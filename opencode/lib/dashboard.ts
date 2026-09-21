/**
 * Localhost settings dashboard.
 *
 * Ports the codex `persistent-plugin-manager` web panel. opencode's desktop app
 * has no plugin settings UI, so this serves one on 127.0.0.1 and renders it
 * from the registry: whatever a plugin declares in its descriptor appears here
 * without the dashboard knowing anything about that plugin.
 *
 * Unlike the codex original this is **not** a detached daemon. opencode loads
 * plugins once per project directory, so a daemon would be spawned 40+ times.
 * Instead the server lives in the opencode process and the port bind itself is
 * the lock: `listen` on a fixed port is atomic, so exactly one instance wins and
 * the rest defer to it. The winner dies with opencode, leaving nothing behind.
 */

import http from "node:http"
import fsp from "node:fs/promises"
import path from "node:path"
import { CONFIG_DIR } from "./paths.ts"
import * as Registry from "./registry.ts"
import * as ConfigFiles from "./config-files.ts"
import * as Marketplace from "./marketplace.ts"
import * as Sessions from "./session-store.ts"
import * as ModelPicker from "./model-picker.ts"
import * as Theme from "./theme.ts"

const PORT_MIN = 14100
const PORT_MAX = 14120
const PORT_FILE = path.join(CONFIG_DIR, "plugin-manager.port")

const KEY = Symbol.for("@dsh/opencode-dashboard")

type State = { server: http.Server | null; port: number | null; starting: Promise<number | null> | null }

function state(): State {
  const g = globalThis as Record<symbol, unknown>
  if (!g[KEY]) g[KEY] = { server: null, port: null, starting: null } satisfies State
  return g[KEY] as State
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
    // Live plugin state: a cached response would show stale settings.
    "cache-control": "no-store",
  })
  res.end(payload)
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // The dashboard only ever posts small settings payloads.
    if (size > 64 * 1024) throw new Error("payload too large")
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")

  if (url.pathname === "/api/plugins" && req.method === "GET") {
    return json(res, 200, { plugins: await Registry.snapshot() })
  }

  /**
   * One opencode session: its metadata and the tail of its transcript.
   *
   * The dashboard cannot focus a session inside the opencode GUI — nothing in
   * the plugin API reaches the editor's UI — so a session link opens the
   * transcript here instead, which is what makes an imported session
   * inspectable at all.
   */
  const session = url.pathname.match(/^\/api\/session\/([^/]+)$/)
  if (session && req.method === "GET") {
    const id = decodeURIComponent(session[1])
    const row = Sessions.get(id)
    if (!row) return json(res, 404, { error: `Unknown session: ${id}` })
    return json(res, 200, {
      session: {
        id: row.id,
        title: row.title,
        directory: row.directory,
        projectID: row.projectID,
        messages: Sessions.messageCount(row.id),
        tokens: Sessions.totalTokens(row),
        cost: row.cost,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      turns: Sessions.recentTurns(id, 40),
    })
  }

  /**
   * Rows under one group of a tree panel, fetched when the group is expanded.
   *
   * Separate from the plugin snapshot on purpose: the snapshot is polled every
   * few seconds, and a plugin listing hundreds of sessions across dozens of
   * projects would pay for all of them on every tick.
   */
  const children = url.pathname.match(/^\/api\/plugins\/([^/]+)\/panel\/([^/]+)\/children$/)
  if (children && req.method === "GET") {
    const [, id, panelKey] = children
    const groupID = url.searchParams.get("group")
    if (!groupID) return json(res, 400, { error: "Missing group" })
    try {
      const items = await Registry.children(decodeURIComponent(id), decodeURIComponent(panelKey), groupID)
      return json(res, 200, { items })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Full-text search across whatever a plugin owns.
   *
   * GET with the query in the URL so a search is shareable and re-runnable,
   * and so it cannot be mistaken for a mutation.
   */
  const search = url.pathname.match(/^\/api\/plugins\/([^/]+)\/search$/)
  if (search && req.method === "GET") {
    const query = url.searchParams.get("q") ?? ""
    if (!query.trim()) return json(res, 200, { items: [] })
    try {
      const items = await Registry.runSearch(decodeURIComponent(search[1]), query)
      return json(res, 200, { items })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The scratch conversation used to try a model out.
   *
   * Held in memory by the model picker and never written anywhere: a test
   * conversation exists to judge a model, not to be kept.
   */
  const chat = url.pathname.match(/^\/api\/plugins\/([^/]+)\/chat$/)
  if (chat) {
    const id = decodeURIComponent(chat[1])
    if (req.method === "GET") return json(res, 200, { turns: ModelPicker.chat(id) })
    if (req.method === "POST") {
      const body = await readBody(req)
      const plugin = Registry.get(id)
      if (!plugin) return json(res, 404, { error: `Unknown plugin: ${id}` })
      const action = plugin.actions?.[String(body.action ?? "")]
      if (!action) return json(res, 400, { error: `Unknown action: ${body.action}` })
      try {
        await action.run(String(body.message ?? ""))
        return json(res, 200, { turns: ModelPicker.chat(id) })
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const chatClear = url.pathname.match(/^\/api\/plugins\/([^/]+)\/chat\/clear$/)
  if (chatClear && req.method === "POST") {
    ModelPicker.clearChat(decodeURIComponent(chatClear[1]))
    return json(res, 200, { ok: true, turns: [] })
  }

  // ── versions and marketplace ───────────────────────────────────────────
  if (url.pathname === "/api/marketplace" && req.method === "GET") {
    const config = await Marketplace.config().catch(() => null)
    const cache = await Marketplace.cached()
    return json(res, 200, {
      repository: config?.repository ?? null,
      apiBase: config?.apiBase ?? null,
      enabled: config?.enabled ?? false,
      checkedAt: cache?.checkedAt ?? null,
      error: cache?.error ?? null,
      listings: cache?.listings ?? [],
    })
  }

  if (url.pathname === "/api/marketplace/refresh" && req.method === "POST") {
    try {
      const cache = await Marketplace.refresh()
      if (cache.error) return json(res, 200, { ok: false, message: cache.error })
      const updates = (await Marketplace.status()).filter((entry) => entry.updateAvailable)
      return json(res, 200, {
        ok: true,
        message: updates.length
          ? `${updates.length} update${updates.length === 1 ? "" : "s"} available`
          : `no updates (${cache.listings.length} release${cache.listings.length === 1 ? "" : "s"} found)`,
      })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // ── config editor ──────────────────────────────────────────────────────
  if (url.pathname === "/api/config" && req.method === "GET") {
    return json(res, 200, { files: await ConfigFiles.list(), configDir: CONFIG_DIR })
  }

  const file = url.pathname.match(/^\/api\/config\/([^/]+)$/)
  if (file && req.method === "GET") {
    try {
      return json(res, 200, await ConfigFiles.read(decodeURIComponent(file[1])))
    } catch (error) {
      return json(res, 404, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const action = url.pathname.match(/^\/api\/config\/([^/]+)\/(diff|save)$/)
  if (action && req.method === "POST") {
    const name = decodeURIComponent(action[1])
    try {
      const body = await readBody(req)
      if (typeof body.content !== "string") return json(res, 400, { error: "content is required" })

      if (action[2] === "diff") {
        // Preview: validate and diff against disk without writing.
        const { content: current } = await ConfigFiles.read(name)
        return json(res, 200, {
          diff: ConfigFiles.diff(current, body.content),
          validation: ConfigFiles.validate(name, body.content),
          unchanged: current === body.content,
        })
      }

      const result = await ConfigFiles.write(name, body.content)
      return json(res, 200, { ok: true, ...result, files: await ConfigFiles.list() })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const match = url.pathname.match(/^\/api\/plugins\/([^/]+)\/(settings|enabled|action)$/)
  if (match && req.method === "POST") {
    const [, id, kind] = match
    const plugin = Registry.get(id)
    if (!plugin) return json(res, 404, { error: `Unknown plugin: ${id}` })

    try {
      const body = await readBody(req)

      if (kind === "settings") {
        if (typeof body.key !== "string") return json(res, 400, { error: "key is required" })
        await plugin.update(body.key, body.value)
        return json(res, 200, { ok: true, plugins: await Registry.snapshot() })
      }

      if (kind === "enabled") {
        if (typeof body.enabled !== "boolean") return json(res, 400, { error: "enabled must be a boolean" })
        if (plugin.toggleable === false) return json(res, 400, { error: `${plugin.title} cannot be disabled` })
        await Registry.setEnabled(id, body.enabled)
        return json(res, 200, { ok: true, plugins: await Registry.snapshot() })
      }

      const action = plugin.actions?.[body.action]
      if (!action) return json(res, 400, { error: `Unknown action: ${body.action}` })
      // A settings-list action carries the value its prompt collected.
      const message = await action.run(typeof body.value === "string" ? body.value : undefined)
      return json(res, 200, { ok: true, message, plugins: await Registry.snapshot() })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // Every non-API path serves the same shell, which then routes on the URL.
  // That is what makes `/plugin/task-queue/settings` survive a direct load or a
  // refresh instead of 404ing, so links into a specific page actually work.
  if (!url.pathname.startsWith("/api/")) {
    // Read per request: a theme change then shows on reload, with no restart.
    const body = page(await Theme.load())
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "x-content-type-options": "nosniff",
      // The page is generated fresh on every request and changes whenever a
      // plugin is edited, so a cached copy is always the wrong one — without
      // this the browser keeps serving a stale build after an opencode restart.
      "cache-control": "no-store, must-revalidate",
      // The page is fully self-contained; no external origins are reachable.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    })
    return void res.end(body)
  }

  json(res, 404, { error: "Not Found" })
}

/**
 * Bind the first free port in the range.
 *
 * `listen` is atomic, so a failed bind means another opencode instance already
 * hosts the dashboard — that instance serves the same registry, so losing the
 * race is a success for the caller.
 */
async function bind(server: http.Server): Promise<number | null> {
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening)
        resolve(error.code !== "EADDRINUSE" ? false : false)
      }
      const onListening = () => {
        server.removeListener("error", onError)
        resolve(true)
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(port, "127.0.0.1")
    })
    if (ok) return port
  }
  return null
}

/** Start the dashboard if this process does not already host it. */
export async function start(): Promise<{ url: string | null; hosted: boolean }> {
  const s = state()
  if (s.port) return { url: `http://127.0.0.1:${s.port}`, hosted: true }

  s.starting ??= (async () => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    })
    // Never hold opencode open on account of the dashboard.
    server.unref()

    const port = await bind(server)
    if (port === null) {
      server.close()
      return null
    }
    s.server = server
    s.port = port
    await fsp.mkdir(path.dirname(PORT_FILE), { recursive: true }).catch(() => {})
    await fsp.writeFile(PORT_FILE, String(port), "utf8").catch(() => {})
    return port
  })()

  const port = await s.starting
  if (port !== null) return { url: `http://127.0.0.1:${port}`, hosted: true }

  // Another instance owns the dashboard; report where it is.
  const existing = await fsp.readFile(PORT_FILE, "utf8").catch(() => "")
  const trimmed = existing.trim()
  return { url: trimmed ? `http://127.0.0.1:${trimmed}` : null, hosted: false }
}

export async function stop(): Promise<void> {
  const s = state()
  if (!s.server) return
  await new Promise<void>((resolve) => s.server!.close(() => resolve()))
  s.server = null
  s.port = null
  s.starting = null
  await fsp.rm(PORT_FILE, { force: true }).catch(() => {})
}

export function current(): string | null {
  const s = state()
  return s.port ? `http://127.0.0.1:${s.port}` : null
}

/**
 * The dashboard page.
 *
 * A shell with a plugin sidebar and a content pane, rendered entirely from
 * `/api/plugins` and `/api/config` — a plugin that adds a setting appears here
 * with no change to this file. Values are inserted as text nodes rather than
 * HTML, so plugin-supplied strings cannot inject markup.
 *
 * The sidebar collapses to an off-canvas drawer below 860px, which is also what
 * happens when the window is docked beside the opencode GUI.
 */
function page(theme: Theme.Theme): string {
  const dark = Theme.resolve(theme.darkAccent).dark
  const light = Theme.resolve(theme.lightAccent).light

  // The mode is an attribute on <html> rather than a class swap in JS, so the
  // correct palette is painted on the first frame; deciding it client-side
  // flashes the wrong one first.
  return String.raw`<!doctype html>
<html data-mode="${theme.mode}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>opencode plugins</title>
<style>
/* Dark is the default palette; light overrides only what has to change. */
:root{
  --bg:#141418; --panel:#1c1c22; --panel2:#232329; --line:#2e2e37;
  --text:#e8e8ec; --muted:#9a9aa6; --faint:#6b6b78;
  --ok:#4ade80; --warn:#fbbf24; --err:#f87171; --accent:${dark};
  --add:#1e3a24; --addfg:#86efac; --del:#3f1d1d; --delfg:#fca5a5;
  --sidebar:260px;
}
/* Explicit light, and system-light. The two selectors are separate because a
   media query cannot be folded into an attribute selector. */
html[data-mode="light"]{
  --bg:#f6f7f9; --panel:#ffffff; --panel2:#eef0f4; --line:#d8dce3;
  --text:#14161a; --muted:#4a5060; --faint:#767d8d;
  --ok:#15803d; --warn:#a16207; --err:#b91c1c; --accent:${light};
  --add:#dcfce7; --addfg:#14532d; --del:#fee2e2; --delfg:#7f1d1d;
}
@media (prefers-color-scheme: light){
  html[data-mode="system"]{
    --bg:#f6f7f9; --panel:#ffffff; --panel2:#eef0f4; --line:#d8dce3;
    --text:#14161a; --muted:#4a5060; --faint:#767d8d;
    --ok:#15803d; --warn:#a16207; --err:#b91c1c; --accent:${light};
    --add:#dcfce7; --addfg:#14532d; --del:#fee2e2; --delfg:#7f1d1d;
  }
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);
  font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
button{font:inherit;color:inherit}

/* ---- shell ---- */
.shell{display:flex;height:100%}
.sidebar{width:var(--sidebar);flex:none;background:var(--panel);border-right:1px solid var(--line);
  display:flex;flex-direction:column;transition:transform .18s ease}
.brand{padding:16px 18px;border-bottom:1px solid var(--line)}
.brand h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.2px}
.brand .sub{color:var(--faint);font-size:11.5px;margin-top:2px}
.nav{flex:1;overflow-y:auto;padding:10px 0}
.navgroup{padding:12px 18px 6px;color:var(--faint);font-size:10.5px;
  text-transform:uppercase;letter-spacing:.9px;font-weight:600}
.navitem{display:flex;align-items:center;gap:9px;width:100%;text-align:left;
  padding:8px 18px;background:none;border:0;cursor:pointer;color:var(--muted);font-size:13.5px;
  text-decoration:none}
.navitem:hover{background:var(--panel2);color:var(--text)}
.navitem.active{background:var(--panel2);color:var(--text);box-shadow:inset 2px 0 0 var(--accent)}
.navitem .dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
.navitem .dot.on{background:var(--ok)}
.navitem .dot.off{background:#4a4a56}
.navitem .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.navitem .badge{font-size:10.5px;color:var(--faint);font-variant-numeric:tabular-nums}
.sidefoot{padding:10px 18px;border-top:1px solid var(--line);color:var(--faint);font-size:11px}

.content{flex:1;overflow-y:auto;min-width:0}
.topbar{display:none;align-items:center;gap:12px;padding:12px 16px;
  border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:20}
.hamburger{background:var(--panel2);border:1px solid var(--line);border-radius:7px;
  padding:6px 10px;cursor:pointer;line-height:1}
.pane{max-width:900px;margin:0 auto;padding:26px 28px 60px}
.pane h2{margin:0 0 4px;font-size:18px;font-weight:600}
.pane .lead{color:var(--muted);margin:0 0 22px;font-size:13px}

/* ---- responsive: sidebar auto-hides ---- */
.scrim{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:25}
@media (max-width:860px){
  .sidebar{position:fixed;top:0;bottom:0;left:0;z-index:30;transform:translateX(-100%);
    box-shadow:2px 0 18px rgba(0,0,0,.4)}
  body.nav-open .sidebar{transform:none}
  body.nav-open .scrim{display:block}
  .topbar{display:flex}
  .pane{padding:20px 16px 50px}
}

/* ---- cards ---- */
.card{background:var(--panel);border:1px solid var(--line);border-radius:11px;margin-bottom:16px;overflow:hidden}
.card.off{opacity:.6}
.chead{display:flex;align-items:center;gap:12px;padding:14px 18px}
.chead h3{margin:0;font-size:15px;font-weight:600;flex:1}
.chead .id{color:var(--faint);font-size:11.5px;font-family:ui-monospace,Consolas,monospace}
.cdesc{padding:0 18px 14px;color:var(--muted);font-size:12.5px;margin:0}
.sect{border-top:1px solid var(--line);padding:14px 18px}
.sect h4{margin:0 0 10px;font-size:11px;color:var(--faint);
  text-transform:uppercase;letter-spacing:.8px;font-weight:600}

.row{display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:14px;align-items:center;margin-bottom:10px}
.row:last-child{margin-bottom:0}
.row label{color:var(--muted);font-size:13px}
@media (max-width:640px){ .row{grid-template-columns:1fr;gap:6px} }

input[type=text],input[type=number],select,textarea{width:100%;padding:7px 10px;background:#101014;
  color:var(--text);border:1px solid var(--line);border-radius:7px;font:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}

.pills{display:flex;flex-wrap:wrap;gap:8px}
.pill{background:#101014;border:1px solid var(--line);border-radius:999px;
  padding:4px 11px;font-size:12px;color:var(--muted)}
.pill b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}
.pill.ok b{color:var(--ok)} .pill.warn b{color:var(--warn)} .pill.error b{color:var(--err)}

.btn{background:var(--panel2);border:1px solid var(--line);border-radius:7px;
  padding:6px 13px;cursor:pointer}
.btn:hover{border-color:var(--accent)}
.btn:disabled{opacity:.45;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#0f1020;font-weight:600}
.btn.danger{border-color:#5b2626;color:var(--delfg)}
.btnrow{display:flex;gap:8px;flex-wrap:wrap}

.switch{position:relative;width:38px;height:21px;flex:none;display:inline-block}
.switch input{opacity:0;width:0;height:0;position:absolute}
.slider{position:absolute;inset:0;background:#3a3a45;border-radius:999px;transition:.15s;cursor:pointer}
.slider:before{content:"";position:absolute;width:15px;height:15px;left:3px;top:3px;
  background:#fff;border-radius:50%;transition:.15s}
.switch input:checked+.slider{background:var(--accent)}
.switch input:checked+.slider:before{transform:translateX(17px)}
.switch input:disabled+.slider{opacity:.4;cursor:not-allowed}

/* ---- tabs ---- */
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:20px}
.tab{background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;
  padding:9px 15px;cursor:pointer;color:var(--muted);font-size:13.5px}
.tab:hover{color:var(--text)}
.tab.active{color:var(--text);border-bottom-color:var(--accent)}
.tab .count{color:var(--faint);font-size:11px;margin-left:5px;font-variant-numeric:tabular-nums}

/* ---- collapsible settings groups ---- */
.grouphead{display:flex;align-items:center;gap:9px;width:100%;background:none;border:0;
  padding:13px 18px;cursor:pointer;color:var(--text);font:inherit;font-weight:600;font-size:13.5px;text-align:left}
.grouphead:hover{color:var(--accent)}
.grouphead.open{border-bottom:1px solid var(--line)}
.grouphead .caret{color:var(--faint);font-size:11px;width:10px}
.grouphead .count{margin-left:auto;color:var(--faint);font-size:11px;font-weight:400;
  font-variant-numeric:tabular-nums}

/* ---- version tab ---- */
.vrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.vnum{font-family:ui-monospace,Consolas,monospace;font-size:22px;font-weight:600}
.tagpill{border-radius:999px;padding:3px 10px;font-size:11.5px;border:1px solid var(--line);
  text-transform:uppercase;letter-spacing:.6px}
.tagpill.stable{color:var(--ok);border-color:#26543a}
.tagpill.beta{color:var(--warn);border-color:#5b4a26}
.vnote{color:var(--muted);font-size:12.5px;margin:0 0 4px}
.vgrid{display:grid;gap:9px;grid-template-columns:minmax(0,1fr);margin-top:6px}
.vcell{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:11px 13px}
.vcell .k{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.7px}
.vcell .v{font-size:13.5px;margin-top:3px;word-break:break-word;
  font-family:ui-monospace,Consolas,monospace}

/* ---- panels: one card per item, accent-coloured by tone ---- */
.panel{margin-bottom:26px}
.phead{display:flex;align-items:baseline;gap:10px;margin-bottom:4px;flex-wrap:wrap}
.phead h3{margin:0;font-size:15px;font-weight:600}
.phead .when{color:var(--faint);font-size:11.5px;flex:1}
.pdesc{color:var(--muted);font-size:12.5px;margin:0 0 12px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.chip{background:var(--panel);border:1px solid var(--line);border-radius:999px;
  padding:3px 11px;font-size:12px;color:var(--muted);cursor:pointer}
.chip:hover{border-color:var(--accent);color:var(--text)}
.chip.on{background:var(--panel2);border-color:var(--accent);color:var(--text)}
.chip .n{color:var(--faint);margin-left:5px;font-variant-numeric:tabular-nums}

.grid{display:grid;gap:9px;grid-template-columns:minmax(0,1fr)}
.item{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--faint);
  border-radius:9px;padding:11px 13px}
.item.ok{border-left-color:var(--ok)}
.item.warn{border-left-color:var(--warn)}
.item.error{border-left-color:var(--err)}
.item.muted{border-left-color:#3a3a45}
.item .t{font-size:13.5px;font-weight:600;word-break:break-word}
.item .s{color:var(--faint);font-size:11.5px;margin-top:2px;word-break:break-all}
.item .fields{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:9px}
.item .f{font-size:12px;color:var(--muted);display:flex;gap:5px;align-items:baseline;min-width:0}
.item .f .k{color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:.6px}
.item .f .v{font-variant-numeric:tabular-nums;word-break:break-word}
.item .f.ok .v{color:var(--ok)} .item .f.warn .v{color:var(--warn)} .item .f.error .v{color:var(--err)}
.item.link{cursor:pointer;text-align:left;width:100%;font:inherit;color:inherit}
.item.link:hover{border-color:var(--accent)}

/* ---- search result cards: header, matched messages, totals ---- */
.scard{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--faint);
  border-radius:9px;overflow:hidden}
.scard.ok{border-left-color:var(--ok)}
.scard.muted{border-left-color:#3a3a45}
.shead{display:block;width:100%;text-align:left;background:none;border:0;
  padding:11px 13px;cursor:pointer;color:inherit;font:inherit}
.shead:hover{background:var(--panel2)}
.shead .t{font-size:13.5px;font-weight:600;word-break:break-word}
.shead .s{color:var(--faint);font-size:11.5px;margin-top:2px;word-break:break-word}
.sbody{border-top:1px solid var(--line);padding:4px 0}
.smsg{padding:7px 13px;border-bottom:1px solid #22222a}
.smsg:last-child{border-bottom:0}
.smsg.user{background:#15151b}
.smeta{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.smeta .srole{font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:var(--faint)}
.smsg.user .smeta .srole{color:var(--accent)}
.smeta .swhen{font-size:10.5px;color:var(--faint);flex:1;font-variant-numeric:tabular-nums}
.stext{font-size:12.5px;line-height:1.6;color:var(--muted);word-break:break-word}
.stext mark{background:#4a3d16;color:#fde68a;border-radius:2px;padding:0 1px}
.sfoot{border-top:1px solid var(--line);padding:8px 13px;display:flex;
  flex-wrap:wrap;gap:6px 16px;background:#101014}
.sfoot .f{display:flex;gap:5px;align-items:baseline;font-size:11.5px}
.sfoot .k{color:var(--faint);font-size:10px;text-transform:uppercase;letter-spacing:.6px}
.sfoot .v{color:var(--muted);font-variant-numeric:tabular-nums}

/* ---- panels: table layout, one row per item ---- */
.table{border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--panel)}
.trow{display:grid;grid-template-columns:var(--tcols);align-items:center;
  gap:10px;padding:9px 13px;border-bottom:1px solid var(--line);border-left:3px solid transparent}
.trow:last-child{border-bottom:0}
.trow.ok{border-left-color:var(--ok)}
.trow.warn{border-left-color:var(--warn)}
.trow.error{border-left-color:var(--err)}
.trow.muted{border-left-color:#3a3a45}
.trow.thead{background:#101014;border-left-color:transparent;position:sticky;top:0;z-index:1}
.trow.thead .tcell{color:var(--faint);font-size:10.5px;text-transform:uppercase;
  letter-spacing:.7px;font-weight:600}
.tcell{font-size:12.5px;color:var(--muted);min-width:0;overflow:hidden;text-overflow:ellipsis}
.tcell.right{text-align:right;font-variant-numeric:tabular-nums}
.tcell.ok{color:var(--ok)} .tcell.warn{color:var(--warn)} .tcell.error{color:var(--err)}
.tcell.tname{overflow:visible}
.tcell.tname .t{font-size:13.5px;font-weight:600;color:var(--text);word-break:break-word}
.tcell.tname .s{color:var(--faint);font-size:11.5px;margin-top:1px;word-break:break-all}
.tcell.tactions{overflow:visible}
.tcell.tactions .ctlrow{margin:0;justify-content:flex-end;flex-wrap:nowrap}
.ctltoggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.switch.sm{width:32px;height:18px}
.switch.sm .slider:before{width:12px;height:12px;left:3px;top:3px}
.switch.sm input:checked+.slider:before{transform:translateX(14px)}
/* A table cannot usefully shrink below its columns; scroll instead of wrapping. */
@media (max-width:860px){ .table{overflow-x:auto} .trow{min-width:640px} }
/* ---- per-card controls ---- */
.ctlrow{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;padding-top:9px;border-top:1px solid var(--line)}
.btn.ctl{padding:3px 9px;font-size:11.5px;border-radius:6px}
select.ctl{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;
  padding:3px 7px;font:inherit;font-size:11.5px;max-width:190px}
select.ctl:hover{border-color:var(--accent)}

/* ---- tree panel: collapsible groups with lazily loaded rows ---- */
.tree{display:flex;flex-direction:column;gap:8px}
.treegroup{padding:0;overflow:visible}
.treehead{display:flex;align-items:center;gap:10px;padding:9px 12px;flex-wrap:wrap}
.treehead.open{border-bottom:1px solid var(--line)}
.treetoggle{flex:1;min-width:0;display:flex;align-items:center;gap:8px;background:none;border:0;
  color:var(--text);font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;text-align:left;padding:0}
.treetoggle:hover{color:var(--accent)}
.treetoggle .tt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.treehead .fields{display:flex;flex-wrap:wrap;gap:6px 12px}
.treehead .f{font-size:12px;color:var(--muted);display:flex;gap:5px;align-items:baseline}
.treehead .f .k{color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:.6px}
.treehead .f.ok .v{color:var(--ok)} .treehead .f.warn .v{color:var(--warn)}
.treesub{color:var(--faint);font-size:11.5px;padding:0 12px 9px;word-break:break-all}
.treebody{padding:10px 12px 12px}
.dots{background:none;border:1px solid transparent;border-radius:6px;color:var(--muted);
  cursor:pointer;font-size:16px;line-height:1;padding:2px 8px}
.dots:hover{border-color:var(--line);color:var(--text);background:var(--panel2)}

/* ---- model picker with its scratch chat ---- */
.modelrow{align-items:flex-start}
.modelbox{display:flex;flex-direction:column;gap:8px;min-width:0}
.chatbar{display:flex}
.chat{border:1px solid var(--line);border-radius:9px;background:var(--panel2);overflow:hidden}
.chathead{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--line);
  color:var(--faint);font-size:11.5px}
.chathead span{flex:1}
.chatlog{display:flex;flex-direction:column;gap:7px;padding:10px;max-height:320px;overflow-y:auto}
.bubble{max-width:86%;border-radius:10px;padding:7px 10px;font-size:12.5px;line-height:1.45}
.bubble.user{align-self:flex-end;background:var(--accent);color:#08080b}
.bubble.assistant{align-self:flex-start;background:var(--panel);border:1px solid var(--line)}
.bubble.err{border-color:var(--err);color:var(--err)}
.bubble .who{font-size:10px;text-transform:uppercase;letter-spacing:.6px;opacity:.75;margin-bottom:3px;
  display:flex;gap:7px}
.bubble .ms{opacity:.8}
.bubble .msg{white-space:pre-wrap;word-break:break-word}
.chatrow{display:flex;gap:7px;padding:9px 10px;border-top:1px solid var(--line)}
.chatin{flex:1;min-width:0;background:var(--panel);border:1px solid var(--line);border-radius:7px;
  color:var(--text);font:inherit;font-size:12.5px;padding:6px 9px}
.chatin:focus{outline:none;border-color:var(--accent)}

/* ---- search ---- */
.searchrow{display:flex;gap:8px;align-items:center}
.searchin{flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:8px;
  color:var(--text);font:inherit;font-size:13px;padding:7px 11px}
.searchin:focus{outline:none;border-color:var(--accent)}

/* ---- three-dot menu (body-appended so a poll cannot destroy it) ---- */
.menu{position:fixed;z-index:40;min-width:190px;background:var(--panel);border:1px solid var(--line);
  border-radius:9px;padding:5px;box-shadow:0 10px 26px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:2px}
.menuitem{background:none;border:0;border-radius:6px;color:var(--text);cursor:pointer;font:inherit;
  font-size:12.5px;padding:7px 10px;text-align:left}
.menuitem:hover{background:var(--panel2)}
.menuitem.danger{color:var(--err)}
.menusel{background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--text);
  font:inherit;font-size:12.5px;margin:2px;padding:5px 7px}

/* ---- logs ---- */
.logs{background:#101014;border:1px solid var(--line);border-radius:9px;
  max-height:60vh;overflow-y:auto;padding:4px 0}
.logline{display:grid;grid-template-columns:76px 52px 1fr;gap:10px;padding:3px 13px;
  font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5}
.logline:hover{background:var(--panel)}
.logline .ts{color:var(--faint);font-variant-numeric:tabular-nums}
.logline .lv{font-size:10px;text-transform:uppercase;letter-spacing:.6px;padding-top:1px}
.logline .msg{white-space:pre-wrap;word-break:break-word;color:var(--muted)}
/* The combined view adds a plugin column; without a plugin it stays 3-up. */
.logline:has(.who){grid-template-columns:76px 52px 116px 1fr}
.logline .who{color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.logline.info .lv{color:var(--faint)}
.logline.warn .lv{color:var(--warn)} .logline.warn .msg{color:#fde68a}
.logline.error .lv{color:var(--err)} .logline.error .msg{color:var(--delfg)}

/* ---- config editor ---- */
.backlink{background:none;border:0;padding:0 0 8px;cursor:pointer;color:var(--muted);font-size:12.5px}
.backlink:hover{color:var(--accent)}
.filelist{display:grid;gap:8px}
.fileitem{display:flex;align-items:center;gap:12px;width:100%;text-align:left;
  background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:11px 14px;cursor:pointer}
.fileitem:hover{border-color:var(--accent)}
.fileitem .nm{font-family:ui-monospace,Consolas,monospace;font-size:13px;flex:none}
.fileitem .ds{color:var(--faint);font-size:12px;flex:1;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--faint)}
.tag.restart{border-color:#5a4a1e;color:var(--warn)}
.tag.missing{border-color:#4a2a2a;color:var(--delfg)}

.editor{font-family:ui-monospace,Consolas,"Cascadia Mono",monospace;font-size:12.5px;
  line-height:1.5;min-height:420px;resize:vertical;tab-size:2;white-space:pre}
.edhead{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.edhead .path{color:var(--faint);font-size:11.5px;font-family:ui-monospace,Consolas,monospace;
  flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.note{border-radius:8px;padding:9px 12px;font-size:12.5px;margin-bottom:12px}
.note.warn{background:#2a2312;border:1px solid #5a4a1e;color:#fde68a}
.note.err{background:#2a1515;border:1px solid #5b2626;color:var(--delfg)}
.note.ok{background:#12231a;border:1px solid #1e4a2e;color:var(--addfg)}

/* ---- alerts: a stated problem, not a coloured word ----
   A warning has to read as a sentence with room for a heading, the detail and
   a countdown. A pill is a label for a value and gives none of that, so the
   Info tab states conditions in a bordered block instead. */
.alerts{display:grid;gap:10px;margin-bottom:4px}
.alert{display:flex;gap:11px;align-items:flex-start;border-radius:9px;
  padding:11px 13px;border:1px solid;border-left-width:3px}
.alert.warn{background:#2a2312;border-color:#5a4a1e;color:#fde68a}
.alert.error{background:#2a1515;border-color:#5b2626;color:#fca5a5}
.alert.ok{background:#12231a;border-color:#1e4a2e;color:var(--addfg)}
.alert .ico{font-size:14px;line-height:1.35;flex:none}
.alert .body{flex:1;min-width:0}
.alert .atitle{font-weight:600;font-size:13px;word-break:break-word}
.alert .adesc{margin-top:3px;font-size:12px;opacity:.85;word-break:break-word}
.alert .ameta{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:7px;font-size:11.5px;opacity:.8}
.alert .ameta b{font-weight:600;font-variant-numeric:tabular-nums}
.alert .acount{flex:none;font-size:11px;opacity:.75;font-variant-numeric:tabular-nums}

/* diff */
.diffbox{border:1px solid var(--line);border-radius:9px;overflow:hidden;margin:12px 0;
  max-height:400px;overflow-y:auto;background:#101014}
.dline{display:grid;grid-template-columns:44px 44px 16px 1fr;
  font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55}
.dline>span{padding:0 6px}
.dline .ln{color:var(--faint);text-align:right;user-select:none;font-variant-numeric:tabular-nums}
.dline .mk{text-align:center;user-select:none}
.dline .tx{white-space:pre-wrap;word-break:break-word}
.dline.add{background:var(--add)} .dline.add .tx,.dline.add .mk{color:var(--addfg)}
.dline.remove{background:var(--del)} .dline.remove .tx,.dline.remove .mk{color:var(--delfg)}
.dline.same .tx{color:var(--muted)}
.dsum{display:flex;gap:14px;font-size:12px;color:var(--muted);margin-bottom:8px}
.dsum .a{color:var(--addfg)} .dsum .r{color:var(--delfg)}

/* modal */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50;display:flex;
  align-items:center;justify-content:center;padding:24px}
.modalbox{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  width:min(860px,100%);max-height:88vh;display:flex;flex-direction:column}
.modalbox header{padding:16px 20px;border-bottom:1px solid var(--line);
  display:flex;align-items:center;gap:10px}
.modalbox header h3{margin:0;font-size:15px;flex:1}
.modalbody{padding:16px 20px;overflow-y:auto}
.modalfoot{padding:14px 20px;border-top:1px solid var(--line);display:flex;gap:9px;justify-content:flex-end}

#toast{position:fixed;right:18px;bottom:18px;background:var(--panel2);
  border:1px solid var(--accent);border-radius:9px;padding:10px 15px;
  opacity:0;transform:translateY(6px);transition:.18s;pointer-events:none;z-index:60;max-width:380px}
#toast.show{opacity:1;transform:none}
#toast.bad{border-color:#5b2626}
.empty{color:var(--faint);text-align:center;padding:44px 20px}
</style></head>
<body>
<div class="shell">
  <aside class="sidebar" id="sidebar">
    <div class="brand"><h1>opencode plugins</h1><div class="sub" id="brandsub">loading…</div></div>
    <nav class="nav" id="nav"></nav>
    <div class="sidefoot" id="sidefoot"></div>
  </aside>
  <div class="scrim" id="scrim"></div>
  <main class="content">
    <div class="topbar">
      <button class="hamburger" id="burger" aria-label="Menu">☰</button>
      <strong id="mobtitle">Home</strong>
    </div>
    <div class="pane" id="pane"><div class="empty">loading…</div></div>
  </main>
</div>
<div id="toast"></div>
<script>
const $ = (id) => document.getElementById(id)
const pane = $("pane"), nav = $("nav")
let DATA = { plugins: [], files: [], configDir: "", marketplace: {} }
// Opens on the plugin manager, which carries the opencode-wide config.
let view = { name: "plugin", arg: "plugin-manager" }
let editor = null   // { name, file, original, draft }
let tab = "info"    // active tab on a plugin page
const filters = {}  // panel key -> selected group, per plugin
const logLevel = {} // plugin id -> minimum log level shown
const sections = {} // "<plugin>:<group>" -> open, so a refresh keeps it open
const expanded = {} // "<plugin>:<panel>:<group>" -> open, for tree panels
const treeRows = {} // same key -> { loading, items, error }, filled on expand
const searchState = {} // plugin id -> { query, items, loading, error }
const chatOpen = {}    // "<plugin>:<field>" -> whether the chat window is open
const chatState = {}   // same key -> { turns, sending }
let openMenu = null // the open three-dot menu, appended to document.body

/* -------------------------------- routing -------------------------------- */
/**
 * The URL is the source of truth for what is on screen.
 *
 * Routes are /plugin/<id>[/<tab>], /config/<file> and / (which resolves to
 * the plugin manager). Keeping them real URLs means a page can be
 * bookmarked, reloaded, opened in a second tab and navigated with back/forward
 * — none of which worked while the view lived only in a variable.
 */
const PLUGIN_TABS = ["info", "logging", "settings", "version"]

function parseRoute(pathname) {
  const parts = decodeURI(pathname).split("/").filter(Boolean)
  if (parts[0] === "plugin" && parts[1]) {
    const wanted = parts[2]
    return { view: { name: "plugin", arg: parts[1] }, tab: PLUGIN_TABS.includes(wanted) ? wanted : "info" }
  }
  if (parts[0] === "config" && parts[1]) {
    return { view: { name: "config", arg: parts.slice(1).join("/") }, tab: "info" }
  }
  if (parts[0] === "session" && parts[1]) {
    return { view: { name: "session", arg: parts[1] }, tab: "info" }
  }
  return { view: { name: "plugin", arg: "plugin-manager" }, tab: "info" }
}

function routePath(v = view, t = tab) {
  if (v.name === "config") return "/config/" + encodeURIComponent(v.arg)
  if (v.name === "session") return "/session/" + encodeURIComponent(v.arg)
  // The default tab is left off so the common URL stays short.
  return "/plugin/" + encodeURIComponent(v.arg) + (t && t !== "info" ? "/" + t : "")
}

/** Point the address bar at the current view without reloading the page. */
function syncURL(replace) {
  const next = routePath()
  if (location.pathname === next) return
  history[replace ? "replaceState" : "pushState"]({}, "", next)
}

let toastTimer
function toast(msg, bad) {
  const t = $("toast")
  t.textContent = msg
  t.className = "show" + (bad ? " bad" : "")
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.className = ""), 2600)
}

function el(tag, props, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue
    if (k === "class") n.className = v
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v)
    else if (k in n) n[k] = v
    else n.setAttribute(k, v)
  }
  // Flatten all the way down, not one level.
  //
  // Views compose naturally into nested arrays — a tab body holding a list of
  // panels, a panel holding a list of rows — and append has no idea what to do
  // with an array, so it stringifies it: an element two levels deep renders as
  // the literal text "[object HTMLElement]" instead of appearing. That is
  // silent and looks like the data was missing rather than the markup wrong,
  // so this flattens to whatever depth the caller happened to build.
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid)
  return n
}

async function api(path, opts) {
  const r = await fetch(path, opts)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status))
  return data
}
const post = (path, body) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

/* ------------------------------ navigation ------------------------------ */
const NARROW = () => window.matchMedia("(max-width:860px)").matches
function closeNav() { document.body.classList.remove("nav-open") }
$("burger").onclick = () => document.body.classList.toggle("nav-open")
$("scrim").onclick = closeNav

function go(name, arg, nextTab) {
  // Leaving the editor with unsaved work should be deliberate.
  if (editor && editor.draft !== editor.original && !(name === "config" && arg === editor.name)) {
    if (!confirm("Discard unsaved changes to " + editor.name + "?")) return
  }
  if (name !== "config") editor = null
  // Each page opens on its first tab rather than inheriting the last one.
  if (name !== view.name || arg !== view.arg) tab = nextTab ?? "info"
  else if (nextTab) tab = nextTab
  view = { name, arg }
  syncURL(false)
  if (NARROW()) closeNav()
  render()
  // Render immediately from cache, then refresh just this view's data.
  void loadView()
}

/** Back/forward must move between pages, not leave the app. */
addEventListener("popstate", () => {
  const route = parseRoute(location.pathname)
  editor = route.view.name === "config" && editor?.name === route.view.arg ? editor : null
  view = route.view
  tab = route.tab
  render()
  void loadView()
})

function renderNav() {
  // Real anchors, so middle-click and "open in new tab" work and the browser
  // shows the target on hover. The click handler keeps it a soft navigation.
  const item = (label, nm, arg, opts = {}) =>
    el("a", {
      class: "navitem" + (view.name === nm && view.arg === arg ? " active" : ""),
      href: routePath({ name: nm, arg }, "info"),
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        go(nm, arg)
      },
    },
      opts.dot !== undefined ? el("span", { class: "dot " + (opts.dot ? "on" : "off") }) : el("span", { class: "dot" }),
      el("span", { class: "nm" }, label),
      opts.badge ? el("span", { class: "badge" }, opts.badge) : null)

  // The sidebar is the plugin list, nothing else. Config files belong to
  // opencode itself, so they live on the plugin manager's Info tab.
  nav.replaceChildren(...DATA.plugins.map((p) => item(p.title, "plugin", p.id, { dot: p.enabled })))

  const on = DATA.plugins.filter((p) => p.enabled).length
  $("brandsub").textContent = on + " of " + DATA.plugins.length + " enabled"
  $("sidefoot").textContent = DATA.configDir
  $("mobtitle").textContent =
    view.name === "plugin" ? (DATA.plugins.find((p) => p.id === view.arg)?.title ?? "Plugin")
      : view.name === "config" ? view.arg : "Plugins"
}

/* ------------------------------- widgets -------------------------------- */
function statusPills(items) {
  return el("div", { class: "pills" },
    items.map((s) => el("span", { class: "pill " + (s.tone || "") }, s.label + ": ", el("b", {}, String(s.value)))))
}

function field(plugin, f) {
  const commit = async (value) => {
    try {
      await post("/api/plugins/" + encodeURIComponent(plugin.id) + "/settings", { key: f.key, value })
      toast("saved")
      await load()
    } catch (e) { toast(e.message, true); await load() }
  }
  let input
  if (f.type === "boolean") {
    input = el("label", { class: "switch" },
      el("input", { type: "checkbox", checked: f.value, onchange: (e) => commit(e.target.checked) }),
      el("span", { class: "slider" }))
  } else if (f.type === "select") {
    input = el("select", { onchange: (e) => commit(e.target.value) },
      f.options.map((o) => el("option", { value: o.value, selected: o.value === f.value }, o.label)))
  } else if (f.type === "model") {
    // The picker and its chat live in one row, because choosing a model and
    // checking it answers usefully are the same task.
    return el("div", { class: "row modelrow" },
      el("label", { title: f.description || "" }, f.label),
      el("div", { class: "modelbox" },
        el("select", { onchange: (e) => commit(e.target.value) },
          f.options.map((o) => el("option", { value: o.value, selected: o.value === f.value }, o.label))),
        chatWindow(plugin, f)))
  } else if (f.type === "number") {
    input = el("input", { type: "number", value: String(f.value), min: f.min, max: f.max,
      onchange: (e) => commit(Number(e.target.value)) })
  } else if (f.type === "action") {
    input = el("button", {
      class: "btn" + (f.danger ? " danger" : ""),
      onclick: async (e) => {
        // A prompt-carrying action collects its argument before running, which
        // is what lets "add subscriber" live in the settings list.
        let arg
        if (f.prompt) {
          arg = window.prompt(f.prompt, f.value || "")
          if (arg === null) return
        }
        e.target.disabled = true
        try {
          const r = await post("/api/plugins/" + encodeURIComponent(plugin.id) + "/action",
            { action: f.action, value: arg })
          toast(r.message || "done")
        } catch (err) { toast(err.message, true) }
        e.target.disabled = false
        await load()
      },
    }, f.label)
    // An action's label is on the button, so the row label stays empty.
    return el("div", { class: "row" }, el("label", { title: f.description || "" }, ""), input)
  } else if (f.multiline) {
    input = el("textarea", { rows: 4, value: f.value, placeholder: f.placeholder || "",
      onchange: (e) => commit(e.target.value) })
  } else {
    input = el("input", { type: f.secret ? "password" : "text", value: f.value, placeholder: f.placeholder || "",
      onchange: (e) => commit(e.target.value) })
  }
  return el("div", { class: "row" }, el("label", { title: f.description || "" }, f.label), input)
}

/**
 * A throwaway conversation with the selected model.
 *
 * Each exchange runs in a scratch session the server deletes afterwards, and
 * the transcript lives only in memory, so nothing said here is saved. It is
 * collapsed until asked for: most visits to a settings page are not about
 * testing a model.
 */
function chatWindow(plugin, f) {
  const key = plugin.id + ":" + f.key
  const open = chatOpen[key] === true
  const state = chatState[key] || { turns: [], sending: false }

  if (!open) {
    return el("div", { class: "chatbar" },
      el("button", {
        class: "btn",
        type: "button",
        disabled: !f.value,
        title: f.value ? "" : "Select a model first",
        onclick: () => { chatOpen[key] = true; loadChat(plugin, f); },
      }, f.value ? "Test this model" : "Select a model to test"))
  }

  const box = el("input", {
    type: "text",
    class: "chatin",
    placeholder: "Ask the model something…",
    onkeydown: (e) => {
      if (e.key !== "Enter" || e.shiftKey) return
      e.preventDefault()
      sendChat(plugin, f, e.target.value)
      e.target.value = ""
    },
  })

  const log = el("div", { class: "chatlog" },
    state.turns.length
      ? state.turns.map((t) =>
          el("div", { class: "bubble " + t.role + (t.error ? " err" : "") },
            el("div", { class: "who" },
              t.role === "user" ? "you" : (f.value || "model"),
              t.elapsedMs ? el("span", { class: "ms" }, (t.elapsedMs / 1000).toFixed(1) + "s") : null),
            el("div", { class: "msg" }, t.error ? t.error : t.text)))
      : el("div", { class: "empty" }, "Nothing sent yet. Messages here are never saved."),
    state.sending ? el("div", { class: "bubble assistant" }, el("div", { class: "msg" }, "…")) : null)

  return el("div", { class: "chat" },
    el("div", { class: "chathead" },
      el("span", {}, "Scratch conversation — not saved"),
      el("button", {
        class: "btn ctl",
        type: "button",
        onclick: () => { void clearChat(plugin, f) },
      }, "Clear"),
      el("button", {
        class: "btn ctl",
        type: "button",
        onclick: () => { chatOpen[key] = false; render() },
      }, "Close")),
    log,
    el("div", { class: "chatrow" },
      box,
      el("button", {
        class: "btn primary",
        type: "button",
        disabled: state.sending,
        onclick: () => {
          const input = box.value
          box.value = ""
          sendChat(plugin, f, input)
        },
      }, state.sending ? "…" : "Send")))
}

/** Read the server's copy of the scratch transcript. */
function loadChat(plugin, f) {
  const key = plugin.id + ":" + f.key
  api("/api/plugins/" + encodeURIComponent(plugin.id) + "/chat")
    .then((r) => {
      chatState[key] = { turns: r.turns || [], sending: false }
      render()
    })
    .catch(() => { chatState[key] = { turns: [], sending: false }; render() })
}

function sendChat(plugin, f, message) {
  const text = (message || "").trim()
  if (!text) return

  const key = plugin.id + ":" + f.key
  const prior = (chatState[key] || { turns: [] }).turns
  // Echo immediately: a model can take seconds and the message should not
  // vanish while it thinks.
  chatState[key] = { turns: [...prior, { role: "user", text, at: Date.now() }], sending: true }
  render()

  post("/api/plugins/" + encodeURIComponent(plugin.id) + "/chat", { action: f.chatAction, message: text })
    .then((r) => { chatState[key] = { turns: r.turns || [], sending: false } })
    .catch((e) => {
      chatState[key] = {
        turns: [...chatState[key].turns, { role: "assistant", text: "", at: Date.now(), error: e.message }],
        sending: false,
      }
    })
    .then(() => { if (view.name === "plugin" && view.arg === plugin.id) render() })
}

function clearChat(plugin, f) {
  const key = plugin.id + ":" + f.key
  return post("/api/plugins/" + encodeURIComponent(plugin.id) + "/chat/clear", {})
    .then(() => { chatState[key] = { turns: [], sending: false }; render() })
    .catch((e) => toast(e.message, true))
}

/** Whether a field's "when" condition is met by the plugin's current values. */
function fieldVisible(plugin, f) {
  if (!f.when) return true
  const other = plugin.settings.find((x) => x.key === f.when.key)
  return other ? f.when.equals.includes(String(other.value)) : true
}

/**
 * Settings as ungrouped rows followed by one collapsible section per group.
 *
 * Open sections are remembered per plugin across the 5s refresh, so editing a
 * field does not collapse the section being edited.
 */
function settingsView(plugin) {
  const visible = plugin.settings.filter((f) => fieldVisible(plugin, f))
  const loose = visible.filter((f) => !f.group)
  const groups = []
  for (const f of visible) {
    if (!f.group) continue
    let entry = groups.find((g) => g.name === f.group)
    if (!entry) groups.push((entry = { name: f.group, fields: [], expanded: false }))
    entry.fields.push(f)
    if (f.expanded) entry.expanded = true
  }

  const openKey = (name) => plugin.id + ":" + name
  const nodes = []
  if (loose.length) {
    nodes.push(el("div", { class: "card" }, el("div", { class: "sect" }, el("h4", {}, "Settings"), loose.map((f) => field(plugin, f)))))
  }
  for (const g of groups) {
    const key = openKey(g.name)
    // Default closed unless the plugin asked otherwise; the user's choice wins.
    const open = sections[key] === undefined ? g.expanded : sections[key]
    nodes.push(el("div", { class: "card" },
      el("button", {
        class: "grouphead" + (open ? " open" : ""),
        onclick: () => { sections[key] = !open; render() },
      }, el("span", { class: "caret" }, open ? "▾" : "▸"), g.name,
        el("span", { class: "count" }, String(g.fields.length))),
      open ? el("div", { class: "sect" }, g.fields.map((f) => field(plugin, f))) : null))
  }
  return nodes.length ? nodes : [el("div", { class: "empty" }, "This plugin has no settings.")]
}

function toggleSwitch(p) {
  return el("label", { class: "switch", title: p.toggleable ? "enable / disable" : "always on" },
    el("input", {
      type: "checkbox", checked: p.enabled, disabled: !p.toggleable,
      onchange: async (e) => {
        const want = e.target.checked
        try {
          await post("/api/plugins/" + encodeURIComponent(p.id) + "/enabled", { enabled: want })
          toast(want ? "enabled" : "disabled")
        } catch (err) { toast(err.message, true) }
        await load()
      },
    }),
    el("span", { class: "slider" }))
}

/** Run a plugin action. Returns whether it succeeded, so a control can revert. */
async function runAction(p, key, button, value) {
  if (button) button.disabled = true
  let ok = true
  try {
    const body = { action: key }
    // Only sent when present, so an action that takes no input still receives
    // undefined rather than an empty string it would have to special-case.
    if (value !== undefined && value !== null) body.value = value
    const r = await post("/api/plugins/" + encodeURIComponent(p.id) + "/action", body)
    toast(r.message || "done")
  } catch (err) {
    ok = false
    toast(err.message, true)
  }
  if (button) button.disabled = false
  await load()
  return ok
}

function actionRow(p) {
  // An action needing an argument is only meaningful from the control that
  // supplies it; as a bare button it acts on nothing.
  const runnable = p.actions.filter((a) => !a.hidden)
  if (!runnable.length) return null
  return el("div", { class: "sect" },
    el("h4", {}, "Actions"),
    el("div", { class: "btnrow" }, runnable.map((a) =>
      el("button", { class: "btn", onclick: (e) => runAction(p, a.key, e.target) }, a.label))))
}

/** "3 min ago" — panels carry a timestamp so stale data is obvious. */
function ago(at) {
  if (!at) return "never updated"
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return "updated " + s + "s ago"
  if (s < 3600) return "updated " + Math.round(s / 60) + " min ago"
  return "updated " + Math.round(s / 3600) + "h ago"
}

/**
 * Controls rendered on a panel card.
 *
 * Each runs one of the plugin's actions with the row's own input, so a card
 * can be acted on where it is read instead of through a matching tool call.
 * Clicks are stopped from bubbling so a control inside a linked card does not
 * also navigate.
 */
function panelControls(p, it) {
  if (!(it.controls || []).length) return null

  return el("div", { class: "ctlrow", onclick: (e) => e.stopPropagation() },
    it.controls.map((c) => {
      if (c.type === "select") {
        return el("select", {
          class: "ctl",
          title: c.label,
          onchange: async (e) => {
            const value = e.target.value
            if (value === c.value) return
            await runAction(p, c.action, null, (c.input ? c.input + "=" : "") + value)
          },
        }, c.options.map((o) => el("option", { value: o.value, selected: o.value === c.value }, o.label)))
      }

      if (c.type === "prompt") {
        return el("button", {
          class: "btn ctl",
          onclick: async (e) => {
            const value = prompt(c.prompt, c.value ?? "")
            if (value === null) return
            await runAction(p, c.action, e.target, (c.input ? c.input + "=" : "") + value)
          },
        }, c.label)
      }

      // A toggle outside a table column still renders as a switch, labelled.
      if (c.type === "toggle") {
        return el("label", { class: "ctltoggle", title: c.label },
          rowToggle(p, it, c), el("span", {}, c.label))
      }

      return el("button", {
        class: "btn ctl" + (c.danger ? " danger" : ""),
        onclick: async (e) => {
          if (c.confirm && !confirm(c.confirm)) return
          await runAction(p, c.action, e.target, c.input)
        },
      }, c.label)
    }))
}

/** One panel item as a card: title, optional subtitle, and its fields. */
function panelItem(p, it) {
  // A linked card is a button so it is keyboard-reachable, not just clickable.
  const tag = it.link ? "button" : "div"
  return el(tag, {
    class: "item " + (it.tone || "") + (it.link ? " link" : ""),
    onclick: it.link ? () => go(it.link.view, it.link.arg ?? null) : null,
  },
    el("div", { class: "t" }, it.title),
    it.subtitle ? el("div", { class: "s" }, it.subtitle) : null,
    (it.fields || []).length
      ? el("div", { class: "fields" }, it.fields.map((f) =>
          el("div", { class: "f " + (f.tone || "") },
            el("span", { class: "k" }, f.label),
            el("span", { class: "v" }, f.value))))
      : null,
    panelControls(p, it))
}

/**
 * The search box on a plugin's Info tab.
 *
 * Submitting, not typing, runs the query: a full-text scan is far too
 * expensive to fire on every keystroke.
 */
function searchBox(p) {
  const state = searchState[p.id] || { query: "", items: [], loading: false, error: null }

  const input = el("input", {
    type: "text",
    class: "searchin",
    value: state.query,
    placeholder: p.search.placeholder || "Search…",
    // Re-render replaces this node, so the caret position has to be restored.
    onkeydown: (e) => { if (e.key === "Enter") runSearch2(p, e.target.value) },
  })

  return el("section", { class: "panel" },
    el("form", {
      class: "searchrow",
      onsubmit: (e) => { e.preventDefault(); runSearch2(p, input.value) },
    },
      input,
      el("button", { class: "btn primary", type: "submit" }, "Search"),
      state.query
        ? el("button", {
            class: "btn",
            type: "button",
            onclick: () => { delete searchState[p.id]; render() },
          }, "Clear")
        : null))
}

/**
 * Text with the matched ranges marked.
 *
 * The ranges arrive from the server, which parsed the query and selected the
 * rows; re-finding the terms here would be a second implementation of quoting
 * and case-folding, free to disagree with the one that produced the result.
 * Marks are built as text nodes, so a transcript containing markup is shown
 * rather than interpreted.
 */
function highlight(text, ranges) {
  if (!(ranges || []).length) return el("span", {}, text)

  const out = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) out.push(text.slice(cursor, r.start))
    out.push(el("mark", {}, text.slice(r.start, r.end)))
    cursor = r.end
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return el("span", {}, out)
}

/**
 * One search result: session header, matched messages, then its totals.
 *
 * A flat list of sessions answers "which session" but not "where in it", which
 * is the question a search is usually really asking. Showing the matching
 * messages inline — highlighted, each forkable — means the answer is on the
 * page instead of two navigations away.
 */
function searchCard(p, it) {
  const hits = it.hits || []
  const shown = hits.length
  const total = it.matchCount ?? shown

  const body = shown
    ? el("div", { class: "sbody" },
        hits.map((h) =>
          el("div", { class: "smsg " + (h.role === "user" ? "user" : "assistant") },
            el("div", { class: "smeta" },
              el("span", { class: "srole" }, h.role),
              h.at ? el("span", { class: "swhen" }, new Date(h.at).toISOString().slice(0, 16).replace("T", " ")) : null,
              // Forking needs the message, which only this row knows.
              el("button", {
                class: "btn ctl",
                type: "button",
                title: "Start a new session containing everything up to this message",
                onclick: (e) => {
                  e.stopPropagation()
                  runAction(p, "fork-session", e.target, it.sessionID + "=" + h.messageID)
                },
              }, "Fork here")),
            el("div", { class: "stext" }, highlight(h.snippet, h.ranges)))))
    : null

  // Only what the session actually records: a zero cost is usually "not
  // priced", and printing $0.00 would assert something the row does not say.
  const footer = []
  if (it.tokens) footer.push(el("span", { class: "f" }, el("span", { class: "k" }, "tokens"), el("span", { class: "v" }, formatCount(it.tokens))))
  if (it.cost) footer.push(el("span", { class: "f" }, el("span", { class: "k" }, "cost"), el("span", { class: "v" }, "$" + it.cost.toFixed(2))))
  if (it.model) footer.push(el("span", { class: "f" }, el("span", { class: "k" }, "model"), el("span", { class: "v" }, it.model)))
  if (total > shown) footer.push(el("span", { class: "f" }, el("span", { class: "k" }, "more"), el("span", { class: "v" }, String(total - shown) + " further matches")))

  return el("div", { class: "scard " + (it.tone || "") },
    el("button", {
      class: "shead",
      type: "button",
      onclick: () => go("session", it.sessionID),
    },
      el("div", { class: "t" }, it.title),
      it.subtitle ? el("div", { class: "s" }, it.subtitle) : null,
      el("div", { class: "fields" }, (it.fields || []).map((f) =>
        el("div", { class: "f " + (f.tone || "") },
          el("span", { class: "k" }, f.label),
          el("span", { class: "v" }, f.value))))),
    body,
    footer.length ? el("div", { class: "sfoot" }, footer) : null)
}

/** "18.1M", "8.0k" — a raw token count is unreadable at this scale. */
function formatCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

/** Results of the active search, replacing the panels while one is running. */
function searchResults(p, state) {
  if (state.loading) return el("div", { class: "empty" }, "searching…")
  if (state.error) return el("div", { class: "note err" }, state.error)

  const matched = state.items.reduce((n, it) => n + (it.matchCount ?? 0), 0)

  return el("section", { class: "panel" },
    el("div", { class: "phead" },
      el("h3", {}, state.items.length ? state.items.length + " sessions" : "No results"),
      el("span", { class: "when" },
        matched ? matched + ' matching messages for "' + state.query + '"' : "for " + state.query)),
    state.items.length
      ? el("div", { class: "grid" }, state.items.map((it) =>
          it.hits ? searchCard(p, it) : panelItem(p, it)))
      : el("div", { class: "empty" }, "Nothing matched " + state.query + "."))
}

function runSearch2(p, query) {
  const q = (query || "").trim()
  if (!q) { delete searchState[p.id]; render(); return }

  searchState[p.id] = { query: q, items: [], loading: true, error: null }
  render()

  api("/api/plugins/" + encodeURIComponent(p.id) + "/search?q=" + encodeURIComponent(q))
    .then((r) => { searchState[p.id] = { query: q, items: r.items || [], loading: false, error: null } })
    .catch((e) => { searchState[p.id] = { query: q, items: [], loading: false, error: e.message } })
    .then(() => { if (view.name === "plugin" && view.arg === p.id) render() })
}

/**
 * A three-dot menu for one tree group.
 *
 * Rendered into document.body rather than inside the header, because the
 * header is rebuilt by every poll and is clipped by the card's overflow. The
 * menu closes on any outside click, on Escape, and after running an entry.
 */
function groupMenu(p, panel, group, anchor) {
  closeMenu()

  const run = async (entry, value) => {
    closeMenu()
    if (entry.confirm && !confirm(entry.confirm)) return
    const arg = value === undefined ? entry.input : (entry.input ? entry.input + "=" : "") + value
    await runAction(p, entry.action, null, arg)
  }

  const menu = el("div", { class: "menu" },
    (group.menu || []).map((entry) => {
      if (entry.type === "prompt") {
        return el("button", {
          class: "menuitem" + (entry.danger ? " danger" : ""),
          onclick: () => {
            const value = prompt(entry.prompt, entry.value ?? "")
            if (value === null) return
            void run(entry, value)
          },
        }, entry.label)
      }

      if (entry.type === "select") {
        return el("select", {
          class: "menusel",
          title: entry.label,
          onchange: (e) => { if (e.target.value) void run(entry, e.target.value) },
        },
          el("option", { value: "" }, entry.label),
          entry.options.map((o) => el("option", { value: o.value }, o.label)))
      }

      return el("button", {
        class: "menuitem" + (entry.danger ? " danger" : ""),
        onclick: () => void run(entry),
      }, entry.label)
    }))

  // Positioned against the button, then nudged back inside the viewport.
  const box = anchor.getBoundingClientRect()
  menu.style.top = Math.round(box.bottom + 4) + "px"
  menu.style.left = Math.round(box.left) + "px"
  document.body.append(menu)
  const own = menu.getBoundingClientRect()
  if (own.right > window.innerWidth - 8) {
    menu.style.left = Math.max(8, Math.round(window.innerWidth - own.width - 8)) + "px"
  }

  openMenu = menu
  setTimeout(() => {
    document.addEventListener("click", closeMenu, { once: true })
    document.addEventListener("keydown", escMenu)
  }, 0)
}

function closeMenu() {
  if (!openMenu) return
  openMenu.remove()
  openMenu = null
  document.removeEventListener("keydown", escMenu)
}

function escMenu(e) {
  if (e.key === "Escape") closeMenu()
}

/**
 * A tree panel: collapsible groups whose rows load on first expand.
 *
 * Open state and loaded rows both live at module scope, because the dashboard
 * polls and rebuilds this subtree wholesale every few seconds.
 */
function treeView(p, panel) {
  const groups = panel.groups || []
  if (!groups.length) return el("div", { class: "empty" }, panel.empty || "Nothing to show.")

  return el("div", { class: "tree" }, groups.map((g) => {
    const key = p.id + ":" + panel.key + ":" + g.id
    const open = expanded[key] === undefined ? g.expanded === true : expanded[key]
    const cached = treeRows[key]

    const head = el("div", { class: "treehead" + (open ? " open" : "") },
      el("button", {
        class: "treetoggle",
        onclick: () => {
          expanded[key] = !open
          if (!open && !treeRows[key]) loadChildren(p, panel, g.id, key)
          render()
        },
      },
        el("span", { class: "caret" }, open ? "▾" : "▸"),
        el("span", { class: "tt" }, g.title),
        g.count !== undefined ? el("span", { class: "count" }, String(g.count)) : null),
      g.fields && g.fields.length
        ? el("div", { class: "fields" }, g.fields.map((f) =>
            el("div", { class: "f " + (f.tone || "") },
              el("span", { class: "k" }, f.label),
              el("span", { class: "v" }, f.value))))
        : null,
      (g.menu || []).length
        ? el("button", {
            class: "dots",
            title: "Project actions",
            onclick: (e) => { e.stopPropagation(); groupMenu(p, panel, g, e.currentTarget) },
          }, "⋯")
        : null)

    let body = null
    if (open) {
      if (!cached || cached.loading) body = el("div", { class: "empty" }, "loading…")
      else if (cached.error) body = el("div", { class: "note err" }, cached.error)
      else if (!cached.items.length) body = el("div", { class: "empty" }, "No sessions.")
      else body = el("div", { class: "grid" }, cached.items.map((it) => panelItem(p, it)))
    }

    return el("div", { class: "card treegroup" + (g.tone ? " " + g.tone : "") },
      head,
      g.subtitle ? el("div", { class: "treesub" }, g.subtitle) : null,
      body ? el("div", { class: "treebody" }, body) : null)
  }))
}

/** Fetch one group's rows, then re-render if that group is still on screen. */
function loadChildren(p, panel, groupID, key) {
  treeRows[key] = { loading: true, items: [], error: null }
  const path = "/api/plugins/" + encodeURIComponent(p.id) + "/panel/" + encodeURIComponent(panel.key) +
    "/children?group=" + encodeURIComponent(groupID)
  api(path)
    .then((r) => { treeRows[key] = { loading: false, items: r.items || [], error: null } })
    .catch((e) => { treeRows[key] = { loading: false, items: [], error: e.message } })
    .then(() => { if (view.name === "plugin" && view.arg === p.id) render() })
}

function panelView(p, panel) {
  const key = p.id + ":" + panel.key
  const act0 = panel.action ? p.actions.find((a) => a.key === panel.action) : null
  if (panel.type === "tree") {
    return el("section", { class: "panel" },
      el("div", { class: "phead" },
        el("h3", {}, panel.title),
        el("span", { class: "when" }, panel.updatedAt !== undefined ? ago(panel.updatedAt) : ""),
        act0 ? el("button", { class: "btn primary", onclick: (e) => runAction(p, act0.key, e.target) }, act0.label) : null),
      panel.description ? el("p", { class: "pdesc" }, panel.description) : null,
      treeView(p, panel))
  }

  const active = filters[key] || panel.defaultFilter || "all"
  const items = active === "all" ? panel.items : panel.items.filter((it) => it.group === active)

  const chips = (panel.filters || []).length
    ? el("div", { class: "chips" },
        ["all", ...panel.filters].map((g) => {
          const n = g === "all" ? panel.items.length : panel.items.filter((it) => it.group === g).length
          return el("button", {
            class: "chip" + (active === g ? " on" : ""),
            onclick: () => { filters[key] = g; render() },
          }, g, el("span", { class: "n" }, String(n)))
        }))
    : null

  const act = panel.action ? p.actions.find((a) => a.key === panel.action) : null

  return el("section", { class: "panel" },
    el("div", { class: "phead" },
      el("h3", {}, panel.title),
      el("span", { class: "when" }, panel.updatedAt !== undefined ? ago(panel.updatedAt) : ""),
      act ? el("button", { class: "btn primary", onclick: (e) => runAction(p, act.key, e.target) }, act.label) : null),
    panel.description ? el("p", { class: "pdesc" }, panel.description) : null,
    chips,
    items.length
      ? panel.type === "table"
        ? tableView(p, panel, items)
        : panel.type === "alerts"
          ? alertsView(p, items)
          : el("div", { class: "grid" }, items.map((it) => panelItem(p, it)))
      : el("div", { class: "empty" }, panel.empty || "Nothing to show."))
}

/**
 * A panel as alerts: each item stated as a bordered block.
 *
 * Used where the items are problems rather than data. A pill shows a value in
 * a colour, which is enough for "queued: 3" and useless for "gpt-5.5 usage
 * limit exceeded, retries at 01:11" — that needs a heading, a sentence and its
 * own metrics, laid out so it reads as a statement instead of a label.
 */
function alertsView(p, items) {
  const icon = { error: "✕", warn: "!", ok: "✓" }
  return el("div", { class: "alerts" }, items.map((it) => {
    const tone = it.tone === "error" ? "error" : it.tone === "ok" ? "ok" : "warn"
    return el("div", { class: "alert " + tone },
      el("span", { class: "ico" }, icon[tone]),
      el("div", { class: "body" },
        el("div", { class: "atitle" }, it.title),
        it.subtitle ? el("div", { class: "adesc" }, it.subtitle) : null,
        (it.fields || []).length
          ? el("div", { class: "ameta" }, it.fields.map((f) =>
              el("span", {}, f.label + ": ", el("b", {}, f.value))))
          : null,
        panelControls(p, it)),
      it.count ? el("span", { class: "acount" }, "×" + it.count) : null)
  }))
}

/**
 * A panel as a table: one row per item, columns shared by every row.
 *
 * The right shape for a homogeneous list. Cards repeat each field's label on
 * every item, so comparing one attribute across rows means re-finding that
 * label each time; a table puts it in the header once and lines the values up
 * underneath. Row controls go in a trailing column so the actions available on
 * a row sit beside it rather than below.
 */
function tableView(p, panel, items) {
  const columns = panel.columns || []
  const hasControls = items.some((it) => (it.controls || []).length)

  // Controls that name a column are cells, not buttons in the actions cell:
  // six mute switches belong under six headings, not in a row of toggles.
  const columnControl = (it, label) =>
    (it.controls || []).find((c) => c.type === "toggle" && c.column === label)

  // The name column takes the slack; the rest size to their content so a
  // column of switches does not sprawl across half the table.
  const template =
    "minmax(140px,1.6fr) " +
    columns.map(() => "minmax(60px,max-content)").join(" ") +
    (hasControls ? " max-content" : "")

  const head = el("div", { class: "trow thead", style: "--tcols:" + template },
    el("div", { class: "tcell tname" }, "name"),
    columns.map((c) => el("div", { class: "tcell" + (c.align === "right" ? " right" : "") }, c.label)),
    hasControls ? el("div", { class: "tcell tactions" }, "") : null)

  const rows = items.map((it) => {
    const byLabel = new Map((it.fields || []).map((f) => [f.label, f]))
    // Controls bound to a column are rendered in it; the rest are row actions.
    const actions = (it.controls || []).filter((c) => !(c.type === "toggle" && c.column))

    return el("div", { class: "trow " + (it.tone || ""), style: "--tcols:" + template },
      el("div", { class: "tcell tname" },
        el("div", { class: "t" }, it.title),
        it.subtitle ? el("div", { class: "s" }, it.subtitle) : null),
      columns.map((c) => {
        const toggle = columnControl(it, c.label)
        if (toggle) {
          return el("div", { class: "tcell" + (c.align === "right" ? " right" : "") },
            rowToggle(p, it, toggle))
        }
        const f = byLabel.get(c.label)
        return el("div", {
          class: "tcell" + (c.align === "right" ? " right" : "") + (f?.tone ? " " + f.tone : ""),
          title: f ? String(f.value) : "",
        }, f ? String(f.value) : "—")
      }),
      hasControls
        ? el("div", { class: "tcell tactions" },
            actions.length ? panelControls(p, { ...it, controls: actions }) : null)
        : null)
  })

  return el("div", { class: "table" }, head, rows)
}

/** A checkbox cell that sends its new state to the plugin. */
function rowToggle(p, it, c) {
  const input = el("input", {
    type: "checkbox",
    checked: c.value,
    title: c.label,
    onchange: async (e) => {
      const want = e.target.checked
      // Send the state being requested, so the action never has to guess what
      // the row looked like when it was clicked.
      const ok = await runAction(p, c.action, null, (c.input ? c.input + "=" : "") + String(want))
      if (!ok) e.target.checked = !want
    },
  })
  return el("label", { class: "switch sm", onclick: (e) => e.stopPropagation() },
    input, el("span", { class: "slider" }))
}

/**
 * The Version tab: the installed version, its channel, and what the
 * marketplace offers. A beta is never published, so it is reported as
 * unreleased rather than as being behind.
 */
function versionView(p) {
  const v = p.version
  if (!v) {
    return el("div", { class: "empty" },
      "This plugin is not listed in versions.json. Every plugin must declare a managed version.")
  }

  const mk = DATA.marketplace || {}
  const cell = (k, val) => el("div", { class: "vcell" }, el("div", { class: "k" }, k), el("div", { class: "v" }, val))

  const state = v.updateAvailable
    ? el("span", { class: "pill warn" }, "update available: ", el("b", {}, v.available))
    : v.unreleased
      ? el("span", { class: "pill" }, "local beta — not published")
      : v.available
        ? el("span", { class: "pill ok" }, "up to date")
        : el("span", { class: "pill" }, "no published release found")

  return [
    el("section", { class: "panel" },
      el("div", { class: "phead" },
        el("h3", {}, "Installed"),
        el("span", { class: "when" }, mk.checkedAt ? ago(mk.checkedAt) : "never checked"),
        el("button", { class: "btn primary", onclick: (e) => checkUpdates(e.target) }, "Check for updates")),
      el("div", { class: "vrow" },
        el("span", { class: "vnum" }, "v" + v.version),
        el("span", { class: "tagpill " + v.channel }, v.channel),
        state),
      v.notes ? el("p", { class: "vnote" }, v.notes) : null,
      mk.error ? el("p", { class: "vnote" }, "Last check failed: " + mk.error) : null,
      el("div", { class: "vgrid" },
        cell("Release tag", v.releaseTag),
        cell("Latest published", v.available || "—"),
        cell("Promoted from", v.promotedFrom || "—"),
        cell("Marketplace", mk.repository || "—"))),

    // What the published release actually contains, pulled from its GitHub
    // release body. Shown whenever a release exists, not only when an update is
    // available, so the notes for the installed version stay readable too.
    v.available
      ? el("section", { class: "panel" },
          el("div", { class: "phead" },
            el("h3", {}, "Published release"),
            el("span", { class: "when" }, v.releasedAt ? ago(Date.parse(v.releasedAt)) : "")),
          el("div", { class: "vgrid" },
            el("div", { class: "vcell" },
              el("div", { class: "k" }, (v.releaseTagPublished || "v" + v.available) + (v.updateAvailable ? " — update available" : "")),
              el("div", { class: "v", style: "white-space:pre-wrap;word-break:break-word;font-family:inherit" },
                v.releaseNotes || "This release published no notes."),
              mk.repository && v.releaseTagPublished
                ? el("div", { style: "margin-top:9px" },
                    el("a", {
                      class: "btn",
                      href: "https://github.com/" + mk.repository + "/releases/tag/" + v.releaseTagPublished,
                      target: "_blank",
                      rel: "noreferrer",
                    }, "Open on GitHub"))
                : null)))
      : null,

    el("section", { class: "panel" },
      el("div", { class: "phead" }, el("h3", {}, "Versioning")),
      el("p", { class: "pdesc" },
        "Versions are va.b.c. b is the stable line, so x.y.0 is a release and any x.y.z with z above 0 " +
        "is a local beta. Promoting a verified beta bumps b and resets c: 1.2.1 becomes 1.3.0. " +
        "Only x.y.0 is published to the marketplace."),
      v.downloadURL
        ? el("div", { class: "btnrow" },
            el("a", { class: "btn", href: v.downloadURL, target: "_blank", rel: "noreferrer" }, "Download " + v.available))
        : null),
  ]
}

async function checkUpdates(button) {
  if (button) button.disabled = true
  try {
    const r = await post("/api/marketplace/refresh", {})
    toast(r.message || "checked")
  } catch (e) { toast(e.message, true) }
  if (button) button.disabled = false
  await load()
}

/**
 * The Logging tab, filtered by level.
 *
 * A warning or an error is the reason anyone opens this tab, and both were
 * buried in a run of routine info lines. The chips select a minimum severity
 * rather than an exact one, so "warn" keeps errors visible — filtering them out
 * while looking for problems would be precisely backwards.
 */
const LOG_RANK = { info: 0, warn: 1, error: 2 }

/**
 * One plugin's Logging tab, or — on the manager — every plugin's at once.
 *
 * The manager owns the other plugins, so its own tab is the place to watch
 * them together: a background sweep that misbehaves is easier to spot next to
 * what else was happening than on a tab you have to already suspect.
 */
function logView(p) {
  const combined = p.id === "plugin-manager"
  const source = combined
    ? DATA.plugins
        .flatMap((x) => x.logs.map((l) => ({ ...l, plugin: x.title })))
        .sort((a, b) => a.at - b.at)
    : p.logs

  const level = logLevel[p.id] || "all"
  const lines = level === "all" ? source : source.filter((l) => LOG_RANK[l.level] >= LOG_RANK[level])

  const counts = { all: source.length, info: 0, warn: 0, error: 0 }
  for (const l of source) {
    if (LOG_RANK[l.level] >= LOG_RANK.info) counts.info++
    if (LOG_RANK[l.level] >= LOG_RANK.warn) counts.warn++
    if (LOG_RANK[l.level] >= LOG_RANK.error) counts.error++
  }

  const chips = el("div", { class: "chips" },
    ["all", "info", "warn", "error"].map((g) =>
      el("button", {
        class: "chip" + (level === g ? " on" : ""),
        onclick: () => { logLevel[p.id] = g; render() },
      }, g, el("span", { class: "n" }, String(counts[g])))))

  if (!source.length) {
    return el("div", {}, el("div", { class: "empty" }, "No activity recorded yet this session."))
  }

  const fmt = (at) => {
    const d = new Date(at)
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0")).join(":")
  }

  return el("div", {}, chips,
    lines.length
      ? el("div", { class: "logs" },
          // Newest first: the interesting line is the most recent one.
          [...lines].reverse().map((l) =>
            el("div", { class: "logline " + l.level },
              el("span", { class: "ts" }, fmt(l.at)),
              el("span", { class: "lv" }, l.level),
              // Only the combined view needs to say which plugin spoke.
              l.plugin ? el("span", { class: "who" }, l.plugin) : null,
              el("span", { class: "msg" }, l.message))))
      : el("div", { class: "empty" }, "Nothing at this level."))
}

/* -------------------------------- views --------------------------------- */
/**
 * A plugin page: header, then Info / Logging / Settings.
 *
 * Info shows the plugin's own panels plus its status; Logging shows what it
 * recorded this session; Settings holds the editable fields and any actions
 * that are not already surfaced by a panel.
 */
function viewPlugin(id) {
  const p = DATA.plugins.find((x) => x.id === id)
  if (!p) return [el("div", { class: "empty" }, "plugin not found")]

  const tabs = [
    { key: "info", label: "Info", count: p.panels.reduce((n, panel) => n + panel.items.length, 0) },
    { key: "logging", label: "Logging", count: p.logs.length },
    { key: "settings", label: "Settings", count: p.settings.length },
    { key: "version", label: "Version", dot: p.version?.updateAvailable },
  ]
  if (!tabs.some((t) => t.key === tab)) tab = "info"

  let body
  if (tab === "version") {
    body = versionView(p)
  } else if (tab === "info") {
    const hits = searchState[p.id]
    body = [
      p.status.length
        ? el("section", { class: "panel" }, el("div", { class: "phead" }, el("h3", {}, "Status")), statusPills(p.status))
        : null,
      p.search ? searchBox(p) : null,
      // A search answers a question, so its results take over the view until
      // it is cleared rather than competing with the panels below.
      hits && hits.query
        ? searchResults(p, hits)
        : [
            ...p.panels.map((panel) => panelView(p, panel)),
            !p.status.length && !p.panels.length
              ? el("div", { class: "empty" }, "This plugin reports no info.")
              : null,
          ],
    ]
  } else if (tab === "logging") {
    body = [logView(p)]
  } else {
    // Actions already reachable from a panel button are not repeated here.
    const panelActions = new Set(p.panels.map((panel) => panel.action).filter(Boolean))
    const rest = { ...p, actions: p.actions.filter((a) => !panelActions.has(a.key)) }
    // A plugin's own state file is edited here rather than in a central list.
    const own = DATA.files.find((f) => f.pluginID === p.id)
    body = [
      ...settingsView(p),
      rest.actions.length ? el("div", { class: "card" }, actionRow(rest)) : null,
      own
        ? el("section", { class: "panel", style: "margin-top:26px" },
            el("div", { class: "phead" }, el("h3", {}, own.name)),
            el("p", { class: "pdesc" }, own.description),
            ...rawEditor(own))
        : null,
    ]
  }

  return [
    el("div", { class: "chead", style: "padding:0 0 4px" },
      el("h2", { style: "flex:1" }, p.title),
      p.version ? el("span", { class: "tagpill " + p.version.channel }, "v" + p.version.version) : null,
      el("span", { class: "id" }, p.id),
      toggleSwitch(p)),
    el("p", { class: "lead" }, p.description || ""),
    el("div", { class: "tabs" }, tabs.map((t) =>
      el("button", {
        class: "tab" + (tab === t.key ? " active" : ""),
        onclick: () => { tab = t.key; syncURL(false); render(); void loadView() },
      }, t.label,
        t.count ? el("span", { class: "count" }, String(t.count)) : null,
        // An available update is worth seeing without opening the tab.
        t.dot ? el("span", { class: "count" }, "●") : null))),
    // Flattened before spreading: a tab body is built as nested arrays — the
    // Info tab's panel list is one element of it — and spreading without this
    // hands replaceChildren an array, which it renders as the text
    // "[object HTMLElement],[object HTMLElement]" in place of the panels.
    ...body.flat(Infinity).filter(Boolean),
  ]
}

/* --------------------------- config editor ------------------------------ */
function diffSummary(lines) {
  const add = lines.filter((l) => l.type === "add").length
  const rem = lines.filter((l) => l.type === "remove").length
  return el("div", { class: "dsum" },
    el("span", { class: "a" }, "+" + add + " added"),
    el("span", { class: "r" }, "−" + rem + " removed"))
}

function diffView(lines) {
  // Collapse long unchanged stretches so the change stays readable.
  const keep = new Set()
  lines.forEach((l, i) => {
    if (l.type === "same") return
    for (let k = i - 3; k <= i + 3; k++) if (k >= 0 && k < lines.length) keep.add(k)
  })
  const out = []
  let skipped = 0
  lines.forEach((l, i) => {
    if (!keep.has(i)) { skipped++; return }
    if (skipped) {
      out.push(el("div", { class: "dline same" },
        el("span", { class: "ln" }), el("span", { class: "ln" }),
        el("span", { class: "mk" }, "⋯"),
        el("span", { class: "tx" }, skipped + " unchanged line" + (skipped === 1 ? "" : "s"))))
      skipped = 0
    }
    out.push(el("div", { class: "dline " + l.type },
      el("span", { class: "ln" }, l.before == null ? "" : String(l.before)),
      el("span", { class: "ln" }, l.after == null ? "" : String(l.after)),
      el("span", { class: "mk" }, l.type === "add" ? "+" : l.type === "remove" ? "−" : ""),
      el("span", { class: "tx" }, l.text)))
  })
  if (skipped) out.push(el("div", { class: "dline same" },
    el("span", { class: "ln" }), el("span", { class: "ln" }),
    el("span", { class: "mk" }, "⋯"),
    el("span", { class: "tx" }, skipped + " unchanged lines")))
  return el("div", { class: "diffbox" }, out)
}

/**
 * The editor is reached from the plugin manager's Info tab, not the sidebar,
 * so it needs its own way back.
 */
function backToConfig() {
  return el("button", { class: "backlink", onclick: () => go("plugin", "plugin-manager") },
    "← opencode configuration")
}

/**
 * One opencode session: metadata and the tail of its transcript.
 *
 * Reached from the session-manager's Info tab. The plugin API cannot focus a
 * session inside the opencode GUI, so an imported transcript is shown here
 * rather than pretending to hand off to the editor.
 */
let sessionCache = null // { id, session, turns }

function viewSession(id) {
  if (!sessionCache || sessionCache.id !== id) {
    sessionCache = { id, session: null, turns: [], loading: true, error: null }
    api("/api/session/" + encodeURIComponent(id))
      .then((r) => {
        sessionCache = { id, session: r.session, turns: r.turns, loading: false, error: null }
        if (view.name === "session" && view.arg === id) render()
      })
      .catch((e) => {
        sessionCache = { id, session: null, turns: [], loading: false, error: e.message }
        if (view.name === "session" && view.arg === id) render()
      })
  }

  const back = el("button", { class: "backlink", onclick: () => go("plugin", "session-manager") },
    "← session manager")

  if (sessionCache.loading) return [back, el("h2", {}, id), el("div", { class: "empty" }, "loading…")]
  if (sessionCache.error) return [back, el("h2", {}, id), el("div", { class: "note err" }, sessionCache.error)]

  const s = sessionCache.session
  return [
    back,
    el("h2", {}, s.title || "(untitled)"),
    el("p", { class: "lead" }, s.directory),
    el("section", { class: "panel" },
      el("div", { class: "phead" }, el("h3", {}, "Session")),
      el("div", { class: "vgrid" },
        vcell("id", s.id),
        vcell("project", s.projectID),
        vcell("messages", String(s.messages)),
        vcell("tokens", String(s.tokens)),
        vcell("updated", new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ")))),
    el("section", { class: "panel" },
      el("div", { class: "phead" }, el("h3", {}, "Transcript"),
        el("span", { class: "when" }, sessionCache.turns.length + " recent turns")),
      sessionCache.turns.length
        ? el("div", { class: "grid" }, sessionCache.turns.map((t) =>
            el("div", { class: "item " + (t.role === "user" ? "ok" : "muted") },
              el("div", { class: "t" }, t.role),
              el("div", { class: "s", style: "white-space:pre-wrap;word-break:break-word;color:var(--muted)" },
                t.text.length > 2000 ? t.text.slice(0, 2000) + "\n…" : t.text))))
        : el("div", { class: "empty" }, "No text turns recorded.")),
  ]
}

function vcell(k, v) {
  return el("div", { class: "vcell" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v))
}

/**
 * The raw JSON editor for one file, as a self-contained block.
 *
 * Shared by the standalone config page and the bottom of a plugin's Settings
 * tab, so a plugin's own state file is edited where that plugin lives rather
 * than in a central list.
 */
function rawEditor(meta) {
  if (!editor || editor.name !== meta.name) {
    editor = { name: meta.name, file: meta, original: "", draft: "", loading: true }
    api("/api/config/" + encodeURIComponent(meta.name)).then((r) => {
      editor = { name: meta.name, file: r.file, original: r.content, draft: r.content, loading: false }
      render()
    }).catch((e) => toast(e.message, true))
    return [el("div", { class: "empty" }, "loading…")]
  }

  const dirty = editor.draft !== editor.original
  const area = el("textarea", {
    class: "editor", spellcheck: false, value: editor.draft,
    oninput: (e) => {
      editor.draft = e.target.value
      saveBtn.disabled = editor.draft === editor.original
      revertBtn.disabled = saveBtn.disabled
      state.textContent = saveBtn.disabled ? "saved" : "unsaved changes"
      state.style.color = saveBtn.disabled ? "var(--faint)" : "var(--warn)"
    },
  })
  const state = el("span", { class: "id", style: "color:" + (dirty ? "var(--warn)" : "var(--faint)") },
    dirty ? "unsaved changes" : "saved")
  const saveBtn = el("button", { class: "btn primary", disabled: !dirty, onclick: confirmSave }, "Review & save")
  const revertBtn = el("button", { class: "btn", disabled: !dirty, onclick: () => { editor.draft = editor.original; render() } }, "Revert")

  return [
    el("div", { class: "edhead" }, el("span", { class: "path" }, meta.path), state, revertBtn, saveBtn),
    meta.restart
      ? el("div", { class: "note warn" }, "Applied when opencode restarts — this file is read once at startup.")
      : el("div", { class: "note ok" }, "Applied immediately; no restart needed."),
    !meta.exists ? el("div", { class: "note" }, "This file does not exist yet. Saving will create it.") : null,
    area,
  ]
}

/** Diff-on-save: preview the change and require confirmation before writing. */
async function confirmSave() {
  let preview
  try {
    preview = await post("/api/config/" + encodeURIComponent(editor.name) + "/diff", { content: editor.draft })
  } catch (e) { return toast(e.message, true) }

  if (preview.unchanged) return toast("no changes")

  const body = el("div", { class: "modalbody" })
  if (!preview.validation.ok) {
    body.append(el("div", { class: "note err" },
      "Invalid JSON" + (preview.validation.line ? " (line " + preview.validation.line + ")" : "") +
      ": " + preview.validation.message))
  }
  if (editor.file.restart) {
    body.append(el("div", { class: "note warn" },
      "opencode reads this file at startup — the change takes effect after you restart opencode."))
  }
  body.append(diffSummary(preview.diff), diffView(preview.diff))

  const modal = el("div", { class: "modal" },
    el("div", { class: "modalbox" },
      el("header", {}, el("h3", {}, "Save " + editor.name + "?"),
        el("span", { class: "id" }, editor.file.path)),
      body,
      el("div", { class: "modalfoot" },
        el("button", { class: "btn", onclick: () => modal.remove() }, "Cancel"),
        el("button", {
          class: "btn primary",
          disabled: !preview.validation.ok,
          title: preview.validation.ok ? "" : "Fix the JSON error first",
          onclick: async () => {
            try {
              const r = await post("/api/config/" + encodeURIComponent(editor.name) + "/save",
                { content: editor.draft })
              editor.original = editor.draft
              editor.file = r.file
              DATA.files = r.files
              modal.remove()
              toast(r.backup ? "saved (backup kept)" : "saved")
              render()
            } catch (e) { toast(e.message, true) }
          },
        }, "Save"))))

  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove() })
  document.body.append(modal)
}

function viewConfig(name) {
  const meta = DATA.files.find((f) => f.name === name)
  if (!meta) return [el("div", { class: "empty" }, "unknown file")]

  return [
    backToConfig(),
    el("h2", {}, name),
    el("p", { class: "lead" }, meta.description),
    ...rawEditor(meta),
  ]
}

/* ------------------------------- render --------------------------------- */
function render() {
  renderNav()
  // The 5s poll re-renders; keep the reader's place in a scrolled log.
  const scrolled = pane.querySelector(".logs")
  const keepScroll = scrolled ? scrolled.scrollTop : null

  // Same problem for the search box: a poll would otherwise steal the caret
  // mid-word. Remember where it was and put it back.
  const active = document.activeElement
  const typing = active && active.classList && active.classList.contains("searchin")
    ? { start: active.selectionStart, end: active.selectionEnd, value: active.value }
    : null

  const kids =
    view.name === "plugin" ? viewPlugin(view.arg) :
    view.name === "config" ? viewConfig(view.arg) :
    view.name === "session" ? viewSession(view.arg) :
    [el("div", { class: "empty" }, "not found")]
  // Flattened for the same reason el is: a view returns nested arrays, and
  // replaceChildren would stringify an array into "[object HTMLElement]".
  pane.replaceChildren(...kids.flat(Infinity).filter(Boolean))

  if (keepScroll) {
    const logs = pane.querySelector(".logs")
    if (logs) logs.scrollTop = keepScroll
  }

  if (typing) {
    const box = pane.querySelector(".searchin")
    if (box) {
      // The value is restored too: a poll can land between a keystroke and a
      // submit, and the re-render would otherwise revert what was typed.
      box.value = typing.value
      box.focus()
      box.setSelectionRange(typing.start, typing.end)
    }
  }
}

/**
 * Load everything the shell needs: the plugin list and the config file list.
 *
 * Only called once at startup and after a mutation, because the sidebar has to
 * know every plugin. Per-view refreshes go through loadView instead.
 */
async function load(silent) {
  try {
    const [p, c] = await Promise.all([api("/api/plugins"), api("/api/config")])
    DATA = { ...DATA, plugins: p.plugins, files: c.files, configDir: c.configDir }
    render()
  } catch (e) {
    if (!silent) pane.replaceChildren(el("div", { class: "empty" }, "failed to load: " + e.message))
  }
}

/**
 * Refresh only what the current page shows.
 *
 * Polling every endpoint on a timer meant a plugin page waited on the
 * marketplace and the config list before it could draw, and navigation blocked
 * on a full round trip. Fetching per view keeps a redirect instant: the cached
 * plugin list renders straight away and only the missing piece is fetched.
 */
async function loadView() {
  // The marketplace is a network call, so it is fetched only when shown.
  if (view.name === "plugin" && tab === "version" && !DATA.marketplace.checkedAt) {
    try {
      DATA.marketplace = await api("/api/marketplace")
      render()
    } catch {
      /* the Version tab reports its own unavailability */
    }
    return
  }
  if (view.name === "config" || view.name === "plugin") {
    try {
      const p = await api("/api/plugins")
      DATA = { ...DATA, plugins: p.plugins }
      render()
    } catch {
      /* keep showing the last good state rather than blanking the page */
    }
  }
}

// Route from the URL before the first paint so a deep link opens its page
// directly instead of flashing the default one.
{
  const route = parseRoute(location.pathname)
  view = route.view
  tab = route.tab
  syncURL(true)
}
load()

// Keep the visible page fresh, but never clobber an open editor or a modal.
// The raw editor also appears at the bottom of a Settings tab, so a live draft
// there suspends the poll just as the standalone config page does.
setInterval(() => {
  if (view.name === "config") return
  if (editor && editor.draft !== editor.original) return
  if (document.querySelector(".modal")) return
  // A refresh rebuilds the pane, which would close a menu mid-click.
  if (openMenu) return
  void loadView()
}, 5000)
</script></body></html>`
}
