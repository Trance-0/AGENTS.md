// Pure helpers for Settings → Canvas settings (no DOM): compare widgets and
// list the widget operations that turn the live scene into a draft layout.
import { migrateWidget } from "./schema.js";

// JSON with sorted object keys, so prop order never counts as a change.
export const canonical = value => JSON.stringify(value, (_key, item) => (item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));

// Ordered operations that turn the live scene into the draft: deletions
// first (they free widget slots), then creations, then changes.
export function liveDiff(liveWidgets, draft) {
  const live = new Map(liveWidgets.map(widget => [widget.id, migrateWidget(widget)]));
  const next = new Map(draft.map(widget => [widget.id, widget]));
  const ops = [];
  for (const [id, widget] of live) if (!next.has(id)) ops.push({ op: "delete", id, widget });
  for (const [id, widget] of next) if (!live.has(id)) ops.push({ op: "create", id, widget });
  for (const [id, widget] of next) {
    const before = live.get(id);
    if (!before) continue;
    if (before.type !== widget.type) { ops.unshift({ op: "delete", id, widget: before }); ops.push({ op: "create", id, widget }); continue; }
    if (canonical({ ...before, hidden: !!before.hidden }) !== canonical({ ...widget, hidden: !!widget.hidden })) ops.push({ op: "update", id, widget });
  }
  return ops;
}
