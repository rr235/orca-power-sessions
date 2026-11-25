import { Box, read } from 'orca'
import { assert, mount, test } from 'orca/testing'
import { DEMO } from '../fixtures'
import { ActionCard, ActionForm } from './actions'
import { draft, editing } from './state'

test('an icon opens its edit form, preserves a long grapheme, and is disabled while running', async () => {
  const action = { ...DEMO.servers.find((a) => a.id === 'blog')!, icon: '👍🏽' }
  const running = { ...action, id: 'running', name: 'Running', icon: '🌐', up: true, terminal: 'term_running' }
  const view = await mount(() => (
    <Box>
      <ActionCard action={action} />
      <ActionCard action={running} />
      {read(editing) === action.id ? <ActionForm id={action.id} actions={[action]} projects={DEMO.projects} /> : null}
    </Box>
  ))
  try {
    const icon = view.find({ type: 'Button', text: action.icon })
    assert.equal(icon?.props.tooltip, `Edit ${action.name}`)
    assert.ok(icon && icon.path < (view.find({ label: `Run ${action.name}` })?.path ?? ''), 'the icon starts the row')
    await view.press(icon!)
    assert.equal(view.find({ label: 'Icon' })?.props.value, action.icon)
    assert.ok(view.find({ label: `Close ${action.name}` }))
    // One grapheme can exceed a native input's UTF-16 length limit.
    const longCharacter = 'क्'.repeat(8) + 'क'
    assert.equal(view.find({ label: 'Icon' })?.props.maxLength, undefined, 'native length caps can split a single grapheme')
    await view.type({ label: 'Icon' }, longCharacter, { replace: true })
    assert.equal(read(draft).icon, longCharacter)
    await view.press({ label: `Close ${action.name}` })
    assert.equal(view.find({ label: 'Icon' }), null)
    const disabled = view.find({ type: 'Button', text: running.icon })
    assert.deepEqual([disabled?.disabled, disabled?.props.tooltip], [true, 'Stop to edit'])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})
