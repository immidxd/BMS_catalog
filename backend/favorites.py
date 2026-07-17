"""«Обране» користувача — публічний write, авторизований Telegram initData.

На відміну від admin.py (лише адміни), ці ендпоінти доступні БУДЬ-ЯКОМУ валідному
Telegram-користувачу: кожен зберігає свій список у catalog_favorites за своїм
telegram_user_id (синхронізується між входами/пристроями). Поза Telegram (браузер)
initData немає — там фронтенд тримає обране локально (localStorage).
"""

from typing import List, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from auth import telegram_user_from_init_data
from database import get_db

router = APIRouter()


def _require_user(init_data: Optional[str]) -> int:
    uid = telegram_user_from_init_data(init_data or "")
    if uid is None:
        raise HTTPException(status_code=401, detail="Потрібен Telegram")
    return uid


@router.get("/api/favorites")
async def list_favorites(
    x_telegram_init_data: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """Список номерів товарів в «Обраному» поточного користувача."""
    uid = _require_user(x_telegram_init_data)
    try:
        rows = db.execute(
            text("SELECT productnumber FROM catalog_favorites WHERE telegram_user_id = :uid"),
            {"uid": uid},
        ).scalars().all()
    except Exception:
        db.rollback()
        rows = []
    return {"productnumbers": list(rows)}


@router.post("/api/favorites")
async def toggle_favorite(
    productnumber: str = Body(..., embed=True),
    favorite: bool = Body(..., embed=True),
    x_telegram_init_data: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """Додати/прибрати товар з «Обраного». Повертає новий публічний лічильник ♥️."""
    uid = _require_user(x_telegram_init_data)
    pnum = (productnumber or "").strip()
    if not pnum:
        raise HTTPException(status_code=400, detail="Порожній номер")
    if favorite:
        db.execute(text("""
            INSERT INTO catalog_favorites (telegram_user_id, productnumber)
            VALUES (:uid, :pn) ON CONFLICT DO NOTHING
        """), {"uid": uid, "pn": pnum})
    else:
        db.execute(text(
            "DELETE FROM catalog_favorites WHERE telegram_user_id = :uid AND productnumber = :pn"
        ), {"uid": uid, "pn": pnum})
    db.commit()
    count = db.execute(
        text("SELECT COUNT(*) FROM catalog_favorites WHERE productnumber = :pn"), {"pn": pnum}
    ).scalar() or 0
    return {"productnumber": pnum, "favorite": favorite, "fav_count": int(count)}
