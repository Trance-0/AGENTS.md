// Popup menu and properties form for the scene editor. Both are fixed-position
// elements inside the screen surface (so they also work in full display),
// keyboard accessible, and closed by Esc or an outside click. The form is
// generated from the widget type's schema; values are checked with the shared
// validator before they are sent.
import { WIDGET_TYPES, validateWidget } from "./schema.js";

let current = null;

export function closePopups({ restore = false } = {}) {
  if (!current) return;
  const { el, onClose } = current;
  current = null;
  el.remove();
  document.removeEventListener("pointerdown", outside, true);
  if (restore) onClose?.();
}

function outside(event) {
  if (current && !current.el.contains(event.target)) closePopups();
}

function place(el, anchor) {
  const host = document.querySelector("#screen-surface") || document.body;
  host.append(el);
  const box = (anchor?.getBoundingClientRect?.() ?? host.getBoundingClientRect());
  const width = el.offsetWidth, height = el.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - width - 8, box.left + Math.min(box.width, 24)));
  const below = box.bottom + 6 + height <= innerHeight ? box.bottom + 6 : box.top - height - 6;
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, below))}px`;
}

function open(el, anchor, onClose) {
  closePopups();
  current = { el, onClose };
  place(el, anchor);
  setTimeout(() => document.addEventListener("pointerdown", outside, true));
}

export function openMenu(_stage, anchor, title, items, onClose) {
  const menu = document.createElement("div");
  menu.className = "scene-popup scene-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", title);
  const heading = document.createElement("div");
  heading.className = "scene-popup-title";
  heading.textContent = title;
  menu.append(heading);
  const buttons = items.map(item => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `scene-menu-item${item.danger ? " danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.dataset.action = item.id;
    button.textContent = item.label;
    button.tabIndex = -1;
    button.onclick = () => { closePopups(); item.run(); };
    menu.append(button);
    return button;
  });
  menu.onkeydown = event => {
    const index = buttons.indexOf(document.activeElement);
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move) buttons[(index + move + buttons.length) % buttons.length].focus();
    else if (event.key === "Home") buttons[0].focus();
    else if (event.key === "End") buttons.at(-1).focus();
    else if (event.key === "Escape" || event.key === "Tab") closePopups({ restore: true });
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  open(menu, anchor, onClose);
  buttons[0]?.focus();
  return menu;
}

// One schema-generated form field (shared with Settings → Canvas settings).
// `options.prefix` keeps element IDs unique when both forms exist.
export function field(key, spec, value, options = {}) {
  const id = `${options.prefix || "scene-field"}-${key}`;
  const row = document.createElement("label");
  row.className = "scene-field";
  row.htmlFor = id;
  const caption = document.createElement("span");
  caption.textContent = spec.label;
  let input;
  if (spec.type === "embed") {
    input = document.createElement("select");
    for (const path of options.embeds || []) input.append(new Option(path, path));
    input.value = value || (options.embeds || [])[0] || "";
  } else if (spec.type === "enum") {
    input = document.createElement("select");
    for (const option of spec.options) input.append(new Option(spec.labels?.[option] ?? option, option));
    input.value = value;
  } else {
    input = document.createElement("input");
    if (spec.type === "boolean") { input.type = "checkbox"; input.checked = !!value; }
    else if (spec.type === "number") { input.type = "number"; input.min = spec.min; input.max = spec.max; input.step = spec.step ?? "any"; input.value = value; }
    else { input.type = spec.type === "url" ? "url" : "text"; input.maxLength = spec.max ?? 512; input.value = value ?? ""; if (spec.type === "url") input.placeholder = "https://"; }
  }
  input.id = id;
  input.name = key;
  row.append(caption, input);
  if (spec.type === "boolean") row.classList.add("inline");
  return { row, input, read: () => (spec.type === "boolean" ? input.checked : spec.type === "number" ? Number(input.value) : input.value) };
}

export function openForm(_stage, anchor, widget, options, onSubmit) {
  const schema = WIDGET_TYPES[widget.type];
  const form = document.createElement("form");
  form.className = "scene-popup scene-form";
  form.setAttribute("role", "dialog");
  form.setAttribute("aria-label", `${schema.label} widget properties`);
  form.noValidate = true;
  const heading = document.createElement("div");
  heading.className = "scene-popup-title";
  heading.textContent = `${schema.label} properties`;
  form.append(heading);
  const fields = Object.entries(schema.props).map(([key, spec]) => [key, field(key, spec, widget.props?.[key] ?? spec.default, options)]);
  for (const [, item] of fields) form.append(item.row);
  const message = document.createElement("p");
  message.className = "scene-form-status";
  message.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "scene-form-actions";
  const cancel = Object.assign(document.createElement("button"), { type: "button", textContent: "Cancel", className: "action-btn" });
  const save = Object.assign(document.createElement("button"), { type: "submit", textContent: "Save", className: "action-btn primary" });
  actions.append(cancel, save);
  form.append(message, actions);
  cancel.onclick = () => closePopups({ restore: true });
  form.onkeydown = event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePopups({ restore: true }); } };
  form.onsubmit = async event => {
    event.preventDefault();
    const props = Object.fromEntries(fields.map(([key, item]) => [key, item.read()]));
    try { validateWidget({ ...widget, id: widget.id || "draft", props }, options); }
    catch (error) { message.textContent = `Widget not saved: dashboard/scene editor — ${error.reason || error.message}.`; return; }
    save.disabled = true;
    try { await onSubmit(props); closePopups(); }
    catch (error) { message.textContent = error.message; save.disabled = false; }
  };
  open(form, anchor, () => anchor?.focus?.());
  form.querySelector("input, select")?.focus();
  return form;
}
