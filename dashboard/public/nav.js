// Sidebar groups and tabbed group pages.
//
// The server registry describes every panel's `group`, `order`, and `tabs`
// (GET /api/panels -> { panels, groups }); this module only lays them out.
// Each group is one page; each tab belongs to exactly one panel, so the
// per-panel soft toggle, admin-only gate, and data routes stay unchanged.
import { $, api, el, esc } from "/api.js";
import { renderUsage, renderQuota } from "/metrics.js";
import { renderConfigEditor } from "/config-editor.js";
import { renderSummary } from "/usage-summary.js";
import { renderSettings } from "/settings-page.js";
import { sceneSettingsSection } from "/scene/settings-section.js";

export const ICONS = {
  stream: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 9l5 3-5 3z"/>',
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M2 13v2M22 13v2"/>',
  build: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gauge: '<path d="M3.5 17a9 9 0 1 1 17 0"/><path d="M12 13l4-5"/><circle cx="12" cy="13" r="1.5"/>',
  quota: '<rect x="3" y="6" width="16" height="12" rx="2"/><path d="M21 10v4M7 10v4M11 10v4"/>',
  config: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M10 13l-2 2 2 2M14 13l2 2-2 2"/>',
  claw: '<path d="M6 3c-1 4 0 8 4 10M12 3c-.5 4 .5 8 3 10M18 4c0 4-1 7-3 9M7 21c1-4 4-7 8-8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
};

const GROUP_BLURBS = {
  openclaw: "Gateway health, agents and model fallbacks, model backends, and the live config.",
  usage: "Codex quota and token usage. The summary pools accounts; the CPA tab keeps them separate.",
  adapters: "Chat-platform adapters that relay into OpenClaw.",
  builds: "Pipeline build status and last-known-good tag.",
  settings: "Preferences for this browser, and dashboard administration.",
};

export function createNavigator(ctx) {
  const { state } = ctx;
  let current = null; // { group, tab }

  // Tabs for a group, in registry order, each tagged with its owning panel.
  const tabsFor = groupId => state.panels
    .filter(panel => panel.group === groupId)
    .flatMap(panel => (panel.tabs || [{ id: panel.id, title: panel.title }]).map(tab => ({ ...tab, panel })));

  function renderSidebar() {
    const nav = $("#panel-nav");
    nav.replaceChildren();
    for (const group of state.groups) {
      if (group.id === "live") continue;
      const panels = state.panels.filter(panel => panel.group === group.id);
      const off = panels.length > 0 && panels.every(panel => !panel.enabled);
      const a = el("a", "nav-item");
      a.dataset.view = group.id;
      a.href = `#${group.id}`;
      a.title = off ? `${group.title} (disabled)` : group.title;
      a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[group.icon] || ICONS.panel}</svg><span>${esc(group.title)}</span>${off ? '<span class="dot">off</span>' : ""}`;
      a.addEventListener("click", event => { event.preventDefault(); showGroup(group.id); });
      nav.appendChild(a);
    }
    setActiveNav(current?.group || (ctx.isLiveVisible() ? "live" : null));
  }

  function setActiveNav(viewId) {
    document.querySelectorAll(".nav-item").forEach(item => {
      const active = item.dataset.view === viewId;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
    });
  }

  // Resolves "#group", "#group/tab", and legacy "#panel-id" links.
  function resolve(hash) {
    const [first, second] = String(hash || "").replace(/^#/, "").split("/");
    if (!first || first === "live" || first === "live-stream") return { group: "live" };
    if (state.groups.some(group => group.id === first)) {
      const tabs = tabsFor(first);
      return { group: first, tab: (tabs.find(tab => tab.id === second) || tabs[0])?.id };
    }
    const panel = state.panels.find(item => item.id === first);
    if (panel) return { group: panel.group, tab: (panel.tabs || [])[0]?.id || panel.id };
    return null;
  }

  function showGroup(groupId, tabId, { updateHash = true } = {}) {
    if (groupId === "live") { current = null; ctx.showLive(); return; }
    const group = state.groups.find(item => item.id === groupId);
    const tabs = tabsFor(groupId);
    if (!group || !tabs.length) return;
    const tab = tabs.find(item => item.id === tabId) || tabs.find(item => item.id === current?.tab && current?.group === groupId) || tabs[0];
    current = { group: groupId, tab: tab.id };
    setActiveNav(groupId);
    ctx.closeMobileSidebar();
    $("#view-live-stream").classList.add("hidden");
    $("#view-panel").classList.remove("hidden");
    if (updateHash) history.replaceState(null, "", tabs.length > 1 ? `#${groupId}/${tab.id}` : `#${groupId}`);
    renderGroup(group, tabs, tab);
  }

  function renderGroup(group, tabs, active) {
    const view = $("#view-panel");
    view.className = "view panel-view group-page";
    const header = el("div", "panel-header");
    const titles = el("div");
    titles.append(el("h1", "", group.title), el("p", "", GROUP_BLURBS[group.id] || active.panel.description || ""));
    header.append(titles);
    view.replaceChildren(header);
    if (tabs.length > 1) view.append(tabBar(group, tabs, active));
    const pane = el("div", "tab-pane");
    pane.id = `tab-${active.id}`;
    pane.setAttribute("role", tabs.length > 1 ? "tabpanel" : "region");
    pane.setAttribute("aria-label", active.title);
    if (tabs.length > 1) pane.setAttribute("aria-labelledby", `tabbtn-${active.id}`);
    view.append(pane);
    renderTab(pane, active).catch(error => ctx.report(error));
  }

  function tabBar(group, tabs, active) {
    const bar = el("div", "tabs");
    bar.setAttribute("role", "tablist");
    bar.setAttribute("aria-label", `${group.title} sections`);
    for (const tab of tabs) {
      const button = el("button", "tab", tab.title);
      button.type = "button";
      button.id = `tabbtn-${tab.id}`;
      button.dataset.tab = tab.id;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(tab.id === active.id));
      button.setAttribute("aria-controls", `tab-${tab.id}`);
      button.tabIndex = tab.id === active.id ? 0 : -1;
      if (!tab.panel.enabled) button.append(el("span", "dot", "off"));
      button.onclick = () => showGroup(group.id, tab.id);
      bar.append(button);
    }
    bar.onkeydown = event => {
      const index = tabs.findIndex(tab => tab.id === active.id);
      const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const tab = tabs[(next + tabs.length) % tabs.length];
      showGroup(group.id, tab.id);
      $(`#tabbtn-${tab.id}`)?.focus();
    };
    return bar;
  }

  async function renderTab(pane, tab) {
    const { panel } = tab;
    if (state.user?.isAdmin && panel.id !== "live-stream" && panel.id !== "settings") pane.append(adminBar(panel, tab));
    // Admins keep the Settings page even when it is disabled for members, so
    // the panel switches there stay reachable.
    if (!panel.enabled && !(panel.id === "settings" && state.user?.isAdmin)) {
      pane.append(el("p", "panel-disabled", "This panel is disabled. Its data and actions are switched off until an administrator enables it again."));
      return;
    }
    const first = (panel.tabs || [])[0]?.id || panel.id;
    const custom = TAB_RENDERERS[tab.id];
    if (tab.id === first && custom?.cards !== false) {
      pane.append(statusCards(panel));
      const rows = readOnlyRows(panel);
      if (rows) pane.append(rows);
    }
    if (!custom) return;
    // Renderers own their container (some replace its children on reload).
    const body = el("div", "tab-body");
    pane.append(body);
    return custom.render(body, { api, state, panel, ctx: { ...ctx, renderSidebar } });
  }

  // Admin-only switch for the panel that owns this tab. Uses the admin session
  // plus the same-origin header (ctx.setPanelEnabled), like other admin mutations.
  function adminBar(panel, tab) {
    const box = el("div", "panel-admin");
    const label = el("label", "switch");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.id = "panel-enabled";
    toggle.setAttribute("role", "switch");
    toggle.checked = panel.enabled;
    const shared = (panel.tabs || []).length > 1 ? ` (${panel.tabs.map(item => item.title).join(", ")})` : "";
    label.append(toggle, el("span", "switch-track"), el("span", "", ` Panel enabled${shared}`));
    const status = el("span", "hint", panel.enabled ? "Visible to signed-in members." : "Hidden from members; data and actions are off.");
    status.setAttribute("role", "status");
    if (panel.adminOnly) box.append(el("span", "badge", "Admins only"));
    toggle.onchange = async () => {
      toggle.disabled = true;
      status.textContent = "Saving…";
      try {
        await ctx.setPanelEnabled(panel.id, toggle.checked);
        renderSidebar();
        showGroup(current.group, tab.id, { updateHash: false });
      } catch (error) {
        toggle.checked = panel.enabled;
        status.textContent = error.message;
        toggle.disabled = false;
      }
    };
    box.prepend(label);
    box.append(status);
    return box;
  }

  return { renderSidebar, showGroup, resolve, setActiveNav, current: () => current };
}

function statusCards(panel) {
  const cards = el("div", "cards");
  for (const item of panel.status || []) {
    const card = el("div", "card");
    card.append(el("div", "label", item.label), el("div", `value tone-${item.tone || "neutral"}`, String(item.value)));
    cards.append(card);
  }
  return cards;
}

// Deployment configuration rows: shown read-only, because they come from the
// private environment and cannot be changed from the browser.
function readOnlyRows(panel) {
  const settings = (panel.settings || []).filter(item => item.scope !== "browser");
  if (!settings.length) return null;
  const box = el("section", "settings-card");
  box.append(el("h2", "", "Deployment"));
  const list = el("div", "settings-list");
  for (const item of settings) {
    const row = el("div", "setting-row");
    row.append(el("label", "", item.label));
    const value = el("output", "setting-value", String(item.value ?? ""));
    value.setAttribute("aria-label", `${item.label} (read-only)`);
    row.append(value);
    list.append(row);
  }
  box.append(list, el("p", "settings-note", "Configuration shown read-only; it is set in the deployment environment."));
  return box;
}

function table(headers, rows) {
  const wrap = el("div", "table-scroll");
  const tableEl = el("table", "data-table");
  const head = el("tr");
  for (const header of headers) head.append(el("th", "", header));
  const thead = el("thead"); thead.append(head);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const [value, className] of row) tr.append(el("td", className || "", value));
    tbody.append(tr);
  }
  tableEl.append(thead, tbody);
  wrap.append(tableEl);
  return wrap;
}

const panelData = (panel, apiFn) => apiFn(`/api/panels/${encodeURIComponent(panel.id)}/data`);

// Tab-specific bodies, keyed by tab ID. Tabs without an entry show the owning
// panel's status cards and read-only deployment rows only.
const TAB_RENDERERS = {
  "openclaw-status": {
    async render(pane, { api: apiFn, panel }) {
      const box = el("section", "settings-card");
      box.append(el("h2", "", "Agents and model fallback chain"));
      pane.append(box);
      const data = await panelData(panel, apiFn);
      if (!data.available) { box.append(el("p", "settings-note", data.reason)); return; }
      const chain = model => model ? [model.primary || "(none)", ...model.fallbacks].join(" → ") : "not configured";
      box.append(table(["Agent", "Name", "Model order (primary → fallbacks)"], data.agents.map(agent => [[agent.id, "mono"], [agent.name], [chain(agent.model) + (agent.inheritsDefault ? " (default)" : ""), "mono"]])));
      if (data.defaults) box.append(el("p", "settings-note", `Default for agents without their own model: ${chain(data.defaults)}.`));
    },
  },
  "openclaw-backends": {
    async render(pane, { api: apiFn, panel }) {
      const box = el("section", "settings-card");
      box.append(el("h2", "", "Model backends"));
      box.append(el("p", "settings-note", "Provider names and the environment variable each reads. Key values never leave the private environment."));
      pane.append(box);
      const data = await panelData(panel, apiFn);
      box.append(table(["Provider", "Env var", "Note"], (data.providers || []).map(item => [[item.provider, "mono"], [item.env, "mono"], [item.note || ""]])));
    },
  },
  "openclaw-config": { render: (pane, { state }) => renderConfigEditor(pane, !!state.user?.isAdmin) },
  "usage-summary": { cards: false, render: (pane, { api: apiFn }) => renderSummary(pane, apiFn) },
  "cpa-quota": { cards: false, render: (pane, { api: apiFn }) => renderQuota(pane, apiFn) },
  "usage-metrics": { cards: false, render: (pane, { api: apiFn }) => renderUsage(pane, apiFn) },
  settings: { cards: false, render: (pane, { state, ctx }) => renderSettings(pane, { state, setPanelEnabled: ctx.setPanelEnabled, onPanelsChanged: ctx.renderSidebar, extraAdminSections: [() => sceneSettingsSection(api)] }) },
};
