// The ownership policy uses observed values directly, without recreating the process probe.
import { assert, test } from 'orca/testing'
import { actionTerminals, commandRunning, foregroundCommands, runState, runStates, startStep, terminalTitle } from './rules'
import type { RunObservation } from './rules'

const KB = { id: 'kb', name: 'Knowledge Base', path: '/c/kb', url: 'http://localhost:3410' }
const KNOWN = { kb: 'term_kb' }
const terminalList = (...rows: object[]) => JSON.stringify({ result: { terminals: rows } })
const KB_TERMINAL = { handle: 'term_kb', title: 'bun', worktreePath: '/c/kb', tabId: 'tab1', leafId: 'leaf1', connected: true }
const STOPPED: RunObservation = { serving: null, inFolder: false, commandRunning: false }
const SERVING: RunObservation = { serving: 'term_kb', inFolder: true, commandRunning: true }

test('finds the watched terminal by handle or title and remembers when it closed', () => {
  assert.deepEqual(actionTerminals([KB], terminalList(KB_TERMINAL), KNOWN), KNOWN)
  assert.deepEqual(actionTerminals([KB], terminalList(), KNOWN), { kb: null })
  assert.deepEqual(actionTerminals([KB], terminalList({ ...KB_TERMINAL, connected: false }), KNOWN), { kb: null })
  assert.deepEqual(actionTerminals([KB], terminalList({ ...KB_TERMINAL, worktreePath: '/c/x' }), KNOWN), { kb: null })
  const reissued = { ...KB_TERMINAL, handle: 'term_new', title: terminalTitle(KB) }
  assert.deepEqual(actionTerminals([KB], terminalList(reissued), KNOWN), { kb: 'term_new' })
  assert.equal(terminalTitle(KB), '⚡ Knowledge Base server (kb)', 'running terminals are found by this title')
  assert.deepEqual(actionTerminals([{ ...KB, id: 'kb2' }], terminalList(reissued), {}), {}, 'duplicate names never share a terminal')
  assert.deepEqual(actionTerminals([KB], terminalList(), {}), {}, 'never watched is distinct from closed')
})

for (const [name, observed, up] of [
  ['its listener runs in the watched terminal', SERVING, true],
  ['the server is killed with its terminal open', STOPPED, false],
  ['another terminal in the project holds the port', { ...SERVING, serving: 'term_other' }, false],
  ['a daemon or ambiguous listeners hold the port', { ...SERVING, serving: null }, false],
  ['ownership is unreadable while another command runs', { ...STOPPED, commandRunning: true }, false]
] as const) {
  test(name, () => {
    assert.deepEqual(runState(KB, KNOWN, observed), { up, terminal: 'term_kb' })
  })
}

test('a closed watched terminal cannot be replaced by another service on the port', () => {
  const closed = actionTerminals([KB], terminalList(), KNOWN)
  const state = runState(KB, closed, { ...SERVING, serving: 'term_other' })
  assert.deepEqual(state, { up: false, terminal: null }, 'Stop has no terminal to close')
  assert.equal(startStep(state, null, false), 'create')
})

test('keeps a manually discovered terminal through server exit and port takeover', () => {
  const first = runStates([KB], {}, [SERVING])
  assert.deepEqual(first.states, [{ up: true, terminal: 'term_kb' }])
  const killed = runStates([KB], first.terminals, [STOPPED])
  assert.deepEqual(killed.states, [{ up: false, terminal: 'term_kb' }], 'Stop retains its target')
  assert.equal(startStep(killed.states[0], killed.terminals.kb, false), 'rerun')
  const takeover = runStates([KB], killed.terminals, [{ ...SERVING, serving: 'term_other' }])
  assert.deepEqual(takeover.states, killed.states, 'another listener cannot replace its terminal')
})

test('adopts only unclaimed project terminals and reserves each one for one action', () => {
  assert.deepEqual(runState(KB, {}, { ...SERVING, inFolder: false }), { up: false, terminal: null })
  assert.deepEqual(runState(KB, { docs: 'term_kb' }, SERVING), { up: false, terminal: null })
  const watched = runStates([KB, { ...KB, id: 'docs' }], {}, [SERVING, SERVING])
  assert.deepEqual(watched.states, [{ up: true, terminal: 'term_kb' }, { up: false, terminal: null }])
  assert.deepEqual(watched.terminals, KNOWN)
})

test('Run shows a busy terminal and reruns only at its prompt', () => {
  assert.equal(startStep({ up: true, terminal: 'term_kb' }, 'term_kb', false), 'show')
  assert.equal(startStep({ up: false, terminal: 'term_kb' }, 'term_kb', true), 'show')
  assert.equal(startStep({ up: false, terminal: 'term_kb' }, 'term_kb', false), 'rerun')
})

test('before a URL is known, only a foreground command in its live terminal runs', () => {
  const unknown = { ...KB, url: null }
  assert.deepEqual(runState(unknown, KNOWN, SERVING), { up: true, terminal: 'term_kb' })
  assert.deepEqual(runState(unknown, KNOWN, STOPPED), { up: false, terminal: 'term_kb' })
  assert.deepEqual(runState(unknown, { kb: null }, SERVING), { up: false, terminal: null })
})

test('reads foreground commands from the process list, excluding shells and prompt helpers', () => {
  const list = ['68562 ttys001 S+ bun', '64961 ttys001 S /u/.cache/gitstatus/gitstatusd', '64434 ttys001 S+ -zsh', '700 ?? Ss+ node'].join('\n')
  assert.deepEqual(foregroundCommands(list), [68562], 'not a background helper, a shell or a daemon')
  const variables = new Map([[68562, { paneKey: 'tab1:leaf1', handle: 'term_kb' }]])
  assert.equal(commandRunning(variables, 'tab1:leaf1', 'term_x'), true, 'by pane')
  assert.equal(commandRunning(variables, null, 'term_kb'), true, 'by handle')
  assert.equal(commandRunning(variables, 'tab1:leaf10', 'term_other'), false)
  assert.equal(commandRunning(new Map(), 'tab1:leaf1', 'term_kb'), false)
})
