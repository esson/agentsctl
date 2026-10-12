import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ListOptions, Session, SessionResult, SessionSource } from "../../sessions/types.js";
import { sameFolder } from "../../sessions/folders.js";
import { errorMessage, isRecord } from "../util.js";

// Sessions: one folder per session, ~/.copilot/session-state/<id>/ with workspace.yaml (folder,
// name, times) and events.jsonl (the conversation). Fields used: docs/providers/copilot-sessions.md.

const PROVIDER = "Copilot";

/**
 * Clients whose sessions are listed: the terminal CLI, and no client_name (older CLI versions).
 * Copilot's desktop app ("github/autopilot") and Windows Terminal's agent ("wta-*") use the same
 * folder and are left out.
 */
const CLI_CLIENTS = new Set(["github/cli", undefined]);

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
  return session;
}

async function readSession(dir: string, id: string, cwd: string | undefined): Promise<Session | null> {
  let ws: Record<string, string>;
  try {
    ws = parseWorkspaceYaml(await readFile(path.join(dir, "workspace.yaml"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // folder without a session
    throw e;
  }
  if (!CLI_CLIENTS.has(ws.client_name) || !ws.cwd) return null;
  // Check the folder before reading the (possibly large) event log.
  if (cwd !== undefined && !sameFolder(ws.cwd, cwd)) return null;
  let events: string;
  try {
    events = await readFile(path.join(dir, "events.jsonl"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // never got a message
    throw e;
  }
  return parseCopilotSession(ws.id || id, ws, events);
}

export interface CopilotSessionsOptions {
  /** Defaults to ~/.copilot/session-state. */
  sessionStateDir?: string;
}

export function createCopilotSessions(o: CopilotSessionsOptions = {}): SessionSource {
  return {
    name: "copilot",
    displayName: PROVIDER,
    async list(opts: ListOptions): Promise<SessionResult> {
      const root = o.sessionStateDir ?? path.join(os.homedir(), ".copilot", "session-state");
      try {
        let ids: string[];
        try {
          ids = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return { provider: PROVIDER, ok: true, sessions: [] };
          throw e;
        }
        const found = await Promise.all(ids.map((id) => readSession(path.join(root, id), id, opts.cwd)));
        return { provider: PROVIDER, ok: true, sessions: found.filter((s): s is Session => s !== null) };
      } catch (e) {
        return { provider: PROVIDER, ok: false, error: errorMessage(e) };
      }
    },
  };
}

export const copilotSessions = createCopilotSessions();
