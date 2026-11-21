// The agent session behind each pane: which agent runs there and the session id it names its
// transcript after. `orca worktree ps` lists panes without that id and the host's `agents.list`
// lists sessions without their pane, so the two are matched by workspace, agent and when the agent
// entered its state. A pane Orca gives no id keeps its agent's last reply, to find its transcript by.
import type { OrcaWorkerApi } from 'orca/worker'
import { result } from './json'
import type { WorkspaceRow } from './workspaces'

/** A pane's agent session (null when Orca gives none), the checkout it runs in and the agent's last reply. */
export type AgentSession = { agent: string; sessionId: string | null; path: string; reply: string | null }
/** A row of the host's `agents.list`, as far as matching needs it. */
export type HostAgent = { agent: string | null; stateStartedAt: number; sessionId?: string | null }

type PsAgent = { paneKey?: string; agentType?: string | null; stateStartedAt?: number; lastAssistantMessage?: string | null }
type PsRow = { path?: string | null; agents?: PsAgent[] }

/**
 * Each pane's agent session, by pane key, from `orca worktree ps --json` and the host's agents by
 * checkout path. A pane matches the host row of the same agent that entered its state at the same
 * time, else the only row of that agent when the workspace runs one; any other pane has no id.
 */
export function matchSessions(psJson: string, hostAgents: ReadonlyMap<string, readonly HostAgent[]>, keys?: ReadonlySet<string>): Map<string, AgentSession> {
  const sessions = new Map<string, AgentSession>()
  for (const row of result<{ worktrees?: PsRow[] }>(psJson).worktrees ?? []) {
    const hosted = (row.path && hostAgents.get(row.path)) || []
    for (const pane of row.agents ?? []) {
      if (!pane.paneKey || !pane.agentType || (keys && !keys.has(pane.paneKey))) {
        continue
      }
      const same = hosted.filter((a) => a.agent === pane.agentType)
      const panes = (row.agents ?? []).filter((p) => p.agentType === pane.agentType)
      const timed = same.filter((a) => a.stateStartedAt === pane.stateStartedAt)
      const unique = timed.length === 1 && panes.filter((p) => p.stateStartedAt === pane.stateStartedAt).length === 1
      const alone = same.length === 1 && panes.length === 1
      const found = unique ? timed[0] : alone ? same[0] : undefined
      if (row.path) {
        sessions.set(pane.paneKey, { agent: pane.agentType, sessionId: found?.sessionId ?? null, path: row.path, reply: pane.lastAssistantMessage?.trim() || null })
      }
    }
  }
  return sessions
}

/** The agent sessions of these panes on this machine, read from `orca worktree ps --json` and the host. */
export async function agentSessions(orca: OrcaWorkerApi, psJson: string, keys: readonly string[]): Promise<Map<string, AgentSession>> {
  const wanted = new Set(keys)
  const paths = new Set(
    (result<{ worktrees?: PsRow[] }>(psJson).worktrees ?? [])
      .filter((row) => row.path && (row.agents ?? []).some((a) => a.paneKey && wanted.has(a.paneKey)))
      .map((row) => row.path as string)
  )
  const rows = ((await orca.host.call('workspace.list')).workspaces as WorkspaceRow[]).filter(
    (row) => paths.has(row.path) && (row.hostId === null || row.hostId === 'local')
  )
  const listed = await Promise.all(
    rows.map(async (row): Promise<[string, HostAgent[]]> => {
      const answer = await orca.host.call('agents.list', { workspaceId: row.id }).catch(() => ({ agents: [] as HostAgent[] }))
      return [row.path, answer.agents]
    })
  )
  return matchSessions(psJson, new Map(listed), wanted)
}
