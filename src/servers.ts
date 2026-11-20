// The quick actions: dev servers the panel starts. Each runs `command` in a terminal at `path`, the
// main checkout of an Orca project. There are none built in: the person adds them in the panel, and
// the worker keeps them in plugin storage. Each server is watched in one Orca terminal and counts as
// running only while the process on its port was started in it (`serverState`). Unless typed, the
// address is learned again from what the server prints at each start.
import { terminalAlive, terminalByTitle } from './overview'
import type { Project, QuickAction, QuickActionInput } from './protocol'
import { normalUrl } from './url'

/** The terminal title a server's terminal gets, so it is found again after a worker restart. The
 *  prefix keeps it apart from agent terminals, which take their conversation's name. */
export const terminalTitle = (action: Pick<QuickAction, 'id' | 'name'>): string => `⚡ ${action.name} server (${action.id})`

/**
 * Each action's own terminal in `orca terminal list --json`: the one the panel started it in
 * (`known`, by handle) while it is open in the action's folder, else one with its title. A closed
 * or disconnected watched terminal stays null; an action never watched has no entry.
 */
export function actionTerminals(
  actions: readonly Pick<QuickAction, 'id' | 'name' | 'path'>[],
  terminalsJson: string,
  known: Readonly<Record<string, string>>
): Record<string, string | null> {
  return Object.fromEntries(
    actions.flatMap((a) => {
      const handle = known[a.id]
      const live = handle && terminalAlive(terminalsJson, handle, a.path) ? handle : terminalByTitle(terminalsJson, terminalTitle(a), a.path)
      return handle || live ? [[a.id, live]] : []
    })
  )
}

/** The port an address points at, or null for one that is not a local http address. */
export function portOf(url: string | null): number | null {
  if (!url) {
    return null
  }
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    if (!['http:', 'https:'].includes(parsed.protocol) ||
      !(host === 'localhost' || host.endsWith('.localhost') || ['127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(host))) {
      return null
    }
    return parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9-]+\.localhost):\d+[^\s'"<>)\]]*/gi

/**
 * The address a dev server printed as it started: the last one on a line that says `Local` (Vite and
 * Next.js print it so), else the last local address, since a command that starts other services
 * first prints theirs earlier. The last, so a rerun in the same terminal wins over the run before.
 * `0.0.0.0` opens as `localhost`; a trailing slash or full stop is dropped.
 */
export function printedUrl(lines: readonly string[]): string | null {
  let local: string | null = null
  let last: string | null = null
  for (const line of lines) {
    const found = line.match(LOCAL_URL)
    if (!found) {
      continue
    }
    last = found[0]
    if (/\blocal\b/i.test(line)) {
      local = found[0]
    }
  }
  const url = local ?? last
  return url ? tidy(url) : null
}

const tidy = (url: string) => url.replace('://0.0.0.0', '://localhost').replace(/[/.,;:]+$/, '')

/** The stored list, or null when nothing valid is stored yet. */
export function storedActions(value: unknown): QuickAction[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value.filter(
    (a): a is QuickAction =>
      Boolean(a) && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.command === 'string' && typeof a.path === 'string'
  )
}

/** Links each action without a project to the Orca project whose main checkout is its folder. */
export function linkProjects(actions: QuickAction[], projects: readonly Project[]): QuickAction[] {
  return actions.map((action) => {
    if (action.projectId) {
      return action
    }
    const project = projects.find((p) => p.path === action.path)
    return project ? { ...action, projectId: project.id } : action
  })
}

const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid_params' })

/**
 * The list with `input` added, or replacing the action with its id. A typed `url` is the address
 * (empty: read it at the next Run); without one, a new command or project forgets the address the
 * server printed.
 */
export function saveAction(actions: QuickAction[], input: QuickActionInput, projects: readonly Project[], newId: string): QuickAction[] {
  const name = input.name.trim()
  const command = input.command.trim()
  const project = projects.find((p) => p.id === input.projectId)
  if (!name || !command) {
    throw invalid('A quick action needs a name and a command.')
  }
  const typed = input.url === undefined ? undefined : normalUrl(input.url)
  if (input.url?.trim() && !typed) {
    throw invalid(`Not a web address: ${input.url}`)
  }
  if (!project?.path) {
    throw invalid('Choose a project with a main checkout.')
  }
  const existing = input.id ? actions.find((a) => a.id === input.id) : undefined
  if (input.id && !existing) {
    throw invalid(`Unknown quick action ${input.id}`)
  }
  if (!existing) {
    return [...actions, { id: newId, name, command, projectId: project.id, path: project.path, url: typed ?? null, urlTyped: Boolean(typed) }]
  }
  const moved = existing.projectId !== project.id || existing.path !== project.path
  // The form sends back the address it showed: unchanged, it is still printed or typed as before.
  const typedNew = typed !== undefined && typed !== existing.url
  const keepsTyped = !typedNew && Boolean(existing.urlTyped && existing.url)
  const forgets = moved || command !== existing.command
  const url = typedNew ? typed : keepsTyped || !forgets ? existing.url : null
  const next: QuickAction = {
    ...existing,
    name,
    command,
    projectId: project.id,
    path: project.path,
    url,
    urlTyped: Boolean(url) && (typedNew || keepsTyped)
  }
  return actions.map((a) => (a.id === existing.id ? next : a))
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

/** The process ids `lsof -t` prints, one per line. */
export function listenerPids(output: string): number[] {
  return [...new Set(output.split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 1))]
}

/** Each process's working folder, from `lsof -a -d cwd -Fpn -p <pids>`: a `p<pid>` line, then `n<path>`. */
export function processFolders(output: string): Map<number, string> {
  const folders = new Map<number, string>()
  let pid: number | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
    } else if (line.startsWith('n') && pid !== null && Number.isInteger(pid)) {
      folders.set(pid, line.slice(1))
    }
  }
  return folders
}

/** Whether the processes listening on a port are the action's: each runs in its folder or below. */
export function listenersInFolder(pids: readonly number[], folders: ReadonlyMap<number, string>, path: string): boolean {
  const root = path.replace(/\/+$/, '')
  return pids.length > 0 && pids.every((pid) => {
    const folder = folders.get(pid)
    return folder !== undefined && (folder === root || folder.startsWith(`${root}/`))
  })
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

/**
 * The address to keep once a start printed `printed`: the stored one while the port is the same,
 * since an address typed before typed ones were marked (such as `demo.localhost:3100` for a server
 * printing `localhost:3100`) looks like a printed one; the printed one when the port moved.
 */
export function relearnedUrl(stored: string | null, printed: string): string {
  return stored && portOf(stored) !== null && portOf(stored) === portOf(printed) ? stored : printed
}

/** A process's parent, controlling terminal and the Orca terminal it was started in, from
 *  `ps eww -o ppid=,tty=,command= -p <pid>`: Orca puts `ORCA_PANE_KEY` and `ORCA_TERMINAL_HANDLE`
 *  in a terminal's environment. A daemon has no controlling terminal (`??` on macOS, `?` on Linux). */
export type ProcessTerminal = { ppid: number | null; detached: boolean; paneKey: string | null; handle: string | null }

export function processTerminal(output: string): ProcessTerminal {
  const line = output.trim()
  const [, ppidText, tty] = /^(\d+)\s+(\S+)/.exec(line) ?? []
  const ppid = Number(ppidText)
  return {
    ppid: Number.isInteger(ppid) && ppid > 1 ? ppid : null,
    detached: !tty || /^\?+$/.test(tty),
    paneKey: /\sORCA_PANE_KEY=(\S+)/.exec(line)?.[1] ?? null,
    handle: /\sORCA_TERMINAL_HANDLE=(term_\S+)/.exec(line)?.[1] ?? null
  }
}

/** Observations of a server's listener and foreground command, read by the worker. */
export type ServerObservation = {
  serving: string | null
  inFolder: boolean
  commandRunning: boolean
}

/** Whether a server is running, and the Orca terminal it is watched in. Stop targets this terminal. */
export type ServerState = { up: boolean; terminal: string | null }
type WatchedAction = Pick<QuickAction, 'id' | 'path' | 'url'>

/**
 * A known port runs only when its listener belongs to the watched terminal. Missing ownership
 * never proves that. Before a URL is known, a foreground command in that terminal is enough.
 * Only an action never watched can adopt a manually started server from its project folder.
 */
export function serverState(
  a: WatchedAction,
  own: Readonly<Record<string, string | null>>,
  observed: ServerObservation
): ServerState {
  const mine = own[a.id] ?? null
  const stopped: ServerState = { up: false, terminal: mine }
  if (!portOf(a.url)) {
    return { up: mine !== null && observed.commandRunning, terminal: mine }
  }
  if (mine) {
    return { up: observed.serving === mine, terminal: mine }
  }
  const serving = observed.serving
  if (a.id in own || !serving || Object.values(own).includes(serving) || !observed.inFolder) {
    return stopped
  }
  return { up: true, terminal: serving }
}

/** Reserve discovered terminals in action order, so two actions never adopt the same terminal. */
export function watchServers(
  actions: readonly WatchedAction[],
  own: Readonly<Record<string, string | null>>,
  observations: readonly ServerObservation[]
): { states: ServerState[]; terminals: Record<string, string | null> } {
  const terminals = { ...own }
  const states = actions.map((a, index) => {
    const state = serverState(a, terminals, observations[index])
    if (state.terminal) {
      terminals[a.id] = state.terminal
    }
    return state
  })
  return { states, terminals }
}

/**
 * What Run does: show the terminal of a running server, run the command again in its open terminal,
 * or open a new one. A terminal still running a command is only shown, so the command is never typed
 * into a server that is starting or listens on a port other than the one stored.
 */
export function startStep(state: ServerState, own: string | null, commandRunning: boolean): 'show' | 'rerun' | 'create' {
  if (own) {
    return state.up || commandRunning ? 'show' : 'rerun'
  }
  return state.up ? 'show' : 'create'
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'login'])

/**
 * Whether a command runs in a terminal, from `ps eww -ax -o pid=,tty=,stat=,command=`: a foreground
 * process (`+`) carrying the terminal's `ORCA_PANE_KEY` or `ORCA_TERMINAL_HANDLE`, other than a shell.
 * Prompt helpers run in the background. macOS hides the environment of its own binaries, so a
 * command such as `/bin/sleep` is not seen; dev servers (node, bun, deno) are.
 */
export function commandRunning(psOutput: string, paneKey: string | null, handle: string): boolean {
  return psOutput.split('\n').some((line) => {
    const [, tty, stat, command] = /^\s*\d+\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line) ?? []
    if (!command || !stat.includes('+') || /^\?+$/.test(tty)) {
      return false
    }
    const program = (command.split(/\s/)[0] ?? '').split('/').pop()?.replace(/^-/, '') ?? ''
    const padded = `${command} `
    const ours = (paneKey !== null && padded.includes(` ORCA_PANE_KEY=${paneKey} `)) || padded.includes(` ORCA_TERMINAL_HANDLE=${handle} `)
    return ours && !SHELLS.has(program)
  })
}
