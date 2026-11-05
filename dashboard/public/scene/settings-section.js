// Settings → Scene defaults (administrators): the image allowlist and the saved
// default layout that opens every new stream.
import { el } from "/api.js";
import { builtinLayout } from "./schema.js";

export function sceneSettingsSection(api) {
  const box = el("section", "settings-card admin-card");
  box.id = "scene-defaults";
  box.append(el("h2", "", "Scene defaults"), el("p", "settings-card-note", "Administrators only. Edit the layout itself with Edit scene on the Live page; it is replayed as the opening scene of every new stream."));
  const list = el("div", "settings-list");
  const layoutRow = el("div", "setting-row");
  const layoutText = el("div", "setting-text");
  const layoutInfo = el("small", "setting-help", "Loading…");
  layoutText.append(el("span", "setting-label", "Saved layout"), layoutInfo);
  const reset = el("button", "action-btn", "Reset to built-in");
  reset.type = "button";
  layoutRow.append(layoutText, reset);
  const embedRow = el("div", "setting-row");
  const embedText = el("div", "setting-text");
  const embedInfo = el("small", "setting-help", "");
  embedText.append(el("span", "setting-label", "Embed pages"), embedInfo);
  embedRow.append(embedText);
  const allowRow = el("div", "setting-row stacked");
  const allowLabel = el("label", "setting-text");
  allowLabel.htmlFor = "scene-allowlist";
  allowLabel.append(el("span", "setting-label", "Image allowlist"), el("small", "setting-help", "One HTTPS prefix per line (at most 16). Image widgets may only use URLs that start with one of these; the page's Content-Security-Policy allows the same origins."));
  const area = document.createElement("textarea");
  area.id = "scene-allowlist";
  area.rows = 3;
  area.spellcheck = false;
  area.placeholder = "https://images.example.com/stream/";
  const save = el("button", "action-btn", "Save allowlist");
  save.type = "button";
  const controls = el("div", "allowlist-controls");
  controls.append(area, save);
  allowRow.append(allowLabel, controls);
  const status = el("p", "settings-note");
  status.setAttribute("role", "status");
  list.append(layoutRow, embedRow, allowRow);
  box.append(list, status);
  let version = 0, embeds = [];
  const load = async () => {
    const view = await api("/api/scene/layout");
    version = view.layout.version;
    embeds = view.settings.embeds || [];
    layoutInfo.textContent = `${view.layout.widgets.length} widget${view.layout.widgets.length === 1 ? "" : "s"} · ${view.layout.builtin ? `built-in default (avatar, cat${embeds.length ? ", and embed backdrop" : ""})` : `version ${version}, saved ${new Date(view.layout.updatedAt).toLocaleString()}`}${view.live ? " · a stream is live: its scene changes through Edit scene" : ""}`;
    area.value = view.settings.imageAllowlist.join("\n");
    embedInfo.textContent = embeds.length ? `Served by this deployment (read-only, set by the operator): ${embeds.join(", ")}. Embed widgets sit behind the log and never take clicks.` : "None: the operator has not configured an embed directory (CIRCTIME_EMBED_DIR).";
  };
  save.onclick = async () => {
    save.disabled = true;
    try {
      const settings = await api("/api/scene/settings", { method: "PUT", body: JSON.stringify({ imageAllowlist: area.value.split(/\s+/).filter(Boolean) }) });
      area.value = settings.imageAllowlist.join("\n");
      status.textContent = "Allowlist saved.";
    } catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  };
  reset.onclick = async () => {
    reset.disabled = true;
    try { await api("/api/scene/layout", { method: "PUT", body: JSON.stringify({ widgets: builtinLayout({ embeds }), baseVersion: version }) }); await load(); status.textContent = "Saved layout reset to the built-in default."; }
    catch (error) { status.textContent = error.message; }
    finally { reset.disabled = false; }
  };
  load().catch(error => { status.textContent = error.message; });
  return box;
}
