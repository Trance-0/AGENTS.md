import crypto from 'node:crypto'
import { redactForPcp } from './pcp-redact.ts'
import type { IndexEntry } from './index-store.ts'
import type { Turn } from './sources.ts'
import type { ProjectIdentity } from './project-identity.ts'
import * as PCP from './pcp.ts'

/** IDs survive retry/cursor loss and distinguish repeated identical messages. */
export function messagesWithIdentity(entry: IndexEntry, turns: Turn[]) {
  const seen = new Map<string, number>()
  return turns.map(turn => {
    const hash = crypto.createHash('sha256').update(JSON.stringify([entry.kind, entry.nativeID, turn.role, turn.time ?? null, turn.text])).digest('hex')
    const occurrence = seen.get(hash) || 0
    seen.set(hash, occurrence + 1)
    return { external_id: `${hash}:${occurrence}`, role: turn.role, content: redactForPcp(turn.text).slice(0, PCP.MAX_CONTENT_CHARS),
      provider: entry.kind, base_model: entry.model || undefined,
      ...(turn.time && Number.isFinite(turn.time) && turn.time >= 946684800000 ? { provider_timestamp: new Date(turn.time).toISOString() } : {}) }
  })
}

export function projectRegistration(entry: IndexEntry, identity: ProjectIdentity) {
  const directory = identity.directory
  const realDirectory = (directory.startsWith('/') || /^[A-Za-z]:\//.test(directory))
    && !directory.includes('/.codex/worktrees/') && !directory.includes('/session-manager/projects/')
  const kind = /^[A-Za-z]:\//.test(directory) ? 'windows' : directory.startsWith('/Users/') ? 'macos' : 'linux'
  return {
    canonical_key: identity.remote ? `git:${identity.remote.toLowerCase()}` : `name:${identity.name.toLowerCase()}`,
    display_name: identity.name,
    ...(identity.remote ? { git_remotes: [`https://${identity.remote}`] } : {}),
    ...(realDirectory ? { workspace: { device_id: entry.device, device_kind: kind, directory,
      ...(entry.branch ? { default_branch: entry.branch } : {}), seen_at: new Date(entry.modified).toISOString() } } : {}),
  }
}

export async function pushTranscript(entry: IndexEntry, config: PCP.Config, turns: Turn[], identity: ProjectIdentity, force: boolean) {
  const externalKey = `${entry.device}:${entry.kind}:${entry.nativeID}`
  const previous = entry.pcp
  if (!turns.length) return { key: entry.key, externalKey, status: 'empty' as const }
  if (previous && !force && turns.length < previous.turns) throw new Error(`Transcript cannot sync: session-manager/PCP source identity — ${entry.key} was rewritten; review it before forcing a replay`)
  const remote = await PCP.ensureSession(config, externalKey, entry.title, 'exact')
  const registered = await PCP.ensureProject(config, projectRegistration(entry, identity))
  const context = await PCP.syncContext(config, externalKey, {
    project_id: registered.project.id, context_title: entry.sourceTitle || entry.title,
    updated_at: new Date(entry.modified).toISOString(), device_id: entry.device,
  })
  const all = messagesWithIdentity(entry, turns)
  // The first ID-based replay lets PCP adopt matching legacy rows in place.
  const start = force || previous?.identityVersion !== 2 ? 0 : previous.turns
  let added = 0
  for (let offset = start; offset < all.length; offset += PCP.MAX_MESSAGES_PER_REQUEST) {
    const result = await PCP.mergeMessages(config, externalKey, entry.device, all.slice(offset, offset + PCP.MAX_MESSAGES_PER_REQUEST))
    added += result.appended
  }
  entry.pcp = { identityVersion: 2, sessionID: remote.session_id, accessToken: remote.access_token ?? previous?.accessToken,
    turns: turns.length, fingerprint: entry.fingerprint, pushedAt: Date.now() }
  return { key: entry.key, externalKey, status: added ? 'pushed' as const : 'up-to-date' as const,
    sessionID: remote.session_id, projectID: registered.project.id, turns: turns.length, added, conflicts: context.conflicts }
}
