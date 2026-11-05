import { node, number, money, trendChart, breakdownTable } from "/metrics-charts.js";

function status(box, text, error = false) { box.textContent = text; box.classList.toggle("tone-error", error); }
function control(label, input) { const wrapper = node("label", undefined, "metrics-control"); input.setAttribute("aria-label", label); wrapper.append(node("span", label), input); return wrapper; }
function select(options) { const el = node("select"); for (const [value, text] of options) { const option = node("option", text); option.value = value; el.append(option); } return el; }
function section(title) { const box = node("section", undefined, "metrics-section"); box.append(node("h2", title)); return box; }

export async function renderUsage(body, api) {
  body.replaceChildren();
  const root = node("div", undefined, "metrics-view"); body.append(root);
  const bar = node("div", undefined, "metrics-toolbar");
  const range = select([[1, "Last 24 hours"], [7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"]]); range.value = "7";
  const route = select([["", "All routes"]]); const model = select([["", "All models"]]);
  const mode = select([["tokens", "Tokens"], ["cost", "Price (USD)"]]);
  const refresh = node("button", "Refresh", "btn");
  bar.append(control("Period", range), control("Route", route), control("Model", model), control("View", mode), refresh);
  const message = node("p", "Loading usage…", "metrics-status"); message.setAttribute("role", "status");
  const cards = node("div", undefined, "cards metrics-cards");
  const trend = section("Usage over time"); const graph = node("div"); trend.append(graph);
  const decomposition = section("Breakdown"); const grouping = select([["route", "By route"], ["model", "By model"]]);
  const table = node("div", undefined, "metrics-table-scroll"); decomposition.append(control("Group", grouping), table);
  const pricing = section("Model prices");
  pricing.append(node("p", "USD per million tokens. Set your actual route rates; zero is allowed when explicitly configured. Updating a rate recalculates estimates for stored usage.", "metrics-muted"));
  const priceForm = node("form", undefined, "metrics-pricing");
  const priceRoute = node("input"); priceRoute.required = true; priceRoute.placeholder = "cpa";
  const priceModel = node("input"); priceModel.required = true; priceModel.placeholder = "claude-opus-4-6-thinking";
  priceForm.append(control("Route", priceRoute), control("Model", priceModel));
  const rates = {};
  for (const [key, label] of [["input", "Input"], ["output", "Output"], ["cacheRead", "Cache read"], ["cacheWrite", "Cache write"]]) {
    const input = node("input"); input.type = "number"; input.min = "0"; input.max = "100000"; input.step = "any"; input.required = true;
    rates[key] = input; priceForm.append(control(label, input));
  }
  const save = node("button", "Save price", "btn"); save.type = "submit"; priceForm.append(save);
  const priceMessage = node("p", "", "metrics-status"); priceMessage.setAttribute("role", "status");
  const priceList = node("div", undefined, "metrics-price-list"); pricing.append(priceForm, priceMessage, priceList);
  root.append(bar, message, cards, trend, decomposition, pricing);
  let report, sequence = 0;
  const draw = () => {
    if (!report) return;
    cards.replaceChildren();
    for (const [label, value] of [["Tokens", number(report.summary.tokens)], ["Known cost subtotal", money(report.summary.costUsd)], ["Metered attempts", number(report.summary.attempts)], ["Unpriced attempts", number(report.summary.unpriced)]]) {
      const card = node("div", undefined, "card"); card.append(node("div", label, "label"), node("div", value, "value")); cards.append(card);
    }
    trendChart(graph, report, mode.value);
    breakdownTable(table, grouping.value === "route" ? report.routes : report.models, grouping.value, mode.value);
  };
  async function load() {
    const ticket = ++sequence; refresh.disabled = true;
    try {
      const data = await api(`/api/admin/metrics/usage?${new URLSearchParams({ days: range.value, route: route.value, model: model.value })}`);
      if (ticket !== sequence || !root.isConnected) return;
      report = data;
      const selectedRoute = route.value, selectedModel = model.value;
      route.replaceChildren(...select([["", "All routes"], ...[...new Set(data.filters.map(row => row.route))].sort().map(value => [value, value])]).children); route.value = selectedRoute;
      const models = [...new Set(data.filters.filter(row => !selectedRoute || row.route === selectedRoute).map(row => row.model))].sort();
      model.replaceChildren(...select([["", "All models"], ...models.map(value => [value, value])]).children); model.value = models.includes(selectedModel) ? selectedModel : "";
      status(message, `${data.note}${data.firstEventAt ? ` Collection began ${new Date(data.firstEventAt).toLocaleString()}.` : " Collection starts when the OpenClaw plugin records its next model attempt."}`);
      priceList.replaceChildren();
      for (const price of data.prices) {
        const button = node("button", `${price.route} / ${price.model} — edit rates`, "btn");
        button.onclick = () => { priceRoute.value = price.route; priceModel.value = price.model; for (const key of Object.keys(rates)) rates[key].value = price[key]; };
        priceList.append(button);
      }
      draw();
    } catch (error) { if (ticket === sequence) status(message, error.message, true); }
    finally { if (ticket === sequence) refresh.disabled = false; }
  }
  range.onchange = load; route.onchange = () => { model.value = ""; load(); }; model.onchange = load; refresh.onclick = load;
  mode.onchange = draw; grouping.onchange = draw;
  priceForm.onsubmit = async event => {
    event.preventDefault(); save.disabled = true;
    try {
      await api("/api/admin/metrics/pricing", { method: "PUT", body: JSON.stringify({ route: priceRoute.value.trim(), model: priceModel.value.trim(), ...Object.fromEntries(Object.entries(rates).map(([key, input]) => [key, Number(input.value)])) }) });
      status(priceMessage, "Price saved; usage estimates updated."); await load();
    } catch (error) { status(priceMessage, error.message, true); }
    finally { save.disabled = false; }
  };
  await load();
  const timer = setInterval(() => { if (!root.isConnected) clearInterval(timer); else if (!document.hidden) load(); }, 30000);
}

export async function renderQuota(body, api) {
  body.replaceChildren();
  const root = node("div", undefined, "metrics-view"); body.append(root);
  const settings = section("Remote dashboard connection");
  settings.append(node("p", "Enter the CPA dashboard management key, not an inference API key. The saved key is encrypted and never returned to the browser.", "metrics-muted"));
  const form = node("form", undefined, "metrics-pricing");
  const endpoint = node("input"); endpoint.type = "url"; endpoint.required = true; endpoint.value = "https://cpa.trance-0.com";
  const key = node("input"); key.type = "password"; key.autocomplete = "new-password"; key.placeholder = "Enter management key";
  const save = node("button", "Save connection", "btn"); save.type = "submit";
  const remove = node("button", "Remove saved key", "btn"); remove.type = "button";
  form.append(control("CPA dashboard URL", endpoint), control("Management key", key), save, remove); settings.append(form);
  const message = node("p", "Loading connection…", "metrics-status"); message.setAttribute("role", "status");
  const quota = section("Remaining capacity"); const refresh = node("button", "Refresh quota", "btn");
  const updated = node("p", "", "metrics-muted"); const accounts = node("div", undefined, "quota-accounts"); quota.append(refresh, updated, accounts);
  root.append(settings, message, quota);
  let configured = false;
  function draw(snapshot) {
    accounts.replaceChildren();
    updated.textContent = snapshot ? `Last checked ${new Date(snapshot.updatedAt).toLocaleString()}. ${snapshot.note}` : "No quota snapshot yet. Save your connection and refresh.";
    for (const account of snapshot?.accounts || []) {
      const box = node("article", undefined, "quota-account"); box.append(node("h3", account.label));
      if (account.error) box.append(node("p", account.error, "tone-error"));
      for (const window of account.windows) {
        const row = node("div", undefined, "quota-window");
        const value = window.remainingPercent;
        row.append(node("strong", window.label), node("span", value === null ? "Unknown remaining" : `${value.toFixed(1)}% remaining`));
        if (value !== null) { const meter = node("meter"); meter.min = 0; meter.max = 100; meter.low = 10; meter.high = 50; meter.optimum = 100; meter.value = value; meter.setAttribute("aria-label", `${account.label} ${window.label} remaining`); row.append(meter); }
        row.append(node("small", window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString()}` : window.assumed ? "Next reset starts with the next use" : "Reset time unavailable"));
        // The server's read-time correction (server/metrics/quota-normalize.js).
        const reported = window.reported?.remainingPercent;
        const was = Number.isFinite(reported) ? ` (snapshot said ${reported.toFixed(1)}%)` : "";
        if (window.assumed === "reset-passed") row.append(node("small", `Reset passed at ${new Date(window.reported.resetsAt).toLocaleString()}; counted as 100% remaining until the next refresh${was}.`, "quota-assumed"));
        else if (window.assumed === "weekly-unused") row.append(node("small", `The weekly window shows no usage, so this 5-hour window counts as 100% remaining${was}.`, "quota-assumed"));
        else if (window.assumed === "weekly-exhausted") row.append(node("small", `5h counted as 0%: weekly quota exhausted${was}.`, "quota-assumed"));
        if (window.assumed) row.dataset.assumed = window.assumed;
        box.append(row);
      }
      accounts.append(box);
    }
    if (snapshot && !snapshot.accounts.length) accounts.append(node("p", "No enabled quota accounts were returned by CPA."));
  }
  async function load() {
    const view = await api("/api/admin/metrics/cpa");
    configured = view.configured; endpoint.value = view.endpoint; key.value = "";
    key.placeholder = configured ? "Saved — leave blank to keep current key" : "Enter management key";
    save.disabled = !view.encryptionReady; remove.disabled = !configured; refresh.disabled = !configured;
    status(message, !view.encryptionReady ? "Credential saving unavailable: dashboard/encryption — ask the operator to mount the encryption key." : configured ? "Encrypted credential saved. Only administrators can access this panel." : "No management key saved yet.", !view.encryptionReady);
    draw(view.snapshot);
  }
  form.onsubmit = async event => {
    event.preventDefault(); save.disabled = true;
    try { await api("/api/admin/metrics/cpa", { method: "PUT", body: JSON.stringify({ endpoint: endpoint.value.trim(), key: key.value }) }); key.value = ""; await load(); }
    catch (error) { status(message, error.message, true); save.disabled = false; }
  };
  remove.onclick = async () => { try { await api("/api/admin/metrics/cpa", { method: "DELETE" }); await load(); } catch (error) { status(message, error.message, true); } };
  refresh.onclick = async () => {
    refresh.disabled = true; status(message, "Checking CPA account quotas…");
    try { const data = await api("/api/admin/metrics/cpa/refresh", { method: "POST", body: "{}" }); draw(data.snapshot); status(message, "Quota snapshot updated."); }
    catch (error) { status(message, error.message, true); }
    finally { refresh.disabled = !configured; }
  };
  try { await load(); } catch (error) { status(message, error.message, true); }
}
