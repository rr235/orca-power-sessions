// What a quick action's port and terminal show now: whether its port answers, which processes
// listen on it and the Orca terminal they were started in (lsof and ps), and whether a command runs
// in its terminal. The ownership policy that reads these is in rules.ts.
import { realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { run } from '../cli'
import { paneOfTerminal, terminalServing } from '../orca/terminals'
import type { QuickAction } from '../protocol'
import { commandRunning, foregroundCommands, listenerPids, listenersInFolder, orcaVariables, portOf, processFolders, processParent } from './rules'
import type { OrcaVariables, RunObservation } from './rules'

const PORT_TIMEOUT_MS = 400

type Log = (message: string) => void

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

/** A missing lsof or ps is logged, since it would otherwise look like a server with no terminal. */
function logMissing(log: Log, error: unknown): void {
  if ((error as { notFound?: boolean }).notFound) {
    log(`finding a quick action's terminal: ${(error as Error).message}`)
  }
}

/** The processes listening on `port`. */
async function listeners(log: Log, port: number): Promise<number[]> {
  try {
    return listenerPids(await run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']))
  } catch (error) {
    // Missing or unreadable ownership never establishes that this action is running.
    logMissing(log, error)
    return []
  }
}

/** Whether every listener runs in the folder; one whose folder cannot be read does not. */
async function inFolder(log: Log, pids: readonly number[], folder: string): Promise<boolean> {
  try {
    // lsof reports resolved folders, such as /private/tmp for /tmp.
    const path = await realpath(folder).catch(() => folder)
    return listenersInFolder(pids, processFolders(await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')])), path)
  } catch (error) {
    logMissing(log, error)
    return false
  }
}

/**
 * The Orca variables of these processes only, by pid. ps cannot pick variables, so it hands over each
 * one's environment and `orcaVariables` keeps the two Orca sets; nothing else is kept or logged.
 */
async function variablesOf(log: Log, pids: readonly number[]): Promise<Map<number, OrcaVariables>> {
  if (!pids.length) {
    return new Map()
  }
  try {
    return orcaVariables(await run('ps', ['eww', '-o', 'pid=,command=', '-p', pids.join(',')]))
  } catch (error) {
    // ps also fails when every process just exited.
    logMissing(log, error)
    return new Map()
  }
}

/** The Orca terminal the listeners on a port were started in, as `terminalServing` in orca/terminals.ts finds it. */
async function servingTerminal(log: Log, pids: readonly number[], terminalsJson: string, agents: ReadonlySet<string>): Promise<string | null> {
  const processOf = async (pid: number) => {
    let parent
    try {
      parent = processParent(await run('ps', ['-o', 'ppid=,tty=', '-p', String(pid)]))
    } catch (error) {
      logMissing(log, error)
      return null
    }
    // A process without a terminal was not started in one: its environment is never read.
    const variables = parent.detached ? undefined : (await variablesOf(log, [pid])).get(pid)
    return { ...parent, paneKey: variables?.paneKey ?? null, handle: variables?.handle ?? null }
  }
  return terminalServing(pids, processOf, terminalsJson, agents)
}

/** Read observations separately from the terminal ownership policy in rules.ts. */
export function probe(terminalsJson: string, agents: () => Promise<ReadonlySet<string>>, log: Log) {
  // One read per probe, made only when a terminal is asked about: the foreground commands by name,
  // then the Orca variables of those processes alone.
  let foreground: Promise<Map<number, OrcaVariables>> | null = null
  const foregroundVariables = () =>
    (foreground ??= run('ps', ['-ax', '-o', 'pid=,tty=,stat=,comm='])
      .catch((error) => {
        logMissing(log, error)
        return ''
      })
      .then((list) => variablesOf(log, foregroundCommands(list))))
  const running = async (terminal: string) => commandRunning(await foregroundVariables(), paneOfTerminal(terminalsJson, terminal), terminal)
  return {
    commandRunning: running,
    async observe(a: QuickAction, own: string | null, listening = false): Promise<RunObservation> {
      const port = portOf(a.url)
      let serving: string | null = null
      let sameFolder = false
      if (port && ((await portOpen(port)) || listening)) {
        const pids = await listeners(log, port)
        if (pids.length) {
          serving = await servingTerminal(log, pids, terminalsJson, await agents())
          sameFolder = !own && serving !== null && (await inFolder(log, pids, a.path))
        }
      }
      return { serving, inFolder: sameFolder, commandRunning: !port && own !== null && (await running(own)) }
    }
  }
}
