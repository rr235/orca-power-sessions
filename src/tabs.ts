// Brings an agent session's tab to the front of Orca's window, and reads which tab it shows. Orca
// has no CLI command or plugin method for either, so the worker calls the RPC Orca's paired clients
// use, `session.tabs.activate`, through Orca's runtime client (see chats.ts), and reads the window
// state Orca saves. These are Orca internals, not a published API: an Orca update can change them,
// and the error then says so.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runInOrca } from './chats'
import { run } from './cli'
import { tabOfPane } from './overview'

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

const ORCA_DATA = join(homedir(), 'Library', 'Application Support', 'orca')

/** What Orca's window shows: its workspace and that workspace's selected tab. */
export type Selected = { worktreeId: string; tabId: string }

/** The workspace and tab in Orca's saved window state (`payload` of its `workspaceSession` row). */
export function selectedOf(payload: string): Selected | null {
  try {
    const state = JSON.parse(payload) as { activeWorktreeId?: string | null; activeTabIdByWorktree?: Record<string, string | null> }
    const worktreeId = state.activeWorktreeId
    const tabId = worktreeId ? state.activeTabIdByWorktree?.[worktreeId] : null
    return worktreeId && tabId ? { worktreeId, tabId } : null
  } catch {
    return null
  }
}

/**
 * The workspace and tab Orca's window shows, from the window state Orca saves in its profile, about
 * a second and a half after each change. Orca reports no tab switch to plugins, and this read takes
 * milliseconds where asking the runtime starts a process.
 */
export async function selectedTab(): Promise<Selected | null> {
  try {
    const index = JSON.parse(await readFile(join(ORCA_DATA, 'orca-profile-index.json'), 'utf8')) as { activeProfileId?: string }
    const profile = index.activeProfileId
    if (!profile || !/^[A-Za-z0-9_-]+$/.test(profile)) {
      return null
    }
    const store = join(ORCA_DATA, 'profiles', profile, 'profile-state.db')
    const payload = await run('sqlite3', ['-readonly', store, "select payload from profile_state_documents where domain = 'workspaceSession'"])
    return selectedOf(payload)
  } catch {
    return null
  }
}
