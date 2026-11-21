// The quick actions in plugin storage: the list as the person saved it, the terminal each was
// started in and where its latest start's output begins. Every change goes through one queue, so
// concurrent requests never overwrite each other.
import type { OrcaWorkerApi } from 'orca/worker'
import type { QuickAction } from '../protocol'
import { storedActions } from './rules'

// The quick actions, as the person last saved them.
const ACTIONS_KEY = 'quickActions'
// Quick action id -> the terminal handle it was started in, kept across worker restarts.
const HANDLES_KEY = 'serverTerminals'
export type Handles = Record<string, string>
// Quick action id -> where the output of its latest start begins (null: read the tail), until it prints its address.
const STARTS_KEY = 'serverStarts'
export type Starts = Record<string, string | null>

export type ActionStore = ReturnType<typeof actionStore>

export function actionStore(storage: OrcaWorkerApi['storage']) {
  async function record<T>(key: string): Promise<Record<string, T>> {
    const stored = await storage.get(key)
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, T>) : {}
  }
  const handles = (): Promise<Handles> => record<string>(HANDLES_KEY)
  const starts = (): Promise<Starts> => record<string | null>(STARTS_KEY)

  // All storage read-modify-write operations share a queue, including concurrent actions.
  let writes: Promise<unknown> = Promise.resolve()
  function write<T>(edit: () => Promise<T>): Promise<T> {
    const next = writes.then(edit)
    writes = next.catch(() => undefined)
    return next
  }

  /** The stored quick actions; none before anything was saved. */
  async function actions(): Promise<QuickAction[]> {
    return storedActions(await storage.get(ACTIONS_KEY)) ?? []
  }

  async function action(id: string): Promise<QuickAction> {
    const found = (await actions()).find((a) => a.id === id)
    if (!found) {
      throw Object.assign(new Error(`Unknown quick action ${id}`), { code: 'invalid_params' })
    }
    return found
  }

  // Changes to the stored list run one at a time, so a save and a learned address never overwrite each other.
  function change(edit: (actions: QuickAction[]) => QuickAction[]): Promise<QuickAction[]> {
    return write(async () => {
      const current = await actions()
      const edited = edit(current)
      if (JSON.stringify(edited) !== JSON.stringify(current)) {
        await storage.set(ACTIONS_KEY, edited)
      }
      return edited
    })
  }

  /** Marks a start, so the address its output prints replaces the stored one. */
  async function markStart(id: string, cursor: string | null): Promise<void> {
    await write(async () => storage.set(STARTS_KEY, { ...(await starts()), [id]: cursor }))
  }

  async function forgetStarts(ids: readonly string[]): Promise<void> {
    await write(async () => {
      const current = await starts()
      if (ids.some((id) => id in current)) {
        await storage.set(STARTS_KEY, Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))))
      }
    })
  }

  /** Moves each start's cursor from `from` to `to`, unless a start marked the action again meanwhile. */
  async function moveStarts(moves: ReadonlyMap<string, [from: string, to: string]>): Promise<void> {
    await write(async () => {
      const current = await starts()
      const moved = [...moves].filter(([id, [from]]) => current[id] === from)
      if (moved.length) {
        await storage.set(STARTS_KEY, { ...current, ...Object.fromEntries(moved.map(([id, [, to]]) => [id, to])) })
      }
    })
  }

  /**
   * Saves the terminals `watch` finds, from the stored handles and actions, keeping closed
   * associations, and answers what it found.
   */
  function saveWatched<T extends { terminals: Record<string, string | null> }>(watch: (known: Handles, actions: QuickAction[]) => T): Promise<T> {
    return write(async () => {
      const known = await handles()
      const watched = watch(known, await actions())
      const live = Object.fromEntries(Object.entries(watched.terminals).filter((entry): entry is [string, string] => entry[1] !== null))
      const next = { ...known, ...live }
      if (JSON.stringify(next) !== JSON.stringify(known)) {
        await storage.set(HANDLES_KEY, next)
      }
      return watched
    })
  }

  async function setHandle(id: string, handle: string): Promise<void> {
    await write(async () => storage.set(HANDLES_KEY, { ...(await handles()), [id]: handle }))
  }

  async function forgetTerminal(id: string): Promise<void> {
    await write(async () => {
      const { [id]: _, ...rest } = await handles()
      await storage.set(HANDLES_KEY, rest)
    })
    await forgetStarts([id])
  }

  return { actions, action, change, handles, starts, markStart, forgetStarts, moveStarts, saveWatched, setHandle, forgetTerminal }
}
