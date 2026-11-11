// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import { DEMO, DEMO_USAGE, DEMO_WORKTREES } from './fixtures'
import * as panel from './panel'

test('shows servers, sessions and projects, and starts a server', async () => {
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
      'session.selected': () => ({ worktreeId: 'r2::/w/kb', tabId: 'p2' })
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
    // A running server ends with its terminal, then open, then a green dot; open goes to the default browser.
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
    // The row toggles details; the terminal button at the right shows the session's tab.
    const row = (title: string) => ({ type: 'ListItem', text: new RegExp(title) }) as const
    assert.equal(view.find({ type: 'IconButton', label: /details of/ }), null, 'no chevron')
    // Orca shows the chat's tab, so its title is in normal text with its details closed.
    const title = (text: string) => view.find({ type: 'Text', text })?.props.muted
    assert.equal(title('Review search ranking change'), false, 'the tab Orca shows')
    assert.equal(title('Draft post layout'), true, 'a tab Orca does not show')
    await view.press({ type: 'ListItem', text: /Onboarding checklist for new tenants/ })
    assert.deepEqual(focused, [], 'pressing the title leaves Orca on its tab')
    assert.ok(view.find({ text: /^Opus 5\.5,\s*High$/ }), 'pressing the title opens the details')
    assert.equal(title('Onboarding checklist for new tenants'), true, 'open details leave a tab Orca does not show muted')
    const line = view.find(row('Onboarding checklist for new tenants'))
    const tab = view.find({ type: 'IconButton', label: 'Show Onboarding checklist for new tenants tab' })
    assert.ok(line && tab && line.path < tab.path && tab.props.icon === 'terminal', 'a terminal button after the title')
    assert.equal(tab?.props.variant, 'solid', 'the terminal button is solid')
    assert.equal(tab?.props.tone, 'success', 'the terminal button is green')
    await view.press(tab as never)
    assert.deepEqual(focused, ['p1 /w/platform'], 'the terminal button shows its tab in Orca')
    assert.equal(title('Review search ranking change'), true, 'the pressed session is the one shown now')
    await view.press({ type: 'ListItem', text: /Onboarding checklist for new tenants/ })
    assert.equal(view.find({ text: /^Opus 5\.5,\s*High$/ }), null, 'pressing the title again closes the details')
    await view.press({ type: 'ListItem', text: /Onboarding checklist for new tenants/ })
    assert.deepEqual(focused, ['p1 /w/platform'], 'title presses never focus the session')
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
    assert.ok(view.find({ type: 'Spinner' }), 'working spinner')
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
    await view.press(row('Onboarding checklist for new tenants'))
    assert.equal(view.find({ text: /^Opus 5\.5,\s*High$/ }), null)
    assert.equal(focused.length, 1, 'the row does not change the tab')
    // The quick action closes every open card.
    await view.press(row('Onboarding checklist for new tenants'))
    assert.ok(view.find({ text: 'issue-212-onboarding' }), 'details open again')
    await view.press(view.find({ label: 'Collapse all session details' }) as never)
    assert.equal(view.find({ text: 'issue-212-onboarding' }), null, 'the details close')
    // Before any compaction there is no since line, and the total turns take the colour, none up to 20.
    await view.press(row('Review search ranking change'))
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
    await view.press({ type: 'ListItem', text: /Review search ranking change/ })
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
    await view.press({ type: 'ListItem', text: /Onboarding checklist for new tenants/ })
    await view.press({ type: 'ListItem', text: /Review search ranking change/ })
    assert.deepEqual(host.data().storage.expanded, { p2: true }, 'each change is stored at once')
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

test('groups a project\'s sessions by worktree when it has more than one', async () => {
  assert.deepEqual(
    panel.byWorktree(DEMO_WORKTREES.sessions.filter((s) => s.projectId === 'github:mountin-io/platform')).map((w) => [w.name, w.sessions.map((s) => s.key)]),
    [
      ['issue-212-onboarding', ['p1', 'p5']],
      ['main', ['p4']]
    ],
    'in the order of each worktree\'s first session'
  )
  const host = mockHost({ requests: { 'overview.load': () => DEMO_WORKTREES, 'session.usage': () => ({}) } })
  const view = await mount(panel, { host })
  try {
    // Paths hold keys, so the order on screen is the order findAll returns.
    const texts = view.findAll({ type: 'Text' }).map((node) => node.text)
    const order = ['issue-212-onboarding', 'Onboarding checklist for new tenants', 'Review onboarding copy', 'main', 'Release notes for 0.4', 'Planner']
    // From the Platform project, which follows Personal Blog's session.
    const platform = texts.slice(texts.indexOf('Draft post layout'))
    assert.deepEqual(platform.filter((text) => order.includes(text as string)), order,'a header per worktree with sessions, its sessions under it')
    // Personal Blog has two worktrees with a session in one; the session outside every project has one.
    const before = (title: string) => texts[texts.indexOf(title) - 1]
    assert.equal(before('Draft post layout'), 'main', 'a header even when only one worktree has sessions')
    assert.equal(before('Review search ranking change'), 'mountin-knowledge-base', 'a project with one worktree has no header')
    // The details show the session's branch with the branch icon, not its worktree's name again.
    await view.press({ type: 'ListItem', text: /Release notes for 0\.4/ })
    assert.ok(view.find({ type: 'Text', text: 'release/0.4' }), 'the branch')
    assert.ok(view.find({ type: 'Image', alt: 'Branch' } as never), 'the branch icon')
    assert.equal(view.findAll({ type: 'Text', text: 'main' }).length, 2, 'the worktree name only in its header')
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
    await view.press({ type: 'ListItem', text: /Review search ranking change/ })
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
  const open = async (title: RegExp, want: string[]) => {
    const pressing = view.press({ type: 'ListItem', text: title })
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
    let answer = await open(/Onboarding checklist for new tenants/, ['Loading model', 'Loading context', 'Loading turns', 'Loading title'])
    for (const text of ['active', 'issue-212-onboarding', '#212', '#215']) {
      assert.ok(view.find({ text }), `shows ${text} while loading`)
    }
    assert.equal(view.find({ text: 'Claude' }), null, 'no agent name standing in for the model')
    await answer()
    assert.deepEqual(labels(), [])
    assert.ok(view.find({ text: /^Opus 5\.5,\s*High$/ }))
    assert.ok(view.find({ text: 'Tenant invite emails' }))
    // A session without pull requests has no title to wait for.
    answer = await open(/Review search ranking change/, ['Loading model', 'Loading context', 'Loading turns'])
    await answer()
    assert.deepEqual(labels(), [])
  } finally {
    await view.unmount()
  }
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
  // Editing hides nothing: the sessions and the servers stay, under the same titles.
  const allInView = () => {
    // Sessions is a plain title; Quick actions sit under it, at the bottom, under a header of the panel's own.
    assert.equal(view.find({ type: 'Collapsible' }), null)
    const sessions = view.find({ type: 'Text', text: 'Sessions' })
    const quick = view.find({ type: 'Text', text: 'Quick actions' })
    assert.ok(sessions && quick && sessions.path < quick.path, 'Sessions above Quick actions')
    const line = view.findAll({ type: 'Separator' } as never).filter((s) => s.path < quick.path && !quick.path.startsWith(s.path))
    assert.ok(line.some((s) => s.path > sessions.path), 'a separator between Sessions and Quick actions')
    assert.ok(view.find({ label: 'Run Primer' }), 'the servers stay')
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
    assert.equal(view.find({ label: 'Run Primer' }), null, 'closed: no servers')
    assert.ok(view.findAll({ type: 'Text', text: '●' }).some((d) => d.props.tone === 'success' && d.path > (header()?.path ?? '')), 'the dot stays while closed')
    await view.press(header() as never)
    allInView()
    // Run comes first in a server's row.
    const run = view.find({ label: 'Run Primer' })
    const primerName = view.find({ type: 'Text', text: 'Primer' })
    assert.ok(run && primerName && run.path < primerName.path, 'Run comes before the name')
    const icons = view.findAll({ type: 'Image' }).length
    // The Sessions title carries the smallest minus button, which closes every session's details.
    const collapse = view.find({ type: 'IconButton', label: 'Collapse all session details' })
    assert.equal(collapse?.props.icon, 'remove', 'a minus')
    assert.equal(collapse?.props.size, 'xs')
    // Add action sits under the servers, and opens its form right there.
    const addLine = view.find({ type: 'Text', text: 'Add action' })
    const lastServer = view.find({ label: 'Run Blog' })
    assert.ok(addLine && lastServer && lastServer.path < addLine.path, `Add action under the servers: ${lastServer?.path} ${addLine?.path}`)
    // Styled like Collapse all session details: muted text, then its plus button.
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
    assert.equal(view.find({ type: 'Textarea', label: 'Command' } as never)?.props.placeholder, 'npm run dev')
    assert.equal(view.find({ type: 'Input', label: 'URL' } as never)?.props.placeholder, 'URL (optional)')
    const note = view.find({ type: 'Text', text: /^The command runs in the project's main checkout\./ })
    assert.ok(note && heading && heading.path < note.path, 'the note sits under the title')
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
    for (const type of ['Select', 'Input', 'Textarea']) {
      assert.equal(view.find({ type } as never)?.props.labelHidden, true, `${type} label hidden`)
    }
    const form = view.find({ type: 'Select', label: 'Project' } as never)
    assert.ok(form && form.path < (nameInput()?.path ?? ''), `project before name: ${form?.path} ${nameInput()?.path}`)
    await view.press({ type: 'Button', text: 'Add +' })
    assert.ok(view.find({ text: 'Choose a project.' }))
    await view.select({ type: 'Select', label: 'Project' } as never, 'github:rr235/blog')
    await view.type({ type: 'Input', label: 'Name' } as never, 'Docs')
    await view.press({ type: 'Button', text: 'Add +' })
    assert.ok(view.find({ text: 'Give it a command.' }))
    assert.equal(saved.length, 0)
    await view.type({ type: 'Textarea', label: 'Command' } as never, 'bun run docs')
    // The URL comes under the command, is optional, and must be a web address when given.
    const url = view.find({ type: 'Input', label: 'URL' } as never)
    const command = view.find({ type: 'Textarea', label: 'Command' } as never)
    assert.ok(url && command && command.path < url.path, 'URL under the command')
    assert.equal(url?.props.labelHidden, true)
    assert.equal(view.findAll({ type: 'Image' }).length, icons, 'choosing a project shows no icon in the form')
    await view.type({ type: 'Input', label: 'URL' } as never, 'ftp://x')
    await view.press({ type: 'Button', text: 'Add +' })
    assert.ok(view.find({ text: 'Give it a web address, such as localhost:3000.' }))
    assert.equal(saved.length, 0)
    await view.type({ type: 'Input', label: 'URL' } as never, 'localhost:4000', { replace: true })
    await view.press({ type: 'Button', text: 'Add +' })
    assert.deepEqual(saved, [{ name: 'Docs', command: 'bun run docs', projectId: 'github:rr235/blog', url: 'localhost:4000' }])
    assert.equal(nameInput(), null, 'saving closes the form')
    saved.length = 0

    // A stopped server's row ends with an edit button; a running one has none, and there is no Edit quick actions.
    assert.equal(view.find({ label: 'Edit quick actions' }), null)
    assert.equal(view.find({ label: 'Edit Platform' }), null, 'Platform is running')
    const editPrimer = view.find({ label: 'Edit Primer' })
    assert.ok(editPrimer && (view.find({ label: 'Run Primer' })?.path ?? '') < editPrimer.path, 'edit sits at the right of the row')

    // Its form opens where the add form does, above Add action, and the row's button closes it.
    await view.press(view.find({ label: 'Edit Primer' }) as never)
    allInView()
    assert.equal(nameInput()?.props.value, 'Primer')
    // Titled Edit action, and the Add action line under it reads Edit action while it is open.
    const editTitles = view.findAll({ type: 'Text', text: 'Edit action' })
    assert.equal(editTitles.length, 2, 'the title and the line under the form')
    assert.equal(editTitles[0].props.size, 'sm')
    assert.equal(view.find({ type: 'Text', text: 'Add action' }), null)
    assert.ok((nameInput()?.path ?? '') < editTitles[1].path, 'the form sits above the line')
    assert.ok(view.find({ label: 'Close Primer' }), 'the row can close its form')
    assert.equal(view.find({ type: 'IconButton', label: 'Edit action' })?.props.icon, 'close', 'the line closes it too')
    assert.equal(view.find({ type: 'IconButton', label: 'Edit action' })?.props.tooltip, 'Close edit action')
    assert.equal(view.find({ label: 'Close Primer' })?.props.tooltip, 'Close edit action')
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
    assert.deepEqual(saved, [{ name: 'Primer docs', command: 'bun run dev:primer', projectId: 'github:rr235/blog', url: 'http://localhost:3200', id: 'primer' }])
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
