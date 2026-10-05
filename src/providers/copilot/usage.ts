// Copilot usage via GET https://api.github.com/copilot_internal/user (internal, undocumented).
// Response schema verified live 2026-09-23 on a Copilot Business account (docs/providers/copilot-usage.md).
// Token: Copilot CLI's credential `copilot-cli/https://github.com:<login>` in Windows Credential
// Manager (login from ~/.copilot/config.json, which starts with a `//` comment line), falling
// back to `gh auth token`. Credential reads use read-only CredReadW (wincred.ts) — never
// @napi-rs/keyring, whose withTarget().getPassword() blanked the credentials.
//
// Token-based billing (verified 2026-09-23, Copilot Business): users have no personal cap
// (`unlimited: true`); the real limit is the organization's pool of included AI credits.
// Pool = seats × AGENTSCTL_COPILOT_CREDITS_PER_SEAT (default 1900), or AGENTSCTL_COPILOT_TEAM_CREDITS.
// Used = Copilot `ai-units` from the org billing usage summary (needs org admin/billing access).

import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { Provider, ProviderResult, UsageWindow } from "../types.js";
import { readGenericCredential } from "../../wincred.js";
import { errorMessage, fetchJson, isFiniteNumber, isRecord, ProviderError, toErrorResult, withStart } from "../util.js";

const PROVIDER = "Copilot";
const USER_URL = "https://api.github.com/copilot_internal/user";
const UNEXPECTED = "unexpected response format";
const API = "https://api.github.com";
// Derived from the org billing page (2026-09-23): included AI credits divided by Business seats.
const DEFAULT_CREDITS_PER_SEAT = 1900;

export function copilotConfigPath(): string {
  return path.join(os.homedir(), ".copilot", "config.json");
}

/** Strip whole-line `//` comments, then JSON.parse. */
export function parseCommentedJson(text: string): unknown {
  const stripped = text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return JSON.parse(stripped);
}

async function readLogin(): Promise<string> {
  const file = copilotConfigPath();
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProviderError(`not logged in: ${file} not found (run \`copilot\` and log in)`);
    }
    throw new ProviderError(`cannot read ${file}: ${errorMessage(e)}`);
  }
  let cfg: unknown;
  try {
    cfg = parseCommentedJson(text);
  } catch {
    throw new ProviderError(`${file} is not valid JSON`);
  }
  const last = isRecord(cfg) && isRecord(cfg.lastLoggedInUser) ? cfg.lastLoggedInUser : undefined;
  const login = last?.login;
  if (typeof login !== "string" || login === "") {
    throw new ProviderError(`not logged in: no lastLoggedInUser.login in ${file} (run \`copilot\` and log in)`);
  }
  return login;
}

async function readCopilotCliToken(login: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new ProviderError("copilot-cli token lookup is only implemented for Windows Credential Manager");
  }
  const target = `copilot-cli/https://github.com:${login}`;
  let secret: string | null;
  try {
    // Read-only CredReadW. Never @napi-rs/keyring: it blanked credentials (see wincred.ts).
    secret = await readGenericCredential(target);
  } catch (e) {
    throw new ProviderError(`cannot read Windows Credential Manager: ${errorMessage(e)}`);
  }
  if (secret === null || secret === undefined) {
    throw new ProviderError("no copilot-cli entry in Windows Credential Manager");
  }
  if (secret === "") throw new ProviderError("copilot-cli entry in Windows Credential Manager is empty");
  return secret;
}

/** Fallback: the GitHub CLI's token (`gh auth token`, read-only). Verified to work against /copilot_internal/user. */
function readGhToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token", "-h", "github.com"], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      const token = stdout?.trim() ?? "";
      if (err || token === "") return reject(new ProviderError("`gh auth token` returned no token"));
      resolve(token);
    });
  });
}

interface TokenSource {
  source: string;
  token: string;
}

/** All readable tokens: Copilot CLI's own credential first, then `gh auth token`. */
async function readTokens(): Promise<TokenSource[]> {
  const tokens: TokenSource[] = [];
  const problems: string[] = [];
  try {
    tokens.push({ source: "copilot-cli", token: await readCopilotCliToken(await readLogin()) });
  } catch (e) {
    problems.push(errorMessage(e));
  }
  try {
    const gh = await readGhToken();
    if (!tokens.some((t) => t.token === gh)) tokens.push({ source: "gh", token: gh });
  } catch (e) {
    problems.push(errorMessage(e));
  }
  if (tokens.length === 0) {
    throw new ProviderError(`not logged in: ${problems.join("; ")} (run \`copilot\` and /login, or \`gh auth login\`)`);
  }
  return tokens;
}

export interface CopilotUser {
  orgs: string[];
  resetsAt: Date | null;
  tokenBasedBilling: boolean;
  /** Personal AI credits used this month (token-based billing). */
  creditsUsed: number | null;
  premium: Record<string, unknown>;
}

/** Parser for /copilot_internal/user, verified live 2026-09-23 (Copilot Business, docs/providers/copilot-usage.md). */
export function parseCopilotUser(json: unknown): CopilotUser {
  const snaps = isRecord(json) && isRecord(json.quota_snapshots) ? json.quota_snapshots : undefined;
  const premium = snaps && isRecord(snaps.premium_interactions) ? snaps.premium_interactions : undefined;
  if (!isRecord(json) || !premium || !isFiniteNumber(premium.percent_remaining)) throw new ProviderError(UNEXPECTED);
  const resetRaw = json.quota_reset_date_utc ?? json.quota_reset_date;
  const reset = typeof resetRaw === "string" ? new Date(resetRaw) : null;
  const orgs = Array.isArray(json.organization_login_list)
    ? json.organization_login_list.filter((o): o is string => typeof o === "string")
    : [];
  return {
    orgs,
    resetsAt: reset && !Number.isNaN(reset.getTime()) ? reset : null,
    tokenBasedBilling: json.token_based_billing === true || premium.token_based_billing === true,
    creditsUsed: isFiniteNumber(premium.credits_used) ? premium.credits_used : null,
    premium,
  };
}

/**
 * Per-user premium-request window for request-based billing. `unlimited` plans report
 * entitlement 0, so they get no percentage. Limited plans have not been observed live.
 */
export function premiumWindow(user: CopilotUser): UsageWindow {
  const p = user.premium;
  if (p.unlimited === true) {
    return { label: "Monthly (Premium)", percentUsed: null, resetsAt: user.resetsAt, extra: "no personal limit" };
  }
  const w: UsageWindow = {
    label: "Monthly (Premium)",
    percentUsed: 100 - (p.percent_remaining as number),
    resetsAt: user.resetsAt,
  };
  if (isFiniteNumber(p.entitlement) && p.entitlement > 0 && isFiniteNumber(p.remaining)) {
    w.extra = `${p.entitlement - p.remaining}/${p.entitlement}`;
  }
  return w;
}

/** Copilot AI credits (`ai-units`, gross) used this month, from the org billing usage summary. */
export function parseOrgCreditsUsed(json: unknown): number {
  const items = isRecord(json) && Array.isArray(json.usageItems) ? json.usageItems : undefined;
  if (!items) throw new ProviderError(UNEXPECTED);
  let used = 0;
  for (const i of items) {
    if (isRecord(i) && i.product === "Copilot" && i.unitType === "ai-units" && isFiniteNumber(i.grossQuantity)) {
      used += i.grossQuantity;
    }
  }
  return used;
}

/** Total Copilot seats, from /orgs/{org}/copilot/billing. */
export function parseOrgSeats(json: unknown): number {
  const total = isRecord(json) && isRecord(json.seat_breakdown) ? json.seat_breakdown.total : undefined;
  if (!isFiniteNumber(total)) throw new ProviderError(UNEXPECTED);
  return total;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw.replace(/[_,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new ProviderError(`${name} must be a positive number`);
  return n;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** The quota resets on the 1st (UTC), so the window started one calendar month before the reset. */
export function monthStartUtc(resetsAt: Date | null): Date | undefined {
  if (!resetsAt) return undefined;
  const start = new Date(resetsAt.getTime());
  start.setUTCMonth(start.getUTCMonth() - 1);
  return start;
}

export function teamCreditsWindow(
  used: number,
  pool: number,
  personal: number | null,
  resetsAt: Date | null,
): UsageWindow {
  const share = used > 0 && personal !== null ? ` - ${Math.round((personal / used) * 100)}%` : "";
  const you = personal === null ? "" : `, you ${fmt(personal)} AIC${share}`;
  const window = { label: "Monthly (Team)", percentUsed: (used / pool) * 100, resetsAt, extra: `${fmt(used)}/${fmt(pool)} AIC${you}` };
  return withStart(window, monthStartUtc(resetsAt));
}

function ghHeaders(token: string): Record<string, string> {
  return { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}

/** GET with the first token that works (e.g. the Copilot CLI token may lack org billing access). */
async function getWithAnyToken(url: string, tokens: TokenSource[], reloginHint: string): Promise<unknown> {
  let last: unknown;
  for (const t of tokens) {
    try {
      return await fetchJson(url, { method: "GET", headers: ghHeaders(t.token) }, { reloginHint });
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function teamWindow(user: CopilotUser, tokens: TokenSource[]): Promise<UsageWindow> {
  const orgs = process.env.AGENTSCTL_COPILOT_ORG ? [process.env.AGENTSCTL_COPILOT_ORG] : user.orgs;
  if (orgs.length === 0) throw new ProviderError("no organization on this Copilot account");
  const now = new Date();
  const hint = "org admin or billing manager access needed";
  let last: unknown;
  for (const org of orgs) {
    try {
      const o = encodeURIComponent(org);
      const period = `year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`;
      const used = parseOrgCreditsUsed(
        await getWithAnyToken(`${API}/organizations/${o}/settings/billing/usage/summary?${period}`, tokens, hint),
      );
      let pool = envNumber("AGENTSCTL_COPILOT_TEAM_CREDITS");
      if (pool === undefined) {
        const seats = parseOrgSeats(await getWithAnyToken(`${API}/orgs/${o}/copilot/billing`, tokens, hint));
        pool = seats * (envNumber("AGENTSCTL_COPILOT_CREDITS_PER_SEAT") ?? DEFAULT_CREDITS_PER_SEAT);
      }
      return teamCreditsWindow(used, pool, user.creditsUsed, user.resetsAt);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export const copilot: Provider = {
  name: "copilot",
  displayName: PROVIDER,
  async collect(): Promise<ProviderResult> {
    try {
      const tokens = await readTokens();
      const user = parseCopilotUser(await getWithAnyToken(USER_URL, tokens, "run `copilot` and /login, or `gh auth login`"));
      if (!user.tokenBasedBilling) return { provider: PROVIDER, ok: true, windows: [premiumWindow(user)] };
      try {
        return { provider: PROVIDER, ok: true, windows: [await teamWindow(user, tokens)] };
      } catch (e) {
        // The team pool needs org admin/billing access; fall back to personal usage (no limit).
        const used = user.creditsUsed === null ? "usage unknown" : `${fmt(user.creditsUsed)} AIC used`;
        const extra = `${used}, no personal limit; team pool unavailable: ${errorMessage(e)}`;
        return {
          provider: PROVIDER,
          ok: true,
          windows: [{ label: "Monthly (You)", percentUsed: null, resetsAt: user.resetsAt, extra }],
        };
      }
    } catch (e) {
      if (e instanceof ProviderError && e.message.startsWith(UNEXPECTED)) {
        return { provider: PROVIDER, ok: false, error: UNEXPECTED };
      }
      return toErrorResult(PROVIDER, e);
    }
  },
};
