#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Односторонній синхрон каталожного ЗРІЗУ bsstorage → хмарна Postgres (read-copy).

Навіщо: каталог 24/7 у хмарі читає ВЛАСНУ копію БД, а BMS лишається недоторканим
джерелом істини на Mac. Цей скрипт лише ЧИТАЄ локальну bsstorage (COPY ... TO STDOUT)
і перезаливає потрібні таблиці в хмару — у локальну БД НІЧОГО не пише, BMS не чіпає.

Приватність: з orders/order_items беремо ЛИШЕ колонки для sold_count — жодних даних
клієнтів (імен, адрес, цін оплат) у хмару не потрапляє.

Запуск:  CLOUD_DATABASE_URL=postgres://... python cloud/sync_to_cloud.py
Локальні креди — зі звичайних DB_* (.env у корені BMS_catalog).
Щогодинний автозапуск — через launchd (див. cloud/com.bms.catalog.sync.plist).
"""
import io
import os
import sys
import time
import psycopg2
from dotenv import load_dotenv

# Маніфест: таблиця → колонки (None = всі). orders/order_items — лише для sold_count.
TABLES = {
    "brands": None, "types": None, "subtypes": None, "styles": None,
    "colors": None, "genders": None, "conditions": None, "statuses": None,
    "color_groups": None, "color_group_members": None,
    "materials": None, "product_materials": None,
    # catalog_listings НЕМАЄ у цьому списку: публікації синхронізуються
    # ДВОБІЧНО (мердж newest-wins) — див. _merge_catalog_listings нижче.
    # Простий push затирав би тумблери 👁, натиснуті в Mini App (вони пишуть
    # у ХМАРНУ БД через Railway).
    "brand_aliases": None,
    "products": None,
    "orders": ["id", "order_status_id", "payment_status_id"],
    "order_items": ["order_id", "product_id"],
}

# Індекси у хмарі — щоб каталожні запити були швидкі (локальні індекси не копіюються).
INDEXES = [
    'CREATE INDEX IF NOT EXISTS ix_products_brandid ON products(brandid)',
    'CREATE INDEX IF NOT EXISTS ix_products_typeid ON products(typeid)',
    'CREATE INDEX IF NOT EXISTS ix_products_colorid ON products(colorid)',
    'CREATE INDEX IF NOT EXISTS ix_products_pnum ON products(productnumber)',
    'CREATE INDEX IF NOT EXISTS ix_cl_pnum ON catalog_listings(productnumber)',
    'CREATE INDEX IF NOT EXISTS ix_ba_brandid ON brand_aliases(brand_id)',
    'CREATE INDEX IF NOT EXISTS ix_oi_product ON order_items(product_id)',
    'CREATE INDEX IF NOT EXISTS ix_oi_order ON order_items(order_id)',
    'CREATE INDEX IF NOT EXISTS ix_pm_product ON product_materials(product_id)',
]


def _merge_catalog_listings(lc, cc, local_dsn: dict) -> tuple:
    """ДВОБІЧНИЙ синк публікацій (catalog_listings): newest-wins по updated_at.

    Тумблери 👁 у Mini App пишуть у ХМАРНУ БД (через Railway), а BMS-картка — у
    ЛОКАЛЬНУ. Простий push локальної копії затирав би хмарні рішення адміна.
    Тому: читаємо ОБИДВІ сторони → для кожного номера перемагає новіший
    updated_at → результат пишемо у хмару (в межах великої транзакції) і
    ДОПИСУЄМО назад у локальну (окреме rw-з'єднання; catalog_listings — таблиця
    САМОГО каталогу, BMS-core не чіпається).

    Синхронізуємо ВСІ керовані колонки каталогу — базові (публікація/рекомендований)
    ТА фічі (публічність опису, знижка sale_price/is_on_sale). Інакше TRUNCATE+insert
    лише базових колонок затирав би фічі в хмарі щоразу. newest-wins — по updated_at
    (тому кожен writer має ставити updated_at=now())."""
    # Колонки в СТАЛОМУ порядку; updated_at — останній (індекс для newest-wins).
    COLS = ["productnumber", "is_published", "is_featured", "is_description_public",
            "sale_price", "is_on_sale", "published_at", "updated_at"]
    U = COLS.index("updated_at")
    collist = ", ".join(COLS)
    sel = f"SELECT {collist} FROM catalog_listings"

    cc.execute("""CREATE TABLE IF NOT EXISTS catalog_listings (
        productnumber text PRIMARY KEY,
        is_published boolean NOT NULL DEFAULT false,
        is_featured boolean NOT NULL DEFAULT false,
        published_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now())""")
    # Адитивні фіче-колонки на ОБИДВОХ сторонах (щоб SELECT/INSERT з ними не падали).
    # local — READONLY, тож локальні ALTER — через окреме rw-з'єднання ДО читання.
    feature_ddl = [
        "ADD COLUMN IF NOT EXISTS is_description_public boolean NOT NULL DEFAULT false",
        "ADD COLUMN IF NOT EXISTS sale_price numeric",
        "ADD COLUMN IF NOT EXISTS is_on_sale boolean NOT NULL DEFAULT false",
    ]
    for ddl in feature_ddl:
        cc.execute(f"ALTER TABLE catalog_listings {ddl}")
    lrw = psycopg2.connect(**local_dsn)
    try:
        lrc = lrw.cursor()
        for ddl in feature_ddl:
            lrc.execute(f"ALTER TABLE catalog_listings {ddl}")
        lrw.commit()

        cc.execute(sel)
        cloud_rows = {r[0]: r for r in cc.fetchall()}
        lc.execute(sel)
        local_rows = {r[0]: r for r in lc.fetchall()}

        merged = {}
        for pn in set(cloud_rows) | set(local_rows):
            a, b = local_rows.get(pn), cloud_rows.get(pn)
            merged[pn] = a if (b is None or (a is not None and a[U] >= b[U])) else b

        # Хмара: повна заміна злитим станом (у тій самій транзакції, що й решта).
        cc.execute("TRUNCATE catalog_listings")
        # PRIMARY KEY обов'язковий: admin-тумблер 👁 (Railway) робить upsert
        # ON CONFLICT (productnumber) — без PK він ПАДАЄ. Історично таблицю в хмарі
        # створив генерований синк без ключів; додаємо PK (після TRUNCATE — безпечно).
        cc.execute("""DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint
                           WHERE conrelid = 'catalog_listings'::regclass AND contype = 'p') THEN
                ALTER TABLE catalog_listings ADD PRIMARY KEY (productnumber);
            END IF;
        END $$""")
        from psycopg2.extras import execute_values
        if merged:
            execute_values(cc,
                f"INSERT INTO catalog_listings ({collist}) VALUES %s", list(merged.values()))

        # Локальна: дозаписати лише те, де ХМАРА новіша/нова (рішення з телефона).
        newer = [merged[pn] for pn in merged
                 if pn not in local_rows or merged[pn][U] > local_rows[pn][U]]
        if newer:
            execute_values(lrc,
                f"INSERT INTO catalog_listings ({collist}) VALUES %s "
                "ON CONFLICT (productnumber) DO UPDATE SET "
                "is_published = EXCLUDED.is_published, is_featured = EXCLUDED.is_featured, "
                "is_description_public = EXCLUDED.is_description_public, "
                "sale_price = EXCLUDED.sale_price, is_on_sale = EXCLUDED.is_on_sale, "
                "published_at = EXCLUDED.published_at, updated_at = EXCLUDED.updated_at",
                newer)
            lrw.commit()
    finally:
        lrw.close()
    return len(merged), len(newer)


def _columns(local_cur, table, want):
    """(назви, DDL-визначення) колонок таблиці з information_schema (з проекцією)."""
    local_cur.execute(
        """SELECT column_name, udt_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position""",
        (table,),
    )
    rows = local_cur.fetchall()
    if want:
        order = {c: i for i, c in enumerate(want)}
        rows = sorted((r for r in rows if r[0] in order), key=lambda r: order[r[0]])
    names, defs = [], []
    for name, udt in rows:
        typ = (udt[1:] + "[]") if udt.startswith("_") else udt  # _text → text[]
        names.append(name)
        defs.append(f'"{name}" {typ}')
    return names, defs


def main():
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    cloud_url = os.getenv("CLOUD_DATABASE_URL")
    if not cloud_url:
        sys.exit("✗ Немає CLOUD_DATABASE_URL (рядок підключення до хмарної Postgres).")

    local_dsn = dict(
        host=os.getenv("DB_HOST", "localhost"), port=os.getenv("DB_PORT", "5432"),
        dbname=os.getenv("DB_NAME"), user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )
    local = psycopg2.connect(**local_dsn)
    # readonly: у BMS-таблиці не пишемо. Єдиний виняток — catalog_listings
    # (таблиця каталогу): двобічний мердж через ОКРЕМЕ rw-з'єднання.
    local.set_session(readonly=True)
    cloud = psycopg2.connect(cloud_url)
    lc, cc = local.cursor(), cloud.cursor()

    cc.execute("CREATE EXTENSION IF NOT EXISTS unaccent")
    cc.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")       # оператор % (латинський fuzzy)
    cc.execute("CREATE EXTENSION IF NOT EXISTS fuzzystrmatch")  # levenshtein (кириличні одруки)
    cloud.commit()

    t0 = time.time()
    for table, want in TABLES.items():
        names, defs = _columns(lc, table, want)
        if not names:
            print(f"  ⚠ {table}: немає колонок — пропускаю")
            continue
        collist = ", ".join(f'"{n}"' for n in names)
        cc.execute(f'CREATE TABLE IF NOT EXISTS "{table}" ({", ".join(defs)})')
        cc.execute(f'TRUNCATE "{table}"')
        buf = io.StringIO()
        lc.copy_expert(f'COPY (SELECT {collist} FROM "{table}") TO STDOUT', buf)
        buf.seek(0)
        cc.copy_expert(f'COPY "{table}" ({collist}) FROM STDIN', buf)
        print(f"  ✓ {table}: {cc.rowcount} рядків")

    # Публікації — двобічний мердж (newest-wins), НЕ простий push.
    m_total, m_back = _merge_catalog_listings(lc, cc, local_dsn)
    print(f"  ✓ catalog_listings: {m_total} рядків (мердж; у локальну повернуто {m_back})")

    # catalog_images — ПОХІДНА таблиця (нема локально): список фото-шляхів з диска,
    # щоб хмарний images.py будував індекс без диска (CATALOG_IMAGES_SOURCE=db).
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
    import images  # noqa: E402  — у sync-контексті (без CATALOG_IMAGES_SOURCE) читає ДИСК
    cc.execute('CREATE TABLE IF NOT EXISTS catalog_images (relpath text, version text)')
    cc.execute('TRUNCATE catalog_images')
    buf = io.StringIO()
    n = 0
    for relpath, version in images._iter_photo_records():
        buf.write(f"{relpath}\t{version}\n")
        n += 1
    buf.seek(0)
    cc.copy_expert("COPY catalog_images (relpath, version) FROM STDIN", buf)
    cc.execute('CREATE INDEX IF NOT EXISTS ix_catimg_relpath ON catalog_images(relpath)')
    print(f"  ✓ catalog_images: {n} фото")

    for ix in INDEXES:
        cc.execute(ix)
    # ОДИН commit на весь зріз: читачі бачать або повністю старий, або повністю
    # новий стан (жодних «наполовину оновлених» таблиць у мить синхрону о :00).
    cloud.commit()
    cc.execute("ANALYZE")
    cloud.commit()

    lc.close(); cc.close(); local.close(); cloud.close()
    print(f"✓ Синхрон завершено за {time.time() - t0:.1f}с")


if __name__ == "__main__":
    main()
