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
import fcntl
import io
import os
import sys
import time
import psycopg2
from dotenv import load_dotenv

# ── Запобіжники проти «підвисання всього BMS» ────────────────────────────────
# Реальний інцидент: цей скрипт завис на мережевому запиті до хмари, тримаючи
# ВІДКРИТУ читальну транзакцію на локальній catalog_listings. Наступний
# щогодинний запуск спробував ALTER TABLE на тій самій таблиці — і став у чергу
# за нею. У Postgres черга блокувань FIFO, тож за цим ALTER стали ВСІ читачі
# catalog_listings, а список товарів у BMS джойниться з нею → застосунок
# повністю зависав (HTTP 500 по lock timeout).
#
# Три незалежні лінії оборони:
#   1) один екземпляр за раз (flock) — накладання запусків неможливе;
#   2) серверні таймаути на локальній сесії — навіть якщо процес зависне,
#      Postgres сам прибере його транзакцію за LOCAL_IDLE_TX_TIMEOUT;
#   3) DDL лише коли колонки справді бракує, і завжди під lock_timeout.
LOCK_PATH = os.getenv("CATALOG_SYNC_LOCK", "/tmp/bms_catalog_sync.lock")
LOCAL_IDLE_TX_TIMEOUT = os.getenv("CATALOG_SYNC_IDLE_TX_TIMEOUT", "2min")
LOCAL_LOCK_TIMEOUT = os.getenv("CATALOG_SYNC_LOCK_TIMEOUT", "3s")
LOCAL_STATEMENT_TIMEOUT = os.getenv("CATALOG_SYNC_STATEMENT_TIMEOUT", "10min")


def _acquire_single_instance_lock():
    """Ексклюзивний flock на весь час роботи. Другий запуск просто виходить.

    Повертає file-об'єкт (тримати до кінця процесу — закриття знімає лок).
    """
    fh = open(LOCK_PATH, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        print("↷ Синхрон уже виконується — цей запуск пропускаю "
              f"(лок: {LOCK_PATH}).")
        sys.exit(0)
    fh.write(str(os.getpid()))
    fh.flush()
    return fh

# Маніфест: таблиця → колонки (None = всі). orders/order_items — лише для sold_count.
TABLES = {
    "brands": None, "types": None, "subtypes": None, "styles": None,
    "colors": None, "genders": None, "conditions": None, "statuses": None,
    "color_groups": None, "color_group_members": None,
    "materials": None, "product_materials": None,
    "technologies": None,   # для блоку «Технології» в картці (join у деталі каталогу)
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
            "sale_price", "is_on_sale", "featured_order", "published_at", "updated_at"]
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
    feature_cols = {
        "is_description_public": "boolean NOT NULL DEFAULT false",
        "sale_price": "numeric",
        "is_on_sale": "boolean NOT NULL DEFAULT false",
        "featured_order": "integer",
    }
    for col, typ in feature_cols.items():
        cc.execute(f"ALTER TABLE catalog_listings ADD COLUMN IF NOT EXISTS {col} {typ}")
    lrw = psycopg2.connect(**local_dsn)
    try:
        lrc = lrw.cursor()
        # ⚠️ ALTER TABLE бере ACCESS EXCLUSIVE — поки він чекає в черзі, за ним
        # стають УСІ читачі таблиці (і BMS зависає). Тому:
        #   • спершу дивимось, чого справді бракує — у нормальному прогоні
        #     жодного ALTER не виконується взагалі;
        #   • якщо ALTER потрібен — під lock_timeout, і при невдачі тихо
        #     виходимо з мерджу, а не тримаємо чергу.
        lrc.execute("""SELECT column_name FROM information_schema.columns
                       WHERE table_schema='public' AND table_name='catalog_listings'""")
        present = {r[0] for r in lrc.fetchall()}
        missing = {c: t for c, t in feature_cols.items() if c not in present}
        if missing:
            lrc.execute(f"SET lock_timeout = '{LOCAL_LOCK_TIMEOUT}'")
            try:
                for col, typ in missing.items():
                    lrc.execute(
                        f"ALTER TABLE catalog_listings ADD COLUMN IF NOT EXISTS {col} {typ}")
                lrw.commit()
            except psycopg2.errors.LockNotAvailable:
                lrw.rollback()
                print("  ⚠ catalog_listings зайнята іншою транзакцією — "
                      "пропускаю мердж публікацій цього разу (BMS не блокуємо)")
                return 0, 0
        else:
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
                "featured_order = EXCLUDED.featured_order, "
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
    # Тримаємо лок до кінця процесу: паралельних запусків (щогодинний launchd +
    # ручний тригер із BMS) більше не буває — саме їх накладання й підвісило БД.
    lock_fh = _acquire_single_instance_lock()  # noqa: F841 — живе до виходу
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
    # Серверні запобіжники на ЛОКАЛЬНІЙ сесії: якщо процес зависне на мережі до
    # хмари, Postgres сам обірве його транзакцію й звільнить локи — BMS не
    # постраждає навіть у найгіршому сценарії.
    _lc0 = local.cursor()
    _lc0.execute(f"SET idle_in_transaction_session_timeout = '{LOCAL_IDLE_TX_TIMEOUT}'")
    _lc0.execute(f"SET statement_timeout = '{LOCAL_STATEMENT_TIMEOUT}'")
    _lc0.execute(f"SET lock_timeout = '{LOCAL_LOCK_TIMEOUT}'")
    local.commit()
    _lc0.close()
    # Хмара через мережу: без keepalive обрив каналу вішає скрипт на години
    # (саме так і сталося) — тримаємо TCP-перевірку живості й ліміт на конект.
    cloud = psycopg2.connect(
        cloud_url,
        connect_timeout=int(os.getenv("CATALOG_SYNC_CONNECT_TIMEOUT", "15")),
        keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=3,
    )
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

    # Локальних читань більше не буде (catalog_images читає ДИСК, не БД) — закриваємо
    # читальну транзакцію ТУТ, до найдовшої частини (заливання в хмару). Інакше вона
    # висіла б відкритою всю мережеву роботу й тримала локи на таблицях BMS.
    local.rollback()

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
    # Після публікації товарного зрізу повертаємо лише похідну аналітику назад у
    # локальну BMS. Якщо вона тимчасово недоступна, основний каталог уже успішно
    # синхронізований і не відкочується.
    try:
        from sync_analytics_from_cloud import sync_once as _pull_analytics
        result = _pull_analytics(cloud_url, local_dsn)
        print(f"  ✓ catalog analytics: {result}")
    except Exception as exc:
        print(f"  ⚠ catalog analytics pull skipped: {exc}")
    print(f"✓ Синхрон завершено за {time.time() - t0:.1f}с")


if __name__ == "__main__":
    main()
