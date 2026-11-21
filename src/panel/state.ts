// The panel's state: what it last read from the worker, what is open, pinned and busy, and the
// reads that keep it current. One copy per panel, so every component reads the same atoms.
import { atom, plugin, read, set, storage, update, type OrcaEvents, type PanelContext } from 'orca'
import type { ActionStatus, Overview, PullRequestInfo, Selected, SessionUsage } from '../protocol'
import { watchQuickActions } from './quick-action-polling'

export const REFRESH_MS = 15000
const EVENT_DELAY_MS = 400
// How often the panel asks which tab Orca shows; each read starts a process under Orca's Node.
export const SELECTED_MS = 2000
// After a press shows a tab, how long the panel trusts that over a read that may predate the switch.
const SELECTED_HOLD_MS = 3000

// The last overview, kept across panel runs so reopening shows it at once while it refreshes.
export const overview = atom<Overview | null>('overview', null, { persist: 'plugin', version: 8, migrate: () => null })
// Which sections are open, kept across panel runs.
export const sections = atom<{ favourites?: boolean; sessions?: boolean; actions: boolean }>('sections', { favourites: true, sessions: true, actions: true }, { persist: 'plugin' })
// Whether Sessions lists only the projects that have a session, kept across panel runs.
export const projectsWithSessionsOnly = atom<boolean>('projectsWithSessionsOnly', false, { persist: 'plugin' })
// Projects just shown again by the activity button, by project id; cleared after REVEAL_MS.
export const REVEAL_MS = 100
export const revealed = atom<string[]>([])
let revealTimer: ReturnType<typeof setTimeout> | null = null
// Sessions whose details are open, by session key. Orca runs a panel per workspace, and showing a
// session can switch workspace, so each change goes to the plugin's storage at once and every panel
// takes the others' changes from there.
export const EXPANDED_KEY = 'expanded'
// Pinned sessions, by session key in the order they were pinned: their details stay open above
// Sessions. Kept in the plugin's storage, which keeps every panel current.
export const PINNED_KEY = 'pinned'
export const pinned = atom<string[]>(PINNED_KEY, [], { persist: 'storage' })
export const expanded = atom<Record<string, true>>({})
// Bumped by each change here and each storage read, so a read never undoes a newer change.
let expandedEdits = 0
let expandedReads = 0
// Writes not yet answered: a read meanwhile could still see the older value, so it waits for them.
let expandedWrites = 0
let expandedReadWaiting = false
// The workspace and tab Orca's window shows, so that session's title, and its workspace's and
// project's names, are in normal text.
export const selected = atom<Selected | null>(null)
let selectedHeldUntil = 0
let selectedReading = false
// Model, effort and tokens of sessions whose details were opened, by session key.
export const usage = atom<Record<string, SessionUsage>>({})
// Title and state of pull requests Orca does not track, by URL, read when a session's details open.
export const prInfo = atom<Record<string, PullRequestInfo>>({})
// Sessions whose numbers and pull request URLs whose titles are being read, for their skeletons.
export const usageLoading = atom<Record<string, boolean>>({})
// Sessions whose last usage read failed, so their details do not report a missing transcript.
export const usageFailed = atom<Record<string, boolean>>({})
export const prLoading = atom<Record<string, boolean>>({})
export const loadError = atom<string | null>(null)
export const busy = atom<Record<string, boolean>>({})
// The quick action whose form is open: its id, NEW_ACTION for a new one, or null.
export const NEW_ACTION = ':new'
export const editing = atom<string | null>(null)
export const closeForm = () => set(editing, null)
// What the form holds, apart from the overview, so a refresh never replaces what is being typed.
// `steps` holds one entry per command row, at least one.
export type Draft = { name: string; steps: string[]; projectId: string; url: string }
export const draft = atom<Draft>({ name: '', steps: [''], projectId: '', url: '' })
export const formError = atom<string | null>(null)
export const actionError = atom<string | null>(null)

let loadSeq = 0
let eventTimer: ReturnType<typeof setTimeout> | null = null

export async function load(): Promise<void> {
  const seq = ++loadSeq
  try {
    const next = await plugin.request('overview.load', undefined, { timeoutMs: 30000 })
    if (seq === loadSeq) {
      set(overview, next)
      set(loadError, null)
      // Forget sessions that ended, then refresh the numbers of the open and pinned ones.
      const live = new Set(next.sessions.map((s) => s.key))
      const open = Object.keys(read(expanded)).filter((key) => live.has(key))
      if (open.length !== Object.keys(read(expanded)).length) {
        setExpanded(open)
      }
      const pins = read(pinned).filter((key) => live.has(key))
      if (pins.length !== read(pinned).length) {
        set(pinned, pins)
      }
      void loadUsage([...new Set([...open, ...pins])])
    }
  } catch {
    if (seq === loadSeq) {
      set(loadError, 'Could not read Orca. Check that the Orca CLI is installed.')
    }
  }
}

/** Reads the model, effort and tokens of these sessions; the details show what they have meanwhile. */
export async function loadUsage(keys: string[]): Promise<void> {
  if (!keys.length) {
    return
  }
  void loadPullRequests(keys)
  update(usageLoading, (all) => ({ ...all, ...Object.fromEntries(keys.map((key) => [key, true])) }))
  const markFailed = (failed: boolean) => update(usageFailed, (all) => ({ ...all, ...Object.fromEntries(keys.map((key) => [key, failed])) }))
  try {
    const next = await plugin.request('session.usage', { keys }, { timeoutMs: 30000 })
    update(usage, (all) => ({ ...all, ...next }))
    markFailed(false)
  } catch {
    // The details still show what Orca reported, and the next refresh reads again.
    markFailed(true)
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

export function loadSoon(): void {
  if (eventTimer) {
    clearTimeout(eventTimer)
  }
  eventTimer = setTimeout(() => {
    eventTimer = null
    void load()
  }, EVENT_DELAY_MS)
}

// The focused workspace as Orca last reported it; null before the first report.
let focusedWorkspace: { id?: string } | null = null

/**
 * Reloads on any change in the focused workspace, as a terminal closing there can end a session.
 * Orca reports a close about 0.3 s after it, while the closed terminal is still listed, and again
 * about 2 s later without it, so the terminal list cannot tell a close apart. It reads at once: a
 * panel in the background can hold a timer for a second, and the later report reads again. The
 * first report and a workspace switch do not reload.
 */
export function workspaceChanged({ context }: OrcaEvents['workspace.changed']): void {
  if (focusedWorkspace && context && focusedWorkspace.id === context.workspaceId) {
    void load()
  }
  focusedWorkspace = context ? { id: context.workspaceId } : null
}

/** Ends this panel run's reads: a press's hold is this run's, and the next run reads Orca afresh. */
export function endPanelRun(): void {
  selectedHeldUntil = 0
  focusedWorkspace = null
  ++loadSeq
  if (eventTimer) {
    clearTimeout(eventTimer)
  }
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
  set(revealed, [])
}

/** Runs a worker action with `key` marked busy, then refreshes. */
export async function act(key: string, action: () => Promise<unknown>, failure: string | ((error: unknown) => string)): Promise<boolean> {
  if (read(busy)[key]) {
    return false
  }
  let succeeded = false
  update(busy, (b) => ({ ...b, [key]: true }))
  set(actionError, null)
  try {
    await action()
    succeeded = true
  } catch (error) {
    set(actionError, typeof failure === 'string' ? failure : failure(error))
  } finally {
    update(busy, ({ [key]: _, ...rest }) => rest)
  }
  await load()
  return succeeded
}

let actionPolling: ReturnType<typeof watchQuickActions>

/** Watches the quick actions for this panel run; dispose it when the run ends. */
export function watchActions(ctx: PanelContext): ReturnType<typeof watchQuickActions> {
  actionPolling = watchQuickActions(ctx, load, () => read(overview)?.servers ?? [])
  return actionPolling
}

export async function startAction(action: ActionStatus): Promise<void> {
  await actionPolling.start(action.id, () =>
    act(`run:${action.id}`, () => plugin.request('server.start', { id: action.id }, { timeoutMs: 40000 }), `Could not start ${action.name}.`)
  )
}

export async function loadSelected(): Promise<void> {
  // A read starts a process; one at a time, so a slow one never piles up behind the timer.
  if (selectedReading) {
    return
  }
  selectedReading = true
  try {
    const shown = await plugin.request('session.selected', undefined, { timeoutMs: 10000 })
    if (Date.now() >= selectedHeldUntil) {
      // Orca names only the workspace: the session last shown from here stays marked while it is on screen.
      const known = read(selected)
      set(selected, shown && shown.key === null && known?.worktreeId === shown.worktreeId ? known : shown)
    }
  } catch {
    // The titles keep the last known selection.
  } finally {
    selectedReading = false
  }
}

/** Shows `shown` as selected and trusts it over reads for a while, as a press just showed it. */
export function holdSelected(shown: Selected): void {
  set(selected, shown)
  selectedHeldUntil = Date.now() + SELECTED_HOLD_MS
}

/** Opens these sessions' details and closes the rest, here and in every other panel. */
export function setExpanded(keys: string[]): void {
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
export async function readExpanded(): Promise<void> {
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

export function toggleDetails(key: string): void {
  const open = Object.keys(read(expanded))
  const opening = !open.includes(key)
  setExpanded(opening ? [...open, key] : open.filter((k) => k !== key))
  if (opening) {
    void loadUsage([key])
  }
}

/** Shows a session above Sessions with its details open; it stays in its project too, with its details there closed. */
export function pinSession(key: string): void {
  update(pinned, (keys) => (keys.includes(key) ? keys : [...keys, key]))
  if (read(expanded)[key]) {
    setExpanded(Object.keys(read(expanded)).filter((k) => k !== key))
  }
  void loadUsage([key])
}

/** Reads the numbers of sessions another panel pinned, which this panel has none for yet. */
export async function loadPinnedUsage(): Promise<void> {
  const stored = await storage.get(PINNED_KEY).catch(() => null)
  const known = read(usage)
  const loading = read(usageLoading)
  const keys = Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string' && !known[key] && !loading[key]) : []
  void loadUsage(keys)
}

/** Takes a session out of the Pinned area; it stays where it is in its project. */
export const unpinSession = (key: string) => update(pinned, (keys) => keys.filter((k) => k !== key))

/** Closes every session's details and reloads the panel. */
export function refresh(): void {
  setExpanded([])
  void load()
}

export const toggleActions = () => update(sections, (s) => ({ ...s, actions: !s.actions }))
// Sessions stored before it could close have no flag, and stay open.
export const toggleSessions = () => update(sections, (s) => ({ ...s, sessions: s.sessions === false }))
// Favourites stored before it could close have no flag, and stay open.
export const toggleFavourites = () => update(sections, (s) => ({ ...s, favourites: s.favourites === false }))

/**
 * Shows only the projects with a session, or all of them again. Showing all again marks each project
 * that comes back with a grey dot and its name in normal text for REVEAL_MS, so the eye finds what changed.
 */
export function toggleProjectsWithSessionsOnly(): void {
  const wasOn = read(projectsWithSessionsOnly)
  update(projectsWithSessionsOnly, (on) => !on)
  const data = read(overview)
  if (!wasOn || !data) {
    return
  }
  // The projects the filter hid: no session belongs to them.
  set(revealed, data.projects.filter((p) => !data.sessions.some((s) => s.projectId === p.id)).map((p) => p.id))
  if (revealTimer) {
    clearTimeout(revealTimer)
  }
  revealTimer = setTimeout(() => {
    revealTimer = null
    set(revealed, [])
  }, REVEAL_MS)
}
