// Placeholder settings panel. Real settings (theme, accent, notifications) are
// future work; this keeps the YouTube "settings" slot occupied.

export function createSettingsPanel(ctx) {
  return {
    id: "settings",
    title: "Settings",
    description: "Dashboard appearance and behavior (placeholder).",
    icon: "settings",

    settings: () => [
      {
        key: "theme",
        label: "Theme",
        type: "select",
        value: "dark",
        options: ["dark", "light", "system"],
      },
      { key: "autoplay", label: "Autoplay stream", type: "boolean", value: true },
      { key: "volume", label: "Alert volume", type: "number", value: 40 },
    ],

    status: () => [
      { label: "Theme", value: "dark", tone: "neutral" },
    ],
  };
}
