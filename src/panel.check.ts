// `orca plugin check` and `orca plugin shot --scenario` render the panel once per scenario, with
// every worker request stubbed so no real session reaches the image.
import { defineCheck } from 'orca/testing'
import { DEMO, DEMO_USAGE, DEMO_WORKTREES } from './fixtures'

const requests = {
  'overview.load': () => DEMO,
  'session.usage': () => DEMO_USAGE,
  'pr.info': () => ({ 'https://github.com/mountin-io/platform/pull/215': { title: 'Tenant invite emails', state: 'merged' } }),
  'server.start': () => null,
  'server.stop': () => null,
  'action.save': () => null,
  'action.delete': () => null,
  'project.open': () => null
}

export default defineCheck({
  demo: { requests },
  details: { requests, storage: { expanded: { p1: true, p2: true } } },
  worktrees: { requests: { ...requests, 'overview.load': () => DEMO_WORKTREES }, storage: { expanded: { p1: true } } },
  empty: { requests: { ...requests, 'overview.load': () => ({ ...DEMO, sessions: [] }) } }
})
