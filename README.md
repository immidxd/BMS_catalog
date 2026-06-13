# TG Shop — Telegram Mini App каталог

Публічний інтернет-каталог взуттєвого бізнесу всередині Telegram: покупці гортають
наявні товари, гнучко фільтрують (тип, бренд, розмір, сезон, колір, стан, ціна)
і одним натиском пишуть продавцю.

Дані — з тієї самої PostgreSQL БД `bsstorage`, що й система керування бізнесом (BMS).
Застосунок **тільки читає** дані; показуються лише наявні видимі товари.

## Запуск (розробка)

```bash
./run.sh
```

- Backend: http://localhost:8001 (API-документація: `/api/docs`)
- Frontend: http://localhost:5173 (проксі `/api` та `/product-images` на backend)

Перед запуском заповніть `.env` (див. ключі в наявному файлі): підключення до БД,
папка фото `PRODUCT_IMAGES_DIR`, нік продавця `SELLER_TG_USERNAME`, назва `SHOP_NAME`.

## Збірка для продакшну

```bash
cd frontend && npm run build
```

Після збірки backend сам віддає `frontend/dist` — достатньо одного процесу:

```bash
cd backend && ../venv/bin/uvicorn main:app --port 8001
```

## Підключення до Telegram

Mini App потребує **публічного HTTPS-адресу**:

1. Прокиньте порт назовні (наприклад, `cloudflared tunnel --url http://localhost:8001`
   або ngrok, або розгорніть на VPS).
2. У [@BotFather](https://t.me/BotFather): створіть бота → `/newapp` → вкажіть
   HTTPS-адресу як Web App URL.
3. Кнопку відкриття каталогу можна додати в меню бота (`/setmenubutton`).

## Архітектура

```
backend/   FastAPI :8001 — read-only API каталогу + статика фото + віддача збірки
frontend/  React 18 + TypeScript + Vite — Mini App (telegram-web-app.js)
```

Бізнес-логіка наявності товару та конвенція фото узгоджені з BMS — деталі в `CLAUDE.md`.
