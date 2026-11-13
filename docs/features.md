# Power Sessions features

An overview of your Claude and Codex sessions across your projects.
The project, workspace and session Orca shows are in normal text, the rest muted.

| Dark | Light |
| --- | --- |
| ![Sessions grouped by project, dark theme](../assets/screenshots/sessions-dark.png) | ![Sessions grouped by project, light theme](../assets/screenshots/sessions-light.png) |

## Features

### Session details

Open any session to see what it is doing and how much it has used.
Usage appears where recorded by Claude, Codex or Orca.

- **Model and effort**: the latest recorded model and reasoning effort, where available. Fable and Astra model names show in the warning colour.
- **Tokens**: the total tokens the session has used.
- **Context**: how full the context window is, as used and total size.
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

Press **Compact** in a session's details to compact its conversation without switching to it. The button is disabled while the agent is working; it does not queue a compact.

> **Use with caution.** Pressing Compact runs `/compact`, or its equivalent, in the session right away.

| Dark | Light |
| --- | --- |
| ![Session details with the Compact button beside the status, dark theme](../assets/screenshots/compact-dark.png) | ![Session details with the Compact button beside the status, light theme](../assets/screenshots/compact-light.png) |

### Quick actions

Create quick actions for the scripts you run often in your projects, such as a dev server.

- **Run and stop**: start a script with one press. Stop closes its tracked terminal. A server started elsewhere has no Stop control.
- **Running at a glance**: a green dot marks each running action, and one beside the section title shows that something is running.
- **Terminal and URL**: show the action’s tracked terminal, or open its URL in your browser once known.
- **Edit**: change an action's project, name, command or URL.

| Dark | Light |
| --- | --- |
| ![Quick actions with two running servers and two stopped ones, dark theme](../assets/screenshots/quick-actions-list-dark.png) | ![Quick actions with two running servers and two stopped ones, light theme](../assets/screenshots/quick-actions-list-light.png) |

To add one, press the **+** beside **Add action**, pick the project, then give it a name and the command. Add a URL only if it differs from the one the server prints. Press **Add +** to save it. The command runs in the project’s main checkout.

| Dark | Light |
| --- | --- |
| ![The Add new action form with a project, name, command and URL, dark theme](../assets/screenshots/add-action-dark.png) | ![The Add new action form with a project, name, command and URL, light theme](../assets/screenshots/add-action-light.png) |
