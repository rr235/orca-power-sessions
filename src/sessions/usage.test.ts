import { assert, test } from 'orca/testing'
import { Tally } from './usage'

test('takes the context Claude records after a compaction, else forgets it until the next reply', () => {
  const tally = new Tally()
  const reply = (id: string, input: number, timestamp: string) =>
    JSON.stringify({ type: 'assistant', timestamp, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, cache_read_input_tokens: 0, output_tokens: 1 } } })
  tally.feed(reply('m1', 189_000, '2026-11-09T19:00:00.000Z'))
  assert.equal(tally.context, 189_000)
  tally.feed(JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-09T19:10:00.000Z' }))
  assert.equal(tally.context, null, 'unknown after a compaction')
  tally.feed(reply('m2', 80_000, '2026-11-09T19:20:00.000Z'))
  assert.equal(tally.context, 80_000)
  tally.feed(JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-09T19:30:00.000Z', compactMetadata: { trigger: 'auto', preTokens: 367_505, postTokens: 54_707 } }))
  assert.equal(tally.context, 54_707)
})

test('counts Claude tokens once per message and keeps the latest model and effort', () => {
  const tally = new Tally()
  const line = (id: string, model: string, output: number) =>
    JSON.stringify({
      type: 'assistant',
      effort: model.startsWith('<') ? undefined : output > 10 ? 'max' : 'high',
      message: { id, model, usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: output } }
    })
  // Two lines of one message (the second with the final output count), then a second message.
  tally.feed([line('m1', 'claude-sonnet-5-5', 1), line('m1', 'claude-sonnet-5-5', 8)].join('\n'))
  tally.feed(`${line('m2', 'claude-opus-5-5', 20)}\n${line('m3', '<synthetic>', 0)}\nnot json`)
  assert.equal(tally.tokens, 120 + 132 + 112)
  // Input written to the cache counts as input, input read from it as cached.
  assert.deepEqual(tally.tokenSplit, { input: 36, cached: 300, output: 28 })
  assert.equal(tally.model, 'claude-opus-5-5')
  assert.equal(tally.effort, 'max')
  // Context is the last main-thread message's input; a subagent's turn does not count.
  assert.equal(tally.context, 112)
  tally.feed(JSON.stringify({ isSidechain: true, message: { id: 's1', usage: { input_tokens: 5 } } }))
  assert.equal(tally.context, 112)
})

test('counts the prompts a person sent to Claude and its compactions', () => {
  const tally = new Tally()
  const user = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra })
  tally.feed(
    [
      user([{ type: 'text', text: 'Show the usage in the details' }]),
      user('Plain text prompt'),
      user('<command-message>rr:codex-review</command-message>\n<command-name>/rr:codex-review</command-name>'),
      user([{ type: 'image' }, { type: 'text', text: 'This screenshot' }]),
      // Not prompts: a tool's result, an injected skill, a subagent's prompt, local commands, notices.
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'usage: 3' }], { toolUseResult: { usage: 3 } }),
      user([{ type: 'text', text: 'Base directory for this skill' }], { isMeta: true }),
      user('Find the file', { isSidechain: true }),
      user('<command-name>/model</command-name>'),
      user('<local-command-stdout>Set model</local-command-stdout>'),
      user('<task-notification>done</task-notification>'),
      user('[Request interrupted by user]'),
      // A compaction: its boundary counts, the summary that follows does not.
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }),
      user('This session is being continued from a previous conversation', { isCompactSummary: true }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: true })
    ].join('\n')
  )
  assert.deepEqual([tally.turns, tally.compactions, tally.turnsSinceCompaction], [4, 1, 0])
  tally.feed(user('After the compaction'))
  assert.deepEqual([tally.turns, tally.turnsSinceCompaction], [5, 1])
})

test('counts Claude tool calls once each, in the main thread', () => {
  const tally = new Tally()
  const block = (id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'assistant', message: { id, content, usage: { input_tokens: 1 } }, ...extra })
  tally.feed(
    [
      block('m1', [{ type: 'text', text: 'Reading' }]),
      block('m1', [{ type: 'tool_use', id: 'toolu_1', name: 'Read' }]),
      block('m1', [{ type: 'tool_use', id: 'toolu_2', name: 'Bash' }]),
      // A copied line, and a subagent's call.
      block('m1', [{ type: 'tool_use', id: 'toolu_2', name: 'Bash' }]),
      block('s1', [{ type: 'tool_use', id: 'toolu_3', name: 'Grep' }], { isSidechain: true })
    ].join('\n')
  )
  assert.equal(tally.toolCalls, 2)
  // After a compaction, only new calls count as since; a copied old one does not.
  tally.feed(
    [
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
      block('m2', [{ type: 'tool_use', id: 'toolu_1', name: 'Read' }]),
      block('m2', [{ type: 'tool_use', id: 'toolu_4', name: 'Edit' }])
    ].join('\n')
  )
  assert.deepEqual([tally.toolCalls, tally.toolCallsSinceCompaction], [3, 1])
})

test('counts the turns a person started in Codex and its compactions', () => {
  const tally = new Tally()
  const started = (turn: string, root: string | null, trigger?: string) =>
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn, root_turn_id: root, turn_attribution: trigger ? { turn_trigger: trigger } : undefined } })
  tally.feed(
    [
      started('a', 'a'),
      started('b', null, 'user'),
      started('c', 'a'),
      started('d', 'd', 'guardian_review'),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } }),
      JSON.stringify({ type: 'compacted', payload: { message: '', replacement_history: [] } }),
      started('e', 'e'),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'done' } })
    ].join('\n')
  )
  assert.deepEqual([tally.turns, tally.compactions, tally.turnsSinceCompaction, tally.toolCalls, tally.toolCallsSinceCompaction], [3, 1, 1, 2, 1])
})

test('reads Codex model, effort and total tokens from its rollout', () => {
  const tally = new Tally()
  tally.feed(
    [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 2905294 }, last_token_usage: { total_tokens: 98506 }, model_context_window: 258400 }
        }
      })
    ].join('\n')
  )
  assert.deepEqual([tally.model, tally.effort, tally.tokens], ['gpt-6.1-sol', 'high', 2905294])
  assert.deepEqual([tally.context, tally.contextWindow], [98506, 258400])
  // Without the split, only the total is known.
  assert.equal(tally.tokenSplit, null)
  // Codex counts cached input inside its input: the split takes it out, so the parts add up.
  tally.feed(
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 12_146_734, cached_input_tokens: 11_234_688, output_tokens: 83_691, total_tokens: 12_230_425 } }
      }
    })
  )
  assert.deepEqual(tally.tokenSplit, { input: 912_046, cached: 11_234_688, output: 83_691 })
  assert.equal(tally.tokens, 12_230_425)
})
