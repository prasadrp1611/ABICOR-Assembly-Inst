"""
Part highlighter. Two selectable modes:
  - "box":  the multimodal engine returns bounding boxes -> drawn as labelled boxes.
  - "mask": the engine returns true segmentation masks -> drawn as pixel-accurate
            translucent overlays with contour outlines.
OpenCV does the rendering in both cases.
"""
import base64
import json
from typing import List

import cv2
import numpy as np
from google.genai import types

import config

# BGR palette (OpenCV)
PALETTE = [(111, 0, 193), (193, 89, 0), (0, 157, 31), (18, 143, 243),
           (192, 57, 43), (155, 89, 182), (40, 180, 200)]


def _parse_json(text: str):
    t = text
    if "```json" in t: t = t.split("```json")[1].split("```")[0].strip()
    elif "```" in t:   t = t.split("```")[1].split("```")[0].strip()
    try:
        data = json.loads(t)
    except Exception:
        return []
    if isinstance(data, dict):
        data = data.get("detections") or data.get("parts") or data.get("objects") or []
    return data if isinstance(data, list) else []


# ----------------------------------------------------------------- BOX mode
def detect_parts(client, image_path: str, labels: List[str]) -> list:
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
    out = []
    for d in _parse_json(resp.text):
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
        lw = max(3, int(round(w / 500)))      # bolder outline on high-res / printed frames
        cv2.rectangle(overlay, (x1, y1), (x2, y2), color, -1)
        cv2.rectangle(img, (x1, y1), (x2, y2), color, lw)
        _label(img, d.get("label", "part"), x1, y1, color)
        drawn.append(d.get("label", "part"))
    cv2.addWeighted(overlay, 0.22, img, 0.78, 0, img)
    cv2.imwrite(out_path, img)
    return {"ok": True, "detections": drawn, "mode": "box"}


# ----------------------------------------------------------------- MASK mode
def detect_masks(client, image_path: str, labels: List[str]) -> list:
    if not labels:
        return []
    with open(image_path, "rb") as fh:
        img = fh.read()
    wanted = "; ".join(sorted(set(labels)))
    prompt = (
        "Give the segmentation masks for these assembly parts in the image, if visible: "
        + wanted + ". Output a JSON list where each entry contains the 2D bounding box "
        "in the key \"box_2d\" as [ymin,xmin,ymax,xmax] normalised to 0-1000, the "
        "segmentation mask in the key \"mask\" as a base64 PNG, and the text label in "
        "the key \"label\". Only include parts that are actually visible."
    )
    resp = client.models.generate_content(
        model=config.MODEL,
        contents=[types.Part.from_bytes(data=img, mime_type="image/jpeg"), prompt],
        config=types.GenerateContentConfig(
            temperature=config.TEMPERATURE, seed=config.SEED,
            response_mime_type="application/json"),
    )
    out = []
    for d in _parse_json(resp.text):
        box = d.get("box_2d") or d.get("box")
        mask = d.get("mask")
        if box and len(box) == 4 and mask:
            out.append({"label": d.get("label", "part"),
                        "box": [int(x) for x in box], "mask": mask})
    return out


def _decode_mask(b64: str):
    s = b64.split(",", 1)[1] if "," in b64 else b64
    try:
        raw = base64.b64decode(s)
    except Exception:
        return None
    m = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
    return m


def annotate_masks(image_path: str, items: list, out_path: str) -> dict:
    img = cv2.imread(image_path)
    if img is None:
        return {"ok": False, "detections": []}
    H, W = img.shape[:2]
    overlay = img.copy()
    outlines = []          # (contours_shifted, color, label, x1, y1)
    drawn = []
    for i, it in enumerate(items):
        ymin, xmin, ymax, xmax = it["box"]
        x1, y1 = int(xmin / 1000 * W), int(ymin / 1000 * H)
        x2, y2 = int(xmax / 1000 * W), int(ymax / 1000 * H)
        if x2 <= x1 or y2 <= y1:
            continue
        m = _decode_mask(it["mask"])
        if m is None:
            continue
        m = cv2.resize(m, (x2 - x1, y2 - y1), interpolation=cv2.INTER_LINEAR)
        binary = (m > 127).astype(np.uint8)
        if binary.sum() == 0:
            continue
        color = PALETTE[i % len(PALETTE)]
        region = overlay[y1:y2, x1:x2]
        region[binary.astype(bool)] = color
        cont, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        shifted = [c + np.array([[x1, y1]]) for c in cont]
        outlines.append((shifted, color, it.get("label", "part"), x1, y1))
        drawn.append(it.get("label", "part"))

    cv2.addWeighted(overlay, 0.45, img, 0.55, 0, img)     # translucent masks
    for shifted, color, label, x1, y1 in outlines:        # crisp outlines + labels
        cv2.drawContours(img, shifted, -1, color, 2, cv2.LINE_AA)
        _label(img, label, x1, y1, color)
    cv2.imwrite(out_path, img)
    return {"ok": True, "detections": drawn, "mode": "mask"}


def _label(img, text, x1, y1, color):
    # Labels get printed and read by people who may not have great eyesight, so
    # the text scales with the image and sits on a high-contrast plate.
    H, W = img.shape[:2]
    scale = max(0.9, min(2.2, W / 1000.0))
    thick = max(2, int(round(scale * 2)))
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)
    pad = int(8 * scale)
    yt = max(th + 2 * pad, y1)                         # keep the plate on-canvas
    xl = max(0, min(x1, W - tw - 2 * pad - 1))
    cv2.rectangle(img, (xl, yt - th - 2 * pad), (xl + tw + 2 * pad, yt), color, -1)
    cv2.rectangle(img, (xl, yt - th - 2 * pad), (xl + tw + 2 * pad, yt), (30, 30, 30),
                  max(1, thick // 2))                  # dark keyline for contrast
    org = (xl + pad, yt - pad)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0),
                thick + 2, cv2.LINE_AA)                # black underlay …
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255),
                thick, cv2.LINE_AA)                    # … then white text


# ----------------------------------------------------------------- SAM mode
def annotate_sam(image_path: str, detections: list, out_path: str) -> dict:
    """Use engine boxes as SAM prompts -> precise masks -> render."""
    import sam_backend
    img = cv2.imread(image_path)
    if img is None:
        return {"ok": False, "detections": []}
    H, W = img.shape[:2]
    boxes_px, kept = [], []
    for d in detections:
        ymin, xmin, ymax, xmax = d["box"]
        x1, y1 = int(xmin / 1000 * W), int(ymin / 1000 * H)
        x2, y2 = int(xmax / 1000 * W), int(ymax / 1000 * H)
        if x2 > x1 and y2 > y1:
            boxes_px.append([x1, y1, x2, y2]); kept.append(d)
    if not boxes_px:
        return {"ok": True, "detections": [], "mode": "sam"}

    masks = sam_backend.segment(image_path, boxes_px)
    overlay = img.copy()
    outlines, drawn = [], []
    for i, (d, m) in enumerate(zip(kept, masks)):
        if m is None or m.sum() == 0:
            continue
        binm = m.astype(np.uint8)
        color = PALETTE[i % len(PALETTE)]
        overlay[binm.astype(bool)] = color
        cont, _ = cv2.findContours(binm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        x1, y1 = boxes_px[i][0], boxes_px[i][1]
        outlines.append((cont, color, d.get("label", "part"), x1, y1))
        drawn.append(d.get("label", "part"))

    cv2.addWeighted(overlay, 0.45, img, 0.55, 0, img)
    for cont, color, label, x1, y1 in outlines:
        cv2.drawContours(img, cont, -1, color, 2, cv2.LINE_AA)
        _label(img, label, x1, y1, color)
    cv2.imwrite(out_path, img)
    return {"ok": True, "detections": drawn, "mode": "sam"}


# ----------------------------------------------------------------- unified
def highlight(client, image_path: str, labels: List[str], mode: str, out_path: str) -> dict:
    if mode == "sam":
        try:
            import sam_backend
            if sam_backend.available():
                dets = detect_parts(client, image_path, labels)   # engine localises
                if dets:
                    res = annotate_sam(image_path, dets, out_path)  # SAM segments
                    if res.get("detections"):
                        return res
        except Exception:
            pass  # fall through to boxes
    dets = detect_parts(client, image_path, labels)
    return annotate(image_path, dets, out_path)
