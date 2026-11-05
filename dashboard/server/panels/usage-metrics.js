export function createUsageMetricsPanel() {
  return { id: "usage-metrics", title: "OpenClaw usage", adminOnly: true, icon: "chart", description: "Tokens and estimated cost by route and model, including input, output, and cache usage." };
}
