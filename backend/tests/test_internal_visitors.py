"""Свої акаунти не потрапляють у статистику вітрини (own_accounts + catalog_internal_visitors).

Лише на ТИМЧАСОВИХ базах (ім'я містить «test»): живу BMS і хмару тест не чіпає.
Друга база — «локальна» сторона синхрону аналітики (BMS).

    createdb bms_catalog_test_tmp && createdb bms_catalog_test_tmp_local
    CATALOG_TEST_DATABASE_URL=postgresql://…/bms_catalog_test_tmp \\
    CATALOG_TEST_LOCAL_DATABASE_URL=postgresql://…/bms_catalog_test_tmp_local \\
        ../react-fastapi-app/venv/bin/pytest -q backend/tests/test_internal_visitors.py
"""
import os
import sys
import uuid
from pathlib import Path

import pytest

URL = os.getenv("CATALOG_TEST_DATABASE_URL", "")
LOCAL_URL = os.getenv("CATALOG_TEST_LOCAL_DATABASE_URL", "")
pytestmark = pytest.mark.skipif("test" not in URL, reason="потрібна тимчасова тестова база")

ADMIN, BRAND, BUYER = 111, 7293475623, 222
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def ctx():
    # Змінні — ДО імпорту database: інакше він узяв би живу БД із .env
    os.environ.update(DATABASE_URL=URL, CATALOG_ANALYTICS_SECRET="test-secret",
                      ADMIN_TG_IDS=str(ADMIN), CATALOG_ORDER_SKIP_TG_IDS="", CATALOG_ORDERS_SHEET="0")
    sys.path.insert(0, str(ROOT / "backend"))
    import database
    assert "test" in str(database.engine.url), "тест лише на тестовій базі"
    import analytics
    import favorites
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import text

    from catalog import _ensure_favorites_table, _ensure_views_table
    for ensure in (_ensure_views_table, _ensure_favorites_table, analytics.ensure_analytics_tables):
        db = database.SessionLocal()
        ensure(db)
        db.close()
    app = FastAPI()
    app.include_router(analytics.router)
    app.include_router(favorites.router)
    # Без контекст-менеджера — startup-події не потрібні
    return analytics, database, TestClient(app), text


def _event(client, event_type="catalog_open", pn=None, user_id=None, internal=False, visitor=None):
    body = {"event_id": str(uuid.uuid4()), "event_type": event_type, "productnumber": pn}
    if user_id:
        body["user_id"] = user_id
    if internal:
        body["internal"] = True
    headers = {"X-Catalog-Visitor": visitor or str(uuid.uuid4()), "X-Catalog-Session": str(uuid.uuid4())}
    return client.post("/api/analytics/events", json=body, headers=headers).json()


def _scalar(ctx, sql, **params):
    _, database, _, text = ctx
    db = database.SessionLocal()
    try:
        return db.execute(text(sql), params).scalar()
    finally:
        db.close()


def test_known_own_accounts_registered_on_start(ctx):
    analytics = ctx[0]
    for uid in (ADMIN, BRAND):
        assert _scalar(ctx, "SELECT COUNT(*) FROM catalog_internal_visitors WHERE visitor_key=:k",
                       k=analytics._key(f"tg:{uid}")) == 1


def test_own_events_are_not_recorded(ctx):
    analytics, _, client, _ = ctx
    assert _event(client, user_id=ADMIN) == {"accepted": False}
    assert _event(client, "product_view", "#Ф1", user_id=BRAND) == {"accepted": False}
    assert _event(client, "product_view", "#Ф1", user_id=BUYER) == {"accepted": True}
    for uid in (ADMIN, BRAND):
        assert _scalar(ctx, "SELECT COUNT(*) FROM catalog_events WHERE visitor_key=:k",
                       k=analytics._key(f"tg:{uid}")) == 0


def test_owner_device_flag_registers_anonymous_key(ctx):
    analytics, _, client, _ = ctx
    device = str(uuid.uuid4())
    assert _event(client, visitor=device, internal=True) == {"accepted": False}
    assert _scalar(ctx, "SELECT COUNT(*) FROM catalog_internal_visitors WHERE visitor_key=:k",
                   k=analytics._key(f"anon:{device}")) == 1


def test_old_events_and_likes_of_own_accounts_do_not_count(ctx):
    analytics, database, client, text = ctx
    # «Історія» до виправлення: подія адміна вже лежить у таблиці
    db = database.SessionLocal()
    db.execute(text("""
        INSERT INTO catalog_events (event_id, event_type, productnumber, visitor_key, session_id)
        VALUES (CAST(:e AS uuid), 'product_view', '#Ф2', :k, CAST(:s AS uuid))
    """), {"e": str(uuid.uuid4()), "k": analytics._key(f"tg:{ADMIN}"), "s": str(uuid.uuid4())})
    db.commit()
    db.close()
    assert _scalar(ctx, f"SELECT COUNT(*) FROM catalog_events WHERE productnumber='#Ф2' "
                        f"AND {analytics.NOT_INTERNAL}") == 0

    # Лайк свого працює (обране), але в публічний лічильник ♥️ не йде
    fav = lambda uid: client.post("/api/favorites", json={"productnumber": "#Ф2", "favorite": True,
                                                          "user_id": uid},
                                  headers={"X-Catalog-Visitor": str(uuid.uuid4())}).json()
    assert fav(ADMIN)["fav_count"] == 0
    assert fav(BUYER)["fav_count"] == 1


@pytest.mark.skipif("test" not in LOCAL_URL, reason="потрібна друга тестова база")
def test_sync_mirrors_registry_and_snapshot_skips_own_likes(ctx):
    sys.path.insert(0, str(ROOT / "cloud"))
    import psycopg2
    from sync_analytics_from_cloud import sync_once

    result = sync_once(URL, {"dsn": LOCAL_URL}, acquire_lock=False)
    assert result["internal_visitors"] >= 3
    local = psycopg2.connect(LOCAL_URL)
    try:
        cur = local.cursor()
        cur.execute("SELECT active_favorites FROM catalog_analytics_product_snapshot WHERE productnumber='#Ф2'")
        assert cur.fetchone()[0] == 1          # лише покупець, без адміна
        cur.execute("SELECT COUNT(*) FROM catalog_internal_visitors")
        assert cur.fetchone()[0] == result["internal_visitors"]
    finally:
        local.close()
