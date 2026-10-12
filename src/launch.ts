import { spawn } from "node:child_process";

// Running a program with the terminal attached, for `agentsctl resume`. Process I/O, so only
// agentsctl.ts uses it; commands describe the program in RunResult.exec.

/**
 * One argument quoted for the shell that runs it: cmd.exe on Windows (where the agents are
 * .cmd/.exe shims found through PATH, and `start` is a cmd builtin), /bin/sh elsewhere.
 */
export function quoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return /^[\w\-.:\\/=@+,]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
  return /^[\w\-.:/=@+,]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** The command line the shell runs for `argv`. */
export const commandLine = (argv: string[], platform: NodeJS.Platform = process.platform): string =>
  argv.map((a) => quoteArg(a, platform)).join(" ");

/**
 * Run `argv` in `cwd` with this terminal's stdin, stdout and stderr, and wait for it to exit.
 * Resolves to its exit code; rejects when it cannot be started (for example, `cwd` is gone).
 */
export function runAttached(argv: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandLine(argv), { cwd, shell: true, stdio: "inherit" });
    // Ctrl+C goes to the agent (the whole console gets it); agentsctl waits for the agent instead.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    const done = () => process.off("SIGINT", ignore);
    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code, signal) => {
      done();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
