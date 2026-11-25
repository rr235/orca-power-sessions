import { assert, mockHost, mount, test, type TreeSnapshot } from 'orca/testing'
import { mock } from 'node:test'
import { DEMO } from '../fixtures'
import type { ActionStatus } from '../protocol'
import * as panel from '../panel'

test('quick actions show startup, completion and failure, and stop polling when idle or unmounted', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let up = false
  let fail = false
  let loads = 0
  const action: ActionStatus = { id: 'sync', name: 'Sync', steps: ['bun build'], projectId: null, url: null, terminal: 'term_sync', up: false }
  const host = mockHost({ requests: {
    'overview.load': () => { loads++; return { ...DEMO, sessions: [], servers: [DEMO.servers[0], { ...action, up }] } },
    'session.selected': () => null,
    'server.start': () => { if (fail) throw new Error('no terminal'); return null },
    'server.stop': () => { up = false; return null }
  } })
  const view = await mount(panel, { host })
  const tick = async (ms: number) => { mock.timers.tick(ms); await view.settled() }
  // Compare every direct slot, including the space available to the name.
  const rowLayout = (node: TreeSnapshot | string | null = view.tree()): unknown => {
    if (!node || typeof node === 'string') return null
    if (node.key === 'sync') return node.children?.map((child) => child && typeof child !== 'string' ? child.props : null)
    return node.children?.map((child) => rowLayout(child)).find(Boolean) ?? null
  }
  try {
    const stoppedLayout = rowLayout()
    assert.ok(stoppedLayout, 'the action row is present')
    await view.press({ label: 'Run Sync' })
    assert.deepEqual([view.find({ label: 'Stop Sync' })?.disabled, view.find({ label: 'Stop Sync' })?.props.tooltip], [true, 'Starting'])
    assert.deepEqual(rowLayout(), stoppedLayout, 'starting keeps every control slot')
    up = true
    await tick(1000)
    assert.equal(view.find({ label: 'Stop Sync' })?.disabled, false)
    assert.equal(view.find({ label: 'Edit Sync' })?.disabled, true)
    assert.deepEqual(rowLayout(), stoppedLayout, 'running keeps the name and control space')
    up = false
    await tick(1000)
    assert.ok(view.find({ label: 'Run Sync' }))
    assert.equal(view.find({ label: 'Edit Sync' })?.disabled, false)
    assert.deepEqual(rowLayout(), stoppedLayout, 'completion keeps the same slots')
    const idle = loads
    await tick(2000)
    assert.equal(loads, idle, 'address-based actions keep the normal cycle')
    fail = true
    await view.press({ label: 'Run Sync' })
    assert.ok(view.find({ label: 'Run Sync' }))
    fail = false
    up = true
    action.url = 'http://localhost:4000'
    await view.press({ label: 'Run Sync' })
    assert.deepEqual(rowLayout(), stoppedLayout, 'a URL keeps the same slots')
    assert.deepEqual(view.findAll({ type: 'IconButton' }).filter(({ props }) => String(props.label).includes('Sync')).map(({ props }) => props.label),
      ['Edit Sync', 'Show Sync terminal', 'Open Sync', 'Stop Sync'])
    await view.press({ label: 'Stop Sync' })
    assert.deepEqual(rowLayout(), stoppedLayout, 'Stop keeps the same slots')
    assert.ok(view.find({ label: 'Run Sync' }))
  } finally {
    await view.unmount()
    const closed = loads
    mock.timers.tick(11000)
    mock.timers.reset()
    assert.equal(loads, closed, 'queued boot checks stop at teardown')
  }
})
