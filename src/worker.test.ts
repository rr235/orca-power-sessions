import { assert, test } from 'orca/testing'
import { orderLikeSidebar, parseProjects, parseSessions, terminalAlive, terminalByTitle, terminalOfPane, workspaceRanks } from './overview'
import type { Project, QuickAction } from './protocol'
import { linkProjects, portOf, printedUrl, saveAction, storedActions, terminalTail, terminalTitle } from './servers'
import { handleOf } from './worker'
import { compactProblem, operationId, payloadFingerprint } from './chats'
import { focusCandidates, focusProblem, pathOfTerminals, selectedOf } from './tabs'
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

test('finds the focused workspace and the tab Orca shows in it', () => {
  const listed = [
    { name: 'main', branch: 'main', path: '/c/kb' },
    { name: 'main', branch: 'main', path: '/c/blog' },
    { name: 'draft', branch: 'refs/heads/draft', path: '/c/blog-draft' }
  ]
  const focus = (displayName: string, branch: string, terminals: string[] = []) => ({ displayName, branch, terminals: terminals.map((id) => ({ id })) })
  assert.deepEqual(focusCandidates(focus('draft', 'draft'), listed), ['/c/blog-draft'], 'one match, with or without refs/heads/')
  assert.deepEqual(focusCandidates(focus('main', 'main'), listed), ['/c/kb', '/c/blog'], 'many workspaces are called main')
  // Among several, the one holding the focused workspace's terminals.
  const terminals = JSON.stringify({ result: { terminals: [{ handle: 'term_a', worktreePath: '/c/blog' }, { handle: 'term_b', worktreePath: '/c/kb' }] } })
  assert.equal(pathOfTerminals(terminals, ['term_b'], ['/c/kb', '/c/blog']), '/c/kb')
  assert.equal(pathOfTerminals(terminals, ['term_x'], ['/c/kb', '/c/blog']), null, 'an unknown terminal tells nothing')
  assert.equal(pathOfTerminals(terminals, ['term_a'], ['/c/kb']), null, 'a terminal outside the candidates tells nothing')
  // The runtime names a terminal tab by tab and leaf, a chat by its session; other tabs match no session.
  const answer = (activeTabId: string | null) => JSON.stringify({ worktree: 'r1::/c/kb', activeTabId })
  assert.deepEqual(selectedOf(answer('tab-1::leaf-1')), { worktreeId: 'r1::/c/kb', tabId: 'tab-1' })
  assert.deepEqual(selectedOf(answer('agent-session:claude_abc')), { worktreeId: 'r1::/c/kb', tabId: 'agent-session:claude_abc' })
  assert.deepEqual(selectedOf(answer(null)), { worktreeId: 'r1::/c/kb', tabId: null })
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
