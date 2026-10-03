"""Тиша для Neon: опитування агента друку й вкладки «Склад» НЕ ходять у БД.

Правило проєкту — не перевищувати безкоштовний ліміт Neon (див. CLAUDE.md,
backend/quiet_db.py). Тест рахує РЕАЛЬНІ SQL-запити до бази.

    BMS_WH_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bms_wh_test \
        venv/bin/python backend/tests/test_quiet_db.py

Ніколи не давати сюди Neon чи bsstorage: скрипт створює таблиці-заглушки.
"""
import os, sys, pathlib
_url = os.environ.get("BMS_WH_TEST_DATABASE_URL", "")
if not _url or "test" not in _url.lower():
    print("пропущено: потрібен BMS_WH_TEST_DATABASE_URL із «test» у назві бази"); sys.exit(0)
os.environ["DATABASE_URL"] = _url
os.environ.pop("CLOUD_DATABASE_URL", None)
_root = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_root / "backend")); sys.path.insert(0, str(_root))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event, text
import database, warehouse, quiet_db

db = database.SessionLocal()
db.execute(text("""
CREATE TABLE IF NOT EXISTS brands (id INT PRIMARY KEY, brandname TEXT);
CREATE TABLE IF NOT EXISTS types (id INT PRIMARY KEY, typename TEXT);
CREATE TABLE IF NOT EXISTS colors (id INT PRIMARY KEY, colorname TEXT);
CREATE TABLE IF NOT EXISTS genders (id INT PRIMARY KEY, gendername TEXT);
CREATE TABLE IF NOT EXISTS conditions (id INT PRIMARY KEY, conditionname TEXT);
CREATE TABLE IF NOT EXISTS orders (id INT PRIMARY KEY, order_status_id INT, payment_status_id INT);
CREATE TABLE IF NOT EXISTS order_items (id INT PRIMARY KEY, order_id INT, product_id INT);
CREATE TABLE IF NOT EXISTS products (id INT PRIMARY KEY, productnumber TEXT, model TEXT, price NUMERIC, oldprice NUMERIC,
  quantity INT, sizeeu TEXT, size_letter TEXT, sizeua TEXT, measurementscm TEXT, season TEXT, official_photos_from TEXT,
  brandid INT, typeid INT, colorid INT, genderid INT, current_conditionid INT, conditionid INT);
INSERT INTO products (id, productnumber, price, quantity, sizeeu) VALUES (5, '#Ф1', 100, 1, '40') ON CONFLICT DO NOTHING;
""")); db.commit()
warehouse.ensure_warehouse_schema(db)
db.execute(text("DELETE FROM wh_print_jobs")); db.execute(text("DELETE FROM wh_agents"))
db.execute(text("DELETE FROM wh_box_items WHERE box_id IN (SELECT id FROM wh_boxes WHERE code IN ('Q1','Q2'))"))
db.execute(text("DELETE FROM wh_events WHERE box_code IN ('Q1','Q2')"))
db.execute(text("DELETE FROM wh_boxes WHERE code IN ('Q1','Q2')")); db.commit(); db.close()

app = FastAPI(); app.include_router(warehouse.router)
app.middleware("http")(quiet_db.wh_cache_middleware)
app.dependency_overrides[warehouse.require_staff] = lambda: "bms"
c = TestClient(app)

queries = [0]
event.listen(database.engine, "before_cursor_execute", lambda *a, **k: queries.__setitem__(0, queries[0] + 1))

def sql_count(fn):
    queries[0] = 0
    r = fn()
    assert r.status_code < 400, r.text
    return queries[0], r.json()

poll = lambda: c.get("/api/wh/print-jobs", params={"status": "queued", "limit": 5})

# ── Черга друку ────────────────────────────────────────────────────────────
n, body = sql_count(poll); assert n > 0 and body["jobs"] == []          # перше опитування — у БД
for _ in range(20):                                                       # далі — тиша
    n, body = sql_count(poll); assert n == 0 and body["jobs"] == [], n
r = c.post("/api/wh/print-jobs", json={"kind": "stickers", "product_ids": [5]}); assert r.status_code == 201, r.text
job = r.json()["id"]
n, body = sql_count(poll); assert n > 0 and [j["id"] for j in body["jobs"]] == [job]   # нове завдання видно одразу
n, body = sql_count(poll); assert n > 0 and body["jobs"]                  # поки в черзі — щоразу з БД
assert c.post(f"/api/wh/print-jobs/{job}/claim").status_code == 200
assert c.post(f"/api/wh/print-jobs/{job}/done", json={"ok": True}).status_code == 200
n, body = sql_count(poll); assert n > 0 and body["jobs"] == []
n, body = sql_count(poll); assert n == 0 and body["jobs"] == []
# Гонка: БД сказала «порожньо», але завдання створили, поки запит ішов → не губимо
gen = quiet_db.queue_gen(); quiet_db.queue_changed(); quiet_db.queue_observed(True, gen)
assert not quiet_db.queue_known_empty()
print("черга друку: OK")

# ── Пульс агента ───────────────────────────────────────────────────────────
hb = lambda: c.post("/api/wh/print-agent/heartbeat", params={"agent": "bms", "printer": "10.0.0.5"})
n, _ = sql_count(hb); assert n > 0                                        # перший — у БД
for _ in range(10):
    n, _ = sql_count(hb); assert n == 0, n
n, _ = sql_count(lambda: c.post("/api/wh/print-agent/heartbeat", params={"agent": "bms"}))
assert n > 0                                                              # принтер зник — фіксуємо в БД
poll()                                                                    # відновити «порожньо» після POST-ів
n, st = sql_count(lambda: c.get("/api/wh/print-agent/status"))
assert n == 0 and st["online"] and st["agent"] == "bms" and st["queued"] == 0, (n, st)
print("пульс агента: OK")

# ── Кеш опитуваних GET-ів складу ───────────────────────────────────────────
c.post("/api/wh/boxes", json={"code": "Q1", "category": "Q"})
n, boxes = sql_count(lambda: c.get("/api/wh/boxes")); assert n > 0
n, again = sql_count(lambda: c.get("/api/wh/boxes")); assert n == 0 and again == boxes
n, _ = sql_count(lambda: c.get("/api/wh/events")); assert n > 0
n, _ = sql_count(lambda: c.get("/api/wh/events")); assert n == 0
assert c.post("/api/wh/boxes", json={"code": "Q2", "category": "Q"}).status_code == 201   # зміна складу
n, fresh = sql_count(lambda: c.get("/api/wh/boxes")); assert n > 0
assert {b["code"] for b in fresh["boxes"]} >= {"Q1", "Q2"}, fresh
n, _ = sql_count(lambda: c.get("/api/wh/boxes/next-code", params={"category": "Q"})); assert n > 0   # генератор не кешується
c.options("/api/wh/boxes", headers={"Origin": "https://web.telegram.org", "Access-Control-Request-Method": "GET"})
n, _ = sql_count(lambda: c.get("/api/wh/boxes")); assert n == 0, n           # preflight кеш не скидає
print("кеш складу: OK")
