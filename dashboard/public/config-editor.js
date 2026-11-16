import { api, el } from "/api.js";
import { button, field, section, editorTabs, select } from "/settings-controls.js";
import { renderObject, labelFor } from "/config-fields.js";

import { SECTIONS } from "/config-help.js";

export function modelOptions(config) {
  const models = new Set(Object.keys(config?.agents?.defaults?.models || {}));
  for (const [provider, data] of Object.entries(config?.models?.providers || {})) for (const model of data.models || []) if (model.id) models.add(`${provider}/${model.id}`);
  return [...models].sort();
}
function chatEffortCard(draft, changed) {
  const defaults = draft?.agents?.defaults;
  const primary = typeof defaults?.model === "string" ? defaults.model : defaults?.model?.primary;
  if (!primary) return null;
  const qwen = primary.toLowerCase() === "vllm/nvidia/qwen3.8-27b-nvfp4";
  const levels = qwen ? ["low", "medium", "xhigh"] : ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"];
  const options = { "": `Use default (${defaults.thinkingDefault || "automatic"})`, ...Object.fromEntries(levels.map(level => [level, level === "xhigh" ? "xhigh · Extra high" : level])) };
  const control = select(defaults.models?.[primary]?.params?.thinking ?? "", options, value => {
    if (value) {
      defaults.models ??= {};
      defaults.models[primary] ??= {};
      defaults.models[primary].params ??= {};
      defaults.models[primary].params.thinking = value;
    } else if (defaults.models?.[primary]?.params) delete defaults.models[primary].params.thinking;
    changed();
  });
  const card = section("Chat model reasoning effort", `How much time ${primary} spends reasoning before answering. Higher effort can improve difficult answers, but takes longer.`);
  card.append(field("Chat reasoning effort", control, `${qwen ? "Qwen supports low, medium, and xhigh (extra high)." : "Available effort levels depend on your model and provider."} This model setting overrides the default below. A session's /think command or a scheduled task can override it for that conversation or run. Coding agent settings are separate.`));
  return card;
}
export async function renderConfigEditor(body, isAdmin) {
  if (!isAdmin) return body.append(el("p", "", "Settings unavailable: dashboard/admin authorization — administrator access is required."));
  const box = el("div", "config-editor apple-settings"); body.append(box);
  const status = el("p", "editor-status"); status.setAttribute("role", "status");
  const form = el("div", "configuration-sections"), raw = el("div", "raw-editor");
  const text = el("textarea", "config-text mono"); text.rows = 28; text.spellcheck = false; text.setAttribute("aria-label", "OpenClaw JSON configuration");
  raw.append(el("p", "settings-note", "Advanced backup editor. Masked credentials are preserved when saved."), text);
  let activeSection = "agents";
  let draft = {}, baseHash, dirty = false, loaded = false, busy = false;
  let refreshEffort = () => {};
  const mark = () => { dirty = true; status.textContent = "Unsaved changes"; refreshEffort(); };
  const draw = () => {
    refreshEffort = () => {};
    form.replaceChildren();
    const options = el("datalist"); options.id = "openclaw-model-options"; for (const name of modelOptions(draft)) options.append(new Option(name, name)); form.append(options);
    const keys = [...Object.keys(SECTIONS).filter(k => Object.hasOwn(draft, k)), ...Object.keys(draft).filter(k => !Object.hasOwn(SECTIONS, k))];
    if (!keys.includes(activeSection)) activeSection = keys[0];
    const nav = el("nav", "config-section-nav"); nav.setAttribute("aria-label", "Configuration sections");
    const content = el("div", "config-section-content");
    for (const key of keys) {
      const [title] = SECTIONS[key] || [labelFor(key)];
      const link = button(title, () => { activeSection = key; draw(); });
      if (key === activeSection) link.setAttribute("aria-current", "true"); nav.append(link);
    }
    if (activeSection) {
      const key = activeSection, [title, note] = SECTIONS[key] || [labelFor(key), `Configuration values for ${labelFor(key)}. Select a field below to edit how this part of OpenClaw behaves.`];
      const card = section(title, note); const fields = el("div", "config-fields");
      if (key === "agents") {
        const effortHost = el("div", "chat-effort-settings");
        refreshEffort = () => {
          effortHost.replaceChildren();
          const effort = chatEffortCard(draft, () => { mark(); draw(); });
          if (effort) effortHost.append(effort);
        };
        refreshEffort(); content.append(effortHost);
      }
      if (draft[key] && typeof draft[key] === "object" && !Array.isArray(draft[key])) renderObject(fields, draft[key], mark, { path: key });
      else { const wrapper = { [key]: draft[key] }; renderObject(fields, wrapper, () => { draft[key] = wrapper[key]; mark(); }); }
      card.append(fields); content.append(card);
    }
    const workspace = el("div", "configuration-workspace"); workspace.append(nav, content); form.append(workspace);
  };
  const parse = () => { const value = JSON.parse(text.value); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("configuration must be an object"); draft = value; draw(); };
  const tabs = editorTabs(form, raw, { label: "Configuration editor", status, toJson: () => { text.value = JSON.stringify(draft, null, 2); }, toForm: parse });
  text.oninput = mark;
  const actions = el("div", "editor-toolbar");
  const reload = button("Reload", async () => { if (dirty && !confirm("Discard your unsaved configuration changes?")) return; await load(); }); reload.classList.add("config-reload");
  const save = button("Save changes", async () => {
    if (!loaded || busy) return;
    try {
      if (tabs.isRaw()) parse(); busy = true; save.disabled = true;
      const view = await api("/api/admin/openclaw-config", { method: "PUT", body: JSON.stringify({ text: JSON.stringify(draft), baseHash }) });
      draft = view.config; baseHash = view.hash; dirty = false; draw(); text.value = JSON.stringify(draft, null, 2);
      status.textContent = view.changed ? "Saved · previous configuration backed up" : "No changes to save";
    } catch (error) { status.textContent = `Settings not saved: dashboard/config editor — ${error.message}`; }
    finally { busy = false; save.disabled = !loaded; }
  }, true); save.classList.add("config-save"); save.disabled = true;
  actions.append(reload, save);
  const history = el("details", "config-group config-history");
  history.append(el("summary", "", "Restore history"));
  const historyList = el("div", "backup-list");
  history.append(historyList);
  async function loadHistory() {
    try {
      const { backups } = await api("/api/admin/openclaw-config/backups");
      historyList.replaceChildren();
      if (!backups.length) { historyList.append(el("p", "settings-note", "No backups yet. Each save keeps a snapshot here.")); return; }
      for (const backup of backups) {
        const row = el("div", "array-item");
        const label = el("span", "backup-label", `${new Date(backup.modifiedAt).toLocaleString()} · ${(backup.size / 1024).toFixed(1)} KiB`);
        const restoreBtn = button("Restore", async () => {
          if (!confirm(`Restore the configuration saved ${new Date(backup.modifiedAt).toLocaleString()}? The current configuration is backed up first.`)) return;
          restoreBtn.disabled = true;
          try {
            await api("/api/admin/openclaw-config/restore", { method: "POST", body: JSON.stringify({ name: backup.name }) });
            await load();
            await loadHistory();
          } catch (error) { status.textContent = `Settings not restored: dashboard/config editor — ${error.message}`; restoreBtn.disabled = false; }
        }, true);
        row.append(label, restoreBtn);
        historyList.append(row);
      }
    } catch (error) { historyList.replaceChildren(el("p", "settings-note", error.message)); }
  }
  box.append(tabs.bar, el("p", "settings-note", "Changes apply to OpenClaw. Stored credentials stay private, and each save keeps a backup."), form, raw, actions, history, status);
  async function load() {
    status.textContent = "Loading settings…";
    try { const view = await api("/api/admin/openclaw-config"); draft = view.config; baseHash = view.hash; loaded = true; dirty = false; draw(); text.value = JSON.stringify(draft, null, 2); status.textContent = "Settings are up to date"; save.disabled = false; }
    catch (error) { status.textContent = error.message; }
    loadHistory();
  }
  await load();
}
