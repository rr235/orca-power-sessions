import { assert, test } from 'orca/testing'
import type { Session, SessionUsage } from '../protocol'
import { contextLabel, countLabel, modelLabel, modelTone, tokenLabel, tokensStatement, turnsTone, usageGap } from './session-details'

test('says why a session has no turns', () => {
  const session = (agent: string | null) => ({ agent }) as Session
  const stats = (turns: number | null) => ({ turns }) as SessionUsage
  assert.equal(usageGap(session('claude'), stats(0)), null, 'no prompt yet is still known')
  assert.equal(usageGap(session('codex'), stats(12)), null)
  assert.equal(usageGap(session('claude'), undefined), 'No transcript found for this session.')
  assert.equal(usageGap(session('codex'), stats(null)), 'No transcript found for this session.')
  assert.equal(usageGap(session('gemini'), stats(3)), 'Usage is only read for Claude and Codex sessions.')
  assert.equal(usageGap(session(null), undefined), 'Usage is only read for Claude and Codex sessions.')
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
