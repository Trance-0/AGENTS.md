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
    // Back layer for stage-attached embeds: below the log (z-index 0) and never interactive.
    this.back = document.createElement("div");
    this.back.className = "scene-back";
    this.back.setAttribute("aria-hidden", "true");
    host.prepend(this.back);
    // Log-component layer: embeds attached to the log panel are its backdrop.
    // It tracks the log element's box (so it moves with the log in theater,
    // full screen, and mobile layouts) and sits right before the log in the
    // DOM at the same z-index, so the log text always paints above it.
    this.log = host.querySelector(".stream-log");
    this.logBack = document.createElement("div");
    this.logBack.className = "scene-log-back";
    this.logBack.setAttribute("aria-hidden", "true");
    if (this.log) this.log.before(this.logBack); else host.prepend(this.logBack);
    addEventListener("dashboard-theme", () => this.postTheme());
    this.nodes = new Map();
    this.state = null;
    this.override = null;
    this.selected = null;
    this.avatar = AVATAR_RENDERERS[avatar]();
    this.avatar.ready.then(() => this.draw(true));
    const resize = new ResizeObserver(() => this.fit());
    resize.observe(host);
    if (this.log) resize.observe(this.log);
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
    const log = this.log;
    Object.assign(this.logBack.style, log
      ? { left: `${log.offsetLeft}px`, top: `${log.offsetTop}px`, width: `${log.offsetWidth}px`, height: `${log.offsetHeight}px` }
      : { left: "0px", top: "0px", width: `${width}px`, height: `${height}px` });
    this.stage.style.setProperty("--scene-scale", String(h / 720));
    this.dirty = true;
    this.draw(true);
  }

  widgets() {
    return Object.values(this.override ?? this.state?.widgets ?? {}).sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
  }

  // Which layer a widget lives on. Embeds recorded before `attach` existed
  // were on the stage, so old recordings replay exactly as they did.
  layerOf(widget) {
    if (!WIDGET_TYPES[widget.type]?.back) return this.stage;
    if (widget.props.attach === "log") return this.logBack;
    // Stage embeds join the stage while editing so they can be selected.
    return this.override && !this.keepBackdropLayer ? this.stage : this.back;
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
      // Hidden widgets are not drawn for viewers; the editor shows them dimmed so they can be shown again.
      el.hidden = !!widget.hidden && !this.override;
      el.classList.toggle("scene-hidden", !!widget.hidden);
      if (this.override) {
        el.tabIndex = 0;
        el.setAttribute("role", "button");
        el.setAttribute("aria-label", `${widget.type} widget${widget.props.text ? `: ${widget.props.text}` : ""}${widget.props.attach === "log" ? " (log component backdrop)" : ""}${widget.hidden ? " (hidden)" : ""}. Enter for options, arrow keys to move, Delete to remove.`);
      } else {
        el.removeAttribute("tabindex");
        el.removeAttribute("role");
        el.removeAttribute("aria-label");
      }
      // Appending an element that is already in place would move it, which
      // reloads iframes; z-index, not DOM order, decides stacking.
      const layer = this.layerOf(widget);
      if (el.parentNode !== layer) layer.append(el);
    }
    this.logBack.classList.toggle("editing", !!this.override);
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
        // A fixed theme is part of the URL; "system" follows the dashboard
        // theme by postMessage without a reload.
        const key = `${props.src}|${props.theme ?? "system"}|${!!props.monochrome}`;
        if (node.srcKey !== key) {
          node.srcKey = key;
          const src = this.embedSrc(props.src, props.theme, props.monochrome);
          if (src) node.frame.src = src;
        }
        node.el.style.opacity = String(props.opacity);
        node.el.dataset.attach = props.attach === "log" ? "log" : "stage";
      } else if (widget.type === "image") {
        if (node.img.getAttribute("src") !== props.url && /^https:\/\//.test(props.url)) node.img.src = props.url;
        node.img.alt = props.alt;
        node.img.dataset.fit = props.fit;
      } else if (canvas) this.paint(node, t, state);
    }
  }

  // Same-origin dashboard paths only. The embed contract (circtime): embed=1,
  // the resolved theme (the dark radar is faint on light), and parent_origin so
  // the opaque-origin frame can verify where theme messages come from.
  // `theme`: the widget's theme prop; "system" (or absent) is the resolved
  // dashboard theme from the theme helper (public/theme.js).
  embedSrc(path, theme = "system", monochrome = false) {
    if (typeof path !== "string" || !/^\/embed\/[a-z0-9-]+\/$/.test(path)) return null;
    const resolved = theme === "dark" || theme === "light" ? theme : document.documentElement.dataset.theme || "dark";
    const params = new URLSearchParams({ embed: "1", theme: resolved, parent_origin: location.origin });
    if (monochrome) params.set("monochrome", "1");
    if (this.reduced()) params.set("motion", "reduce");
    return `${path}?${params}`;
  }

  postTheme() {
    const theme = document.documentElement.dataset.theme || "dark";
    // The sandboxed frame's origin is "null", so "*" is the only target that
    // reaches it; the message carries nothing but the public theme name.
    for (const node of this.nodes.values()) {
      if (!node.frame || (node.widget.props.theme ?? "system") !== "system") continue;
      node.frame.contentWindow?.postMessage({ type: "circtime-theme", theme }, "*");
    }
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
      const props = node.widget.props;
      const pack = props.pack || "witch";
      if (node.avatarPack !== pack) {
        node.avatarPack = pack; node.avatarRenderer = AVATAR_RENDERERS.witch(pack);
        node.avatarRenderer.ready.then(() => this.draw(true));
      }
      const expression = avatarExpression(scene, t, props);
      node.el.dataset.expression = expression;
      node.avatarRenderer.draw(ctx, width, height, { expression, frame: expression === "talk" ? talkFrame(t, reduced) : expression, t, reduced, mirror: node.widget.props.mirror });
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
    // A renderer whose host left the page (a closed settings preview) stops.
    if (this.frame || document.hidden || !this.host.isConnected) return;
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
