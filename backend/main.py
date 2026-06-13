"""TG Shop — Telegram Mini App каталог. Точка входу FastAPI (порт 8001)."""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from catalog import router as catalog_router
from images import URL_PREFIX as IMAGES_URL_PREFIX, get_images_dir

app = FastAPI(title="TG Shop — каталог", docs_url="/api/docs")

# Mini App відкривається з домену Telegram — CORS відкритий (API read-only)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/api/config")
async def get_config():
    """Публічна конфігурація для фронтенду."""
    admin_ids = [int(x) for x in os.getenv("ADMIN_TG_IDS", "").replace(" ", "").split(",") if x.isdigit()]
    return {
        "seller_username": os.getenv("SELLER_TG_USERNAME", ""),
        "shop_name": os.getenv("SHOP_NAME", "Каталог"),
        "admin_tg_ids": admin_ids,
    }


app.include_router(catalog_router)

# Статика фото товарів: монтуємо корінь «Товар», URL містять підпапку-категорію
_images_dir = get_images_dir()
if os.path.isdir(_images_dir):
    app.mount(IMAGES_URL_PREFIX, StaticFiles(directory=_images_dir), name="product-images")

# Продакшн-збірка фронтенду (npm run build) — віддається цим же сервером
_frontend_dist = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend", "dist")
if os.path.isdir(_frontend_dist):
    app.mount("/", StaticFiles(directory=_frontend_dist, html=True), name="frontend")
