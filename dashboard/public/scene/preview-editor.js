import { fitRect } from './editor.js';

/** Pointer edits only change the local draft; saving/applying stays explicit. */
export function enablePreviewEditing({ preview, renderer, getWidgets, isEditable, select, change, add }) {
  let gesture = null;
  const overlay = document.createElement('div'); overlay.className = 'preview-draw-box'; overlay.hidden = true; preview.append(overlay);
  preview.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !isEditable()) return;
    const target = preview.dataset.drawMode === 'true' || event.shiftKey ? null : event.target.closest('[data-widget-id]');
    const widget = getWidgets().find(w => w.id === target?.dataset.widgetId);
    const layer = widget ? renderer.layerOf(widget) : renderer.stage;
    const rect = layer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    event.preventDefault();
    if (widget) select(widget.id);
    gesture = { id: widget?.id, original: widget ? structuredClone(widget) : null, rect,
      x: event.clientX, y: event.clientY, resize: event.target.classList.contains('preview-resize'), moved: false };
    preview.setPointerCapture(event.pointerId);
  });
  preview.addEventListener('pointermove', event => {
    if (!gesture) return;
    const g = gesture, dx = (event.clientX - g.x) / g.rect.width, dy = (event.clientY - g.y) / g.rect.height;
    if (Math.abs(event.clientX - g.x) + Math.abs(event.clientY - g.y) < 3 && !g.moved) return;
    g.moved = true;
    if (g.original) {
      const w = g.original;
      const shape = g.resize ? { x: w.x, y: w.y, w: w.w + (w.type === "avatar" && Math.abs(dy) > Math.abs(dx) ? dy * 9 / 16 : dx), h: w.h + dy } : { ...w, x: w.x + dx, y: w.y + dy };
      change(w.id, fitRect(shape, w.props?.attach === 'log' ? 'embed' : w.type));
    } else {
      const bounds = preview.getBoundingClientRect();
      Object.assign(overlay.style, { left: `${Math.min(g.x, event.clientX) - bounds.left}px`, top: `${Math.min(g.y, event.clientY) - bounds.top}px`, width: `${Math.abs(event.clientX - g.x)}px`, height: `${Math.abs(event.clientY - g.y)}px` });
      overlay.hidden = false;
    }
  });
  preview.addEventListener('pointerup', event => {
    const g = gesture; gesture = null; overlay.hidden = true;
    if (!g) return;
    if (g.moved && !g.id) {
      add({ x: (Math.min(g.x, event.clientX) - g.rect.left) / g.rect.width, y: (Math.min(g.y, event.clientY) - g.rect.top) / g.rect.height,
        w: Math.abs(event.clientX - g.x) / g.rect.width, h: Math.abs(event.clientY - g.y) / g.rect.height });
    }
  });
  preview.addEventListener('pointercancel', () => {
    if (gesture?.original) change(gesture.id, gesture.original);
    gesture = null; overlay.hidden = true;
  });
  return () => {
    const editable = isEditable(); preview.classList.toggle('preview-editable', editable);
    for (const node of renderer.nodes.values()) {
      let handle = node.el.querySelector('.preview-resize');
      if (editable && !handle) { handle = document.createElement('span'); handle.className = 'preview-resize'; handle.setAttribute('aria-label', 'Resize widget'); node.el.append(handle); }
      if (handle) handle.hidden = !editable;
    }
  };
}
