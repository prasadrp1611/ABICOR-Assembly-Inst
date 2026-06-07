const $ = (s) => document.querySelector(s);
let pollTimer = null;
let currentJob = null;
let CONFIGURED = false;
let SAM_AVAILABLE = false;
let HL_MODE = "box";
let lastInstructions = "";   // persists the refine/rerun prompt across re-renders
let MODE = "byok";                                   // "gateway" (access codes) | "byok" (raw key)
let ACCESS = localStorage.getItem("abicor_access") || "";   // revocable access code (gateway mode)
// attach the access code to every gated request (no-op in byok mode)
const authH = (extra) => Object.assign({}, extra || {}, ACCESS ? { "X-Access-Code": ACCESS } : {});

// ---- fun mode (easter egg): the fun button swaps the main-page tutorial video
//      for a meme video (in place) and plays the bing-bong mp3 as the soundtrack ----
let FUN = false;
const FUN_VIDEO_ID = "EaCUyNQWY2M";
const HOWTO_MEDIA =
  `<video class="howto-video" src="/static/howto.mp4" controls preload="metadata" poster="/static/genius.png"></video>`;
// "silent" = muted party preview (home page) · "loud" = with sound (during the wait) · "off" = restore
function funVideo(mode) {
  const media = $("#howto-media");
  if (!media) return;
  if (mode === "off") { media.innerHTML = HOWTO_MEDIA; return; }
  const mute = mode === "silent" ? 1 : 0;
  media.innerHTML =
    `<iframe class="howto-video" src="https://www.youtube.com/embed/${FUN_VIDEO_ID}` +
    `?autoplay=1&mute=${mute}&loop=1&playlist=${FUN_VIDEO_ID}&rel=0&playsinline=1&modestbranding=1" ` +
    `allow="autoplay; encrypted-media; fullscreen" ` +
    `referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
}
function confettiBurst() {
  const colors = ["#ff2db8", "#7a00ff", "#ffd000", "#00e0c0", "#ff5a5a", "#4fa8ff"];
  for (let i = 0; i < 110; i++) {
    const c = document.createElement("div");
    c.className = "confetti";
    c.style.left = Math.random() * 100 + "vw";
    c.style.background = colors[i % colors.length];
    c.style.animationDelay = (Math.random() * 0.7) + "s";
    const sz = 6 + Math.random() * 9;
    c.style.width = c.style.height = sz + "px";
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4500);
  }
}
function toggleFun() {
  FUN = !FUN;
  document.body.classList.toggle("fun-mode", FUN);   // party theme applies everywhere
  $("#fun-btn").classList.toggle("on", FUN);
  if (FUN) {
    $("#howto-card") && $("#howto-card").classList.remove("hidden");  // show the party video anywhere
    funVideo("loud");                                                 // full party — sound on immediately
    confettiBurst();
  } else {
    funVideo("off");
  }
}
$("#fun-btn").addEventListener("click", toggleFun);

// ---- file pickers (click + drag/drop, single dialog) ----
// If the access key/code isn't set yet, prompt for it first — before they pick a file.
function requireKey() {
  if (!CONFIGURED) { openSettings(); return true; }
  return false;
}
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
  // open the native dialog exactly once — but ask for the access key first if missing
  drop.addEventListener("click", () => { if (requireKey()) return; input.click(); });
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (requireKey()) return; input.click(); }
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
    if (requireKey()) return;
    if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; show(); }
  });
}
wireDrop("video-drop", "video", "video-name", "drag & drop or click · mp4 · mov");
wireDrop("pdf-drop", "parts_pdf", "pdf-name", "optional · BoM / spare parts / datasheets · multiple");

// ---- submit ----
$("#job-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (requireKey()) return;
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
    const r = await fetch("/api/jobs", { method: "POST", body: fd, headers: authH() });
    if (!r.ok) {
      if (r.status === 401) { openSettings(); throw new Error("Your access code is missing, invalid, or revoked."); }
      throw new Error("upload failed (" + r.status + ")");
    }
    const { job_id } = await r.json();
    currentJob = job_id;
    window.currentJob = job_id;   // expose for the Report-a-problem widget
    loadSessions();               // new session appears in the sidebar
    $("#upload-card").classList.add("hidden");
    if (!FUN) $("#howto-card") && $("#howto-card").classList.add("hidden");  // fun: keep party video playing
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
  $("#howto-card") && $("#howto-card").classList.add("hidden");
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
      method: "POST", headers: authH({ "Content-Type": "application/json" }),
      body: JSON.stringify({ instructions: instr }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || "rerun failed"); }
    $("#result").classList.add("hidden");
    $("#progress-card").classList.remove("hidden");
    $("#stage-msg").textContent = "Re-running with your instructions…";
    $("#bar").style.width = "0%";
    $("#progress-card").scrollIntoView({ behavior: "smooth" });
    if (FUN) { $("#howto-card") && $("#howto-card").classList.remove("hidden"); funVideo("loud"); }
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
let partChoice = {};           // "step:compIndex" -> chosen part number (user override)

const secOf = (ts) => {
  const p = String(ts).split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
};
const pad2 = (n) => String(n).padStart(2, "0");
const defFrame = (n) => `step_${pad2(n)}.jpg`;
const frameURL = (name) => name && name.startsWith("up_")
  ? `/api/jobs/${currentJob}/uploads/${name}` : `/api/jobs/${currentJob}/frames/${name}`;

async function showResult() {
  loadSessions();
  resultData = await (await fetch(`/api/jobs/${currentJob}/result`)).json();
  $("#howto-card") && $("#howto-card").classList.add("hidden");   // stop the meme when results show
  templateSettings = null;
  partChoice = {};
  for (const st of resultData.stations)
    for (const s of st.steps)
      (s.components || []).forEach((c, ci) => {
        const cands = c.part_candidates || [];
        partChoice[`${s.step_number}:${ci}`] = c.part_id || (cands[0] ? cands[0].part_no : "");
      });
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
  if (samBtn && !SAM_AVAILABLE) { samBtn.disabled = true; samBtn.title = "Precise highlight isn't available on this machine"; }
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
    el.querySelectorAll(".pt-shot").forEach((im) =>
      im.addEventListener("click", () => openImageLightbox(im.dataset.img)));

    // Part-ID pickers (confidence-ranked) + custom override
    el.querySelectorAll(".part-pick").forEach((sel) => {
      const ci = sel.dataset.ci;
      const key = `${n}:${ci}`;
      const custom = el.querySelector(`.part-custom[data-ci="${ci}"]`);
      sel.addEventListener("change", () => {
        if (sel.value === "__custom") {
          custom.classList.remove("hidden");
          custom.focus();
          partChoice[key] = custom.value.trim();
          if (custom.value.trim()) { persistPartChoice(n, ci, custom.value.trim()); flashSaved(sel); }
        } else {
          if (custom) custom.classList.add("hidden");
          partChoice[key] = sel.value;
          persistPartChoice(n, ci, sel.value); flashSaved(sel);
        }
      });
      if (custom) {
        custom.addEventListener("input", () => { partChoice[key] = custom.value.trim(); });
        custom.addEventListener("change", () => { persistPartChoice(n, ci, custom.value.trim()); flashSaved(custom); });
      }
    });
  });
}

async function persistPartChoice(step, ci, partNo) {
  // keep the in-memory result in sync so a JSON download reflects the choice
  for (const st of resultData.stations)
    for (const s of st.steps)
      if (s.step_number == step) {
        const c = (s.components || [])[ci];
        if (c) { c.part_id = partNo; c.part_id_user_set = true; }
      }
  try {
    await fetch(`/api/jobs/${currentJob}/part_choice`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: +step, ci: +ci, part_no: partNo }),
    });
  } catch (e) {}
}
function flashSaved(el) {
  el.classList.add("saved");
  setTimeout(() => el.classList.remove("saved"), 900);
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
  badge.textContent = HL_MODE === "sam" ? "⏳ tracing the exact shape…" : "⏳ locating…";
  try {
    const q = `step=${n}&mode=${HL_MODE}&frame=${encodeURIComponent(frame)}` +
              (label ? `&label=${encodeURIComponent(label)}` : "");
    const d = await (await fetch(`/api/jobs/${currentJob}/highlight?${q}`, { headers: authH() })).json();
    currentImage[n] = d.url.split("?")[0].split("/").pop();   // segmented image -> used in docx
    showStill(n, d.url + "?t=" + Date.now());
    const tag = d.mode === "sam" ? "precise highlight" : "outline";
    badge.textContent = d.count ? `🎯 ${d.detections.join(", ")} · ${tag} · in doc` : `no match · ${tag}`;
  } catch (e) { badge.textContent = "⚠ failed"; }
}

// ---- lightbox ----
function ensureLightbox() {
  let box = $("#lightbox");
  if (!box) {
    box = document.createElement("div");
    box.id = "lightbox"; box.className = "lightbox";
    box.innerHTML = `<button class="lb-close">✕</button><div class="lb-body"></div>`;
    document.body.appendChild(box);
    box.addEventListener("click", (e) => {
      if (e.target === box || e.target.classList.contains("lb-close")) box.classList.remove("show");
    });
  }
  return box;
}
function openImageLightbox(url) {
  const box = ensureLightbox();
  box.querySelector(".lb-body").innerHTML = `<img src="${url}"/>`;
  box.classList.add("show");
}

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
      parts: (s.components || []).map((c, ci) => {
        const key = `${n}:${ci}`;
        const pn = key in partChoice ? partChoice[key] : (c.part_id || "");
        return pn ? { name: c.name, part_no: pn } : null;
      }).filter(Boolean),
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
          <button data-mode="box" class="active">Outline</button>
          <button data-mode="sam" id="sam-btn">Precise highlight</button>
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
  const points = step.instructions.map((i) => {
    const thumb = i.image
      ? `<img class="pt-shot" src="${frameURL(i.image)}" data-img="${frameURL(i.image)}"
           title="${esc(i.timestamp || "")}" loading="lazy" onerror="this.remove()"/>` : "";
    return `<li><span class="pt-n"></span>
      <span class="act ${i.action_type}">${i.action_type.replace("_", " ")}</span>
      <span class="pt-text" data-step="${n}">${esc(i.text)}</span>${thumb}</li>`;
  }).join("");

  const hasCandidates = (step.components || []).some((c) => c.part_candidates && c.part_candidates.length);
  // without a product document there are no candidates → show component names only (no part IDs)
  const comps = (step.components || []).map((c) =>
    `<span class="chip">${esc(c.name)}</span>`).join("");

  // when product docs were supplied, show a confidence-ranked Part-ID dropdown per component
  const compPicks = (step.components || []).map((c, ci) => {
    const cands = c.part_candidates || [];
    if (!cands.length) return `<div class="comp-row"><span class="comp-name">${esc(c.name)}</span></div>`;
    const effPid = c.part_id || cands[0].part_no;        // default = highest-confidence match
    const isCustom = !!(effPid && !cands.some((pc) => pc.part_no === effPid));
    const opts = cands.map((pc) => {
      const pct = Math.round(pc.confidence * 100);
      const sel = (!isCustom && pc.part_no === effPid) ? " selected" : "";
      return `<option value="${esc(pc.part_no)}"${sel}>${esc(pc.part_no)} — ${esc(pc.official_name)} · ${pct}%</option>`;
    }).join("");
    const noneSel = !effPid ? " selected" : "";
    const userSet = c.part_id_user_set ? ` <span class="saved-tag">✓ set</span>` : "";
    return `
      <div class="comp-row">
        <span class="comp-name">${esc(c.name)}${userSet}</span>
        <select class="part-pick" data-step="${n}" data-ci="${ci}">
          <option value=""${noneSel}>— no part —</option>
          ${opts}
          <option value="__custom"${isCustom ? " selected" : ""}>✎ Custom…</option>
        </select>
        <input class="part-custom ${isCustom ? "" : "hidden"}" data-step="${n}" data-ci="${ci}"
               placeholder="part no." value="${isCustom ? esc(c.part_id) : ""}"/>
      </div>`;
  }).join("");

  const tools = (step.tools || []).map((t) => `<span class="chip">${esc(t)}</span>`).join("");
  const deictic = (step.deictic_references || []).map((x) =>
    `<div class="deictic">“<b>${esc(x.utterance)}</b>” → ${esc(x.refers_to)}</div>`).join("");
  const tips = (step.tips || []).map((t) => `<div class="tip">💡 ${esc(t)}</div>`).join("");
  const warns = (step.warnings || []).map((t) => `<div class="warn">⚠ ${esc(t)}</div>`).join("");
  // language-aware narration (seamless: no redundant English for English videos)
  const nar = step.narration || {};
  const lang = (nar.original_language || "").toLowerCase().slice(0, 2);
  const isEN = lang === "en" || lang === "";
  const orig = (nar.original_text || "").trim();
  const en = (nar.english_text || "").trim();
  const LANGS = { de: "German", en: "English", fr: "French", es: "Spanish", it: "Italian",
    pt: "Portuguese", nl: "Dutch", pl: "Polish", tr: "Turkish", zh: "Chinese", ja: "Japanese",
    ko: "Korean", ru: "Russian", ar: "Arabic", hi: "Hindi", sv: "Swedish", cs: "Czech" };
  const langName = LANGS[lang] || (nar.original_language || "Original");
  let narrBody = "";
  if (orig) narrBody += `<div class="orig"><span class="nlang">${esc(langName)}</span> ${esc(orig)}</div>`;
  if (en && !isEN && en.toLowerCase() !== orig.toLowerCase())
    narrBody += `<div class="nen"><span class="nlang">English</span> ${esc(en)}</div>`;
  const narr = narrBody
    ? `<details class="narr"><summary>Narration</summary><div class="narr-body">${narrBody}</div></details>` : "";
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
          ${step.instructions.filter((i) => i.image).map((i, k) =>
            `<option value="${esc(i.image)}">🖼 Sub-step ${k + 1} @ ${esc(i.timestamp || "")}</option>`).join("")}
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
      ${hasCandidates
        ? `<div class="block-label">Components &amp; Part&nbsp;IDs <span class="hint-sm">(pick the correct match)</span></div>${compPicks}`
        : (comps ? `<div class="block-label">Components</div><div class="chips">${comps}</div>` : "")}
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

// ---- settings / access code or API key + capabilities ----
function applySettingsCopy() {
  const t = $("#settings-title"), h = $("#settings-help"), inp = $("#api-key"), btn = $("#save-key");
  if (!inp) return;
  if (MODE === "gateway") {
    if (t) t.textContent = "Enter your access code";
    if (h) h.textContent = "Paste the access code you were given. It connects you to the AI engine " +
      "and can be revoked by the operator at any time. Stored on this device only.";
    inp.placeholder = "ABICOR-XXXX-XXXX";
    if (btn) btn.textContent = "Connect";
  } else {
    if (t) t.textContent = "Connect the AI engine";
    if (h) h.textContent = "Paste your access key to enable the engine. It is stored locally on this " +
      "machine only and never shown again.";
    inp.placeholder = "Paste your API key…";
    if (btn) btn.textContent = "Save & verify";
  }
}
function openSettings() {
  applySettingsCopy();
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
$("#t-template").addEventListener("change", (e) => {
  e.target.value = "";
  alert("Custom output templates are coming soon. For now the document uses the ABICOR BINZEL template — edit its fields above.");
});

$("#save-key").addEventListener("click", async () => {
  const val = $("#api-key").value.trim();
  const st = $("#key-status");
  if (!val) {
    st.className = "key-status err";
    st.textContent = MODE === "gateway" ? "Please paste your access code." : "Please paste a key.";
    return;
  }
  st.className = "key-status"; st.textContent = "Verifying…";
  $("#save-key").disabled = true;
  try {
    if (MODE === "gateway") {
      const r = await fetch("/api/access/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: val }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || "That access code was rejected.");
      ACCESS = val; localStorage.setItem("abicor_access", val);
      CONFIGURED = true;
      st.className = "key-status ok"; st.textContent = (d.label ? "Welcome, " + d.label + " — " : "") + "connected ✓";
    } else {
      const r = await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gemini_api_key: val }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || "Could not verify key");
      CONFIGURED = true;
      st.className = "key-status ok"; st.textContent = "Connected ✓";
    }
    setTimeout(closeSettings, 700);
  } catch (e) {
    st.className = "key-status err"; st.textContent = e.message;
  }
  $("#save-key").disabled = false;
});

// ---- session sidebar (all past / active / archived documents) ----
const fmtWhen = (t) => {
  if (!t) return "";
  const d = new Date(t * 1000), diff = Date.now() / 1000 - t;
  if (diff < 3600) return Math.max(1, Math.floor(diff / 60)) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return d.toLocaleDateString();
};
function sessionName(j) {
  const o = j.options || {};
  return o.product_model || o.product_name || (j.video || "").replace(/\.[^.]+$/, "")
    || ("Document " + (j.id || "").slice(0, 6));
}
function badgeFor(j) {
  if (j.status === "done") return '<span class="sb-badge done">done</span>';
  if (j.status === "error") return '<span class="sb-badge err">error</span>';
  return '<span class="sb-badge run">…</span>';
}
async function loadSessions() {
  const list = $("#session-list");
  if (!list) return;
  let jobs = [];
  try { jobs = await (await fetch("/api/jobs")).json(); } catch (e) { return; }
  if (!jobs.length) {
    list.innerHTML = '<div class="sb-empty">No documents yet.<br>Click “＋ New document”.</div>';
    return;
  }
  const sort = ($("#sb-sort") && $("#sb-sort").value) || "recent";
  jobs.sort((a, b) => {
    if (sort === "name") return sessionName(a).localeCompare(sessionName(b));
    const ta = a.created_at || 0, tb = b.created_at || 0;
    return sort === "oldest" ? ta - tb : tb - ta;   // recent = newest first
  });
  const card = (j) => `<div class="sb-card${j.id === currentJob ? " active" : ""}" data-id="${j.id}">
      <img class="sb-thumb" src="/api/jobs/${j.id}/frames/step_01.jpg"
           onerror="this.src='/static/genius.png'"/>
      <div class="sb-meta">
        <div class="sb-name">${esc(sessionName(j))}</div>
        <div class="sb-sub">${fmtWhen(j.created_at)}</div>
      </div>
      ${badgeFor(j)}
      <button class="sb-arch-btn" data-arch="${j.id}" data-to="${j.archived ? 0 : 1}"
        title="${j.archived ? "Restore" : "Archive"}">${j.archived ? "↩" : "🗄"}</button>
    </div>`;
  const active = jobs.filter((j) => !j.archived), archived = jobs.filter((j) => j.archived);
  let html = active.map(card).join("");
  if (archived.length) html += '<div class="sb-sec">Archived</div>' + archived.map(card).join("");
  list.innerHTML = html;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-arch]");
  if (a) { e.stopPropagation(); archiveSession(a.dataset.arch, a.dataset.to === "1"); return; }
  const o = e.target.closest("[data-open]");
  if (o) { closeKnowledgeGraph(); openSession(o.dataset.open); return; }   // graph citation → open tutorial
  const c = e.target.closest(".sb-card");
  if (c) openSession(c.dataset.id);
});
async function archiveSession(id, to) {
  try {
    await fetch(`/api/jobs/${id}/archive`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: to }),
    });
  } catch (e) {}
  loadSessions();
}
async function openSession(id) {
  currentJob = id; window.currentJob = id;
  $("#upload-card") && $("#upload-card").classList.add("hidden");
  $("#howto-card") && $("#howto-card").classList.add("hidden");
  let s = {};
  try { s = await (await fetch(`/api/jobs/${id}`)).json(); } catch (e) {}
  if (s.status === "done") showResult();
  else if (s.status === "error") showError(s);
  else { $("#result").classList.add("hidden"); $("#progress-card").classList.remove("hidden"); poll(); }
  loadSessions();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function showUpload() {
  currentJob = null; window.currentJob = null;
  $("#result") && $("#result").classList.add("hidden");
  $("#progress-card") && $("#progress-card").classList.add("hidden");
  $("#upload-card") && $("#upload-card").classList.remove("hidden");
  if (!FUN) $("#howto-card") && $("#howto-card").classList.remove("hidden");
  loadSessions();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---- combined knowledge graph (all sessions merged into one) ----
const KG_COLORS = { Tool: "#e74c3c", Component: "#3498db", Material: "#2ecc71",
  Action: "#f39c12", Property: "#9b59b6", SafetyMeasure: "#e91e63" };
let kgNet = null;
async function openKnowledgeGraph() {
  const modal = $("#kg-modal");
  modal.classList.remove("hidden");
  $("#kg-stats").textContent = " · loading…";
  let d;
  try { d = await (await fetch("/api/knowledge")).json(); }
  catch (e) { $("#kg-stats").textContent = " · failed to load"; return; }
  $("#kg-stats").textContent =
    ` · ${d.stats.n_nodes} entities · ${d.stats.n_edges} links · ${d.stats.n_sessions} videos`;
  $("#kg-legend").innerHTML = Object.entries(KG_COLORS)
    .filter(([k]) => (d.stats.classes || {})[k])
    .map(([k, c]) => `<span><i style="background:${c}"></i>${k} (${d.stats.classes[k]})</span>`).join("");
  if (!window.vis) { $("#kg-stats").textContent = " · graph library not loaded"; return; }
  const nodes = d.nodes.map((n) => ({
    id: n.id, label: n.label, group: n.cls, value: n.sessions,
    color: KG_COLORS[n.cls] || "#95a5a6",
    title: `${n.label} — in ${n.sessions} video(s)`,
  }));
  const edges = d.edges.map((e) => ({ from: e.source, to: e.target, label: e.predicate }));
  if (kgNet) kgNet.destroy();
  try {
    kgNet = new vis.Network($("#kg-canvas"),
      { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) },
      {
        nodes: { shape: "dot", scaling: { min: 8, max: 42 },
          font: { color: "#e8e8f0", size: 13, strokeWidth: 3, strokeColor: "#0e0c16" } },
        edges: { color: { color: "#56546e", highlight: "#C1006F" }, width: 0.6,
          font: { color: "#8a87a0", size: 9, strokeWidth: 0 },
          smooth: { type: "continuous" }, arrows: { to: { enabled: true, scaleFactor: 0.5 } } },
        physics: { stabilization: { iterations: 160 },
          barnesHut: { gravitationalConstant: -9000, springLength: 130, springConstant: 0.03 } },
        interaction: { hover: true, tooltipDelay: 120 },
      });
    kgNet.once("stabilizationIterationsDone", () => kgNet && kgNet.fit({ animation: false }));
  } catch (err) {
    $("#kg-stats").textContent = " · render error: " + (err.message || err);
  }
}
function closeKnowledgeGraph() {
  $("#kg-modal").classList.add("hidden");
  if (kgNet) { kgNet.destroy(); kgNet = null; }
}
async function askKnowledge() {
  const inp = $("#kg-ask"), ans = $("#kg-answer");
  if (!inp) return;
  const q = inp.value.trim();
  if (!q) return;
  ans.classList.remove("hidden");
  ans.innerHTML = '<div class="kg-ans-text">Traversing the graph…</div>';
  try {
    const r = await fetch("/api/ask", {
      method: "POST", headers: authH({ "Content-Type": "application/json" }),
      body: JSON.stringify({ question: q }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { ans.innerHTML = `<div class="kg-ans-text">${esc(d.detail || "Couldn't answer that.")}</div>`; return; }
    let html = `<div class="kg-ans-text">${esc(d.answer || "Nothing found in the knowledge base for that.")}</div>`;
    if (d.sessions && d.sessions.length) {
      html += '<div class="kg-ans-label">📹 Demonstrated in — click to open the tutorial</div>';
      html += d.sessions.map((s) =>
        `<span class="kg-chip" data-open="${s.id}"><img src="/api/jobs/${s.id}/frames/step_01.jpg" onerror="this.style.display='none'"/>${esc(s.name)}</span>`
      ).join("");
    }
    ans.innerHTML = html;
  } catch (e) { ans.innerHTML = '<div class="kg-ans-text">Network error — try again.</div>'; }
}

// ---- auto-hiding "peek" footer + collapsible sidebar ----
let _footTimer;
function peekFooter() {
  const f = document.querySelector(".foot");
  if (!f) return;
  f.classList.remove("hide");
  clearTimeout(_footTimer);
  _footTimer = setTimeout(() => f.classList.add("hide"), 4500);   // show, then slide away
}
function toggleSidebar() {
  const collapsed = document.body.classList.toggle("sb-collapsed");
  localStorage.setItem("abicor_sb_collapsed", collapsed ? "1" : "");
}

async function boot() {
  try {
    const c = await (await fetch("/api/config")).json();
    MODE = c.mode || "byok";
    if (MODE === "gateway") {
      if (ACCESS) {                      // silently re-verify a stored code on load
        try {
          const v = await fetch("/api/access/verify", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: ACCESS }),
          });
          CONFIGURED = v.ok;
          if (!v.ok) { ACCESS = ""; localStorage.removeItem("abicor_access"); }
        } catch (e) { CONFIGURED = false; }
      }
    } else {
      CONFIGURED = !!c.engine_ready;
    }
  } catch (e) {}
  try {
    const cap = await (await fetch("/api/capabilities")).json();
    SAM_AVAILABLE = !!cap.sam;
  } catch (e) {}
  applySettingsCopy();
  loadSessions();
  setInterval(loadSessions, 8000);
  $("#sb-new") && $("#sb-new").addEventListener("click", showUpload);
  $("#sb-graph") && $("#sb-graph").addEventListener("click", openKnowledgeGraph);
  $("#kg-close") && $("#kg-close").addEventListener("click", closeKnowledgeGraph);
  $("#kg-ask") && $("#kg-ask").addEventListener("keydown", (e) => { if (e.key === "Enter") askKnowledge(); });
  $("#sb-sort") && $("#sb-sort").addEventListener("change", loadSessions);
  $("#sb-toggle") && $("#sb-toggle").addEventListener("click", toggleSidebar);
  if (localStorage.getItem("abicor_sb_collapsed")) document.body.classList.add("sb-collapsed");
  window.addEventListener("scroll", peekFooter, { passive: true });
  peekFooter();
  if (!CONFIGURED) openSettings();
}
boot();
