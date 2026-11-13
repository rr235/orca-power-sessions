// Brings an agent session's tab to the front of Orca's window, and reads which tab it shows. The
// focused workspace comes from the plugin API; Orca has no CLI command or plugin method for a tab,
// so the worker calls the RPCs Orca's paired clients use, `session.tabs.activate` and
// `session.tabs.list`, through Orca's runtime client (see chats.ts). These are Orca internals, not a
// published API: an Orca update can change them, and the error then says so.
import type { OrcaWorkerApi } from 'orca/worker'
import { runInOrca } from './chats'
import { run } from './cli'
import { tabOfPane } from './overview'
import type { Selected } from './protocol'

const METHOD = 'session.tabs.activate'
const TIMEOUT_MS = 15000

const SCRIPT = `
const [request] = process.argv.slice(1)
const { client: clientPath, params } = JSON.parse(request)
const { RuntimeClient } = require(clientPath)
;(async () => {
  try {
    await new RuntimeClient().call('${METHOD}', params, { timeoutMs: ${TIMEOUT_MS} })
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
 * Focuses the tab of the session in `paneKey`, in the workspace at `path`. The workspace must
 * already be the one Orca shows: the runtime focuses a tab only within the workspace on screen.
 */
export async function focusTab(path: string, paneKey: string): Promise<void> {
  const tab = tabOfPane(paneKey)
  if (!tab) {
    throw new Error('This session has no tab Orca can focus.')
  }
  const params = { worktree: `path:${path}`, ...tab, intent: 'user', navigation: 'host' }
  const problem = focusProblem(await runInOrca(SCRIPT, { params }, TIMEOUT_MS))
  if (problem) {
    throw new Error(problem)
  }
}

const LIST_METHOD = 'session.tabs.list'
const LIST_TIMEOUT_MS = 5000

const LIST_SCRIPT = `
const [request] = process.argv.slice(1)
const { client: clientPath, params } = JSON.parse(request)
const { RuntimeClient } = require(clientPath)
;(async () => {
  try {
    const answer = await new RuntimeClient().call('${LIST_METHOD}', params, { timeoutMs: ${LIST_TIMEOUT_MS} })
    const { worktree, activeTabId } = answer.result || {}
    console.log(JSON.stringify({ worktree, activeTabId }))
  } catch (error) {
    console.log(JSON.stringify({ error: { code: error.code || null, message: String(error.message || error) } }))
  }
  process.exit(0)
})()
`

/** What `workspace.readContext` answers for the focused workspace. */
export type FocusContext = { branch: string; displayName: string; terminals: { id: string }[] }
type Listed = { path: string; name: string; branch: string | null }
type TerminalRow = { handle?: string; worktreePath?: string }

const branchName = (branch: string | null | undefined) => (branch ?? '').replace(/^refs\/heads\//, '')

/**
 * The paths of the workspaces that match the focused one by name and branch. Many workspaces share
 * a name like `main`, so more than one can match.
 */
export function focusCandidates(context: FocusContext, workspaces: Listed[]): string[] {
  return workspaces.filter((w) => w.name === context.displayName && branchName(w.branch) === branchName(context.branch)).map((w) => w.path)
}

/** The candidate holding one of the focused workspace's terminals, from `orca terminal list --json`. */
export function pathOfTerminals(terminalsJson: string, ids: string[], candidates: string[]): string | null {
  const terminals = (JSON.parse(terminalsJson) as { result?: { terminals?: TerminalRow[] } }).result?.terminals ?? []
  const path = terminals.find((t) => t.handle && ids.includes(t.handle))?.worktreePath
  return path && candidates.includes(path) ? path : null
}

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
    return parsed.worktree ? { worktreeId: parsed.worktree, tabId: parsed.activeTabId ? shownTab(parsed.activeTabId) : null } : null
  } catch {
    return null
  }
}

// The focused workspace's path, by its context: resolving it may run the CLI, so it is done once per focus.
const focusPaths = new Map<string, string | null>()

async function focusedPath(orca: OrcaWorkerApi, context: FocusContext): Promise<string | null> {
  const key = JSON.stringify(context)
  if (focusPaths.has(key)) {
    return focusPaths.get(key) ?? null
  }
  const { workspaces } = await orca.host.call('workspace.list')
  const candidates = focusCandidates(context, workspaces)
  const ids = context.terminals.map((t) => t.id)
  const path =
    candidates.length === 1
      ? candidates[0]
      : candidates.length > 1 && ids.length
        ? pathOfTerminals(await run('orca', ['terminal', 'list', '--json']), ids, candidates)
        : null
  focusPaths.clear()
  focusPaths.set(key, path)
  return path
}

/**
 * The workspace Orca's window shows, from the plugin API, and the tab it shows there, from Orca's
 * runtime: both live, where the window state Orca saves can lag by many minutes. Null when no
 * workspace is focused or Orca cannot tell which one it is.
 */
export async function selectedTab(orca: OrcaWorkerApi): Promise<Selected | null> {
  const context = await orca.host.call('workspace.readContext')
  const path = context ? await focusedPath(orca, context) : null
  if (!path) {
    return null
  }
  return selectedOf(await runInOrca(LIST_SCRIPT, { params: { worktree: `path:${path}` } }, LIST_TIMEOUT_MS + 2000))
}
