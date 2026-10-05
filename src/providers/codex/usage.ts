import os from "node:os";
import path from "node:path";
import type { CollectOptions, Provider, ProviderResult, UsageWindow } from "../types.js";
import { casUpdateJsonFile, isExpired, requestTokenRefresh, withRefresh } from "../refresh.js";
import { decodeJwtExp, fetchJson, isFiniteNumber, isRecord, ProviderError, readJsonFile, toErrorResult, windowStart, withStart } from "../util.js";

// Verified contract: docs/providers/codex-usage.md

const PROVIDER = "Codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLI_VERSION = "0.155.1"; // version the headers were verified with
const RELOGIN = "run `codex` once to refresh the login";
// Refresh contract: docs/providers/codex-usage.md "Refresh"
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export function codexAuthPath(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

/** Label from the window length, shared naming across providers: 18000 -> "Session (5h)", 604800 -> "Weekly". */
export function codexWindowLabel(seconds: unknown, fallback: string): string {
  if (!isFiniteNumber(seconds) || seconds <= 0) return fallback;
  if (seconds === 604800) return "Weekly";
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  if (seconds % 3600 === 0) return `Session (${seconds / 3600}h)`;
  if (seconds % 60 === 0) return `Session (${seconds / 60}m)`;
  return fallback;
}

function parseWindow(w: unknown, fallbackLabel: string): UsageWindow | null {
  if (w === null || w === undefined) return null;
  if (!isRecord(w) || !isFiniteNumber(w.used_percent)) throw new ProviderError("unexpected response format");
  const resetsAt = isFiniteNumber(w.reset_at) ? new Date(w.reset_at * 1000) : null;
  const length = isFiniteNumber(w.limit_window_seconds) && w.limit_window_seconds > 0 ? w.limit_window_seconds : null;
  return withStart(
    { label: codexWindowLabel(w.limit_window_seconds, fallbackLabel), percentUsed: w.used_percent, resetsAt },
    length === null ? undefined : windowStart(resetsAt, length),
  );
}

/** Pure: map a /wham/usage response to windows. Throws ProviderError on unexpected shape. */
export function parseCodexUsage(json: unknown): UsageWindow[] {
  if (!isRecord(json) || !isRecord(json.rate_limit)) throw new ProviderError("unexpected response format");
  const rl = json.rate_limit;
  return [parseWindow(rl.primary_window, "Primary limit"), parseWindow(rl.secondary_window, "Secondary limit")].filter(
    (w): w is UsageWindow => w !== null,
  );
}

interface CodexAuth {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
}

function extractCodexAuth(auth: unknown, file: string): CodexAuth {
  if (!isRecord(auth)) throw new ProviderError(`unexpected format in ${file}`);
  const tokens = isRecord(auth.tokens) ? auth.tokens : undefined;
  const accessToken = tokens?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY !== "") {
      throw new ProviderError("logged in with an API key — no ChatGPT subscription usage to report");
    }
    throw new ProviderError(`not logged in: no access token in ${file} (run \`codex\` to log in)`);
  }
  const accountId = typeof tokens?.account_id === "string" && tokens.account_id ? tokens.account_id : undefined;
  const refreshToken =
    typeof tokens?.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : undefined;
  return { accessToken, refreshToken, accountId };
}

const storedRefreshToken = (json: Record<string, unknown>): unknown =>
  isRecord(json.tokens) ? json.tokens.refresh_token : undefined;

function userAgent(): string {
  const osName = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Mac OS" : "Linux";
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  return `codex_cli_rs/${CLI_VERSION} (${osName} ${os.release()}; ${arch})`;
}

export interface CodexDeps {
  authPath?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Refresh via auth.openai.com and write the new tokens back to auth.json (CAS on refresh_token). */
async function refreshCodex(file: string, auth: CodexAuth, deps: CodexDeps): Promise<string> {
  const usedRefresh = auth.refreshToken!;
  const res = await requestTokenRefresh({
    url: TOKEN_URL,
    body: { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: usedRefresh },
    reloginHint: "run `codex` once",
    fetchImpl: deps.fetchImpl,
  });
  const accessToken = res.access_token as string;
  try {
    const cas = await casUpdateJsonFile(file, usedRefresh, storedRefreshToken, (json) => {
      const tokens = isRecord(json.tokens) ? json.tokens : (json.tokens = {});
      tokens.access_token = accessToken;
      if (typeof res.id_token === "string" && res.id_token) tokens.id_token = res.id_token;
      if (typeof res.refresh_token === "string" && res.refresh_token) tokens.refresh_token = res.refresh_token;
      json.last_refresh = new Date(deps.now?.() ?? Date.now()).toISOString();
    });
    if (!cas.written && cas.json) {
      // Codex refreshed concurrently: its stored token wins, ours is discarded.
      const current = isRecord(cas.json.tokens) ? cas.json.tokens.access_token : undefined;
      if (typeof current === "string" && current) return current;
    }
  } catch {
    // Write-back failed: still use the new token for this run.
  }
  return accessToken;
}

export function createCodexProvider(deps: CodexDeps = {}): Provider {
  return {
    name: "codex",
    displayName: PROVIDER,
    async collect(opts?: CollectOptions): Promise<ProviderResult> {
      try {
        const file = (deps.authPath ?? codexAuthPath)();
        const auth = extractCodexAuth(
          await readJsonFile(file, `not logged in: ${file} not found (run \`codex\` to log in)`),
          file,
        );
        const exp = decodeJwtExp(auth.accessToken);
        const windows = await withRefresh({
          allowRefresh: opts?.refresh ?? true,
          accessToken: auth.accessToken,
          expired: isExpired(exp === null ? null : exp * 1000, deps.now?.() ?? Date.now()),
          expiredMessage: "token expired — run `codex` once to refresh the login",
          refresh: auth.refreshToken ? () => refreshCodex(file, auth, deps) : undefined,
          call: async (accessToken) => {
            const headers: Record<string, string> = {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
              "User-Agent": userAgent(),
              originator: "codex_cli_rs",
            };
            if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
            const json = await fetchJson(
              USAGE_URL,
              { method: "GET", headers },
              { reloginHint: RELOGIN, fetchImpl: deps.fetchImpl },
            );
            return parseCodexUsage(json);
          },
        });
        return { provider: PROVIDER, ok: true, windows };
      } catch (e) {
        return toErrorResult(PROVIDER, e);
      }
    },
  };
}

export const codex: Provider = createCodexProvider();
