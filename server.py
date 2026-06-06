"""
ABICOR Assembly-Doc — FastAPI server.

Endpoints:
  GET  /                              -> the web UI
  POST /api/jobs                      -> upload video (+ optional parts PDF), start job
  GET  /api/jobs                      -> list jobs
  GET  /api/jobs/{id}                 -> job status
  GET  /api/jobs/{id}/result          -> the assembly.json
  GET  /api/jobs/{id}/frames/{name}   -> a step frame image
  GET  /api/schema                    -> the JSON Schema contract
"""
import json, shutil, threading, time, uuid
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

import config
from schema import AssemblyDocument
from pipeline import process_job, write_status, ts_to_seconds, extract_frame
import docx_export
import vision
import sam_backend

app = FastAPI(title="ABICOR Assembly-Doc Generator")
STATIC = config.APP_DIR / "static"


@app.on_event("startup")
def _warm_sam():
    # pre-load SAM weights in the background so the first highlight isn't slow
    if sam_backend.available():
        threading.Thread(target=sam_backend.warmup, daemon=True).start()


def _run_job(job_id: str, options: dict):
    threading.Thread(target=process_job, args=(job_id, options), daemon=True).start()


@app.get("/", response_class=HTMLResponse)
def index():
    return (STATIC / "index.html").read_text(encoding="utf-8")


@app.get("/api/schema")
def get_schema():
    return AssemblyDocument.model_json_schema()


@app.get("/api/config")
def get_config():
    return {"configured": config.has_key()}


@app.post("/api/config")
def set_config(body: dict = Body(...)):
    key = (body.get("gemini_api_key") or "").strip()
    if not key:
        raise HTTPException(400, "Please paste an API key.")
    if not config.validate_key(key):
        raise HTTPException(400, "That key was rejected — check it and try again.")
    config.set_api_key(key)
    return {"ok": True, "configured": True}


@app.get("/api/capabilities")
def capabilities():
    return {"sam": sam_backend.available()}


@app.post("/api/jobs")
async def create_job(
    video: UploadFile = File(...),
    parts_pdf: UploadFile | None = File(None),
    product_name: str = Form(""),
    product_model: str = Form(""),
    product_id: str = Form(""),
    chunk_minutes: float = Form(0),
):
    if not config.has_key():
        raise HTTPException(400, "API key not configured. Open Settings and add your key.")
    job_id = uuid.uuid4().hex[:12]
    job_dir = config.JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # save the video
    video_name = Path(video.filename).name or "input.mp4"
    with open(job_dir / video_name, "wb") as f:
        shutil.copyfileobj(video.file, f)

    options = {
        "video_filename": video_name,
        "product_name": product_name.strip(),
        "product_model": product_model.strip(),
        "product_id": product_id.strip(),
        "chunk_minutes": chunk_minutes,
    }

    # optional parts PDF
    if parts_pdf is not None and parts_pdf.filename:
        parts_name = Path(parts_pdf.filename).name
        with open(job_dir / parts_name, "wb") as f:
            shutil.copyfileobj(parts_pdf.file, f)
        options["parts_filename"] = parts_name

    write_status(job_dir, id=job_id, status="queued", stage="queued",
                 progress=0, message="Queued…", created_at=time.time(),
                 video=video_name, has_parts=bool(options.get("parts_filename")),
                 options=options)
    _run_job(job_id, options)
    return {"job_id": job_id}


@app.get("/api/jobs")
def list_jobs():
    out = []
    for d in sorted(config.JOBS_DIR.iterdir(), reverse=True):
        sf = d / "status.json"
        if sf.exists():
            try:
                out.append(json.loads(sf.read_text(encoding="utf-8")))
            except Exception:
                pass
    return out


def _status(job_id: str) -> dict:
    sf = config.JOBS_DIR / job_id / "status.json"
    if not sf.exists():
        raise HTTPException(404, "job not found")
    return json.loads(sf.read_text(encoding="utf-8"))


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    return _status(job_id)


@app.get("/api/jobs/{job_id}/result")
def job_result(job_id: str):
    rf = config.JOBS_DIR / job_id / "assembly.json"
    if not rf.exists():
        raise HTTPException(404, "result not ready")
    return JSONResponse(json.loads(rf.read_text(encoding="utf-8")))


@app.get("/api/jobs/{job_id}/frames/{name}")
def job_frame(job_id: str, name: str):
    fp = config.JOBS_DIR / job_id / "frames" / Path(name).name
    if not fp.exists():
        raise HTTPException(404, "frame not found")
    return FileResponse(fp, media_type="image/jpeg")


# --------------------------------------------------------------- editor + export
@app.get("/editor", response_class=HTMLResponse)
def editor():
    return (STATIC / "editor.html").read_text(encoding="utf-8")


def _load_result(job_id: str) -> dict:
    rf = config.JOBS_DIR / job_id / "assembly.json"
    if not rf.exists():
        raise HTTPException(404, "result not ready")
    return json.loads(rf.read_text(encoding="utf-8"))


@app.get("/api/jobs/{job_id}/frame_options")
def frame_options(job_id: str, step: int, count: int = 4):
    """Extract several candidate frames spread across a step's time window."""
    data = _load_result(job_id)
    job_dir = config.JOBS_DIR / job_id
    video = job_dir / data["source"]["video_file"]
    frames_dir = job_dir / "frames"; frames_dir.mkdir(exist_ok=True)

    target = None
    for st in data["stations"]:
        for s in st["steps"]:
            if s["step_number"] == step:
                target = s
    if not target:
        raise HTTPException(404, "step not found")

    t0 = ts_to_seconds(target["timestamp_start"])
    t1 = ts_to_seconds(target.get("timestamp_end") or target["timestamp_start"])
    if t1 <= t0:
        t1 = t0 + 4
    urls = []
    for k in range(count):
        secs = t0 + (t1 - t0) * (k / max(1, count - 1)) if count > 1 else t0
        name = f"step_{step:02d}_opt{k+1}.jpg"
        if extract_frame(str(video), secs, str(frames_dir / name)):
            urls.append({"name": name,
                         "url": f"/api/jobs/{job_id}/frames/{name}",
                         "t": round(secs, 1)})
    return {"options": urls}


@app.post("/api/jobs/{job_id}/images")
async def upload_image(job_id: str, image: UploadFile = File(...)):
    job_dir = config.JOBS_DIR / job_id
    if not job_dir.exists():
        raise HTTPException(404, "job not found")
    up = job_dir / "uploads"; up.mkdir(exist_ok=True)
    name = f"up_{uuid.uuid4().hex[:8]}_{Path(image.filename).name}"
    with open(up / name, "wb") as f:
        shutil.copyfileobj(image.file, f)
    return {"name": name, "url": f"/api/jobs/{job_id}/uploads/{name}"}


@app.get("/api/jobs/{job_id}/uploads/{name}")
def serve_upload(job_id: str, name: str):
    fp = config.JOBS_DIR / job_id / "uploads" / Path(name).name
    if not fp.exists():
        raise HTTPException(404, "image not found")
    return FileResponse(fp)


@app.post("/api/jobs/{job_id}/export")
def export_docx(job_id: str, model: dict = Body(...)):
    job_dir = config.JOBS_DIR / job_id
    if not job_dir.exists():
        raise HTTPException(404, "job not found")
    out = job_dir / "assembly_instruction.docx"
    docx_export.build_docx(model, job_dir, out)
    fname = (model.get("settings", {}).get("model") or "assembly_instruction")
    fname = "".join(c if c.isalnum() or c in "-_" else "_" for c in fname) + ".docx"
    return FileResponse(
        out, filename=fname,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")


# --------------------------------------------------------------- ontology + highlight
@app.get("/api/jobs/{job_id}/ontology")
def get_ontology(job_id: str):
    f = config.JOBS_DIR / job_id / "ontology.json"
    if not f.exists():
        raise HTTPException(404, "no ontology")
    return JSONResponse(json.loads(f.read_text(encoding="utf-8")))


@app.get("/api/jobs/{job_id}/ontology.png")
def ontology_png(job_id: str):
    f = config.JOBS_DIR / job_id / "ontology.png"
    if not f.exists():
        raise HTTPException(404, "no ontology image")
    return FileResponse(f, media_type="image/png")


@app.get("/api/jobs/{job_id}/highlight")
def highlight(job_id: str, step: int, mode: str = "box"):
    """Locate & highlight the step's components in its frame (lazy, cached)."""
    mode = mode if mode in ("box", "sam") else "box"
    data = _load_result(job_id)
    job_dir = config.JOBS_DIR / job_id
    frames = job_dir / "frames"
    target = None
    for st in data["stations"]:
        for s in st["steps"]:
            if s["step_number"] == step:
                target = s
    if not target:
        raise HTTPException(404, "step not found")

    src = frames / f"step_{step:02d}.jpg"
    if not src.exists():
        raise HTTPException(404, "frame not found")
    out = frames / f"step_{step:02d}_hl_{mode}.jpg"

    labels = [c["name"] for c in target.get("components", [])]
    labels += target.get("tools", [])
    client = config.get_client()
    res = vision.highlight(client, str(src), labels, mode, str(out))
    return {"url": f"/api/jobs/{job_id}/frames/{out.name}",
            "detections": res.get("detections", []),
            "count": len(res.get("detections", [])),
            "mode": res.get("mode", mode)}


# static assets (css/js) served under /static
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


if __name__ == "__main__":
    import uvicorn
    print("ABICOR Assembly-Doc running at  http://127.0.0.1:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
