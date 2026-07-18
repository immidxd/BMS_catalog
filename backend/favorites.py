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
    """Суворо: лише ПІДПИСАНИЙ Telegram-користувач (для читання приватного списку)."""
    uid = telegram_user_from_init_data(init_data or "")
    if uid is None:
        raise HTTPException(status_code=401, detail="Потрібен Telegram")
    return uid


def _count_user(init_data: Optional[str], user_id: Optional[int]) -> int:
    """Для ПУБЛІЧНОГО лічильника ♥️: підписаний initData (пріоритет) АБО непідписаний
    telegram user.id (фолбек, коли initData не верифікується — напр. Mini App від
    іншого бота). Обране не є приватними даними, тож для лічильника фолбек прийнятний.
    Персональний список у клієнта тримається в Telegram CloudStorage, не тут."""
    uid = telegram_user_from_init_data(init_data or "")
    if uid is not None:
        return uid
    if isinstance(user_id, int) and user_id > 0:
        return user_id
    raise HTTPException(status_code=401, detail="Немає ідентифікатора користувача")


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
    user_id: Optional[int] = Body(None, embed=True),   # непідписаний фолбек для лічильника
    x_telegram_init_data: Optional[str] = Header(None),
    db: Session = Depends(get_db),
):
    """Додати/прибрати товар з «Обраного». Повертає новий публічний лічильник ♥️."""
    uid = _count_user(x_telegram_init_data, user_id)
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
