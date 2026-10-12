import { bold, dim, errorColor, fg, GLYPH_GAP, paintProvider, PROVIDER_STYLES, underline } from "../theme.js";
import { stripLongPathPrefix } from "./folders.js";
import type { Client, Session } from "./types.js";

// Pure rendering of the session list. No agent knowledge, no I/O.
// All times are rendered in the local timezone of the process.

/** A session together with the display name of the agent it belongs to. */
export interface ListedSession {
  provider: string;
  session: Session;
}

export interface SourceError {
  provider: string;
  error: string;
}

export interface SessionsRenderOptions {
  /** ANSI colors and Nerd Font glyphs. Off by default. */
  color?: boolean;
  /** The folder that was listed; undefined = every folder (resume lines then start with `cd`). */
  folder?: string;
  /** Terminal width in columns, used to shorten long titles. Unknown (e.g. a pipe) = no limit. */
  columns?: number;
  /** Sessions left out by --limit. */
  hidden?: number;
}

const COLUMN_GAP = "   ";
const TITLE_MAX = 60;
const TITLE_MIN = 20;
const UNTITLED = "(untitled)";
const CLIENT_LABELS: Record<Client, string> = {
  cli: "CLI",
  vscode: "VS Code",
  "visual-studio": "Visual Studio",
  desktop: "Desktop App",
};
const UNKNOWN_CLIENT = "Unknown";

/** The client column's text for a session. */
export const clientLabel = (s: Session): string => (s.client ? CLIENT_LABELS[s.client] : UNKNOWN_CLIENT);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;
const width = (s: string): number => [...s].length;

/**
 * Time since `date`, one unit: "just now", "5 minutes ago", "3 hours ago", "12 days ago".
 * From 30 days on, the date: "12 Aug", or "12 Aug 2025" in an earlier year.
 */
export function formatAgo(date: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${plural(days, "day")} ago`;
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

/** Shorten to `max` characters, ending in "…" when cut. */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

/** Folder for display and `cd`: without the `\\?\` prefix some agents store. */
const displayFolder = (cwd: string): string => stripLongPathPrefix(cwd);

/** The command to copy: as stored when listing one folder, prefixed with `cd` when listing all. */
export function resumeLine(s: Session, allFolders: boolean): string {
  return allFolders ? `cd "${displayFolder(s.cwd)}"; ${s.resumeCommand}` : s.resumeCommand;
}

/** The agent name as it appears on screen, before coloring: with its glyph in color mode. */
function agentLabel(provider: string, color: boolean): string {
  const glyph = color ? PROVIDER_STYLES[provider.toLowerCase()]?.glyph : undefined;
  return glyph ? `${glyph}${GLYPH_GAP}${provider}` : provider;
}

/** The session list, newest first as given, with one empty line of padding above and below. */
export function renderSessions(
  listed: ListedSession[],
  errors: SourceError[],
  now: Date,
  opts: SessionsRenderOptions = {},
): string {
  const color = !!opts.color;
  const paint = {
    title: (s: string) => (color ? bold(underline(s)) : s),
    agent: (s: string) => (color ? paintProvider(s) : s),
    dim: (s: string) => (color ? dim(s) : s),
    error: (s: string) => (color ? fg(errorColor, s) : s),
  };
  const all = opts.folder === undefined;
  const header = all ? "Sessions in all folders" : `Sessions in ${displayFolder(opts.folder as string)}`;
  const lines: string[] = ["", paint.title(header), ""];

  if (listed.length === 0) lines.push(errors.length > 0 ? "No sessions could be read." : "No sessions found.");

  const agentWidth = Math.max(0, ...listed.map((l) => width(agentLabel(l.provider, color))));
  const agos = listed.map((l) => formatAgo(l.session.lastUsedAt, now));
  const agoWidth = Math.max(0, ...agos.map(width));
  const clients = listed.map((l) => clientLabel(l.session));
  const clientWidth = Math.max(0, ...clients.map(width));
  const titles = listed.map((l) => l.session.title ?? UNTITLED);
  let titleWidth = Math.min(TITLE_MAX, Math.max(0, ...titles.map(width)));
  if (opts.columns !== undefined) {
    const room = opts.columns - agentWidth - clientWidth - agoWidth - 3 * COLUMN_GAP.length;
    titleWidth = Math.min(titleWidth, Math.max(TITLE_MIN, room));
  }
  const indent = " ".repeat(agentWidth + COLUMN_GAP.length);

  listed.forEach((l, i) => {
    if (i > 0) lines.push("");
    const agentPad = " ".repeat(agentWidth - width(agentLabel(l.provider, color)));
    const title = truncate(titles[i], titleWidth);
    const titlePad = " ".repeat(titleWidth - width(title));
    const shownTitle = l.session.title === null ? paint.dim(title) : title;
    // The client is the last column, so it is not padded (no trailing spaces).
    const agoPad = " ".repeat(agoWidth - width(agos[i]));
    const shownClient = l.session.client ? clients[i] : paint.dim(clients[i]);
    lines.push(
      `${paint.agent(l.provider)}${agentPad}${COLUMN_GAP}${shownTitle}${titlePad}${COLUMN_GAP}${agos[i]}${agoPad}${COLUMN_GAP}${shownClient}`,
    );
    lines.push(`${indent}${paint.dim(resumeLine(l.session, all))}`);
  });

  if (opts.hidden) {
    lines.push("", paint.dim(`${plural(opts.hidden, "older session")} not shown (use --limit to show more)`));
  }
  for (const e of errors) lines.push("", `${paint.agent(e.provider)}${COLUMN_GAP}${paint.error("could not read:")} ${e.error}`);
  lines.push("");
  return lines.join("\n") + "\n";
}

/** Machine-readable list: dates as ISO strings, resume commands without the `cd`. */
export function renderSessionsJson(listed: ListedSession[], errors: SourceError[]): string {
  const sessions = listed.map(({ provider, session: s }) => ({
    provider,
    id: s.id,
    title: s.title,
    cwd: displayFolder(s.cwd),
    startedAt: s.startedAt?.toISOString() ?? null,
    lastUsedAt: s.lastUsedAt.toISOString(),
    resumeCommand: s.resumeCommand,
    client: s.client ?? null,
    ...(s.branch !== undefined && { branch: s.branch }),
    ...(s.model !== undefined && { model: s.model }),
  }));
  return JSON.stringify({ sessions, errors }, null, 2) + "\n";
}
