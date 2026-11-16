export function createOpenclawCodingPanel() {
  return {
    id: "openclaw-coding",
    title: "Coding agent settings",
    description: "Configure OpenCode model order and reasoning effort, provider access, and coding-agent connections.",
    icon: "config",
    group: "openclaw",
    adminOnly: true,
    order: 21,
    tabs: [{ id: "openclaw-coding", title: "Coding agent settings" }],
  };
}
