#!/usr/bin/env node
/**
 * bark-notify — Codex MCP server
 *
 * Configures and drives Bark push notifications: subscribers and their
 * per-type profiles, the message templates for each event kind, the focus
 * mode, and manual/test pushes. The `notify` event hook in
 * ./scripts/notify.mjs shares the same engine. No third-party dependencies;
 * Node >= 18.
 */

import {
  loadState,
  persist,
  deliver,
  deliverEvent,
  flushQueueFile,
  loadQueue,
  resolveProfile,
  renderTemplate,
  TYPE_IDS,
  LEVELS,
  TEMPLATE_KEYS,
  configPath,
} from './scripts/bark-core.mjs';
import readline from 'node:readline';

const state = await loadState();

/** Sample context used to preview a template without sending anything. */
const PREVIEW_CONTEXT = {
  session_title: '重写 Bark 通知模板',
  task: '为 bark-notify 增加模板与订阅者配置',
  complete_summary: '新增模板渲染、按类型推送参数与订阅者独立档案。',
  request_error: '429 Too Many Requests',
  event: 'agent-turn-complete',
  turn_id: '01a0b2b0-51b5-7ca1-91a8-7a84373b1f82',
  cwd: 'D:\\Documents\\Github\\deepseek-harness',
  time: new Date().toLocaleString(),
};

async function snapshot() {
  return {
    configPath: configPath(),
    mode: state.mode,
    templateKeys: TEMPLATE_KEYS,
    levels: LEVELS,
    types: state.types,
    subscribers: state.subscribers.map((subscriber) => ({
      key: subscriber.key.slice(0, 4) + '…',
      label: subscriber.label,
      enabled: subscriber.enabled,
      profiles: subscriber.profiles,
    })),
    pending: (await loadQueue()).map((item, index) => ({ index, kind: item.kind, queuedAt: item.queuedAt })),
  };
}

function findSubscriber(key) {
  const subscriber = state.subscribers.find((entry) => entry.key === key);
  if (subscriber === undefined) throw new Error('订阅者不存在: ' + key);
  return subscriber;
}

function assertType(id) {
  if (!TYPE_IDS.includes(id)) throw new Error('未知通知类型: ' + id);
  return id;
}

/** Copy the presentation fields a caller may set on a type or a profile. */
function applyPresentation(target, args) {
  if (args.level !== undefined) {
    if (!LEVELS.includes(args.level)) throw new Error('未知推送级别: ' + args.level);
    target.level = args.level;
  }
  for (const f of ['sound', 'icon', 'group', 'title', 'body']) {
    if (args[f] !== undefined) target[f] = String(args[f]);
  }
  if (args.enabled !== undefined) target.enabled = args.enabled === true;
}

const PRESENTATION_PROPS = {
  enabled: { type: 'boolean', description: 'Whether this notification type fires.' },
  level: { type: 'string', enum: LEVELS, description: 'Bark interruption level; "passive" pushes silently.' },
  sound: { type: 'string', description: 'Bark sound name; empty inherits the app default.' },
  icon: { type: 'string', description: 'HTTPS URL of a custom push icon.' },
  group: { type: 'string', description: 'Bark group name used to cluster notifications.' },
  title: { type: 'string', description: 'Title template; supports <' + TEMPLATE_KEYS.join('>, <') + '>.' },
  body: { type: 'string', description: 'Body template; supports the same placeholders.' },
};

const TOOLS = [
  {
    name: 'bark_send',
    description: 'Push a Bark notification to all enabled subscribers immediately, bypassing the focus mode.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title.' },
        body: { type: 'string', description: 'Notification body text.' },
        level: { type: 'string', enum: LEVELS, description: 'Optional interruption level.' },
        sound: { type: 'string', description: 'Optional Bark sound name.' },
        icon: { type: 'string', description: 'Optional HTTPS icon URL.' },
        group: { type: 'string', description: 'Optional Bark group name.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'bark_test',
    description: 'Render one event kind with sample data and push it, exercising every subscriber profile.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', enum: TYPE_IDS, description: 'Event kind to test (default taskDone).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'bark_preview',
    description: 'Render an event kind for one subscriber without sending it, to check a template.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', enum: TYPE_IDS, description: 'Event kind to render.' },
        key: { type: 'string', description: 'Subscriber key; defaults to every subscriber.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'bark_state',
    description: 'Return the current configuration: focus mode, per-type templates and push options, subscribers with their profiles, and the away-mode queue.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bark_set_mode',
    description: 'Set the focus mode. "work" pushes immediately; "away" queues event notifications until returned to work.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['work', 'away'], description: 'Target focus mode.' } },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'bark_set_type',
    description: 'Configure one notification type: its toggle, templates, interruption level, sound, icon, and group. These are the defaults every subscriber inherits.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', enum: TYPE_IDS, description: 'Notification type to configure.' },
        ...PRESENTATION_PROPS,
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'bark_set_profile',
    description: 'Override one notification type for one subscriber. Omitted fields, and empty template strings, inherit the type defaults.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Subscriber key.' },
        id: { type: 'string', enum: TYPE_IDS, description: 'Notification type to override.' },
        ...PRESENTATION_PROPS,
      },
      required: ['key', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'bark_clear_profile',
    description: 'Drop a subscriber override so the type defaults apply again.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Subscriber key.' },
        id: { type: 'string', enum: TYPE_IDS, description: 'Notification type to reset.' },
      },
      required: ['key', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'bark_add_subscriber',
    description: 'Add a Bark subscriber by its device key (the segment after https://api.day.app/ in the Bark app).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Device key.' },
        label: { type: 'string', description: 'Optional display label.' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'bark_remove_subscriber',
    description: 'Remove a subscriber by its device key.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Device key.' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'bark_set_subscriber',
    description: 'Enable or disable a single subscriber, or rename it.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Device key.' },
        enabled: { type: 'boolean', description: 'Whether the subscriber receives pushes.' },
        label: { type: 'string', description: 'New display label.' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'bark_flush',
    description: 'Immediately deliver all queued (away-mode) notifications.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function runTool(name, args) {
  switch (name) {
    case 'bark_send': {
      const title = String(args?.title ?? '通知');
      const body = String(args?.body ?? '');
      const results = await deliver(state, title, body, args ?? {});
      return { results, message: summarize(results) };
    }
    case 'bark_test': {
      const id = assertType(String(args?.id ?? 'taskDone'));
      const results = await deliverEvent(state, id, PREVIEW_CONTEXT);
      return { results, message: summarize(results) };
    }
    case 'bark_preview': {
      const id = assertType(String(args?.id));
      const key = String(args?.key ?? '').trim();
      const targets = key === '' ? state.subscribers : [findSubscriber(key)];
      return {
        context: PREVIEW_CONTEXT,
        previews: targets.map((subscriber) => {
          const profile = resolveProfile(state, id, subscriber);
          return {
            subscriber: subscriber.label,
            willSend: state.types[id].enabled !== false && subscriber.profiles?.[id]?.enabled !== false && subscriber.enabled,
            title: renderTemplate(profile.title, PREVIEW_CONTEXT),
            body: renderTemplate(profile.body, PREVIEW_CONTEXT),
            level: profile.level,
            sound: profile.sound,
            icon: profile.icon,
            group: profile.group,
          };
        }),
      };
    }
    case 'bark_state':
      return snapshot();
    case 'bark_set_mode': {
      const mode = String(args?.mode);
      if (mode !== 'work' && mode !== 'away') throw new Error('未知模式: ' + mode);
      const wasAway = state.mode === 'away';
      state.mode = mode;
      await persist(state);
      if (mode === 'work' && wasAway) {
        const flushed = await flushQueueFile(state);
        return { message: '已切换到工作模式' + (flushed.length ? '，已补发 ' + flushed.length + ' 条通知' : ''), state: await snapshot() };
      }
      return { message: mode === 'away' ? '已切换到离开模式，通知将被暂存' : '已切换到工作模式', state: await snapshot() };
    }
    case 'bark_set_type': {
      const id = assertType(String(args?.id));
      applyPresentation(state.types[id], args ?? {});
      await persist(state);
      return { message: '已更新通知类型 ' + id, type: state.types[id] };
    }
    case 'bark_set_profile': {
      const id = assertType(String(args?.id));
      const subscriber = findSubscriber(String(args?.key));
      const profile = subscriber.profiles[id] ?? {};
      applyPresentation(profile, args ?? {});
      subscriber.profiles[id] = profile;
      await persist(state);
      return { message: '已更新 ' + subscriber.label + ' 的 ' + id + ' 档案', profile };
    }
    case 'bark_clear_profile': {
      const id = assertType(String(args?.id));
      const subscriber = findSubscriber(String(args?.key));
      delete subscriber.profiles[id];
      await persist(state);
      return { message: '已恢复 ' + subscriber.label + ' 的 ' + id + ' 默认设置' };
    }
    case 'bark_add_subscriber': {
      const key = String(args?.key ?? '').trim();
      const label = String(args?.label ?? '').trim();
      if (key === '') throw new Error('设备 Key 不能为空');
      if (state.subscribers.some((subscriber) => subscriber.key === key)) throw new Error('该订阅者已存在');
      state.subscribers.push({ key, label: label || '设备 ' + key.slice(0, 6), enabled: true, profiles: {} });
      await persist(state);
      return { message: '已添加订阅者 ' + (label || key.slice(0, 6)), state: await snapshot() };
    }
    case 'bark_remove_subscriber': {
      const key = String(args?.key);
      state.subscribers = state.subscribers.filter((subscriber) => subscriber.key !== key);
      await persist(state);
      return { message: '已删除订阅者', state: await snapshot() };
    }
    case 'bark_set_subscriber': {
      const subscriber = findSubscriber(String(args?.key));
      if (args?.enabled !== undefined) subscriber.enabled = args.enabled === true;
      if (args?.label !== undefined) subscriber.label = String(args.label).trim() || subscriber.label;
      await persist(state);
      return { message: '已更新订阅者 ' + subscriber.label, state: await snapshot() };
    }
    case 'bark_flush': {
      const flushed = await flushQueueFile(state);
      return { message: flushed.length === 0 ? '没有待发通知' : '已补发 ' + flushed.length + ' 条通知', state: await snapshot() };
    }
    default:
      throw new Error('Unhandled tool: ' + name);
  }
}

function summarize(results) {
  const ok = results.filter((entry) => entry.ok).length;
  if (results.length === 0) return '没有匹配的订阅者';
  return ok === results.length ? `已发送到 ${ok} 台设备` : `已发送到 ${ok}/${results.length} 台设备`;
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
        serverInfo: { name: 'bark-notify', version: '1.2.0' },
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
