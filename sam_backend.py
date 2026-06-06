"""
Real SAM (Segment Anything) via HuggingFace transformers.

The multimodal engine localises a part (bounding box); SAM turns that box prompt
into a pixel-accurate mask. Optional — if torch/transformers are not installed,
`available()` is False and the app falls back to box highlighting.

First use downloads the model weights (facebook/sam-vit-base, ~375 MB).
"""
from functools import lru_cache

MODEL_ID = "facebook/sam-vit-base"

_model = None
_proc = None


def available() -> bool:
    try:
        import torch          # noqa: F401
        import transformers   # noqa: F401
        return True
    except Exception:
        return False


def _load():
    global _model, _proc
    if _model is None:
        import torch
        from transformers import SamModel, SamProcessor
        _proc = SamProcessor.from_pretrained(MODEL_ID)
        _model = SamModel.from_pretrained(MODEL_ID)
        _model.eval()
        torch.set_num_threads(max(1, (torch.get_num_threads() or 4)))
    return _model, _proc


def segment(image_path: str, boxes_xyxy: list):
    """boxes_xyxy: list of [x1,y1,x2,y2] in pixels. Returns list of bool masks (HxW)."""
    if not boxes_xyxy:
        return []
    import torch
    import numpy as np
    from PIL import Image

    model, proc = _load()
    img = Image.open(image_path).convert("RGB")
    boxes = [[float(v) for v in b] for b in boxes_xyxy]
    inputs = proc(img, input_boxes=[boxes], return_tensors="pt")
    with torch.no_grad():
        out = model(**inputs)
    masks = proc.image_processor.post_process_masks(
        out.pred_masks.cpu(),
        inputs["original_sizes"].cpu(),
        inputs["reshaped_input_sizes"].cpu(),
    )[0]                                  # tensor [n_boxes, n_masks(3), H, W]
    scores = out.iou_scores[0].cpu()      # [n_boxes, n_masks]
    result = []
    for i in range(masks.shape[0]):
        best = int(scores[i].argmax())
        result.append(masks[i, best].numpy().astype(bool))
    return result


def warmup():
    """Pre-load weights so the first request isn't slow."""
    try:
        _load()
        return True
    except Exception:
        return False
