#!/usr/bin/env node
/**
 * session-importer — Codex MCP server
 *
 * Scans the Claude Code and dsh session stores and imports Claude Code work
 * into Codex's rollout JSONL layout (best effort). dsh sessions are zstd
 * compressed and are reported but not converted. No third-party dependencies.
 */

import { status, importRun, roots } from './scripts/importer.mjs';
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'import_status',
    description:
      'Report what the importer sees: the Claude Code and dsh store roots, how many external sessions are ' +
      'available in each, and the sessions already imported (from the ledger).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'import_run',
    description:
      'Run one import pass over the Claude Code store. With `write: false` (the default) it is a dry run that ' +
      'reports what would be imported without writing anything. With `write: true` it writes Codex rollout JSONL ' +
      'files under ~/.codex/sessions and records them in the ledger. dsh sessions are reported only.',
    inputSchema: {
      type: 'object',
      properties: {
        write: { type: 'boolean', description: 'Whether to actually write the imported rollout files (default false).' },
      },
      additionalProperties: false,
    },
  },
];

async function runTool(name, args) {
  switch (name) {
    case 'import_status':
      return { roots: roots(), ...(await status()) };
    case 'import_run':
      return importRun({ write: args?.write === true });
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
  if (id === undefined) return null;

  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'session-importer', version: '1.0.0' },
      } };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
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
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
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
