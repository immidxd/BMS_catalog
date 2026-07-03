"""Публічне API каталогу — read-only поверх БД bsstorage.

У каталог потрапляють лише наявні товари (логіка узгоджена з BMS):
  - залишок > 0: GREATEST(quantity − sold_count, 0) > 0
  - статус журналу не фінальний ('Продано','Подаровано','Повернуто')
  - не «загублений» (is_lost), валідний productnumber, ціна > 0
"""

import math
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import get_db
from images import GALLERY_IMAGE_WIDTH, list_images, main_image_url, official_photo_productnumbers

router = APIRouter()

# «Продано» = Подарунок(7) АБО (Підтверджено(1) І Оплачено(1)), мінус Повернення(9).
_SOLD_JOIN = """
    LEFT JOIN (
        SELECT oi.product_id,
               GREATEST(
                 COUNT(*) FILTER (WHERE o.order_status_id = 7
                                    OR (o.order_status_id = 1 AND o.payment_status_id = 1))
                 - COUNT(*) FILTER (WHERE o.order_status_id = 9),
               0) AS sold_count
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id IS NOT NULL
          AND o.order_status_id IN (1, 7, 9)
        GROUP BY oi.product_id
    ) sold ON sold.product_id = p.id
"""

# Повний набір JOIN-ів для запитів каталогу (список товарів + фасет розмірів):
# покриває всі поля, на які можуть посилатися фільтри (пошук по бренду/типу/
# підвиду/стилю/кольору/статі/стану). Тримаємо в одному місці — щоб список і
# фасет завжди мали однакову основу.
_FULL_JOINS = f"""
        FROM products p
        LEFT JOIN brands b ON p.brandid = b.id
        LEFT JOIN types t ON p.typeid = t.id
        LEFT JOIN subtypes st ON p.subtypeid = st.id
        LEFT JOIN styles sty ON p.styleid = sty.id
        LEFT JOIN colors c ON p.colorid = c.id
        LEFT JOIN genders g ON p.genderid = g.id
        LEFT JOIN conditions cond ON cond.id = COALESCE(p.current_conditionid, p.conditionid)
        LEFT JOIN statuses s ON p.statusid = s.id
        LEFT JOIN catalog_listings cl ON cl.productnumber = p.productnumber
        {_SOLD_JOIN}
"""

_AVAILABLE_WHERE = """
    GREATEST(COALESCE(p.quantity, 0) - COALESCE(sold.sold_count, 0), 0) > 0
    AND (s.statusname IS NULL OR s.statusname NOT IN ('Продано', 'Подаровано', 'Повернуто'))
    AND COALESCE(p.is_lost, FALSE) = FALSE
    AND p.productnumber IS NOT NULL
    AND p.productnumber <> '???'
    AND p.productnumber NOT LIKE '???\\_%'
    AND p.productnumber NOT LIKE '\\_\\_tmp\\_rename\\_%'
    AND COALESCE(p.price, 0) > 0
"""

# Сортування по агрегатах: картка каталогу = група рядків одного productnumber
# (ростовка: один номер — кілька рядків-розмірів у products)
_SORTS = {
    "newest": "MAX(p.dateadded) DESC NULLS LAST, MIN(p.id) DESC",
    "price_asc": "MIN(p.price) ASC, MIN(p.id) DESC",
    "price_desc": "MAX(p.price) DESC, MIN(p.id) DESC",
}

# Сортування ЗОВНІШНЬОГО рівня — над агрегованими по номеру рядками (per_number)
_OUTER_SORTS = {
    "newest": "MAX(dateadded) DESC NULLS LAST, MIN(id) DESC",
    "price_asc": "MIN(price) ASC, MIN(id) DESC",
    "price_desc": "MAX(price) DESC, MIN(id) DESC",
}

# «Підпис торгової пропозиції» (псевдоніми per_number): бренд+тип+колір+модель+
# сезон+ціна+стан. За ним різні номери (різні завози ІДЕНТИЧНОГО товару в тому ж
# стані й за тією ж ціною) зливаються в ОДНУ публічну картку. Адмін
# (group_offers=false) бачить кожен номер окремо — для поштучного керування.
_OFFER_SIG = "brandid, typeid, colorid, model_key, season_key, price, cond_key"


def _pick_representative(members: List[Dict[str, Any]],
                         official_only: bool = False) -> tuple[Dict[str, Any], Optional[str]]:
    """Серед злитих в одну картку номерів обираємо представника: пріоритет —
    студійне (official) головне фото, далі будь-яке фото, далі без фото. Його id
    і фото йдуть у картку (узгоджено: студійні в пріоритеті). official_only —
    публічна вітрина: картці дозволене лише студійне фото (реальні — тільки адміну)."""
    best_rank, best = 9, members[0]
    for m in members:
        imgs = list_images(m["pn"], m.get("of") or "")
        rank = 0 if (imgs and imgs[0].kind == "official") else (1 if imgs else 2)
        if rank < best_rank:
            best_rank, best = rank, m
    return best, main_image_url(best["pn"], best.get("of") or "", official_only=official_only)


def _build_filters(
    search: Optional[str],
    typeids: Optional[List[int]],
    subtypeids: Optional[List[int]],
    brandids: Optional[List[int]],
    genderids: Optional[List[int]],
    color_group_ids: Optional[List[int]],
    conditionids: Optional[List[int]],
    seasons: Optional[List[str]],
    eu_sizes: Optional[List[int]],
    size_letters: Optional[List[str]],
    min_price: Optional[float],
    max_price: Optional[float],
    min_cm: Optional[float],
    max_cm: Optional[float],
    has_photo: Optional[bool],
    only_published: bool = True,
) -> tuple[str, Dict[str, Any]]:
    """Збирає додаткові WHERE-умови та параметри запиту."""
    conditions: List[str] = []
    params: Dict[str, Any] = {}

    # Публічний каталог показує лише схвалені до публікації товари (catalog_listings).
    # Адмін передає only_published=false, щоб бачити весь наявний пул для модерації.
    if only_published:
        conditions.append("COALESCE(cl.is_published, FALSE) = TRUE")

    if search and search.strip():
        # Розумний пошук: кожне слово запиту має збігтися хоча б з одним полем
        # (номер, бренд, тип, підвид, стиль, колір, сезон, стать, стан, модель,
        # опис). Регістр кирилиці згортаємо через ICU-колацію (звичайний lower/
        # ILIKE цього НЕ роблять у цій БД), unaccent — для латинських діакритик,
        # trigram (pg_trgm) на коротких полях — толерантність до помилок.
        # extranote НЕ включаємо: це приватні нотатки — щоб їх не можна було «промацати» пошуком
        like_fields = [
            "p.productnumber", "p.model", "p.description", "p.marking",
            "b.brandname", "t.typename", "st.subtypename", "sty.stylename",
            "c.colorname", "p.season", "g.gendername", "cond.conditionname",
        ]
        trgm_fields = ["b.brandname", "t.typename", "st.subtypename", "c.colorname", "p.model"]
        norm = lambda expr: f'unaccent(lower({expr} COLLATE "und-x-icu"))'
        token_clauses: List[str] = []
        for i, raw in enumerate(search.strip().split()):
            token = raw.lower()
            like_key, trgm_key = f"s_like_{i}", f"s_trgm_{i}"
            params[like_key] = f"%{token}%"
            params[trgm_key] = token
            ors = [f"{norm(f)} LIKE unaccent(:{like_key})" for f in like_fields]
            ors += [f"{norm(f)} % unaccent(:{trgm_key})" for f in trgm_fields]
            # Кирилична транслітерація бренду («найк»→Nike, «адідас»→Adidas): бренди в
            # БД латиницею, а pg_trgm НЕ генерує тригерми для кирилиці. Тож токен резолвимо
            # у brand_id через спільну brand_aliases (її ж читає BMS-парсер): точний збіг,
            # підрядковий (множина/багатослівні «нью баланс») і levenshtein≤1 (одруки).
            ntok = f"unaccent(:{trgm_key})"
            nalias = norm("ba.alias_name")
            strict = (  # точний або підрядковий збіг аліаса (множина/багатослівні)
                f"{nalias} = {ntok} "
                f"OR (length({ntok}) >= 4 AND {nalias} LIKE '%' || {ntok} || '%') "
                f"OR (length({nalias}) >= 4 AND {ntok} LIKE '%' || {nalias} || '%')"
            )
            ors.append(f"p.brandid IN (SELECT ba.brand_id FROM brand_aliases ba WHERE {strict})")
            # levenshtein — лише РЕЗЕРВ (коли строгого збігу нема), щоб одрук «адидс»→Adidas
            # ловився, але точний «крокс» не тягнув ще й сусідній «брокс»→Brooks.
            ors.append(
                f"(length({ntok}) >= 4 "
                f"AND NOT EXISTS (SELECT 1 FROM brand_aliases ba WHERE {strict}) "
                f"AND p.brandid IN (SELECT ba.brand_id FROM brand_aliases ba "
                f"WHERE levenshtein({nalias}, {ntok}) <= 1))"
            )
            token_clauses.append("(" + " OR ".join(ors) + ")")
        conditions.append("(" + " AND ".join(token_clauses) + ")")
    if typeids:
        conditions.append("p.typeid = ANY(:typeids)")
        params["typeids"] = typeids
    if subtypeids:
        conditions.append("p.subtypeid = ANY(:subtypeids)")
        params["subtypeids"] = subtypeids
    if brandids:
        conditions.append("p.brandid = ANY(:brandids)")
        params["brandids"] = brandids
    if genderids:
        conditions.append("p.genderid = ANY(:genderids)")
        params["genderids"] = genderids
    if color_group_ids:
        conditions.append(
            "p.colorid IN (SELECT color_id FROM color_group_members WHERE group_id = ANY(:color_group_ids))"
        )
        params["color_group_ids"] = color_group_ids
    if conditionids:
        conditions.append("COALESCE(p.current_conditionid, p.conditionid) = ANY(:conditionids)")
        params["conditionids"] = conditionids
    if seasons:
        # season — multi-value рядок "Зима, Осінь"; матчимо кожен сезон окремо
        season_parts = [f"p.season ILIKE :season_{i}" for i in range(len(seasons))]
        conditions.append(f"({' OR '.join(season_parts)})")
        for i, season in enumerate(seasons):
            params[f"season_{i}"] = f"%{season}%"
    if eu_sizes:
        # Чіп цілого розміру K ловить товар, чий sizeeu (значення/дроб/діапазон)
        # потрапляє у K за floor: "39"/"39.5"/"39.3"→39; "39-40"→39 і 40;
        # "36-38.5"→36,37,38. Парсимо sizeeu у [lo, hi] і шукаємо ціле з набору.
        clean = "REPLACE(REPLACE(p.sizeeu, ',', '.'), ' ', '')"
        lo_raw = f"split_part({clean}, '-', 1)"
        hi_raw = f"split_part({clean}, '-', 2)"
        lo = f"(CASE WHEN {lo_raw} ~ '^[0-9]+(\\.[0-9]+)?$' THEN {lo_raw}::numeric END)"
        hi = f"COALESCE((CASE WHEN {hi_raw} ~ '^[0-9]+(\\.[0-9]+)?$' THEN {hi_raw}::numeric END), {lo})"
        conditions.append(f"""(
            p.sizeeu IS NOT NULL AND {lo} IS NOT NULL
            AND EXISTS (
                SELECT 1 FROM unnest(CAST(:eu_sizes AS int[])) AS sz
                WHERE sz >= FLOOR({lo}) AND sz <= FLOOR({hi})
            )
        )""")
        params["eu_sizes"] = eu_sizes
    if size_letters:
        conditions.append("p.size_letter = ANY(:size_letters)")
        params["size_letters"] = size_letters
    if min_price is not None:
        conditions.append("p.price >= :min_price")
        params["min_price"] = min_price
    if max_price is not None:
        conditions.append("p.price <= :max_price")
        params["max_price"] = max_price
    if min_cm is not None:
        conditions.append("COALESCE(p.measurementscm_max, p.measurementscm_min) >= :min_cm")
        params["min_cm"] = min_cm
    if max_cm is not None:
        conditions.append("COALESCE(p.measurementscm_min, p.measurementscm_max) <= :max_cm")
        params["max_cm"] = max_cm
    if has_photo:
        # Лише ОФІЦІЙНІ (студійні) фото: зіставляємо власний номер АБО донора
        # official_photos_from з набором номерів, що мають офіційне фото.
        # БЕЗ LOWER: Postgres не фолдить кирилицю; набір містить обидва регістри.
        conditions.append("""(
            BTRIM(LTRIM(p.productnumber, '#')) = ANY(:photo_pns)
            OR BTRIM(COALESCE(p.official_photos_from, '')) = ANY(:photo_pns)
        )""")
        params["photo_pns"] = list(official_photo_productnumbers())

    where_sql = (" AND " + " AND ".join(conditions)) if conditions else ""
    return where_sql, params


@router.get("/api/catalog")
async def get_catalog(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    search: Optional[str] = Query(None),
    typeids: Optional[List[int]] = Query(None),
    subtypeids: Optional[List[int]] = Query(None),
    brandids: Optional[List[int]] = Query(None),
    genderids: Optional[List[int]] = Query(None),
    color_group_ids: Optional[List[int]] = Query(None),
    conditionids: Optional[List[int]] = Query(None),
    seasons: Optional[List[str]] = Query(None),
    eu_sizes: Optional[List[int]] = Query(None),
    size_letters: Optional[List[str]] = Query(None),
    min_price: Optional[float] = Query(None, ge=0),
    max_price: Optional[float] = Query(None, ge=0),
    min_cm: Optional[float] = Query(None),
    max_cm: Optional[float] = Query(None),
    # Дефолт True: публічний каталог НІКОЛИ не показує товар без фото.
    # Лише адмін явно передає has_photo=false, щоб бачити такі товари для правок.
    has_photo: bool = Query(True),
    # Публіка бачить лише опубліковані; адмін передає only_published=false для модерації.
    only_published: bool = Query(True),
    # Публічна вітрина (True): різні номери ідентичного товару зливаються в одну
    # картку. Адмін (False): кожен номер окремо — для поштучного керування.
    group_offers: bool = Query(True),
    sort: str = Query("newest"),
    db: Session = Depends(get_db),
):
    """Список наявних товарів з фільтрами та пагінацією."""
    order_by = _OUTER_SORTS.get(sort, _OUTER_SORTS["newest"])
    # «Рекомендовані» спливають угору лише у дефолтній (кураторській) сітці «Новинки»;
    # при явному сортуванні за ціною поважаємо вибір користувача без піну.
    if sort == "newest":
        order_by = "BOOL_OR(featured) DESC, " + order_by
    group_key = _OFFER_SIG if group_offers else "productnumber"
    where_sql, params = _build_filters(
        search, typeids, subtypeids, brandids, genderids, color_group_ids,
        conditionids, seasons, eu_sizes, size_letters,
        min_price, max_price, min_cm, max_cm, has_photo, only_published,
    )

    base_sql = f"{_FULL_JOINS} WHERE {_AVAILABLE_WHERE} {where_sql}"

    # Внутрішній рівень: агрегуємо рядки-розміри по номеру (як було). Зовнішній:
    # групуємо номери у пропозицію за підписом (або лишаємо по номеру для адміна).
    per_number = f"""
        WITH per_number AS (
            SELECT MIN(p.id) AS id, p.productnumber,
                   MIN(p.official_photos_from) AS official_photos_from,
                   MIN(p.model) AS model, MIN(p.price) AS price, MAX(p.oldprice) AS oldprice,
                   ARRAY_AGG(DISTINCT p.sizeeu) FILTER (WHERE p.sizeeu IS NOT NULL AND p.sizeeu <> '') AS sizes,
                   ARRAY_AGG(DISTINCT p.size_letter) FILTER (WHERE p.size_letter IS NOT NULL AND p.size_letter <> '') AS size_letters,
                   MIN(p.measurementscm) AS measurementscm,
                   MIN(p.season) AS season, MIN(b.brandname) AS brandname, MIN(t.typename) AS typename,
                   MAX(p.dateadded) AS dateadded,
                   BOOL_OR(COALESCE(cl.is_featured, FALSE)) AS featured,
                   BOOL_OR(COALESCE(cl.is_published, FALSE)) AS published,
                   MIN(p.brandid) AS brandid, MIN(p.typeid) AS typeid, MIN(p.colorid) AS colorid,
                   lower(btrim(coalesce(MIN(p.model), ''))) AS model_key,
                   lower(btrim(coalesce(MIN(p.season), ''))) AS season_key,
                   MIN(COALESCE(p.current_conditionid, p.conditionid)) AS cond_key
            {base_sql}
            GROUP BY p.productnumber
        )
    """

    total = db.execute(text(
        f"{per_number} SELECT COUNT(*) FROM (SELECT 1 FROM per_number GROUP BY {group_key}) t"
    ), params).scalar() or 0

    rows = db.execute(
        text(f"""
            {per_number}
            SELECT jsonb_agg(jsonb_build_object(
                       'id', id, 'pn', productnumber, 'of', coalesce(official_photos_from, ''),
                       'sizes', sizes, 'size_letters', size_letters
                   ) ORDER BY id) AS members,
                   MIN(model) AS model, MIN(price) AS price, MAX(oldprice) AS oldprice,
                   MIN(season) AS season, MIN(brandname) AS brandname, MIN(typename) AS typename,
                   MIN(measurementscm) AS measurementscm,
                   BOOL_OR(featured) AS featured, BOOL_OR(published) AS published
            FROM per_number
            GROUP BY {group_key}
            ORDER BY {order_by}
            LIMIT :limit OFFSET :offset
        """),
        {**params, "limit": per_page, "offset": (page - 1) * per_page},
    ).mappings().all()

    def _size_sort_key(value: str) -> float:
        try:
            return float(value.replace(",", ".").split("-")[0])
        except ValueError:
            return 999.0

    items = []
    for r in rows:
        members = r["members"] or []
        sizes = sorted({s for m in members for s in (m.get("sizes") or [])}, key=_size_sort_key)
        size_letters = sorted({l for m in members for l in (m.get("size_letters") or [])})
        rep, image = _pick_representative(members, official_only=only_published)
        items.append({
            "id": rep["id"],
            "productnumber": rep["pn"],
            "model": r["model"],
            "brand": r["brandname"],
            "type": r["typename"],
            "price": r["price"],
            "oldprice": r["oldprice"],
            "sizes": sizes,
            "size_letters": size_letters,
            "measurementscm": r["measurementscm"],
            "season": r["season"],
            "image": image,
            "featured": r["featured"],
            "published": r["published"],   # для адмін-сітки (бачить пул і що ввімкнено)
        })

    return {
        "items": items,
        "total": total,
        "page": page,
        "pages": (total + per_page - 1) // per_page,
    }


@router.get("/api/catalog/filters")
async def get_catalog_filters(
    only_published: bool = Query(True),
    db: Session = Depends(get_db),
):
    """Опції фільтрів, пораховані лише по наявних товарах (з кількістю)."""
    from_sql = f"""
        FROM products p
        LEFT JOIN statuses s ON p.statusid = s.id
        LEFT JOIN catalog_listings cl ON cl.productnumber = p.productnumber
        {_SOLD_JOIN}
    """
    # Публіка рахує опції лише по опублікованих; адмін — по всьому наявному пулу.
    where_avail = _AVAILABLE_WHERE + (" AND COALESCE(cl.is_published, FALSE) = TRUE" if only_published else "")
    base_sql = f"{from_sql} WHERE {where_avail}"

    def _options(join_table: str, join_on: str, id_col: str, name_col: str) -> List[Dict[str, Any]]:
        # Службові/порожні/плейсхолдерні назви ('???', 'Невідомо', 'Невизначено')
        # у публічні фільтри не пускаємо — товари лишаються в каталозі, лише без чіпа
        rows = db.execute(text(f"""
            SELECT x.{id_col} AS id, x.{name_col} AS name, COUNT(*) AS count
            {from_sql}
            JOIN {join_table} x ON {join_on}
            WHERE {where_avail}
              AND x.{name_col} IS NOT NULL
              AND x.{name_col} NOT IN ('', '???', 'Невідомо', 'Невизначено')
            GROUP BY x.{id_col}, x.{name_col}
            ORDER BY count DESC, name
        """)).mappings().all()
        return [dict(r) for r in rows]

    # Продажі на бренд/тип (по всіх товарах, не лише наявних) — для сортування
    # дефолтних чіпів: найпопулярніше за продажами йде першим.
    def _sales_map(col: str) -> Dict[int, int]:
        rows = db.execute(text(f"""
            SELECT p.{col} AS id, COALESCE(SUM(sold.sold_count), 0) AS sales
            FROM products p {_SOLD_JOIN}
            WHERE p.{col} IS NOT NULL
            GROUP BY p.{col}
        """)).mappings().all()
        return {r["id"]: r["sales"] for r in rows}

    def _by_sales(options: List[Dict[str, Any]], sales: Dict[int, int]) -> List[Dict[str, Any]]:
        return sorted(options, key=lambda o: (-sales.get(o["id"], 0), -o["count"], o["name"]))

    types = _by_sales(_options("types", "x.id = p.typeid", "id", "typename"), _sales_map("typeid"))
    subtypes = _options("subtypes", "x.id = p.subtypeid", "id", "subtypename")
    brands = _by_sales(_options("brands", "x.id = p.brandid", "id", "brandname"), _sales_map("brandid"))
    genders = _options("genders", "x.id = p.genderid", "id", "gendername")
    conditions = _options(
        "conditions", "x.id = COALESCE(p.current_conditionid, p.conditionid)", "id", "conditionname"
    )
    # Захист: реальні стани — короткі мітки без речень; вільний текст-нотатка
    # (містить крапку, напр. «потертості. легка відмінність…») у фільтр не пускаємо
    conditions = [c for c in conditions if "." not in (c.get("name") or "")]

    color_groups = [dict(r) for r in db.execute(text(f"""
        SELECT cg.id, cg.name, cg.hex_code, COUNT(*) AS count
        {from_sql}
        JOIN color_group_members cgm ON cgm.color_id = p.colorid
        JOIN color_groups cg ON cg.id = cgm.group_id
        WHERE {where_avail}
        GROUP BY cg.id, cg.name, cg.hex_code, cg.display_order
        ORDER BY cg.display_order
    """)).mappings().all()]

    # EU-розміри — СТАБІЛЬНИЙ «всесвіт» (усі цілі EU, наявні в каталозі). Фронтенд
    # малює цю фіксовану сітку завжди; динамічний фасет лише гасить недоступні —
    # тож сітка не змінює розмір (нема «мелькання»).
    eu_rows = db.execute(text(f"""
        SELECT DISTINCT p.sizeeu {base_sql} AND p.sizeeu IS NOT NULL AND p.sizeeu <> ''
    """)).scalars().all()
    eu_wholes: set[int] = set()
    for v in eu_rows:
        eu_wholes.update(_sizeeu_to_wholes(v))
    eu = sorted(w for w in eu_wholes if w >= 14)

    size_letters = [r["size_letter"] for r in db.execute(text(f"""
        SELECT DISTINCT p.size_letter {base_sql} AND p.size_letter IS NOT NULL AND p.size_letter <> ''
    """)).mappings().all()]
    letter_order = {"XS": 0, "S": 1, "M": 2, "L": 3, "XL": 4, "XXL": 5, "XXXL": 6}
    size_letters.sort(key=lambda letter: letter_order.get(letter, 99))

    seasons_raw = db.execute(text(f"""
        SELECT DISTINCT p.season {base_sql} AND p.season IS NOT NULL AND p.season <> ''
    """)).mappings().all()
    seasons: List[str] = []
    for r in seasons_raw:
        for part in (r["season"] or "").split(","):
            part = part.strip()
            if part and part not in seasons:
                seasons.append(part)
    seasons.sort()

    price_range = db.execute(text(f"""
        SELECT COALESCE(MIN(p.price), 0) AS min, COALESCE(MAX(p.price), 0) AS max {base_sql}
    """)).mappings().first()

    return {
        "types": types,
        "subtypes": subtypes,
        "brands": brands,
        "genders": genders,
        "conditions": conditions,
        "color_groups": color_groups,
        "eu": eu,
        "size_letters": size_letters,
        "seasons": seasons,
        "price_range": dict(price_range) if price_range else {"min": 0, "max": 0},
    }


def _sizeeu_to_wholes(value: str) -> List[int]:
    """Цілі EU-розміри, які «накриває» значення sizeeu — узгоджено з матчингом
    чіпа у _build_filters (floor по [lo, hi]): "39"/"39.5"/"39.3"→[39];
    "39-40"→[39,40]; "36-38.5"→[36,37,38]. Нечислові/порожні → []."""
    cleaned = value.replace(",", ".").replace(" ", "")
    parts = cleaned.split("-")

    def _num(token: str) -> Optional[float]:
        return float(token) if re.fullmatch(r"[0-9]+(\.[0-9]+)?", token) else None

    lo = _num(parts[0]) if parts and parts[0] else None
    if lo is None:
        return []
    hi = _num(parts[1]) if len(parts) > 1 else None
    if hi is None:
        hi = lo
    return list(range(math.floor(lo), math.floor(hi) + 1))


@router.get("/api/catalog/facets")
async def get_facets(
    search: Optional[str] = Query(None),
    typeids: Optional[List[int]] = Query(None),
    subtypeids: Optional[List[int]] = Query(None),
    brandids: Optional[List[int]] = Query(None),
    genderids: Optional[List[int]] = Query(None),
    color_group_ids: Optional[List[int]] = Query(None),
    conditionids: Optional[List[int]] = Query(None),
    seasons: Optional[List[str]] = Query(None),
    eu_sizes: Optional[List[int]] = Query(None),
    size_letters: Optional[List[str]] = Query(None),
    min_price: Optional[float] = Query(None, ge=0),
    max_price: Optional[float] = Query(None, ge=0),
    min_cm: Optional[float] = Query(None),
    max_cm: Optional[float] = Query(None),
    has_photo: bool = Query(True),
    only_published: bool = Query(True),
    db: Session = Depends(get_db),
):
    """Динамічні фасети: EU-розміри, стать, кольорові групи — наявні в поточному
    відфільтрованому наборі. Кожен фасет ВИКЛЮЧАЄ свій власний фільтр (faceted
    search) — щоб опції адаптувались під інші активні фільтри, але лишались
    вибірними (вибране можна зняти, навіть якщо фасет його вже не містить)."""

    def _where(skip: str) -> tuple[str, Dict[str, Any]]:
        # «size» виключає весь розмірний фасет (EU + буквений)
        return _build_filters(
            search, typeids, subtypeids, brandids,
            None if skip == "gender" else genderids,
            None if skip == "color" else color_group_ids,
            conditionids, seasons,
            None if skip == "size" else eu_sizes,
            None if skip == "size" else size_letters,
            min_price, max_price, min_cm, max_cm, has_photo, only_published,
        )

    # — Розмір: EU + буквений (виключаємо власний розмірний фільтр) —
    sw, sp = _where("size")
    size_rows = db.execute(text(f"""
        SELECT DISTINCT p.sizeeu {_FULL_JOINS}
        WHERE {_AVAILABLE_WHERE} {sw} AND p.sizeeu IS NOT NULL AND p.sizeeu <> ''
    """), sp).scalars().all()
    wholes: set[int] = set()
    for value in size_rows:
        wholes.update(_sizeeu_to_wholes(value))
    eu = sorted(w for w in wholes if w >= 14)

    letter_rows = db.execute(text(f"""
        SELECT DISTINCT p.size_letter {_FULL_JOINS}
        WHERE {_AVAILABLE_WHERE} {sw} AND p.size_letter IS NOT NULL AND p.size_letter <> ''
    """), sp).scalars().all()
    _LETTER_ORDER = {"XS": 0, "S": 1, "M": 2, "L": 3, "XL": 4, "XXL": 5, "XXXL": 6, "XXXXXXL": 9}
    size_letters_avail = sorted(letter_rows, key=lambda x: _LETTER_ORDER.get(x, 99))

    # — Стать (виключаємо власний фільтр статі) —
    gw, gp = _where("gender")
    gender_rows = db.execute(text(f"""
        SELECT g.id AS id, g.gendername AS name, COUNT(DISTINCT p.id) AS count {_FULL_JOINS}
        WHERE {_AVAILABLE_WHERE} {gw}
          AND p.genderid IS NOT NULL AND g.gendername NOT IN ('', 'Невідомо', 'Невизначено')
        GROUP BY g.id, g.gendername ORDER BY count DESC
    """), gp).mappings().all()

    # — Кольорові групи (виключаємо власний фільтр кольору) —
    cw, cp = _where("color")
    color_rows = db.execute(text(f"""
        SELECT cg.id AS id, cg.name AS name, cg.hex_code AS hex_code, COUNT(DISTINCT p.id) AS count
        {_FULL_JOINS}
        JOIN color_group_members cgm ON cgm.color_id = p.colorid
        JOIN color_groups cg ON cg.id = cgm.group_id
        WHERE {_AVAILABLE_WHERE} {cw}
        GROUP BY cg.id, cg.name, cg.hex_code, cg.display_order ORDER BY cg.display_order
    """), cp).mappings().all()

    return {
        "eu": eu,
        "size_letters": size_letters_avail,
        "genders": [dict(r) for r in gender_rows],
        "color_groups": [dict(r) for r in color_rows],
    }


@router.get("/api/catalog/{product_id}")
async def get_catalog_product(
    product_id: int = Path(..., ge=1),
    only_published: bool = Query(True),
    # True (публічна вітрина): розміри збираємо по всіх номерах тієї ж пропозиції.
    group_offers: bool = Query(True),
    db: Session = Depends(get_db),
):
    """Повна картка товару з фото та матеріалами."""
    pub_clause = " AND COALESCE(cl.is_published, FALSE) = TRUE" if only_published else ""
    row = db.execute(
        text(f"""
            SELECT p.id, p.productnumber, p.official_photos_from, p.model, p.description,
                   COALESCE(cl.is_published, FALSE) AS published,
                   COALESCE(cl.is_featured, FALSE) AS featured,
                   p.brandid, p.typeid, p.colorid,
                   COALESCE(p.current_conditionid, p.conditionid) AS sig_cond,
                   p.price, p.oldprice, p.sizeeu, p.sizeua, p.measurementscm,
                   p.size_letter, p.season, p.year, p.width, p.dimensions,
                   p.measurements_length_min, p.measurements_length_max,
                   p.measurements_height_min, p.measurements_height_max,
                   p.measurements_heel_min, p.measurements_heel_max,
                   p.measurements_sole_thickness_min, p.measurements_sole_thickness_max,
                   b.brandname, t.typename, st.subtypename, sty.stylename,
                   g.gendername, c.colorname, cond.conditionname,
                   GREATEST(COALESCE(p.quantity, 0) - COALESCE(sold.sold_count, 0), 0) AS available
            FROM products p
            LEFT JOIN brands b ON p.brandid = b.id
            LEFT JOIN types t ON p.typeid = t.id
            LEFT JOIN subtypes st ON p.subtypeid = st.id
            LEFT JOIN styles sty ON p.styleid = sty.id
            LEFT JOIN genders g ON p.genderid = g.id
            LEFT JOIN colors c ON p.colorid = c.id
            LEFT JOIN conditions cond ON cond.id = COALESCE(p.current_conditionid, p.conditionid)
            LEFT JOIN statuses s ON p.statusid = s.id
            LEFT JOIN catalog_listings cl ON cl.productnumber = p.productnumber
            {_SOLD_JOIN}
            WHERE p.id = :product_id AND {_AVAILABLE_WHERE}{pub_clause}
        """),
        {"product_id": product_id},
    ).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Товар не знайдено або вже продано")

    materials = db.execute(
        text("""
            SELECT pm.position, m.materialname
            FROM product_materials pm
            JOIN materials m ON m.id = pm.material_id
            WHERE pm.product_id = :product_id
            ORDER BY pm.position, pm.ord
        """),
        {"product_id": product_id},
    ).mappings().all()
    materials_by_position: Dict[str, List[str]] = {}
    for m in materials:
        materials_by_position.setdefault(m["position"], []).append(m["materialname"])

    # Публіці (only_published) — ЛИШЕ студійні фото; «реальні»/«нюанси» бачить тільки адмін
    images = list_images(row["productnumber"], row["official_photos_from"] or "",
                         width=GALLERY_IMAGE_WIDTH, official_only=only_published)

    # Розміри: для номера (ростовка) АБО для всіх номерів тієї ж пропозиції
    # (group_offers) — щоб злита картка показувала повну ростовку всіх завозів.
    size_rows = db.execute(
        text(f"""
            SELECT p.id, p.sizeeu, p.sizeua, p.size_letter, p.measurementscm,
                   GREATEST(COALESCE(p.quantity, 0) - COALESCE(sold.sold_count, 0), 0) AS available
            FROM products p
            LEFT JOIN statuses s ON p.statusid = s.id
            LEFT JOIN catalog_listings cl ON cl.productnumber = p.productnumber
            {_SOLD_JOIN}
            WHERE {_AVAILABLE_WHERE}{pub_clause} AND (
                (NOT :group_offers AND p.productnumber = :pnum)
                OR (:group_offers
                    AND p.brandid IS NOT DISTINCT FROM :brandid
                    AND p.typeid IS NOT DISTINCT FROM :typeid
                    AND p.colorid IS NOT DISTINCT FROM :colorid
                    AND lower(btrim(coalesce(p.model, ''))) = lower(btrim(coalesce(:model_raw, '')))
                    AND lower(btrim(coalesce(p.season, ''))) = lower(btrim(coalesce(:season_raw, '')))
                    AND p.price IS NOT DISTINCT FROM :price
                    AND COALESCE(p.current_conditionid, p.conditionid) IS NOT DISTINCT FROM :cond)
            )
            ORDER BY p.sizeeu NULLS LAST, p.id
        """),
        {
            "group_offers": group_offers, "pnum": row["productnumber"],
            "brandid": row["brandid"], "typeid": row["typeid"], "colorid": row["colorid"],
            "model_raw": row["model"], "season_raw": row["season"],
            "price": row["price"], "cond": row["sig_cond"],
        },
    ).mappings().all()

    # Дедуплікація за САМИМ розміром (як він у чіпі), БЕЗ устілки в см — інакше
    # «43-44 EU» з трохи різним обміром (27-27.5 vs 27-28 см) дублювався б. Ключ:
    # EU → літера → см (для дитячих/без EU, де розмір задає саме см).
    def _size_identity(r) -> tuple:
        if r["sizeeu"]:
            return ("eu", r["sizeeu"].replace(" ", ""))
        if r["size_letter"]:
            return ("letter", r["size_letter"])
        return ("cm", r["measurementscm"])

    seen, size_variants = set(), []
    for r in size_rows:
        key = _size_identity(r)
        if key in seen:
            continue
        seen.add(key)
        size_variants.append(dict(r))

    skip = {"official_photos_from", "brandid", "typeid", "colorid", "sig_cond"}
    return {
        **{k: row[k] for k in row.keys() if k not in skip},
        "materials": materials_by_position,
        "images": [{"url": img.url, "kind": img.kind} for img in images],
        "size_variants": size_variants,
    }
