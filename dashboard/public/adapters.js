import { api, el } from '/api.js';
import { button } from '/settings-controls.js';

export async function renderAdapters(body) {
  const box = el('section', 'apple-settings settings-card preference-section'); body.append(box);
  box.append(el('h2', '', 'AstrBot execution access'), el('p', 'settings-note', 'Verified owner direct messages can run tasks in OpenClaw. Only groups listed below can request execution; other chats keep restricted access. Group history stays separate.'));
  const status = el('p', 'editor-status'); status.setAttribute('role', 'status');
  const form = el('div', 'settings-list'); box.append(status, form);
  let draft = await api('/api/admin/adapters');
  function field(label, value, change) {
    const row = el('label', 'preference-field'); row.append(el('span', 'field-label', label));
    const input = document.createElement('input'); input.type = 'text'; input.value = value; input.oninput = () => change(input.value); row.append(input); return row;
  }
  function draw() {
    form.replaceChildren();
    const row = el('label', 'setting-row'); row.append(el('span', '', 'Owner direct-message execution'));
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = draft.ownerEnabled; enabled.onchange = () => { draft.ownerEnabled = enabled.checked; }; row.append(enabled); form.append(row);
    for (const [index, group] of draft.groups.entries()) {
      const card = el('section', 'settings-card');
      card.append(field('Platform', group.platform, value => { group.platform = value; }), field('Group ID', group.group_id, value => { group.group_id = value; }));
      const choiceRow = el('label', 'setting-row'); choiceRow.append(el('span', '', 'Who can execute'));
      const select = document.createElement('select'); select.setAttribute('aria-label', 'Who can execute');
      for (const [value, label] of [['owner', 'Verified owner only'], ['selected', 'Selected members'], ['all', 'All members']]) { const option = el('option', '', label); option.value = value; select.append(option); }
      select.value = Array.isArray(group.senders) ? 'selected' : group.senders;
      select.onchange = () => { group.senders = select.value === 'selected' ? [] : select.value; draw(); }; choiceRow.append(select); card.append(choiceRow);
      if (Array.isArray(group.senders)) {
        for (const [i, id] of group.senders.entries()) { const line = el('div', 'task-toolbar'); line.append(field('Sender ID', id, value => { group.senders[i] = value; }), button('Remove member', () => { group.senders.splice(i, 1); draw(); })); card.append(line); }
        card.append(button('Add member', () => { group.senders.push(''); draw(); }));
      }
      card.append(button('Remove group', () => { draft.groups.splice(index, 1); draw(); })); form.append(card);
    }
    if (!draft.groups.length) form.append(el('p', 'empty-state', 'No groups have execution access.'));
    form.append(button('Add group', () => { draft.groups.push({ platform: 'qq', group_id: '', senders: 'owner' }); draw(); }));
  }
  box.append(button('Save access', async () => {
    try { draft = await api('/api/admin/adapters', { method: 'PUT', body: JSON.stringify({ baseHash: draft.hash, ownerEnabled: draft.ownerEnabled, groups: draft.groups }) }); draw(); status.textContent = 'Access settings saved.'; }
    catch (error) { status.textContent = error.message; }
  }, true));
  draw();
}
