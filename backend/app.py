from __future__ import annotations

import os
import re
import json
import tempfile
import uuid
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles


CACHE_HOME = Path(__file__).resolve().parent / ".paddle-home"
CACHE_HOME.mkdir(parents=True, exist_ok=True)
os.environ["HOME"] = str(CACHE_HOME)
os.environ["USERPROFILE"] = str(CACHE_HOME)
os.environ.setdefault("XDG_CACHE_HOME", str(CACHE_HOME / ".cache"))
os.environ.setdefault("PADDLE_HOME", str(CACHE_HOME / ".cache" / "paddle"))
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(CACHE_HOME / ".paddlex"))
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("FLAGS_enable_pir_api", "0")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "False")

app = FastAPI(title="JKGL Local OCR", version="1.0.0")


@app.middleware("http")
async def disable_frontend_asset_cache(request: Any, call_next: Any) -> Response:
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith(("/js/", "/assets/")):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


REPORT_UPLOAD_DIR = Path(__file__).resolve().parent / "uploads" / "reports"
REPORT_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/vendor", StaticFiles(directory=Path(__file__).resolve().parent.parent / "vendor"), name="vendor")
app.mount("/assets", StaticFiles(directory=Path(__file__).resolve().parent.parent / "assets"), name="assets")
app.mount("/js", StaticFiles(directory=Path(__file__).resolve().parent.parent / "js"), name="js")
app.mount("/uploads", StaticFiles(directory=Path(__file__).resolve().parent / "uploads"), name="uploads")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


PACKAGE_RE = re.compile(r"([A-H]\s*)?套餐|CT\s*平扫|胃肠镜|彩超|肺部\s*CT", re.I)
NOISE_RE = re.compile(
    r"健康体检|套餐信息|检查项目详情|返回|立即预约|修改|微信|5G|^\d{1,2}:\d{2}|"
    r"检查意义|项目说明|检查内容|单项价格|说明/备注|备注/说明|项目分类|科室分类|检查科室|科室栏|单价",
    re.I
)
AUDIENCE_RE = re.compile(r"适用男性|适用女性|不限性别|男性|女性")
CATEGORY_NAMES = [
    "一般检查",
    "一般项目",
    "身高体重",
    "登记",
    "科室",
    "检验科",
    "放射科",
    "彩超室",
    "超声科",
    "心电图室",
    "功能科",
    "内科",
    "外科",
    "眼科",
    "耳鼻喉科",
    "口腔科",
    "妇科",
    "男科",
]


@dataclass
class OcrLine:
    text: str
    confidence: float
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) / 2

    @property
    def cy(self) -> float:
        return (self.y1 + self.y2) / 2

    @property
    def width(self) -> float:
        return self.x2 - self.x1


def clean_text(text: str) -> str:
    return re.sub(r"\s+", "", str(text or "")).strip()


def parse_price(text: str) -> int:
    source = str(text or "").replace(",", "")
    currency = re.search(r"[￥¥Yy]\s*(\d{2,5})", source)
    if currency:
        return int(currency.group(1))

    values = []
    for match in re.finditer(r"(?<!\d)(\d{2,5})(?:元)?(?!\d)", source):
        value = int(match.group(1))
        if 20 <= value <= 50000:
            values.append(value)
    return values[-1] if values else 0


def parse_item_price(text: str) -> float | int | None:
    source = str(text or "").replace(",", "").strip()
    
    # 1. First try currency prefix search (avoid matching letters in words like FT3)
    currency = re.search(r"[￥¥]\s*(\d{1,5}(?:\.\d{1,2})?)", source)
    if not currency:
        currency = re.search(r"(?:^|[\s:：])[YyVvFfTt*xX]\s*(\d{1,5}(?:\.\d{1,2})?)", source)
    if currency:
        try:
            val = float(currency.group(1))
            return int(val) if val.is_integer() else val
        except ValueError:
            pass

    # 2. If it's a clean standalone price line, match it exactly
    clean_source = source.strip(".-_ /")
    standalone = re.fullmatch(r"(\d{1,5}(?:\.\d{1,2})?)\s*(?:元)?", clean_source)
    if standalone:
        try:
            val = float(standalone.group(1))
            return int(val) if val.is_integer() else val
        except ValueError:
            pass
            
    return None



def is_noise(text: str) -> bool:
    compact = clean_text(text)
    return not compact or bool(NOISE_RE.search(compact))


def clean_parentheses(text: str) -> str:
    text = text.replace("（", "(").replace("）", ")")
    text = text.replace("［", "[").replace("］", "]")
    text = text.replace("【", "[").replace("】", "]")
    text = text.replace("〔", "(").replace("〕", ")")
    
    text = re.sub(r"\(\s*\)", "", text)
    text = re.sub(r"\[\s*\]", "", text)
    
    text = re.sub(r"\(\s*$", "", text)
    text = re.sub(r"\[\s*$", "", text)
    
    open_count = text.count("(")
    close_count = text.count(")")
    if open_count > close_count:
        text += ")" * (open_count - close_count)
    elif close_count > open_count:
        if text.startswith(")"):
            text = text[1:]
        open_count = text.count("(")
        close_count = text.count(")")
        if close_count > open_count:
            text = "(" * (close_count - open_count) + text
    return text


def normalize_package_name(text: str) -> str:
    text = clean_text(text)
    text = re.sub(r"^[<>、.·\-\s]+", "", text)
    text = re.sub(r"[￥¥Yy]\d{2,5}.*$", "", text)
    text = clean_parentheses(text)
    return text


def read_image(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="无法读取图片，请换一张截图。")
    return image


def preprocess_for_ocr(path: Path, mode: str, quality: str) -> Path:
    image = read_image(path)
    height, width = image.shape[:2]



    # 针对手机长截图（宽高比大）进行特殊优化：按宽度缩放，防止按高度缩放导致文字变得极其微小而无法识别
    aspect_ratio = height / width
    if aspect_ratio >= 1.8:
        target_width = 1200 if quality == "accurate" else 1000
        if width > target_width:
            scale = target_width / width
            image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        elif width < 800:
            scale = 960 / width
            image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    else:
        # 普通图片按最大边进行缩放
        max_side = max(height, width)
        if mode == "detail":
            target_side = 1900
        elif quality == "accurate":
            target_side = 2200
        else:
            target_side = 1400 if mode == "list" else 1600
        if max_side > target_side:
            scale = target_side / max_side
            image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        elif max_side < 960:
            scale = 960 / max_side
            image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    # Keep color information for PaddleOCR, but improve phone screenshots a little.
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_channel = clahe.apply(l_channel)
    enhanced = cv2.merge((l_channel, a_channel, b_channel))
    image = cv2.cvtColor(enhanced, cv2.COLOR_LAB2BGR)

    out_path = Path(tempfile.gettempdir()) / f"jkgl_ocr_{uuid.uuid4().hex}.png"
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        return path
    encoded.tofile(str(out_path))
    return out_path


@lru_cache(maxsize=2)
def get_ocr_engine(quality: str = "fast") -> Any:
    from paddleocr import PaddleOCR

    try:
        return PaddleOCR(
            text_detection_model_name="PP-OCRv6_tiny_det",
            text_recognition_model_name="PP-OCRv6_tiny_rec",
            text_det_limit_side_len=960,
            text_det_limit_type="min",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    except TypeError:
        return PaddleOCR(use_angle_cls=False, lang="ch", show_log=False, text_det_limit_side_len=960, text_det_limit_type="min")


def to_list(value: Any) -> list:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        return value.tolist()
    return list(value)


def flatten_v2_result(result: Any) -> list[OcrLine]:
    rows: list[OcrLine] = []
    pages = result if isinstance(result, list) else [result]
    for page in pages:
        if not page:
            continue
        entries = page if isinstance(page, list) else [page]
        for item in entries:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            box, payload = item[0], item[1]
            if not payload:
                continue
            text = str(payload[0])
            confidence = float(payload[1]) if len(payload) > 1 else 0.0
            points = np.array(box, dtype=float)
            x1, y1 = float(points[:, 0].min()), float(points[:, 1].min())
            x2, y2 = float(points[:, 0].max()), float(points[:, 1].max())
            if not is_noise(text):
                rows.append(OcrLine(text, confidence, x1, y1, x2, y2))
    return rows


def run_paddle_ocr(path: Path, quality: str) -> list[OcrLine]:
    engine = get_ocr_engine(quality)
    if hasattr(engine, "predict"):
        result = engine.predict(str(path))
        lines: list[OcrLine] = []
        for res in result:
            payload = getattr(res, "json", None) or res
            if isinstance(payload, dict) and "res" in payload:
                payload = payload["res"]
            if not isinstance(payload, dict):
                continue

            texts = payload.get("rec_texts") or []
            scores = to_list(payload.get("rec_scores"))
            boxes = to_list(payload.get("rec_boxes")) or to_list(payload.get("rec_polys")) or to_list(payload.get("dt_polys"))
            for index, text in enumerate(texts):
                if is_noise(text):
                    continue
                box = boxes[index] if index < len(boxes) else [0, 0, 0, 0]
                arr = np.array(box, dtype=float)
                if arr.ndim == 1 and arr.size >= 4:
                    x1, y1, x2, y2 = [float(value) for value in arr[:4]]
                elif arr.ndim >= 2:
                    x1, y1 = float(arr[:, 0].min()), float(arr[:, 1].min())
                    x2, y2 = float(arr[:, 0].max()), float(arr[:, 1].max())
                else:
                    x1 = y1 = x2 = y2 = 0
                confidence = float(scores[index]) if index < len(scores) else 0.0
                lines.append(OcrLine(str(text), confidence, x1, y1, x2, y2))
        return sorted(lines, key=lambda item: (item.y1, item.x1))

    result = engine.ocr(str(path), cls=False)
    return sorted(flatten_v2_result(result), key=lambda item: (item.y1, item.x1))


def raw_text_from_lines(lines: list[OcrLine]) -> str:
    return "\n".join(line.text for line in sorted(lines, key=lambda item: (item.y1, item.x1)))


def extract_package_list(lines: list[OcrLine]) -> list[dict[str, Any]]:
    candidates = [
        line for line in lines
        if PACKAGE_RE.search(clean_text(line.text)) and not is_noise(line.text)
    ]
    candidates.sort(key=lambda item: item.cy)

    packages: list[dict[str, Any]] = []
    seen = set()
    for index, candidate in enumerate(candidates):
        row_top = candidate.cy - 40
        row_bottom = candidates[index + 1].cy - 20 if index + 1 < len(candidates) else candidate.cy + 190
        bucket = [line for line in lines if row_top <= line.cy <= row_bottom]
        bucket_text = " ".join(line.text for line in bucket)
        price = parse_price(bucket_text)
        audience_match = AUDIENCE_RE.search(clean_text(bucket_text))
        name = normalize_package_name(candidate.text)
        if len(name) < 4 or name in seen:
            continue
        seen.add(name)
        packages.append({
            "name": name,
            "audience": audience_match.group(0) if audience_match else "",
            "price": price,
            "source": "PaddleOCR截图",
            "reviewStatus": "pending",
        })
    return packages


def is_category(text: str) -> str:
    compact = clean_text(text)
    
    # 模糊别名匹配，映射至标准科室名称
    if "眼底" in compact and ("照" in compact or "室" in compact):
        return "眼科"
    if "耳鼻喉" in compact:
        return "耳鼻喉科"
        
    for category in CATEGORY_NAMES:
        if category in compact and len(compact) <= max(12, len(category) + 3):
            # 如果匹配到的科室分类名称（如"眼科"、"内科"）后面跟了"普检"、"项目"等字眼，说明它是具体的项目名称而非科室标题
            if category in {"内科", "外科", "眼科", "耳鼻喉科", "口腔科", "妇科", "男科", "科室"} and any(k in compact for k in ["普检", "项目", "功能", "筛查"]):
                continue
            return category
    return ""


def normalize_exam_item_name(text: str) -> str:
    # 先在保留空格的原始文本中过滤价格，避免误删 CA199/GP73 中的数字
    text = re.sub(r"[￥¥Yy]\s*\d+", "", text)
    text = re.sub(r"\d+\s*元", "", text)
    text = re.sub(r"\s+\d+$", "", text)
    
    compact = clean_text(text)
    compact = re.sub(r"^[<>\-、.·]+", "", compact)
    # 不再移除“(厦禾)”等分院名称后缀，保留在项目名称中以便用户识别
    compact = compact.strip("；;，,、")
    compact = clean_parentheses(compact)
    return compact


def is_fragment_name(text: str) -> bool:
    compact = clean_text(text)
    if len(compact) <= 1:
        return True
    if re.fullmatch(r"[（(]?(?:化|化学|学发光法|化学发光法|发光法)[）)]?", compact):
        return True
    if re.fullmatch(r"[）)〕】]*[法术项]?([（(](?:厦禾|夏禾|厦未|夏未)[）)])?", compact):
        return True
    if compact in {"厦禾", "夏禾", "厦未", "夏未", "法", "项"}:
        return True
    return False


def is_same_item_column(candidate: OcrLine, price_line: OcrLine, image_width: int) -> bool:
    # 划分左右两列：左列项目名称及价格一般在图片宽度的 32% 以内
    if candidate.x1 < image_width * 0.32:
        return True

    compact = clean_text(candidate.text)
    if not compact:
        return False

    # 某些 OCR 会把项目名中的括号后缀切到偏右位置，例如：
    #   癌胚抗原（CEA)
    #   (化
    #   学发光法)
    # 这类短后缀应继续并入项目名，而不是被当成备注或遗漏项目。
    if candidate.x1 >= image_width * 0.5:
        return False
    near_price_column = candidate.cx <= price_line.cx + image_width * 0.2
    looks_like_name_suffix = (
        len(compact) <= 16
        and (
            compact.startswith(("(", "（"))
            or compact.endswith((")", "）"))
            or "发光法" in compact
            or "化学" in compact
            or compact in {"化", "(化", "（化"}
        )
    )
    return near_price_column and looks_like_name_suffix


def extract_detail_items(lines: list[OcrLine], image_width: int) -> list[dict[str, Any]]:
    ordered = sorted(lines, key=lambda item: (item.y1, item.x1))
    price_lines = [l for l in ordered if parse_item_price(l.text) is not None]

    def is_category_header(l: OcrLine) -> str:
        cat = is_category(l.text)
        if not cat:
            return ""
        # 核心结构判定：项目名称下方必定紧贴其单项价格（通常在 -15px 到 100px 之间）。
        # 而真正的科室分类栏（灰底）距离下一个项目的价格通常远大于 100px，且其前一个项目的价格在上方（距离远超 -15px）。
        # 此逻辑完美适配高分屏，既能捞回“耳鼻喉科”这样的拉伸行，又绝对不会误伤“外科”、“内科”等真正的科室栏。
        if any(-15 <= p.cy - l.cy <= 100 for p in price_lines):
            return ""
        return cat

    items: list[dict[str, Any]] = []
    category = "未分类"
    used_lines = set()

    for index, line in enumerate(ordered):
        category_name = is_category_header(line)
        if category_name:
            category = category_name
            continue

        price = parse_item_price(line.text)
        if price is None:
            continue

        same_band = [item for item in ordered if abs(item.cy - line.cy) <= 26 and item is not line]
        name_texts_lines = [
            item for item in same_band
            if is_same_item_column(item, line, image_width)
            and parse_item_price(item.text) is None and not is_category_header(item)
        ]

        previous_name_parts_lines = []
        for prev in reversed(ordered[:index]):
            if parse_item_price(prev.text) is not None:
                break
            if is_same_item_column(prev, line, image_width) and not is_category_header(prev):
                lowest_cy_so_far = previous_name_parts_lines[-1].cy if previous_name_parts_lines else line.cy
                gap = lowest_cy_so_far - prev.cy
                line_height = max(prev.y2 - prev.y1, 10)
                
                # Dynamic Left-Right Structure strict boundary constraint
                # If the gap between lines is greater than 1.8x line height, it's a completely different item.
                # If checking distance from the price to the first name line, allow up to 3.5x line height.
                threshold = line_height * 3.5 if not previous_name_parts_lines else line_height * 1.8
                
                if gap > threshold:
                    break
                previous_name_parts_lines.append(prev)

        all_name_lines = name_texts_lines + previous_name_parts_lines
        # Group lines that are on the same horizontal row (cy difference <= 15) and sort them by x1 coordinate
        rows_list = []
        for item in sorted(all_name_lines, key=lambda x: x.cy):
            placed = False
            for row in rows_list:
                if abs(row[0].cy - item.cy) <= 15:
                    row.append(item)
                    placed = True
                    break
            if not placed:
                rows_list.append([item])
        for row in rows_list:
            row.sort(key=lambda x: x.x1)
        rows_list.sort(key=lambda r: sum(x.cy for x in r) / len(r))
        all_name_lines = []
        for row in rows_list:
            all_name_lines.extend(row)
            
        name_raw = "".join(item.text for item in all_name_lines) if all_name_lines else ""

        inline_name = re.sub(r"[￥¥Yy]\s*\d+|\d+\s*元|\s+\d+$", "", line.text).strip()
        name = normalize_exam_item_name(name_raw or inline_name)

        item_lines = all_name_lines + [line]
        item_line_ids = {id(item) for item in item_lines}
        min_y = min(item.y1 for item in item_lines)
        max_y = max(item.y2 for item in item_lines)

        right_column_lines = [
            item for item in ordered
            if id(item) not in item_line_ids
            and item.x1 >= image_width * 0.32
            and parse_item_price(item.text) is None
            and not is_category_header(item)
            and min_y - 12 <= item.cy <= max_y + 15
        ]
        right_column_lines.sort(key=lambda x: x.y1)
        note = "".join(clean_text(item.text) for item in right_column_lines if clean_text(item.text))

        if not name or len(name) < 2 or is_noise(name) or is_fragment_name(name):
            continue
        if any(existing["name"] == name and existing["price"] == price for existing in items):
            continue

        used_lines.update(id(l) for l in item_lines + right_column_lines)

        items.append({
            "category": category,
            "name": name,
            "price": price,
            "note": note,
            "source": "PaddleOCR截图",
            "reviewStatus": "pending",
            "_cy": min_y
        })

    # === Fallback Pass: Salvage independent items whose prices were completely missed ===
    orphan_lines = [
        l for l in ordered
        if id(l) not in used_lines
        and l.x1 < image_width * 0.35
        and not is_category_header(l)
        and parse_item_price(l.text) is None
    ]

    orphan_items = []
    current_orphan = []
    for l in sorted(orphan_lines, key=lambda x: x.cy):
        if not current_orphan:
            current_orphan.append(l)
        else:
            prev = current_orphan[-1]
            gap = l.cy - prev.cy
            line_height = max(prev.y2 - prev.y1, 10)
            if gap <= line_height * 1.8:
                current_orphan.append(l)
            else:
                orphan_items.append(current_orphan)
                current_orphan = [l]
    if current_orphan:
        orphan_items.append(current_orphan)

    for orphan_group in orphan_items:
        rows_list = []
        for item in sorted(orphan_group, key=lambda x: x.cy):
            placed = False
            for row in rows_list:
                if abs(row[0].cy - item.cy) <= 15:
                    row.append(item)
                    placed = True
                    break
            if not placed:
                rows_list.append([item])
        for row in rows_list:
            row.sort(key=lambda x: x.x1)
        rows_list.sort(key=lambda r: sum(x.cy for x in r) / len(r))
        all_name_lines = []
        for row in rows_list:
            all_name_lines.extend(row)
            
        name_raw = "".join(item.text for item in all_name_lines) if all_name_lines else ""
        name = normalize_exam_item_name(name_raw)

        if not name or len(name) < 2 or is_noise(name) or is_fragment_name(name):
            continue
        if any(existing["name"] == name for existing in items):
            continue

        min_y = min(item.y1 for item in orphan_group)
        max_y = max(item.y2 for item in orphan_group)
        
        right_column_lines = [
            item for item in ordered
            if item.x1 >= image_width * 0.32
            and parse_item_price(item.text) is None
            and not is_category_header(item)
            and min_y - 12 <= item.cy <= max_y + 15
        ]
        right_column_lines.sort(key=lambda x: x.y1)
        note = "".join(clean_text(item.text) for item in right_column_lines if clean_text(item.text))
        
        cat_for_orphan = "未分类"
        avg_cy = sum(item.cy for item in orphan_group) / len(orphan_group)
        cat_lines = [l for l in ordered if is_category_header(l) and l.cy < avg_cy]
        if cat_lines:
            cat_for_orphan = is_category_header(cat_lines[-1]) or "未分类"

        items.append({
            "category": cat_for_orphan,
            "name": name,
            "price": 0,
            "note": note,
            "source": "遗漏恢复",
            "reviewStatus": "pending",
            "_cy": min_y
        })

    items.sort(key=lambda x: x.get("_cy", 0))
    for item in items:
        item.pop("_cy", None)

    return items


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"ok": "true", "engine": "PaddleOCR"}


DATA_FILE_PATH = Path(__file__).resolve().parent / "data.json"
DATA_BACKUP_PATH = Path(__file__).resolve().parent / "data.backup.json"
EMPTY_DATA: dict[str, list[Any]] = {
    "packages": [],
    "members": [],
    "plans": [],
    "dailyRecords": [],
    "dailyMonthRecords": [],
}


def normalize_data_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="数据格式必须是 JSON 对象。")

    normalized = dict(payload)
    for key in ["packages", "members", "plans", "dailyRecords", "dailyMonthRecords"]:
        value = normalized.get(key, [])
        if value is None:
            value = []
        if not isinstance(value, list):
            raise HTTPException(status_code=400, detail=f"{key} 必须是数组。")
        normalized[key] = value
    return normalized


def write_json_with_backup(path: Path, payload: dict[str, Any]) -> None:
    if path.exists():
        DATA_BACKUP_PATH.write_bytes(path.read_bytes())

    tmp_path = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    try:
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


@app.get("/api/data")
def get_data() -> dict[str, Any]:
    if DATA_FILE_PATH.exists():
        try:
            return normalize_data_payload(json.loads(DATA_FILE_PATH.read_text(encoding="utf-8")))
        except Exception:
            pass
    return dict(EMPTY_DATA)


@app.post("/api/data")
async def save_data(payload: dict[str, Any]) -> dict[str, str]:
    try:
        normalized = normalize_data_payload(payload)
        write_json_with_backup(DATA_FILE_PATH, normalized)
        return {"status": "ok"}
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    index_path = Path(__file__).resolve().parent.parent / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="index.html not found")
    headers = {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    }
    return HTMLResponse(index_path.read_text(encoding="utf-8"), headers=headers)


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> Response:
    return Response(status_code=204)


@app.post("/api/report-files")
async def upload_report_file(file: UploadFile = File(...)) -> dict[str, Any]:
    original_name = Path(file.filename or "report").name
    suffix = Path(original_name).suffix.lower()
    allowed_suffixes = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".pdf"}
    if suffix not in allowed_suffixes:
        raise HTTPException(status_code=400, detail="仅支持图片或 PDF 报告。")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空。")
    if len(content) > 30 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="报告文件不能超过 30MB。")

    stored_name = f"{uuid.uuid4().hex}{suffix}"
    target = REPORT_UPLOAD_DIR / stored_name
    target.write_bytes(content)
    return {
        "id": uuid.uuid4().hex,
        "name": original_name,
        "storedName": stored_name,
        "type": file.content_type or ("application/pdf" if suffix == ".pdf" else "image"),
        "size": len(content),
        "url": f"/uploads/reports/{stored_name}",
    }


@app.post("/api/ocr")
async def ocr(
    file: UploadFile = File(...),
    mode: str = Form("list"),
    quality: str = Form("fast"),
) -> JSONResponse:
    if mode not in {"list", "detail"}:
        raise HTTPException(status_code=400, detail="mode 必须是 list 或 detail")
    if quality not in {"fast", "accurate"}:
        raise HTTPException(status_code=400, detail="quality 必须是 fast 或 accurate")

    suffix = Path(file.filename or "image.png").suffix or ".png"
    temp_path = Path(tempfile.gettempdir()) / f"jkgl_upload_{uuid.uuid4().hex}{suffix}"
    prepared_path: Path | None = None
    try:
        content = await file.read()
        temp_path.write_bytes(content)
        prepared_path = preprocess_for_ocr(temp_path, mode, quality)
        prepared_image = read_image(prepared_path)
        _, prepared_width = prepared_image.shape[:2]
        lines = run_paddle_ocr(prepared_path, quality)
        raw_text = raw_text_from_lines(lines)
        payload: dict[str, Any] = {
            "mode": mode,
            "quality": quality,
            "engine": "PaddleOCR",
            "rawText": raw_text,
            "lines": [
                {
                    "text": item.text,
                    "confidence": item.confidence,
                    "box": [item.x1, item.y1, item.x2, item.y2],
                }
                for item in lines
            ],
        }

        if mode == "list":
            payload["packages"] = extract_package_list(lines)
        else:
            payload["items"] = extract_detail_items(lines, prepared_width)
            payload["detailPrice"] = parse_price(raw_text)

        return JSONResponse(payload)
    finally:
        for path in [temp_path, prepared_path]:
            if path and path.exists():
                try:
                    path.unlink()
                except OSError:
                    pass


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("JKGL_OCR_PORT", "8765"))
    uvicorn.run("app:app", host="localhost", port=port, reload=False)
