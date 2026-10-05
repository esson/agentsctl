/** Terminal facts that decide whether output is colored and how wide it may be. */
export interface Terminal {
  isTTY: boolean;
  env: Record<string, string | undefined>;
  /** Terminal width; undefined when unknown (e.g. output is piped). */
  columns?: number;
}

export const NO_TERMINAL: Terminal = { isTTY: false, env: {} };

/** Color only for a TTY, unless NO_COLOR / --no-color disable it or FORCE_COLOR forces it. */
export function useColor(noColorFlag: boolean, term: Terminal): boolean {
  if (noColorFlag || term.env.NO_COLOR) return false;
  const force = term.env.FORCE_COLOR;
  if (force !== undefined && force !== "") return force !== "0" && force !== "false";
  return term.isTTY;
}
