"""Свої акаунти магазину — не покупці.

Їхні дії в каталозі — тести й робота, а не попит. Тому вони НЕ створюють рядків у
«Замовленнях» (orders_sheet.place_order) і НЕ рахуються в статистиці вітрини
(analytics.record_event → реєстр catalog_internal_visitors, за яким рахують BMS,
Топ-9 і лічильники каталогу).

Свої — це:
  • BrandStoreua (7293475623) — окремий акаунт магазину, НЕ адмін;
  • ADMIN_TG_IDS — адміни;
  • власники й АКТИВНИЙ персонал складу (warehouse: WAREHOUSE_TG_IDS + wh_staff) —
    вони працюють із товаром, а не купують його;
  • CATALOG_ORDER_SKIP_TG_IDS — додаткові акаунти через кому (без деплою).
"""

from __future__ import annotations

import os
from typing import Set

_OWN_ACCOUNTS = {7293475623}


def _env_ids(*names: str) -> Set[int]:
    ids: Set[int] = set()
    for var in names:
        ids |= {int(x) for x in os.getenv(var, "").replace(" ", "").split(",") if x.isdigit()}
    return ids


def own_ids() -> Set[int]:
    ids = _OWN_ACCOUNTS | _env_ids("ADMIN_TG_IDS", "CATALOG_ORDER_SKIP_TG_IDS")
    try:
        from warehouse import _staff_ids   # власники складу + активний персонал (кеш 15 с)
        ids |= _staff_ids()
    except Exception:  # noqa: BLE001 — склад недоступний: лишаємо статичний список
        pass
    return ids


def is_own(tg_user_id) -> bool:
    try:
        return int(tg_user_id) in own_ids()
    except (TypeError, ValueError):
        return False
