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
app.dependency_overrides[warehouse.require_staff] = lambda: "bms"
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

# ── Історія: скасувати / повернути ─────────────────────────────────────────
def ev(**f):
    d = database.SessionLocal()
    try:
        conds = " AND ".join(f"{k} = :{k}" for k in f) or "TRUE"
        return [dict(r) for r in d.execute(text(f"SELECT id, kind, box_code, qty, undo_of, undone_by FROM wh_events WHERE {conds} ORDER BY id"), f).mappings().all()]
    finally: d.close()

c.post("/api/wh/boxes", json={"code": "H1", "category": "H"})
c.post("/api/wh/boxes", json={"code": "H2", "category": "H"})
# T1 має 1 шт товару 5 (з тесту вище), T2 — 1 шт → вийняти все з T1/T2, щоб почати чисто
c.post("/api/wh/unpack", json={"product_id": 5})
r = c.post("/api/wh/boxes/H1/pack", json={"product_id": 5, "qty": 1}); assert r.status_code == 200
pack_ev = ev(kind="pack", box_code="H1")[-1]
# список: подія недавня, undoable, не скасована
lst = c.get("/api/wh/events?box=H1").json()["events"]; top = lst[0]
assert top["id"] == pack_ev["id"] and top["undoable"] and not top["undone"]
# скасувати pack → unpack-обернення; товар зник з H1
r = c.post(f"/api/wh/events/{pack_ev['id']}/undo"); assert r.status_code == 200, r.text
assert qty("H1") == 0
lst = c.get("/api/wh/events?box=H1").json()["events"]
orig = next(e for e in lst if e["id"] == pack_ev["id"]); assert orig["undone"] and not orig["undoable"]
undo_ev = next(e for e in lst if e["undo_of"] == pack_ev["id"]); assert undo_ev["kind"] == "unpack"
# повторне скасування того ж — відмова
assert c.post(f"/api/wh/events/{pack_ev['id']}/undo").status_code == 409
# повернути = скасувати обернення → товар знову в H1, оригінал більше не «скасований»
r = c.post(f"/api/wh/events/{undo_ev['id']}/undo"); assert r.status_code == 200, r.text
assert qty("H1") == 1
lst = c.get("/api/wh/events?box=H1").json()["events"]
orig = next(e for e in lst if e["id"] == pack_ev["id"]); assert not orig["undone"]
# move: H1 → H2, скасувати → назад у H1
r = c.post("/api/wh/boxes/H2/pack", json={"product_id": 5, "qty": 1, "move": True}); assert r.status_code == 200
mv = ev(kind="move", box_code="H2")[-1]
assert c.post(f"/api/wh/events/{mv['id']}/undo").status_code == 200
assert qty("H1") == 1 and qty("H2") == 0
# seal → undo → open
c.post("/api/wh/boxes/H1/seal"); se = ev(kind="seal", box_code="H1")[-1]
assert c.post(f"/api/wh/events/{se['id']}/undo").status_code == 200
assert c.get("/api/wh/boxes/H1").json()["status"] == "open"
# правка назви зберігає prev і відкочується
c.patch("/api/wh/boxes/H1", json={"title": "Нова назва"}); ed = ev(kind="box_edit", box_code="H1")[-1]
assert c.post(f"/api/wh/events/{ed['id']}/undo").status_code == 200
assert c.get("/api/wh/boxes/H1").json()["title"] is None
# видалення з вмістом → відновлення разом із вмістом
r = c.delete("/api/wh/boxes/H1?force=true"); assert r.status_code == 200
de = ev(kind="box_delete", box_code="H1")[-1]
assert qty("H1") == 0
assert c.post(f"/api/wh/events/{de['id']}/undo").status_code == 200
b = c.get("/api/wh/boxes/H1").json(); assert b["status"] == "open" and b["needs_check"] and qty("H1") == 1
# не-модератор не може
app.dependency_overrides[warehouse.require_staff] = lambda: "tg:999 Працівник"
assert c.post(f"/api/wh/events/{pack_ev['id']}/undo").status_code == 403
print("історія: OK")
