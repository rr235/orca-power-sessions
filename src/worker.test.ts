import { assert, test } from 'orca/testing'
import { agentPanes, orderLikeSidebar, parseProjects, parseSessions, terminalAlive, terminalByTitle, terminalOfPane, terminalOfProcess, terminalServing, workspaceRanks } from './overview'
import type { Project, QuickAction } from './protocol'
import { linkProjects, listenerPids, portOf, printedUrl, processTerminal, saveAction, storedActions, terminalTail, terminalTitle } from './servers'
import { handleOf } from './worker'
import { compactProblem, operationId, payloadFingerprint, runFailure, runtimeClientPath } from './chats'

test('finds Orca\'s runtime client in its new or old place, and says briefly why a run failed', () => {
  const has = (...paths: string[]) => (path: string) => paths.includes(path)
  assert.equal(runtimeClientPath('/u', has('/u/out/cli/runtime/client.js', '/u/out/cli/runtime-client.js')), '/u/out/cli/runtime/client.js', 'the new place first')
  assert.equal(runtimeClientPath('/u', has('/u/out/cli/runtime-client.js')), '/u/out/cli/runtime-client.js', 'an older Orca')
  assert.throws(() => runtimeClientPath('/u', has()), /runtime client somewhere the plugin does not know/)
  const stderr = "node:internal/modules/cjs/loader:1575\n  throw err;\n  ^\n\nError: Cannot find module '/x/client.js'\nRequire stack:\n- /[eval]"
  assert.equal(runFailure(stderr, new Error('Command failed: Orca -e const [request] = ...')), "Orca's runtime could not run the request: Error: Cannot find module '/x/client.js'.")
  assert.equal(runFailure('', Object.assign(new Error('x'), { killed: true })), "Orca's runtime could not run the request: it timed out.")
  assert.equal(runFailure('', new Error('x')), "Orca's runtime could not run the request: it exited without an answer.")
})
import { focusProblem, selectedOf } from './tabs'
import { tabOfPane } from './overview'

test('finds the tab of a session and reads the focus answer', () => {
  assert.deepEqual(tabOfPane('structured-agent-session-claude_abc_123:leaf-1'), { tabId: 'agent-session:claude_abc_123' })
  assert.deepEqual(tabOfPane('tab-1:leaf-1'), { tabId: 'tab-1', leafId: 'leaf-1' })
  assert.equal(tabOfPane('w1#0'), null, 'a session without a pane has no tab')
  assert.equal(focusProblem(JSON.stringify({ ok: true })), null)
  assert.equal(focusProblem(JSON.stringify({ error: { code: 'runtime_error', message: 'tab_not_found' } })), 'Orca has no open tab for this session.')
  assert.equal(focusProblem(JSON.stringify({ error: { code: 'method_not_found', message: 'x' } })), 'This Orca build cannot focus a tab from a plugin.')
  assert.equal(focusProblem(''), 'Orca gave no readable answer.')
})

test('reads the focused workspace and the tab Orca shows in it', () => {
  // The runtime names a terminal tab by tab and leaf, a chat by its session; other tabs match no session.
  const answer = (activeTabId: string | null) => JSON.stringify({ worktree: 'r1::/c/kb', activeTabId })
  assert.deepEqual(selectedOf(answer('tab-1::leaf-1')), { worktreeId: 'r1::/c/kb', tabId: 'tab-1' })
  assert.deepEqual(selectedOf(answer('agent-session:claude_abc')), { worktreeId: 'r1::/c/kb', tabId: 'agent-session:claude_abc' })
  assert.deepEqual(selectedOf(answer(null)), { worktreeId: 'r1::/c/kb', tabId: null })
  assert.equal(selectedOf('null'), null, 'no workspace is focused')
  assert.equal(selectedOf(JSON.stringify({ error: { code: 'method_not_found', message: 'x' } })), null)
  assert.equal(selectedOf(''), null)
})

test('signs a chat compact the way Orca does, and reads its answer', () => {
  // The digest Orca's own structuredAgentSessionPayloadFingerprint gives for the same input.
  assert.equal(payloadFingerprint('claude_abc', { command: 'compact' }), 'afd403551720ff3808cf6e85767d1c8fae1a6dba8a2f22b99bf8ff3a43495d78')
  assert.match(operationId(1794251032095), /^1794251032095-[0-9a-f]{32}$/)
  const answer = (result: unknown) => JSON.stringify({ answer: result })
  assert.equal(compactProblem(answer({ ok: true, value: { command: 'compact', state: 'completed' } })), null)
  assert.equal(compactProblem(answer({ ok: true, value: { state: 'unknown' } })), 'Orca could not confirm the compact.')
  assert.equal(compactProblem(answer({ ok: true, value: { state: 'completed', error: 'The command was not run.' } })), 'The command was not run.')
  assert.equal(compactProblem(answer({ ok: true, value: { state: 'unknown', error: 'The command has not started yet.' } })), 'The command has not started yet.')
  assert.equal(compactProblem(answer({ ok: false, refusal: { code: 'agent_session_operation_invalid', reason: 'turnActive' } })), 'The chat is working: compact it once the turn ends.')
  assert.equal(compactProblem(JSON.stringify({ error: { code: 'method_not_found', message: 'x' } })), 'This Orca build cannot compact chats from a plugin.')
  assert.equal(compactProblem(JSON.stringify({ error: { code: 'x', message: 'agent_session_identity_required' } })), 'Orca has no chat with this session id.')
  assert.equal(compactProblem(''), 'Orca gave no readable answer.')
})

const PROJECTS = JSON.stringify({
  result: {
    projects: [
      { id: 'github:rr235/blog', displayName: 'Personal Blog', providerIdentity: { owner: 'rr235', repo: 'blog' }, sourceRepoIds: ['r-blog'] },
      { id: 'github:acme/x', displayName: 'Acme', providerIdentity: { owner: 'acme', repo: 'x' }, sourceRepoIds: ['r-x'] }
    ]
  }
})
const REPOS = JSON.stringify({ result: { repos: [{ id: 'r-blog', path: '/c/blog' }] } })
const PS = JSON.stringify({
  result: {
    worktrees: [
      {
        worktreeId: 'r-blog::/c/blog',
        repoId: 'r-blog',
        displayName: 'main',
        status: 'active',
        agents: [
          { paneKey: 'a', agentType: 'claude', state: 'done', hasLivePty: true, conversationName: 'Old', stateStartedAt: 1 },
          { paneKey: 'b', agentType: 'codex', state: 'working', hasLivePty: null, prompt: 'Fix   the build', stateStartedAt: 2 },
          { paneKey: 'c', agentType: 'claude', state: 'done', hasLivePty: false, stateStartedAt: 3 }
        ]
      },
      { worktreeId: 'r-x::/c/x', repoId: 'r-x', displayName: 'feat', status: 'inactive', agents: [{ paneKey: 'd', agentType: 'claude', state: 'done', conversationName: 'Sleeping chat' }] }
    ]
  }
})

test('lists live sessions by title, sleeping workspaces included', () => {
  const sessions = parseSessions(PS, PROJECTS)
  assert.deepEqual(
    sessions.map((s) => [s.key, s.title, s.state, s.agentIcon]),
    [
      ['b', 'Fix the build', 'working', 'assets/agents/codex.png'],
      ['a', 'Old', 'done', 'assets/agents/claude.png'],
      ['d', 'Sleeping chat', 'done', 'assets/agents/claude.png']
    ]
  )
})

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

test('orders sessions like Orca\'s sidebar, by workspace and then tab position', () => {
  const sessions = parseSessions(PS, PROJECTS)
  // Within a workspace, `b` has no stored position, so it follows `a`.
  assert.deepEqual(orderLikeSidebar(sessions, new Map(), new Map([['a', 2]])).map((s) => s.key), ['a', 'b', 'd'])
  // The newer workspace comes first, its sessions together.
  const ranks = new Map([['r-x::/c/x', 0], ['r-blog::/c/blog', 1]])
  assert.deepEqual(orderLikeSidebar(sessions, ranks, new Map([['a', 2], ['b', 5]])).map((s) => s.key), ['d', 'a', 'b'])
  // The highest manual order, else sort order, first; a tie by name; a workspace with neither last.
  const ps = JSON.stringify({
    result: {
      worktrees: [
        { worktreeId: 'old', displayName: 'old', sortOrder: 10 },
        { worktreeId: 'none', displayName: 'none' },
        { worktreeId: 'manual', displayName: 'manual', manualOrder: 15, sortOrder: 99 },
        { worktreeId: 'new', displayName: 'new', sortOrder: 20 },
        { worktreeId: 'also-new', displayName: 'also-new', sortOrder: 20 }
      ]
    }
  })
  assert.deepEqual([...workspaceRanks(ps).keys()], ['also-new', 'new', 'manual', 'old', 'none'])
})

test('lists projects in Orca order with paths, live agent and worktree counts', () => {
  const ps = JSON.stringify({
    result: { worktrees: [...JSON.parse(PS).result.worktrees, { worktreeId: 'r-blog::/c/blog-draft', repoId: 'r-blog', displayName: 'draft', agents: [] }] }
  })
  const projects = parseProjects(PROJECTS, REPOS, parseSessions(PS, PROJECTS), ps)
  assert.deepEqual(
    projects.map((p) => [p.name, p.path, p.repoIds, p.agents, p.worktrees]),
    [
      ['Personal Blog', '/c/blog', ['r-blog'], 2, 2],
      ['Acme', null, ['r-x'], 1, 1]
    ]
  )
})

test('finds server terminals by handle or title', () => {
  const a = { id: 'a', name: 'Dev' }
  const b = { id: 'b', name: 'Dev' }
  const terminals = JSON.stringify({
    result: { terminals: [{ handle: 'term_1', title: terminalTitle(a), worktreePath: '/c/a', connected: true }, { handle: 'term_2', title: 'x', worktreePath: '/c/a', connected: false }] }
  })
  assert.equal(terminalByTitle(terminals, terminalTitle(a), '/c/a'), 'term_1')
  assert.equal(terminalByTitle(terminals, terminalTitle(b), '/c/a'), null, 'duplicate names never share a terminal')
  assert.equal(terminalByTitle(terminals, terminalTitle(a), '/c/b'), null, 'moving a project rejects the old terminal title')
  assert.equal(terminalAlive(terminals, 'term_1', '/c/a'), true)
  assert.equal(terminalAlive(terminals, 'term_1', '/c/b'), false, 'moving a project rejects its saved handle')
  assert.equal(terminalAlive(terminals, 'term_2', '/c/a'), false)
  assert.equal(handleOf('{"result":{"terminal":{"handle":"term_abc-1"}}}'), 'term_abc-1')
})

test('finds the address a dev server printed, preferring its Local line', () => {
  // Vite, after another service printed its own address first.
  assert.equal(printedUrl(['Supabase API URL: http://127.0.0.1:54321', '  ➜  Local:   http://localhost:5173/', '  ➜  Network: use --host']), 'http://localhost:5173')
  // Without a Local line, the last address printed.
  assert.equal(printedUrl(['db on http://127.0.0.1:54322', 'ready on http://0.0.0.0:3100.']), 'http://localhost:3100')
  assert.equal(printedUrl(['compiling...']), null)
  assert.equal(portOf('http://demo.localhost:3100'), 3100)
  assert.equal(portOf('https://example.com:3100'), null, 'a remote address is never probed on localhost')
  assert.equal(portOf(null), null)
  assert.deepEqual(terminalTail('{"result":{"terminal":{"tail":["a","b"]}}}'), ['a', 'b'])
  assert.deepEqual(terminalTail('not json'), [])
})

const PROJECT_LIST: Project[] = [
  { id: 'p-web', name: 'Web', repo: 'o/web', path: '/c/web', repoIds: [], agents: 0, worktrees: 1 },
  { id: 'p-api', name: 'API', repo: 'o/api', path: '/c/api', repoIds: [], agents: 0, worktrees: 1 },
  { id: 'p-cloud', name: 'Cloud only', repo: 'o/cloud', path: null, repoIds: [], agents: 0, worktrees: 1 }
]
const WEB: QuickAction = { id: 'web', name: 'Web', command: 'bun run dev', projectId: null, path: '/c/web', url: 'http://localhost:3000' }

test('links stored actions to the project of their folder', () => {
  assert.equal(linkProjects([WEB], PROJECT_LIST)[0].projectId, 'p-web')
  assert.equal(linkProjects([{ ...WEB, path: '/elsewhere' }], PROJECT_LIST)[0].projectId, null)
  assert.equal(storedActions(undefined), null)
  assert.deepEqual(storedActions([WEB, { id: 1 }]), [WEB])
})

test('saves a new or changed action, forgetting what no longer holds', () => {
  const linked = linkProjects([WEB], PROJECT_LIST)
  const added = saveAction(linked, { name: ' Docs ', command: 'bun run docs', projectId: 'p-api' }, PROJECT_LIST, 'docs-1')
  assert.deepEqual(added[1], { id: 'docs-1', name: 'Docs', command: 'bun run docs', projectId: 'p-api', path: '/c/api', url: null })
  // A new name keeps the address.
  const renamed = saveAction(linked, { id: 'web', name: 'Site', command: 'bun run dev', projectId: 'p-web' }, PROJECT_LIST, 'x')[0]
  assert.deepEqual([renamed.name, renamed.url], ['Site', 'http://localhost:3000'])
  // A new command or project forgets the address.
  assert.equal(saveAction(linked, { id: 'web', name: 'Web', command: 'bun run start', projectId: 'p-web' }, PROJECT_LIST, 'x')[0].url, null)
  const moved = saveAction(linked, { id: 'web', name: 'Web', command: 'bun run dev', projectId: 'p-api' }, PROJECT_LIST, 'x')[0]
  assert.deepEqual([moved.path, moved.url], ['/c/api', null])
  // A typed address wins, even over a new command; an empty one means read it at the next Run.
  const typed = saveAction(linked, { id: 'web', name: 'Web', command: 'bun run start', projectId: 'p-web', url: 'localhost:4000/' }, PROJECT_LIST, 'x')[0]
  assert.equal(typed.url, 'http://localhost:4000')
  assert.equal(saveAction(linked, { id: 'web', name: 'Web', command: 'bun run dev', projectId: 'p-web', url: ' ' }, PROJECT_LIST, 'x')[0].url, null)
  assert.equal(saveAction(linked, { name: 'New', command: 'x', projectId: 'p-web', url: 'https://app.localhost:3100/a/' }, PROJECT_LIST, 'n')[1].url, 'https://app.localhost:3100/a')
  assert.throws(() => saveAction(linked, { name: 'Web', command: 'x', projectId: 'p-web', url: 'ftp://x' }, PROJECT_LIST, 'x'))
  assert.throws(() => saveAction(linked, { name: 'Web', command: ' ', projectId: 'p-web' }, PROJECT_LIST, 'x'))
  assert.throws(() => saveAction(linked, { name: 'Web', command: 'x', projectId: 'p-cloud' }, PROJECT_LIST, 'x'))
})

test('reads a server process and the terminal it was started in', () => {
  assert.deepEqual(listenerPids('12320\n12320\n\n1\n'), [12320], 'once each, never launchd')
  assert.deepEqual(listenerPids(''), [])
  const shell = '27643 ttys004 bun run kb:ui --dev TERM=xterm ORCA_TAB_ID=tab1 ORCA_TERMINAL_HANDLE=term_old ORCA_PANE_KEY=tab1:leaf1 HOME=/u'
  assert.deepEqual(processTerminal(`  ${shell}\n`), { ppid: 27643, detached: false, paneKey: 'tab1:leaf1', handle: 'term_old' })
  assert.deepEqual(processTerminal('12318 ttys004 node scripts/serve.mjs --dev'), { ppid: 12318, detached: false, paneKey: null, handle: null }, 'a clean environment')
  assert.equal(processTerminal('1 ?? node pm2').detached, true, 'a macOS daemon')
  assert.equal(processTerminal('1 ? node pm2').detached, true, 'a Linux daemon')
  assert.equal(processTerminal('1 ?? /sbin/launchd').ppid, null, 'the walk ends at launchd')
  assert.equal(processTerminal('5 ttys001 echo xORCA_PANE_KEY=tab9:leaf9').paneKey, null, 'only a whole variable counts')
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
