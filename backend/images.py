"""Фото товарів за productnumber — та сама файлова конвенція, що й у BMS.

Конвенція імен файлів (логіку віддзеркалено з BMS product_images.py):
  <pnum>_<будь-що>.<ext>      → official (студійні; решта суфіксу довільна)
  <pnum>_00N<будь-що>.<ext>   → real     (реальні фото; рівно два нулі на початку)
  <pnum>_defN<будь-що>.<ext>  → defect   (нюанси; показуються в кінці галереї)
Номер — усе до першого `_`, `.` або пробілу; опційний префікс `#`.
Дефіс НЕ є розділювачем: `Ф1067-2` — окремий товар, не матчиться під `Ф1067`.

PRODUCT_IMAGES_DIR — КОРІНЬ «Товар»; скануємо його рекурсивно, бо фото
розкладені по категоріях (Взуття, Одяг, Сумки, Аксесуари, Інше). URL фото
включає підпапку відносно кореня, напр. `/product-images/Одяг/Ф3400_01.JPG`.

Для швидкої видачі головних фото у списку каталогу тримаємо індекс
(нормалізований номер → відсортовані файли) у пам'яті з TTL.
"""

import os
import re
import time
from dataclasses import dataclass
from typing import Dict, List, Tuple
from urllib.parse import quote

DEFAULT_IMAGES_DIR = os.path.expanduser("~/Downloads/Бізнес/Товар")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
URL_PREFIX = "/product-images"
INDEX_TTL = 300  # сек; перескан папки не частіше, ніж раз на 5 хв

# Cloudflare R2 (публічний CDN). Якщо задано — URL фото вказують прямо на R2,
# а не на локальний статик-маунт цього бекенда. Це і є «миттєва» роздача для
# публічного каталогу: фото з краю мережі Cloudflare, без навантаження на нас,
# без залежності від того, чи запущений локальний бекенд. Ключі в R2 = той самий
# відносний шлях, що й локально (`Взуття/Ф1184_01.webp`), бо ingest/міграція в
# BMS заливали саме так. Порожній → локальний фолбек (dev).
R2_PUBLIC_BASE_URL = os.environ.get("R2_PUBLIC_BASE_URL", "").strip().rstrip("/")
# Параметр трансформації ширини (Cloudflare Images/Worker на власному домені).
# r2.dev його не підтримує → лишити порожнім; на власному домені напр. "width".
R2_RESIZE_PARAM = os.environ.get("R2_RESIZE_PARAM", "").strip()

# Cloudflare Image Resizing (/cdn-cgi/image) — доступний ЛИШЕ коли R2-бакет
# відданий через ВЛАСНИЙ домен на Cloudflare (r2.dev НЕ підтримує). Увімкнення:
# R2_IMAGE_RESIZE=1 + R2_PUBLIC_BASE_URL=<власний домен>. Тоді URL фото
# трансформуються у потрібну ширину (виграш по байтах 5-10×), format=auto →
# браузер сам отримує AVIF/WebP. Вимкнено (дефолт) → URL віддаються БЕЗ змін
# (поточна перевірена поведінка). Ширини: картка в сітці vs фото на сторінці.
R2_IMAGE_RESIZE = os.environ.get("R2_IMAGE_RESIZE", "").strip().lower() in ("1", "true", "yes", "on")
CARD_IMAGE_WIDTH = 440       # головне фото картки (~210px @2x)
GALLERY_IMAGE_WIDTH = 1080   # фото на сторінці товару (повна ширина @~2x)


def get_images_dir() -> str:
    return os.environ.get("PRODUCT_IMAGES_DIR", DEFAULT_IMAGES_DIR)


def _file_version(abs_path: str) -> str:
    """`?v=<hash>` із mtime+size — cache-busting при заміні фото під тією ж назвою
    (інакше immutable-кеш браузера/CDN віддавав би старе). '' якщо файлу нема."""
    try:
        st = os.stat(abs_path)
        return f"?v={int(st.st_mtime):x}{st.st_size:x}"
    except OSError:
        return ""


def _photo_url(relpath: str, abs_path: str = "") -> str:
    """URL фото: R2 CDN якщо налаштовано, інакше локальний статик-маунт. + ?v=."""
    ver = _file_version(abs_path) if abs_path else ""
    base = f"{R2_PUBLIC_BASE_URL}/{quote(relpath)}" if R2_PUBLIC_BASE_URL else f"{URL_PREFIX}/{quote(relpath)}"
    return base + ver


def _with_width(url: str, width: int) -> str:
    """Обгортає R2-URL у Cloudflare-трансформацію ширини (`/cdn-cgi/image`). Поза
    увімкненим resize, без width або для не-R2 URL — повертає URL без змін (тобто
    дефолтна поведінка лишається тією ж). `?v=` cache-bust їде у джерельному шляху."""
    if not (R2_IMAGE_RESIZE and width and R2_PUBLIC_BASE_URL and url.startswith(R2_PUBLIC_BASE_URL)):
        return url
    rest = url[len(R2_PUBLIC_BASE_URL):].lstrip("/")   # шлях(+?v=) відносно домену
    return f"{R2_PUBLIC_BASE_URL}/cdn-cgi/image/width={width},format=auto,quality=82/{rest}"


@dataclass
class ImageEntry:
    filename: str
    url: str
    kind: str  # 'official' | 'real' | 'defect'


def _normalize(pnum: str) -> str:
    return (pnum or "").strip().lstrip("#").strip().lower()


def _classify(suffix: str) -> str:
    """Тип фото за суфіксом одразу після номера (як у BMS)."""
    if re.match(r"^_def\d+\b", suffix, re.IGNORECASE):
        return "defect"
    if re.match(r"^_00\d+\b", suffix):
        return "real"
    return "official"


def _sort_key(suffix: str, kind: str, base: str) -> Tuple[int, int, str]:
    """Натуральний порядок: official з числом → official без → real → defect."""
    if kind == "defect":
        m = re.search(r"_def(\d+)", suffix, re.IGNORECASE)
        return (3, int(m.group(1)) if m else 0, base.lower())
    if kind == "real":
        m = re.search(r"_00(\d+)", suffix)
        return (2, int(m.group(1)) if m else 0, base.lower())
    m = re.search(r"\d+", suffix)
    if m:
        return (0, int(m.group(0)), base.lower())
    return (1, 0, base.lower())


# ── Індекс папки: нормалізований номер → [(sort_key, ImageEntry)] ───────────
_index: Dict[str, List[Tuple[Tuple[int, int, str], ImageEntry]]] = {}
# Ключі для фільтра «з фото»: номер БЕЗ згортання регістру (Postgres LOWER не
# фолдить кирилицю) + нижньорегістровий дубль як підстраховка.
_photo_keys: set[str] = set()
# Окремо — номери з ОФІЦІЙНИМ (студійним) фото. Публічний каталог пускає ЛИШЕ їх:
# товари тільки з «реальними»/«дефект» фото в каталог не потрапляють.
_official_photo_keys: set[str] = set()
_index_built_at: float = 0.0


def _build_index() -> Dict[str, List[Tuple[Tuple[int, int, str], ImageEntry]]]:
    index: Dict[str, List[Tuple[Tuple[int, int, str], ImageEntry]]] = {}
    photo_keys: set[str] = set()
    official_keys: set[str] = set()
    root = get_images_dir()
    if not os.path.isdir(root):
        _photo_keys.clear()
        _official_photo_keys.clear()
        return index
    # Рекурсивно: фото розкладені по підпапках-категоріях під коренем «Товар»
    for dirpath, _dirs, files in os.walk(root):
        for fname in files:
            base, ext = os.path.splitext(fname)
            if ext.lower() not in IMAGE_EXTENSIONS:
                continue
            stripped = base.lstrip("#")
            # Номер товару — все до першого розділювача `_`, `.` або пробілу
            m = re.match(r"^([^_.\s]+)(.*)$", stripped)
            if not m:
                continue
            raw_pnum, suffix = m.group(1).strip(), m.group(2)
            pnum, kind = _normalize(raw_pnum), _classify(suffix)
            # URL включає шлях відносно кореня (з підпапкою), '/' не кодуємо
            abs_path = os.path.join(dirpath, fname)
            relpath = os.path.relpath(abs_path, root)
            entry = ImageEntry(filename=fname, url=_photo_url(relpath, abs_path), kind=kind)
            index.setdefault(pnum, []).append((_sort_key(suffix, kind, base), entry))
            photo_keys.add(raw_pnum)
            photo_keys.add(raw_pnum.lower())
            if kind == "official":
                official_keys.add(raw_pnum)
                official_keys.add(raw_pnum.lower())
    for entries in index.values():
        entries.sort(key=lambda pair: pair[0])
    _photo_keys.clear()
    _photo_keys.update(photo_keys)
    _official_photo_keys.clear()
    _official_photo_keys.update(official_keys)
    return index


def _get_index() -> Dict[str, List[Tuple[Tuple[int, int, str], ImageEntry]]]:
    global _index, _index_built_at
    if time.time() - _index_built_at > INDEX_TTL:
        _index = _build_index()
        _index_built_at = time.time()
    return _index


def list_images(productnumber: str, official_photos_from: str = "", width: int = 0) -> List[ImageEntry]:
    """Всі фото товару; донорські official підтягуються одним хопом (як у BMS).
    width > 0 → URL трансформуються під цю ширину (якщо R2_IMAGE_RESIZE)."""
    index = _get_index()
    own = list(index.get(_normalize(productnumber), []))
    donor_pnum = _normalize(official_photos_from)
    if donor_pnum and donor_pnum != _normalize(productnumber):
        own = [pair for pair in own if pair[1].kind != "official"]
        own += [pair for pair in index.get(donor_pnum, []) if pair[1].kind == "official"]
        own.sort(key=lambda pair: pair[0])
    if width:
        return [ImageEntry(e.filename, _with_width(e.url, width), e.kind) for _, e in own]
    return [entry for _, entry in own]


def main_image_url(productnumber: str, official_photos_from: str = "") -> str | None:
    """Головне фото для картки каталогу (перше за сортуванням), у ширині картки."""
    images = list_images(productnumber, official_photos_from, width=CARD_IMAGE_WIDTH)
    return images[0].url if images else None


def photo_productnumbers() -> frozenset[str]:
    """Номери, що мають хоч одне фото (для фільтра «Тільки з фото»).

    Ключі — без `#` та trim, у ОРИГІНАЛЬНОМУ регістрі (+ нижньорегістровий дубль),
    бо Postgres LOWER() не фолдить кирилицю. SQL зіставляє цей набір з
    `BTRIM(LTRIM(p.productnumber,'#'))` та official_photos_from БЕЗ LOWER.
    """
    _get_index()  # гарантує побудову/оновлення індексу і _photo_keys
    return frozenset(_photo_keys)


def official_photo_productnumbers() -> frozenset[str]:
    """Номери, що мають хоч одне ОФІЦІЙНЕ (студійне) фото — для гейта публічного
    каталогу (лише такі товари показуються; «реальні»/«дефект»-only — ні)."""
    _get_index()  # гарантує побудову/оновлення індексу і _official_photo_keys
    return frozenset(_official_photo_keys)
