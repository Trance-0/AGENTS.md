/**
 * quota — probe the CPA (CliProxy) endpoint for remaining quota.
 *
 * Same logic as the `cpa-usage` plugin, inlined so the task-queue watcher is
 * self-contained. A definitive provider response decides availability: a parsed
 * quota header wins, otherwise 2xx is available, 429 is exhausted. A transport
 * failure returns `available: null` (never flips the reset edge).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_CONFIG = path.join(CODEX_HOME, 'config.toml');

const DEFAULT_BASE = 'https://cpa.trance-0.com/v1';
const DEFAULT_PROBE = '/models';
const DEFAULT_HEADERS = ['x-quota-remaining', 'x-ratelimit-remaining-requests', 'x-ratelimit-remaining', 'x-remaining-credits'];

function tomlString(key, text) {
  const match = text.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`));
  return match ? match[1] : '';
}

async function resolveConfig() {
  let toml = '';
  try {
    toml = await readFile(CODEX_CONFIG, 'utf8');
  } catch {
    /* no config.toml */
  }
  const baseURL = tomlString('base_url', toml) || DEFAULT_BASE;
  const apiKey = process.env.CPA_API_KEY || tomlString('experimental_bearer_token', toml) || '';
  let probePath = DEFAULT_PROBE;
  let headerNames = DEFAULT_HEADERS.slice();
  if (existsSync(path.join(CODEX_HOME, 'cpa-usage.json'))) {
    try {
      const raw = JSON.parse(await readFile(path.join(CODEX_HOME, 'cpa-usage.json'), 'utf8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.probePath === 'string') probePath = raw.probePath;
        if (Array.isArray(raw.quotaHeaderNames)) headerNames = raw.quotaHeaderNames.map(String);
      }
    } catch {
      /* ignore */
    }
  }
  return { baseURL, apiKey, probePath, headerNames };
}

function readQuota(headers, names) {
  for (const name of names) {
    const value = headers.get(name);
    if (value === null || value === undefined) continue;
    const parsed = Number(String(value).trim());
    if (Number.isFinite(parsed)) return { header: name, value: parsed };
  }
  return null;
}

export async function checkQuota() {
  const cfg = await resolveConfig();
  if (cfg.baseURL.trim() === '') return { available: null, error: 'no baseURL' };

  const headers = { accept: 'application/json' };
  if (cfg.apiKey !== '') headers.authorization = 'Bearer ' + cfg.apiKey;

  const base = cfg.baseURL.replace(/\/+$/, '');
  const probe = cfg.probePath.startsWith('/') ? cfg.probePath : '/' + cfg.probePath;

  let response;
  try {
    response = await fetch(base + probe, { headers });
  } catch (error) {
    return { available: null, error: String(error?.message ?? error) };
  }

  const status = response.status;
  const quota = readQuota(response.headers, cfg.headerNames);

  let available;
  if (quota !== null) available = quota.value > 0;
  else if (status >= 200 && status < 300) available = true;
  else if (status === 429) available = false;
  else available = null;

  return { available, remaining: quota ? quota.value : null, status, baseURL: cfg.baseURL };
}
