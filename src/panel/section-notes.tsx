// Section descriptions and setup notes share the same copy and layout.
import { Box, Callout, Code, Stack, Text } from 'orca'

// How far an xs icon button's glyph sits inside its 24px control slot, in pixels.
export const ICON_INSET_PX = 7

// What Sessions and Quick actions are for: under their headers, or first in their note while it shows.
export const SESSIONS_DESCRIPTION = 'All sessions are grouped by Orca projects.'
export const ACTIONS_DESCRIPTION = 'One click run for commands to run within your project folder.'

/** A description aligned with the section arrow and the quick action controls. */
export function SectionDescription({ text }: { text: string }) {
  return (
    <Box direction="row" gap="none" paddingX="xs">
      <Box width={ICON_INSET_PX} minWidth={ICON_INSET_PX} shrink={false} />
      <Box grow minWidth={0}>
        <Text size="xs" muted>
          {text}
        </Text>
      </Box>
    </Box>
  )
}

/** Shown in Sessions while Orca has no projects: how to add one, in the words of Orca's own buttons. */
export function NoProjectsNote() {
  return (
    <Callout title="No Orca projects found">
      <Stack gap="xs">
        <NoteGap />
        <Text size="xs">{SESSIONS_DESCRIPTION}</Text>
        <NoteGap />
        <Text size="xs">To add a project:</Text>
        <Text size="xs">1. Open the workspaces sidebar, click on the add project (folder with plus inside) icon.</Text>
        <Text size="xs">2. Choose Browse folder for a folder you have, Clone from URL for a Git repository, or Create new project to start empty.</Text>
        <Text size="xs">3. Start a session in the project. It appears here on its own.</Text>
      </Stack>
    </Callout>
  )
}

/** Shown in Quick actions while none is saved: how to add one, with examples, in the form's own words. */
export function NoActionsNote() {
  return (
    <Callout tone="accent" title="No quick actions yet?">
      <Stack gap="xs">
        <NoteGap />
        <Text size="xs">{ACTIONS_DESCRIPTION}</Text>
        <NoteGap />
        <Text size="xs">Click Add action below to add one.</Text>
        <NoteGap />
        <Text size="xs">Examples:</Text>
        <ExampleLine label="- Single command:" commands={['npm run dev']} />
        <ExampleLine label="- Multiple commands:" commands={['git pull', 'npm install', 'npm run build']} />
      </Stack>
    </Callout>
  )
}

/** A blank line in a note: under its title, and between its parts. */
const NoteGap = () => <Box height={8} shrink={false} />

/** One example in a note: its label, then each command as inline code, comma separated. */
function ExampleLine({ label, commands }: { label: string; commands: string[] }) {
  return (
    <Box direction="row" align="center" gap="xs" wrap>
      <Text size="xs">{label}</Text>
      {commands.map((command, i) => (
        <Box key={command} direction="row" align="center" gap="none">
          <Code>{command}</Code>
          {i < commands.length - 1 ? <Text size="xs">,</Text> : null}
        </Box>
      ))}
    </Box>
  )
}
