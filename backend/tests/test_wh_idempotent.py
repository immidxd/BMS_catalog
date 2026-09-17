"""Ідемпотентність дій складу: повтор pack з тим самим op_id не подвоює qty."""
"""Запуск лише з окремою ТЕСТОВОЮ базою (у назві має бути «test»):

    BMS_WH_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bms_wh_test \
        venv/bin/python backend/tests/test_wh_idempotent.py

Ніколи не давати сюди Neon чи bsstorage: скрипт створює таблиці-заглушки.
"""
import os, sys, uuid, pathlib
_url = os.environ.get("BMS_WH_TEST_DATABASE_URL", "")
if not _url or "test" not in _url.lower():
    print("пропущено: потрібен BMS_WH_TEST_DATABASE_URL із «test» у назві бази"); sys.exit(0)
os.environ["DATABASE_URL"] = _url
os.environ.pop("CLOUD_DATABASE_URL", None)
_root = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_root / "backend")); sys.path.insert(0, str(_root))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
import database, warehouse

db = database.SessionLocal()
# Мінімальні заглушки таблиць дзеркала — рівно ті, що читає _PRODUCT_SQL/_box_summary_sql.
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
warehouse.ensure_warehouse_schema(db); db.close()

app = FastAPI(); app.include_router(warehouse.router)
app.dependency_overrides[warehouse.require_staff] = lambda: "test"
fake = {"id": 5, "productnumber": "#Ф1", "number": "Ф1", "size": "40", "color": "чорний", "available_qty": 1,
        "quantity": 1, "sold_count": 0, "price": 100, "oldprice": None, "brand": "X", "model": None, "type": None,
        "gender": None, "season": None, "condition": None, "insole": "", "image": None}
c = TestClient(app)

def qty(code):
    d = database.SessionLocal()
    try:
        return d.execute(text("SELECT COALESCE(SUM(i.qty),0) FROM wh_box_items i JOIN wh_boxes b ON b.id=i.box_id WHERE b.code=:c AND i.unpacked_at IS NULL"), {"c": code}).scalar()
    finally: d.close()

op = str(uuid.uuid4())
r = c.post("/api/wh/boxes", json={"code": "T1", "category": "T", "op_id": op}); assert r.status_code == 201, r.text
r2 = c.post("/api/wh/boxes", json={"code": "T1", "category": "T", "op_id": op}); assert r2.status_code == 201 and r2.json()["code"] == "T1", r2.text   # повтор → той самий результат, не 409
r3 = c.post("/api/wh/boxes", json={"code": "T1", "category": "T"}); assert r3.status_code == 409   # без op_id — справжній конфлікт

op = str(uuid.uuid4())
r = c.post("/api/wh/boxes/T1/pack", json={"product_id": 5, "qty": 2, "op_id": op}); assert r.status_code == 200, r.text
assert qty("T1") == 2
r = c.post("/api/wh/boxes/T1/pack", json={"product_id": 5, "qty": 2, "op_id": op}); assert r.status_code == 200 and r.json()["ok"]
assert qty("T1") == 2, qty("T1")          # повтор НЕ подвоїв
r = c.post("/api/wh/boxes/T1/pack", json={"product_id": 5, "qty": 1}); assert r.status_code == 200
assert qty("T1") == 3                      # без op_id — звичайне додавання

op = str(uuid.uuid4())
r = c.post("/api/wh/boxes/T1/unpack", json={"product_id": 5, "qty": 1, "op_id": op}); assert r.status_code == 200
r = c.post("/api/wh/boxes/T1/unpack", json={"product_id": 5, "qty": 1, "op_id": op}); assert r.status_code == 200
assert qty("T1") == 2, qty("T1")          # повтор unpack не вийняв двічі

op = str(uuid.uuid4())
r = c.post(f"/api/wh/boxes/T1/seal?op_id={op}"); assert r.status_code == 200 and r.json()["status"] == "sealed"
r = c.post(f"/api/wh/boxes/T1/seal?op_id={op}"); assert r.status_code == 200
# 409 elsewhere НЕ запамʼятовується: після відмови повтор із тим самим op_id працює
c.post("/api/wh/boxes", json={"code": "T2", "category": "T"})
op = str(uuid.uuid4())
r = c.post("/api/wh/boxes/T2/pack", json={"product_id": 5, "qty": 1, "op_id": op}); assert r.status_code == 409 and r.json()["detail"]["code"] == "elsewhere"
r = c.post("/api/wh/boxes/T2/pack", json={"product_id": 5, "qty": 1, "move": True, "op_id": op}); assert r.status_code == 200, r.text
assert qty("T2") == 1 and qty("T1") == 1
print("ідемпотентність: OK")
