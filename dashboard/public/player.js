import { SceneTimeline } from "./scene/reduce.js";

export const formatTime = seconds => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
};

// Metric ticks update widgets only; every other scene event keeps its caption in the log.
export const isLogEvent = event => event.kind !== "chat" && !(event.kind === "widget" && event.op === "metrics");

// A moderation event removes a viewer chat message: the server already
// rewrote the stored line; this drops the copy a live player received earlier.
export function applyModeration(events, event) {
  if (event?.moderation?.op !== "chat_delete") return;
  const index = events.findIndex(item => item.id === event.moderation.target && item.kind === "chat");
  if (index >= 0) events[index] = { ...events[index], msg: "", author: undefined, deleted: true };
}

export const isChat = event => event.kind === "chat" && !event.deleted;

export function previewAt(events, time) {
  return events.filter(event => isLogEvent(event) && event.t <= time).slice(-5);
}

const MARK_LEVELS = new Set(["warn", "error", "fatal", "critical"]);

export const PLAYBACK_RATES = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]);
export const RATE_STORAGE_KEY = "agent-dashboard.playbackRate";
// Settings > "Autoplay recordings": whether opening a recording starts replay.
// Live streams always follow the live edge. Default on; stored per browser.
export const AUTOPLAY_STORAGE_KEY = "agent-dashboard.autoplay";
export const normalizeAutoplay = value => value !== false && value !== "false";

export function readAutoplay() {
  try { return normalizeAutoplay(localStorage.getItem(AUTOPLAY_STORAGE_KEY)); } catch { return true; }
}

export function storeAutoplay(value) {
  try { localStorage.setItem(AUTOPLAY_STORAGE_KEY, String(normalizeAutoplay(value))); } catch {}
}
// Controls stay up this long after the last pointer/keyboard activity while
// playing; leaving the player hides them sooner.
export const CONTROLS_IDLE_MS = 2500;
export const CONTROLS_LEAVE_MS = 1000;

// Accepts a number or stored string; anything outside the offered list is 1x.
export function normalizeRate(value) {
  const rate = Number(value);
  return PLAYBACK_RATES.includes(rate) ? rate : 1;
}

// Steps through PLAYBACK_RATES (direction +1 faster, -1 slower), clamped at the ends.
export function stepRate(rate, direction) {
  const index = PLAYBACK_RATES.indexOf(normalizeRate(rate));
  return PLAYBACK_RATES[Math.max(0, Math.min(PLAYBACK_RATES.length - 1, index + Math.sign(direction)))];
}

// Recording time after `elapsed` wall-clock seconds at `rate`, clamped to [0, duration].
export function advanceTime(time, elapsed, rate, duration) {
  return Math.max(0, Math.min(duration, time + Math.max(0, elapsed) * normalizeRate(rate)));
}

export const formatRate = rate => `${normalizeRate(rate)}x`;

// YouTube-style auto-hide: only while playing, never with a menu open or a
// keyboard-focused control; idle time is measured from the last activity.
export function controlsShouldHide({ playing, menuOpen = false, keyboardFocus = false, scrubbing = false, pointerInside = false, idleMs = 0 }) {
  if (!playing || menuOpen || keyboardFocus || scrubbing) return false;
  return idleMs >= (pointerInside ? CONTROLS_IDLE_MS : CONTROLS_LEAVE_MS);
}

export function readStoredRate() {
  try { return normalizeRate(localStorage.getItem(RATE_STORAGE_KEY) ?? 1); } catch { return 1; }
}

function storeRate(rate) {
  try { localStorage.setItem(RATE_STORAGE_KEY, String(rate)); } catch {}
}

export class Player {
  constructor(onChat) {
    this.events = [];
    this.recording = null;
    this.time = 0;
    this.follow = true;
    this.playing = false;
    this.rate = readStoredRate();
    this.onChat = onChat;
    // Scene state is folded client-side with checkpoints (public/scene/reduce.js).
    this.timeline = new SceneTimeline();
    this.onScene = null;
    this.lastTick = performance.now();
    this.chrome = { pointerInside: false, lastActivity: performance.now(), scrubbing: false, hidden: false };
    this.setupTimeline();
    this.setupSpeedMenu();
    this.setupAutoHide();
    document.querySelector("#btn-live").onclick = () => this.goLive();
    document.querySelector("#btn-play").onclick = () => this.toggle();
    // Settings > Playback speed.
    addEventListener("dashboard-playback-rate", event => this.setRate(event.detail?.rate));
    this.timer = setInterval(() => this.tick(), 200);
  }

  // Following the live edge counts as playing: the visible log keeps advancing.
  isPlaying() {
    return !!this.recording && (this.follow || this.playing);
  }

  // Live following always runs at 1x; the chosen rate applies to recorded time.
  effectiveRate() {
    return this.follow ? 1 : this.rate;
  }

  toggle() {
    if (!this.recording) return;
    if (this.isPlaying()) {
      this.follow = false;
      this.playing = false;
    } else if (this.time >= this.duration()) {
      // At the end: a live stream resumes following; a recording restarts.
      if (this.recording.status === "live") this.follow = true;
      else { this.time = 0; this.playing = true; }
    } else this.playing = true;
    this.lastTick = performance.now();
    this.reveal();
    this.render();
  }

  setRate(rate) {
    this.rate = normalizeRate(rate);
    storeRate(this.rate);
    dispatchEvent(new CustomEvent("dashboard-playback-rate-changed", { detail: { rate: this.rate } }));
    this.render();
  }

  duration() {
    if (!this.recording) return 0;
    return this.recording.status === "live" ? (Date.now() - this.recording.startedAt) / 1000 : this.recording.duration;
  }

  load(recording, events) {
    this.recording = recording;
    this.events = events;
    this.timeline = new SceneTimeline(events);
    this.follow = recording?.status === "live";
    this.time = this.follow ? this.duration() : 0;
    this.playing = !!recording && !this.follow && readAutoplay();
    this.lastTick = performance.now();
    this.reveal();
    this.render();
  }

  add(event) {
    if (event.recordingId !== this.recording?.id || this.events.some(item => item.id === event.id)) return;
    this.events.push(event);
    this.timeline.push(event);
    applyModeration(this.events, event);
    if (this.follow) this.time = this.duration();
    this.render();
  }

  // Recording time between 200 ms ticks, for smooth canvas animation.
  displayTime() {
    if (!this.recording) return 0;
    if (this.follow) return this.duration();
    if (!this.playing) return this.time;
    return advanceTime(this.time, (performance.now() - this.lastTick) / 1000, this.rate, this.duration());
  }

  goLive() {
    this.follow = this.recording?.status === "live";
    this.time = this.duration();
    this.playing = false;
    this.render();
  }

  tick() {
    const now = performance.now();
    const elapsed = (now - this.lastTick) / 1000;
    this.lastTick = now;
    const duration = this.duration();
    if (this.follow) this.time = duration;
    else if (this.playing) {
      this.time = advanceTime(this.time, elapsed, this.rate, duration);
      if (this.time >= duration) {
        // Replay caught up: a still-live stream rejoins the live edge (1x);
        // a finished recording stops at its end.
        if (this.recording?.status === "live") this.follow = true;
        this.playing = false;
      }
    }
    this.render();
  }

  render() {
    const $ = selector => document.querySelector(selector);
    $("#player").classList.toggle("offline", !this.recording || this.recording.status !== "live");
    $("#stream-title").textContent = this.recording?.title || "AI Platform Live Stream";
    $("#live-label").textContent = this.recording?.status === "live" ? (this.follow ? "LIVE" : "REWIND") : this.recording ? "REPLAY" : "OFFLINE";
    const playing = this.isPlaying();
    $("#btn-play").setAttribute("aria-label", playing ? "Pause" : "Play");
    $("#btn-play").title = playing ? "Pause (k)" : "Play (k)";
    // SVGElement has no `hidden` property; the attribute drives the CSS rule.
    $("#play-icon").toggleAttribute("hidden", playing);
    $("#pause-icon").toggleAttribute("hidden", !playing);
    this.renderSpeed();
    this.renderChrome();
    $("#stream-summary").textContent = this.recording?.summary || "Chat with the host beside the player. Completed streams preserve timed logs and viewer chat for replay.";
    $("#btn-play").disabled = !this.recording;
    $("#btn-live").hidden = this.recording?.status !== "live";
    const duration = this.duration();
    $("#time-elapsed").textContent = formatTime(this.time);
    $("#time-total").textContent = formatTime(duration);
    const percentage = duration ? this.time / duration * 100 : 0;
    $("#progress-elapsed").style.width = `${percentage}%`;
    $("#scrubber").style.left = `${percentage}%`;
    $("#progress-bar").setAttribute("aria-valuemax", String(Math.floor(duration)));
    $("#progress-bar").setAttribute("aria-valuenow", String(Math.floor(this.time)));
    const visible = this.events.filter(event => event.t <= this.time);
    const logs = visible.filter(isLogEvent).slice(-100);
    this.onScene?.(this.timeline.stateAt(this.time));
    const key = `${this.recording?.id}:${logs.at(-1)?.id}:${logs.length}`;
    if (this.renderKey !== key) {
      this.renderKey = key;
      $("#stream-log").replaceChildren(...logs.map(event => logLine(event)));
      $("#captions").textContent = !this.recording ? "The stream is offline. Choose a recording or return when the host goes live." : this.recording.status === "live" ? "Live with OpenClaw" : "Recorded stream";
    }
    this.onChat(visible.filter(isChat));
    const marks = $("#event-marks");
    // Only warnings and worse get a progress-bar checkpoint; info stays in the log.
    marks.replaceChildren(...this.events.filter(event => event.kind !== "chat" && MARK_LEVELS.has(event.level)).slice(-300).map(event => {
      const mark = document.createElement("span");
      mark.className = `event-mark ${event.level}`;
      mark.style.left = `${duration ? event.t / duration * 100 : 0}%`;
      return mark;
    }));
  }

  setupTimeline() {
    const bar = document.querySelector("#progress-bar");
    const tip = document.querySelector("#tooltip");
    let anchor = null;
    const at = event => Math.max(0, Math.min(1, (event.clientX - bar.getBoundingClientRect().left) / bar.clientWidth)) * this.duration();
    const preview = (time, rangeStart) => {
      tip.replaceChildren();
      const title = document.createElement("div");
      title.className = "tt-time";
      title.textContent = rangeStart === undefined ? `Preview at ${formatTime(time)}` : `${formatTime(Math.min(time, rangeStart))} – ${formatTime(Math.max(time, rangeStart))}`;
      tip.append(title);
      const events = rangeStart === undefined ? previewAt(this.events, time) : this.events.filter(event => isLogEvent(event) && event.t >= Math.min(time, rangeStart) && event.t <= Math.max(time, rangeStart)).slice(-5);
      for (const event of events) tip.append(logLine(event));
      if (!events.length) {
        const empty = document.createElement("p");
        empty.textContent = this.events.length && time < this.events[0].t ? "Waiting for the first event at this time." : "No log events recorded at this time.";
        tip.append(empty);
      }
      tip.style.display = "block";
      const rect = bar.getBoundingClientRect();
      tip.style.left = `${Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, rect.left + (this.duration() ? time / this.duration() : 0) * rect.width - tip.offsetWidth / 2))}px`;
      tip.style.top = `${Math.max(8, rect.top - tip.offsetHeight - 12)}px`;
    };
    bar.onpointermove = event => {
      const time = at(event);
      if (anchor !== null) { this.seek(time); preview(time, anchor); }
      else preview(time);
    };
    bar.onpointerenter = event => preview(at(event));
    bar.onpointerdown = event => {
      anchor = at(event);
      this.chrome.scrubbing = true;
      bar.setPointerCapture(event.pointerId);
      this.seek(anchor);
      preview(anchor);
    };
    bar.onpointerup = bar.onpointercancel = () => { anchor = null; this.chrome.scrubbing = false; tip.style.display = "none"; };
    bar.onpointerleave = () => { if (anchor === null) tip.style.display = "none"; };
    bar.onkeydown = event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      this.seek(event.key === "Home" ? 0 : event.key === "End" ? this.duration() : this.time + (event.key === "ArrowRight" ? 5 : -5));
      preview(this.time);
    };
    bar.onblur = () => { tip.style.display = "none"; };
  }

  renderSpeed() {
    const button = document.querySelector("#btn-speed");
    const live = this.follow && this.recording?.status === "live";
    const rate = this.effectiveRate();
    button.disabled = !this.recording || live;
    const label = live ? "Playback speed: 1x while watching live" : `Playback speed: ${formatRate(rate)}`;
    if (button.getAttribute("aria-label") !== label) {
      button.setAttribute("aria-label", label);
      button.title = live ? "Playback speed is fixed at 1x while watching live" : `Playback speed (${formatRate(rate)}; Shift+< / Shift+>)`;
      document.querySelector("#speed-label").textContent = formatRate(rate);
    }
    for (const item of document.querySelectorAll("#speed-menu [data-rate]")) item.setAttribute("aria-checked", String(Number(item.dataset.rate) === this.rate));
    if (button.disabled && this.menuOpen()) this.closeSpeedMenu(false);
  }

  menuOpen() {
    return !document.querySelector("#speed-menu").hidden;
  }

  openSpeedMenu() {
    const menu = document.querySelector("#speed-menu");
    menu.hidden = false;
    document.querySelector("#btn-speed").setAttribute("aria-expanded", "true");
    this.renderSpeed();
    (menu.querySelector('[aria-checked="true"]') || menu.firstElementChild).focus();
  }

  closeSpeedMenu(restoreFocus = true) {
    document.querySelector("#speed-menu").hidden = true;
    const button = document.querySelector("#btn-speed");
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus && !button.disabled) button.focus();
    this.reveal();
  }

  setupSpeedMenu() {
    const button = document.querySelector("#btn-speed");
    const menu = document.querySelector("#speed-menu");
    menu.replaceChildren(...PLAYBACK_RATES.map(rate => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "speed-option";
      item.setAttribute("role", "menuitemradio");
      item.dataset.rate = String(rate);
      item.tabIndex = -1;
      item.textContent = rate === 1 ? "Normal (1x)" : formatRate(rate);
      item.onclick = () => { this.setRate(rate); this.closeSpeedMenu(); };
      return item;
    }));
    button.onclick = () => (this.menuOpen() ? this.closeSpeedMenu() : this.openSpeedMenu());
    menu.onkeydown = event => {
      const items = [...menu.querySelectorAll("[data-rate]")];
      const index = items.indexOf(document.activeElement);
      const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (move) items[(index + move + items.length) % items.length].focus();
      else if (event.key === "Home") items[0].focus();
      else if (event.key === "End") items.at(-1).focus();
      else if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.stopPropagation(); this.closeSpeedMenu(event.key === "Escape"); }
      else return;
      if (event.key !== "Tab") event.preventDefault();
    };
    document.addEventListener("pointerdown", event => {
      if (this.menuOpen() && !event.target.closest(".speed-control")) this.closeSpeedMenu(false);
    });
  }

  reveal() {
    this.chrome.lastActivity = performance.now();
    if (this.chrome.hidden) this.renderChrome();
  }

  renderChrome() {
    const surface = document.querySelector("#screen-surface");
    const focused = document.activeElement;
    const hidden = controlsShouldHide({
      playing: this.isPlaying(),
      menuOpen: this.menuOpen(),
      keyboardFocus: !!focused && document.querySelector("#player-chrome").contains(focused) && focused.matches(":focus-visible"),
      scrubbing: this.chrome.scrubbing,
      pointerInside: this.chrome.pointerInside,
      idleMs: performance.now() - this.chrome.lastActivity,
    });
    if (hidden === this.chrome.hidden) return;
    this.chrome.hidden = hidden;
    surface.classList.toggle("controls-hidden", hidden);
    if (hidden) document.querySelector("#tooltip").style.display = "none";
  }

  setupAutoHide() {
    const surface = document.querySelector("#screen-surface");
    const activity = () => this.reveal();
    surface.addEventListener("pointerenter", event => { if (event.pointerType === "mouse") this.chrome.pointerInside = true; activity(); });
    // Touch and pen have no hover; they reveal on tap and then use the idle delay.
    surface.addEventListener("pointerdown", event => { this.chrome.pointerInside = true; activity(); });
    surface.addEventListener("pointermove", activity);
    surface.addEventListener("pointerleave", event => { if (event.pointerType === "mouse") { this.chrome.pointerInside = false; activity(); } });
    surface.addEventListener("focusin", activity);
    surface.addEventListener("focusout", () => setTimeout(() => this.renderChrome()));
    surface.addEventListener("keydown", event => {
      activity();
      const tag = event.target.tagName;
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (event.key === "k" || event.key === "K" || (event.key === " " && tag !== "BUTTON")) {
        event.preventDefault();
        this.toggle();
      } else if ((event.key === ">" || event.key === "<") && !document.querySelector("#btn-speed").disabled) {
        event.preventDefault();
        this.setRate(stepRate(this.rate, event.key === ">" ? 1 : -1));
      }
    });
  }

  seek(time) {
    this.follow = false;
    this.playing = false;
    this.time = Math.max(0, Math.min(this.duration(), time));
    this.render();
  }
}

function logLine(event) {
  const line = document.createElement("div");
  line.className = `log-line ${event.level}`;
  for (const [className, text] of [["t", formatTime(event.t)], ["src", event.source], ["msg", event.msg]]) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    line.append(span);
  }
  return line;
}
