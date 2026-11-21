// Each session's model, effort and token use. Orca's CLI does not report them, so they come from
// where the agents record them: Orca's hook status file (terminal sessions), Orca's session store
// (chat sessions), both read in orca/stores.ts, and the agent's own transcript, which is read once
// and then only as it grows.
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chatRecords, contextReports, hookStatus, sessionStore } from '../orca/stores'
import type { ChatRecord, ContextReport, Source } from '../orca/stores'
import type { SessionUsage, TokenSplit } from '../protocol'
import { chatSessionId } from '../shared'

/** Claude names a project's transcript folder after its working directory. */
const claudeFolder = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** A chat session's model and effort as chosen in Orca, and where its transcript should be. */
export function chatSource(record: ChatRecord): (Source & { codexThread: string | null; createdAt: number }) | null {
  const agent = record.provider === 'claude' || record.provider === 'codex' ? record.provider : null
  if (!agent) {
    return null
  }
  const handle = [...(record.providerHandleChain ?? [])].reverse().find((link) => link.handle?.sessionId || link.handle?.threadId)?.handle
  const home = record.accountHome?.path ?? join(homedir(), agent === 'claude' ? '.claude' : '.codex')
  const cwd = record.location?.workspaceId?.split('::')[1]
  const transcript = agent === 'claude' && handle?.sessionId && cwd ? join(home, 'projects', claudeFolder(cwd), `${handle.sessionId}.jsonl`) : null
  return {
    agent,
    transcript,
    model: record.options?.model ?? null,
    effort: record.options?.effort ?? null,
    codexThread: agent === 'codex' ? (handle?.threadId ?? null) : null,
    createdAt: record.createdAt ?? 0
  }
}

/** A Codex thread's rollout file: Codex files it under the day it started, in local time. */
async function codexTranscript(thread: string, createdAt: number): Promise<string | null> {
  const root = join(homedir(), '.codex', 'sessions')
  const day = 24 * 60 * 60 * 1000
  for (const at of [createdAt, createdAt - day, createdAt + day]) {
    const date = new Date(at)
    const folder = join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'))
    const name = (await readdir(folder).catch(() => [] as string[])).find((file) => file.endsWith(`-${thread}.jsonl`))
    if (name) {
      return join(folder, name)
    }
  }
  return null
}

/** A transcript line, as far as the tally reads it. */
type Row = {
  type?: string
  subtype?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  timestamp?: string
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

  /** A compaction empties the context: its size stays unknown until the agent's next reply. */
  private compaction(row: Row): void {
    this.compactions += 1
    this.turnsSinceCompaction = 0
    this.toolCallsAtCompaction = this.toolCalls
    this.setContext(null, row)
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

/**
 * Claude's context window, which its transcript does not record: 1M from the 4.6 models on and for
 * `[1m]` ids, 200k before. Null for a model this cannot tell.
 */
export function claudeWindow(model: string): number | null {
  if (model.includes('[1m]')) {
    return 1_000_000
  }
  const version = /^claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-|\[|$)/.exec(model)
  if (!version) {
    return null
  }
  const [major, minor] = [Number(version[1]), Number(version[2] ?? 0)]
  if (model.startsWith('claude-haiku-4')) {
    return 200_000
  }
  return major > 4 || (major === 4 && minor >= 6) ? 1_000_000 : 200_000
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

/**
 * The tokens in a session's context now: the transcript's last reading, unless Orca's report is
 * newer, as it is after a compaction. Null when neither knows.
 */
export function currentContext(tally: { context: number | null; contextAt: number } | null, report: ContextReport | undefined): number | null {
  if (report?.used != null && (!tally || report.at >= tally.contextAt)) {
    return report.used
  }
  return tally?.context ?? null
}

/** Model, effort, tokens and context use for each session key that can be traced to a transcript or record. */
export async function sessionUsage(keys: string[]): Promise<Record<string, SessionUsage>> {
  const hooks = await hookStatus()
  const chatIds = new Map(keys.flatMap((key) => {
    const id = chatSessionId(key)
    return id ? [[key, id] as [string, string]] : []
  }))
  const ids = [...new Set(chatIds.values())]
  const store = sessionStore()
  const [records, reports] = await Promise.all([chatRecords(ids, store), contextReports(ids, store)])
  const results = await Promise.all(
    keys.map(async (key): Promise<[string, SessionUsage] | null> => {
      const id = chatIds.get(key)
      const record = id ? records.get(id) : undefined
      const chat = record ? chatSource(record) : null
      const source: Source | undefined = chat ?? hooks.get(key)
      if (!source) {
        return null
      }
      const transcript = chat?.codexThread ? await codexTranscript(chat.codexThread, chat.createdAt) : source.transcript
      const tally = transcript ? await tallyOf(transcript) : null
      const model = tally?.model ?? source.model
      const report = id ? reports.get(id) : undefined
      return [
        key,
        {
          model,
          // Codex records the effort each turn ran at; Claude's comes from Orca.
          effort: tally?.effort ?? source.effort,
          tokens: tally?.tokens ?? null,
          tokenSplit: tally?.tokenSplit ?? null,
          context: currentContext(tally, report),
          // Codex records its window; else Orca's last report; else Claude's usual window for the model.
          contextWindow:
            tally?.contextWindow ?? report?.window ?? (source.agent === 'claude' && model ? claudeWindow(model) : null),
          turns: tally?.turns ?? null,
          turnsSinceCompaction: tally?.turnsSinceCompaction ?? null,
          compactions: tally?.compactions ?? null,
          toolCalls: tally?.toolCalls ?? null,
          toolCallsSinceCompaction: tally?.toolCallsSinceCompaction ?? null
        }
      ]
    })
  )
  return Object.fromEntries(results.filter((entry): entry is [string, SessionUsage] => entry !== null))
}
