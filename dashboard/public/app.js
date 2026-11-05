import { Player, formatTime, readAutoplay, storeAutoplay } from "/player.js";
import { renderUsage, renderQuota } from "/metrics.js";

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
  // Chrome (menu, theme, screen modes) is wired first so it keeps working even
  // when a later data request fails.
  wireChrome();
  wireTheme();
  try {
    state.user = await api("/auth/user");
    document.body.classList.toggle("guest", !state.user);
    document.body.classList.toggle("admin", !!state.user?.isAdmin);
    renderAvatar();
    if (state.user) {
      await loadPanels().catch(error => report(error));
      startUptime();
    }
    const { stream, viewers } = await api("/api/broadcast");
    $("#viewer-count").textContent = viewers;
    state.stream = stream;
    if (stream) await loadRecording(stream.id, true);
    await loadCatalog();
    connectStream();
    updateControls();
  } catch (error) { report(error); }
}

async function loadPanels() {
  state.panels = (await api("/api/panels")).panels;
  renderSidebar();
}

/* ---------- Theme ---------- */
const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" };
function wireTheme() {
  const theme = globalThis.dashboardTheme;
  const button = $("#theme-toggle");
  if (!theme) { button.hidden = true; return; }
  const sync = () => {
    const preference = theme.read();
    const label = `Theme: ${THEME_LABELS[preference]} (switch to ${THEME_LABELS[theme.next(preference)]})`;
    button.setAttribute("aria-label", label);
    button.title = label;
    document.querySelectorAll("select[data-setting='theme']").forEach(select => { select.value = preference; });
  };
  button.onclick = () => theme.set(theme.next(theme.read()));
  window.addEventListener("dashboard-theme", sync);
  // Another tab changed the preference.
  window.addEventListener("storage", event => { if (event.key === theme.KEY) { theme.apply(); sync(); } });
  sync();
}

/* ---------- Sidebar uptime chip ---------- */
function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function startUptime() {
  const chip = $("#uptime-chip");
  const refresh = async () => {
    try { chip.textContent = `Server up ${formatUptime((await api("/api/uptime")).uptimeSeconds)}`; }
    catch { chip.textContent = ""; }
  };
  refresh();
  setInterval(refresh, 60000);
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

// Sidebar icons by the panel's self-described `icon` name.
const PANEL_ICONS = {
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M2 13v2M22 13v2"/>',
  build: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  config: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M10 13l-2 2 2 2M14 13l2 2-2 2"/>',
  claw: '<path d="M6 3c-1 4 0 8 4 10M12 3c-.5 4 .5 8 3 10M18 4c0 4-1 7-3 9M7 21c1-4 4-7 8-8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
};

function renderSidebar() {
  const nav = $("#panel-nav");
  const current = document.querySelector(".nav-item.active")?.dataset.view;
  nav.replaceChildren();
  for (const panel of state.panels) {
    if (panel.id === "live-stream") continue;
    const a = document.createElement("a");
    a.className = "nav-item";
    a.dataset.view = panel.id;
    a.href = `#${panel.id}`;
    a.title = panel.enabled ? panel.title : `${panel.title} (disabled)`;
    a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${PANEL_ICONS[panel.icon] || PANEL_ICONS.panel}</svg><span>${esc(panel.title)}</span>${panel.enabled ? "" : '<span class="dot">off</span>'}`;
    a.addEventListener("click", event => { event.preventDefault(); showPanel(panel.id); });
    nav.appendChild(a);
  }
  if (current) setActiveNav(current);
}

const isNarrow = () => window.matchMedia("(max-width: 720px)").matches;
function closeMobileSidebar() {
  if (!isNarrow()) return;
  $("#sidebar").classList.remove("open");
  $("#hamburger").setAttribute("aria-expanded", "false");
}

function setActiveNav(viewId) {
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === viewId));
}

/* ---------- Views ---------- */
function showPanel(id) {
  const panel = state.panels.find((p) => p.id === id);
  if (!panel) return;
  setActiveNav(id);
  closeMobileSidebar();
  $("#view-live-stream").classList.add("hidden");
  $("#view-panel").classList.remove("hidden");
  renderPanelView(panel);
}

function showLive() {
  setActiveNav("live-stream");
  closeMobileSidebar();
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
    <div id="panel-admin"></div>
    <div class="cards" id="panel-cards"></div>
    <div id="panel-body"></div>`;

  if (state.user?.isAdmin) renderPanelAdmin($("#panel-admin"), panel);
  if (!panel.enabled) {
    $("#panel-body").innerHTML = `<p class="panel-disabled">This panel is disabled. Its data and actions are switched off until an administrator enables it again.</p>`;
    return;
  }

  const cards = $("#panel-cards");
  for (const s of panel.status || []) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="label">${esc(s.label)}</div><div class="value tone-${s.tone || "neutral"}">${esc(String(s.value))}</div>`;
    cards.appendChild(card);
  }

  const body = $("#panel-body");
  if (Array.isArray(panel.settings) && panel.settings.length) {
    const list = document.createElement("div");
    list.className = "settings-list";
    for (const s of panel.settings) list.appendChild(settingRow(s));
    body.appendChild(list);
    if (panel.settings.some(s => s.scope === "browser")) {
      const note = document.createElement("p");
      note.className = "settings-note";
      note.textContent = "Saved in this browser only; other devices keep their own preferences.";
      body.appendChild(note);
    } else {
      const note = document.createElement("p");
      note.className = "settings-note";
      note.textContent = "Configuration shown read-only; it is set in the deployment environment.";
      body.appendChild(note);
    }
  }
  if (panel.id === "settings") return;

  if (panel.id === "openclaw-config") return renderConfigEditor(body);
  if (panel.id === "cpa-quota") return renderQuota(body, api);
  if (panel.id === "usage-metrics") return renderUsage(body, api);

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

// Admin mutation helper for panel toggles: admin session + same-origin
// X-Dashboard-Request header (added by api()). Refreshes the panel list and
// returns the updated panel snapshot. UI-independent so redesigned settings
// views can reuse it.
async function setPanelEnabled(id, enabled) {
  const result = await api(`/api/panels/${encodeURIComponent(id)}/toggle`, { method: "POST", body: JSON.stringify({ enabled }) });
  await loadPanels();
  return state.panels.find(p => p.id === id) || { id, enabled: result.enabled };
}

// Admin-only panel switch. Uses the admin session plus the same-origin
// X-Dashboard-Request header (sent by api()), like other admin mutations.
function renderPanelAdmin(box, panel) {
  if (panel.id === "live-stream") return;
  box.className = "panel-admin";
  const label = document.createElement("label");
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.id = "panel-enabled";
  toggle.checked = panel.enabled;
  label.append(toggle, " Panel enabled");
  const status = document.createElement("span");
  status.className = "hint";
  status.setAttribute("role", "status");
  status.textContent = panel.enabled ? "Visible to signed-in members." : "Hidden from members; data and actions are off.";
  toggle.onchange = async () => {
    toggle.disabled = true;
    status.textContent = "Saving…";
    try {
      await renderPanelView(await setPanelEnabled(panel.id, toggle.checked));
    } catch (error) {
      toggle.checked = panel.enabled;
      status.textContent = error.message;
      toggle.disabled = false;
    }
  };
  box.append(label, status);
}

// Browser-scope settings are live controls saved in localStorage; every other
// panel setting is deployment configuration and is shown read-only.
function settingRow(s) {
  const row = document.createElement("div");
  row.className = "setting-row";
  const id = `setting-${s.key}`;
  const label = document.createElement("label");
  label.textContent = s.label;
  if (s.help) {
    const help = document.createElement("small");
    help.className = "setting-help";
    help.textContent = s.help;
    label.append(help);
  }
  row.append(label);
  if (s.scope !== "browser") {
    const value = document.createElement("output");
    value.className = "setting-value";
    value.textContent = String(s.value ?? "");
    value.setAttribute("aria-label", `${s.label} (read-only)`);
    row.append(value);
    return row;
  }
  label.htmlFor = id;
  if (s.key === "theme") {
    const theme = globalThis.dashboardTheme;
    const select = document.createElement("select");
    select.id = id;
    select.dataset.setting = "theme";
    for (const option of s.options || []) select.append(new Option(THEME_LABELS[option] || option, option));
    select.value = theme?.read() ?? "system";
    select.onchange = () => theme?.set(select.value);
    row.append(select);
  } else if (s.key === "autoplay") {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = id;
    box.dataset.setting = "autoplay";
    box.checked = readAutoplay();
    box.onchange = () => storeAutoplay(box.checked);
    row.append(box);
  }
  return row;
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
  // Wide screens collapse the sidebar to an icon rail; narrow screens slide it in and out.
  const syncMenu = () => {
    const sidebar = $("#sidebar");
    $("#hamburger").setAttribute("aria-expanded", String(isNarrow() ? sidebar.classList.contains("open") : !sidebar.classList.contains("collapsed")));
  };
  $("#hamburger").onclick = () => { $("#sidebar").classList.toggle(isNarrow() ? "open" : "collapsed"); syncMenu(); };
  window.matchMedia("(max-width: 720px)").addEventListener("change", syncMenu);
  syncMenu();
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
  // Icon buttons: aria-pressed drives the enter/exit icon swap in CSS; the
  // accessible name and tooltip describe the action the next click performs.
  const setMode = (button, active, enterLabel, exitLabel, key) => {
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ? exitLabel : enterLabel);
    button.title = `${active ? exitLabel : enterLabel}${key ? ` (${key})` : ""}`;
  };
  const syncScreenButtons = () => {
    const theater = document.body.classList.contains("theater");
    const web = document.body.classList.contains("web-fullscreen");
    const full = !!document.fullscreenElement;
    $("#btn-exit-screen").hidden = !web && !full;
    setMode($("#btn-theater"), theater, "Theater mode", "Exit theater mode", "t");
    setMode($("#btn-web-fullscreen"), web, "Web full screen", "Exit web full screen", "w");
    setMode($("#btn-fullscreen"), full, "Full display", "Exit full display", "f");
    player.reveal();
  };
  $("#btn-theater").onclick = () => { document.body.classList.toggle("theater"); syncScreenButtons(); };
  $("#btn-web-fullscreen").onclick = () => { document.body.classList.toggle("web-fullscreen"); syncScreenButtons(); };
  $("#btn-fullscreen").onclick = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await surface.requestFullscreen(); }
    catch (error) { report(new Error(`Full display unavailable: dashboard/screen mode — ${error.message}`)); }
  };
  $("#btn-exit-screen").onclick = () => exit().catch(report);
  document.addEventListener("fullscreenchange", syncScreenButtons);
  surface.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    const button = { t: "#btn-theater", w: "#btn-web-fullscreen", f: "#btn-fullscreen" }[event.key.toLowerCase()];
    if (!button) return;
    event.preventDefault();
    $(button).click();
  });
  syncScreenButtons();
  document.addEventListener("keydown", event => { if (event.key === "Escape") exit().catch(report); });
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

init();
