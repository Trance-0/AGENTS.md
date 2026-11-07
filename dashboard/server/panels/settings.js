// Per-browser dashboard preferences. The browser renders these fields as live
// controls and stores them in localStorage (see public/theme.js and
// public/player.js); nothing here is saved on the server or sent upstream.

export function createSettingsPanel() {
  return {
    id: "settings",
    title: "Settings",
    description: "Appearance, motion, and playback preferences for this browser, plus panel administration for admins.",
    icon: "settings",
    group: "settings",
    order: 0,

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
        key: "motion",
        label: "Motion",
        type: "select",
        scope: "browser",
        options: ["system", "reduce", "full"],
        help: "Reduce turns off animated transitions, the avatar's breathing bob, and the cat's paw drumming. System follows your device setting.",
      },
      {
        key: "autoplay",
        label: "Autoplay recordings",
        type: "boolean",
        scope: "browser",
        help: "Start replay when you open a recording. Live streams always follow the live edge.",
      },
      {
        key: "playbackRate",
        label: "Playback speed",
        type: "select",
        scope: "browser",
        options: ["0.25", "0.5", "0.75", "1", "1.25", "1.5", "2"],
        help: "Replay speed for recordings; the player's speed menu changes the same setting.",
      },
    ],
  };
}
