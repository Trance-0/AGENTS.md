import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exportArchive, importArchive, mergeRecords } from '../lib/session-transfer.ts'
import { writeTarGz, readTarGz } from '../lib/archive.ts'

const folder = await mkdtemp(path.join(os.tmpdir(), 'session-transfer-'))
const make = () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE project(id TEXT PRIMARY KEY, time_updated INTEGER);
    CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, metadata TEXT, time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY, seq INTEGER);
    CREATE TABLE event(id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT);`)
  return db
}
const a = make(), b = make(), c = make()
const handle = { step() {}, log() {}, finish() {} }
const file = path.join(folder, 'a.tar.gz'), again = path.join(folder, 'b.tar.gz')
try {
  a.exec(`INSERT INTO project VALUES ('p', 1); INSERT INTO session VALUES ('s','p','{}',1);
    INSERT INTO message VALUES ('m','s','{"role":"assistant"}',1,1);
    INSERT INTO part VALUES ('tool','m','s','{"type":"tool","state":{"status":"completed","output":"中文"}}',1,1);
    INSERT INTO event_sequence VALUES ('s',1);
    INSERT INTO event VALUES ('e','s',1,'tool.completed','{"result":"retained"}');`)
  b.exec(`INSERT INTO project VALUES ('local',1); INSERT INTO session VALUES ('local','local','{}',1);`)
  const invalid = { key:'codex:remote', kind:'codex', nativeID:'remote', device:'other-device',
    file: path.join(folder, 'missing.jsonl'), directory:'Z:/unavailable', title:'retained pointer',
    remote:null, branch:null, sourceTitle:null, model:'', created:1, modified:1, size:1, fingerprint:'1:1', missing:true }
  console.log('Testing A -> B, with unrelated existing history and an invalid source pointer')
  await exportArchive(a, file, [invalid])
  await importArchive(b, file, handle)
  assert.equal(b.prepare('SELECT count(*) n FROM session').get().n, 2)
  assert.deepEqual(b.prepare('SELECT * FROM part').all(), a.prepare('SELECT * FROM part').all())
  assert.deepEqual(b.prepare('SELECT * FROM event').all(), a.prepare('SELECT * FROM event').all())
  const before = b.prepare('SELECT count(*) n FROM plugin_session_archive_history').get().n
  await importArchive(b, file, handle)
  assert.equal(b.prepare('SELECT count(*) n FROM session').get().n, 2)
  assert.equal(b.prepare('SELECT count(*) n FROM plugin_session_archive_history').get().n, before)
  console.log('Testing same-length tool updates, divergent destination edits, and older archive replay')
  b.exec(`UPDATE part SET data='{"type":"tool","output":"destination edit"}', time_updated=2`)
  a.exec(`UPDATE part SET data='{"type":"tool","output":"source update"}', time_updated=3`)
  await exportArchive(a, file, [])
  await importArchive(b, file, handle)
  assert.equal(b.prepare('SELECT data FROM part').get().data, '{"type":"tool","output":"source update"}')
  assert.ok(b.prepare("SELECT count(*) n FROM plugin_session_archive_history WHERE payload LIKE '%destination edit%'").get().n)
  console.log('Testing B -> C re-export: complete history and invalid pointer retained without original source')
  await exportArchive(b, again, [])
  await importArchive(c, again, handle)
  assert.equal(c.prepare('SELECT count(*) n FROM session').get().n, 2)
  assert.ok(c.prepare("SELECT count(*) n FROM plugin_session_archive_history WHERE payload LIKE '%retained pointer%'").get().n)
  assert.ok(c.prepare("SELECT count(*) n FROM plugin_session_archive_history WHERE payload LIKE '%destination edit%'").get().n)
  const entries = []
  for await (const e of readTarGz(again)) entries.push(e)
  const bad = path.join(folder, 'bad.tar.gz')
  const history = entries.find((e) => e.name.startsWith('history/'))
  history.data = Buffer.from('{}')
  await writeTarGz(bad, (async function* () { yield* entries })())
  await assert.rejects(importArchive(c, bad, handle), /checksum mismatch/)
  console.log('Testing same external source imported on two devices under different session/message IDs')
  const d = make()
  const meta = JSON.stringify({ imported: { source: 'codex', sourceID: 'native', device: 'origin' } })
  d.prepare('INSERT INTO project VALUES (?,?)').run('p',1)
  d.prepare('INSERT INTO session VALUES (?,?,?,?)').run('dest','p',meta,1)
  d.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('dm','dest','{"role":"user"}',1,1)
  d.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('dp','dm','dest','{"type":"text","text":"same"}',1,1)
  const imported = [
    { table:'session', row:{ id:'source',project_id:'p',metadata:meta,time_updated:1 } },
    { table:'message', row:{ id:'sm',session_id:'source',data:'{"role":"user"}',time_created:1,time_updated:1 } },
    { table:'part', row:{ id:'sp',message_id:'sm',session_id:'source',data:'{"type":"text","text":"same"}',time_created:1,time_updated:1 } },
  ]
  mergeRecords(d, imported)
  mergeRecords(d, imported)
  assert.equal(d.prepare('SELECT count(*) n FROM session').get().n,1)
  assert.equal(d.prepare('SELECT count(*) n FROM message').get().n,1)
  assert.equal(d.prepare('SELECT count(*) n FROM part').get().n,1)
  d.close()
  console.log('Testing full deployed schema in isolated in-memory databases')
  const live = new DatabaseSync(path.join(os.homedir(), '.local/share/opencode/opencode.db'), { readOnly:true })
  const schema = live.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  live.close()
  const realA = new DatabaseSync(':memory:'), realB = new DatabaseSync(':memory:')
  for (const row of schema) { realA.exec(row.sql); realB.exec(row.sql) }
  realA.exec(`PRAGMA foreign_keys=ON;
    INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('rp','Z:/remote',1,1,'[]');
    INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES ('rs','rp','rs','Z:/remote','test','1',1,1);
    INSERT INTO message VALUES ('rm','rs',1,1,'{"role":"assistant"}');
    INSERT INTO part VALUES ('rpart','rm','rs',1,1,'{"type":"tool","tool":"bash","state":{"status":"completed","output":"test"}}');`)
  realB.exec('PRAGMA foreign_keys=ON')
  await exportArchive(realA, file, [])
  await importArchive(realB, file, handle)
  assert.deepEqual(realA.prepare('SELECT * FROM session').all(), realB.prepare('SELECT * FROM session').all())
  assert.deepEqual(realA.prepare('SELECT * FROM part').all(), realB.prepare('SELECT * FROM part').all())
  realA.close(); realB.close()
  console.log('PASS: full tool/event records, idempotency, updates, retained revisions, invalid pointers, re-export, corruption rejection')
} finally {
  a.close(); b.close(); c.close()
  await rm(folder, { recursive: true, force: true })
}
