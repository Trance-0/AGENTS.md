import fs from "node:fs";
import path from "node:path";
import { builtinLayout, normalizeAllowlist, validateLayout } from "../../public/scene/schema.js";

// Saved default scene layout and scene settings in the dashboard data volume.
// The layout is validated on every read and write and versioned: each save
// increments `version`, and a save with a stale `baseVersion` is rejected so
// two editors never overwrite each other. Until the first save the built-in
// layout (avatar + cat) is used with version 0.
const fail = (status, reason) => Object.assign(new Error(`Scene layout not saved: dashboard/scene layout — ${reason}.`), { status });

export class SceneStore {
  // `embeds`: dashboard-served embed paths this deployment allows (server config).
  constructor(directory, { embeds = [] } = {}) {
    this.directory = directory;
    this.embeds = embeds;
    this.layoutFile = path.join(directory, "scene-layout.json");
    this.settingsFile = path.join(directory, "scene-settings.json");
    fs.mkdirSync(directory, { recursive: true });
  }

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

  settings() {
    if (this.cachedSettings) return this.cachedSettings;
    const stored = this.readJson(this.settingsFile) || {};
    let imageAllowlist = [];
    try { imageAllowlist = normalizeAllowlist(stored.imageAllowlist || []); } catch { imageAllowlist = []; }
    this.cachedSettings = { imageAllowlist, embeds: this.embeds, updatedAt: stored.updatedAt || null };
    return this.cachedSettings;
  }

  saveSettings(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw fail(400, "settings must be an object");
    for (const key of Object.keys(input)) if (key !== "imageAllowlist") throw fail(400, `unknown settings field '${key}'`);
    const value = { imageAllowlist: normalizeAllowlist(input.imageAllowlist ?? []), updatedAt: Date.now() };
    this.writeJson(this.settingsFile, value);
    this.cachedSettings = { ...value, embeds: this.embeds };
    return this.cachedSettings;
  }

  options() { return { allowlist: this.settings().imageAllowlist, embeds: this.embeds }; }

  // A stored layout that no longer validates (for example an image whose
  // prefix left the allowlist) keeps its valid widgets only.
  layout() {
    const stored = this.readJson(this.layoutFile);
    if (!stored) return { version: 0, updatedAt: null, builtin: true, widgets: builtinLayout({ embeds: this.embeds }) };
    const options = this.options();
    const widgets = [];
    for (const widget of Array.isArray(stored.widgets) ? stored.widgets : []) {
      try { widgets.push(...validateLayout({ widgets: [widget] }, options)); } catch {}
    }
    return { version: Number.isSafeInteger(stored.version) ? stored.version : 0, updatedAt: stored.updatedAt ?? null, builtin: false, widgets };
  }

  saveLayout(widgetsInput, baseVersion) {
    const current = this.layout();
    if (baseVersion !== undefined && baseVersion !== current.version) throw fail(409, `the saved layout changed (version ${current.version}, edit based on ${baseVersion}); reload and retry`);
    const widgets = validateLayout({ widgets: widgetsInput }, this.options());
    const value = { version: current.version + 1, updatedAt: Date.now(), widgets };
    this.writeJson(this.layoutFile, value);
    return { ...value, builtin: false };
  }
}
