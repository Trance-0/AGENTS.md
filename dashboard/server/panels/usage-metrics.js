export function createUsageMetricsPanel() {
  return { id: "usage-metrics", title: "OpenClaw usage", adminOnly: true, icon: "chart", group: "usage", order: 30, tabTitle: "Token metrics", description: "Tokens and estimated cost by route and model, including input, output, and cache usage." };
}
