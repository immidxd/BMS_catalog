"""«Замовити» з кількома розмірами: позиції в «Замовленнях» і розбір листа.

Без Google і без БД: писар працює з підставним аркушем у пам'яті (структура — як у
живому документі: колонки за назвою, блок «В ЧЕРЗІ» нижче замовлень).

    ../react-fastapi-app/venv/bin/pytest -q backend/tests/test_order_sizes.py
"""
import re
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import orders_sheet as osh  # noqa: E402

HEADER = ["Номера товарів", "Клієнт", "Telegram", "Контактний номер", "Ціна", "Уточнення",
          "Статус відповіді", "Коментарі", "Дата замовлення"]


class _Sheet:
    title = "17.10.2026"

    def __init__(self):
        blank = [""] * len(HEADER)
        self.rows = [HEADER[:], ["Ф9", "Олена", "", "", "100", "", "ㅤ", "", "2026-10-17"],
                     blank[:], blank[:], blank[:],
                     ["", "", "", "", "", "", "В ЧЕРЗІ", "", ""]]
        self.writes = 0

    def get_all_values(self):
        return [r[:] for r in self.rows]

    def batch_update(self, updates, value_input_option=None):
        self.writes += 1
        for u in updates:
            m = re.match(r"([A-Z]+)(\d+)$", u["range"])
            col = 0
            for ch in m.group(1):
                col = col * 26 + ord(ch) - 64
            self.rows[int(m.group(2)) - 1][col - 1] = u["values"][0][0]


@pytest.fixture
def sheet(monkeypatch):
    ws = _Sheet()
    book = types.SimpleNamespace(worksheets=lambda: [ws])
    monkeypatch.setattr(osh, "_client", lambda: types.SimpleNamespace(open_by_key=lambda _id: book))
    monkeypatch.setattr(osh, "enabled", lambda: True)
    monkeypatch.setattr(osh.time, "sleep", lambda _s: None)
    monkeypatch.setattr(osh, "_today", lambda: "2026-10-17")
    monkeypatch.setenv("ORDERS_SPREADSHEET_ID", "test")
    return ws


def _cell(ws, row, header):
    return ws.rows[row - 1][HEADER.index(header)]


def test_two_sizes_of_one_number_are_two_positions(sheet):
    placed = osh.record_intent([("#Ф1", 1600.0, "39 EU"), ("#Ф1", 1600.0, "40 EU")])
    assert placed == ("17.10.2026", 3)
    assert _cell(sheet, 3, "Номера товарів") == "Ф1; Ф1;"
    assert _cell(sheet, 3, "Ціна") == "1600; 1600;"       # «Сума» рахує обидві пари
    assert _cell(sheet, 3, "Уточнення") == "Ф1 (39); Ф1 (40);"
    assert _cell(sheet, 3, "Статус відповіді") == osh.INTENT_STATUS


def test_next_click_appends_new_sizes_and_skips_repeats(sheet):
    first = osh.record_intent([("#Ф1", 1600.0, "39 EU"), ("#Ф1", 1600.0, "40 EU")])
    osh.record_intent([("#Ф1", 1600.0, "39 EU"), ("#Ф1-2", 1600.0, "41 EU")], previous=first)
    assert _cell(sheet, 3, "Номера товарів") == "Ф1; Ф1; Ф1-2;"
    assert _cell(sheet, 3, "Уточнення") == "Ф1 (39); Ф1 (40); Ф1-2 (41);"
    writes = sheet.writes
    assert osh.record_intent([("#Ф1", 1600.0, "40 EU")], previous=first) == first
    assert sheet.writes == writes                         # повтор — без запису


def test_business_message_items():
    tgb = pytest.importorskip("tg_business")
    one = "Доброго дня! Цікавить товар:\n\nBadura 8108 — #Ф4535\nРозмір: 41 EU\nЦіна: 1 600 грн"
    assert tgb._order_items(one, "#Ф4535") == [("#Ф4535", "41 EU")]
    same = "Badura 8108 — #Ф4535\nРозміри: 39 EU, 40 EU\nЦіна: 2 × 1 600 грн"
    assert tgb._order_items(same, "#Ф4535") == [("#Ф4535", "39 EU"), ("#Ф4535", "40 EU")]
    mixed = "Rieker Y9131-15\nРозміри: 38 EU (#Ф4535), 39 EU (#Ф4535-2)\nЦіна: 2 × 1 950 грн"
    assert tgb._order_items(mixed, "#Ф4535") == [("#Ф4535", "38 EU"), ("#Ф4535-2", "39 EU")]
    cm = "Дитячі — #Д12\nРозміри: 25,5-26 см, 27 см"
    assert tgb._order_items(cm, "#Д12") == [("#Д12", "25,5-26 см"), ("#Д12", "27 см")]
    assert tgb._order_items("Сумка — #С1\nЦіна: 900 грн", "#С1") == [("#С1", None)]
    # Розміри з різною ціною: ціна (і номер) у дужках не потрапляють у розмір
    priced = "UGG Jella — #Ф4046\nРозміри: 40 EU (1 290 грн), 41 EU (#Ф4046-2, 1 100 грн)\nРазом: 2 390 грн"
    assert tgb._order_items(priced, "#Ф4046") == [("#Ф4046", "40 EU"), ("#Ф4046-2", "41 EU")]


def test_click_items_are_sanitized():
    analytics = pytest.importorskip("analytics")
    meta = {"items": [{"pn": "#Ф1", "size": "39 EU"}, {"pn": "#Ф1-2", "size": "40 EU"},
                      {"pn": "#Ф;1", "size": "x"}, {"pn": "#" + "Ф" * 90}, "сміття"]}
    assert analytics._order_items(meta, "#Ф1", None) == [("#Ф1", "39 EU"), ("#Ф1-2", "40 EU")]
    assert analytics._order_items({}, "#Ф1", "38 EU") == [("#Ф1", "38 EU")]
