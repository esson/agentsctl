import { errorMessage, ProviderError } from "./util.js";

export type SqliteCtor = typeof import("better-sqlite3");

/** better-sqlite3 is a native module: loaded on first use so a broken build only affects its callers. */
export async function loadSqlite(): Promise<SqliteCtor> {
  try {
    return (await import("better-sqlite3")).default;
  } catch (e) {
    throw new ProviderError(`cannot load better-sqlite3: ${errorMessage(e)}`);
  }
}
