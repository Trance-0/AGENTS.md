// Usage > Subscriptions: Bark push alarms for Codex quota and CliProxy reset
// events. Device keys stay in the browser only long enough to be saved; the
// server returns stable ids, never the keys. See server/metrics/subscription-*.
import { el } from "/api.js";

const TYPE_IDS = ["depleted", "newCredits", "pool5h", "resetArrived", "resetRequested"];
const TYPE_LABELS = {
  depleted: "Codex account depleted",
  newCredits: "Codex new credits arrived",
  pool5h: "5-hour pool status",
  resetArrived: "Reset arrived",
  resetRequested: "Reset requested",
};
const RESET_LABELS = { ticked: "Reset ticked", requested: "Reset requested", arrivedAt: "Reset arrived at", expiresAt: "Reset expires at" };

function input(type = "text") { return Object.assign(document.createElement("input"), { type }); }
function password() { const node = input("password"); node.autocomplete = "new-password"; return node; }
function row(...children) { const box = el("div", "setting-row"); box.append(...children); return box; }
function statusLine() { const node = el("p", "metrics-status"); node.setAttribute("role", "status"); return node; }

export async function renderSubscription(body, api) {
  body.replaceChildren();
  const root = el("div", "metrics-view");
  const status = statusLine(); status.textContent = "Loading subscriptions…";

  // --- Devices ---
  const devicesBox = el("section", "metrics-section");
  devicesBox.append(el("h2", "", "Bark devices"), el("p", "metrics-muted", "Paste each device's Bark key (from the Bark app). Keys are stored encrypted and never shown again; leave a key blank to keep the saved one."));
  const deviceList = el("div", "subscription-devices");
  devicesBox.append(deviceList);
  const addDevice = el("button", "btn", "Add device");
  devicesBox.append(addDevice);

  // --- Alarms ---
  const alarmsBox = el("section", "metrics-section");
  alarmsBox.append(el("h2", "", "Alarms"), el("p", "metrics-muted", "Tick an alarm to subscribe. Message placeholders: <account>, <provider>, <reset>, <expire>, <pool5h>, <week>, <accounts>, <time>."));
  const alarmList = el("div", "subscription-alarms");
  alarmsBox.append(alarmList);

  // --- Reset field mapping ---
  const resetBox = el("section", "metrics-section");
  resetBox.append(el("h2", "", "Reset field mapping"), el("p", "metrics-muted", "Field names are detected from the CPA auth files. Override one only when a reset alarm misreads an account."));
  const resetList = el("div", "subscription-reset");
  resetBox.append(resetList);

  // --- Presentation ---
  const presBox = el("section", "metrics-section");
  presBox.append(el("h2", "", "Presentation"));
  const level = el("select", undefined);
  for (const value of ["passive", "active", "timeSensitive", "critical"]) level.append(new Option(value, value));
  const group = input("text"); group.placeholder = "agent-dashboard";
  presBox.append(row(el("label", "field-label", "Bark level"), level), row(el("label", "field-label", "Bark group"), group));

  const actions = el("div", "task-toolbar");
  const save = el("button", "action-btn", "Save subscriptions");
  const test = el("button", "action-btn", "Send test push");
  actions.append(save, test);

  root.append(status, devicesBox, alarmsBox, resetBox, presBox, actions);
  body.append(root);

  const deviceRows = [];
  const alarmRows = new Map();
  const resetInputs = new Map();

  function addDeviceRow(device = {}) {
    const label = input("text"); label.placeholder = "Device name"; label.value = device.label || "";
    const key = password(); key.placeholder = device.id ? "Leave blank to keep key" : "Bark device key";
    const enabled = input("checkbox"); enabled.checked = device.enabled !== false; enabled.setAttribute("role", "switch");
    const remove = el("button", "btn", "Remove");
    const toggle = el("label", "preference-toggle"); toggle.append(el("span", "field-label", "On"), enabled);
    const wrap = el("div", "subscription-device");
    wrap.append(row(el("label", "field-label", "Name"), label), row(el("label", "field-label", "Key"), key), toggle, remove);
    const entry = { id: device.id || "", label, key, enabled, remove, wrap };
    remove.onclick = () => { wrap.remove(); deviceRows.splice(deviceRows.indexOf(entry), 1); };
    deviceRows.push(entry);
    deviceList.append(wrap);
  }

  function addAlarmRow(id) {
    const enabled = input("checkbox"); enabled.setAttribute("role", "switch");
    const title = input("text"); title.placeholder = "Notification title";
    const message = input("text"); message.placeholder = "Notification message";
    const box = el("div", "subscription-alarm");
    const toggle = el("label", "preference-toggle"); toggle.append(el("span", "field-label", TYPE_LABELS[id]), enabled);
    box.append(toggle, row(el("label", "field-label", "Title"), title), row(el("label", "field-label", "Message"), message));
    alarmRows.set(id, { enabled, title, message });
    alarmList.append(box);
  }
  for (const id of TYPE_IDS) addAlarmRow(id);

  function addResetRow(concept) {
    const override = input("text"); override.placeholder = "auto-detect";
    const hint = el("span", "field-help", "detected: —");
    resetInputs.set(concept, { override, hint });
    resetList.append(row(el("label", "field-label", RESET_LABELS[concept]), override, hint));
  }
  for (const concept of ["ticked", "requested", "arrivedAt", "expiresAt"]) addResetRow(concept);

  addDevice.onclick = () => addDeviceRow();

  function draw(data) {
    level.value = data.level || "passive";
    group.value = data.group || "agent-dashboard";
    deviceRows.forEach(entry => entry.wrap.remove()); deviceRows.length = 0;
    for (const device of data.devices) addDeviceRow(device);
    if (!data.devices.length) addDeviceRow();
    for (const [id, row] of alarmRows) {
      const config = data.types[id] || { enabled: false, title: "", body: "" };
      row.enabled.checked = config.enabled === true;
      row.title.value = config.title || "";
      row.message.value = config.body || "";
    }
    for (const [concept, entry] of resetInputs) {
      entry.override.value = data.resetFields?.[concept] || "";
      entry.hint.textContent = `detected: ${data.detectedResetFields?.[concept] || "—"}`;
    }
  }

  function payload() {
    return {
      devices: deviceRows.map(entry => ({ id: entry.id, label: entry.label.value.trim(), enabled: entry.enabled.checked, key: entry.key.value.trim() })),
      types: Object.fromEntries([...alarmRows].map(([id, row]) => [id, { enabled: row.enabled.checked, title: row.title.value.trim(), body: row.message.value.trim() }])),
      resetFields: Object.fromEntries([...resetInputs].map(([concept, entry]) => [concept, entry.override.value.trim()])),
      level: level.value,
      group: group.value.trim(),
    };
  }

  function showDelivery(data) {
    const s = data.status || {};
    const parts = [];
    if (s.lastRunAt) parts.push(`Last check ${new Date(s.lastRunAt).toLocaleString()}.`);
    if (s.lastDelivery?.length) {
      const ok = s.lastDelivery.filter(d => d.ok).length;
      parts.push(`Last push: ${ok}/${s.lastDelivery.length} delivered (${s.lastDelivery.map(d => d.key).join(", ")}).`);
    }
    status.textContent = data.note + (parts.length ? ` ${parts.join(" ")}` : "");
  }

  async function load() {
    const data = await api("/api/admin/subscription");
    draw(data);
    showDelivery(data);
    return data;
  }

  save.onclick = async () => {
    save.disabled = true; status.textContent = "Saving…";
    try { const data = await api("/api/admin/subscription", { method: "PUT", body: JSON.stringify(payload()) }); draw(data); showDelivery(data); }
    catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  };

  test.onclick = async () => {
    test.disabled = true; status.textContent = "Sending test push…";
    try { const result = await api("/api/admin/subscription/test", { method: "POST", body: "{}" }); status.textContent = `Test push sent to ${result.sent.length} device${result.sent.length === 1 ? "" : "s"}.`; }
    catch (error) { status.textContent = error.message; }
    finally { test.disabled = false; }
  };

  try { await load(); } catch (error) { status.textContent = error.message; }
}
