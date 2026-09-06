"""Реєстрація вебхука Telegram Business (разова дія при налаштуванні).

Оновлення `business_message` Telegram НЕ надсилає за замовчуванням — їх треба
запросити явно в `allowed_updates`. Через це вебхук, поставлений «як завжди»,
мовчав би, і причину неможливо було б побачити. Тому один скрипт, який ставить
адресу, секрет і перелік оновлень разом.

Запуск (з кореня BMS_catalog, змінні беруться з .env або середовища):

    python3 cloud/set_tg_webhook.py https://<адреса-каталогу>
    python3 cloud/set_tg_webhook.py --delete      # зняти вебхук

TG_WEBHOOK_SECRET має збігатися зі значенням у середовищі хмарного каталогу —
саме ним приймальня відрізняє Telegram від будь-кого, хто знайшов адресу.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

# .env лежить у корені репозиторію, поруч із цією текою
for line in (Path(__file__).resolve().parent.parent / ".env").read_text().splitlines():
    if line.strip() and not line.startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))

UPDATES = ["business_connection", "business_message"]


def call(method: str, **params) -> dict:
    token = os.environ["BOT_TOKEN"]
    data = urllib.parse.urlencode(
        {k: (json.dumps(v) if isinstance(v, (list, dict, bool)) else v)
         for k, v in params.items()}).encode()
    with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/{method}",
                                data or None, timeout=20) as response:
        return json.load(response)


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--delete":
        print(call("deleteWebhook", drop_pending_updates=False))
        return 0
    if not args:
        print(__doc__)
        return 1

    secret = os.environ.get("TG_WEBHOOK_SECRET", "").strip()
    if len(secret) < 16:
        print("✗ TG_WEBHOOK_SECRET не заданий або закороткий (треба ≥16 символів).")
        return 1

    url = args[0].rstrip("/") + "/api/tg/webhook"
    # drop_pending_updates: чернетки старих оновлень нам не потрібні — рядки в
    # документі власника мають народжуватись лише з листів, надісланих ПІСЛЯ вмикання.
    print(call("setWebhook", url=url, secret_token=secret,
               allowed_updates=UPDATES, drop_pending_updates=True))

    me = call("getMe")["result"]
    info = call("getWebhookInfo")["result"]
    print(f"\nБот: @{me['username']}")
    print(f"Адреса: {info.get('url') or '—'}")
    print(f"Оновлення: {info.get('allowed_updates') or 'усі типові (БЕЗ business!)'}")
    if info.get("last_error_message"):
        print(f"Остання помилка доставки: {info['last_error_message']}")
    if not me.get("can_connect_to_business"):
        print("\n⚠️ У бота ВИМКНЕНО Business Mode — листи не приходитимуть.")
        print("   BotFather → /mybots → цей бот → Bot Settings → Business Mode → Turn on.")
    print("\nДалі — в Telegram акаунта менеджера: Налаштування → Telegram Business →")
    print("Чат-боти → додати цього бота (потрібен Telegram Premium).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
