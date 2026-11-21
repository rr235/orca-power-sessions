// A Claude session's context window and effort, worked out as Claude Code does: from its settings
// files and the flags its process was started with. These are Claude Code's own files and process
// arguments, never Orca's. The resolving is pure, so the tests feed it fixtures.
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from '../cli'

/** What a Claude process was started with, from its arguments; null when not given. */
export type Launch = { model: string | null; effort: string | null; autocompact: string | null }
/** The part of a Claude Code settings file that sets the window or effort. */
export type ClaudeSettings = {
  model?: unknown
  effortLevel?: unknown
  autoCompactWindow?: unknown
  modelSettings?: Record<string, { effortLevel?: unknown; autoCompactWindow?: unknown } | undefined>
  env?: Record<string, unknown>
}

/** A session with no live process to read flags from. */
export const NO_LAUNCH: Launch = { model: null, effort: null, autocompact: null }
const MIN_WINDOW = 100_000
const MAX_WINDOW = 1_000_000

/** `--model`, `--effort` and `--autocompact` from a process's command line, as `--flag=value` or `--flag value`. */
export function launchFlags(command: string): Launch {
  const flag = (name: string) => new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(\\S+)`).exec(command)?.[1] ?? null
  return { model: flag('model'), effort: flag('effort'), autocompact: flag('autocompact') }
}

/** A token count as Claude Code reads one: a number, or text such as `400000`, `400k` or `1M`. */
function tokenCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null
  }
  const match = typeof value === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(value) : null
  if (!match) {
    return null
  }
  const scale = match[2].toLowerCase() === 'k' ? 1_000 : match[2].toLowerCase() === 'm' ? 1_000_000 : 1
  return Math.round(Number(match[1]) * scale)
}

/**
 * A model's full context window in Claude Code: 1M for `[1m]` ids and, by default, for Fable,
 * Sonnet 5 and later, Haiku 5.5 and later and Opus 4.7 and later; 200k otherwise, and for every
 * model when 1M context is turned off. Null for a model this cannot tell.
 */
export function modelWindow(model: string, oneM = false, disable1m = false): number | null {
  const id = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-|\[|$)/.exec(model)
  if (!id) {
    return null
  }
  if (disable1m) {
    return 200_000
  }
  if (oneM || model.includes('[1m]')) {
    return MAX_WINDOW
  }
  const [family, major, minor] = [id[1], Number(id[2]), Number(id[3] ?? 0)]
  const version = major + minor / 10
  const long =
    family === 'fable' || family === 'mythos' || (family === 'sonnet' && major >= 5) || (family === 'haiku' && version >= 5.5) || (family === 'opus' && version >= 4.7)
  return long ? MAX_WINDOW : 200_000
}

/** The keys a model's `modelSettings` entry can have: its id, then its id without a date. */
const modelKeys = (model: string) => [...new Set([model.replace(/\[1m\]$/, ''), model.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '')])]

function modelSetting<K extends 'effortLevel' | 'autoCompactWindow'>(file: ClaudeSettings, model: string, key: K): unknown {
  for (const name of modelKeys(model)) {
    const value = file.modelSettings?.[name]?.[key]
    if (value != null) {
      return value
    }
  }
  return file[key] ?? null
}

/** The first value `pick` finds, from the highest-precedence file down. */
function first<T>(files: readonly ClaudeSettings[], pick: (file: ClaudeSettings) => T | null): T | null {
  for (const file of files) {
    const value = pick(file)
    if (value != null) {
      return value
    }
  }
  return null
}

/**
 * The window a Claude session compacts at, which Claude Code reports as its context window: the
 * model's window, capped by the auto-compact window. That comes from `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
 * in a settings file's `env`, else the `--autocompact` flag, else `modelSettings` or
 * `autoCompactWindow` in the highest-precedence file that sets one. `files` run from the highest
 * precedence down.
 */
export function contextWindow(model: string, launch: Launch, files: readonly ClaudeSettings[]): number | null {
  const disable1m = first(files, (f) => (f.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT ? true : null)) === true
  const chosen = launch.model ?? first(files, (f) => (typeof f.model === 'string' ? f.model : null))
  const full = modelWindow(model, Boolean(chosen?.includes('[1m]')), disable1m)
  const flag = launch.autocompact === 'auto' ? null : tokenCount(launch.autocompact)
  const auto =
    first(files, (f) => tokenCount(f.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW)) ??
    flag ??
    (launch.autocompact === 'auto' ? null : first(files, (f) => tokenCount(modelSetting(f, model, 'autoCompactWindow'))))
  if (auto === null) {
    return full
  }
  const bounded = Math.min(Math.max(auto, MIN_WINDOW), MAX_WINDOW)
  return full === null ? bounded : Math.min(bounded, full)
}

/** A Claude session's effort: its `--effort` flag, else `modelSettings` or `effortLevel` in the highest-precedence file that sets one. */
export function effortOf(model: string | null, launch: Launch, files: readonly ClaudeSettings[]): string | null {
  if (launch.effort) {
    return launch.effort
  }
  const value = first(files, (f) => (model ? modelSetting(f, model, 'effortLevel') : (f.effortLevel ?? null)))
  return typeof value === 'string' ? value : null
}

async function readSettings(path: string): Promise<ClaudeSettings | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ClaudeSettings
  } catch {
    return null
  }
}

/** Claude Code's settings files for a checkout, from the highest precedence down: managed, local, project, user. */
export async function settingsFor(cwd: string): Promise<ClaudeSettings[]> {
  const paths = [
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.json')
  ]
  return (await Promise.all(paths.map(readSettings))).filter((file): file is ClaudeSettings => file !== null)
}

/**
 * What each running Claude session was started with, by session id: Claude Code lists its live
 * processes in `~/.claude/sessions/<pid>.json`, and `ps` gives each one's arguments.
 */
export async function liveLaunches(): Promise<Map<string, Launch>> {
  const folder = join(homedir(), '.claude', 'sessions')
  const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => /^\d+\.json$/.test(name))
  const sessions = new Map<number, string>()
  for (const name of names) {
    try {
      const entry = JSON.parse(await readFile(join(folder, name), 'utf8')) as { pid?: unknown; sessionId?: unknown }
      if (typeof entry.pid === 'number' && typeof entry.sessionId === 'string') {
        sessions.set(entry.pid, entry.sessionId)
      }
    } catch {
      // A file being written is read on the next refresh.
    }
  }
  if (!sessions.size) {
    return new Map()
  }
  const out = await run('ps', ['-o', 'pid=,command=', '-p', [...sessions.keys()].join(',')]).catch(() => '')
  const launches = new Map<string, Launch>()
  for (const line of out.split('\n')) {
    const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? []
    const session = pid ? sessions.get(Number(pid)) : undefined
    // A reused pid runs something else.
    if (session && /(^|\/)claude(\s|$)/.test(command.split(' --')[0])) {
      launches.set(session, launchFlags(command))
    }
  }
  return launches
}

