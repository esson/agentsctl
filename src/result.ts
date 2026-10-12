/** What a command produces: text for both streams and the process exit code. */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** stdout may be shown through a pager (`--pager`) when it goes to a terminal. */
  page?: boolean;
}

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
