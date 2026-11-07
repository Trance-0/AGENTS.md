// Settings → Canvas settings (administrators only). A settings view of the
// streaming canvas that complements the on-stage editor:
//
// - Widget list: every widget of a draft layout with type, name, position and
//   size, layer, and visibility; add, edit (schema-generated form, the shared
//   validator), duplicate, delete, reorder, show/hide.
// - Live preview: the draft drawn by the same renderer viewers use, scaled.
// - Scene configuration: image allowlist, enabled embeds, widget defaults
//   (metric, avatar, cat, embed), metric refresh, built-in layout contents.
// - "Save layout" persists the draft as the saved default layout (PUT
//   /api/scene/layout, versioned). "Apply to live stream" records the
//   difference against the live scene as widget events (?scope=live), after a
//   confirmation; it never changes the saved layout.
//
// Every request goes through api() (admin session + same-origin
// X-Dashboard-Request: 1); the server re-validates everything.
import { el } from "/api.js";
import { LIMITS, METRIC_SOURCES, PALETTE, REFRESH_MINUTES, WIDGET_TYPES, builtinLayout, defaultRect, migrateWidget, validateLayout, validateWidget, withDefaults } from "./schema.js";
import { initialState } from "./reduce.js";
import { SceneRenderer } from "./renderer.js";
import { field } from "./editor-popups.js";
import { canonical, liveDiff } from "./diff.js";
import { fitRect } from "./editor.js";

const EMBED_NAMES = { "/embed/circtime/": "circtime uptime radar" };
const GROUPS = [
  ["stage", "On the stage", "Drawn above the log, top layer first."],
  ["log", "Log component backdrop", "Inside the log panel's box, behind the log text."],
  ["back", "Stage backdrop", "Across the 16:9 stage, behind the log."],
];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pct = value => `${Math.round(value * 1000) / 10}%`;
const groupOf = widget => (!WIDGET_TYPES[widget.type]?.back ? "stage" : widget.props?.attach === "log" ? "log" : "back");
const newId = taken => { let id; do id = `w-${[...crypto.getRandomValues(new Uint8Array(4))].map(byte => byte.toString(16).padStart(2, "0")).join("")}`; while (taken.has(id)); return id; };

export function describe(widget) {
  const props = widget.props || {};
  if (widget.type === "text") return `“${props.text}”`;
  if (widget.type === "metric") return props.label || METRIC_SOURCES[props.source] || props.source;
  if (widget.type === "clock") return WIDGET_TYPES.clock.props.mode.labels[props.mode] || props.mode;
  if (widget.type === "image") { try { return props.alt || new URL(props.url).hostname; } catch { return "No image URL yet"; } }
  if (widget.type === "embed") return EMBED_NAMES[props.src] || props.src || "No page";
  return props.mirror ? "Mirrored" : "";
}

export function canvasSettingsSection(api) {
  const box = el("section", "settings-card admin-card canvas-settings");
  box.id = "canvas-settings";
  box.setAttribute("aria-labelledby", "canvas-settings-title");
  const title = el("h2", "", "Canvas settings");
  title.id = "canvas-settings-title";
  box.append(title, el("p", "settings-card-note", "Administrators only. Set up the streaming canvas: the default layout that opens every new stream, and the scene configuration. Edit scene on the Live page edits the same layout on the stage."));

  // ---------- Status and toolbar ----------
  const status = el("p", "canvas-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const summary = el("div", "canvas-summary");
  const toolbar = el("div", "canvas-toolbar");
  const addType = document.createElement("select");
  addType.id = "canvas-add-type";
  const addLabel = el("label", "canvas-add");
  addLabel.htmlFor = addType.id;
  addLabel.append(el("span", "visually-hidden", "Widget type to add"));
  const add = button("Add widget", "canvas-add-btn");
  const loadLive = button("Load live scene", "canvas-load-live", "Replace the draft with the scene that is live now");
  const revert = button("Discard changes", "canvas-revert", "Return the draft to the saved layout");
  const reset = button("Use built-in layout", "canvas-builtin", "Load the built-in layout into the draft (save to keep it)");
  const apply = button("Apply to live stream", "canvas-apply", "Record the draft's differences in the live stream");
  const save = button("Save layout", "canvas-save", "Save the draft as the default layout for future streams", "primary");
  const addGroup = el("div", "canvas-toolbar-group");
  addGroup.append(addLabel, addType, add);
  const draftGroup = el("div", "canvas-toolbar-group");
  draftGroup.append(loadLive, revert, reset);
  const commitGroup = el("div", "canvas-toolbar-group canvas-commit");
  commitGroup.append(apply, save);
  toolbar.append(addGroup, draftGroup, commitGroup);

  // ---------- Preview ----------
  const previewWrap = el("figure", "canvas-preview-wrap");
  const preview = el("div", "canvas-preview");
  preview.setAttribute("aria-hidden", "true");
  const log = el("div", "stream-log canvas-preview-log");
  for (const [t, source, msg] of [["0:12:03", "openclaw", "Reading the deployment log for the dashboard service…"], ["0:12:09", "openclaw", "Tests passed: 61 of 61. Building the image."], ["0:12:20", "dashboard", "Scene metrics updated: 2 pooled public values refreshed."], ["0:12:31", "openclaw", "Deploy finished; the health check is green."]]) {
    const line = el("div", "log-line");
    line.append(el("span", "t", t), el("span", "src", source), el("span", "msg", msg));
    log.append(line);
  }
  preview.append(log);
  const previewMode = el("div", "segmented canvas-preview-mode");
  previewMode.setAttribute("role", "radiogroup");
  previewMode.setAttribute("aria-label", "Preview shows");
  const modes = {};
  for (const [value, text] of [["draft", "Draft"], ["live", "Live scene"]]) {
    const input = document.createElement("input");
    Object.assign(input, { type: "radio", name: "canvas-preview-mode", id: `canvas-preview-${value}`, value, checked: value === "draft" });
    const label = el("label", "", text);
    label.htmlFor = input.id;
    input.onchange = () => drawPreview();
    modes[value] = input;
    previewMode.append(input, label);
  }
  const caption = el("figcaption", "canvas-preview-caption");
  previewWrap.append(preview, caption, previewMode);

  // ---------- Widget list and properties ----------
  const listWrap = el("div", "canvas-list-wrap");
  const listHeading = el("h3", "canvas-heading", "Widgets");
  listHeading.id = "canvas-widgets-heading";
  const list = el("div", "canvas-groups");
  list.id = "canvas-widgets";
  listWrap.append(listHeading, list);
  const editor = el("div", "canvas-editor");
  editor.id = "canvas-editor";
  editor.setAttribute("aria-labelledby", "canvas-editor-title");

  const workspace = el("div", "canvas-workspace");
  workspace.append(previewWrap, listWrap, editor);

  // ---------- Scene configuration ----------
  const config = document.createElement("form");
  config.className = "canvas-config";
  config.id = "canvas-config";
  config.noValidate = true;
  const configHeading = el("h3", "canvas-heading", "Scene configuration");
  const configStatus = el("p", "canvas-status");
  configStatus.setAttribute("role", "status");

  const dialog = document.createElement("dialog");
  dialog.className = "canvas-dialog";
  dialog.id = "canvas-confirm";
  dialog.setAttribute("aria-labelledby", "canvas-confirm-title");

  box.append(summary, toolbar, status, workspace, configHeading, config, configStatus, dialog);

  let view = null, draft = [], selected = null, busy = false;
  const renderer = new SceneRenderer(preview, (() => { const t0 = Date.now(); return () => ({ t: (Date.now() - t0) / 1000, startedAt: t0 }); })());
  const settings = () => view?.settings || { imageAllowlist: [], embeds: [], servedEmbeds: [], defaults: {} };
  const options = () => ({ allowlist: settings().imageAllowlist, embeds: settings().embeds });
  const say = (text, tone = "") => { status.textContent = text; status.dataset.tone = tone; };

  function problems() {
    const result = new Map();
    for (const widget of draft) { try { validateWidget(widget, options()); } catch (error) { result.set(widget.id, error.reason || error.message); } }
    return result;
  }
  const dirty = () => view && canonical(draft) !== canonical(view.layout.widgets);
  const liveOps = () => (view?.live ? liveDiff(view.live.widgets, draft) : []);

  // ---------- Rendering ----------
  function renderAll({ keepEditor = false } = {}) {
    renderSummary();
    renderAddTypes();
    renderList();
    if (!keepEditor) renderEditor();
    drawPreview();
  }

  function renderSummary() {
    if (!view) return;
    const { layout, live } = view;
    const bad = problems().size;
    summary.replaceChildren(
      chip(layout.builtin ? "Saved layout: built-in default" : `Saved layout: version ${layout.version}`, "", layout.updatedAt ? `Saved ${new Date(layout.updatedAt).toLocaleString()}` : "Not saved yet; the built-in layout opens new streams"),
      chip(live ? "Stream live" : "Stream offline", live ? "live" : "", live ? `${live.widgets.length} widgets in the live scene` : "Apply to live stream is available while a stream is live"),
      chip(dirty() ? "Unsaved changes" : "Draft matches the saved layout", dirty() ? "warn" : "ok"),
      ...(bad ? [chip(`${bad} widget${bad === 1 ? " needs" : "s need"} attention`, "error")] : []),
    );
    const ops = liveOps().length;
    save.disabled = busy || !dirty() || bad > 0;
    apply.disabled = busy || !live || bad > 0 || ops === 0;
    apply.title = !live ? "No stream is live" : ops ? `Record ${ops} change${ops === 1 ? "" : "s"} in the live stream` : "The live scene already matches the draft";
    loadLive.disabled = busy || !live;
    revert.disabled = busy || !dirty();
    reset.disabled = busy;
    add.disabled = busy || draft.length >= LIMITS.widgets;
    modes.live.disabled = !live;
    if (!live && modes.live.checked) modes.draft.checked = true;
  }

  function renderAddTypes() {
    const value = addType.value;
    addType.replaceChildren();
    for (const [type, schema] of Object.entries(WIDGET_TYPES)) {
      const option = new Option(schema.label, type);
      if (type === "embed" && !settings().embeds.length) { option.disabled = true; option.textContent = "Embed (no embed page enabled)"; }
      if (type === "image" && !settings().imageAllowlist.length) { option.disabled = true; option.textContent = "Image (add an allowlist prefix first)"; }
      addType.append(option);
    }
    addType.value = value && !addType.querySelector(`option[value="${value}"]`)?.disabled ? value : "text";
  }

  function renderList() {
    const focusKey = document.activeElement?.dataset?.key;
    const bad = problems();
    list.replaceChildren();
    listHeading.textContent = `Widgets (${draft.length} of ${LIMITS.widgets})`;
    if (!draft.length) list.append(el("p", "settings-note", "The draft is empty. Add a widget, or use the built-in layout."));
    for (const [group, heading, help] of GROUPS) {
      const members = ordered(group);
      if (!members.length) continue;
      const section = el("section", "canvas-group");
      section.dataset.group = group;
      const h = el("h4", "canvas-group-title", heading);
      h.id = `canvas-group-${group}`;
      section.append(h, el("p", "canvas-group-help", help));
      const items = el("ol", "canvas-list");
      items.setAttribute("aria-labelledby", h.id);
      members.forEach((widget, index) => items.append(row(widget, index, members, bad.get(widget.id))));
      section.append(items);
      list.append(section);
    }
    if (focusKey) list.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  function ordered(group) {
    return draft.filter(widget => groupOf(widget) === group).sort((a, b) => b.z - a.z || a.id.localeCompare(b.id));
  }

  function row(widget, index, members, problem) {
    const item = el("li", "canvas-row");
    item.dataset.widgetId = widget.id;
    item.classList.toggle("selected", widget.id === selected);
    item.classList.toggle("is-hidden", !!widget.hidden);
    item.classList.toggle("invalid", !!problem);
    const pick = el("button", "canvas-row-main");
    pick.type = "button";
    pick.dataset.key = `${widget.id}:select`;
    pick.setAttribute("aria-pressed", String(widget.id === selected));
    pick.setAttribute("aria-label", `Edit ${WIDGET_TYPES[widget.type].label} widget ${widget.id}: ${describe(widget)}`);
    const type = el("span", "canvas-type", WIDGET_TYPES[widget.type].label);
    type.dataset.type = widget.type;
    const name = el("span", "canvas-name");
    name.append(el("strong", "", widget.id), el("span", "canvas-desc", describe(widget)));
    pick.append(type, name);
    pick.onclick = () => select(widget.id, { focus: true });
    const where = groupOf(widget) === "log" ? "of the log box" : "of the stage";
    const geometry = el("span", "canvas-geometry", `${pct(widget.x)}, ${pct(widget.y)} · ${pct(widget.w)} × ${pct(widget.h)} ${where}`);
    const layer = el("span", "canvas-layer", `Layer ${widget.z}`);
    const visible = el("label", "switch canvas-visible");
    const toggle = document.createElement("input");
    Object.assign(toggle, { type: "checkbox", checked: !widget.hidden });
    toggle.setAttribute("role", "switch");
    toggle.dataset.key = `${widget.id}:visible`;
    toggle.setAttribute("aria-label", `Show ${widget.id}`);
    toggle.onchange = () => change(widget.id, { hidden: !toggle.checked });
    visible.append(toggle, el("span", "switch-track"), el("span", "canvas-visible-text", widget.hidden ? "Hidden" : "Visible"));
    const actions = el("span", "canvas-actions");
    actions.append(
      icon("up", `Move ${widget.id} up a layer`, index === 0, () => reorder(widget.id, -1), "M12 19V5M5 12l7-7 7 7"),
      icon("down", `Move ${widget.id} down a layer`, index === members.length - 1, () => reorder(widget.id, 1), "M12 5v14M5 12l7 7 7-7"),
      icon("duplicate", `Duplicate ${widget.id}`, draft.length >= LIMITS.widgets, () => duplicate(widget.id), "M8 8h11v11H8zM5 16V5h11"),
      icon("delete", `Delete ${widget.id}`, false, () => remove(widget.id), "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13", "danger"),
    );
    for (const control of actions.children) control.dataset.key = `${widget.id}:${control.dataset.action}`;
    item.append(pick, geometry, layer, visible, actions);
    if (problem) item.append(el("p", "canvas-problem", problem));
    return item;
  }

  function icon(action, label, disabled, run, path, tone = "") {
    const control = el("button", `icon-btn canvas-icon ${tone}`);
    control.type = "button";
    control.dataset.action = action;
    control.setAttribute("aria-label", label);
    control.title = label;
    control.disabled = disabled || busy;
    control.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
    control.onclick = run;
    return control;
  }

  // The properties form for the selected widget. Rebuilt only when the
  // selection changes, so typing keeps focus; every edit updates the draft.
  function renderEditor() {
    editor.replaceChildren();
    const widget = draft.find(item => item.id === selected);
    const heading = el("h3", "canvas-heading", widget ? `${WIDGET_TYPES[widget.type].label} widget · ${widget.id}` : "Widget properties");
    heading.id = "canvas-editor-title";
    editor.append(heading);
    if (!widget) { editor.append(el("p", "settings-note", "Choose a widget in the list to edit its position, layer, visibility, and properties.")); return; }
    const form = document.createElement("form");
    form.className = "canvas-form";
    form.noValidate = true;
    form.onsubmit = event => event.preventDefault();
    const geometry = el("fieldset", "canvas-fieldset");
    geometry.append(el("legend", "", groupOf(widget) === "log" ? "Position and size (percent of the log box)" : "Position and size (percent of the 16:9 stage)"));
    const number = (key, label, value, min, max, step) => {
      const wrap = el("label", "scene-field");
      const input = document.createElement("input");
      Object.assign(input, { type: "number", id: `canvas-geo-${key}`, name: key, min, max, step, value });
      wrap.htmlFor = input.id;
      wrap.append(el("span", "", label), input);
      return { wrap, input };
    };
    const geo = {
      x: number("x", "Left", round1(widget.x * 100), 0, 100, 0.5), y: number("y", "Top", round1(widget.y * 100), 0, 100, 0.5),
      w: number("w", "Width", round1(widget.w * 100), 2, 100, 0.5), h: number("h", "Height", round1(widget.h * 100), 2, 100, 0.5),
      z: number("z", "Layer (higher is in front)", widget.z, 0, LIMITS.zMax, 1),
    };
    const grid = el("div", "canvas-geo-grid");
    for (const item of Object.values(geo)) grid.append(item.wrap);
    geometry.append(grid);
    const visible = el("label", "scene-field inline");
    const visibleInput = document.createElement("input");
    Object.assign(visibleInput, { type: "checkbox", id: "canvas-geo-visible", checked: !widget.hidden });
    visible.htmlFor = visibleInput.id;
    visible.append(visibleInput, el("span", "", "Visible to viewers"));
    geometry.append(visible);
    const props = el("fieldset", "canvas-fieldset");
    props.append(el("legend", "", "Properties"));
    const fields = Object.entries(WIDGET_TYPES[widget.type].props).map(([key, spec]) => [key, spec, field(key, spec, widget.props?.[key] ?? spec.default, { ...options(), prefix: "canvas-field" })]);
    for (const [, , item] of fields) props.append(item.row);
    if (!fields.length) props.append(el("p", "settings-note", "This widget has no properties."));
    const message = el("p", "canvas-problem");
    message.setAttribute("role", "alert");
    form.append(geometry, props, message);
    editor.append(form);
    const read = commit => {
      const rect = { x: Number(geo.x.input.value) / 100, y: Number(geo.y.input.value) / 100, w: Number(geo.w.input.value) / 100, h: Number(geo.h.input.value) / 100 };
      const fitted = commit && Object.values(rect).every(Number.isFinite) ? fitRect(rect, groupOf(widget) === "log" ? "embed" : widget.type) : rect;
      if (commit && fitted !== rect) for (const key of ["x", "y", "w", "h"]) geo[key].input.value = round1(fitted[key] * 100);
      const next = { id: widget.id, type: widget.type, ...fitted, z: Number(geo.z.input.value), props: Object.fromEntries(fields.map(([key, , item]) => [key, item.read()])) };
      if (!visibleInput.checked) next.hidden = true;
      return next;
    };
    const update = commit => {
      const next = read(commit);
      let value = next;
      try { value = validateWidget(next, options()); message.textContent = ""; }
      catch (error) { message.textContent = `Not valid yet: ${error.reason || error.message}.`; }
      // A blur after typing fires "change" with nothing new: leave the list
      // alone, so a click that caused the blur still lands on its target.
      if (canonical(value) === canonical(draft.find(item => item.id === widget.id))) return;
      replace(value);
      renderSummary();
      renderList();
      drawPreview();
    };
    form.addEventListener("input", () => update(false));
    form.addEventListener("change", () => update(true));
    try { validateWidget(widget, options()); } catch (error) { message.textContent = `Not valid yet: ${error.reason || error.message}.`; }
  }
  const round1 = value => Math.round(value * 10) / 10;

  function drawPreview() {
    const showLive = modes.live.checked && view?.live;
    const widgets = showLive ? view.live.widgets : draft.filter(widget => { try { validateWidget(widget, options()); return true; } catch { return false; } });
    const now = Date.now();
    renderer.selected = showLive ? null : selected;
    renderer.update({ ...initialState(), widgets: Object.fromEntries(widgets.map(widget => [widget.id, widget])), metrics: {
      "cpa.codex.5h": { remainingPercent: 62, resetAt: now + 2 * 3600e3 + 14 * 60e3, accounts: 3, total: 3, updatedAt: now },
      "cpa.codex.week": { remainingPercent: 41, resetAt: now + 3 * 86400e3 + 5 * 3600e3, accounts: 3, total: 3, updatedAt: now },
      "tokens.today": { tokens: 1230000 }, "tokens.7d": { tokens: 12300000 },
    } });
    const hidden = widgets.filter(widget => widget.hidden).length, shown = widgets.length - hidden;
    caption.textContent = `${showLive ? "Live scene" : "Draft"} as viewers see it: ${shown} widget${shown === 1 ? "" : "s"}${hidden ? `, ${hidden} hidden not shown` : ""}. Metric widgets show sample values.`;
    preview.dataset.mode = showLive ? "live" : "draft";
  }

  // ---------- Draft edits (local until saved or applied) ----------
  function replace(widget) { draft = draft.map(item => (item.id === widget.id ? widget : item)); }

  function change(id, changes) {
    const widget = draft.find(item => item.id === id);
    if (!widget) return;
    const next = { ...widget, ...changes };
    if (!next.hidden) delete next.hidden;
    replace(next);
    renderAll({ keepEditor: id !== selected });
    if (id === selected) renderEditor();
  }

  function select(id, { focus = false } = {}) {
    selected = id;
    renderAll();
    if (focus) editor.querySelector("input, select")?.focus();
  }

  function topZ(group) {
    const peers = draft.filter(widget => groupOf(widget) === group).map(widget => widget.z);
    return group === "stage" ? Math.min(LIMITS.zMax, Math.max(99, ...peers) + 1) : peers.length ? Math.min(LIMITS.zMax, Math.max(...peers) + 1) : 0;
  }

  function addWidget() {
    const type = addType.value;
    if (draft.length >= LIMITS.widgets) return say(`Widget not added: dashboard/canvas settings — a scene holds at most ${LIMITS.widgets} widgets.`, "error");
    const base = withDefaults({ type, props: {} }, settings().defaults || {});
    const props = { ...base.props };
    if (type === "embed") props.src = settings().embeds[0];
    const widget = { id: newId(new Set(draft.map(item => item.id))), type, ...defaultRect(type), z: 0, props };
    widget.z = topZ(groupOf(widget));
    let added = widget;
    try { added = validateWidget(widget, options()); } catch {}
    draft = [...draft, added];
    say(`Added ${WIDGET_TYPES[type].label.toLowerCase()} widget ${added.id} to the draft.${type === "image" ? " Enter an allowlisted image URL." : ""}`);
    select(added.id, { focus: true });
  }

  function duplicate(id) {
    const widget = draft.find(item => item.id === id);
    if (!widget || draft.length >= LIMITS.widgets) return;
    const copy = { ...widget, id: newId(new Set(draft.map(item => item.id))), ...fitRect({ x: widget.x + 0.03, y: widget.y + 0.03, w: widget.w, h: widget.h }, groupOf(widget) === "log" ? "embed" : widget.type), props: { ...widget.props } };
    copy.z = topZ(groupOf(copy));
    draft = [...draft, copy];
    say(`Duplicated ${id} as ${copy.id}.`);
    select(copy.id);
    list.querySelector(`[data-key="${CSS.escape(copy.id)}:select"]`)?.focus();
  }

  function remove(id) {
    const group = draft.find(item => item.id === id);
    const peers = group ? ordered(groupOf(group)) : [];
    const index = peers.findIndex(item => item.id === id);
    draft = draft.filter(item => item.id !== id);
    const next = peers[index + 1] || peers[index - 1] || draft[0];
    if (selected === id) selected = next?.id ?? null;
    say(`Removed ${id} from the draft. Discard changes brings it back until you save.`);
    renderAll();
    (list.querySelector(`[data-key="${CSS.escape(`${next?.id}:select`)}"]`) || add).focus();
  }

  // Swaps layers with the neighbour in the same group (direction -1 = up / in front).
  function reorder(id, direction) {
    const widget = draft.find(item => item.id === id);
    const peers = ordered(groupOf(widget));
    const index = peers.findIndex(item => item.id === id), other = peers[index + direction];
    if (!other) return;
    let mine = other.z, theirs = widget.z;
    if (mine === theirs) mine = Math.max(0, Math.min(LIMITS.zMax, other.z - direction));
    draft = draft.map(item => (item.id === id ? { ...item, z: mine } : item.id === other.id ? { ...item, z: theirs } : item));
    say(`Moved ${id} ${direction < 0 ? "up" : "down"}: now layer ${mine}.`);
    renderAll({ keepEditor: id !== selected });
    if (id === selected) renderEditor();
    list.querySelector(`[data-key="${CSS.escape(`${id}:${direction < 0 ? "up" : "down"}`)}"]:not(:disabled)`)?.focus();
  }

  // ---------- Server ----------
  async function load({ keepDraft = false } = {}) {
    view = await api("/api/scene/layout");
    if (!keepDraft) draft = view.layout.widgets.map(widget => ({ ...widget }));
    if (!draft.some(widget => widget.id === selected)) selected = draft[0]?.id ?? null;
    renderAll();
    renderConfig();
  }

  async function run(control, task) {
    busy = true;
    renderSummary();
    try { await task(); }
    catch (error) { say(error.message, "error"); }
    finally { busy = false; renderSummary(); renderList(); control?.focus?.(); }
  }

  save.onclick = () => run(save, async () => {
    validateLayout({ widgets: draft }, options());
    view = await api("/api/scene/layout", { method: "PUT", body: JSON.stringify({ widgets: draft, baseVersion: view.layout.version }) });
    draft = view.layout.widgets.map(widget => ({ ...widget }));
    say(`Layout saved as version ${view.layout.version}. It opens every new stream${view.live ? "; the live stream changes only through Apply to live stream or Edit scene" : ""}.`, "ok");
    renderAll({ keepEditor: true });
  });

  apply.onclick = () => run(apply, async () => {
    view = { ...view, ...(await api("/api/scene/layout")), layout: view.layout };
    if (!view.live) throw new Error("Live scene not changed: dashboard/canvas settings — the stream is no longer live.");
    const ops = liveOps();
    if (!ops.length) { say("The live scene already matches the draft."); return; }
    const counts = ["create", "update", "delete"].map(op => [op, ops.filter(item => item.op === op).length]).filter(([, n]) => n);
    const ok = await confirm("Apply to the live stream?", [
      `Viewers see these changes right away, and they are recorded in the public recording: ${counts.map(([op, n]) => `${n} ${{ create: "added", update: "changed", delete: "removed" }[op]}`).join(", ")}.`,
      ...ops.slice(0, 8).map(item => `${{ create: "Add", update: "Change", delete: "Remove" }[item.op]} ${WIDGET_TYPES[item.widget.type]?.label.toLowerCase() || "widget"} ${item.id}`),
      ...(ops.length > 8 ? [`…and ${ops.length - 8} more`] : []),
      "The saved layout does not change; use Save layout for future streams.",
    ], "Apply to live stream");
    if (!ok) { say("Nothing was applied."); return; }
    let done = 0;
    for (const item of ops) {
      const url = `/api/scene/widgets${item.op === "create" ? "" : `/${encodeURIComponent(item.id)}`}?scope=live`;
      const { id, type, ...changes } = item.widget;
      const request = item.op === "create" ? { method: "POST", body: JSON.stringify({ widget: item.widget }) }
        : item.op === "update" ? { method: "PATCH", body: JSON.stringify({ changes: { ...changes, hidden: !!item.widget.hidden } }) }
        : { method: "DELETE", body: "{}" };
      // Paced under the administrator limit (5 changes per second); a 429 waits and retries.
      for (let attempt = 0; ; attempt++) {
        try { await api(url, request); break; }
        catch (error) { if (!/rate limit|at most \d+ (times|scene events) per second/.test(error.message) || attempt >= 5) throw new Error(`${error.message} (${done} of ${ops.length} changes were applied before this one.)`); await pause(1200); }
      }
      done++;
      say(`Applying to the live stream… ${done} of ${ops.length}`);
      await pause(220);
    }
    const fresh = await api("/api/scene/layout");
    view = { ...fresh, layout: view.layout };
    say(`Applied ${done} change${done === 1 ? "" : "s"} to the live stream; they are recorded in its replay.${dirty() ? " The saved layout is unchanged: Save layout keeps the draft for future streams." : ""}`, "ok");
    renderAll({ keepEditor: true });
  });

  add.onclick = () => addWidget();
  loadLive.onclick = () => { if (!view?.live) return; draft = view.live.widgets.map(widget => migrateWidget({ ...widget })); say("Loaded the live scene into the draft."); renderAll(); };
  revert.onclick = () => { draft = view.layout.widgets.map(widget => ({ ...widget })); say("Draft reset to the saved layout."); renderAll(); };
  reset.onclick = () => { draft = builtinLayout({ embeds: settings().embeds, settings: settings() }); say("Loaded the built-in layout into the draft. Save layout to keep it."); renderAll(); };

  function confirm(heading, lines, action) {
    return new Promise(resolve => {
      dialog.replaceChildren();
      const h = el("h3", "", heading);
      h.id = "canvas-confirm-title";
      const body = el("ul", "canvas-dialog-list");
      for (const line of lines.slice(1)) body.append(el("li", "", line));
      const actions = el("div", "canvas-dialog-actions");
      const cancel = button("Cancel", "canvas-confirm-cancel");
      const ok = button(action, "canvas-confirm-ok", "", "primary");
      actions.append(cancel, ok);
      dialog.append(h, el("p", "", lines[0]), body, actions);
      const finish = value => { dialog.onclose = null; if (dialog.open) dialog.close(); resolve(value); };
      cancel.onclick = () => finish(false);
      ok.onclick = () => finish(true);
      dialog.onclose = () => finish(false);
      dialog.showModal();
      cancel.focus();
    });
  }

  // ---------- Scene configuration form ----------
  function renderConfig() {
    const current = settings();
    config.replaceChildren();
    const section = (legend, help) => { const set = el("fieldset", "canvas-fieldset"); set.append(el("legend", "", legend)); if (help) set.append(el("p", "canvas-group-help", help)); config.append(set); return set; };
    const select = (id, label, choices, value) => {
      const wrap = el("label", "scene-field");
      const input = document.createElement("select");
      input.id = id;
      for (const [option, text] of choices) input.append(new Option(text, option));
      input.value = String(value);
      wrap.htmlFor = id;
      wrap.append(el("span", "", label), input);
      return { wrap, input };
    };
    const check = (id, label, value) => {
      const wrap = el("label", "scene-field inline");
      const input = document.createElement("input");
      Object.assign(input, { type: "checkbox", id, checked: !!value });
      wrap.htmlFor = id;
      wrap.append(input, el("span", "", label));
      return { wrap, input };
    };

    const images = section("Image allowlist", "Add up to 16 HTTPS prefixes. Image widgets can use addresses that begin with an allowed prefix.");
    const prefixes = [...current.imageAllowlist];
    if (!prefixes.length) prefixes.push("");
    const imageRows = el("div", "image-prefix-list");
    const drawPrefixes = () => {
      imageRows.replaceChildren();
      prefixes.forEach((prefix, index) => {
        const row = el("div", "image-prefix-row");
        const value = document.createElement("input"); value.type = "url";
        value.id = index === 0 ? "canvas-allowlist" : `canvas-allowlist-${index}`;
        value.value = prefix; value.placeholder = "https://images.example.com/stream/";
        value.setAttribute("aria-label", `Allowed image URL prefix ${index + 1}`);
        value.oninput = () => { prefixes[index] = value.value; };
        const remove = button("Remove", `canvas-prefix-remove-${index}`);
        remove.onclick = () => { prefixes.splice(index, 1); drawPrefixes(); };
        row.append(value, remove); imageRows.append(row);
      });
    };
    const addPrefix = button("Add image prefix", "canvas-prefix-add");
    addPrefix.onclick = () => { if (prefixes.length < 16) { prefixes.push(""); drawPrefixes(); } };
    drawPrefixes(); images.append(imageRows, addPrefix);

    const embeds = section("Embed pages", "Pages this deployment serves (set by the operator). A disabled page cannot be used, and widgets that use it drop out of the layout.");
    const embedChecks = current.servedEmbeds.map(path => {
      const item = check(`canvas-embed-${path.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`, `${EMBED_NAMES[path] || path} (${path})`, !current.disabledEmbeds.includes(path));
      embeds.append(item.wrap);
      return [path, item.input];
    });
    if (!current.servedEmbeds.length) embeds.append(el("p", "settings-note", "None: the operator has not configured an embed directory (CIRCTIME_EMBED_DIR)."));

    const embed = section("Embed defaults", "Used for new embed widgets and the built-in backdrop. Embeds never take clicks; log text above them stays selectable.");
    const embedGrid = el("div", "canvas-geo-grid");
    const spec = WIDGET_TYPES.embed.props;
    const attach = select("canvas-default-attach", spec.attach.label, spec.attach.options.map(option => [option, spec.attach.labels[option]]), current.defaults.embed.attach);
    const theme = select("canvas-default-theme", spec.theme.label, spec.theme.options.map(option => [option, spec.theme.labels[option]]), current.defaults.embed.theme);
    const opacityWrap = el("label", "scene-field");
    const opacity = document.createElement("input");
    Object.assign(opacity, { type: "range", id: "canvas-default-opacity", min: spec.opacity.min, max: spec.opacity.max, step: spec.opacity.step, value: current.defaults.embed.opacity });
    const opacityValue = el("output", "canvas-output", `${Math.round(current.defaults.embed.opacity * 100)}%`);
    opacity.oninput = () => { opacityValue.textContent = `${Math.round(Number(opacity.value) * 100)}%`; };
    opacityWrap.htmlFor = opacity.id;
    const opacityCaption = el("span", "");
    opacityCaption.append(`${spec.opacity.label} `, opacityValue);
    opacityWrap.append(opacityCaption, opacity);
    embedGrid.append(attach.wrap, theme.wrap, opacityWrap);
    embed.append(embedGrid);

    const metric = section("Metric widgets", "Defaults for new metric widgets, and how often live values refresh while a metric widget is on a live stream.");
    const metricGrid = el("div", "canvas-geo-grid");
    const source = select("canvas-default-source", "Default source", Object.entries(METRIC_SOURCES), current.defaults.metric.source);
    const colour = select("canvas-default-color", "Default colour", Object.keys(PALETTE).map(name => [name, name]), current.defaults.metric.color);
    const minutes = select("canvas-refresh-minutes", "Refresh every", REFRESH_MINUTES.map(value => [String(value), `${value} minutes`]), current.metricRefresh.minutes);
    metricGrid.append(source.wrap, colour.wrap, minutes.wrap);
    const cpa = check("canvas-refresh-cpa", "Refresh CPA quota from upstream on each refresh (off: publish the last stored snapshot)", current.metricRefresh.cpa);
    metric.append(metricGrid, cpa.wrap);

    const characters = section("Avatar and cat", "The built-in layout includes the checked widgets; mirroring applies to new widgets and the built-in layout.");
    const charGrid = el("div", "canvas-check-grid");
    const avatarIn = check("canvas-builtin-avatar", "Avatar in the built-in layout", current.builtin.avatar);
    const avatarMirror = check("canvas-default-avatar-mirror", "Mirror the avatar", current.defaults.avatar.mirror);
    const catIn = check("canvas-builtin-cat", "Cat in the built-in layout", current.builtin.cat);
    const catMirror = check("canvas-default-cat-mirror", "Mirror the cat", current.defaults.cat.mirror);
    const embedIn = check("canvas-builtin-embed", "Embed backdrop in the built-in layout", current.builtin.embed);
    charGrid.append(avatarIn.wrap, avatarMirror.wrap, catIn.wrap, catMirror.wrap, embedIn.wrap);
    characters.append(charGrid);

    const submit = button("Save configuration", "canvas-config-save", "", "primary");
    submit.type = "submit";
    const actions = el("div", "canvas-form-actions");
    actions.append(submit);
    config.append(actions);
    config.onsubmit = event => {
      event.preventDefault();
      run(submit, async () => {
        const disabledEmbeds = embedChecks.filter(([, input]) => !input.checked).map(([path]) => path);
        const losing = [...new Set([...draft, ...view.layout.widgets].filter(widget => widget.type === "embed" && disabledEmbeds.includes(widget.props.src)).map(widget => widget.id))];
        if (losing.length && !(await confirm("Disable this embed page?", [`${losing.length} widget${losing.length === 1 ? " uses" : "s use"} it and will drop out of the layout: ${losing.join(", ")}.`, "Re-enabling the page before the next save brings them back.", "Recorded streams keep showing what viewers saw."], "Disable"))) { configStatus.textContent = "Configuration not saved."; return; }
        view.settings = await api("/api/scene/settings", { method: "PUT", body: JSON.stringify({
          imageAllowlist: prefixes.map(value => value.trim()).filter(Boolean),
          disabledEmbeds,
          defaults: { embed: { attach: attach.input.value, theme: theme.input.value, opacity: Number(opacity.value) }, metric: { source: source.input.value, color: colour.input.value }, avatar: { mirror: avatarMirror.input.checked }, cat: { mirror: catMirror.input.checked } },
          builtin: { avatar: avatarIn.input.checked, cat: catIn.input.checked, embed: embedIn.input.checked },
          metricRefresh: { minutes: Number(minutes.input.value), cpa: cpa.input.checked },
        }) });
        await load({ keepDraft: true });
        configStatus.textContent = `Configuration saved ${new Date(view.settings.updatedAt).toLocaleTimeString()}.`;
      });
    };
  }

  load().catch(error => say(error.message, "error"));
  return box;
}

function button(text, id, title = "", tone = "") {
  const control = el("button", `action-btn${tone ? ` ${tone}` : ""}`, text);
  control.type = "button";
  control.id = id;
  if (title) control.title = title;
  return control;
}

function chip(text, tone, title) {
  const item = el("span", `canvas-chip${tone ? ` tone-${tone}` : ""}`, text);
  if (title) item.title = title;
  return item;
}
