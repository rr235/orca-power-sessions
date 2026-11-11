// Shared session formatting and detail rows, used by the Power Sessions panel.
import { Box, Button, env, Image, Progress, Text } from 'orca'
import type { Session, SessionUsage, TokenSplit } from './protocol'

/** A plugin image `px` wide: Orca's smallest Image is 48px, but it never grows past its box. */
export function Icon({ src, alt = '', px, rounded }: { src: string; alt?: string; px: number; rounded?: boolean }) {
  return (
    <Box width={px} minWidth={px} shrink={false}>
      <Image src={src} alt={alt} size="xs" rounded={rounded} />
    </Box>
  )
}

// States read in lowercase, like `idle` and `active`.
const OUTCOME_LABEL: Record<string, string> = {
  success: 'idle',
  failure: 'failed',
  cancellation: 'cancelled',
  interruption: 'interrupted',
  superseded: 'superseded',
  unconfirmed: 'unconfirmed'
}
export const AGENT_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex' }
const EFFORT_LABEL: Record<string, string> = { xhigh: 'Extra high', max: 'Max', none: 'No' }

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

/** A model id as people say it: `claude-opus-5-5` is Opus 5.5, `gpt-6.1-sol` is GPT-6.1 Sol. */
export function modelLabel(id: string): string {
  const base = id.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(base)
  if (claude) {
    return `${capital(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  }
  const gpt = /^gpt-([^-]+)(.*)$/.exec(base)
  if (gpt) {
    return `GPT-${gpt[1]}${gpt[2].split('-').filter(Boolean).map((word) => ` ${capital(word)}`).join('')}`
  }
  return base
}

/** A Fable or Astra model's name is in the warning colour. */
export function modelTone(label: string): 'warning' | undefined {
  return /\b(fable|astra)\b/i.test(label) ? 'warning' : undefined
}

/** A token count in a few characters: 950, 12k, 2.9M. */
export function tokenLabel(tokens: number): string {
  const short = (value: number, unit: string) => `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, '')}${unit}`
  if (tokens >= 1e6) {
    return short(tokens / 1e6, 'M')
  }
  return tokens >= 1e3 ? short(tokens / 1e3, 'k') : String(tokens)
}

/** The tokens used: `2.9M tokens total: 152k input, 38k output, 2.7M cached`. */
export function tokensStatement(tokens: number, split: TokenSplit | null): string {
  const total = `${tokenLabel(tokens)} ${tokens === 1 ? 'token' : 'tokens'} total`
  if (!split) {
    return total
  }
  return `${total}: ${tokenLabel(split.input)} input, ${tokenLabel(split.output)} output, ${tokenLabel(split.cached)} cached`
}

/** Context use as `121k` of `1M`, and the percent (0 to 100) for the bar; no window, no bar. */
export function contextLabel(used: number, window: number | null): { used: string; window: string | null; percent: number | null } {
  if (!window) {
    return { used: tokenLabel(used), window: null, percent: null }
  }
  return { used: tokenLabel(used), window: tokenLabel(window), percent: Math.min(100, Math.max(0, Math.round((used / window) * 100))) }
}

type StatusIcon = 'working' | 'waiting' | 'failed' | 'stopped' | 'idle'

const OUTCOME_ICON: Record<string, StatusIcon> = {
  success: 'idle',
  failure: 'failed',
  cancellation: 'stopped',
  interruption: 'stopped',
  superseded: 'stopped'
}

export function statusOf(session: Session): { label: string; icon: StatusIcon; live: boolean } {
  switch (session.state) {
    case 'working':
      return { label: 'active', icon: 'working', live: true }
    case 'blocked':
      return { label: 'blocked', icon: 'waiting', live: true }
    case 'waiting':
      return { label: 'needs input', icon: 'waiting', live: true }
    default: {
      const outcome = session.outcome ?? ''
      return { label: OUTCOME_LABEL[outcome] ?? 'idle', icon: OUTCOME_ICON[outcome] ?? 'idle', live: false }
    }
  }
}

export type FactIcon = 'branch' | `status-${Exclude<StatusIcon, 'working' | 'idle'>}`

/**
 * One row of the details: a small Lucide icon (or `lead`, such as a spinner), then its value. Every
 * row has this shape and the same spacing. Orca's own icons have one size, so `bun scripts/icons.ts`
 * draws these as PNGs, one per colour scheme.
 */
export function Fact({ icon, lead, alt, children }: { icon?: FactIcon; lead?: unknown; alt: string; children: unknown }) {
  return (
    <Box direction="row" align="center" gap="xs" minWidth={0}>
      {lead ?? <Icon src={`assets/details/${icon}-${env.theme.colorScheme}.png`} alt={alt} px={12} />}
      <Box direction="row" align="center" gap="xs" minWidth={0} grow>
        {children}
      </Box>
    </Box>
  )
}

/** `Opus 5.5, High` on the left, total tokens on the right. */
export function ModelFact({ session, stats }: { session: Session; stats: SessionUsage | undefined }) {
  const agent = session.agent ? (AGENT_LABEL[session.agent] ?? capital(session.agent)) : 'Agent'
  const effort = stats?.effort ? (EFFORT_LABEL[stats.effort] ?? capital(stats.effort)) : null
  const model = stats?.model ? modelLabel(stats.model) : agent
  const tone = modelTone(model)
  return (
    <Box direction="row" align="center" gap="sm" minWidth={0}>
      {/* A Fable or Astra model's name is in the warning colour. */}
      <Box grow minWidth={0}>
        <Text size="xs" tone={tone} truncate>
          {effort ? `${model}, ` : model}
          {effort ? (
            <Text size="xs" muted>
              {effort}
            </Text>
          ) : null}
        </Text>
      </Box>
      {stats?.tokens != null ? (
        <Box shrink={false}>
          {/* A ghost button only for its tooltip: Orca's Text has no tooltip. */}
          <Button variant="ghost" size="xs" tooltip={tokensStatement(stats.tokens, stats.tokenSplit)}>
            {tokenLabel(stats.tokens)}
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}

/** How full the context window was at the last turn: a bar, then `121k / 1M`. */
export function ContextFact({ used, window }: { used: number; window: number | null }) {
  const label = contextLabel(used, window)
  return (
    <Box direction="row" align="center" gap="xs" minWidth={0}>
      {label.percent != null ? (
        <Box grow minWidth={0}>
          <Progress label="Context used" labelHidden value={label.percent} />
        </Box>
      ) : null}
      <Box shrink={false}>
        <Text size="xs">
          {label.used}
          {label.window ? (
            <Text size="xs" muted>
              {` / ${label.window}`}
            </Text>
          ) : null}
        </Text>
      </Box>
    </Box>
  )
}

/** `12 turns, 1 compaction, 0 tool calls`: a count with its noun, singular for one. */
export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Turns since the last compaction (or since the start, before one): no colour up to 20, yellow
 * from 21 to 35, red from 36.
 */
export function turnsTone(turns: number): 'warning' | 'danger' | undefined {
  return turns > 35 ? 'danger' : turns > 20 ? 'warning' : undefined
}

/**
 * The turns and tool calls since the last compaction, which only differ from the totals once the
 * context has been compacted, then the totals in the same shape, `40 turns, 186 tool calls, 3
 * compactions`, all muted. Before the first compaction the total turns take the colour instead.
 */
export function TurnsFact({ stats }: { stats: SessionUsage }) {
  const turns = countLabel(stats.turns ?? 0, 'turn')
  const compactions = stats.compactions
  const rest = [
    stats.toolCalls != null ? countLabel(stats.toolCalls, 'tool call') : null,
    compactions != null ? countLabel(compactions, 'compaction') : null
  ].filter((part) => part !== null)
  return (
    <Box gap="xs" minWidth={0}>
      {compactions && stats.turnsSinceCompaction != null ? (
        <Text size="xs" truncate>
          <Text size="xs" tone={turnsTone(stats.turnsSinceCompaction)}>
            {`${countLabel(stats.turnsSinceCompaction, 'turn')}${stats.toolCallsSinceCompaction != null ? ', ' : ' '}`}
          </Text>
          <Text size="xs" muted>
            {`${stats.toolCallsSinceCompaction != null ? `${countLabel(stats.toolCallsSinceCompaction, 'tool call')} ` : ''}since the last compaction`}
          </Text>
        </Text>
      ) : null}
      <Text size="xs" truncate>
        <Text size="xs" muted={Boolean(compactions)} tone={compactions ? undefined : turnsTone(stats.turns ?? 0)}>
          {rest.length ? `${turns}, ` : turns}
        </Text>
        {rest.length ? (
          <Text size="xs" muted>
            {rest.join(', ')}
          </Text>
        ) : null}
      </Text>
    </Box>
  )
}

