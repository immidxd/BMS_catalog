"""Підключення до спільної БД bsstorage (read-only для каталогу)."""

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine
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

engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=5)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
