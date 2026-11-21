import { assert, test } from 'orca/testing'
import { folderAt } from './workspaces'

test('finds the folder workspace at a path, so a folder session can be shown', () => {
  const rows = [
    { id: 'repo-1::/w/platform', kind: 'worktree' as const, path: '/w/platform', hostId: 'local' },
    { id: 'folder:remote', kind: 'folder' as const, path: '/bots/mountin-bot', hostId: 'ssh:box' },
    { id: 'folder:bot', kind: 'folder' as const, path: '/bots/mountin-bot', hostId: null }
  ]
  assert.equal(folderAt(rows, '/bots/mountin-bot'), 'folder:bot', 'the folder on this machine')
  assert.equal(folderAt(rows, '/w/platform'), null, 'a Git worktree stays on the CLI')
  assert.equal(folderAt(rows, '/elsewhere'), null, 'nothing listed there')
  assert.equal(folderAt(rows.slice(0, 2), '/bots/mountin-bot'), null, 'a folder only on another host')
})
