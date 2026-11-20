// Serves the Power Sessions panel. Orca transpiles this file when it loads: no build step. Most of
// what the panel reads and does goes through the `orca` CLI, which runs as the same user; showing a
// folder workspace, which the CLI refuses, goes through the host's `workspace.open`.
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import type { OrcaWorkerApi } from 'orca/worker'
import { run } from './cli'
import { agentPanes, chatSessionId, defaultAgent, orderLikeSidebar, paneOfTerminal, parseProjects, parseSessions, terminalOfPane, terminalServing, workspaceRanks } from './overview'
import type { Overview, Project, QuickAction, Server } from './protocol'
import {
  actionTerminals,
  commandRunning,
  linkProjects,
  listenerPids,
  listenersInFolder,
  outputCursor,
  portOf,
  printedUrl,
  processFolders,
  processTerminal,
  relearnedUrl,
  saveAction,
  startStep,
  storedActions,
  terminalTail,
  terminalTitle,
  watchServers
} from './servers'
import type { ServerObservation, ServerState } from './servers'
import { pullRequestInfo } from './pulls'
import { sessionUsage, tabPositions } from './usage'
import { compactChat } from './chats'
import { focusTab, folderAt, selectedTab, tabCount } from './tabs'

// The quick actions, as the person last saved them.
const ACTIONS_KEY = 'quickActions'
// Server id -> the terminal handle it was started in, kept across worker restarts.
const HANDLES_KEY = 'serverTerminals'
type Handles = Record<string, string>
// Server id -> where the output of its latest start begins (null: read the tail), until it prints its address.
const STARTS_KEY = 'serverStarts'
type Starts = Record<string, string | null>

const PORT_TIMEOUT_MS = 400
// How much of a server's terminal output is searched for the address it printed.
const OUTPUT_LINES = '400'

function answersOn(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(PORT_TIMEOUT_MS, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Whether a server listens on `port`, over IPv4 or IPv6: dev servers bind either. */
export async function portOpen(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([answersOn('127.0.0.1', port), answersOn('::1', port)])
  return v4 || v6
}

/** The handle `orca terminal create --json` answers with, wherever the result keeps it. */
export function handleOf(json: string): string | null {
  return /"(term_[^"]+)"/.exec(json)?.[1] ?? null
}

/** A new action's id: its name in lowercase letters and digits, and a short random part. */
const newId = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'action'}-${randomUUID().slice(0, 8)}`

export default function activate(orca: OrcaWorkerApi): void {
  async function record<T>(key: string): Promise<Record<string, T>> {
    const stored = await orca.storage.get(key)
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, T>) : {}
  }
  const handles = (): Promise<Handles> => record<string>(HANDLES_KEY)
  const starts = (): Promise<Starts> => record<string | null>(STARTS_KEY)

  // All storage read-modify-write operations share a queue, including concurrent actions.
  let writes: Promise<unknown> = Promise.resolve()
  function write<T>(edit: () => Promise<T>): Promise<T> {
    const next = writes.then(edit)
    writes = next.catch(() => undefined)
    return next
  }

  /** Marks a start, so the address its output prints replaces the stored one. */
  async function markStart(id: string, cursor: string | null): Promise<void> {
    await write(async () => orca.storage.set(STARTS_KEY, { ...(await starts()), [id]: cursor }))
  }

  async function forgetStarts(ids: readonly string[]): Promise<void> {
    await write(async () => {
      const current = await starts()
      if (ids.some((id) => id in current)) {
        await orca.storage.set(STARTS_KEY, Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))))
      }
    })
  }

  // Changes to the stored list run one at a time, so a save and a learned address never overwrite each other.
  function change(edit: (actions: QuickAction[]) => QuickAction[]): Promise<QuickAction[]> {
    return write(async () => {
      const current = await actions()
      const edited = edit(current)
      if (JSON.stringify(edited) !== JSON.stringify(current)) {
        await orca.storage.set(ACTIONS_KEY, edited)
      }
      return edited
    })
  }

  /** The stored quick actions; the default servers before anything was saved. */
  async function actions(): Promise<QuickAction[]> {
    return storedActions(await orca.storage.get(ACTIONS_KEY)) ?? []
  }

  async function action(id: string): Promise<QuickAction> {
    const found = (await actions()).find((a) => a.id === id)
    if (!found) {
      throw Object.assign(new Error(`Unknown quick action ${id}`), { code: 'invalid_params' })
    }
    return found
  }

  async function projects(): Promise<Project[]> {
    const [projectsJson, reposJson] = await Promise.all([run('orca', ['project', 'list', '--json']), run('orca', ['repo', 'list', '--json'])])
    return parseProjects(projectsJson, reposJson, [])
  }

  /** A missing lsof or ps is logged, since it would otherwise look like a server with no terminal. */
  function logMissing(error: unknown): void {
    if ((error as { notFound?: boolean }).notFound) {
      orca.log(`finding a server's terminal: ${(error as Error).message}`)
    }
  }

  /** The processes listening on `port`. */
  async function listeners(port: number): Promise<number[]> {
    try {
      return listenerPids(await run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']))
    } catch (error) {
      // Missing or unreadable ownership never establishes that this action is running.
      logMissing(error)
      return []
    }
  }

  /** Whether every listener runs in the folder; one whose folder cannot be read does not. */
  async function inFolder(pids: readonly number[], folder: string): Promise<boolean> {
    try {
      // lsof reports resolved folders, such as /private/tmp for /tmp.
      const path = await realpath(folder).catch(() => folder)
      return listenersInFolder(pids, processFolders(await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')])), path)
    } catch (error) {
      logMissing(error)
      return false
    }
  }

  /** The Orca terminal the listeners on a port were started in, as `terminalServing` in overview.ts finds it. */
  async function servingTerminal(pids: readonly number[], terminalsJson: string, agents: ReadonlySet<string>): Promise<string | null> {
    const processOf = async (pid: number) => {
      try {
        return processTerminal(await run('ps', ['eww', '-o', 'ppid=,tty=,command=', '-p', String(pid)]))
      } catch (error) {
        // ps also fails for a process that just exited.
        logMissing(error)
        return null
      }
    }
    return terminalServing(pids, processOf, terminalsJson, agents)
  }

  /** Read observations separately from the terminal ownership policy in servers.ts. */
  function probe(terminalsJson: string, agents: () => Promise<ReadonlySet<string>>) {
    // One process list per probe, read only when a terminal is asked about.
    let processes: Promise<string> | null = null
    const processList = () =>
      (processes ??= run('ps', ['eww', '-ax', '-o', 'pid=,tty=,stat=,command=']).catch((error) => {
        logMissing(error)
        return ''
      }))
    const running = async (terminal: string) => commandRunning(await processList(), paneOfTerminal(terminalsJson, terminal), terminal)
    return {
      commandRunning: running,
      async observe(a: QuickAction, own: string | null, listening = false): Promise<ServerObservation> {
        const port = portOf(a.url)
        let serving: string | null = null
        let sameFolder = false
        if (port && ((await portOpen(port)) || listening)) {
          const pids = await listeners(port)
          if (pids.length) {
            serving = await servingTerminal(pids, terminalsJson, await agents())
            sameFolder = !own && serving !== null && (await inFolder(pids, a.path))
          }
        }
        return { serving, inFolder: sameFolder, commandRunning: !port && own !== null && (await running(own)) }
      }
    }
  }

  /** Save discovered terminals, including manual starts, and retain closed associations. */
  function watchStates(list: QuickAction[], terminalsJson: string, observed: ServerObservation[]) {
    return write(async () => {
      const known = await handles()
      const own = actionTerminals(await actions(), terminalsJson, known)
      const watched = watchServers(list, own, observed)
      const live = Object.fromEntries(Object.entries(watched.terminals).filter((entry): entry is [string, string] => entry[1] !== null))
      const next = { ...known, ...live }
      if (JSON.stringify(next) !== JSON.stringify(known)) {
        await orca.storage.set(HANDLES_KEY, next)
      }
      return watched
    })
  }

  /**
   * The address each server printed in its terminal since its latest start, or ever when none is
   * known, saved for next time. A typed address stays.
   */
  async function learnUrls(list: QuickAction[], terminals: Record<string, string | null>): Promise<QuickAction[]> {
    const started = await starts()
    const relearn = (a: QuickAction) => !(a.urlTyped && a.url) && (!a.url || a.id in started)
    const learned = new Map<string, string>()
    // Server id -> the cursor read from and where that page ended, when it held no address.
    const paged = new Map<string, [string, string]>()
    await Promise.all(
      list.map(async (a) => {
        const terminal = terminals[a.id]
        if (!terminal || !relearn(a)) {
          return
        }
        const cursor = started[a.id]
        try {
          const read = ['terminal', 'read', '--terminal', terminal, '--limit', OUTPUT_LINES, ...(cursor ? ['--cursor', cursor] : []), '--json']
          const json = await run('orca', read)
          const url = printedUrl(terminalTail(json))
          const next = cursor ? outputCursor(json, 'next') : null
          if (url) {
            learned.set(a.id, url)
          } else if (cursor && next && next !== cursor) {
            paged.set(a.id, [cursor, next])
          }
        } catch {
          // Unread now; the next refresh tries again.
        }
      })
    )
    if (paged.size) {
      // The next refresh reads on from there, unless a start marked the server again meanwhile.
      await write(async () => {
        const current = await starts()
        const moved = [...paged].filter(([id, [from]]) => current[id] === from)
        if (moved.length) {
          await orca.storage.set(STARTS_KEY, { ...current, ...Object.fromEntries(moved.map(([id, [, to]]) => [id, to])) })
        }
      })
    }
    if (!learned.size) {
      return list
    }
    await forgetStarts([...learned.keys()])
    // Checked again, in case the person saved meanwhile.
    return change((current) => current.map((a) => (learned.has(a.id) && relearn(a) ? { ...a, url: relearnedUrl(a.url, learned.get(a.id) as string) } : a)))
  }

  async function load(): Promise<Overview> {
    const [projectsJson, reposJson, psJson, terminalsJson, known] = await Promise.all([
      run('orca', ['project', 'list', '--json']),
      run('orca', ['repo', 'list', '--json']),
      run('orca', ['worktree', 'ps', '--json']),
      run('orca', ['terminal', 'list', '--json']),
      handles()
    ])
    const parsed = parseSessions(psJson, projectsJson)
    // In the order of Orca's sidebar.
    const sessions = orderLikeSidebar(parsed, workspaceRanks(psJson), await tabPositions(parsed.map((s) => s.key.split(':')[0])))
    const projectList = parseProjects(projectsJson, reposJson, sessions)
    let list = await change((current) => linkProjects(current, projectList))
    const terminals = actionTerminals(list, terminalsJson, known)
    list = await learnUrls(list, terminals)
    const agents = agentPanes(psJson)
    const ports = probe(terminalsJson, async () => agents)
    const observed = await Promise.all(list.map((a) => ports.observe(a, terminals[a.id] ?? null)))
    const { states } = await watchStates(list, terminalsJson, observed)
    const servers: Server[] = list.map((a, index) => ({
      id: a.id,
      name: a.name,
      command: a.command,
      projectId: a.projectId,
      url: a.url,
      ...states[index]
    }))
    return { servers, projects: projectList, sessions }
  }

  /** The server's state now, with the terminal the panel started it in, asking lsof even when the port check fails. */
  async function stateNow(a: QuickAction): Promise<ServerState & { own: string | null; commandRunning: boolean }> {
    const [list, terminalsJson, known] = await Promise.all([actions(), run('orca', ['terminal', 'list', '--json']), handles()])
    const own = actionTerminals(list, terminalsJson, known)
    const mine = own[a.id] ?? null
    const agents = async () => agentPanes(await run('orca', ['worktree', 'ps', '--json']))
    const ports = probe(terminalsJson, agents)
    const [observed, running] = await Promise.all([ports.observe(a, mine, true), mine ? ports.commandRunning(mine) : Promise.resolve(false)])
    const watched = await watchStates([a], terminalsJson, [observed])
    const state = watched.states[0]
    return { ...state, own: watched.terminals[a.id] ?? null, commandRunning: running }
  }

  /** Where the terminal's output ends now, so the address the rerun prints is read from there. */
  async function outputEnd(terminal: string): Promise<string | null> {
    try {
      return outputCursor(await run('orca', ['terminal', 'read', '--terminal', terminal, '--limit', '1', '--json']))
    } catch {
      return null
    }
  }

  // One start per server at a time, so a double press opens one terminal.
  const starting = new Map<string, Promise<null>>()

  async function start(a: QuickAction): Promise<null> {
    const { own, commandRunning: running, ...state } = await stateNow(a)
    const step = startStep(state, own, running)
    if (step === 'show') {
      if (state.terminal) {
        await run('orca', ['terminal', 'switch', '--terminal', state.terminal, '--json'])
      }
      return null
    }
    if (step === 'rerun' && own) {
      // Its terminal is open but the server stopped: run the command there again.
      await markStart(a.id, await outputEnd(own))
      await run('orca', ['terminal', 'send', '--terminal', own, '--text', a.command, '--enter', '--json'])
      await run('orca', ['terminal', 'switch', '--terminal', own, '--json'])
      return null
    }
    // A new terminal's whole output is this start's.
    await markStart(a.id, null)
    const out = await run(
      'orca',
      ['terminal', 'create', '--worktree', `path:${a.path}`, '--title', terminalTitle(a), '--command', a.command, '--focus', '--json'],
      30000
    )
    const handle = handleOf(out)
    if (handle) {
      await write(async () => orca.storage.set(HANDLES_KEY, { ...(await handles()), [a.id]: handle }))
    } else {
      orca.log(`no terminal handle in: ${out.slice(0, 300)}`)
    }
    return null
  }

  async function forgetTerminal(id: string): Promise<void> {
    await write(async () => {
      const { [id]: _, ...rest } = await handles()
      await orca.storage.set(HANDLES_KEY, rest)
    })
    await forgetStarts([id])
  }

  orca.panels.handle('overview.load', load)
  orca.panels.handle('session.usage', ({ keys }) => sessionUsage(keys))
  orca.panels.handle('pr.info', ({ urls }) => pullRequestInfo(urls))
  orca.panels.handle('server.start', ({ id }) => {
    const existing = starting.get(id)
    if (existing) {
      return existing
    }
    const pending = action(id)
      .then(start)
      .finally(() => starting.delete(id))
    starting.set(id, pending)
    return pending
  })
  orca.panels.handle('server.stop', async ({ id }) => {
    // The terminal it is watched in: never a terminal of another service on its port.
    const live = (await stateNow(await action(id))).terminal
    if (live) {
      await run('orca', ['terminal', 'close', '--terminal', live, '--json'])
    }
    await forgetStarts([id])
    return null
  })
  orca.panels.handle('action.save', async (input) => {
    const projectList = await projects()
    await change((current) => saveAction(current, input, projectList, newId(input.name)))
    return null
  })
  orca.panels.handle('action.delete', async ({ id }) => {
    await change((current) => current.filter((a) => a.id !== id))
    await forgetTerminal(id)
    return null
  })
  orca.panels.handle('session.compact', async ({ key }) => {
    const terminal = terminalOfPane(await run('orca', ['terminal', 'list', '--json']), key)
    if (terminal) {
      await run('orca', ['terminal', 'send', '--terminal', terminal, '--text', '/compact', '--enter', '--json'])
      return null
    }
    const chat = chatSessionId(key)
    if (!chat) {
      throw Object.assign(new Error('This session has neither a terminal nor a chat to compact.'), { code: 'invalid_params' })
    }
    try {
      await compactChat(chat)
    } catch (error) {
      orca.log(`compact ${chat}: ${(error as Error).message}`)
      throw error
    }
    return null
  })
  orca.panels.handle('session.selected', () => selectedTab())
  /** The id of the folder workspace at `path`, which is also its runtime selector, or null for a Git worktree. */
  const folderOf = async (path: string) => folderAt((await orca.host.call('workspace.list')).workspaces, path)

  /** Shows a workspace in Orca's window. The CLI refuses to show a folder workspace, so a folder goes through `workspace.open`. */
  async function show(path: string, folder: string | null): Promise<void> {
    if (folder) {
      await orca.host.call('workspace.open', { workspaceId: folder })
    } else {
      await run('orca', ['worktree', 'activate', '--worktree', `path:${path}`, '--json'])
    }
  }

  /** Shows the workspace at `path` and answers the selector Orca's runtime knows it by. */
  async function showWorkspace(path: string): Promise<string> {
    const folder = await folderOf(path)
    await show(path, folder)
    return folder ?? `path:${path}`
  }

  orca.panels.handle('session.focus', async ({ key, path }) => {
    // Orca focuses a tab only in the workspace on screen, so show the workspace first.
    const workspace = await showWorkspace(path)
    try {
      await focusTab(workspace, key)
    } catch (error) {
      orca.log(`focus ${key}: ${(error as Error).message}`)
      throw error
    }
    return null
  })
  /**
   * Shows the workspace. One with no tabs starts the agent a new tab would, as a chat or terminal
   * per Orca's settings, in place of the plain terminal Orca opens in an empty workspace.
   */
  async function openWorkspace(path: string): Promise<null> {
    const folder = await folderOf(path)
    const workspace = folder ?? `path:${path}`
    if ((await tabCount(workspace)) === 0) {
      const agent = defaultAgent(await run('orca', ['agent', 'installed', '--json']).catch(() => '{}'))
      if (agent) {
        try {
          // The CLI cannot show a folder, so a folder's agent starts in the background and is shown below.
          await run('orca', ['agent', 'launch', '--agent', agent, '--worktree', workspace, ...(folder ? [] : ['--focus']), '--json'], 30000)
          if (!folder) {
            return null
          }
        } catch (error) {
          // Not repeated, as the launch may have opened its tab: the workspace is shown as before.
          orca.log(`launch ${agent} in ${path}: ${(error as Error).message}`)
        }
      }
    }
    await show(path, folder)
    return null
  }

  // One open per workspace at a time, so a double press starts one agent.
  const opening = new Map<string, Promise<null>>()
  orca.panels.handle('project.open', ({ path }) => {
    const pending = opening.get(path) ?? openWorkspace(path).finally(() => opening.delete(path))
    opening.set(path, pending)
    return pending.catch((error: Error) => {
      orca.log(`open ${path}: ${error.message}`)
      throw error
    })
  })
}
