import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { WITCH_FRAMES } from '../../public/scene/assets.js';

const STATE = /^[a-z][a-z0-9_-]{0,31}$/;
const fail = reason => Object.assign(new Error(`Avatar not imported: dashboard/avatar archive — ${reason}`), { status: 400 });
export class AvatarStore {
  constructor(root) { this.root = root; fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
  catalog() {
    const builtin = { id: 'witch', name: 'Witch', states: WITCH_FRAMES, builtin: true };
    return [builtin, ...fs.readdirSync(this.root).filter(id => /^[a-f0-9]{24}$/.test(id)).flatMap(id => {
      try { return [JSON.parse(fs.readFileSync(path.join(this.root, id, 'manifest.json'), 'utf8'))]; } catch { return []; }
    })];
  }
  pack(id) { return this.catalog().find(item => item.id === id); }
  async import(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 12 * 1024 * 1024) throw fail('ZIP must be at most twelve MiB');
    let total = 0, count = 0, entries;
    try {
      entries = unzipSync(bytes, { filter: item => {
        if (++count > 64 || item.originalSize > 5 * 1024 * 1024 || (total += item.originalSize) > 24 * 1024 * 1024) throw fail('archive contains too many or oversized files');
        if (item.name.startsWith('/') || item.name.includes('\\') || item.name.split('/').includes('..')) throw fail('archive paths must stay inside the pack');
        return /(?:\.png|\.webp|\.jpe?g|\.gif|manifest\.json)$/i.test(item.name);
      } });
    } catch (error) { throw error.status ? error : fail('ZIP is invalid or uses an unsupported compression method'); }
    const manifestEntry = Object.entries(entries).find(([name]) => path.posix.basename(name) === 'manifest.json');
    let input = {};
    try { if (manifestEntry) input = JSON.parse(strFromU8(manifestEntry[1])); } catch { throw fail('manifest.json is not valid JSON'); }
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : 'Uploaded avatar';
    const source = input.states || Object.fromEntries(Object.keys(entries).filter(file => /\.(png|webp|jpe?g|gif)$/i.test(file)).map(file => [path.posix.basename(file).replace(/\.[^.]+$/, ''), file]));
    if (!source || Array.isArray(source) || typeof source !== 'object' || !source.idle || Object.keys(source).length > 16) throw fail('include idle.png or an idle state in manifest.json; at most sixteen states');
    const frames = {};
    for (const [state, file] of Object.entries(source)) {
      if (!STATE.test(state) || state === 'auto' || typeof file !== 'string') throw fail('state names must be short lowercase identifiers');
      const data = entries[file] || Object.entries(entries).find(([key]) => path.posix.basename(key) === file)?.[1];
      if (!data || data.length > 5 * 1024 * 1024) throw fail(`state ${state} has no supported image`);
      try {
        const image = sharp(data, { limitInputPixels: 16_000_000, animated: false });
        const meta = await image.metadata();
        if (!['png', 'jpeg', 'webp', 'gif'].includes(meta.format)) throw fail('only PNG, JPEG, WebP and GIF frames are supported');
        frames[state] = await image.resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      } catch (error) { throw error.status ? error : fail(`state ${state} is not a decodable image`); }
    }
    const hash = crypto.createHash('sha256').update(name);
    for (const key of Object.keys(frames).sort()) hash.update(key).update(frames[key]);
    const id = hash.digest('hex').slice(0, 24), folder = path.join(this.root, id);
    const manifest = { id, name, states: Object.fromEntries(Object.keys(frames).map(state => [state, `/avatar-assets/${id}/${state}.png`])) };
    if (!fs.existsSync(folder)) {
      const staging = path.join(this.root, `.import-${crypto.randomBytes(8).toString('hex')}`); fs.mkdirSync(staging, { mode: 0o700 });
      try {
        for (const [state, data] of Object.entries(frames)) fs.writeFileSync(path.join(staging, `${state}.png`), data, { mode: 0o600 });
        fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
        if (fs.existsSync(folder)) fs.rmSync(staging, { recursive: true }); else fs.renameSync(staging, folder);
      } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
    }
    return manifest;
  }
  async remap(id, name, mapping) {
    const pack = this.pack(id);
    if (!pack || !mapping || typeof mapping !== 'object' || Array.isArray(mapping) || !mapping.idle || Object.keys(mapping).length > 16) throw fail('provide an idle state and at most sixteen state mappings');
    const archive = unzipSync(await this.export(id)), states = {};
    for (const [state, source] of Object.entries(mapping)) {
      if (!STATE.test(state) || state === 'auto' || !Object.hasOwn(pack.states, source)) throw fail('state mapping references a missing resource');
      states[state] = `${source}.png`;
    }
    archive['manifest.json'] = strToU8(JSON.stringify({ name: typeof name === 'string' ? name : pack.name, states }));
    return this.import(zipSync(archive));
  }
  async export(id) {
    const pack = this.pack(id); if (!pack) throw fail('avatar pack does not exist');
    const files = {}, states = {};
    for (const [state, url] of Object.entries(pack.states)) {
      const data = id === 'witch' ? await sharp(fs.readFileSync(new URL(`../../public${url}`, import.meta.url))).png().toBuffer()
        : fs.readFileSync(path.join(this.root, id, `${state}.png`));
      files[`${state}.png`] = data; states[state] = `${state}.png`;
    }
    files['manifest.json'] = strToU8(JSON.stringify({ name: pack.name, states }, null, 2));
    return Buffer.from(zipSync(files));
  }
}
