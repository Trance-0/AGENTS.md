// Subscriptions: Bark push alarms for Codex quota and CliProxy reset events.
// Device keys and templates are encrypted at rest; the monitor refreshes the
// quota snapshot and pushes live every five minutes.
export function createSubscriptionPanel() {
  return {
    id: "subscription",
    title: "Subscriptions",
    adminOnly: true,
    icon: "bell",
    group: "usage",
    order: 21,
    tabTitle: "Subscriptions",
    description: "Bark push alarms for Codex depletion, new credits, the 5-hour pool, and CliProxy reset events.",
    settings: () => [],
    status: () => [],
  };
}
