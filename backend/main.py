"""TG Shop — Telegram Mini App каталог. Точка входу FastAPI (порт 8001)."""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from admin import router as admin_router
from auth import admin_writes_enabled
from catalog import router as catalog_router
from favorites import router as favorites_router
from images import URL_PREFIX as IMAGES_URL_PREFIX, get_images_dir

# Документація API (Swagger/ReDoc/openapi.json) — за замовчуванням ВИМКНЕНА:
# публічно не світимо структуру API (зокрема існування адмін-ендпоінта).
# Для розробки увімкнути: CATALOG_ENABLE_DOCS=1.
_enable_docs = os.getenv("CATALOG_ENABLE_DOCS", "").strip().lower() in ("1", "true", "yes", "on")
app = FastAPI(
    title="TG Shop — каталог",
    docs_url="/api/docs" if _enable_docs else None,
    redoc_url="/api/redoc" if _enable_docs else None,
    openapi_url="/api/openapi.json" if _enable_docs else None,
)

# Mini App відкривається з домену Telegram — CORS відкритий (API read-only)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    # PATCH — захищений адмін-запис (публікація/опис); POST — «Обране» користувача
    allow_methods=["GET", "PATCH", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/api/config")
async def get_config():
    """Публічна конфігурація для фронтенду."""
    admin_ids = [int(x) for x in os.getenv("ADMIN_TG_IDS", "").replace(" ", "").split(",") if x.isdigit()]
    return {
        "seller_username": os.getenv("SELLER_TG_USERNAME", ""),
        # Мульти-канал замовлення — кнопки показуються лише для заданих каналів
        "seller_phone": os.getenv("SELLER_PHONE", ""),
        "seller_instagram": os.getenv("SELLER_INSTAGRAM", "").lstrip("@"),
        "seller_viber": os.getenv("SELLER_VIBER", ""),   # номер для Viber-чату
        "shop_name": os.getenv("SHOP_NAME", "Каталог"),
        "admin_tg_ids": admin_ids,
        # Чи доступний адмін-запис публікації (Фаза 2) — щоб фронт знав, чи показувати тумблер
        "admin_writes": admin_writes_enabled(),
    }


app.include_router(catalog_router)
app.include_router(admin_router)
app.include_router(favorites_router)


@app.on_event("startup")
def _ensure_catalog_tables() -> None:
    """Гарантуємо додаткові об'єкти каталогу (перегляди, обране, публічність опису)
    — адитивно, не залежимо від міграцій BMS. Кожен крок незалежний: збій одного
    (напр. catalog_listings ще нема) не блокує решту."""
    try:
        from database import SessionLocal
        from catalog import (_ensure_description_public_column,
                             _ensure_favorites_table, _ensure_views_table)
    except Exception:
        return
    for ensure in (_ensure_views_table, _ensure_favorites_table, _ensure_description_public_column):
        db = SessionLocal()
        try:
            ensure(db)
        except Exception:
            db.rollback()   # відсутня таблиця/гонка — некритично, каталог працює далі
        finally:
            db.close()

# Статика фото товарів: монтуємо корінь «Товар», URL містять підпапку-категорію
_images_dir = get_images_dir()
if os.path.isdir(_images_dir):
    app.mount(IMAGES_URL_PREFIX, StaticFiles(directory=_images_dir), name="product-images")

# index.html — НЕ кешувати (щоб деплой/оновлення фронтенду показувались одразу, без
# «застряглого» старого бандла в Telegram-WebView). Хешовані asset-и (assets/*.js|css)
# лишаємо кешованими браузером — їхні імена змінюються при кожному білді.
@app.middleware("http")
async def _no_cache_index(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", "/index.html")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# Продакшн-збірка фронтенду (npm run build) — віддається цим же сервером
_frontend_dist = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend", "dist")
if os.path.isdir(_frontend_dist):
    app.mount("/", StaticFiles(directory=_frontend_dist, html=True), name="frontend")
