import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import express from 'express';
import { mountAvatars } from './scene/avatar-routes.js';
import { AvatarStore } from './scene/avatars.js';
import { downloadAvatar } from './scene/avatar-remote.js';
import { blinking, avatarExpression } from '../public/scene/derive.js';
import { initialState } from '../public/scene/reduce.js';

test('avatar ZIP import strips metadata, preserves immutable resources and exports/edit states', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatars-')); const store = new AvatarStore(dir);
  try {
    const frame = await sharp({ create: { width: 30, height: 20, channels: 4, background: '#aabbcc' } }).withExif({ IFD0: { Artist: 'private-metadata' } }).png().toBuffer();
    const zip = zipSync({ 'idle.png': frame, 'blink.png': frame });
    const pack = await store.import(zip);
    assert.equal((await store.import(zip)).id, pack.id);
    assert.equal((await sharp(fs.readFileSync(path.join(dir, pack.id, 'idle.png'))).metadata()).exif, undefined);
    const exported = unzipSync(await store.export(pack.id)); assert.ok(exported['manifest.json']); assert.ok(exported['idle.png']);
    const edited = await store.remap(pack.id, 'Custom happy avatar', { idle: 'idle', happy: 'blink' });
    assert.notEqual(edited.id, pack.id); assert.ok(store.pack(pack.id)); assert.ok(edited.states.happy);
    const builtin = unzipSync(await store.export('witch')); assert.ok(builtin['idle.png']);
    await assert.rejects(store.import(zipSync({ '../idle.png': frame })), /paths/);
    await assert.rejects(store.import(zipSync({ 'manifest.json': strToU8('{"states":{"idle":"evil.png"}}'), 'evil.png': strToU8('<svg/>') })), /supported|decodable/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('avatar remote import refuses private endpoints and non-HTTPS URLs', async () => {
  await assert.rejects(downloadAvatar('http://example.com/avatar.zip'), /HTTPS/);
  await assert.rejects(downloadAvatar('https://127.0.0.1/avatar.zip'), /private|reserved/);
});
test('avatar blink interval and explicit installed state affect rendering', () => {
  const count = period => Array.from({ length: 10000 }, (_, i) => blinking(i / 100, period, .2)).filter(Boolean).length;
  assert.ok(count(2) > count(10) * 3);
  assert.equal(avatarExpression(initialState(), 4, { state: 'happy' }), 'happy');
});

test('avatar mutation routes require administrator, same-origin header and enabled Canvas panel', async () => {
  let enabled = true, uploads = 0;
  const app = express(); app.use(express.json());
  const auth = (q, s, n) => q.get('x-user') ? n() : s.sendStatus(401);
  const admin = (q, s, n) => q.get('x-user') === 'admin' ? n() : s.sendStatus(403);
  const csrf = (q, s, n) => q.get('x-dashboard-request') === '1' ? n() : s.sendStatus(403);
  mountAvatars(app, { catalog: () => [], import: async () => { uploads++; return { id: 'test' }; } }, { requireAuth: auth, requireAdmin: admin, requireCsrf: csrf, isEnabled: () => enabled });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/avatars/upload`;
  const send = headers => fetch(url, { method: 'POST', headers: { 'content-type': 'application/zip', ...headers }, body: new Uint8Array([1]) });
  try {
    assert.equal((await send({})).status, 401);
    assert.equal((await send({ 'x-user': 'member' })).status, 403);
    assert.equal((await send({ 'x-user': 'admin' })).status, 403);
    assert.equal((await send({ 'x-user': 'admin', 'x-dashboard-request': '1' })).status, 201);
    enabled = false;
    assert.equal((await send({ 'x-user': 'admin', 'x-dashboard-request': '1' })).status, 404);
    assert.equal(uploads, 1);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
