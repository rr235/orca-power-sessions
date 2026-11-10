// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/**
 * A quick action as the person edits it and the worker stores it: a dev server's `command`, run in
 * `path`, the main checkout of the Orca project `projectId`. `url` is the address the server
 * printed when it started (or the one typed), null until it is known.
 */
export type QuickAction = {
  id: string
  name: string
  command: string
  projectId: string | null
  path: string
  url: string | null
}

/** What the panel sends to add (no `id`) or change a quick action. */
/** `url` set (even empty) replaces the address: empty means read it from the output at the next Run. */
export type QuickActionInput = { id?: string; name: string; command: string; projectId: string; url?: string }

/**
 * A dev server the panel can start: `up` whether its port answers (however
 * it was started; before its address is known, whether its terminal is open), `terminal` the Orca
 * terminal the panel started it in, if still open.
 */
export type Server = {
  id: string
  name: string
  command: string
  projectId: string | null
  url: string | null
  up: boolean
  terminal: string | null
}

/** An Orca project, with its main checkout and how many agents run in any of its workspaces. */
export type Project = {
  id: string
  name: string
  repo: string
  path: string | null
  agents: number
}

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

/** A live agent session in one Orca workspace. */
export type Session = {
  key: string
  worktreeId: string
  workspace: string
  /** The Orca project id, or null for a workspace outside any project. */
  projectId: string | null
  project: string
  agent: string | null
  agentIcon: string | null
  title: string
  state: AgentState
  since: number
  /** Details shown when the session is expanded; null when Orca does not report them. */
  branch: string | null
  path: string | null
  /** The tool a working agent is running, such as `Bash: bun test`. */
  tool: string | null
  /** How the agent's last turn ended: `success`, `failure`, `interruption`, ... */
  outcome: string | null
  /** The pull requests linked to the session's workspace, the one Orca tracks first. */
  prs: PullRequest[]
}

export type PullRequest = { number: number; url: string; state: string | null; title: string | null }

/** What `gh` reads of a pull request; `state` is lowercase: `open`, `merged` or `closed`. */
export type PullRequestInfo = { title: string; state: string | null }

/** Tokens used: input read fresh (or written to the cache), input read from the cache, and output. */
export type TokenSplit = { input: number; cached: number; output: number }

/** What a session's transcript says it ran on: null when the agent did not record it. */
export type SessionUsage = {
  /** The model id, such as `claude-opus-5-5` or `gpt-6.1-sol`. */
  model: string | null
  /** The reasoning effort, such as `high`. */
  effort: string | null
  /** Tokens the session has used so far: input, cached input and output. */
  tokens: number | null
  /** The same tokens split by kind, when the agent records them. */
  tokenSplit: TokenSplit | null
  /** Tokens in the context window at the last turn. */
  context: number | null
  /** The context window's size: recorded by Codex, known per model for Claude. */
  contextWindow: number | null
  /** Prompts the person has sent, in all and since the last compaction. */
  turns: number | null
  turnsSinceCompaction: number | null
  /** How often the context was compacted. */
  compactions: number | null
  /** Tools the agent called in its main thread, in all and since the last compaction. */
  toolCalls: number | null
  toolCallsSinceCompaction: number | null
}

export type Overview = { servers: Server[]; projects: Project[]; sessions: Session[] }

declare module 'orca' {
  interface PluginRequests {
    /** Servers with their terminals, projects and live agent sessions. */
    'overview.load': { output: Overview }
    /** Model, effort, token and context use for these sessions, by session key; unknown sessions are left out. */
    'session.usage': { input: { keys: string[] }; output: Record<string, SessionUsage> }
    /** Title and state of these pull requests, by URL; ones `gh` cannot read are left out. */
    'pr.info': { input: { urls: string[] }; output: Record<string, PullRequestInfo> }
    /** Runs the server's command, in its terminal when still open, else a new one; when the server
     *  already answers, shows its terminal instead. */
    'server.start': { input: { id: string }; output: null }
    /** Stops the server's terminal. */
    'server.stop': { input: { id: string }; output: null }
    /** Adds a quick action, or changes the one with this `id`. */
    'action.save': { input: QuickActionInput; output: null }
    /** Removes a quick action; a terminal it runs in stays open. */
    'action.delete': { input: { id: string }; output: null }
    /** Runs `/compact` in the session: sent to its terminal, or run in its chat through Orca's chat RPC.
     *  Rejects with the reason when a chat's compact did not complete. */
    'session.compact': { input: { key: string }; output: null }
    /** The workspace and tab Orca's window shows, or null when it cannot tell. */
    'session.selected': { output: { worktreeId: string; tabId: string } | null }
    /** Shows a session's workspace and brings its tab to the front. */
    'session.focus': { input: { key: string; path: string }; output: null }
    /** Shows a project's main checkout in Orca. */
    'project.open': { input: { path: string }; output: null }
  }
}
