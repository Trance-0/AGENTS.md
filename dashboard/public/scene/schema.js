// Scene widget schemas and the one validator shared by the server (admin and
// OpenClaw routes, saved layout) and the browser editor (form generation and
// pre-checks). Pure ES module: no DOM, clock, or randomness.
//
// A widget is { id, type, x, y, w, h, z, props } plus `hidden: true` when an
// administrator hid it (omitted when visible, so older widgets keep their
// shape). Geometry is normalized to the 16:9 stage (0-1) so layouts work at any
// size; an embed attached to the log component is instead positioned within
// the log panel's box (0-1 of that box). Every field is allowlisted per
// type; unknown types or fields are rejected, never ignored. Strings are only
// ever rendered with textContent / canvas fillText. Image URLs must be HTTPS
// and start with an administrator-configured prefix.

export const SCENE_SV = 1;
export const LIMITS = Object.freeze({ widgets: 24, widgetBytes: 1536, eventBytes: 2048, allowlist: 16, urlLength: 512, minSize: 0.02, zMax: 999 });
export const WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Avatar expressions OpenClaw may force for a while (`auto` returns to the
// activity-derived picture). Seconds are whole numbers.
export const AVATAR_STATES = Object.freeze(["idle", "blink", "talk", "think", "sleepy"]);
export const AVATAR_SECONDS = Object.freeze({ min: 1, max: 120, default: 10 });

// Text colours, taken from the witch avatar's palette.
export const PALETTE = Object.freeze({
  snow: "#fdf6f3", cream: "#f6e9c8", mist: "#dfdfe6", slate: "#86879d", ink: "#2d2f4e",
  apple: "#e2412b", blush: "#f6b6b2", teal: "#4fb6c8", leaf: "#7da36c",
});

// Public metric sources. Values are computed server-side from existing metrics
// (server/scene/bridge.js); events carry only pooled numbers.
export const METRIC_SOURCES = Object.freeze({
  "cpa.codex.5h": "Codex 5h",
  "cpa.codex.week": "Codex weekly",
  "tokens.today": "Tokens today",
  "tokens.7d": "Tokens 7 days",
});

const colour = { type: "enum", label: "Colour", options: Object.keys(PALETTE), default: "snow" };
export const WIDGET_TYPES = Object.freeze({
  text: {
    label: "Text", rect: { x: 0.05, y: 0.06, w: 0.34, h: 0.1 },
    props: {
      text: { type: "string", label: "Text", min: 1, max: 120, default: "Hello from the stream" },
      size: { type: "number", label: "Font size", min: 10, max: 96, step: 1, integer: true, default: 28 },
      color: colour,
      align: { type: "enum", label: "Alignment", options: ["left", "center", "right"], default: "left" },
      card: { type: "boolean", label: "Card background", default: true },
    },
  },
  metric: {
    label: "Metric", rect: { x: 0.05, y: 0.06, w: 0.24, h: 0.14 },
    props: {
      source: { type: "enum", label: "Source", options: Object.keys(METRIC_SOURCES), labels: METRIC_SOURCES, default: "cpa.codex.5h" },
      label: { type: "string", label: "Label (blank uses the source name)", min: 0, max: 40, default: "" },
      color: colour,
    },
  },
  avatar: {
    label: "Avatar", rect: { x: 0.74, y: 0.1, w: 0.2, h: 0.3556 }, aspect: 1,
    props: {
      mirror: { type: "boolean", label: "Mirror", default: false },
      pack: { type: "string", label: "Avatar pack ID", min: 1, max: 24, default: "witch" },
      state: { type: "string", label: "State (auto or installed state)", min: 1, max: 32, default: "auto" },
      blinkInterval: { type: "number", label: "Blink interval (seconds)", min: 1, max: 60, step: 0.1, default: 4.2 },
      blinkDuration: { type: "number", label: "Blink duration (seconds)", min: 0.05, max: 1, step: 0.05, default: 0.16 },
    },
  },
  cat: {
    label: "Cat", rect: { x: 0.78, y: 0.66, w: 0.18, h: 0.24 },
    props: { mirror: { type: "boolean", label: "Mirror", default: false } },
  },
  clock: {
    label: "Clock", rect: { x: 0.05, y: 0.06, w: 0.16, h: 0.08 },
    props: {
      mode: { type: "enum", label: "Shows", options: ["uptime", "wall"], labels: { uptime: "Stream uptime", wall: "Wall clock (UTC)" }, default: "uptime" },
      size: { type: "number", label: "Font size", min: 10, max: 96, step: 1, integer: true, default: 24 },
      color: colour,
    },
  },
  // Same-origin HTML page from the server-side embed allowlist (dashboard-served
  // paths only), shown in a sandboxed iframe behind the log text. `attach`
  // picks the box it lives in: the log component (default; the embed is that
  // panel's backdrop and moves with it in every screen mode) or the 16:9 stage.
  embed: {
    label: "Embed", rect: { x: 0, y: 0, w: 1, h: 1 }, z: 0, back: true,
    props: {
      src: { type: "embed", label: "Page", default: "" },
      attach: { type: "enum", label: "Attached to", options: ["log", "stage"], labels: { log: "Log component (backdrop behind the log)", stage: "Whole stage (16:9)" }, default: "log" },
      opacity: { type: "number", label: "Opacity", min: 0.05, max: 1, step: 0.05, default: 0.3 },
      monochrome: { type: "boolean", label: "Monochrome status colors (red / yellow / green)", default: false },
      theme: { type: "enum", label: "Theme", options: ["system", "dark", "light"], labels: { system: "System (follows the dashboard theme)", dark: "Dark", light: "Light" }, default: "system" },
    },
  },
  image: {
    label: "Image", rect: { x: 0.05, y: 0.06, w: 0.24, h: 0.24 },
    props: {
      url: { type: "url", label: "Image URL (must match the allowlist)", default: "" },
      alt: { type: "string", label: "Description", min: 0, max: 120, default: "" },
      fit: { type: "enum", label: "Fit", options: ["contain", "cover"], default: "contain" },
    },
  },
});

export class SceneValidationError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
    this.status = 400;
  }
}
const fail = reason => { throw new SceneValidationError(reason); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const round = value => Math.round(value * 10000) / 10000;
// Control characters and bidi overrides could disguise text in a public overlay.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
// Same rule for multi-line text (stream descriptions): newlines and tabs allowed.
const UNSAFE_MULTILINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
export const unsafeText = (text, { multiline = false } = {}) => (multiline ? UNSAFE_MULTILINE : UNSAFE_TEXT).test(text);

// Validates a forced avatar expression: { expression, seconds } or { expression: "auto" }.
export function validateAvatarState(input, available = AVATAR_STATES) {
  if (!plain(input)) fail("the avatar state must be an object");
  for (const key of Object.keys(input)) if (!["expression", "seconds"].includes(key)) fail(`unknown avatar field '${key}'`);
  if (input.expression === "auto") return { expression: "auto" };
  if (typeof input.expression !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(input.expression)) fail("avatar expression must be an installed lowercase state name, or auto");
  if (!available.includes(input.expression)) fail(`avatar expression must be one of ${available.join(", ")}, or auto`);
  const seconds = input.seconds ?? AVATAR_SECONDS.default;
  if (!Number.isInteger(seconds) || seconds < AVATAR_SECONDS.min || seconds > AVATAR_SECONDS.max) fail(`avatar seconds must be a whole number from ${AVATAR_SECONDS.min} to ${AVATAR_SECONDS.max}`);
  return { expression: input.expression, seconds };
}

// Normalizes the admin image allowlist: HTTPS URL prefixes ending in "/".
export function normalizeAllowlist(list) {
  if (!Array.isArray(list)) fail("the image allowlist must be a list of HTTPS URL prefixes");
  if (list.length > LIMITS.allowlist) fail(`the image allowlist holds at most ${LIMITS.allowlist} prefixes`);
  const out = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry.length > LIMITS.urlLength) fail("each allowlist entry must be a URL of at most 512 characters");
    let url;
    try { url = new URL(entry.trim()); } catch { fail(`allowlist entry "${entry.slice(0, 80)}" is not a valid URL`); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("allowlist entries must be HTTPS prefixes without credentials, query, or fragment");
    const prefix = url.origin + (url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`);
    if (!out.includes(prefix)) out.push(prefix);
  }
  return out;
}

export function imageUrlAllowed(value, allowlist = []) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
  return allowlist.some(prefix => url.href.startsWith(prefix));
}

function checkProp(type, key, spec, value, allowlist, embeds) {
  const field = `props.${key}`;
  if (spec.type === "string") {
    if (typeof value !== "string") fail(`${type} field '${field}' must be text`);
    const text = value.trim();
    if (text.length < spec.min || text.length > spec.max) fail(`${type} field '${field}' must be ${spec.min}-${spec.max} characters`);
    if (UNSAFE_TEXT.test(text)) fail(`${type} field '${field}' contains control characters`);
    return text;
  }
  if (spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < spec.min || value > spec.max || (spec.integer && !Number.isInteger(value))) fail(`${type} field '${field}' must be ${spec.integer ? "a whole number" : "a number"} from ${spec.min} to ${spec.max}`);
    return value;
  }
  if (spec.type === "boolean") {
    if (typeof value !== "boolean") fail(`${type} field '${field}' must be true or false`);
    return value;
  }
  if (spec.type === "enum") {
    if (!spec.options.includes(value)) fail(`${type} field '${field}' must be one of ${spec.options.join(", ")}`);
    return value;
  }
  if (spec.type === "embed") {
    if (typeof value !== "string" || !embeds.includes(value)) fail(`${type} page must be one of the dashboard-served embeds (${embeds.join(", ") || "none configured"})`);
    return value;
  }
  if (spec.type === "url") {
    if (typeof value !== "string" || !value || value.length > LIMITS.urlLength) fail(`${type} field '${field}' must be an HTTPS URL of at most ${LIMITS.urlLength} characters`);
    if (!imageUrlAllowed(value, allowlist)) fail(`${type} URL is not on the administrator's image allowlist`);
    return new URL(value).href;
  }
  fail(`${type} field '${field}' has an unsupported schema`);
}

// Validates and normalizes a complete widget. Missing props take their
// defaults; unknown top-level fields, unknown props, and wrong types fail.
export function validateWidget(input, { allowlist = [], embeds = [] } = {}) {
  if (!plain(input)) fail("a widget must be an object");
  for (const key of Object.keys(input)) if (!["id", "type", "x", "y", "w", "h", "z", "props", "hidden"].includes(key)) fail(`unknown widget field '${key}'`);
  if (input.hidden !== undefined && typeof input.hidden !== "boolean") fail("widget field 'hidden' must be true or false");
  const schema = typeof input.type === "string" && Object.hasOwn(WIDGET_TYPES, input.type) ? WIDGET_TYPES[input.type] : null;
  if (!schema) fail(`widget type '${String(input.type).slice(0, 40)}' is not supported`);
  if (typeof input.id !== "string" || !WIDGET_ID.test(input.id)) fail("widget ID must be 1-32 lowercase letters, digits, or hyphens");
  const geometry = {};
  for (const key of ["x", "y", "w", "h"]) {
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`widget field '${key}' must be a number from 0 to 1`);
    geometry[key] = round(value);
  }
  const { x, y, w, h } = geometry;
  if (x < 0 || y < 0 || w < LIMITS.minSize || h < LIMITS.minSize || x + w > 1.0001 || y + h > 1.0001) fail("widget must lie inside the stage (0-1) and be at least 2% wide and tall");
  const z = input.z ?? 100;
  if (!Number.isInteger(z) || z < 0 || z > LIMITS.zMax) fail(`widget field 'z' must be a whole number from 0 to ${LIMITS.zMax}`);
  const source = input.props ?? {};
  if (!plain(source)) fail("widget field 'props' must be an object");
  for (const key of Object.keys(source)) if (!Object.hasOwn(schema.props, key)) fail(`${input.type} widget has no field 'props.${key}'`);
  const props = {};
  for (const [key, spec] of Object.entries(schema.props)) {
    const value = source[key] === undefined ? spec.default : source[key];
    const required = (spec.type === "url" || spec.type === "embed") && value === "";
    props[key] = required ? fail(`${input.type} field 'props.${key}' is required`) : checkProp(input.type, key, spec, value, allowlist, embeds);
  }
  const widget = { id: input.id, type: input.type, x, y, w, h, z, props, ...(input.hidden ? { hidden: true } : {}) };
  if (JSON.stringify(widget).length > LIMITS.widgetBytes) fail(`widget exceeds ${LIMITS.widgetBytes} bytes`);
  return widget;
}

// The built-in circtime backdrop as dashboard 0.2.2-0.2.3 created it: whole
// stage, id "backdrop". Only this widget moves to the log component when an
// older layout or live scene is migrated; every other embed keeps its place.
export function isDefaultBackdrop(widget) {
  return widget?.type === "embed" && widget.id === "backdrop" && widget.props?.src === "/embed/circtime/"
    && widget.x === 0 && widget.y === 0 && widget.w === 1 && widget.h === 1;
}

// Embeds saved or recorded before `attach` existed were on the stage. The
// default backdrop becomes the log component's backdrop; any other embed is
// pinned to the stage, exactly where its administrator put it.
export function migrateWidget(widget) {
  if (widget?.type !== "embed" || !plain(widget.props) || widget.props.attach !== undefined) return widget;
  return { ...widget, props: { ...widget.props, attach: isDefaultBackdrop(widget) ? "log" : "stage" } };
}

// PATCH semantics: geometry, z, visibility, and individual props may change; id and type never do.
export function mergeWidget(existingInput, changes, options) {
  if (!plain(changes)) fail("widget changes must be an object");
  for (const key of Object.keys(changes)) if (!["x", "y", "w", "h", "z", "props", "hidden"].includes(key)) fail(key === "id" || key === "type" ? `widget field '${key}' cannot be changed` : `unknown widget field '${key}'`);
  if (changes.props !== undefined && !plain(changes.props)) fail("widget field 'props' must be an object");
  const existing = migrateWidget(existingInput);
  const merged = { ...existing, ...changes, props: { ...existing.props, ...(changes.props || {}) } };
  if (merged.hidden === false) delete merged.hidden;
  return validateWidget(merged, options);
}

export function validateLayout(input, options) {
  if (!plain(input) || !Array.isArray(input.widgets)) fail("a layout must be an object with a 'widgets' list");
  for (const key of Object.keys(input)) if (!["widgets", "baseVersion"].includes(key)) fail(`unknown layout field '${key}'`);
  if (input.widgets.length > LIMITS.widgets) fail(`a scene holds at most ${LIMITS.widgets} widgets`);
  const ids = new Set();
  return input.widgets.map(item => {
    const widget = validateWidget(item, options);
    if (ids.has(widget.id)) fail(`widget ID '${widget.id}' appears twice`);
    ids.add(widget.id);
    return widget;
  });
}

// Default rectangle for a new widget of a type, kept inside the stage.
export function defaultRect(type) {
  return { ...(WIDGET_TYPES[type]?.rect || { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }) };
}

// ---------- Scene settings (Settings → Canvas settings) ----------
// Defaults for new widgets reuse the widget prop schemas above, so a default
// can never hold a value the widget itself would reject.
export const DEFAULT_PROPS = Object.freeze({ metric: ["source", "color"], avatar: ["mirror", "pack", "state", "blinkInterval", "blinkDuration"], cat: ["mirror"], embed: ["attach", "opacity", "theme", "monochrome"] });
export const REFRESH_MINUTES = Object.freeze([2, 5, 10, 15, 30, 60]);
const EMBED_PATH = /^\/embed\/[a-z0-9-]+\/$/;

export function defaultSettings() {
  const defaults = {};
  for (const [type, keys] of Object.entries(DEFAULT_PROPS)) defaults[type] = Object.fromEntries(keys.map(key => [key, WIDGET_TYPES[type].props[key].default]));
  return {
    imageAllowlist: [],
    // Served embed paths the administrator switched off; empty = all served embeds enabled.
    disabledEmbeds: [],
    defaults,
    // Which built-in widgets the built-in layout includes.
    builtin: { avatar: true, cat: true, embed: true },
    // Metric widgets: refresh interval while a metric widget is live, and
    // whether that refresh also asks CPA for new quota (decision 2).
    metricRefresh: { minutes: 5, cpa: true },
  };
}

// Validates a settings change and merges it over `current` (missing keys keep
// their current values). Unknown keys and values fail, like widgets.
export function normalizeSettings(input, current = defaultSettings()) {
  if (!plain(input)) fail("scene settings must be an object");
  for (const key of Object.keys(input)) if (!["imageAllowlist", "disabledEmbeds", "defaults", "builtin", "metricRefresh"].includes(key)) fail(`unknown settings field '${key}'`);
  const base = defaultSettings();
  const next = {
    imageAllowlist: input.imageAllowlist === undefined ? current.imageAllowlist ?? [] : normalizeAllowlist(input.imageAllowlist),
    disabledEmbeds: current.disabledEmbeds ?? [],
    defaults: Object.fromEntries(Object.entries(base.defaults).map(([type, values]) => [type, { ...values, ...(current.defaults?.[type] || {}) }])),
    builtin: { ...base.builtin, ...(current.builtin || {}) },
    metricRefresh: { ...base.metricRefresh, ...(current.metricRefresh || {}) },
  };
  if (input.disabledEmbeds !== undefined) {
    if (!Array.isArray(input.disabledEmbeds) || input.disabledEmbeds.length > LIMITS.allowlist || !input.disabledEmbeds.every(item => typeof item === "string" && EMBED_PATH.test(item))) fail("disabled embeds must be a list of at most 16 dashboard embed paths such as /embed/circtime/");
    next.disabledEmbeds = [...new Set(input.disabledEmbeds)];
  }
  if (input.defaults !== undefined) {
    if (!plain(input.defaults)) fail("widget defaults must be an object");
    for (const [type, values] of Object.entries(input.defaults)) {
      if (!Object.hasOwn(DEFAULT_PROPS, type)) fail(`widget type '${String(type).slice(0, 40)}' has no defaults`);
      if (!plain(values)) fail(`${type} defaults must be an object`);
      for (const [key, value] of Object.entries(values)) {
        if (!DEFAULT_PROPS[type].includes(key)) fail(`${type} defaults have no field '${String(key).slice(0, 40)}'`);
        next.defaults[type][key] = checkProp(type, key, WIDGET_TYPES[type].props[key], value, [], []);
      }
    }
  }
  if (input.builtin !== undefined) {
    if (!plain(input.builtin)) fail("built-in layout options must be an object");
    for (const [key, value] of Object.entries(input.builtin)) {
      if (!Object.hasOwn(base.builtin, key)) fail(`built-in layout has no option '${String(key).slice(0, 40)}'`);
      if (typeof value !== "boolean") fail(`built-in layout option '${key}' must be true or false`);
      next.builtin[key] = value;
    }
  }
  if (input.metricRefresh !== undefined) {
    if (!plain(input.metricRefresh)) fail("metric refresh must be an object");
    for (const [key, value] of Object.entries(input.metricRefresh)) {
      if (key === "minutes") { if (!REFRESH_MINUTES.includes(value)) fail(`metric refresh interval must be one of ${REFRESH_MINUTES.join(", ")} minutes`); }
      else if (key === "cpa") { if (typeof value !== "boolean") fail("metric refresh field 'cpa' must be true or false"); }
      else fail(`metric refresh has no field '${String(key).slice(0, 40)}'`);
      next.metricRefresh[key] = value;
    }
  }
  return next;
}

// Fills props a new widget left out with the administrator's defaults; the
// validator fills anything else from the schema.
export function withDefaults(input, defaults = {}) {
  if (!plain(input) || typeof input.type !== "string" || !Object.hasOwn(DEFAULT_PROPS, input.type) || !plain(defaults[input.type])) return input;
  const props = plain(input.props) ? { ...input.props } : input.props === undefined ? {} : input.props;
  if (!plain(props)) return input;
  for (const key of DEFAULT_PROPS[input.type]) if (props[key] === undefined && defaults[input.type][key] !== undefined) props[key] = defaults[input.type][key];
  return { ...input, props };
}

// The built-in layout used until an administrator saves one: the avatar
// top-right, the cat in its lower-right home, and (when the deployment serves
// one) the first enabled embed as the log component's backdrop, behind the log
// text. `settings` (optional) supplies the administrator's defaults.
export function builtinLayout({ embeds = [], settings = defaultSettings() } = {}) {
  const defaults = settings.defaults || defaultSettings().defaults, include = { ...defaultSettings().builtin, ...(settings.builtin || {}) };
  return [
    ...(embeds.length && include.embed ? [{ id: "backdrop", type: "embed", ...defaultRect("embed"), z: 0, props: { src: embeds[0], ...defaults.embed } }] : []),
    ...(include.avatar ? [{ id: "avatar", type: "avatar", ...defaultRect("avatar"), z: 100, props: { ...defaults.avatar } }] : []),
    ...(include.cat ? [{ id: "cat", type: "cat", ...defaultRect("cat"), z: 101, props: { ...defaults.cat } }] : []),
  ];
}
