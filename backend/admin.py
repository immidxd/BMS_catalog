"""Адмін-API каталогу (Фаза 2) — ЄДИНІ записи в усьому застосунку.

Запис лише у `catalog_listings` (публікація товару). Доступ — суворо через
auth.authorize_admin (Telegram initData або адмін-токен). Публічне API лишається
read-only й цього роутера не торкається.
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from auth import admin_writes_enabled, authorize_admin
from database import get_db

router = APIRouter()


@router.patch("/api/admin/catalog", response_model=Dict[str, Any])
async def set_catalog_publication(
    productnumber: str = Body(..., embed=True),
    is_published: bool = Body(..., embed=True),
    is_featured: bool = Body(False, embed=True),
    authorization: Optional[str] = Header(None),
    x_telegram_init_data: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """Опублікувати/зняти товар (+ «Рекомендований») прямо з каталогу. Upsert у
    catalog_listings за productnumber (діє на всю картку/ростовку)."""
    if not admin_writes_enabled():
        raise HTTPException(status_code=503, detail="Адмін-запис не налаштовано")
    if not authorize_admin(authorization, x_telegram_init_data):
        raise HTTPException(status_code=401, detail="Не авторизовано")

    pnum = (productnumber or "").strip()
    exists = db.execute(
        text("SELECT 1 FROM products WHERE productnumber = :pn LIMIT 1"), {"pn": pnum}
    ).scalar()
    if not exists:
        raise HTTPException(status_code=404, detail="Товар не знайдено")

    feat = bool(is_featured and is_published)  # «Рекомендований» лише для опублікованого
    db.execute(text("""
        INSERT INTO catalog_listings (productnumber, is_published, is_featured, published_at, updated_at)
        VALUES (:pn, :pub, :feat, CASE WHEN :pub THEN now() END, now())
        ON CONFLICT (productnumber) DO UPDATE SET
            is_published = EXCLUDED.is_published,
            is_featured  = EXCLUDED.is_featured,
            published_at = COALESCE(catalog_listings.published_at, EXCLUDED.published_at),
            updated_at   = now()
    """), {"pn": pnum, "pub": is_published, "feat": feat})
    db.commit()
    return {"productnumber": pnum, "is_published": is_published, "is_featured": feat}
