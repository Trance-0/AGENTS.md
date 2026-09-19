#!/usr/bin/env node
/**
 * task-queue — Codex MCP server
 *
 * Durable, importance-ordered task queue that resumes existing Codex sessions.
 * The agent creates, lists, transitions, deletes, and force-runs tasks here;
 * the watcher daemon in ./scripts/watcher.mjs auto-resumes the top pending task
 * when CPA quota returns. No third-party dependencies; Node >= 18.
 */

import { createTask, listTasks, getTask, setStatus, deleteTask, pickNext, storePath } from './scripts/store.mjs';
import { runResume } from './scripts/resume.mjs';
import { checkQuota } from './scripts/quota.mjs';
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'task_create',
    description:
      'Create a pending task that continues an existing Codex session later. ' +
      '`sessionId` is the Codex session/thread id or name to resume; `prompt` is the continuation message. ' +
      '`importance` is 1–5 (higher runs first). `model` and `reasoningEffort` optionally override the resume route.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short label (defaults to the first 40 chars of prompt).' },
        importance: { type: 'number', description: '1–5, default 3.' },
        sessionId: { type: 'string', description: 'Codex session/thread id or name to resume.' },
        prompt: { type: 'string', description: 'Continuation prompt sent after resuming.' },
        model: { type: 'string', description: 'Optional model override.' },
        reasoningEffort: { type: 'string', description: 'Optional reasoning effort override.' },
      },
      required: ['sessionId', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_list',
    description: 'List tasks ordered by importance (desc), then oldest update.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'task_get',
    description: 'Return one task by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'task_set_status',
    description: 'Transition a task to pending, running, done, or failed.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'running', 'done', 'failed'] } },
      required: ['id', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_delete',
    description: 'Delete a task by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'task_run',
    description:
      'Resume the highest-priority pending task now via `codex exec resume`, marking it running then done/failed. ' +
      'This is the manual equivalent of the watcher daemon.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'quota',
    description: 'Check current CPA quota availability (used by the watcher to decide when to resume).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function runTool(name, args) {
  switch (name) {
    case 'task_create':
      return createTask(args);
    case 'task_list':
      return { tasks: await listTasks(), storePath: storePath() };
    case 'task_get':
      return getTask(String(args?.id));
    case 'task_set_status':
      return setStatus(String(args?.id), String(args?.status));
    case 'task_delete':
      return { deleted: await deleteTask(String(args?.id)) };
    case 'task_run': {
      const task = await pickNext();
      if (task === null) return { message: '没有待办任务', started: false };
      await setStatus(task.id, 'running');
      const result = await runResume(task, 0);
      await setStatus(task.id, result.ok ? 'done' : 'failed');
      return { started: true, task: { id: task.id, title: task.title, sessionId: task.sessionId }, result };
    }
    case 'quota':
      return checkQuota();
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
        serverInfo: { name: 'task-queue', version: '1.0.0' },
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
