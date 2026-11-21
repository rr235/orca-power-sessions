// Finds and shows Orca workspaces. The CLI shows a Git worktree; a folder workspace, which the CLI
// refuses, goes through the host's `workspace.open`.
import type { OrcaWorkerApi } from 'orca/worker'
import { activateWorktree } from './commands'

/** A row of the host's `workspace.list`, as far as finding a folder workspace needs it. */
export type WorkspaceRow = { id: string; kind: 'worktree' | 'folder'; path: string; hostId: string | null }

/**
 * The id of the folder workspace at `path` on this machine, or null when the path is a Git
 * worktree or Orca lists nothing there. A folder's id (`folder:<id>`) is also its runtime selector.
 */
export function folderAt(rows: readonly WorkspaceRow[], path: string): string | null {
  const row = rows.find((r) => r.kind === 'folder' && r.path === path && (r.hostId === null || r.hostId === 'local'))
  return row?.id ?? null
}

/** The id of the folder workspace at `path`, which is also its runtime selector, or null for a Git worktree. */
export const folderOf = async (orca: OrcaWorkerApi, path: string): Promise<string | null> =>
  folderAt((await orca.host.call('workspace.list')).workspaces, path)

/** Shows a workspace in Orca's window: a folder through `workspace.open`, a Git worktree through the CLI. */
export async function show(orca: OrcaWorkerApi, path: string, folder: string | null): Promise<void> {
  if (folder) {
    await orca.host.call('workspace.open', { workspaceId: folder })
  } else {
    await activateWorktree(path)
  }
}

/** Shows the workspace at `path` and answers the selector Orca's runtime knows it by. */
export async function showWorkspace(orca: OrcaWorkerApi, path: string): Promise<string> {
  const folder = await folderOf(orca, path)
  await show(orca, path, folder)
  return folder ?? `path:${path}`
}
