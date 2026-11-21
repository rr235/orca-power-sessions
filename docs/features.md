# Power Sessions features

An overview of your Claude and Codex sessions across your projects.
The project, workspace and session Orca shows are in normal text, the rest muted.

| Dark | Light |
| --- | --- |
| ![Sessions grouped by project, dark theme](../assets/screenshots/sessions-dark.png) | ![Sessions grouped by project, light theme](../assets/screenshots/sessions-light.png) |

## Features

### Session details

Open any session to see what it is doing and how much it has used.
Usage appears where recorded in the Claude or Codex transcript.

- **Model and effort**: the latest recorded model and reasoning effort. Fable and Astra model names show in the warning colour.
- **Tokens**: the total tokens the session has used.
- **Context**: how full the context window is, as used and total size. A Claude window is the size Claude Code compacts at, from its settings.
- **Turns and tool calls**: your prompts and the agent's tool calls, since the last compaction and in total. More than 20 turns since the last compaction show in the warning colour, more than 35 in red. Before the first compaction, the colours apply to total turns.
- **Compactions**: how often the conversation has been compacted.
- **Branch**: the workspace’s current Git branch.
- **Pull requests**: pull requests linked to the session’s tab or shared by its workspace. Each one opens in your browser.

| Dark | Light |
| --- | --- |
| ![Session details with model, context, turns, branch and pull requests, dark theme](../assets/screenshots/session-details-prs-dark.png) | ![Session details with model, context, turns, branch and pull requests, light theme](../assets/screenshots/session-details-prs-light.png) |

| Dark | Light |
| --- | --- |
| ![Session details with Fable 5.2 in the warning colour, dark theme](../assets/screenshots/session-details-fable-dark.png) | ![Session details with Fable 5.2 in the warning colour, light theme](../assets/screenshots/session-details-fable-light.png) |

### Compact your sessions directly

Press **Compact** in a terminal session's details to compact its conversation without switching to it. Chats have no Compact button, since Orca offers plugins no way to compact one. The button is disabled while the agent is working; it does not queue a compact.

> **Use with caution.** Pressing Compact sends `/compact` to the session right away.

| Dark | Light |
| --- | --- |
| ![Session details with the Compact button beside the status, dark theme](../assets/screenshots/compact-dark.png) | ![Session details with the Compact button beside the status, light theme](../assets/screenshots/compact-light.png) |

### Quick actions

Create quick actions for the scripts you run often in your projects, such as a dev server.

- **Run and stop**: start a script with one press. Each action watches one Orca terminal: the one Run opened, or, before it has watched one, a server terminal discovered in the project's folder. The association stays after the server exits or the terminal closes. Stop closes only that terminal, and Run opens a new one when it is closed.
- **Running at a glance**: a green dot marks each running action, and one beside the section title shows that something is running. An action runs only while the process on its port was started in its terminal: closing the terminal or stopping the server clears the dot, and another service on the same port never counts. A server started outside Orca, or by an agent, does not show as running.
- **URL learned at each Run**: when the server prints its URL on a different port, the action switches to it, unless you typed one.
- **Terminal and URL**: show the action’s tracked terminal, or open its URL in your browser once known.
- **Steps**: an action can run several commands in order in its terminal, each once the one before succeeds, such as `bun install`, then `bun run dev`.
- **Edit**: change an action's project, name, steps or URL. Remove a step with its ×.

| Dark | Light |
| --- | --- |
| ![Quick actions with two running servers and two stopped ones, dark theme](../assets/screenshots/quick-actions-list-dark.png) | ![Quick actions with two running servers and two stopped ones, light theme](../assets/screenshots/quick-actions-list-light.png) |

To add one, press the **+** beside **Add action**, pick the project, then give it a name and the command. Press **Add step +** for another command to run after it. Add a URL only if it differs from the one the server prints. Press **Add +** to save it. The commands run in the project’s main checkout.

| Dark | Light |
| --- | --- |
| ![The Add new action form with a project, name, command and URL, dark theme](../assets/screenshots/add-action-dark.png) | ![The Add new action form with a project, name, command and URL, light theme](../assets/screenshots/add-action-light.png) |
