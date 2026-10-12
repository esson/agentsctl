/** The app a session ran in: the agent's terminal CLI, an editor extension or its desktop app. */
export type Client = "cli" | "vscode" | "visual-studio" | "desktop";

/** One saved agent session, normalized across agents. */
export interface Session {
  /** The id the agent's resume command takes. */
  id: string;
  /** Session name or generated title; null when the agent has neither. */
  title: string | null;
  /** Folder the session was started in, as the agent stored it. */
  cwd: string;
  startedAt: Date | null;
  lastUsedAt: Date;
  /** Copy-pasteable command that resumes the session from its folder. */
  resumeCommand: string;
  /** The same command as program and arguments, run by `agentsctl resume` in the session's folder. */
  resumeArgv: string[];
  branch?: string;
  model?: string;
  /** The app the session ran in; undefined when the store does not say. */
  client?: Client;
}

export type SessionResult =
  | { provider: string; ok: true; sessions: Session[] }
  | { provider: string; ok: false; error: string };

export interface ListOptions {
  /** Only sessions started in exactly this folder; undefined = every folder. */
  cwd?: string;
}

/**
 * An agent's saved sessions. `name` is the lowercase id used by `--provider`.
 * An agent that is not installed (no session store) returns ok with no sessions.
 */
export interface SessionSource {
  name: string;
  displayName?: string;
  list(opts: ListOptions): Promise<SessionResult>;
}
