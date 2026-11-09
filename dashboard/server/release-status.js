import fs from 'node:fs';
import path from 'node:path';

export function releaseStatus(directory = process.env.PLATFORM_STATUS_DIR) {
  if (!directory) return null;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, 'openclaw.json'), 'utf8'));
    if (!/^sha256:[a-f0-9]{64}$/.test(value.image_id) || typeof value.revision !== 'string') return null;
    const checked = Date.parse(value.checked_at);
    return { imageId: value.image_id, revision: value.revision.slice(0, 40), createdAt: value.created_at,
      checkedAt: value.checked_at, healthy: value.healthy === true, stale: !Number.isFinite(checked) || Date.now() - checked > 180000,
      action: ['seed', 'deployed', 'rolled-back', 'healthy', 'recovered'].includes(value.action) ? value.action : 'unknown' };
  } catch { return null; }
}
