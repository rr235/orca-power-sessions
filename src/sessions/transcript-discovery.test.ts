import { assert, test } from 'orca/testing'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeTranscriptByReply, codexTranscript } from './usage'

test('finds a resumed Codex thread outside the recent date folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'power-sessions-codex-'))
  try {
    const folder = join(root, '2020', '01', '01')
    await mkdir(folder, { recursive: true })
    const path = join(folder, 'rollout-2020-01-01-thread-old.jsonl')
    await writeFile(path, '{}\n')
    assert.equal(await codexTranscript(root, 'thread-old'), path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('discovers a Claude transcript only from an unambiguous main-thread assistant reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'power-sessions-claude-'))
  const reply = 'The tests pass and the updated "filter" labels sit on one row.'
  const row = (type: string, content: unknown, extra = {}) => JSON.stringify({ type, message: { content }, ...extra }) + '\n'
  try {
    const quoted = join(root, 'quoted.jsonl')
    await writeFile(quoted, row('user', reply) + row('assistant', [{ type: 'tool_use', input: { text: reply } }]) + row('assistant', reply, { isSidechain: true }))
    assert.equal(await claudeTranscriptByReply(root, reply), null, 'quoted text is not a main-thread reply')
    const path = join(root, 'actual.jsonl')
    const assistant = row('assistant', [{ type: 'text', text: 'The tests pass\nand the updated "filter" labels sit on one row.' }])
    await writeFile(path, assistant)
    assert.equal(await claudeTranscriptByReply(root, reply), path, 'decoded text preserves quotes and normalizes whitespace')
    await writeFile(join(root, 'duplicate.jsonl'), assistant)
    assert.equal(await claudeTranscriptByReply(root, reply), null, 'two matching transcripts remain unresolved')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
