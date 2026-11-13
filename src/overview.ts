// Turns the `orca` CLI's JSON into what the panel shows. Pure, so the tests feed it fixtures.
import type { AgentState, Project, PullRequest, Session } from './protocol'

type ProjectRow = {
  id?: string
  displayName?: string
  providerIdentity?: { owner?: string; repo?: string }
  sourceRepoIds?: string[]
}
type RepoRow = { id?: string; path?: string }
type AgentRow = {
  paneKey?: string
  agentType?: string | null
  state?: string
  hasLivePty?: boolean | null
  conversationName?: string | null
  taskTitle?: string | null
  displayName?: string | null
  prompt?: string | null
  stateStartedAt?: number
  toolName?: string | null
  toolInput?: unknown
  mainAgent?: { outcome?: string } | null
}
export type PsRow = {
  worktreeId?: string
  repoId?: string
  repo?: string
  displayName?: string
  status?: string
  branch?: string | null
  path?: string | null
  /** The workspace's place when the sidebar is sorted manually; `manualOrder` wins when set. */
  manualOrder?: number | null
  sortOrder?: number | null
  linkedPR?: { number?: number; url?: string; state?: string; title?: string } | null
  /** `origins` are the session tabs a link was seen in. */
  linkedItems?: { type?: string; number?: number; url?: string; origins?: { tabId?: string }[] }[]
  agents?: AgentRow[]
}
type TerminalRow = { handle?: string; title?: string | null; connected?: boolean; tabId?: string; leafId?: string; worktreePath?: string }

const result = <T>(json: string): T => ((JSON.parse(json) as { result?: T }).result ?? ({} as T))

// Agent icon files shipped in assets/agents/, by Orca's agent type.
const AGENT_ICONS = new Set(['claude', 'codex'])
const STATES: readonly AgentState[] = ['working', 'blocked', 'waiting', 'done']

export const agentIcon = (agent: string | null): string | null =>
  agent && AGENT_ICONS.has(agent) ? `assets/agents/${agent}.png` : null

const DETAIL_CHARS = 280

/** Text for the details view: one paragraph, Markdown emphasis and code marks dropped, capped. */
export function detailText(value: unknown, max = DETAIL_CHARS): string | null {
  const text = (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value))
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : null
}

/**
 * The pull requests of one session: the one Orca tracks for the workspace's branch first, then the
 * others linked to the workspace. A link belongs to the session tabs it was seen in (its origins),
 * or to the whole workspace when it has none; so does the tracked one, since a main checkout's
 * branch, and with it the tracked pull request, changes under sessions that never worked on it.
 * `tab` is the session's tab id, the pane key before its `:`.
 */
export function pullRequestsOf(row: PsRow, tab: string | null): PullRequest[] {
  const links = (row.linkedItems ?? []).filter(
    (item): item is typeof item & { url: string; number: number } => item.type === 'pr' && Boolean(item.url) && typeof item.number === 'number'
  )
  const ours = (url: string) => {
    const tabs = (links.find((item) => item.url === url)?.origins ?? []).map((origin) => origin.tabId).filter(Boolean)
    return !tabs.length || (tab !== null && tabs.includes(tab))
  }
  const prs: PullRequest[] = []
  const tracked = row.linkedPR
  if (tracked?.url && typeof tracked.number === 'number' && ours(tracked.url)) {
    prs.push({ number: tracked.number, url: tracked.url, state: tracked.state ?? null, title: tracked.title?.trim() || null })
  }
  for (const item of links) {
    if (item.url !== tracked?.url && !prs.some((pr) => pr.url === item.url) && ours(item.url)) {
      prs.push({ number: item.number, url: item.url, state: null, title: null })
    }
  }
  return prs
}

/** A label for an agent session: its conversation name, else its task or the start of its prompt. */
function titleOf(agent: AgentRow, workspace: string): string {
  const prompt = agent.prompt?.replace(/\s+/g, ' ').trim()
  return (
    agent.conversationName?.trim() ||
    agent.taskTitle?.trim() ||
    agent.displayName?.trim() ||
    (prompt ? (prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt) : '') ||
    workspace
  )
}

/**
 * Live agent sessions from `orca worktree ps --json`, by title, so the list holds still as agents
 * change state. Agents in a sleeping workspace (`inactive`) stay, as in Orca's sidebar; an agent
 * whose terminal is gone is left out.
 */
export function parseSessions(psJson: string, projectsJson: string): Session[] {
  const projects = result<{ projects?: ProjectRow[] }>(projectsJson).projects ?? []
  const byRepo = new Map<string, ProjectRow>()
  for (const project of projects) {
    for (const repoId of project.sourceRepoIds ?? []) {
      byRepo.set(repoId, project)
    }
  }
  const rows = result<{ worktrees?: PsRow[] }>(psJson).worktrees ?? []
  const sessions = rows.flatMap((row) => {
    if (!row.worktreeId) {
      return []
    }
    const project = row.repoId ? byRepo.get(row.repoId) : undefined
    const workspace = row.displayName ?? ''
    return (row.agents ?? [])
      .filter((agent) => agent.hasLivePty !== false)
      .map((agent, index): Session => {
        const type = agent.agentType ?? null
        const state = STATES.find((s) => s === agent.state) ?? 'done'
        return {
          key: agent.paneKey ?? `${row.worktreeId}#${index}`,
          worktreeId: row.worktreeId as string,
          workspace,
          projectId: project?.id ?? null,
          project: project?.displayName?.trim() || row.repo || '',
          agent: type,
          agentIcon: agentIcon(type),
          title: titleOf(agent, workspace),
          state,
          since: agent.stateStartedAt ?? 0,
          branch: row.branch?.replace(/^refs\/heads\//, '') || null,
          path: row.path || null,
          // The tool only means something while the agent works; a finished one keeps its last.
          tool:
            state === 'working' && agent.toolName
              ? [agent.toolName, detailText(agent.toolInput, 80)].filter(Boolean).join(': ')
              : null,
          outcome: agent.mainAgent?.outcome ?? null,
          prs: pullRequestsOf(row, agent.paneKey?.split(':')[0] ?? null)
        }
      })
  })
  return sessions.sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
}

/**
 * Each workspace's place in Orca's sidebar, by worktree id, sorted manually as Orca does by default:
 * the highest rank (`manualOrder`, else `sortOrder`) first, so a new workspace comes first, then by
 * name.
 */
export function workspaceRanks(psJson: string): Map<string, number> {
  const rank = (row: PsRow) => row.manualOrder ?? row.sortOrder ?? null
  const rows = (result<{ worktrees?: PsRow[] }>(psJson).worktrees ?? []).filter((row) => row.worktreeId)
  rows.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)]
    const byRank = x !== null && y !== null ? y - x : x === null ? (y === null ? 0 : 1) : -1
    return byRank || (a.displayName ?? '').localeCompare(b.displayName ?? '')
  })
  return new Map(rows.map((row, index) => [row.worktreeId as string, index]))
}

/**
 * Sessions in the order of Orca's sidebar: by their workspace's place (`ranks`), then by the
 * position of their tab (`positions`, by tab id, the pane key before its `:`). Orca stores
 * positions for chat tabs only, so sessions without one follow, in the order given. Within a
 * workspace the sidebar lists agents by when it first saw each, which Orca keeps in its window
 * only; tab position is the nearest order Orca saves.
 */
export function orderLikeSidebar(sessions: Session[], ranks: Map<string, number>, positions: Map<string, number>): Session[] {
  const place = (session: Session) => ranks.get(session.worktreeId) ?? Number.POSITIVE_INFINITY
  const position = (session: Session) => positions.get(session.key.split(':')[0]) ?? Number.POSITIVE_INFINITY
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => place(a.session) - place(b.session) || position(a.session) - position(b.session) || a.index - b.index)
    .map(({ session }) => session)
}

/**
 * Orca projects with their main checkout, live agent count and workspace count (from `orca
 * worktree ps --json`, 0 without it), in Orca's sidebar order.
 */
export function parseProjects(projectsJson: string, reposJson: string, sessions: Session[], psJson = '{}'): Project[] {
  const projects = result<{ projects?: ProjectRow[] }>(projectsJson).projects ?? []
  const paths = new Map((result<{ repos?: RepoRow[] }>(reposJson).repos ?? []).map((repo) => [repo.id, repo.path]))
  const rows = (result<{ worktrees?: PsRow[] }>(psJson).worktrees ?? []).filter((row) => row.worktreeId)
  return projects
    .flatMap((project): Project[] => {
      const name = project.displayName?.trim()
      if (!project.id || !name) {
        return []
      }
      const { owner, repo } = project.providerIdentity ?? {}
      const repoId = project.sourceRepoIds?.[0]
      return [
        {
          id: project.id,
          name,
          repo: owner && repo ? `${owner}/${repo}` : '',
          path: (repoId && paths.get(repoId)) || null,
          repoIds: project.sourceRepoIds ?? [],
          agents: sessions.filter((s) => s.projectId === project.id).length,
          worktrees: rows.filter((row) => row.repoId && project.sourceRepoIds?.includes(row.repoId)).length
        }
      ]
    })
}

const CHAT_PANE = 'structured-agent-session-'
const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** Orca's session id for a chat pane (`structured-agent-session-<id>:<leaf>`), else null. */
export function chatSessionId(paneKey: string): string | null {
  if (!paneKey.startsWith(CHAT_PANE)) {
    return null
  }
  const id = paneKey.slice(CHAT_PANE.length).split(':')[0]
  return SAFE_ID.test(id) ? id : null
}

/**
 * The tab Orca's runtime knows a session's pane by. A chat's pane key is
 * `structured-agent-session-<sessionId>:<leafId>` and its tab is `agent-session:<sessionId>`; a
 * terminal's pane key is `<tabId>:<leafId>`.
 */
export function tabOfPane(paneKey: string): { tabId: string; leafId?: string } | null {
  const chat = chatSessionId(paneKey)
  if (chat) {
    return { tabId: `agent-session:${chat}` }
  }
  const [tabId, leafId] = paneKey.split(':')
  return tabId && leafId ? { tabId, leafId } : null
}

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

/** Whether a terminal handle is still live in this checkout in `orca terminal list --json`. */
export function terminalAlive(terminalsJson: string, handle: string, path: string): boolean {
  const terminals = result<{ terminals?: TerminalRow[] }>(terminalsJson).terminals ?? []
  return terminals.some((t) => t.handle === handle && t.worktreePath === path && t.connected !== false)
}
