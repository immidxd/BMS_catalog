"""Склад: коробки, вміст, події — API для Mini App «BMS Склад» і для десктопної BMS.

Схема — sql/warehouse.sql (застосовується при старті, ідемпотентно). Це ЄДИНЕ
джерело правди про те, що в якій коробці лежить; синхронізації з локальною
базою BMS немає навмисно.

Хто може писати:
  • працівник із Mini App — валідний Telegram `initData`, підписаний ботом
    складу (WAREHOUSE_BOT_TOKEN; поки не задано — бот вітрини BOT_TOKEN), і
    user.id ∈ WAREHOUSE_TG_IDS (поки не задано — ADMIN_TG_IDS);
  • BMS — Bearer CATALOG_ADMIN_TOKEN (той самий, що для публікацій).
Читати теж лише вони: вміст складу — не публічна інформація.

Товар = рядок products (id), не номер: ростовка — кілька рядків з одним
номером, і в коробці лежить конкретна пара конкретного розміру. Рядок із
quantity>1 може лежати частинами в різних коробках (qty у кожній).
"""

from __future__ import annotations

import hmac
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from auth import _admin_ids, _admin_token, _bot_token, telegram_profile_from_init_data
from catalog import _SOLD_JOIN
from database import SessionLocal, get_db
from images import main_image_url

router = APIRouter(prefix="/api/wh", tags=["warehouse"])

QR_PRODUCT = "bms:p:"
QR_BOX = "bms:b:"
BOX_CODE_RE = re.compile(r"^[A-ZА-ЯІЇЄҐ]{1,3}\d{1,4}$")


# ───────────────────────────── схема ─────────────────────────────────────────

def ensure_warehouse_schema(db: Session) -> None:
    sql = (Path(__file__).resolve().parent / "sql" / "warehouse.sql").read_text(encoding="utf-8")
    db.execute(text(sql))
    db.commit()


# ───────────────────────────── доступ ────────────────────────────────────────

def _wh_bot_token() -> str:
    return (os.getenv("WAREHOUSE_BOT_TOKEN") or "").strip() or _bot_token()


def _owner_ids() -> set[int]:
    """Власники — з налаштувань сервера (WAREHOUSE_TG_IDS, інакше ADMIN_TG_IDS)."""
    raw = (os.getenv("WAREHOUSE_TG_IDS") or "").replace(" ", "")
    ids = {int(x) for x in raw.split(",") if x.isdigit()}
    return ids or _admin_ids()


_staff_cache: Dict[str, Any] = {"at": 0.0, "ids": set()}


def _db_staff_ids() -> set[int]:
    """Активні працівники з wh_staff (кеш 15 с — не ходити в базу на кожен запит)."""
    import time as _time
    now = _time.time()
    if now - _staff_cache["at"] < 15:
        return _staff_cache["ids"]
    db = SessionLocal()
    try:
        rows = db.execute(text("SELECT tg_id FROM wh_staff WHERE status = 'active'")).fetchall()
        ids = {int(r[0]) for r in rows}
    except Exception:  # noqa: BLE001 — таблиці ще нема / база моргнула
        ids = _staff_cache["ids"]
    finally:
        db.close()
    _staff_cache.update(at=now, ids=ids)
    return ids


def _staff_cache_reset() -> None:
    _staff_cache["at"] = 0.0


def _staff_ids() -> set[int]:
    return _owner_ids() | _db_staff_ids()


def require_staff(
    authorization: Optional[str] = Header(None),
    x_telegram_init_data: Optional[str] = Header(None),
) -> str:
    """Повертає рядок-актора для журналу: «tg:<id> Ім'я» або «bms»."""
    tok = _admin_token()
    if tok and authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and hmac.compare_digest(value.strip(), tok):
            return "bms"
    if x_telegram_init_data:
        prof = telegram_profile_from_init_data(x_telegram_init_data, token=_wh_bot_token())
        if prof and prof["id"] in _staff_ids():
            name = prof.get("name") or prof.get("username") or ""
            return f"tg:{prof['id']} {name}".strip()
    raise HTTPException(status_code=401, detail="Немає доступу до складу")


@router.get("/whoami")
def whoami(x_telegram_init_data: Optional[str] = Header(None),
           authorization: Optional[str] = Header(None)):
    """Самодіагностика доступу для Mini App: ХТО відкрив і ЧОМУ (не) пустили —
    без секретів. Показує id користувача, чи підпис initData збігається з
    ботом складу / ботом вітрини, чи id у білому списку, і що не задано на
    сервері. Це те, що власник бачить замість глухого «Немає доступу»."""
    import json as _json
    from urllib.parse import parse_qsl
    uid: Optional[int] = None
    name = ""
    if x_telegram_init_data:
        try:
            user = _json.loads(dict(parse_qsl(x_telegram_init_data, keep_blank_values=True)).get("user", "{}"))
            uid = int(user.get("id")) if user.get("id") else None
            name = " ".join(x for x in (user.get("first_name"), user.get("last_name")) if x).strip()
        except Exception:  # noqa: BLE001
            uid = None
    wh_token_raw = os.getenv("WAREHOUSE_BOT_TOKEN") or ""
    wh_token_set = bool(wh_token_raw.strip())
    staff_set = bool((os.getenv("WAREHOUSE_TG_IDS") or "").strip())
    # Форма токена (без витоку): лапки/пробіли — типова помилка при вставці.
    token_shape = {
        "looks_valid": bool(re.match(r"^\d{6,12}:[A-Za-z0-9_-]{30,}$", wh_token_raw.strip())),
        "has_quotes": wh_token_raw.strip()[:1] in ("'", '"'),
        "has_spaces": wh_token_raw != wh_token_raw.strip() or " " in wh_token_raw.strip(),
    }
    bot_info = _bot_identity(_wh_bot_token())
    menu = bot_menu_button((os.getenv("WAREHOUSE_BOT_TOKEN") or "").strip()) if wh_token_set else None
    app_url = public_app_url()
    sig_wh = bool(x_telegram_init_data and telegram_profile_from_init_data(x_telegram_init_data, token=_wh_bot_token()))
    sig_shop = bool(x_telegram_init_data and _bot_token() and telegram_profile_from_init_data(x_telegram_init_data, token=_bot_token()))
    in_staff = uid is not None and uid in _staff_ids()
    staff_status: Optional[str] = None
    if uid is not None:
        if uid in _owner_ids():
            staff_status = "owner"
        else:
            db = SessionLocal()
            try:
                staff_status = db.execute(text("SELECT status FROM wh_staff WHERE tg_id = :i"), {"i": uid}).scalar()
                if staff_status == "active":
                    db.execute(text("UPDATE wh_staff SET last_seen_at = now() WHERE tg_id = :i"), {"i": uid})
                    db.commit()
            except Exception:  # noqa: BLE001
                staff_status = None
            finally:
                db.close()
    problems: List[str] = []
    if wh_token_set and token_shape["has_quotes"]:
        problems.append("WAREHOUSE_BOT_TOKEN вставлено з лапками — приберіть їх.")
    if wh_token_set and not token_shape["looks_valid"]:
        problems.append("WAREHOUSE_BOT_TOKEN не схожий на токен бота (формат 1234567890:AAF…).")
    if wh_token_set and bot_info and not bot_info.get("ok"):
        problems.append("Telegram не приймає WAREHOUSE_BOT_TOKEN (getMe: " + str(bot_info.get("error")) + ").")
    if wh_token_set and menu and menu.get("ok") and app_url and menu.get("url") != app_url:
        problems.append(f"Кнопка меню бота веде не на цей застосунок ({menu.get('url') or 'не задана'}); "
                        f"сервер сам виставить {app_url} при наступному старті.")
    if not x_telegram_init_data:
        problems.append("Застосунок відкрито не з Telegram (немає initData).")
    else:
        if not sig_wh and not sig_shop:
            who = (f"токен на сервері належить боту @{bot_info['username']}" if bot_info and bot_info.get("username")
                   else "це токен іншого бота")
            problems.append("Підпис не збігається з жодним ботом: на сервері "
                            + (f"WAREHOUSE_BOT_TOKEN задано, але {who}. Відкрийте застосунок саме через цього бота "
                               f"або вставте токен того бота, через якого відкриваєте." if wh_token_set
                               else "не задано WAREHOUSE_BOT_TOKEN (токен бота, через якого відкрито застосунок)."))
        elif not sig_wh and sig_shop:
            problems.append("Відкрито через бота вітрини, а не бота складу.")
        if uid is not None and not in_staff and staff_status not in ("pending", "blocked"):
            problems.append(f"Ваш Telegram id {uid} не в списку працівників.")
    # Адмін-токен (BMS / розробка в браузері) — теж повний доступ.
    tok = _admin_token()
    bearer_ok = False
    if tok and authorization:
        scheme, _, value = authorization.partition(" ")
        bearer_ok = scheme.lower() == "bearer" and hmac.compare_digest(value.strip(), tok)
    if bearer_ok:
        problems = []
    return {"user_id": uid, "name": name or ("BMS" if bearer_ok else ""),
            "access": bool(bearer_ok or (sig_wh and in_staff)),
            "signature_warehouse_bot": sig_wh, "signature_shop_bot": sig_shop, "in_staff": in_staff,
            "staff_status": staff_status,
            "server": {"warehouse_bot_token_set": wh_token_set, "staff_ids_set": staff_set,
                       "token_shape": token_shape,
                       "warehouse_bot": ({"username": bot_info.get("username"), "id": bot_info.get("id")}
                                         if bot_info and bot_info.get("ok") else None),
                       "menu_button": menu, "app_url": app_url},
            "problems": problems}


def public_app_url() -> Optional[str]:
    """Публічна адреса Mini App складу: WAREHOUSE_PUBLIC_URL або домен Railway."""
    explicit = (os.getenv("WAREHOUSE_PUBLIC_URL") or "").strip().rstrip("/")
    if explicit:
        return explicit if explicit.endswith("/wh") else explicit + "/wh"
    domain = (os.getenv("RAILWAY_PUBLIC_DOMAIN") or "").strip()
    return f"https://{domain}/wh" if domain else None


def bot_menu_button(token: str) -> Optional[Dict[str, Any]]:
    """Куди зараз веде кнопка меню бота (getChatMenuButton) — публічне налаштування."""
    import requests as _rq
    if not token:
        return None
    try:
        r = _rq.get(f"https://api.telegram.org/bot{token}/getChatMenuButton", timeout=6).json()
        if not r.get("ok"):
            return {"ok": False, "error": r.get("description")}
        btn = r.get("result") or {}
        return {"ok": True, "type": btn.get("type"), "text": btn.get("text"),
                "url": (btn.get("web_app") or {}).get("url")}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:80]}


def ensure_bot_menu_button() -> Optional[str]:
    """При старті: якщо є токен бота складу й публічна адреса — поставити боту
    кнопку меню «Склад» → /wh (setChatMenuButton). Це знімає крок BotFather і
    гарантує, що застосунок відкривається саме тим ботом, чиїм токеном сервер
    перевіряє підпис. Ідемпотентно: не чіпає, якщо вже вказує куди треба."""
    import requests as _rq
    token = (os.getenv("WAREHOUSE_BOT_TOKEN") or "").strip()
    url = public_app_url()
    if not token or not url:
        return None
    cur = bot_menu_button(token)
    if cur and cur.get("ok") and cur.get("url") == url:
        return url
    try:
        r = _rq.post(f"https://api.telegram.org/bot{token}/setChatMenuButton", timeout=8,
                     json={"menu_button": {"type": "web_app", "text": "Склад", "web_app": {"url": url}}}).json()
        return url if r.get("ok") else None
    except Exception:  # noqa: BLE001
        return None


_BOT_IDENTITY_CACHE: Dict[str, Any] = {}


def _bot_identity(token: str) -> Optional[Dict[str, Any]]:
    """Кому належить токен — getMe у Telegram (нік бота публічний, токен не
    світимо). Кеш на 5 хв на токен, щоб не смикати Telegram на кожне відкриття."""
    import time as _time
    import requests as _rq
    if not token:
        return None
    key = str(hash(token))
    hit = _BOT_IDENTITY_CACHE.get(key)
    if hit and _time.time() - hit["at"] < 300:
        return hit["val"]
    try:
        r = _rq.get(f"https://api.telegram.org/bot{token}/getMe", timeout=6)
        data = r.json()
        val = ({"ok": True, "username": data["result"].get("username"), "id": data["result"].get("id")}
               if data.get("ok") else {"ok": False, "error": data.get("description", r.status_code)})
    except Exception as exc:  # noqa: BLE001
        val = {"ok": False, "error": str(exc)[:80]}
    _BOT_IDENTITY_CACHE[key] = {"at": _time.time(), "val": val}
    return val


# ───────────────────────────── допоміжне ─────────────────────────────────────

def parse_code(raw: str) -> Optional[Dict[str, Any]]:
    """`bms:p:<id>:<номер>` → product; `bms:b:<код>` → box; інакше None."""
    s = (raw or "").strip()
    if s.startswith(QR_PRODUCT):
        pid, _, number = s[len(QR_PRODUCT):].partition(":")
        return {"kind": "product", "id": int(pid), "number": number or None} if pid.isdigit() else None
    if s.startswith(QR_BOX):
        code = s[len(QR_BOX):].strip().upper()
        return {"kind": "box", "code": code} if code else None
    return None


def normalize_box_code(code: str) -> str:
    c = re.sub(r"\s+", "", (code or "")).upper()
    if not BOX_CODE_RE.match(c):
        raise HTTPException(status_code=400, detail="Код коробки: 1–3 літери + номер, напр. Z9, L12")
    return c


def _event(db: Session, actor: str, kind: str, *, box: Optional[Dict[str, Any]] = None,
           product: Optional[Dict[str, Any]] = None, qty: Optional[int] = None,
           details: Optional[Dict[str, Any]] = None, undo_of: Optional[int] = None) -> int:
    r = db.execute(text("""
        INSERT INTO wh_events (actor, kind, box_id, box_code, product_id, productnumber, qty, details, undo_of)
        VALUES (:actor, :kind, :box_id, :box_code, :pid, :pnum, :qty, CAST(:details AS jsonb), :undo_of)
        RETURNING id
    """), {
        "actor": actor, "kind": kind,
        "box_id": box["id"] if box else None, "box_code": box["code"] if box else None,
        "pid": product["id"] if product else None,
        "pnum": product.get("productnumber") if product else None,
        "qty": qty, "details": json.dumps(details or {}, ensure_ascii=False), "undo_of": undo_of,
    }).scalar()
    return int(r)


_PRODUCT_SQL = """
    SELECT p.id, p.productnumber, p.model, p.price, p.oldprice, p.quantity, p.sizeeu, p.size_letter,
           p.sizeua, p.measurementscm, p.season, p.official_photos_from,
           b.brandname AS brand, t.typename AS type, c.colorname AS color,
           g.gendername AS gender, cond.conditionname AS condition,
           COALESCE(sold.sold_count, 0) AS sold_count,
           GREATEST(COALESCE(p.quantity, 0) - COALESCE(sold.sold_count, 0), 0) AS available_qty
    FROM products p
    LEFT JOIN brands b ON b.id = p.brandid
    LEFT JOIN types t ON t.id = p.typeid
    LEFT JOIN colors c ON c.id = p.colorid
    LEFT JOIN genders g ON g.id = p.genderid
    LEFT JOIN conditions cond ON cond.id = COALESCE(p.current_conditionid, p.conditionid)
""" + _SOLD_JOIN


def _size_text(r: Dict[str, Any]) -> str:
    eu = (r.get("sizeeu") or "").strip()
    if eu:
        return f"EU {eu}"
    return (r.get("size_letter") or r.get("sizeua") or "").strip()


def _product_dict(r: Dict[str, Any]) -> Dict[str, Any]:
    pnum = r.get("productnumber") or ""
    return {
        "id": int(r["id"]),
        "productnumber": pnum,
        "number": pnum.lstrip("#"),
        "size": _size_text(r),
        "insole": (r.get("measurementscm") or "").strip(),
        "brand": r.get("brand"), "model": r.get("model"), "type": r.get("type"),
        "color": r.get("color"), "gender": r.get("gender"), "season": r.get("season"),
        "condition": r.get("condition"),
        "price": r.get("price"),
        "oldprice": r.get("oldprice"),
        "quantity": int(r.get("quantity") or 0),
        "sold_count": int(r.get("sold_count") or 0),
        "available_qty": int(r.get("available_qty") or 0),
        "image": main_image_url(pnum, r.get("official_photos_from") or ""),
    }


def _load_product(db: Session, product_id: int) -> Optional[Dict[str, Any]]:
    r = db.execute(text(_PRODUCT_SQL + " WHERE p.id = :id"), {"id": int(product_id)}).mappings().first()
    return _product_dict(dict(r)) if r else None


def _find_products_by_number(db: Session, number: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Пошук за номером (з «#» чи без): точний збіг спершу, далі за префіксом."""
    n = (number or "").strip().lstrip("#").upper()
    if not n:
        return []
    rows = db.execute(text(_PRODUCT_SQL + """
        WHERE UPPER(LTRIM(p.productnumber, '#')) LIKE :pref
        ORDER BY (UPPER(LTRIM(p.productnumber, '#')) = :exact) DESC, p.productnumber, p.sizeeu
        LIMIT :lim
    """), {"pref": n + "%", "exact": n, "lim": int(limit)}).mappings().all()
    return [_product_dict(dict(r)) for r in rows]


def _locations(db: Session, product_ids: List[int]) -> Dict[int, List[Dict[str, Any]]]:
    """Де зараз лежать товари: {product_id: [{box_code, box_title, qty, packed_at}]}."""
    if not product_ids:
        return {}
    rows = db.execute(text("""
        SELECT i.product_id, i.qty, i.packed_at, b.code, b.title, b.location, b.status, b.needs_check
        FROM wh_box_items i JOIN wh_boxes b ON b.id = i.box_id
        WHERE i.unpacked_at IS NULL AND i.product_id = ANY(:ids)
        ORDER BY i.packed_at DESC
    """), {"ids": [int(i) for i in product_ids]}).mappings().all()
    out: Dict[int, List[Dict[str, Any]]] = {}
    for r in rows:
        out.setdefault(int(r["product_id"]), []).append({
            "box_code": r["code"], "box_title": r["title"], "box_location": r["location"],
            "box_status": r["status"], "needs_check": r["needs_check"],
            "qty": int(r["qty"]), "packed_at": r["packed_at"],
        })
    return out


def _box_row(db: Session, code: str, for_update: bool = False) -> Optional[Dict[str, Any]]:
    sql = "SELECT * FROM wh_boxes WHERE code = :c" + (" FOR UPDATE" if for_update else "")
    r = db.execute(text(sql), {"c": normalize_box_code(code)}).mappings().first()
    return dict(r) if r else None


def _box_summary_sql(where: str = "") -> str:
    return f"""
        SELECT b.*, COALESCE(s.items, 0) AS items, COALESCE(s.units, 0) AS units,
               COALESCE(s.value, 0) AS value
        FROM wh_boxes b
        LEFT JOIN (
            SELECT i.box_id, COUNT(*) AS items, SUM(i.qty) AS units,
                   SUM(i.qty * COALESCE(p.price, 0)) AS value
            FROM wh_box_items i LEFT JOIN products p ON p.id = i.product_id
            WHERE i.unpacked_at IS NULL
            GROUP BY i.box_id
        ) s ON s.box_id = b.id
        {where}
    """


def _box_dict(r: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": int(r["id"]), "code": r["code"], "category": r.get("category"),
        "title": r.get("title"), "location": r.get("location"), "status": r.get("status"),
        "needs_check": bool(r.get("needs_check")), "note": r.get("note"),
        "items": int(r.get("items") or 0), "units": int(r.get("units") or 0),
        "value": float(r.get("value") or 0),
        "created_at": r.get("created_at"), "sealed_at": r.get("sealed_at"),
        "checked_at": r.get("checked_at"), "updated_at": r.get("updated_at"),
        "created_by": r.get("created_by"),
    }


def next_box_code(db: Session, category: str) -> str:
    cat = re.sub(r"[^A-ZА-ЯІЇЄҐ]", "", (category or "").upper())[:3]
    if not cat:
        raise HTTPException(status_code=400, detail="Вкажіть літеру категорії (Z, L, D, T, V…)")
    rows = db.execute(text("SELECT code FROM wh_boxes WHERE code LIKE :p"), {"p": cat + "%"}).fetchall()
    used = set()
    for (code,) in rows:
        m = re.match(rf"^{re.escape(cat)}(\d+)$", code)
        if m:
            used.add(int(m.group(1)))
    n = 1
    while n in used:
        n += 1
    return f"{cat}{n}"


# ───────────────────────────── схеми запитів ─────────────────────────────────

class BoxCreate(BaseModel):
    code: Optional[str] = None            # порожньо → згенерувати за категорією
    category: Optional[str] = None        # літера сезону
    title: Optional[str] = None
    location: Optional[str] = None
    note: Optional[str] = None
    needs_check: bool = False
    op_id: Optional[str] = None           # ідемпотентність (офлайн-черга телефона)


class BoxPatch(BaseModel):
    title: Optional[str] = None
    location: Optional[str] = None
    note: Optional[str] = None
    category: Optional[str] = None
    needs_check: Optional[bool] = None
    op_id: Optional[str] = None


class PackIn(BaseModel):
    product_id: int
    qty: int = Field(1, ge=1, le=99)
    move: bool = False                    # уже лежить в іншій коробці → перенести
    op_id: Optional[str] = None


class UnpackIn(BaseModel):
    product_id: int
    qty: Optional[int] = Field(None, ge=1, le=99)   # None → усе, що лежить
    op_id: Optional[str] = None


# ───────────────────────────── ідемпотентність ───────────────────────────────
# Дія з телефона може дійти двічі (обрив після коміту, повтор із офлайн-черги).
# Клієнт дає op_id; ми займаємо його ДО дії, а результат кладемо в тій самій
# транзакції — повтор отримує збережену відповідь і нічого не змінює.

class _Replay(Exception):
    def __init__(self, result: Any): self.result = result


def _claim_op(db: Session, op_id: Optional[str], kind: str, actor: str) -> None:
    """Зайняти op_id. Уже є з результатом → _Replay(результат); є без
    результату (виконується паралельно) → 409 «повторіть»."""
    if not op_id:
        return
    r = db.execute(text("""
        INSERT INTO wh_client_ops (op_id, kind, actor) VALUES (:id, :kind, :actor)
        ON CONFLICT (op_id) DO NOTHING RETURNING op_id
    """), {"id": op_id[:128], "kind": kind, "actor": actor}).first()
    if r:
        return
    row = db.execute(text("SELECT result, created_at < now() - interval '2 minutes' AS stale FROM wh_client_ops WHERE op_id = :id"),
                     {"id": op_id[:128]}).mappings().first()
    if row and row["result"] is not None:
        raise _Replay(row["result"])
    if row and row["stale"]:
        # Зайнято, але результату так і не зʼявилось (процес упав між діями) —
        # перебираємо на себе, інакше op_id лишився б «у польоті» назавжди.
        db.execute(text("UPDATE wh_client_ops SET created_at = now(), actor = :actor WHERE op_id = :id"),
                   {"id": op_id[:128], "actor": actor})
        return
    raise HTTPException(status_code=409, detail={"code": "in_flight", "message": "Ця дія ще виконується — повторіть за мить"})


def _finish_op(db: Session, op_id: Optional[str], result: Any) -> None:
    if op_id:
        db.execute(text("UPDATE wh_client_ops SET result = CAST(:r AS jsonb) WHERE op_id = :id"),
                   {"id": op_id[:128], "r": json.dumps(result, ensure_ascii=False, default=str)})


# ───────────────────────────── читання ───────────────────────────────────────

@router.get("/scan")
def scan(code: str = Query(..., min_length=1), db: Session = Depends(get_db),
         actor: str = Depends(require_staff)):
    """Що відсканували: товар (із місцем) або коробка (з вмістом)."""
    parsed = parse_code(code)
    if not parsed:
        # Може, набрали номер руками або сканер прочитав чужий код.
        found = _find_products_by_number(db, code, limit=10)
        if not found:
            raise HTTPException(status_code=404, detail="Це не код BMS і не номер товару")
        locs = _locations(db, [p["id"] for p in found])
        for p in found:
            p["locations"] = locs.get(p["id"], [])
        return {"kind": "products", "products": found}
    if parsed["kind"] == "box":
        return {"kind": "box", "box": box_detail(parsed["code"], db, actor)}
    prod = _load_product(db, parsed["id"])
    if not prod:
        # Рядок зник (злиття/перейменування) — рятуємось номером зі стікера.
        found = _find_products_by_number(db, parsed.get("number") or "", limit=10)
        if not found:
            raise HTTPException(status_code=404, detail="Товар зі стікера не знайдено")
        locs = _locations(db, [p["id"] for p in found])
        for p in found:
            p["locations"] = locs.get(p["id"], [])
        return {"kind": "products", "products": found, "stale_sticker": True}
    prod["locations"] = _locations(db, [prod["id"]]).get(prod["id"], [])
    return {"kind": "product", "product": prod}


@router.get("/search")
def search(q: str = Query(..., min_length=1), db: Session = Depends(get_db),
           _: str = Depends(require_staff)):
    found = _find_products_by_number(db, q, limit=20)
    locs = _locations(db, [p["id"] for p in found])
    for p in found:
        p["locations"] = locs.get(p["id"], [])
    return {"products": found}


@router.get("/products/{product_id}")
def product(product_id: int, db: Session = Depends(get_db), _: str = Depends(require_staff)):
    prod = _load_product(db, product_id)
    if not prod:
        raise HTTPException(status_code=404, detail="Товар не знайдено")
    prod["locations"] = _locations(db, [prod["id"]]).get(prod["id"], [])
    return prod


@router.get("/locations")
def locations(product_ids: str = Query(..., description="id через кому"),
              db: Session = Depends(get_db), _: str = Depends(require_staff)):
    """Пакетно: де лежать товари (для колонки «Коробка» в BMS)."""
    ids = [int(x) for x in product_ids.split(",") if x.strip().isdigit()][:2000]
    return {"locations": {str(k): v for k, v in _locations(db, ids).items()}}


@router.get("/boxes")
def boxes(status: Optional[str] = None, db: Session = Depends(get_db),
          _: str = Depends(require_staff)):
    where = "WHERE b.status = :st" if status else "WHERE b.status <> 'archived'"
    # Новіші коробки зверху — на складі працюють із щойно створеними.
    rows = db.execute(text(_box_summary_sql(where) + " ORDER BY b.created_at DESC, b.id DESC"),
                      {"st": status} if status else {}).mappings().all()
    return {"boxes": [_box_dict(dict(r)) for r in rows]}


@router.get("/boxes/next-code")
def boxes_next_code(category: str = Query(..., min_length=1), db: Session = Depends(get_db),
                    _: str = Depends(require_staff)):
    return {"code": next_box_code(db, category)}


@router.get("/boxes/{code}")
def box_detail(code: str, db: Session = Depends(get_db), _: str = Depends(require_staff)):
    r = db.execute(text(_box_summary_sql("WHERE b.code = :c")), {"c": normalize_box_code(code)}).mappings().first()
    if not r:
        raise HTTPException(status_code=404, detail=f"Коробки {code} немає")
    box = _box_dict(dict(r))
    items = db.execute(text("""
        SELECT i.id AS item_id, i.product_id, i.productnumber AS snap_number, i.size AS snap_size,
               i.color AS snap_color, i.qty, i.packed_at, i.packed_by
        FROM wh_box_items i WHERE i.box_id = :b AND i.unpacked_at IS NULL
        ORDER BY i.packed_at DESC
    """), {"b": box["id"]}).mappings().all()
    prods = {}
    if items:
        rows = db.execute(text(_PRODUCT_SQL + " WHERE p.id = ANY(:ids)"),
                          {"ids": [int(i["product_id"]) for i in items]}).mappings().all()
        prods = {int(r["id"]): _product_dict(dict(r)) for r in rows}
    out = []
    for i in items:
        p = prods.get(int(i["product_id"]))
        out.append({
            "item_id": int(i["item_id"]), "product_id": int(i["product_id"]),
            "qty": int(i["qty"]), "packed_at": i["packed_at"], "packed_by": i["packed_by"],
            "product": p or {"id": int(i["product_id"]), "productnumber": i["snap_number"],
                             "number": (i["snap_number"] or "").lstrip("#"), "size": i["snap_size"],
                             "color": i["snap_color"], "missing": True},
        })
    box["contents"] = out
    return box


UNDOABLE_KINDS = {"pack", "unpack", "move", "seal", "open", "check", "box_create", "box_delete", "box_edit"}


def _events_query(db: Session, *, box: Optional[str], product_id: Optional[int], actor: Optional[str],
                  kind: Optional[str], limit: int, offset: int) -> List[Dict[str, Any]]:
    """Події з прапорцем `undone`: скасована = має undone_by, і та подія-
    обернення сама не скасована («повернути» знімає прапорець)."""
    conds, params = [], {"lim": limit, "off": offset}
    if box:
        conds.append("e.box_code = :bc"); params["bc"] = normalize_box_code(box)
    if product_id:
        conds.append("e.product_id = :pid"); params["pid"] = int(product_id)
    if actor:
        conds.append("e.actor ILIKE :actor"); params["actor"] = f"%{actor}%"
    if kind:
        conds.append("e.kind = :kind"); params["kind"] = kind
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    rows = db.execute(text(f"""
        SELECT e.*, (e.undone_by IS NOT NULL AND u.undone_by IS NULL) AS undone,
               u.actor AS undone_actor, u.at AS undone_at
        FROM wh_events e LEFT JOIN wh_events u ON u.id = e.undone_by
        {where} ORDER BY e.at DESC, e.id DESC LIMIT :lim OFFSET :off
    """), params).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["undoable"] = d["kind"] in UNDOABLE_KINDS and not d["undone"]
        out.append(d)
    return out


@router.get("/events")
def events(box: Optional[str] = None, product_id: Optional[int] = None,
           actor: Optional[str] = None, kind: Optional[str] = None,
           limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
           db: Session = Depends(get_db), _: str = Depends(require_staff)):
    return {"events": _events_query(db, box=box, product_id=product_id, actor=actor, kind=kind,
                                    limit=limit, offset=offset)}


# ───────────────────────────── історія: скасувати / повернути ────────────────
# Модерація дій працівників: власник у BMS бачить усе й може відкотити будь-яку
# дію. Скасування — НОВА подія-обернення (той самий словник родів), а не
# видалення; повернення — скасування обернення. Робити це може лише BMS
# (адмін-токен) або власник з телефона.

def _require_moderator(actor: str) -> None:
    if actor == "bms":
        return
    m = re.match(r"^tg:(\d+)", actor or "")
    if m and int(m.group(1)) in _owner_ids():
        return
    raise HTTPException(status_code=403, detail="Скасовувати дії може лише власник або BMS")


def _box_by_id_or_code(db: Session, box_id: Optional[int], code: Optional[str]) -> Optional[Dict[str, Any]]:
    if box_id:
        r = db.execute(text("SELECT * FROM wh_boxes WHERE id = :id FOR UPDATE"), {"id": int(box_id)}).mappings().first()
        if r:
            return dict(r)
    return _box_row(db, code, for_update=True) if code else None


def _pack_rows(db: Session, actor: str, box: Dict[str, Any], prod: Dict[str, Any], qty: int) -> None:
    db.execute(text("""
        INSERT INTO wh_box_items (box_id, product_id, productnumber, size, color, qty, packed_by)
        VALUES (:b, :pid, :pnum, :size, :color, :qty, :by)
        ON CONFLICT (box_id, product_id) WHERE unpacked_at IS NULL
        DO UPDATE SET qty = wh_box_items.qty + EXCLUDED.qty, packed_at = now(), packed_by = EXCLUDED.packed_by
    """), {"b": box["id"], "pid": prod["id"], "pnum": prod.get("productnumber"), "size": prod.get("size"),
           "color": prod.get("color"), "qty": qty, "by": actor})
    if box["status"] == "sealed":
        db.execute(text("UPDATE wh_boxes SET status = 'open', updated_at = now() WHERE id = :id"), {"id": box["id"]})


@router.post("/events/{event_id}/undo")
def event_undo(event_id: int, db: Session = Depends(get_db), actor: str = Depends(require_staff)):
    """Скасувати дію (або повернути скасовану — це те саме, застосоване до події-обернення)."""
    _require_moderator(actor)
    e = db.execute(text("SELECT * FROM wh_events WHERE id = :id FOR UPDATE"), {"id": int(event_id)}).mappings().first()
    if not e:
        raise HTTPException(status_code=404, detail="Події немає")
    e = dict(e)
    if e["kind"] not in UNDOABLE_KINDS:
        raise HTTPException(status_code=409, detail=f"Дію «{e['kind']}» скасувати не можна")
    if e.get("undone_by"):
        u = db.execute(text("SELECT undone_by FROM wh_events WHERE id = :id"), {"id": e["undone_by"]}).scalar()
        if u is None:
            raise HTTPException(status_code=409, detail="Цю дію вже скасовано — її можна лише повернути")
    details = e.get("details") or {}
    if isinstance(details, str):
        details = json.loads(details or "{}")
    qty = int(e.get("qty") or 1)
    prod = _load_product(db, e["product_id"]) if e.get("product_id") else None
    if e.get("product_id") and not prod:
        prod = {"id": e["product_id"], "productnumber": e.get("productnumber"), "number": (e.get("productnumber") or "").lstrip("#"),
                "size": None, "color": None}
    box = _box_by_id_or_code(db, e.get("box_id"), e.get("box_code"))
    kind = e["kind"]
    new_id: int

    if kind == "pack":
        if not box:
            raise HTTPException(status_code=409, detail="Коробки вже немає")
        done = _unpack_rows(db, actor, e["product_id"], box["id"], qty)
        if not done:
            raise HTTPException(status_code=409, detail=f"{prod['number'] if prod else ''} уже не лежить у {box['code']}")
        new_id = _event(db, actor, "unpack", box=box, product=prod, qty=sum(d["qty"] for d in done),
                        details={"undo": True}, undo_of=e["id"])
    elif kind == "move":
        # Повернути з цієї коробки туди, звідки взяли.
        src_code = (details.get("from") or [None])[0]
        src = _box_row(db, src_code, for_update=True) if src_code else None
        if not src or src["status"] == "archived":
            raise HTTPException(status_code=409, detail=f"Коробки {src_code or '?'} , звідки переносили, вже немає")
        if not box:
            raise HTTPException(status_code=409, detail="Коробки вже немає")
        done = _unpack_rows(db, actor, e["product_id"], box["id"], qty)
        if not done:
            raise HTTPException(status_code=409, detail=f"{prod['number'] if prod else ''} уже не лежить у {box['code']}")
        _pack_rows(db, actor, src, prod, sum(d["qty"] for d in done))
        new_id = _event(db, actor, "move", box=src, product=prod, qty=sum(d["qty"] for d in done),
                        details={"from": [box["code"]], "undo": True}, undo_of=e["id"])
    elif kind == "unpack":
        if not box or box["status"] == "archived":
            raise HTTPException(status_code=409, detail="Коробки, звідки виймали, вже немає")
        elsewhere = db.execute(text("""
            SELECT b.code FROM wh_box_items i JOIN wh_boxes b ON b.id = i.box_id
            WHERE i.product_id = :pid AND i.unpacked_at IS NULL AND i.box_id <> :b
        """), {"pid": e["product_id"], "b": box["id"]}).scalars().all()
        if elsewhere:
            raise HTTPException(status_code=409, detail=f"{prod['number'] if prod else ''} тепер лежить у {', '.join(elsewhere)} — спершу розберіться з цим")
        _pack_rows(db, actor, box, prod, qty)
        new_id = _event(db, actor, "pack", box=box, product=prod, qty=qty, details={"undo": True}, undo_of=e["id"])
    elif kind in ("seal", "open", "check"):
        if not box:
            raise HTTPException(status_code=409, detail="Коробки вже немає")
        if kind == "seal":
            db.execute(text("UPDATE wh_boxes SET status = 'open', updated_at = now() WHERE id = :id"), {"id": box["id"]})
            new_id = _event(db, actor, "open", box=box, details={"undo": True}, undo_of=e["id"])
        elif kind == "open":
            db.execute(text("UPDATE wh_boxes SET status = 'sealed', sealed_at = now(), updated_at = now() WHERE id = :id"), {"id": box["id"]})
            new_id = _event(db, actor, "seal", box=box, details={"undo": True}, undo_of=e["id"])
        else:
            db.execute(text("UPDATE wh_boxes SET needs_check = TRUE, updated_at = now() WHERE id = :id"), {"id": box["id"]})
            new_id = _event(db, actor, "box_edit", box=box, details={"needs_check": True, "undo": True}, undo_of=e["id"])
    elif kind == "box_create":
        if not box:
            raise HTTPException(status_code=409, detail="Коробки вже немає")
        n_open = db.execute(text("SELECT COUNT(*) FROM wh_box_items WHERE box_id = :b AND unpacked_at IS NULL"), {"b": box["id"]}).scalar() or 0
        if n_open:
            raise HTTPException(status_code=409, detail=f"У {box['code']} лежить {n_open} поз. — спершу вийміть")
        db.execute(text("UPDATE wh_boxes SET status = 'archived', updated_at = now() WHERE id = :id"), {"id": box["id"]})
        new_id = _event(db, actor, "box_delete", box=box, qty=0, details={"undo": True}, undo_of=e["id"])
    elif kind == "box_delete":
        if not box:
            raise HTTPException(status_code=409, detail="Коробки вже немає")
        if box["status"] != "archived":
            raise HTTPException(status_code=409, detail=f"Коробка {box['code']} і так не видалена")
        db.execute(text("UPDATE wh_boxes SET status = 'open', needs_check = TRUE, updated_at = now() WHERE id = :id"), {"id": box["id"]})
        restored = 0
        for it in details.get("items") or []:
            p = _load_product(db, int(it["product_id"])) or {"id": int(it["product_id"]), "productnumber": it.get("productnumber"), "size": None, "color": None}
            busy = db.execute(text("SELECT 1 FROM wh_box_items WHERE product_id = :pid AND unpacked_at IS NULL LIMIT 1"), {"pid": p["id"]}).first()
            if busy:
                continue      # уже лежить деінде — не дублюємо
            _pack_rows(db, actor, box, p, int(it.get("qty") or 1)); restored += 1
        new_id = _event(db, actor, "box_create", box=box, qty=restored,
                        details={"undo": True, "restored_items": restored, "title": box.get("title")}, undo_of=e["id"])
    elif kind == "box_edit":
        if not box:
            raise HTTPException(status_code=409, detail="Коробки вже немає")
        prev = details.get("prev") or {}
        if not prev:
            raise HTTPException(status_code=409, detail="Для цієї правки не збережено попередні значення")
        sets = ", ".join(f"{k} = :{k}" for k in prev)
        db.execute(text(f"UPDATE wh_boxes SET {sets}, updated_at = now() WHERE id = :id"), {**prev, "id": box["id"]})
        cur = {k: box.get(k) for k in prev}
        new_id = _event(db, actor, "box_edit", box=box, details={**prev, "prev": cur, "undo": True}, undo_of=e["id"])
    else:  # pragma: no cover
        raise HTTPException(status_code=409, detail="Скасувати не можна")

    db.execute(text("UPDATE wh_events SET undone_by = :u WHERE id = :id"), {"u": new_id, "id": e["id"]})
    db.commit()
    return {"ok": True, "undone": e["id"], "by_event": new_id}


# ───────────────────────────── коробки: запис ────────────────────────────────

@router.post("/boxes", status_code=201)
def box_create(payload: BoxCreate = Body(...), db: Session = Depends(get_db),
               actor: str = Depends(require_staff)):
    try:
        _claim_op(db, payload.op_id, "box_create", actor)
    except _Replay as rp:
        db.rollback()
        return rp.result
    code = normalize_box_code(payload.code) if payload.code else next_box_code(db, payload.category or "")
    category = (payload.category or re.match(r"^[A-ZА-ЯІЇЄҐ]+", code).group(0)).upper()
    if _box_row(db, code):
        raise HTTPException(status_code=409, detail=f"Коробка {code} уже є")
    r = db.execute(text("""
        INSERT INTO wh_boxes (code, category, title, location, note, needs_check, created_by)
        VALUES (:code, :cat, :title, :loc, :note, :chk, :by) RETURNING *
    """), {"code": code, "cat": category, "title": payload.title, "loc": payload.location,
           "note": payload.note, "chk": payload.needs_check, "by": actor}).mappings().first()
    box = dict(r)
    _event(db, actor, "box_create", box=box, details={"title": payload.title})
    db.commit()
    result = box_detail(code, db, actor)
    if payload.op_id:
        _finish_op(db, payload.op_id, result)
        db.commit()
    return result


@router.patch("/boxes/{code}")
def box_patch(code: str, payload: BoxPatch = Body(...), db: Session = Depends(get_db),
              actor: str = Depends(require_staff)):
    box = _box_row(db, code, for_update=True)
    if not box:
        raise HTTPException(status_code=404, detail=f"Коробки {code} немає")
    changes = {k: v for k, v in payload.dict().items() if v is not None and k != "op_id"}
    if not changes:
        return box_detail(code, db, actor)
    try:
        _claim_op(db, payload.op_id, "box_edit", actor)
    except _Replay as rp:
        db.rollback()
        return rp.result
    sets = ", ".join(f"{k} = :{k}" for k in changes)
    db.execute(text(f"UPDATE wh_boxes SET {sets}, updated_at = now() WHERE id = :id"),
               {**changes, "id": box["id"]})
    # prev — щоб «Історія» могла відкотити правку.
    _event(db, actor, "box_edit", box=box, details={**changes, "prev": {k: box.get(k) for k in changes}})
    db.commit()
    result = box_detail(code, db, actor)
    if payload.op_id:
        _finish_op(db, payload.op_id, result)
        db.commit()
    return result


@router.post("/boxes/{code}/seal")
def box_seal(code: str, op_id: Optional[str] = Query(None), db: Session = Depends(get_db),
             actor: str = Depends(require_staff)):
    try:
        _claim_op(db, op_id, "seal", actor)
    except _Replay as rp:
        db.rollback()
        return rp.result
    box = _box_row(db, code, for_update=True)
    if not box:
        raise HTTPException(status_code=404, detail=f"Коробки {code} немає")
    db.execute(text("UPDATE wh_boxes SET status = 'sealed', sealed_at = now(), updated_at = now() WHERE id = :id"),
               {"id": box["id"]})
    _event(db, actor, "seal", box=box)
    db.commit()
    result = box_detail(code, db, actor)
    if op_id:
        _finish_op(db, op_id, result)
        db.commit()
    return result


@router.post("/boxes/{code}/open")
def box_open(code: str, op_id: Optional[str] = Query(None), db: Session = Depends(get_db),
             actor: str = Depends(require_staff)):
    try:
        _claim_op(db, op_id, "open", actor)
    except _Replay as rp:
        db.rollback()
        return rp.result
    box = _box_row(db, code, for_update=True)
    if not box:
        raise HTTPException(status_code=404, detail=f"Коробки {code} немає")
    db.execute(text("UPDATE wh_boxes SET status = 'open', updated_at = now() WHERE id = :id"), {"id": box["id"]})
    _event(db, actor, "open", box=box)
    db.commit()
    result = box_detail(code, db, actor)
    if op_id:
        _finish_op(db, op_id, result)
        db.commit()
    return result


@router.post("/boxes/{code}/check")
def box_check(code: str, op_id: Optional[str] = Query(None), db: Session = Depends(get_db),
             actor: str = Depends(require_staff)):
    """Коробку звірено — знімаємо «Перевірити»."""
    try:
        _claim_op(db, op_id, "check", actor)
    except _Replay as rp:
        db.rollback()
        return rp.result
    box = _box_row(db, code, for_update=True)
    if not box:
        raise HTTPException(status_code=404, detail=f"Коробки {code} немає")
    db.execute(text("UPDATE wh_boxes SET needs_check = FALSE, checked_at = now(), updated_at = now() WHERE id = :id"),
               {"id": box["id"]})
    _event(db, actor, "check", box=box)
    db.commit()
    result = box_detail(code, db, actor)
    if op_id:
        _finish_op(db, op_id, result)
        db.commit()
    return result


@router.delete("/boxes/{code}")
def box_delete(code: str, force: bool = False, db: Session = Depends(get_db),
               actor: str = Depends(require_staff)):
    """Видалити коробку. З вмістом — лише force: усе всередині стає «без коробки»
    (рядки закриваються, історія лишається); сама коробка → archived, не DELETE:
    події посилаються на її код."""
    box = _box_row(db, code, for_update=True)
    if not box:
        raise HTTPException(status_code=404, detail=f"Коробки {code} немає")
    open_items = db.execute(text("SELECT product_id, productnumber, qty FROM wh_box_items WHERE box_id = :b AND unpacked_at IS NULL"),
                            {"b": box["id"]}).mappings().all()
    n_open = len(open_items)
    if n_open and not force:
        raise HTTPException(status_code=409, detail=f"У коробці {box['code']} ще {n_open} позицій. Спершу розпакуйте або підтвердьте видалення з вмістом.")
    if n_open:
        db.execute(text("UPDATE wh_box_items SET unpacked_at = now(), unpacked_by = :by WHERE box_id = :b AND unpacked_at IS NULL"),
                   {"b": box["id"], "by": actor})
    db.execute(text("UPDATE wh_boxes SET status = 'archived', updated_at = now() WHERE id = :id"), {"id": box["id"]})
    # Вміст — у details: «Історія» відновлює коробку разом із ним.
    _event(db, actor, "box_delete", box=box, qty=int(n_open),
           details={"force": bool(force), "items": [{"product_id": int(r["product_id"]), "productnumber": r["productnumber"], "qty": int(r["qty"])} for r in open_items]})
    db.commit()
    return {"deleted": box["code"], "unpacked_items": int(n_open)}


@router.get("/conditions")
def conditions(db: Session = Depends(get_db), _: str = Depends(require_staff)):
    """Стани товару для редагування з телефона (живі значення, без сміття)."""
    rows = db.execute(text("""
        SELECT c.id, c.conditionname AS name, COUNT(p.id) AS n
        FROM conditions c LEFT JOIN products p ON p.current_conditionid = c.id
        GROUP BY c.id, c.conditionname HAVING COUNT(p.id) >= 5 ORDER BY c.id
    """)).mappings().all()
    return {"conditions": [dict(r) for r in rows]}


class MirrorRow(BaseModel):
    id: int
    price: Optional[float] = None
    oldprice: Optional[float] = None
    current_conditionid: Optional[int] = None


class MirrorPatch(BaseModel):
    rows: List[MirrorRow]


@router.post("/products/mirror")
def products_mirror(payload: MirrorPatch = Body(...), db: Session = Depends(get_db),
                    actor: str = Depends(require_staff)):
    """BMS після застосування правки оновлює дзеркало products у хмарі, щоб
    телефон бачив свіже, не чекаючи годинного синхрону. Пакетно: правка ціни в
    BMS розходиться на всю ростовку (рядки того ж номера й стану), тому агент
    шле кожен змінений рядок. Лише з адмін-токеном."""
    if actor != "bms":
        raise HTTPException(status_code=403, detail="Лише BMS")
    n = 0
    for row in payload.rows:
        db.execute(text("""UPDATE products
                           SET price = :price, oldprice = :oldprice, current_conditionid = :cond
                           WHERE id = :id"""),
                   {"id": int(row.id), "price": row.price, "oldprice": row.oldprice, "cond": row.current_conditionid})
        n += 1
    db.commit()
    return {"ok": True, "updated": n}


# ───────────────────────────── працівники ────────────────────────────────────

def _staff_row_dict(r: Dict[str, Any]) -> Dict[str, Any]:
    return {"tg_id": int(r["tg_id"]), "name": r.get("name") or "", "username": r.get("username") or "",
            "status": r["status"], "requested_at": r.get("requested_at"), "approved_at": r.get("approved_at"),
            "approved_by": r.get("approved_by"), "last_seen_at": r.get("last_seen_at"), "note": r.get("note")}


@router.post("/access-request")
def access_request(x_telegram_init_data: Optional[str] = Header(None), db: Session = Depends(get_db)):
    """Працівник просить доступ: підпис initData бота складу обовʼязковий (щоб
    не можна було підкинути чужий id), далі — рядок pending у wh_staff.
    Власник підтверджує в BMS. Повторний запит не скидає active/blocked."""
    if not x_telegram_init_data:
        raise HTTPException(status_code=400, detail="Відкрийте застосунок із Telegram")
    prof = telegram_profile_from_init_data(x_telegram_init_data, token=_wh_bot_token())
    if not prof:
        raise HTTPException(status_code=401, detail="Підпис Telegram не збігається з ботом складу")
    uid = int(prof["id"])
    if uid in _owner_ids():
        return {"status": "owner"}
    r = db.execute(text("""
        INSERT INTO wh_staff (tg_id, name, username, status)
        VALUES (:id, :name, :username, 'pending')
        ON CONFLICT (tg_id) DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username,
            requested_at = CASE WHEN wh_staff.status = 'pending' THEN wh_staff.requested_at ELSE now() END
        RETURNING status
    """), {"id": uid, "name": (prof.get("name") or "")[:120], "username": (prof.get("username") or "")[:64]}).scalar()
    db.commit()
    return {"status": r}


@router.get("/staff")
def staff_list(db: Session = Depends(get_db), actor: str = Depends(require_staff)):
    """Список для BMS: власники (з налаштувань) + працівники з бази."""
    if actor != "bms":
        raise HTTPException(status_code=403, detail="Лише BMS")
    rows = db.execute(text("SELECT * FROM wh_staff ORDER BY (status = 'pending') DESC, requested_at DESC")).mappings().all()
    return {"owners": sorted(_owner_ids()), "staff": [_staff_row_dict(dict(r)) for r in rows],
            "pending": sum(1 for r in rows if r["status"] == "pending")}


class StaffIn(BaseModel):
    tg_id: int = Field(..., ge=1)
    name: Optional[str] = None
    note: Optional[str] = None


@router.post("/staff", status_code=201)
def staff_add(payload: StaffIn = Body(...), db: Session = Depends(get_db), actor: str = Depends(require_staff)):
    """Додати працівника вручну за Telegram id (одразу active)."""
    if actor != "bms":
        raise HTTPException(status_code=403, detail="Лише BMS")
    r = db.execute(text("""
        INSERT INTO wh_staff (tg_id, name, status, approved_at, approved_by, note)
        VALUES (:id, :name, 'active', now(), :by, :note)
        ON CONFLICT (tg_id) DO UPDATE SET status = 'active', approved_at = now(), approved_by = EXCLUDED.approved_by,
            name = COALESCE(NULLIF(EXCLUDED.name, ''), wh_staff.name), note = COALESCE(EXCLUDED.note, wh_staff.note)
        RETURNING *
    """), {"id": int(payload.tg_id), "name": (payload.name or "")[:120], "by": actor, "note": payload.note}).mappings().first()
    db.commit()
    _staff_cache_reset()
    return _staff_row_dict(dict(r))


class StaffStatusIn(BaseModel):
    status: str = Field(..., pattern="^(active|blocked)$")


@router.post("/staff/{tg_id}/status")
def staff_set_status(tg_id: int, payload: StaffStatusIn = Body(...), db: Session = Depends(get_db),
                     actor: str = Depends(require_staff)):
    if actor != "bms":
        raise HTTPException(status_code=403, detail="Лише BMS")
    r = db.execute(text("""
        UPDATE wh_staff SET status = :st,
            approved_at = CASE WHEN :st = 'active' THEN now() ELSE approved_at END,
            approved_by = CASE WHEN :st = 'active' THEN :by ELSE approved_by END
        WHERE tg_id = :id RETURNING *
    """), {"st": payload.status, "by": actor, "id": int(tg_id)}).mappings().first()
    if not r:
        raise HTTPException(status_code=404, detail="Працівника не знайдено")
    db.commit()
    _staff_cache_reset()
    return _staff_row_dict(dict(r))


@router.delete("/staff/{tg_id}")
def staff_delete(tg_id: int, db: Session = Depends(get_db), actor: str = Depends(require_staff)):
    if actor != "bms":
        raise HTTPException(status_code=403, detail="Лише BMS")
    db.execute(text("DELETE FROM wh_staff WHERE tg_id = :id"), {"id": int(tg_id)})
    db.commit()
    _staff_cache_reset()
    return {"ok": True}


# ───────────────────────────── черга (телефон → агент BMS) ───────────────────

class PrintJobIn(BaseModel):
    """Завдання для агента BMS у крамниці. Черга спільна: друк (box_label,
    stickers) і правки товару (product_edit) — агент застосовує їх канонічним
    шляхом BMS (база + журнал + блокування поля від парсера)."""
    kind: str = Field(..., pattern="^(box_label|stickers|product_edit)$")
    code: Optional[str] = None                  # box_label
    product_ids: Optional[List[int]] = None     # stickers
    copies: int = Field(1, ge=1, le=20)
    layout: str = "2x2"
    product_id: Optional[int] = None            # product_edit
    fields: Optional[Dict[str, Any]] = None     # product_edit: {price, current_conditionid, ...}


class PrintJobDone(BaseModel):
    ok: bool = True
    error: Optional[str] = None


def _job_dict(r: Dict[str, Any]) -> Dict[str, Any]:
    return {k: r[k] for k in ("id", "kind", "payload", "status", "created_by", "created_at",
                              "claimed_at", "agent", "finished_at", "error")}


@router.post("/print-jobs", status_code=201)
def print_job_create(payload: PrintJobIn = Body(...), db: Session = Depends(get_db),
                     actor: str = Depends(require_staff)):
    """Поставити завдання на друк (виконає агент BMS у крамниці)."""
    if payload.kind == "box_label":
        code = normalize_box_code(payload.code or "")
        if not _box_row(db, code):
            raise HTTPException(status_code=404, detail=f"Коробки {code} немає")
        data = {"code": code, "copies": payload.copies}
    elif payload.kind == "product_edit":
        # Стан — НАЗВОЮ (як у картці BMS: current_condition_name → резолв у id
        # робить сам product_service). Ціна — число ≥ 0. Решту полів ігноруємо.
        raw = payload.fields or {}
        fields: Dict[str, Any] = {}
        if raw.get("price") is not None and str(raw.get("price")).strip() != "":
            try:
                fields["price"] = float(raw["price"])
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Ціна має бути числом")
            if fields["price"] < 0:
                raise HTTPException(status_code=400, detail="Ціна не може бути відʼємною")
        cond = str(raw.get("current_condition_name") or raw.get("condition") or "").strip()
        if cond:
            ok = db.execute(text("SELECT conditionname FROM conditions WHERE lower(conditionname) = lower(:n) LIMIT 1"),
                            {"n": cond}).scalar()
            if not ok:
                raise HTTPException(status_code=400, detail=f"Невідомий стан «{cond}»")
            fields["current_condition_name"] = ok
        if not payload.product_id or not fields:
            raise HTTPException(status_code=400, detail="Нема що змінювати")
        if not _load_product(db, payload.product_id):
            raise HTTPException(status_code=404, detail="Товар не знайдено")
        data = {"product_id": int(payload.product_id), "fields": fields}
    else:
        ids = [int(i) for i in (payload.product_ids or []) if i]
        if not ids:
            raise HTTPException(status_code=400, detail="Не передано товарів")
        data = {"product_ids": ids, "copies": payload.copies, "layout": payload.layout}
    # Чи є кому друкувати: агент відмічається при кожному опитуванні.
    agent_seen = db.execute(text("SELECT MAX(seen_at) FROM wh_agents")).scalar()
    payload_json = json.dumps(data, ensure_ascii=False, sort_keys=True)
    # Друк: таке саме завдання вже чекає в черзі (принтер був недоступний, а
    # людина тисне ще раз) — не плодимо копії, повертаємо наявне.
    if payload.kind in ("box_label", "stickers"):
        dup = db.execute(text("""
            SELECT * FROM wh_print_jobs
            WHERE status = 'queued' AND kind = :kind AND payload = CAST(:payload AS jsonb)
            ORDER BY id LIMIT 1
        """), {"kind": payload.kind, "payload": payload_json}).mappings().first()
        if dup:
            return {**_job_dict(dict(dup)), "agent_seen_at": agent_seen, "duplicate": True}
    r = db.execute(text("""
        INSERT INTO wh_print_jobs (kind, payload, created_by)
        VALUES (:kind, CAST(:payload AS jsonb), :by) RETURNING *
    """), {"kind": payload.kind, "payload": payload_json, "by": actor}).mappings().first()
    db.commit()
    return {**_job_dict(dict(r)), "agent_seen_at": agent_seen}


@router.get("/print-jobs")
def print_jobs(status: str = Query("queued"), limit: int = Query(20, ge=1, le=100),
               db: Session = Depends(get_db), _: str = Depends(require_staff)):
    rows = db.execute(text(
        "SELECT * FROM wh_print_jobs WHERE status = :st ORDER BY created_at LIMIT :lim"
    ), {"st": status, "lim": limit}).mappings().all()
    return {"jobs": [_job_dict(dict(r)) for r in rows]}


@router.get("/print-jobs/{job_id}")
def print_job_get(job_id: int, db: Session = Depends(get_db), _: str = Depends(require_staff)):
    """Стан одного завдання — телефон чекає, поки агент застосує правку."""
    r = db.execute(text("SELECT id, kind, status, error, agent, created_at, finished_at FROM wh_print_jobs WHERE id = :id"),
                   {"id": job_id}).mappings().first()
    if not r:
        raise HTTPException(status_code=404, detail="Завдання не знайдено")
    return dict(r)


@router.post("/print-jobs/{job_id}/claim")
def print_job_claim(job_id: int, agent: str = Query("bms"), db: Session = Depends(get_db),
                    _: str = Depends(require_staff)):
    """Агент бере завдання (лише якщо воно ще в черзі — захист від двох агентів)."""
    r = db.execute(text("""
        UPDATE wh_print_jobs SET status = 'printing', claimed_at = now(), agent = :agent
        WHERE id = :id AND status = 'queued' RETURNING *
    """), {"id": job_id, "agent": agent[:64]}).mappings().first()
    db.commit()
    if not r:
        raise HTTPException(status_code=409, detail="Завдання вже взято або скасовано")
    return _job_dict(dict(r))


@router.post("/print-jobs/{job_id}/done")
def print_job_done(job_id: int, payload: PrintJobDone = Body(...), db: Session = Depends(get_db),
                   _: str = Depends(require_staff)):
    db.execute(text("""
        UPDATE wh_print_jobs SET status = :st, finished_at = now(), error = :err WHERE id = :id
    """), {"id": job_id, "st": "done" if payload.ok else "failed", "err": (payload.error or None)})
    db.commit()
    return {"id": job_id, "status": "done" if payload.ok else "failed"}


@router.post("/print-jobs/{job_id}/cancel")
def print_job_cancel(job_id: int, db: Session = Depends(get_db), _: str = Depends(require_staff)):
    db.execute(text("UPDATE wh_print_jobs SET status = 'cancelled', finished_at = now() "
                    "WHERE id = :id AND status = 'queued'"), {"id": job_id})
    db.commit()
    return {"id": job_id, "status": "cancelled"}


@router.post("/print-agent/heartbeat")
def print_agent_heartbeat(agent: str = Query("bms"), printer: Optional[str] = Query(None),
                          db: Session = Depends(get_db), _: str = Depends(require_staff)):
    """Агент повідомляє, що живий і який принтер бачить (телефон покаже «офлайн»,
    якщо пульсу нема понад хвилину)."""
    db.execute(text("""
        INSERT INTO wh_agents (agent, seen_at, printer) VALUES (:agent, now(), :printer)
        ON CONFLICT (agent) DO UPDATE SET seen_at = now(), printer = EXCLUDED.printer
    """), {"agent": agent[:64], "printer": (printer or None)})
    db.commit()
    return {"ok": True}


@router.get("/print-agent/status")
def print_agent_status(db: Session = Depends(get_db), _: str = Depends(require_staff)):
    r = db.execute(text("SELECT agent, seen_at, printer FROM wh_agents ORDER BY seen_at DESC LIMIT 1")).mappings().first()
    queued = db.execute(text("SELECT COUNT(*) FROM wh_print_jobs WHERE status = 'queued'")).scalar()
    online = bool(r and (datetime.now(timezone.utc) - r["seen_at"]).total_seconds() < 90)
    return {"online": online, "agent": r["agent"] if r else None, "last_seen": r["seen_at"] if r else None,
            "printer": r["printer"] if r else None, "queued": int(queued or 0)}


# ───────────────────────────── пакування ─────────────────────────────────────

@router.post("/boxes/{code}/pack")
def pack(code: str, payload: PackIn = Body(...), db: Session = Depends(get_db),
         actor: str = Depends(require_staff)):
    """Покласти товар у коробку. Якщо він уже лежить в іншій — 409 з місцем
    (застосунок питає «перенести?»), або `move=true` → переносимо."""
    try:
        _claim_op(db, payload.op_id, "pack", actor)
    except _Replay as rp:
        db.rollback()
        return rp.result
    box = _box_row(db, code, for_update=True)
    if not box:
        raise HTTPException(status_code=404, detail=f"Коробки {code} немає")
    if box["status"] == "archived":
        raise HTTPException(status_code=409, detail=f"Коробку {box['code']} видалено")
    prod = _load_product(db, payload.product_id)
    if not prod:
        raise HTTPException(status_code=404, detail="Товар не знайдено")
    qty = int(payload.qty)

    elsewhere = db.execute(text("""
        SELECT i.id, i.qty, b.code FROM wh_box_items i JOIN wh_boxes b ON b.id = i.box_id
        WHERE i.product_id = :pid AND i.unpacked_at IS NULL AND i.box_id <> :b
        ORDER BY i.packed_at
    """), {"pid": prod["id"], "b": box["id"]}).mappings().all()
    if elsewhere and not payload.move:
        raise HTTPException(status_code=409, detail={
            "code": "elsewhere",
            "message": f"{prod['number']} уже лежить у {', '.join(r['code'] for r in elsewhere)}",
            "locations": [{"box_code": r["code"], "qty": int(r["qty"])} for r in elsewhere],
        })
    moved_from: List[str] = []
    if elsewhere and payload.move:
        left = qty
        for r in elsewhere:
            if left <= 0:
                break
            take = min(left, int(r["qty"]))
            if take >= int(r["qty"]):
                db.execute(text("UPDATE wh_box_items SET unpacked_at = now(), unpacked_by = :by WHERE id = :id"),
                           {"id": r["id"], "by": actor})
            else:
                db.execute(text("UPDATE wh_box_items SET qty = qty - :t WHERE id = :id"), {"t": take, "id": r["id"]})
            moved_from.append(r["code"])
            left -= take

    db.execute(text("""
        INSERT INTO wh_box_items (box_id, product_id, productnumber, size, color, qty, packed_by)
        VALUES (:b, :pid, :pnum, :size, :color, :qty, :by)
        ON CONFLICT (box_id, product_id) WHERE unpacked_at IS NULL
        DO UPDATE SET qty = wh_box_items.qty + EXCLUDED.qty, packed_at = now(), packed_by = EXCLUDED.packed_by
    """), {"b": box["id"], "pid": prod["id"], "pnum": prod["productnumber"], "size": prod["size"],
           "color": prod["color"], "qty": qty, "by": actor})
    _event(db, actor, "move" if moved_from else "pack", box=box, product=prod, qty=qty,
           details={"from": moved_from} if moved_from else None)
    if box["status"] == "sealed":
        # Клали в запечатану — значить її відкрили; чесно позначаємо.
        db.execute(text("UPDATE wh_boxes SET status = 'open', updated_at = now() WHERE id = :id"), {"id": box["id"]})
    prod["locations"] = _locations(db, [prod["id"]]).get(prod["id"], [])
    result = {"ok": True, "box": box["code"], "product": prod, "moved_from": moved_from,
              "warning": ("Товар продано — стікер/пара мали б піти покупцю" if prod["available_qty"] <= 0 else None)}
    _finish_op(db, payload.op_id, result)
    db.commit()
    return result


def _reopen_if_sealed(db: Session, box_ids: List[int]) -> None:
    """Вийняли із запечатаної — отже її відкрили; статус має казати правду."""
    if box_ids:
        db.execute(text("UPDATE wh_boxes SET status = 'open', updated_at = now() "
                        "WHERE id = ANY(:ids) AND status = 'sealed'"), {"ids": list(set(box_ids))})


def _unpack_rows(db: Session, actor: str, product_id: int, box_id: Optional[int], qty: Optional[int]) -> List[Dict[str, Any]]:
    rows = db.execute(text("""
        SELECT i.id, i.qty, i.box_id, b.code FROM wh_box_items i JOIN wh_boxes b ON b.id = i.box_id
        WHERE i.product_id = :pid AND i.unpacked_at IS NULL
          AND (:b IS NULL OR i.box_id = :b)
        ORDER BY i.packed_at FOR UPDATE OF i
    """), {"pid": int(product_id), "b": box_id}).mappings().all()
    done: List[Dict[str, Any]] = []
    left = qty
    for r in rows:
        if left is not None and left <= 0:
            break
        take = int(r["qty"]) if left is None else min(left, int(r["qty"]))
        if take >= int(r["qty"]):
            db.execute(text("UPDATE wh_box_items SET unpacked_at = now(), unpacked_by = :by WHERE id = :id"),
                       {"id": r["id"], "by": actor})
        else:
            db.execute(text("UPDATE wh_box_items SET qty = qty - :t WHERE id = :id"), {"t": take, "id": r["id"]})
        done.append({"box_id": int(r["box_id"]), "box_code": r["code"], "qty": take})
        if left is not None:
            left -= take
    return done


@router.post("/boxes/{code}/unpack")
def unpack_from_box(code: str, payload: UnpackIn = Body(...), db: Session = Depends(get_db),
                    actor: str = Depends(require_staff)):
    try:
        _claim_op(db, payload.op_id, "unpack", actor)
    except _Replay as rp:
        db.rollback()
        return rp.result
    box = _box_row(db, code, for_update=True)
    if not box:
        raise HTTPException(status_code=404, detail=f"Коробки {code} немає")
    prod = _load_product(db, payload.product_id) or {"id": payload.product_id, "productnumber": None, "number": str(payload.product_id)}
    done = _unpack_rows(db, actor, payload.product_id, box["id"], payload.qty)
    if not done:
        raise HTTPException(status_code=404, detail=f"{prod['number']} не лежить у {box['code']}")
    for d in done:
        _event(db, actor, "unpack", box=box, product=prod, qty=d["qty"])
    _reopen_if_sealed(db, [box["id"]])
    result = {"ok": True, "unpacked": done}
    _finish_op(db, payload.op_id, result)
    db.commit()
    return result


@router.post("/unpack")
def unpack_anywhere(payload: UnpackIn = Body(...), db: Session = Depends(get_db),
                    actor: str = Depends(require_staff)):
    """Вийняти товар, де б він не лежав (сканування товару → «Вийняти»)."""
    try:
        _claim_op(db, payload.op_id, "unpack", actor)
    except _Replay as rp:
        db.rollback()
        return rp.result
    prod = _load_product(db, payload.product_id) or {"id": payload.product_id, "productnumber": None, "number": str(payload.product_id)}
    done = _unpack_rows(db, actor, payload.product_id, None, payload.qty)
    if not done:
        raise HTTPException(status_code=404, detail=f"{prod['number']} не лежить у жодній коробці")
    for d in done:
        _event(db, actor, "unpack", box={"id": d["box_id"], "code": d["box_code"]}, product=prod, qty=d["qty"])
    _reopen_if_sealed(db, [d["box_id"] for d in done])
    result = {"ok": True, "unpacked": done}
    _finish_op(db, payload.op_id, result)
    db.commit()
    return result


@router.post("/boxes/{code}/unpack-all")
def unpack_all(code: str, db: Session = Depends(get_db), actor: str = Depends(require_staff)):
    box = _box_row(db, code, for_update=True)
    if not box:
        raise HTTPException(status_code=404, detail=f"Коробки {code} немає")
    rows = db.execute(text("""
        SELECT product_id, productnumber, qty FROM wh_box_items WHERE box_id = :b AND unpacked_at IS NULL
    """), {"b": box["id"]}).mappings().all()
    db.execute(text("UPDATE wh_box_items SET unpacked_at = now(), unpacked_by = :by WHERE box_id = :b AND unpacked_at IS NULL"),
               {"b": box["id"], "by": actor})
    for r in rows:
        _event(db, actor, "unpack", box=box, product={"id": r["product_id"], "productnumber": r["productnumber"]},
               qty=int(r["qty"]), details={"all": True})
    db.commit()
    return {"ok": True, "unpacked_items": len(rows), "units": sum(int(r["qty"]) for r in rows)}
