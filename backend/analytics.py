"""Privacy-safe behavioral analytics for the public catalog.

The product detail GET endpoint is deliberately side-effect free: neighboring cards are
prefetched by the UI, so counting GETs would inflate views.  The browser reports a
``product_view`` only after the requested card is actually active on screen.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from auth import telegram_user_from_init_data
from database import get_db

router = APIRouter()

EVENT_TYPES = {
    "catalog_open",
    "product_view",
    "favorite_add",
    "favorite_remove",
    "contact_click",
}
CONTACT_CHANNELS = {"telegram", "phone", "instagram", "viber"}


def _secret() -> bytes:
    value = (
        os.getenv("CATALOG_ANALYTICS_SECRET")
        or os.getenv("BOT_TOKEN")
        or os.getenv("CATALOG_ADMIN_TOKEN")
        or "catalog-analytics-local-fallback"
    )
    return value.encode("utf-8")


def _valid_uuid(value: Optional[str]) -> Optional[str]:
    try:
        return str(uuid.UUID((value or "").strip()))
    except (ValueError, AttributeError):
        return None


def visitor_key(
    init_data: Optional[str],
    user_id: Optional[int],
    visitor_id: Optional[str],
) -> str:
    """Return a stable one-way identity without storing Telegram IDs or IP data."""
    verified_uid = telegram_user_from_init_data(init_data or "")
    if verified_uid is not None:
        source = f"tg:{verified_uid}"
    elif isinstance(user_id, int) and user_id > 0:
        # Compatibility path for the existing Mini App opened from another bot.
        source = f"tg:{user_id}"
    else:
        anon = _valid_uuid(visitor_id)
        if not anon:
            raise HTTPException(status_code=400, detail="Немає ідентифікатора відвідувача")
        source = f"anon:{anon}"
    return hmac.new(_secret(), source.encode("utf-8"), hashlib.sha256).hexdigest()


def ensure_analytics_tables(db: Session) -> None:
    """Create only additive catalog-owned tables and indexes."""
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS catalog_events (
            event_id uuid PRIMARY KEY,
            event_type varchar(32) NOT NULL,
            productnumber varchar(80),
            visitor_key char(64) NOT NULL,
            session_id uuid NOT NULL,
            metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
            occurred_at timestamptz NOT NULL DEFAULT now(),
            received_at timestamptz NOT NULL DEFAULT now(),
            CHECK (event_type IN (
                'catalog_open', 'product_view', 'favorite_add',
                'favorite_remove', 'contact_click'
            ))
        )
    """))
    db.execute(text("""
        CREATE INDEX IF NOT EXISTS ix_catalog_events_received
            ON catalog_events (received_at DESC)
    """))
    db.execute(text("""
        CREATE INDEX IF NOT EXISTS ix_catalog_events_product_time
            ON catalog_events (productnumber, received_at DESC)
            WHERE productnumber IS NOT NULL
    """))
    db.execute(text("""
        CREATE INDEX IF NOT EXISTS ix_catalog_events_visitor_time
            ON catalog_events (visitor_key, received_at DESC)
    """))
    db.execute(text("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_events_session_view
            ON catalog_events (session_id, event_type, COALESCE(productnumber, ''))
            WHERE event_type IN ('catalog_open', 'product_view')
    """))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS catalog_favorite_state (
            visitor_key char(64) NOT NULL,
            productnumber varchar(80) NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (visitor_key, productnumber)
        )
    """))
    db.execute(text("""
        CREATE INDEX IF NOT EXISTS ix_catalog_favorite_state_product
            ON catalog_favorite_state (productnumber)
    """))
    # One-time, idempotent preservation of the existing Telegram favorites. The raw
    # numeric ID remains only in the legacy table; the new analytics state receives
    # exactly the same HMAC identity used by current verified Telegram requests.
    if db.execute(text("SELECT to_regclass('public.catalog_favorites')")).scalar():
        legacy = db.execute(text(
            "SELECT telegram_user_id, productnumber FROM catalog_favorites"
        )).all()
        for uid, pnum in legacy:
            key = hmac.new(_secret(), f"tg:{uid}".encode("utf-8"), hashlib.sha256).hexdigest()
            db.execute(text("""
                INSERT INTO catalog_favorite_state (visitor_key, productnumber)
                VALUES (:key, :pn) ON CONFLICT DO NOTHING
            """), {"key": key, "pn": pnum})
    db.commit()


def _clean_metadata(event_type: str, metadata: Any) -> Dict[str, str]:
    if not isinstance(metadata, dict):
        return {}
    if event_type == "contact_click":
        channel = str(metadata.get("channel") or "").lower().strip()
        if channel not in CONTACT_CHANNELS:
            return {}
        # Обраний розмір — щоб бачити, за якими розмірами реально пишуть (і чи взагалі
        # доходять до вибору). Довжину ріжемо: це підпис пігулки, а не вільний текст.
        size = str(metadata.get("size") or "").strip()[:32]
        return {"channel": channel, **({"size": size} if size else {})}
    return {}


@router.post("/api/analytics/events")
async def record_event(
    payload: Dict[str, Any] = Body(...),
    x_catalog_visitor: Optional[str] = Header(None),
    x_catalog_session: Optional[str] = Header(None),
    x_telegram_init_data: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    event_type = str(payload.get("event_type") or "").strip()
    if event_type not in EVENT_TYPES:
        raise HTTPException(status_code=400, detail="Невідомий тип події")

    event_id = _valid_uuid(str(payload.get("event_id") or ""))
    session_id = _valid_uuid(x_catalog_session)
    if not event_id or not session_id:
        raise HTTPException(status_code=400, detail="Некоректний ідентифікатор події або сесії")

    pnum = str(payload.get("productnumber") or "").strip() or None
    if pnum and len(pnum) > 80:
        raise HTTPException(status_code=400, detail="Некоректний номер товару")
    if event_type != "catalog_open" and not pnum:
        raise HTTPException(status_code=400, detail="Для події потрібен номер товару")

    key = visitor_key(x_telegram_init_data, payload.get("user_id"), x_catalog_visitor)
    meta = _clean_metadata(event_type, payload.get("metadata"))

    inserted = db.execute(text("""
        INSERT INTO catalog_events
            (event_id, event_type, productnumber, visitor_key, session_id, metadata)
        VALUES
            (CAST(:event_id AS uuid), :event_type, :pn, :visitor_key,
             CAST(:session_id AS uuid), CAST(:metadata AS jsonb))
        ON CONFLICT DO NOTHING
        RETURNING event_id
    """), {
        "event_id": event_id,
        "event_type": event_type,
        "pn": pnum,
        "visitor_key": key,
        "session_id": session_id,
        "metadata": json.dumps(meta),
    }).scalar()

    # Keep the old admin badge compatible, but increment it only for a genuine,
    # deduplicated active-card view. Historical inflated values are preserved as legacy.
    if inserted and event_type == "product_view" and pnum:
        db.execute(text("""
            INSERT INTO catalog_views (productnumber, views, updated_at)
            VALUES (:pn, 1, now())
            ON CONFLICT (productnumber) DO UPDATE
            SET views = catalog_views.views + 1, updated_at = now()
        """), {"pn": pnum})
    db.commit()
    return {"accepted": bool(inserted)}
