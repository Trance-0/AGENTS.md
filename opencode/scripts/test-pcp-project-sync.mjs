import assert from 'node:assert/strict'
import { redactForPcp } from '../lib/pcp-redact.ts'
import { messagesWithIdentity, projectRegistration, pushTranscript } from '../lib/pcp-project-sync.ts'

const entry = { key: 'codex:test', kind: 'codex', nativeID: 'test', device: 'linux-test', title: 'Build task', sourceTitle: 'Task title',
  directory: '/work/repo', remote: 'https://example.test/owner/repo.git', branch: 'main', created: 1700000000000,
  modified: 1700000010000, model: 'model', fingerprint: 'first' }
const identity = { projectID: 'remote-id', remote: 'example.test/owner/repo', name: 'repo', directory: '/work/repo', worktree: '/work/repo', source: 'remote' }
const turns = [{ role: 'user', text: 'repeat' }, { role: 'user', text: 'repeat' }, { role: 'assistant', text: 'done', time: 1700000001000 }]
const sensitive = 'token=abcdef1234567890 Bearer abcdefghijklmnop'
assert.equal(redactForPcp(sensitive), 'token=<REDACTED> Bearer <REDACTED>')
assert.equal(redactForPcp(redactForPcp(sensitive)), redactForPcp(sensitive))
const first = messagesWithIdentity(entry, turns)
assert.notEqual(first[0].external_id, first[1].external_id)
assert.deepEqual(messagesWithIdentity(entry, [...turns, { role: 'user', text: 'later' }]).slice(0, 3), first)
assert.equal(first[0].provider_timestamp, undefined, 'unknown timestamps are never invented')
assert.equal(first[2].provider_timestamp, '2023-11-14T22:13:21.000Z')
assert.equal(projectRegistration(entry, identity).canonical_key, 'git:example.test/owner/repo')
assert.equal(projectRegistration(entry, { ...identity, directory: '/home/a/.codex/worktrees/scratch' }).workspace, undefined)
const fetch = globalThis.fetch
const requests = [], ids = new Set()
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body), pathname = new URL(url).pathname
  requests.push({ pathname, method: init.method, body })
  let value
  if (pathname.endsWith('/manager/sessions')) value = { session_id: 'session', access_token: 'fixture' }
  else if (pathname.endsWith('/manager/projects')) value = { project: { id: 'project' }, created: false }
  else if (pathname.endsWith('/context')) value = { conflicts: [] }
  else if (pathname.endsWith('/merge-messages')) {
    const appended = body.messages.filter(message => !ids.has(message.external_id)).length
    for (const message of body.messages) ids.add(message.external_id)
    value = { appended, duplicates: body.messages.length - appended }
  } else throw new Error('Unexpected route')
  return new Response(JSON.stringify(value), { status: 200 })
}
try {
  const config = { baseURL: 'https://pcp.example.test', scopedToken: 'fixture', exportDir: '' }
  const one = await pushTranscript(entry, config, turns, identity, false)
  assert.equal(one.added, 3)
  assert.equal(entry.pcp.identityVersion, 2)
  assert.equal((await pushTranscript(entry, config, turns, identity, true)).added, 0)
  assert.equal(requests.find(r => r.pathname.endsWith('/context')).body.device_id, 'linux-test')
  assert.equal(requests.find(r => r.pathname.endsWith('/context')).body.updated_at, new Date(entry.modified).toISOString())
  await assert.rejects(pushTranscript(entry, config, turns.slice(0, 1), identity, false), /was rewritten/)
  assert.equal(ids.size, 3)
  console.info('PCP project sync passed: stable identities, repeated messages, project/workspace registration, versioned context, cursor recovery and replay.')
} finally { globalThis.fetch = fetch }
