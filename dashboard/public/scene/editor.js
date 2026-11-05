// Admin scene editor on the Live stage. Drag on empty stage to draw a
// rectangle and pick a widget type; left-click a widget for its menu (edit
// properties, create new, duplicate, delete, bring forward, send back); drag
// to move, corner handles to resize, arrow keys to nudge, Delete to remove,
// Esc to close a menu or exit, Ctrl/Cmd+Z (or Undo) to revert the last edit.
//
// Edits go through the admin scene API. With no live stream they change the
// saved default layout; while live they are also recorded as widget events.
import { LIMITS, WIDGET_TYPES, defaultRect, mergeWidget } from "./schema.js";
import { openForm, openMenu, closePopups } from "./editor-popups.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = value => Math.round(value * 10000) / 10000;
const MIN = LIMITS.minSize;

// Keeps a rectangle inside the stage; avatars stay square on the 16:9 stage.
export function fitRect({ x, y, w, h }, type) {
  w = clamp(w, MIN, 1); h = clamp(h, MIN, 1);
  if (WIDGET_TYPES[type]?.aspect === 1) {
    h = w * 16 / 9;
    if (h > 1) { h = 1; w = 9 / 16; }
  }
  return { x: round(clamp(x, 0, 1 - w)), y: round(clamp(y, 0, 1 - h)), w: round(w), h: round(h) };
}

export class SceneEditor {
  constructor({ renderer, api, report, toolbar }) {
    Object.assign(this, { renderer, api, report, toolbar });
    this.active = false;
    this.widgets = null;
    this.undoStack = [];
    this.stage = renderer.stage;
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    toolbar.toggle.onclick = () => (this.active ? this.close() : this.open().catch(error => this.status(error.message)));
    toolbar.done.onclick = () => this.close();
    toolbar.undo.onclick = () => this.undo();
  }

  status(text) { this.toolbar.mode.textContent = text; }

  async open() {
    const view = await this.api("/api/scene/layout");
    this.live = !!view.live;
    this.allowlist = view.settings.imageAllowlist;
    this.embeds = view.settings.embeds || [];
    this.layoutVersion = view.layout.version;
    this.widgets = Object.fromEntries((view.live ? view.live.widgets : view.layout.widgets).map(widget => [widget.id, widget]));
    this.active = true;
    this.undoStack = [];
    document.body.classList.add("scene-editing");
    this.stage.classList.add("editing");
    this.stage.tabIndex = -1;
    this.stage.addEventListener("pointerdown", this.onPointerDown);
    this.stage.addEventListener("keydown", this.onKeyDown);
    this.toolbar.toggle.setAttribute("aria-pressed", "true");
    this.toolbar.toggle.textContent = "Editing scene";
    this.toolbar.done.hidden = false;
    this.toolbar.undo.hidden = false;
    this.syncUndo();
    this.status(this.live
      ? "Editing the live scene: changes are recorded in this stream and saved to the default layout. Drag on the stage to add a widget; click a widget for options."
      : "Editing the saved default layout (no stream is live). It opens every new stream. Drag on the stage to add a widget; click a widget for options.");
    this.render();
    this.stage.focus?.();
  }

  close() {
    if (!this.active) return;
    closePopups();
    clearTimeout(this.nudgeTimer);
    this.nudge = null;
    this.active = false;
    this.widgets = null;
    document.body.classList.remove("scene-editing");
    this.stage.classList.remove("editing");
    this.stage.removeAttribute("tabindex");
    this.stage.removeEventListener("pointerdown", this.onPointerDown);
    this.stage.removeEventListener("keydown", this.onKeyDown);
    this.toolbar.toggle.setAttribute("aria-pressed", "false");
    this.toolbar.toggle.textContent = "Edit scene";
    this.toolbar.done.hidden = true;
    this.toolbar.undo.hidden = true;
    this.status("");
    this.renderer.setOverride(null, null);
  }

  render(selected = this.selected) {
    this.selected = selected && this.widgets?.[selected] ? selected : null;
    this.renderer.setOverride({ ...this.widgets }, this.selected);
  }

  syncUndo() { this.toolbar.undo.disabled = !this.undoStack.length; }

  point(event) {
    const box = this.stage.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / box.width, 0, 1), y: clamp((event.clientY - box.top) / box.height, 0, 1) };
  }

  // ---------- API operations (optimistic, reverted on failure) ----------
  async request(url, method, body) {
    return this.api(url, { method, body: JSON.stringify(body ?? {}) });
  }

  async create(widget, { record = true } = {}) {
    const { widget: saved } = await this.request("/api/scene/widgets", "POST", { widget });
    if (!this.active) return saved; // closed while the request was in flight
    this.widgets[saved.id] = saved;
    if (record) this.push({ label: "add", undo: () => this.remove(saved.id, { record: false }) });
    this.render(saved.id);
    return saved;
  }

  async update(id, changes, { record = true } = {}) {
    const before = this.widgets?.[id];
    if (!before) return;
    try { this.widgets[id] = mergeWidget(before, changes, { allowlist: this.allowlist, embeds: this.embeds }); this.render(id); }
    catch (error) { this.status(`Widget not changed: dashboard/scene editor — ${error.reason || error.message}.`); return; }
    try {
      const { widget } = await this.request(`/api/scene/widgets/${encodeURIComponent(id)}`, "PATCH", { changes });
      if (!this.active) return;
      this.widgets[id] = widget;
      if (record) this.push({ label: "change", undo: () => this.update(id, { x: before.x, y: before.y, w: before.w, h: before.h, z: before.z, props: before.props, hidden: !!before.hidden }, { record: false }) });
      this.render(id);
    } catch (error) {
      if (!this.active) return;
      this.widgets[id] = before;
      this.render(id);
      this.status(error.message);
    }
  }

  async remove(id, { record = true } = {}) {
    const before = this.widgets?.[id];
    if (!before) return;
    await this.request(`/api/scene/widgets/${encodeURIComponent(id)}`, "DELETE");
    if (!this.active) return;
    delete this.widgets[id];
    if (record) this.push({ label: "delete", undo: () => this.create(before, { record: false }) });
    this.render(null);
  }

  push(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 30) this.undoStack.shift();
    this.syncUndo();
  }

  async undo() {
    const entry = this.undoStack.pop();
    this.syncUndo();
    if (!entry) return;
    try { await entry.undo(); this.status(`Undid the last ${entry.label}.`); }
    catch (error) { this.status(error.message); }
  }

  guarded(promise) { promise.catch(error => this.status(error.message)); }

  // ---------- Menus ----------
  typeMenu(rect, anchor) {
    openMenu(this.stage, anchor, "Add widget", Object.entries(WIDGET_TYPES).map(([type, schema]) => ({
      label: schema.label, id: `add-${type}`,
      run: () => {
        if (type === "image" && !this.allowlist.length) return this.status("Image widget not added: dashboard/scene editor — no image allowlist is configured; add an HTTPS prefix in Settings → Scene defaults first.");
        if (type === "embed" && !this.embeds.length) return this.status("Embed widget not added: dashboard/scene editor — this deployment serves no embed pages (CIRCTIME_EMBED_DIR is not set).");
        if (type === "embed") return this.guarded(this.create({ type, ...fitRect(rect, type), props: { src: this.embeds[0] } }));
        if (type === "image") return this.propertiesForm({ id: null, type, ...fitRect(rect, type), z: 100, props: {} });
        this.guarded(this.create({ type, ...fitRect(rect, type) }));
      },
    })), () => this.stage.focus());
  }

  widgetMenu(id, anchor) {
    const widget = this.widgets?.[id];
    if (!widget) return;
    const zs = Object.values(this.widgets).filter(item => item.id !== id).map(item => item.z);
    const offset = (rect, d) => fitRect({ ...rect, x: rect.x + d, y: rect.y + d }, widget.type);
    openMenu(this.stage, anchor, `${WIDGET_TYPES[widget.type].label} widget`, [
      { id: "edit", label: "Edit properties…", run: () => this.propertiesForm(widget) },
      { id: "new", label: "Create new…", run: () => this.typeMenu(offset(defaultRect(widget.type), 0), anchor) },
      { id: "duplicate", label: "Duplicate", run: () => this.guarded(this.create({ type: widget.type, ...offset(widget, 0.03), props: widget.props })) },
      { id: "forward", label: "Bring forward", run: () => this.guarded(this.update(id, { z: clamp(Math.max(widget.z, ...zs) + 1, 0, LIMITS.zMax) })) },
      { id: "back", label: "Send back", run: () => this.guarded(this.update(id, { z: clamp(Math.min(widget.z, ...zs) - 1, 0, LIMITS.zMax) })) },
      { id: "visibility", label: widget.hidden ? "Show on stream" : "Hide on stream", run: () => this.guarded(this.update(id, { hidden: !widget.hidden })) },
      { id: "delete", label: "Delete", danger: true, run: () => this.guarded(this.remove(id)) },
    ], () => this.renderer.nodes.get(id)?.el.focus());
  }

  propertiesForm(widget) {
    const anchor = widget.id ? this.renderer.nodes.get(widget.id)?.el : this.stage;
    openForm(this.stage, anchor, widget, { allowlist: this.allowlist, embeds: this.embeds }, async props => {
      if (!widget.id) await this.create({ type: widget.type, x: widget.x, y: widget.y, w: widget.w, h: widget.h, props });
      else await this.update(widget.id, { props });
    });
  }

  // ---------- Pointer: draw, select, move, resize ----------
  onPointerDown(event) {
    if (event.button !== 0 || event.target.closest(".scene-popup")) return;
    closePopups();
    let target = event.target.closest(".scene-widget");
    const start = this.point(event);
    // A full-stage backdrop (embed) acts as empty stage until it is selected:
    // dragging over it draws a new widget, a plain click opens its menu.
    const backdrop = target && WIDGET_TYPES[this.widgets[target.dataset.widgetId]?.type]?.back && this.selected !== target.dataset.widgetId ? target : null;
    if (backdrop) target = null;
    const id = target?.dataset.widgetId;
    const corner = event.target.dataset?.corner;
    const original = id ? { ...this.widgets[id] } : null;
    let moved = false, ghost = null;
    this.stage.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (id) this.render(id);
    const rectFrom = now => {
      if (!original) return { x: Math.min(start.x, now.x), y: Math.min(start.y, now.y), w: Math.abs(now.x - start.x), h: Math.abs(now.y - start.y) };
      const dx = now.x - start.x, dy = now.y - start.y;
      if (!corner) return fitRect({ ...original, x: original.x + dx, y: original.y + dy }, original.type);
      const left = corner.includes("w"), top = corner.includes("n");
      const x1 = left ? Math.min(original.x + dx, original.x + original.w - MIN) : original.x;
      const y1 = top ? Math.min(original.y + dy, original.y + original.h - MIN) : original.y;
      const x2 = left ? original.x + original.w : Math.max(original.x + original.w + dx, original.x + MIN);
      const y2 = top ? original.y + original.h : Math.max(original.y + original.h + dy, original.y + MIN);
      return fitRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, original.type);
    };
    const move = moveEvent => {
      if (!this.active) return;
      const now = this.point(moveEvent);
      if (!moved && Math.hypot((now.x - start.x) * this.stage.clientWidth, (now.y - start.y) * this.stage.clientHeight) < 4) return;
      moved = true;
      const rect = rectFrom(now);
      if (original) { this.widgets[id] = { ...original, ...rect }; this.render(id); }
      else {
        ghost ??= Object.assign(document.createElement("div"), { className: "scene-draw" });
        this.stage.append(ghost);
        Object.assign(ghost.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` });
      }
    };
    const up = upEvent => {
      this.stage.removeEventListener("pointermove", move);
      this.stage.removeEventListener("pointerup", up);
      this.stage.removeEventListener("pointercancel", up);
      ghost?.remove();
      if (!this.active) return;
      if (upEvent.type === "pointercancel") { if (original) { this.widgets[id] = original; this.render(id); } return; }
      const rect = rectFrom(this.point(upEvent));
      if (original && moved) {
        this.widgets[id] = original;
        this.guarded(this.update(id, { x: rect.x, y: rect.y, w: rect.w, h: rect.h }));
      } else if (original) this.widgetMenu(id, target);
      else if (moved && rect.w >= MIN && rect.h >= MIN) this.typeMenu(rect, ghost || this.stage, rect);
      else if (backdrop) { this.render(backdrop.dataset.widgetId); this.widgetMenu(backdrop.dataset.widgetId, backdrop); }
      else this.render(null);
    };
    this.stage.addEventListener("pointermove", move);
    this.stage.addEventListener("pointerup", up);
    this.stage.addEventListener("pointercancel", up);
  }

  // ---------- Keyboard ----------
  onKeyDown(event) {
    if (event.target.closest(".scene-popup")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); this.undo(); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); this.toolbar.toggle.focus(); return; }
    const id = event.target.closest(".scene-widget")?.dataset.widgetId;
    if (!id || !this.widgets[id]) return;
    const widget = this.widgets[id];
    const step = event.shiftKey ? 0.05 : 0.01;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (delta) {
      event.preventDefault();
      this.nudge ??= { id, original: { ...widget } };
      this.widgets[id] = { ...widget, ...fitRect({ ...widget, x: widget.x + delta[0], y: widget.y + delta[1] }, widget.type) };
      this.render(id);
      this.renderer.nodes.get(id)?.el.focus();
      // One recorded change per burst of key presses.
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = setTimeout(() => {
        const original = this.nudge?.original, current = this.widgets?.[id];
        this.nudge = null;
        if (!current || !original) return;
        this.widgets[id] = original;
        this.guarded(this.update(id, { x: current.x, y: current.y }).then(() => this.renderer.nodes.get(id)?.el.focus()));
      }, 400);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.guarded(this.remove(id).then(() => this.stage.focus()));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.render(id);
      this.widgetMenu(id, this.renderer.nodes.get(id)?.el);
    }
  }
}
