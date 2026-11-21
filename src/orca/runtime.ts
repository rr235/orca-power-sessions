// Calls Orca's runtime for what neither its CLI nor the plugin API offers: compacting a chat
// session, bringing a session's tab to the front, reading which tab the window shows and counting a
// workspace's tabs. The worker runs the runtime client that ships inside Orca's CLI under Orca's
// bundled Node, and calls the RPCs Orca's own window uses (`agentSession.conversationCommand`,
// `session.tabs.activate`, `session.tabs.list`). These are Orca internals, not a published API: an
// Orca update can change them, and the error then says so.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import process from 'node:process'
import type { Selected } from '../protocol'
import { tabOfPane } from '../shared'

const COMPACT_METHOD = 'agentSession.conversationCommand'
// Where macOS installs Orca; `ORCA_APP` names another `.app` bundle.
const APP = process.env.ORCA_APP ?? '/Applications/Orca.app'
// The mobile client waits this long for a compact to finish.
export const COMPACT_TIMEOUT_MS = 200000

/** Orca's canonical JSON: keys sorted, undefined left out. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
}

/** The digest Orca checks a chat mutation against: its method, session and fields, never the fence. */
export function payloadFingerprint(sessionId: string, fields: Record<string, unknown>): string {
  return createHash('sha256').update(canonical({ method: COMPACT_METHOD, sessionId, fields })).digest('hex')
}

/** A new operation id in Orca's format: milliseconds, then 32 hex digits. */
export const operationId = (now = Date.now()) => `${Math.trunc(now)}-${randomUUID().replace(/-/g, '').toLowerCase()}`

// Runs under Orca's Node with the request as its one argument: reads the session's current fence,
// sends the command, and prints the answer (or the error) as JSON.
const COMPACT_SCRIPT = `
const [request] = process.argv.slice(1)
const { client: clientPath, sessionId, fields, envelope } = JSON.parse(request)
const { RuntimeClient } = require(clientPath)
;(async () => {
  try {
    const client = new RuntimeClient()
    const history = await client.call('agentSession.history', { sessionId, direction: 'tail', limit: 1 })
    const fence = history.result && history.result.page ? history.result.page.fence : null
    if (typeof fence !== 'number') throw Object.assign(new Error('no fence'), { code: 'no_fence' })
    const answer = await client.call('${COMPACT_METHOD}', { envelope: { ...envelope, expectedRuntimeFence: fence }, ...fields }, { timeoutMs: ${COMPACT_TIMEOUT_MS} })
    console.log(JSON.stringify({ answer: answer.result }))
  } catch (error) {
    console.log(JSON.stringify({ error: { code: error.code || null, message: String(error.message || error) } }))
  }
  process.exit(0)
})()
`

type Answer = {
  answer?: { ok?: boolean; value?: { state?: string; error?: string }; refusal?: { code?: string; reason?: string } }
  error?: { code: string | null; message: string }
}

/** Why a compact did not happen, in words, or null when it completed. */
export function compactProblem(output: string): string | null {
  let parsed: Answer
  try {
    parsed = JSON.parse(output.trim().split('\n').pop() ?? '') as Answer
  } catch {
    return 'Orca gave no readable answer.'
  }
  if (parsed.error) {
    if (parsed.error.message === 'agent_session_identity_required') {
      return 'Orca has no chat with this session id.'
    }
    return parsed.error.code === 'method_not_found' || parsed.error.message.includes('structured_agent_session_unsupported')
      ? 'This Orca build cannot compact chats from a plugin.'
      : parsed.error.message
  }
  const answer = parsed.answer
  if (answer?.value?.error) {
    return answer.value.error
  }
  if (answer?.ok && answer.value?.state === 'completed') {
    return null
  }
  if (answer?.ok) {
    return 'Orca could not confirm the compact.'
  }
  const reason = answer?.refusal?.reason
  return reason === 'turnActive' ? 'The chat is working: compact it once the turn ends.' : `Orca refused: ${reason ?? answer?.refusal?.code ?? 'no reason given'}.`
}

/**
 * Runs `script` under Orca's bundled Node with one JSON argument: `request`, plus `client`, the
 * path of Orca's runtime client. Resolves with what the script printed.
 */
function runInOrca(script: string, request: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const contents = `${realpathSync(APP)}/Contents`
  const argument = JSON.stringify({ ...request, client: runtimeClientPath(`${contents}/Resources/app.asar.unpacked`) })
  return new Promise<string>((resolve, reject) => {
    execFile(
      `${contents}/MacOS/Orca`,
      ['-e', script, argument],
      { timeout: timeoutMs, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (error: Error | null, stdout: string, stderr: string) =>
        error && !stdout ? reject(new Error(runFailure(stderr, error))) : resolve(stdout)
    )
  })
}

// Where Orca's CLI keeps its runtime client, newest layout first: Orca 1.4.259 moved it.
const CLIENT_PATHS = ['out/cli/runtime/client.js', 'out/cli/runtime-client.js']

/** The runtime client in Orca's unpacked app folder, throwing when no known path holds one. */
export function runtimeClientPath(unpacked: string, exists: (path: string) => boolean = existsSync): string {
  const found = CLIENT_PATHS.map((path) => `${unpacked}/${path}`).find((path) => exists(path))
  if (!found) {
    throw new Error('This Orca build keeps its runtime client somewhere the plugin does not know.')
  }
  return found
}

/** A short reason for a run that printed nothing: the first error line, never the script itself. */
export function runFailure(stderr: string, error: Error): string {
  const line = stderr.split('\n').find((l) => /^\w*Error\b/.test(l.trim()))?.trim()
  const reason = (error as { killed?: boolean }).killed ? 'it timed out' : line || 'it exited without an answer'
  return `Orca's runtime could not run the request: ${reason}.`
}

/** Runs `/compact` in a chat session, throwing with the reason when Orca does not. */
export async function compactChat(sessionId: string): Promise<void> {
  const fields = { command: 'compact' }
  const output = await runInOrca(
    COMPACT_SCRIPT,
    {
      sessionId,
      fields,
      envelope: { sessionId, clientOperationId: operationId(), payloadFingerprint: payloadFingerprint(sessionId, fields) }
    },
    COMPACT_TIMEOUT_MS
  )
  const problem = compactProblem(output)
  if (problem) {
    throw new Error(problem)
  }
}

const FOCUS_METHOD = 'session.tabs.activate'
const FOCUS_TIMEOUT_MS = 15000

const FOCUS_SCRIPT = `
const [request] = process.argv.slice(1)
const { client: clientPath, params } = JSON.parse(request)
const { RuntimeClient } = require(clientPath)
;(async () => {
  try {
    await new RuntimeClient().call('${FOCUS_METHOD}', params, { timeoutMs: ${FOCUS_TIMEOUT_MS} })
    console.log(JSON.stringify({ ok: true }))
  } catch (error) {
    console.log(JSON.stringify({ error: { code: error.code || null, message: String(error.message || error) } }))
  }
  process.exit(0)
})()
`

/** Why a focus did not happen, in words, or null when Orca took it. */
export function focusProblem(output: string): string | null {
  let parsed: { ok?: boolean; error?: { code: string | null; message: string } }
  try {
    parsed = JSON.parse(output.trim().split('\n').pop() ?? '')
  } catch {
    return 'Orca gave no readable answer.'
  }
  if (parsed.ok) {
    return null
  }
  const message = parsed.error?.message ?? ''
  if (message === 'tab_not_found') {
    return 'Orca has no open tab for this session.'
  }
  return parsed.error?.code === 'method_not_found' ? 'This Orca build cannot focus a tab from a plugin.' : message || 'Orca did not focus the tab.'
}

/**
 * Focuses the tab of the session in `paneKey`, in the workspace `workspace` selects (`path:<path>`
 * or `folder:<id>`). The workspace must already be the one Orca shows: the runtime focuses a tab
 * only within the workspace on screen.
 */
export async function focusTab(workspace: string, paneKey: string): Promise<void> {
  const tab = tabOfPane(paneKey)
  if (!tab) {
    throw new Error('This session has no tab Orca can focus.')
  }
  const params = { worktree: workspace, ...tab, intent: 'user', navigation: 'host' }
  const problem = focusProblem(await runInOrca(FOCUS_SCRIPT, { params }, FOCUS_TIMEOUT_MS))
  if (problem) {
    throw new Error(problem)
  }
}

const LIST_METHOD = 'session.tabs.list'
const LIST_TIMEOUT_MS = 4000

const LIST_SCRIPT = `
const [request] = process.argv.slice(1)
const { client: clientPath } = JSON.parse(request)
const { RuntimeClient } = require(clientPath)
;(async () => {
  try {
    const client = new RuntimeClient()
    const workspaces = await client.call('worktree.ps', { limit: 10000 }, { timeoutMs: ${LIST_TIMEOUT_MS} })
    const active = (workspaces.result?.worktrees || []).filter(row => row.isActive)
    if (active.length !== 1) {
      console.log('null')
    } else {
      const answer = await client.call('${LIST_METHOD}', { worktree: active[0].worktreeId }, { timeoutMs: ${LIST_TIMEOUT_MS} })
      const { worktree, activeTabId } = answer.result || {}
      console.log(JSON.stringify({ worktree, activeTabId }))
    }
  } catch (error) {
    console.log(JSON.stringify({ error: { code: error.code || null, message: String(error.message || error) } }))
  }
  process.exit(0)
})()
`

/**
 * The tab id the panel compares against a session's: a terminal tab's runtime id is
 * `<tabId>::<leafId>`, and every pane of the tab is on screen, so the leaf is dropped. A chat's
 * (`agent-session:<id>`) and any other tab's id stays as it is.
 */
export const shownTab = (activeTabId: string) => activeTabId.split('::')[0]

/** The workspace and tab in what `session.tabs.list` answered, or null when it did not answer. */
export function selectedOf(output: string): Selected | null {
  try {
    const parsed = JSON.parse(output.trim().split('\n').pop() ?? '') as { worktree?: string; activeTabId?: string | null }
    return parsed?.worktree ? { worktreeId: parsed.worktree, tabId: parsed.activeTabId ? shownTab(parsed.activeTabId) : null } : null
  } catch {
    return null
  }
}

const COUNT_SCRIPT = `
const [request] = process.argv.slice(1)
const { client: clientPath, worktree } = JSON.parse(request)
const { RuntimeClient } = require(clientPath)
;(async () => {
  try {
    const answer = await new RuntimeClient().call('${LIST_METHOD}', { worktree }, { timeoutMs: ${LIST_TIMEOUT_MS} })
    const tabs = answer.result && answer.result.tabs
    console.log(JSON.stringify({ count: Array.isArray(tabs) ? tabs.length : null }))
  } catch (error) {
    console.log(JSON.stringify({ error: { code: error.code || null, message: String(error.message || error) } }))
  }
  process.exit(0)
})()
`

/** How many tabs `session.tabs.list` answered with, or null when it did not answer. */
export function tabCountOf(output: string): number | null {
  try {
    const count = (JSON.parse(output.trim().split('\n').pop() ?? '') as { count?: unknown })?.count
    return typeof count === 'number' ? count : null
  } catch {
    return null
  }
}

/** How many tabs the workspace `workspace` selects (`path:<path>` or `folder:<id>`) has open, or null when Orca cannot say. */
export async function tabCount(workspace: string): Promise<number | null> {
  try {
    return tabCountOf(await runInOrca(COUNT_SCRIPT, { worktree: workspace }, LIST_TIMEOUT_MS + 1000))
  } catch {
    return null
  }
}

/**
 * The workspace and tab Orca's window shows, read live through one runtime client process.
 * Null when no unique workspace is focused or Orca cannot read its tabs.
 */
export async function selectedTab(): Promise<Selected | null> {
  return selectedOf(await runInOrca(LIST_SCRIPT, {}, LIST_TIMEOUT_MS * 2 + 1000))
}
