import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage, FETCH_TIMEOUT_MS, isRecord, ProviderError } from "./util.js";

// Best-effort OAuth token refresh shared by Codex, Claude and Cursor.
// Policy: refresh only when the stored access token is expired (with EXPIRY_SKEW_MS) or the
// usage call returned 401; then refresh once and retry the usage call once. Never log tokens.

export const EXPIRY_SKEW_MS = 60_000;

/** True if `expiresAtMs` is known and at most EXPIRY_SKEW_MS in the future. */
export function isExpired(expiresAtMs: number | null | undefined, nowMs: number): boolean {
  return typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs) && expiresAtMs - EXPIRY_SKEW_MS <= nowMs;
}

export interface WithRefreshOptions<T> {
  /** --no-refresh => false. */
  allowRefresh: boolean;
  accessToken: string;
  /** Local expiry check said the token is expired. */
  expired: boolean;
  /** Error shown when the token is expired and no refresh is possible/allowed. */
  expiredMessage: string;
  /** Present when a refresh token is stored. Returns the access token to use afterwards. */
  refresh?: () => Promise<string>;
  /** The usage call. A ProviderError with status 401 triggers the refresh path. */
  call: (accessToken: string) => Promise<T>;
}

/** Run the usage call with at most one refresh and one retry. */
export async function withRefresh<T>(o: WithRefreshOptions<T>): Promise<T> {
  const canRefresh = o.allowRefresh && o.refresh !== undefined;
  if (o.expired) {
    if (!canRefresh) throw new ProviderError(o.expiredMessage);
    return o.call(await o.refresh!());
  }
  try {
    return await o.call(o.accessToken);
  } catch (e) {
    if (!canRefresh || !(e instanceof ProviderError) || e.status !== 401) throw e;
  }
  return o.call(await o.refresh!());
}

export interface TokenRequest {
  url: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  /** e.g. "run `codex` once" — appended to the refresh-failed error. */
  reloginHint: string;
  fetchImpl?: typeof fetch;
}

/**
 * POST a refresh_token grant. Returns the JSON response, which is guaranteed to contain a
 * non-empty string `access_token`. Any failure -> ProviderError
 * "token expired and refresh failed (<status>) — <hint>".
 */
export async function requestTokenRefresh(req: TokenRequest): Promise<Record<string, unknown>> {
  const fail = (what: string | number) =>
    new ProviderError(`token expired and refresh failed (${what}) — ${req.reloginHint}`);
  let res: Response;
  try {
    res = await (req.fetchImpl ?? fetch)(req.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...req.headers },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    throw fail(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw fail(res.status);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw fail("invalid response");
  }
  if (!isRecord(json) || typeof json.access_token !== "string" || json.access_token === "") {
    throw fail("invalid response");
  }
  return json;
}

// ---------------------------------------------------------------------------------------------
// Atomic JSON write-back with compare-and-swap on the refresh token.

interface JsonFormat {
  indent: string | number;
  eol: string;
  trailingNewline: boolean;
  bom: boolean;
}

/** Detect indentation / line endings so a rewrite keeps the original style. */
export function detectJsonFormat(text: string): JsonFormat {
  const bom = text.startsWith("﻿");
  const body = bom ? text.slice(1) : text;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const m = /^[{[]\r?\n([ \t]+)\S/.exec(body);
  const indent = m ? m[1] : body.includes("\n") ? 2 : 0;
  return { indent, eol, trailingNewline: /\r?\n$/.test(body), bom };
}

export function formatJson(value: unknown, fmt: JsonFormat): string {
  let out = JSON.stringify(value, null, fmt.indent);
  if (fmt.eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (fmt.trailingNewline) out += fmt.eol;
  return (fmt.bom ? "﻿" : "") + out;
}

export type CasResult = { written: true; json: Record<string, unknown> } | { written: false; json: Record<string, unknown> | null };

/**
 * Re-read `file`, and only if `getRefreshToken(json) === expectedRefreshToken` apply `mutate` and
 * atomically replace the file (temp file in the same directory + rename). If the stored refresh
 * token changed (the tool refreshed concurrently) nothing is written and the current JSON is
 * returned so the caller can use the tool's new access token instead. Only fields touched by
 * `mutate` change; unknown keys, key order and formatting style are preserved.
 */
export async function casUpdateJsonFile(
  file: string,
  expectedRefreshToken: string,
  getRefreshToken: (json: Record<string, unknown>) => unknown,
  mutate: (json: Record<string, unknown>) => void,
): Promise<CasResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { written: false, json: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { written: false, json: null };
  }
  if (!isRecord(json)) return { written: false, json: null };
  if (getRefreshToken(json) !== expectedRefreshToken) return { written: false, json };

  mutate(json);
  await atomicWriteFile(file, formatJson(json, detectJsonFormat(text)));
  return { written: true, json };
}

/** Write to a temp file next to `file`, then rename over it (atomic replace on NTFS/POSIX). */
export async function atomicWriteFile(file: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.agentsctl-${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    // Windows can briefly refuse the rename while another process has the target open.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  } catch (e) {
    await rm(tmp, { force: true });
    throw new Error(`cannot write ${file}: ${errorMessage(e)}`);
  }
}
