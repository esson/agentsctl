import { parseArgs } from "node:util";
import { selectProviders } from "../providers/select.js";
import { errorMessage } from "../providers/util.js";
import { EXIT_OK, EXIT_USAGE, type RunResult } from "../result.js";
import { NO_TERMINAL, useColor, type Terminal } from "../terminal.js";
import { renderSessions, renderSessionsJson, type ListedSession, type SourceError } from "./render.js";
import type { ListOptions, SessionResult, SessionSource } from "./types.js";

// The `sessions` subcommand: argv + session sources + clock + folder in, text + exit code out.

export const EXIT_ALL_FAILED = 1;
/** --all lists every folder, so it is limited unless --limit or --pager says otherwise. */
export const ALL_FOLDERS_LIMIT = 10;

export function helpText(sources: SessionSource[]): string {
  return `agentsctl sessions — list saved agent sessions, newest first, with the command to resume each

Usage: agentsctl sessions [options]

Options:
  --all                  Sessions from every folder (default: only the current folder)
  --provider <names>     Agents, separated by commas or spaces (${[...new Set(sources.map((s) => s.name))].join(", ")})
  --limit <n>            Show at most n sessions (default: all, or ${ALL_FOLDERS_LIMIT} with --all and no --pager)
  --pager                Show the list in a pager ($AGENTSCTL_PAGER, $PAGER or less) when writing to a terminal
  --json                 Print machine-readable JSON instead of the list
  --no-color             Plain text: no colors or icons (also: NO_COLOR env var; FORCE_COLOR forces color)
  -h, --help             Show this help

Session files are only read, never changed.

Exit codes: 0 = listed (also when there are no sessions), 1 = no agent could be read, 2 = usage error.
`;
}

/** Run one source; a throw becomes an error result so it never affects the others. */
export async function listSource(s: SessionSource, opts: ListOptions): Promise<SessionResult> {
  try {
    return await s.list(opts);
  } catch (e) {
    return { provider: s.displayName ?? s.name, ok: false, error: errorMessage(e) };
  }
}

export interface SessionsContext {
  now: () => Date;
  /** The folder sessions are listed for. */
  cwd: string;
  term?: Terminal;
}

export async function runSessions(argv: string[], sources: SessionSource[], ctx: SessionsContext): Promise<RunResult> {
  const term = ctx.term ?? NO_TERMINAL;
  const usageError = (message: string, withHelp = false): RunResult => ({
    stdout: "",
    stderr: `agentsctl sessions: ${message}\n${withHelp ? `\n${helpText(sources)}` : ""}`,
    exitCode: EXIT_USAGE,
  });

  let values: { all?: boolean; provider?: string; limit?: string; pager?: boolean; json?: boolean; "no-color"?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        all: { type: "boolean" },
        provider: { type: "string" },
        limit: { type: "string" },
        pager: { type: "boolean" },
        json: { type: "boolean" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    return usageError(errorMessage(e), true);
  }

  if (values.help) return { stdout: helpText(sources), stderr: "", exitCode: EXIT_OK };

  // A pager makes a long list easy to read, so --all then shows everything.
  let limit = values.all && !values.pager ? ALL_FOLDERS_LIMIT : Infinity;
  if (values.limit !== undefined) {
    if (!/^\s*[1-9]\d*\s*$/.test(values.limit)) return usageError("--limit must be a positive whole number");
    limit = Number(values.limit);
  }

  let selected = sources;
  if (values.provider !== undefined) {
    const sel = selectProviders(values.provider, sources);
    if (!sel.ok) return usageError(sel.error);
    selected = sel.selected;
  }

  const folder = values.all ? undefined : ctx.cwd;
  const results = await Promise.all(selected.map((s) => listSource(s, { cwd: folder })));
  const errors: SourceError[] = results.flatMap((r) => (r.ok ? [] : [{ provider: r.provider, error: r.error }]));
  const listed: ListedSession[] = results
    .flatMap((r) => (r.ok ? r.sessions.map((session) => ({ provider: r.provider, session })) : []))
    .sort((a, b) => b.session.lastUsedAt.getTime() - a.session.lastUsedAt.getTime());
  const shown = listed.slice(0, limit);

  const stdout = values.json
    ? renderSessionsJson(shown, errors)
    : renderSessions(shown, errors, ctx.now(), {
        color: useColor(!!values["no-color"], term),
        folder,
        columns: term.isTTY ? term.columns : undefined,
        hidden: listed.length - shown.length,
      });
  const allFailed = results.length > 0 && results.every((r) => !r.ok);
  const result: RunResult = { stdout, stderr: "", exitCode: allFailed ? EXIT_ALL_FAILED : EXIT_OK };
  if (values.pager) result.page = true;
  return result;
}
