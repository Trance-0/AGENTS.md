import { Player, formatTime } from "/player.js";
import { $, api, report, esc } from "/api.js";
import { createNavigator } from "/nav.js";

const state = { user: null, panels: [], groups: [], stream: null, recordings: [], loading: 0, viewingLive: true, liveEvents: new Map() };
const player = new Player(renderChat);
const nav = createNavigator({
  state, report, setPanelEnabled, showLive,
  closeMobileSidebar: () => closeMobileSidebar(),
  isLiveVisible: () => !$("#view-live-stream").classList.contains("hidden"),
});

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
      openRoute(location.hash);
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
  const { panels, groups } = await api("/api/panels");
  state.panels = panels;
  state.groups = groups || [];
  nav.renderSidebar();
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
    document.querySelectorAll("input[name='setting-theme']").forEach(input => { input.checked = input.value === preference; });
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

const isNarrow = () => window.matchMedia("(max-width: 720px)").matches;
function closeMobileSidebar() {
  if (!isNarrow()) return;
  $("#sidebar").classList.remove("open");
  $("#hamburger").setAttribute("aria-expanded", "false");
}

function showLive() {
  nav.setActiveNav("live");
  if (location.hash && location.hash !== "#live") history.replaceState(null, "", "#live");
  closeMobileSidebar();
  $("#view-panel").classList.add("hidden");
  $("#view-live-stream").classList.remove("hidden");
}

// Opens "#group", "#group/tab", or a legacy "#panel-id" link; guests stay on Live.
function openRoute(hash) {
  const route = state.user ? nav.resolve(hash) : null;
  if (!route || route.group === "live") { if (state.user && hash && hash !== "#live" && !route) report(new Error(`Page unavailable: dashboard/navigation — "${hash}" is not a page you can open.`)); return showLive(); }
  nav.showGroup(route.group, route.tab);
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
  $(".nav-item[data-view='live']").onclick = event => { event.preventDefault(); showLive(); };
  addEventListener("hashchange", () => openRoute(location.hash));
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

init();
