"""Драйвер БД не має залежати від «типового» в SQLAlchemy (інцидент 05.10.2026:
SQLAlchemy 2.1 перейшов на psycopg 3 → каталог не стартував на Railway)."""
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _db(monkeypatch, url):
    monkeypatch.setenv("DATABASE_URL", url)
    import database
    return importlib.reload(database)


def test_plain_and_heroku_style_urls_get_psycopg2(monkeypatch):
    for url in ("postgresql://u:p@h/db?sslmode=require", "postgres://u:p@h/db",
                "postgresql+psycopg://u:p@h/db"):
        db = _db(monkeypatch, url)
        assert db.DATABASE_URL.startswith("postgresql+psycopg2://u:p@h/db")
        assert db.engine.dialect.driver == "psycopg2"
    assert _db(monkeypatch, "postgresql://u:p@h/db?sslmode=require").DATABASE_URL.endswith("?sslmode=require")


def test_explicit_other_driver_is_left_alone(monkeypatch):
    from database import _with_psycopg2
    assert _with_psycopg2("postgresql+psycopg2://x") == "postgresql+psycopg2://x"
    assert _with_psycopg2("sqlite:///x.db") == "sqlite:///x.db"
