#!/usr/bin/env node
/**
 * cpa-usage — Codex MCP server
 *
 * Reports the remaining CPA (CliProxy) quota by probing an OpenAI-compatible
 * endpoint and reading the quota from response headers, the same way the dsh
 * `cliproxy-quota` monitor did. No third-party dependencies; Node >= 18.
 *
 * Tools:
 *   get_quota    Probe the endpoint and return remaining quota + availability.
 *   list_models  List the model ids the endpoint advertises.
 *
 * Configuration is read from `~/.codex/cpa-usage.json` when present, otherwise
 * it falls back to the `model_providers.custom` block in `~/.codex/config.toml`
 * and the `CPA_API_KEY` environment variable. The API key is never written to
 * disk by this plugin.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const PLUGIN_CONFIG = path.join(CODEX_HOME, 'cpa-usage.json');
const CODEX_CONFIG = path.join(CODEX_HOME, 'config.toml');

const DEFAULT_BASE = 'https://cpa.trance-0.com/v1';
const DEFAULT_PROBE = '/models';
const DEFAULT_HEADERS = [
  'x-quota-remaining',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining',
  'x-remaining-credits',
];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function tomlString(key, text) {
  const re = new RegExp(`${key}\\s*=\\s*"([^"]+)"`);
  const match = text.match(re);
  return match ? match[1] : '';
}

async function resolveConfig() {
  const cfg = { baseURL: '', apiKey: '', probePath: DEFAULT_PROBE, quotaHeaderNames: DEFAULT_HEADERS.slice() };

  let toml = '';
  try {
    toml = await readFile(CODEX_CONFIG, 'utf8');
  } catch {
    /* no config.toml */
  }

  // Fallbacks first, then the plugin file overrides.
  cfg.baseURL = tomlString('base_url', toml) || DEFAULT_BASE;
  cfg.apiKey = process.env.CPA_API_KEY || tomlString('experimental_bearer_token', toml) || '';

  if (existsSync(PLUGIN_CONFIG)) {
    try {
      const raw = JSON.parse(await readFile(PLUGIN_CONFIG, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.baseURL === 'string' && raw.baseURL.trim() !== '') cfg.baseURL = raw.baseURL;
        if (typeof raw.apiKey === 'string' && raw.apiKey.trim() !== '') cfg.apiKey = raw.apiKey;
        if (typeof raw.probePath === 'string' && raw.probePath.trim() !== '') cfg.probePath = raw.probePath;
        if (Array.isArray(raw.quotaHeaderNames)) cfg.quotaHeaderNames = raw.quotaHeaderNames.map(String);
      }
    } catch {
      /* ignore a malformed plugin config */
    }
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

function probeUrl(baseURL, probePath) {
  const base = baseURL.replace(/\/+$/, '');
  const p = probePath.startsWith('/') ? probePath : '/' + probePath;
  return base + p;
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

async function probe(cfg) {
  const headers = { accept: 'application/json' };
  if (cfg.apiKey !== '') headers.authorization = 'Bearer ' + cfg.apiKey;

  let response;
  try {
    response = await fetch(probeUrl(cfg.baseURL, cfg.probePath), { headers });
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), available: null };
  }

  const status = response.status;
  const quota = readQuota(response.headers, cfg.quotaHeaderNames);
  const bodyText = await response.text();

  let models = null;
  if (status >= 200 && status < 300) {
    try {
      const body = JSON.parse(bodyText);
      if (body && Array.isArray(body.data)) models = body.data.map((entry) => entry?.id).filter(Boolean);
      else if (body && Array.isArray(body)) models = body.map((entry) => entry?.id).filter(Boolean);
    } catch {
      /* body is not JSON models */
    }
  }

  // A definitive response decides availability: a parsed quota wins, otherwise
  // 2xx is available, 429 is exhausted. A transport error keeps availability null.
  let available;
  let code = 'ok';
  if (quota !== null) {
    available = quota.value > 0;
    code = available ? 'ok' : 'QUOTA';
  } else if (status >= 200 && status < 300) {
    available = true;
  } else if (status === 429) {
    available = false;
    code = 'QUOTA';
  } else {
    available = null;
    code = 'HTTP_' + status;
  }

  return {
    ok: true,
    baseURL: cfg.baseURL,
    probePath: cfg.probePath,
    status,
    available,
    code,
    remaining: quota ? quota.value : null,
    quotaHeader: quota ? quota.header : null,
    models,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'get_quota',
    description:
      'Probe the CPA (CliProxy) endpoint and report remaining quota and availability. ' +
      'Returns `available` (true/false/null when undeterminable), `remaining` count when a ' +
      'quota header was found, and the HTTP status otherwise.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_models',
    description: 'List the model ids the CPA endpoint advertises, if the probe body is a model list.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetQuota() {
  const cfg = await resolveConfig();
  if (cfg.baseURL.trim() === '') return { error: 'No baseURL configured; set CPA_API_KEY and edit ~/.codex/cpa-usage.json' };
  return probe(cfg);
}

async function handleListModels() {
  const cfg = await resolveConfig();
  const result = await probe(cfg);
  if (result.models === null) return { models: null, note: 'Probe body was not a model list.' };
  return { models: result.models, count: result.models.length };
}

async function runTool(name) {
  switch (name) {
    case 'get_quota':
      return handleGetQuota();
    case 'list_models':
      return handleListModels();
    default:
      throw new Error('Unhandled tool: ' + name);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

async function dispatch(request) {
  const { id, method, params } = request;
  if (id === undefined) return null; // notification

  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cpa-usage', version: '1.0.0' },
      } };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call':
      return handleToolCall(id, params);
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
  }
}

async function handleToolCall(id, params) {
  const name = params?.name;
  if (!TOOLS.some((tool) => tool.name === name)) {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + name } };
  }
  try {
    const data = await runTool(name, params?.arguments ?? {});
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false } };
  } catch (err) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true } };
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      return;
    }
    try {
      const response = await dispatch(request);
      if (response) send(response);
    } catch (err) {
      if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: String(err?.message ?? err) } });
    }
  });
}

main();
