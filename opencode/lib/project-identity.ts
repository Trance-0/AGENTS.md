/**
 * Project identity across devices.
 *
 * Sessions collected from several machines must collapse onto one opencode
 * project when they are the same work. Identity is resolved in this order:
 *
 *   1. **Git remote URL** — normalised to `host/owner/repo`. This is the only
 *      globally stable key, so any two sessions sharing a remote merge into one
 *      project regardless of which device or directory they ran in. Codex
 *      records the remote in `session_meta.git.repository_url`; for local
 *      directories it is read from git itself.
 *   2. **Root commit** — for a repository with no remote, the first root commit
 *      is still stable across clones on different devices.
 *   3. **Directory basename** — the fallback when nothing git-based is known.
 *      Sessions from `D:\work\myapp` and `/home/me/myapp` merge under `myapp`.
 *      This is deliberately looser than a full path match: the same project
 *      checked out at different paths on different devices is the common case.
 *
 * Only the first two produce an id opencode itself would compute, so a
 * basename-derived project is namespaced under a `name:` prefix to guarantee it
 * can never collide with a real repository id.
 */

import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fsp from "node:fs/promises"
import { basename } from "./device.ts"

const exec = promisify(execFile)

export type IdentitySource = "remote" | "root-commit" | "basename" | "global"

export type ProjectIdentity = {
  /** The opencode project id these sessions belong to. */
  projectID: string
  /** How the id was derived, for reporting and for merge decisions. */
  source: IdentitySource
  /** Normalised `host/owner/repo`, when a remote was known. */
  remote: string | null
  /** Worktree root for the local directory, or "/" when it is not local. */
  worktree: string
  /** Directory the session ran in, normalised to forward slashes. */
  directory: string
  /** Human-readable project name, used when creating a new project row. */
  name: string
}

/**
 * Normalise a path for comparison across devices.
 *
 * Separators are unified and a Windows drive letter is upper-cased, so the same
 * location recorded as `d:\x` and `D:/x` compares equal.
 */
export function normalizePath(directory: string): string {
  const unified = directory.replace(/\\/g, "/").replace(/\/+$/, "")
  return unified.replace(/^([a-z]):\//, (_, drive) => `${drive.toUpperCase()}:/`)
}

/**
 * Reduce a git remote URL to `host/owner/repo`.
 *
 * Mirrors opencode's own normalisation so an id computed here matches the id
 * opencode computes for the same checkout: the scheme, credentials, trailing
 * `.git` and any trailing slash are dropped, and the host is lower-cased.
 */
export function remoteKey(remote: string): string {
  const value = remote.trim()
  if (!value) return ""

  const parts = (host: string, name: string) => {
    const pathname = name.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "")
    if (!host || !pathname) return ""
    return `${host.toLowerCase()}/${pathname}`
  }

  try {
    const parsed = new URL(value)
    if (parsed.protocol === "file:") return ""
    return parts(parsed.hostname, parsed.pathname)
  } catch {
    // `git@host:owner/repo.git` is not a URL but is the common SSH form.
    const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
    return scp ? parts(scp[2], scp[3]) : ""
  }
}

/** The project id opencode assigns to a repository with this remote. */
export function idForRemote(remote: string): string {
  return crypto.createHash("sha1").update(`git-remote:${remote}`).digest("hex")
}

/**
 * The project id for a directory identified only by its name.
 *
 * Namespaced so it can never collide with a sha1 repository id, and lower-cased
 * so the same project merges across case-differing paths on Windows and Linux.
 */
export function idForName(name: string): string {
  return `name:${name.toLowerCase()}`
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, windowsHide: true })
    return stdout.trim()
  } catch {
    return ""
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fsp.stat(directory)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the project a session belongs to.
 *
 * `recordedRemote` is the remote captured in the transcript itself, which is
 * what makes sessions from other devices resolvable even when their directory
 * does not exist here.
 */
export async function resolve(input: {
  directory: string
  recordedRemote?: string | null
}): Promise<ProjectIdentity> {
  const directory = normalizePath(input.directory ?? "")
  const name = basename(directory)

  if (!directory) {
    return { projectID: "global", source: "global", remote: null, worktree: "/", directory: "", name: "global" }
  }

  // A remote recorded in the transcript wins: it identifies the project even
  // when this device has never checked the repository out.
  const recorded = remoteKey(input.recordedRemote ?? "")

  const local = await isDirectory(directory)
  const worktree = local ? normalizePath(await git(directory, ["rev-parse", "--show-toplevel"])) : ""

  // Prefer the live remote when the directory is present, so a repository that
  // was re-pointed at a new origin follows the new remote.
  const live = local && worktree ? remoteKey(await git(directory, ["remote", "get-url", "origin"])) : ""
  const remote = live || recorded

  if (remote) {
    return {
      projectID: idForRemote(remote),
      source: "remote",
      remote,
      worktree: worktree || "/",
      directory,
      name: basename(remote) || name,
    }
  }

  if (local && worktree) {
    const roots = await git(directory, ["rev-list", "--max-parents=0", "HEAD"])
    const root = roots.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort()[0]
    if (root) {
      return { projectID: root, source: "root-commit", remote: null, worktree, directory, name: basename(worktree) || name }
    }
  }

  // No git identity available: merge on the directory name so the same project
  // observed at different paths on different devices lands in one project.
  if (name && name !== directory) {
    return { projectID: idForName(name), source: "basename", remote: null, worktree: worktree || directory, directory, name }
  }

  return { projectID: "global", source: "global", remote: null, worktree: "/", directory, name: name || "global" }
}

/**
 * Resolve using only what the transcript recorded, without touching git.
 *
 * Used when grouping a large index for reporting, where spawning git per
 * directory would dominate the runtime. A directory with no recorded remote
 * falls back to its basename, which is the same rule `resolve` applies when a
 * directory is not a repository on this device.
 */
export function resolveOffline(input: { directory: string; recordedRemote?: string | null }): ProjectIdentity {
  const directory = normalizePath(input.directory ?? "")
  const name = basename(directory)

  if (!directory) {
    return { projectID: "global", source: "global", remote: null, worktree: "/", directory: "", name: "global" }
  }

  const remote = remoteKey(input.recordedRemote ?? "")
  if (remote) {
    return {
      projectID: idForRemote(remote),
      source: "remote",
      remote,
      worktree: "/",
      directory,
      name: basename(remote) || name,
    }
  }

  if (name && name !== directory) {
    return { projectID: idForName(name), source: "basename", remote: null, worktree: directory, directory, name }
  }

  return { projectID: "global", source: "global", remote: null, worktree: "/", directory, name: name || "global" }
}

/**
 * A resolver that remembers which remote each directory belongs to.
 *
 * Only some tools record the git remote, so within one directory a few sessions
 * carry a remote and the rest carry none. Resolved independently those would
 * split into a `remote` project and a `basename` project for the same work, so
 * this shares every remote it learns — from a transcript or from git — with all
 * other sessions in the same directory.
 *
 * Each distinct directory is consulted at most once, which keeps a full-index
 * grouping to one git invocation per directory rather than one per session.
 */
export function createResolver(options: { consultGit?: boolean } = {}) {
  const consultGit = options.consultGit !== false
  /** directory → remote key learned from a transcript or from git. */
  const remotes = new Map<string, string>()
  /** basename → remote key, used to rescue directories that no longer exist. */
  const byName = new Map<string, string>()
  const resolved = new Map<string, ProjectIdentity>()

  function remember(directory: string, remote: string): void {
    remotes.set(directory, remote)
    const name = basename(directory).toLowerCase()
    if (name && !byName.has(name)) byName.set(name, remote)
  }

  /**
   * Record every remote the transcripts revealed, and — when git is available —
   * every remote the surviving directories know about.
   *
   * Doing this up front makes resolution order-independent: a directory that no
   * longer exists can adopt the remote of a sibling checkout no matter which of
   * the two is resolved first.
   */
  async function learn(entries: Array<{ directory: string; remote?: string | null }>): Promise<void> {
    const directories = new Set<string>()

    for (const entry of entries) {
      const directory = normalizePath(entry.directory ?? "")
      if (!directory) continue
      directories.add(directory)
      if (remotes.has(directory)) continue
      const remote = remoteKey(entry.remote ?? "")
      if (remote) remember(directory, remote)
    }

    if (!consultGit) return

    // Ask git only about directories no transcript described, and only once
    // each: this is one process per distinct directory for the whole index.
    await Promise.all(
      [...directories]
        .filter((directory) => !remotes.has(directory))
        .map(async (directory) => {
          if (!(await isDirectory(directory))) return
          const remote = remoteKey(await git(directory, ["remote", "get-url", "origin"]))
          if (remote) remember(directory, remote)
        }),
    )
  }

  async function identify(directory: string): Promise<ProjectIdentity> {
    const key = normalizePath(directory ?? "")
    const cached = resolved.get(key)
    if (cached) return cached

    const identity = consultGit
      ? await resolve({ directory: key, recordedRemote: remotes.get(key) ?? null })
      : resolveOffline({ directory: key, recordedRemote: remotes.get(key) ?? null })

    // A remote discovered via git is worth remembering for the other sessions
    // that ran in this directory without recording one.
    if (identity.remote) {
      remember(key, identity.remote)
      resolved.set(key, identity)
      return identity
    }

    // A directory that was deleted (a pruned worktree, or a checkout on another
    // device) has no git to consult and no recorded remote, so it would fall to
    // its basename while its surviving siblings resolved to a remote. Adopt the
    // remote already known for that name so the two do not split apart.
    if (identity.source === "basename") {
      const adopted = byName.get(identity.name.toLowerCase())
      if (adopted) {
        const merged: ProjectIdentity = {
          projectID: idForRemote(adopted),
          source: "remote",
          remote: adopted,
          worktree: identity.worktree,
          directory: identity.directory,
          name: identity.name,
        }
        resolved.set(key, merged)
        return merged
      }
    }

    resolved.set(key, identity)
    return identity
  }

  return { learn, identify }
}
