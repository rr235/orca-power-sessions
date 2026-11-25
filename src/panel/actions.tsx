// Quick actions in the panel: a card per action with Run, Stop, Show and Open, and the form that
// adds or edits one, with a row per step.
import { Box, Button, IconButton, Input, plugin, read, Select, set, shell, Text, Textarea, update } from 'orca'
import type { ActionStatus, Project, QuickActionInput } from '../protocol'
import { normalUrl, runCommand } from '../shared'
import { startingActions } from './quick-action-polling'
import { DOT_PX } from './sessions'
import { act, actionError, busy, closeForm, draft, editing, formError, NEW_ACTION, startAction } from './state'
import type { Draft } from './state'

// Both open in the default browser; Orca allows it only from the press itself.
const openAction = (action: ActionStatus) => void shell.openExternal(action.url as string)
const stopAction = (action: ActionStatus) =>
  act(`run:${action.id}`, () => plugin.request('server.stop', { id: action.id }), `Could not stop ${action.name}.`)

/** Opens the form for an action, or for a new one. */
export function editAction(action: ActionStatus | null): void {
  set(draft, { name: action?.name ?? '', steps: action?.steps ?? [''], projectId: action?.projectId ?? '', url: action?.url ?? '' })
  set(formError, null)
  set(editing, action?.id ?? NEW_ACTION)
}

/** What is missing before the form can be saved, or null. */
export function draftProblem(d: Draft): string | null {
  if (!d.projectId) {
    return 'Choose a project.'
  }
  if (!d.name.trim()) {
    return 'Give it a name.'
  }
  if (!d.steps.some((step) => step.trim())) {
    return 'Give it a command.'
  }
  // The address is optional: empty, it is read from the server's output at the next Run.
  return !d.url.trim() || normalUrl(d.url) ? null : 'Give it a web address, such as localhost:3000.'
}

async function saveDraft(id: string | null): Promise<void> {
  const d = read(draft)
  const problem = draftProblem(d)
  if (problem) {
    set(formError, problem)
    return
  }
  const steps = d.steps.map((step) => step.trim()).filter(Boolean)
  const input: QuickActionInput = { name: d.name, steps, projectId: d.projectId, url: d.url, ...(id ? { id } : {}) }
  await act('action:save', () => plugin.request('action.save', input), `Could not save ${d.name.trim()}.`)
  if (!read(actionError)) {
    closeForm()
  }
}

async function deleteAction(id: string, name: string): Promise<void> {
  await act('action:delete', () => plugin.request('action.delete', { id }), `Could not delete ${name}.`)
  if (!read(actionError)) {
    closeForm()
  }
}

export function ActionCard({ action }: { action: ActionStatus }) {
  const pending = Boolean(read(busy)[`run:${action.id}`])
  const ours = Boolean(action.terminal)
  const editingThis = read(editing) === action.id
  // Run and Stop share the last slot; an action with no Orca terminal to close, such as a dev server under pm2 or an agent, has nothing to stop.
  // Between Run and the action showing as running, Stop shows disabled.
  const control = !action.up && read(startingActions)[action.id] ? (
    <IconButton icon="stop" label={`Stop ${action.name}`} tooltip="Starting" size="xs" variant="ghost" disabled onPress={() => undefined} />
  ) : !action.up ? (
    <IconButton
      icon="play"
      label={`Run ${action.name}`}
      tooltip={`Run: ${runCommand(action.steps)}`}
      size="xs"
      variant="ghost"
      tone="accent"
      disabled={pending}
      onPress={() => startAction(action)}
    />
  ) : ours ? (
    <IconButton icon="stop" label={`Stop ${action.name}`} size="xs" variant="ghost" disabled={pending} onPress={() => stopAction(action)} />
  ) : null
  return (
    <Box direction="row" align="center" gap="xs">
      {/* The edit button, whose form opens under the row and which then closes it. A running action shows it disabled. */}
      <Box direction="row" align="center" justify="center" width={SLOT_PX} minWidth={SLOT_PX} shrink={false}>
        {action.up ? (
          <IconButton icon="edit" label={`Edit ${action.name}`} tooltip="Stop to edit" size="xs" variant="ghost" disabled onPress={() => undefined} />
        ) : (
          <IconButton
            icon={editingThis ? 'close' : 'edit'}
            label={editingThis ? `Close ${action.name}` : `Edit ${action.name}`}
            tooltip={editingThis ? 'Close edit action' : undefined}
            size="xs"
            variant="ghost"
            onPress={() => (editingThis ? closeForm() : editAction(action))}
          />
        )}
      </Box>
      {/* The name takes the free space, so the other buttons sit at the right edge. */}
      <Box grow minWidth={0}>
        <Text size="xs" muted truncate>
          {action.name}
        </Text>
      </Box>
      {/* Reserve optional controls so starting, stopping, or learning a URL never changes the name's space. */}
      <Box direction="row" align="center" justify="center" width={SLOT_PX} minWidth={SLOT_PX} shrink={false}>
        {action.up && ours ? (
          <IconButton icon="terminal" label={`Show ${action.name} terminal`} size="xs" variant="ghost" disabled={pending} onPress={() => startAction(action)} />
        ) : null}
      </Box>
      {/* Before the server printed its address there is nothing to open yet. */}
      <Box direction="row" align="center" justify="center" width={SLOT_PX} minWidth={SLOT_PX} shrink={false}>
        {action.up && action.url ? (
          <IconButton
            icon="open-external"
            label={`Open ${action.name}`}
            tooltip={ours ? `Open ${action.url}` : `Open ${action.url} (no terminal to stop)`}
            size="xs"
            variant="ghost"
            onPress={() => openAction(action)}
          />
        ) : null}
      </Box>
      {/* A running action shows the green dot of a working session, just before its Stop button. */}
      <Box direction="row" align="center" justify="center" width={DOT_PX} minWidth={DOT_PX} shrink={false}>
        {action.up ? (
          <Text size="xs" tone="success">
            ●
          </Text>
        ) : null}
      </Box>
      <Box direction="row" align="center" justify="center" width={SLOT_PX} minWidth={SLOT_PX} shrink={false}>
        {control}
      </Box>
    </Box>
  )
}

// Button slots stay the same width whether occupied or empty.
const SLOT_PX = 24

/** A muted label with its icon button right after it, on a line of its own. */
export function LabelledButton({ text, icon, tooltip, onPress }: { text: string; icon: 'add' | 'close'; tooltip?: string; onPress: () => void }) {
  return (
    <Box direction="row" align="center" gap="xs">
      <Box minWidth={0}>
        <Text size="xs" muted truncate>
          {text}
        </Text>
      </Box>
      <IconButton icon={icon} label={text} tooltip={tooltip} size="xs" variant="ghost" onPress={onPress} />
    </Box>
  )
}

/**
 * An action's commands, a row each in the order they run. With more than one, each row can be
 * removed; Add step adds an empty row at the end.
 */
function StepRows({ steps, onChange }: { steps: string[]; onChange: (steps: string[]) => void }) {
  const several = steps.length > 1
  return (
    <Box gap="xs">
      {steps.map((step, i) => {
        const field = {
          label: `Step ${i + 1}`,
          labelHidden: true,
          value: step,
          placeholder: i === 0 ? 'npm run dev' : 'Next command',
          onChange: (value: string) => onChange(steps.map((s, j) => (j === i ? value : s)))
        }
        return (
          <Box key={i} direction="row" align="center" gap="xs">
            <Box grow minWidth={0}>
              {step.includes('\n') ? <Textarea {...field} rows={2} /> : <Input {...field} />}
            </Box>
            {several ? (
              <IconButton icon="close" label={`Remove step ${i + 1}`} size="xs" variant="ghost" onPress={() => onChange(steps.filter((_, j) => j !== i))} />
            ) : null}
          </Box>
        )
      })}
      <Box direction="row">
        <Button variant="ghost" size="xs" tooltip="Add a command to run after the last one" onPress={() => onChange([...steps, ''])}>
          Add step +
        </Button>
      </Box>
    </Box>
  )
}

/** The form for one quick action: its name, its commands, and the project whose checkout runs them. */
export function ActionForm({ id, actions, projects }: { id: string | null; actions: ActionStatus[]; projects: Project[] }) {
  const d = read(draft)
  const problem = read(formError)
  const saving = Boolean(read(busy)['action:save'] || read(busy)['action:delete'])
  const action = id ? actions.find((s) => s.id === id) : undefined
  // Only a project with a main checkout can run a command.
  const choices = projects.filter((p) => p.path)
  const edit = (change: Partial<Draft>) => {
    update(draft, (current) => ({ ...current, ...change }))
    set(formError, null)
  }
  return (
    // A card like the session details, so the form stands apart from the actions above it.
    <Box background="accent" radius="lg" padding="sm" gap="md" margin="xs">
      <Box gap="xs">
        <Text size="sm">{action ? 'Edit action' : 'Add new action'}</Text>
        {/* The placeholders show examples only, so the note says what is optional. */}
        <Text size="xs" muted>
          The commands run serially in order in the project's main checkout.
        </Text>
        <Text size="xs" muted>
          Add a URL only if it differs from the one the server prints.
        </Text>
      </Box>
      {/* No visible labels: the placeholders name the fields, the hidden labels serve screen readers.
          Project and name share a row, half each. */}
      <Box direction="row" align="center" gap="sm">
        <Box grow minWidth={0} width="50%">
          <Select
            label="Project"
            labelHidden
            value={d.projectId || undefined}
            placeholder="Project"
            options={choices.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(projectId) => edit({ projectId })}
          />
        </Box>
        <Box grow minWidth={0} width="50%">
          <Input label="Name" labelHidden value={d.name} placeholder="Name" maxLength={40} onChange={(name) => edit({ name })} />
        </Box>
      </Box>
      <StepRows steps={d.steps} onChange={(steps) => edit({ steps })} />
      <Input label="URL" labelHidden value={d.url} placeholder="URL (optional)" onChange={(url) => edit({ url })} />
      {problem ? (
        <Text size="xs" tone="danger">
          {problem}
        </Text>
      ) : null}
      {/* One button on the right (Orca puts a Button's icon before its text, so Add's plus is text);
          an action being edited also has a small Delete on the left. The row's button or Add
          action's closes the form. */}
      <Box direction="row" align="center" justify="between" gap="sm">
        {action ? (
          <Button variant="ghost" tone="danger" size="xs" tooltip={`Remove ${action.name} action from quick actions`} disabled={saving} onPress={() => void deleteAction(action.id, action.name)}>
            Delete
          </Button>
        ) : (
          <Box />
        )}
        <Box direction="row" align="center" gap="xs">
          <Button variant="ghost" size="xs" disabled={saving} onPress={closeForm}>
            Cancel
          </Button>
          <Button variant="solid" tone="neutral" size="xs" disabled={saving} onPress={() => void saveDraft(id)}>
            {action ? 'Save' : 'Add +'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
