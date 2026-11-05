export const formatTime = seconds => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
};

export function previewAt(events, time) {
  return events.filter(event => event.kind !== "chat" && event.t <= time).slice(-5);
}

const MARK_LEVELS = new Set(["warn", "error", "fatal", "critical"]);

export class Player {
  constructor(onChat) {
    this.events = [];
    this.recording = null;
    this.time = 0;
    this.follow = true;
    this.playing = false;
    this.onChat = onChat;
    this.lastTick = performance.now();
    this.setupTimeline();
    document.querySelector("#btn-live").onclick = () => this.goLive();
    document.querySelector("#btn-play").onclick = () => {
      const wasPlaying = this.follow || this.playing;
      if (!wasPlaying && this.time >= this.duration()) this.time = 0;
      this.follow = false;
      this.playing = !wasPlaying;
      this.render();
    };
    this.timer = setInterval(() => this.tick(), 200);
  }

  duration() {
    if (!this.recording) return 0;
    return this.recording.status === "live" ? (Date.now() - this.recording.startedAt) / 1000 : this.recording.duration;
  }

  load(recording, events) {
    this.recording = recording;
    this.events = events;
    this.follow = recording?.status === "live";
    this.time = this.follow ? this.duration() : 0;
    this.playing = !!recording && !this.follow;
    this.lastTick = performance.now();
    this.render();
  }

  add(event) {
    if (event.recordingId !== this.recording?.id || this.events.some(item => item.id === event.id)) return;
    this.events.push(event);
    if (this.follow) this.time = this.duration();
    this.render();
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
    if (this.follow) this.time = this.duration();
    else if (this.playing) this.time = Math.min(this.duration(), this.time + elapsed);
    if (!this.follow && this.time >= this.duration()) this.playing = false;
    this.render();
  }

  render() {
    const $ = selector => document.querySelector(selector);
    $("#player").classList.toggle("offline", !this.recording || this.recording.status !== "live");
    $("#stream-title").textContent = this.recording?.title || "AI Platform Live Stream";
    $("#live-label").textContent = this.recording?.status === "live" ? (this.follow ? "LIVE" : "REWIND") : this.recording ? "REPLAY" : "OFFLINE";
    const playing = this.follow || this.playing;
    $("#btn-play").setAttribute("aria-label", playing ? "Pause" : "Play");
    $("#btn-play").title = playing ? "Pause" : "Play";
    $("#play-icon").hidden = playing;
    $("#pause-icon").hidden = !playing;
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
    const logs = visible.filter(event => event.kind !== "chat").slice(-100);
    const key = `${this.recording?.id}:${logs.at(-1)?.id}:${logs.length}`;
    if (this.renderKey !== key) {
      this.renderKey = key;
      $("#stream-log").replaceChildren(...logs.map(event => logLine(event)));
      $("#captions").textContent = !this.recording ? "The stream is offline. Choose a recording or return when the host goes live." : this.recording.status === "live" ? "Live with OpenClaw" : "Recorded stream";
    }
    this.onChat(visible.filter(event => event.kind === "chat"));
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
      const events = rangeStart === undefined ? previewAt(this.events, time) : this.events.filter(event => event.kind !== "chat" && event.t >= Math.min(time, rangeStart) && event.t <= Math.max(time, rangeStart)).slice(-5);
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
      bar.setPointerCapture(event.pointerId);
      this.seek(anchor);
      preview(anchor);
    };
    bar.onpointerup = bar.onpointercancel = () => { anchor = null; tip.style.display = "none"; };
    bar.onpointerleave = () => { if (anchor === null) tip.style.display = "none"; };
    bar.onkeydown = event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      this.seek(event.key === "Home" ? 0 : event.key === "End" ? this.duration() : this.time + (event.key === "ArrowRight" ? 5 : -5));
      preview(this.time);
    };
    bar.onblur = () => { tip.style.display = "none"; };
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
