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
import json, re, shutil, sys, threading, time, unicodedata, uuid
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

# Force UTF-8 I/O so prints never crash under a C/ascii locale (runs everywhere).
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def safe_filename(name: str, fallback: str = "upload.bin") -> str:
    """ASCII-safe filename (HTTP-header + cross-platform safe), keeping the extension.
    Non-ASCII (smart quotes, umlauts, emoji) is transliterated/stripped — otherwise
    the name reaches Gemini's upload as a header value and httpx can't ascii-encode it."""
    p = Path(name or "")
    stem = unicodedata.normalize("NFKD", p.stem).encode("ascii", "ignore").decode("ascii")
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._")
    ext = re.sub(r"[^A-Za-z0-9.]+", "", p.suffix)
    out = ((stem or "upload") + ext)[:120]
    return out or fallback


app = FastAPI(title="ABICOR Assembly-Doc Generator")
STATIC = config.APP_DIR / "static"


@app.on_event("startup")
def _warm_sam():
    # Pre-load SAM weights in the background. The torch import + model load happen
    # entirely inside the thread so server startup (and request readiness) is instant.
    def _w():
        try:
            if sam_backend.available():
                sam_backend.warmup()
        except Exception:
            pass
    threading.Thread(target=_w, daemon=True).start()


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
    parts_pdf: list[UploadFile] = File(default=[]),
    product_name: str = Form(""),
    product_model: str = Form(""),
    product_id: str = Form(""),
    chunk_minutes: float = Form(0),
):
    if not config.has_key():
        raise HTTPException(400, "API key not configured. Open Settings and add your key.")
    if not video or not video.filename:
        raise HTTPException(400, "No video file provided.")

    # stream the upload to disk in chunks so a large file never blocks the loop
    async def save_upload(upload: UploadFile, dest: Path) -> int:
        size = 0
        try:
            with open(dest, "wb") as f:
                while True:
                    chunk = await upload.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > config.MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "File too large (limit 2 GB).")
                    f.write(chunk)
        finally:
            await upload.close()
        if size == 0:
            raise HTTPException(400, f"Uploaded file '{dest.name}' is empty.")
        return size

    job_id = uuid.uuid4().hex[:12]
    job_dir = config.JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    try:
        video_name = safe_filename(video.filename, "input.mp4")
        await save_upload(video, job_dir / video_name)

        options = {
            "video_filename": video_name,
            "product_name": product_name.strip(),
            "product_model": product_model.strip(),
            "product_id": product_id.strip(),
            "chunk_minutes": chunk_minutes,
        }

        parts_names = []
        for pf in (parts_pdf or []):
            if pf is None or not pf.filename:
                continue
            pname = safe_filename(pf.filename, f"doc_{len(parts_names)+1}.pdf")
            # avoid collisions if two docs share a sanitized name
            if pname in parts_names:
                pname = f"{len(parts_names)+1}_{pname}"
            await save_upload(pf, job_dir / pname)
            parts_names.append(pname)
        if parts_names:
            options["parts_filenames"] = parts_names

        write_status(job_dir, id=job_id, status="queued", stage="queued",
                     progress=0, message="Queued…", created_at=time.time(),
                     video=video_name, has_parts=bool(options.get("parts_filenames")),
                     options=options)
        _run_job(job_id, options)
        return {"job_id": job_id}
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(500, f"Upload failed: {type(e).__name__}")


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


@app.post("/api/jobs/{job_id}/rerun")
def rerun_job(job_id: str, body: dict = Body(...)):
    """Re-run analysis on the already-uploaded video with extra prompt instructions."""
    if not config.has_key():
        raise HTTPException(400, "API key not configured. Open Settings and add your key.")
    job_dir = config.JOBS_DIR / job_id
    sf = job_dir / "status.json"
    if not sf.exists():
        raise HTTPException(404, "job not found")
    st = json.loads(sf.read_text(encoding="utf-8"))
    options = st.get("options", {})
    if not options.get("video_filename"):
        raise HTTPException(400, "original video not available for rerun")
    options["extra_instructions"] = (body.get("instructions") or "").strip()
    write_status(job_dir, status="queued", stage="queued", progress=0,
                 message="Re-running with your instructions…", options=options)
    _run_job(job_id, options)
    return {"job_id": job_id, "rerun": True}


@app.post("/api/jobs/{job_id}/part_choice")
def set_part_choice(job_id: str, body: dict = Body(...)):
    """Persist a user's Part-ID choice into assembly.json and remember it for reruns."""
    job_dir = config.JOBS_DIR / job_id
    rf = job_dir / "assembly.json"
    if not rf.exists():
        raise HTTPException(404, "result not ready")
    data = json.loads(rf.read_text(encoding="utf-8"))
    step_no = int(body.get("step", -1))
    ci = int(body.get("ci", -1))
    pn = (body.get("part_no") or "").strip()

    cname = None
    for st in data["stations"]:
        for s in st["steps"]:
            if s["step_number"] == step_no:
                comps = s.get("components", [])
                if 0 <= ci < len(comps):
                    comps[ci]["part_id"] = pn
                    comps[ci]["part_id_user_set"] = True
                    cname = comps[ci].get("name")
    data["parts_matched"] = sum(1 for st in data["stations"] for s in st["steps"]
                                for c in s.get("components", []) if c.get("part_id"))
    rf.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    # remember the override (keyed by component name) so a future rerun keeps it
    if cname:
        sf = job_dir / "status.json"
        if sf.exists():
            stj = json.loads(sf.read_text(encoding="utf-8"))
            opts = stj.get("options", {})
            ov = opts.get("part_overrides") or {}
            ov[cname.strip().lower()] = pn
            opts["part_overrides"] = ov
            write_status(job_dir, options=opts)
    return {"ok": True, "parts_matched": data["parts_matched"]}


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
    name = f"up_{uuid.uuid4().hex[:8]}_{safe_filename(image.filename, 'img.jpg')}"
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
def highlight(job_id: str, step: int, mode: str = "box", label: str = "", frame: str = ""):
    """Locate & highlight a step's parts in its frame (lazy, cached).
    label: highlight only this part (else all). frame: source frame filename."""
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

    src = frames / (Path(frame).name if frame else f"step_{step:02d}.jpg")
    if not src.exists():
        src = frames / f"step_{step:02d}.jpg"
    if not src.exists():
        raise HTTPException(404, "frame not found")

    if label:
        labels = [label]
    else:
        labels = [c["name"] for c in target.get("components", [])] + target.get("tools", [])

    slug = "".join(c for c in label if c.isalnum())[:14] or "all"
    out = frames / f"{src.stem}_hl_{mode}_{slug}.jpg"
    client = config.get_client()
    res = vision.highlight(client, str(src), labels, mode, str(out))
    return {"url": f"/api/jobs/{job_id}/frames/{out.name}",
            "detections": res.get("detections", []),
            "count": len(res.get("detections", [])),
            "mode": res.get("mode", mode),
            "backend": sam_backend.active_kind() if mode == "sam" else "box"}


@app.get("/api/jobs/{job_id}/video")
def serve_video(job_id: str):
    """Serve the source video (Range-enabled) for per-section snippet playback."""
    data = _load_result(job_id)
    fp = config.JOBS_DIR / job_id / data["source"]["video_file"]
    if not fp.exists():
        raise HTTPException(404, "video not found")
    ext = fp.suffix.lower()
    media = "video/mp4" if ext in (".mp4", ".m4v") else \
            "video/quicktime" if ext == ".mov" else "application/octet-stream"
    return FileResponse(fp, media_type=media)


# static assets (css/js) served under /static
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


if __name__ == "__main__":
    import uvicorn
    print("ABICOR Assembly-Doc running at  http://127.0.0.1:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
