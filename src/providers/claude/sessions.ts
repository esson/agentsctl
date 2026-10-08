import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ListOptions, Session, SessionResult, SessionSource } from "../../sessions/types.js";
import { normalizeFolder, sameFolder } from "../../sessions/folders.js";
import { errorMessage, isRecord } from "../util.js";
import { claudeConfigDir } from "./paths.js";

// Sessions: one transcript per session, <config dir>/projects/<encoded folder>/<session id>.jsonl.
// The records read here are described in docs/providers/claude-sessions.md.
// Subagent transcripts live in <session id>/subagents/ and are never read.

const PROVIDER = "Claude";

/** Claude Code's folder name for a project: every character except A-Z, a-z, 0-9 becomes "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** First line of a user prompt, as a title fallback. Never commands or injected text. */
function promptText(message: unknown): string | null {
  const content = isRecord(message) ? message.content : undefined;
  let text: unknown;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const block = content.find((b) => isRecord(b) && b.type === "text" && typeof b.text === "string");
    text = isRecord(block) ? block.text : undefined;
  }
  if (typeof text !== "string") return null;
  const line = text.trim().split("\n")[0].trim();
  // Slash commands, command output and other injected text are wrapped in <tags>.
  return line && !line.startsWith("<") ? line : null;
}

function time(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * One transcript -> a session, or null when it has no conversation (no assistant reply,
 * e.g. Claude Code was opened and closed). `fallbackTime` is used when no record has a timestamp.
 */
export function parseClaudeTranscript(id: string, transcript: string, fallbackTime: Date): Session | null {
  let name: string | undefined;
  let aiTitle: string | undefined;
  let prompt: string | null = null;
  let cwd: string | undefined;
  let branch: string | undefined;
  let model: string | undefined;
  let first: Date | null = null;
  let last: Date | null = null;
  let replied = false;
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a transcript that is being written can end in a partial line
    }
    if (!isRecord(r)) continue;
    const t = time(r.timestamp);
    if (t) {
      first ??= t;
      last = t;
    }
    cwd ??= text(r.cwd);
    branch = text(r.gitBranch) ?? branch;
    // A name the user gave the session wins over the generated title.
    if (r.type === "agent-name") name = text(r.agentName) ?? name;
    if (r.type === "custom-title") name = text(r.customTitle) ?? name;
    if (r.type === "ai-title") aiTitle = text(r.aiTitle) ?? aiTitle;
    if (r.type === "user" && !r.isMeta && !r.isSidechain && prompt === null) prompt = promptText(r.message);
    if (r.type === "assistant" && !r.isSidechain) {
      replied = true;
      const m = isRecord(r.message) ? text(r.message.model) : undefined;
      if (m && !m.startsWith("<")) model = m; // "<synthetic>" marks locally generated messages
    }
  }
  if (!replied || !cwd) return null;
  const session: Session = {
    id,
    title: name ?? aiTitle ?? prompt,
    cwd,
    startedAt: first,
    lastUsedAt: last ?? fallbackTime,
    resumeCommand: `claude --resume ${id}`,
  };
  if (branch) session.branch = branch;
  if (model) session.model = model;
  return session;
}

async function readSessions(dir: string, cwd: string | undefined): Promise<Session[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  const sessions = await Promise.all(
    files.map(async (f) => {
      const file = path.join(dir, f);
      const [transcript, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      return parseClaudeTranscript(f.slice(0, -".jsonl".length), transcript, info.mtime);
    }),
  );
  // The folder name is lossy ("a-b" and "a\b" encode the same), so check the recorded cwd too.
  return sessions.filter((s): s is Session => s !== null && (cwd === undefined || sameFolder(s.cwd, cwd)));
}

export interface ClaudeSessionsOptions {
  /** Defaults to <config dir>/projects. */
  projectsDir?: string;
}

export function createClaudeSessions(o: ClaudeSessionsOptions = {}): SessionSource {
  return {
    name: "claude",
    displayName: PROVIDER,
    async list(opts: ListOptions): Promise<SessionResult> {
      const root = o.projectsDir ?? path.join(claudeConfigDir(), "projects");
      try {
        let dirs: string[];
        try {
          dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return { provider: PROVIDER, ok: true, sessions: [] };
          throw e;
        }
        if (opts.cwd !== undefined) {
          // Normalized first (no trailing separator); drive letter casing can differ between runs
          // on Windows, so the name is matched case-insensitively.
          const want = encodeProjectDir(normalizeFolder(opts.cwd)).toLowerCase();
          dirs = dirs.filter((d) => d.toLowerCase() === want);
        }
        const found = await Promise.all(dirs.map((d) => readSessions(path.join(root, d), opts.cwd)));
        return { provider: PROVIDER, ok: true, sessions: found.flat() };
      } catch (e) {
        return { provider: PROVIDER, ok: false, error: errorMessage(e) };
      }
    },
  };
}

export const claudeSessions = createClaudeSessions();
