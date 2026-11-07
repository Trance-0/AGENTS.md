import { el } from "/api.js";

export function button(label, action, primary = false) {
  const node = el("button", primary ? "primary" : "", label); node.type = "button"; node.onclick = action; return node;
}
export function section(title, description) {
  const box = el("section", "settings-card preference-section");
  box.append(el("h2", "", title));
  if (description) box.append(el("p", "settings-card-note", description));
  return box;
}
export function field(label, control, help = "") {
  const row = el("label", "preference-field");
  control.setAttribute("aria-label", label);
  row.append(el("span", "field-label", label), control);
  if (help) row.append(el("small", "field-help", help));
  return row;
}
export function input(value, change, type = "text") {
  const node = document.createElement("input"); node.type = type; node.value = value ?? "";
  node.oninput = () => change(type === "number" ? (node.value === "" ? undefined : Number(node.value)) : node.value);
  return node;
}
export function select(value, options, change) {
  const node = document.createElement("select");
  const entries = Array.isArray(options) ? options.map(item => [item, item]) : Object.entries(options);
  if (value !== undefined && !entries.some(([key]) => key === value)) entries.unshift([value, value]);
  for (const [key, label] of entries) node.append(new Option(label, key));
  node.value = value ?? ""; node.onchange = () => change(node.value); return node;
}
export function toggle(label, value, change) {
  const row = el("label", "preference-toggle"); row.append(el("span", "field-label", label));
  const control = el("span", "switch"); const checkbox = document.createElement("input"); checkbox.type = "checkbox";
  checkbox.checked = !!value; checkbox.setAttribute("role", "switch"); checkbox.onchange = () => change(checkbox.checked);
  control.append(checkbox, el("span", "switch-track")); row.append(control); return row;
}
export function editorTabs(form, raw, { label, toJson, toForm, status }) {
  const bar = el("div", "editor-segments"); bar.setAttribute("role", "tablist"); bar.setAttribute("aria-label", label);
  const views = [["UI editor", form], ["JSON", raw]];
  function show(index) {
    if ((index === 1) === !raw.hidden) return;
    try { if (index === 1) toJson(); else if (!raw.hidden) toForm(); }
    catch (error) { status.textContent = `Editor cannot switch: dashboard/settings validation — ${error.message}`; return; }
    views.forEach(([, view], i) => { view.hidden = i !== index; buttons[i].setAttribute("aria-selected", String(i === index)); buttons[i].tabIndex = i === index ? 0 : -1; });
  }
  const buttons = views.map(([title], i) => { const b = button(title, () => show(i)); b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(i === 0)); b.tabIndex = i === 0 ? 0 : -1; bar.append(b); return b; });
  bar.onkeydown = event => {
    const current = buttons.indexOf(document.activeElement); if (current < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - current; show(next); buttons[next].focus();
  };
  raw.hidden = true;
  return { bar, isRaw: () => !raw.hidden };
}
