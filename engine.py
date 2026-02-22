import json
import ollama
import re

CALIBRATION_ANCHORS = {
    # Electronics
    "laptop": 320,
    "keyboard": 450,
    "mouse": 120,
    "cell phone": 75,
    "monitor": 600,
    "tv": 1200,
    "tablet": 240,
    "remote": 180,
    "headphones": 180,
    "speaker": 150,
    "printer": 400,
    "router": 250,
    # Furniture
    "chair": 500,
    "couch": 1800,
    "sofa": 1800,
    "bed": 1400,
    "desk": 1200,
    "table": 1200,
    "door": 900,
    "window": 1000,
    "refrigerator": 700,
    "microwave": 500,
    "oven": 600,
    "sink": 600,
    "toilet": 380,
    # People & Body
    "person": 450,
    "face": 160,
    # Food & Kitchen
    "bottle": 75,
    "cup": 90,
    "wine glass": 80,
    "bowl": 160,
    "banana": 200,
    "apple": 80,
    "orange": 85,
    "sandwich": 150,
    "pizza": 300,
    "cake": 250,
    "fork": 190,
    "knife": 200,
    "spoon": 170,
    "plate": 260,
    # Office
    "book": 210,
    "scissors": 180,
    "vase": 120,
    "clock": 300,
    "pen": 15,
    "backpack": 350,
    "handbag": 300,
    "suitcase": 500,
    # Vehicles
    "car": 1800,
    "truck": 2500,
    "bus": 2500,
    "motorcycle": 800,
    "bicycle": 1000,
    "airplane": 35000,
    "boat": 5000,
    "train": 3000,
    # Sports
    "sports ball": 220,
    "baseball bat": 70,
    "tennis racket": 290,
    "skateboard": 800,
    "surfboard": 1800,
    "frisbee": 270,
    # Animals
    "cat": 450,
    "dog": 500,
    "bird": 200,
    "horse": 1500,
    "cow": 1800,
    "elephant": 4000,
    # Construction (relevant to hackathon theme)
    "hard hat": 300,
    "fire hydrant": 450,
    "stop sign": 750,
    "bench": 1500,
    "traffic light": 300,
}


def _extract_dimensions(content):
    """Parse width/height/depth in mm from model output."""
    defaults = {"width_mm": 400, "height_mm": 400, "depth_mm": 400}

    if not content:
        return defaults

    # Try JSON object first.
    start = content.find("{")
    end = content.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(content[start : end + 1])
            width = int(float(parsed.get("width", parsed.get("width_mm", defaults["width_mm"]))))
            height = int(float(parsed.get("height", parsed.get("height_mm", defaults["height_mm"]))))
            depth = int(float(parsed.get("depth", parsed.get("depth_mm", defaults["depth_mm"]))))
            return {
                "width_mm": max(width, 1),
                "height_mm": max(height, 1),
                "depth_mm": max(depth, 1),
            }
        except Exception:
            pass

    # Fallback: extract first 3 numbers in order.
    nums = re.findall(r"\d+(?:\.\d+)?", content)
    if len(nums) >= 3:
        width, height, depth = [max(int(float(n)), 1) for n in nums[:3]]
        return {"width_mm": width, "height_mm": height, "depth_mm": depth}

    return defaults


def get_object_dimensions(label):
    """Uses LLM to estimate real-world dimensions (mm) of a detected object."""
    prompt = (
        f"Provide average dimensions in millimeters for a standard {label}. "
        'Return only a JSON object like {"width": 0, "height": 0, "depth": 0} '
        "with integer values and no extra text."
    )

    try:
        response = ollama.chat(
            model="llama3",
            messages=[{"role": "user", "content": prompt}],
        )
        content = response["message"]["content"]
        return _extract_dimensions(content)
    except Exception as e:
        print(f"LLM Error: {e}")
        return {"width_mm": 400, "height_mm": 400, "depth_mm": 400}


def calculate_distance(pixel_width, real_width, focal_length):
    """The math behind monocular depth estimation."""
    if pixel_width == 0:
        return 0
    return (real_width * focal_length) / pixel_width


def calculate_focal_length(pixel_width, real_width_mm, distance_mm):
    """F = (P × D) / W"""
    if pixel_width == 0:
        return 0
    return (pixel_width * distance_mm) / real_width_mm
