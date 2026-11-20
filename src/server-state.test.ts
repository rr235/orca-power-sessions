// A quick action's server is watched in one Orca terminal: it runs only while the process on its
// port was started in that terminal. These tests pin that rule for status, Run and Stop, starting
// from Orca's own terminal list.
import { assert, test } from 'orca/testing'
import { actionTerminals, commandRunning, serverState, startStep, terminalTitle } from './servers'
import type { ServerProbe } from './servers'

const KB = { id: 'kb', name: 'Knowledge Base', path: '/c/kb', url: 'http://localhost:3410' }
const KNOWN = { kb: 'term_kb' }

/** `orca terminal list --json` with these terminals. */
const terminalList = (...rows: object[]) => JSON.stringify({ result: { terminals: rows } })
const KB_TERMINAL = { handle: 'term_kb', title: 'bun', worktreePath: '/c/kb', tabId: 'tab1', leafId: 'leaf1', connected: true }

/** A process listening on a port: the Orca terminal it was started in (null: a daemon) and its folder. */
type Listener = { pid: number; terminal: string | null; folder: string }

/**
 * A probe of a machine where `ports` lists who listens where, and `running` the terminals with a
 * command in the foreground. A port in `slow` answers lsof but not the port check; `noLsof` has none.
 */
function machine(ports: Record<number, Listener[]>, running: string[] = [], options: { slow?: number[]; noLsof?: boolean } = {}): ServerProbe {
  const all = Object.values(ports).flat()
  return {
    portOpen: async (port) => Boolean(ports[port]?.length) && !options.slow?.includes(port),
    listeners: async (port) => (options.noLsof ? null : (ports[port] ?? []).map((l) => l.pid)),
    terminalOf: async (pids) => {
      const terminals = new Set(pids.map((pid) => all.find((l) => l.pid === pid)?.terminal ?? null))
      return terminals.size === 1 ? [...terminals][0] : null
    },
    inFolder: async (pids, path) =>
      pids.every((pid) => {
        const folder = all.find((l) => l.pid === pid)?.folder
        return folder !== undefined && (folder === path || folder.startsWith(`${path}/`))
      }),
    commandRunning: async (terminal) => running.includes(terminal)
  }
}

/** The state from a terminal list, as the worker computes it. */
const stateOf = (terminalsJson: string, probe: ServerProbe, action = KB, listening = false) =>
  serverState(action, actionTerminals([action], terminalsJson, KNOWN), probe, listening)

const SERVER_IN_TERMINAL = { 3410: [{ pid: 10, terminal: 'term_kb', folder: '/c/kb' }] }
const OTHER_SERVICE = { 3410: [{ pid: 20, terminal: null, folder: '/c/other' }] }

test('finds the terminal it watches only while Orca lists it open', () => {
  assert.deepEqual(actionTerminals([KB], terminalList(KB_TERMINAL), KNOWN), { kb: 'term_kb' })
  assert.deepEqual(actionTerminals([KB], terminalList(), KNOWN), { kb: null }, 'closed')
  assert.deepEqual(actionTerminals([KB], terminalList({ ...KB_TERMINAL, connected: false }), KNOWN), { kb: null }, 'disconnected')
  assert.deepEqual(actionTerminals([KB], terminalList({ ...KB_TERMINAL, worktreePath: '/c/x' }), KNOWN), { kb: null }, 'in another checkout')
  const reissued = { ...KB_TERMINAL, handle: 'term_new', title: terminalTitle(KB) }
  assert.deepEqual(actionTerminals([KB], terminalList(reissued), KNOWN), { kb: 'term_new' }, 'found again by its title')
})

test('runs while the server answers from the terminal it was started in', async () => {
  const state = await stateOf(terminalList(KB_TERMINAL), machine(SERVER_IN_TERMINAL, ['term_kb']))
  assert.deepEqual(state, { up: true, terminal: 'term_kb' })
  assert.equal(startStep(state, 'term_kb', true), 'show', 'Run shows the terminal, never starts a second server')
})

test('stops running once its terminal is closed, whatever holds the port', async () => {
  // The server's process was left behind, detached, in the project's folder.
  const leftover = { 3410: [{ pid: 10, terminal: null, folder: '/c/kb' }] }
  assert.deepEqual(await stateOf(terminalList(), machine(leftover)), { up: false, terminal: null })
  assert.deepEqual(await stateOf(terminalList({ ...KB_TERMINAL, connected: false }), machine(leftover)), { up: false, terminal: null }, 'disconnected')
  assert.deepEqual(await stateOf(terminalList(), machine(OTHER_SERVICE)), { up: false, terminal: null }, 'another service')
  assert.deepEqual(await stateOf(terminalList(), machine({})), { up: false, terminal: null }, 'nothing listens')
  assert.equal(startStep({ up: false, terminal: null }, null, false), 'create', 'Run opens a new terminal')
})

test('stops running once its server is killed, its terminal still open', async () => {
  const killed = await stateOf(terminalList(KB_TERMINAL), machine({}))
  assert.deepEqual(killed, { up: false, terminal: 'term_kb' }, 'Stop still closes the terminal')
  assert.equal(startStep(killed, 'term_kb', false), 'rerun', 'Run types the command into the same terminal')
})

test('does not run when another process holds its port while its terminal is open', async () => {
  assert.deepEqual(await stateOf(terminalList(KB_TERMINAL), machine(OTHER_SERVICE)), { up: false, terminal: 'term_kb' }, 'a daemon')
  const otherTerminal = { 3410: [{ pid: 30, terminal: 'term_other', folder: '/c/kb' }] }
  assert.deepEqual(await stateOf(terminalList(KB_TERMINAL), machine(otherTerminal)), { up: false, terminal: 'term_kb' }, 'a server in another terminal')
  const shared = { 3410: [{ pid: 10, terminal: 'term_kb', folder: '/c/kb' }, { pid: 20, terminal: null, folder: '/c/other' }] }
  assert.deepEqual(await stateOf(terminalList(KB_TERMINAL), machine(shared, ['term_kb'])), { up: false, terminal: 'term_kb' }, 'not every listener is its')
})

test('Run never types the command into a terminal still running one', async () => {
  // After Run, the server starts on a new port while the stored one belongs to another service.
  const state = await stateOf(terminalList(KB_TERMINAL), machine(OTHER_SERVICE, ['term_kb']))
  assert.equal(state.up, false)
  assert.equal(startStep(state, 'term_kb', true), 'show')
})

test('watches a terminal the person started the server in, from its folder', async () => {
  const byHand = { 3410: [{ pid: 40, terminal: 'term_hand', folder: '/c/kb/apps/web' }] }
  const state = await stateOf(terminalList(), machine(byHand))
  assert.deepEqual(state, { up: true, terminal: 'term_hand' }, 'shown and stopped like its own')
  assert.equal(startStep(state, null, false), 'show')
  const elsewhere = { 3410: [{ pid: 40, terminal: 'term_hand', folder: '/c/other' }] }
  assert.deepEqual(await stateOf(terminalList(), machine(elsewhere)), { up: false, terminal: null }, 'another project on the same port')
  const anothers = { 3410: [{ pid: 40, terminal: 'term_docs', folder: '/c/kb' }] }
  assert.deepEqual(await serverState(KB, { kb: null, docs: 'term_docs' }, machine(anothers)), { up: false, terminal: null }, "another action's terminal")
})

test('Stop targets only the terminal the server is watched in', async () => {
  // `server.stop` closes `terminal` from the state with `listening` set.
  const open = terminalList(KB_TERMINAL)
  assert.equal((await stateOf(open, machine(SERVER_IN_TERMINAL), KB, true)).terminal, 'term_kb')
  assert.equal((await stateOf(open, machine({}), KB, true)).terminal, 'term_kb', 'its terminal, even with the server killed')
  assert.equal((await stateOf(terminalList(), machine(OTHER_SERVICE), KB, true)).terminal, null, 'never another service')
})

test('a slow server is still seen when the port check times out', async () => {
  const slow = machine(SERVER_IN_TERMINAL, ['term_kb'], { slow: [3410] })
  assert.equal((await stateOf(terminalList(KB_TERMINAL), slow)).up, false, 'the panel refresh trusts the port check')
  const state = await stateOf(terminalList(KB_TERMINAL), slow, KB, true)
  assert.deepEqual(state, { up: true, terminal: 'term_kb' }, 'Run and Stop also ask lsof')
  assert.equal(startStep(state, 'term_kb', true), 'show', 'never typed into twice')
})

test('without lsof, it runs while its terminal runs a command on an open port', async () => {
  const noLsof = (running: string[]) => machine(SERVER_IN_TERMINAL, running, { noLsof: true })
  assert.deepEqual(await stateOf(terminalList(KB_TERMINAL), noLsof(['term_kb'])), { up: true, terminal: 'term_kb' })
  assert.equal((await stateOf(terminalList(KB_TERMINAL), noLsof([]))).up, false, 'killed')
  assert.equal((await stateOf(terminalList(), noLsof([]))).up, false, 'closed')
})

test('before its address is known, it runs while a command runs in its terminal', async () => {
  const unknown = { ...KB, url: null }
  assert.deepEqual(await stateOf(terminalList(KB_TERMINAL), machine({}, ['term_kb']), unknown), { up: true, terminal: 'term_kb' })
  assert.deepEqual(await stateOf(terminalList(KB_TERMINAL), machine({}), unknown), { up: false, terminal: 'term_kb' }, 'killed')
  assert.deepEqual(await stateOf(terminalList(), machine({}, ['term_kb']), unknown), { up: false, terminal: null }, 'closed')
  assert.equal(startStep({ up: true, terminal: 'term_kb' }, 'term_kb', true), 'show')
})

test('reads whether a command runs in a terminal from the process list', () => {
  const env = (pane: string) => `TERM=xterm-256color ORCA_TERMINAL_HANDLE=term_kb ORCA_PANE_KEY=${pane} HOME=/u`
  const server = `68562 ttys001  S+   bun run dev ${env('tab1:leaf1')}`
  assert.equal(commandRunning(server, 'tab1:leaf1', 'term_kb'), true)
  assert.equal(commandRunning(`68562 ttys001  S+   bun run dev ORCA_PANE_KEY=tab1:leaf1`, 'tab1:leaf1', 'term_x'), true, 'its pane at the end of the line')
  assert.equal(commandRunning('', 'tab1:leaf1', 'term_kb'), false, 'killed: gone from the list')
  assert.equal(commandRunning(`64961 ttys001  S    /u/.cache/gitstatus/gitstatusd ${env('tab1:leaf1')}`, 'tab1:leaf1', 'term_kb'), false, 'a prompt helper in the background')
  assert.equal(commandRunning(`64434 ttys001  S+   -zsh ${env('tab1:leaf1')}`, 'tab1:leaf1', 'term_kb'), false, 'the shell at its prompt')
  assert.equal(commandRunning(`700 ttys002  S+   bun run dev TERM=x ORCA_TERMINAL_HANDLE=term_other ORCA_PANE_KEY=tab2:leaf2`, 'tab1:leaf1', 'term_kb'), false, 'another terminal')
  assert.equal(commandRunning(`700 ttys002  S+   bun run dev ORCA_PANE_KEY=tab1:leaf10`, 'tab1:leaf1', 'term_x'), false, 'only a whole pane key')
  assert.equal(commandRunning(`700 ??       Ss+  node pm2 ${env('tab1:leaf1')}`, 'tab1:leaf1', 'term_kb'), false, 'a daemon')
})
