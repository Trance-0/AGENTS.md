/** Device-specific snapshots in a shared folder; cursors stay local. */
import fsp from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { CONFIG_DIR, DATA_DIR } from "./paths.ts"
import * as Transfer from "./session-transfer.ts"
import * as DB from "./db.ts"
import * as Progress from "./progress.ts"
import * as Logs from "./logs.ts"
import { local } from "./device.ts"
import * as Registry from "./registry.ts"

export type Config = { directory: string; mode: "manual" | "import" | "auto" }
const configFile = path.join(CONFIG_DIR, "session-sync.json")
const cursorFile = path.join(DATA_DIR, "session-sync-cursors.json")
type Cursor = { imported: Record<string, string>; exported?: string }
const stateKey = Symbol.for("opencode.directory-sync")
const state = ((globalThis as Record<symbol, unknown>)[stateKey] ??= { running: false, started: false }) as { running: boolean; started: boolean }
export async function config(): Promise<Config> {
  try {
    const c = JSON.parse(await fsp.readFile(configFile, "utf8")) as Config
    return { directory: c.directory || "", mode: ["manual", "import", "auto"].includes(c.mode) ? c.mode : "manual" }
  } catch { return { directory: "", mode: "manual" } }
}
export async function configure(patch: Partial<Config>) {
  const c = { ...await config(), ...patch }
  if (!["manual", "import", "auto"].includes(c.mode)) throw new Error("Sync setting rejected: session-manager/directory-config — unknown mode")
  if (c.directory && !path.isAbsolute(c.directory)) throw new Error("Sync setting rejected: session-manager/directory-config — folder must be absolute")
  await fsp.mkdir(CONFIG_DIR, { recursive: true })
  await fsp.writeFile(configFile, JSON.stringify(c, null, 2))
}
export async function archiveDigest(file: string) {
  const hash = createHash("sha256")
  const handle = await fsp.open(file, "r")
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk) } finally { await handle.close() }
  return hash.digest("hex")
}
function fingerprint() {
  const db = DB.open(true)
  try {
    const hash = createHash("sha256")
    for (const table of ["session", "message", "part", "event"]) {
      for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY id`).iterate()) hash.update(JSON.stringify(row))
    }
    return hash.digest("hex")
  } finally { db.close() }
}
export async function sync(readOnly = false) {
  if (state.running) return "Directory sync already running."
  const c = await config()
  if (!c.directory) throw new Error("Sessions cannot sync: session-manager/directory-sync — no folder configured")
  state.running = true
  const h = Progress.start("session-manager", "sync-directory", "Reading sync folder")
  try {
    await fsp.mkdir(c.directory, { recursive: true })
    const device = await local()
    const own = `device-${device.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.tar.gz`
    let cursor: Cursor = { imported: {} }
    try { cursor = JSON.parse(await fsp.readFile(cursorFile, "utf8")) } catch { /* First sync. */ }
    const files = (await fsp.readdir(c.directory)).filter((f) => f.endsWith(".tar.gz") && f !== own).sort()
    let imported = 0, failed = 0
    for (const [i, name] of files.entries()) {
      const file = path.join(c.directory, name)
      h.step(i, files.length, `Reading archive ${i + 1}/${files.length}`)
      try {
        const digest = await archiveDigest(file)
        if (cursor.imported[file] === digest) continue
        await Transfer.importLocal(file, h)
        // Do not acknowledge a file replaced while it was being imported.
        if (await archiveDigest(file) !== digest) throw new Error("archive changed during import; retry next pass")
        cursor.imported[file] = digest
        imported++
      } catch (e) {
        failed++
        h.log(`Archive not merged: session-manager/directory-sync — ${name}: ${String(e)}`, "warn")
      }
    }
    const before = fingerprint()
    let exported = false
    if (!readOnly && c.mode === "auto" && !failed && (cursor.exported !== before || !(await fsp.stat(path.join(c.directory, own)).catch(() => null)))) {
      await Transfer.exportLocal(path.join(c.directory, own), [], (done, total) => h.step(done, total, `Writing snapshot ${done}/${total}`))
      cursor.exported = before
      exported = true
    }
    await fsp.mkdir(DATA_DIR, { recursive: true })
    await fsp.writeFile(cursorFile, JSON.stringify(cursor))
    const summary = `Directory sync: ${imported} archives merged, ${exported ? 1 : 0} snapshot written, ${failed} failed.`
    h.finish(failed ? "failed" : "done", summary)
    Logs.log("session-manager", summary, failed ? "warn" : "info")
    return summary
  } catch (e) { h.finish("failed", String(e)); throw e } finally { state.running = false }
}
export function start() {
  if (state.started) return
  state.started = true
  const tick = async () => {
    if (!Registry.isEnabled("session-manager")) return
    if ((await config()).mode === "manual") return
    try { await sync() } catch (e) { Logs.log("session-manager", `Sessions cannot sync: session-manager/directory-sync — ${String(e)}`, "warn") }
  }
  const timer = setInterval(() => void tick(), 60_000)
  timer.unref()
  const initial = setTimeout(() => void tick(), 5000)
  initial.unref()
}
