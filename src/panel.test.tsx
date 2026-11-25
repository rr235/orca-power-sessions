// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test, type TreeSnapshot } from 'orca/testing'
import { storage } from 'orca'
import { mock } from 'node:test'
import { DEMO, DEMO_USAGE, DEMO_WORKTREES } from './fixtures'
import type { SessionUsage } from './protocol'
import * as panel from './panel'
import { byWorktree } from './panel/sessions'
import { saveAction, storedActions } from './actions/rules'

/** The pressable row holding the image named `alt`: an image's alt is not a label. */
function pinControl(view: Awaited<ReturnType<typeof mount>>, alt: string) {
  const image = view.findAll({ type: 'Image' }).find((i) => i.props.alt === alt)
  if (!image) {
    return null
  }
  const rows = view.findAll({ type: 'ListItem' }).filter((row) => image.path.startsWith(row.path))
  return rows.sort((a, b) => b.path.length - a.path.length)[0] ?? null
}

/** The chevron that shows or hides a session's details. */
function chevron(view: Awaited<ReturnType<typeof mount>>, title: string) {
  const alt = view.findAll({ type: 'Image' }).find((i) => new RegExp(`^(Show|Hide) details of ${title}$`).test(String(i.props.alt)))?.props.alt
  return alt ? pinControl(view, String(alt)) : null
}

test('single-line steps keep Input rows while legacy multiline commands save unchanged', async () => {
  const project = DEMO.projects.find((p) => p.id === 'github:rr235/blog')!
  const command = 'if true; then\n  bun run dev\nfi'
  let actions = storedActions([{ id: 'legacy', name: 'Legacy', command, projectId: project.id, path: project.path, url: 'http://localhost:4000' }])!
  actions.push({ ...actions[0], id: 'single', name: 'Single', command: 'bun run dev', steps: ['bun run dev'] })
  const host = mockHost({
    requests: {
      'overview.load': () => ({ ...DEMO, sessions: [], servers: actions.map((a) => ({ ...a, up: false, terminal: null })) }),
      'session.selected': () => null,
      'action.save': (input) => {
        actions = saveAction(actions, input, [project], 'unused')
        return null
      }
    }
  })
  const view = await mount(panel, { host })
  try {
    await view.press({ label: 'Edit Single' })
    assert.equal(view.find({ type: 'Input', label: 'Step 1' } as never)?.props.value, 'bun run dev')
    assert.equal(view.find({ type: 'Textarea', label: 'Step 1' } as never), null)
    await view.press({ label: 'Edit Legacy' })
    assert.equal(view.find({ type: 'Textarea', label: 'Step 1' } as never)?.props.value, command)
    assert.equal(view.find({ type: 'Textarea', label: 'Step 1' } as never)?.props.rows, 2)
    assert.equal(view.find({ type: 'Input', label: 'Step 1' } as never), null)
    assert.equal(view.find({ label: 'Step 2' }), null)
    await view.type({ type: 'Input', label: 'Name' } as never, 'Renamed', { replace: true })
    await view.press({ type: 'Button', text: 'Save' })
    assert.deepEqual([actions[0].name, actions[0].command, actions[0].steps, actions[0].url], ['Renamed', command, [command], 'http://localhost:4000'])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('a closed session disappears on a workspace report before any timer advances', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let sessions = DEMO.sessions
  const host = mockHost({ requests: {
    'overview.load': () => ({ ...DEMO, sessions }),
    'session.selected': () => null
  } })
  const view = await mount(panel, { host })
  const report = { context: { workspaceId: 'wt_a', branch: 'main', displayName: 'Workspace A', terminals: [{ id: 't1' }] } }
  try {
    await view.emit('workspace.changed', report)
    assert.ok(view.find({ text: sessions[0].title }))
    sessions = sessions.slice(1)
    await view.emit('workspace.changed', report)
    assert.equal(view.find({ text: DEMO.sessions[0].title }), null, 'the close can still list the terminal')
  } finally {
    await view.unmount()
    mock.timers.reset()
  }
})

test('a slow command refresh completes without overlapping polls', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let loads = 0
  const action = { id: 'sync', name: 'Sync', steps: ['bun build'], projectId: null, url: null, terminal: 'term_sync' }
  const host = mockHost({ requests: {
    'overview.load': async () => {
      const first = ++loads === 1
      if (!first) await new Promise((resolve) => setTimeout(resolve, 2300))
      return { ...DEMO, sessions: [], servers: [{ ...action, up: first }] }
    },
    'session.selected': () => null
  } })
  const view = await mount(panel, { host })
  try {
    mock.timers.tick(2000)
    await new Promise((resolve) => setImmediate(resolve))
    mock.timers.tick(2000)
    assert.equal(loads, 2, 'one overview request stays in flight')
    mock.timers.tick(300)
    await view.settled()
    assert.ok(view.find({ label: 'Run Sync' }))
  } finally {
    await view.unmount()
    mock.timers.reset()
  }
})

test('shows quick actions, sessions and projects, and starts an action', async () => {
  const started: string[] = []
  const compacted: string[] = []
  const focused: string[] = []
  const host = mockHost({
    requests: {
      'overview.load': () => DEMO,
      'session.usage': ({ keys }) => Object.fromEntries(keys.map((key) => [key, DEMO_USAGE[key]])),
      'pr.info': ({ urls }) => Object.fromEntries(urls.map((url) => [url, { title: 'Tenant invite emails', state: 'merged' }])),
      'server.start': ({ id }) => {
        started.push(id)
        return null
      },
      'session.compact': ({ key }) => {
        compacted.push(key)
        return null
      },
      'session.focus': ({ key, path }) => {
        focused.push(`${key} ${path}`)
        return null
      },
      'session.selected': () => ({ worktreeId: 'r2::/w/kb', key: 'p2' })
    }
  })
  const view = await mount(panel, { host })
  const browsed = () => host.callsOf('shell.openExternal').map((params) => (params as { url: string }).url)
  try {
    for (const text of ['Platform', 'Primer', 'Website', 'KB', 'Blog', 'Onboarding checklist for new tenants', 'Planner', 'CRM']) {
      assert.ok(view.find({ text }), `shows ${text}`)
    }
    await view.press(view.find({ label: 'Run Primer' }) as never)
    assert.deepEqual(started, ['primer'])
    // A running action ends with its terminal, then open, then a green dot; open goes to the default browser.
    const terminal = view.find({ label: 'Show Platform terminal' })
    const open = view.find({ label: 'Open Platform' })
    assert.ok(terminal && open && terminal.path < open.path, `terminal before open: ${terminal?.path} ${open?.path}`)
    const dots = view.findAll({ type: 'Text', text: '●' }).filter((d) => d.props.tone === 'success')
    assert.ok(dots.some((d) => d.path > (open?.path ?? '')), 'a green dot after open')
    await view.press(view.find({ label: 'Open Platform' }) as never)
    assert.deepEqual(browsed(), ['http://demo.localhost:3100'])

    // The details open under the session, with the transcript's numbers, and close again.
    assert.equal(view.find({ text: 'Opus 5.5' }), null)
    assert.equal(view.find({ text: 'issue-212-onboarding' }), null, 'the branch moved into the details')
    // The row shows the session's tab; the chevron at the right toggles details.
    const row = (title: string) => ({ type: 'ListItem', text: new RegExp(title) }) as const
    const toggle = async (title: string) => view.press(chevron(view, title) as never)
    // Orca shows the chat's tab, so its title is in normal text with its details closed.
    const title = (text: string) => view.find({ type: 'Text', text })?.props.muted
    assert.equal(title('Review search ranking change'), false, 'the tab Orca shows')
    assert.equal(title('Draft post layout'), true, 'a tab Orca does not show')
    // The workspace Orca shows names its project in normal text, here the group outside every project.
    const project = (text: string) => view.findAll({ type: 'Text', text }).find((n) => n.props.size === 'xs')?.props.muted
    assert.equal(project('mountin-knowledge-base'), false, 'the project Orca shows')
    assert.equal(project('Platform'), true, 'a project Orca does not show')
    const line = view.find(row('Onboarding checklist for new tenants'))
    const closed = view.findAll({ type: 'Image' }).find((i) => i.props.alt === 'Show details of Onboarding checklist for new tenants')
    assert.ok(line && closed && line.path < closed.path, 'a chevron after the title')
    assert.match(String(closed?.props.src), /^assets\/details\/chevron-right-(dark|light)\.png$/, 'pointing right while closed')
    await toggle('Onboarding checklist for new tenants')
    assert.deepEqual(focused, [], 'the chevron leaves Orca on its tab')
    assert.ok(view.find({ text: /^Opus 5\.5,\s*High$/ }), 'the chevron opens the details')
    const openChevron = view.findAll({ type: 'Image' }).find((i) => i.props.alt === 'Hide details of Onboarding checklist for new tenants')
    assert.match(String(openChevron?.props.src), /^assets\/details\/chevron-down-(dark|light)\.png$/, 'pointing down while open')
    assert.equal(title('Onboarding checklist for new tenants'), true, 'open details leave a tab Orca does not show muted')
    await view.press(row('Onboarding checklist for new tenants'))
    assert.deepEqual(focused, ['p1 /w/platform'], 'the title shows its tab in Orca')
    assert.equal(title('Review search ranking change'), true, 'the pressed session is the one shown now')
    assert.equal(project('Platform'), false, 'and its project')
    assert.equal(project('mountin-knowledge-base'), true)
    assert.ok(view.find({ text: /^Opus 5\.5,\s*High$/ }), 'the title leaves the details open')
    await toggle('Onboarding checklist for new tenants')
    assert.equal(view.find({ text: /^Opus 5\.5,\s*High$/ }), null, 'the chevron again closes the details')
    await toggle('Onboarding checklist for new tenants')
    assert.deepEqual(focused, ['p1 /w/platform'], 'chevron presses never focus the session')
    assert.ok(view.find({ text: /^Opus 5\.5,\s*High$/ }), 'model and effort on one line')
    assert.ok(!view.find({ type: 'ListItem', text: /Onboarding checklist for new tenants/ })?.props.current, 'an open row has no background')
    // How long the session has been in its state sits just before Compact, which waits while a turn runs.
    const compact = view.find({ label: 'Compact' })
    const since = view.find({ type: 'RelativeTime' })
    assert.ok(compact && since && since.path < compact.path, `the time before compact: ${since?.path} ${compact?.path}`)
    assert.equal(compact?.props.disabled, true, 'not while working')
    assert.equal(compact?.props.icon, 'layers')
    assert.equal(compact?.props.variant, 'outline')
    assert.equal(compact?.props.tone, 'accent')
    // The shown session's title stays one line, in normal text.
    const openTitle = view.find({ type: 'Text', text: 'Onboarding checklist for new tenants' })
    assert.equal(openTitle?.props.truncate, true)
    assert.equal(openTitle?.props.muted, false)
    assert.ok(view.find({ text: /^24 turns,\s*48 tool calls since the last compaction$/ }), 'turns and tool calls since the last compaction')
    // 21 to 35 turns since the last compaction is yellow.
    assert.equal(view.find({ type: 'Text', text: /^24 turns,/ })?.props.tone, 'warning')
    assert.equal(view.find({ type: 'Text', text: '186 tool calls, 3 compactions' })?.props.muted, true, 'tool calls and compactions are muted')
    assert.ok(view.find({ text: /^40 turns,\s*186 tool calls, 3 compactions$/ }), 'total turns, tool calls and compactions on one line')
    const total = view.find({ type: 'Text', text: /^40 turns,$/ })
    assert.ok(total, 'total turns')
    assert.equal(total?.props.tone, undefined, 'after a compaction the total has no colour')
    assert.equal(total?.props.muted, true, 'and is muted like the rest of its line')
    // The total tokens are a ghost button, only so that hovering explains them.
    assert.equal(view.find({ type: 'Button', text: '2.9M' })?.props.tooltip, '2.9M tokens total: 152k input, 38k output, 2.7M cached')
    for (const text of ['121k / 1M', 'issue-212-onboarding', '#212', '#215', 'Tenant invite emails']) {
      assert.ok(view.find({ text }), `details show ${text}`)
    }
    assert.equal(view.find({ text: 'Bash: bun test onboarding' }), null, 'the card leaves out the running tool')
    // A pull request's number and title share one muted line, merged or not.
    assert.equal(view.find({ type: 'Text', text: '#215' })?.props.tone, undefined)
    assert.equal(view.find({ type: 'Text', text: '#215' })?.props.muted, true)
    assert.equal(view.find({ type: 'Text', text: 'Tenant invite emails' })?.props.muted, true)
    // Pressing a pull request's row opens it in the default browser.
    await view.press({ type: 'ListItem', text: /#215/ })
    assert.deepEqual(browsed().slice(1), ['https://github.com/mountin-io/platform/pull/215'])
    assert.deepEqual(host.refusals, [], 'Orca allows both, since each comes from a press')
    // Orca draws what it accepts: a dropped component or prop would show up as a warning.
    assert.ok(view.find({ type: 'Progress' }), 'context bar')
    assert.equal(view.find({ type: 'Spinner' }), null, 'no spinner: an active status is a static dot')
    assert.ok(view.find({ type: 'Text', text: 'active' }), 'the active status')
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
    await toggle('Onboarding checklist for new tenants')
    assert.equal(view.find({ text: /^Opus 5\.5,\s*High$/ }), null)
    assert.equal(focused.length, 1, 'the chevron does not change the tab')
    // The quick action closes every open card.
    await toggle('Onboarding checklist for new tenants')
    assert.ok(view.find({ text: 'issue-212-onboarding' }), 'details open again')
    await view.press(view.find({ label: 'Refresh sessions' }) as never)
    assert.equal(view.find({ text: 'issue-212-onboarding' }), null, 'the details close')
    // Before any compaction there is no since line, and the total turns take the colour, none up to 20.
    await toggle('Review search ranking change')
    assert.equal(view.find({ text: /since the last compaction/ }), null)
    // A chat session, which has no terminal, compacts too.
    const chatCompact = view.find({ label: 'Compact' })
    assert.equal(chatCompact?.props.disabled, false)
    await view.press(chatCompact as never)
    assert.deepEqual(compacted, ['p2'])
    const few = view.find({ type: 'Text', text: /^4 turns,$/ })
    assert.ok(few, 'total turns')
    assert.equal(few?.props.tone, undefined, 'up to 20 turns has no colour')
    assert.deepEqual(view.errors, [])
  } finally {
    // Always unmount: a failed assertion would otherwise leave the panel running and the run hanging.
    await view.unmount()
  }
})

test('shows a Fable or Astra model name in the warning colour', async () => {
  const host = mockHost({
    requests: {
      'overview.load': () => DEMO,
      'session.usage': ({ keys }) => Object.fromEntries(keys.map((key) => [key, { ...DEMO_USAGE[key], model: 'claude-fable-5-2' }]))
    }
  })
  const view = await mount(panel, { host })
  try {
    await view.press(chevron(view, 'Review search ranking change') as never)
    assert.equal(view.find({ type: 'Text', text: /^Fable 5\.2,/ })?.props.tone, 'warning')
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('shares open details with the panels of other workspaces through storage', async () => {
  const host = mockHost({
    requests: { 'overview.load': () => DEMO, 'session.usage': ({ keys }) => Object.fromEntries(keys.map((key) => [key, DEMO_USAGE[key]])) },
    storage: { expanded: { p1: true } }
  })
  const view = await mount(panel, { host })
  try {
    await view.settled()
    assert.ok(view.find({ text: /^Opus 5\.5,\s*High$/ }), 'details another panel opened are open here')
    await view.press(chevron(view, 'Onboarding checklist for new tenants') as never)
    await view.press(chevron(view, 'Review search ranking change') as never)
    assert.deepEqual(host.data().storage.expanded, { p2: true }, 'each change is stored at once')
  } finally {
    await view.unmount()
  }
})

test('pins a session above Sessions with its details open, and unpins it', async () => {
  const host = mockHost({
    requests: { 'overview.load': () => DEMO, 'session.usage': ({ keys }) => Object.fromEntries(keys.map((key) => [key, DEMO_USAGE[key]])), 'pr.info': () => ({}) }
  })
  const view = await mount(panel, { host })
  try {
    await view.settled()
    const empty = view.find({ type: 'Text', text: 'Favourites' })
    const sessionsTitle = view.find({ type: 'Text', text: 'Sessions' })
    assert.ok(empty && sessionsTitle && empty.path < sessionsTitle.path, 'Favourites shows above Sessions before a pin')
    assert.ok(view.find({ type: 'Text', text: "Pin session details by clicking on the star button." }), 'with how to add and remove one')
    await view.press({ type: 'ListItem', text: /^Favourites$/ })
    assert.equal(view.find({ type: 'Text', text: "Pin session details by clicking on the star button." }), null, 'the line shows only while Favourites is open')
    await view.press({ type: 'ListItem', text: /^Favourites$/ })
    assert.ok(view.find({ type: 'Text', text: "Pin session details by clicking on the star button." }), 'and returns when it opens')
    assert.equal(view.find({ type: 'IconButton', label: 'Add Onboarding checklist for new tenants to Favourites' }), null, 'the row has no pin')
    await view.press(chevron(view, 'Onboarding checklist for new tenants') as never)
    const pin = view.find({ type: 'IconButton', label: 'Add Onboarding checklist for new tenants to Favourites' })
    const status = view.find({ type: 'Text', text: 'active' })
    const compact = view.find({ label: 'Compact' })
    const since = view.find({ type: 'RelativeTime' })
    assert.ok(pin && status && since && compact && status.path < pin.path && pin.path < since.path && since.path < compact.path, 'the star sits just before the time')
    assert.equal(pin?.props.icon, 'star')
    assert.equal(pin?.props.tooltip, 'Add to Favourites')
    assert.equal(pin?.props.variant, compact?.props.variant, 'outlined like Compact')
    await view.press(pin as never)
    await view.settled()
    assert.deepEqual(host.data().storage.pinned, ['p1'], 'the pin is stored for every panel')
    assert.equal(view.find({ type: 'Text', text: "Pin session details by clicking on the star button." }), null, 'how to pin hides once a session is pinned')
    const title = view.find({ type: 'Text', text: 'Favourites' })
    const sessions = view.find({ type: 'Text', text: 'Sessions' })
    assert.ok(title && sessions && title.path < sessions.path, 'Pinned sits above Sessions')
    const unpins = view.findAll({ type: 'IconButton', label: 'Remove Onboarding checklist for new tenants from Favourites' })
    assert.equal(unpins.length, 1, 'one remove star, in its Favourites card')
    assert.equal(unpins[0].props.icon, 'star')
    assert.equal(unpins[0].props.tone, 'danger', 'red while a favourite')
    assert.equal(unpins[0].props.tooltip, 'Remove from Favourites')
    const pinnedName = view.findAll({ type: 'Text', text: 'Onboarding checklist for new tenants' })[0]
    const pinnedStatus = view.find({ type: 'Text', text: 'active' })
    assert.ok(title && pinnedName && pinnedStatus && pinnedName.path > title.path && unpins[0].path > pinnedStatus.path && unpins[0].path < (sessions?.path ?? ''), 'the red star follows the status in the Favourites card')
    assert.equal(view.find({ type: 'IconButton', label: 'Add Onboarding checklist for new tenants to Favourites' }), null, 'no add star once a favourite')
    const row = chevron(view, 'Onboarding checklist for new tenants')
    assert.ok(sessions && row && row.path > sessions.path, 'the session stays in its project too, with a chevron')
    assert.equal(view.findAll({ type: 'Image' }).filter((i) => /details of Onboarding checklist for new tenants$/.test(String(i.props.alt))).length, 1, 'no chevron in Pinned')
    assert.equal(view.findAll({ text: 'issue-212-onboarding' }).length, 1, 'one details card, in Pinned')
    assert.ok(view.find({ text: 'issue-212-onboarding' }), 'its details show')
    assert.ok(view.find({ text: /^Opus 5\.5,\s*High$/ }), 'with its numbers')
    // The refresh button closes the list's details, not a pinned card.
    await view.press(view.find({ label: 'Refresh sessions' }) as never)
    assert.ok(view.find({ text: 'issue-212-onboarding' }), 'the pinned card stays')
    await view.press(view.find({ type: 'IconButton', label: 'Remove Onboarding checklist for new tenants from Favourites' }) as never)
    await view.settled()
    assert.deepEqual(host.data().storage.pinned, [])
    assert.ok(view.find({ type: 'Text', text: 'Favourites' }), 'Favourites stays after the last pin')
    assert.ok(view.find({ type: 'Text', text: "Pin session details by clicking on the star button." }), 'and how to pin returns')
    assert.equal(view.find({ text: 'issue-212-onboarding' }), null, 'its project row has its details closed')
    await view.press(chevron(view, 'Onboarding checklist for new tenants') as never)
    assert.ok(view.find({ type: 'IconButton', label: 'Add Onboarding checklist for new tenants to Favourites' }), 'and pins again from them')
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('the activity button shows only projects with sessions, then all of them again', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const host = mockHost({ requests: { 'overview.load': () => DEMO, 'session.usage': () => ({}), 'pr.info': () => ({}) } })
  const view = await mount(panel, { host })
  const flashes = () => view.findAll({ type: 'Text', text: '●' }).filter((dot) => dot.props.muted === true)
  try {
    await view.settled()
    const filter = () => view.find({ type: 'IconButton', icon: 'activity' })
    const refresh = view.find({ type: 'IconButton', label: 'Refresh sessions' })
    assert.ok(filter() && refresh && filter()!.path < refresh.path, 'it sits right before Refresh')
    assert.equal(filter()?.props.label, 'Show only projects with sessions')
    assert.ok(view.find({ type: 'Text', text: 'CRM' }) && view.find({ type: 'Text', text: 'Planner' }), 'all projects show at first')
    await view.press(filter() as never)
    assert.equal(view.find({ type: 'Text', text: 'CRM' }), null, 'a project without sessions hides')
    assert.equal(view.find({ type: 'Text', text: 'Planner' }), null)
    assert.ok(view.find({ type: 'Text', text: 'Platform' }) && view.find({ type: 'Text', text: 'Personal Blog' }), 'projects with sessions stay')
    assert.equal(filter()?.props.label, 'Show all projects')
    assert.equal(filter()?.props.tone, 'accent', 'highlighted while filtering')
    assert.equal(flashes().length, 0, 'no flash while hiding')
    await view.press(filter() as never)
    assert.ok(view.find({ type: 'Text', text: 'CRM' }), 'all projects show again')
    const shown = flashes()
    assert.equal(shown.length, 2, 'a grey dot on each project shown again, and only those')
    for (const [name, key] of [['CRM', 'github:rr235/crm/'], ['Planner', 'github:rr235/planner/']]) {
      const title = view.find({ type: 'Text', text: name })
      const dot = shown.find((d) => d.path.includes(key))
      assert.ok(title && dot && title.path < dot.path, `${name}: the dot sits right after its name`)
      assert.equal(title?.props.muted, false, `${name}: in normal text while the dot shows`)
    }
    mock.timers.tick(99)
    await view.settled()
    assert.equal(flashes().length, 2, 'still there just before 100ms')
    mock.timers.tick(1)
    await view.settled()
    assert.equal(flashes().length, 0, 'gone at 100ms')
    assert.equal(view.find({ type: 'Text', text: 'CRM' })?.props.muted, true, 'and the name is muted again')
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
    mock.timers.reset()
  }
})

test('says why Sessions is empty when no project has a session and the filter is on', async () => {
  const host = mockHost({ requests: { 'overview.load': () => ({ ...DEMO, sessions: [] }), 'session.usage': () => ({}), 'pr.info': () => ({}) } })
  const view = await mount(panel, { host })
  try {
    await view.settled()
    await view.press({ type: 'IconButton', icon: 'activity' })
    assert.equal(view.find({ type: 'Text', text: 'CRM' }), null)
    assert.ok(view.find({ text: /^No project has a session\./ }), 'a line says so')
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('explains how to add a project while Orca has none', async () => {
  const host = mockHost({ requests: { 'overview.load': () => ({ ...DEMO, projects: [], sessions: [] }), 'session.usage': () => ({}), 'pr.info': () => ({}) } })
  const view = await mount(panel, { host })
  try {
    await view.settled()
    const note = view.find({ type: 'Callout', title: 'No Orca projects found' })
    const sessions = view.find({ type: 'Text', text: 'Sessions' })
    const actions = view.find({ type: 'Text', text: 'Quick actions' })
    assert.ok(note && sessions && actions && sessions.path < note.path && note.path < actions.path, 'the note sits inside Sessions')
    assert.equal(view.find({ type: 'Text', text: 'Favourites' }), null, 'Favourites hides without projects')
    assert.equal(view.find({ label: 'Refresh sessions' }), null, 'and so does Refresh')
    assert.ok(view.find({ text: /^1\. Open the workspaces sidebar, click on the add project/ }) && view.find({ text: /^2\. Choose Browse folder/ }) && view.find({ text: /^3\. Start a session/ }), 'with numbered steps')
    const described = view.findAll({ type: 'Text', text: 'All sessions are grouped by Orca projects.' })
    assert.equal(described.length, 1, 'the description shows once')
    assert.ok(note && described[0].path.startsWith(note.path), 'as the note’s first line, not under the header')
    await view.press({ type: 'ListItem', text: /^Sessions$/ })
    assert.equal(view.find({ type: 'Callout', title: 'No Orca projects found' }), null, 'closed Sessions hides it')
    assert.equal(view.find({ type: 'Text', text: 'All sessions are grouped by Orca projects.' }), null, 'and the header has no description')
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('explains how to add a quick action while none is saved, with examples', async () => {
  const host = mockHost({ requests: { 'overview.load': () => ({ ...DEMO, servers: [] }), 'session.usage': () => ({}), 'pr.info': () => ({}) } })
  const view = await mount(panel, { host })
  try {
    await view.settled()
    const note = view.find({ type: 'Callout', title: 'No quick actions yet?' })
    const header = view.find({ type: 'Text', text: 'Quick actions' })
    const add = view.find({ label: 'Add action' })
    assert.ok(note && header && add && header.path < note.path && note.path < add.path, 'the note sits between the header and Add action')
    assert.equal(note?.props.tone, 'accent')
    assert.ok(view.find({ type: 'Text', text: 'Click Add action below to add one.' }), 'with how to add one')
    assert.ok(view.find({ type: 'Text', text: '- Single command:' }) && view.find({ type: 'Text', text: '- Multiple commands:' }), 'and two examples')
    const code = view.findAll({ type: 'Code' }).filter((c) => note && c.path.startsWith(note.path))
    assert.deepEqual(code.map((c) => c.text), ['npm run dev', 'git pull', 'npm install', 'npm run build'], 'their commands as inline code')
    const described = view.findAll({ type: 'Text', text: 'One click run for commands to run within your project folder.' })
    assert.equal(described.length, 1, 'the description shows once')
    assert.ok(note && described[0].path.startsWith(note.path), 'as the note’s first line, not under the header')
    await view.press({ type: 'ListItem', text: /^Quick actions$/ })
    assert.equal(view.find({ type: 'Callout', title: 'No quick actions yet?' }), null, 'closed Quick actions hides it')
    assert.equal(view.find({ type: 'Text', text: 'One click run for commands to run within your project folder.' }), null, 'and the header has no description')
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('shows no quick action note while actions are saved', async () => {
  const host = mockHost({ requests: { 'overview.load': () => DEMO, 'session.usage': () => ({}), 'pr.info': () => ({}) } })
  const view = await mount(panel, { host })
  try {
    await view.settled()
    assert.equal(view.find({ type: 'Callout', title: 'No quick actions yet?' }), null)
  } finally {
    await view.unmount()
  }
})

test('shows no project note while Orca has projects', async () => {
  const host = mockHost({ requests: { 'overview.load': () => DEMO, 'session.usage': () => ({}), 'pr.info': () => ({}) } })
  const view = await mount(panel, { host })
  try {
    await view.settled()
    assert.equal(view.find({ type: 'Callout', title: 'No Orca projects found' }), null)
  } finally {
    await view.unmount()
  }
})

test('syncs ordered pins across panels, including while Sessions is closed', async () => {
  const requested: string[] = []
  const host = mockHost({
    requests: {
      'overview.load': () => DEMO,
      'session.usage': ({ keys }) => {
        requested.push(...keys)
        return Object.fromEntries(keys.map((key) => [key, DEMO_USAGE[key]]))
      },
      'pr.info': () => ({})
    },
    storage: { pinned: ['gone', 'p2'] }
  })
  const view = await mount(panel, { host })
  try {
    await view.settled()
    assert.ok(view.find({ type: 'IconButton', label: 'Remove Review search ranking change from Favourites' }), 'the stored pin shows')
    assert.deepEqual(host.data().storage.pinned, ['p2'], 'the ended session is dropped')
    await view.press(chevron(view, 'Onboarding checklist for new tenants') as never)
    await view.press(view.find({ type: 'IconButton', label: 'Add Onboarding checklist for new tenants to Favourites' }) as never)
    assert.deepEqual(host.data().storage.pinned, ['p2', 'p1'], 'several pins keep the order pinned')
    await view.press({ type: 'ListItem', text: /^Sessions$/ })
    assert.equal(view.persisted.plugin.sections.sessions, false, 'the closed section is remembered')
    assert.ok(view.find({ text: 'issue-212-onboarding' }), 'pinned details stay open with Sessions closed')
    const pins = view.findAll({ type: 'IconButton' }).filter((item) => String(item.props.label).startsWith('Remove '))
    assert.deepEqual(pins.map((item) => item.props.label), ['Remove Review search ranking change from Favourites', 'Remove Onboarding checklist for new tenants from Favourites'])
    await view.press({ type: 'ListItem', text: /^Favourites$/ })
    assert.equal(view.persisted.plugin.sections.favourites, false, 'closed Favourites is remembered')
    assert.equal(view.find({ text: 'issue-212-onboarding' }), null, 'closed Favourites hides its cards')
    assert.ok(view.find({ type: 'Text', text: 'Favourites' }), 'and keeps its header')
    await view.press({ type: 'ListItem', text: /^Favourites$/ })
    assert.ok(view.find({ text: 'issue-212-onboarding' }), 'reopening shows them again')
    // A storage write from another panel goes through Orca's real storage synchronization.
    await storage.set('pinned', ['p3'])
    await view.settled()
    assert.ok(view.find({ type: 'IconButton', label: 'Remove Draft post layout from Favourites' }), 'a new remote pin appears')
    assert.equal(view.find({ text: 'issue-212-onboarding' }), null, 'a remote unpin removes its card')
    assert.ok(requested.includes('p3'), 'the remote pin requests its usage')
    assert.equal(view.find({ type: 'Skeleton', label: 'Loading model' }), null, 'the remote pin finishes loading its usage')
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('opens a project when its name is pressed', async () => {
  const opened: string[] = []
  const host = mockHost({
    requests: {
      'overview.load': () => DEMO,
      'session.usage': () => ({}),
      'project.open': ({ path }) => {
        opened.push(path)
        return null
      }
    }
  })
  const view = await mount(panel, { host })
  try {
    await view.press({ type: 'ListItem', text: /Planner$/ })
    assert.deepEqual(opened, ['/w/planner'], 'the project row opens its main checkout')
  } finally {
    await view.unmount()
  }
})

test('shows a chat or a terminal session\'s tab from its title', async () => {
  const focused: string[] = []
  const chat = { ...DEMO.sessions[1], key: 'structured-agent-session-claude_abc:leaf-1' }
  const host = mockHost({
    requests: {
      'overview.load': () => ({ ...DEMO, sessions: [DEMO.sessions[0], chat] }),
      'session.usage': () => ({}),
      'session.focus': ({ key }) => {
        focused.push(key)
        return null
      }
    }
  })
  const view = await mount(panel, { host })
  try {
    await view.settled()
    await view.press({ type: 'ListItem', text: new RegExp(chat.title) })
    await view.press({ type: 'ListItem', text: new RegExp(DEMO.sessions[0].title) })
    assert.deepEqual(focused, [chat.key, DEMO.sessions[0].key], 'each title shows its tab in Orca')
    assert.ok(chevron(view, chat.title) && chevron(view, DEMO.sessions[0].title), 'both have a chevron')
  } finally {
    await view.unmount()
  }
})

test('groups a project\'s sessions by worktree when it has more than one', async () => {
  assert.deepEqual(
    byWorktree(DEMO_WORKTREES.sessions.filter((s) => s.projectId === 'github:mountin-io/platform')).map((w) => [w.name, w.sessions.map((s) => s.key)]),
    [
      ['issue-212-onboarding', ['p1', 'p5']],
      ['main', ['p4']]
    ],
    'in the order of each worktree\'s first session'
  )
  // Orca shows a file in Platform's main checkout: its project and worktree names are in normal
  // text, and no session's title is.
  const host = mockHost({
    requests: {
      'overview.load': () => DEMO_WORKTREES,
      'session.usage': () => ({}),
      'session.selected': () => ({ worktreeId: 'r1::/w/platform-main', key: null })
    }
  })
  const view = await mount(panel, { host })
  try {
    await view.settled()
    const muted = (text: string, size = 'xs') => view.findAll({ type: 'Text', text }).filter((n) => n.props.size === size).map((n) => n.props.muted)
    assert.equal(muted('Platform')[0], false, 'the project Orca shows')
    assert.equal(muted('Personal Blog')[0], true)
    assert.deepEqual(muted('main'), [false], 'the main checkout Orca shows')
    assert.deepEqual(muted('issue-212-onboarding'), [true])
    assert.deepEqual(muted('Release notes for 0.4'), [true], 'a file, not the session, is on screen')
    // Paths hold keys, so the order on screen is the order findAll returns.
    const texts = view.findAll({ type: 'Text' }).map((node) => node.text)
    const order = ['issue-212-onboarding', 'Onboarding checklist for new tenants', 'Review onboarding copy', 'main', 'Release notes for 0.4', 'Planner']
    // From the Platform project, which follows Personal Blog's session.
    const platform = texts.slice(texts.indexOf('Draft post layout'))
    assert.deepEqual(platform.filter((text) => order.includes(text as string)), order,'a header per worktree with sessions, its sessions under it')
    // Personal Blog and the session outside every project each have sessions in one worktree.
    const before = (title: string) => texts[texts.indexOf(title) - 1]
    assert.equal(before('Draft post layout'), 'Personal Blog', 'no header when only one worktree has sessions')
    assert.equal(before('Review search ranking change'), 'mountin-knowledge-base', 'a project with one worktree has no header')
    // A project's name has no icon.
    assert.ok(!view.findAll({ type: 'Image' }).some((i) => String(i.props.src).includes('/project-')), 'no project icon')
    // The details show the session's branch with the branch icon, not its worktree's name again.
    await view.press(chevron(view, 'Release notes for 0\\.4') as never)
    assert.ok(view.find({ type: 'Text', text: 'release/0.4' }), 'the branch')
    assert.ok(view.find({ type: 'Image', alt: 'Branch' } as never), 'the branch icon')
    assert.equal(view.findAll({ type: 'Text', text: 'main' }).length, 1, 'the worktree name only in its header')
    assert.equal(view.find({ type: 'Text', text: /^on / }), null)
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('shows why a session could not compact', async () => {
  const host = mockHost({
    requests: {
      'overview.load': () => DEMO,
      'session.usage': () => DEMO_USAGE,
      'session.compact': () => {
        throw new Error('The command was not run.')
      }
    }
  })
  const view = await mount(panel, { host })
  try {
    await view.press(chevron(view, 'Review search ranking change') as never)
    await view.press({ label: 'Compact' })
    assert.ok(view.find({ type: 'Callout', text: 'Could not compact Review search ranking change. The command was not run.' }))
  } finally {
    await view.unmount()
  }
})

test('shows skeletons only for what the details are still reading', async () => {
  const held: Array<() => void> = []
  const host = mockHost({
    requests: {
      'overview.load': () => DEMO,
      'session.usage': ({ keys }) =>
        new Promise((resolve) => held.push(() => resolve(Object.fromEntries(keys.map((key) => [key, DEMO_USAGE[key]]))))),
      'pr.info': ({ urls }) =>
        new Promise((resolve) => held.push(() => resolve(Object.fromEntries(urls.map((url) => [url, { title: 'Tenant invite emails', state: 'merged' }])))))
    }
  })
  const view = await mount(panel, { host })
  const labels = () => view.findAll({ type: 'Skeleton' }).map((s) => s.props.label)
  // A press settles only once its reads answer, so they are held open while the view is polled,
  // then answered together.
  const open = async (title: string, want: string[]) => {
    const pressing = view.press(chevron(view, title) as never)
    for (let i = 0; i < 200 && JSON.stringify(labels()) !== JSON.stringify(want); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(labels(), want)
    return async () => {
      held.splice(0).forEach((answer) => answer())
      await pressing
    }
  }
  try {
    // Model, context and turns wait for the transcript, and #215's title for gh; status, the
    // worktree and #212, which Orca already knows, show at once.
    let answer = await open('Onboarding checklist for new tenants', ['Loading model', 'Loading context', 'Loading turns', 'Loading title'])
    for (const text of ['active', 'issue-212-onboarding', '#212', '#215']) {
      assert.ok(view.find({ text }), `shows ${text} while loading`)
    }
    assert.equal(view.find({ text: 'Claude' }), null, 'no agent name standing in for the model')
    await answer()
    assert.deepEqual(labels(), [])
    assert.ok(view.find({ text: /^Opus 5\.5,\s*High$/ }))
    assert.ok(view.find({ text: 'Tenant invite emails' }))
    // A session without pull requests has no title to wait for.
    answer = await open('Review search ranking change', ['Loading model', 'Loading context', 'Loading turns'])
    await answer()
    assert.deepEqual(labels(), [])
  } finally {
    await view.unmount()
  }
})

test('explains missing usage and reserves the same lines for known, partial and missing usage', async () => {
  const missing = 'No transcript found for this session.'
  const unsupported = 'Usage is only read for Claude and Codex sessions.'
  const failed = 'Could not read usage. The next refresh tries again.'
  const partial = { ...DEMO_USAGE.p3, context: 121_400 }
  const zero = { ...DEMO_USAGE.p2, turns: 0, compactions: 0, toolCalls: 0 }
  const cases: { agent: string | null; stats: SessionUsage | undefined; note: string; fails?: true }[] = [
    { agent: 'claude', stats: undefined, note: missing },
    { agent: 'claude', stats: undefined, note: failed, fails: true },
    { agent: 'codex', stats: undefined, note: missing },
    { agent: 'gemini', stats: undefined, note: unsupported },
    { agent: null, stats: undefined, note: unsupported },
    { agent: 'claude', stats: partial, note: missing },
    { agent: 'codex', stats: zero, note: '0 turns, 0 tool calls, 0 compactions' },
    { agent: 'claude', stats: DEMO_USAGE.p1, note: '40 turns, 186 tool calls, 3 compactions' }
  ]
  // Text children are inline spans, so stop at each outer Text to count the rendered line slots.
  const lines = (node: TreeSnapshot | string | null): number =>
    !node || typeof node === 'string' ? 0 : node.type === 'Text' ? 1 : (node.children ?? []).reduce((sum, child) => sum + lines(child), 0)
  const counts: number[] = []
  for (const { agent, stats, note, fails } of cases) {
    const session = { ...DEMO.sessions[0], agent, prs: [] }
    const host = mockHost({
      requests: {
        'overview.load': () => ({ ...DEMO, sessions: [session] }),
        'session.usage': () => {
          if (fails) {
            throw new Error('worker timed out')
          }
          return stats ? { [session.key]: stats } : {}
        }
      },
      storage: { expanded: { [session.key]: true } }
    })
    const view = await mount(panel, { host })
    try {
      await view.settled()
      assert.ok(view.find({ type: 'Text', text: note }), `${agent}: ${note}`)
      assert.equal(view.findAll({ type: 'Progress' }).length, 1, 'context bar always renders')
      if (stats?.tokens == null) {
        assert.ok(view.find({ type: 'Button', text: 'NA' }), 'unknown tokens keep the button')
        assert.equal(view.find({ type: 'Progress' })?.props.value, 0, 'unknown percent keeps an empty bar')
        assert.ok(view.find({ text: stats?.context != null ? /^121k\s*\/ NA$/ : /^NA\s*\/ NA$/ }), 'partial context keeps its known value')
      }
      if (stats === DEMO_USAGE.p1) {
        assert.ok(view.find({ type: 'Text', text: '24 turns, 48 tool calls since the last compaction' }))
      }
      counts.push(lines(view.tree()))
      assert.deepEqual([view.errors, view.warnings], [[], []])
    } finally {
      await view.unmount()
    }
  }
  assert.ok(counts.every((count) => count === counts[0]), `equal line slots: ${counts}`)
})

test('edits, adds and deletes quick actions', async () => {
  const saved: unknown[] = []
  const deleted: string[] = []
  const host = mockHost({
    requests: {
      'overview.load': () => DEMO,
      'session.usage': () => ({}),
      'pr.info': () => ({}),
      'action.save': (input) => {
        saved.push(input)
        return null
      },
      'action.delete': ({ id }) => {
        deleted.push(id)
        return null
      }
    }
  })
  const view = await mount(panel, { host })
  const nameInput = () => view.find({ type: 'Input', label: 'Name' } as never)
  // Editing hides nothing: the sessions and the actions stay, under the same titles.
  const allInView = () => {
    // Sessions and Quick actions each have a pressable header of the panel's own, Quick actions at the bottom.
    assert.equal(view.find({ type: 'Collapsible' }), null)
    const sessions = view.find({ type: 'Text', text: 'Sessions' })
    const quick = view.find({ type: 'Text', text: 'Quick actions' })
    assert.ok(sessions && quick && sessions.path < quick.path, 'Sessions above Quick actions')
    assert.equal(view.findAll({ type: 'Separator' } as never).length, 0, 'no separator between the sections')
    assert.ok(view.find({ label: 'Run Primer' }), 'the actions stay')
    assert.ok(view.find({ text: 'Onboarding checklist for new tenants' }), 'the sessions stay')
  }
  try {
    allInView()
    // The arrow and the title are one pressable header.
    const header = () => view.find({ type: 'ListItem', text: /Quick actions/ })
    const headerDot = () => view.findAll({ type: 'Text', text: '●' }).find((d) => d.props.tone === 'success' && d.path > (header()?.path ?? '') && d.path < (view.find({ label: 'Stop Platform' })?.path ?? ''))
    assert.equal(header()?.props.icon, 'expand', 'open: the arrow points down')
    assert.equal(view.find({ type: 'IconButton', label: /quick actions$/ } as never), null, 'no separate arrow button')
    assert.ok(headerDot(), 'Platform runs, so the header has a green dot')
    await view.press(header() as never)
    assert.equal(header()?.props.icon, 'next', 'closed: the arrow points right')
    assert.equal(view.find({ label: 'Run Primer' }), null, 'closed: no actions')
    assert.ok(view.findAll({ type: 'Text', text: '●' }).some((d) => d.props.tone === 'success' && d.path > (header()?.path ?? '')), 'the dot stays while closed')
    await view.press(header() as never)
    allInView()
    // Sessions opens and closes the same way; its refresh button stays while closed.
    const sessionsHeader = () => view.find({ type: 'ListItem', text: /Sessions/ })
    assert.equal(sessionsHeader()?.props.icon, 'expand', 'Sessions open: the arrow points down')
    await view.press(sessionsHeader() as never)
    assert.equal(sessionsHeader()?.props.icon, 'next', 'Sessions closed: the arrow points right')
    assert.equal(view.find({ text: 'Onboarding checklist for new tenants' }), null, 'Sessions closed: no sessions')
    assert.ok(view.find({ type: 'IconButton', label: 'Refresh sessions' }), 'the refresh button stays while closed')
    assert.ok(view.find({ label: 'Run Primer' }), 'Quick actions stay while Sessions is closed')
    await view.press(sessionsHeader() as never)
    allInView()
    // Run comes last in an action's row.
    const run = view.find({ label: 'Run Primer' })
    const primerName = view.find({ type: 'Text', text: 'Primer' })
    assert.ok(run && primerName && primerName.path < run.path, 'Run comes after the name')
    const icons = view.findAll({ type: 'Image' }).length
    // The Sessions title carries the smallest refresh button, which closes every session's details.
    const refreshButton = view.find({ type: 'IconButton', label: 'Refresh sessions' })
    assert.equal(refreshButton?.props.icon, 'refresh', 'a refresh icon')
    assert.equal(refreshButton?.props.size, 'xs')
    // Add action sits under the actions, and opens its form right there.
    const addLine = view.find({ type: 'Text', text: 'Add action' })
    const lastAction = view.find({ label: 'Run Blog' })
    assert.ok(addLine && lastAction && lastAction.path < addLine.path, `Add action under the actions: ${lastAction?.path} ${addLine?.path}`)
    // Styled like Refresh sessions: muted text, then its plus button.
    assert.equal(view.find({ type: 'IconButton', label: 'Add action' })?.props.icon, 'add')
    assert.equal(view.find({ type: 'Text', text: 'Add action' })?.props.muted, true)
    await view.press({ type: 'IconButton', label: 'Add action' })
    assert.equal(view.find({ type: 'IconButton', label: 'Add action' })?.props.icon, 'close', 'the same button closes the form')
    assert.equal(view.find({ type: 'IconButton', label: 'Add action' })?.props.tooltip, 'Close new action')
    allInView()
    assert.equal(nameInput()?.props.value, '', 'an empty form')
    const addText = view.find({ type: 'Text', text: 'Add action' })
    assert.ok(addText && (nameInput()?.path ?? '') < addText.path, 'the form opens above Add action')
    // The new form starts with its title, in plain sm text.
    const heading = view.find({ type: 'Text', text: 'Add new action' })
    assert.ok(heading && heading.path < (view.find({ type: 'Select', label: 'Project' } as never)?.path ?? ''), 'title first in the form')
    assert.equal(heading?.props.size, 'sm')
    assert.equal(heading?.props.muted, undefined)
    assert.equal(heading?.props.tone, undefined)
    // Example placeholders, and a muted note under the title for what they leave out.
    assert.equal(view.find({ type: 'Input', label: 'Step 1' } as never)?.props.placeholder, 'npm run dev')
    assert.equal(view.find({ type: 'Textarea', label: 'Step 1' } as never), null, 'single-line steps keep Input rows')
    assert.equal(view.find({ type: 'Input', label: 'URL' } as never)?.props.placeholder, 'URL (optional)')
    // The commands note sits under the title; the URL note sits under the URL field.
    const note = view.find({ type: 'Text', text: "The commands run serially in order in the project's main checkout." })
    assert.ok(note && heading && heading.path < note.path, 'the note sits under the title')
    const urlNote = view.find({ type: 'Text', text: 'URL (optional): if the URL differs from the one the server prints.' })
    const urlField = view.find({ type: 'Input', label: 'URL' } as never)
    const addButton = view.find({ type: 'Button', text: 'Add +' })
    assert.ok(urlNote && urlField && addButton && urlField.path < urlNote.path && urlNote.path < addButton.path, 'the URL note sits under the URL field')
    assert.equal(urlNote?.props.muted, true)
    assert.equal(note?.props.muted, true)
    assert.equal(view.find({ type: 'Button', text: 'Delete' }), null, 'nothing to delete yet')
    // One button, Add with a plus, and no Save or Cancel.
    assert.equal(view.find({ type: 'Button', text: 'Add +' })?.props.icon, undefined, 'the plus is in the text, after Add')
    assert.equal(view.find({ type: 'Button', text: 'Add +' })?.props.size, 'xs')
    assert.equal(view.find({ type: 'Button', text: 'Add +' })?.props.tone, 'neutral')
    const cancel = view.find({ type: 'Button', text: 'Cancel' })
    assert.ok(cancel && cancel.path < (view.find({ type: 'Button', text: 'Add +' })?.path ?? ''), 'a ghost Cancel just before Add')
    assert.equal(cancel?.props.variant, 'ghost')
    assert.equal(cancel?.props.size, 'xs')
    assert.equal(view.find({ type: 'Button', text: 'Save' }), null)
    // It needs a name, a command and a project before it is sent.
    // No visible labels, in the order project, name, command.
    for (const label of ['Project', 'Name', 'Step 1']) {
      assert.equal(view.find({ label } as never)?.props.labelHidden, true, `${label} label hidden`)
    }
    // One step has nothing to remove.
    assert.equal(view.find({ label: 'Remove step 1' }), null)
    const form = view.find({ type: 'Select', label: 'Project' } as never)
    assert.ok(form && form.path < (nameInput()?.path ?? ''), `project before name: ${form?.path} ${nameInput()?.path}`)
    await view.press({ type: 'Button', text: 'Add +' })
    assert.ok(view.find({ text: 'Choose a project.' }))
    await view.select({ type: 'Select', label: 'Project' } as never, 'github:rr235/blog')
    await view.type({ type: 'Input', label: 'Name' } as never, 'Docs')
    await view.press({ type: 'Button', text: 'Add +' })
    assert.ok(view.find({ text: 'Give it a command.' }))
    assert.equal(saved.length, 0)
    await view.type({ type: 'Input', label: 'Step 1' } as never, 'bun run docs')
    // Add step adds a row under the last; with several, each can be removed.
    await view.press({ type: 'Button', text: 'Add step +' })
    assert.equal(view.find({ type: 'Input', label: 'Step 2' } as never)?.props.placeholder, 'Next command')
    await view.type({ type: 'Input', label: 'Step 2' } as never, 'bun run build')
    await view.press({ type: 'Button', text: 'Add step +' })
    await view.press({ label: 'Remove step 3' })
    assert.equal(view.find({ type: 'Input', label: 'Step 3' } as never), null)
    assert.equal(view.find({ type: 'Button', text: '↑' }), null, 'no reordering')
    // The URL comes under the steps, is optional, and must be a web address when given.
    const url = view.find({ type: 'Input', label: 'URL' } as never)
    const command = view.find({ type: 'Button', text: 'Add step +' })
    assert.ok(url && command && command.path < url.path, 'URL under the steps')
    assert.equal(url?.props.labelHidden, true)
    assert.equal(view.findAll({ type: 'Image' }).length, icons, 'choosing a project shows no icon in the form')
    await view.type({ type: 'Input', label: 'URL' } as never, 'ftp://x')
    await view.press({ type: 'Button', text: 'Add +' })
    assert.ok(view.find({ text: 'Give it a web address, such as localhost:3000.' }))
    assert.equal(saved.length, 0)
    await view.type({ type: 'Input', label: 'URL' } as never, 'localhost:4000', { replace: true })
    await view.press({ type: 'Button', text: 'Add +' })
    assert.deepEqual(saved, [{ name: 'Docs', steps: ['bun run docs', 'bun run build'], projectId: 'github:rr235/blog', url: 'localhost:4000', icon: '' }])
    assert.equal(nameInput(), null, 'saving closes the form')
    saved.length = 0

    // A stopped action's row starts with an edit button and ends with Run; a running one's edit button is disabled, and there is no Edit quick actions.
    assert.equal(view.find({ label: 'Edit quick actions' }), null)
    assert.equal(view.find({ label: 'Edit Platform' })?.props.disabled, true, 'Platform is running')
    assert.equal(view.find({ label: 'Edit Platform' })?.props.tooltip, 'Stop to edit', 'Platform has a Stop button')
    assert.equal(view.find({ type: 'Button', text: '🌐' })?.props.tooltip, 'Edit once it stops', 'Website has no terminal to stop')
    const editPrimer = view.find({ label: 'Edit Primer' })
    assert.ok(editPrimer && editPrimer.path < (view.find({ label: 'Run Primer' })?.path ?? ''), 'edit sits at the left of the row, run at the right')

    // Its form opens under its row, where Edit was pressed, and the row's button closes it.
    await view.press(view.find({ label: 'Edit Primer' }) as never)
    allInView()
    assert.equal(nameInput()?.props.value, 'Primer')
    const closePrimer = view.find({ label: 'Close Primer' })
    // Rows are keyed by action id, so the form shares the Primer row's group and follows its row.
    const row = closePrimer?.path ?? ''
    const group = row.slice(0, row.indexOf('/primer/') + '/primer/'.length)
    const formPath = nameInput()?.path ?? ''
    assert.ok(row && formPath.startsWith(group) && row < formPath, `the form sits under its row: ${row} ${formPath}`)
    // Titled Edit action; the line under the actions still reads Add action.
    assert.equal(view.find({ type: 'Text', text: "The commands run serially in order in the project's main checkout." }), null, 'editing leaves out how the commands run')
    const editTitles = view.findAll({ type: 'Text', text: 'Edit action' })
    assert.equal(editTitles.length, 1, 'only the title')
    assert.equal(editTitles[0].props.size, 'sm')
    assert.equal(view.find({ type: 'IconButton', label: 'Add action' })?.props.icon, 'add')
    assert.equal(closePrimer?.props.tooltip, 'Close edit action')
    // Add action switches to a new action's form.
    await view.press(view.find({ type: 'IconButton', label: 'Add action' }) as never)
    assert.equal(nameInput()?.props.value, '')
    assert.equal(view.find({ label: 'Close Primer' }), null)
    await view.press(view.find({ label: 'Edit Primer' }) as never)
    // An extra small Delete on the left; Cancel, then Save, on the right.
    const del = view.find({ type: 'Button', text: 'Delete' })
    const save = view.find({ type: 'Button', text: 'Save' })
    assert.equal(del?.props.size, 'xs')
    assert.equal(del?.props.tooltip, 'Remove Primer action from quick actions')
    assert.ok(del && save && del.path < save.path, 'Delete before Save')
    const editCancel = view.find({ type: 'Button', text: 'Cancel' })
    assert.ok(editCancel && del && save && del.path < editCancel.path && editCancel.path < save.path, 'Cancel between Delete and Save')
    await view.type({ type: 'Input', label: 'Name' } as never, 'Primer docs', { replace: true })
    await view.select({ type: 'Select', label: 'Project' } as never, 'github:rr235/blog')
    await view.press({ type: 'Button', text: 'Save' })
    // The form starts with the address the action has.
    assert.deepEqual(saved, [{ name: 'Primer docs', steps: ['bun run dev:primer'], projectId: 'github:rr235/blog', url: 'http://localhost:3200', icon: '', id: 'primer' }])
    assert.equal(nameInput(), null, 'saving closes the form')

    await view.press(view.find({ label: 'Edit Blog' }) as never)
    await view.press(view.find({ label: 'Close Blog' }) as never)
    assert.equal(nameInput(), null, 'the row closes its form')
    await view.press(view.find({ label: 'Edit Blog' }) as never)
    await view.press({ type: 'Button', text: 'Delete' })
    assert.deepEqual(deleted, ['blog'])
    assert.equal(nameInput(), null, 'deleting closes the form')
    allInView()
    // Orca draws what it accepts: a dropped component or prop would show up as a warning.
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})
