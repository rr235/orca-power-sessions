// The Power Sessions panel: quick action buttons on top, then every Orca project with its live agent
// sessions under it. No build step: Orca strips the types and compiles the JSX when it loads. Its
// state is in panel/state.ts, the session and quick action components beside it in panel/.
import { Box, Callout, IconButton, List, ListItem, on, read, Skeleton, Stack, storage, Text, type PanelContext } from 'orca'
import { ActionCard, ActionForm, editAction, LabelledButton } from './panel/actions'
import { ICON_INSET_PX, NoActionsNote, NoProjectsNote, SectionDescription } from './panel/section-notes'
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
  projectsWithSessionsOnly,
  readExpanded,
  refresh,
  REFRESH_MS,
  sections,
  SELECTED_MS,
  toggleActions,
  toggleFavourites,
  toggleProjectsWithSessionsOnly,
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
  const activeOnly = read(projectsWithSessionsOnly)
  const allGroups = data ? groups(data.projects, data.sessions) : []
  const shownGroups = activeOnly ? allGroups.filter((group) => group.sessions.length) : allGroups
  return (
    <Box height="100%" gap="sm">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {failure ? <Callout tone="danger">{failure}</Callout> : null}
      {!data ? (
        <Skeleton lines={6} label="Loading" />
      ) : (
        // One scrolling column: Pinned, Sessions and Quick actions follow each other at their own
        // height, so nothing is cut off; a closed section takes only its header.
        <Box grow minHeight={0} scroll="y" gap="lg">
          {/* Favourites come first and show whenever Orca has a project, with a header like Sessions':
              the arrow and the title open and close the section. Pinned sessions follow, each with its
              details open, in the order they were pinned. */}
          {hasProjects ? (
            <Box shrink={false} gap="none">
              <Box gap="none" shrink={false}>
                <List>
                  <ListItem icon={favouritesOpen ? 'expand' : 'next'} onPress={toggleFavourites}>
                    <Text weight="medium" muted>
                      Favourites
                    </Text>
                  </ListItem>
                </List>
                {/* How to pin, inside the section: it shows only while Favourites is open and empty. */}
                {favouritesOpen && !pinnedSessions.length ? <SectionDescription text="Pin session details by clicking on the star button." /> : null}
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
            </Box>
          ) : null}
          <Box shrink={false} gap="none">
            {/* One pressable header like Quick actions': the arrow and the title open and close the
                section together. Its activity button shows only projects with sessions, or all of them
                again; its refresh button closes every session's details and reads Orca again. With no
                projects neither has anything to act on, and the panel still reloads on its own. */}
            <Box gap="none" shrink={false}>
              <Box direction="row" align="center" justify="between" gap="sm">
                <Box grow minWidth={0}>
                  <List>
                    <ListItem icon={sessionsOpen ? 'expand' : 'next'} onPress={toggleSessions}>
                      <Text weight="medium" muted>
                        Sessions
                      </Text>
                    </ListItem>
                  </List>
                </Box>
                {hasProjects ? (
                  <Box direction="row" align="center" gap="none" shrink={false}>
                    <IconButton
                      icon="activity"
                      label={activeOnly ? 'Show all projects' : 'Show only projects with sessions'}
                      size="xs"
                      variant="ghost"
                      tone={activeOnly ? 'accent' : undefined}
                      onPress={toggleProjectsWithSessionsOnly}
                    />
                    <IconButton icon="refresh" label="Refresh sessions" size="xs" variant="ghost" onPress={refresh} />
                  </Box>
                ) : null}
              </Box>
            </Box>
            {sessionsOpen ? (
              <Box shrink={false}>
                <Stack gap="md">
                  {data.projects.length ? null : <NoProjectsNote />}
                  {hasProjects && activeOnly && !shownGroups.length ? (
                    <SectionDescription text="No project has a session. Press the activity button to show all projects." />
                  ) : null}
                  {shownGroups.map((group) => (
                    <ProjectGroup key={group.key} group={group} />
                  ))}
                </Stack>
              </Box>
            ) : null}
          </Box>
          {/* Quick actions follow Sessions directly, the column's lg gap apart. The header is the
              panel's own, not a Collapsible, so it can carry a green dot while an action runs, open or
              closed; its arrow points right when closed and down when open, as Orca's does. */}
          <Box shrink={false} gap="none">
            {/* One pressable header: the arrow and the title open and close the section together. The
                dot has its own row, so it gets more room than the title's gap. */}
            <Box shrink={false}>
              <List>
                <ListItem icon={open.actions ? 'expand' : 'next'} onPress={toggleActions}>
                  <Box direction="row" align="center" gap="sm">
                    <Text weight="medium" muted>
                      Quick actions
                    </Text>
                    {data.servers.some((action) => action.up) ? (
                      <Text size="xs" tone="success">
                        ●
                      </Text>
                    ) : null}
                  </Box>
                </ListItem>
              </List>
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
