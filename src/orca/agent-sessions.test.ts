import { assert, test } from 'orca/testing'
import { matchSessions } from './agent-sessions'

const ps = (agents: { paneKey: string; agentType: string; stateStartedAt: number }[]) =>
  JSON.stringify({ result: { worktrees: [{ path: '/code/app', agents }] } })

test('matches each pane to the host session of its agent that entered its state at the same time', () => {
  const panes = ps([
    { paneKey: 'structured-agent-session-a:l', agentType: 'claude', stateStartedAt: 100 },
    { paneKey: 'tab-2:l', agentType: 'claude', stateStartedAt: 200 },
    { paneKey: 'tab-3:l', agentType: 'codex', stateStartedAt: 300 }
  ])
  const host = new Map([
    [
      '/code/app',
      [
        { agent: 'claude', stateStartedAt: 200, sessionId: 's-2' },
        { agent: 'claude', stateStartedAt: 100, sessionId: 's-1' },
        { agent: 'codex', stateStartedAt: 999, sessionId: 't-1' }
      ]
    ]
  ])
  const found = matchSessions(panes, host)
  assert.equal(found.get('structured-agent-session-a:l')?.sessionId, 's-1')
  assert.equal(found.get('tab-2:l')?.sessionId, 's-2')
  assert.deepEqual(found.get('tab-3:l'), { agent: 'codex', sessionId: 't-1', path: '/code/app', reply: null }, 'the only Codex session, though its time moved on')
})

test('gives no id to a pane it cannot tell apart or one Orca has no id for, and leaves out panes not asked for', () => {
  const panes = ps([
    { paneKey: 'tab-1:l', agentType: 'claude', stateStartedAt: 100 },
    { paneKey: 'tab-2:l', agentType: 'claude', stateStartedAt: 200 }
  ])
  const host = new Map([['/code/app', [{ agent: 'claude', stateStartedAt: 300, sessionId: 's-1' }, { agent: 'claude', stateStartedAt: 200, sessionId: null }]]])
  assert.deepEqual([...matchSessions(panes, host).values()].map((s) => s.sessionId), [null, null])
  const one = new Map([['/code/app', [{ agent: 'claude', stateStartedAt: 100, sessionId: 's-1' }]]])
  assert.deepEqual([...matchSessions(panes, one, new Set(['tab-2:l'])).keys()], ['tab-2:l'])
  const tied = ps([
    { paneKey: 'tab-1:l', agentType: 'claude', stateStartedAt: 100 },
    { paneKey: 'tab-2:l', agentType: 'claude', stateStartedAt: 100 }
  ])
  const sameTime = new Map([['/code/app', [{ agent: 'claude', stateStartedAt: 100, sessionId: 's-1' }, { agent: 'claude', stateStartedAt: 100, sessionId: 's-2' }]]])
  assert.deepEqual([...matchSessions(tied, sameTime).values()].map((s) => s.sessionId), [null, null], 'two host rows share a timestamp')
  assert.deepEqual([...matchSessions(tied, one).values()].map((s) => s.sessionId), [null, null], 'two panes share a timestamp')
})
