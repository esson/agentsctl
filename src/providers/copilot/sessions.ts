import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ListOptions, Session, SessionResult, SessionSource } from "../../sessions/types.js";
import { sameFolder } from "../../sessions/folders.js";
import { loadSqlite } from "../sqlite.js";
import { errorMessage, isRecord } from "../util.js";

// Sessions: one folder per session, ~/.copilot/session-state/<id>/ with workspace.yaml (folder,
// name, times) and events.jsonl (the conversation). The desktop app's own session list in
// ~/.copilot/data.db marks desktop sessions. Fields used: docs/providers/copilot-sessions.md.

const PROVIDER = "Copilot";

/** client_name of sessions from Copilot's desktop app, listed and marked as desktop sessions. */
const DESKTOP_CLIENT = "github/autopilot";

/**
 * Clients whose sessions are listed: the terminal CLI, no client_name (older CLI versions) and the
 * desktop app. Windows Terminal's agent ("wta-*") uses the same folder and is left out: its
 * sessions are named after the agent's system prompt.
 */
const LISTED_CLIENTS = new Set(["github/cli", undefined, DESKTOP_CLIENT]);

/**
 * The top-level `key: value` pairs of workspace.yaml, as written by Copilot's YAML library:
 * plain, "double-quoted" and 'single-quoted' scalars, and block scalars (`|-`, `>`) on indented lines.
 * Not a general YAML parser.
 */
export function parseWorkspaceYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const raw = (m[2] ?? "").trim();
    if (/^[|>][-+]?$/.test(raw)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i]);
      const indent = Math.min(...block.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
      out[m[1]] = block.map((l) => l.slice(indent)).join("\n").trim();
    } else if (raw.startsWith('"')) {
      try {
        out[m[1]] = JSON.parse(raw) as string;
      } catch {
        out[m[1]] = raw.slice(1, -1);
      }
    } else if (raw.startsWith("'")) {
      out[m[1]] = raw.slice(1, -1).replace(/''/g, "'");
    } else {
      out[m[1]] = raw;
    }
  }
  return out;
}

function time(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const firstLine = (s: string | undefined): string | null => s?.trim().split("\n")[0].trim() || null;

/**
 * One session folder -> a session, or null when it has no conversation (no user message)
 * or no folder. `events` is the text of events.jsonl.
 */
export function parseCopilotSession(id: string, ws: Record<string, string>, events: string): Session | null {
  let prompt: string | null = null;
  let model: string | undefined;
  let last: Date | null = null;
  let asked = false;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a log that is being written can end in a partial line
    }
    if (!isRecord(r)) continue;
    last = time(r.timestamp) ?? last;
    const data = isRecord(r.data) ? r.data : {};
    if (r.type === "user.message") {
      asked = true;
      if (prompt === null && typeof data.content === "string") prompt = firstLine(data.content);
    }
    if (r.type === "session.model_change" && typeof data.newModel === "string" && data.newModel) model = data.newModel;
  }
  const cwd = ws.cwd;
  const lastUsedAt = last ?? time(ws.updated_at);
  if (!asked || !cwd || !lastUsedAt) return null;
  const session: Session = {
    id,
    // `name` is generated unless user_named is true; `summary` is the older field for it.
    title: firstLine(ws.name) ?? firstLine(ws.summary) ?? prompt,
    cwd,
    startedAt: time(ws.created_at),
    lastUsedAt,
    resumeCommand: `copilot --resume ${id}`,
  };
  if (ws.branch) session.branch = ws.branch;
  if (model) session.model = model;
  if (ws.client_name === DESKTOP_CLIENT) session.desktop = true;
  return session;
}

/** What the desktop app's session list says about a session. */
export interface DesktopInfo {
  /** Session ids the desktop app created (not CLI sessions it shows). */
  desktop: Set<string>;
  /** Session ids archived in the desktop app. */
  archived: Set<string>;
}

const NO_DESKTOP_INFO: DesktopInfo = { desktop: new Set(), archived: new Set() };

/**
 * The desktop app's `sessions` table, read-only. It only refines the list (marker, archived),
 * so a missing or unreadable database gives no information instead of an error.
 */
async function readDesktopInfo(file: string): Promise<DesktopInfo> {
  try {
    const Database = await loadSqlite();
    const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 2000 });
    try {
      const rows = db.prepare("SELECT id, session_type, archived_at FROM sessions").all() as {
        id: string;
        session_type: string | null;
        archived_at: string | null;
      }[];
      return {
        desktop: new Set(rows.filter((r) => r.session_type !== "cli_session").map((r) => r.id)),
        archived: new Set(rows.filter((r) => r.archived_at).map((r) => r.id)),
      };
    } finally {
      db.close();
    }
  } catch {
    return NO_DESKTOP_INFO;
  }
}

async function readSession(dir: string, id: string, cwd: string | undefined, info: DesktopInfo): Promise<Session | null> {
  let ws: Record<string, string>;
  try {
    ws = parseWorkspaceYaml(await readFile(path.join(dir, "workspace.yaml"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // folder without a session
    throw e;
  }
  if (!LISTED_CLIENTS.has(ws.client_name) || !ws.cwd || info.archived.has(ws.id || id)) return null;
  // Check the folder before reading the (possibly large) event log.
  if (cwd !== undefined && !sameFolder(ws.cwd, cwd)) return null;
  let events: string;
  try {
    events = await readFile(path.join(dir, "events.jsonl"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // never got a message
    throw e;
  }
  const session = parseCopilotSession(ws.id || id, ws, events);
  // Desktop sessions from before client_name was written are known from the app's own list.
  if (session && info.desktop.has(session.id)) session.desktop = true;
  return session;
}

export interface CopilotSessionsOptions {
  /** Copilot's folder with session-state/ and data.db. Defaults to ~/.copilot. */
  copilotHome?: string;
}

export function createCopilotSessions(o: CopilotSessionsOptions = {}): SessionSource {
  return {
    name: "copilot",
    displayName: PROVIDER,
    async list(opts: ListOptions): Promise<SessionResult> {
      const home = o.copilotHome ?? path.join(os.homedir(), ".copilot");
      const root = path.join(home, "session-state");
      try {
        let ids: string[];
        try {
          ids = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return { provider: PROVIDER, ok: true, sessions: [] };
          throw e;
        }
        const info = await readDesktopInfo(path.join(home, "data.db"));
        const found = await Promise.all(ids.map((id) => readSession(path.join(root, id), id, opts.cwd, info)));
        return { provider: PROVIDER, ok: true, sessions: found.filter((s): s is Session => s !== null) };
      } catch (e) {
        return { provider: PROVIDER, ok: false, error: errorMessage(e) };
      }
    },
  };
}

export const copilotSessions = createCopilotSessions();
