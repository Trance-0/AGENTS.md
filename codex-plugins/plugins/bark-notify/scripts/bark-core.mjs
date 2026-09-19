/**
 * bark-core — shared Bark notification engine (config, templates, queue, push).
 *
 * Configuration persists to `~/.codex/bark-notify.json`; on first run it
 * migrates the old `~/.dsh/bark-notify.json` if present, and upgrades the
 * pre-1.2 shape (boolean `types`, plain `devices`) in memory on every read.
 * Only `node:` builtins and `fetch`.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BARK_BASE = 'https://api.day.app';
export const TYPE_IDS = ['taskDone', 'question', 'approval', 'error', 'start', 'quit'];

/** Bark interruption levels, least to most intrusive. `passive` pushes silently. */
export const LEVELS = ['passive', 'active', 'timeSensitive', 'critical'];

/** Template placeholders a user may write in a title or body template. */
export const TEMPLATE_KEYS = [
  'session_title',
  'complete_summary',
  'request_error',
  'task',
  'event',
  'turn_id',
  'cwd',
  'time',
];

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const STATE_PATH = path.join(CODEX_HOME, 'bark-notify.json');
const QUEUE_PATH = path.join(CODEX_HOME, 'bark-notify-queue.json');
const LEGACY_PATH = path.join(os.homedir(), '.dsh', 'bark-notify.json');

/**
 * Per-type defaults. `start` and `quit` are passive so session bookkeeping
 * never lights up the screen; anything the user must answer is timeSensitive.
 */
export function defaultTypes() {
  return {
    taskDone: {
      enabled: true,
      level: 'active',
      sound: '',
      icon: '',
      group: 'Codex',
      title: '✅ <session_title>',
      body: '任务：<task>\n结果：<complete_summary>',
    },
    question: {
      enabled: true,
      level: 'timeSensitive',
      sound: '',
      icon: '',
      group: 'Codex',
      title: '❓ 需要你的回应',
      body: '<session_title>\n<task>',
    },
    approval: {
      enabled: true,
      level: 'timeSensitive',
      sound: '',
      icon: '',
      group: 'Codex',
      title: '🔐 等待审批',
      body: '<session_title>\n<task>',
    },
    error: {
      enabled: true,
      level: 'timeSensitive',
      sound: '',
      icon: '',
      group: 'Codex',
      title: '⚠️ 出错：<session_title>',
      body: '<request_error>',
    },
    start: {
      enabled: true,
      level: 'passive',
      sound: '',
      icon: '',
      group: 'Codex',
      title: '🚀 会话开始',
      body: '<session_title>',
    },
    quit: {
      enabled: true,
      level: 'passive',
      sound: '',
      icon: '',
      group: 'Codex',
      title: '👋 会话结束',
      body: '<session_title>',
    },
  };
}

/**
 * A fresh configuration has no subscribers: a device key is a credential, so
 * it is added with `bark_add_subscriber` rather than shipped in the source.
 */
export function defaultState() {
  return {
    mode: 'work',
    subscribers: [],
    types: defaultTypes(),
  };
}

function readString(value) {
  return typeof value === 'string' ? value : '';
}

/** Read one type/profile override, keeping only fields the caller actually set. */
function parseOverride(raw, { withEnabled }) {
  const out = {};
  if (raw === null || typeof raw !== 'object') return out;
  if (withEnabled && typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (LEVELS.includes(raw.level)) out.level = raw.level;
  for (const field of ['sound', 'icon', 'group', 'title', 'body']) {
    if (typeof raw[field] === 'string') out[field] = raw[field];
  }
  return out;
}

function parseState(text) {
  const state = defaultState();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return state;
  if (parsed.mode === 'work' || parsed.mode === 'away') state.mode = parsed.mode;

  // `devices` is the pre-1.2 name for `subscribers`.
  const rawSubscribers = Array.isArray(parsed.subscribers) ? parsed.subscribers : parsed.devices;
  if (Array.isArray(rawSubscribers)) {
    const subscribers = [];
    for (const entry of rawSubscribers) {
      if (entry === null || typeof entry !== 'object') continue;
      const key = readString(entry.key).trim();
      if (key === '') continue;
      const profiles = {};
      if (entry.profiles !== null && typeof entry.profiles === 'object') {
        for (const id of TYPE_IDS) {
          const profile = parseOverride(entry.profiles[id], { withEnabled: true });
          if (Object.keys(profile).length > 0) profiles[id] = profile;
        }
      }
      subscribers.push({
        key,
        label: readString(entry.label).trim() || key,
        enabled: entry.enabled !== false,
        profiles,
      });
    }
    if (subscribers.length > 0) state.subscribers = subscribers;
  }

  if (parsed.types !== null && typeof parsed.types === 'object') {
    for (const id of TYPE_IDS) {
      const raw = parsed.types[id];
      // Pre-1.2 stored a bare boolean per type.
      if (typeof raw === 'boolean') state.types[id].enabled = raw;
      else Object.assign(state.types[id], parseOverride(raw, { withEnabled: true }));
    }
  }
  return state;
}

export function configPath() {
  return STATE_PATH;
}

/**
 * Parse stored configuration text into a full state, upgrading older shapes.
 * Empty or unparsable text yields the defaults, so a caller that owns the file
 * (such as the settings dashboard) can read it without duplicating the schema.
 */
export function parseConfig(text) {
  if (String(text ?? '').trim() === '') return defaultState();
  return parseState(text) ?? defaultState();
}

export async function loadState() {
  let text = '';
  if (existsSync(STATE_PATH)) {
    text = await readFile(STATE_PATH, 'utf8');
  } else if (existsSync(LEGACY_PATH)) {
    text = await readFile(LEGACY_PATH, 'utf8');
  }
  if (text === '') return defaultState();
  const state = parseState(text);
  if (state === null) return defaultState();
  return state;
}

export async function persist(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  const payload = { mode: state.mode, subscribers: state.subscribers, types: state.types };
  await writeFile(STATE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

export function enabledSubscribers(state) {
  return state.subscribers.filter((subscriber) => subscriber.enabled);
}

// ── templates ──────────────────────────────────────────────────────────────

/**
 * Substitute `<placeholder>` tokens from `context`. A known key with no value
 * renders empty and its line is dropped; an unknown key is left verbatim so a
 * typo stays visible instead of silently deleting text.
 */
export function renderTemplate(template, context) {
  const filled = String(template ?? '').replace(/<([a-z_]+)>/g, (whole, key) => {
    if (!TEMPLATE_KEYS.includes(key)) return whole;
    return String(context?.[key] ?? '');
  });
  return filled
    .split('\n')
    .filter((line, index, lines) => line.trim() !== '' || index === lines.length - 1)
    .join('\n')
    .trim();
}

/** Merge the type defaults with one subscriber's override for that type. */
export function resolveProfile(state, kind, subscriber) {
  const base = state.types[kind] ?? {};
  const override = subscriber?.profiles?.[kind] ?? {};
  const merged = { ...base, ...override };
  // An empty override string means "inherit", not "blank".
  for (const field of ['title', 'body', 'sound', 'icon', 'group']) {
    if (readString(override[field]).trim() === '') merged[field] = base[field] ?? '';
  }
  return merged;
}

/** Whether `kind` should reach `subscriber`: the type and the profile must both allow it. */
export function subscribes(state, kind, subscriber) {
  if (state.types[kind]?.enabled === false) return false;
  return subscriber?.profiles?.[kind]?.enabled !== false;
}

// ── push ───────────────────────────────────────────────────────────────────

export function buildUrl(key, title, body, options = {}) {
  const segments = [key];
  if (title !== undefined) segments.push(title);
  if (body !== undefined) segments.push(body);
  const url = new URL(BARK_BASE + '/' + segments.map((s) => encodeURIComponent(s)).join('/'));
  for (const field of ['level', 'sound', 'icon', 'group']) {
    const value = readString(options[field]).trim();
    if (value !== '') url.searchParams.set(field, value);
  }
  return url.toString();
}

export async function pushToDevice(key, title, body, options = {}) {
  const url = buildUrl(key, title, body, options);
  try {
    const response = await fetch(url, { method: 'GET' });
    const status = response.status;
    return { key, ok: status >= 200 && status < 300, status };
  } catch (error) {
    return { key, ok: false, status: 0, error: String(error?.message ?? error) };
  }
}

/** Push the same title/body to every enabled subscriber, returning per-device outcomes. */
export async function deliver(state, title, body, options = {}) {
  const results = [];
  for (const target of enabledSubscribers(state)) {
    results.push(await pushToDevice(target.key, title, body, options));
  }
  return results;
}

/**
 * Render and push one event. Each subscriber gets its own profile, so titles,
 * bodies, levels, icons, and the per-type toggle are resolved per device.
 * Returns the per-device outcomes; subscribers that opted out are omitted.
 */
export async function deliverEvent(state, kind, context) {
  const results = [];
  for (const target of enabledSubscribers(state)) {
    if (!subscribes(state, kind, target)) continue;
    const profile = resolveProfile(state, kind, target);
    const title = renderTemplate(profile.title, context);
    const body = renderTemplate(profile.body, context);
    results.push(await pushToDevice(target.key, title, body, profile));
  }
  return results;
}

// ── persistent away-mode queue ─────────────────────────────────────────────
// The `notify` hook is a short-lived process, so an away-mode notification is
// appended here instead of living in a process that is about to exit. The MCP
// server flushes this file when the mode returns to `work` or on demand. The
// event context is queued, not the rendered text, so a template edited while
// away applies when the queue is finally flushed.

export function queuePath() {
  return QUEUE_PATH;
}

export async function loadQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  try {
    const parsed = JSON.parse(await readFile(QUEUE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveQueue(items) {
  await mkdir(path.dirname(QUEUE_PATH), { recursive: true });
  await writeFile(QUEUE_PATH, JSON.stringify(items, null, 2) + '\n', 'utf8');
}

export async function enqueueFile(kind, context) {
  const items = await loadQueue();
  items.push({ kind, context, queuedAt: new Date().toISOString() });
  await saveQueue(items);
  return items.length;
}

export async function flushQueueFile(state) {
  const items = await loadQueue();
  const results = [];
  for (const item of items) {
    // Pre-1.2 queue entries hold rendered title/body instead of a context.
    if (item.context === undefined) results.push(...(await deliver(state, item.title, item.body)));
    else results.push(...(await deliverEvent(state, item.kind, item.context)));
  }
  await saveQueue([]);
  return results;
}
