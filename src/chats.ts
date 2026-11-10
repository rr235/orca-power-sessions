// Compacts an Orca chat session. Orca has no CLI command or plugin method for this, so the worker
// calls the RPC Orca's own chat composer uses, `agentSession.conversationCommand`, through the
// runtime client that ships inside Orca's CLI, run under Orca's bundled Node. These are Orca
// internals, not a published API: an Orca update can change them, and the error then says so.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import process from 'node:process'

const METHOD = 'agentSession.conversationCommand'
// Where macOS installs Orca; `ORCA_APP` names another `.app` bundle.
const APP = process.env.ORCA_APP ?? '/Applications/Orca.app'
// The mobile client waits this long for a compact to finish.
export const COMPACT_TIMEOUT_MS = 200000

/** Orca's canonical JSON: keys sorted, undefined left out. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
}

/** The digest Orca checks a chat mutation against: its method, session and fields, never the fence. */
export function payloadFingerprint(sessionId: string, fields: Record<string, unknown>): string {
  return createHash('sha256').update(canonical({ method: METHOD, sessionId, fields })).digest('hex')
}

/** A new operation id in Orca's format: milliseconds, then 32 hex digits. */
export const operationId = (now = Date.now()) => `${Math.trunc(now)}-${randomUUID().replace(/-/g, '').toLowerCase()}`

// Runs under Orca's Node with the request as its one argument: reads the session's current fence,
// sends the command, and prints the answer (or the error) as JSON.
const SCRIPT = `
const [request] = process.argv.slice(1)
const { client: clientPath, sessionId, fields, envelope } = JSON.parse(request)
const { RuntimeClient } = require(clientPath)
;(async () => {
  try {
    const client = new RuntimeClient()
    const history = await client.call('agentSession.history', { sessionId, direction: 'tail', limit: 1 })
    const fence = history.result && history.result.page ? history.result.page.fence : null
    if (typeof fence !== 'number') throw Object.assign(new Error('no fence'), { code: 'no_fence' })
    const answer = await client.call('${METHOD}', { envelope: { ...envelope, expectedRuntimeFence: fence }, ...fields }, { timeoutMs: ${COMPACT_TIMEOUT_MS} })
    console.log(JSON.stringify({ answer: answer.result }))
  } catch (error) {
    console.log(JSON.stringify({ error: { code: error.code || null, message: String(error.message || error) } }))
  }
  process.exit(0)
})()
`

type Answer = {
  answer?: { ok?: boolean; value?: { state?: string; error?: string }; refusal?: { code?: string; reason?: string } }
  error?: { code: string | null; message: string }
}

/** Why a compact did not happen, in words, or null when it completed. */
export function compactProblem(output: string): string | null {
  let parsed: Answer
  try {
    parsed = JSON.parse(output.trim().split('\n').pop() ?? '') as Answer
  } catch {
    return 'Orca gave no readable answer.'
  }
  if (parsed.error) {
    if (parsed.error.message === 'agent_session_identity_required') {
      return 'Orca has no chat with this session id.'
    }
    return parsed.error.code === 'method_not_found' || parsed.error.message.includes('structured_agent_session_unsupported')
      ? 'This Orca build cannot compact chats from a plugin.'
      : parsed.error.message
  }
  const answer = parsed.answer
  if (answer?.value?.error) {
    return answer.value.error
  }
  if (answer?.ok && answer.value?.state === 'completed') {
    return null
  }
  if (answer?.ok) {
    return 'Orca could not confirm the compact.'
  }
  const reason = answer?.refusal?.reason
  return reason === 'turnActive' ? 'The chat is working: compact it once the turn ends.' : `Orca refused: ${reason ?? answer?.refusal?.code ?? 'no reason given'}.`
}

/**
 * Runs `script` under Orca's bundled Node with one JSON argument: `request`, plus `client`, the
 * path of Orca's runtime client. Resolves with what the script printed.
 */
export function runInOrca(script: string, request: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const contents = `${realpathSync(APP)}/Contents`
  const argument = JSON.stringify({ ...request, client: `${contents}/Resources/app.asar.unpacked/out/cli/runtime-client.js` })
  return new Promise<string>((resolve, reject) => {
    execFile(
      `${contents}/MacOS/Orca`,
      ['-e', script, argument],
      { timeout: timeoutMs, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (error: Error | null, stdout: string) => (error && !stdout ? reject(error) : resolve(stdout))
    )
  })
}

/** Runs `/compact` in a chat session, throwing with the reason when Orca does not. */
export async function compactChat(sessionId: string): Promise<void> {
  const fields = { command: 'compact' }
  const output = await runInOrca(
    SCRIPT,
    {
      sessionId,
      fields,
      envelope: { sessionId, clientOperationId: operationId(), payloadFingerprint: payloadFingerprint(sessionId, fields) }
    },
    COMPACT_TIMEOUT_MS
  )
  const problem = compactProblem(output)
  if (problem) {
    throw new Error(problem)
  }
}
