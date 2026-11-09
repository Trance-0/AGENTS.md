import fs from 'node:fs';
import { OpenClawConfigStore } from './openclaw-config.js';
import path from 'node:path';
import crypto from 'node:crypto';

const OWNER_TOOLS = ['exec', 'process', 'read', 'write', 'edit', 'apply_patch', 'sessions_spawn'];
const GROUP_TOOLS = ['pcp_execute'];
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const fail = (status, cause) => Object.assign(new Error(`Adapter change refused: dashboard/adapter settings — ${cause}`), { status });
export class AdapterStore {
  constructor(file, openclawFile) { this.file = file; this.openclawFile = openclawFile; }
  read() {
    const text = fs.readFileSync(this.file, 'utf8');
    const policy = JSON.parse(text);
    return { hash: hash(text), ownerEnabled: !!policy.owner, groups: (policy.groups || []).map(({ platform, group_id, senders }) => ({ platform, group_id, senders })) };
  }
  save(input) {
    const current = this.read();
    if (input?.baseHash !== current.hash) throw fail(409, 'settings changed; refresh before saving');
    if (typeof input.ownerEnabled !== 'boolean' || !Array.isArray(input.groups) || input.groups.length > 100) throw fail(400, 'invalid owner or group settings');
    const seen = new Set();
    const configStore = new OpenClawConfigStore({ file: this.openclawFile, backupDir: path.join(path.dirname(this.file), 'backups', 'openclaw') });
    const currentConfig = configStore.read();
    const config = currentConfig.config;
    const agents = config.agents?.list || [];
    const additions = [];
    const groups = input.groups.map(group => {
      if (!group || !/^[a-z][a-z0-9_-]{0,31}$/.test(group.platform) || !/^[A-Za-z0-9._@+=-]{1,128}$/.test(group.group_id)) throw fail(400, 'each group needs a platform and valid group ID');
      const key = `${group.platform}:${group.group_id}`;
      if (seen.has(key)) throw fail(400, 'duplicate group entry');
      seen.add(key);
      const senders = group.senders;
      if (!['owner', 'all'].includes(senders) && !(Array.isArray(senders) && senders.length > 0 && senders.length <= 100 && senders.every(id => typeof id === 'string' && /^[A-Za-z0-9._@+=-]{1,128}$/.test(id)))) throw fail(400, 'choose owner, all members, or a nonempty sender-ID list');
      const agent = `astrbot-exec-${hash(key).slice(0, 12)}`;
      additions.push({ id: agent, name: `AstrBot ${group.platform} group ${group.group_id}`,
        workspace: `/home/node/.openclaw/group-agents/${agent}`, memorySearch: { enabled: false },
        tools: { profile: 'minimal', alsoAllow: ['pcp_context', 'pcp_search', 'pcp_attachment', 'pcp_execute'],
          deny: ['group:fs', 'group:runtime', 'group:ui', 'group:web', 'group:sessions', 'group:memory', 'group:automation', 'group:nodes', 'group:messaging'], elevated: { enabled: false } } });
      return { platform: group.platform, group_id: group.group_id, senders, agent, tools: GROUP_TOOLS };
    });
    if (input.ownerEnabled && !agents.some(a => a.id === 'astrbot-exec')) throw fail(409, 'owner execution agent is not installed');
    if (additions.length) {
      config.agents = { ...config.agents, list: [...agents.filter(a => !additions.some(g => g.id === a.id)), ...additions] };
      configStore.save(JSON.stringify(config), currentConfig.hash);
    }
    const policy = { ...(input.ownerEnabled ? { owner: { agent: 'astrbot-exec', tools: OWNER_TOOLS } } : {}), groups };
    const backup = path.join(path.dirname(this.file), 'backups');
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.copyFileSync(this.file, path.join(backup, `${Date.now()}-${current.hash}.json`));
    const temp = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, this.file);
    return this.read();
  }
}

export function mountAdapters(app, store, { requireAuth, requireAdmin, requireCsrf, isEnabled }) {
  const available = async (_req, res, next) => {
    if (!await isEnabled('adapter-settings')) return res.status(404).json({ error: 'Adapter settings unavailable: dashboard/panel lookup — panel is disabled.' });
    if (!store) return res.status(503).json({ error: 'Adapter settings unavailable: dashboard/adapter storage — shared policy directory is not configured.' });
    next();
  };
  const route = fn => (req, res, next) => { try { res.set('Cache-Control', 'no-store').json(fn(req)); } catch (e) { if (e.status) res.status(e.status).json({ error: e.message }); else next(e); } };
  app.get('/api/admin/adapters', requireAuth, requireAdmin, available, route(() => store.read()));
  app.put('/api/admin/adapters', requireAuth, requireAdmin, requireCsrf, available, route(req => store.save(req.body)));
}
