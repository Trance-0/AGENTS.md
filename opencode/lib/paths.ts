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

/**
 * Root of the per-plugin log files.
 *
 * Under the data directory rather than the config one: these are operational
 * records, not configuration, and they must not travel when the config is
 * copied to another machine.
 */
export const LOG_DIR = path.join(DATA_DIR, "plugin-logs")

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
  /**
   * Codex's thread-name sidecar: `{ id, thread_name, updated_at }` per line.
   *
   * The name Codex shows a user lives here rather than in the transcript, so
   * this is the only place a session's familiar title can be read. Read-only —
   * Codex owns this file.
   */
  codexIndex: path.join(HOME, ".codex", "session_index.jsonl"),
  dsh: path.join(HOME, ".dsh", "sessions"),
}

/** Legacy dsh/codex config locations, read once for migration. */
export const LEGACY = {
  barkConfig: path.join(HOME, ".dsh", "bark-notify.json"),
  codexBarkConfig: path.join(HOME, ".codex", "bark-notify.json"),
  codexHome: process.env.CODEX_HOME || path.join(HOME, ".codex"),
}
