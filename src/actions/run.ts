// Runs the quick actions: their run states for the overview, start, stop, save and delete.
import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import { agentPanes } from '../orca/agents'
import { closeTerminal, createTerminal, listTerminals, listWorkspaces, readTerminal, sendToTerminal, switchTerminal } from '../orca/commands'
import { outputCursor, terminalTail } from '../orca/terminals'
import type { ActionStatus, Project, QuickAction, QuickActionInput } from '../protocol'
import { runCommand } from '../shared'
import { probe } from './ports'
import { actionTerminals, linkProjects, printedUrl, relearnedUrl, runStates, saveAction, startStep, terminalTitle } from './rules'
import type { RunObservation, RunState } from './rules'
import { actionStore } from './store'
import type { Handles } from './store'

// How much of a quick action's terminal output is searched for the address it printed.
const OUTPUT_LINES = '400'

/** A new action's id: its name in lowercase letters and digits, and a short random part. */
const newId = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'action'}-${randomUUID().slice(0, 8)}`

/** What the overview reads for the quick actions, alongside the sessions' reads. */
export type ActionsOutput = { terminalsJson: string; known: Handles }

export function quickActions(orca: OrcaWorkerApi) {
  const store = actionStore(orca.storage)
  const log = (message: string) => orca.log(message)

  /** Save discovered terminals, including manual starts, and retain closed associations. */
  function watchStates(list: QuickAction[], terminalsJson: string, observed: RunObservation[]) {
    return store.saveWatched((known, stored) => runStates(list, actionTerminals(stored, terminalsJson, known), observed))
  }

  /**
   * The address each server printed in its terminal since its latest start, or ever when none is
   * known, saved for next time. A typed address stays.
   */
  async function learnUrls(list: QuickAction[], terminals: Record<string, string | null>): Promise<QuickAction[]> {
    const started = await store.starts()
    const relearn = (a: QuickAction) => !(a.urlTyped && a.url) && (!a.url || a.id in started)
    const learned = new Map<string, string>()
    // Quick action id -> the cursor read from and where that page ended, when it held no address.
    const paged = new Map<string, [string, string]>()
    await Promise.all(
      list.map(async (a) => {
        const terminal = terminals[a.id]
        if (!terminal || !relearn(a)) {
          return
        }
        const cursor = started[a.id]
        try {
          const json = await readTerminal(terminal, OUTPUT_LINES, cursor)
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
      // The next refresh reads on from there, unless a start marked the action again meanwhile.
      await store.moveStarts(paged)
    }
    if (!learned.size) {
      return list
    }
    await store.forgetStarts([...learned.keys()])
    // Checked again, in case the person saved meanwhile.
    return store.change((current) => current.map((a) => (learned.has(a.id) && relearn(a) ? { ...a, url: relearnedUrl(a.url, learned.get(a.id) as string) } : a)))
  }

  /** Read with the sessions' reads, so the overview's CLI calls run together. */
  async function read(): Promise<ActionsOutput> {
    const [terminalsJson, known] = await Promise.all([listTerminals(), store.handles()])
    return { terminalsJson, known }
  }

  /** Each quick action with its run state, linked to the projects. */
  async function statuses({ terminalsJson, known }: ActionsOutput, projects: Project[], workspacesJson: string): Promise<ActionStatus[]> {
    let list = await store.change((current) => linkProjects(current, projects))
    const terminals = actionTerminals(list, terminalsJson, known)
    list = await learnUrls(list, terminals)
    const agents = agentPanes(workspacesJson)
    const ports = probe(terminalsJson, async () => agents, log)
    const observed = await Promise.all(list.map((a) => ports.observe(a, terminals[a.id] ?? null)))
    const { states } = await watchStates(list, terminalsJson, observed)
    return list.map((a, index) => ({
      id: a.id,
      name: a.name,
      steps: a.steps,
      projectId: a.projectId,
      url: a.url,
      ...states[index]
    }))
  }

  /** The quick action's run state now, with the terminal the panel started it in, asking lsof even when the port check fails. */
  async function stateNow(a: QuickAction): Promise<RunState & { own: string | null; commandRunning: boolean }> {
    const [list, terminalsJson, known] = await Promise.all([store.actions(), listTerminals(), store.handles()])
    const own = actionTerminals(list, terminalsJson, known)
    const mine = own[a.id] ?? null
    const agents = async () => agentPanes(await listWorkspaces())
    const ports = probe(terminalsJson, agents, log)
    const [observed, running] = await Promise.all([ports.observe(a, mine, true), mine ? ports.commandRunning(mine) : Promise.resolve(false)])
    const watched = await watchStates([a], terminalsJson, [observed])
    const state = watched.states[0]
    return { ...state, own: watched.terminals[a.id] ?? null, commandRunning: running }
  }

  /** Where the terminal's output ends now, so the address the rerun prints is read from there. */
  async function outputEnd(terminal: string): Promise<string | null> {
    try {
      return outputCursor(await readTerminal(terminal, '1'))
    } catch {
      return null
    }
  }

  async function startAction(a: QuickAction): Promise<null> {
    const { own, commandRunning: running, ...state } = await stateNow(a)
    const step = startStep(state, own, running)
    if (step === 'show') {
      if (state.terminal) {
        await switchTerminal(state.terminal)
      }
      return null
    }
    if (step === 'rerun' && own) {
      // Its terminal is open but the server stopped: run the command there again.
      await store.markStart(a.id, await outputEnd(own))
      await sendToTerminal(own, runCommand(a.steps))
      await switchTerminal(own)
      return null
    }
    // A new terminal's whole output is this start's.
    await store.markStart(a.id, null)
    const { handle, output } = await createTerminal(a.path, terminalTitle(a), runCommand(a.steps))
    if (handle) {
      await store.setHandle(a.id, handle)
    } else {
      orca.log(`no terminal handle in: ${output.slice(0, 300)}`)
    }
    return null
  }

  // One start per quick action at a time, so a double press opens one terminal.
  const starting = new Map<string, Promise<null>>()
  function start(id: string): Promise<null> {
    const existing = starting.get(id)
    if (existing) {
      return existing
    }
    const pending = store
      .action(id)
      .then(startAction)
      .finally(() => starting.delete(id))
    starting.set(id, pending)
    return pending
  }

  async function stop(id: string): Promise<null> {
    // The terminal it is watched in: never a terminal of another service on its port.
    const live = (await stateNow(await store.action(id))).terminal
    if (live) {
      await closeTerminal(live)
    }
    await store.forgetStarts([id])
    return null
  }

  async function save(input: QuickActionInput, projects: readonly Project[]): Promise<null> {
    await store.change((current) => saveAction(current, input, projects, newId(input.name)))
    return null
  }

  async function remove(id: string): Promise<null> {
    await store.change((current) => current.filter((a) => a.id !== id))
    await store.forgetTerminal(id)
    return null
  }

  return { read, statuses, start, stop, save, delete: remove }
}
