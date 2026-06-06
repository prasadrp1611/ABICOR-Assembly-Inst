"""
Long-video chunking. Splits a long tutorial (e.g. 1 hour) into smaller time
windows so each part is fast and reliable to parse, then the per-part results
are merged back into one document with absolute timestamps + continuous numbering.
"""
import cv2


def get_duration(path: str) -> float:
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    n = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    cap.release()
    return (n / fps) if fps else 0.0


def sec_to_mmss(s: float) -> str:
    s = int(round(s))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def plan_chunks(duration_s: float, chunk_minutes: float) -> list:
    """Return [{index,start,end}] windows covering the whole video."""
    step = max(30.0, float(chunk_minutes) * 60.0)
    out, t, i = [], 0.0, 0
    while t < duration_s - 0.5:
        end = min(duration_s, t + step)
        out.append({"index": i, "start": t, "end": end})
        t, i = end, i + 1
    return out or [{"index": 0, "start": 0.0, "end": duration_s}]


def split_clip(src: str, out_path: str, start_s: float, end_s: float, max_w: int = 640):
    """Write a downscaled sub-clip [start_s, end_s] for fast analysis."""
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    scale = min(1.0, max_w / w) if w else 1.0
    ow, oh = max(2, int(w * scale)), max(2, int(h * scale))
    vw = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (ow, oh))
    cap.set(cv2.CAP_PROP_POS_MSEC, start_s * 1000)
    end_ms = end_s * 1000
    n = 0
    while True:
        ok, fr = cap.read()
        if not ok or cap.get(cv2.CAP_PROP_POS_MSEC) > end_ms:
            break
        if scale < 1.0:
            fr = cv2.resize(fr, (ow, oh))
        vw.write(fr)
        n += 1
    cap.release()
    vw.release()
    return out_path if n > 0 else None
