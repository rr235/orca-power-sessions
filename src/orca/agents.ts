// Lookups in the JSON of `orca worktree ps` and `orca agent installed`. Pure, so the tests feed it fixtures.
import { result } from './json'

type PsRow = { worktreeId?: string; path?: string | null; status?: string; isActive?: boolean; liveTerminalCount?: number; agents?: { paneKey?: string }[] }

/** The panes agents run in, from `orca worktree ps --json`: a server started by an agent is not the agent's terminal to close. */
export function agentPanes(psJson: string): Set<string> {
  const rows = result<{ worktrees?: PsRow[] }>(psJson).worktrees ?? []
  return new Set(rows.flatMap((row) => (row.agents ?? []).flatMap((agent) => (agent.paneKey ? [agent.paneKey] : []))))
}

/** The agent a new tab starts in Orca's settings, from `orca agent installed --json`, or null when none is set. */
export function defaultAgent(installedJson: string): string | null {
  try {
    const agents = result<{ agents?: { id?: string; default?: boolean }[] }>(installedJson).agents ?? []
    return agents.find((a) => a.default === true && a.id)?.id ?? null
  } catch {
    return null
  }
}

/** The workspace Orca's window shows, from `orca worktree ps --json`, or null when none is. */
export function activeWorkspace(psJson: string): string | null {
  const rows = result<{ worktrees?: PsRow[] }>(psJson).worktrees ?? []
  const active = rows.filter((row) => row.isActive && row.worktreeId)
  return active.length === 1 ? (active[0].worktreeId as string) : null
}

/**
 * Whether the workspace at `path` has a terminal or an agent open, from `orca worktree ps --json`,
 * or null when it is not listed or asleep: a sleeping workspace lists none until it wakes. File and
 * browser tabs are not counted.
 */
export function hasOpenTabs(psJson: string, path: string): boolean | null {
  const row = (result<{ worktrees?: PsRow[] }>(psJson).worktrees ?? []).find((r) => r.path === path)
  if (!row || row.status === 'inactive') {
    return null
  }
  return (row.liveTerminalCount ?? 0) > 0 || (row.agents ?? []).length > 0
}
