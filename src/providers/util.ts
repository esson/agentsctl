import { readFile } from "node:fs/promises";
import type { ProviderResult } from "./types.js";

// Shared helpers for providers. Never log or embed token values in errors.

export const FETCH_TIMEOUT_MS = 10_000;

/** An expected, user-facing failure. `message` is shown as-is in the report. */
export class ProviderError extends Error {
  /** HTTP status when the failure came from a response (used to detect 401 -> refresh). */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Turn anything thrown inside a provider into an error result. */
export function toErrorResult(provider: string, e: unknown): ProviderResult {
  if (e instanceof ProviderError) return { provider, ok: false, error: e.message };
  return { provider, ok: false, error: `unexpected error: ${errorMessage(e)}` };
}

/**
 * Read a JSON file. Missing file -> ProviderError(notFoundMessage).
 * Invalid JSON -> ProviderError naming the file.
 */
export async function readJsonFile(file: string, notFoundMessage: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new ProviderError(notFoundMessage);
    throw new ProviderError(`cannot read ${file}: ${errorMessage(e)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${file} is not valid JSON`);
  }
}

/** Decode the `exp` claim (epoch seconds) of a JWT without verifying it. null if absent/invalid. */
export function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    const exp = isRecord(payload) ? payload.exp : undefined;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** Window start for a fixed-length window that ends at `resetsAt`. */
export function windowStart(resetsAt: Date | null, lengthSeconds: number): Date | undefined {
  return resetsAt ? new Date(resetsAt.getTime() - lengthSeconds * 1000) : undefined;
}

/** Adds `startsAt` only when it is known, so windows without it keep their exact shape. */
export function withStart<T extends object>(w: T, startsAt: Date | undefined): T & { startsAt?: Date } {
  return startsAt ? { ...w, startsAt } : w;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Parse a date string/number; null if missing or invalid. */
export function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface FetchJsonOptions {
  /** Appended to 401/403 errors, e.g. "run `codex` once to refresh the login". */
  reloginHint: string;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * fetch + timeout + status/content-type checks + JSON parse.
 * Every failure becomes a ProviderError with a short, actionable message.
 */
export async function fetchJson(url: string, init: RequestInit, opts: FetchJsonOptions): Promise<unknown> {
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ProviderError(`request timed out after ${FETCH_TIMEOUT_MS / 1000}s (${new URL(url).host})`);
    }
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : errorMessage(e);
    throw new ProviderError(`network error: ${cause}`);
  }

  if (res.status === 401) {
    await res.body?.cancel();
    throw new ProviderError(`token rejected (401) — ${opts.reloginHint}`, 401);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.toLowerCase().includes("json");
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 403 && !isJson) {
      throw new ProviderError(`blocked (403, non-JSON response — likely a bot challenge or wrong endpoint)`);
    }
    if (res.status === 403) throw new ProviderError(`access denied (403) — ${opts.reloginHint}`, 403);
    if (res.status === 429) throw new ProviderError("rate limited (429) — try again later");
    throw new ProviderError(`HTTP ${res.status} ${res.statusText}`.trim());
  }
  if (!isJson) {
    await res.body?.cancel();
    throw new ProviderError(`unexpected response format (content-type: ${contentType || "none"})`);
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderError("unexpected response format (invalid JSON)");
  }
}
