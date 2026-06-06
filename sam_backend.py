"""
Tiered SAM (Segment Anything) backend via HuggingFace transformers.

Preference order (config.SAM_PREFERENCE), first that loads wins:
  sam3 -> facebook/sam3                      (best, GATED: needs HF_TOKEN + license)
  sam2 -> facebook/sam2.1-hiera-base-plus    (open, Apache-2.0, small, fast)
  sam1 -> facebook/sam-vit-base              (open, universal fallback)

The engine localises a part (bounding box); SAM turns that box into a pixel
mask. If torch/transformers are missing, available() is False and the app falls
back to box highlighting — so it runs everywhere.
"""
import numpy as np

import config

_MODEL_IDS = {
    "sam3": "facebook/sam3",
    "sam2": "facebook/sam2.1-hiera-base-plus",
    "sam1": "facebook/sam-vit-base",
}
_state = {"kind": None, "model": None, "proc": None}


def available() -> bool:
    try:
        import torch          # noqa: F401
        import transformers   # noqa: F401
        return True
    except Exception:
        return False


def active_kind():
    return _state["kind"]


def _load_one(kind: str):
    import torch
    tok = config.hf_token()
    mid = _MODEL_IDS[kind]
    if kind == "sam1":
        from transformers import SamModel, SamProcessor
        proc = SamProcessor.from_pretrained(mid)
        model = SamModel.from_pretrained(mid)
    elif kind == "sam2":
        from transformers import Sam2Model, Sam2Processor
        proc = Sam2Processor.from_pretrained(mid)
        model = Sam2Model.from_pretrained(mid)
    elif kind == "sam3":
        # SAM 3's geometry/box-promptable head (gated)
        from transformers import Sam3TrackerModel, Sam3TrackerProcessor
        proc = Sam3TrackerProcessor.from_pretrained(mid, token=tok)
        model = Sam3TrackerModel.from_pretrained(mid, token=tok)
    else:
        raise ValueError(f"unknown SAM kind {kind}")
    model.eval()
    torch.set_num_threads(max(1, torch.get_num_threads() or 4))
    return model, proc


def load():
    """Load the first available backend per preference. Returns kind or None."""
    if _state["model"] is not None:
        return _state["kind"]
    for kind in config.SAM_PREFERENCE:
        if kind not in _MODEL_IDS:
            continue
        try:
            model, proc = _load_one(kind)
            _state.update(kind=kind, model=model, proc=proc)
            print(f"[SAM] active backend: {kind} ({_MODEL_IDS[kind]})")
            return kind
        except Exception as e:
            print(f"[SAM] {kind} unavailable -> {str(e)[:140]}")
    print("[SAM] no backend could be loaded; falling back to box mode")
    return None


def warmup():
    try:
        return load()
    except Exception:
        return None


def _best(masks, scores):
    out = []
    arr = np.array(masks)
    for i in range(arr.shape[0]):
        mi = arr[i]
        if mi.ndim == 3:                       # [n_masks, H, W] -> pick best
            best = 0
            if scores is not None:
                try:
                    best = int(np.array(scores)[i].argmax())
                except Exception:
                    best = 0
            mi = mi[best]
        out.append(mi.astype(bool))
    return out


def segment(image_path: str, boxes_xyxy: list):
    """boxes_xyxy: [[x1,y1,x2,y2], ...] in pixels. Returns list of bool masks."""
    if not boxes_xyxy:
        return []
    if load() is None:
        return []
    try:
        import torch
        from PIL import Image
        kind, model, proc = _state["kind"], _state["model"], _state["proc"]
        img = Image.open(image_path).convert("RGB")
        boxes = [[float(v) for v in b] for b in boxes_xyxy]

        if kind == "sam1":
            inputs = proc(img, input_boxes=[boxes], return_tensors="pt")
            with torch.no_grad():
                out = model(**inputs)
            masks = proc.image_processor.post_process_masks(
                out.pred_masks.cpu(), inputs["original_sizes"].cpu(),
                inputs["reshaped_input_sizes"].cpu())[0]
            scores = out.iou_scores[0].cpu()
            return _best(masks, scores)

        # sam2 / sam3
        inputs = proc(images=img, input_boxes=[boxes], return_tensors="pt")
        with torch.no_grad():
            out = model(**inputs)
        try:
            masks = proc.post_process_masks(out.pred_masks.cpu(),
                                            inputs["original_sizes"].cpu())[0]
        except Exception:
            masks = proc.image_processor.post_process_masks(
                out.pred_masks.cpu(), inputs["original_sizes"].cpu())[0]
        scores = getattr(out, "iou_scores", None)
        scores = scores[0].cpu() if scores is not None else None
        return _best(masks, scores)
    except Exception as e:
        print(f"[SAM] segment failed ({_state['kind']}): {str(e)[:140]}")
        return []
