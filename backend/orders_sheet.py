"""Намір замовлення з каталогу → живий документ «Замовлення» (Google Sheets).

⚠️ Документ активно редагує власник ВРУЧНУ, і в ньому вже є другий писар (BMS
`writeback_order_to_journal`). Тому кожне правило нижче — не стиль, а страховка:

1. ВКЛАДКА — найновіша ЗА ДАТОЮ в назві, а не остання за позицією: вкладки
   впорядковані НОВИМИ ЗВЕРХУ ('Клієнти', 'New', '30.08.2026', …, '05.02.2022'),
   тож остання за позицією — це лютий 2022. Службові вкладки без дати ігноруємо.
   Щойно власник створить вкладку з новішою датою — записи підуть туди самі.

2. РЯДОК — перший ПОВНІСТЮ вільний після останнього заповненого, але ДО початку
   блоку «В ЧЕРЗІ»: саме там у власника живуть замовлення. Нижче черги трапляються
   рядки з фінальними статусами, тож шукати по всьому аркушу не можна.

3. КОЛОНКИ — лише за НАЗВОЮ заголовка: частина колонок прихована/згрупована, і
   позиції не збігаються з візуальними.

4. НЕ ЧІПАЄМО «Суму» (там у кожному рядку жива формула, що розбиває ціни через ';')
   і все, що правіше «Оновлення» — там блок статистики зі злитими комірками.

5. СТАТУС «В ЧЕРЗІ» — він є у списку валідації колонки, а формула «Замовлень»
   (COUNTIFS … "<>В Черзі") його ВИКЛЮЧАЄ. Інакше кожен клік у каталозі мовчки
   збільшував би власникові лічильник замовлень і касу на кінець дня.

6. ПОРОЖНЄ — це не тільки '': у статусах стоїть заповнювач 'ㅤ' (U+3164).

7. ЗАПИС ОПТИМІСТИЧНИЙ: перед записом перечитуємо рядок, пишемо ТІЛЬКИ свої
   колонки (не рядок цілком), одразу перечитуємо й звіряємо. Якщо в ту саму мить
   там з'явилось чуже — беремо наступний вільний рядок. Так навіть у найгіршому
   збігу дані власника не затираються.

Вимкнено, доки не задані CATALOG_ORDERS_SHEET=1, GOOGLE_SERVICE_ACCOUNT_JSON
і ORDERS_SPREADSHEET_ID.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

BLANK_MARKS = {"", "ㅤ"}
QUEUE_STATUS = "В ЧЕРЗІ"
CATALOG_MARK = "CG"

COL_NUMBERS = "Номера товарів"
COL_PRICE = "Ціна"
COL_DETAILS = "Уточнення"
COL_STATUS = "Статус відповіді"
COL_COMMENT = "Коментарі"
COL_DATE = "Дата замовлення"
WRITABLE = (COL_NUMBERS, COL_PRICE, COL_DETAILS, COL_STATUS, COL_COMMENT, COL_DATE)

_DATE_TITLE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})$")
# Один запис за раз у межах процесу: два одночасні кліки не мають цілити в один рядок
_WRITE_LOCK = threading.Lock()


def enabled() -> bool:
    return (os.getenv("CATALOG_ORDERS_SHEET", "").strip().lower() in ("1", "true", "yes", "on")
            and bool(os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON"))
            and bool(os.getenv("ORDERS_SPREADSHEET_ID")))


def _blank(value: Any) -> bool:
    return str(value or "").strip() in BLANK_MARKS


def sheet_date(title: str):
    m = _DATE_TITLE.match(title.strip())
    if not m:
        return None
    try:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None


def _service_account_info() -> Dict[str, Any]:
    """Ключ зі змінної середовища. Приймаємо і чистий JSON, і base64 — приватний
    ключ містить переноси рядків, і при вставці у веб-поле JSON легко ламається;
    base64 цю проблему знімає повністю."""
    raw = (os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON") or "").strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        import base64
        return json.loads(base64.b64decode(raw))


def _client():
    """gspread-клієнт із ключа в змінній середовища (файлу у хмарі немає)."""
    import gspread
    from google.oauth2.service_account import Credentials
    creds = Credentials.from_service_account_info(_service_account_info(), scopes=[
        "https://www.googleapis.com/auth/spreadsheets",
    ])
    return gspread.authorize(creds)


def _pick_worksheet(spreadsheet):
    dated = [(sheet_date(w.title), w) for w in spreadsheet.worksheets()]
    dated = [(d, w) for d, w in dated if d]
    if not dated:
        raise RuntimeError("У документі немає вкладки з датою в назві")
    return max(dated, key=lambda x: x[0])[1]


class _Layout:
    """Розкладка вкладки: де колонки, де вільно, де починається «В ЧЕРЗІ»."""

    def __init__(self, rows: List[List[str]]):
        self.rows = rows
        headers = rows[0] if rows else []
        self.col = {h.strip(): i for i, h in enumerate(headers) if h.strip()}
        missing = [c for c in WRITABLE if c not in self.col]
        if missing:
            raise RuntimeError(f"У вкладці немає колонок: {missing}")

    def cell(self, row: int, header: str) -> str:
        r = self.rows[row - 1] if row - 1 < len(self.rows) else []
        i = self.col[header]
        return (r[i] if i < len(r) else "").strip()

    def first_queue_row(self) -> Optional[int]:
        """Початок блоку «В ЧЕРЗІ» — нижня межа зони замовлень.

        ВЛАСНІ рядки (позначені CG) пропускаємо: вони теж мають статус «В ЧЕРЗІ»,
        і без цього перше ж записане замовлення оголосило б початком черги саме
        себе — межа поповзла б угору, і наступні замовлення нікуди було б класти."""
        for i in range(2, len(self.rows) + 1):
            if (self.cell(i, COL_STATUS).upper() == QUEUE_STATUS
                    and self.cell(i, COL_COMMENT).upper() != CATALOG_MARK):
                return i
        return None

    def is_free(self, row: int) -> bool:
        return all(_blank(self.cell(row, h)) for h in WRITABLE)

    def free_rows(self) -> List[int]:
        """Вільні рядки одразу після блоку ЗАМОВЛЕНЬ і до початку «В ЧЕРЗІ».

        «Останнє замовлення» рахуємо за наявністю НОМЕРА ТОВАРУ, а не за будь-яким
        вмістом: між замовленнями й чергою живуть рядки-запити (клієнт + коментар,
        статус УТОЧНИТИ, номера немає). Якби вони вважались заповненими, нові
        замовлення падали б ПІД них, відірвано від свого блоку."""
        limit = self.first_queue_row() or (len(self.rows) + 1)
        last_order = max((i for i in range(2, limit)
                          if not _blank(self.cell(i, COL_NUMBERS))), default=1)
        return [i for i in range(last_order + 1, limit) if self.is_free(i)]

    def a1(self, row: int, header: str) -> str:
        """Адреса однієї комірки ('S34'). Своя реалізація, щоб розкладку можна було
        перевіряти офлайн, без залежності від gspread."""
        n, letters = self.col[header] + 1, ""
        while n:
            n, rem = divmod(n - 1, 26)
            letters = chr(65 + rem) + letters
        return f"{letters}{row}"


def _split(value: str) -> List[str]:
    return [p.strip() for p in str(value or "").split(";") if p.strip()]


def _join(parts: List[str]) -> str:
    return "".join(f"{p}; " for p in parts).strip()


def _fmt_price(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


def _values(numbers: List[str], prices: List[str], details: List[str]) -> Dict[str, str]:
    return {
        COL_NUMBERS: _join(numbers),
        COL_PRICE: _join(prices),
        COL_DETAILS: _join(details),
        COL_STATUS: QUEUE_STATUS,
        COL_COMMENT: CATALOG_MARK,
        COL_DATE: date.today().strftime("%Y-%m-%d"),
    }


def _is_ours(layout: _Layout, row: int) -> bool:
    """Чи цей рядок створили МИ і його ще не змінив власник."""
    return (layout.cell(row, COL_COMMENT).upper() == CATALOG_MARK
            and layout.cell(row, COL_STATUS).upper() == QUEUE_STATUS
            and layout.cell(row, COL_DATE) == date.today().strftime("%Y-%m-%d"))


# ── Памʼять «свого» рядка на час заходу відвідувача ──────────────────────────
# Тримаємо на СЕРВЕРІ й ключем беремо session_id аналітики: якби рядок присилав
# клієнт, підроблений номер дозволив би дописувати в чужий рядок документа.
def ensure_table(db) -> None:
    from sqlalchemy import text
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS catalog_order_rows (
            session_id  uuid PRIMARY KEY,
            sheet_title varchar(64) NOT NULL,
            row_index   integer NOT NULL,
            updated_at  timestamptz NOT NULL DEFAULT now()
        )
    """))
    db.commit()


def recall(db, session_id: str):
    from sqlalchemy import text
    row = db.execute(text("""
        SELECT sheet_title, row_index FROM catalog_order_rows
        WHERE session_id = CAST(:sid AS uuid) AND updated_at > now() - interval '12 hours'
    """), {"sid": session_id}).first()
    return (row[0], int(row[1])) if row else None


def remember(db, session_id: str, title: str, row_index: int) -> None:
    from sqlalchemy import text
    db.execute(text("""
        INSERT INTO catalog_order_rows (session_id, sheet_title, row_index, updated_at)
        VALUES (CAST(:sid AS uuid), :t, :r, now())
        ON CONFLICT (session_id) DO UPDATE
           SET sheet_title = EXCLUDED.sheet_title,
               row_index   = EXCLUDED.row_index,
               updated_at  = now()
    """), {"sid": session_id, "t": title, "r": row_index})
    db.commit()


def record_intent(productnumber: str, price: Optional[float], size: Optional[str],
                  previous: Optional[Tuple[str, int]] = None) -> Optional[Tuple[str, int]]:
    """Записати намір. Повертає (назва вкладки, рядок) — щоб наступний товар того
    самого відвідувача дописався СЮДИ Ж, а не створив новий рядок.

    previous — те, що повернув попередній виклик у цьому ж заході відвідувача.
    Якщо власник встиг змінити той рядок (інший статус/коментар/дата) — не чіпаємо
    його зовсім і починаємо новий: суперечити людині в її документі не можна.
    """
    if not enabled():
        return None
    number = (productnumber or "").strip().lstrip("#")
    if not number:
        return None
    # Формат уточнення — рівно як у власника: «Ф4350 (40);», без «EU».
    # З каталогу розмір приходить підписом пігулки («38 EU», «41.3 EU», «M»).
    size_label = re.sub(r"\s*EU\s*$", "", str(size or "").strip(), flags=re.I)
    detail = f"{number} ({size_label})" if size_label else ""

    with _WRITE_LOCK:
        sh = _client().open_by_key(os.environ["ORDERS_SPREADSHEET_ID"])
        ws = _pick_worksheet(sh)
        layout = _Layout(ws.get_all_values())

        # 1) Дозапис у «наш» рядок цього ж заходу
        if previous and previous[0] == ws.title and _is_ours(layout, previous[1]):
            row = previous[1]
            numbers = _split(layout.cell(row, COL_NUMBERS)) + [number]
            prices = _split(layout.cell(row, COL_PRICE)) + ([_fmt_price(price)] if price else [])
            details = _split(layout.cell(row, COL_DETAILS)) + ([detail] if detail else [])
        else:
            row, numbers = None, [number]
            prices = [_fmt_price(price)] if price else []
            details = [detail] if detail else []

        payload = _values(numbers, prices, details)

        # 2) Новий рядок — з перевіркою, що його не зайняли між читанням і записом
        candidates = [row] if row else layout.free_rows()
        if not candidates:
            logger.warning("[orders] немає вільного рядка до блоку «В ЧЕРЗІ» — пропускаю запис")
            return None

        for target in candidates[:3]:
            if row is None:
                # Перечитуємо саме перед записом: рядок могли зайняти в цю мить
                if not _Layout(ws.get_all_values()).is_free(target):
                    continue
            ws.batch_update(
                [{"range": layout.a1(target, h), "values": [[v]]} for h, v in payload.items()],
                value_input_option="USER_ENTERED",
            )
            time.sleep(0.4)
            check = _Layout(ws.get_all_values())
            if check.cell(target, COL_NUMBERS) == payload[COL_NUMBERS]:
                logger.info("[orders] %s → '%s' рядок %d", number, ws.title, target)
                return (ws.title, target)
            logger.warning("[orders] запис у рядок %d не підтвердився — пробую далі", target)
        return None


def handle_contact_click(session_id: str, productnumber: str, size: Optional[str]) -> None:
    """Фонова обробка кліку «Замовити». Викликається ПІСЛЯ відповіді користувачу —
    покупець не чекає на Google, чат відкривається одразу.

    Ціну беремо з БД, а не з клієнта: у документ власника має потрапляти те саме
    число, що показує вітрина, і його не можна підмінити з браузера.
    """
    if not enabled():
        return
    try:
        from database import SessionLocal
        from sqlalchemy import text
    except Exception:
        return
    db = SessionLocal()
    try:
        ensure_table(db)
        price = db.execute(text("""
            SELECT CASE WHEN COALESCE(cl.is_on_sale, FALSE)
                         AND cl.sale_price IS NOT NULL
                         AND cl.sale_price > 0 AND cl.sale_price < p.price
                        THEN cl.sale_price ELSE p.price END
            FROM products p
            LEFT JOIN catalog_listings cl ON cl.productnumber = p.productnumber
            WHERE p.productnumber = :pn
            ORDER BY p.id LIMIT 1
        """), {"pn": productnumber}).scalar()
        placed = record_intent(productnumber, float(price) if price else None,
                               size, previous=recall(db, session_id))
        if placed:
            remember(db, session_id, placed[0], placed[1])
    except Exception as exc:                       # noqa: BLE001
        # Документ власника важливіший за нашу статистику: будь-який збій тут
        # НЕ має ламати відповідь каталогу. Причину кладемо в БД — логи хмари
        # читати незручно, а так збій видно звідусіль і одразу.
        logger.warning("[orders] намір не записано (%s): %s", productnumber, exc)
        try:
            db.rollback()
            db.execute(text("""
                CREATE TABLE IF NOT EXISTS catalog_order_errors (
                    id serial PRIMARY KEY,
                    at timestamptz NOT NULL DEFAULT now(),
                    productnumber varchar(80),
                    reason text
                )
            """))
            db.execute(text("INSERT INTO catalog_order_errors (productnumber, reason) "
                            "VALUES (:pn, :r)"),
                       {"pn": productnumber, "r": f"{type(exc).__name__}: {exc}"[:500]})
            db.commit()
        except Exception:
            pass
    finally:
        db.close()
