import { assert, test } from 'orca/testing'
import { agentPanes } from './agents'
import { handleOf, outputCursor, terminalAlive, terminalByTitle, terminalOfPane, terminalOfProcess, terminalServing, terminalTail } from './terminals'

test('finds a terminal session\'s terminal by its pane; a chat session has none', () => {
  const terminals = JSON.stringify({
    result: {
      terminals: [
        { handle: 'term_a', tabId: 'tab1', leafId: 'leaf1', connected: true },
        { handle: 'term_b', tabId: 'tab2', leafId: 'leaf2', connected: false }
      ]
    }
  })
  assert.equal(terminalOfPane(terminals, 'tab1:leaf1'), 'term_a')
  assert.equal(terminalOfPane(terminals, 'tab2:leaf2'), null, 'a disconnected terminal')
  assert.equal(terminalOfPane(terminals, 'chat:leaf'), null)
})

test('finds a live terminal by title or handle in its checkout', () => {
  const terminals = JSON.stringify({
    result: { terminals: [{ handle: 'term_1', title: 'Dev (a)', worktreePath: '/c/a', connected: true }, { handle: 'term_2', title: 'x', worktreePath: '/c/a', connected: false }] }
  })
  assert.equal(terminalByTitle(terminals, 'Dev (a)', '/c/a'), 'term_1')
  assert.equal(terminalByTitle(terminals, 'Dev (b)', '/c/a'), null, 'duplicate names never share a terminal')
  assert.equal(terminalByTitle(terminals, 'Dev (a)', '/c/b'), null, 'moving a project rejects the old terminal title')
  assert.equal(terminalAlive(terminals, 'term_1', '/c/a'), true)
  assert.equal(terminalAlive(terminals, 'term_1', '/c/b'), false, 'moving a project rejects its saved handle')
  assert.equal(terminalAlive(terminals, 'term_2', '/c/a'), false)
  assert.equal(handleOf('{"result":{"terminal":{"handle":"term_abc-1"}}}'), 'term_abc-1')
})

test('reads a terminal\'s output and where it ends', () => {
  assert.equal(outputCursor('{"result":{"terminal":{"nextCursor":"260","latestCursor":"267"}}}'), '267')
  assert.equal(outputCursor('{"result":{"terminal":{"nextCursor":42}}}'), '42', 'a host without latestCursor')
  assert.equal(outputCursor('{"result":{"terminal":{"nextCursor":null}}}'), null)
  assert.equal(outputCursor('not json'), null)
  assert.equal(outputCursor('{"result":{"terminal":{"nextCursor":"263","latestCursor":"267"}}}', 'next'), '263', 'where a page read on from a cursor ends')
  assert.deepEqual(terminalTail('{"result":{"terminal":{"tail":["a","b"]}}}'), ['a', 'b'])
  assert.deepEqual(terminalTail('not json'), [])
})

test('finds the panes agents run in', () => {
  const ps = JSON.stringify({ result: { worktrees: [{ worktreeId: 'w1', agents: [{ paneKey: 'tab3:leaf3' }, {}] }, { worktreeId: 'w2' }] } })
  assert.deepEqual([...agentPanes(ps)], ['tab3:leaf3'])
})

const SERVING = JSON.stringify({
  result: {
    terminals: [
      { handle: 'term_new', tabId: 'tab1', leafId: 'leaf1', connected: true },
      { handle: 'term_b', tabId: 'tab2', leafId: 'leaf2', connected: false },
      { handle: 'term_agent', tabId: 'tab3', leafId: 'leaf3', connected: true },
      { handle: 'term_other', tabId: 'tab4', leafId: 'leaf4', connected: true }
    ]
  }
})
const AGENTS = new Set(['tab3:leaf3'])

test('finds the terminal by pane, else handle, never an agent\'s', () => {
  assert.equal(terminalOfProcess(SERVING, 'tab1:leaf1', 'term_old', AGENTS), 'term_new', 'the pane outlives a reissued handle')
  assert.equal(terminalOfProcess(SERVING, null, 'term_new', AGENTS), 'term_new')
  assert.equal(terminalOfProcess(SERVING, 'tab2:leaf2', 'term_b', AGENTS), null, 'a disconnected terminal')
  assert.equal(terminalOfProcess(SERVING, 'tab3:leaf3', null, AGENTS), null, 'an agent by pane')
  assert.equal(terminalOfProcess(SERVING, null, 'term_agent', AGENTS), null, 'an agent by handle')
  assert.equal(terminalOfProcess(SERVING, null, null, AGENTS), null)
})

test('walks up from a listening process to the terminal serving the port', async () => {
  type Info = { ppid: number | null; detached: boolean; paneKey: string | null; handle: string | null }
  const tree = (processes: Record<number, Info>) => async (pid: number) => processes[pid] ?? null
  const plain = (ppid: number | null): Info => ({ ppid, detached: false, paneKey: null, handle: null })
  const inPane = (ppid: number | null, paneKey: string): Info => ({ ppid, detached: false, paneKey, handle: null })
  // node (clean environment) -> bun -> the shell of tab1:leaf1.
  assert.equal(await terminalServing([30], tree({ 30: plain(20), 20: inPane(10, 'tab1:leaf1'), 10: inPane(1, 'tab1:leaf1') }), SERVING, AGENTS), 'term_new')
  assert.equal(await terminalServing([30], tree({ 30: { ...plain(20), detached: true }, 20: inPane(1, 'tab1:leaf1') }), SERVING, AGENTS), null, 'a daemon is not stopped by closing a terminal')
  assert.equal(await terminalServing([30], tree({ 30: inPane(20, 'tab3:leaf3') }), SERVING, AGENTS), null, 'a server an agent started')
  assert.equal(
    await terminalServing([30], tree({ 30: inPane(20, 'tab-gone:leaf'), 20: inPane(1, 'tab1:leaf1') }), SERVING, AGENTS),
    null,
    'the nearest Orca environment decides, never an outer terminal'
  )
  assert.equal(await terminalServing([30], tree({ 30: plain(20) }), SERVING, AGENTS), null, 'a process that exited mid-walk')
  assert.equal(await terminalServing([], tree({}), SERVING, AGENTS), null, 'nothing listens')
  assert.equal(await terminalServing([40, 30], tree({ 30: inPane(1, 'tab1:leaf1') }), SERVING, AGENTS), null, 'an unidentified listener makes the port ambiguous')
  assert.equal(await terminalServing([30, 40], tree({ 30: inPane(1, 'tab1:leaf1'), 40: inPane(1, 'tab4:leaf4') }), SERVING, AGENTS), null, 'different terminals can listen on the same port over IPv4 and IPv6')
  assert.equal(await terminalServing([30, 40], tree({ 30: inPane(1, 'tab1:leaf1'), 40: inPane(1, 'tab1:leaf1') }), SERVING, AGENTS), 'term_new', 'multiple listening processes in one terminal are unambiguous')
})
