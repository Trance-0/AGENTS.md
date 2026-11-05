import { Player, formatTime } from "/player.js";

const $ = selector => document.querySelector(selector);
const state = { user: null, panels: [], stream: null, recordings: [], loading: 0, viewingLive: true, liveEvents: new Map() };
const player = new Player(renderChat);

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", "X-Dashboard-Request": "1", ...options.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request unavailable: dashboard/browser request — server returned HTTP ${response.status}.`);
  }
  return response.json();
}

function report(error, element = $("#page-status")) {
  element.hidden = false;
  element.textContent = error.message || String(error);
}

async function init() {
  try {
    state.user = await api("/auth/user");
    document.body.classList.toggle("guest", !state.user);
    document.body.classList.toggle("admin", !!state.user?.isAdmin);
    renderAvatar();
    if (state.user) {
      state.panels = (await api("/api/panels")).panels;
      renderSidebar();
    }
    const { stream, viewers } = await api("/api/broadcast");
    $("#viewer-count").textContent = viewers;
    state.stream = stream;
    if (stream) await loadRecording(stream.id, true);
    await loadCatalog();
    wireChrome();
    connectStream();
    updateControls();
  } catch (error) { report(error); }
}

function renderAvatar() {
  if (!state.user) return;
  const avatar = $("#avatar");
  const fallback = () => { avatar.textContent = (state.user.name || "User").slice(0, 1).toUpperCase(); };
  fallback();
  avatar.title = state.user.name;
  if (state.user.avatar) {
    const image = new Image();
    image.alt = `${state.user.name}'s avatar`;
    image.onload = () => avatar.replaceChildren(image);
    image.onerror = fallback;
    image.src = state.user.avatar;
  }
}

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

  if (panel.id === "openclaw-config") return renderConfigEditor(body);

  // Extra data table for panels that expose it
  try {
    const data = await api(`/api/panels/${encodeURIComponent(panel.id)}/data`);
    renderPanelData(body, data);
  } catch {}
}

// Administrator editor for OpenClaw's live openclaw.json. Masked secrets
// round-trip as placeholders and are restored server-side; invalid JSON is
// rejected before it is sent.
async function renderConfigEditor(body) {
  const box = document.createElement("div");
  box.className = "config-editor";
  if (!state.user?.isAdmin) {
    box.innerHTML = `<p class="config-status">Administrator group required to view or edit the OpenClaw config.</p>`;
    return body.appendChild(box);
  }
  box.innerHTML = `
    <p class="config-help">Secret values appear as <code>__dashboard_redacted__</code> and are kept unchanged on save. Prefer env SecretRefs such as <code>{"source":"env","provider":"default","id":"NAME"}</code> over literal credentials. Saves are backed up and hot-reloaded by OpenClaw.</p>
    <textarea class="config-text mono" spellcheck="false" rows="32" aria-label="openclaw.json"></textarea>
    <div class="config-actions"><button type="button" class="config-reload">Reload</button><button type="button" class="config-save primary">Save</button><span class="config-status" role="status"></span></div>`;
  body.appendChild(box);
  const text = box.querySelector(".config-text");
  const status = box.querySelector(".config-status");
  let baseHash = null;
  const load = async () => {
    status.textContent = "Loading…";
    try {
      const view = await api("/api/admin/openclaw-config");
      text.value = JSON.stringify(view.config, null, 2);
      baseHash = view.hash;
      status.textContent = `Loaded; last modified ${view.modifiedAt}.`;
    } catch (error) { status.textContent = error.message; }
  };
  box.querySelector(".config-reload").addEventListener("click", load);
  box.querySelector(".config-save").addEventListener("click", async () => {
    try { JSON.parse(text.value); }
    catch (error) { status.textContent = `Config cannot be saved: dashboard/browser validation — invalid JSON (${error.message}).`; return; }
    status.textContent = "Saving…";
    try {
      const view = await api("/api/admin/openclaw-config", { method: "PUT", body: JSON.stringify({ text: text.value, baseHash }) });
      text.value = JSON.stringify(view.config, null, 2);
      baseHash = view.hash;
      status.textContent = view.changed ? `Saved at ${view.modifiedAt}; OpenClaw will hot-reload it.` : "No changes to save.";
    } catch (error) { status.textContent = error.message; }
  });
  await load();
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


async function loadCatalog() {
  state.recordings = (await api("/api/recordings")).recordings;
  const cards = $("#rec-cards");
  cards.replaceChildren();
  if (state.stream) cards.append(recordingCard(state.stream, true));
  for (const recording of state.recordings) cards.append(recordingCard(recording));
  if (!cards.children.length) cards.textContent = "No recordings yet. Completed streams will appear here.";
  if (state.user?.isAdmin) await renderLibrary();
}

function recordingCard(recording, live = false) {
  const button = document.createElement("button");
  button.className = "rec-card";
  button.dataset.recordingId = recording.id;
  button.innerHTML = `<span class="rec-thumb">${live ? "LIVE" : formatTime(recording.duration)}</span><span class="rec-meta"><span class="rec-title">${esc(recording.title)}</span><span class="rec-sub">${live ? "Watch now" : `${recording.eventCount} events · Score ${recording.score}`}</span></span>`;
  button.onclick = () => loadRecording(recording.id, live).catch(report);
  return button;
}

async function loadRecording(id, live = false) {
  const generation = ++state.loading;
  const events = [];
  let offset = 0;
  let page;
  do {
    page = await api(`/api/recordings/${encodeURIComponent(id)}/events?offset=${offset}`);
    if (generation !== state.loading) return;
    events.push(...page.events);
    offset = page.nextOffset;
    if (page.more) report(new Error(`Playback is loading: dashboard/recording fetch — ${events.length} events downloaded; fetching the next page.`));
  } while (page.more);
  $("#page-status").hidden = true;
  state.viewingLive = live;
  const merged = new Map(events.map(event => [event.id, event]));
  if (live) for (const event of state.liveEvents.values()) if (event.recordingId === id) merged.set(event.id, event);
  player.load(page.recording, [...merged.values()].sort((a, b) => a.id - b.id));
  showLive();
  updateControls();
}

async function renderLibrary() {
  const { recordings } = await api("/api/admin/recordings");
  const library = $("#admin-recordings");
  library.replaceChildren();
  for (const recording of recordings.filter(item => item.status !== "live")) {
    const form = document.createElement("form");
    form.className = "recording-row";
    const title = document.createElement("button");
    title.type = "button";
    title.className = "action-btn";
    title.textContent = recording.title;
    title.onclick = () => loadRecording(recording.id).catch(report);
    const hidden = document.createElement("input");
    hidden.type = "checkbox";
    hidden.checked = recording.hidden;
    const score = document.createElement("input");
    score.type = "number"; score.min = "0"; score.max = "100"; score.required = true; score.value = recording.score;
    const hiddenLabel = document.createElement("label"); hiddenLabel.append(hidden, "Hidden");
    const scoreLabel = document.createElement("label"); scoreLabel.append("Score ", score);
    const save = document.createElement("button"); save.className = "action-btn"; save.textContent = "Save";
    form.append(title, hiddenLabel, scoreLabel, save);
    form.onsubmit = async event => {
      event.preventDefault(); save.disabled = true;
      try { await api(`/api/recordings/${recording.id}`, { method: "PATCH", body: JSON.stringify({ hidden: hidden.checked, score: Number(score.value) }) }); await loadCatalog(); }
      catch (error) { report(error); }
      finally { save.disabled = false; }
    };
    library.append(form);
  }
}

function connectStream() {
  const stream = new EventSource("/api/stream");
  stream.addEventListener("status", async event => {
    const next = JSON.parse(event.data);
    const previous = state.stream;
    state.stream = next;
    if (previous?.id !== next?.id) state.liveEvents.clear();
    if (next && player.recording?.id === next.id) { player.recording = next; player.render(); }
    if (next && state.viewingLive && next.id !== player.recording?.id) {
      state.loading++;
      player.load(next, []);
    } else if (!next && previous && player.recording?.id === previous.id) {
      player.recording = { ...previous, status: "ended", duration: player.duration(), endedAt: Date.now() };
      player.follow = false;
      player.render();
    }
    updateControls();
    try { await loadCatalog(); } catch (error) { report(error); }
  });
  stream.addEventListener("viewers", event => { $("#viewer-count").textContent = JSON.parse(event.data).count; });
  stream.addEventListener("event", event => {
    const data = JSON.parse(event.data);
    state.liveEvents.set(data.id, data);
    if (state.liveEvents.size > 1000) state.liveEvents.delete(state.liveEvents.keys().next().value);
    if (state.viewingLive) player.add(data);
  });
  stream.addEventListener("catalog", async event => {
    const { id } = JSON.parse(event.data);
    try {
      await loadCatalog();
      if (!state.user?.isAdmin && player.recording?.id === id && !state.recordings.some(recording => recording.id === id)) {
        state.loading++; player.load(null, []); report(new Error("Playback stopped: dashboard/recording visibility — the administrator hid this recording."));
      }
    } catch (error) { report(error); }
  });
  stream.onerror = () => report(new Error("Live updates delayed: dashboard/event connection — connection interrupted; reconnecting automatically."));
  stream.onopen = () => { $("#page-status").hidden = true; };
}

let chatKey;
function renderChat(events) {
  const key = `${player?.recording?.id}:${events.at(-1)?.id}:${events.length}`;
  if (key === chatKey) return;
  chatKey = key;
  const messages = $("#chat-messages");
  messages.replaceChildren(...events.slice(-100).map(event => {
    const line = document.createElement("div"); line.className = "chat-message";
    const author = document.createElement("strong"); author.textContent = event.author || "Viewer";
    const text = document.createElement("span"); text.textContent = event.msg;
    const time = document.createElement("time"); time.textContent = formatTime(event.t);
    line.append(time, author, text);
    return line;
  }));
  messages.scrollTop = messages.scrollHeight;
}

function updateControls() {
  const canChat = !!state.user && !!state.stream && state.viewingLive && player.recording?.id === state.stream.id;
  $("#chat-input").disabled = !canChat;
  $("#chat-send").disabled = !canChat;
  $("#chat-input").placeholder = !state.user ? "Sign in to join the chat" : !state.stream ? "Chat is closed while offline" : "Say something to the host";
  $("#btn-start").disabled = !!state.stream;
  $("#btn-end").disabled = !state.stream;
  $("#broadcast-title").disabled = !!state.stream;
  $("#stream-started").textContent = state.stream ? "· Stream is live" : "· Stream is offline";
}

function wireChrome() {
  $("#hamburger").onclick = () => { $("#sidebar").classList.toggle("collapsed"); $("#sidebar").classList.toggle("open"); };
  $(".nav-item[data-view='live-stream']").onclick = event => { event.preventDefault(); showLive(); };
  $("#broadcast-controls").onsubmit = async event => {
    event.preventDefault(); $("#btn-start").disabled = true;
    try { const { stream } = await api("/api/broadcast/start", { method: "POST", body: JSON.stringify({ title: $("#broadcast-title").value }) }); state.stream = stream; await loadRecording(stream.id, true); }
    catch (error) { report(error); } finally { updateControls(); }
  };
  $("#btn-end").onclick = async () => {
    $("#btn-end").disabled = true;
    try { await api("/api/broadcast/end", { method: "POST", body: "{}" }); }
    catch (error) { report(error); } finally { updateControls(); }
  };
  $("#chat-form").onsubmit = async event => {
    event.preventDefault(); $("#chat-send").disabled = true;
    try { await api("/api/chat", { method: "POST", body: JSON.stringify({ message: $("#chat-input").value }) }); $("#chat-input").value = ""; $("#chat-status").textContent = "Message sent. Watch the main stream for the host's reply."; }
    catch (error) { report(error, $("#chat-status")); } finally { updateControls(); }
  };
  const surface = $("#screen-surface");
  const exit = async () => {
    document.body.classList.remove("web-fullscreen");
    if (document.fullscreenElement) await document.exitFullscreen();
    syncScreenButtons();
  };
  const syncScreenButtons = () => {
    $("#btn-exit-screen").hidden = !document.body.classList.contains("web-fullscreen") && !document.fullscreenElement;
    $("#btn-theater").setAttribute("aria-pressed", String(document.body.classList.contains("theater")));
    $("#btn-web-fullscreen").setAttribute("aria-pressed", String(document.body.classList.contains("web-fullscreen")));
  };
  $("#btn-theater").onclick = () => { document.body.classList.toggle("theater"); syncScreenButtons(); };
  $("#btn-web-fullscreen").onclick = () => { document.body.classList.toggle("web-fullscreen"); syncScreenButtons(); };
  $("#btn-fullscreen").onclick = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await surface.requestFullscreen(); }
    catch (error) { report(new Error(`Full display unavailable: dashboard/screen mode — ${error.message}`)); }
  };
  $("#btn-exit-screen").onclick = () => exit().catch(report);
  document.addEventListener("fullscreenchange", syncScreenButtons);
  document.addEventListener("keydown", event => { if (event.key === "Escape") exit().catch(report); });
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

init();
