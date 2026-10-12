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
  branch?: string;
  model?: string;
  /** Created in the agent's desktop app rather than its terminal CLI. */
  desktop?: boolean;
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
