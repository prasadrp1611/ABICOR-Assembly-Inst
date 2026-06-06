"""
Core processing pipeline: video -> deterministic JSON -> frames -> part-ID matching.
Each job is a directory under jobs/<id>/ containing input + outputs + status.json.
"""
import os, json, time, traceback
from pathlib import Path

import numpy as np
import cv2
import jsonschema
from google.genai import types

import config
import chunking
from schema import (AssemblyDocument, SYSTEM_PROMPT, USER_INSTRUCTION,
                    SCHEMA_VERSION)


# --------------------------------------------------------------------------- utils
def ts_to_seconds(ts: str) -> float:
    parts = [int(p) for p in str(ts).split(":")]
    if len(parts) == 3: return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2: return parts[0] * 60 + parts[1]
    return float(parts[0])


def extract_frame(video_path: str, seconds: float, out_path: str) -> bool:
    cap = cv2.VideoCapture(video_path)
    cap.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
    ok, frame = cap.read()
    cap.release()
    if ok:
        cv2.imwrite(out_path, frame)
        return True
    return False


def _cos(a, b) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


# --------------------------------------------------------------------------- status
def write_status(job_dir: Path, **fields):
    sf = job_dir / "status.json"
    cur = {}
    if sf.exists():
        cur = json.loads(sf.read_text(encoding="utf-8"))
    cur.update(fields)
    sf.write_text(json.dumps(cur, indent=2, ensure_ascii=False), encoding="utf-8")
    return cur


# --------------------------------------------------------------------------- stages
def analyze_video(client, video_path: str, progress, extra: str = "") -> dict:
    progress(stage="uploading", progress=10,
             message="Ingesting media…")
    vfile = client.files.upload(file=video_path)
    while vfile.state.name == "PROCESSING":
        time.sleep(4)
        vfile = client.files.get(name=vfile.name)
    if vfile.state.name == "FAILED":
        raise RuntimeError("media processing failed")

    progress(stage="analyzing", progress=35,
             message="Multimodal engine analysing the procedure…")
    user_msg = USER_INSTRUCTION
    if extra:
        user_msg += ("\n\nADDITIONAL INSTRUCTIONS FROM THE USER — apply these while "
                     "still obeying the schema and all rules above:\n" + extra)
    resp = client.models.generate_content(
        model=config.MODEL,
        contents=[vfile, user_msg],
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            temperature=config.TEMPERATURE,
            seed=config.SEED,
            response_mime_type="application/json",
            response_schema=AssemblyDocument,
        ),
    )
    doc: AssemblyDocument = resp.parsed
    if doc is None:
        raise RuntimeError("the AI engine returned no structured result")
    data = doc.model_dump()

    # deterministic post-processing
    data["schema_version"] = SCHEMA_VERSION
    data["source"]["video_file"] = os.path.basename(video_path)
    for st in data["stations"]:
        for step in st["steps"]:
            step["frame_image"] = f"step_{step['step_number']:02d}.jpg"

    progress(stage="validating", progress=55, message="Structuring & validating steps…")
    jsonschema.validate(instance=data, schema=AssemblyDocument.model_json_schema())
    return data, vfile


def merge_chunk_docs(chunk_results: list, full_duration: float) -> dict:
    """Merge per-part documents: absolute timestamps + continuous step numbering."""
    base = chunk_results[0][1]
    merged = {
        "schema_version": SCHEMA_VERSION,
        "product": base["product"],
        "source": dict(base["source"]),
        "summary": "",
        "stations": [],
    }
    merged["source"]["duration"] = chunking.sec_to_mmss(full_duration)
    gstep, summaries = 1, []
    for meta, data in chunk_results:
        S = meta["start"]
        steps = []
        for st in data["stations"]:
            for step in st["steps"]:
                ts = S + ts_to_seconds(step["timestamp_start"])
                te = S + ts_to_seconds(step.get("timestamp_end") or step["timestamp_start"])
                step["timestamp_start"] = chunking.sec_to_mmss(ts)
                step["timestamp_end"] = chunking.sec_to_mmss(min(te, full_duration))
                step["step_number"] = gstep
                step["frame_image"] = f"step_{gstep:02d}.jpg"
                steps.append(step)
                gstep += 1
        merged["stations"].append({
            "station_number": meta["index"] + 1,
            "station_title": f"Part {meta['index'] + 1}  "
                             f"({chunking.sec_to_mmss(meta['start'])}–{chunking.sec_to_mmss(meta['end'])})",
            "steps": steps,
        })
        if data.get("summary"):
            summaries.append(data["summary"])
    merged["summary"] = " ".join(summaries)[:1500] or base.get("summary", "")
    return merged


def process_chunked(client, video_path: str, job_dir: Path, progress,
                    chunk_minutes: float, duration: float, extra: str = "") -> dict:
    clips_dir = job_dir / "chunks"
    clips_dir.mkdir(exist_ok=True)
    plan = chunking.plan_chunks(duration, chunk_minutes)
    progress(stage="chunking", progress=12,
             message=f"Splitting the video into {len(plan)} parts…")
    results = []
    for c in plan:
        clip = clips_dir / f"part_{c['index']:02d}.mp4"
        chunking.split_clip(video_path, str(clip), c["start"], c["end"])
        progress(stage="analyzing",
                 progress=18 + int(60 * c["index"] / max(1, len(plan))),
                 message=f"Analysing part {c['index'] + 1} of {len(plan)}…")
        data, _ = analyze_video(client, str(clip), progress, extra)
        results.append((c, data))
    merged = merge_chunk_docs(results, duration)
    merged["source"]["video_file"] = os.path.basename(video_path)
    merged["chunked"] = {"parts": len(plan), "chunk_minutes": chunk_minutes}
    return merged


def extract_all_frames(video_path: str, data: dict, frames_dir: Path, progress):
    progress(stage="extracting_frames", progress=65,
             message="Extracting a frame for each step…")
    frames_dir.mkdir(exist_ok=True)
    for st in data["stations"]:
        for step in st["steps"]:
            secs = ts_to_seconds(step["timestamp_start"])
            extract_frame(video_path, secs, str(frames_dir / step["frame_image"]))


def extract_parts_table(client, pdf_path: str) -> list:
    """Extract any parts/components with part numbers from a product document.
    Works for a BoM, spare-parts list, datasheet, manual, or assembly drawing."""
    pf = client.files.upload(file=pdf_path)
    while pf.state.name == "PROCESSING":
        time.sleep(2)
        pf = client.files.get(name=pf.name)
    prompt = (
        "This document is product documentation — it may be a Bill of Materials, "
        "spare-parts list, datasheet, manual, or exploded-view assembly drawing. "
        "Extract EVERY part or component that has an identifiable part number / "
        "article number / order code. For each return: item (the item number or "
        "label if shown, else \"\"), part_no (the part/article number exactly as "
        "written), description. Ignore rows with no part number. "
        'Return ONLY JSON: {"parts":[{"item":"...","part_no":"...","description":"..."}]}'
    )
    r = client.models.generate_content(
        model=config.MODEL, contents=[pf, prompt],
        config=types.GenerateContentConfig(temperature=0, seed=config.SEED,
                                            response_mime_type="application/json"),
    )
    t = r.text
    if "```json" in t: t = t.split("```json")[1].split("```")[0].strip()
    elif "```" in t:   t = t.split("```")[1].split("```")[0].strip()
    try:
        return json.loads(t).get("parts", [])
    except Exception:
        return []


def extract_parts_from_docs(client, paths: list, progress) -> list:
    """Extract + merge parts from one or more product documents (deduped by part_no)."""
    merged, seen = [], set()
    n = len(paths)
    for i, p in enumerate(paths):
        progress(stage="matching_parts", progress=72 + int(6 * i / max(1, n)),
                 message=f"Reading product document {i + 1} of {n}…")
        for pt in extract_parts_table(client, str(p)):
            key = (str(pt.get("part_no", "")).strip().lower()
                   or str(pt.get("description", "")).strip().lower())
            if key and key not in seen:
                seen.add(key)
                pt["source_doc"] = Path(p).name
                merged.append(pt)
    return merged


def match_parts(client, data: dict, parts: list, progress):
    """Embed official parts + components, assign best Part ID by cosine similarity."""
    progress(stage="matching_parts", progress=80,
             message=f"Matching components to {len(parts)} official part IDs…")

    def embed(text):
        r = client.models.embed_content(model=config.EMBED_MODEL, contents=text)
        return np.array(r.embeddings[0].values)

    part_vecs = [(p, embed(f"{p['description']} (welding machine spare part)"))
                 for p in parts]

    # cache component embeddings by name to avoid repeats
    cache = {}
    matched = 0
    for st in data["stations"]:
        for step in st["steps"]:
            for comp in step["components"]:
                name = comp["name"]
                if name not in cache:
                    cache[name] = embed(name)
                q = cache[name]
                # rank ALL candidate parts by confidence, keep the top few
                scored = sorted(((_cos(q, v), p) for p, v in part_vecs),
                                key=lambda x: -x[0])[:6]
                comp["part_candidates"] = [
                    {"item": p["item"], "part_no": p["part_no"],
                     "official_name": p["description"], "confidence": round(s, 3),
                     "source_doc": p.get("source_doc", "")}
                    for s, p in scored]
                best_s, best_p = scored[0]
                confident = best_s >= config.PART_MATCH_THRESHOLD
                comp["part_match"] = {
                    "item": best_p["item"],
                    "part_no": best_p["part_no"],
                    "official_name": best_p["description"],
                    "confidence": round(best_s, 3),
                    "confident": confident,
                }
                # default to the highest-confidence match (never "no part" by default)
                comp["part_id"] = best_p["part_no"]
                if confident:
                    matched += 1
    data["parts_matched"] = matched
    data["official_parts"] = parts
    return data


# --------------------------------------------------------------------------- driver
def process_job(job_id: str, options: dict):
    job_dir = config.JOBS_DIR / job_id
    frames_dir = job_dir / "frames"

    def progress(**f):
        f.setdefault("status", "processing")
        write_status(job_dir, **f)

    try:
        client = config.get_client()
        video_path = str(job_dir / options["video_filename"])

        duration = chunking.get_duration(video_path)
        chunk_minutes = float(options.get("chunk_minutes") or 0)
        # auto-chunk long videos (>15 min) into 10-min parts unless told otherwise
        auto = chunk_minutes <= 0 and duration > 15 * 60
        use_chunks = chunk_minutes > 0 or auto
        extra = (options.get("extra_instructions") or "").strip()
        vfile = None

        if use_chunks:
            cm = chunk_minutes if chunk_minutes > 0 else 10
            data = process_chunked(client, video_path, job_dir, progress, cm, duration, extra)
        else:
            data, vfile = analyze_video(client, video_path, progress, extra)

        # apply user-provided product overrides
        for k in ("name", "model", "id_number"):
            if options.get(f"product_{k}"):
                data["product"][k] = options[f"product_{k}"]

        extract_all_frames(video_path, data, frames_dir, progress)

        parts_files = options.get("parts_filenames") or (
            [options["parts_filename"]] if options.get("parts_filename") else [])
        matched_ran = False
        if parts_files:
            parts = extract_parts_from_docs(client, [job_dir / p for p in parts_files], progress)
            if parts:
                data = match_parts(client, data, parts, progress)
                data["source_documents"] = parts_files
                matched_ran = True
        if not matched_ran:
            # No usable product document -> never show (possibly hallucinated) part numbers.
            for st in data["stations"]:
                for s in st["steps"]:
                    for c in s.get("components", []):
                        c["part_id"] = ""
                        c.pop("part_candidates", None)
                        c.pop("part_match", None)
            data["parts_matched"] = 0

        # re-apply the user's saved Part-ID corrections (survives reruns), by component name
        overrides = options.get("part_overrides") or {}
        if overrides:
            for st in data["stations"]:
                for s in st["steps"]:
                    for c in s.get("components", []):
                        k = (c.get("name") or "").strip().lower()
                        if k in overrides:
                            c["part_id"] = overrides[k]
                            c["part_id_user_set"] = True
            data["parts_matched"] = sum(1 for st in data["stations"] for s in st["steps"]
                                        for c in s.get("components", []) if c.get("part_id"))

        # ontology / knowledge graph (supplementary — never fails the job)
        if vfile is not None:
            try:
                progress(stage="ontology", progress=92, message="Mapping the part ontology…")
                import ontology as onto_mod
                onto = onto_mod.extract_ontology(client, vfile)
                (job_dir / "ontology.json").write_text(
                    json.dumps(onto, indent=2, ensure_ascii=False), encoding="utf-8")
                label = data["product"]["model"] or data["product"]["name"] or "Assembly"
                onto_mod.render_graph(onto, job_dir / "ontology.png", title=f"{label} — Ontology")
                data["ontology_summary"] = onto_mod.summarize(onto)
            except Exception as oe:
                data["ontology_summary"] = {"error": str(oe)[:140]}
        else:
            data["ontology_summary"] = {"note": "ontology skipped for chunked long videos"}

        (job_dir / "assembly.json").write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

        n_steps = sum(len(s["steps"]) for s in data["stations"])
        n_points = sum(len(st["instructions"])
                       for s in data["stations"] for st in s["steps"])
        write_status(
            job_dir, status="done", stage="done", progress=100,
            message="Assembly document ready.",
            product=data["product"]["model"] or data["product"]["name"],
            n_steps=n_steps, n_points=n_points,
            parts_matched=data.get("parts_matched", 0),
            finished_at=time.time(),
        )
    except Exception as e:
        write_status(job_dir, status="error", stage="error", progress=100,
                     message=f"{type(e).__name__}: {e}",
                     traceback=traceback.format_exc())
