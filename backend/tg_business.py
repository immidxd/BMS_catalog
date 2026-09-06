"""Замовлення = НАДІСЛАНИЙ лист менеджеру, а не клік у каталозі.

Листи в ОСОБИСТИЙ акаунт менеджера ззовні не бачить ніхто — Telegram такого API
не дає. Єдиний законний спосіб: власник вмикає боту Business Mode (BotFather →
Bot Settings → Business Mode) і під'єднує його до свого акаунта (Telegram →
Налаштування → Telegram Business → Чат-боти). Після цього бот отримує оновлення
`business_message` про листи в особистих чатах власника — саме на них ця
приймальня і чекає.

Правила виросли з того, що документ «Замовлення» власник веде РУКАМИ:

1. РЯДОК СТВОРЮЄ ЛИШЕ ЛИСТ ЗА ШАБЛОНОМ КАТАЛОГУ («Цікавить товар: … #Ф2886»).
   Вільне питання з решіткою («а є ще #Ф2886?») рядка НЕ створює: власник його
   й так прочитає, а хибне замовлення в живому документі коштує дорожче за
   пропущене.
2. ЛИСТИ ВЛАСНИКА ІГНОРУЄМО: у `business_message` приходять і його власні
   відповіді. Вхідний лист у приватному чаті — той, де відправник І Є чат;
   у відповіді власника чат — покупець, а відправник — він сам.
3. ПОВТОРНЕ ОНОВЛЕННЯ — не другий рядок: Telegram надсилає його знову, доки не
   отримає 200, тож ключ (з'єднання + номер листа) осідає в БД ДО обробки.
4. ЧУЖИЙ СТУК — 403 ще до розбору тіла: адреса вебхука публічна, і єдиний
   захист — секрет із заголовка (той самий, що переданий у setWebhook).
5. ВІДПОВІДАЄМО ОДРАЗУ, аркуш пишемо у фоні: Google відповідає повільніше, ніж
   Telegram готовий чекати, а мовчання обертається зливою повторів.

Вимкнено, доки не задано TG_WEBHOOK_SECRET (плюс те, чого вимагає сам писар
аркуша: CATALOG_ORDERS_SHEET, GOOGLE_SERVICE_ACCOUNT_JSON, ORDERS_SPREADSHEET_ID).
"""

from __future__ import annotations

import hmac
import logging
import os
import re
from typing import Any, Dict, Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, Header, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import get_db
import orders_sheet

logger = logging.getLogger(__name__)
router = APIRouter()

# Підпис шаблону каталогу — рядок із frontend/src/components/ProductPage.tsx
# (`orderMessage`). Змінили текст там — змініть і тут, інакше листи перестануть
# ставати замовленнями (мовчки).
TEMPLATE_MARK = "цікавить товар"
# Номер товару в листі: «#Ф2886», «#В234», «#Ф1067-2». У БД номер зберігається
# РАЗОМ із решіткою, тож беремо збіг як є, нічого не зрізаючи.
_NUMBER = re.compile(r"#[0-9A-Za-zА-Яа-яЇїІіЄєҐґ]{1,12}(?:-\d{1,3})?")
_SIZE = re.compile(r"Розмір:\s*(.{1,32})")


def enabled() -> bool:
    return bool(_secret()) and orders_sheet.enabled()


def _secret() -> str:
    return os.getenv("TG_WEBHOOK_SECRET", "").strip()


def ensure_table(db: Session) -> None:
    """Оброблені листи. Це і захист від повторів вебхука, і журнал: видно, який
    саме лист став яким замовленням."""
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS catalog_tg_orders (
            message_key   text PRIMARY KEY,
            tg_user_id    bigint NOT NULL,
            productnumber varchar(80),
            at            timestamptz NOT NULL DEFAULT now()
        )
    """))
    db.commit()


def _buyer(sender: Dict[str, Any]) -> Dict[str, str]:
    """Ім'я та нік покупця — рівно у тій формі, якої чекає писар аркуша."""
    name = " ".join(str(x) for x in (sender.get("first_name"), sender.get("last_name")) if x).strip()
    return {"name": name, "username": str(sender.get("username") or "").strip()}


@router.post("/api/tg/webhook")
async def telegram_webhook(
    background: BackgroundTasks,
    update: Dict[str, Any] = Body(...),
    x_telegram_bot_api_secret_token: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """Оновлення бота. Після збігу секрета відповідаємо 200 ЗАВЖДИ: будь-який
    інший код змусить Telegram слати те саме оновлення по колу."""
    secret = _secret()
    if not secret or not hmac.compare_digest(x_telegram_bot_api_secret_token or "", secret):
        raise HTTPException(status_code=403, detail="Заборонено")

    conn = update.get("business_connection")
    if isinstance(conn, dict):
        # З'єднання бота з акаунтом власника: у логах видно, що підключення живе
        logger.info("[tg] business-з'єднання %s, увімкнене=%s",
                    conn.get("id"), conn.get("is_enabled"))
        return {"ok": True}

    message = update.get("business_message")
    if not isinstance(message, dict):
        return {"ok": True}

    sender, chat = message.get("from") or {}, message.get("chat") or {}
    if not sender.get("id") or sender.get("id") != chat.get("id"):
        return {"ok": True}                      # відповідь власника, а не лист покупця

    body = str(message.get("text") or message.get("caption") or "").strip()
    number = _NUMBER.search(body)
    if TEMPLATE_MARK not in body.lower() or not number:
        return {"ok": True}                      # вільне питання — не замовлення

    key = f"{message.get('business_connection_id') or ''}:{message.get('message_id')}"
    try:
        ensure_table(db)
        fresh = db.execute(text("""
            INSERT INTO catalog_tg_orders (message_key, tg_user_id, productnumber)
            VALUES (:k, :u, :pn) ON CONFLICT DO NOTHING RETURNING message_key
        """), {"k": key, "u": sender["id"], "pn": number.group(0)}).scalar()
        db.commit()
    except Exception as exc:                     # noqa: BLE001
        db.rollback()
        logger.warning("[tg] лист %s не позначено обробленим: %s", key, exc)
        return {"ok": True}                      # без захисту від повторів не пишемо
    if not fresh:
        return {"ok": True}                      # це оновлення ми вже обробили

    size = _SIZE.search(body)
    background.add_task(orders_sheet.handle_order_message, int(sender["id"]),
                        number.group(0), size.group(1).strip() if size else None,
                        _buyer(sender))
    return {"ok": True}
