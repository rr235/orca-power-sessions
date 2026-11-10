// The quick actions: dev servers the panel starts. Each runs `command` in a terminal at `path`, the
// main checkout of an Orca project. There are none built in: the person adds them in the panel, and
// the worker keeps them in plugin storage. A server counts as running while something answers on its address's port,
// however it was started. The address is learned from what the server prints when it starts.
import type { Project, QuickAction, QuickActionInput } from './protocol'
import { normalUrl } from './url'

/** The terminal title a server's terminal gets, so it is found again after a worker restart. The
 *  prefix keeps it apart from agent terminals, which take their conversation's name. */
export const terminalTitle = (action: Pick<QuickAction, 'id' | 'name'>): string => `⚡ ${action.name} server (${action.id})`

/** The port an address points at, or null for one that is not a local http address. */
export function portOf(url: string | null): number | null {
  if (!url) {
    return null
  }
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    if (!['http:', 'https:'].includes(parsed.protocol) ||
      !(host === 'localhost' || host.endsWith('.localhost') || ['127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(host))) {
      return null
    }
    return parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9-]+\.localhost):\d+[^\s'"<>)\]]*/gi

/**
 * The address a dev server printed as it started: the one on a line that says `Local` (Vite and
 * Next.js print it so), else the last local address, since a command that starts other services
 * first prints theirs earlier. `0.0.0.0` opens as `localhost`; a trailing slash or full stop is dropped.
 */
export function printedUrl(lines: readonly string[]): string | null {
  let last: string | null = null
  for (const line of lines) {
    const found = line.match(LOCAL_URL)
    if (!found) {
      continue
    }
    const url = found[0]
    if (/\blocal\b/i.test(line)) {
      return tidy(url)
    }
    last = url
  }
  return last ? tidy(last) : null
}

const tidy = (url: string) => url.replace('://0.0.0.0', '://localhost').replace(/[/.,;:]+$/, '')

/** The stored list, or null when nothing valid is stored yet. */
export function storedActions(value: unknown): QuickAction[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value.filter(
    (a): a is QuickAction =>
      Boolean(a) && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.command === 'string' && typeof a.path === 'string'
  )
}

/** Links each action without a project to the Orca project whose main checkout is its folder. */
export function linkProjects(actions: QuickAction[], projects: readonly Project[]): QuickAction[] {
  return actions.map((action) => {
    if (action.projectId) {
      return action
    }
    const project = projects.find((p) => p.path === action.path)
    return project ? { ...action, projectId: project.id } : action
  })
}

const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid_params' })

/**
 * The list with `input` added, or replacing the action with its id. A typed `url` is the address
 * (empty: read it at the next Run); without one, a new command or project forgets the address the
 * server printed.
 */
export function saveAction(actions: QuickAction[], input: QuickActionInput, projects: readonly Project[], newId: string): QuickAction[] {
  const name = input.name.trim()
  const command = input.command.trim()
  const project = projects.find((p) => p.id === input.projectId)
  if (!name || !command) {
    throw invalid('A quick action needs a name and a command.')
  }
  const typed = input.url === undefined ? undefined : normalUrl(input.url)
  if (input.url?.trim() && !typed) {
    throw invalid(`Not a web address: ${input.url}`)
  }
  if (!project?.path) {
    throw invalid('Choose a project with a main checkout.')
  }
  const existing = input.id ? actions.find((a) => a.id === input.id) : undefined
  if (input.id && !existing) {
    throw invalid(`Unknown quick action ${input.id}`)
  }
  if (!existing) {
    return [...actions, { id: newId, name, command, projectId: project.id, path: project.path, url: typed ?? null }]
  }
  const moved = existing.projectId !== project.id || existing.path !== project.path
  const next: QuickAction = {
    ...existing,
    name,
    command,
    projectId: project.id,
    path: project.path,
    url: typed !== undefined ? typed : moved || command !== existing.command ? null : existing.url
  }
  return actions.map((a) => (a.id === existing.id ? next : a))
}

/** The output lines of `orca terminal read --json`. */
export function terminalTail(json: string): string[] {
  try {
    const tail = (JSON.parse(json) as { result?: { terminal?: { tail?: unknown } } }).result?.terminal?.tail
    return Array.isArray(tail) ? tail.filter((line): line is string => typeof line === 'string') : []
  } catch {
    return []
  }
}
