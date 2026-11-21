// Reads what Orca keeps on disk and its CLI does not report: the hook status of terminal sessions
// and, from its session store, chat sessions' records, context reports and tab positions. These
// are Orca's private files and tables, read with `sqlite3 -readonly`: an Orca update can move them.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from '../cli'

const ORCA_DATA = join(homedir(), 'Library', 'Application Support', 'orca')
// Orca keeps its hook status in an SQLite log since 1.4.256, and in a JSON file before.
const HOOK_STATUS_DB = join(ORCA_DATA, 'agent-hooks', 'last-status.db')
const HOOK_STATUS_JSON = join(ORCA_DATA, 'agent-hooks', 'last-status.json')
// Orca keeps chat sessions in its domain store since 1.4.262, and in its journal store before.
const DOMAIN_STORE = join(ORCA_DATA, 'agent-session-domain.db')
const JOURNAL_STORE = join(ORCA_DATA, 'agent-session-journal.db')
const CHAT_PANE = 'structured-agent-session-'
const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** Orca's chat session store and its layout: the domain store where it exists, else the journal store. */
export type SessionStore = { path: string; layout: 'domain' | 'journal' }

export function sessionStore(domain = DOMAIN_STORE, journal = JOURNAL_STORE): SessionStore {
  return existsSync(domain) ? { path: domain, layout: 'domain' } : { path: journal, layout: 'journal' }
}

export type Agent = 'claude' | 'codex'
/** Where a session's numbers live: its transcript, and what Orca knows without reading it. */
export type Source = { agent: Agent; transcript: string | null; model: string | null; effort: string | null }

type HookEntry = { paneKey?: string; source?: string; providerSession?: { transcriptPath?: string; effort?: string } }

/** Terminal sessions' transcripts and effort, by pane key, from Orca's hook status file. */
export function parseHookStatus(json: string): Map<string, Source> {
  return hookSources(Object.entries((JSON.parse(json) as { entries?: Record<string, HookEntry> }).entries ?? {}))
}

/**
 * Terminal sessions' transcripts and effort, by pane key, from Orca's hook status store: the SQLite
 * log, whose later rows replace earlier ones, else the JSON file of an older Orca.
 */
export async function hookStatus(db = HOOK_STATUS_DB, json = HOOK_STATUS_JSON): Promise<Map<string, Source>> {
  const out = await run('sqlite3', ['-readonly', '-json', db, 'select value from rows order by seq']).catch(() => null)
  if (out === null) {
    return readFile(json, 'utf8').then(parseHookStatus).catch(() => new Map<string, Source>())
  }
  const rows = out.trim() ? (parse<{ value: string }[]>(out) ?? []) : []
  return hookSources(rows.flatMap((row) => {
    const entry = parse<HookEntry>(row.value)
    return entry?.paneKey && entry.source ? [[entry.paneKey, entry] as [string, HookEntry]] : []
  }))
}

function hookSources(entries: [string, HookEntry][]): Map<string, Source> {
  const sources = new Map<string, Source>()
  for (const [paneKey, entry] of entries) {
    const agent = entry.source === 'claude' || entry.source === 'codex' ? entry.source : null
    if (agent) {
      const session = entry.providerSession
      sources.set(paneKey, { agent, transcript: session?.transcriptPath ?? null, model: null, effort: session?.effort ?? null })
    }
  }
  return sources
}

export type ChatRecord = {
  provider?: string
  createdAt?: number
  accountHome?: { path?: string }
  location?: { workspaceId?: string }
  options?: { model?: string; effort?: string }
  providerHandleChain?: { handle?: { sessionId?: string; threadId?: string } }[]
}

function parse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T
  } catch {
    return null
  }
}

export async function chatRecords(ids: string[], store: SessionStore): Promise<Map<string, ChatRecord>> {
  if (!ids.length) {
    return new Map()
  }
  const list = ids.map((id) => `'${id}'`).join(',')
  const out = await run('sqlite3', [
    '-readonly',
    '-json',
    store.path,
    `select session_id, record_json from agent_session_records where session_id in (${list})`
  ]).catch(() => '')
  const rows = out.trim() ? (parse<{ session_id: string; record_json: string }[]>(out) ?? []) : []
  return new Map(rows.flatMap((row) => {
    const record = parse<ChatRecord>(row.record_json)
    return record ? [[row.session_id, record] as [string, ChatRecord]] : []
  }))
}

/** Orca's last context report for a chat: the window, the tokens in it, and when it was read (ms). */
export type ContextReport = { window: number | null; used: number | null; at: number }

/**
 * The context Orca last reported for each of these chat sessions, by session id. Claude's window
 * differs between sessions of one model (400k or 1M), so this beats a guess by model; and Orca
 * reads the context again after a compaction, which the transcript does not record. The domain
 * store keeps reports in `journal_items`; the journal store kept them in `journal_outcomes`, and
 * older sessions there in `journal_rows`.
 */
export async function contextReports(ids: string[], store = sessionStore()): Promise<Map<string, ContextReport>> {
  const safe = [...new Set(ids)].filter((id) => SAFE_ID.test(id))
  if (!safe.length) {
    return new Map()
  }
  const list = safe.map((id) => `'${id}'`).join(',')
  const report = (column: string) =>
    `${column} like '%"kind":"report"%' and json_extract(${column}, '$.body.contextUsage.used.kind') = 'report'`
  const fields = (column: string) =>
    ['windowTokens as window', 'usedTokens as used', 'capturedAt as at']
      .map((field) => {
        const [key, name] = field.split(' as ')
        return `json_extract(${column}, '$.body.contextUsage.used.${key}') as ${name}`
      })
      .join(', ')
  const domain = `
    select id, window, used, at from (
      select session_id as id, ${fields('payload_json')},
        row_number() over (
          partition by session_id
          order by json_extract(payload_json, '$.body.contextUsage.used.capturedAt') desc, sequence desc, sequence_index desc, ordinal desc
        ) as n
      from journal_items where session_id in (${list}) and hidden = 0 and context_window = 1 and ${report('payload_json')}
    ) where n = 1`
  const journal = `
    with outcomes as (
      select id, window, used, at from (
        select g.session_id as id, ${fields('o.value_json')},
          row_number() over (partition by g.session_id order by o.generation desc, o.seq desc) as n
        from journal_outcomes o join journal_outcome_generations g on g.generation = o.generation
        where g.session_id in (${list}) and o.field = 'items' and ${report('o.value_json')}
      ) where n = 1
    ), legacy as (
      select id, window, used, at from (
        select session_id as id, ${fields('row_json')},
          row_number() over (partition by session_id order by seq desc) as n
        from journal_rows where session_id in (${list}) and ${report('row_json')}
      ) where n = 1
    )
    select id, window, used, at from outcomes
    union all select id, window, used, at from legacy where id not in (select id from outcomes)`
  const sql = store.layout === 'domain' ? domain : journal
  const out = await run('sqlite3', ['-readonly', '-json', store.path, sql]).catch(() => '')
  const rows = out.trim() ? (parse<{ id: string; window: unknown; used: unknown; at: unknown }[]>(out) ?? []) : []
  const count = (value: unknown) => (typeof value === 'number' && value > 0 ? value : null)
  return new Map(rows.map((row) => [row.id, { window: count(row.window), used: count(row.used), at: count(row.at) ?? 0 }]))
}

/** The sidebar position of these chat tabs, by tab id, from Orca's session store; others are left out. */
export async function tabPositions(tabIds: string[], store = sessionStore()): Promise<Map<string, number>> {
  const ids = [...new Set(tabIds)].filter((id) => id.startsWith(CHAT_PANE) && SAFE_ID.test(id))
  if (!ids.length) {
    return new Map()
  }
  const list = ids.map((id) => `'${id}'`).join(',')
  const out = await run('sqlite3', ['-readonly', '-json', store.path, `select tab_id, position from agent_session_tabs where tab_id in (${list})`]).catch(
    () => ''
  )
  const rows = out.trim() ? (parse<{ tab_id: string; position: number }[]>(out) ?? []) : []
  return new Map(rows.filter((row) => typeof row.position === 'number').map((row) => [row.tab_id, row.position]))
}
