import express from 'express';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AdapterStore, mountAdapters } from './adapters.js';

test('adapter access saves atomically, rejects stale edits, and keeps groups isolated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-test-'));
  try {
    const file = path.join(dir, 'policy.json'), config = path.join(dir, 'openclaw.json');
    fs.writeFileSync(file, JSON.stringify({ groups: [] }));
    const id = `astrbot-exec-${crypto.createHash('sha256').update('qq:123').digest('hex').slice(0, 12)}`;
    fs.writeFileSync(config, JSON.stringify({ agents: { list: [{ id: 'astrbot-exec' }, { id, sandbox: { mode: 'all', workspaceAccess: 'none' } }] } }));
    const store = new AdapterStore(file, config), initial = store.read();
    const groups = [{ platform: 'qq', group_id: '123', senders: ['456'] }];
    const next = store.save({ baseHash: initial.hash, ownerEnabled: true, groups });
    assert.deepEqual(next.groups, groups);
    assert.throws(() => store.save({ baseHash: initial.hash, ownerEnabled: false, groups: [] }), /settings changed/);
    assert.throws(() => store.save({ baseHash: next.hash, ownerEnabled: true, groups: [...groups, ...groups] }), /duplicate group/);
    assert.throws(() => store.save({ baseHash: next.hash, ownerEnabled: true, groups: [{ ...groups[0], group_id: '999' }] }), /isolated execution agent/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('adapter routes require administrator, CSRF, and enabled panel', async () => {
  const app = express(); app.use(express.json()); let enabled = true;
  const auth = (req, res, next) => req.get('x-user') ? next() : res.sendStatus(401);
  const admin = (req, res, next) => req.get('x-user') === 'admin' ? next() : res.sendStatus(403);
  const csrf = (req, res, next) => req.get('x-dashboard-request') === '1' ? next() : res.sendStatus(403);
  mountAdapters(app, { read: () => ({ groups: [] }), save: () => ({ groups: [] }) }, { requireAuth: auth, requireAdmin: admin, requireCsrf: csrf, isEnabled: () => enabled });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/adapters`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-user': 'viewer' } })).status, 403);
    assert.equal((await fetch(url, { method: 'PUT', headers: { 'x-user': 'admin' } })).status, 403);
    assert.equal((await fetch(url, { method: 'PUT', headers: { 'x-user': 'admin', 'x-dashboard-request': '1' } })).status, 200);
    enabled = false;
    assert.equal((await fetch(url, { headers: { 'x-user': 'admin' } })).status, 404);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
