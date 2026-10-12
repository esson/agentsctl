/** What a command produces: text for both streams and the process exit code. */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** stdout may be shown through a pager (`--pager`) when it goes to a terminal. */
  page?: boolean;
  /**
   * A program to run after printing, with the terminal attached (`agentsctl resume`); its exit
   * code becomes agentsctl's. Commands only describe it, the entry point runs it.
   */
  exec?: { argv: string[]; cwd: string };
}

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
