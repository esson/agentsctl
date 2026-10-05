import type { Provider } from "./providers/types.js";
import { EXIT_OK, EXIT_USAGE, type RunResult } from "./result.js";
import { NO_TERMINAL, type Terminal } from "./terminal.js";
import { runUsage } from "./usage/cli.js";

// CLI logic without process I/O: argv + providers + clock in, text + exit code out.
// agentsctl.ts wires in the real providers; tests inject fakes.

export { EXIT_OK, EXIT_USAGE, type RunResult } from "./result.js";
export type { Terminal } from "./terminal.js";

/** Everything a subcommand may need, injected by `run`. */
interface Context {
  providers: Provider[];
  now: () => Date;
  term: Terminal;
}

interface Command {
  summary: string;
  run(argv: string[], ctx: Context): Promise<RunResult>;
}

const COMMANDS: Record<string, Command> = {
  usage: {
    summary: "Show subscription usage limits for Codex, Claude, Copilot and Cursor",
    run: (argv, ctx) => runUsage(argv, ctx.providers, ctx.now, ctx.term),
  },
};

export function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const commands = Object.entries(COMMANDS)
    .map(([name, c]) => `  ${name.padEnd(width)}   ${c.summary}`)
    .join("\n");
  return `agentsctl — one CLI for your AI coding agents

Usage: agentsctl <command> [options]

Commands:
${commands}

Options:
  -h, --help   Show this help

Run "agentsctl <command> --help" for the options of a command.
`;
}

export async function run(
  argv: string[],
  providers: Provider[],
  now: () => Date = () => new Date(),
  term: Terminal = NO_TERMINAL,
): Promise<RunResult> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "-h" || name === "--help") {
    return { stdout: helpText(), stderr: "", exitCode: EXIT_OK };
  }
  // Own-property check: "toString" etc. must not resolve to Object.prototype members.
  if (!Object.hasOwn(COMMANDS, name)) {
    const what = name.startsWith("-") ? "unknown option" : "unknown command";
    return { stdout: "", stderr: `agentsctl: ${what} '${name}'\n\n${helpText()}`, exitCode: EXIT_USAGE };
  }
  return COMMANDS[name].run(rest, { providers, now, term });
}
