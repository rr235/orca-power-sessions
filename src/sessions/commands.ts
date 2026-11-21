// What the panel asks of a session or a workspace: compact a session, focus its tab, read the
// selected tab, and open a workspace.
import type { OrcaWorkerApi } from 'orca/worker'
import { launchAgent, listTerminals, newTabAgent, sendToTerminal } from '../orca/commands'
import { compactChat, focusTab, selectedTab, tabCount } from '../orca/runtime'
import { terminalOfPane } from '../orca/terminals'
import { folderOf, show, showWorkspace } from '../orca/workspaces'
import { chatSessionId } from '../shared'

export function sessionCommands(orca: OrcaWorkerApi) {
  async function compact(key: string): Promise<null> {
    const terminal = terminalOfPane(await listTerminals(), key)
    if (terminal) {
      await sendToTerminal(terminal, '/compact')
      return null
    }
    const chat = chatSessionId(key)
    if (!chat) {
      throw Object.assign(new Error('This session has neither a terminal nor a chat to compact.'), { code: 'invalid_params' })
    }
    try {
      await compactChat(chat)
    } catch (error) {
      orca.log(`compact ${chat}: ${(error as Error).message}`)
      throw error
    }
    return null
  }

  async function focus(key: string, path: string): Promise<null> {
    // Orca focuses a tab only in the workspace on screen, so show the workspace first.
    const workspace = await showWorkspace(orca, path)
    try {
      await focusTab(workspace, key)
    } catch (error) {
      orca.log(`focus ${key}: ${(error as Error).message}`)
      throw error
    }
    return null
  }

  /**
   * Shows the workspace. One with no tabs starts the agent a new tab would, as a chat or terminal
   * per Orca's settings, in place of the plain terminal Orca opens in an empty workspace.
   */
  async function openWorkspace(path: string): Promise<null> {
    const folder = await folderOf(orca, path)
    const workspace = folder ?? `path:${path}`
    if ((await tabCount(workspace)) === 0) {
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

  return { compact, focus, selected: selectedTab, open }
}
