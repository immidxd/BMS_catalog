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
    "catalog_listings": None, "brand_aliases": None,
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
]


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

    local = psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"), port=os.getenv("DB_PORT", "5432"),
        dbname=os.getenv("DB_NAME"), user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )
    local.set_session(readonly=True)  # гарантія: у локальну БД не пишемо
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
        cloud.commit()
        print(f"  ✓ {table}: {cc.rowcount} рядків")

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
    cloud.commit()
    print(f"  ✓ catalog_images: {n} фото")

    for ix in INDEXES:
        cc.execute(ix)
    cc.execute("ANALYZE")
    cloud.commit()

    lc.close(); cc.close(); local.close(); cloud.close()
    print(f"✓ Синхрон завершено за {time.time() - t0:.1f}с")


if __name__ == "__main__":
    main()
