import { assert, test } from 'orca/testing'
import { contextWindow, effortOf, launchFlags, modelWindow, NO_LAUNCH } from './claude-settings'

test('reads the model, effort and auto-compact flags a Claude process was started with', () => {
  assert.deepEqual(launchFlags('/u/.local/bin/claude --output-format stream-json --effort=high --model=opus --resume=abc'), {
    model: 'opus',
    effort: 'high',
    autocompact: null
  })
  assert.deepEqual(launchFlags('claude --model opus[1m] --autocompact 500k'), { model: 'opus[1m]', effort: null, autocompact: '500k' })
})

test('knows each model\'s full window in Claude Code', () => {
  assert.deepEqual(
    ['claude-opus-5-5', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-5-5', 'claude-haiku-4-5', 'claude-fable-5-2', 'kimi-k3'].map((m) => modelWindow(m)),
    [1_000_000, 1_000_000, 200_000, 1_000_000, 200_000, 1_000_000, 200_000, 1_000_000, null]
  )
  assert.equal(modelWindow('claude-opus-4-6', true), 1_000_000, 'a [1m] model')
  assert.equal(modelWindow('claude-opus-5-5', false, true), 200_000, '1M context turned off')
})

test('caps the window at the auto-compact window from the highest-precedence source', () => {
  const user = { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 400000, effortLevel: 'high' } }, autoCompactWindow: 300000, effortLevel: 'xhigh' }
  assert.equal(contextWindow('claude-opus-5-5', NO_LAUNCH, [user]), 400_000, 'the model\'s own entry wins in its file')
  assert.equal(contextWindow('claude-opus-5-1', NO_LAUNCH, [user]), 300_000, 'another model takes the file\'s window')
  assert.equal(contextWindow('claude-opus-5-5', NO_LAUNCH, [{ autoCompactWindow: 250000 }, user]), 250_000, 'a higher file wins')
  assert.equal(contextWindow('claude-opus-5-5', { ...NO_LAUNCH, autocompact: '600k' }, [user]), 600_000, 'the flag beats settings')
  assert.equal(contextWindow('claude-opus-5-5', { ...NO_LAUNCH, autocompact: 'auto' }, [user]), 1_000_000, 'auto runs at the tuned window')
  assert.equal(contextWindow('claude-opus-5-5', NO_LAUNCH, [{ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200k' } }, user]), 200_000, 'the variable beats all')
  assert.equal(contextWindow('claude-opus-4-6', NO_LAUNCH, [{ autoCompactWindow: 400000 }]), 200_000, 'never past the model\'s window')
  assert.equal(contextWindow('claude-opus-4-6', { ...NO_LAUNCH, model: 'opus[1m]' }, []), 1_000_000, 'a [1m] launch')
  assert.equal(contextWindow('claude-opus-5-5', NO_LAUNCH, []), 1_000_000)
})

test('takes effort from the launch flag, else the model\'s settings, else the file\'s', () => {
  const user = { modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } }, effortLevel: 'xhigh' }
  assert.equal(effortOf('claude-opus-5-5', { ...NO_LAUNCH, effort: 'low' }, [user]), 'low')
  assert.equal(effortOf('claude-opus-5-5', NO_LAUNCH, [user]), 'high')
  assert.equal(effortOf('claude-sonnet-5', NO_LAUNCH, [user]), 'xhigh')
  assert.equal(effortOf(null, NO_LAUNCH, []), null)
})
