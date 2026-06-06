const $ = (s) => document.querySelector(s);
let pollTimer = null;
let currentJob = null;
let CONFIGURED = false;
let SAM_AVAILABLE = false;
let HL_MODE = "box";

// ---- file pickers (click + drag/drop, single dialog) ----
function wireDrop(dropId, inputId, nameId, label) {
  const drop = $("#" + dropId), input = $("#" + inputId), name = $("#" + nameId);
  const show = () => {
    if (input.files.length) {
      name.textContent = input.files[0].name;
      drop.classList.add("set");
    } else {
      name.textContent = label;
      drop.classList.remove("set");
    }
  };
  // open the native dialog exactly once
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", show);
  // drag & drop
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "dragend"].forEach((ev) =>
    drop.addEventListener(ev, () => drop.classList.remove("drag")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; show(); }
  });
}
wireDrop("video-drop", "video", "video-name", "drag & drop or click · mp4 · mov");
wireDrop("pdf-drop", "parts_pdf", "pdf-name", "optional · enables Part-ID matching");

// ---- submit ----
$("#job-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!CONFIGURED) { openSettings(); return; }
  const video = $("#video").files[0];
  if (!video) {
    $("#video-drop").classList.add("missing");
    setTimeout(() => $("#video-drop").classList.remove("missing"), 1200);
    return;
  }
  const fd = new FormData();
  fd.append("video", video);
  if ($("#parts_pdf").files[0]) fd.append("parts_pdf", $("#parts_pdf").files[0]);
  fd.append("product_name", $("#product_name").value);
  fd.append("product_model", $("#product_model").value);
  fd.append("product_id", $("#product_id").value);
  fd.append("chunk_minutes", $("#chunk_minutes").value);

  $("#go").disabled = true;
  $("#go").textContent = "Uploading…";
  try {
    const r = await fetch("/api/jobs", { method: "POST", body: fd });
    if (!r.ok) throw new Error("upload failed (" + r.status + ")");
    const { job_id } = await r.json();
    currentJob = job_id;
    $("#upload-card").classList.add("hidden");
    $("#progress-card").classList.remove("hidden");
    $("#result").classList.add("hidden");
    poll();
  } catch (err) {
    alert(err.message);
    $("#go").disabled = false;
    $("#go").textContent = "Generate";
  }
});

// ---- poll status ----
const STAGES = {
  queued: "Queued", chunking: "Splitting long video into parts",
  uploading: "Ingesting media",
  analyzing: "Perceiving the procedure (multimodal AI)",
  validating: "Structuring & validating steps", extracting_frames: "Extracting key frames",
  matching_parts: "Cross-referencing part catalogue", ontology: "Mapping the part ontology",
  done: "Done", error: "Error",
};

function poll() {
  clearTimeout(pollTimer);
  fetch(`/api/jobs/${currentJob}`)
    .then((r) => r.json())
    .then((s) => {
      $("#bar").style.width = (s.progress || 0) + "%";
      $("#stage-msg").textContent = s.message || STAGES[s.stage] || s.stage;
      if (s.status === "done") return showResult();
      if (s.status === "error") return showError(s);
      pollTimer = setTimeout(poll, 1800);
    })
    .catch(() => (pollTimer = setTimeout(poll, 2500)));
}

function showError(s) {
  $("#progress-card").classList.add("hidden");
  const r = $("#result");
  r.classList.remove("hidden");
  r.innerHTML = `<div class="err"><b>Processing failed.</b><br>${esc(s.message || "")}</div>`;
  resetForm();
}

function resetForm() {
  $("#go").disabled = false;
  $("#go").textContent = "Generate";
}

// ---- render result ----
async function showResult() {
  const data = await (await fetch(`/api/jobs/${currentJob}/result`)).json();
  $("#progress-card").classList.add("hidden");
  const root = $("#result");
  root.classList.remove("hidden");
  root.innerHTML = renderDoc(data);
  $("#dl-json").addEventListener("click", () =>
    download(`${(data.product.model || "assembly").replace(/\s+/g, "_")}.json`, data));
  $("#open-editor").addEventListener("click", () =>
    (window.location = `/editor?job=${currentJob}`));
  $("#new-job").addEventListener("click", () => location.reload());
  root.querySelectorAll(".hl-btn").forEach((b) =>
    b.addEventListener("click", () => toggleHighlight(b)));
  // highlight-mode selector
  const samBtn = $("#sam-btn");
  if (samBtn && !SAM_AVAILABLE) {
    samBtn.disabled = true;
    samBtn.title = "SAM backend not installed (pip install -r requirements-sam.txt)";
  }
  $("#hl-mode") && $("#hl-mode").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.disabled) return;
      HL_MODE = b.dataset.mode;
      $("#hl-mode").querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    }));
  resetForm();
  root.scrollIntoView({ behavior: "smooth" });
}

async function toggleHighlight(btn) {
  const step = btn.dataset.step;
  const img = document.getElementById(`img-${step}`);
  const mode = HL_MODE;
  // currently showing this same mode -> revert to original
  if (btn.dataset.shown === mode) {
    img.src = img.dataset.orig;
    btn.dataset.shown = "";
    btn.textContent = "🔍 Highlight parts";
    return;
  }
  const cacheKey = "hl_" + mode;
  if (btn.dataset[cacheKey]) {
    img.src = btn.dataset[cacheKey];
    btn.dataset.shown = mode;
    btn.textContent = "↩ Show original";
    return;
  }
  btn.disabled = true;
  btn.textContent = mode === "sam" ? "Segmenting (SAM)…" : "Locating parts…";
  try {
    const r = await fetch(`/api/jobs/${currentJob}/highlight?step=${step}&mode=${mode}`);
    if (!r.ok) throw new Error("highlight failed");
    const d = await r.json();
    const url = d.url + "?t=" + Date.now();
    btn.dataset[cacheKey] = url;
    img.src = url;
    btn.dataset.shown = mode;
    const tag = d.mode === "sam" ? "SAM" : "boxes";
    btn.textContent = d.count ? `↩ Show original (${d.count} · ${tag})` : "↩ Show original";
  } catch (e) {
    btn.textContent = "🔍 Highlight parts";
  }
  btn.disabled = false;
}

function renderDoc(d) {
  const p = d.product, s = d.source;
  const nSteps = d.stations.reduce((a, st) => a + st.steps.length, 0);
  const meta = [
    p.model && `<span class="meta-chip"><b>Model</b> ${esc(p.model)}</span>`,
    p.id_number && `<span class="meta-chip"><b>ID</b> ${esc(p.id_number)}</span>`,
    `<span class="meta-chip"><b>Language</b> ${esc(s.language)}</span>`,
    `<span class="meta-chip"><b>Duration</b> ${esc(s.duration)}</span>`,
    `<span class="meta-chip"><b>Steps</b> ${nSteps}</span>`,
    d.parts_matched != null &&
      `<span class="meta-chip"><b>Part IDs matched</b> ${d.parts_matched}</span>`,
  ].filter(Boolean).join("");

  let html = `
    <div class="doc-head">
      <h1>${esc(p.name || "Assembly Instruction")}</h1>
      <div class="doc-meta">${meta}</div>
      <p class="muted">${esc(d.summary || "")}</p>
      <div class="doc-actions">
        <button class="btn-primary" id="open-editor">📝 Open in Word Editor</button>
        <button class="btn-ghost" id="dl-json">⬇ Download JSON</button>
        <button class="btn-ghost" id="new-job">+ New video</button>
      </div>
      <div class="mode-row">
        <span class="lbl">Part highlighting:</span>
        <div class="hl-mode" id="hl-mode">
          <button data-mode="box" class="active">Boxes</button>
          <button data-mode="sam" id="sam-btn">SAM segmentation</button>
        </div>
      </div>
    </div>`;

  for (const st of d.stations) {
    html += `<div class="station-title">${esc(st.station_title)}</div>`;
    for (const step of st.steps) html += renderStep(step);
  }
  html += renderOntology(d);
  return html;
}

function renderOntology(d) {
  const o = d.ontology_summary;
  if (!o || o.error) return "";
  const cls = Object.entries(o.classes || {})
    .map(([k, v]) => `<span class="meta-chip"><b>${esc(k)}</b> ${v}</span>`).join("");
  return `
    <div class="station-title">Knowledge Graph · Ontology</div>
    <div class="onto-card">
      <div class="onto-meta">
        <span class="meta-chip"><b>Entities</b> ${o.n_entities}</span>
        <span class="meta-chip"><b>Relationships</b> ${o.n_relationships}</span>
        ${cls}
      </div>
      <img class="onto-img" src="/api/jobs/${currentJob}/ontology.png"
           onclick="window.open(this.src)" title="click to enlarge"
           onerror="this.parentElement.style.display='none'"/>
      <div class="muted small">Auto-extracted part/tool/action ontology with typed
        relationships (PART_OF, CONNECTS_TO, SCREWS_INTO…). Click to enlarge.</div>
    </div>`;
}

function renderStep(step) {
  const img = `/api/jobs/${currentJob}/frames/${encodeURIComponent(step.frame_image)}`;
  const points = step.instructions.map((i) => `
    <li><span class="pt-n"></span>
      <span class="act ${i.action_type}">${i.action_type.replace("_", " ")}</span>
      <span class="pt-text">${esc(i.text)}</span></li>`).join("");

  const comps = (step.components || []).map((c) => {
    let pid = "", conf = "";
    if (c.part_id) pid = `<span class="pid">${esc(c.part_id)}</span>`;
    const m = c.part_match;
    if (m) {
      const cls = m.confident ? "hi" : "lo";
      conf = `<span class="conf ${cls}">${Math.round(m.confidence * 100)}%</span>`;
      if (!c.part_id) pid = `<span class="pid" title="${esc(m.official_name)}">≈ ${esc(m.part_no)}</span>`;
    }
    return `<span class="chip">${esc(c.name)}${pid}${conf}</span>`;
  }).join("");

  const tools = (step.tools || []).map((t) => `<span class="chip">${esc(t)}</span>`).join("");
  const deictic = (step.deictic_references || []).map((x) =>
    `<div class="deictic">“<b>${esc(x.utterance)}</b>” → ${esc(x.refers_to)}</div>`).join("");
  const tips = (step.tips || []).map((t) => `<div class="tip">💡 ${esc(t)}</div>`).join("");
  const warns = (step.warnings || []).map((t) => `<div class="warn">⚠ ${esc(t)}</div>`).join("");

  const n = step.narration || {};
  const narr = (n.original_text || n.english_text) ? `
    <details class="narr"><summary>Narration</summary>
      <div class="narr-body">
        <div class="orig">${esc(n.original_text || "")}</div>
        <div>${esc(n.english_text || "")}</div>
      </div></details>` : "";

  return `
  <div class="step">
    <div>
      <img class="step-img" id="img-${step.step_number}" src="${img}" data-orig="${img}"
           loading="lazy" onerror="this.style.opacity=.25"/>
      <div class="step-cap">frame @ ${esc(step.timestamp_start)}</div>
      <button class="hl-btn" data-step="${step.step_number}">🔍 Highlight parts</button>
    </div>
    <div>
      <div class="step-title"><span class="step-num">${step.step_number}</span>
        ${esc(step.title)}
        <span class="ts">${esc(step.timestamp_start)}–${esc(step.timestamp_end)}</span></div>
      <div class="goal">${esc(step.goal || "")}</div>
      <ul class="points">${points}</ul>
      ${comps ? `<div class="block-label">Components</div><div class="chips">${comps}</div>` : ""}
      ${tools ? `<div class="block-label">Tools</div><div class="chips">${tools}</div>` : ""}
      ${deictic ? `<div class="block-label">Resolved references</div>${deictic}` : ""}
      ${tips}${warns}${narr}
    </div>
  </div>`;
}

// ---- helpers ----
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- settings / API key + capabilities ----
function openSettings() {
  $("#settings").classList.remove("hidden");
  setTimeout(() => $("#api-key").focus(), 50);
}
function closeSettings() { $("#settings").classList.add("hidden"); }
$("#open-settings").addEventListener("click", openSettings);
$("#settings-close").addEventListener("click", closeSettings);
$("#settings").addEventListener("click", (e) => { if (e.target.id === "settings") closeSettings(); });

$("#save-key").addEventListener("click", async () => {
  const key = $("#api-key").value.trim();
  const st = $("#key-status");
  if (!key) { st.className = "key-status err"; st.textContent = "Please paste a key."; return; }
  st.className = "key-status"; st.textContent = "Verifying…";
  $("#save-key").disabled = true;
  try {
    const r = await fetch("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gemini_api_key: key }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || "Could not verify key");
    CONFIGURED = true;
    st.className = "key-status ok"; st.textContent = "Connected ✓";
    setTimeout(closeSettings, 700);
  } catch (e) {
    st.className = "key-status err"; st.textContent = e.message;
  }
  $("#save-key").disabled = false;
});

async function boot() {
  try {
    const c = await (await fetch("/api/config")).json();
    CONFIGURED = !!c.configured;
  } catch (e) {}
  try {
    const cap = await (await fetch("/api/capabilities")).json();
    SAM_AVAILABLE = !!cap.sam;
  } catch (e) {}
  if (!CONFIGURED) openSettings();
}
boot();
