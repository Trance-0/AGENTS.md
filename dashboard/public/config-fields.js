import { el } from "/api.js";
import { button, field, input, select, toggle } from "/settings-controls.js";

import { helpFor } from "/config-help.js";
import { orderedModels } from "/model-order.js";

const SECRET = "__dashboard_redacted__";
const SECRET_KEY = /(token|secret|password|passwd|apikey|api_key|cookie|credential|privatekey|private_key)$/i;
const NAMES = { dmScope: "Direct-message sessions", groupPolicy: "Group access", dmPolicy: "Direct-message access", primary: "Primary model", fallbacks: "Fallback models", baseUrl: "Service URL", maxConcurrent: "Concurrent runs", contextTokens: "Context window", apiKey: "API key", botToken: "Bot token", default: "Default agent", workspace: "Workspace", enabled: "Enabled", auth: "Authentication", allowFrom: "Allowed senders", thinking: "Reasoning effort", thinkingDefault: "Default reasoning effort" };
const ENUMS = { dmScope: ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"], groupPolicy: ["open", "allowlist", "disabled"], dmPolicy: ["pairing", "allowlist", "open", "disabled"], thinking: ["off", "minimal", "low", "medium", "high", "xhigh"], thinkingDefault: ["off", "minimal", "low", "medium", "high", "xhigh"], reloadMode: ["off", "restart", "hot", "hybrid"] };
export const labelFor = key => NAMES[key] || String(key).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, s => s.toUpperCase());
const hasSecret = value => JSON.stringify(value).includes(SECRET);

// Work on the complete draft; unknown fields remain editable and round-trip intact.
export function renderObject(host, object, changed, { path = "", models = [] } = {}) {
  host.replaceChildren();
  for (const [key, value] of Object.entries(object)) {
    const location = path ? `${path}.${key}` : key;
    const set = next => { object[key] = next; changed(); };
    host.append(valueControl(key, value, set, changed, location, models));
  }
}
function valueControl(key, value, set, changed, path, models) {
  const label = labelFor(key), help = helpFor(key, path, value);
  if (typeof value === "boolean") { const row = el("div", "config-toggle-row"); row.append(toggle(label, value, set), el("small", "field-help", help)); return row; }
  if (value === SECRET || (typeof value === "string" && SECRET_KEY.test(key))) {
    const control = input(value === SECRET ? "" : value, next => set(next || SECRET), "password"); control.placeholder = "Stored securely · leave blank to keep"; control.autocomplete = "new-password";
    return field(label, control, help);
  }
  if (Array.isArray(value)) {
    const wrap = el("section", "config-group");
    wrap.append(el("h3", "", `${label} · ${value.length}`), el("p", "settings-note", help));
    if (key === "fallbacks" && value.every(item => typeof item === "string")) {
      wrap.append(orderedModels(value, (row, item, index) => {
        const control = input(item, next => { value[index] = next; set(value); }); control.setAttribute("list", "openclaw-model-options");
        row.append(field(`Fallback ${index + 1}`, control));
      }, () => set(value)));
      return wrap;
    }
    const list = el("div", "array-items"); wrap.append(list);
    const draw = () => {
      list.replaceChildren();
      value.forEach((item, index) => {
        const row = el("div", "array-item");
        row.append(valueControl(typeof item === "object" && item ? item.name || item.id || `Item ${index + 1}` : `Item ${index + 1}`, item, next => { value[index] = next; set(value); }, changed, `${path}.${index}`, models));
        // Masked credentials are restored by their original path; do not shift them.
        if (!hasSecret(value)) row.append(button("Remove", () => { value.splice(index, 1); set(value); draw(); }));
        list.append(row);
      });
    };
    draw();
    wrap.append(button("Add item", () => { value.push(value.length && typeof value[0] === "object" ? {} : ""); set(value); draw(); }));
    return wrap;
  }
  if (value && typeof value === "object") {
    const details = el("section", "config-group");
    details.append(el("h3", "", label), el("p", "settings-note", help)); const fields = el("div", "config-children"); renderObject(fields, value, changed, { path, models }); details.append(fields);
    const add = el("div", "add-setting"); let name = "", type = "string";
    const keyInput = input("", v => { name = v; }); keyInput.placeholder = "New setting name"; keyInput.setAttribute("aria-label", `${label}: new setting name`);
    const typeInput = select(type, ["string", "number", "boolean", "object", "list"], v => { type = v; }); typeInput.setAttribute("aria-label", `${label}: new setting type`);
    add.append(keyInput, typeInput, button("Add", () => {
      if (!name.trim() || Object.hasOwn(value, name) || ["__proto__", "constructor", "prototype"].includes(name)) { keyInput.setCustomValidity("Setting cannot be added: dashboard/config editor — enter a new, unique setting name."); keyInput.reportValidity(); return; }
      keyInput.setCustomValidity(""); value[name] = { string: "", number: 0, boolean: false, object: {}, list: [] }[type]; set(value); renderObject(fields, value, changed, { path, models }); keyInput.value = ""; name = "";
    })); details.append(add); return details;
  }
  if (key === "thinking" && path === "agents.defaults.models.vllm/nvidia/Qwen3.8-27B-NVFP4.params.thinking") return field(label, select(value, ["low", "medium", "xhigh"], set), help);
  if (ENUMS[key]) return field(label, select(value, ENUMS[key], set), help);
  const control = input(value ?? "", set, typeof value === "number" ? "number" : "text");
  if (typeof value === "number") control.step = "any";
  if (key === "model" || key === "primary" || /fallbacks\.\d+$/.test(path)) control.setAttribute("list", "openclaw-model-options");
  return field(label, control, value === null ? "Currently unset. JSON view supports explicit null values." : help);
}
