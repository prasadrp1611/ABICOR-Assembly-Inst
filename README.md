# ABICOR Assembly-Doc Generator

Turn a welder's **tutorial video** into a **deterministic, illustrated, step-by-step
assembly document** — time-stamped point-wise steps, grounded "this/that" references,
a frame (or segmented image) per step, automatic **Part-ID matching** from your product
PDFs, an auto-built **knowledge graph**, and a one-click **Word (.docx)** export in your
own template.

> Built for the ABICOR BINZEL International Product Management hackathon.

---

## ✨ What it does

- **Video → structured steps** — each physical action becomes one numbered instruction point.
- **Grounded references** — every "this / that / here / das / hier" is mapped to the real part.
- **Per-step media** — a video snippet of the section, or a chosen frame, or a part highlighted
  with **boxes** or **SAM segmentation**.
- **Part-ID matching** — drop in one or more product PDFs (BoM, spare-parts list, datasheet,
  drawing); part numbers are extracted and matched to the components in the video.
- **Knowledge graph (ontology)** — parts / tools / actions with typed relationships.
- **Inline editing + Word export** — fix text, pick images, edit the template, export `.docx`.
- **Refine & rerun** — tell the AI to "add more steps / be more verbose" and re-run on the same video.
- **Long videos** — a 1-hour tutorial is auto-split into parts and merged back together.
- **Runs everywhere** — Windows / macOS / Linux, Python 3.10+. SAM is optional.

---

## ✅ Requirements

- **Python 3.10 or newer** — <https://www.python.org/downloads/>
  (on Windows, tick *"Add python.exe to PATH"* during install)
- A **Google AI Studio (Gemini) API key** — free at <https://aistudio.google.com/apikey>
- ~1 GB free disk for the Python packages
- Internet access (the analysis runs in the cloud)

---

## 🚀 Setup (one time)

### Windows
```bat
git clone https://github.com/prasadrp1611/ABICOR-Assembly-Inst.git
cd ABICOR-Assembly-Inst
setup.bat
```

### macOS / Linux
```bash
git clone https://github.com/prasadrp1611/ABICOR-Assembly-Inst.git
cd ABICOR-Assembly-Inst
chmod +x setup.sh run.sh
./setup.sh
```

`setup` creates a virtual environment in `.venv`, installs the dependencies, and copies
`.env.example` to `.env`.

---

## 🔑 The API key

You can provide the key **either** way:

1. **In the app** *(easiest)* — start the app, click the **⚙ gear** (top-right) →
   paste your key → *Save & verify*. It is stored locally only.
2. **In the file** — open **`.env`** and set:
   ```
   GEMINI_API_KEY=your-key-here
   ```

The key is never committed to git (`.env` is git-ignored).

---

## ▶️ Run

### Windows
```bat
run.bat
```
### macOS / Linux
```bash
./run.sh
```

Then open **<http://127.0.0.1:8000>** in your browser. Press **Ctrl+C** in the terminal to stop.

---

## 🧭 First use

1. On the home page, watch the short **"How to film your tutorial"** guide (below *Generate*).
2. **Choose a tutorial video** (mp4 / mov). Optionally add one or more **product PDFs**
   (BoM / spare parts / datasheet) to enable Part-ID matching.
3. (Optional) fill in product name / model / ID, and pick a split size for long videos.
4. Click **Generate**. Watch the progress, then explore the result:
   - per-step **video snippet**, **frame** dropdown, **highlight a part** dropdown (Boxes / SAM)
   - click any image → **lightbox**
   - **✎ Edit** the steps inline · **↻ Refine & Rerun** with new instructions
   - **⬇ Export Word** → edit the template fields → **Generate .docx**

---

## 🧩 Optional: precise SAM segmentation

The "SAM segmentation" highlight mode is optional and heavier. Without it the app uses
fast bounding boxes. To enable it:

```bash
# inside the project, with the venv active:
pip install -r requirements-sam.txt
# CPU-only PyTorch (recommended for portability):
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
```

Backends are tried in order and the first that loads wins:

| Backend | Notes |
|---|---|
| **SAM 3** (`facebook/sam3`) | best, **gated** — accept the license on HF and set `HF_TOKEN` in `.env` |
| **SAM 2.1** (`facebook/sam2.1-hiera-base-plus`) | open, small, fast — the practical default |
| **SAM 1** (`facebook/sam-vit-base`) | open, universal fallback |
| **box mode** | if PyTorch is not installed |

Model weights download automatically on first use.

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| *"Python was not found"* | Install Python 3.10+ and re-run `setup`. On Windows re-tick *Add to PATH*. |
| Browser shows *"API key not configured"* | Add the key via the ⚙ Settings dialog, or in `.env`. |
| `[Errno 10048] address already in use` | Port 8000 is busy — close the other server, or change the port at the bottom of `server.py`. |
| First **SAM** highlight is slow | It downloads + loads the model once (then it's cached). Use **Boxes** for instant results. |
| Large upload seems stuck | Big files take time to upload + the cloud step runs after; the progress bar updates per stage. |
| `pip install` fails on `numpy`/`opencv` | Make sure you're on Python 3.10–3.12 and using the `.venv` created by `setup`. |

---

## 🏗️ How it works

```
 video (.mp4/.mov) ─┐
 product PDFs ──────┤→ multimodal AI engine ─→ AssemblyDocument JSON (schema-locked)
                    │   (deterministic mode)        ├→ one frame per step
                    │                               ├→ semantic match → Part IDs
                    │                               └→ knowledge graph (ontology)
                    └→ browser viewer · inline editor · Word (.docx) export
```

The JSON structure is fixed by a strict schema and validated on every run, so the output
shape is identical every time.

## 📁 Project layout

| File | Purpose |
|------|---------|
| `server.py`     | FastAPI app, uploads, background jobs, REST API |
| `pipeline.py`   | video → JSON → frames → part matching → ontology |
| `schema.py`     | data model + system prompt (the deterministic contract) |
| `chunking.py`   | split long videos into parts and merge results |
| `ontology.py`   | knowledge-graph extraction + graph renderer |
| `vision.py` · `sam_backend.py` | part localisation / highlight / SAM segmentation |
| `docx_export.py`| Word (.docx) generator (editable template) |
| `config.py`     | keys, model + determinism settings |
| `static/`       | the web UI |
| `assets/`       | document logos |
| `jobs/<id>/`    | per-run inputs, `frames/`, `assembly.json`, `ontology.*`, `status.json` *(git-ignored)* |

## 🔌 API (for reference)

| Method | Route | |
|--------|-------|--|
| POST | `/api/jobs` | upload `video` (+ optional `parts_pdf` × N, product fields, `chunk_minutes`) |
| GET  | `/api/jobs/{id}` | job status / progress |
| GET  | `/api/jobs/{id}/result` | the `assembly.json` |
| POST | `/api/jobs/{id}/rerun` | re-run with extra prompt instructions |
| GET  | `/api/jobs/{id}/frames/{name}` · `/video` · `/highlight` | media |
| GET  | `/api/jobs/{id}/ontology` · `/ontology.png` | knowledge graph |
| POST | `/api/jobs/{id}/export` | render the `.docx` |
| GET/POST | `/api/config` | check / set the API key |

## 📝 Credits & licensing

- **ABICOR BINZEL** logos and document template are the property of Alexander Binzel
  Schweisstechnik GmbH & Co. KG (used here for the hackathon).
- The narrated guide video's background music — *"Somewhere Sunny"* by **Kevin MacLeod**
  (incompetech.com), licensed **CC BY 3.0**.
- The "fun mode" sound and the spinning icon are light-hearted easter eggs.
