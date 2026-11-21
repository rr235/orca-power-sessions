// Pure helpers both the panel and the worker use. No Node imports: the panel bundles this file.

/** The command a terminal runs for an action's steps: each after the one before succeeds. One step
 *  is its command as typed. */
export const runCommand = (steps: readonly string[]): string => steps.join(' && ')

const CHAT_PANE = 'structured-agent-session-'
const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** Orca's session id for a chat pane (`structured-agent-session-<id>:<leaf>`), else null. */
export function chatSessionId(paneKey: string): string | null {
  if (!paneKey.startsWith(CHAT_PANE)) {
    return null
  }
  const id = paneKey.slice(CHAT_PANE.length).split(':')[0]
  return SAFE_ID.test(id) ? id : null
}

/**
 * The tab Orca's runtime knows a session's pane by. A chat's pane key is
 * `structured-agent-session-<sessionId>:<leafId>` and its tab is `agent-session:<sessionId>`; a
 * terminal's pane key is `<tabId>:<leafId>`.
 */
export function tabOfPane(paneKey: string): { tabId: string; leafId?: string } | null {
  const chat = chatSessionId(paneKey)
  if (chat) {
    return { tabId: `agent-session:${chat}` }
  }
  const [tabId, leafId] = paneKey.split(':')
  return tabId && leafId ? { tabId, leafId } : null
}

/**
 * A typed quick action address as the panel stores it: `localhost:3000` becomes `http://localhost:3000`,
 * and a trailing slash goes. Null when it is not an http or https address. Shared by the panel,
 * which checks the form, and the worker, which saves it.
 */
export function normalUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text) {
    return null
  }
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `http://${text}`)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
      return null
    }
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
    return `${url.origin}${path}${url.search}`
  } catch {
    return null
  }
}
