import sys
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from fastapi import HTTPException

from app import OcrLine, extract_detail_items, extract_package_list, normalize_data_payload, parse_item_price


def line(text, x1, y1, x2, y2, confidence=0.99):
    return OcrLine(text=text, confidence=confidence, x1=x1, y1=y1, x2=x2, y2=y2)


class OcrParsingTests(unittest.TestCase):
    def test_data_payload_normalization_keeps_main_tables_safe(self):
        payload = normalize_data_payload({"packages": [{"name": "A套餐"}]})

        self.assertEqual(payload["packages"], [{"name": "A套餐"}])
        self.assertEqual(payload["members"], [])
        self.assertEqual(payload["plans"], [])

    def test_data_payload_rejects_non_array_main_tables(self):
        with self.assertRaises(HTTPException):
            normalize_data_payload({"packages": {"name": "A套餐"}, "members": [], "plans": []})

    def test_package_list_extracts_name_audience_and_price(self):
        lines = [
            line("C套餐(大众版)-男性", 100, 100, 400, 130),
            line("适用男性", 110, 145, 210, 170),
            line("￥1619", 460, 145, 560, 170),
            line("立即预约", 700, 145, 820, 170),
        ]

        packages = extract_package_list(lines)

        self.assertEqual(len(packages), 1)
        self.assertEqual(packages[0]["name"], "C套餐(大众版)-男性")
        self.assertEqual(packages[0]["audience"], "男性")
        self.assertEqual(packages[0]["price"], 1619)

    def test_detail_items_keep_name_note_price_and_category(self):
        lines = [
            line("检验科", 120, 10, 220, 35),
            line("甲胎蛋白(AFP)", 130, 115, 330, 140),
            line("(化学发光法)", 155, 142, 310, 166),
            line("肝癌风险评估及早期筛查", 450, 118, 850, 145),
            line("￥34", 250, 175, 310, 200),
        ]

        items = extract_detail_items(lines, image_width=1000)

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["category"], "检验科")
        self.assertEqual(items[0]["name"], "甲胎蛋白(AFP)(化学发光法)")
        self.assertEqual(items[0]["price"], 34)
        self.assertEqual(items[0]["note"], "肝癌风险评估及早期筛查")

    def test_price_parser_does_not_treat_marker_numbers_as_prices(self):
        self.assertIsNone(parse_item_price("CA199(化学发光法)"))
        self.assertIsNone(parse_item_price("游离T3(FT3)"))
        self.assertEqual(parse_item_price("¥50"), 50)
        self.assertEqual(parse_item_price("50"), 50)


if __name__ == "__main__":
    unittest.main()
