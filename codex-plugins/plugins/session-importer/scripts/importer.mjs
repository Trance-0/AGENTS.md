/**
 * importer — scan external coding-tool session stores and import them into
 * Codex's rollout JSONL layout (best effort).
 *
 * Sources understood:
 *   - Claude Code: ~/.claude/projects/**​/*.jsonl  (plain JSONL, converted)
 *   - dsh:         ~/.dsh/sessions/**​/session.*.jsonl.zstd  (zstd — reported only;
 *                  conversion requires an external `zstd` decompressor)
 *
 * The Codex rollout shape produced is `session_meta` followed by one
 * `response_item` message per user/assistant turn. It is a best-effort import:
 * Codex may need to reindex before imported sessions appear in `codex resume`.
 * Nothing writes back to the source stores.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CLAUDE_ROOT = path.join(os.homedir(), '.claude', 'projects');
const DSH_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const CODEX_SESSIONS = path.join(CODEX_HOME, 'sessions');
const LEDGER_PATH = path.join(CODEX_HOME, 'session-importer.json');

export function roots() {
  return { claudeRoot: CLAUDE_ROOT, dshRoot: DSH_ROOT, codexSessions: CODEX_SESSIONS, ledgerPath: LEDGER_PATH };
}

async function walkFiles(dir, suffix) {
  const out = [];
  async function recurse(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await recurse(full);
      else if (entry.name.endsWith(suffix)) out.push(full);
    }
  }
  await recurse(dir);
  return out;
}

function textOfClaudeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && (block.type === 'text' || block.type === 'output_text'))
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n');
}

async function readClaude(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const messages = [];
  let cwd = '';
  let model = '';
  let firstTs = '';
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    if (typeof record.cwd === 'string' && record.cwd !== '') cwd = record.cwd;
    if (firstTs === '' && typeof record.timestamp === 'string') firstTs = record.timestamp;
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const message = record.message;
    if (!message) continue;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof message.model === 'string' && message.model !== '') model = message.model;
    const text = textOfClaudeContent(message.content).trim();
    if (text === '') continue;
    messages.push({ role, text });
  }
  if (messages.length === 0) return null;
  const sessionId = (raw.match(/"sessionId"\s*:\s*"([^"]+)"/) || [])[1] || path.basename(file, '.jsonl');
  return { sessionId, cwd, model, firstTs, messages };
}

function codexLines(claude, timestampMs) {
  const ts = new Date(timestampMs).toISOString();
  const id = claude.sessionId || randomUUID();
  const lines = [];
  let ordinal = 0;
  lines.push(JSON.stringify({
    timestamp: ts,
    ordinal: ordinal++,
    type: 'session_meta',
    payload: {
      session_id: id,
      id,
      timestamp: ts,
      cwd: claude.cwd,
      originator: 'session-importer',
      cli_version: '0.148.0',
      source: 'cli',
      model_provider: 'custom',
      base_instructions: { text: 'Imported from Claude Code by the session-importer plugin.' },
    },
  }));
  for (const message of claude.messages) {
    lines.push(JSON.stringify({
      timestamp: ts,
      ordinal: ordinal++,
      type: 'response_item',
      payload: {
        type: 'message',
        role: message.role,
        content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text }],
      },
    }));
  }
  return lines;
}

function rolloutPath(timestampMs, sessionId) {
  const d = new Date(timestampMs);
  const p = (n) => String(n).padStart(2, '0');
  const ym = String(d.getFullYear());
  const month = p(d.getMonth() + 1);
  const day = p(d.getDate());
  const stamp = `${ym}-${month}-${day}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  const name = `rollout-${stamp}-${sessionId}.jsonl`;
  return path.join(CODEX_SESSIONS, ym, month, day, name);
}

async function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return {};
  try {
    const parsed = JSON.parse(await readFile(LEDGER_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveLedger(ledger) {
  await mkdir(path.dirname(LEDGER_PATH), { recursive: true });
  await writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

function scanDsh() {
  // List dsh session dirs (zstd). Conversion is out of scope without a zstd codec.
  const found = [];
  if (!existsSync(DSH_ROOT)) return found;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.zstd')) found.push(full);
    }
  };
  walk(DSH_ROOT);
  return found;
}

export async function importRun({ write = false } = {}) {
  const ledger = await loadLedger();
  const claudeFiles = await walkFiles(CLAUDE_ROOT, '.jsonl');
  const dshFiles = scanDsh();

  const report = { claudeScanned: claudeFiles.length, imported: 0, skipped: 0, failures: [], dshFound: dshFiles.length, dshNote: null, dryRun: !write };

  for (const file of claudeFiles) {
    let state;
    try {
      state = statSync(file);
    } catch {
      continue;
    }
    const key = 'claude:' + path.basename(file, '.jsonl');
    const stateToken = state.size + ':' + state.mtimeMs;
    if (ledger[key] && ledger[key].state === stateToken) {
      report.skipped += 1;
      continue;
    }

    const claude = await readClaude(file);
    if (claude === null) {
      report.failures.push({ file, error: 'unreadable or empty' });
      continue;
    }

    const timestampMs = claude.firstTs ? Date.parse(claude.firstTs) || Date.now() : Date.now();
    const lines = codexLines(claude, timestampMs);

    if (write) {
      const target = rolloutPath(timestampMs, claude.sessionId);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, lines.join('\n') + '\n', 'utf8');
      ledger[key] = { source: 'claude', sessionId: claude.sessionId, cwd: claude.cwd, model: claude.model, turns: claude.messages.length, state: stateToken, rolloutPath: target, importedAt: new Date().toISOString() };
    }
    report.imported += 1;
  }

  if (write) await saveLedger(ledger);
  report.dshNote = dshFiles.length > 0
    ? dshFiles.length + ' dsh sessions found (zstd-compressed); conversion requires a zstd codec and is skipped.'
    : null;

  return report;
}

export async function status() {
  const ledger = await loadLedger();
  const claudeFiles = await walkFiles(CLAUDE_ROOT, '.jsonl');
  const dshFiles = scanDsh();
  return {
    claudeRoot: CLAUDE_ROOT,
    dshRoot: DSH_ROOT,
    codexSessions: CODEX_SESSIONS,
    claudeAvailable: claudeFiles.length,
    dshAvailable: dshFiles.length,
    importedCount: Object.keys(ledger).length,
    imported: Object.values(ledger).slice(-50).reverse(),
  };
}
