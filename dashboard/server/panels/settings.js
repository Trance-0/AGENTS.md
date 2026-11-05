// Per-browser dashboard preferences. The browser renders these fields as live
// controls and stores them in localStorage (see public/theme.js and
// public/player.js); nothing here is saved on the server or sent upstream.

export function createSettingsPanel() {
  return {
    id: "settings",
    title: "Settings",
    description: "Appearance and playback preferences for this browser. Changes apply immediately and are saved in this browser only.",
    icon: "settings",

    settings: () => [
      {
        key: "theme",
        label: "Theme",
        type: "select",
        scope: "browser",
        options: ["system", "light", "dark"],
        help: "System follows your device's light or dark setting.",
      },
      {
        key: "autoplay",
        label: "Autoplay recordings",
        type: "boolean",
        scope: "browser",
        help: "Start replay when you open a recording. Live streams always follow the live edge.",
      },
    ],
  };
}
