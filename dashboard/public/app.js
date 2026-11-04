/* Agent Dashboard frontend: YouTube-style live window + plugin panels. */

const $ = (sel) => document.querySelector(sel);

const state = {
  panels: [],
  user: null,
  total: 0, // uptime seconds (the progress bar duration)
  live: true,
  scrubT: null, // timepoint being scrubbed (null = live)
  events: [], // recent events (for timeline marks + tooltip)
  maxLogLines: 160,
};

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (res.status === 401 && !path.startsWith("/auth/")) {
    window.location.href = "/auth/login";
    throw new Error("Dashboard data unavailable: dashboard/session authorization — sign-in session is missing or expired.");
  }
  return res;
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/* ---------- Init ---------- */
async function init() {
  try {
    const [userRes, panelsRes, uptimeRes] = await Promise.all([
      api("/auth/user"),
      api("/api/panels"),
      api("/api/uptime"),
    ]);
    state.user = await userRes.json();
    const panelsBody = await panelsRes.json();
    state.panels = panelsBody.panels ?? [];
    const uptimeBody = await uptimeRes.json();
    state.total = uptimeBody.uptimeSeconds ?? 0;
  } catch (e) {
    return;
  }

  renderAvatar();
  renderSidebar();
  renderRecommended();
  wireChrome();
  startLiveStream();
  startClock();
}

/* ---------- Avatar + user ---------- */
function renderAvatar() {
  const name = state.user?.name || "A";
  $("#avatar").textContent = name.slice(0, 1).toUpperCase();
}

/* ---------- Sidebar ---------- */
function renderSidebar() {
  const nav = $("#panel-nav");
  nav.innerHTML = "";
  for (const panel of state.panels) {
    if (panel.id === "live-stream") continue;
    const a = document.createElement("a");
    a.className = "nav-item";
    a.dataset.view = panel.id;
    a.href = `#${panel.id}`;
    a.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg><span>${esc(panel.title)}</span>${panel.enabled ? "" : '<span class="dot">off</span>'}`;
    a.addEventListener("click", () => showPanel(panel.id));
    nav.appendChild(a);
  }
}

function setActiveNav(viewId) {
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === viewId));
}

/* ---------- Views ---------- */
function showPanel(id) {
  const panel = state.panels.find((p) => p.id === id);
  if (!panel) return;
  setActiveNav(id);
  $("#view-live-stream").classList.add("hidden");
  $("#view-panel").classList.remove("hidden");
  renderPanelView(panel);
}

function showLive() {
  setActiveNav("live-stream");
  $("#view-panel").classList.add("hidden");
  $("#view-live-stream").classList.remove("hidden");
}

async function renderPanelView(panel) {
  const el = $("#view-panel");
  el.classList.add("panel-view");
  el.innerHTML = `
    <div class="panel-header">
      <div>
        <h1>${esc(panel.title)}</h1>
        <p>${esc(panel.description || "")}</p>
      </div>
    </div>
    <div class="cards" id="panel-cards"></div>
    <div id="panel-body"></div>`;

  const cards = $("#panel-cards");
  for (const s of panel.status || []) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="label">${esc(s.label)}</div><div class="value tone-${s.tone || "neutral"}">${esc(String(s.value))}</div>`;
    cards.appendChild(card);
  }

  const body = $("#panel-body");
  if (Array.isArray(panel.settings) && panel.settings.length) {
    body.innerHTML += `<div class="settings-list"></div>`;
    const list = body.querySelector(".settings-list");
    for (const s of panel.settings) {
      const row = document.createElement("div");
      row.className = "setting-row";
      const input = fieldInput(s);
      row.innerHTML = `<label>${esc(s.label)}</label>`;
      row.appendChild(input);
      list.appendChild(row);
    }
  }

  // Extra data table for panels that expose it
  try {
    const res = await api(`/api/panels/${encodeURIComponent(panel.id)}/data`);
    if (res.ok) {
      const data = await res.json();
      renderPanelData(body, data);
    }
  } catch {}
}

function fieldInput(s) {
  if (s.type === "boolean") {
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = Boolean(s.value);
    return c;
  }
  if (s.type === "select") {
    const sel = document.createElement("select");
    for (const o of s.options || []) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      opt.selected = o === s.value;
      sel.appendChild(opt);
    }
    return sel;
  }
  const i = document.createElement("input");
  i.type = s.type === "number" ? "number" : "text";
  i.value = s.value ?? "";
  return i;
}

function renderPanelData(body, data) {
  if (!data || typeof data !== "object") return;
  if (Array.isArray(data.providers)) {
    const table = document.createElement("table");
    table.className = "data-table";
    table.innerHTML = `<thead><tr><th>Provider</th><th>Env var</th><th>Note</th></tr></thead><tbody></tbody>`;
    const tb = table.querySelector("tbody");
    for (const p of data.providers) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mono">${esc(p.provider)}</td><td class="mono">${esc(p.env)}</td><td>${esc(p.note || "")}</td>`;
      tb.appendChild(tr);
    }
    body.appendChild(table);
  }
}

/* ---------- Recommended (placeholder) ---------- */
function renderRecommended() {
  const items = [
    { t: "OpenClaw config manager", s: "Placeholder · recommended", cls: "t1" },
    { t: "Model backend status", s: "Placeholder · recommended", cls: "t2" },
    { t: "PCP context feed", s: "Placeholder · recommended", cls: "t3" },
    { t: "Build & LKG history", s: "Placeholder · recommended", cls: "t4" },
    { t: "AstrBot relay health", s: "Placeholder · recommended", cls: "t1" },
  ];
  const wrap = $("#rec-cards");
  wrap.innerHTML = "";
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "rec-card";
    card.innerHTML = `<div class="rec-thumb ${it.cls}">▶</div><div class="rec-meta"><div class="rec-title">${esc(it.t)}</div><div class="rec-sub">${esc(it.s)}</div></div>`;
    wrap.appendChild(card);
  }
}

/* ---------- Chrome wiring ---------- */
function wireChrome() {
  $("#hamburger").addEventListener("click", () => {
    const sb = $("#sidebar");
    sb.classList.toggle("collapsed");
    sb.classList.toggle("open");
  });
  $(".nav-item[data-view='live-stream']").addEventListener("click", (e) => {
    e.preventDefault();
    showLive();
  });
  $("#btn-settings").addEventListener("click", () => {
    if (state.panels.some((p) => p.id === "settings")) showPanel("settings");
  });
  $("#btn-like").addEventListener("click", () => {
    $("#btn-like").classList.add("liked");
    $("#btn-like").querySelector("span").textContent = "Liked";
  });
  $("#btn-live").addEventListener("click", goLive);
}

/* ---------- Live stream (SSE) ---------- */
function startLiveStream() {
  const log = $("#stream-log");
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    let event;
    try { event = JSON.parse(ev.data); } catch { return; }
    state.events.push(event);
    if (state.events.length > 400) state.events.shift();
    state.total = Math.max(state.total, event.t || 0);
    appendLogLine(event);
    updateCaptions(event);
    markEvent(event);
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

function appendLogLine(event) {
  const log = $("#stream-log");
  const line = document.createElement("div");
  line.className = `log-line ${event.level || "info"}`;
  line.innerHTML = `<span class="t">${fmtTime(event.t)}</span><span class="src">${esc(event.source)}</span><span class="msg">${esc(event.msg)}</span>`;
  log.appendChild(line);
  while (log.children.length > state.maxLogLines) log.removeChild(log.firstChild);
}

function updateCaptions(event) {
  const c = $("#captions");
  if (event.level === "error") c.textContent = `⚠ ${event.msg}`;
  else if (event.level === "warn") c.textContent = `● ${event.msg}`;
  else c.textContent = "Streaming live logs…";
}

function markEvent(event) {
  const marks = $("#event-marks");
  const mark = document.createElement("div");
  mark.className = `event-mark ${event.level || "info"}`;
  marks.appendChild(mark);
  while (marks.children.length > 300) marks.removeChild(marks.firstChild);
  layoutMarks();
}

function layoutMarks() {
  const bar = $("#progress-bar");
  const marks = $("#event-marks");
  const width = bar.clientWidth;
  const total = state.total || 1;
  Array.from(marks.children).forEach((m, i) => {
    const e = state.events[state.events.length - marks.children.length + i];
    if (!e) return;
    const pct = (e.t / total) * 100;
    m.style.left = `${Math.min(100, Math.max(0, pct))}%`;
  });
}

/* ---------- Clock / progress ---------- */
function startClock() {
  setInterval(() => {
    if (state.live) {
      state.total += 1;
    }
    updateProgress();
    updateUptimeChip();
  }, 1000);
}

function updateProgress() {
  const total = state.total || 1;
  const scrub = state.scrubT != null ? state.scrubT : state.total;
  $("#progress-elapsed").style.width = `${(scrub / total) * 100}%`;
  $("#time-elapsed").textContent = fmtTime(scrub);
  $("#time-total").textContent = fmtTime(state.total);
  layoutMarks();
}

function updateUptimeChip() {
  $("#uptime-chip").textContent = `up ${fmtTime(state.total)}`;
}

/* ---------- Timeline scrub (drag & draw) ---------- */
function setupScrubber() {
  const bar = $("#progress-bar");
  let scrubbing = false;
  let anchorT = null;

  const tFromEvent = (e) => {
    const rect = bar.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(state.total || 1, ratio * (state.total || 1)));
  };

  bar.addEventListener("pointerdown", (e) => {
    scrubbing = true;
    anchorT = tFromEvent(e);
    state.scrubT = anchorT;
    state.live = false;
    bar.classList.add("scrubbing");
    bar.setPointerCapture(e.pointerId);
    updateProgress();
  });

  bar.addEventListener("pointermove", (e) => {
    if (!scrubbing) {
      // Hover: preview tooltip at cursor timepoint
      showTooltipAt(tFromEvent(e), e.clientX, e.clientY);
      return;
    }
    const t = tFromEvent(e);
    state.scrubT = t;
    const lo = Math.min(anchorT, t);
    const hi = Math.max(anchorT, t);
    drawSelection(lo, hi);
    showRangeTooltip(lo, hi, e.clientX, e.clientY);
    updateProgress();
  });

  const end = () => {
    if (!scrubbing) return;
    scrubbing = false;
    bar.classList.remove("scrubbing");
    $("#selection").style.display = "none";
    hideTooltip();
  };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
  bar.addEventListener("pointerleave", () => {
    if (!scrubbing) hideTooltip();
  });
}

function drawSelection(lo, hi) {
  const sel = $("#selection");
  const total = state.total || 1;
  sel.style.display = "block";
  sel.style.left = `${(lo / total) * 100}%`;
  sel.style.width = `${((hi - lo) / total) * 100}%`;
}

function eventsInRange(lo, hi) {
  return state.events.filter((e) => e.t >= lo && e.t <= hi);
}

function showTooltipAt(t, x, y) {
  const near = eventsInRange(Math.max(0, t - 2), t + 2).slice(-6);
  if (near.length === 0) { hideTooltip(); return; }
  renderTooltip(t, near, x, y);
}

function showRangeTooltip(lo, hi, x, y) {
  const near = eventsInRange(lo, hi).slice(-10);
  renderTooltip(lo, near, x, y);
}

function renderTooltip(t, events, x, y) {
  const tip = $("#tooltip");
  const lines = events.map((e) => `<div class="tt-line ${e.level}">${fmtTime(e.t)} [${esc(e.source)}] ${esc(e.msg)}</div>`).join("");
  tip.innerHTML = `<div class="tt-time">⏱ ${fmtTime(t)} — ${events.length} event${events.length === 1 ? "" : "s"}</div>${lines || '<div class="tt-line">no events here</div>'}`;
  tip.style.display = "block";
  const pw = tip.offsetWidth;
  const left = Math.min(window.innerWidth - pw - 16, Math.max(8, x + 12));
  const top = y - tip.offsetHeight - 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function hideTooltip() {
  $("#tooltip").style.display = "none";
}

function goLive() {
  state.live = true;
  state.scrubT = null;
  $("#selection").style.display = "none";
  updateProgress();
}

/* ---------- Utils ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.addEventListener("DOMContentLoaded", () => {
  init();
  setupScrubber();
});
