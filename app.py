from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from PIL import Image, ImageOps
from ultralytics import YOLO

from engine import CALIBRATION_ANCHORS, calculate_distance, calculate_focal_length, get_object_dimensions

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
CALIBRATION_DISTANCE_MM = 304.8
CALIBRATION_CONFIDENCE_THRESHOLD = 0.55
CALIBRATION_REAL_WIDTH_MIN_MM = 30.0
CALIBRATION_REAL_WIDTH_MAX_MM = 5000.0
CALIBRATION_FOCAL_MIN = 50.0
CALIBRATION_FOCAL_MAX = 10000.0
LARGE_SCENE_OBJECTS = {
    "bed",
    "couch",
    "sofa",
    "dining table",
    "table",
    "desk",
    "chair",
    "tv",
    "refrigerator",
}

app = FastAPI(title="SemaDepth API")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@lru_cache(maxsize=1)
def load_model() -> YOLO:
    return YOLO(str(BASE_DIR / "yolov8l.pt"))


def _read_image(upload_bytes: bytes) -> np.ndarray:
    raw = Image.open(BytesIO(upload_bytes))
    image = ImageOps.exif_transpose(raw).convert("RGB")
    return np.array(image)


class DimensionsRequest(BaseModel):
    label: str = Field(min_length=1)


class MeasureRequest(BaseModel):
    pixel_width: float = Field(gt=0)
    real_width_mm: float = Field(gt=0)
    focal_constant: float = Field(gt=0)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/detect")
async def detect(image: UploadFile = File(...)) -> dict[str, Any]:
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Upload must be an image.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image file.")

    img_array = _read_image(image_bytes)
    results = load_model().predict(
        source=img_array,
        imgsz=1280,
        conf=0.3,
        augment=True,
        verbose=False,
    )
    result = results[0]

    detections: list[dict[str, Any]] = []
    for idx, box in enumerate(result.boxes):
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        class_id = int(box.cls[0].item())
        label = result.names[class_id]
        confidence = float(box.conf[0].item())
        bbox_width = float(x2 - x1)
        anchor_width_mm = CALIBRATION_ANCHORS.get(label.lower())
        detection = {
            "id": idx,
            "label": label,
            "class_id": class_id,
            "confidence": confidence,
            "anchor_width_mm": anchor_width_mm,
            "bbox": {
                "x1": float(x1),
                "y1": float(y1),
                "x2": float(x2),
                "y2": float(y2),
                "width": bbox_width,
                "height": float(y2 - y1),
            },
        }
        detections.append(detection)

    return {
        "image": {"width": int(img_array.shape[1]), "height": int(img_array.shape[0])},
        "detections": detections,
    }


@app.post("/calibrate")
async def calibrate(image: UploadFile = File(...)) -> dict[str, Any]:
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Upload must be an image.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image file.")

    img_array = _read_image(image_bytes)
    results = load_model().predict(
        source=img_array,
        imgsz=1280,
        conf=0.3,
        augment=True,
        verbose=False,
    )
    result = results[0]

    if len(result.boxes) == 0:
        raise HTTPException(status_code=400, detail="No object detected for calibration.")

    image_center_x = img_array.shape[1] / 2.0
    image_center_y = img_array.shape[0] / 2.0

    best_box = None
    best_score = None
    for box in result.boxes:
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        class_id = int(box.cls[0].item())
        label = result.names[class_id]
        confidence = float(box.conf[0].item())
        if confidence < CALIBRATION_CONFIDENCE_THRESHOLD:
            continue
        width = max(float(x2 - x1), 1.0)
        height = max(float(y2 - y1), 1.0)
        area = width * height
        center_x = (x1 + x2) / 2.0
        center_y = (y1 + y2) / 2.0

        dx = (center_x - image_center_x) / max(img_array.shape[1], 1)
        dy = (center_y - image_center_y) / max(img_array.shape[0], 1)
        center_distance = (dx**2 + dy**2) ** 0.5
        area_ratio = area / max(float(img_array.shape[0] * img_array.shape[1]), 1.0)
        # Prefer centered, medium-size targets. Penalize huge scene-level boxes.
        target_area_ratio = 0.12
        area_score = max(0.0, 1.0 - abs(area_ratio - target_area_ratio) / target_area_ratio)
        large_box_penalty = 0.0
        anchor_bonus = 0.12 if label.lower() in CALIBRATION_ANCHORS else 0.0
        if area_ratio > 0.45:
            large_box_penalty += 0.5
        if label.lower() in LARGE_SCENE_OBJECTS and area_ratio > 0.20:
            large_box_penalty += 0.3

        score = (
            (0.50 * (1.0 - center_distance))
            + (0.35 * area_score)
            + (0.15 * confidence)
            + anchor_bonus
            - large_box_penalty
        )
        if best_score is None or score > best_score:
            best_score = score
            best_box = box

    if best_box is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unable to select a reliable calibration object (confidence must be >= {CALIBRATION_CONFIDENCE_THRESHOLD:.2f}).",
        )

    x1, y1, x2, y2 = best_box.xyxy[0].tolist()
    class_id = int(best_box.cls[0].item())
    label = result.names[class_id]
    pixel_width = max(float(x2 - x1), 1.0)

    anchor_width_mm = CALIBRATION_ANCHORS.get(label.lower())
    if anchor_width_mm:
        real_width_mm = float(anchor_width_mm)
        width_source = "anchor"
    else:
        dims = get_object_dimensions(label)
        real_width_mm = float(dims["width_mm"])
        width_source = "llm"
    real_width_mm = max(CALIBRATION_REAL_WIDTH_MIN_MM, min(real_width_mm, CALIBRATION_REAL_WIDTH_MAX_MM))
    focal_constant = calculate_focal_length(
        pixel_width=pixel_width,
        real_width_mm=real_width_mm,
        distance_mm=CALIBRATION_DISTANCE_MM,
    )

    if focal_constant <= 0 or focal_constant < CALIBRATION_FOCAL_MIN or focal_constant > CALIBRATION_FOCAL_MAX:
        raise HTTPException(
            status_code=400,
            detail="Calibration failed. Focal constant out of valid range; retry with a clearer, centered object.",
        )

    return {
        "label": label,
        "focal_constant": float(focal_constant),
        "pixel_width": float(pixel_width),
        "real_width_mm": float(real_width_mm),
        "width_source": width_source,
        "distance_mm": float(CALIBRATION_DISTANCE_MM),
    }


@app.post("/dimensions")
def dimensions(payload: DimensionsRequest) -> dict[str, Any]:
    dims = get_object_dimensions(payload.label)
    return {
        "label": payload.label,
        "width_mm": int(dims["width_mm"]),
        "height_mm": int(dims["height_mm"]),
        "depth_mm": int(dims["depth_mm"]),
    }


@app.post("/measure")
def measure(payload: MeasureRequest) -> dict[str, float]:
    distance_mm = calculate_distance(
        pixel_width=payload.pixel_width,
        real_width=payload.real_width_mm,
        focal_length=payload.focal_constant,
    )
    return {
        "distance_mm": float(distance_mm),
        "distance_m": float(distance_mm / 1000.0),
    }
