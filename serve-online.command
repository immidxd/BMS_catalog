#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  КАТАЛОГ ОНЛАЙН — тимчасовий доступ з будь-яких пристроїв (через тунель loca.lt)
#  Подвійний клік → з'явиться адреса https://…loca.lt → відкрий на телефоні.
#  Щоб ЗУПИНИТИ доступ — просто закрий це вікно Terminal.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")"

echo "▸ Збираю свіжий каталог…"
( cd frontend && npm run build ) >/tmp/catalog_build.log 2>&1 \
  && echo "  ✓ білд готовий" \
  || echo "  (білд не вдався — використаю попередній; деталі: /tmp/catalog_build.log)"

if lsof -nP -iTCP:8001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "▸ Backend уже працює (:8001)"
else
  echo "▸ Запускаю backend…"
  ( cd backend && ../venv/bin/uvicorn main:app --host 127.0.0.1 --port 8001 ) >/tmp/catalog_be.log 2>&1 &
  sleep 5
fi

# IP, який бачить loca.lt = саме той пароль, що на сторінці-попередженні
IP=$( curl -s --max-time 8 https://loca.lt/mytunnelpassword || curl -s --max-time 8 https://api.ipify.org )
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Нижче з'явиться адреса виду  https://…loca.lt"
echo "  → відкрий її на телефоні або іншому пристрої."
echo ""
echo "  Якщо покаже сіру сторінку «Tunnel website ahead»:"
echo "     встав цей IP →  ${IP:-(див. порожньо? перевір інтернет)}"
echo "     у поле IP Address → натисни Continue."
echo ""
echo "  Щоб ЗУПИНИТИ доступ — закрий це вікно Terminal."
echo "════════════════════════════════════════════════════════════"
echo ""
# Стабільний піддомен (якщо вільний): https://brandstore-catalog.loca.lt
npx --yes localtunnel --port 8001 --subdomain brandstore-catalog
