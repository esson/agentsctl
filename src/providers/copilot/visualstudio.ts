import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ListOptions, Session, SessionResult, SessionSource } from "../../sessions/types.js";
import { isWithin, normalizeFolder, sameFolder } from "../../sessions/folders.js";
import { errorMessage, isRecord } from "../util.js";
import { MsgpackReader } from "./msgpack.js";

// Copilot Chat sessions of Visual Studio: one MessagePack file per chat in the solution's folder,
// <solution folder>/.vs/<solution name>/copilot-chat/<hash>/sessions/<chat id>. There is no central
// index; solution folders come from Visual Studio's recent list. Fields: docs/providers/copilot-sessions.md.

const PROVIDER = "Copilot";

/** File format version the reader understands (the first byte of every chat file seen). */
const FORMAT_VERSION = 1;
/** Message role in a chat file: [role, message]. */
const USER = 0;
/** Content part type of plain text in a message. */
const TEXT_PART = 3;

const firstLine = (s: unknown): string | null => (typeof s === "string" ? s.trim().split("\n")[0].trim() || null : null);

function time(v: unknown): Date | null {
  const d = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** The first plain-text part of a message's Content: [[type, {Content: text}], ...]. */
function messageText(message: unknown): string | null {
  const parts = isRecord(message) && Array.isArray(message.Content) ? message.Content : [];
  for (const part of parts) {
    if (Array.isArray(part) && part[0] === TEXT_PART && isRecord(part[1])) {
      const line = firstLine(part[1].Content);
      if (line) return line;
    }
  }
  return null;
}

/**
 * One chat file -> a session, or null when it is not a chat with a prompt. Only the header and the
 * messages up to the first prompt are decoded; the rest of the conversation is never read.
 */
export function parseVisualStudioChat(
  id: string,
  data: Buffer,
  solutionFolder: string,
  resume: OpenCommand,
  lastUsedAt: Date,
): Session | null {
  if (data[0] !== FORMAT_VERSION) return null;
  const reader = new MsgpackReader(data, 1);
  const header = reader.next();
  if (!isRecord(header)) return null;
  let prompt: string | null = null;
  let asked = false;
  while (!reader.done && !asked) {
    const item = reader.next();
    if (Array.isArray(item) && item[0] === USER) {
      asked = true;
      prompt = messageText(item[1]);
    }
  }
  if (!asked) return null;
  return {
    id,
    title: firstLine(header.Name) ?? prompt,
    cwd: solutionFolder,
    startedAt: time(header.TimeCreated),
    lastUsedAt,
    resumeCommand: resume.command,
    resumeArgv: resume.argv,
    client: "visual-studio",
  };
}

/**
 * Solution and folder paths from the recent lists ("CodeContainers.Offline") in
 * <Visual Studio data folder>/<version>_<instance>/ApplicationPrivateSettings.xml.
 */
export function parseRecentList(xml: string): string[] {
  const at = xml.indexOf('name="CodeContainers.Offline"');
  if (at < 0) return [];
  const m = /<value[^>]*>([\s\S]*?)<\/value>/.exec(xml.slice(at));
  if (!m) return [];
  const json = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  let entries: unknown;
  try {
    entries = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((e) => {
    const p = isRecord(e) && isRecord(e.Value) && isRecord(e.Value.LocalProperties) ? e.Value.LocalProperties.FullPath : undefined;
    return typeof p === "string" && p ? [p] : [];
  });
}

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** Folders Visual Studio opened recently: a solution or project's folder, or an opened folder. */
async function recentFolders(vsDataDir: string): Promise<string[]> {
  const versions = await readDirNames(vsDataDir);
  const lists = await Promise.all(
    versions.map((v) => readFile(path.join(vsDataDir, v, "ApplicationPrivateSettings.xml"), "utf8").then(parseRecentList, () => [])),
  );
  const folders = await Promise.all(
    lists.flat().map(async (p) => ((await stat(p).then((s) => s.isDirectory(), () => false)) ? p : path.dirname(p))),
  );
  const unique = new Map(folders.map((f) => [normalizeFolder(f), f]));
  return [...unique.values()];
}

/** The git repository root a folder belongs to, if any. */
async function gitRoot(folder: string): Promise<string | undefined> {
  for (let dir = folder; ; dir = path.dirname(dir)) {
    if (await exists(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * A solution folder belongs to the listed folder when it is that folder, or below it within the
 * same git repository (solutions often live in src/, below the repository root).
 */
async function belongsTo(solutionFolder: string, cwd: string): Promise<boolean> {
  if (sameFolder(solutionFolder, cwd)) return true;
  if (!isWithin(solutionFolder, cwd)) return false;
  const root = await gitRoot(solutionFolder);
  return root !== undefined && (sameFolder(root, cwd) || isWithin(cwd, root));
}

/** How to get back to a chat: the shown command (PowerShell) and the argv run through cmd.exe. */
export interface OpenCommand {
  command: string;
  argv: string[];
}

/**
 * Open the solution (or folder) in Visual Studio, then pick the chat from Copilot Chat's history.
 * cmd.exe's `start` takes a window title first, hence the empty argument in argv.
 */
async function openCommand(solutionFolder: string, solutionName: string): Promise<OpenCommand> {
  const candidates = solutionName.endsWith(".slnx") ? [solutionName] : [`${solutionName}.sln`, `${solutionName}.slnx`];
  for (const c of candidates) {
    const file = path.join(solutionFolder, c);
    if (await exists(file)) return { command: `start "${file}"`, argv: ["start", "", file] };
  }
  return { command: `start devenv "${solutionFolder}"`, argv: ["start", "", "devenv", solutionFolder] };
}

/** Every chat of one solution folder: .vs/<solution name>/copilot-chat/<hash>/sessions/<chat id>. */
async function readSolutionFolder(folder: string): Promise<Session[]> {
  const vs = path.join(folder, ".vs");
  const sessions: Session[] = [];
  for (const solutionName of await readDirNames(vs)) {
    const chatRoot = path.join(vs, solutionName, "copilot-chat");
    const hashes = await readDirNames(chatRoot);
    if (hashes.length === 0) continue;
    const resume = await openCommand(folder, solutionName);
    for (const hash of hashes) {
      const dir = path.join(chatRoot, hash, "sessions");
      let ids: string[];
      try {
        ids = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
      } catch {
        continue;
      }
      const found = await Promise.all(
        ids.map(async (id) => {
          const file = path.join(dir, id);
          try {
            const [data, info] = await Promise.all([readFile(file), stat(file)]);
            return parseVisualStudioChat(id, data, folder, resume, info.mtime);
          } catch {
            return null; // being written, or a format this reader does not know
          }
        }),
      );
      sessions.push(...found.filter((s): s is Session => s !== null));
    }
  }
  return sessions;
}

export interface VisualStudioSessionsOptions {
  /** Visual Studio's per-user data folder. Defaults to %LOCALAPPDATA%\Microsoft\VisualStudio. */
  vsDataDir?: string;
}

export function createVisualStudioSessions(o: VisualStudioSessionsOptions = {}): SessionSource {
  return {
    name: "copilot",
    displayName: PROVIDER,
    async list(opts: ListOptions): Promise<SessionResult> {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      const vsDataDir = o.vsDataDir ?? path.join(local, "Microsoft", "VisualStudio");
      try {
        let folders = await recentFolders(vsDataDir);
        if (opts.cwd !== undefined) {
          const cwd = opts.cwd;
          const keep = await Promise.all(folders.map((f) => belongsTo(f, cwd)));
          folders = folders.filter((_, i) => keep[i]);
          // The current folder is always checked, also when it is not in the recent list.
          if (!folders.some((f) => sameFolder(f, cwd))) folders.push(cwd);
        }
        const found = await Promise.all(folders.map(readSolutionFolder));
        return { provider: PROVIDER, ok: true, sessions: found.flat() };
      } catch (e) {
        return { provider: PROVIDER, ok: false, error: errorMessage(e) };
      }
    },
  };
}

export const visualStudioSessions = createVisualStudioSessions();
