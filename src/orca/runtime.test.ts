import { assert, test } from 'orca/testing'
import { tabOfPane } from '../shared'
import { defaultAgent } from './agents'
import { compactProblem, focusProblem, operationId, payloadFingerprint, runFailure, runtimeClientPath, selectedOf, tabCountOf } from './runtime'

test('finds Orca\'s runtime client in its new or old place, and says briefly why a run failed', () => {
  const has = (...paths: string[]) => (path: string) => paths.includes(path)
  assert.equal(runtimeClientPath('/u', has('/u/out/cli/runtime/client.js', '/u/out/cli/runtime-client.js')), '/u/out/cli/runtime/client.js', 'the new place first')
  assert.equal(runtimeClientPath('/u', has('/u/out/cli/runtime-client.js')), '/u/out/cli/runtime-client.js', 'an older Orca')
  assert.throws(() => runtimeClientPath('/u', has()), /runtime client somewhere the plugin does not know/)
  const stderr = "node:internal/modules/cjs/loader:1575\n  throw err;\n  ^\n\nError: Cannot find module '/x/client.js'\nRequire stack:\n- /[eval]"
  assert.equal(runFailure(stderr, new Error('Command failed: Orca -e const [request] = ...')), "Orca's runtime could not run the request: Error: Cannot find module '/x/client.js'.")
  assert.equal(runFailure('', Object.assign(new Error('x'), { killed: true })), "Orca's runtime could not run the request: it timed out.")
  assert.equal(runFailure('', new Error('x')), "Orca's runtime could not run the request: it exited without an answer.")
})

test('finds the tab of a session and reads the focus answer', () => {
  assert.deepEqual(tabOfPane('structured-agent-session-claude_abc_123:leaf-1'), { tabId: 'agent-session:claude_abc_123' })
  assert.deepEqual(tabOfPane('tab-1:leaf-1'), { tabId: 'tab-1', leafId: 'leaf-1' })
  assert.equal(tabOfPane('w1#0'), null, 'a session without a pane has no tab')
  assert.equal(focusProblem(JSON.stringify({ ok: true })), null)
  assert.equal(focusProblem(JSON.stringify({ error: { code: 'runtime_error', message: 'tab_not_found' } })), 'Orca has no open tab for this session.')
  assert.equal(focusProblem(JSON.stringify({ error: { code: 'method_not_found', message: 'x' } })), 'This Orca build cannot focus a tab from a plugin.')
  assert.equal(focusProblem(''), 'Orca gave no readable answer.')
})

test('reads the focused workspace and the tab Orca shows in it', () => {
  // The runtime names a terminal tab by tab and leaf, a chat by its session; other tabs match no session.
  const answer = (activeTabId: string | null) => JSON.stringify({ worktree: 'r1::/c/kb', activeTabId })
  assert.deepEqual(selectedOf(answer('tab-1::leaf-1')), { worktreeId: 'r1::/c/kb', tabId: 'tab-1' })
  assert.deepEqual(selectedOf(answer('agent-session:claude_abc')), { worktreeId: 'r1::/c/kb', tabId: 'agent-session:claude_abc' })
  assert.deepEqual(selectedOf(answer(null)), { worktreeId: 'r1::/c/kb', tabId: null })
  assert.equal(selectedOf('null'), null, 'no workspace is focused')
  assert.equal(selectedOf(JSON.stringify({ error: { code: 'method_not_found', message: 'x' } })), null)
  assert.equal(selectedOf(''), null)
})

test('reads how many tabs a workspace has and the agent a new tab starts', () => {
  assert.equal(tabCountOf(JSON.stringify({ count: 0 })), 0, 'an empty workspace')
  assert.equal(tabCountOf(JSON.stringify({ count: 3 })), 3)
  assert.equal(tabCountOf(JSON.stringify({ count: null })), null, 'Orca answered without tabs')
  assert.equal(tabCountOf(JSON.stringify({ error: { code: 'selector_not_found', message: 'selector_not_found' } })), null)
  assert.equal(tabCountOf(''), null)
  const installed = (agents: unknown[]) => JSON.stringify({ ok: true, result: { agents } })
  assert.equal(defaultAgent(installed([{ id: 'claude', default: true }, { id: 'codex', default: false }])), 'claude')
  assert.equal(defaultAgent(installed([{ id: 'claude', default: false }, { id: 'codex', default: true }])), 'codex')
  assert.equal(defaultAgent(installed([{ id: 'claude', default: false }])), null, 'no default set')
  assert.equal(defaultAgent('{}'), null, 'agent installed failed')
  assert.equal(defaultAgent('not json'), null)
})

test('signs a chat compact the way Orca does, and reads its answer', () => {
  // The digest Orca's own structuredAgentSessionPayloadFingerprint gives for the same input.
  assert.equal(payloadFingerprint('claude_abc', { command: 'compact' }), 'afd403551720ff3808cf6e85767d1c8fae1a6dba8a2f22b99bf8ff3a43495d78')
  assert.match(operationId(1794251032095), /^1794251032095-[0-9a-f]{32}$/)
  const answer = (result: unknown) => JSON.stringify({ answer: result })
  assert.equal(compactProblem(answer({ ok: true, value: { command: 'compact', state: 'completed' } })), null)
  assert.equal(compactProblem(answer({ ok: true, value: { state: 'unknown' } })), 'Orca could not confirm the compact.')
  assert.equal(compactProblem(answer({ ok: true, value: { state: 'completed', error: 'The command was not run.' } })), 'The command was not run.')
  assert.equal(compactProblem(answer({ ok: true, value: { state: 'unknown', error: 'The command has not started yet.' } })), 'The command has not started yet.')
  assert.equal(compactProblem(answer({ ok: false, refusal: { code: 'agent_session_operation_invalid', reason: 'turnActive' } })), 'The chat is working: compact it once the turn ends.')
  assert.equal(compactProblem(JSON.stringify({ error: { code: 'method_not_found', message: 'x' } })), 'This Orca build cannot compact chats from a plugin.')
  assert.equal(compactProblem(JSON.stringify({ error: { code: 'x', message: 'agent_session_identity_required' } })), 'Orca has no chat with this session id.')
  assert.equal(compactProblem(''), 'Orca gave no readable answer.')
})
