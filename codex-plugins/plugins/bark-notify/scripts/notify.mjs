#!/usr/bin/env node
/**
 * bark-notify — Codex `notify` event hook
 *
 * Codex runs the command listed in `~/.codex/config.toml` `notify` with a JSON
 * payload as the last argument, e.g.
 *   {"type":"agent-turn-complete","turn-id":"...","input-messages":["..."],"last-assistant-message":"..."}
 * This maps the payload to an event kind and a template context, then renders
 * each subscriber's profile for that kind. A plain event name (e.g.
 * `turn-ended`) is still accepted as a fallback. In `work` mode it pushes
 * immediately; in `away` mode it queues the context so that a template edited
 * while away still applies when the queue is flushed.
 *
 * Install by adding an entry to `notify` in ~/.codex/config.toml, e.g.:
 *   notify = [ "node", "<absolute path to notify.mjs>" ]
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadState, deliverEvent, enqueueFile, subscribes, enabledSubscribers } from './bark-core.mjs';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl');

/** Collapse whitespace and truncate to `max` characters with an ellipsis. */
function summarizeText(text, max) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + '…';
}

/** Read a payload field that may be hyphenated, underscored, or camelCase. */
function field(payload, ...names) {
  for (const name of names) if (payload[name] !== undefined) return payload[name];
  return undefined;
}

/**
 * Best-effort title of the thread that just finished: the most recently
 * updated `session_index.jsonl` entry, accepted only when it was written
 * within the last 10 minutes so a stale index cannot mislabel the push.
 */
async function recentThreadTitle() {
  if (!existsSync(SESSION_INDEX)) return '';
  try {
    const lines = (await readFile(SESSION_INDEX, 'utf8')).trim().split('\n');
    let latest = null;
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const at = Date.parse(entry?.updated_at ?? '');
      if (!Number.isFinite(at)) continue;
      if (latest === null || at > latest.at) latest = { at, name: String(entry?.thread_name ?? '').trim() };
    }
    if (latest === null || latest.name === '') return '';
    if (Date.now() - latest.at > 10 * 60 * 1000) return '';
    return latest.name;
  } catch {
    return '';
  }
}

/** Classify a Codex notify payload type into one of the configured event kinds. */
function kindForType(type) {
  if (/turn[-_]complete|turn[-_]ended/.test(type)) return 'taskDone';
  if (/approval|permission/.test(type)) return 'approval';
  if (/question|input[-_]request|interrupt/.test(type)) return 'question';
  if (/error|fail/.test(type)) return 'error';
  if (/session[-_]start|start/.test(type)) return 'start';
  if (/session[-_]end|quit|exit/.test(type)) return 'quit';
  return '';
}

/** Build { kind, context } from a Codex notify JSON payload, or null when unrecognised. */
async function mapPayload(payload) {
  const type = String(field(payload, 'type') ?? '').toLowerCase();
  let kind = kindForType(type);
  if (kind === '') return null;

  const inputs = field(payload, 'input-messages', 'input_messages', 'inputMessages');
  const error = summarizeText(field(payload, 'error', 'error-message', 'error_message'), 300);
  // A turn that ended in an error is an `error` event, not a completion.
  if (kind === 'taskDone' && error !== '') kind = 'error';

  const context = {
    session_title: (await recentThreadTitle()) || summarizeText(Array.isArray(inputs) ? inputs.join(' ') : '', 60) || '任务',
    task: summarizeText(Array.isArray(inputs) ? inputs.join(' ') : '', 100),
    complete_summary: summarizeText(field(payload, 'last-assistant-message', 'last_assistant_message', 'lastAssistantMessage'), 300),
    request_error: error,
    event: type,
    turn_id: String(field(payload, 'turn-id', 'turn_id', 'turnId') ?? ''),
    cwd: String(field(payload, 'cwd') ?? ''),
    time: new Date().toLocaleString(),
  };
  return { kind, context };
}

/** Fallback for a hand-wired `notify` that passes a plain event name. */
async function mapEvent(event) {
  const kind = kindForType(event) || 'taskDone';
  return {
    kind,
    context: {
      session_title: (await recentThreadTitle()) || 'Codex',
      task: '',
      complete_summary: '',
      request_error: /error|fail/.test(event) ? event : '',
      event,
      turn_id: '',
      cwd: '',
      time: new Date().toLocaleString(),
    },
  };
}

// Codex appends its JSON payload after any configured args, so the payload —
// or the plain event name in a hand-wired setup — is the last argument.
const lastArg = String(process.argv[process.argv.length - 1] ?? '');
let mapped = null;
if (lastArg.startsWith('{')) {
  try {
    mapped = await mapPayload(JSON.parse(lastArg));
    if (mapped === null) process.exit(0); // recognised JSON, but not an event we push
  } catch {
    mapped = null;
  }
}
if (mapped === null) mapped = await mapEvent(lastArg.toLowerCase());

const { kind, context } = mapped;
const state = await loadState();

// Drop at the source when no enabled subscriber wants this kind.
if (!enabledSubscribers(state).some((subscriber) => subscribes(state, kind, subscriber))) process.exit(0);

if (state.mode !== 'work') {
  const count = await enqueueFile(kind, context);
  console.error('[bark-notify] 离开模式，已暂存 #' + count);
  process.exit(0);
}

const results = await deliverEvent(state, kind, context);
console.error('[bark-notify] ' + kind + ' → ' + results.length + ' 台设备');
process.exit(0);
