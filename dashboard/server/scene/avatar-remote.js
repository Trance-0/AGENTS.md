import https from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export async function downloadAvatar(address, redirects = 0) {
  let url;
  try { url = new URL(address); } catch { throw Object.assign(new Error("Avatar not downloaded: dashboard/avatar remote — enter a valid HTTPS ZIP URL"), { status: 400 }); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || redirects > 3) throw Object.assign(new Error('Avatar not downloaded: dashboard/avatar remote — use a public HTTPS ZIP URL'), { status: 400 });
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')) throw Object.assign(new Error('Avatar not downloaded: dashboard/avatar remote — private or reserved addresses are not allowed'), { status: 400 });
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const req = https.get(url, { lookup: (_host, options, callback) => options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family), signal: AbortSignal.timeout(20000) }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); resolve(downloadAvatar(new URL(response.headers.location, url).href, redirects + 1)); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(Object.assign(new Error(`Avatar not downloaded: dashboard/avatar remote — server returned HTTP ${response.statusCode}`), { status: 502 })); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 12 * 1024 * 1024) { req.destroy(new Error('Avatar not downloaded: dashboard/avatar remote — ZIP exceeds twelve MiB')); return; } chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', reject);
    });
    req.on('error', reject);
  });
}
