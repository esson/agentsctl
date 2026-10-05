import { test } from "node:test";
import assert from "node:assert/strict";
import { run as runCli, type Terminal } from "../../src/cli.js";
import { selectProviders } from "../../src/usage/cli.js";
import type { CollectOptions, Provider, ProviderResult } from "../../src/providers/types.js";

// Everything here goes through the dispatcher as `agentsctl usage ...`.
const run = (argv: string[], providers: Provider[], clock: () => Date, term?: Terminal) =>
  runCli(["usage", ...argv], providers, clock, term);

// Fake providers: no network, no token files. `calls` records which ones actually ran.
const now = () => new Date(2026, 8, 23, 14, 30);
let calls: string[] = [];
let collectOpts: (CollectOptions | undefined)[] = [];

function fake(name: string, result: (display: string) => ProviderResult | Promise<ProviderResult>): Provider {
  const displayName = name[0].toUpperCase() + name.slice(1);
  return {
    name,
    displayName,
    async collect(opts?: CollectOptions) {
      calls.push(name);
      collectOpts.push(opts);
      return result(displayName);
    },
  };
}

const okProvider = (name: string) =>
  fake(name, (provider) => ({
    provider,
    ok: true,
    windows: [{ label: "5h limit", percentUsed: 25, resetsAt: new Date(Date.UTC(2026, 8, 23, 14, 59, 52)) }],
  }));
const failProvider = (name: string) => fake(name, (provider) => ({ provider, ok: false, error: "not logged in" }));
const throwProvider = (name: string) =>
  fake(name, () => {
    throw new Error("boom");
  });

const mixed = () => [okProvider("codex"), okProvider("claude"), failProvider("copilot"), failProvider("cursor")];

test.beforeEach(() => {
  calls = [];
  collectOpts = [];
});

test("no flags: full report of all providers, exit 0", async () => {
  const r = await run([], mixed(), now);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^\nAI Usage Limits — 2026-09-23 14:30\n/);
  for (const name of ["Codex", "Claude", "Copilot", "Cursor"]) assert.match(r.stdout, new RegExp(`^${name}$`, "m"));
  assert.match(r.stdout, /could not read: not logged in/);
  assert.deepEqual(calls.sort(), ["claude", "codex", "copilot", "cursor"]);
});

test("--json: list of {provider, ok, windows|error} with ISO dates", async () => {
  const r = await run(["--json"], mixed(), now);
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[0], {
    provider: "Codex",
    ok: true,
    windows: [{ label: "5h limit", percentUsed: 25, resetsAt: "2026-09-23T14:59:52.000Z" }],
  });
  assert.deepEqual(parsed[2], { provider: "Copilot", ok: false, error: "not logged in" });
});

test("--provider filters and keeps registry order", async () => {
  const r = await run(["--json", "--provider", "claude,codex"], mixed(), now);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(
    JSON.parse(r.stdout).map((x: { provider: string }) => x.provider),
    ["Codex", "Claude"],
  );
  assert.deepEqual(calls.sort(), ["claude", "codex"]);
});

test("--provider is case-insensitive and whitespace tolerant (also --provider=...)", async () => {
  const r = await run(["--json", "--provider= Codex , CLAUDE ,"], mixed(), now);
  assert.equal(r.exitCode, 0);
  assert.equal(JSON.parse(r.stdout).length, 2);
});

test("--provider unknown: error on stderr, exit 2, nothing runs", async () => {
  const r = await run(["--provider", "codex,bogus"], mixed(), now);
  assert.equal(r.exitCode, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /unknown provider: bogus\. Known providers: codex, claude, copilot, cursor/);
  assert.deepEqual(calls, []);
});

test("--provider empty list: exit 2", async () => {
  const r = await run(["--provider", " , "], mixed(), now);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /\(none given\)/);
});

test("unknown flag and positional args: exit 2 with help on stderr", async () => {
  for (const argv of [["--bogus"], ["codex"], ["--provider"]]) {
    const r = await run(argv, mixed(), now);
    assert.equal(r.exitCode, 2, argv.join(" "));
    assert.match(r.stderr, /Usage: agentsctl usage/);
    assert.deepEqual(calls, []);
  }
});

test("--help / -h: help on stdout, exit 0, nothing runs", async () => {
  for (const flag of ["--help", "-h"]) {
    const r = await run([flag], mixed(), now);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /--provider <names>.*codex, claude, copilot, cursor/);
  }
  assert.deepEqual(calls, []);
});

test("exit 1 when all selected providers fail", async () => {
  const r = await run([], [failProvider("codex"), failProvider("claude")], now);
  assert.equal(r.exitCode, 1);
  const j = await run(["--json"], [failProvider("codex")], now);
  assert.equal(j.exitCode, 1);
  assert.deepEqual(JSON.parse(j.stdout), [{ provider: "Codex", ok: false, error: "not logged in" }]);
});

test("exit depends only on the selected providers", async () => {
  assert.equal((await run(["--provider", "copilot,cursor"], mixed(), now)).exitCode, 1);
  assert.equal((await run(["--provider", "cursor,codex"], mixed(), now)).exitCode, 0);
});

test("a throwing provider becomes an error result and does not break the others", async () => {
  const r = await run(["--json"], [throwProvider("codex"), okProvider("claude")], now);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(JSON.parse(r.stdout)[0], { provider: "Codex", ok: false, error: "boom" });
  const all = await run([], [throwProvider("codex")], now);
  assert.equal(all.exitCode, 1);
  assert.match(all.stdout, /could not read: boom/);
});

test("ok provider with zero windows counts as data and renders 'no usage data'", async () => {
  const r = await run([], [fake("codex", (provider) => ({ provider, ok: true, windows: [] }))], now);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /Codex\n {3}no usage data\n\n$/);
});

test("selectProviders", () => {
  const ps = mixed();
  const sel = selectProviders("CURSOR,codex", ps);
  assert.ok(sel.ok);
  assert.deepEqual(sel.selected.map((p) => p.name), ["codex", "cursor"]);
  assert.equal(selectProviders("nope", ps).ok, false);
});

test("refresh is enabled by default and passed to every provider", async () => {
  await run(["--json"], mixed(), now);
  assert.equal(collectOpts.length, 4);
  for (const o of collectOpts) assert.deepEqual(o, { refresh: true });
});

test("--no-refresh passes { refresh: false } to every provider and is in --help", async () => {
  const r = await run(["--json", "--no-refresh"], mixed(), now);
  assert.equal(r.exitCode, 0);
  assert.equal(collectOpts.length, 4);
  for (const o of collectOpts) assert.deepEqual(o, { refresh: false });
  const h = await run(["--help"], mixed(), now);
  assert.match(h.stdout, /--no-refresh/);
});

// ---- colors ----

const tty = (env: Record<string, string | undefined> = {}) => ({ isTTY: true, env });
const pipe = (env: Record<string, string | undefined> = {}) => ({ isTTY: false, env });
const hasAnsi = (s: string) => s.includes("\x1b[");

test("color: TTY gets colors and glyphs; pipe stays plain", async () => {
  assert.ok(hasAnsi((await run([], mixed(), now, tty())).stdout));
  assert.ok((await run([], mixed(), now, tty())).stdout.includes("  Codex"));
  assert.ok(!hasAnsi((await run([], mixed(), now, pipe())).stdout));
  assert.ok(!hasAnsi((await run([], mixed(), now)).stdout), "default terminal is plain");
});

test("color: --no-color and NO_COLOR disable, FORCE_COLOR forces", async () => {
  assert.ok(!hasAnsi((await run(["--no-color"], mixed(), now, tty())).stdout));
  assert.ok(!hasAnsi((await run([], mixed(), now, tty({ NO_COLOR: "1" }))).stdout));
  assert.ok(hasAnsi((await run([], mixed(), now, pipe({ FORCE_COLOR: "1" }))).stdout));
  assert.ok(!hasAnsi((await run([], mixed(), now, tty({ FORCE_COLOR: "0" }))).stdout));
});

test("color: --json never contains escape codes", async () => {
  assert.ok(!hasAnsi((await run(["--json"], mixed(), now, tty({ FORCE_COLOR: "1" }))).stdout));
});

// ---- layout ----

test("layout: auto picks compact on a narrow TTY, wide on a pipe; --layout overrides", async () => {
  const narrow = { isTTY: true, env: { NO_COLOR: "1" }, columns: 50 };
  assert.match((await run([], mixed(), now, narrow)).stdout, /\n {3}5h limit\n/);
  assert.doesNotMatch((await run([], mixed(), now, { isTTY: false, env: {}, columns: 50 })).stdout, /\n {3}5h limit\n/);
  assert.match((await run(["--layout", "wide"], mixed(), now, narrow)).stdout, /\n {3}5h limit {2,}/);
  assert.match((await run(["--layout", "compact"], mixed(), now)).stdout, /\n {3}5h limit\n/);
});

test("layout: invalid value is a usage error", async () => {
  const r = await run(["--layout", "tall"], mixed(), now);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /--layout must be auto, wide or compact/);
});

test("selectProviders: accepts spaces too (PowerShell passes an unquoted a,b,c as 'a b c')", () => {
  const ps = mixed();
  for (const spec of ["codex copilot cursor", "codex, copilot  cursor", " codex,copilot,cursor "]) {
    const sel = selectProviders(spec, ps);
    assert.ok(sel.ok, spec);
    assert.deepEqual(sel.selected.map((p) => p.name), ["codex", "copilot", "cursor"]);
  }
});
