// Settings page: real per-browser preferences plus, for administrators, the
// panel switches for every panel in one list. Preferences live in
// localStorage only and are never sent to the server.
import { el } from "/api.js";
import { PLAYBACK_RATES, formatRate, readAutoplay, storeAutoplay, readStoredRate } from "/player.js";

const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" };
const MOTION_LABELS = { system: "System", reduce: "Reduce", full: "Full" };
const GROUP_TITLES = { live: "Live", openclaw: "OpenClaw", usage: "Usage", adapters: "Adapters", builds: "Builds", settings: "Settings" };

export function renderSettings(body, { state, setPanelEnabled, onPanelsChanged, extraAdminSections = [] }) {
  body.replaceChildren();
  const page = el("div", "settings-page");
  const settingsPanel = state.panels.find(panel => panel.id === "settings");
  if (settingsPanel && !settingsPanel.enabled) page.append(el("p", "panel-disabled", "The Settings panel is disabled for members. Administrators keep access so they can switch panels back on."));

  const appearance = card("Appearance", "Applies to this browser immediately.");
  appearance.list.append(
    row("Theme", "System follows your device's light or dark setting.", segmented("setting-theme", THEME_LABELS, globalThis.dashboardTheme?.read() ?? "system", value => globalThis.dashboardTheme?.set(value))),
    row("Motion", "Reduce turns off animated transitions, the avatar's breathing bob, and the cat's paw drumming. System follows your device setting.", segmented("setting-motion", MOTION_LABELS, globalThis.dashboardMotion?.read() ?? "system", value => globalThis.dashboardMotion?.set(value))),
  );

  const playback = card("Playback", "Used when you open a recording or rewind a live stream.");
  const autoplay = toggle("setting-autoplay", readAutoplay(), value => storeAutoplay(value));
  const speed = document.createElement("select");
  speed.id = "setting-speed";
  for (const rate of PLAYBACK_RATES) speed.append(new Option(rate === 1 ? "Normal (1x)" : formatRate(rate), String(rate)));
  speed.value = String(readStoredRate());
  speed.onchange = () => dispatchEvent(new CustomEvent("dashboard-playback-rate", { detail: { rate: Number(speed.value) } }));
  playback.list.append(
    row("Autoplay recordings", "Start replay when you open a recording. Live streams always follow the live edge.", autoplay, "setting-autoplay"),
    row("Playback speed", "Replay speed for recordings. The player's speed menu changes the same setting; live viewing is always 1x.", speed, "setting-speed"),
  );
  page.append(appearance.box, playback.box);
  page.append(el("p", "settings-note", "Saved in this browser only; other devices keep their own preferences."));

  if (state.user?.isAdmin) {
    page.append(panelSwitches(state, setPanelEnabled, onPanelsChanged));
    for (const section of extraAdminSections) page.append(section());
  }
  body.append(page);

  // Keep the controls in sync with the top-bar theme button and other tabs.
  const sync = () => {
    for (const input of page.querySelectorAll('input[name="setting-theme"]')) input.checked = input.value === globalThis.dashboardTheme?.read();
    for (const input of page.querySelectorAll('input[name="setting-motion"]')) input.checked = input.value === globalThis.dashboardMotion?.read();
    speed.value = String(readStoredRate());
  };
  const stop = () => { removeEventListener("dashboard-theme", listener); removeEventListener("dashboard-playback-rate-changed", listener); removeEventListener("storage", listener); };
  const listener = () => (page.isConnected ? sync() : stop());
  addEventListener("dashboard-theme", listener);
  addEventListener("dashboard-playback-rate-changed", listener);
  addEventListener("storage", listener);
}

function card(title, note) {
  const box = el("section", "settings-card");
  box.append(el("h2", "", title));
  if (note) box.append(el("p", "settings-card-note", note));
  const list = el("div", "settings-list");
  box.append(list);
  return { box, list };
}

function row(label, help, control, forId) {
  const item = el("div", "setting-row");
  const text = el(forId ? "label" : "div", "setting-text");
  if (forId) text.htmlFor = forId;
  text.append(el("span", "setting-label", label));
  if (help) text.append(el("small", "setting-help", help));
  item.append(text, control);
  return item;
}

// Radio group styled as a segmented control; arrow keys move between options natively.
function segmented(name, labels, value, onChange) {
  const group = el("div", "segmented");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", name.replace("setting-", ""));
  for (const [option, text] of Object.entries(labels)) {
    const id = `${name}-${option}`;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.id = id;
    input.value = option;
    input.checked = option === value;
    input.onchange = () => { if (input.checked) onChange(option); };
    const label = el("label", "", text);
    label.htmlFor = id;
    group.append(input, label);
  }
  return group;
}

function toggle(id, checked, onChange) {
  const label = el("label", "switch");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.setAttribute("role", "switch");
  input.checked = checked;
  input.onchange = () => onChange(input.checked);
  label.append(input, el("span", "switch-track"));
  return label;
}

// Every panel with its soft toggle, grouped as in the sidebar. Uses the same
// admin mutation as the per-tab switch (session + same-origin header).
function panelSwitches(state, setPanelEnabled, onPanelsChanged) {
  const section = card("Panels", "Administrators only. A disabled panel is hidden from members and its data routes and actions are switched off; admins still see it with an \"off\" badge.");
  section.box.classList.add("admin-card");
  section.box.id = "panel-switches";
  const render = () => {
    section.list.replaceChildren();
    const groupOrder = id => { const index = (state.groups || []).findIndex(group => group.id === id); return index < 0 ? 99 : index; };
    for (const panel of [...state.panels].sort((a, b) => groupOrder(a.group) - groupOrder(b.group) || a.order - b.order)) {
      const tabs = (panel.tabs || []).map(tab => tab.title).join(", ");
      const id = `panel-switch-${panel.id}`;
      const control = toggle(id, panel.enabled, async enabled => {
        input.disabled = true;
        status.textContent = "Saving…";
        try {
          await setPanelEnabled(panel.id, enabled);
          onPanelsChanged?.();
          render();
        } catch (error) {
          input.checked = panel.enabled;
          input.disabled = false;
          status.textContent = error.message;
        }
      });
      const input = control.querySelector("input");
      const status = el("small", "setting-help");
      status.setAttribute("role", "status");
      if (panel.id === "live-stream") { input.disabled = true; status.textContent = "Always on: the player cannot be disabled."; }
      const item = row(`${GROUP_TITLES[panel.group] || panel.group} · ${panel.title}`, tabs && tabs !== panel.title ? `Tabs: ${tabs}` : "", control, id);
      item.dataset.panel = panel.id;
      item.querySelector(".setting-text").append(status);
      if (panel.adminOnly) item.querySelector(".setting-label").append(el("span", "badge", "Admins only"));
      section.list.append(item);
    }
  };
  render();
  return section.box;
}
