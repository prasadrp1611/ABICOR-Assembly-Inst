/* ABICOR — Support widget.
   A white-labeled support chat (the assistant has NO tools — it can only talk and
   help you file a report) plus a one-click "send report to the team" that writes a
   structured incident to /api/incidents for the support bot to pick up.
   No secrets (keys, headers, access codes) are ever included in a report. */
(function () {
  const MAX = 20;
  const ERRORS = [];
  const FAILS = [];
  const cap = (arr, x) => { arr.push(x); if (arr.length > MAX) arr.shift(); };

  window.addEventListener("error", (e) =>
    cap(ERRORS, (e.message || "error") + (e.filename ? ` @ ${e.filename}:${e.lineno || 0}` : "")));
  window.addEventListener("unhandledrejection", (e) =>
    cap(ERRORS, "promise: " + ((e.reason && e.reason.message) || String(e.reason || "")).slice(0, 300)));

  const _fetch = window.fetch;            // un-wrapped, used by the widget itself
  window.fetch = async function (...args) {
    const method = (args[1] && args[1].method) || "GET";
    const pathOf = (u) => { try { return new URL(u, location.href).pathname; } catch (_) { return ""; } };
    try {
      const r = await _fetch.apply(this, args);
      if (!r.ok) cap(FAILS, { method, path: pathOf(r.url || args[0]), status: r.status });
      return r;
    } catch (err) {
      cap(FAILS, { method, path: pathOf(args[0]), status: "network" });
      throw err;
    }
  };

  const access = () => localStorage.getItem("abicor_access") || "";
  const chatHeaders = () => {
    const h = { "Content-Type": "application/json" };
    if (access()) h["X-Access-Code"] = access();      // gateway mode: prove a valid code
    return h;
  };

  const messages = [];                    // {role:'user'|'assistant', content}

  // ---- styles ----
  const css = `
  #rp-btn{position:fixed;right:16px;bottom:16px;z-index:9998;border:0;cursor:pointer;
    background:#1b1b22;color:#fff;border-radius:999px;padding:10px 14px;font:600 13px system-ui;
    box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:.85;transition:opacity .15s,transform .15s}
  #rp-btn:hover{opacity:1;transform:translateY(-1px)}
  #rp-panel{position:fixed;right:16px;bottom:64px;z-index:9999;width:340px;max-width:93vw;
    background:#fff;color:#1b1b22;border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.30);
    display:none;flex-direction:column;overflow:hidden;font:14px system-ui}
  #rp-panel.show{display:flex}
  .rp-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;
    background:#1b1b22;color:#fff}
  .rp-head b{font-size:14px}
  .rp-head button{border:0;background:transparent;color:#fff;cursor:pointer;font-size:15px}
  .rp-log{padding:12px;max-height:300px;min-height:120px;overflow-y:auto;display:flex;
    flex-direction:column;gap:8px;background:#f7f7fb}
  .rp-b{padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.4;max-width:86%;white-space:pre-wrap}
  .rp-b.assistant{background:#fff;border:1px solid #e6e6ee;align-self:flex-start;border-bottom-left-radius:4px}
  .rp-b.user{background:#c1006f;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
  .rp-in{display:flex;gap:6px;padding:10px;border-top:1px solid #ececf2}
  .rp-in input{flex:1;border:1px solid #d8d8e0;border-radius:10px;padding:9px;font:13px system-ui}
  .rp-in button{border:0;background:#1b1b22;color:#fff;border-radius:10px;padding:0 13px;cursor:pointer;font-size:15px}
  .rp-foot{display:flex;align-items:center;gap:8px;padding:0 10px 10px}
  .rp-foot .rp-report{flex:1;border:0;background:#efe7ee;color:#c1006f;border-radius:10px;
    padding:9px;font:600 12px system-ui;cursor:pointer}
  .rp-foot .rp-link{border:0;background:#eee;border-radius:10px;padding:9px 11px;cursor:pointer}
  .rp-ok{padding:0 12px 10px;font-size:12px;color:#6b6b76;min-height:0}`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  // ---- DOM ----
  const btn = document.createElement("button");
  btn.id = "rp-btn"; btn.type = "button"; btn.textContent = "🛟 Support";
  const panel = document.createElement("div");
  panel.id = "rp-panel";
  panel.innerHTML = `
    <div class="rp-head"><b>Support</b><button id="rp-x" title="close">✕</button></div>
    <div class="rp-log" id="rp-log"></div>
    <div class="rp-in">
      <input id="rp-in" placeholder="Ask a question or describe the problem…"/>
      <button id="rp-send" title="send">➤</button>
    </div>
    <div class="rp-foot">
      <button class="rp-link" id="rp-clip" title="attach a screenshot">📎</button>
      <input type="file" id="rp-file" accept="image/*" style="display:none"/>
      <button class="rp-report" id="rp-report">Send report to the team</button>
    </div>
    <div class="rp-ok" id="rp-ok"></div>`;
  if (document.body) { document.body.appendChild(btn); document.body.appendChild(panel); }

  const $ = (s) => panel.querySelector(s);
  const log = $("#rp-log"), input = $("#rp-in"), ok = $("#rp-ok");

  function bubble(role, text) {
    const b = document.createElement("div");
    b.className = "rp-b " + (role === "user" ? "user" : "assistant");
    b.textContent = text;
    log.appendChild(b); log.scrollTop = log.scrollHeight;
    return b;
  }

  let greeted = false;
  function openPanel() {
    panel.classList.add("show");
    if (!greeted) {
      greeted = true;
      bubble("assistant", "Hi! I'm the Assembly-Doc support assistant. Ask me anything, " +
        "or tell me what went wrong and I'll help you file a report.");
    }
    setTimeout(() => input.focus(), 50);
  }
  btn.addEventListener("click", () =>
    panel.classList.contains("show") ? panel.classList.remove("show") : openPanel());
  $("#rp-x").addEventListener("click", () => panel.classList.remove("show"));

  async function sendChat() {
    const text = input.value.trim();
    if (!text) return;
    input.value = ""; ok.textContent = "";
    bubble("user", text); messages.push({ role: "user", content: text });
    const typing = bubble("assistant", "…");
    try {
      const r = await _fetch("/api/support/chat", {
        method: "POST", headers: chatHeaders(),
        body: JSON.stringify({
          messages: messages.slice(-10),
          route: location.pathname + location.hash,
          console_errors: ERRORS.slice(-5),
        }),
      });
      const d = await r.json().catch(() => ({}));
      typing.remove();
      if (!r.ok) {
        bubble("assistant", r.status === 503
          ? "Support chat is offline right now — but you can still use “Send report to the team” below."
          : (d.detail || "Sorry, something went wrong. You can still send a report below."));
        return;
      }
      bubble("assistant", d.reply); messages.push({ role: "assistant", content: d.reply });
    } catch (_) {
      typing.remove();
      bubble("assistant", "Network problem — you can still send a report below.");
    }
  }
  $("#rp-send").addEventListener("click", sendChat);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  // optional screenshot the user attaches
  $("#rp-clip").addEventListener("click", () => $("#rp-file").click());
  $("#rp-file").addEventListener("change", () => {
    if ($("#rp-file").files[0]) ok.textContent = "📎 " + $("#rp-file").files[0].name + " will be attached.";
  });
  function readShot() {
    const f = $("#rp-file").files[0];
    if (!f || f.size > 3_500_000) return Promise.resolve(null);
    return new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(typeof r.result === "string" ? r.result : null);
      r.onerror = () => res(null);
      r.readAsDataURL(f);
    });
  }

  $("#rp-report").addEventListener("click", async () => {
    const userMsgs = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    if (!userMsgs.trim()) { ok.style.color = "#c1006f"; ok.textContent = "Tell me what happened first."; return; }
    ok.style.color = "#6b6b76"; ok.textContent = "Sending report…";
    const body = {
      message: userMsgs.slice(0, 2000),
      transcript: messages.slice(-20),
      route: location.pathname + location.hash,
      user_agent: navigator.userAgent,
      job_id: window.currentJob || "",
      console_errors: ERRORS.slice(),
      failed_requests: FAILS.slice(),
      screenshot: await readShot(),
    };
    try {
      const r = await _fetch("/api/incidents", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error("failed");
      ok.style.color = "#1a8f4a";
      ok.textContent = "Thanks! Logged as " + (d.id || "received") + ". The team will look into it.";
      $("#rp-file").value = "";
    } catch (_) {
      ok.style.color = "#c1006f"; ok.textContent = "Couldn't send the report — please try again.";
    }
  });
})();
