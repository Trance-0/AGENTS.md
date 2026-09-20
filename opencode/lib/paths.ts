/**
 * Shared filesystem locations for the ported dsh/codex plugins.
 *
 * Everything the plugins own lives under the opencode global config directory
 * so that state travels with the rest of the opencode configuration.
 */

import os from "node:os"
import path from "node:path"

export const HOME = os.homedir()

/** `~/.config/opencode` (or `$XDG_CONFIG_HOME/opencode`). */
export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "opencode")

/** `~/.local/share/opencode` (or `$XDG_DATA_HOME/opencode`). */
export const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "opencode")

/** The live opencode SQLite database. */
export const DB_PATH = path.join(DATA_DIR, "opencode.db")

/** State files owned by these plugins. */
export const STATE = {
  sessionIndex: path.join(CONFIG_DIR, "session-index.json"),
  sessionLedger: path.join(CONFIG_DIR, "session-ledger.json"),
  barkConfig: path.join(CONFIG_DIR, "bark-notify.json"),
  barkQueue: path.join(CONFIG_DIR, "bark-notify-queue.json"),
  cpaConfig: path.join(CONFIG_DIR, "cpa-usage.json"),
  taskQueue: path.join(CONFIG_DIR, "task-queue.json"),
  pcpConfig: path.join(CONFIG_DIR, "pcp.json"),
}

/** External coding-agent session stores scanned by the session manager. */
export const SOURCES = {
  claude: path.join(HOME, ".claude", "projects"),
  codex: path.join(HOME, ".codex", "sessions"),
  codexArchived: path.join(HOME, ".codex", "archived_sessions"),
  dsh: path.join(HOME, ".dsh", "sessions"),
}

/** Legacy dsh/codex config locations, read once for migration. */
export const LEGACY = {
  barkConfig: path.join(HOME, ".dsh", "bark-notify.json"),
  codexBarkConfig: path.join(HOME, ".codex", "bark-notify.json"),
  codexHome: process.env.CODEX_HOME || path.join(HOME, ".codex"),
}
