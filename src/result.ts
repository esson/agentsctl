/** What a command produces: text for both streams and the process exit code. */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
