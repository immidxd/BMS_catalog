# ─────────────────────────────────────────────────────────────────────────────
#  Каталог TG Shop — один контейнер: збірка фронтенду + бекенд, що його віддає.
#  Деплой: Railway/Render (вони самі підставляють $PORT). БД — хмарна (Neon) через
#  env DATABASE_URL; фото — з R2 (R2_PUBLIC_BASE_URL); індекс фото — з БД
#  (CATALOG_IMAGES_SOURCE=db), бо локального диска у хмарі нема.
# ─────────────────────────────────────────────────────────────────────────────

# ── Етап 1: збірка фронтенду (Vite) ──────────────────────────────────────────
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build          # → /app/frontend/dist

# ── Етап 2: бекенд + готова збірка ───────────────────────────────────────────
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY --from=frontend /app/frontend/dist frontend/dist

WORKDIR /app/backend
# $PORT задає хостинг; локально дефолт 8001
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8001}"]
