// Serves the Power Sessions panel. Orca transpiles this file when it loads: no build step. The
// sessions half lives in src/sessions/ and the quick actions half in src/actions/; this file
// registers the handlers and composes the overview from both.
import type { OrcaWorkerApi } from 'orca/worker'
import { quickActions } from './actions/run'
import type { Overview } from './protocol'
import { sessionCommands } from './sessions/commands'
import { projects, readSessions, sessionsOf } from './sessions/list'
import { pullRequestInfo } from './sessions/pulls'
import { sessionUsage } from './sessions/usage'

export default function activate(orca: OrcaWorkerApi): void {
  const actions = quickActions(orca)
  const sessions = sessionCommands(orca)

  async function load(): Promise<Overview> {
    // Both halves read the CLI together; the quick actions then link to the projects found.
    const [output, actionsOutput] = await Promise.all([readSessions(), actions.read()])
    const overview = await sessionsOf(output)
    const servers = await actions.statuses(actionsOutput, overview.projects, output.workspacesJson)
    return { servers, projects: overview.projects, sessions: overview.sessions }
  }

  orca.panels.handle('overview.load', load)
  orca.panels.handle('session.usage', ({ keys }) => sessionUsage(orca, keys))
  orca.panels.handle('pr.info', ({ urls }) => pullRequestInfo(urls))
  orca.panels.handle('server.start', ({ id }) => actions.start(id))
  orca.panels.handle('server.stop', ({ id }) => actions.stop(id))
  orca.panels.handle('action.save', async (input) => actions.save(input, await projects()))
  orca.panels.handle('action.delete', ({ id }) => actions.delete(id))
  orca.panels.handle('session.compact', ({ key }) => sessions.compact(key))
  orca.panels.handle('session.selected', () => sessions.selected())
  orca.panels.handle('session.focus', ({ key, path }) => sessions.focus(key, path))
  orca.panels.handle('project.open', ({ path }) => sessions.open(path))
}
