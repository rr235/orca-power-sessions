/**
 * A typed server address as the panel stores it: `localhost:3000` becomes `http://localhost:3000`,
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
