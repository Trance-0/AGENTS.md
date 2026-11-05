// Scene renderer: draws the folded scene state over the player. All rendering
// is client-side; strings go through textContent / fillText only, and images
// use URLs the server already checked against the admin allowlist (the CSP
// img-src enforces the same origins). Rendering is a pure function of
// (state, t), so live, seek, and every playback rate agree.
import { METRIC_SOURCES, PALETTE, WIDGET_TYPES } from "./schema.js";
import { avatarExpression, catPose, talkFrame } from "./derive.js";
import { AVATAR_RENDERERS } from "./avatar.js";
import { drawCat } from "./cat.js";
import { formatAge, formatCountdown, formatTokens } from "./format.js";

const STALE_MS = 10 * 60 * 1000;
const FRAME_MS = 1000 / 30;
const pad = n => String(n).padStart(2, "0");
const uptime = seconds => { const s = Math.max(0, Math.floor(seconds)); return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };

export class SceneRenderer {
  // host: the #player element. clock(): { t, startedAt, playing }.
  constructor(host, clock, { avatar = "witch" } = {}) {
    this.host = host;
    this.clock = clock;
    this.stage = document.createElement("div");
    this.stage.className = "scene-stage";
    this.stage.setAttribute("aria-label", "Stream scene");
    host.append(this.stage);
    // Back layer for embeds: below the log (z-index 0) and never interactive.
    this.back = document.createElement("div");
    this.back.className = "scene-back";
    this.back.setAttribute("aria-hidden", "true");
    host.prepend(this.back);
    addEventListener("dashboard-theme", () => this.postTheme());
    this.nodes = new Map();
    this.state = null;
    this.override = null;
    this.selected = null;
    this.avatar = AVATAR_RENDERERS[avatar]();
    this.avatar.ready.then(() => this.draw(true));
    new ResizeObserver(() => this.fit()).observe(host);
    this.fit();
    this.loop = this.loop.bind(this);
    this.frame = null;
    document.addEventListener("visibilitychange", () => this.schedule());
  }

  reduced() { return globalThis.dashboardMotion?.reduced?.() ?? false; }

  // Largest 16:9 box inside the player, so normalized positions mean the
  // same thing in normal, theater, web full screen, and full display modes.
  fit() {
    const { clientWidth: width, clientHeight: height } = this.host;
    const w = Math.min(width, height * 16 / 9), h = w * 9 / 16;
    for (const layer of [this.stage, this.back]) Object.assign(layer.style, { width: `${w}px`, height: `${h}px`, left: `${(width - w) / 2}px`, top: `${(height - h) / 2}px` });
    this.stage.style.setProperty("--scene-scale", String(h / 720));
    this.dirty = true;
    this.draw(true);
  }

  widgets() {
    return Object.values(this.override ?? this.state?.widgets ?? {}).sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
  }

  update(state) {
    if (state === this.state && !this.dirty) return;
    this.dirty = false;
    this.state = state;
    this.sync();
    this.draw(false);
    this.schedule();
  }

  setOverride(widgets, selected = this.selected) {
    this.override = widgets;
    this.selected = selected;
    this.sync();
    this.draw(true);
    this.schedule();
  }

  sync() {
    const widgets = this.widgets();
    const seen = new Set();
    for (const widget of widgets) {
      seen.add(widget.id);
      let node = this.nodes.get(widget.id);
      if (!node || node.type !== widget.type) {
        node?.el.remove();
        node = this.create(widget);
        this.nodes.set(widget.id, node);
      }
      node.widget = widget;
      const el = node.el;
      Object.assign(el.style, { left: `${widget.x * 100}%`, top: `${widget.y * 100}%`, width: `${widget.w * 100}%`, height: `${widget.h * 100}%`, zIndex: String(widget.z) });
      el.classList.toggle("selected", this.selected === widget.id);
      el.classList.toggle("mirrored", !!widget.props.mirror);
      if (this.override) {
        el.tabIndex = 0;
        el.setAttribute("role", "button");
        el.setAttribute("aria-label", `${widget.type} widget${widget.props.text ? `: ${widget.props.text}` : ""}. Enter for options, arrow keys to move, Delete to remove.`);
      } else {
        el.removeAttribute("tabindex");
        el.removeAttribute("role");
        el.removeAttribute("aria-label");
      }
      // Embeds live on the back layer; while editing they join the stage so they can be selected.
      // Appending an element that is already in place would move it, which
      // reloads iframes; z-index, not DOM order, decides stacking.
      const layer = WIDGET_TYPES[widget.type]?.back && !this.override ? this.back : this.stage;
      if (el.parentNode !== layer) layer.append(el);
    }
    for (const [id, node] of this.nodes) if (!seen.has(id)) { node.el.remove(); this.nodes.delete(id); }
  }

  create(widget) {
    const el = document.createElement("div");
    el.className = `scene-widget scene-${widget.type}`;
    el.dataset.widgetId = widget.id;
    el.dataset.type = widget.type;
    const node = { el, type: widget.type, widget };
    if (widget.type === "avatar" || widget.type === "cat") {
      node.canvas = document.createElement("canvas");
      node.canvas.setAttribute("aria-hidden", "true");
      el.append(node.canvas);
      el.setAttribute("aria-hidden", "true");
    } else if (widget.type === "embed") {
      // Sandboxed without allow-same-origin: an opaque origin with no access to
      // dashboard cookies, storage, or APIs. pointer-events: none (CSS) keeps
      // clicks, selection, and copy on the log above it.
      node.frame = document.createElement("iframe");
      node.frame.setAttribute("sandbox", "allow-scripts");
      node.frame.referrerPolicy = "no-referrer";
      node.frame.tabIndex = -1;
      node.frame.title = "Embedded dashboard page";
      el.append(node.frame);
    } else if (widget.type === "image") {
      node.img = document.createElement("img");
      node.img.referrerPolicy = "no-referrer";
      node.img.draggable = false;
      node.img.decoding = "async";
      el.append(node.img);
    } else {
      node.label = document.createElement("span");
      node.label.className = "scene-label";
      node.value = document.createElement("span");
      node.value.className = "scene-value";
      node.sub = document.createElement("span");
      node.sub.className = "scene-sub";
      el.append(node.label, node.value, node.sub);
    }
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const handle = document.createElement("span");
      handle.className = `scene-handle ${corner}`;
      handle.dataset.corner = corner;
      handle.setAttribute("aria-hidden", "true");
      el.append(handle);
    }
    return node;
  }

  // Text, metric, clock, and image content (DOM); canvas widgets when `canvas`.
  draw(canvas) {
    const { t, startedAt } = this.clock();
    const state = this.state;
    const wallAt = (startedAt ?? Date.now()) + t * 1000;
    for (const node of this.nodes.values()) {
      const { widget } = node;
      const props = widget.props;
      if (widget.type === "text") {
        this.text(node, "", props.text, "");
        node.el.dataset.color = props.color;
        node.el.dataset.align = props.align;
        node.el.classList.toggle("card", props.card);
        node.el.style.setProperty("--scene-font", String(props.size));
      } else if (widget.type === "clock") {
        this.text(node, props.mode === "wall" ? "UTC" : "Live for", props.mode === "wall" ? new Date(wallAt).toISOString().slice(11, 19) : uptime(t), "");
        node.el.dataset.color = props.color;
        node.el.style.setProperty("--scene-font", String(props.size));
      } else if (widget.type === "metric") {
        node.el.dataset.color = props.color;
        this.metric(node, props, state?.metrics?.[props.source], wallAt);
      } else if (widget.type === "embed") {
        if (node.srcPath !== props.src) {
          node.srcPath = props.src;
          const src = this.embedSrc(props.src);
          if (src) node.frame.src = src;
        }
        node.el.style.opacity = String(props.opacity);
      } else if (widget.type === "image") {
        if (node.img.getAttribute("src") !== props.url && /^https:\/\//.test(props.url)) node.img.src = props.url;
        node.img.alt = props.alt;
        node.img.dataset.fit = props.fit;
      } else if (canvas) this.paint(node, t, state);
    }
  }

  // Same-origin dashboard paths only; the theme rides along as query params,
  // and later changes arrive by postMessage.
  embedSrc(path) {
    if (typeof path !== "string" || !/^\/embed\/[a-z0-9-]+\/$/.test(path)) return null;
    const theme = globalThis.dashboardTheme;
    const params = new URLSearchParams({ theme: document.documentElement.dataset.theme || "dark", preference: theme?.read?.() || "system" });
    if (this.reduced()) params.set("motion", "reduce");
    return `${path}?${params}`;
  }

  postTheme() {
    const message = { type: "dashboard-theme", theme: document.documentElement.dataset.theme || "dark", preference: globalThis.dashboardTheme?.read?.() || "system" };
    // The sandboxed frame has an opaque origin, so "*" is the only target that
    // reaches it; the message carries nothing but the public theme name.
    for (const node of this.nodes.values()) node.frame?.contentWindow?.postMessage(message, "*");
  }

  text(node, label, value, sub) {
    if (node.label.textContent !== label) node.label.textContent = label;
    if (node.value.textContent !== value) node.value.textContent = value;
    if (node.sub.textContent !== sub) node.sub.textContent = sub;
  }

  metric(node, props, data, wallAt) {
    const label = props.label || METRIC_SOURCES[props.source];
    if (!data) return this.text(node, label, "—", "waiting for the next refresh");
    if (props.source.startsWith("tokens.")) return this.text(node, label, formatTokens(data.tokens), "");
    const week = props.source === "cpa.codex.week";
    const reset = data.resetAt ? formatCountdown(data.resetAt - wallAt, week) : null;
    const age = data.updatedAt && wallAt - data.updatedAt > STALE_MS ? ` · as of ${formatAge(wallAt - data.updatedAt)} ago` : "";
    const value = data.remainingPercent === null || data.remainingPercent === undefined ? "—" : `${data.remainingPercent}%`;
    node.el.classList.toggle("empty", data.remainingPercent === 0);
    this.text(node, label, value, `${reset ? `resets in ${reset} · ` : ""}${data.accounts} of ${data.total} accounts${age}`);
  }

  paint(node, t, state) {
    const canvas = node.canvas;
    const ratio = Math.min(2, devicePixelRatio || 1);
    const width = Math.max(1, Math.round(node.el.clientWidth * ratio)), height = Math.max(1, Math.round(node.el.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext("2d");
    const reduced = this.reduced();
    const scene = state ?? { activity: { lastT: null, thinkingSince: null, tools: 0, talkUntil: null, provider: null, taps: [] }, metrics: {} };
    if (node.type === "avatar") {
      const expression = avatarExpression(scene, t);
      node.el.dataset.expression = expression;
      this.avatar.draw(ctx, width, height, { expression, frame: expression === "talk" ? talkFrame(t, reduced) : expression, t, reduced, mirror: node.widget.props.mirror });
    } else {
      const pose = catPose(scene, t, reduced);
      node.el.dataset.pose = pose.pose;
      node.el.dataset.paws = `${pose.left ? "down" : "up"}-${pose.right ? "down" : "up"}`;
      drawCat(ctx, width, height, { ...pose, t, reduced, mirror: node.widget.props.mirror });
    }
  }

  // One requestAnimationFrame loop at most 30 fps, only while the tab is
  // visible and a canvas widget or clock is on stage.
  schedule() {
    if (this.frame || document.hidden) return;
    if (![...this.nodes.values()].some(node => node.canvas || node.type === "clock" || node.type === "metric")) return;
    this.frame = requestAnimationFrame(this.loop);
  }

  loop(now) {
    this.frame = null;
    if (document.hidden) return;
    if (!this.last || now - this.last >= FRAME_MS) {
      this.last = now;
      this.draw(true);
    }
    this.schedule();
  }
}

export { PALETTE };
