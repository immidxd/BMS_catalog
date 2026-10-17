"""Власні акаунти магазину не створюють рядків у «Замовленнях» — це тести власника.

Перевіряємо саму точку входу писаря (`place_order`), куди сходяться обидва шляхи
(клік «Замовити» і лист у Telegram Business). Справжньої БД і Google тут немає:
підставлений `database.SessionLocal` лише фіксує, що писар пішов далі.

    ../react-fastapi-app/venv/bin/pytest -q backend/tests/test_orders_own_accounts.py
"""
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import orders_sheet  # noqa: E402


class _Reached(Exception):
    pass


def _reaches_db(monkeypatch, uid: int, **env: str) -> bool:
    monkeypatch.setattr(orders_sheet, "enabled", lambda: True)
    for var in ("ADMIN_TG_IDS", "CATALOG_ORDER_SKIP_TG_IDS"):
        monkeypatch.setenv(var, env.get(var, ""))

    def session():
        raise _Reached

    monkeypatch.setitem(sys.modules, "database", types.SimpleNamespace(SessionLocal=session))
    try:
        orders_sheet.place_order(uid, "#Ф1", None, {"name": "Тест"})
    except _Reached:
        return True
    return False


def test_admin_account_is_skipped(monkeypatch):
    assert not _reaches_db(monkeypatch, 766150893, ADMIN_TG_IDS="766150893")


def test_brand_account_is_skipped(monkeypatch):
    assert not _reaches_db(monkeypatch, 7293475623)


def test_extra_skip_list_from_env(monkeypatch):
    assert not _reaches_db(monkeypatch, 555, CATALOG_ORDER_SKIP_TG_IDS="111, 555")


@pytest.mark.parametrize("uid", [123456789, 7872798351])
def test_real_buyer_goes_on(monkeypatch, uid):
    assert _reaches_db(monkeypatch, uid, ADMIN_TG_IDS="766150893")


def test_warehouse_staff_is_skipped(monkeypatch):
    # Персонал складу (wh_staff, активний) — свої: працюють із товаром, а не купують
    monkeypatch.setitem(sys.modules, "warehouse", types.SimpleNamespace(_staff_ids=lambda: {4242}))
    assert not _reaches_db(monkeypatch, 4242)
