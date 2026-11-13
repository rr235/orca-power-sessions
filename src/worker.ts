// Serves the Power Sessions panel. Orca transpiles this file when it loads: no build step. Plugins
// have no host method for projects, all workspaces or terminal creation, so the worker asks the
// `orca` CLI, which runs as the same user.
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import type { OrcaWorkerApi } from 'orca/worker'
import { run } from './cli'
import { chatSessionId, orderLikeSidebar, parseProjects, parseSessions, terminalAlive, terminalByTitle, terminalOfPane, workspaceRanks } from './overview'
import type { Overview, Project, QuickAction, Server } from './protocol'
import { linkProjects, portOf, printedUrl, saveAction, storedActions, terminalTail, terminalTitle } from './servers'
import { pullRequestInfo } from './pulls'
import { sessionUsage, tabPositions } from './usage'
import { compactChat } from './chats'
import { focusTab, selectedTab } from './tabs'

// The quick actions, as the person last saved them.
const ACTIONS_KEY = 'quickActions'
// Server id -> the terminal handle it was started in, kept across worker restarts.
const HANDLES_KEY = 'serverTerminals'
type Handles = Record<string, string>

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
  async function handles(): Promise<Handles> {
    const stored = await orca.storage.get(HANDLES_KEY)
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Handles) : {}
  }

  // Changes to the stored list run one at a time, so a save and a learned address never overwrite each other.
  let writes: Promise<unknown> = Promise.resolve()
  function change(edit: (actions: QuickAction[]) => QuickAction[]): Promise<QuickAction[]> {
    const next = writes.then(async () => {
      const current = await actions()
      const edited = edit(current)
      if (JSON.stringify(edited) !== JSON.stringify(current)) {
        await orca.storage.set(ACTIONS_KEY, edited)
      }
      return edited
    })
    writes = next.catch(() => undefined)
    return next
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

  /** Each action's live terminal: the one it was started in, else one with its title. */
  function liveTerminals(list: readonly QuickAction[], terminalsJson: string, known: Handles): Record<string, string | null> {
    return Object.fromEntries(
      list.map((a) => {
        const handle = known[a.id]
        const live = handle && terminalAlive(terminalsJson, handle, a.path) ? handle : terminalByTitle(terminalsJson, terminalTitle(a), a.path)
        return [a.id, live]
      })
    )
  }

  /** The address each server without one printed in its terminal, saved for next time. */
  async function learnUrls(list: QuickAction[], terminals: Record<string, string | null>): Promise<QuickAction[]> {
    const learned = new Map<string, string>()
    await Promise.all(
      list.map(async (a) => {
        const terminal = terminals[a.id]
        if (a.url || !terminal) {
          return
        }
        try {
          const url = printedUrl(terminalTail(await run('orca', ['terminal', 'read', '--terminal', terminal, '--limit', OUTPUT_LINES, '--json'])))
          if (url) {
            learned.set(a.id, url)
          }
        } catch {
          // Unread now; the next refresh tries again.
        }
      })
    )
    if (!learned.size) {
      return list
    }
    // Only an address still unknown is filled in, in case the person saved meanwhile.
    return change((current) => current.map((a) => (!a.url && learned.has(a.id) ? { ...a, url: learned.get(a.id) ?? null } : a)))
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
    const projectList = parseProjects(projectsJson, reposJson, sessions, psJson)
    let list = await change((current) => linkProjects(current, projectList))
    const terminals = liveTerminals(list, terminalsJson, known)
    list = await learnUrls(list, terminals)
    const up = await Promise.all(
      list.map((a) => {
        const port = portOf(a.url)
        // Before its address is known, a server counts as running while its terminal is open.
        return port ? portOpen(port) : Promise.resolve(Boolean(terminals[a.id]))
      })
    )
    const servers: Server[] = list.map((a, index) => ({
      id: a.id,
      name: a.name,
      command: a.command,
      projectId: a.projectId,
      url: a.url,
      up: up[index],
      terminal: terminals[a.id] ?? null
    }))
    return { servers, projects: projectList, sessions }
  }

  async function liveTerminal(a: QuickAction): Promise<string | null> {
    const terminalsJson = await run('orca', ['terminal', 'list', '--json'])
    return liveTerminals([a], terminalsJson, await handles())[a.id] ?? null
  }

  // One start per server at a time, so a double press opens one terminal.
  const starting = new Map<string, Promise<null>>()

  async function start(a: QuickAction): Promise<null> {
    const port = portOf(a.url)
    const [live, up] = await Promise.all([liveTerminal(a), port ? portOpen(port) : Promise.resolve(false)])
    if (live && (up || !port)) {
      // Already serving, or its address is not known yet so it may be: show its terminal.
      await run('orca', ['terminal', 'switch', '--terminal', live, '--json'])
      return null
    }
    if (up) {
      // Serving from elsewhere (such as pm2): a second one would fail.
      return null
    }
    if (live) {
      // Its terminal is open but the server stopped: run the command there again.
      await run('orca', ['terminal', 'send', '--terminal', live, '--text', a.command, '--enter', '--json'])
      await run('orca', ['terminal', 'switch', '--terminal', live, '--json'])
      return null
    }
    const out = await run(
      'orca',
      ['terminal', 'create', '--worktree', `path:${a.path}`, '--title', terminalTitle(a), '--command', a.command, '--focus', '--json'],
      30000
    )
    const handle = handleOf(out)
    if (handle) {
      await orca.storage.set(HANDLES_KEY, { ...(await handles()), [a.id]: handle })
    } else {
      orca.log(`no terminal handle in: ${out.slice(0, 300)}`)
    }
    return null
  }

  async function forgetTerminal(id: string): Promise<void> {
    const { [id]: _, ...rest } = await handles()
    await orca.storage.set(HANDLES_KEY, rest)
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
    const live = await liveTerminal(await action(id))
    if (live) {
      await run('orca', ['terminal', 'close', '--terminal', live, '--json'])
    }
    await forgetTerminal(id)
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
  orca.panels.handle('session.selected', () => selectedTab(orca))
  orca.panels.handle('session.focus', async ({ key, path }) => {
    // Orca focuses a tab only in the workspace on screen, so show the workspace first.
    await run('orca', ['worktree', 'activate', '--worktree', `path:${path}`, '--json'])
    try {
      await focusTab(path, key)
    } catch (error) {
      orca.log(`focus ${key}: ${(error as Error).message}`)
      throw error
    }
    return null
  })
  orca.panels.handle('project.open', async ({ path }) => {
    await run('orca', ['worktree', 'activate', '--worktree', `path:${path}`, '--json'])
    return null
  })
}
