// OpenClaw config manager. Administrators edit the live openclaw.json from the
// browser (see openclaw-config-routes.js); OpenClaw itself mounts it read-only.

import fs from "node:fs";
import { config } from "../config.js";

export function createOpenclawConfigPanel() {
  return {
    id: "openclaw-config",
    title: "OpenClaw settings",
    adminOnly: true,
    description: "Edit OpenClaw's live openclaw.json (administrators only). OpenClaw reads it read-only and hot-reloads saves; secret values stay masked.",
    icon: "config",
    group: "openclaw",
    order: 20,
    tabs: [{ id: "openclaw-config", title: "Settings" }, { id: "openclaw-tasks", title: "Scheduled tasks" }],

    settings: () => [
      { key: "file", label: "Config file", type: "string", value: config.openclaw.configFile || "(not mounted)" },
    ],

    status: () => {
      if (!config.openclaw.configFile) return [{ label: "Config", value: "not mounted", tone: "error" }];
      try {
        const stat = fs.statSync(config.openclaw.configFile);
        return [
          { label: "Config", value: "mounted", tone: "ok" },
          { label: "Last modified", value: stat.mtime.toISOString(), tone: "neutral" },
        ];
      } catch (error) {
        return [{ label: "Config", value: `unreadable (${error.code || "unknown"})`, tone: "error" }];
      }
    },
  };
}
