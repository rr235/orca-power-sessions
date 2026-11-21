// Sessions in the panel: a group per project, worktree groups within it, a row per session and
// its details button.
import { Box, env, List, ListItem, plugin, read, set, Text } from 'orca'
import type { Project, Selected, Session } from '../protocol'
import { tabOfPane } from '../shared'
import { Icon, SessionDetails } from './session-details'
import {
  act,
  actionError,
  busy,
  expanded,
  holdSelected,
  pinned,
  pinSession,
  prInfo,
  prLoading,
  revealed,
  selected,
  toggleDetails,
  unpinSession,
  usage,
  usageLoading
} from './state'

const openProject = (project: Project) =>
  project.path
    ? act(`open:${project.id}`, () => plugin.request('project.open', { path: project.path as string }, { timeoutMs: 50000 }), `Could not open ${project.name}.`)
    : Promise.resolve()
/** The tab id Orca's runtime gives a session's tab: `agent-session:<id>` for a chat, else the pane key's tab. */
export const sessionTab = (session: Session) => tabOfPane(session.key)?.tabId ?? session.key.split(':')[0]

/** Whether Orca's window shows this session's tab. */
export const isSelected = (session: Session, shown: Selected | null) =>
  shown !== null && shown.worktreeId === session.worktreeId && shown.tabId === sessionTab(session)

/**
 * Whether Orca's window shows a workspace of this project. A worktree id starts with its repo's id,
 * then `::`; a group outside every project knows its workspaces only by its sessions.
 */
export const isProjectSelected = (group: Pick<Group, 'project' | 'sessions'>, shown: Selected | null) =>
  shown !== null &&
  (group.project
    ? // A worker older than the panel, mid-update, sends projects without repo ids.
      (group.project.repoIds ?? []).some((id) => shown.worktreeId.startsWith(`${id}::`))
    : group.sessions.some((s) => s.worktreeId === shown.worktreeId))

/** Shows the session's workspace and tab in Orca; nothing on the panel changes, so no reload. */
async function focusSession(session: Session): Promise<void> {
  if (!session.path) {
    return
  }
  set(actionError, null)
  holdSelected({ worktreeId: session.worktreeId, tabId: sessionTab(session) })
  try {
    await plugin.request('session.focus', { key: session.key, path: session.path }, { timeoutMs: 30000 })
  } catch (error) {
    set(actionError, `Could not show ${session.title}. ${error instanceof Error && error.message ? error.message : ''}`.trim())
  }
}
// A chat's compact answers once the summary is written; Orca lets a panel wait at most this long,
// and the worker carries on after it.
const COMPACT_TIMEOUT_MS = 120000
/** Runs /compact in the session, its terminal or its chat; a failure says why. */
const compactSession = (session: Session) =>
  act(
    `compact:${session.key}`,
    () => plugin.request('session.compact', { key: session.key }, { timeoutMs: COMPACT_TIMEOUT_MS }),
    (error) =>
      (error as { code?: string }).code === 'timeout'
        ? `${session.title} is still compacting.`
        : `Could not compact ${session.title}. ${error instanceof Error && error.message ? error.message : ''}`.trim()
  )

// The status dot's slot, in pixels, so every title ends at the same place.
export const DOT_PX = 16

export function SessionRow({ session, inPinnedArea = false }: { session: Session; inPinnedArea?: boolean }) {
  const isOpen = inPinnedArea || Boolean(read(expanded)[session.key])
  return (
    <Box gap="none">
      <SessionLine session={session} inPinnedArea={inPinnedArea} />
      {isOpen ? (
        <Box direction="row" gap="none" minWidth={0}>
          <Box width={DETAILS_INDENT_PX} minWidth={DETAILS_INDENT_PX} shrink={false} />
          <Box grow minWidth={0}>
            <SessionDetails
              session={session}
              stats={read(usage)[session.key]}
              loading={Boolean(read(usageLoading)[session.key])}
              info={read(prInfo)}
              titleLoading={read(prLoading)}
              compacting={Boolean(read(busy)[`compact:${session.key}`])}
              onCompact={() => void compactSession(session)}
              favourite={favouriteOf(session)}
            />
          </Box>
        </Box>
      ) : null}
      {/* A gap between an open card and the next session's title. */}
      {isOpen && !inPinnedArea ? <Box height={16} shrink={false} /> : null}
    </Box>
  )
}

/** Whether Orca names the session's pane: only then does its key stay with it as others end. */
const pinnable = (session: Session) => !session.key.startsWith(`${session.worktreeId}#`)

/** The details card's Favourites star: red to remove a favourite; none when the session cannot be one. */
function favouriteOf(session: Session): { on: boolean; onPress: () => void } | null {
  if (read(pinned).includes(session.key)) {
    return { on: true, onPress: () => unpinSession(session.key) }
  }
  return pinnable(session) ? { on: false, onPress: () => pinSession(session.key) } : null
}

// How far an open details card sits in from its session's row, in pixels.
const DETAILS_INDENT_PX = 16

function SessionLine({ session, inPinnedArea = false }: { session: Session; inPinnedArea?: boolean }) {
  return (
    // A list row shows the session's tab (terminal or chat) in Orca. At the right, the chevron that
    // toggles the details. In the Favourites area the details always show, so the row has no
    // chevron; an empty slot keeps the titles' ends aligned. The chevron stays beside the ListItem
    // so controls are not nested.
    // Every row is one line that truncates. Only the title of the tab Orca shows is in normal text,
    // with no background.
    <Box direction="row" align="center" gap="none" minWidth={0}>
      <Box grow minWidth={0}>
        <List>
          <ListItem onPress={session.path ? () => void focusSession(session) : undefined}>
            <Box direction="row" align="center" gap="xs" minWidth={0}>
              {session.agentIcon ? <Icon src={session.agentIcon} alt={session.agent ?? 'Agent'} px={11} /> : null}
              <Box grow minWidth={0}>
                <Text size="xs" muted={!isSelected(session, read(selected))} truncate>
                  {session.title}
                </Text>
              </Box>
              {/* Every row keeps the dot's slot, so titles end and dots sit at the same place. */}
              <Box direction="row" align="center" justify="center" width={DOT_PX} minWidth={DOT_PX} shrink={false}>
                {/* Only an active session has a dot. */}
                {session.state === 'working' ? (
                  <Text size="xs" tone="success">
                    ●
                  </Text>
                ) : null}
              </Box>
            </Box>
          </ListItem>
        </List>
      </Box>
      {inPinnedArea ? <Box width={CHEVRON_SLOT_PX} minWidth={CHEVRON_SLOT_PX} shrink={false} /> : <DetailsButton session={session} />}
    </Box>
  )
}

// The chevron's width with its row's side padding, which a Favourites row keeps empty.
const CHEVRON_SLOT_PX = 28

// The chevron that shows or hides a session's details: a muted PNG in a pressable row,
// since Orca's IconButton has no size under 24px.
function DetailsButton({ session }: { session: Session }) {
  const isOpen = Boolean(read(expanded)[session.key])
  return (
    <Box shrink={false}>
      <List>
        <ListItem onPress={() => toggleDetails(session.key)}>
          <Icon
            src={`assets/details/chevron-${isOpen ? 'down' : 'right'}-${env.theme.colorScheme}.png`}
            alt={`${isOpen ? 'Hide' : 'Show'} details of ${session.title}`}
            px={12}
          />
        </ListItem>
      </List>
    </Box>
  )
}

type Group = { key: string; project: Project | null; name: string; sessions: Session[] }

/**
 * One entry per project, in Orca's sidebar order, with its sessions under it: nothing moves as
 * agents change state, and dragging a project in the sidebar moves it here. Sessions outside every
 * project get an entry of their own, last.
 */
export function groups(projects: Project[], sessions: Session[]): Group[] {
  const byKey = new Map<string, Group>(
    projects.map((p): [string, Group] => [p.id, { key: p.id, project: p, name: p.name, sessions: [] }])
  )
  for (const session of sessions) {
    const key = session.projectId && byKey.has(session.projectId) ? session.projectId : `other:${session.project}`
    const group = byKey.get(key) ?? { key, project: null, name: session.project, sessions: [] }
    group.sessions.push(session)
    byKey.set(key, group)
  }
  return [...byKey.values()]
}

export function ProjectGroup({ group }: { group: Group }) {
  const { project } = group
  const isRevealed = read(revealed).includes(group.key)
  return (
    <Box gap="none">
      {/* The whole row is pressable and opens the project's main checkout in Orca. Its name is in
          normal text while Orca shows one of its workspaces. */}
      <List>
        <ListItem onPress={project?.path ? () => void openProject(project) : undefined}>
          {/* The name only takes the width it needs, so the dot of a project just shown again sits
              right after it: the grey dot of an idle session. While the dot shows, the name is in
              normal text, then muted again. */}
          <Box direction="row" align="center" gap="xs" minWidth={0}>
            <Box minWidth={0}>
              <Text size="xs" muted={!isProjectSelected(group, read(selected)) && !isRevealed} truncate>
                {group.name}
              </Text>
            </Box>
            {isRevealed ? (
              <Text size="xs" muted>
                ●
              </Text>
            ) : null}
          </Box>
        </ListItem>
      </List>
      {group.sessions.length ? (
        <Box gap="none" paddingX="md">
          {worktreeGrouped(group)
            ? byWorktree(group.sessions).map((worktree) => <WorktreeGroup key={worktree.key} worktree={worktree} />)
            : group.sessions.map((session) => <SessionRow key={session.key} session={session} />)}
        </Box>
      ) : null}
    </Box>
  )
}

type Worktree = { key: string; name: string; sessions: Session[] }

/** A project's sessions by workspace, in the order their first session comes. */
export function byWorktree(sessions: Session[]): Worktree[] {
  const worktrees = new Map<string, Worktree>()
  for (const session of sessions) {
    const worktree = worktrees.get(session.worktreeId) ?? { key: session.worktreeId, name: session.workspace || 'main', sessions: [] }
    worktree.sessions.push(session)
    worktrees.set(session.worktreeId, worktree)
  }
  return [...worktrees.values()]
}

/** Whether a project's sessions sit under their worktree: when they run in more than one. */
const worktreeGrouped = (group: Group) => new Set(group.sessions.map((s) => s.worktreeId)).size > 1

// How far a worktree's sessions sit in from its name, in pixels.
const WORKTREE_INDENT_PX = 12

function WorktreeGroup({ worktree }: { worktree: Worktree }) {
  return (
    <Box gap="none">
      {/* A label, not a control: a ListItem without a press, so its icon lines up with the sessions'.
          Its name is in normal text while Orca shows this workspace. */}
      <List>
        <ListItem>
          <Box direction="row" align="center" gap="xs" minWidth={0}>
            <Icon src={`assets/details/worktree-${env.theme.colorScheme}.png`} alt="Worktree" px={11} />
            <Box grow minWidth={0}>
              <Text size="xs" muted={read(selected)?.worktreeId !== worktree.key} truncate>
                {worktree.name}
              </Text>
            </Box>
          </Box>
        </ListItem>
      </List>
      <Box direction="row" gap="none" minWidth={0}>
        <Box width={WORKTREE_INDENT_PX} minWidth={WORKTREE_INDENT_PX} shrink={false} />
        <Box grow minWidth={0}>
          {worktree.sessions.map((session) => (
            <SessionRow key={session.key} session={session} />
          ))}
        </Box>
      </Box>
    </Box>
  )
}
