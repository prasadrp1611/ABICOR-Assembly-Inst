const $ = (s) => document.querySelector(s);
let pollTimer = null;
let currentJob = null;
let CONFIGURED = false;
let SAM_AVAILABLE = false;
let HL_MODE = "box";
let lastInstructions = "";   // persists the refine/rerun prompt across re-renders

// ---- fun mode (easter egg): plays audio while a job is parsing ----
let FUN = false;
const funAudio = new Audio("/static/funmode.mp3");
funAudio.loop = true;
funAudio.volume = 0.85;
function funStop() { try { funAudio.pause(); funAudio.currentTime = 0; } catch (e) {} }
$("#fun-btn").addEventListener("click", () => {
  FUN = !FUN;
  $("#fun-btn").classList.toggle("on", FUN);
  if (!FUN) funStop();
  else if (currentJob) funAudio.play().catch(() => {});
});

// ---- file pickers (click + drag/drop, single dialog) ----
function wireDrop(dropId, inputId, nameId, label) {
  const drop = $("#" + dropId), input = $("#" + inputId), name = $("#" + nameId);
  const show = () => {
    if (input.files.length > 1) {
      name.textContent = `${input.files.length} files selected`;
      drop.classList.add("set");
    } else if (input.files.length === 1) {
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
wireDrop("pdf-drop", "parts_pdf", "pdf-name", "optional · BoM / spare parts / datasheets · multiple");

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
  for (const pf of $("#parts_pdf").files) fd.append("parts_pdf", pf);
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
    $("#howto-card") && $("#howto-card").classList.add("hidden");
    $("#progress-card").classList.remove("hidden");
    $("#result").classList.add("hidden");
    if (FUN) funAudio.play().catch(() => {});
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
      if (s.status === "done") { funStop(); return showResult(); }
      if (s.status === "error") { funStop(); return showError(s); }
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

async function doRerun() {
  const instr = $("#refine-text").value.trim();
  lastInstructions = instr;
  const btn = $("#rerun-btn");
  btn.disabled = true; btn.textContent = "Re-running…";
  try {
    const r = await fetch(`/api/jobs/${currentJob}/rerun`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: instr }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || "rerun failed"); }
    $("#result").classList.add("hidden");
    $("#progress-card").classList.remove("hidden");
    $("#stage-msg").textContent = "Re-running with your instructions…";
    $("#bar").style.width = "0%";
    $("#progress-card").scrollIntoView({ behavior: "smooth" });
    if (FUN) funAudio.play().catch(() => {});
    poll();
  } catch (e) {
    alert("Rerun failed: " + e.message);
    btn.disabled = false; btn.textContent = "↻ Rerun analysis";
  }
}

// ---- render result ----
let resultData = null;
const chosenFrame = {};    // step -> picked frame filename, or null = video snippet
const currentImage = {};   // step -> filename currently displayed (frame OR segmented), null = video
let templateSettings = null;   // editable Word-template fields

const secOf = (ts) => {
  const p = String(ts).split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
};
const pad2 = (n) => String(n).padStart(2, "0");
const defFrame = (n) => `step_${pad2(n)}.jpg`;
const frameURL = (name) => name && name.startsWith("up_")
  ? `/api/jobs/${currentJob}/uploads/${name}` : `/api/jobs/${currentJob}/frames/${name}`;

async function showResult() {
  resultData = await (await fetch(`/api/jobs/${currentJob}/result`)).json();
  templateSettings = null;
  $("#progress-card").classList.add("hidden");
  const root = $("#result");
  root.classList.remove("hidden");
  root.innerHTML = renderDoc(resultData);

  $("#dl-json").addEventListener("click", () =>
    download(`${(resultData.product.model || "assembly").replace(/\s+/g, "_")}.json`, resultData));
  $("#new-job").addEventListener("click", () => location.reload());
  $("#toggle-edit").addEventListener("click", toggleEdit);
  $("#export-docx").addEventListener("click", openTemplate);

  // refine & rerun
  $("#toggle-refine").addEventListener("click", () => $("#refine").classList.toggle("hidden"));
  $("#refine-text").value = lastInstructions;
  document.querySelectorAll(".refine-presets button").forEach((b) =>
    b.addEventListener("click", () => {
      const t = $("#refine-text");
      t.value = (t.value.trim() ? t.value.trim() + " " : "") + b.dataset.add;
      t.focus();
    }));
  $("#rerun-btn").addEventListener("click", doRerun);

  const samBtn = $("#sam-btn");
  if (samBtn && !SAM_AVAILABLE) { samBtn.disabled = true; samBtn.title = "SAM backend unavailable"; }
  $("#hl-mode") && $("#hl-mode").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.disabled) return;
      HL_MODE = b.dataset.mode;
      $("#hl-mode").querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    }));

  initSteps();
  resetForm();
  root.scrollIntoView({ behavior: "smooth" });
}

// ---- per-step media controllers ----
function initSteps() {
  document.querySelectorAll(".step").forEach((el) => {
    const n = el.dataset.step, start = +el.dataset.start, end = +el.dataset.end;
    const vid = document.getElementById(`vid-${n}`);
    const still = document.getElementById(`img-${n}`);
    chosenFrame[n] = null;
    currentImage[n] = null;

    // section video snippet via media fragment (autoplay + loop the fragment, muted)
    vid.src = `/api/jobs/${currentJob}/video#t=${start},${end}`;
    const seekStart = () => { try { vid.currentTime = start; } catch (e) {} };
    vid.addEventListener("loadedmetadata", () => { seekStart(); vid.play().catch(() => {}); });
    vid.addEventListener("timeupdate", () => {
      if (vid.currentTime >= end || vid.currentTime < start - 0.2) seekStart();
    });

    el.querySelector(".frame-sel").addEventListener("mousedown",
      (e) => loadFrameOptions(n, e.target), { once: true });
    el.querySelector(".frame-sel").addEventListener("change", (e) => onFrameSel(n, e.target));
    el.querySelector(".part-sel").addEventListener("change", (e) => onPartSel(n, e.target));
    el.querySelector(".media").addEventListener("click", (e) => {
      if (e.target.closest("select")) return;
      openLightbox(n);
    });
  });
}

async function loadFrameOptions(n, sel) {
  if (sel.dataset.loaded) return;
  sel.dataset.loaded = "1";
  try {
    const { options } = await (await fetch(`/api/jobs/${currentJob}/frame_options?step=${n}&count=6`)).json();
    options.forEach((o) => {
      if ([...sel.options].some((x) => x.value === o.name)) return;
      const opt = document.createElement("option");
      opt.value = o.name; opt.textContent = `Frame @ ${o.t}s`;
      sel.appendChild(opt);
    });
  } catch (e) {}
}

function showVideo(n) {
  document.getElementById(`vid-${n}`).classList.remove("hidden");
  document.getElementById(`img-${n}`).classList.add("hidden");
}
function showStill(n, url) {
  const vid = document.getElementById(`vid-${n}`), img = document.getElementById(`img-${n}`);
  vid.pause(); vid.classList.add("hidden");
  img.src = url; img.classList.remove("hidden");
}

function onFrameSel(n, sel) {
  const v = sel.value;
  const badge = document.getElementById(`badge-${n}`);
  if (v === "__video") {
    chosenFrame[n] = null; currentImage[n] = null; showVideo(n);
    document.getElementById(`vid-${n}`).play().catch(() => {});
    badge.textContent = "▶ section";
  } else {
    const frame = v === "__default" ? defFrame(n) : v;
    chosenFrame[n] = frame; currentImage[n] = frame;
    showStill(n, frameURL(frame));
    badge.textContent = "🖼 frame · in doc";
    const psel = document.querySelector(`.part-sel[data-step="${n}"]`);
    if (psel && psel.value) onPartSel(n, psel);    // re-highlight on the new frame
  }
}

async function onPartSel(n, sel) {
  const v = sel.value;
  const badge = document.getElementById(`badge-${n}`);
  if (!v) {                                         // off -> back to frame or video
    if (chosenFrame[n]) { showStill(n, frameURL(chosenFrame[n])); currentImage[n] = chosenFrame[n]; }
    else { showVideo(n); document.getElementById(`vid-${n}`).play().catch(() => {}); currentImage[n] = null; }
    badge.textContent = chosenFrame[n] ? "🖼 frame · in doc" : "▶ section";
    return;
  }
  const label = v === "__all" ? "" : v;
  const frame = chosenFrame[n] || defFrame(n);
  badge.textContent = HL_MODE === "sam" ? "⏳ segmenting…" : "⏳ locating…";
  try {
    const q = `step=${n}&mode=${HL_MODE}&frame=${encodeURIComponent(frame)}` +
              (label ? `&label=${encodeURIComponent(label)}` : "");
    const d = await (await fetch(`/api/jobs/${currentJob}/highlight?${q}`)).json();
    currentImage[n] = d.url.split("?")[0].split("/").pop();   // segmented image -> used in docx
    showStill(n, d.url + "?t=" + Date.now());
    const tag = d.mode === "sam" ? (d.backend || "SAM").toUpperCase() : "boxes";
    badge.textContent = d.count ? `🎯 ${d.detections.join(", ")} · ${tag} · in doc` : `no match · ${tag}`;
  } catch (e) { badge.textContent = "⚠ failed"; }
}

// ---- lightbox ----
function openLightbox(n) {
  const img = document.getElementById(`img-${n}`);
  const showingStill = !img.classList.contains("hidden");
  let box = $("#lightbox");
  if (!box) {
    box = document.createElement("div");
    box.id = "lightbox"; box.className = "lightbox";
    box.innerHTML = `<button class="lb-close">✕</button><div class="lb-body"></div>`;
    document.body.appendChild(box);
    box.addEventListener("click", (e) => { if (e.target === box || e.target.classList.contains("lb-close")) box.classList.remove("show"); });
  }
  const body = box.querySelector(".lb-body");
  if (showingStill) {
    body.innerHTML = `<img src="${img.src}"/>`;
  } else {
    const el = document.querySelector(`.step[data-step="${n}"]`);
    body.innerHTML = `<video src="/api/jobs/${currentJob}/video#t=${el.dataset.start},${el.dataset.end}" autoplay loop muted controls></video>`;
  }
  box.classList.add("show");
}

// ---- inline edit + Word export ----
function toggleEdit() {
  const on = $("#result").classList.toggle("editing");
  $("#toggle-edit").textContent = on ? "✓ Done" : "✎ Edit";
  $("#toggle-edit").classList.toggle("active", on);
  document.querySelectorAll(".step-title-text,.pt-text,.goal-edit").forEach((e) => {
    e.contentEditable = on ? "true" : "false";
  });
}

function buildExportModel() {
  const d = resultData;
  const steps = [];
  d.stations.forEach((st) => st.steps.forEach((s) => {
    const n = s.step_number;
    const tEl = document.querySelector(`.step-title-text[data-step="${n}"]`);
    const bullets = [...document.querySelectorAll(`.pt-text[data-step="${n}"]`)]
      .map((e) => e.textContent.trim()).filter(Boolean);
    steps.push({
      include: true, number: n,
      title: tEl ? tEl.textContent.trim() : s.title,
      goal: s.goal,
      bullets: bullets.length ? bullets : s.instructions.map((i) => i.text),
      image: currentImage[n] || chosenFrame[n] || defFrame(n),
      narration_de: (s.narration && s.narration.original_text) || "",
      narration_en: (s.narration && s.narration.english_text) || "",
      parts: (s.components || []).filter((c) => c.part_id).map((c) => ({ name: c.name, part_no: c.part_id })),
    });
  }));
  return { settings: { ...(templateSettings || defaultTemplate()) }, steps };
}

// ---- editable Word template ----
function defaultTemplate() {
  const d = resultData;
  return {
    header_title: "BINZEL standard", doc_title: "Assembly instruction",
    doc_subtitle: "Montageanweisung", mro_label: "MRO.",
    product_name: d.product.name || "", model: d.product.model || "",
    id_number: d.product.id_number || "", document_no: d.product.id_number || "",
    station_title: (d.stations[0] && d.stations[0].station_title) || "Station 1: Final Assembly",
    drawn_by: "AI Documentation Engine", date: new Date().toLocaleDateString("de-DE"),
    bilingual: false, include_goal: true, include_narration: false, include_part_ids: true,
    header_logo: "",
  };
}
function openTemplate() {
  if (!templateSettings) templateSettings = defaultTemplate();
  const s = templateSettings;
  const set = (id, v) => { $(id).value = v == null ? "" : v; };
  set("#t-header-title", s.header_title); set("#t-doc-title", s.doc_title);
  set("#t-doc-sub", s.doc_subtitle); set("#t-mro", s.mro_label);
  set("#t-product", s.product_name); set("#t-model", s.model);
  set("#t-docno", s.document_no); set("#t-station", s.station_title);
  set("#t-drawnby", s.drawn_by); set("#t-date", s.date);
  $("#t-goal").checked = s.include_goal; $("#t-parts").checked = s.include_part_ids;
  $("#t-narr").checked = s.include_narration; $("#t-biling").checked = s.bilingual;
  $("#tmpl-modal").classList.remove("hidden");
}
function readTemplate() {
  const s = templateSettings || (templateSettings = defaultTemplate());
  s.header_title = $("#t-header-title").value; s.doc_title = $("#t-doc-title").value;
  s.doc_subtitle = $("#t-doc-sub").value; s.mro_label = $("#t-mro").value;
  s.product_name = $("#t-product").value; s.model = $("#t-model").value;
  s.document_no = s.id_number = $("#t-docno").value; s.station_title = $("#t-station").value;
  s.drawn_by = $("#t-drawnby").value; s.date = $("#t-date").value;
  s.include_goal = $("#t-goal").checked; s.include_part_ids = $("#t-parts").checked;
  s.include_narration = $("#t-narr").checked; s.bilingual = $("#t-biling").checked;
  return s;
}
async function templateGenerate() {
  readTemplate();
  const f = $("#t-logo").files[0];
  if (f) {
    try {
      const fd = new FormData(); fd.append("image", f);
      const d = await (await fetch(`/api/jobs/${currentJob}/images`, { method: "POST", body: fd })).json();
      templateSettings.header_logo = d.name;
    } catch (e) {}
  }
  $("#tmpl-modal").classList.add("hidden");
  await exportWord();
}

async function exportWord() {
  const btn = $("#tmpl-gen"); if (btn) { btn.disabled = true; btn.textContent = "Building…"; }
  try {
    const r = await fetch(`/api/jobs/${currentJob}/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildExportModel()),
    });
    if (!r.ok) throw new Error("export failed");
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = ((templateSettings && templateSettings.model) || resultData.product.model
      || "assembly_instruction").replace(/\s+/g, "_") + ".docx";
    a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { alert("Export failed: " + e.message); }
  if (btn) { btn.disabled = false; btn.textContent = "⬇ Generate .docx"; }
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
        <button class="btn-primary" id="toggle-refine">↻ Refine &amp; Rerun</button>
        <button class="btn-ghost" id="toggle-edit">✎ Edit</button>
        <button class="btn-ghost" id="export-docx">⬇ Export Word</button>
        <button class="btn-ghost" id="dl-json">⬇ JSON</button>
        <button class="btn-ghost" id="new-job">+ New video</button>
      </div>
      <div class="refine hidden" id="refine">
        <div class="refine-title">Tell the AI what to change, then re-run on the same video:</div>
        <div class="refine-presets">
          <button type="button" data-add="Break the procedure into more, smaller steps — ideally one action per step.">+ More steps</button>
          <button type="button" data-add="Combine into fewer, higher-level steps.">− Fewer steps</button>
          <button type="button" data-add="Be much more verbose: add more detail and more instruction points per step.">More verbose</button>
          <button type="button" data-add="Add explicit safety warnings wherever relevant.">⚠ Safety notes</button>
          <button type="button" data-add="Use simpler, beginner-friendly language.">Simpler language</button>
          <button type="button" data-add="Identify and name every tool and fastener used.">Name all tools</button>
        </div>
        <textarea id="refine-text" placeholder="e.g. Split each screw into its own step and mention the exact tool used. Be very detailed."></textarea>
        <button class="btn-primary" id="rerun-btn">↻ Rerun analysis</button>
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
  const n = step.step_number;
  const start = secOf(step.timestamp_start);
  const end = Math.max(start + 1, secOf(step.timestamp_end || step.timestamp_start));
  const points = step.instructions.map((i) => `
    <li><span class="pt-n"></span>
      <span class="act ${i.action_type}">${i.action_type.replace("_", " ")}</span>
      <span class="pt-text" data-step="${n}">${esc(i.text)}</span></li>`).join("");

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
  const nar = step.narration || {};
  const narr = (nar.original_text || nar.english_text) ? `
    <details class="narr"><summary>Narration</summary>
      <div class="narr-body"><div class="orig">${esc(nar.original_text || "")}</div>
        <div>${esc(nar.english_text || "")}</div></div></details>` : "";
  const partOpts = (step.components || [])
    .map((c) => `<option value="${esc(c.name)}">▸ ${esc(c.name)}</option>`).join("");

  return `
  <div class="step" data-step="${n}" data-start="${start}" data-end="${end}">
    <div class="media-col">
      <div class="media" data-step="${n}" title="click to enlarge">
        <video class="snip" id="vid-${n}" muted loop playsinline preload="metadata"></video>
        <img class="still hidden" id="img-${n}" onerror="this.style.opacity=.25"/>
        <span class="media-badge" id="badge-${n}">▶ section</span>
      </div>
      <div class="media-ctrl">
        <select class="frame-sel" data-step="${n}" title="pick the image to use">
          <option value="__video">▶ Video snippet</option>
          <option value="__default">🖼 Frame @ ${esc(step.timestamp_start)}</option>
        </select>
        <select class="part-sel" data-step="${n}" title="highlight / segment a part">
          <option value="">🎯 Highlight: off</option>
          <option value="__all">All parts</option>
          ${partOpts}
        </select>
      </div>
    </div>
    <div class="text-col">
      <div class="step-title"><span class="step-num">${n}</span>
        <span class="step-title-text" data-step="${n}">${esc(step.title)}</span>
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

// template editor modal (elements always present in the DOM)
$("#tmpl-close").addEventListener("click", () => $("#tmpl-modal").classList.add("hidden"));
$("#tmpl-modal").addEventListener("click", (e) => { if (e.target.id === "tmpl-modal") $("#tmpl-modal").classList.add("hidden"); });
$("#tmpl-reset").addEventListener("click", () => { templateSettings = defaultTemplate(); openTemplate(); });
$("#tmpl-gen").addEventListener("click", templateGenerate);

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
