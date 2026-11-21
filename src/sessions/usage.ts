// Each session's model, effort and token use. Orca does not report them, so they come from the
// agent's own transcript, found by the session id Orca's host gives each pane, read once and then
// only as it grows. A Claude session's window and effort come from Claude Code's settings and flags.
import { access, open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { agentSessions } from '../orca/agent-sessions'
import type { AgentSession } from '../orca/agent-sessions'
import { listWorkspaces } from '../orca/commands'
import { contextWindow, effortOf, liveLaunches, NO_LAUNCH, settingsFor } from './claude-settings'
import type { ClaudeSettings } from './claude-settings'
import type { SessionUsage, TokenSplit } from '../protocol'

/** Claude names a project's transcript folder after its working directory. */
const claudeFolder = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

const exists = (path: string) => access(path).then(() => true, () => false)

/** A Claude session's transcript: in its checkout's folder, else in any project folder, as for a session started in a subfolder. */
async function claudeTranscript(sessionId: string, cwd: string): Promise<string | null> {
  const root = join(homedir(), '.claude', 'projects')
  const direct = join(root, claudeFolder(cwd), `${sessionId}.jsonl`)
  if (await exists(direct)) {
    return direct
  }
  for (const folder of await readdir(root).catch(() => [] as string[])) {
    const path = join(root, folder, `${sessionId}.jsonl`)
    if (await exists(path)) {
      return path
    }
  }
  return null
}

// How many days back from today to look for a Codex rollout: Codex files it under the day it started.
const CODEX_DAYS = 60

/** A Codex thread's rollout file, in the folder of the local day the thread started. */
async function codexTranscript(thread: string, now = Date.now()): Promise<string | null> {
  const root = join(homedir(), '.codex', 'sessions')
  const day = 24 * 60 * 60 * 1000
  for (let back = -1; back <= CODEX_DAYS; back++) {
    const date = new Date(now - back * day)
    const folder = join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'))
    const name = (await readdir(folder).catch(() => [] as string[])).find((file) => file.endsWith(`-${thread}.jsonl`))
    if (name) {
      return join(folder, name)
    }
  }
  return null
}

/** Text with JSON's escaped line breaks and tabs, and every run of white space, as one space. */
export const flattened = (text: string) => text.replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ')

/** A run of a reply that its flattened transcript line holds as written: no quote or backslash, which JSON escapes. */
export function replySnippet(reply: string): string | null {
  return /[^"\\]{24,80}/.exec(flattened(reply).trim())?.[0] ?? null
}

// How many of a checkout's newest transcripts, and how much of each one's end, to search for a reply.
const REPLY_FILES = 15
const REPLY_TAIL_BYTES = 512 * 1024

async function tailOf(path: string, size: number): Promise<string> {
  const file = await open(path, 'r')
  try {
    const length = Math.min(size, REPLY_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await file.close()
  }
}

/**
 * A Claude transcript in the checkout's folder whose end holds the agent's last reply, the newest
 * first: for a pane Orca gives no session id.
 */
async function claudeTranscriptByReply(cwd: string, reply: string): Promise<string | null> {
  const snippet = replySnippet(reply)
  if (!snippet) {
    return null
  }
  const folder = join(homedir(), '.claude', 'projects', claudeFolder(cwd))
  const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl'))
  const found = await Promise.all(names.map(async (name) => ({ path: join(folder, name), info: await stat(join(folder, name)).catch(() => null) })))
  const files = found
    .flatMap((file) => (file.info ? [{ path: file.path, size: file.info.size, at: file.info.mtimeMs }] : []))
    .sort((x, y) => y.at - x.at)
    .slice(0, REPLY_FILES)
  for (const file of files) {
    if (flattened(await tailOf(file.path, file.size).catch(() => '')).includes(snippet)) {
      return file.path
    }
  }
  return null
}

/** Transcripts found, by agent and session id, or by pane and reply for a pane without an id. */
const transcripts = new Map<string, string>()

/** A session's transcript, and the session id it is named after. */
async function transcriptOf(key: string, session: AgentSession): Promise<{ path: string; sessionId: string } | null> {
  const id = session.sessionId ? `${session.agent}:${session.sessionId}` : `${key}:${session.reply}`
  let path = transcripts.get(id) ?? null
  if (!path) {
    if (session.agent === 'claude') {
      path = session.sessionId
        ? await claudeTranscript(session.sessionId, session.path)
        : session.reply
          ? await claudeTranscriptByReply(session.path, session.reply)
          : null
    } else if (session.agent === 'codex' && session.sessionId) {
      path = await codexTranscript(session.sessionId)
    }
    if (path) {
      transcripts.set(id, path)
    }
  }
  const name = path?.split('/').pop()?.replace(/\.jsonl$/, '') ?? ''
  return path ? { path, sessionId: session.sessionId ?? name } : null
}

/** A transcript line, as far as the tally reads it. */
type Row = {
  type?: string
  subtype?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  timestamp?: string
  compactMetadata?: { postTokens?: unknown }
  /** The effort a Claude reply ran at. */
  effort?: unknown
  message?: { id?: string; model?: string; usage?: Record<string, unknown>; content?: unknown }
  payload?: Record<string, unknown>
}

/** Lines the tally reads; any other line is skipped without parsing it. */
const MARKERS = ['"usage"', '"type":"user"', '"compact_boundary"', '"turn_context"', '"token_count"', '"task_started"', '"compacted"', '_call"']

/**
 * Whether a Claude user line is a prompt the person sent: not a tool result, an injected skill or
 * reminder, a local command's output, a background task's notice or a compaction's summary. A
 * skill the person invokes (`<command-message>`) is a prompt.
 */
function claudePrompt(row: Row): boolean {
  if (row.type !== 'user' || row.isSidechain || row.isMeta || row.isCompactSummary) {
    return false
  }
  const content = row.message?.content
  const blocks = Array.isArray(content) ? (content as { type?: string; text?: string }[]) : []
  if (blocks.some((block) => block.type === 'tool_result')) {
    return false
  }
  const text = (typeof content === 'string' ? content : (blocks.find((block) => block.type === 'text')?.text ?? '')).trimStart()
  if (!text && !blocks.length) {
    return false
  }
  if (text.startsWith('[Request interrupted')) {
    return false
  }
  return !text.startsWith('<') || text.startsWith('<command-message>')
}

/** What a transcript has said so far; `feed` takes each new run of whole lines. */
export class Tally {
  model: string | null = null
  effort: string | null = null
  /** Prompts the person sent, those since the last compaction, and how often the context was compacted. */
  turns = 0
  turnsSinceCompaction = 0
  compactions = 0
  /** Tools the agent called in the main thread; a subagent's calls are in its own transcript. */
  get toolCalls(): number {
    return this.claudeTools.size + this.codexTools
  }
  get toolCallsSinceCompaction(): number {
    return this.toolCalls - this.toolCallsAtCompaction
  }
  private toolCallsAtCompaction = 0
  // Claude writes each content block on its own line, and a copied line repeats it: count each id once.
  private claudeTools = new Set<string>()
  private codexTools = 0
  private codexTokens: number | null = null
  private codexSplit: TokenSplit | null = null
  /** Tokens in the context window at the last turn, and the window's size when the agent records it. */
  context: number | null = null
  contextWindow: number | null = null
  /** When `context` was read (or a compaction made it unknown), in ms; 0 when the line had no time. */
  contextAt = 0
  // Claude writes one line per content block, each repeating its message's usage: count each once.
  private claudeTokens = new Map<string, TokenSplit>()

  feed(text: string): void {
    for (const line of text.split('\n')) {
      // A tool's result is never a prompt, and can be large: skip it unless it carries usage.
      const toolResult = line.includes('"toolUseResult"')
      if (!MARKERS.some((marker) => line.includes(marker)) || (toolResult && !line.includes('"usage"'))) {
        continue
      }
      const row = parse<Row>(line)
      if (row) {
        this.claudeRow(row)
        this.codexRow(row)
      }
    }
  }

  private turn(): void {
    this.turns += 1
    this.turnsSinceCompaction += 1
  }

  /** A compaction shrinks the context to the size Claude records, else to unknown until the agent's next reply. */
  private compaction(row: Row): void {
    this.compactions += 1
    this.turnsSinceCompaction = 0
    this.toolCallsAtCompaction = this.toolCalls
    const after = row.compactMetadata?.postTokens
    this.setContext(typeof after === 'number' && after > 0 ? after : null, row)
  }

  private setContext(tokens: number | null, row: Row): void {
    this.context = tokens
    this.contextAt = row.timestamp ? Date.parse(row.timestamp) || 0 : 0
  }

  get tokens(): number | null {
    if (this.codexTokens !== null) {
      return this.codexTokens
    }
    const split = this.tokenSplit
    return split ? split.input + split.cached + split.output : null
  }

  /** The tokens used, split into input read fresh, input read from the cache, and output. */
  get tokenSplit(): TokenSplit | null {
    if (this.codexTokens !== null) {
      return this.codexSplit
    }
    if (!this.claudeTokens.size) {
      return null
    }
    const sum: TokenSplit = { input: 0, cached: 0, output: 0 }
    for (const split of this.claudeTokens.values()) {
      sum.input += split.input
      sum.cached += split.cached
      sum.output += split.output
    }
    return sum
  }

  private claudeRow(row: Row): void {
    if (row.type === 'assistant' && !row.isSidechain && typeof row.effort === 'string' && row.effort) {
      this.effort = row.effort
    }
    if (row.type === 'system' && row.subtype === 'compact_boundary' && !row.isSidechain) {
      this.compaction(row)
    } else if (claudePrompt(row)) {
      this.turn()
    }
    const message = row.message
    if (row.type === 'assistant' && !row.isSidechain && Array.isArray(message?.content)) {
      for (const block of message.content as { type?: string; id?: string }[]) {
        if (block.type === 'tool_use' && block.id) {
          this.claudeTools.add(block.id)
        }
      }
    }
    const usage = message?.usage
    if (!message?.id || !usage) {
      return
    }
    if (message.model && !message.model.startsWith('<')) {
      this.model = message.model
    }
    const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
    // Input written to the cache is input; input read back from it is cached.
    const split = { input: count('input_tokens') + count('cache_creation_input_tokens'), cached: count('cache_read_input_tokens'), output: count('output_tokens') }
    this.claudeTokens.set(message.id, split)
    // A subagent's turns run in their own context.
    if (!row.isSidechain) {
      this.setContext(split.input + split.cached, row)
    }
  }

  private codexRow(row: Row): void {
    const payload = row.payload
    if (row.type === 'compacted') {
      this.compaction(row)
    } else if (row.type === 'response_item' && typeof payload?.type === 'string' && payload.type.endsWith('_call')) {
      // `function_call`, `custom_tool_call`, `local_shell_call`, ...; their outputs end in `_output`.
      this.codexTools += 1
    } else if (payload?.type === 'task_started') {
      // A turn of its own: a forked subagent's rollout repeats its parent's turns under their root,
      // and Codex starts some turns itself (`exec`, `guardian_review`).
      const trigger = (payload.turn_attribution as { turn_trigger?: unknown } | undefined)?.turn_trigger
      const root = payload.root_turn_id
      if ((root == null || root === payload.turn_id) && (trigger == null || trigger === 'user')) {
        this.turn()
      }
    } else if (row.type === 'turn_context' && payload) {
      this.model = typeof payload.model === 'string' ? payload.model : this.model
      this.effort = typeof payload.effort === 'string' ? payload.effort : this.effort
    } else if (payload?.type === 'token_count') {
      const info = payload.info as {
        total_token_usage?: { total_tokens?: unknown; input_tokens?: unknown; cached_input_tokens?: unknown; output_tokens?: unknown }
        last_token_usage?: { total_tokens?: unknown }
        model_context_window?: unknown
      } | null
      const usage = info?.total_token_usage
      const total = usage?.total_tokens
      const last = info?.last_token_usage?.total_tokens
      const window = info?.model_context_window
      if (typeof total === 'number') {
        this.codexTokens = total
        // Codex counts cached input inside its input, and reasoning inside its output.
        const [input, cached, output] = [usage?.input_tokens, usage?.cached_input_tokens ?? 0, usage?.output_tokens]
        this.codexSplit =
          typeof input === 'number' && typeof cached === 'number' && typeof output === 'number'
            ? { input: input - cached, cached, output }
            : null
      }
      if (typeof last === 'number') {
        this.setContext(last, row)
      }
      this.contextWindow = typeof window === 'number' ? window : this.contextWindow
    }
  }
}

function parse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T
  } catch {
    return null
  }
}

const CHUNK_BYTES = 4 * 1024 * 1024

/** Each transcript's tally and how far it has been read, so a refresh reads only what is new. */
const tallies = new Map<string, { offset: number; tally: Tally; reading: Promise<void> }>()

async function readNew(path: string, entry: { offset: number; tally: Tally }): Promise<void> {
  const { size } = await stat(path)
  if (size < entry.offset) {
    // Rewritten from the start: count again.
    entry.offset = 0
    entry.tally = new Tally()
  }
  if (size === entry.offset) {
    return
  }
  const file = await open(path, 'r')
  try {
    let carry = ''
    while (entry.offset < size) {
      const length = Math.min(CHUNK_BYTES, size - entry.offset)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, entry.offset)
      if (!bytesRead) {
        break
      }
      const text = carry + buffer.subarray(0, bytesRead).toString('utf8')
      const end = text.lastIndexOf('\n')
      // Only whole lines: a line still being written is read next time.
      entry.tally.feed(end >= 0 ? text.slice(0, end) : '')
      carry = end >= 0 ? text.slice(end + 1) : text
      entry.offset += bytesRead
    }
    entry.offset -= Buffer.byteLength(carry, 'utf8')
  } finally {
    await file.close()
  }
}

async function tallyOf(path: string): Promise<Tally | null> {
  let entry = tallies.get(path)
  if (!entry) {
    entry = { offset: 0, tally: new Tally(), reading: Promise.resolve() }
    tallies.set(path, entry)
  }
  const current = entry
  // One read per transcript at a time, so two refreshes never count the same lines twice.
  current.reading = current.reading.then(() => readNew(path, current)).catch(() => undefined)
  await current.reading
  return current.offset ? current.tally : null
}

/** Model, effort, tokens and context use for each session key whose transcript can be found. */
export async function sessionUsage(orca: OrcaWorkerApi, keys: string[]): Promise<Record<string, SessionUsage>> {
  const sessions = await agentSessions(orca, await listWorkspaces(), keys)
  const launches = [...sessions.values()].some((s) => s.agent === 'claude') ? await liveLaunches() : new Map()
  // One read of a checkout's settings files per refresh.
  const settings = new Map<string, Promise<ClaudeSettings[]>>()
  const settingsOf = (path: string) => settings.get(path) ?? settings.set(path, settingsFor(path)).get(path)!
  const results = await Promise.all(
    keys.map(async (key): Promise<[string, SessionUsage] | null> => {
      const session = sessions.get(key)
      const transcript = session ? await transcriptOf(key, session) : null
      const tally = transcript ? await tallyOf(transcript.path) : null
      if (!session || !transcript || !tally) {
        return null
      }
      const model = tally.model
      const claude = session.agent === 'claude' ? { launch: launches.get(transcript.sessionId) ?? NO_LAUNCH, files: await settingsOf(session.path) } : null
      return [
        key,
        {
          model,
          // Both agents record the effort each turn ran at; an older Claude transcript leaves it to its flag or settings.
          effort: tally.effort ?? (claude ? effortOf(model, claude.launch, claude.files) : null),
          tokens: tally.tokens,
          tokenSplit: tally.tokenSplit,
          context: tally.context,
          // Codex records its window; Claude's is worked out as Claude Code does.
          contextWindow: tally.contextWindow ?? (claude && model ? contextWindow(model, claude.launch, claude.files) : null),
          turns: tally.turns,
          turnsSinceCompaction: tally.turnsSinceCompaction,
          compactions: tally.compactions,
          toolCalls: tally.toolCalls,
          toolCallsSinceCompaction: tally.toolCallsSinceCompaction
        }
      ]
    })
  )
  return Object.fromEntries(results.filter((entry): entry is [string, SessionUsage] => entry !== null))
}
