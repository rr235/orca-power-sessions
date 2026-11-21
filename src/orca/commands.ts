// The `orca` CLI commands the worker runs, one function each. Lists answer the CLI's JSON as it is,
// for the lookups in terminals.ts, agents.ts and overview.ts to read.
import { run } from '../cli'
import { defaultAgent } from './agents'
import { handleOf } from './terminals'

// Creating a terminal or launching an agent waits for Orca to open it.
const OPEN_TIMEOUT_MS = 30000

export const listProjects = (): Promise<string> => run('orca', ['project', 'list', '--json'])
export const listRepos = (): Promise<string> => run('orca', ['repo', 'list', '--json'])
/** Every workspace with its agents, `orca worktree ps --json`. */
export const listWorkspaces = (): Promise<string> => run('orca', ['worktree', 'ps', '--json'])
export const listTerminals = (): Promise<string> => run('orca', ['terminal', 'list', '--json'])

/** Up to `limit` lines of a terminal's output, from `cursor` when given, else its tail. */
export const readTerminal = (terminal: string, limit: string, cursor?: string | null): Promise<string> =>
  run('orca', ['terminal', 'read', '--terminal', terminal, '--limit', limit, ...(cursor ? ['--cursor', cursor] : []), '--json'])

/** Shows the terminal in Orca's window. */
export const switchTerminal = async (terminal: string): Promise<void> => {
  await run('orca', ['terminal', 'switch', '--terminal', terminal, '--json'])
}

/** Types `text` into the terminal and presses Enter. */
export const sendToTerminal = async (terminal: string, text: string): Promise<void> => {
  await run('orca', ['terminal', 'send', '--terminal', terminal, '--text', text, '--enter', '--json'])
}

export const closeTerminal = async (terminal: string): Promise<void> => {
  await run('orca', ['terminal', 'close', '--terminal', terminal, '--json'])
}

/**
 * Opens a focused terminal titled `title` in the checkout at `path`, running `command`. Answers its
 * handle, and the CLI's output for a log when it holds none.
 */
export async function createTerminal(path: string, title: string, command: string): Promise<{ handle: string | null; output: string }> {
  const output = await run('orca', ['terminal', 'create', '--worktree', `path:${path}`, '--title', title, '--command', command, '--focus', '--json'], OPEN_TIMEOUT_MS)
  return { handle: handleOf(output), output }
}

/** Shows the Git worktree at `path` in Orca's window. The CLI refuses a folder workspace. */
export const activateWorktree = async (path: string): Promise<void> => {
  await run('orca', ['worktree', 'activate', '--worktree', `path:${path}`, '--json'])
}

/** The agent a new tab starts in Orca's settings, or null when none is set or the CLI cannot say. */
export const newTabAgent = async (): Promise<string | null> => defaultAgent(await run('orca', ['agent', 'installed', '--json']).catch(() => '{}'))

/** Starts `agent` in the workspace `workspace` selects, shown in Orca's window when `focus`. */
export const launchAgent = async (agent: string, workspace: string, focus: boolean): Promise<void> => {
  await run('orca', ['agent', 'launch', '--agent', agent, '--worktree', workspace, ...(focus ? ['--focus'] : []), '--json'], OPEN_TIMEOUT_MS)
}
