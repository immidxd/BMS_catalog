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


@router.patch("/api/admin/catalog/description", response_model=Dict[str, Any])
async def edit_catalog_description(
    product_id: int = Body(..., embed=True),               # оновлюємо ОПИС саме цього рядка
    productnumber: str = Body(..., embed=True),            # прапорець публічності — по номеру
    description: Optional[str] = Body(None, embed=True),   # None → текст не чіпаємо
    is_public: Optional[bool] = Body(None, embed=True),    # None → публічність не чіпаємо
    authorization: Optional[str] = Header(None),
    x_telegram_init_data: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """Адмін: редагувати опис товару (пишемо в products.description — те саме поле, що
    в BMS) та/або зробити його публічним (catalog_listings.is_description_public).

    Опис оновлюємо ЛИШЕ для конкретного рядка (product_id) — це те, що бачить адмін
    у картці, і не чіпає інші рядки ростовки, у яких опис може бути свій. Прапорець
    публічності — по номеру (він картковий, діє на всю картку)."""
    if not admin_writes_enabled():
        raise HTTPException(status_code=503, detail="Адмін-запис не налаштовано")
    if not authorize_admin(authorization, x_telegram_init_data):
        raise HTTPException(status_code=401, detail="Не авторизовано")

    pnum = (productnumber or "").strip()
    row = db.execute(
        text("SELECT productnumber FROM products WHERE id = :id"), {"id": product_id}
    ).scalar()
    if row is None:
        raise HTTPException(status_code=404, detail="Товар не знайдено")

    if description is not None:
        db.execute(
            text("UPDATE products SET description = :d WHERE id = :id"),
            {"d": description.strip() or None, "id": product_id},
        )
    if is_public is not None:
        db.execute(text("""
            INSERT INTO catalog_listings (productnumber, is_published, is_featured, is_description_public, updated_at)
            VALUES (:pn, FALSE, FALSE, :pub, now())
            ON CONFLICT (productnumber) DO UPDATE SET
                is_description_public = EXCLUDED.is_description_public,
                updated_at = now()
        """), {"pn": pnum, "pub": is_public})
    db.commit()
    return {"product_id": product_id, "productnumber": pnum,
            "description": description, "is_description_public": is_public}
