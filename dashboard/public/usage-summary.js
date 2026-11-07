// Usage > Summary: pooled Codex quota for both windows with reset countdowns,
// plus token totals. Pooling matches the public scene metric widget; the CPA
// quota tab keeps the per-account view.
import { el } from "/api.js";
import { formatCountdown, formatTokens, formatAge } from "/scene/format.js";

const number = value => new Intl.NumberFormat().format(value || 0);

export async function renderSummary(body, api) {
  body.replaceChildren();
  const root = el("div", "summary-view");
  const status = el("p", "metrics-status", "Loading usage summary…");
  status.setAttribute("role", "status");
  const quota = el("div", "summary-grid");
  const tokens = el("div", "cards summary-tokens");
  const quotaBox = el("section", "settings-card");
  quotaBox.append(el("h2", "", "Codex quota (all accounts pooled)"), quota);
  const tokenBox = el("section", "settings-card");
  tokenBox.append(el("h2", "", "Tokens"), tokens);
  root.append(status, quotaBox, tokenBox);
  body.append(root);
  let data;
  const draw = () => {
    if (!data) return;
    quota.replaceChildren();
    if (!data.codex) {
      quota.append(el("p", "settings-note", data.cpa.enabled ? "No quota snapshot yet." : "The CPA quota panel is disabled, so pooled quota is hidden."));
    } else {
      for (const [key, title, withDays] of [["fiveHour", "5-hour window", false], ["week", "Weekly window", true]]) {
        const window = data.codex[key];
        const card = el("article", "summary-quota");
        card.dataset.window = key;
        const value = window.remainingPercent;
        card.append(el("div", "label", title), el("div", `value ${value === 0 ? "tone-error" : value !== null && value < 20 ? "tone-warn" : ""}`, value === null ? "Unknown" : `${value}% remaining`));
        if (value !== null) {
          const meter = document.createElement("meter");
          meter.min = 0; meter.max = 100; meter.low = 10; meter.high = 50; meter.optimum = 100; meter.value = value;
          meter.setAttribute("aria-label", `${title} pooled remaining`);
          card.append(meter);
        }
        const reset = window.resetAt ? formatCountdown(window.resetAt - Date.now(), withDays) : null;
        card.append(el("p", "summary-reset", reset ? `Next reset in ${reset}` : "Next reset unknown"));
        card.append(el("p", "settings-note", `${window.accounts} of ${window.total} accounts`));
        quota.append(card);
      }
      const age = data.codex.updatedAt ? formatAge(Date.now() - data.codex.updatedAt) : null;
      quota.append(el("p", "settings-note summary-age", age ? `Snapshot taken ${age} ago. Refresh it from the CPA quota tab.` : "No quota snapshot yet. Save the CPA connection and refresh from the CPA quota tab."));
    }
    tokens.replaceChildren();
    for (const [label, value] of [["Today (UTC)", data.tokens.today], ["Last 7 days", data.tokens.week], ["Last 30 days", data.tokens.month]]) {
      const card = el("div", "card");
      const shown = el("div", "value", formatTokens(value));
      shown.title = `${number(value)} tokens`;
      card.append(el("div", "label", label), shown);
      tokens.append(card);
    }
  };
  const load = async () => {
    try {
      data = await api("/api/admin/metrics/summary");
      status.textContent = data.note;
      status.classList.remove("tone-error");
      draw();
    } catch (error) { status.textContent = error.message; status.classList.add("tone-error"); }
  };
  await load();
  // Countdowns tick every 30 s; data reloads every minute while visible.
  let ticks = 0;
  const timer = setInterval(() => {
    if (!root.isConnected) return clearInterval(timer);
    if (document.hidden) return;
    if (++ticks % 2 === 0) load(); else draw();
  }, 30000);
}
