"""Підключення до спільної БД bsstorage (read-only для каталогу)."""

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool
from sqlalchemy.orm import sessionmaker

# .env лежить у корені tg_app
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "postgres")
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "bsstorage")

# Хмара (Neon/Supabase) дає готовий рядок підключення з SSL — якщо заданий
# DATABASE_URL, використовуємо його напряму (інакше будуємо з локальних DB_*).
DATABASE_URL = os.getenv("DATABASE_URL") or \
    f"postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

# Пул з'єднань. ЛОКАЛЬНО (свій Postgres) тримаємо звичайний пул — це швидко й дешево.
# У ХМАРІ (Neon) постійно відкрите з'єднання не дає compute заснути, і безкоштовні
# 100 CU-годин згорають за місяць цілодобової «тиші». Тому там — NullPool: з'єднання
# закривається одразу після запиту, Neon засинає через 5 хв простою (плата = 0).
_IS_CLOUD = bool(os.getenv("DATABASE_URL"))
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    **({"poolclass": NullPool} if _IS_CLOUD else {"pool_size": 5}),
    connect_args={"connect_timeout": int(os.getenv("DB_CONNECT_TIMEOUT", "10"))}
    if DATABASE_URL.startswith("postgres") else {},
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
