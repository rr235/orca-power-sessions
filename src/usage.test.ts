import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { pullRequestsOf } from './overview'
import { infoOf } from './pulls'
import { contextLabel, countLabel, modelLabel, modelTone, tokenLabel, tokensStatement, turnsTone } from './session-details'
import { run } from './cli'
import { chatSessionId } from './overview'
import { chatSource, claudeWindow, contextReports, currentContext, hookStatus, parseHookStatus, Tally } from './usage'

test('forgets the context at a compaction, and takes a newer report from Orca', () => {
  const tally = new Tally()
  const reply = (id: string, input: number, timestamp: string) =>
    JSON.stringify({ type: 'assistant', timestamp, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, cache_read_input_tokens: 0, output_tokens: 1 } } })
  tally.feed(reply('m1', 189_000, '2026-11-09T19:00:00.000Z'))
  assert.equal(tally.context, 189_000)
  const before = { window: 400_000, used: 150_000, at: Date.parse('2026-11-09T18:00:00.000Z') }
  assert.equal(currentContext(tally, before), 189_000, 'an older report does not win')
  tally.feed(JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-09T19:10:00.000Z' }))
  assert.equal(tally.context, null, 'unknown after a compaction')
  assert.equal(currentContext(tally, undefined), null)
  assert.equal(currentContext(tally, before), null, 'a report from before the compaction stays hidden')
  const after = { window: 400_000, used: 78_857, at: Date.parse('2026-11-09T19:11:00.000Z') }
  assert.equal(currentContext(tally, after), 78_857)
  tally.feed(reply('m2', 80_000, '2026-11-09T19:20:00.000Z'))
  assert.equal(currentContext(tally, after), 80_000, 'the next reply is newer than the report')
})

test('counts Claude tokens once per message and keeps the latest model', () => {
  const tally = new Tally()
  const line = (id: string, model: string, output: number) =>
    JSON.stringify({
      type: 'assistant',
      message: { id, model, usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: output } }
    })
  // Two lines of one message (the second with the final output count), then a second message.
  tally.feed([line('m1', 'claude-sonnet-5-5', 1), line('m1', 'claude-sonnet-5-5', 8)].join('\n'))
  tally.feed(`${line('m2', 'claude-opus-5-5', 20)}\n${line('m3', '<synthetic>', 0)}\nnot json`)
  assert.equal(tally.tokens, 120 + 132 + 112)
  // Input written to the cache counts as input, input read from it as cached.
  assert.deepEqual(tally.tokenSplit, { input: 36, cached: 300, output: 28 })
  assert.equal(tally.model, 'claude-opus-5-5')
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

test("reads each chat session's context from Orca's last report", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quick-actions-'))
  const store = join(dir, 'store.db')
  const row = (kind: string, window: number, used = window / 4, at = window) =>
    JSON.stringify({ body: { kind: 'turn', contextUsage: { used: { kind, windowTokens: window, usedTokens: used, capturedAt: at } } } }).replace(/'/g, "''")
  try {
    await run('sqlite3', [
      store,
      `create table journal_outcomes (generation, seq, field, entry_key, format, ordinal, value_json, deleted);
       create table journal_outcome_generations (generation, session_id, epoch);
       create table journal_rows (session_id, epoch, seq, ts, row_json);
       insert into journal_outcome_generations values (1, 'claude_a', 'e1'), (2, 'claude_a', 'e2');
       insert into journal_outcomes values
         (1, 9, 'items', 'k1', 2, '', '${row('report', 1_000_000)}', 0),
         (2, 3, 'items', 'k2', 2, '', '${row('report', 400_000)}', 0),
         (2, 4, 'items', 'k3', 2, '', '${row('estimate', 0)}', 0);
       insert into journal_rows values
         ('claude_a', 'e0', 1, 0, '${row('report', 200_000)}'),
         ('claude_b', 'e0', 1, 0, '${row('report', 1_000_000)}'),
         ('claude_b', 'e0', 2, 0, '${row('report', 400_000)}');`
    ])
    // The newest generation's last report wins; an estimate carries no window; old sessions read their rows.
    const reports = await contextReports(['claude_a', 'claude_b', 'claude_c', "x'; drop table journal_rows; --"], store)
    assert.deepEqual(Object.fromEntries(reports), {
      claude_a: { window: 400_000, used: 100_000, at: 400_000 },
      claude_b: { window: 400_000, used: 100_000, at: 400_000 }
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('knows Claude context windows by model', () => {
  assert.deepEqual(
    ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5[1m]', 'claude-haiku-4-5', 'kimi-k3'].map(claudeWindow),
    [1_000_000, 1_000_000, 1_000_000, 200_000, 1_000_000, 200_000, null]
  )
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

test('traces chat and terminal sessions to their transcripts', () => {
  assert.equal(chatSessionId('structured-agent-session-claude_dc33_6b69:leaf-1'), 'claude_dc33_6b69')
  assert.equal(chatSessionId('tab-1:leaf-1'), null)
  const chat = chatSource({
    provider: 'claude',
    accountHome: { path: '/h/.claude' },
    location: { workspaceId: 'repo::/Users/me/Code/my.app' },
    options: { model: 'claude-opus-5-5', effort: 'high' },
    providerHandleChain: [{ handle: { sessionId: 'old' } }, { handle: { sessionId: 'new' } }]
  })
  assert.deepEqual([chat?.transcript, chat?.model, chat?.effort], ['/h/.claude/projects/-Users-me-Code-my-app/new.jsonl', 'claude-opus-5-5', 'high'])
  const codex = chatSource({ provider: 'codex', providerHandleChain: [{ handle: { threadId: 't-1' } }] })
  assert.deepEqual([codex?.transcript, codex?.codexThread], [null, 't-1'])
  const hooks = parseHookStatus(
    JSON.stringify({ entries: { 'tab:leaf': { source: 'claude', providerSession: { transcriptPath: '/t.jsonl', effort: 'max' } }, other: { source: 'shell' } } })
  )
  assert.deepEqual([...hooks.keys()], ['tab:leaf'])
  assert.deepEqual(hooks.get('tab:leaf'), { agent: 'claude', transcript: '/t.jsonl', model: null, effort: 'max' })
})

test("reads terminal sessions from Orca's hook status log, else its older file", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quick-actions-'))
  const db = join(dir, 'last-status.db')
  const json = join(dir, 'last-status.json')
  const row = (seq: number, key: string, value: object) => `(${seq}, '${key}', '${JSON.stringify(value)}')`
  try {
    await run('sqlite3', [
      db,
      `create table rows (seq, key, value);
       insert into rows values
         ${row(1, 'entry', { paneKey: 't1:l1', source: 'codex', providerSession: { transcriptPath: '/old.jsonl' } })},
         ${row(2, 'entry', { paneKey: 't2:l2', source: 'claude', providerSession: { transcriptPath: '/c.jsonl', effort: 'high' } })},
         ${row(3, 'commitment', { paneKey: 't2:l2', launchTokenHash: 'h' })},
         ${row(4, 'entry', { paneKey: 't3:l3', source: 'shell' })},
         ${row(5, 'entry', { paneKey: 't1:l1', source: 'codex', providerSession: { transcriptPath: '/new.jsonl' } })};`
    ])
    // A later row for a pane replaces an earlier one; rows without an agent are left out.
    const hooks = await hookStatus(db, json)
    assert.deepEqual(Object.fromEntries(hooks), {
      't1:l1': { agent: 'codex', transcript: '/new.jsonl', model: null, effort: null },
      't2:l2': { agent: 'claude', transcript: '/c.jsonl', model: null, effort: 'high' }
    })
    await writeFile(json, JSON.stringify({ entries: { 'old:leaf': { source: 'claude', providerSession: { transcriptPath: '/o.jsonl' } } } }))
    assert.deepEqual([...(await hookStatus(join(dir, 'missing.db'), json)).keys()], ['old:leaf'], 'an older Orca keeps its JSON file')
    assert.equal((await hookStatus(join(dir, 'missing.db'), join(dir, 'missing.json'))).size, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
  assert.deepEqual(infoOf('{"title":" fix: load repo issues ","state":"MERGED"}'), { title: 'fix: load repo issues', state: 'merged' })
  assert.equal(infoOf('not json'), null)
})

test('labels models and token counts', () => {
  assert.deepEqual(
    ['claude-opus-5-5', 'claude-sonnet-4-5-20250929', 'claude-fable-5-1[1m]', 'gpt-6.1-sol', 'kimi-k3:cloud'].map(modelLabel),
    ['Opus 5.5', 'Sonnet 4.5', 'Fable 5.1', 'GPT-6.1 Sol', 'kimi-k3:cloud']
  )
  assert.deepEqual(
    ['Fable 5.2', 'GPT-6.1 Astra', 'astra', 'Opus 5.5', 'GPT-6.1 Sol', 'Fabled 1'].map(modelTone),
    ['warning', 'warning', 'warning', undefined, undefined, undefined]
  )
  assert.deepEqual([950, 12_400, 255_295, 2_905_294, 53_281_672].map(tokenLabel), ['950', '12k', '255k', '2.9M', '53M'])
  assert.deepEqual([countLabel(1, 'turn'), countLabel(12, 'turn'), countLabel(0, 'compaction')], ['1 turn', '12 turns', '0 compactions'])
  assert.deepEqual([0, 20, 21, 35, 36, 80].map(turnsTone), [undefined, undefined, 'warning', 'warning', 'danger', 'danger'])
  assert.deepEqual(tokensStatement(1, null), '1 token total')
  assert.deepEqual(
    tokensStatement(2_905_294, { input: 152_394, cached: 2_714_700, output: 38_200 }),
    '2.9M tokens total: 152k input, 38k output, 2.7M cached'
  )
  assert.deepEqual(contextLabel(121_400, 1_000_000), { used: '121k', window: '1M', percent: 12 })
  assert.deepEqual(contextLabel(98_506, 258_400), { used: '99k', window: '258k', percent: 38 })
  assert.deepEqual(contextLabel(300_000, 258_400), { used: '300k', window: '258k', percent: 100 })
  assert.deepEqual(contextLabel(5_000, null), { used: '5k', window: null, percent: null })
})
