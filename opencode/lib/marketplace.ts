/**
 * Plugin marketplace — GitHub releases as an update source.
 *
 * The release workflow publishes one GitHub release per stable plugin version,
 * tagged `opencode-<plugin>-v<a.b.c>` and carrying a zip of that plugin's
 * sources. This reads those releases back and reports which installed plugins
 * have a newer stable version available.
 *
 * Any repository that follows the same tag and asset convention works, so the
 * marketplace is configurable: the manifest's `repository` is the default and
 * `marketplace.json` may point somewhere else. Only stable `x.y.0` releases are
 * ever offered — a beta is a local build that was never published.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { CONFIG_DIR } from "./paths.ts"
import * as Versions from "./versions.ts"

const CONFIG_PATH = path.join(CONFIG_DIR, "marketplace.json")
const CACHE_PATH = path.join(CONFIG_DIR, "marketplace-cache.json")

/** `opencode-<plugin>-v<version>`, the tag the release workflow creates. */
const TAG_RE = /^opencode-(.+)-v(\d+\.\d+\.\d+)$/

export type Config = {
  /** `owner/name` of the repository whose releases are offered. */
  repository: string
  /** GitHub API root, so an Enterprise host can be used instead. */
  apiBase: string
  /** Whether update checks may reach the network at all. */
  enabled: boolean
}

/** One published, installable plugin version. */
export type Listing = {
  pluginID: string
  version: string
  tag: string
  /** Release asset download URL, absent when the release published no zip. */
  downloadURL: string | null
  publishedAt: string | null
  notes: string | null
}

/** An installed plugin compared against the marketplace. */
export type Status = {
  pluginID: string
  installed: string
  /** Newest stable version offered, or null when the marketplace has none. */
  available: string | null
  downloadURL: string | null
  channel: Versions.Channel
  /** True when a strictly newer stable version exists. */
  updateAvailable: boolean
  /**
   * True when the installed build is a beta. A beta is never published, so it
   * is ahead of the marketplace by construction rather than out of date.
   */
  unreleased: boolean
}

export type Cache = { checkedAt: number; listings: Listing[]; error: string | null }

async function readJSON<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T
  } catch {
    // Absent or unparsable: callers fall back to defaults.
    return null
  }
}

async function writeJSON(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await fsp.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8")
  await fsp.rename(temp, file)
}

/** Effective configuration: the manifest's repository unless overridden. */
export async function config(): Promise<Config> {
  const manifest = await Versions.load()
  const stored = await readJSON<Partial<Config>>(CONFIG_PATH)
  return {
    repository: typeof stored?.repository === "string" && stored.repository.trim() !== ""
      ? stored.repository.trim()
      : manifest.repository,
    apiBase: typeof stored?.apiBase === "string" && stored.apiBase.trim() !== ""
      ? stored.apiBase.trim().replace(/\/+$/, "")
      : "https://api.github.com",
    enabled: stored?.enabled !== false,
  }
}

export async function setConfig(patch: Partial<Config>): Promise<Config> {
  const current = await readJSON<Partial<Config>>(CONFIG_PATH) ?? {}
  const next = { ...current }
  if (patch.repository !== undefined) {
    const value = patch.repository.trim()
    // `owner/name` is the only form the release URL can be built from.
    if (value !== "" && !/^[\w.-]+\/[\w.-]+$/.test(value)) {
      throw new Error(`Repository must be "owner/name", got "${value}"`)
    }
    next.repository = value
  }
  if (patch.apiBase !== undefined) {
    const value = patch.apiBase.trim()
    if (value !== "" && !/^https:\/\//.test(value)) throw new Error("The API base must be an https URL")
    next.apiBase = value
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled
  await writeJSON(CONFIG_PATH, next)
  return config()
}

export function configPath(): string {
  return CONFIG_PATH
}

/** The last check's result, so the dashboard can render without the network. */
export async function cached(): Promise<Cache | null> {
  return readJSON<Cache>(CACHE_PATH)
}

/**
 * Fetch every published plugin release.
 *
 * Only tags matching the convention are considered, and only stable versions
 * are returned: an `x.y.z` tag with `z > 0` would be a beta that should never
 * have been published, and offering it as an update would contradict the
 * versioning rule.
 */
export async function fetchListings(signal?: AbortSignal): Promise<Listing[]> {
  const cfg = await config()
  if (!cfg.enabled) throw new Error("Marketplace update checks are disabled")

  const url = `${cfg.apiBase}/repos/${cfg.repository}/releases?per_page=100`
  const response = await fetch(url, {
    signal,
    headers: { accept: "application/vnd.github+json", "user-agent": "opencode-plugin-manager" },
  })
  if (!response.ok) {
    throw new Error(`${cfg.repository}: GitHub returned ${response.status} ${response.statusText}`)
  }

  const releases = (await response.json()) as Array<Record<string, any>>
  const listings: Listing[] = []
  for (const release of releases) {
    if (release?.draft === true) continue
    const match = TAG_RE.exec(String(release?.tag_name ?? ""))
    if (!match) continue
    const version = Versions.parse(match[2])
    if (version === null || !Versions.isStable(version)) continue

    const pluginID = match[1]
    const wanted = Versions.assetName(pluginID, match[2])
    const asset = (release.assets ?? []).find((a: Record<string, any>) => a?.name === wanted)
    listings.push({
      pluginID,
      version: match[2],
      tag: String(release.tag_name),
      downloadURL: typeof asset?.browser_download_url === "string" ? asset.browser_download_url : null,
      publishedAt: typeof release.published_at === "string" ? release.published_at : null,
      notes: typeof release.body === "string" && release.body.trim() !== "" ? release.body.trim() : null,
    })
  }
  return listings
}

/** Fetch and cache. The cache records a failure too, so the UI can show why. */
export async function refresh(signal?: AbortSignal): Promise<Cache> {
  let cache: Cache
  try {
    cache = { checkedAt: Date.now(), listings: await fetchListings(signal), error: null }
  } catch (error) {
    cache = {
      checkedAt: Date.now(),
      listings: (await cached())?.listings ?? [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
  await writeJSON(CACHE_PATH, cache)
  return cache
}

/** The newest stable listing for one plugin. */
function newest(listings: Listing[], pluginID: string): Listing | null {
  let best: Listing | null = null
  let bestVersion: Versions.Version | null = null
  for (const listing of listings) {
    if (listing.pluginID !== pluginID) continue
    const version = Versions.parse(listing.version)
    if (version === null) continue
    if (bestVersion === null || Versions.compare(version, bestVersion) > 0) {
      best = listing
      bestVersion = version
    }
  }
  return best
}

/**
 * Compare the manifest against the cached listings.
 *
 * This never hits the network: the dashboard polls, so it renders the last
 * known result and leaves refreshing to an explicit action.
 */
export async function status(): Promise<Status[]> {
  const manifest = await Versions.load()
  const listings = (await cached())?.listings ?? []

  return manifest.plugins.map((entry) => {
    const installed = Versions.parse(entry.version)
    const listing = newest(listings, entry.id)
    const available = listing === null ? null : Versions.parse(listing.version)

    return {
      pluginID: entry.id,
      installed: entry.version,
      available: listing?.version ?? null,
      downloadURL: listing?.downloadURL ?? null,
      channel: installed === null ? "beta" : Versions.channel(installed),
      updateAvailable:
        installed !== null && available !== null && Versions.compare(available, installed) > 0,
      unreleased: installed !== null && !Versions.isStable(installed),
    }
  })
}
