import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codexWindowLabel, parseCodexUsage } from "../../src/providers/codex/usage.js";
import { parseClaudeUsage } from "../../src/providers/claude/usage.js";
import { parseCursorUsage } from "../../src/providers/cursor/usage.js";
import {
  parseCommentedJson,
  parseCopilotUser,
  parseOrgCreditsUsed,
  parseOrgSeats,
  premiumWindow,
  teamCreditsWindow,
} from "../../src/providers/copilot/usage.js";
import { decodeJwtExp, ProviderError } from "../../src/providers/util.js";

// Masked example responses copied from docs/providers/*-usage.md.
const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

const isFormatError = (e: unknown): boolean =>
  e instanceof ProviderError && e.message.startsWith("unexpected response format");

// ---- Codex ----

test("parseCodexUsage: fixture response", () => {
  assert.deepEqual(parseCodexUsage(load("codex-usage.json")), [
    { label: "Session (5h)", percentUsed: 75, resetsAt: new Date(1790175592 * 1000), startsAt: new Date((1790175592 - 18000) * 1000) },
    { label: "Weekly", percentUsed: 12, resetsAt: new Date(1790710652 * 1000), startsAt: new Date((1790710652 - 604800) * 1000) },
  ]);
});

test("parseCodexUsage: null windows are skipped", () => {
  assert.deepEqual(parseCodexUsage({ rate_limit: { primary_window: null, secondary_window: null } }), []);
});

test("parseCodexUsage: wrong shape -> format error", () => {
  assert.throws(() => parseCodexUsage({}), isFormatError);
  assert.throws(() => parseCodexUsage("<html>"), isFormatError);
  assert.throws(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent: "75" } } }), isFormatError);
});

test("codexWindowLabel", () => {
  assert.equal(codexWindowLabel(18000, "x"), "Session (5h)");
  assert.equal(codexWindowLabel(604800, "x"), "Weekly");
  assert.equal(codexWindowLabel(86400, "x"), "1-day");
  assert.equal(codexWindowLabel(undefined, "Primary limit"), "Primary limit");
  assert.equal(codexWindowLabel(1234, "fallback"), "fallback");
});

// ---- Claude ----

test("parseClaudeUsage: fixture response uses limits[]", () => {
  assert.deepEqual(parseClaudeUsage(load("claude-usage.json")), [
    { label: "Session (5h)", percentUsed: 22, resetsAt: new Date("2026-09-23T15:50:00.667Z"), startsAt: new Date("2026-09-23T10:50:00.667Z") },
    { label: "Weekly", percentUsed: 61, resetsAt: new Date("2026-09-27T17:00:00.667Z"), startsAt: new Date("2026-09-20T17:00:00.667Z") },
  ]);
});

test("parseClaudeUsage: ISO with microseconds parses", () => {
  const [w] = parseClaudeUsage({
    limits: [{ kind: "session", percent: 5, resets_at: "2026-09-23T15:50:00.667714+00:00" }],
  });
  assert.equal(w.resetsAt?.toISOString(), "2026-09-23T15:50:00.667Z");
});

test("parseClaudeUsage: weekly_scoped uses scope.model.display_name", () => {
  const out = parseClaudeUsage({
    limits: [
      { kind: "weekly_scoped", percent: 40, resets_at: null, scope: { model: { display_name: "Opus" } } },
      { kind: "something_new", percent: 1, resets_at: null },
    ],
  });
  assert.deepEqual(out, [{ label: "Weekly (Opus)", percentUsed: 40, resetsAt: null }]);
});

test("parseClaudeUsage: falls back to flat keys, skips nulls and unknown keys", () => {
  const json = load("claude-usage.json") as Record<string, unknown>;
  delete json.limits;
  json.seven_day_opus = { utilization: 10.5, resets_at: "2026-09-27T17:00:00.667742+00:00" };
  assert.deepEqual(parseClaudeUsage(json), [
    { label: "Session (5h)", percentUsed: 22, resetsAt: new Date("2026-09-23T15:50:00.667Z"), startsAt: new Date("2026-09-23T10:50:00.667Z") },
    { label: "Weekly", percentUsed: 61, resetsAt: new Date("2026-09-27T17:00:00.667Z"), startsAt: new Date("2026-09-20T17:00:00.667Z") },
    { label: "Weekly (Opus)", percentUsed: 10.5, resetsAt: new Date("2026-09-27T17:00:00.667Z"), startsAt: new Date("2026-09-20T17:00:00.667Z") },
  ]);
});

test("parseClaudeUsage: wrong shape -> format error", () => {
  assert.throws(() => parseClaudeUsage({ foo: 1 }), isFormatError);
  assert.throws(() => parseClaudeUsage(null), isFormatError);
});

// ---- Cursor ----

test("parseCursorUsage: fixture response (0% used) -> the two meters Cursor shows", () => {
  const resetsAt = new Date(1791725341000);
  const startsAt = new Date(1789133341000);
  assert.deepEqual(parseCursorUsage(load("cursor-usage.json")), [
    { label: "Cursor Models", percentUsed: 0, resetsAt, extra: "$0.00 spent in total", startsAt },
    { label: "Other Models", percentUsed: 0, resetsAt, startsAt },
  ]);
});

test("parseCursorUsage: live values 2026-10-09 -> auto/api percentages, spend without a limit", () => {
  const out = parseCursorUsage({
    billingCycleEnd: "1791725341000",
    enabled: true,
    planUsage: {
      totalSpend: 591,
      includedSpend: 591,
      remaining: 1409,
      limit: 2000,
      autoPercentUsed: 2.123809523809524,
      apiPercentUsed: 3.6249999999999996,
      totalPercentUsed: 2.3640000000000003,
    },
  });
  assert.deepEqual(out.map((w) => [w.label, w.percentUsed, w.extra]), [
    ["Cursor Models", 2.123809523809524, "$5.91 spent in total"],
    ["Other Models", 3.6249999999999996, undefined],
  ]);
});

test("parseCursorUsage: no auto/api split -> one combined meter; spend from limit - remaining", () => {
  const out = parseCursorUsage({
    billingCycleEnd: "1791725341000",
    enabled: true,
    planUsage: { remaining: 1680, limit: 2000, totalPercentUsed: 16 },
  });
  assert.deepEqual(out, [{ label: "Monthly", percentUsed: 16, resetsAt: new Date(1791725341000), extra: "$3.20 spent" }]);
  const omitted = parseCursorUsage({ enabled: true, planUsage: { limit: 2000, remaining: 2000 } });
  assert.equal(omitted[0].percentUsed, 0);
  assert.equal(omitted[0].extra, "$0.00 spent");
  assert.equal(omitted[0].resetsAt, null);
});

test("parseCursorUsage: enabled false or missing planUsage -> error, not 0%", () => {
  assert.throws(() => parseCursorUsage({ enabled: false, planUsage: {} }), ProviderError);
  assert.throws(() => parseCursorUsage({ enabled: true }), /planUsage missing/);
});

test("parseCursorUsage: wrong shape -> format error", () => {
  assert.throws(() => parseCursorUsage([]), isFormatError);
  assert.throws(() => parseCursorUsage({ planUsage: { totalPercentUsed: "16" } }), isFormatError);
});

// ---- Copilot (verified live on a Business plan with unlimited premium requests) ----

test("parseCopilotUser: live fixture -> token-based billing, orgs, personal credits, reset", () => {
  const user = parseCopilotUser(load("copilot-usage.json"));
  assert.equal(user.tokenBasedBilling, true);
  assert.deepEqual(user.orgs, ["<REDACTED>"]);
  assert.equal(user.creditsUsed, 8190);
  assert.deepEqual(user.resetsAt, new Date("2026-10-01T00:00:00.000Z"));
});

test("premiumWindow: unlimited -> no percentage, 'no personal limit'", () => {
  const w = premiumWindow(parseCopilotUser(load("copilot-usage.json")));
  assert.equal(w.percentUsed, null);
  assert.equal(w.extra, "no personal limit");
});

test("premiumWindow: limited plan -> percent used and used/entitlement", () => {
  const user = parseCopilotUser({
    quota_reset_date_utc: "2026-10-01T00:00:00.000Z",
    quota_snapshots: { premium_interactions: { unlimited: false, percent_remaining: 52.7, entitlement: 300, remaining: 158 } },
  });
  const w = premiumWindow(user);
  assert.ok(Math.abs((w.percentUsed ?? NaN) - 47.3) < 1e-9);
  assert.equal(w.extra, "142/300");
});

test("parseCopilotUser: wrong shape -> unexpected response format", () => {
  for (const bad of [null, {}, { quota_snapshots: {} }, { quota_snapshots: { premium_interactions: {} } }]) {
    assert.throws(() => parseCopilotUser(bad), /unexpected response format/);
  }
});

test("parseOrgCreditsUsed: sums Copilot ai-units only (live-shaped fixture)", () => {
  assert.ok(Math.abs(parseOrgCreditsUsed(load("copilot-org-usage-summary.json")) - 12350) < 1e-6);
  assert.equal(parseOrgCreditsUsed({ usageItems: [] }), 0);
  assert.throws(() => parseOrgCreditsUsed({}), /unexpected response format/);
});

test("parseOrgSeats + teamCreditsWindow: 10 seats x 1900 = 19,000 pool", () => {
  const seats = parseOrgSeats(load("copilot-org-billing.json"));
  assert.equal(seats, 10);
  const w = teamCreditsWindow(12350, seats * 1900, 4120, null);
  assert.equal(w.label, "Monthly (Team)");
  assert.ok(Math.abs((w.percentUsed ?? NaN) - (12350 / 19000) * 100) < 1e-9);
  assert.equal(w.extra, "12,350/19,000 AIC, you 4,120 AIC - 33%");
});

test("parseCommentedJson: strips leading // comment lines", () => {
  assert.deepEqual(parseCommentedJson('// generated file\r\n{"lastLoggedInUser":{"login":"x"}}'), {
    lastLoggedInUser: { login: "x" },
  });
});

// ---- util ----

test("decodeJwtExp", () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  assert.equal(decodeJwtExp(`${b64({ alg: "none" })}.${b64({ exp: 1790836139 })}.sig`), 1790836139);
  assert.equal(decodeJwtExp(`${b64({ alg: "none" })}.${b64({ sub: "x" })}.sig`), null);
  assert.equal(decodeJwtExp("sk-ant-oat-not-a-jwt"), null);
  assert.equal(decodeJwtExp("a.!!!.c"), null);
});

test("teamCreditsWindow: window starts one calendar month (UTC) before the reset", () => {
  const w = teamCreditsWindow(100, 1000, null, new Date("2026-11-01T00:00:00.000Z"));
  assert.deepEqual(w.startsAt, new Date("2026-10-01T00:00:00.000Z"));
  assert.equal(teamCreditsWindow(100, 1000, null, null).startsAt, undefined);
});
