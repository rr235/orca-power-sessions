import { assert, test } from 'orca/testing'
import type { Project, QuickAction } from '../protocol'
import { linkProjects, listenerPids, listenersInFolder, portOf, printedUrl, orcaVariables, processFolders, processParent, relearnedUrl, saveAction, storedActions } from './rules'
import { runCommand } from '../shared'

test('finds the address a dev server printed, preferring its Local line', () => {
  // Vite, after another service printed its own address first.
  assert.equal(printedUrl(['Supabase API URL: http://127.0.0.1:54321', '  ➜  Local:   http://localhost:5173/', '  ➜  Network: use --host']), 'http://localhost:5173')
  // Without a Local line, the last address printed.
  assert.equal(printedUrl(['db on http://127.0.0.1:54322', 'ready on http://0.0.0.0:3100.']), 'http://localhost:3100')
  assert.equal(printedUrl(['compiling...']), null)
  // A rerun in the same terminal: its Local line comes last.
  assert.equal(printedUrl(['  ➜  Local:   http://localhost:3410/', 'stopped', '  ➜  Local:   http://localhost:3411/']), 'http://localhost:3411')
  // A start's printed address replaces the stored one only when the port moved.
  assert.equal(relearnedUrl('http://demo.localhost:3100', 'http://localhost:3100'), 'http://demo.localhost:3100')
  assert.equal(relearnedUrl('http://127.0.0.1:3410/concepts', 'http://localhost:3410'), 'http://127.0.0.1:3410/concepts')
  assert.equal(relearnedUrl('http://localhost:3410', 'http://localhost:3411'), 'http://localhost:3411', 'the port was taken, so it moved')
  assert.equal(relearnedUrl(null, 'http://localhost:5173'), 'http://localhost:5173')
  assert.equal(portOf('http://demo.localhost:3100'), 3100)
  assert.equal(portOf('https://example.com:3100'), null, 'a remote address is never probed on localhost')
  assert.equal(portOf(null), null)
})

const PROJECT_LIST: Project[] = [
  { id: 'p-web', name: 'Web', repo: 'o/web', path: '/c/web', repoIds: [], agents: 0 },
  { id: 'p-api', name: 'API', repo: 'o/api', path: '/c/api', repoIds: [], agents: 0 },
  { id: 'p-cloud', name: 'Cloud only', repo: 'o/cloud', path: null, repoIds: [], agents: 0 }
]
const WEB: QuickAction = { id: 'web', name: 'Web', steps: ['bun run dev'], command: 'bun run dev', projectId: null, path: '/c/web', url: 'http://localhost:3000' }

test('links stored actions to the project of their folder', () => {
  assert.equal(linkProjects([WEB], PROJECT_LIST)[0].projectId, 'p-web')
  assert.equal(linkProjects([{ ...WEB, path: '/elsewhere' }], PROJECT_LIST)[0].projectId, null)
  assert.equal(storedActions(undefined), null)
  assert.deepEqual(storedActions([WEB, { id: 1 }, { id: 'x', name: 'X', path: '/c/x', steps: [] }]), [WEB])
})

test('reads an action stored with one command as that one step, and runs steps in order', () => {
  const { steps, ...rest } = WEB
  const legacy = { ...rest, command: 'bun run dev\nbun run docs' }
  assert.deepEqual(storedActions([legacy]), [{ ...legacy, steps: ['bun run dev\nbun run docs'] }], 'kept as typed')
  assert.equal(runCommand(['bun run dev']), 'bun run dev', 'one step runs as typed')
  assert.equal(runCommand(['bun install', 'bun run dev']), 'bun install && bun run dev')
  // Saved unchanged, a legacy action keeps the address it learned.
  const read = linkProjects(storedActions([rest]) ?? [], PROJECT_LIST)
  assert.deepEqual(read[0].steps, steps)
  const same = saveAction(read, { id: 'web', name: 'Web', steps: [' bun run dev '], projectId: 'p-web', url: 'http://localhost:3000' }, PROJECT_LIST, 'x')[0]
  assert.deepEqual([same.steps, same.url], [['bun run dev'], 'http://localhost:3000'])
})

test('stores steps with their command, so a version before steps still reads them', () => {
  const two = saveAction([WEB], { id: 'web', name: 'Web', steps: ['bun install', 'bun run dev'], projectId: 'p-web' }, PROJECT_LIST, 'x')[0]
  assert.equal(two.command, 'bun install && bun run dev')
  assert.deepEqual(storedActions([two]), [two], 'read back as saved')
  // A version before steps changed the command and kept the old steps: the command wins.
  assert.deepEqual(storedActions([{ ...two, command: 'bun run start' }])?.[0].steps, ['bun run start'])
})

test('saves steps without empty ones, and new steps forget a printed address', () => {
  const linked = linkProjects([WEB], PROJECT_LIST)
  const two = saveAction(linked, { id: 'web', name: 'Web', steps: ['bun install', ' ', 'bun run dev'], projectId: 'p-web' }, PROJECT_LIST, 'x')[0]
  assert.deepEqual([two.steps, two.url], [['bun install', 'bun run dev'], null])
  const reordered = saveAction([{ ...two, url: 'http://localhost:3000' }], { id: 'web', name: 'Web', steps: ['bun run dev', 'bun install'], projectId: 'p-web' }, PROJECT_LIST, 'x')[0]
  assert.equal(reordered.url, null, 'a new order is a new command')
  assert.throws(() => saveAction(linked, { name: 'Web', steps: [' ', ''], projectId: 'p-web' }, PROJECT_LIST, 'x'))
  assert.throws(() => saveAction(linked, { name: 'Web', steps: [], projectId: 'p-web' }, PROJECT_LIST, 'x'))
})

test('saves a new or changed action, forgetting what no longer holds', () => {
  const linked = linkProjects([WEB], PROJECT_LIST)
  const added = saveAction(linked, { name: ' Docs ', steps: ['bun run docs'], projectId: 'p-api' }, PROJECT_LIST, 'docs-1')
  assert.deepEqual(added[1], { id: 'docs-1', name: 'Docs', steps: ['bun run docs'], command: 'bun run docs', projectId: 'p-api', path: '/c/api', url: null, urlTyped: false })
  // A new name keeps the address.
  const renamed = saveAction(linked, { id: 'web', name: 'Site', steps: ['bun run dev'], projectId: 'p-web' }, PROJECT_LIST, 'x')[0]
  assert.deepEqual([renamed.name, renamed.url], ['Site', 'http://localhost:3000'])
  // A new command or project forgets the address.
  assert.equal(saveAction(linked, { id: 'web', name: 'Web', steps: ['bun run start'], projectId: 'p-web' }, PROJECT_LIST, 'x')[0].url, null)
  const moved = saveAction(linked, { id: 'web', name: 'Web', steps: ['bun run dev'], projectId: 'p-api' }, PROJECT_LIST, 'x')[0]
  assert.deepEqual([moved.path, moved.url], ['/c/api', null])
  // A typed address wins, even over a new command; an empty one means read it at the next Run.
  const typed = saveAction(linked, { id: 'web', name: 'Web', steps: ['bun run start'], projectId: 'p-web', url: 'localhost:4000/' }, PROJECT_LIST, 'x')[0]
  assert.deepEqual([typed.url, typed.urlTyped], ['http://localhost:4000', true])
  // The form sends back the address it showed: a printed one stays printed, so the next Run learns it again.
  const shown = saveAction(linked, { id: 'web', name: 'Site', steps: ['bun run dev'], projectId: 'p-web', url: 'http://localhost:3000' }, PROJECT_LIST, 'x')[0]
  assert.deepEqual([shown.url, shown.urlTyped], ['http://localhost:3000', false])
  const rerun = saveAction(linked, { id: 'web', name: 'Web', steps: ['bun run start'], projectId: 'p-web', url: 'http://localhost:3000' }, PROJECT_LIST, 'x')[0]
  assert.equal(rerun.url, null, 'a printed address shown back still goes with a new command')
  const kept = saveAction([typed], { id: 'web', name: 'Web', steps: ['bun run dev'], projectId: 'p-web', url: 'http://localhost:4000' }, PROJECT_LIST, 'x')[0]
  assert.deepEqual([kept.url, kept.urlTyped], ['http://localhost:4000', true], 'a typed one stays typed, even with a new command')
  assert.equal(saveAction(linked, { id: 'web', name: 'Web', steps: ['bun run dev'], projectId: 'p-web', url: ' ' }, PROJECT_LIST, 'x')[0].url, null)
  assert.equal(saveAction(linked, { name: 'New', steps: ['x'], projectId: 'p-web', url: 'https://app.localhost:3100/a/' }, PROJECT_LIST, 'n')[1].url, 'https://app.localhost:3100/a')
  assert.throws(() => saveAction(linked, { name: 'Web', steps: ['x'], projectId: 'p-web', url: 'ftp://x' }, PROJECT_LIST, 'x'))
  assert.throws(() => saveAction(linked, { name: 'Web', steps: [' '], projectId: 'p-web' }, PROJECT_LIST, 'x'))
  assert.throws(() => saveAction(linked, { name: 'Web', steps: ['x'], projectId: 'p-cloud' }, PROJECT_LIST, 'x'))
})

test('saves one character or emoji as an action icon, keeps it unless sent, and removes an empty one', () => {
  const linked = linkProjects([WEB], PROJECT_LIST)
  const add = (icon: string) => saveAction(linked, { name: 'Docs', steps: ['x'], projectId: 'p-web', icon }, PROJECT_LIST, 'd')[1].icon
  assert.equal(add(' K '), 'K')
  for (const emoji of ['🚀', '👍🏽', '🇮🇳', '👨‍👩‍👧']) {
    assert.equal(add(emoji), emoji, `${emoji} is one character`)
  }
  assert.equal(add(''), undefined)
  assert.throws(() => add('KB'), /one character or emoji/)
  assert.throws(() => add('🚀🚀'), /one character or emoji/)
  const withIcon = saveAction(linked, { id: 'web', name: 'Web', steps: ['bun run dev'], projectId: 'p-web', icon: '🌐' }, PROJECT_LIST, 'x')
  assert.equal(withIcon[0].icon, '🌐')
  assert.equal(saveAction(withIcon, { id: 'web', name: 'Site', steps: ['bun run dev'], projectId: 'p-web' }, PROJECT_LIST, 'x')[0].icon, '🌐', 'kept when not sent')
  assert.ok(!('icon' in saveAction(withIcon, { id: 'web', name: 'Web', steps: ['bun run dev'], projectId: 'p-web', icon: ' ' }, PROJECT_LIST, 'x')[0]), 'removed when empty')
  assert.deepEqual(storedActions(withIcon), withIcon, 'read back as saved')
})

test('reads a server process and the terminal it was started in', () => {
  assert.deepEqual(listenerPids('12320\n12320\n\n1\n'), [12320], 'once each, never launchd')
  assert.deepEqual(listenerPids(''), [])
  // Whose port it is: a listener of another service on the same port is never the action's.
  const folders = processFolders('p101\nfcwd\nn/c/kb\np102\nfcwd\nn/c/kb/apps/web\np103\nfcwd\nn/c/kb-other\n')
  assert.deepEqual([...folders], [[101, '/c/kb'], [102, '/c/kb/apps/web'], [103, '/c/kb-other']])
  assert.equal(listenersInFolder([101, 102], folders, '/c/kb'), true, 'the folder and one below it')
  assert.equal(listenersInFolder([101, 103], folders, '/c/kb'), false, 'a sibling folder with the same prefix')
  assert.equal(listenersInFolder([104], folders, '/c/kb'), false, 'a folder lsof could not read')
  assert.equal(listenersInFolder([], folders, '/c/kb'), false, 'nothing listens')
  assert.deepEqual(processParent('  27643 ttys004\n'), { ppid: 27643, detached: false })
  assert.equal(processParent('1 ??').detached, true, 'a macOS daemon')
  assert.equal(processParent('1 ?').detached, true, 'a Linux daemon')
  assert.equal(processParent('1 ??').ppid, null, 'the walk ends at launchd')
})

test('keeps only the two Orca variables from an environment', () => {
  const variables = orcaVariables(
    [
      '5 bun run kb:ui TERM=xterm HOME=/u ORCA_TERMINAL_HANDLE=term_old ORCA_PANE_KEY=tab1:leaf1 SECRET=x',
      '6 node serve.mjs HOME=/u',
      '7 echo xORCA_PANE_KEY=tab9:leaf9'
    ].join('\n')
  )
  assert.deepEqual([...variables], [
    [5, { paneKey: 'tab1:leaf1', handle: 'term_old' }],
    [6, { paneKey: null, handle: null }],
    [7, { paneKey: null, handle: null }]
  ])
})
