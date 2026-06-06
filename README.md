# ABICOR Assembly-Doc Generator

Turn a welder's tutorial video into a **deterministic, structured assembly
document** — time-stamped, point-wise steps with grounded ("this/that")
references, a frame image per step, and optional official **Part-ID matching**
against a spare-parts PDF.

## What it does (end to end)

```
 video (.mp4/.mov)  ─┐
 parts PDF (optional)─┤→  Multimodal AI engine  →  AssemblyDocument JSON (schema-locked)
                      │      (deterministic mode)      │
                      │                                ├→ one frame per step
                      │                                └→ semantic match → Part IDs
                      └→  Browser viewer · Word editor · JSON download
```

- **Deterministic:** the JSON structure is fixed by a strict `response_schema`,
  generation runs in deterministic mode, and every result is validated against
  `assembly_document.schema.json` (exported from `schema.py`).
- **Point-wise instructions:** each physical action the worker narrates becomes
  one numbered instruction point with an `action_type`.
- **Deictic grounding:** every "this/that/here/das/hier" is mapped to the real part.
- **Part-ID matching:** if a spare-parts PDF is supplied, components are matched to
  official part numbers by embedding similarity, with a confidence score.
- **Part highlighting:** on demand, the engine localises a step's parts in its frame.
  Two selectable modes — **Boxes** (fast) or **SAM segmentation** (pixel-accurate
  masks via HuggingFace SAM, prompted by the engine's box). SAM is optional:
  `pip install -r requirements-sam.txt`.
- **In-app key:** paste your API key in the Settings dialog at runtime — no `.env` edit needed.
- **Ontology:** an auto-extracted knowledge graph (parts/tools/actions + typed
  relationships) rendered as a diagram.
- **Word editor:** an in-browser editor (`/editor`) to refine text, choose/upload
  per-step images, and export a `.docx` in the official template.

## Run

```bat
pip install -r requirements.txt          REM first time only
copy .env.example .env                    REM then add your key
run.bat                                   REM or:  python server.py
```

Then open <http://127.0.0.1:8000>. Requires `GEMINI_API_KEY` in `.env`.

## Project layout

| File | Purpose |
|------|---------|
| `server.py`     | FastAPI app, upload + background jobs + REST API |
| `pipeline.py`   | video → JSON → frames → part matching → ontology |
| `schema.py`     | Pydantic models + system prompt (the deterministic contract) |
| `ontology.py`   | knowledge-graph extraction + graph renderer |
| `vision.py`     | part localisation / highlight overlays |
| `docx_export.py`| Word (.docx) generator in the official template |
| `config.py`     | keys, model + determinism settings |
| `static/`       | browser UI (viewer + editor) |
| `jobs/<id>/`    | per-run inputs, `frames/`, `assembly.json`, `ontology.*`, `status.json` |

## API

| Method | Route | |
|--------|-------|--|
| POST | `/api/jobs` | upload `video` (+ optional `parts_pdf`, product fields) |
| GET  | `/api/jobs/{id}` | job status / progress |
| GET  | `/api/jobs/{id}/result` | the `assembly.json` |
| GET  | `/api/jobs/{id}/frames/{name}` | a step frame image |
| GET  | `/api/jobs/{id}/highlight?step=N` | highlight a step's parts |
| GET  | `/api/jobs/{id}/ontology` · `/ontology.png` | knowledge graph |
| GET  | `/editor?job={id}` | the Word editor |
| POST | `/api/jobs/{id}/export` | render the edited `.docx` |
| GET  | `/api/schema` | the JSON Schema contract |
