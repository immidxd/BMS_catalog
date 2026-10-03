"""«Тиша» для хмарної БД (Neon): часті опитування — з пам'яті, а не з бази.

⚠️ ЖОРСТКЕ ПРАВИЛО ПРОЄКТУ: не перевищувати безкоштовний ліміт Neon (100 CU-годин
на місяць). Neon засинає лише після 5 хв БЕЗ ЖОДНОГО запиту — і кожна година
«неспання» коштує. Реальний інцидент (вересень 2026, −881 ₴): агент друку BMS
опитував /api/wh/print-jobs кожні 5 с + пульс кожні 30 с, і compute не засинав
ніколи. Тому все, що опитується по таймеру, відповідає звідси:

  • черга друку: якщо відомо, що вона порожня, — відповідь без БД. Будь-яке
    нове завдання створюється через ЦЕЙ процес (POST /api/wh/print-jobs), тож
    знання точне; про всяк випадок перевіряємо базу раз на RECHECK (6 год);
  • пульс агента — у пам'яті (у БД лише перший після старту / зміна принтера /
    раз на 6 год), щоб статус «онлайн» переживав рестарт;
  • GET-и складу, які BMS опитує кожні 10–15 с (коробки, події, працівники),
    кешуються до будь-якої зміни складу (будь-який не-GET /api/wh/*) або TTL.

Припущення: ОДИН процес uvicorn (див. Dockerfile CMD). Якщо колись буде кілька
воркерів/реплік — вимкнути CATALOG_QUIET_DB=0 (поведінка як раніше).
"""
from __future__ import annotations

import hashlib
import os
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

ENABLED = (os.getenv("CATALOG_QUIET_DB", "1") or "1").lower() not in ("0", "false", "no", "off")
QUEUE_RECHECK_SEC = float(os.getenv("CATALOG_WH_QUEUE_RECHECK_SEC", "21600") or 21600)
AGENT_PERSIST_SEC = float(os.getenv("CATALOG_WH_AGENT_PERSIST_SEC", "21600") or 21600)
CACHE_TTL_SEC = float(os.getenv("CATALOG_WH_CACHE_TTL", "1800") or 1800)

_lock = threading.Lock()

# ───────────────────────────── черга друку ───────────────────────────────────
# gen росте при кожній зміні черги: відповідь «порожньо», прочитана з БД ДО
# зміни, не може перезаписати знання ПІСЛЯ неї (гонка опитування й створення).
_queue: Dict[str, Any] = {"gen": 0, "empty": False, "at": 0.0}


def queue_gen() -> int:
    with _lock:
        return _queue["gen"]


def queue_known_empty() -> bool:
    if not ENABLED:
        return False
    with _lock:
        return _queue["empty"] and time.time() - _queue["at"] < QUEUE_RECHECK_SEC


def queue_observed(empty: bool, gen: int) -> None:
    """Результат запиту до БД — запам'ятати, якщо черга не змінилась за час запиту."""
    with _lock:
        if _queue["gen"] == gen:
            _queue.update(empty=empty, at=time.time())


def queue_changed() -> None:
    """Завдання з'явилось (або могло з'явитись) — наступне опитування йде в БД."""
    with _lock:
        _queue.update(gen=_queue["gen"] + 1, empty=False)


# ───────────────────────────── пульс агента ──────────────────────────────────
_agents: Dict[str, Dict[str, Any]] = {}


def agent_beat(agent: str, printer: Optional[str]) -> bool:
    """Запам'ятати пульс. True — варто записати в БД (перший / новий принтер / давно)."""
    now = time.time()
    with _lock:
        prev = _agents.get(agent)
        persist = (not ENABLED or prev is None or prev["printer"] != printer
                   or now - prev["persisted_at"] > AGENT_PERSIST_SEC)
        _agents[agent] = {"seen_at": datetime.now(timezone.utc), "printer": printer,
                          "persisted_at": now if persist else prev["persisted_at"]}
    return persist


def agent_latest() -> Optional[Dict[str, Any]]:
    """Найсвіжіший пульс з пам'яті (None — після рестарту ще не було / вимкнено)."""
    if not ENABLED:
        return None
    with _lock:
        if not _agents:
            return None
        agent, rec = max(_agents.items(), key=lambda kv: kv[1]["seen_at"])
        return {"agent": agent, "seen_at": rec["seen_at"], "printer": rec["printer"]}


# ───────────────────── кеш GET-ів складу, які опитуються ─────────────────────
# /boxes/next-code і label.png не кешуємо (перше — генератор, друге — бінар).
_CACHEABLE = re.compile(r"^/api/wh/(boxes|boxes/[^/]+|events|staff|locations|conditions)$")
_cache: Dict[str, Any] = {"gen": 0, "items": {}}


def wh_changed() -> None:
    with _lock:
        _cache["gen"] += 1
        _cache["items"].clear()


async def wh_cache_middleware(request, call_next):
    """HTTP-middleware: будь-який не-GET /api/wh/* скидає кеш; опитувані GET — з кешу."""
    path = request.url.path
    if not path.startswith("/api/wh/"):
        return await call_next(request)
    if request.method != "GET":
        try:
            return await call_next(request)
        finally:
            wh_changed()
    if not ENABLED or path == "/api/wh/boxes/next-code" or not _CACHEABLE.match(path):
        return await call_next(request)

    from starlette.responses import Response
    who = (request.headers.get("authorization") or "") + "|" + (request.headers.get("x-telegram-init-data") or "")
    key = hashlib.sha256(f"{path}?{request.url.query}|{who}".encode()).hexdigest()
    now = time.time()
    with _lock:
        hit = _cache["items"].get(key)
        gen = _cache["gen"]
    if hit and now - hit["at"] < CACHE_TTL_SEC:
        return Response(content=hit["body"], status_code=200, headers=hit["headers"])

    response = await call_next(request)
    if response.status_code != 200:
        return response
    body = b"".join([chunk async for chunk in response.body_iterator])
    headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
    with _lock:
        if _cache["gen"] == gen:   # склад не змінився, поки ми читали
            _cache["items"][key] = {"at": now, "body": body, "headers": headers}
    return Response(content=body, status_code=200, headers=headers)
