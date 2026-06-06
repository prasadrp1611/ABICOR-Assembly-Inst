const $ = (s) => document.querySelector(s);
const JOB = new URLSearchParams(location.search).get("job");
let state = { settings: {}, steps: [] };
let pickerStep = null;

const imgURL = (n) =>
  n && n.startsWith("up_") ? `/api/jobs/${JOB}/uploads/${n}` : `/api/jobs/${JOB}/frames/${n}`;

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- init
async function init() {
  if (!JOB) { $("#doc").innerHTML = "<div class='loading'>No job specified.</div>"; return; }
  const r = await fetch(`/api/jobs/${JOB}/result`);
  if (!r.ok) { $("#doc").innerHTML = "<div class='loading'>Result not found.</div>"; return; }
  buildState(await r.json());
  fillSettings();
  renderDoc();
}

function buildState(d) {
  state.raw = d;
  const today = new Date().toLocaleDateString("de-DE");
  state.settings = {
    product_name: d.product.name || "",
    model: d.product.model || "",
    id_number: d.product.id_number || "",
    station_title: (d.stations[0] && d.stations[0].station_title) || "Station 1: Final Assembly",
    bilingual: false, include_goal: true, include_narration: false, include_part_ids: true,
    date: today, drawn_by: "AI Documentation Engine",
  };
  state.steps = [];
  for (const st of d.stations) {
    for (const s of st.steps) {
      state.steps.push({
        include: true,
        number: s.step_number,
        title: s.title || "",
        goal: s.goal || "",
        bullets: (s.instructions || []).map((i) => i.text),
        image: s.frame_image,
        narration_de: (s.narration && s.narration.original_text) || "",
        narration_en: (s.narration && s.narration.english_text) || "",
        parts: (s.components || [])
          .filter((c) => c.part_id || (c.part_match && c.part_match.confident))
          .map((c) => ({ name: c.name, part_no: c.part_id || (c.part_match && c.part_match.part_no) })),
      });
    }
  }
}

// ---------------------------------------------------------------- settings panel
function fillSettings() {
  $("#s-name").value = state.settings.product_name;
  $("#s-model").value = state.settings.model;
  $("#s-id").value = state.settings.id_number;
  $("#s-station").value = state.settings.station_title;
  const bind = (id, key, render) =>
    $(id).addEventListener("input", (e) => { state.settings[key] = e.target.value; if (render) render(); });
  bind("#s-name", "product_name");
  bind("#s-model", "model");
  bind("#s-id", "id_number");
  bind("#s-station", "station_title", () => { const h = $("#station-h"); if (h) h.textContent = state.settings.station_title; });
  const tog = (id, key) => $(id).addEventListener("change", (e) => (state.settings[key] = e.target.checked));
  tog("#t-goal", "include_goal");
  tog("#t-parts", "include_part_ids");
  tog("#t-narr", "include_narration");
  tog("#t-biling", "bilingual");
}

// ---------------------------------------------------------------- document render
function renderDoc() {
  const s = state.settings;
  $("#doc").innerHTML = `
    <div class="sheet-head">
      <div class="ttl">${esc(s.product_name || "Assembly Instruction")}</div>
      <div class="sub">Montageanweisung · ${esc(s.model || "")}
        ${s.id_number ? "· ID " + esc(s.id_number) : ""}</div>
    </div>
    <div class="sheet-station" id="station-h">${esc(s.station_title)}</div>
    ${state.steps.map((st, i) => stepHTML(st, i)).join("")}`;
}

function stepHTML(st, i) {
  const bullets = st.bullets.map((b, bi) => `
    <div class="bul">
      <span class="dot">›</span>
      <textarea data-idx="${i}" data-field="bullet" data-b="${bi}" rows="1">${esc(b)}</textarea>
      <button class="del" data-act="delbul" data-idx="${i}" data-b="${bi}" title="Remove">✕</button>
    </div>`).join("");
  const parts = st.parts.length
    ? `<div class="eparts">${st.parts.map((p) =>
        `<span class="epart">${esc(p.name)} <b>${esc(p.part_no)}</b></span>`).join("")}</div>` : "";
  return `
  <div class="estep${st.include ? "" : " off"}" id="estep-${i}">
    <div>
      <div class="row1">
        <span class="num">${st.number}</span>
        <input class="title" data-idx="${i}" data-field="title" value="${esc(st.title)}"/>
        <label class="inc"><input type="checkbox" data-act="inc" data-idx="${i}"
           ${st.include ? "checked" : ""}/> include</label>
      </div>
      <textarea class="goal-in" data-idx="${i}" data-field="goal" rows="1"
        placeholder="step goal…">${esc(st.goal)}</textarea>
      ${bullets}
      <button class="add-bul" data-act="addbul" data-idx="${i}">+ add instruction</button>
      ${parts}
    </div>
    <div>
      <div class="imgwrap" data-act="img" data-idx="${i}">
        <img src="${imgURL(st.image)}" loading="lazy"/>
        <div class="hint">click to change / upload image</div>
      </div>
    </div>
  </div>`;
}

function reStep(i) {
  const el = document.getElementById(`estep-${i}`);
  if (el) el.outerHTML = stepHTML(state.steps[i], i);
}

// ---------------------------------------------------------------- events (delegated)
$("#doc").addEventListener("input", (e) => {
  const el = e.target, i = el.dataset.idx, f = el.dataset.field;
  if (i == null) return;
  const st = state.steps[i];
  if (f === "title") st.title = el.value;
  else if (f === "goal") st.goal = el.value;
  else if (f === "bullet") st.bullets[el.dataset.b] = el.value;
});

$("#doc").addEventListener("change", (e) => {
  if (e.target.dataset.act === "inc") {
    const i = e.target.dataset.idx;
    state.steps[i].include = e.target.checked;
    document.getElementById(`estep-${i}`).classList.toggle("off", !e.target.checked);
  }
});

$("#doc").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const i = b.dataset.idx, act = b.dataset.act;
  if (act === "addbul") { state.steps[i].bullets.push(""); reStep(i); }
  else if (act === "delbul") { state.steps[i].bullets.splice(b.dataset.b, 1); reStep(i); }
  else if (act === "img") openPicker(+i);
});

// ---------------------------------------------------------------- image picker
async function openPicker(i) {
  pickerStep = i;
  $("#picker").classList.remove("hidden");
  const box = $("#picker-opts");
  box.innerHTML = "Extracting frames…";
  const cur = state.steps[i].image;
  const r = await fetch(`/api/jobs/${JOB}/frame_options?step=${state.steps[i].number}&count=6`);
  const { options } = await r.json();
  const all = [{ name: cur, url: imgURL(cur), t: "current" }, ...options];
  box.innerHTML = all.map((o) => `
    <div class="opt" data-name="${esc(o.name)}">
      <img src="${o.url}"/><div class="t">${o.t === "current" ? "current" : "@ " + o.t + "s"}</div>
    </div>`).join("");
  box.querySelectorAll(".opt").forEach((el) =>
    el.addEventListener("click", () => { setImage(i, el.dataset.name); closePicker(); }));
}
function setImage(i, name) {
  state.steps[i].image = name;
  const el = document.querySelector(`#estep-${i} .imgwrap img`);
  if (el) el.src = imgURL(name);
}
function closePicker() { $("#picker").classList.add("hidden"); }
$("#picker-close").addEventListener("click", closePicker);
$("#picker").addEventListener("click", (e) => { if (e.target.id === "picker") closePicker(); });

$("#picker-upload").addEventListener("change", async (e) => {
  if (!e.target.files.length || pickerStep == null) return;
  const fd = new FormData(); fd.append("image", e.target.files[0]);
  const r = await fetch(`/api/jobs/${JOB}/images`, { method: "POST", body: fd });
  const { name } = await r.json();
  setImage(pickerStep, name); closePicker();
});

// ---------------------------------------------------------------- export
$("#export").addEventListener("click", async () => {
  const btn = $("#export"); btn.disabled = true; btn.textContent = "Building…";
  try {
    const model = { settings: state.settings, steps: state.steps };
    const r = await fetch(`/api/jobs/${JOB}/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(model),
    });
    if (!r.ok) throw new Error("export failed");
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.settings.model || "assembly_instruction").replace(/\s+/g, "_") + ".docx";
    a.click(); URL.revokeObjectURL(a.href);
    toast("Word document downloaded ✓");
  } catch (err) { toast("Export failed: " + err.message); }
  btn.disabled = false; btn.textContent = "⬇ Export to Word (.docx)";
});

$("#dl-json").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.raw, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (state.settings.model || "assembly") + ".json"; a.click();
  URL.revokeObjectURL(a.href);
});

function toast(msg) {
  let t = $(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}

init();
