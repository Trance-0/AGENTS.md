import express from 'express';
import path from 'node:path';
import { downloadAvatar } from './avatar-remote.js';

export function mountAvatars(app, store, { requireAuth, requireAdmin, requireCsrf, isEnabled = () => true }) {
  const available = (_req, res, next) => Promise.resolve(isEnabled("canvas-settings")).then(on => on ? next() : res.status(404).json({ error: "Avatar settings unavailable: dashboard/panel access — Canvas is disabled." })).catch(next);
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(error => error.status ? res.status(error.status).json({ error: error.message }) : next(error));
  app.get('/api/avatars', route((_req, res) => res.json({ avatars: store.catalog() })));
  app.get('/avatar-assets/:id/:file', route((req, res) => {
    if (!/^[a-f0-9]{24}$/.test(req.params.id) || !/^[a-z][a-z0-9_-]{0,31}\.png$/.test(req.params.file) || !store.pack(req.params.id)?.states[req.params.file.slice(0, -4)]) return res.sendStatus(404);
    res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff' });
    res.sendFile(path.resolve(store.root, req.params.id, req.params.file));
  }));
  app.post('/api/admin/avatars/upload', requireAuth, requireAdmin, available, requireCsrf, express.raw({ type: 'application/zip', limit: '12mb' }), route(async (req, res) => res.status(201).json(await store.import(req.body))));
  app.post('/api/admin/avatars/remote', requireAuth, requireAdmin, available, requireCsrf, route(async (req, res) => res.status(201).json(await store.import(await downloadAvatar(req.body?.url)))));
  app.post('/api/admin/avatars/:id/states', requireAuth, requireAdmin, available, requireCsrf, route(async (req, res) => res.status(201).json(await store.remap(req.params.id, req.body?.name, req.body?.states))));
  app.get('/api/admin/avatars/:id/download', requireAuth, requireAdmin, available, route(async (req, res) => {
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="avatar.zip"', 'Cache-Control': 'private, no-store' });
    res.send(await store.export(req.params.id));
  }));
}
