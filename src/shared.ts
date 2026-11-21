// Pure helpers both the panel and the worker use. No Node imports: the panel bundles this file.

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
