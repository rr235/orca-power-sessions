// What the panel asks of a session or a workspace: compact a session, focus its tab, read the
// workspace on screen, and open a workspace.
import type { OrcaWorkerApi } from 'orca/worker'
import { activeWorkspace, hasOpenTabs } from '../orca/agents'
import { launchAgent, listTerminals, listWorkspaces, newTabAgent, sendToTerminal, switchTerminal } from '../orca/commands'
import { terminalOfPane } from '../orca/terminals'
import { folderOf, show, showWorkspace } from '../orca/workspaces'
import type { Selected } from '../protocol'

export function sessionCommands(orca: OrcaWorkerApi) {
  /** Runs /compact in a terminal agent. Orca offers no way to run it in a chat. */
  async function compact(key: string): Promise<null> {
    const terminal = terminalOfPane(await listTerminals(), key)
    if (!terminal) {
      throw Object.assign(new Error('Only a terminal session can be compacted from here.'), { code: 'invalid_params' })
    }
    await sendToTerminal(terminal, '/compact')
    return null
  }

  /** Shows the session's workspace, then its terminal; a chat's tab cannot be chosen, so its workspace shows. */
  async function focus(key: string, path: string): Promise<null> {
    await showWorkspace(orca, path)
    const terminal = terminalOfPane(await listTerminals(), key)
    if (terminal) {
      try {
        await switchTerminal(terminal)
      } catch (error) {
        orca.log(`focus ${key}: ${(error as Error).message}`)
        throw error
      }
    }
    return null
  }

  /** The workspace Orca's window shows. Orca does not say which of its tabs is on screen. */
  async function selected(): Promise<Selected | null> {
    const worktreeId = activeWorkspace(await listWorkspaces())
    return worktreeId ? { worktreeId, key: null } : null
  }

  /**
   * Shows the workspace. One with no tabs starts the agent a new tab would, as a chat or terminal
   * per Orca's settings, in place of the plain terminal Orca opens in an empty workspace.
   */
  async function openWorkspace(path: string): Promise<null> {
    const folder = await folderOf(orca, path)
    const workspace = folder ?? `path:${path}`
    if (hasOpenTabs(await listWorkspaces(), path) === false) {
      const agent = await newTabAgent()
      if (agent) {
        try {
          // The CLI cannot show a folder, so a folder's agent starts in the background and is shown below.
          await launchAgent(agent, workspace, !folder)
          if (!folder) {
            return null
          }
        } catch (error) {
          // Not repeated, as the launch may have opened its tab: the workspace is shown as before.
          orca.log(`launch ${agent} in ${path}: ${(error as Error).message}`)
        }
      }
    }
    await show(orca, path, folder)
    return null
  }

  // One open per workspace at a time, so a double press starts one agent.
  const opening = new Map<string, Promise<null>>()
  function open(path: string): Promise<null> {
    const pending = opening.get(path) ?? openWorkspace(path).finally(() => opening.delete(path))
    opening.set(path, pending)
    return pending.catch((error: Error) => {
      orca.log(`open ${path}: ${error.message}`)
      throw error
    })
  }

  return { compact, focus, selected, open }
}
