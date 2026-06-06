"""
Part highlighter — "SAM-like" localization. The multimodal engine returns
bounding boxes for the named components in a step frame; we draw highlight
overlays + labels onto the image.
"""
import json
from pathlib import Path
from typing import List

import cv2
from google.genai import types

import config

# magenta-ish overlay palette (BGR for OpenCV)
PALETTE = [(111, 0, 193), (193, 89, 0), (0, 157, 31), (18, 143, 243),
           (192, 57, 43), (155, 89, 182)]


def detect_parts(client, image_path: str, labels: List[str]) -> list:
    """Return [{label, box:[ymin,xmin,ymax,xmax] in 0-1000}] for visible parts."""
    if not labels:
        return []
    with open(image_path, "rb") as fh:
        img = fh.read()
    wanted = "; ".join(sorted(set(labels)))
    prompt = (
        "Detect the following assembly parts in this image, if visible: " + wanted +
        ". Return a JSON array; each item {\"label\":\"<the part>\","
        "\"box\":[ymin,xmin,ymax,xmax]} with integer coordinates normalised to 0-1000. "
        "Only include parts that are actually visible. No duplicates."
    )
    resp = client.models.generate_content(
        model=config.MODEL,
        contents=[types.Part.from_bytes(data=img, mime_type="image/jpeg"), prompt],
        config=types.GenerateContentConfig(
            temperature=config.TEMPERATURE, seed=config.SEED,
            response_mime_type="application/json"),
    )
    t = resp.text
    if "```json" in t: t = t.split("```json")[1].split("```")[0].strip()
    elif "```" in t:   t = t.split("```")[1].split("```")[0].strip()
    try:
        data = json.loads(t)
    except Exception:
        return []
    if isinstance(data, dict):
        data = data.get("detections") or data.get("parts") or []
    out = []
    for d in data:
        box = d.get("box") or d.get("box_2d")
        if box and len(box) == 4:
            out.append({"label": d.get("label", "part"), "box": [int(x) for x in box]})
    return out


def annotate(image_path: str, detections: list, out_path: str) -> dict:
    img = cv2.imread(image_path)
    if img is None:
        return {"ok": False, "detections": []}
    h, w = img.shape[:2]
    overlay = img.copy()
    drawn = []
    for i, d in enumerate(detections):
        ymin, xmin, ymax, xmax = d["box"]
        x1, y1 = int(xmin / 1000 * w), int(ymin / 1000 * h)
        x2, y2 = int(xmax / 1000 * w), int(ymax / 1000 * h)
        if x2 <= x1 or y2 <= y1:
            continue
        color = PALETTE[i % len(PALETTE)]
        cv2.rectangle(overlay, (x1, y1), (x2, y2), color, -1)          # fill (for blend)
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 3)               # solid border
        label = d["label"]
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        cv2.rectangle(img, (x1, max(0, y1 - th - 8)), (x1 + tw + 8, y1), color, -1)
        cv2.putText(img, label, (x1 + 4, max(12, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
        drawn.append(d["label"])
    cv2.addWeighted(overlay, 0.22, img, 0.78, 0, img)                  # translucent fills
    cv2.imwrite(out_path, img)
    return {"ok": True, "detections": drawn}
