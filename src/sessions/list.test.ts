import { assert, test } from 'orca/testing'
import { orderLikeSidebar, parseProjects, parseSessions, pullRequestsOf, workspaceRanks } from './list'

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

test('orders sessions like Orca\'s sidebar, by workspace, its sessions in the order given', () => {
  const sessions = parseSessions(PS, PROJECTS)
  assert.deepEqual(orderLikeSidebar(sessions, new Map()).map((s) => s.key), ['b', 'a', 'd'])
  // The newer workspace comes first, its sessions together.
  const ranks = new Map([['r-x::/c/x', 0], ['r-blog::/c/blog', 1]])
  assert.deepEqual(orderLikeSidebar(sessions, ranks).map((s) => s.key), ['d', 'b', 'a'])
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

test('lists projects in Orca order with paths and live agent counts', () => {
  const projects = parseProjects(PROJECTS, REPOS, parseSessions(PS, PROJECTS))
  assert.deepEqual(
    projects.map((p) => [p.name, p.path, p.repoIds, p.agents]),
    [
      ['Personal Blog', '/c/blog', ['r-blog'], 2],
      ['Acme', null, ['r-x'], 1]
    ]
  )
})

test('gives each session its own pull requests, the tracked one first', () => {
  const tracked = { number: 16, url: 'https://x/pull/16', state: 'merged', title: ' Faster ' }
  const linked = [
    { type: 'issue', number: 1 },
    { type: 'pr', number: 12, url: 'https://x/pull/12', origins: [{ tabId: 'tab-a' }] },
    { type: 'pr', number: 13, url: 'https://x/pull/13', origins: [{ tabId: 'tab-b' }] },
    { type: 'pr', number: 14, url: 'https://x/pull/14' },
    { type: 'pr', number: 16, url: 'https://x/pull/16', origins: [{ tabId: 'tab-b' }] }
  ]
  const numbers = (tab: string | null) => pullRequestsOf({ linkedPR: tracked, linkedItems: linked }, tab).map((pr) => pr.number)
  // The tracked pull request was seen only in tab-b, so it is tab-b's alone, as any other link.
  assert.deepEqual(numbers('tab-a'), [12, 14])
  assert.deepEqual(numbers('tab-b'), [16, 13, 14])
  assert.deepEqual(numbers(null), [14])
  // Seen in no tab, the tracked one belongs to every session of the workspace.
  assert.deepEqual(pullRequestsOf({ linkedPR: tracked }, 'tab-a')[0], { number: 16, url: 'https://x/pull/16', state: 'merged', title: 'Faster' })
  assert.deepEqual(pullRequestsOf({}, 'tab-a'), [])
})
