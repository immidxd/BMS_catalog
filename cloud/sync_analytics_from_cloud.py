#!/usr/bin/env python3
"""Incrementally return catalog analytics from Neon to the local BMS database.

Only catalog-owned event/cache tables are written locally. Products, orders and all
business source data remain untouched. The public catalog keeps collecting while BMS
is closed; the next run catches up by immutable event_id.
"""

from __future__ import annotations

import fcntl
import os
import sys
from datetime import timedelta

import psycopg2
from psycopg2.extras import Json, execute_values
from dotenv import load_dotenv

LOCK_PATH = os.getenv("CATALOG_ANALYTICS_SYNC_LOCK", "/tmp/bms_catalog_analytics_sync.lock")


def _lock():
    fh = open(LOCK_PATH, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return None
    fh.write(str(os.getpid()))
    fh.flush()
    return fh


def _ensure_local(cur) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS catalog_events (
            event_id uuid PRIMARY KEY,
            event_type varchar(32) NOT NULL,
            productnumber varchar(80),
            visitor_key char(64) NOT NULL,
            session_id uuid NOT NULL,
            metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
            -- DEFAULT обов'язковий і тут: таблицю створює той, хто стартував ПЕРШИМ
            -- (CREATE TABLE IF NOT EXISTS другого вже нічого не міняє). Синхрон завжди
            -- підставляє значення сам, а от застосунок покладається на DEFAULT — і без
            -- нього кожна подія падала з 500 (NotNullViolation on occurred_at).
            occurred_at timestamptz NOT NULL DEFAULT now(),
            received_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS ix_catalog_events_received
        ON catalog_events(received_at DESC)
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS catalog_analytics_product_snapshot (
            productnumber varchar(80) PRIMARY KEY,
            active_favorites integer NOT NULL DEFAULT 0,
            legacy_views integer NOT NULL DEFAULT 0,
            synced_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS catalog_analytics_sync_state (
            source varchar(40) PRIMARY KEY,
            last_synced_at timestamptz,
            last_received_at timestamptz,
            rows_synced bigint NOT NULL DEFAULT 0,
            last_error text
        )
    """)


def sync_once(cloud_url: str, local_dsn: dict, acquire_lock: bool = True) -> dict:
    lock_fh = _lock() if acquire_lock else True
    if lock_fh is None:
        return {"skipped": True, "reason": "already_running"}

    cloud = psycopg2.connect(
        cloud_url,
        connect_timeout=int(os.getenv("CATALOG_SYNC_CONNECT_TIMEOUT", "15")),
        keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3,
    )
    local = psycopg2.connect(**local_dsn)
    try:
        cc, lc = cloud.cursor(), local.cursor()
        lc.execute("SET statement_timeout = '90s'")
        lc.execute("SET lock_timeout = '3s'")
        _ensure_local(lc)
        local.commit()

        lc.execute("SELECT MAX(received_at) FROM catalog_events")
        last = lc.fetchone()[0]
        # Overlap protects against clock skew/retries; event_id makes it idempotent.
        since = last - timedelta(days=1) if last else None
        if since:
            cc.execute("""
                SELECT event_id, event_type, productnumber, visitor_key, session_id,
                       metadata, occurred_at, received_at
                FROM catalog_events WHERE received_at >= %s ORDER BY received_at
            """, (since,))
        else:
            cc.execute("""
                SELECT event_id, event_type, productnumber, visitor_key, session_id,
                       metadata, occurred_at, received_at
                FROM catalog_events ORDER BY received_at
            """)
        events = cc.fetchall()
        if events:
            execute_values(lc, """
                INSERT INTO catalog_events
                    (event_id, event_type, productnumber, visitor_key, session_id,
                     metadata, occurred_at, received_at)
                VALUES %s ON CONFLICT (event_id) DO NOTHING
            """, [(*r[:5], Json(r[5] or {}), r[6], r[7]) for r in events])

        cc.execute("""
            SELECT productnumber, COUNT(*)::integer
            FROM catalog_favorite_state GROUP BY productnumber
        """)
        favorites = dict(cc.fetchall())
        cc.execute("SELECT productnumber, views::integer FROM catalog_views")
        legacy_views = dict(cc.fetchall())
        numbers = sorted(set(favorites) | set(legacy_views))

        # Snapshot is derived and replaceable; replacement happens in one local tx.
        lc.execute("DELETE FROM catalog_analytics_product_snapshot")
        if numbers:
            execute_values(lc, """
                INSERT INTO catalog_analytics_product_snapshot
                    (productnumber, active_favorites, legacy_views, synced_at)
                VALUES %s
            """, [(pn, favorites.get(pn, 0), legacy_views.get(pn, 0)) for pn in numbers],
                template="(%s, %s, %s, now())")

        lc.execute("SELECT MAX(received_at), COUNT(*) FROM catalog_events")
        latest, total = lc.fetchone()
        lc.execute("""
            INSERT INTO catalog_analytics_sync_state
                (source, last_synced_at, last_received_at, rows_synced, last_error)
            VALUES ('catalog_cloud', now(), %s, %s, NULL)
            ON CONFLICT (source) DO UPDATE SET
                last_synced_at=EXCLUDED.last_synced_at,
                last_received_at=EXCLUDED.last_received_at,
                rows_synced=EXCLUDED.rows_synced,
                last_error=NULL
        """, (latest, total))
        local.commit()
        return {"skipped": False, "events_received": len(events), "events_total": total,
                "favorite_products": len(favorites)}
    except Exception as exc:
        local.rollback()
        try:
            lc = local.cursor()
            _ensure_local(lc)
            lc.execute("""
                INSERT INTO catalog_analytics_sync_state
                    (source, last_synced_at, rows_synced, last_error)
                VALUES ('catalog_cloud', now(), 0, %s)
                ON CONFLICT (source) DO UPDATE SET
                    last_synced_at=EXCLUDED.last_synced_at, last_error=EXCLUDED.last_error
            """, (str(exc)[:1000],))
            local.commit()
        except Exception:
            local.rollback()
        raise
    finally:
        local.close()
        cloud.close()
        if acquire_lock and lock_fh:
            lock_fh.close()


def main() -> None:
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    cloud_url = os.getenv("CLOUD_DATABASE_URL")
    if not cloud_url:
        sys.exit("✗ Немає CLOUD_DATABASE_URL")
    local_dsn = {
        "host": os.getenv("DB_HOST", "localhost"),
        "port": os.getenv("DB_PORT", "5432"),
        "dbname": os.getenv("DB_NAME"),
        "user": os.getenv("DB_USER"),
        "password": os.getenv("DB_PASSWORD"),
    }
    result = sync_once(cloud_url, local_dsn)
    print(f"✓ Аналітика каталогу синхронізована: {result}")


if __name__ == "__main__":
    main()
