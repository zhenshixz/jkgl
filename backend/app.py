from __future__ import annotations

import os
import re
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
from fastapi.responses import JSONResponse


app = FastAPI(title="JKGL Local OCR", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


PACKAGE_RE = re.compile(r"([A-H]\s*)?套餐|CT\s*平扫|胃肠镜|彩超|肺部\s*CT", re.I)
NOISE_RE = re.compile(r"健康体检|套餐信息|检查项目详情|返回|立即预约|修改|微信|5G|^\d{1,2}:\d{2}", re.I)
AUDIENCE_RE = re.compile(r"适用男性|适用女性|不限性别|男性|女性")
CATEGORY_NAMES = [
    "一般检查",
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


def is_noise(text: str) -> bool:
    compact = clean_text(text)
    return not compact or bool(NOISE_RE.search(compact))


def normalize_package_name(text: str) -> str:
    text = clean_text(text)
    text = re.sub(r"^[<>、.·\-\s]+", "", text)
    text = re.sub(r"[￥¥Yy]\d{2,5}.*$", "", text)
    text = text.replace("（", "(").replace("）", ")")
    return text


def read_image(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="无法读取图片，请换一张截图。")
    return image


def preprocess_for_ocr(path: Path) -> Path:
    image = read_image(path)
    height, width = image.shape[:2]

    max_side = max(height, width)
    if max_side < 1800:
        scale = 1800 / max_side
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


@lru_cache(maxsize=1)
def get_ocr_engine() -> Any:
    from paddleocr import PaddleOCR

    # PaddleOCR 3.7 defaults to PP-OCRv6 medium for the general OCR pipeline.
    try:
        return PaddleOCR(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    except TypeError:
        return PaddleOCR(use_angle_cls=False, lang="ch", show_log=False)


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


def run_paddle_ocr(path: Path) -> list[OcrLine]:
    engine = get_ocr_engine()
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
    for category in CATEGORY_NAMES:
        if category in compact and len(compact) <= max(12, len(category) + 3):
            return category
    return ""


def extract_detail_items(lines: list[OcrLine], image_width: int) -> list[dict[str, Any]]:
    ordered = sorted(lines, key=lambda item: (item.y1, item.x1))
    mid_x = image_width * 0.47
    items: list[dict[str, Any]] = []
    category = "未分类"

    for index, line in enumerate(ordered):
        category_name = is_category(line.text)
        if category_name:
            category = category_name
            continue

        price = parse_price(line.text)
        if not price:
            continue

        same_band = [item for item in ordered if abs(item.cy - line.cy) <= 26 and item is not line]
        left_texts = [
            item.text for item in same_band
            if item.cx < mid_x and not parse_price(item.text) and not is_category(item.text)
        ]
        right_texts = [
            item.text for item in same_band
            if item.cx >= mid_x and not parse_price(item.text) and not is_category(item.text)
        ]

        previous_left = []
        for prev in reversed(ordered[:index]):
            if line.cy - prev.cy > 70:
                break
            if prev.cx < mid_x and not parse_price(prev.text) and not is_category(prev.text):
                previous_left.append(prev.text)

        inline_name = re.sub(r"[￥¥Yy]\s*\d{2,5}|\d{2,5}\s*元?", "", line.text).strip()
        name = clean_text("".join(left_texts) or "".join(reversed(previous_left[:2])) or inline_name)
        note = "；".join(clean_text(text) for text in right_texts if clean_text(text))

        if not name or len(name) < 2 or is_noise(name):
            continue
        if any(existing["name"] == name and existing["price"] == price for existing in items):
            continue

        items.append({
            "category": category,
            "name": name,
            "price": price,
            "note": note,
            "source": "PaddleOCR截图",
            "reviewStatus": "pending",
        })

    return items


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"ok": "true", "engine": "PaddleOCR"}


@app.post("/api/ocr")
async def ocr(file: UploadFile = File(...), mode: str = Form("list")) -> JSONResponse:
    if mode not in {"list", "detail"}:
        raise HTTPException(status_code=400, detail="mode 必须是 list 或 detail")

    suffix = Path(file.filename or "image.png").suffix or ".png"
    temp_path = Path(tempfile.gettempdir()) / f"jkgl_upload_{uuid.uuid4().hex}{suffix}"
    prepared_path: Path | None = None
    try:
        content = await file.read()
        temp_path.write_bytes(content)
        prepared_path = preprocess_for_ocr(temp_path)
        prepared_image = read_image(prepared_path)
        _, prepared_width = prepared_image.shape[:2]
        lines = run_paddle_ocr(prepared_path)
        raw_text = raw_text_from_lines(lines)
        payload: dict[str, Any] = {
            "mode": mode,
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
    uvicorn.run("app:app", host="127.0.0.1", port=port, reload=False)
