/**
 * Plugin version manager.
 *
 * Every plugin declares its version in `opencode/versions.json`, which ships
 * beside the source and is the only place a version is written. The manifest is
 * read at runtime so the dashboard, the release workflow and the marketplace
 * all agree on one number.
 *
 * Versions are `va.b.c`:
 *
 *   - `a` — major, only ever set by a human.
 *   - `b` — the stable line. `x.y.0` is a release.
 *   - `c` — beta counter. Any `c > 0` is a local, unverified build.
 *
 * So `1.2.0` is stable and `1.2.1` is a beta on top of it. Promoting a verified
 * beta bumps `b` and resets `c`: `1.2.1` becomes `1.3.0`. Only `x.y.0` is
 * published, which is what lets the release workflow decide what to ship from
 * the version alone.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** A parsed `a.b.c` version. */
export type Version = { major: number; minor: number; patch: number }

/** One plugin's entry in the manifest. */
export type Entry = {
  id: string
  version: string
  /** Set on a stable entry to record which beta was promoted into it. */
  promotedFrom?: string
  /** One-line summary of what changed, shown on the Version tab. */
  notes?: string
}

export type Manifest = {
  /** Owning repository in `owner/name` form; the default marketplace. */
  repository: string
  plugins: Entry[]
}

/**
 * The manifest that ships with this source tree.
 *
 * Resolved relative to this module rather than the config directory: the plugin
 * directory is a junction back to the repository, so this finds the checked-in
 * manifest whether opencode loaded the plugins from the repo or from the config
 * directory.
 */
export const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "versions.json")

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/

/** Parse `1.2.0` or `v1.2.0`. Returns null when the text is not a version. */
export function parse(text: string): Version | null {
  const match = VERSION_RE.exec(String(text ?? "").trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function format(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

/** `-1`, `0` or `1`, ordering by major, then minor, then patch. */
export function compare(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

/** A stable release is exactly `x.y.0`; everything else is a beta. */
export function isStable(version: Version): boolean {
  return version.patch === 0
}

export type Channel = "stable" | "beta"

export function channel(version: Version): Channel {
  return isStable(version) ? "stable" : "beta"
}

/** The next beta on top of `version`: `1.2.0` → `1.2.1`, `1.2.1` → `1.2.2`. */
export function nextBeta(version: Version): Version {
  return { major: version.major, minor: version.minor, patch: version.patch + 1 }
}

/**
 * Promote a beta to the next stable line: `1.2.1` → `1.3.0`.
 *
 * Promoting an already-stable version is a mistake rather than a no-op — it
 * would publish a release nobody verified — so it throws.
 */
export function promote(version: Version): Version {
  if (isStable(version)) throw new Error(`${format(version)} is already stable; bump a beta instead`)
  return { major: version.major, minor: version.minor + 1, patch: 0 }
}

function parseEntry(raw: unknown): Entry | null {
  if (raw === null || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  const id = typeof value.id === "string" ? value.id.trim() : ""
  const version = typeof value.version === "string" ? value.version.trim() : ""
  if (id === "" || parse(version) === null) return null
  return {
    id,
    version,
    promotedFrom: typeof value.promotedFrom === "string" ? value.promotedFrom : undefined,
    notes: typeof value.notes === "string" ? value.notes : undefined,
  }
}

/**
 * Read the manifest.
 *
 * A missing or malformed manifest is fatal rather than defaulted: a plugin with
 * an unknown version could be published or advertised wrongly, and the rule is
 * that every plugin carries a managed version.
 */
export async function load(manifestPath = MANIFEST_PATH): Promise<Manifest> {
  let text: string
  try {
    text = await fsp.readFile(manifestPath, "utf8")
  } catch (error) {
    throw new Error(`Cannot read the plugin version manifest at ${manifestPath}: ${(error as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON: ${(error as Error).message}`)
  }

  const raw = parsed as Record<string, unknown>
  const repository = typeof raw?.repository === "string" ? raw.repository.trim() : ""
  if (repository === "") throw new Error(`${manifestPath} is missing "repository"`)
  if (!Array.isArray(raw?.plugins)) throw new Error(`${manifestPath} is missing "plugins"`)

  const plugins: Entry[] = []
  for (const item of raw.plugins) {
    const entry = parseEntry(item)
    if (entry === null) throw new Error(`${manifestPath} contains an entry without a valid id and a.b.c version`)
    plugins.push(entry)
  }
  return { repository, plugins }
}

/** One plugin's version, or null when the manifest does not list it. */
export async function of(pluginID: string, manifestPath = MANIFEST_PATH): Promise<Entry | null> {
  const manifest = await load(manifestPath)
  return manifest.plugins.find((entry) => entry.id === pluginID) ?? null
}

/** The release tag for a plugin version, e.g. `opencode-bark-notify-v1.2.0`. */
export function releaseTag(pluginID: string, version: string): string {
  return `opencode-${pluginID}-v${String(version).replace(/^v/, "")}`
}

/** The asset name a release carries, e.g. `bark-notify-1.2.0.zip`. */
export function assetName(pluginID: string, version: string): string {
  return `${pluginID}-${String(version).replace(/^v/, "")}.zip`
}
