const ns = "http://www.w3.org/2000/svg";
export const number = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value || 0);
export const money = value => value === null || value === undefined ? "Unknown" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
const colors = ["#59c9b3", "#86a7ff", "#dda7ff", "#f0c16d", "#f18b9d", "#84cf82"];
export function node(tag, text, className) {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el;
}
function svg(tag, attrs, text) {
  const el = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value); if (text !== undefined) el.textContent = text; return el;
}

export function trendChart(container, report, metric) {
  container.replaceChildren();
  const frame = node("div", undefined, "metrics-chart");
  const chart = svg("svg", { viewBox: "0 0 920 260", role: "img", "aria-label": `${metric === "tokens" ? "Token" : "Estimated cost"} usage over time by route` });
  const routes = report.routes.map(row => row.route);
  const buckets = [];
  const begin = Math.floor(report.start / report.bucketMs) * report.bucketMs;
  for (let at = begin; at <= report.end; at += report.bucketMs) buckets.push(at);
  const values = new Map(report.trends.map(row => [`${row.timestamp}:${row.route}`, metric === "tokens" ? row.tokens : row.costUsd || 0]));
  const sums = buckets.map(at => routes.reduce((sum, route) => sum + (values.get(`${at}:${route}`) || 0), 0));
  const max = Math.max(1e-8, ...sums);
  const left = 78, top = 20, height = 190, width = 820;
  const step = width / Math.max(1, buckets.length);
  for (let i = 0; i <= 4; i++) {
    const y = top + height * (1 - i / 4);
    chart.append(svg("line", { x1: left, x2: left + width, y1: y, y2: y, class: "metrics-grid" }));
    chart.append(svg("text", { x: left - 8, y: y + 4, "text-anchor": "end", class: "metrics-axis" }, metric === "tokens" ? number(max * i / 4) : money(max * i / 4)));
  }
  buckets.forEach((at, index) => {
    let bottom = top + height;
    routes.forEach((route, color) => {
      const value = values.get(`${at}:${route}`) || 0;
      const h = value / max * height;
      const rect = svg("rect", { x: left + index * step + 2, y: bottom - h, width: Math.max(1, step - 4), height: h, rx: 2, fill: colors[color % colors.length], tabindex: "0" });
      const detail = `${new Date(at).toLocaleString()} · ${route}: ${metric === "tokens" ? number(value) + " tokens" : money(value)}`;
      rect.setAttribute("aria-label", detail); rect.append(svg("title", {}, detail)); chart.append(rect); bottom -= h;
    });
    if (index % Math.max(1, Math.ceil(buckets.length / 7)) === 0) chart.append(svg("text", { x: left + index * step + step / 2, y: top + height + 24, "text-anchor": "middle", class: "metrics-axis" }, report.bucketMs === 3600000 ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })));
  });
  frame.append(chart);
  const legend = node("div", undefined, "metrics-legend");
  routes.forEach((route, i) => { const label = node("span", route); label.style.setProperty("--route-color", colors[i % colors.length]); legend.append(label); });
  container.append(frame, legend);
  if (metric === "cost" && report.summary.unpriced) container.append(node("p", `${number(report.summary.unpriced)} metered attempts have unknown prices and are omitted from this chart.`, "metrics-muted"));
  if (!report.summary.attempts) container.append(node("p", "No recorded usage in this period. New OpenClaw attempts appear automatically.", "metrics-muted"));
}

export function breakdownTable(container, rows, grouping, metric) {
  container.replaceChildren();
  const table = node("table", undefined, "metrics-table");
  table.setAttribute("aria-label", `Usage by ${grouping}`);
  const head = node("tr");
  const labels = [grouping === "model" ? "Route / model" : "Route", "Attempts", "Input", "Output", "Cache read", "Cache write", metric === "tokens" ? "Total tokens" : "Estimated cost", "Unpriced"];
  for (const label of labels) head.append(node("th", label));
  const thead = node("thead"); thead.append(head); table.append(thead);
  const body = node("tbody");
  for (const row of [...rows].sort((a, b) => metric === "tokens" ? b.tokens - a.tokens : (b.costUsd || 0) - (a.costUsd || 0))) {
    const tr = node("tr");
    for (const value of [grouping === "model" ? `${row.route} / ${row.model}` : row.route, number(row.attempts), number(row.input), number(row.output), number(row.cacheRead), number(row.cacheWrite), metric === "tokens" ? number(row.tokens) : money(row.costUsd), number(row.unpriced)]) tr.append(node("td", value));
    body.append(tr);
  }
  table.append(body); container.append(table);
}
