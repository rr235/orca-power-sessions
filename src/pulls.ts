// Pull request titles and states for the session details. Orca records them for the pull request
// it tracks, not for the others linked to a workspace, so `gh` reads those.
import { run } from './cli'
import type { PullRequestInfo } from './protocol'

// An open pull request is read again after this long, so a merge shows up; a merged or closed one
// is kept for the worker's lifetime.
const OPEN_TTL_MS = 5 * 60_000
const cache = new Map<string, { info: PullRequestInfo; at: number }>()

/** Title and state of these pull requests, by URL; one `gh` cannot read is left out. */
export async function pullRequestInfo(urls: string[]): Promise<Record<string, PullRequestInfo>> {
  const wanted = [...new Set(urls)].filter((url) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url))
  const now = Date.now()
  await Promise.all(
    wanted
      .filter((url) => {
        const hit = cache.get(url)
        return !hit || (hit.info.state === 'open' && now - hit.at > OPEN_TTL_MS)
      })
      .map(async (url) => {
        try {
          const info = infoOf(await run('gh', ['pr', 'view', url, '--json', 'title,state']))
          if (info) {
            cache.set(url, { info, at: now })
          }
        } catch {
          // No gh, not signed in, or no access: the details show the number alone.
        }
      })
  )
  return Object.fromEntries(wanted.flatMap((url) => (cache.has(url) ? [[url, cache.get(url)?.info as PullRequestInfo]] : [])))
}

/** Title and lowercase state (`open`, `merged`, `closed`) in `gh pr view --json title,state` output. */
export function infoOf(json: string): PullRequestInfo | null {
  try {
    const { title, state } = JSON.parse(json) as { title?: unknown; state?: unknown }
    if (typeof title !== 'string' || !title.trim()) {
      return null
    }
    return { title: title.trim(), state: typeof state === 'string' ? state.toLowerCase() : null }
  } catch {
    return null
  }
}
