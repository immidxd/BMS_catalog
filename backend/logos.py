"""Логотипи технологій для вітрини — з маніфесту в R2 (`logos/manifest.json`).

Майстер — локальна тека «Лого» (Технології/<група>/…), R2 `logos/` — її дзеркало;
вітрина бере зменшені копії з `logos/web/` (2–5 КБ замість сотень КБ оригіналу).
БД не чіпаємо: маніфест тягнемо з публічного R2 і тримаємо в пам'яті, тож
/api/config і далі не будить Neon (правило бюджету, CLAUDE.md).
"""

import json
import os
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List

_TTL_SEC = 600
_cache: Dict[str, Any] = {"at": 0.0, "items": []}


def tech_logos() -> List[Dict[str, Any]]:
    """[{slug, label, aliases, url}] для технологій; збій R2 — останній відомий список."""
    base = os.getenv("R2_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base or time.time() - _cache["at"] < _TTL_SEC:
        return _cache["items"] if base else []
    try:
        # r2.dev відбиває типовий UA Python-urllib (403) — представляємось браузерним
        req = urllib.request.Request(f"{base}/logos/manifest.json",
                                     headers={"User-Agent": "Mozilla/5.0 (BMS catalog)"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            manifest = json.load(resp)
        # ?v= — версія маніфесту: лого кешуються на добу, тож після заміни файлу
        # досить підняти version у manifest.json, і всі побачать нове одразу
        ver = manifest.get("version", 1)
        _cache["items"] = [
            {"slug": e["slug"], "label": e["label"],
             "aliases": [a.lower() for a in e.get("aliases", [])],
             "url": f"{base}/logos/web/{urllib.parse.quote(e['file'])}?v={ver}"}
            for e in manifest.get("tech", [])
        ]
        _cache["at"] = time.time()
    except Exception:  # noqa: BLE001 — лого не критичні: картка працює і без них
        _cache["at"] = time.time() - _TTL_SEC + 60   # повторимо за хвилину
    return _cache["items"]
