import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { run } from '../cli'
import { chatRecords, contextReports, hookStatus, parseHookStatus, sessionStore } from './stores'

test('reads only the requested chat records, rejecting unsafe session ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quick-actions-'))
  const store = join(dir, 'domain.db')
  try {
    await run('sqlite3', [
      store,
      `create table agent_session_records (session_id, record_json);
       insert into agent_session_records values ('a', '{"provider":"claude"}'), ('b', '{"provider":"codex"}');`
    ])
    const records = await chatRecords(['a', 'a', "x') or 1=1 --"], { path: store, layout: 'domain' })
    assert.deepEqual(Object.fromEntries(records), { a: { provider: 'claude' } })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("reads each chat session's context from Orca's last report", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quick-actions-'))
  const store = join(dir, 'store.db')
  const row = (kind: string, window: number, used = window / 4, at = window) =>
    JSON.stringify({ body: { kind: 'turn', contextUsage: { used: { kind, windowTokens: window, usedTokens: used, capturedAt: at } } } }).replace(/'/g, "''")
  try {
    await run('sqlite3', [
      store,
      `create table journal_outcomes (generation, seq, field, entry_key, format, ordinal, value_json, deleted);
       create table journal_outcome_generations (generation, session_id, epoch);
       create table journal_rows (session_id, epoch, seq, ts, row_json);
       insert into journal_outcome_generations values (1, 'claude_a', 'e1'), (2, 'claude_a', 'e2');
       insert into journal_outcomes values
         (1, 9, 'items', 'k1', 2, '', '${row('report', 1_000_000)}', 0),
         (2, 3, 'items', 'k2', 2, '', '${row('report', 400_000)}', 0),
         (2, 4, 'items', 'k3', 2, '', '${row('estimate', 0)}', 0);
       insert into journal_rows values
         ('claude_a', 'e0', 1, 0, '${row('report', 200_000)}'),
         ('claude_b', 'e0', 1, 0, '${row('report', 1_000_000)}'),
         ('claude_b', 'e0', 2, 0, '${row('report', 400_000)}');`
    ])
    // The newest generation's last report wins; an estimate carries no window; old sessions read their rows.
    const reports = await contextReports(['claude_a', 'claude_b', 'claude_c', "x'; drop table journal_rows; --"], { path: store, layout: 'journal' })
    assert.deepEqual(Object.fromEntries(reports), {
      claude_a: { window: 400_000, used: 100_000, at: 400_000 },
      claude_b: { window: 400_000, used: 100_000, at: 400_000 }
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("reads each chat session's context from the domain store's items", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quick-actions-'))
  const store = join(dir, 'domain.db')
  const item = (id: string, sequence: number, kind: string, window: number, at: number, hidden = 0) =>
    `('${id}', 'e', '${id}-${sequence}', ${sequence}, ${hidden}, 1, '${JSON.stringify({
      body: { kind: 'turn', contextUsage: { used: { kind, windowTokens: window, usedTokens: window / 4, capturedAt: at } } }
    })}')`
  try {
    await run('sqlite3', [
      store,
      `create table journal_items (session_id, epoch, item_id, sequence, hidden, context_window, payload_json, sequence_index default 0, ordinal default 0);
       insert into journal_items (session_id, epoch, item_id, sequence, hidden, context_window, payload_json) values
         ${item('a', 1, 'report', 1_000_000, 10)},
         ${item('a', 2, 'report', 400_000, 20)},
         ${item('a', 3, 'estimate', 200_000, 30)},
         ${item('a', 4, 'report', 800_000, 40, 1)},
         ${item('b', 1, 'report', 200_000, 5)};`
    ])
    // The newest visible report wins; an estimate and a hidden item are left out.
    const reports = await contextReports(['a', 'b', 'c', "x'; drop table journal_items; --"], { path: store, layout: 'domain' })
    assert.deepEqual(Object.fromEntries(reports), {
      a: { window: 400_000, used: 100_000, at: 20 },
      b: { window: 200_000, used: 50_000, at: 5 }
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("reads chats from Orca's domain store, else its older journal store", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quick-actions-'))
  const domain = join(dir, 'agent-session-domain.db')
  const journal = join(dir, 'agent-session-journal.db')
  try {
    assert.deepEqual(sessionStore(domain, journal), { path: journal, layout: 'journal' })
    await writeFile(domain, '')
    assert.deepEqual(sessionStore(domain, journal), { path: domain, layout: 'domain' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("reads terminal sessions' transcripts from Orca's hook status entries", () => {
  const hooks = parseHookStatus(
    JSON.stringify({ entries: { 'tab:leaf': { source: 'claude', providerSession: { transcriptPath: '/t.jsonl', effort: 'max' } }, other: { source: 'shell' } } })
  )
  assert.deepEqual([...hooks.keys()], ['tab:leaf'])
  assert.deepEqual(hooks.get('tab:leaf'), { agent: 'claude', transcript: '/t.jsonl', model: null, effort: 'max' })
})

test("reads terminal sessions from Orca's hook status log, else its older file", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quick-actions-'))
  const db = join(dir, 'last-status.db')
  const json = join(dir, 'last-status.json')
  const row = (seq: number, key: string, value: object) => `(${seq}, '${key}', '${JSON.stringify(value)}')`
  try {
    await run('sqlite3', [
      db,
      `create table rows (seq, key, value);
       insert into rows values
         ${row(1, 'entry', { paneKey: 't1:l1', source: 'codex', providerSession: { transcriptPath: '/old.jsonl' } })},
         ${row(2, 'entry', { paneKey: 't2:l2', source: 'claude', providerSession: { transcriptPath: '/c.jsonl', effort: 'high' } })},
         ${row(3, 'commitment', { paneKey: 't2:l2', launchTokenHash: 'h' })},
         ${row(4, 'entry', { paneKey: 't3:l3', source: 'shell' })},
         ${row(5, 'entry', { paneKey: 't1:l1', source: 'codex', providerSession: { transcriptPath: '/new.jsonl' } })};`
    ])
    // A later row for a pane replaces an earlier one; rows without an agent are left out.
    const hooks = await hookStatus(db, json)
    assert.deepEqual(Object.fromEntries(hooks), {
      't1:l1': { agent: 'codex', transcript: '/new.jsonl', model: null, effort: null },
      't2:l2': { agent: 'claude', transcript: '/c.jsonl', model: null, effort: 'high' }
    })
    await writeFile(json, JSON.stringify({ entries: { 'old:leaf': { source: 'claude', providerSession: { transcriptPath: '/o.jsonl' } } } }))
    assert.deepEqual([...(await hookStatus(join(dir, 'missing.db'), json)).keys()], ['old:leaf'], 'an older Orca keeps its JSON file')
    assert.equal((await hookStatus(join(dir, 'missing.db'), join(dir, 'missing.json'))).size, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
