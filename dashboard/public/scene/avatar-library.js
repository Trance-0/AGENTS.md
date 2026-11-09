import { api, el } from '/api.js';
import { button } from '/settings-controls.js';

export async function renderAvatarLibrary(pane) {
  const root = el('div', 'apple-settings avatar-library'); pane.append(root);
  root.append(el('h2', '', 'Avatar resources'), el('p', 'settings-note', 'Upload a ZIP of named PNG, JPEG, WebP or GIF frames. Include idle.png, or manifest.json with a name and a states map. Automatic states: idle, blink, talk, think and sleepy. Imported frames become public stream assets.'));
  const status = el('p', 'editor-status'); status.setAttribute('role', 'status'); root.append(status);
  const toolbar = el('section', 'settings-card');
  const file = document.createElement('input'); file.type = 'file'; file.accept = '.zip,application/zip'; file.setAttribute('aria-label', 'Avatar ZIP');
  const url = document.createElement('input'); url.type = 'url'; url.placeholder = 'https://example.com/avatar.zip'; url.setAttribute('aria-label', 'Remote avatar ZIP URL');
  const perform = async fn => { status.textContent = 'Importing avatar…'; try { const pack = await fn(); await load(pack.id); status.textContent = `Avatar ready: ${pack.name}. Select pack ${pack.id} in a canvas avatar widget.`; } catch (error) { status.textContent = error.message; } };
  toolbar.append(file, button('Upload ZIP', () => perform(() => {
    if (!file.files[0]) throw new Error('Avatar not uploaded: dashboard/avatar selection — choose a ZIP file first.');
    return api('/api/admin/avatars/upload', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file.files[0] });
  })), url, button('Add remote / download ZIP', () => perform(() => api('/api/admin/avatars/remote', { method: 'POST', body: JSON.stringify({ url: url.value }) }))));
  root.append(toolbar);
  const list = el('div', 'avatar-packs'); root.append(list);
  async function load(selected) {
    const { avatars } = await api('/api/avatars'); list.replaceChildren();
    for (const pack of avatars) {
      const card = el('section', 'settings-card'); card.dataset.avatarPack = pack.id;
      card.append(el('h3', '', pack.name), el('p', 'settings-note', `Pack: ${pack.id}`));
      const download = el('a', 'action-btn', 'Download ZIP'); download.href = `/api/admin/avatars/${pack.id}/download`; card.append(download);
      const name = document.createElement('input'); name.value = pack.name; name.setAttribute('aria-label', `Avatar name ${pack.id}`);
      const states = el('div', 'avatar-states'); const rows = [];
      const add = (state, source) => {
        const row = el('div', 'avatar-state'); const preview = document.createElement('img'); preview.src = pack.states[source]; preview.alt = state;
        const key = document.createElement('input'); key.value = state; key.setAttribute('aria-label', 'State name');
        const resource = document.createElement('select'); resource.setAttribute('aria-label', `Resource for ${state}`);
        for (const frame of Object.keys(pack.states)) resource.append(new Option(frame, frame)); resource.value = source;
        resource.onchange = () => { preview.src = pack.states[resource.value]; };
        const item = { key, resource, row }; rows.push(item);
        row.append(preview, key, resource, button('Remove state', () => { rows.splice(rows.indexOf(item), 1); row.remove(); })); states.append(row);
      };
      for (const state of Object.keys(pack.states)) add(state, state);
      card.append(name, states, button('Add state', () => add('new_state', 'idle')), button('Save state mapping as new pack', () => perform(() => {
        const keys = rows.map(row => row.key.value.trim());
        if (new Set(keys).size !== keys.length) throw new Error('Avatar not saved: dashboard/state editor — state names must be unique.');
        return api(`/api/admin/avatars/${pack.id}/states`, { method: 'POST', body: JSON.stringify({ name: name.value, states: Object.fromEntries(rows.map(row => [row.key.value.trim(), row.resource.value])) }) });
      }), true));
      list.append(card); if (pack.id === selected) card.scrollIntoView({ block: 'nearest' });
    }
  }
  await load();
}
