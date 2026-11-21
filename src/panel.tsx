// The Power Sessions panel: quick action buttons on top, then every Orca project with its live agent
// sessions under it. No build step: Orca strips the types and compiles the JSX when it loads. Its
// state is in panel/state.ts, the session and quick action components beside it in panel/.
import { Box, Callout, IconButton, List, ListItem, on, read, Separator, Skeleton, Stack, storage, Text, type PanelContext } from 'orca'
import { ActionCard, ActionForm, editAction, LabelledButton } from './panel/actions'
import { ACTIONS_DESCRIPTION, ICON_INSET_PX, NoActionsNote, NoProjectsNote, SectionDescription, SESSIONS_DESCRIPTION } from './panel/section-notes'
import { groups, ProjectGroup, SessionRow } from './panel/sessions'
import {
  actionError,
  closeForm,
  editing,
  endPanelRun,
  EXPANDED_KEY,
  load,
  loadError,
  loadPinnedUsage,
  loadSelected,
  loadSoon,
  NEW_ACTION,
  overview,
  pinned,
  PINNED_KEY,
  readExpanded,
  refresh,
  REFRESH_MS,
  sections,
  SELECTED_MS,
  toggleActions,
  toggleFavourites,
  toggleSessions,
  watchActions
} from './panel/state'

export function setup(ctx: PanelContext): () => void {
  const polling = watchActions(ctx)
  ctx.subscriptions.push(
    on('agent.status.changed', loadSoon),
    on('workspace.created', loadSoon),
    on('workspace.removed', loadSoon)
  )
  const timer = setInterval(() => {
    if (read(ctx.visible)) {
      void load()
    }
  }, REFRESH_MS)
  const selectedTimer = setInterval(() => {
    if (read(ctx.visible)) {
      void loadSelected()
    }
  }, SELECTED_MS)
  ctx.subscriptions.push(
    storage.onDidChange(({ key }) => {
      if (key === EXPANDED_KEY) {
        void readExpanded()
      }
      if (key === PINNED_KEY) {
        void loadPinnedUsage()
      }
    })
  )
  void readExpanded()
  void load()
  void loadSelected()
  return () => {
    clearInterval(timer)
    clearInterval(selectedTimer)
    polling.dispose()
    endPanelRun()
  }
}

export default function Panel() {
  const data = read(overview)
  const error = read(loadError)
  const failure = read(actionError)
  const open = read(sections)
  const form = read(editing)
  const sessionsOpen = open.sessions !== false
  const favouritesOpen = open.favourites !== false
  // Without projects, Sessions shows the note on adding one, and Favourites and Refresh hide.
  const hasProjects = Boolean(data?.projects.length)
  const pins = read(pinned)
  const pinnedSessions = data ? pins.flatMap((key) => data.sessions.filter((s) => s.key === key)) : []
  return (
    <Box height="100%" gap="sm">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {failure ? <Callout tone="danger">{failure}</Callout> : null}
      {!data ? (
        <Skeleton lines={6} label="Loading" />
      ) : (
        // One scrolling column: Pinned, Sessions and Quick actions follow each other at their own
        // height, so nothing is cut off; a closed section takes only its header.
        <Box grow minHeight={0} scroll="y" gap="md">
          {/* Favourites come first and show whenever Orca has a project, with a header like Sessions':
              the arrow and the title open and close the section. Pinned sessions follow, each with its
              details open, in the order they were pinned. A line divides them from Sessions. */}
          {hasProjects ? (
            <Box shrink={false} gap="md">
              <Box gap="none" shrink={false}>
                <List>
                  <ListItem icon={favouritesOpen ? 'expand' : 'next'} onPress={toggleFavourites}>
                    <Text weight="medium">Favourites</Text>
                  </ListItem>
                </List>
                <SectionDescription text="Pin session details by clicking on the star button." />
              </Box>
              {favouritesOpen && pinnedSessions.length ? (
                <Box shrink={false}>
                  <Stack gap="md">
                    {pinnedSessions.map((session) => (
                      <SessionRow key={session.key} session={session} inPinnedArea />
                    ))}
                  </Stack>
                </Box>
              ) : null}
              <Box shrink={false}>
                <Separator />
              </Box>
            </Box>
          ) : null}
          <Box shrink={false} gap="md">
            {/* One pressable header like Quick actions': the arrow and the title open and close the
                section together. Its refresh button closes every session's details and reads Orca again;
                with no projects there is nothing to refresh, and the panel still reloads on its own. */}
            <Box gap="none" shrink={false}>
              <Box direction="row" align="center" justify="between" gap="sm">
                <Box grow minWidth={0}>
                  <List>
                    <ListItem icon={sessionsOpen ? 'expand' : 'next'} onPress={toggleSessions}>
                      <Text weight="medium">Sessions</Text>
                    </ListItem>
                  </List>
                </Box>
                {hasProjects ? <IconButton icon="refresh" label="Refresh sessions" size="xs" variant="ghost" onPress={refresh} /> : null}
              </Box>
              {/* The description starts where Quick actions' does. While the no projects note shows,
                  it is the note's first line instead. */}
              {sessionsOpen && !hasProjects ? null : (
                <SectionDescription text={SESSIONS_DESCRIPTION} />
              )}
            </Box>
            {sessionsOpen ? (
              <Box shrink={false}>
                <Stack gap="md">
                  {data.projects.length ? null : <NoProjectsNote />}
                  {groups(data.projects, data.sessions).map((group) => (
                    <ProjectGroup key={group.key} group={group} />
                  ))}
                </Stack>
              </Box>
            ) : null}
          </Box>
          {/* Quick actions follow Sessions directly; the column's md gap puts md above the line that
              divides them. The header is the panel's own, not a Collapsible, so it can carry a green dot
              while an action runs, open or closed; its arrow points right when closed and down when open,
              as Orca's does. */}
          <Box shrink={false} gap="xs">
            <Box shrink={false}>
              <Separator />
            </Box>
            {/* One pressable header: the arrow and the title open and close the section together. The
                dot has its own row, so it gets more room than the title's gap. */}
            <Box shrink={false}>
              <List>
                <ListItem icon={open.actions ? 'expand' : 'next'} onPress={toggleActions}>
                  <Box direction="row" align="center" gap="sm">
                    <Text weight="medium">Quick actions</Text>
                    {data.servers.some((action) => action.up) ? (
                      <Text size="xs" tone="success">
                        ●
                      </Text>
                    ) : null}
                  </Box>
                </ListItem>
              </List>
              {/* What the section is for, starting at the left edge of the Run icons below: the rows' inset,
                  then the gap before an icon centred in its CONTROL_PX slot. While the no actions note
                  shows, it is the note's first line instead. */}
              {open.actions && !data.servers.length ? null : (
                <SectionDescription text={ACTIONS_DESCRIPTION} />
              )}
              {/* Room between the description and the actions when they show. */}
              {open.actions ? <Box height={8} shrink={false} /> : null}
            </Box>
            {open.actions ? (
              <Box shrink={false}>
                <Stack gap="md">
                  {data.servers.length ? (
                    // Inset by the header's own padding, so Run sits under its arrow and the names under its title.
                    // An action's edit form opens under its row, where Edit was pressed: Orca's
                    // components cannot move focus or scroll to it.
                    <Box gap="sm" paddingX="xs">
                      {data.servers.map((action) =>
                        form === action.id ? (
                          <Stack key={action.id} gap="none">
                            <ActionCard action={action} />
                            <ActionForm key={form} id={form} actions={data.servers} projects={data.projects} />
                          </Stack>
                        ) : (
                          <ActionCard key={action.id} action={action} />
                        )
                      )}
                    </Box>
                  ) : (
                    <NoActionsNote />
                  )}
                  {/* Add action sits under the actions; the form for a new action opens between them
                      and it, and Add action's button then closes it. While an action is edited, it
                      opens the new action form instead. */}
                  <Stack gap="none">
                    {form === NEW_ACTION ? (
                      <Box paddingY="sm">
                        <ActionForm key={form} id={null} actions={data.servers} projects={data.projects} />
                      </Box>
                    ) : null}
                    {/* Starts where the header's arrow and description do. */}
                    <Box direction="row" gap="none" paddingX="xs">
                      <Box width={ICON_INSET_PX} minWidth={ICON_INSET_PX} shrink={false} />
                      <LabelledButton
                        text="Add action"
                        icon={form === NEW_ACTION ? 'close' : 'add'}
                        tooltip={form === NEW_ACTION ? 'Close new action' : undefined}
                        onPress={() => (form === NEW_ACTION ? closeForm() : editAction(null))}
                      />
                    </Box>
                  </Stack>
                </Stack>
              </Box>
            ) : null}
          </Box>
        </Box>
      )}
    </Box>
  )
}
