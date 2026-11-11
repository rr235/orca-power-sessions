// A made-up overview for tests, `orca plugin check` and screenshots, so no real session shows.
import type { Overview, Server, SessionUsage } from './protocol'

const now = Date.now()

const server = (id: string, name: string, command: string, projectId: string | null, url: string | null, up: boolean, terminal: string | null = null): Server => ({
  id,
  name,
  command,
  projectId,
  url,
  up,
  terminal
})

const DEMO_SERVERS: Server[] = [
  server('platform', 'Platform', 'bun run stack:up && bun run dev:platform', 'github:mountin-io/platform', 'http://demo.localhost:3100', true, 'term_demo'),
  server('primer', 'Primer', 'bun run dev:primer', 'github:mountin-io/platform', 'http://localhost:3200', false),
  server('website', 'Website', 'bun run dev:website', 'github:mountin-io/platform', 'http://localhost:3300', true),
  server('knowledgebase', 'KB', 'bun run dev', null, 'http://localhost:3400', false),
  server('blog', 'Blog', 'bun run dev', 'github:rr235/blog', null, false)
]

export const DEMO: Overview = {
  servers: DEMO_SERVERS,
  sessions: [
    {
      key: 'p1',
      worktreeId: 'r1::/w/platform',
      workspace: 'issue-212-onboarding',
      projectId: 'github:mountin-io/platform',
      project: 'Platform',
      agent: 'claude',
      agentIcon: 'assets/agents/claude.png',
      title: 'Onboarding checklist for new tenants',
      state: 'working',
      since: now - 4 * 60 * 1000,
      branch: 'issue-212-onboarding',
      path: '/w/platform',
      tool: 'Bash: bun test onboarding',
      outcome: null,
      prs: [
        { number: 212, url: 'https://github.com/mountin-io/platform/pull/212', state: 'open', title: 'Onboarding checklist for new tenants' },
        { number: 215, url: 'https://github.com/mountin-io/platform/pull/215', state: null, title: null }
      ]
    },
    {
      key: 'p2',
      worktreeId: 'r2::/w/kb',
      workspace: 'main',
      projectId: null,
      project: 'mountin-knowledge-base',
      agent: 'codex',
      agentIcon: 'assets/agents/codex.png',
      title: 'Review search ranking change',
      state: 'waiting',
      since: now - 12 * 60 * 1000,
      branch: 'main',
      path: '/w/kb',
      tool: null,
      outcome: null,
      prs: []
    },
    {
      key: 'p3',
      worktreeId: 'r3::/w/blog',
      workspace: 'main',
      projectId: 'github:rr235/blog',
      project: 'Personal Blog',
      agent: 'claude',
      agentIcon: 'assets/agents/claude.png',
      title: 'Draft post layout',
      state: 'done',
      since: now - 50 * 60 * 1000,
      branch: 'main',
      path: '/w/blog',
      tool: null,
      outcome: 'success',
      prs: []
    }
  ],
  projects: [
    { id: 'github:rr235/crm', name: 'CRM', repo: 'rr235/crm', path: '/w/crm', agents: 0, worktrees: 1 },
    { id: 'github:rr235/blog', name: 'Personal Blog', repo: 'rr235/blog', path: '/w/blog', agents: 1, worktrees: 1 },
    { id: 'github:mountin-io/platform', name: 'Platform', repo: 'mountin-io/platform', path: '/w/platform', agents: 1, worktrees: 1 },
    { id: 'github:rr235/planner', name: 'Planner', repo: 'rr235/planner', path: '/w/planner', agents: 0, worktrees: 1 }
  ]
}

const PLATFORM = 'github:mountin-io/platform'

/**
 * DEMO with Platform in three workspaces, two of them with sessions: the main checkout's session
 * comes between the other workspace's two, as Orca's order can put it. Personal Blog has two
 * workspaces with a session in one.
 */
export const DEMO_WORKTREES: Overview = {
  ...DEMO,
  sessions: [
    DEMO.sessions[0],
    {
      ...DEMO.sessions[0],
      key: 'p4',
      worktreeId: 'r1::/w/platform-main',
      workspace: 'main',
      agent: 'codex',
      agentIcon: 'assets/agents/codex.png',
      title: 'Release notes for 0.4',
      state: 'done',
      branch: 'release/0.4',
      path: '/w/platform-main',
      tool: null,
      outcome: 'success',
      prs: []
    },
    { ...DEMO.sessions[0], key: 'p5', title: 'Review onboarding copy', state: 'waiting', tool: null, prs: [] },
    ...DEMO.sessions.slice(1)
  ],
  projects: DEMO.projects.map((p) =>
    p.id === PLATFORM ? { ...p, agents: 3, worktrees: 3 } : p.id === 'github:rr235/blog' ? { ...p, worktrees: 2 } : p
  )
}

/** Model, effort, tokens and turns for the demo sessions, by key. */
export const DEMO_USAGE: Record<string, SessionUsage> = {
  p1: { model: 'claude-opus-5-5', effort: 'high', tokens: 2_905_294, tokenSplit: { input: 152_394, cached: 2_714_700, output: 38_200 }, context: 121_400, contextWindow: 1_000_000, turns: 40, turnsSinceCompaction: 24, compactions: 3, toolCalls: 186, toolCallsSinceCompaction: 48 },
  p2: { model: 'gpt-6.1-sol', effort: 'xhigh', tokens: 412_800, tokenSplit: { input: 60_000, cached: 340_000, output: 12_800 }, context: 98_500, contextWindow: 258_400, turns: 4, turnsSinceCompaction: 4, compactions: 0, toolCalls: 23, toolCallsSinceCompaction: 23 },
  p3: { model: null, effort: null, tokens: null, tokenSplit: null, context: null, contextWindow: null, turns: null, turnsSinceCompaction: null, compactions: null, toolCalls: null, toolCallsSinceCompaction: null }
}
