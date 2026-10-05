import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createCodexProvider } from "../../src/providers/codex/usage.js";
import { createClaudeProvider } from "../../src/providers/claude/usage.js";
import { createCursorProvider } from "../../src/providers/cursor/usage.js";
import { detectJsonFormat, formatJson } from "../../src/providers/refresh.js";

// Everything here uses temp dirs and a mocked fetch: no real credential file or endpoint is touched.

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const now = () => NOW;

/** Fake unsigned JWT with the given exp (epoch seconds), built at runtime. */
function jwt(exp: number, tag: string): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "none" })}.${b({ exp, tag })}.sig`;
}
const EXPIRED = Math.floor(NOW / 1000) - 3600;
const VALID = Math.floor(NOW / 1000) + 86400;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (c: Call) => { status: number; json?: unknown } | Promise<{ status: number; json?: unknown }>;

function mockFetch(handler: Handler): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = {
      url: String(input),
      headers,
      body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = await handler(call);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-"));
}

const tokenCalls = (calls: Call[]) => calls.filter((c) => c.url.includes("/oauth/token"));
const bearer = (c: Call) => c.headers.authorization?.replace(/^Bearer /, "");

const CODEX_USAGE = {
  rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1790175592 } },
};
const CLAUDE_USAGE = { limits: [{ kind: "session", percent: 20, resets_at: "2026-09-23T17:00:00Z" }] };
const CURSOR_USAGE = { enabled: true, planUsage: { totalPercentUsed: 5, limit: 2000, remaining: 1900 }, billingCycleEnd: "1791000000000" };

// ---------------------------------------------------------------- Codex

function writeCodexAuth(dir: string, access: string, refresh: string): string {
  const file = path.join(dir, "auth.json");
  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "old-id", access_token: access, refresh_token: refresh, account_id: "acc-1" },
    last_refresh: "2026-09-01T00:00:00Z",
    future_unknown_key: { nested: [1, 2, 3] },
  };
  writeFileSync(file, JSON.stringify(auth, null, 2));
  return file;
}

test("codex: expired -> refresh -> write-back -> retry success", async () => {
  const dir = tmpDir();
  try {
    const file = writeCodexAuth(dir, jwt(EXPIRED, "old"), "rt-old");
    const newAccess = jwt(VALID, "new");
    const { fetchImpl, calls } = mockFetch((c) => {
      if (c.url === "https://auth.openai.com/oauth/token") {
        return { status: 200, json: { access_token: newAccess, id_token: "new-id", refresh_token: "rt-new" } };
      }
      return bearer(c) === newAccess ? { status: 200, json: CODEX_USAGE } : { status: 401 };
    });
    const r = await createCodexProvider({ authPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, true);

    const tc = tokenCalls(calls);
    assert.equal(tc.length, 1);
    assert.deepEqual(tc[0].body, { client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token: "rt-old" });
    assert.equal(calls.filter((c) => c.url.includes("wham/usage")).length, 1, "expired token is not sent to the usage API");

    const text = readFileSync(file, "utf8");
    const saved = JSON.parse(text);
    assert.equal(saved.tokens.access_token, newAccess);
    assert.equal(saved.tokens.id_token, "new-id");
    assert.equal(saved.tokens.refresh_token, "rt-new");
    assert.equal(saved.tokens.account_id, "acc-1");
    assert.equal(saved.last_refresh, new Date(NOW).toISOString());
    assert.deepEqual(saved.future_unknown_key, { nested: [1, 2, 3] }, "unknown keys preserved");
    assert.equal(saved.OPENAI_API_KEY, null);
    assert.match(text, /^\{\n {2}"auth_mode"/, "2-space style kept");
    assert.deepEqual(readdirSync(dir), ["auth.json"], "no temp or backup files left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: 401 on a locally valid token -> refresh -> retry once", async () => {
  const dir = tmpDir();
  try {
    const file = writeCodexAuth(dir, jwt(VALID, "revoked"), "rt-old");
    const newAccess = jwt(VALID + 10, "new");
    const { fetchImpl, calls } = mockFetch((c) => {
      if (c.url.includes("/oauth/token")) return { status: 200, json: { access_token: newAccess } };
      return bearer(c) === newAccess ? { status: 200, json: CODEX_USAGE } : { status: 401 };
    });
    const r = await createCodexProvider({ authPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, true);
    assert.equal(tokenCalls(calls).length, 1);
    assert.equal(calls.length, 3); // usage 401, token, usage 200
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.tokens.access_token, newAccess);
    assert.equal(saved.tokens.refresh_token, "rt-old", "refresh token kept when none returned");
    assert.equal(saved.tokens.id_token, "old-id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: second 401 after refresh is reported, no second refresh", async () => {
  const dir = tmpDir();
  try {
    const file = writeCodexAuth(dir, jwt(VALID, "a"), "rt-old");
    const { fetchImpl, calls } = mockFetch((c) =>
      c.url.includes("/oauth/token") ? { status: 200, json: { access_token: jwt(VALID, "b") } } : { status: 401 },
    );
    const r = await createCodexProvider({ authPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /token rejected \(401\)/);
    assert.equal(tokenCalls(calls).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: CAS conflict (file changed during refresh) -> uses file's token, no overwrite", async () => {
  const dir = tmpDir();
  try {
    const file = writeCodexAuth(dir, jwt(EXPIRED, "old"), "rt-old");
    const cliAccess = jwt(VALID, "cli");
    const ours = jwt(VALID, "ours");
    let concurrent = "";
    const { fetchImpl, calls } = mockFetch((c) => {
      if (c.url.includes("/oauth/token")) {
        // The real `codex` CLI refreshes at the same moment and rotates the refresh token.
        writeCodexAuth(dir, cliAccess, "rt-cli");
        concurrent = readFileSync(file, "utf8");
        return { status: 200, json: { access_token: ours, refresh_token: "rt-ours" } };
      }
      return { status: 200, json: CODEX_USAGE };
    });
    const r = await createCodexProvider({ authPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(file, "utf8"), concurrent, "file not overwritten");
    const usage = calls.filter((c) => c.url.includes("wham/usage"));
    assert.equal(bearer(usage[0]), cliAccess, "retry uses the CLI's new token from the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: refresh failure -> clear error, file unchanged", async () => {
  const dir = tmpDir();
  try {
    const file = writeCodexAuth(dir, jwt(EXPIRED, "old"), "rt-old");
    const before = readFileSync(file, "utf8");
    const { fetchImpl } = mockFetch(() => ({ status: 400, json: { error: "invalid_grant" } }));
    const r = await createCodexProvider({ authPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.deepEqual(r, {
      provider: "Codex",
      ok: false,
      error: "token expired and refresh failed (400) — run `codex` once",
    });
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: network failure during refresh -> clear error", async () => {
  const dir = tmpDir();
  try {
    const file = writeCodexAuth(dir, jwt(EXPIRED, "old"), "rt-old");
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const r = await createCodexProvider({ authPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(!r.ok && r.error, "token expired and refresh failed (network error) — run `codex` once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: --no-refresh -> expired error, no request at all", async () => {
  const dir = tmpDir();
  try {
    const file = writeCodexAuth(dir, jwt(EXPIRED, "old"), "rt-old");
    const before = readFileSync(file, "utf8");
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: {} }));
    const r = await createCodexProvider({ authPath: () => file, fetchImpl, now }).collect({ refresh: false });
    assert.equal(!r.ok && r.error, "token expired — run `codex` once to refresh the login");
    assert.equal(calls.length, 0);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: --no-refresh + 401 -> 401 error, no token request", async () => {
  const dir = tmpDir();
  try {
    const file = writeCodexAuth(dir, jwt(VALID, "a"), "rt-old");
    const { fetchImpl, calls } = mockFetch(() => ({ status: 401 }));
    const r = await createCodexProvider({ authPath: () => file, fetchImpl, now }).collect({ refresh: false });
    assert.match(!r.ok ? r.error : "", /token rejected \(401\)/);
    assert.equal(tokenCalls(calls).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: valid token -> no refresh, file untouched", async () => {
  const dir = tmpDir();
  try {
    const file = writeCodexAuth(dir, jwt(VALID, "a"), "rt-old");
    const before = readFileSync(file, "utf8");
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: CODEX_USAGE }));
    const r = await createCodexProvider({ authPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, true);
    assert.equal(tokenCalls(calls).length, 0);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex: token within the 60 s skew counts as expired", async () => {
  const dir = tmpDir();
  try {
    const file = writeCodexAuth(dir, jwt(Math.floor(NOW / 1000) + 30, "almost"), "rt-old");
    const { fetchImpl, calls } = mockFetch((c) =>
      c.url.includes("/oauth/token") ? { status: 200, json: { access_token: jwt(VALID, "n") } } : { status: 200, json: CODEX_USAGE },
    );
    const r = await createCodexProvider({ authPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, true);
    assert.equal(tokenCalls(calls).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Claude

function writeClaudeCreds(dir: string, access: string, refresh: string, expiresAt: number): string {
  const file = path.join(dir, ".credentials.json");
  const creds = {
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt,
      refreshTokenExpiresAt: NOW + 30 * 86400_000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "pro",
      rateLimitTier: "default",
      someNewField: true,
    },
    organizationUuid: "org-1",
    mcpOAuth: { server: { token: "x" } },
  };
  writeFileSync(file, JSON.stringify(creds)); // Claude Code writes compact JSON
  return file;
}

test("claude: expired -> refresh (scopes joined) -> write-back keeps compact style + unknown keys", async () => {
  const dir = tmpDir();
  try {
    const file = writeClaudeCreds(dir, "at-old", "rt-old", NOW - 1000);
    const { fetchImpl, calls } = mockFetch((c) => {
      if (c.url === "https://platform.claude.com/v1/oauth/token") {
        return { status: 200, json: { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600, refresh_token_expires_in: 7200 } };
      }
      return bearer(c) === "at-new" ? { status: 200, json: CLAUDE_USAGE } : { status: 401 };
    });
    const r = await createClaudeProvider({ credentialsPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, true);
    const tc = tokenCalls(calls);
    assert.equal(tc.length, 1);
    assert.deepEqual(tc[0].body, {
      grant_type: "refresh_token",
      refresh_token: "rt-old",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      scope: "user:inference user:profile",
    });
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes("\n"), "compact style kept");
    const saved = JSON.parse(text);
    assert.equal(saved.claudeAiOauth.accessToken, "at-new");
    assert.equal(saved.claudeAiOauth.refreshToken, "rt-new");
    assert.equal(saved.claudeAiOauth.expiresAt, NOW + 3600_000);
    assert.equal(saved.claudeAiOauth.refreshTokenExpiresAt, NOW + 7200_000);
    assert.equal(saved.claudeAiOauth.someNewField, true);
    assert.equal(saved.claudeAiOauth.subscriptionType, "pro");
    assert.deepEqual(saved.claudeAiOauth.scopes, ["user:inference", "user:profile"]);
    assert.deepEqual(saved.mcpOAuth, { server: { token: "x" } });
    assert.equal(saved.organizationUuid, "org-1");
    assert.deepEqual(Object.keys(saved.claudeAiOauth), [
      "accessToken", "refreshToken", "expiresAt", "refreshTokenExpiresAt", "scopes", "subscriptionType", "rateLimitTier", "someNewField",
    ]);
    assert.deepEqual(readdirSync(dir), [".credentials.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude: 401 -> refresh path; refresh_token not returned keeps the old one", async () => {
  const dir = tmpDir();
  try {
    const file = writeClaudeCreds(dir, "at-old", "rt-old", NOW + 3600_000);
    const { fetchImpl, calls } = mockFetch((c) => {
      if (c.url.includes("/oauth/token")) return { status: 200, json: { access_token: "at-new", expires_in: 60 } };
      return bearer(c) === "at-new" ? { status: 200, json: CLAUDE_USAGE } : { status: 401 };
    });
    const r = await createClaudeProvider({ credentialsPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, true);
    assert.equal(tokenCalls(calls).length, 1);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.claudeAiOauth.accessToken, "at-new");
    assert.equal(saved.claudeAiOauth.refreshToken, "rt-old");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude: CAS conflict -> Claude Code's token is used, file not overwritten", async () => {
  const dir = tmpDir();
  try {
    const file = writeClaudeCreds(dir, "at-old", "rt-old", NOW - 1000);
    let concurrent = "";
    const { fetchImpl, calls } = mockFetch((c) => {
      if (c.url.includes("/oauth/token")) {
        writeClaudeCreds(dir, "at-cli", "rt-cli", NOW + 3600_000);
        concurrent = readFileSync(file, "utf8");
        return { status: 200, json: { access_token: "at-ours", refresh_token: "rt-ours", expires_in: 3600 } };
      }
      return { status: 200, json: CLAUDE_USAGE };
    });
    const r = await createClaudeProvider({ credentialsPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(file, "utf8"), concurrent);
    assert.equal(bearer(calls.find((c) => c.url.includes("oauth/usage"))!), "at-cli");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude: refresh failure -> clear error", async () => {
  const dir = tmpDir();
  try {
    const file = writeClaudeCreds(dir, "at-old", "rt-old", NOW - 1000);
    const { fetchImpl } = mockFetch(() => ({ status: 401, json: { error: "invalid_grant" } }));
    const r = await createClaudeProvider({ credentialsPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(!r.ok && r.error, "token expired and refresh failed (401) — run `claude` once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude: --no-refresh -> no fetch at all", async () => {
  const dir = tmpDir();
  try {
    const file = writeClaudeCreds(dir, "at-old", "rt-old", NOW - 1000);
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: {} }));
    const r = await createClaudeProvider({ credentialsPath: () => file, fetchImpl, now }).collect({ refresh: false });
    assert.equal(!r.ok && r.error, "token expired — run `claude` once to refresh the login");
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Cursor

function makeCursorDb(dir: string, access: string, refresh: string): string {
  const file = path.join(dir, "state.vscdb");
  const db = new Database(file);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const ins = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  ins.run("cursorAuth/accessToken", access);
  ins.run("cursorAuth/refreshToken", refresh);
  ins.run("cursorAuth/cachedSignUpType", "Auth_0");
  db.close();
  return file;
}

function readCursorDb(file: string): Record<string, unknown> {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db.prepare("SELECT key, value FROM ItemTable").all() as { key: string; value: unknown }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }
}

test("cursor: expired -> refresh (x-cursor-client-type) -> SQLite write-back -> retry", async () => {
  const dir = tmpDir();
  try {
    const oldTok = jwt(EXPIRED, "old");
    const newTok = jwt(VALID, "new");
    const file = makeCursorDb(dir, oldTok, oldTok);
    const { fetchImpl, calls } = mockFetch((c) => {
      if (c.url === "https://api2.cursor.sh/oauth/token") return { status: 200, json: { access_token: newTok, shouldLogout: false } };
      return bearer(c) === newTok ? { status: 200, json: CURSOR_USAGE } : { status: 401 };
    });
    const r = await createCursorProvider({ dbPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, true);
    const tc = tokenCalls(calls);
    assert.equal(tc.length, 1);
    assert.deepEqual(tc[0].body, { grant_type: "refresh_token", client_id: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB", refresh_token: oldTok });
    assert.equal(tc[0].headers["x-cursor-client-type"], "ide");
    assert.deepEqual(readCursorDb(file), {
      "cursorAuth/accessToken": newTok,
      "cursorAuth/refreshToken": newTok, // Cursor stores the new access token as refresh token too
      "cursorAuth/cachedSignUpType": "Auth_0",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cursor: 401 -> refresh; returned refresh_token is stored", async () => {
  const dir = tmpDir();
  try {
    const file = makeCursorDb(dir, jwt(VALID, "a"), "rt-old");
    const newTok = jwt(VALID, "b");
    const { fetchImpl } = mockFetch((c) => {
      if (c.url.includes("/oauth/token")) return { status: 200, json: { access_token: newTok, refresh_token: "rt-new" } };
      return bearer(c) === newTok ? { status: 200, json: CURSOR_USAGE } : { status: 401 };
    });
    const r = await createCursorProvider({ dbPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, true);
    const rows = readCursorDb(file);
    assert.equal(rows["cursorAuth/accessToken"], newTok);
    assert.equal(rows["cursorAuth/refreshToken"], "rt-new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cursor: CAS conflict -> Cursor's own token is used, DB not overwritten", async () => {
  const dir = tmpDir();
  try {
    const file = makeCursorDb(dir, jwt(EXPIRED, "old"), "rt-old");
    const cursorTok = jwt(VALID, "cursor-app");
    const { fetchImpl, calls } = mockFetch((c) => {
      if (c.url.includes("/oauth/token")) {
        const db = new Database(file);
        db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(cursorTok, "cursorAuth/accessToken");
        db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run("rt-cursor", "cursorAuth/refreshToken");
        db.close();
        return { status: 200, json: { access_token: jwt(VALID, "ours") } };
      }
      return { status: 200, json: CURSOR_USAGE };
    });
    const r = await createCursorProvider({ dbPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(r.ok, true);
    const rows = readCursorDb(file);
    assert.equal(rows["cursorAuth/accessToken"], cursorTok);
    assert.equal(rows["cursorAuth/refreshToken"], "rt-cursor");
    assert.equal(bearer(calls.find((c) => c.url.includes("GetCurrentPeriodUsage"))!), cursorTok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cursor: DB locked -> no write, new token used in memory", async () => {
  const dir = tmpDir();
  try {
    const oldTok = jwt(EXPIRED, "old");
    const file = makeCursorDb(dir, oldTok, "rt-old");
    const newTok = jwt(VALID, "new");
    const locker = new Database(file);
    try {
      const { fetchImpl, calls } = mockFetch((c) => {
        if (c.url.includes("/oauth/token")) {
          locker.exec("BEGIN EXCLUSIVE"); // Cursor holding a write lock
          return { status: 200, json: { access_token: newTok } };
        }
        return bearer(c) === newTok ? { status: 200, json: CURSOR_USAGE } : { status: 401 };
      });
      const r = await createCursorProvider({ dbPath: () => file, fetchImpl, now }).collect({ refresh: true });
      assert.equal(r.ok, true);
      assert.equal(calls.length, 2);
    } finally {
      if (locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
    }
    assert.equal(readCursorDb(file)["cursorAuth/accessToken"], oldTok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cursor: shouldLogout -> refresh failed error, DB unchanged", async () => {
  const dir = tmpDir();
  try {
    const oldTok = jwt(EXPIRED, "old");
    const file = makeCursorDb(dir, oldTok, "rt-old");
    const { fetchImpl } = mockFetch(() => ({ status: 200, json: { access_token: "x", shouldLogout: true } }));
    const r = await createCursorProvider({ dbPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(!r.ok && r.error, "token expired and refresh failed (shouldLogout) — sign in to Cursor again");
    assert.equal(readCursorDb(file)["cursorAuth/accessToken"], oldTok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cursor: refresh HTTP failure -> clear error", async () => {
  const dir = tmpDir();
  try {
    const file = makeCursorDb(dir, jwt(EXPIRED, "old"), "rt-old");
    const { fetchImpl } = mockFetch(() => ({ status: 500 }));
    const r = await createCursorProvider({ dbPath: () => file, fetchImpl, now }).collect({ refresh: true });
    assert.equal(!r.ok && r.error, "token expired and refresh failed (500) — sign in to Cursor again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cursor: --no-refresh -> no fetch, DB unchanged", async () => {
  const dir = tmpDir();
  try {
    const oldTok = jwt(EXPIRED, "old");
    const file = makeCursorDb(dir, oldTok, "rt-old");
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: {} }));
    const r = await createCursorProvider({ dbPath: () => file, fetchImpl, now }).collect({ refresh: false });
    assert.equal(!r.ok && r.error, "token expired — open Cursor once to refresh the session");
    assert.equal(calls.length, 0);
    assert.equal(readCursorDb(file)["cursorAuth/accessToken"], oldTok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- JSON format helpers

test("detectJsonFormat/formatJson round-trip styles", () => {
  const v = { a: 1, b: { c: [1, 2] } };
  for (const text of [
    JSON.stringify(v),
    JSON.stringify(v, null, 2),
    JSON.stringify(v, null, 4) + "\n",
    JSON.stringify(v, null, "\t"),
    JSON.stringify(v, null, 2).replace(/\n/g, "\r\n") + "\r\n",
    "﻿" + JSON.stringify(v, null, 2),
  ]) {
    assert.equal(formatJson(v, detectJsonFormat(text)), text);
  }
});
