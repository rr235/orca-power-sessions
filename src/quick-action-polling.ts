// Quick-action feedback and polling belong to one panel run and stop when that run ends.
import { atom, read, set, update, type PanelContext } from 'orca'
import type { Server } from './protocol'

export const startingActions = atom<Record<string, true>>({})

export function watchQuickActions(ctx: PanelContext, load: () => Promise<void>, servers: () => readonly Server[]) {
  let disposed = false
  let reading: Promise<void> | null = null
  const bootTimers = new Set<ReturnType<typeof setTimeout>>()
  const doneStarting = (id: string) => update(startingActions, ({ [id]: _, ...rest }) => rest)
  // Boot checks and command checks can share a read, but must not supersede one another.
  const poll = () => (reading ??= load().finally(() => {
    reading = null
  }))

  function watchStart(id: string, left = 10): void {
    if (disposed) {
      return
    }
    if (left === 0 || servers().some((s) => s.id === id && s.up)) {
      doneStarting(id)
      return
    }
    const timer = setTimeout(() => {
      bootTimers.delete(timer)
      void poll().then(() => watchStart(id, left - 1))
    }, 1000)
    bootTimers.add(timer)
  }

  // Commands without an address use foreground-process state, so check their completion sooner.
  // Address-based servers retain the panel's normal 15-second refresh cycle.
  const commandTimer = setInterval(() => {
    if (read(ctx.visible) && servers().some((s) => s.up && !s.url && s.terminal)) {
      void poll()
    }
  }, 2000)

  return {
    async start(id: string, run: () => Promise<boolean>): Promise<void> {
      update(startingActions, (all) => ({ ...all, [id]: true as const }))
      const succeeded = await run()
      if (disposed) {
        return
      }
      if (succeeded) {
        watchStart(id)
      } else {
        doneStarting(id)
      }
    },
    dispose(): void {
      disposed = true
      clearInterval(commandTimer)
      for (const timer of bootTimers) {
        clearTimeout(timer)
      }
      bootTimers.clear()
      set(startingActions, {})
    }
  }
}
