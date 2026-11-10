// The Power Sessions panel: dev server buttons on top, then every Orca project with its live agent
// sessions under it. No build step: Orca strips the types and compiles the JSX when it loads.
import {
  atom,
  Box,
  Button,
  Callout,
  env,
  IconButton,
  Input,
  List,
  ListItem,
  on,
  plugin,
  read,
  RelativeTime,
  Select,
  Separator,
  shell,
  set,
  storage,
  Skeleton,
  Spinner,
  Stack,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import type { Overview, Project, QuickActionInput, PullRequest, PullRequestInfo, Server, Session, SessionUsage } from './protocol'
import { normalUrl } from './url'
import { AGENT_LABEL, ContextFact, Fact, Icon, ModelFact, statusOf, TurnsFact, type FactIcon } from './session-details'

const REFRESH_MS = 15000
const EVENT_DELAY_MS = 400
// How often the panel reads which tab Orca shows; Orca saves it about 1.5s after each switch.
const SELECTED_MS = 1000
// After a press shows a tab, how long the panel trusts that over Orca's saved state, which lags.
const SELECTED_HOLD_MS = 3000

// The last overview, kept across panel runs so reopening shows it at once while it refreshes.
const overview = atom<Overview | null>('overview', null, { persist: 'plugin', version: 5, migrate: () => null })
// Which sections are open, kept across panel runs.
const sections = atom('sections', { actions: true }, { persist: 'plugin' })
// Sessions whose details are open, by session key. Orca runs a panel per workspace, and showing a
// session can switch workspace, so each change goes to the plugin's storage at once and every panel
// takes the others' changes from there.
const EXPANDED_KEY = 'expanded'
const expanded = atom<Record<string, true>>({})
// Bumped by each change here and each storage read, so a read never undoes a newer change.
let expandedEdits = 0
let expandedReads = 0
// Writes not yet answered: a read meanwhile could still see the older value, so it waits for them.
let expandedWrites = 0
let expandedReadWaiting = false
// The workspace and tab Orca's window shows, so that session's title is in normal text.
const selected = atom<{ worktreeId: string; tabId: string } | null>(null)
let selectedHeldUntil = 0
// Model, effort and tokens of sessions whose details were opened, by session key.
const usage = atom<Record<string, SessionUsage>>({})
// Title and state of pull requests Orca does not track, by URL, read when a session's details open.
const prInfo = atom<Record<string, PullRequestInfo>>({})
// Sessions whose numbers and pull request URLs whose titles are being read, for their skeletons.
const usageLoading = atom<Record<string, boolean>>({})
const prLoading = atom<Record<string, boolean>>({})
const loadError = atom<string | null>(null)
const busy = atom<Record<string, boolean>>({})
// The quick action whose form is open above Add action: its id, NEW_ACTION for a new one, or null.
const NEW_ACTION = ':new'
const editing = atom<string | null>(null)
const closeForm = () => set(editing, null)
// What the form holds, apart from the overview, so a refresh never replaces what is being typed.
type Draft = { name: string; command: string; projectId: string; url: string }
const draft = atom<Draft>({ name: '', command: '', projectId: '', url: '' })
const formError = atom<string | null>(null)
const actionError = atom<string | null>(null)

let loadSeq = 0
let eventTimer: ReturnType<typeof setTimeout> | null = null

async function load(): Promise<void> {
  const seq = ++loadSeq
  try {
    const next = await plugin.request('overview.load', undefined, { timeoutMs: 30000 })
    if (seq === loadSeq) {
      set(overview, next)
      set(loadError, null)
      // Forget sessions that ended, then refresh the numbers of the open ones.
      const live = new Set(next.sessions.map((s) => s.key))
      const open = Object.keys(read(expanded)).filter((key) => live.has(key))
      if (open.length !== Object.keys(read(expanded)).length) {
        setExpanded(open)
      }
      void loadUsage(open)
    }
  } catch {
    if (seq === loadSeq) {
      set(loadError, 'Could not read Orca. Check that the Orca CLI is installed.')
    }
  }
}

/** Reads the model, effort and tokens of these sessions; the details show what they have meanwhile. */
async function loadUsage(keys: string[]): Promise<void> {
  if (!keys.length) {
    return
  }
  void loadPullRequests(keys)
  update(usageLoading, (all) => ({ ...all, ...Object.fromEntries(keys.map((key) => [key, true])) }))
  try {
    const next = await plugin.request('session.usage', { keys }, { timeoutMs: 30000 })
    update(usage, (all) => ({ ...all, ...next }))
  } catch {
    // The details still show what Orca reported.
  } finally {
    update(usageLoading, (all) => ({ ...all, ...Object.fromEntries(keys.map((key) => [key, false])) }))
  }
}

/** Reads title and state of these sessions' pull requests Orca has none for; open ones again, for a merge. */
async function loadPullRequests(keys: string[]): Promise<void> {
  const known = read(prInfo)
  const wanted = new Set(keys)
  const urls = (read(overview)?.sessions ?? [])
    .filter((session) => wanted.has(session.key))
    .flatMap((session) => session.prs)
    .filter((pr) => !pr.title && (!known[pr.url] || known[pr.url].state === 'open'))
    .map((pr) => pr.url)
  if (!urls.length) {
    return
  }
  update(prLoading, (all) => ({ ...all, ...Object.fromEntries(urls.map((url) => [url, true])) }))
  try {
    const next = await plugin.request('pr.info', { urls }, { timeoutMs: 30000 })
    update(prInfo, (all) => ({ ...all, ...next }))
  } catch {
    // The details show the numbers alone.
  } finally {
    update(prLoading, (all) => ({ ...all, ...Object.fromEntries(urls.map((url) => [url, false])) }))
  }
}

function loadSoon(): void {
  if (eventTimer) {
    clearTimeout(eventTimer)
  }
  eventTimer = setTimeout(() => {
    eventTimer = null
    void load()
  }, EVENT_DELAY_MS)
}

/** Runs a worker action with `key` marked busy, then refreshes. */
async function act(key: string, action: () => Promise<unknown>, failure: string | ((error: unknown) => string)): Promise<void> {
  if (read(busy)[key]) {
    return
  }
  update(busy, (b) => ({ ...b, [key]: true }))
  set(actionError, null)
  try {
    await action()
  } catch (error) {
    set(actionError, typeof failure === 'string' ? failure : failure(error))
  } finally {
    update(busy, ({ [key]: _, ...rest }) => rest)
  }
  await load()
}

// After a start, look again while the server boots, so it turns green without waiting a full cycle.
const BOOT_CHECKS_MS = [3000, 8000]

async function startServer(server: Server): Promise<void> {
  await act(`server:${server.id}`, () => plugin.request('server.start', { id: server.id }, { timeoutMs: 40000 }), `Could not start ${server.name}.`)
  for (const delay of BOOT_CHECKS_MS) {
    setTimeout(() => void load(), delay)
  }
}
// Both open in the default browser; Orca allows it only from the press itself.
const openServer = (server: Server) => void shell.openExternal(server.url as string)
const stopServer = (server: Server) =>
  act(`server:${server.id}`, () => plugin.request('server.stop', { id: server.id }), `Could not stop ${server.name}.`)
const openProject = (project: Project) =>
  project.path
    ? act(`open:${project.id}`, () => plugin.request('project.open', { path: project.path as string }), `Could not open ${project.name}.`)
    : Promise.resolve()
const openPullRequest = (pr: PullRequest) => void shell.openExternal(pr.url)
/** Whether Orca's window shows this session's tab. A pane key starts with the id of its tab. */
export const isSelected = (session: Session, shown: { worktreeId: string; tabId: string } | null) =>
  shown !== null && shown.worktreeId === session.worktreeId && shown.tabId === session.key.split(':')[0]

async function loadSelected(): Promise<void> {
  try {
    const shown = await plugin.request('session.selected', undefined, { timeoutMs: 10000 })
    // Orca's window always shows some tab, so an empty answer is a failed read: keep the last one.
    if (shown && Date.now() >= selectedHeldUntil) {
      set(selected, shown)
    }
  } catch {
    // The titles keep the last known selection.
  }
}

/** Shows the session's workspace and tab in Orca; nothing on the panel changes, so no reload. */
async function focusSession(session: Session): Promise<void> {
  if (!session.path) {
    return
  }
  set(actionError, null)
  set(selected, { worktreeId: session.worktreeId, tabId: session.key.split(':')[0] })
  selectedHeldUntil = Date.now() + SELECTED_HOLD_MS
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

/** Opens the form for an action, or for a new one. */
function editAction(server: Server | null): void {
  set(draft, { name: server?.name ?? '', command: server?.command ?? '', projectId: server?.projectId ?? '', url: server?.url ?? '' })
  set(formError, null)
  set(editing, server?.id ?? NEW_ACTION)
}

/** What is missing before the form can be saved, or null. */
export function draftProblem(d: Draft): string | null {
  if (!d.projectId) {
    return 'Choose a project.'
  }
  if (!d.name.trim()) {
    return 'Give it a name.'
  }
  if (!d.command.trim()) {
    return 'Give it a command.'
  }
  // The address is optional: empty, it is read from the server's output at the next Run.
  return !d.url.trim() || normalUrl(d.url) ? null : 'Give it a web address, such as localhost:3000.'
}

async function saveDraft(id: string | null): Promise<void> {
  const d = read(draft)
  const problem = draftProblem(d)
  if (problem) {
    set(formError, problem)
    return
  }
  const input: QuickActionInput = { name: d.name, command: d.command, projectId: d.projectId, url: d.url, ...(id ? { id } : {}) }
  await act('action:save', () => plugin.request('action.save', input), `Could not save ${d.name.trim()}.`)
  if (!read(actionError)) {
    closeForm()
  }
}

async function deleteAction(id: string, name: string): Promise<void> {
  await act('action:delete', () => plugin.request('action.delete', { id }), `Could not delete ${name}.`)
  if (!read(actionError)) {
    closeForm()
  }
}

/** Closes every session's details and reloads the panel. */
function refresh(): void {
  setExpanded([])
  void load()
}

export function setup(ctx: PanelContext): () => void {
  ctx.subscriptions.push(
    on('agent.status.changed', loadSoon),
    on('workspace.created', loadSoon),
    on('workspace.removed', loadSoon)
  )
  const timer = setInterval(() => {
    if (read(ctx.visible)) {
      void load()
    }
  }, REFRESH_MS)
  const selectedTimer = setInterval(() => {
    if (read(ctx.visible)) {
      void loadSelected()
    }
  }, SELECTED_MS)
  ctx.subscriptions.push(
    storage.onDidChange(({ key }) => {
      if (key === EXPANDED_KEY) {
        void readExpanded()
      }
    })
  )
  void readExpanded()
  void load()
  void loadSelected()
  return () => {
    clearInterval(timer)
    clearInterval(selectedTimer)
    ++loadSeq
    if (eventTimer) {
      clearTimeout(eventTimer)
    }
  }
}


function ServerCard({ server }: { server: Server }) {
  const pending = Boolean(read(busy)[`server:${server.id}`])
  const ours = Boolean(server.terminal)
  const editingThis = read(editing) === server.id
  // Run and Stop share the first slot; a server running outside this panel has nothing to stop.
  const control = !server.up ? (
    <IconButton
      icon="play"
      label={`Run ${server.name}`}
      tooltip={`Run: ${server.command}`}
      size="xs"
      variant="ghost"
      tone="accent"
      disabled={pending}
      onPress={() => startServer(server)}
    />
  ) : ours ? (
    <IconButton icon="stop" label={`Stop ${server.name}`} size="xs" variant="ghost" disabled={pending} onPress={() => stopServer(server)} />
  ) : null
  return (
    <Box direction="row" align="center" gap="xs">
      <Box direction="row" align="center" justify="center" width={CONTROL_PX} minWidth={CONTROL_PX} shrink={false}>
        {control}
      </Box>
      {/* The name takes the free space, so the other buttons sit at the right edge. */}
      <Box grow minWidth={0}>
        <Text size="xs" muted truncate>
          {server.name}
        </Text>
      </Box>
      {server.up && ours ? (
        <IconButton icon="terminal" label={`Show ${server.name} terminal`} size="xs" variant="ghost" disabled={pending} onPress={() => startServer(server)} />
      ) : null}
      {/* Before the server printed its address there is nothing to open yet. */}
      {server.up && server.url ? (
        <IconButton
          icon="open-external"
          label={`Open ${server.name}`}
          tooltip={ours ? `Open ${server.url}` : `Open ${server.url} (started outside this panel)`}
          size="xs"
          variant="ghost"
          onPress={() => openServer(server)}
        />
      ) : null}
      {/* The row ends with the green dot of a running server, the same as a working session's, or the
          edit button of a stopped one, whose form opens above Add action and which then closes it. */}
      {server.up ? (
        <Box direction="row" align="center" justify="center" width={DOT_PX} minWidth={DOT_PX} shrink={false}>
          <Text size="xs" tone="success">
            ●
          </Text>
        </Box>
      ) : (
        <IconButton
          icon={editingThis ? 'close' : 'edit'}
          label={editingThis ? `Close ${server.name}` : `Edit ${server.name}`}
          tooltip={editingThis ? 'Close edit action' : undefined}
          size="xs"
          variant="ghost"
          onPress={() => (editingThis ? closeForm() : editAction(server))}
        />
      )}
    </Box>
  )
}

// The Run or Stop slot, in pixels, so every name starts at the same place.
const CONTROL_PX = 24

// How far an xs icon button's glyph sits inside its CONTROL_PX slot, in pixels.
const ICON_INSET_PX = 7

// The status dot's slot, in pixels, so every title ends at the same place.
const DOT_PX = 16

function StatusFact({ session }: { session: Session }) {
  const status = statusOf(session)
  const working = status.icon === 'working'
  // Active spins, idle is the grey dot the session row shows; other states have their own icon.
  const lead = working ? (
    <Spinner label="active" labelHidden />
  ) : status.icon === 'idle' ? (
    <Text size="xs" muted>
      ●
    </Text>
  ) : undefined
  return (
    <Box direction="row" align="center" gap="sm" minWidth={0}>
      <Box grow minWidth={0}>
        <Fact
          icon={lead ? undefined : (`status-${status.icon}` as FactIcon)}
          lead={lead}
          alt="Status"
        >
          <Text size="xs">{status.label}</Text>
        </Fact>
      </Box>
      {/* How long it has been in this state, just before Compact. */}
      {session.since ? (
        <Box shrink={false}>
          <Text size="xs" muted>
            <RelativeTime at={session.since} format={status.live ? 'duration' : 'short'} muted />
          </Text>
        </Box>
      ) : null}
      {/* Runs /compact in the session, at the far right; not while a turn runs, which Orca refuses for
          a chat. */}
      <Box shrink={false}>
        <IconButton
          icon="layers"
          label="Compact"
          variant="outline"
          tone="accent"
          size="xs"
          disabled={session.state === 'working' || Boolean(read(busy)[`compact:${session.key}`])}
          tooltip={session.state === 'working' ? 'Compact once this turn ends' : 'Run /compact in this session'}
          onPress={() => void compactSession(session)}
        />
      </Box>
    </Box>
  )
}

/** What Orca and the agent's transcript say about a session, under its row while open. */
function SessionDetails({ session }: { session: Session }) {
  const stats = read(usage)[session.key]
  const info = read(prInfo)
  const titleLoading = read(prLoading)
  // Only a Claude or Codex transcript has numbers to wait for, and only the first read shows
  // skeletons: a refresh keeps the numbers already shown.
  const pending = !stats && Boolean(read(usageLoading)[session.key]) && Boolean(session.agent && AGENT_LABEL[session.agent])
  return (
    <Box background="accent" radius="lg" padding="sm" gap="sm" margin="xs">
      <StatusFact session={session} />
      {pending ? (
        // One line each for the model, the context and the turns.
        <Box gap="xs">
          <Skeleton lines={1} label="Loading model" />
          <Skeleton lines={1} label="Loading context" />
          <Skeleton lines={1} label="Loading turns" />
        </Box>
      ) : (
        <Box gap="xs">
          <ModelFact session={session} stats={stats} />
          {stats?.context != null ? <ContextFact used={stats.context} window={stats.contextWindow} /> : null}
          {stats?.turns ? <TurnsFact stats={stats} /> : null}
        </Box>
      )}
      {/* The worktree, with its pull requests below it, set off from the usage by a rule; a long
          title truncates. */}
      <Separator />
      <Box gap="xs" minWidth={0}>
        <Fact icon="worktree" alt="Worktree">
          <Text size="xs" truncate>
            {session.workspace || 'main'}
          </Text>
          {session.branch && session.branch !== session.workspace ? (
            <Text size="xs" muted truncate>
              {`on ${session.branch}`}
            </Text>
          ) : null}
        </Fact>
        {session.prs.length ? (
          // Each pull request is one row that opens it in the default browser: the muted number and
          // title, then a muted open-external icon at the far right. An IconButton cannot be muted and a
          // Link holds only text, so the whole row is the press target.
          <List>
            {session.prs.map((pr) => {
              const title = pr.title ?? info[pr.url]?.title
              return (
                <ListItem key={pr.url} onPress={() => openPullRequest(pr)}>
                  <Box direction="row" align="center" gap="xs" minWidth={0}>
                    <Box shrink={false}>
                      <Text size="xs" muted>
                        {`#${pr.number}`}
                      </Text>
                    </Box>
                    <Box grow minWidth={0}>
                      {title ? (
                        <Text size="xs" muted truncate>
                          {title}
                        </Text>
                      ) : titleLoading[pr.url] ? (
                        <Skeleton lines={1} label="Loading title" />
                      ) : null}
                    </Box>
                    <Box shrink={false}>
                      <Icon src={`assets/details/open-external-${env.theme.colorScheme}.png`} alt="Open pull request" px={12} />
                    </Box>
                  </Box>
                </ListItem>
              )
            })}
          </List>
        ) : null}
      </Box>
    </Box>
  )
}

function SessionRow({ session }: { session: Session }) {
  const isOpen = Boolean(read(expanded)[session.key])
  return (
    <Box gap="none">
      <SessionLine session={session} />
      {isOpen ? (
        <Box direction="row" gap="none" minWidth={0}>
          <Box width={DETAILS_INDENT_PX} minWidth={DETAILS_INDENT_PX} shrink={false} />
          <Box grow minWidth={0}>
            <SessionDetails session={session} />
          </Box>
        </Box>
      ) : null}
      {/* A gap between an open card and the next session's title. */}
      {isOpen ? <Box height={16} shrink={false} /> : null}
    </Box>
  )
}

/** Opens these sessions' details and closes the rest, here and in every other panel. */
function setExpanded(keys: string[]): void {
  expandedEdits += 1
  const next: Record<string, true> = {}
  for (const key of keys) {
    next[key] = true
  }
  set(expanded, next)
  expandedWrites += 1
  void storage
    .set(EXPANDED_KEY, next)
    .catch(() => undefined)
    .finally(() => {
      expandedWrites -= 1
      if (expandedWrites === 0 && expandedReadWaiting) {
        expandedReadWaiting = false
        void readExpanded()
      }
    })
}

/** Takes the open details another panel stored, unless this panel changed them since. */
async function readExpanded(): Promise<void> {
  if (expandedWrites > 0) {
    expandedReadWaiting = true
    return
  }
  const edits = expandedEdits
  const seq = ++expandedReads
  const stored = await storage.get(EXPANDED_KEY).catch(() => null)
  if (edits !== expandedEdits || seq !== expandedReads) {
    return
  }
  const keys = stored && typeof stored === 'object' && !Array.isArray(stored) ? Object.keys(stored).filter((key) => stored[key] === true) : []
  const before = read(expanded)
  set(expanded, Object.fromEntries(keys.map((key) => [key, true as const])))
  const opened = keys.filter((key) => !before[key])
  if (opened.length) {
    void loadUsage(opened)
  }
}

function toggleDetails(key: string): void {
  const open = Object.keys(read(expanded))
  const opening = !open.includes(key)
  setExpanded(opening ? [...open, key] : open.filter((k) => k !== key))
  if (opening) {
    void loadUsage([key])
  }
}

// How far an open details card sits in from its session's row, in pixels.
const DETAILS_INDENT_PX = 16

function SessionLine({ session }: { session: Session }) {
  return (
    // The row toggles the details; the terminal button at the right shows the session's tab in Orca.
    // The button stays beside the ListItem so controls are not nested.
    // Every row is one line that truncates. Only the title of the tab Orca shows is in normal text,
    // with no background.
    <Box direction="row" align="center" gap="none" minWidth={0}>
      <Box grow minWidth={0}>
        <List>
          <ListItem onPress={() => toggleDetails(session.key)}>
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
      <IconButton
        icon="terminal"
        label={`Show ${session.title} tab`}
        size="xs"
        variant="ghost"
        disabled={!session.path}
        onPress={() => focusSession(session)}
      />
    </Box>
  )
}

type Group = { key: string; project: Project | null; name: string; sessions: Session[] }

/**
 * One entry per project, in Orca's sidebar order, with its sessions under it: nothing moves as
 * agents change state, and dragging a project in the sidebar moves it here. Sessions outside every
 * project get an entry of their own, last.
 */
function groups(projects: Project[], sessions: Session[]): Group[] {
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

function ProjectGroup({ group }: { group: Group }) {
  const { project } = group
  return (
    <Box gap="none">
      {/* The whole row is pressable and opens the project's main checkout in Orca. */}
      <List>
        <ListItem onPress={project?.path ? () => void openProject(project) : undefined}>
          <Box direction="row" align="center" gap="xs" minWidth={0}>
            <Icon src={`assets/details/project-${env.theme.colorScheme}.png`} alt="Project" px={12} />
            <Box grow minWidth={0}>
              <Text size="sm" muted truncate>
                {group.name}
              </Text>
            </Box>
          </Box>
        </ListItem>
      </List>
      {group.sessions.length ? (
        <Box gap="none" paddingX="md">
          {group.sessions.map((session) => (
            <SessionRow key={session.key} session={session} />
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

/** A muted label with its icon button right after it, on a line of its own. */
function LabelledButton({ text, icon, tooltip, onPress }: { text: string; icon: 'add' | 'close'; tooltip?: string; onPress: () => void }) {
  return (
    <Box direction="row" align="center" gap="xs">
      <Box minWidth={0}>
        <Text size="xs" muted truncate>
          {text}
        </Text>
      </Box>
      <IconButton icon={icon} label={text} tooltip={tooltip} size="xs" variant="ghost" onPress={onPress} />
    </Box>
  )
}

/** The form for one quick action: its name, its command, and the project whose checkout runs it. */
function ActionForm({ id, servers, projects }: { id: string | null; servers: Server[]; projects: Project[] }) {
  const d = read(draft)
  const problem = read(formError)
  const saving = Boolean(read(busy)['action:save'] || read(busy)['action:delete'])
  const server = id ? servers.find((s) => s.id === id) : undefined
  // Only a project with a main checkout can run a command.
  const choices = projects.filter((p) => p.path)
  const edit = (change: Partial<Draft>) => {
    update(draft, (current) => ({ ...current, ...change }))
    set(formError, null)
  }
  return (
    // A card like the session details, so the form stands apart from the actions above it.
    <Box background="accent" radius="lg" padding="sm" gap="md" margin="xs">
      <Box gap="xs">
        <Text size="sm">{server ? 'Edit action' : 'Add new action'}</Text>
        {/* The placeholders show examples only, so the note says what is optional. */}
        <Text size="xs" muted>
          The command runs in the project's main checkout. Add a URL only if it differs from the one the server prints.
        </Text>
      </Box>
      {/* No visible labels: the placeholders name the fields, the hidden labels serve screen readers.
          Project and name share a row, half each. */}
      <Box direction="row" align="center" gap="sm">
        <Box grow minWidth={0} width="50%">
          <Select
            label="Project"
            labelHidden
            value={d.projectId || undefined}
            placeholder="Project"
            options={choices.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(projectId) => edit({ projectId })}
          />
        </Box>
        <Box grow minWidth={0} width="50%">
          <Input label="Name" labelHidden value={d.name} placeholder="Name" maxLength={40} onChange={(name) => edit({ name })} />
        </Box>
      </Box>
      <Textarea
        label="Command"
        labelHidden
        value={d.command}
        placeholder="npm run dev"
        rows={2}
        onChange={(command) => edit({ command })}
      />
      <Input label="URL" labelHidden value={d.url} placeholder="URL (optional)" onChange={(url) => edit({ url })} />
      {problem ? (
        <Text size="xs" tone="danger">
          {problem}
        </Text>
      ) : null}
      {/* One button on the right (Orca puts a Button's icon before its text, so Add's plus is text);
          an action being edited also has a small Delete on the left. The row's button or Add
          action's closes the form. */}
      <Box direction="row" align="center" justify="between" gap="sm">
        {server ? (
          <Button variant="ghost" tone="danger" size="xs" tooltip={`Remove ${server.name} action from quick actions`} disabled={saving} onPress={() => void deleteAction(server.id, server.name)}>
            Delete
          </Button>
        ) : (
          <Box />
        )}
        <Box direction="row" align="center" gap="xs">
          <Button variant="ghost" size="xs" disabled={saving} onPress={closeForm}>
            Cancel
          </Button>
          <Button variant="solid" tone="neutral" size="xs" disabled={saving} onPress={() => void saveDraft(id)}>
            {server ? 'Save' : 'Add +'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}

const toggleActions = () => update(sections, (s) => ({ ...s, actions: !s.actions }))

export default function Panel() {
  const data = read(overview)
  const error = read(loadError)
  const failure = read(actionError)
  const open = read(sections)
  const form = read(editing)
  return (
    <Box height="100%" gap="sm">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {failure ? <Callout tone="danger">{failure}</Callout> : null}
      {!data ? (
        <Skeleton lines={6} label="Loading" />
      ) : (
        <Box grow minHeight={0} gap="md">
          {/* Sessions take the free space and scroll; Quick actions stay at the bottom. */}
          <Box grow minHeight={0} gap="md">
            {/* A plain title, since Sessions never collapses; its button closes every session's details and reads Orca again. */}
            <Box gap="none" shrink={false}>
              <Box direction="row" align="center" justify="between" gap="sm">
                <Text weight="medium">Sessions</Text>
                <IconButton icon="remove" label="Collapse all session details" size="xs" variant="ghost" onPress={refresh} />
              </Box>
              <Text size="xs" muted>
                All your sessions in one place, grouped by project.
              </Text>
            </Box>
            <Box grow minHeight={0} scroll="y">
              <Stack gap="md">
                {groups(data.projects, data.sessions).map((group) => (
                  <ProjectGroup key={group.key} group={group} />
                ))}
              </Stack>
            </Box>
          </Box>
          {/* The column's md gap puts md above the line that divides Sessions from Quick actions. The
              header is the panel's own, not a Collapsible, so it can carry a green dot while a server
              runs, open or closed; its arrow points right when closed and down when open, as Orca's does. */}
          <Box shrink={false} maxHeight="70%" gap="xs">
            <Box shrink={false}>
              <Separator />
            </Box>
            {/* One pressable header: the arrow and the title open and close the section together. The
                dot has its own row, so it gets more room than the title's gap. */}
            <Box shrink={false}>
              <List>
                <ListItem icon={open.actions ? 'expand' : 'next'} onPress={toggleActions}>
                  <Box direction="row" align="center" gap="sm">
                    <Text weight="medium">Quick actions</Text>
                    {data.servers.some((server) => server.up) ? (
                      <Text size="xs" tone="success">
                        ●
                      </Text>
                    ) : null}
                  </Box>
                </ListItem>
              </List>
              {/* What the section is for, starting at the left edge of the Run icons below: the rows' inset,
                  then the gap before an icon centred in its CONTROL_PX slot. */}
              <Box direction="row" gap="none" paddingX="xs">
                <Box width={ICON_INSET_PX} minWidth={ICON_INSET_PX} shrink={false} />
                <Box grow minWidth={0}>
                  <Text size="xs" muted>
                    Quick actions for your most frequent scripts.
                  </Text>
                </Box>
              </Box>
              {/* Room between the description and the actions when they show. */}
              {open.actions ? <Box height={8} shrink={false} /> : null}
            </Box>
            {open.actions ? (
              <Box minHeight={0} scroll="y">
                <Stack gap="md">
                  {data.servers.length ? (
                    // Inset by the header's own padding, so Run sits under its arrow and the names under its title.
                    <Box gap="sm" paddingX="xs">
                      {data.servers.map((server) => (
                        <ServerCard key={server.id} server={server} />
                      ))}
                    </Box>
                  ) : (
                    <Text size="xs" muted>
                      Click the + icon to create quick action commands.
                    </Text>
                  )}
                  {/* Add action sits under the servers; the form for a new action or the one being edited
                      opens between them and it, and Add action's button then closes it. */}
                  <Stack gap="none">
                    {form ? (
                      <Box paddingY="sm">
                        <ActionForm key={form} id={form === NEW_ACTION ? null : form} servers={data.servers} projects={data.projects} />
                      </Box>
                    ) : null}
                    <LabelledButton
                      text={form && form !== NEW_ACTION ? 'Edit action' : 'Add action'}
                      icon={form ? 'close' : 'add'}
                      tooltip={form ? (form === NEW_ACTION ? 'Close new action' : 'Close edit action') : undefined}
                      onPress={() => (form ? closeForm() : editAction(null))}
                    />
                  </Stack>
                </Stack>
              </Box>
            ) : null}
          </Box>
        </Box>
      )}
    </Box>
  )
}
