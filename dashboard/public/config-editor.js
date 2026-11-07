import { api, el } from "/api.js";
import { button, section, editorTabs } from "/settings-controls.js";
import { renderObject, labelFor } from "/config-fields.js";

const SECTIONS = { agents: ["Agents & defaults", "Models, workspaces, and behavior for your assistants."], models: ["Models & providers", "Available models and the services that provide them."], channels: ["Connected channels", "Messaging accounts and who can reach your assistants."], session: ["Conversations", "Session boundaries and linked identities."], tools: ["Tools & permissions", "Capabilities available to your agents."], gateway: ["Gateway", "Connection, authentication, and reload settings."], plugins: ["Plugins", "Installed integrations and their configuration."], cron: ["Scheduling defaults", "Gateway-wide scheduling options. Manage individual jobs in Scheduled tasks."] };
export function modelOptions(config) {
  const models = new Set(Object.keys(config?.agents?.defaults?.models || {}));
  for (const [provider, data] of Object.entries(config?.models?.providers || {})) for (const model of data.models || []) if (model.id) models.add(`${provider}/${model.id}`);
  return [...models].sort();
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
  const mark = () => { dirty = true; status.textContent = "Unsaved changes"; };
  const draw = () => {
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
      const key = activeSection, [title, note] = SECTIONS[key] || [labelFor(key), "Additional OpenClaw settings."];
      const card = section(title, note); const fields = el("div", "config-fields");
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
  actions.append(reload, save); box.append(tabs.bar, el("p", "settings-note", "Changes apply to OpenClaw. Stored credentials stay private, and each save keeps a backup."), form, raw, actions, status);
  async function load() {
    status.textContent = "Loading settings…";
    try { const view = await api("/api/admin/openclaw-config"); draft = view.config; baseHash = view.hash; loaded = true; dirty = false; draw(); text.value = JSON.stringify(draft, null, 2); status.textContent = "Settings are up to date"; save.disabled = false; }
    catch (error) { status.textContent = error.message; }
  }
  await load();
}
