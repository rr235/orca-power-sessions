// Lookups in the JSON of `orca terminal list`, `read` and `create`. Pure, so the tests feed it fixtures.
import { result } from './json'

type TerminalRow = { handle?: string; title?: string | null; connected?: boolean; tabId?: string; leafId?: string; worktreePath?: string }

/** The live terminal with this title in the action's checkout, from `orca terminal list --json`. */
export function terminalByTitle(terminalsJson: string, title: string, path: string): string | null {
  const terminals = result<{ terminals?: TerminalRow[] }>(terminalsJson).terminals ?? []
  return terminals.find((t) => t.title === title && t.worktreePath === path && t.connected !== false)?.handle ?? null
}

/**
 * The live terminal of an agent's pane, whose key is `<tabId>:<leafId>` in `orca terminal list
 * --json`. A chat session's pane has no terminal.
 */
export function terminalOfPane(terminalsJson: string, paneKey: string): string | null {
  const terminals = result<{ terminals?: TerminalRow[] }>(terminalsJson).terminals ?? []
  return terminals.find((t) => `${t.tabId}:${t.leafId}` === paneKey && t.connected !== false)?.handle ?? null
}

/**
 * The live terminal of a process's Orca environment: by its pane, which outlives a reissued handle,
 * else by its handle. An agent's terminal is never one, so Stop never closes an agent.
 */
export function terminalOfProcess(terminalsJson: string, paneKey: string | null, handle: string | null, agents: ReadonlySet<string>): string | null {
  const terminals = result<{ terminals?: TerminalRow[] }>(terminalsJson).terminals ?? []
  const live = terminals.filter((t) => t.connected !== false)
  const found = (paneKey ? live.find((t) => `${t.tabId}:${t.leafId}` === paneKey) : undefined) ?? (handle ? live.find((t) => t.handle === handle) : undefined)
  return found && !agents.has(`${found.tabId}:${found.leafId}`) ? (found.handle ?? null) : null
}

/** A process as `processTerminal` in servers.ts reads it. */
type ProcessInfo = { ppid: number | null; detached: boolean; paneKey: string | null; handle: string | null }

// How far up from a server's process to look for the terminal it runs in.
const MAX_ANCESTORS = 12

/**
 * The Orca terminal serving a port: every listener must lead to the same live terminal through
 * its nearest ancestor with Orca's terminal environment. Otherwise the port is ambiguous, or
 * closing a terminal would leave a listener running (such as a detached server).
 */
export async function terminalServing(
  pids: readonly number[],
  processOf: (pid: number) => Promise<ProcessInfo | null>,
  terminalsJson: string,
  agents: ReadonlySet<string>
): Promise<string | null> {
  let serving: string | null = null
  for (const pid of pids) {
    let terminal: string | null = null
    let current: number | null = pid
    for (let depth = 0; current && depth < MAX_ANCESTORS; depth++) {
      const found = await processOf(current)
      if (!found || (depth === 0 && found.detached)) {
        break
      }
      if (found.paneKey || found.handle) {
        // The nearest Orca environment decides: an outer one belongs to a terminal that is not serving.
        terminal = terminalOfProcess(terminalsJson, found.paneKey, found.handle, agents)
        break
      }
      current = found.ppid
    }
    if (!terminal || (serving && serving !== terminal)) {
      return null
    }
    serving = terminal
  }
  return serving
}

/** The pane of a live terminal, `<tabId>:<leafId>`, as its processes carry it in `ORCA_PANE_KEY`. */
export function paneOfTerminal(terminalsJson: string, handle: string): string | null {
  const terminals = result<{ terminals?: TerminalRow[] }>(terminalsJson).terminals ?? []
  const found = terminals.find((t) => t.handle === handle && t.connected !== false)
  return found?.tabId && found.leafId ? `${found.tabId}:${found.leafId}` : null
}

/** Whether a terminal handle is still live in this checkout in `orca terminal list --json`. */
export function terminalAlive(terminalsJson: string, handle: string, path: string): boolean {
  const terminals = result<{ terminals?: TerminalRow[] }>(terminalsJson).terminals ?? []
  return terminals.some((t) => t.handle === handle && t.worktreePath === path && t.connected !== false)
}

/** The output lines of `orca terminal read --json`. */
export function terminalTail(json: string): string[] {
  try {
    const tail = (JSON.parse(json) as { result?: { terminal?: { tail?: unknown } } }).result?.terminal?.tail
    return Array.isArray(tail) ? tail.filter((line): line is string => typeof line === 'string') : []
  } catch {
    return []
  }
}

/**
 * A cursor from `orca terminal read --json`: `latest`, where its output ends, so a later read returns
 * only what follows; `next`, where the page just read ends.
 */
export function outputCursor(json: string, which: 'latest' | 'next' = 'latest'): string | null {
  try {
    const terminal = (JSON.parse(json) as { result?: { terminal?: { latestCursor?: unknown; nextCursor?: unknown } } }).result?.terminal
    const cursor = which === 'latest' ? (terminal?.latestCursor ?? terminal?.nextCursor) : terminal?.nextCursor
    return typeof cursor === 'string' || typeof cursor === 'number' ? String(cursor) : null
  } catch {
    return null
  }
}

/** The handle `orca terminal create --json` answers with, wherever the result keeps it. */
export function handleOf(json: string): string | null {
  return /"(term_[^"]+)"/.exec(json)?.[1] ?? null
}
