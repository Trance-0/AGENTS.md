import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseStatus } from './release-status.js';

test('release status exposes only safe fields and marks stale watchdog evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-status-'));
  try {
    const file = path.join(root, 'openclaw.json');
    const value = { image_id: `sha256:${'a'.repeat(64)}`, revision: 'b'.repeat(40), healthy: true, action: 'deployed', checked_at: new Date().toISOString(), env: { SECRET: 'private' } };
    fs.writeFileSync(file, JSON.stringify(value));
    assert.equal(releaseStatus(root).stale, false);
    assert.equal(JSON.stringify(releaseStatus(root)).includes('private'), false);
    value.checked_at = '2020-01-01T00:00:00Z'; fs.writeFileSync(file, JSON.stringify(value));
    assert.equal(releaseStatus(root).stale, true);
    fs.writeFileSync(file, '{}'); assert.equal(releaseStatus(root), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
