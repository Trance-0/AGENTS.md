#!/usr/bin/env node
/**
 * Decide which opencode plugins need a GitHub release, and pack them.
 *
 * A plugin is released when its manifest version is stable (`x.y.0`) and no
 * release carries that tag yet. Betas (`x.y.z`, `z > 0`) are local builds and
 * are never published, so they are skipped rather than failing the run.
 *
 * Usage:
 *   node scripts/plan-release.mjs plan            # write the plan to stdout / $GITHUB_OUTPUT
 *   node scripts/plan-release.mjs pack <outdir>   # zip each planned plugin
 *
 * Existing tags are read from `EXISTING_TAGS` (newline separated) so the
 * decision stays pure and testable; the workflow fills it from `git tag`.
 */

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const MANIFEST = path.join(ROOT, "versions.json")

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/

function parse(text) {
  const match = VERSION_RE.exec(String(text ?? "").trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

const isStable = (version) => version.patch === 0
const releaseTag = (id, version) => `opencode-${id}-v${version}`
const assetName = (id, version) => `${id}-${version}.zip`

function readManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
  if (typeof manifest?.repository !== "string" || !Array.isArray(manifest?.plugins)) {
    throw new Error("versions.json must have a repository and a plugins array")
  }
  for (const entry of manifest.plugins) {
    if (typeof entry?.id !== "string" || parse(entry?.version) === null) {
      throw new Error(`versions.json entry needs an id and an a.b.c version: ${JSON.stringify(entry)}`)
    }
    // Every declared plugin must exist, or a release would ship an empty zip.
    if (!fs.existsSync(path.join(ROOT, "plugin", `${entry.id}.ts`))) {
      throw new Error(`versions.json lists "${entry.id}" but plugin/${entry.id}.ts does not exist`)
    }
  }
  // Every plugin on disk must be declared, so nothing ships unversioned.
  for (const file of fs.readdirSync(path.join(ROOT, "plugin"))) {
    if (!file.endsWith(".ts")) continue
    const id = file.slice(0, -3)
    if (!manifest.plugins.some((entry) => entry.id === id)) {
      throw new Error(`plugin/${file} is not listed in versions.json; every plugin needs a managed version`)
    }
  }
  return manifest
}

/** Plugins whose stable version has no tag yet. */
export function plan(manifest, existingTags) {
  const tags = new Set(existingTags)
  const releases = []
  const skipped = []

  for (const entry of manifest.plugins) {
    const version = parse(entry.version)
    const tag = releaseTag(entry.id, entry.version)
    if (!isStable(version)) {
      skipped.push({ ...entry, tag, reason: "beta — not published" })
      continue
    }
    if (tags.has(tag)) {
      skipped.push({ ...entry, tag, reason: "already released" })
      continue
    }
    releases.push({
      id: entry.id,
      version: entry.version,
      tag,
      asset: assetName(entry.id, entry.version),
      notes: entry.notes ?? "",
    })
  }
  return { releases, skipped }
}

/**
 * Zip one plugin: its own module plus the shared `lib/` and the manifest.
 *
 * The plugins import `lib/` directly, so a zip of the single file would not
 * install. Shipping the whole `lib/` keeps each asset self-contained.
 */
function pack(entry, outDir) {
  const staging = path.join(outDir, `.stage-${entry.id}`)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(path.join(staging, "plugin"), { recursive: true })

  fs.cpSync(path.join(ROOT, "plugin", `${entry.id}.ts`), path.join(staging, "plugin", `${entry.id}.ts`))
  fs.cpSync(path.join(ROOT, "lib"), path.join(staging, "lib"), { recursive: true })
  fs.cpSync(MANIFEST, path.join(staging, "versions.json"))
  const readme = path.join(ROOT, "README.md")
  if (fs.existsSync(readme)) fs.cpSync(readme, path.join(staging, "README.md"))

  // `zip` runs inside the staging directory so the archive has no stray
  // prefix, which means the output path has to be absolute.
  const zip = path.resolve(outDir, entry.asset)
  fs.rmSync(zip, { force: true })
  execFileSync("zip", ["-qr", zip, "."], { cwd: staging, stdio: "inherit" })
  fs.rmSync(staging, { recursive: true, force: true })
  return zip
}

async function main() {
  const [command, outDir] = process.argv.slice(2)
  const manifest = readManifest()
  const existing = (process.env.EXISTING_TAGS ?? "").split("\n").map((t) => t.trim()).filter(Boolean)
  const result = plan(manifest, existing)

  if (command === "plan") {
    for (const entry of result.skipped) console.error(`skip  ${entry.id} v${entry.version} — ${entry.reason}`)
    for (const entry of result.releases) console.error(`release ${entry.id} v${entry.version} → ${entry.tag}`)

    const payload = JSON.stringify(result.releases)
    if (process.env.GITHUB_OUTPUT) {
      await fsp.appendFile(
        process.env.GITHUB_OUTPUT,
        `releases=${payload}\nany=${result.releases.length > 0}\n`,
        "utf8",
      )
    }
    process.stdout.write(payload + "\n")
    return
  }

  if (command === "pack") {
    if (!outDir) throw new Error("pack needs an output directory")
    fs.mkdirSync(outDir, { recursive: true })
    for (const entry of result.releases) console.error(`packed ${pack(entry, outDir)}`)
    return
  }

  throw new Error(`Unknown command: ${command ?? "(none)"}. Use "plan" or "pack <outdir>".`)
}

// Only run when invoked directly, so the planner can be imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
