import fs from "node:fs";
import path from "node:path";
import { builtinLayout, defaultSettings, migrateWidget, normalizeSettings, validateLayout } from "../../public/scene/schema.js";

// Saved default scene layout and scene settings in the dashboard data volume.
// The layout is validated on every read and write and versioned: each save
// increments `version`, and a save with a stale `baseVersion` is rejected so
// two editors never overwrite each other. Until the first save the built-in
// layout (avatar + cat, plus the embed backdrop when one is served) is used
// with version 0.
//
// Layout file schema 2 (dashboard 0.2.6) adds the embed `attach` prop. A
// schema-1 file is migrated once at startup: only the built-in circtime
// backdrop moves to the log component; other embeds are pinned to the stage.
// The original is kept beside it as scene-layout.v1.json for rollback.
const LAYOUT_SCHEMA = 2;
const fail = (status, reason) => Object.assign(new Error(`Scene layout not saved: dashboard/scene layout — ${reason}.`), { status });
const settingsFail = reason => Object.assign(new Error(`Scene settings not saved: dashboard/scene settings — ${reason}.`), { status: 400 });

export class SceneStore {
  // `embeds`: dashboard-served embed paths this deployment allows (server config).
  constructor(directory, { embeds = [], log = () => {} } = {}) {
    this.directory = directory;
    this.servedEmbeds = embeds;
    this.log = log;
    this.layoutFile = path.join(directory, "scene-layout.json");
    this.settingsFile = path.join(directory, "scene-settings.json");
    fs.mkdirSync(directory, { recursive: true });
    this.migrateLayout();
  }

  // Enabled embeds: served by the deployment and not switched off by an administrator.
  get embeds() { return this.servedEmbeds.filter(item => !this.settings().disabledEmbeds.includes(item)); }

  readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw Object.assign(new Error(`Scene unavailable: dashboard/scene storage — ${path.basename(file)} could not be read (${error.code || "invalid JSON"}).`), { status: 500 });
    }
  }

  writeJson(file, value) {
    const temporary = `${file}.tmp`;
    const descriptor = fs.openSync(temporary, "w", 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  }

  migrateLayout() {
    let stored;
    try { stored = this.readJson(this.layoutFile); } catch { return; }
    if (!stored || stored.schema >= LAYOUT_SCHEMA || !Array.isArray(stored.widgets)) return;
    const widgets = stored.widgets.map(migrateWidget);
    const moved = widgets.filter((widget, index) => widget !== stored.widgets[index]).map(widget => `${widget.id}→${widget.props.attach}`);
    const backup = path.join(this.directory, "scene-layout.v1.json");
    if (!fs.existsSync(backup)) fs.copyFileSync(this.layoutFile, backup);
    const version = Number.isSafeInteger(stored.version) ? stored.version : 0;
    this.writeJson(this.layoutFile, { ...stored, schema: LAYOUT_SCHEMA, version: moved.length ? version + 1 : version, ...(moved.length ? { updatedAt: Date.now() } : {}), widgets });
    this.log(`Scene layout migrated: dashboard/scene layout — schema ${LAYOUT_SCHEMA}; embeds ${moved.length ? moved.join(", ") : "none"}; original kept as scene-layout.v1.json.`);
  }

  settings() {
    if (this.cachedSettings) return this.cachedSettings;
    const stored = this.readJson(this.settingsFile) || {};
    let value = defaultSettings();
    // Each part independently: one bad field never discards the others.
    for (const key of ["imageAllowlist", "disabledEmbeds", "defaults", "builtin", "metricRefresh"]) {
      if (stored[key] === undefined) continue;
      try { value = normalizeSettings({ [key]: stored[key] }, value); } catch {}
    }
    this.cachedSettings = this.view(value, stored.updatedAt || null);
    return this.cachedSettings;
  }

  view(value, updatedAt) {
    const embeds = this.servedEmbeds.filter(item => !value.disabledEmbeds.includes(item));
    return { ...value, embeds, servedEmbeds: this.servedEmbeds, updatedAt };
  }

  saveSettings(input) {
    let value;
    try { value = normalizeSettings(input, this.settings()); }
    catch (error) { throw error.reason ? settingsFail(error.reason) : error; }
    const updatedAt = Date.now();
    this.writeJson(this.settingsFile, { ...value, updatedAt });
    this.cachedSettings = this.view(value, updatedAt);
    return this.cachedSettings;
  }

  options() { return { allowlist: this.settings().imageAllowlist, embeds: this.embeds }; }

  builtin() { return builtinLayout({ embeds: this.embeds, settings: this.settings() }); }

  // A stored layout that no longer validates (for example an image whose
  // prefix left the allowlist) keeps its valid widgets only.
  layout() {
    const stored = this.readJson(this.layoutFile);
    if (!stored) return { version: 0, updatedAt: null, builtin: true, widgets: this.builtin() };
    const options = this.options();
    const widgets = [];
    for (const widget of Array.isArray(stored.widgets) ? stored.widgets : []) {
      try { widgets.push(...validateLayout({ widgets: [stored.schema >= LAYOUT_SCHEMA ? widget : migrateWidget(widget)] }, options)); } catch {}
    }
    return { version: Number.isSafeInteger(stored.version) ? stored.version : 0, updatedAt: stored.updatedAt ?? null, builtin: false, widgets };
  }

  saveLayout(widgetsInput, baseVersion) {
    const current = this.layout();
    if (baseVersion !== undefined && baseVersion !== current.version) throw fail(409, `the saved layout changed (version ${current.version}, edit based on ${baseVersion}); reload and retry`);
    const widgets = validateLayout({ widgets: widgetsInput }, this.options());
    const value = { schema: LAYOUT_SCHEMA, version: current.version + 1, updatedAt: Date.now(), widgets };
    this.writeJson(this.layoutFile, value);
    return { version: value.version, updatedAt: value.updatedAt, widgets, builtin: false };
  }
}
