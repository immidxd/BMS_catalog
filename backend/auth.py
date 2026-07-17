"""Автентифікація адмін-записів каталогу (Фаза 2).

Вітрина каталогу — READ-ONLY для всіх. Єдиний виняток — адмін-перемикач
публікації: запис у `catalog_listings` дозволено ЛИШЕ якщо:
  • валідний Telegram WebApp `initData` (HMAC-підпис ботом) і user.id ∈ ADMIN_TG_IDS; АБО
  • Bearer-токен запиту збігається з CATALOG_ADMIN_TOKEN (керування з браузера).
Якщо НІ BOT_TOKEN(+ADMIN_TG_IDS), НІ CATALOG_ADMIN_TOKEN не задані — запис вимкнено.

Усе читається через os.getenv ЛІНИВО (на момент запиту), тож .env, який вантажить
database.py при старті, вже доступний.
"""

import hashlib
import hmac
import json
import os
import time
from typing import Optional
from urllib.parse import parse_qsl


def _bot_token() -> str:
    return os.getenv("BOT_TOKEN", "").strip()


def _admin_token() -> str:
    return os.getenv("CATALOG_ADMIN_TOKEN", "").strip()


def _admin_ids() -> set[int]:
    raw = os.getenv("ADMIN_TG_IDS", "").replace(" ", "")
    return {int(x) for x in raw.split(",") if x.isdigit()}


def admin_writes_enabled() -> bool:
    """Чи взагалі дозволені адмін-записи (хоч один спосіб авторизації налаштовано)."""
    return bool(_admin_token() or (_bot_token() and _admin_ids()))


def telegram_user_from_init_data(init_data: str, max_age_sec: int = 86400) -> Optional[int]:
    """Перевірка Telegram WebApp initData (HMAC-SHA256) для БУДЬ-ЯКОГО користувача.
    Повертає telegram user.id, якщо підпис валідний і не протух; інакше None.
    (Використовується для «Обраного» — не потребує адмін-прав.)"""
    token = _bot_token()
    if not token or not init_data:
        return None
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    except Exception:
        return None
    received_hash = pairs.pop("hash", None)
    pairs.pop("signature", None)  # Ed25519 (стороння перевірка) — тут не використовуємо
    if not received_hash:
        return None
    # data_check_string: "key=value" відсортовані за ключем, через \n
    data_check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
    secret_key = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    calc_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc_hash, received_hash):
        return None
    # Свіжість підпису (захист від повторного використання старих initData)
    try:
        if max_age_sec and (time.time() - int(pairs.get("auth_date", "0"))) > max_age_sec:
            return None
    except ValueError:
        return None
    try:
        return int(json.loads(pairs.get("user", "{}")).get("id"))
    except (ValueError, TypeError):
        return None


def verify_init_data(init_data: str, max_age_sec: int = 86400) -> Optional[int]:
    """Як telegram_user_from_init_data, але повертає id ЛИШЕ якщо user ∈ ADMIN_TG_IDS
    (для адмін-записів)."""
    uid = telegram_user_from_init_data(init_data, max_age_sec)
    return uid if (uid is not None and uid in _admin_ids()) else None


def authorize_admin(authorization: Optional[str], init_data: Optional[str]) -> bool:
    """True, якщо запит має право на адмін-запис: валідний Bearer-адмін-токен
    АБО валідний admin-initData. Порівняння токена — constant-time."""
    tok = _admin_token()
    if tok and authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and hmac.compare_digest(value.strip(), tok):
            return True
    if init_data and verify_init_data(init_data) is not None:
        return True
    return False
