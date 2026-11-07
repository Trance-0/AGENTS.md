// Usage summary: pooled Codex quota (both windows) and token totals at a glance.
// Data comes from /api/admin/metrics/summary (server/metrics/routes.js), which
// pools accounts the same way as the public scene metric widget.
export function createUsageSummaryPanel() {
  return { id: "usage-summary", title: "Usage summary", adminOnly: true, icon: "gauge", group: "usage", order: 10, tabTitle: "Summary", description: "Pooled Codex quota across accounts, reset countdowns, and token totals." };
}
