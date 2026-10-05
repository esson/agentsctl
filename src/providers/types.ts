/** One usage limit window reported by a provider (e.g. "Session (5h)", "Weekly", "Monthly"). */
export interface UsageWindow {
  label: string; // "Session (5h)", "Weekly", "Weekly (Opus)", "Monthly (Team)" ...
  percentUsed: number | null; // 0–100, or null when there is no limit to measure against
  resetsAt: Date | null;
  /** Start of the current window, when known. With `resetsAt` it gives the elapsed share (pace). */
  startsAt?: Date;
  extra?: string; // e.g. "142/300" for Copilot premium requests
}

export type ProviderResult =
  | { provider: string; ok: true; windows: UsageWindow[] }
  | { provider: string; ok: false; error: string };

/** Options passed to every provider run. */
export interface CollectOptions {
  /**
   * Allow a best-effort token refresh (only when the stored token is expired or the usage
   * call returns 401), including writing the new tokens back to the tool's credential store.
   * `false` = strictly read-only (`--no-refresh`).
   */
  refresh: boolean;
}

/** A usage provider. `name` is the lowercase id used by `--provider`. */
export interface Provider {
  name: string;
  /** Display name used in the text report (defaults to `name`). */
  displayName?: string;
  collect(opts?: CollectOptions): Promise<ProviderResult>;
}
