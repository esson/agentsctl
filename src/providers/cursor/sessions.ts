import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ListOptions, Session, SessionResult, SessionSource } from "../../sessions/types.js";
import { sameFolder } from "../../sessions/folders.js";
import { errorMessage, isFiniteNumber, isRecord } from "../util.js";

// Sessions of the Cursor terminal agent (`agent`): ~/.cursor/chats/<md5 of folder>/<chat id>/meta.json.
// Fields used: docs/providers/cursor-sessions.md. The chat's store.db is never opened.

const PROVIDER = "Cursor";

/** A chat's meta.json, as far as it is used. */
export interface ChatMeta {
  title?: unknown;
  cwd?: unknown;
  createdAtMs?: unknown;
  updatedAtMs?: unknown;
  hasConversation?: unknown;
  isSubagent?: unknown;
}

const ms = (v: unknown): Date | null => (isFiniteNumber(v) && v > 0 ? new Date(v) : null);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * One chat -> a session, or null for subagent chats and chats without a conversation.
 * `cwd` is meta.cwd, or the folder worked out from the chat's parent folder when it is missing.
 */
export function chatToSession(id: string, meta: ChatMeta, cwd: string | undefined): Session | null {
  const lastUsedAt = ms(meta.updatedAtMs) ?? ms(meta.createdAtMs);
  if (meta.isSubagent === true || meta.hasConversation !== true || !cwd || !lastUsedAt) return null;
  return {
    id,
    title: text(meta.title) ?? null,
    cwd,
    startedAt: ms(meta.createdAtMs),
    lastUsedAt,
    resumeCommand: `agent --resume ${id}`,
    client: "cli",
  };
}

/** Cursor's folder name for a project: the md5 of the folder path. */
export function chatFolderName(cwd: string): string {
  return createHash("md5").update(cwd).digest("hex");
}

/**
 * Names the chat folder for `cwd` may have: Cursor hashes the path as it got it, so try it as given,
 * without a trailing separator, and (Windows) with either drive letter case.
 */
function chatFolderNames(cwd: string): Set<string> {
  const trimmed = cwd.length > 3 ? cwd.replace(/[\\/]+$/, "") : cwd;
  const forms = [cwd, trimmed];
  if (/^[a-z]:/i.test(trimmed)) forms.push(trimmed[0].toUpperCase() + trimmed.slice(1), trimmed[0].toLowerCase() + trimmed.slice(1));
  return new Set(forms.map(chatFolderName));
}

async function readMeta(file: string): Promise<ChatMeta | null> {
  try {
    const json: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(json) ? json : null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || e instanceof SyntaxError) return null; // not a chat, or being written
    throw e;
  }
}

/** The sessions in one <md5 of folder> directory. */
async function readProject(dir: string, wanted: string | undefined): Promise<Session[]> {
  const ids = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const chats = await Promise.all(ids.map(async (id) => ({ id, meta: await readMeta(path.join(dir, id, "meta.json")) })));
  // Chats from older agent versions have no cwd; every chat in the directory shares the folder.
  const known = chats.map((c) => text(c.meta?.cwd)).find((c) => c !== undefined);
  const hashMatches = wanted !== undefined && chatFolderNames(wanted).has(path.basename(dir));
  const fallback = known ?? (hashMatches ? wanted : undefined);
  return chats.flatMap(({ id, meta }) => {
    const s = meta && chatToSession(id, meta, text(meta.cwd) ?? fallback);
    return s && (wanted === undefined || sameFolder(s.cwd, wanted)) ? [s] : [];
  });
}

export interface CursorSessionsOptions {
  /** Defaults to ~/.cursor/chats. */
  chatsDir?: string;
}

export function createCursorSessions(o: CursorSessionsOptions = {}): SessionSource {
  return {
    name: "cursor",
    displayName: PROVIDER,
    async list(opts: ListOptions): Promise<SessionResult> {
      const root = o.chatsDir ?? path.join(os.homedir(), ".cursor", "chats");
      try {
        let dirs: string[];
        try {
          dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return { provider: PROVIDER, ok: true, sessions: [] };
          throw e;
        }
        const found = await Promise.all(dirs.map((d) => readProject(path.join(root, d), opts.cwd)));
        return { provider: PROVIDER, ok: true, sessions: found.flat() };
      } catch (e) {
        return { provider: PROVIDER, ok: false, error: errorMessage(e) };
      }
    },
  };
}

export const cursorSessions = createCursorSessions();
