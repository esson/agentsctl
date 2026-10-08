import path from "node:path";
import type { CollectOptions, Provider, ProviderResult, UsageWindow } from "../types.js";
import { casUpdateJsonFile, isExpired, requestTokenRefresh, withRefresh } from "../refresh.js";
import { claudeConfigDir } from "./paths.js";
import { fetchJson, isFiniteNumber, isRecord, parseDate, ProviderError, readJsonFile, toErrorResult, windowStart, withStart } from "../util.js";

// Verified contract: docs/providers/claude-usage.md

const PROVIDER = "Claude";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const RELOGIN = "run `claude` once to refresh the login";
// Refresh contract: docs/providers/claude-usage.md section 6
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export function claudeCredentialsPath(): string {
  return path.join(claudeConfigDir(), ".credentials.json");
}

const SESSION_SECONDS = 5 * 3600;
const WEEK_SECONDS = 7 * 86400;

function scopedLabel(scope: unknown): string {
  const model = isRecord(scope) && isRecord(scope.model) ? scope.model : undefined;
  const name = typeof model?.display_name === "string" && model.display_name ? model.display_name : "scoped";
  return `Weekly (${name})`;
}

function parseLimits(limits: unknown[]): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const l of limits) {
    if (!isRecord(l) || !isFiniteNumber(l.percent)) continue;
    let label: string;
    let length = WEEK_SECONDS;
    if (l.kind === "session") [label, length] = ["Session (5h)", SESSION_SECONDS];
    else if (l.kind === "weekly_all") label = "Weekly";
    else if (l.kind === "weekly_scoped") label = scopedLabel(l.scope);
    else continue; // unknown kinds are not rendered
    const resetsAt = parseDate(l.resets_at);
    out.push(withStart({ label, percentUsed: l.percent, resetsAt }, windowStart(resetsAt, length)));
  }
  return out;
}

const FLAT_KEYS: [key: string, label: string, lengthSeconds: number][] = [
  ["five_hour", "Session (5h)", SESSION_SECONDS],
  ["seven_day", "Weekly", WEEK_SECONDS],
  ["seven_day_sonnet", "Weekly (Sonnet)", WEEK_SECONDS],
  ["seven_day_opus", "Weekly (Opus)", WEEK_SECONDS],
];

function parseFlat(json: Record<string, unknown>): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const [key, label, length] of FLAT_KEYS) {
    const v = json[key];
    if (!isRecord(v) || !isFiniteNumber(v.utilization)) continue;
    const resetsAt = parseDate(v.resets_at);
    out.push(withStart({ label, percentUsed: v.utilization, resetsAt }, windowStart(resetsAt, length)));
  }
  return out;
}

/**
 * Pure: map an /api/oauth/usage response to windows. Prefers `limits[]`, falls back to
 * the flat five_hour/seven_day/... keys. Only known keys are read.
 */
export function parseClaudeUsage(json: unknown): UsageWindow[] {
  if (!isRecord(json)) throw new ProviderError("unexpected response format");
  if (Array.isArray(json.limits)) {
    const windows = parseLimits(json.limits);
    if (windows.length > 0) return windows;
  }
  const flat = parseFlat(json);
  if (flat.length > 0) return flat;
  if (Array.isArray(json.limits) || "five_hour" in json || "seven_day" in json) return [];
  throw new ProviderError("unexpected response format");
}

interface ClaudeAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
  scopes: string[];
}

function extractClaudeAuth(creds: unknown, file: string): ClaudeAuth {
  const oauth = isRecord(creds) && isRecord(creds.claudeAiOauth) ? creds.claudeAiOauth : undefined;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || token === "") {
    throw new ProviderError(`not logged in: no claudeAiOauth.accessToken in ${file} (run \`claude\` to log in)`);
  }
  const refreshToken = typeof oauth?.refreshToken === "string" && oauth.refreshToken ? oauth.refreshToken : undefined;
  const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes.filter((x): x is string => typeof x === "string") : [];
  return { accessToken: token, refreshToken, expiresAt: isFiniteNumber(oauth?.expiresAt) ? oauth.expiresAt : null, scopes };
}

const storedRefreshToken = (json: Record<string, unknown>): unknown =>
  isRecord(json.claudeAiOauth) ? json.claudeAiOauth.refreshToken : undefined;

export interface ClaudeDeps {
  credentialsPath?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Refresh via platform.claude.com and write back to .credentials.json (CAS on refreshToken). */
async function refreshClaude(file: string, auth: ClaudeAuth, deps: ClaudeDeps): Promise<string> {
  const usedRefresh = auth.refreshToken!;
  const res = await requestTokenRefresh({
    url: TOKEN_URL,
    body: { grant_type: "refresh_token", refresh_token: usedRefresh, client_id: CLIENT_ID, scope: auth.scopes.join(" ") },
    reloginHint: "run `claude` once",
    fetchImpl: deps.fetchImpl,
  });
  const accessToken = res.access_token as string;
  const now = deps.now?.() ?? Date.now();
  try {
    const cas = await casUpdateJsonFile(file, usedRefresh, storedRefreshToken, (json) => {
      const oauth = isRecord(json.claudeAiOauth) ? json.claudeAiOauth : (json.claudeAiOauth = {});
      oauth.accessToken = accessToken;
      if (typeof res.refresh_token === "string" && res.refresh_token) oauth.refreshToken = res.refresh_token;
      if (isFiniteNumber(res.expires_in)) oauth.expiresAt = now + res.expires_in * 1000;
      if (isFiniteNumber(res.refresh_token_expires_in) && "refreshTokenExpiresAt" in oauth) {
        oauth.refreshTokenExpiresAt = now + res.refresh_token_expires_in * 1000;
      }
    });
    if (!cas.written && cas.json) {
      // Claude Code refreshed concurrently: its stored token wins, ours is discarded.
      const current = isRecord(cas.json.claudeAiOauth) ? cas.json.claudeAiOauth.accessToken : undefined;
      if (typeof current === "string" && current) return current;
    }
  } catch {
    // Write-back failed: still use the new token for this run.
  }
  return accessToken;
}

export function createClaudeProvider(deps: ClaudeDeps = {}): Provider {
  return {
    name: "claude",
    displayName: PROVIDER,
    async collect(opts?: CollectOptions): Promise<ProviderResult> {
      try {
        const file = (deps.credentialsPath ?? claudeCredentialsPath)();
        const auth = extractClaudeAuth(
          await readJsonFile(file, `not logged in: ${file} not found (run \`claude\` to log in)`),
          file,
        );
        const windows = await withRefresh({
          allowRefresh: opts?.refresh ?? true,
          accessToken: auth.accessToken,
          expired: isExpired(auth.expiresAt, deps.now?.() ?? Date.now()),
          expiredMessage: "token expired — run `claude` once to refresh the login",
          refresh: auth.refreshToken ? () => refreshClaude(file, auth, deps) : undefined,
          call: async (accessToken) =>
            parseClaudeUsage(
              await fetchJson(
                USAGE_URL,
                { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" } },
                { reloginHint: RELOGIN, fetchImpl: deps.fetchImpl },
              ),
            ),
        });
        return { provider: PROVIDER, ok: true, windows };
      } catch (e) {
        return toErrorResult(PROVIDER, e);
      }
    },
  };
}

export const claude: Provider = createClaudeProvider();
