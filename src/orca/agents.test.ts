import { assert, test } from 'orca/testing'
import { hasOpenTabs } from './agents'

const ps = (worktrees: unknown[]) => JSON.stringify({ result: { worktrees } })

test('calls a workspace empty only when it is awake with no terminal or agent', () => {
  const rows = ps([
    { path: '/empty', status: 'active', liveTerminalCount: 0, agents: [] },
    { path: '/shell', status: 'active', liveTerminalCount: 1, agents: [] },
    { path: '/chat', status: 'active', liveTerminalCount: 0, agents: [{ paneKey: 'structured-agent-session-a:l' }] },
    { path: '/asleep', status: 'inactive', liveTerminalCount: 0, agents: [] }
  ])
  assert.deepEqual(['/empty', '/shell', '/chat', '/asleep', '/missing'].map((path) => hasOpenTabs(rows, path)), [false, true, true, null, null])
})
