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
  • CATALOG_ORDER_SKIP_TG_IDS — додаткові акаунти через кому (без деплою);
  • за НІКОМ — коли числового tg-id нема (друзі-тестувальники): відбиток ніка в коді
    (репозиторій публічний — ніки відкритим текстом не тримаємо) або env
    CATALOG_OWN_USERNAMES (через кому, без «@», без деплою). Нік приходить у ПІДПИСАНИХ
    initData, тож підробити «свого» ззовні не вийде; ключ такого відвідувача реєструється
    з першою ж подією — і його давніші події теж перестають рахуватись.
"""

from __future__ import annotations

import hashlib
import os
from typing import Optional, Set

_OWN_ACCOUNTS = {7293475623}
# sha256 ніка в нижньому регістрі без «@»; 18.10.2026 — друг власника, допомагає тестувати
_OWN_USERNAME_HASHES = {"5963c794d615b4ece55246622f92547ec1452034c6b1d84dfa68c7635cbc911c"}


def _username_hash(username: str) -> str:
    return hashlib.sha256(username.strip().lstrip("@").lower().encode("utf-8")).hexdigest()


def is_own_username(username: Optional[str]) -> bool:
    u = (username or "").strip().lstrip("@").lower()
    if not u:
        return False
    env = {x.strip().lstrip("@").lower() for x in os.getenv("CATALOG_OWN_USERNAMES", "").split(",") if x.strip()}
    return u in env or _username_hash(u) in _OWN_USERNAME_HASHES


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


def is_own(tg_user_id, username: Optional[str] = None) -> bool:
    if is_own_username(username):
        return True
    try:
        return int(tg_user_id) in own_ids()
    except (TypeError, ValueError):
        return False
