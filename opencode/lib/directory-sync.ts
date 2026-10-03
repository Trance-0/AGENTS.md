/** Local import and per-session directory synchronization. */
import fsp from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { CONFIG_DIR, DATA_DIR } from "./paths.ts"
import * as Transfer from "./session-transfer.ts"
import * as DB from "./db.ts"
import * as Progress from "./progress.ts"
import * as Logs from "./logs.ts"
import * as Registry from "./registry.ts"
import { local } from "./device.ts"

export type Config = { directory: string; mode: "manual" | "local" | "directory" | "auto" }
const modes = ["manual", "local", "directory", "auto"]
const configFile = path.join(CONFIG_DIR, "session-sync.json")
const cursorFile = path.join(DATA_DIR, "session-sync-cursors.json")
const stateKey = Symbol.for("opencode.directory-sync")
const state = ((globalThis as Record<symbol, unknown>)[stateKey] ??= { running: false, started: false }) as { running: boolean; started: boolean }
export async function config(): Promise<Config> {
  try {
    const c = JSON.parse(await fsp.readFile(configFile, "utf8")) as Config
    return { directory: c.directory || "", mode: modes.includes(c.mode) ? c.mode : "manual" }
  } catch { return { directory: "", mode: "manual" } }
}
export async function configure(patch: Partial<Config>) {
  const c = { ...await config(), ...patch }
  if (!modes.includes(c.mode)) throw new Error("Sync setting rejected: session-manager/directory-config — unknown mode")
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
async function files(root: string): Promise<string[]> {
  const result: string[] = []
  for (const item of await fsp.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name)
    if (item.isDirectory()) result.push(...await files(file))
    else if (item.isFile() && item.name.endsWith(".json")) result.push(file)
  }
  return result.sort()
}
export async function sync(localImport?: () => Promise<string>) {
  if (state.running) return "Session sync already running."
  const c = await config()
  if (c.mode === "manual") return "Manual mode: no active merge. Use the explicit import/export controls."
  state.running = true
  const h = Progress.start("session-manager", "sync-directory", "Checking session sync sources")
  try {
    if ((c.mode === "local" || c.mode === "auto") && localImport) h.log(await localImport())
    if (c.mode === "local" || !c.directory) {
      if (c.mode === "directory") throw new Error("Sessions cannot sync: session-manager/directory-sync — no directory configured")
      const message = "Local sessions merged; no remote directory configured."
      h.finish("done", message); return message
    }
    await fsp.mkdir(c.directory, { recursive: true })
    const device = await local()
    let cursor: Record<string, string> = {}
    try { cursor = JSON.parse(await fsp.readFile(cursorFile, "utf8")).files ?? {} } catch { /* First pass. */ }
    const incoming = await files(c.directory)
    let changed = 0, failed = 0
    const db = DB.open()
    try {
      for (const [i, file] of incoming.entries()) {
        h.step(i, incoming.length, `Reading session records ${i + 1}/${incoming.length}`)
        try {
          const digest = await archiveDigest(file)
          if (cursor[file] === digest) continue
          await Transfer.readDirectoryFile(db, file)
          if (await archiveDigest(file) !== digest) throw new Error("file changed during import; retry next pass")
          cursor[file] = digest; changed++
        } catch (e) { failed++; h.log(`Record not merged: session-manager/directory-sync — ${path.basename(file)}: ${String(e)}`, "warn") }
        if (i % 100 === 0) await new Promise((r) => setTimeout(r, 0))
      }
      if (failed) {
        await fsp.mkdir(DATA_DIR, { recursive: true })
        await fsp.writeFile(cursorFile, JSON.stringify({ files: cursor }))
        const message = `Session sync incomplete: session-manager/directory-sync — ${failed} invalid or changing files; publication deferred, records retained for retry.`
        h.finish("failed", message)
        return message
      }
      const published = await Transfer.publishDirectory(db, c.directory, device.id, (done, total) => h.step(done, total, `Publishing sessions ${done}/${total}`))
      await fsp.mkdir(DATA_DIR, { recursive: true })
      await fsp.writeFile(cursorFile, JSON.stringify({ files: cursor }))
      const summary = `Session sync: ${changed} files merged, ${published} sessions published, ${failed} failed.`
      h.finish(failed ? "failed" : "done", summary)
      Logs.log("session-manager", summary, failed ? "warn" : "info")
      return summary
    } finally { db.close() }
  } catch (e) { h.finish("failed", String(e)); throw e } finally { state.running = false }
}
export function start(localImport: () => Promise<string>) {
  if (state.started) return
  state.started = true
  const tick = async () => {
    if (!Registry.isEnabled("session-manager") || (await config()).mode === "manual") return
    try { await sync(localImport) } catch (e) { Logs.log("session-manager", `Sessions cannot sync: session-manager/directory-sync — ${String(e)}`, "warn") }
  }
  const timer = setInterval(() => void tick(), 60_000); timer.unref()
  const initial = setTimeout(() => void tick(), 5000); initial.unref()
}
