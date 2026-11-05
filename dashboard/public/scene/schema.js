// Scene widget schemas and the one validator shared by the server (admin and
// OpenClaw routes, saved layout) and the browser editor (form generation and
// pre-checks). Pure ES module: no DOM, clock, or randomness.
//
// A widget is { id, type, x, y, w, h, z, props }. Geometry is normalized to the
// 16:9 stage (0-1) so layouts work at any size. Every field is allowlisted per
// type; unknown types or fields are rejected, never ignored. Strings are only
// ever rendered with textContent / canvas fillText. Image URLs must be HTTPS
// and start with an administrator-configured prefix.

export const SCENE_SV = 1;
export const LIMITS = Object.freeze({ widgets: 24, widgetBytes: 1536, eventBytes: 2048, allowlist: 16, urlLength: 512, minSize: 0.02, zMax: 999 });
export const WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

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
    props: { mirror: { type: "boolean", label: "Mirror", default: false } },
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

function checkProp(type, key, spec, value, allowlist) {
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
  if (spec.type === "url") {
    if (typeof value !== "string" || !value || value.length > LIMITS.urlLength) fail(`${type} field '${field}' must be an HTTPS URL of at most ${LIMITS.urlLength} characters`);
    if (!imageUrlAllowed(value, allowlist)) fail(`${type} URL is not on the administrator's image allowlist`);
    return new URL(value).href;
  }
  fail(`${type} field '${field}' has an unsupported schema`);
}

// Validates and normalizes a complete widget. Missing props take their
// defaults; unknown top-level fields, unknown props, and wrong types fail.
export function validateWidget(input, { allowlist = [] } = {}) {
  if (!plain(input)) fail("a widget must be an object");
  for (const key of Object.keys(input)) if (!["id", "type", "x", "y", "w", "h", "z", "props"].includes(key)) fail(`unknown widget field '${key}'`);
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
    props[key] = spec.type === "url" && value === "" ? fail(`${input.type} field 'props.${key}' is required`) : checkProp(input.type, key, spec, value, allowlist);
  }
  const widget = { id: input.id, type: input.type, x, y, w, h, z, props };
  if (JSON.stringify(widget).length > LIMITS.widgetBytes) fail(`widget exceeds ${LIMITS.widgetBytes} bytes`);
  return widget;
}

// PATCH semantics: geometry, z, and individual props may change; id and type never do.
export function mergeWidget(existing, changes, options) {
  if (!plain(changes)) fail("widget changes must be an object");
  for (const key of Object.keys(changes)) if (!["x", "y", "w", "h", "z", "props"].includes(key)) fail(key === "id" || key === "type" ? `widget field '${key}' cannot be changed` : `unknown widget field '${key}'`);
  if (changes.props !== undefined && !plain(changes.props)) fail("widget field 'props' must be an object");
  return validateWidget({ ...existing, ...changes, props: { ...existing.props, ...(changes.props || {}) } }, options);
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

// The built-in layout used until an administrator saves one: the avatar
// top-right and the cat in its lower-right home.
export function builtinLayout() {
  return [
    { id: "avatar", type: "avatar", ...defaultRect("avatar"), z: 100, props: { mirror: false } },
    { id: "cat", type: "cat", ...defaultRect("cat"), z: 101, props: { mirror: false } },
  ];
}
