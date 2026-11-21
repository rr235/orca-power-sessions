// Lookups in the JSON of `orca worktree ps` and `orca agent installed`. Pure, so the tests feed it fixtures.
import { result } from './json'

type PsRow = { agents?: { paneKey?: string }[] }

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
