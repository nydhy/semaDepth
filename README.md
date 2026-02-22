<img width="668" height="360" alt="Screenshot 2026-02-22 at 6 32 10 AM" src="https://github.com/user-attachments/assets/13e6fde0-e46e-4ea0-adef-96225b7c129a" />

# SemaDepth

SemaDepth is a monocular distance-estimation web app built with YOLOv8, FastAPI, and a custom cyberpunk-style frontend.

It combines:
- object detection (YOLOv8l)
- guided one-photo calibration per session
- triangle similarity for distance estimation
- optional semantic object dimensions via Ollama (`llama3`)

## Features

- Guided calibration flow before first measurement
- Interactive object click-to-measure workflow
- Confidence-aware target selection
- Anchor-object priors for more stable estimates
- Meter/feet unit toggle
- Session log with object, confidence, focal constant, and distance

## How It Works

### 1) Session Calibration
- User uploads a calibration photo with an object held approximately 1 foot away (about forearm length).
- YOLO detects objects in the calibration image.
- Backend selects a prominent/centered calibration target.
- Real width source:
  - anchor table width if class is known
  - otherwise LLM-estimated width
- Focal constant is computed and stored for the current session.

### 2) Measurement
- User uploads a scene image.
- YOLO detects bounding boxes.
- User clicks an object to measure distance.
- Distance is computed using triangle similarity with the calibrated focal constant.

## Core Math

- Focal length estimate:
  - `F = (P * D) / W`
  - `P`: pixel width in calibration image
  - `D`: calibration distance (`304.8 mm`)
  - `W`: real-world width in mm

- Distance estimate:
  - `D = (W_real * F) / W_pixel`

## Tech Stack

- Backend: FastAPI, Ultralytics YOLOv8, NumPy, Pillow
- Semantic dimensions: Ollama (`llama3`)
- Frontend: HTML, CSS, JavaScript (no framework)

## Project Structure

- `app.py` - FastAPI app and API routes
- `engine.py` - dimension lookup, anchor priors, and math helpers
- `main.py` - ASGI entrypoint alias
- `static/index.html` - frontend markup
- `static/styles.css` - frontend styling
- `static/app.js` - frontend logic and API integration

## API Endpoints

- `POST /calibrate`
  - Upload calibration image
  - Returns focal constant + calibration metadata

- `POST /detect`
  - Upload scene image
  - Returns detections (`label`, `confidence`, `bbox`, optional anchor width)

- `POST /measure`
  - Input: `pixel_width`, `real_width_mm`, `focal_constant`
  - Output: `distance_mm`, `distance_m`

- `POST /dimensions`
  - Input: object `label`
  - Output: semantic dimensions in mm

## Local Setup

### Prerequisites
- Python 3.9+
- Ollama running locally
- `llama3` model pulled in Ollama
- `yolov8l.pt` present in the project root

### Install dependencies
Install with your preferred environment manager. Required packages include:
- `fastapi`
- `uvicorn`
- `ultralytics`
- `numpy`
- `pillow`
- `python-multipart`
- `ollama`

### Run
```bash
cd semaDepth
uvicorn main:app --reload
```

Open: `http://127.0.0.1:8000`

## Notes on Accuracy

SemaDepth provides practical monocular estimates and works best when:
- calibration image is clear and well-framed
- calibration object has a reliable known width
- measured object has a high-confidence, tight bounding box

Accuracy can degrade with occlusion, perspective distortion, weak detections, or uncertain semantic dimensions.

## Roadmap

- Calibration profile persistence (per device/camera)
- Improved calibration target guidance and validation
- Uncertainty scoring per measurement
- Better dimension priors for non-anchor classes
- Optional temporal smoothing across repeated frames
