import { parseArgs } from "node:util";
import { errorMessage } from "../providers/util.js";
import { EXIT_OK, EXIT_USAGE, type RunResult } from "../result.js";
import { stripLongPathPrefix } from "./folders.js";
import { listSource } from "./cli.js";
import { resumeLine, truncate } from "./render.js";
import type { Session, SessionSource } from "./types.js";

// The `resume` subcommand: find a saved session by id (or a unique id prefix) across all agents and
// folders, and describe how to resume it. The entry point runs the command (RunResult.exec).

export const EXIT_NOT_FOUND = 1;
/** Matches listed for an ambiguous id; the rest are counted. */
const MAX_LISTED = 10;
const TITLE_MAX = 50;

export function helpText(): string {
  return `agentsctl resume — resume a saved session by its id, in the session's folder

Usage: agentsctl resume <id> [options]

<id> is a session id from "agentsctl sessions", or the start of one when only one session matches.
The agent's own resume command runs in the session's folder with this terminal; your shell's
folder does not change.

Options:
  --dry-run              Print the command instead of running it
  -h, --help             Show this help

Exit codes: the agent's exit code once it has run; 1 = no session with that id, 2 = usage error
(also when the id matches more than one session).
`;
}

interface Found {
  provider: string;
  session: Session;
}

/** Sessions whose id is `id`; else those whose id starts with it (case-insensitive). */
export function matchSessions(all: Found[], id: string): Found[] {
  const exact = all.filter((f) => f.session.id === id);
  if (exact.length > 0) return exact;
  const prefix = id.toLowerCase();
  return all.filter((f) => f.session.id.toLowerCase().startsWith(prefix));
}

const describe = (f: Found): string => {
  const title = truncate(f.session.title ?? "(untitled)", TITLE_MAX);
  return `${f.provider} session "${title}" in ${stripLongPathPrefix(f.session.cwd)}`;
};

export async function runResume(argv: string[], sources: SessionSource[]): Promise<RunResult> {
  const usageError = (message: string, withHelp = false): RunResult => ({
    stdout: "",
    stderr: `agentsctl resume: ${message}\n${withHelp ? `\n${helpText()}` : ""}`,
    exitCode: EXIT_USAGE,
  });

  let values: { "dry-run"?: boolean; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (e) {
    return usageError(errorMessage(e), true);
  }
  if (values.help) return { stdout: helpText(), stderr: "", exitCode: EXIT_OK };
  if (positionals.length !== 1 || !positionals[0].trim()) {
    return usageError(positionals.length === 0 ? "a session id is required" : "only one session id can be given", true);
  }
  const id = positionals[0].trim();

  const results = await Promise.all(sources.map((s) => listSource(s, {})));
  const all: Found[] = results
    .flatMap((r) => (r.ok ? r.sessions.map((session) => ({ provider: r.provider, session })) : []))
    .sort((a, b) => b.session.lastUsedAt.getTime() - a.session.lastUsedAt.getTime()); // newest first when listed
  const matches = matchSessions(all, id);

  if (matches.length === 0) {
    const failed = results.flatMap((r) => (r.ok ? [] : [`${r.provider} could not be read: ${r.error}`]));
    const why = failed.length > 0 ? `${failed.join("\n")}\n` : "";
    return { stdout: "", stderr: `agentsctl resume: no session with id '${id}'\n${why}`, exitCode: EXIT_NOT_FOUND };
  }
  if (matches.length > 1) {
    const listed = matches.slice(0, MAX_LISTED).map((f) => `  ${f.session.id}   ${describe(f)}`);
    if (matches.length > MAX_LISTED) listed.push(`  … and ${matches.length - MAX_LISTED} more`);
    const list = listed.join("\n");
    return usageError(`'${id}' matches ${matches.length} sessions; give more of the id:\n${list}`);
  }

  const [found] = matches;
  const line = resumeLine(found.session, true);
  if (values["dry-run"]) return { stdout: `${line}\n`, stderr: "", exitCode: EXIT_OK };
  return {
    stdout: "",
    stderr: `Resuming ${describe(found)}\n> ${line}\n`,
    exitCode: EXIT_OK,
    exec: { argv: found.session.resumeArgv, cwd: stripLongPathPrefix(found.session.cwd) },
  };
}
