import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client, ListOptions, Session, SessionResult, SessionSource } from "../../sessions/types.js";
import { sameFolder } from "../../sessions/folders.js";
import { loadSqlite } from "../sqlite.js";
import { errorMessage } from "../util.js";

// Sessions: the `threads` table of <codex home>/state_<N>.sqlite, opened read-only.
// The columns read here are described in docs/providers/codex-sessions.md.

const PROVIDER = "Codex";

/**
 * The sessions `codex resume` offers: interactive ones (CLI, VS Code extension and desktop app),
 * not archived, with at least one prompt.
 */
const QUERY = `
  SELECT id, cwd, name, title, created_at_ms, updated_at_ms, git_branch, model, source, originator
  FROM threads
  WHERE archived = 0 AND source IN ('cli', 'vscode') AND first_user_message <> ''`;

export interface ThreadRow {
  id: string;
  cwd: string | null;
  name: string | null;
  title: string | null;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  git_branch: string | null;
  model: string | null;
  /** "cli" or "vscode" (only interactive threads are read). */
  source?: string | null;
  /** Client that started the thread: "codex-tui", "Codex Desktop", "codex_work_desktop"; null in older rows. */
  originator: string | null;
}

const ms = (v: number | null): Date | null => (typeof v === "number" && v > 0 ? new Date(v) : null);

/** First line of the first prompt, which Codex stores as the title until the thread is named. */
const firstLine = (s: string | null): string | null => s?.trim().split("\n")[0].trim() || null;

/**
 * The client from `originator` ("codex-tui", "Codex Desktop", "codex_work_desktop", ...), else
 * from `source`: "cli" is the terminal; "vscode" is shared by the VS Code extension and the
 * desktop app, so without an originator it is not known.
 */
export function codexClient(source: string | null | undefined, originator: string | null): Client | undefined {
  if (originator) {
    if (/desktop/i.test(originator)) return "desktop";
    if (/vscode|vs_code/i.test(originator)) return "vscode";
    if (/tui|cli|exec/i.test(originator)) return "cli";
  }
  return source === "cli" ? "cli" : undefined;
}

/** One `threads` row -> a session, or null when it lacks a folder or a time. */
export function threadToSession(r: ThreadRow): Session | null {
  const lastUsedAt = ms(r.updated_at_ms) ?? ms(r.created_at_ms);
  if (!r.cwd || !lastUsedAt) return null;
  const session: Session = {
    id: r.id,
    title: r.name?.trim() || firstLine(r.title),
    cwd: r.cwd,
    startedAt: ms(r.created_at_ms),
    lastUsedAt,
    resumeCommand: `codex resume ${r.id}`,
    resumeArgv: ["codex", "resume", r.id],
  };
  if (r.git_branch) session.branch = r.git_branch;
  if (r.model) session.model = r.model;
  const client = codexClient(r.source, r.originator);
  if (client) session.client = client;
  return session;
}

/** The newest state database: state_5.sqlite today, the number goes up with schema changes. */
async function findStateDb(home: string): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(home);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const version = (f: string) => Number(/^state_(\d+)\.sqlite$/.exec(f)?.[1] ?? -1);
  const newest = files.filter((f) => version(f) >= 0).sort((a, b) => version(b) - version(a))[0];
  return newest ? path.join(home, newest) : null;
}

export interface CodexSessionsOptions {
  /** Defaults to ~/.codex. */
  codexHome?: string;
}

export function createCodexSessions(o: CodexSessionsOptions = {}): SessionSource {
  return {
    name: "codex",
    displayName: PROVIDER,
    async list(opts: ListOptions): Promise<SessionResult> {
      try {
        const file = await findStateDb(o.codexHome ?? path.join(os.homedir(), ".codex"));
        if (!file) return { provider: PROVIDER, ok: true, sessions: [] };
        const Database = await loadSqlite();
        const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 2000 });
        let rows: ThreadRow[];
        try {
          rows = db.prepare(QUERY).all() as ThreadRow[];
        } finally {
          db.close();
        }
        // Folders are stored with a \\?\ prefix, so they are compared normalized, not in SQL.
        const sessions = rows
          .map(threadToSession)
          .filter((s): s is Session => s !== null && (opts.cwd === undefined || sameFolder(s.cwd, opts.cwd)));
        return { provider: PROVIDER, ok: true, sessions };
      } catch (e) {
        return { provider: PROVIDER, ok: false, error: errorMessage(e) };
      }
    },
  };
}

export const codexSessions = createCodexSessions();
