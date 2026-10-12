import os from "node:os";
import path from "node:path";
import type { CollectOptions, Provider, ProviderResult, UsageWindow } from "../types.js";
import { isExpired, requestTokenRefresh, withRefresh } from "../refresh.js";
import { loadSqlite, type SqliteCtor } from "../sqlite.js";
import { decodeJwtExp, errorMessage, fetchJson, isFiniteNumber, isRecord, ProviderError, toErrorResult, withStart } from "../util.js";

// Verified contract: docs/providers/cursor-usage.md

const PROVIDER = "Cursor";
const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const RELOGIN = "open Cursor to refresh the session";
// Refresh contract: docs/providers/cursor-usage.md "Refresh flow"
const TOKEN_URL = "https://api2.cursor.sh/oauth/token";
const CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

export function cursorDbPath(): string {
  let base: string;
  if (process.platform === "win32") {
    base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  } else if (process.platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support");
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  }
  return path.join(base, "Cursor", "User", "globalStorage", "state.vscdb");
}

/** Protobuf JSON omits zero-valued numbers: a missing number means 0. */
function num(v: unknown): number | null {
  if (v === undefined) return 0;
  return isFiniteNumber(v) ? v : null;
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** Pure: map a GetCurrentPeriodUsage response to windows. Throws ProviderError on unexpected shape. */
export function parseCursorUsage(json: unknown): UsageWindow[] {
  if (!isRecord(json)) throw new ProviderError("unexpected response format");
  if (json.enabled === false) throw new ProviderError("no included-usage data for this account (usage not enabled)");
  const plan = json.planUsage;
  if (plan === undefined) throw new ProviderError("no included-usage data for this account (planUsage missing)");
  if (!isRecord(plan)) throw new ProviderError("unexpected response format");

  const total = num(plan.totalPercentUsed);
  const auto = num(plan.autoPercentUsed);
  const api = num(plan.apiPercentUsed);
  const limit = num(plan.limit);
  const remaining = num(plan.remaining);
  const totalSpend = num(plan.totalSpend);
  if (total === null || auto === null || api === null || limit === null || remaining === null || totalSpend === null) {
    throw new ProviderError("unexpected response format");
  }

  let resetsAt: Date | null = null;
  if (typeof json.billingCycleEnd === "string" || typeof json.billingCycleEnd === "number") {
    const ms = Number(json.billingCycleEnd);
    if (Number.isFinite(ms) && ms > 0) resetsAt = new Date(ms);
  }

  let startsAt: Date | undefined;
  if (typeof json.billingCycleStart === "string" || typeof json.billingCycleStart === "number") {
    const ms = Number(json.billingCycleStart);
    if (Number.isFinite(ms) && ms > 0) startsAt = new Date(ms);
  }

  // Dollars spent so far (cents in the API). Not shown against `limit`: Cursor's percentages
  // are measured against other, unpublished allowances, so "$spent/$limit" contradicts them.
  const spentCents = plan.totalSpend !== undefined ? totalSpend : limit - remaining;
  const spent = `${dollars(spentCents)} spent`;

  // Same two meters as Cursor's own usage page: "Cursor Models" (the auto bucket: Composer,
  // Cursor Grok, ...) and "Other Models" (named/API models).
  if (plan.autoPercentUsed !== undefined || plan.apiPercentUsed !== undefined) {
    return [
      withStart({ label: "Cursor Models", percentUsed: auto, resetsAt, extra: `${spent} in total` }, startsAt),
      withStart({ label: "Other Models", percentUsed: api, resetsAt }, startsAt),
    ];
  }
  // Older/other plans without the split: one combined meter.
  return [withStart({ label: "Monthly", percentUsed: total, resetsAt, extra: spent }, startsAt)];
}

const ACCESS_KEY = "cursorAuth/accessToken";
const REFRESH_KEY = "cursorAuth/refreshToken";

function asText(v: unknown): string | undefined {
  const t = Buffer.isBuffer(v) ? v.toString("utf8") : v;
  return typeof t === "string" && t.trim() !== "" ? t : undefined;
}

interface CursorAuth {
  accessToken: string;
  refreshToken?: string;
}

async function readCursorAuth(file: string): Promise<CursorAuth> {
  const Database = await loadSqlite();
  let access: unknown;
  let refresh: unknown;
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 2000 });
    try {
      const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
      access = (stmt.get(ACCESS_KEY) as { value: unknown } | undefined)?.value;
      refresh = (stmt.get(REFRESH_KEY) as { value: unknown } | undefined)?.value;
    } finally {
      db.close();
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    const msg = errorMessage(e);
    if (/unable to open|does not exist|SQLITE_CANTOPEN/i.test(msg) || code === "SQLITE_CANTOPEN") {
      throw new ProviderError(`not logged in: ${file} not found (open Cursor and sign in)`);
    }
    if (code === "SQLITE_BUSY" || /busy|locked/i.test(msg)) {
      throw new ProviderError("Cursor state database is busy — try again in a moment");
    }
    throw new ProviderError(`cannot read Cursor state database: ${msg}`);
  }
  const accessToken = asText(access);
  if (!accessToken) {
    throw new ProviderError("not logged in: no cursorAuth/accessToken in state.vscdb (open Cursor and sign in)");
  }
  return { accessToken, refreshToken: asText(refresh) };
}

/**
 * Write the refreshed tokens back in one short IMMEDIATE transaction, only if the stored refresh
 * token is still the one we used (CAS). Returns the access token to use: ours, or Cursor's own if
 * it refreshed concurrently. If the DB is busy/locked or anything fails, nothing is written and
 * our new token is used in memory only.
 */
export async function writeBackCursorTokens(
  file: string,
  usedRefresh: string,
  accessToken: string,
  refreshToken: string,
): Promise<string> {
  const Database = await loadSqlite();
  let db: InstanceType<SqliteCtor> | undefined;
  try {
    db = new Database(file, { fileMustExist: true, timeout: 1000 });
    const conn = db;
    const get = conn.prepare("SELECT value FROM ItemTable WHERE key = ?");
    const upd = conn.prepare("UPDATE ItemTable SET value = ? WHERE key = ?");
    return conn.transaction((): string => {
      const storedRefresh = (get.get(REFRESH_KEY) as { value: unknown } | undefined)?.value;
      if (asText(storedRefresh) !== usedRefresh) {
        const current = asText((get.get(ACCESS_KEY) as { value: unknown } | undefined)?.value);
        return current ?? accessToken;
      }
      const storedAccess = (get.get(ACCESS_KEY) as { value: unknown } | undefined)?.value;
      upd.run(Buffer.isBuffer(storedAccess) ? Buffer.from(accessToken, "utf8") : accessToken, ACCESS_KEY);
      upd.run(Buffer.isBuffer(storedRefresh) ? Buffer.from(refreshToken, "utf8") : refreshToken, REFRESH_KEY);
      return accessToken;
    }).immediate();
  } catch {
    return accessToken;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

export interface CursorDeps {
  dbPath?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

async function refreshCursor(file: string, auth: CursorAuth, deps: CursorDeps): Promise<string> {
  const usedRefresh = auth.refreshToken!;
  const res = await requestTokenRefresh({
    url: TOKEN_URL,
    body: { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: usedRefresh },
    headers: { "x-cursor-client-type": "ide" },
    reloginHint: "sign in to Cursor again",
    fetchImpl: deps.fetchImpl,
  });
  if (res.shouldLogout === true) {
    throw new ProviderError("token expired and refresh failed (shouldLogout) — sign in to Cursor again");
  }
  const accessToken = res.access_token as string;
  // Cursor itself stores the new access token as the refresh token too (docs/providers/cursor-usage.md).
  const refreshToken = typeof res.refresh_token === "string" && res.refresh_token ? res.refresh_token : accessToken;
  return writeBackCursorTokens(file, usedRefresh, accessToken, refreshToken);
}

export function createCursorProvider(deps: CursorDeps = {}): Provider {
  return {
    name: "cursor",
    displayName: PROVIDER,
    async collect(opts?: CollectOptions): Promise<ProviderResult> {
      try {
        const file = (deps.dbPath ?? cursorDbPath)();
        const auth = await readCursorAuth(file);
        const exp = decodeJwtExp(auth.accessToken);
        const windows = await withRefresh({
          allowRefresh: opts?.refresh ?? true,
          accessToken: auth.accessToken,
          expired: isExpired(exp === null ? null : exp * 1000, deps.now?.() ?? Date.now()),
          expiredMessage: "token expired — open Cursor once to refresh the session",
          refresh: auth.refreshToken ? () => refreshCursor(file, auth, deps) : undefined,
          call: async (accessToken) =>
            parseCursorUsage(
              await fetchJson(
                USAGE_URL,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                    "Connect-Protocol-Version": "1",
                  },
                  body: "{}",
                },
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

export const cursor: Provider = createCursorProvider();
