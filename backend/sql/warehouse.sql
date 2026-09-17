-- Склад: коробки, вміст, журнал подій. ЄДИНЕ джерело правди — ця (хмарна) база.
--
-- Пишуть сюди два клієнти: Mini App «BMS Склад» (телефони працівників, через
-- цей же бекенд) і десктопна BMS (напряму / через цей API з адмін-токеном).
-- Синхронізації з локальною базою НЕМАЄ навмисно: двобічний мердж уже кусав
-- (catalog_listings). BMS для своїх колонок «Коробка» лише ЧИТАЄ звідси.
--
-- Ідентичність товару — products.id (рядок), не номер: один номер = ростовка
-- або інший товар. product_id без FK: дзеркало products перезаливається
-- синхроном, а рядок може зникнути (злиття/перейменування) — тому поруч
-- ЗНІМОК номера/розміру/кольору, щоб коробка не «осліпла».
--
-- Ідемпотентно: застосовується при кожному старті бекенда.

CREATE TABLE IF NOT EXISTS wh_boxes (
    id           BIGSERIAL PRIMARY KEY,
    code         TEXT NOT NULL UNIQUE,              -- «Z9», «L2» — літера + номер
    category     TEXT,                              -- літера: Z зима / L літо / D демі / T трекінг / V …
    title        TEXT,                              -- «UGG зима, коробка велика»
    location     TEXT,                              -- де стоїть (поки текст; зона/слот карти — пізніше)
    status       TEXT NOT NULL DEFAULT 'open',      -- open | sealed | archived
    needs_check  BOOLEAN NOT NULL DEFAULT FALSE,    -- «Перевірити коробку»: імпорт / хтось відкривав
    note         TEXT,
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    sealed_at    TIMESTAMPTZ,
    checked_at   TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_wh_boxes_status ON wh_boxes (status);

CREATE TABLE IF NOT EXISTS wh_box_items (
    id            BIGSERIAL PRIMARY KEY,
    box_id        BIGINT NOT NULL REFERENCES wh_boxes(id) ON DELETE CASCADE,
    product_id    INTEGER NOT NULL,
    productnumber TEXT NOT NULL,                    -- знімок
    size          TEXT,                             -- знімок (sizeeu / буква)
    color         TEXT,                             -- знімок
    qty           INTEGER NOT NULL DEFAULT 1,       -- ростовка: скільки пар цього рядка лежить тут
    packed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    packed_by     TEXT,
    unpacked_at   TIMESTAMPTZ,                      -- NULL = зараз у коробці
    unpacked_by   TEXT
);
-- Один товар в одній коробці — один живий рядок (кількість зливається в qty).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_box_items_open
    ON wh_box_items (box_id, product_id) WHERE unpacked_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_wh_box_items_product_open
    ON wh_box_items (product_id) WHERE unpacked_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_wh_box_items_pnum_open
    ON wh_box_items (productnumber) WHERE unpacked_at IS NULL;

CREATE TABLE IF NOT EXISTS wh_events (
    id            BIGSERIAL PRIMARY KEY,
    at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor         TEXT,                             -- «tg:123456 Іван» / «bms»
    kind          TEXT NOT NULL,                    -- box_create | pack | unpack | move | seal | open | check | box_delete | box_edit
    box_id        BIGINT,
    box_code      TEXT,
    product_id    INTEGER,
    productnumber TEXT,
    qty           INTEGER,
    details       JSONB
);
CREATE INDEX IF NOT EXISTS ix_wh_events_box ON wh_events (box_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_wh_events_product ON wh_events (product_id, at DESC);

-- Черга завдань з телефона (друк і правки товару). Принтер стоїть у локальній мережі крамниці (за
-- мостом на Windows-ПК), з хмари до нього шляху нема — тому Mini App кладе
-- завдання сюди, а агент друку в BMS (на Mac) забирає їх і друкує локально.
CREATE TABLE IF NOT EXISTS wh_print_jobs (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL,                     -- box_label | stickers | product_edit
    payload     JSONB NOT NULL,                    -- {code} | {product_ids:[..], copies, layout} | {product_id, fields}
    status      TEXT NOT NULL DEFAULT 'queued',    -- queued | printing | done | failed | cancelled
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at  TIMESTAMPTZ,
    agent       TEXT,                              -- хто друкує («bms@Mac»)
    finished_at TIMESTAMPTZ,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS ix_wh_print_jobs_status ON wh_print_jobs (status, created_at);
-- Пульс агента друку: коли BMS востаннє опитувала чергу (телефон показує «офлайн»).
CREATE TABLE IF NOT EXISTS wh_agents (
    agent    TEXT PRIMARY KEY,
    seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    printer  TEXT
);

-- Працівники складу (доступ до Mini App). Власники — з WAREHOUSE_TG_IDS (env),
-- решта — тут: працівник відкриває бота → «Попросити доступ» → рядок pending →
-- у BMS («Склад → Працівники») власник тисне «Дозволити». Без Railway і без
-- копіювання Telegram id руками.
CREATE TABLE IF NOT EXISTS wh_staff (
    tg_id        BIGINT PRIMARY KEY,
    name         TEXT,
    username     TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',   -- pending | active | blocked
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at  TIMESTAMPTZ,
    approved_by  TEXT,
    last_seen_at TIMESTAMPTZ,
    note         TEXT
);
