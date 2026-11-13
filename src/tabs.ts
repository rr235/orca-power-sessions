// Brings an agent session's tab to the front of Orca's window, and reads which tab it shows. The
// live `worktree.ps` identifies the focused workspace. Orca has no CLI command or plugin method
// for a tab, so the worker calls `session.tabs.activate` and `session.tabs.list` through Orca's
// runtime client (see chats.ts). These are Orca internals and can change between releases.
import { runInOrca } from './chats'
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

/**
 * The workspace and tab Orca's window shows, read live through one runtime client process.
 * Null when no unique workspace is focused or Orca cannot read its tabs.
 */
export async function selectedTab(): Promise<Selected | null> {
  return selectedOf(await runInOrca(LIST_SCRIPT, {}, LIST_TIMEOUT_MS * 2 + 1000))
}
