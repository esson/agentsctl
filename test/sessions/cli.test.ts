import { test } from "node:test";
import assert from "node:assert/strict";
import { run, type Terminal } from "../../src/cli.js";
import type { ListOptions, Session, SessionResult, SessionSource } from "../../src/sessions/types.js";

// Fake sources: no files. `calls` records each list() call with its options.
const now = () => new Date(2026, 9, 15, 12, 0);
const HERE = "C:\\work\\app";
let calls: { name: string; opts: ListOptions }[] = [];

const ago = (minutes: number) => new Date(now().getTime() - minutes * 60000);

function session(id: string, minutesAgo: number, extra: Partial<Session> = {}): Session {
  return {
    id,
    title: `Title ${id}`,
    cwd: HERE,
    startedAt: ago(minutesAgo + 30),
    lastUsedAt: ago(minutesAgo),
    resumeCommand: `tool --resume ${id}`,
    client: "cli",
    ...extra,
  };
}

function fake(name: string, result: (display: string) => SessionResult | Promise<SessionResult>): SessionSource {
  const displayName = name[0].toUpperCase() + name.slice(1);
  return {
    name,
    displayName,
    async list(opts: ListOptions) {
      calls.push({ name, opts });
      return result(displayName);
    },
  };
}

const withSessions = (name: string, sessions: Session[]) => fake(name, (provider) => ({ provider, ok: true, sessions }));
const failing = (name: string) => fake(name, (provider) => ({ provider, ok: false, error: "store unreadable" }));

const sources = () => [
  withSessions("claude", [session("c-old", 600), session("c-new", 5)]),
  withSessions("codex", [session("x-mid", 120)]),
];

const sessions = (argv: string[], srcs: SessionSource[], term?: Terminal) =>
  run(["sessions", ...argv], { providers: [], sessionSources: srcs, now, cwd: HERE }, term);

test.beforeEach(() => {
  calls = [];
});

test("default: current folder only, all agents merged, newest first", async () => {
  const r = await sessions([], sources());
  assert.equal(r.exitCode, 0);
  assert.equal(r.stderr, "");
  assert.deepEqual(calls.map((c) => c.opts), [{ cwd: HERE }, { cwd: HERE }]);
  assert.match(r.stdout, /^\nSessions in C:\\work\\app\n\n/);
  const order = [...r.stdout.matchAll(/--resume (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(order, ["c-new", "x-mid", "c-old"]);
  assert.match(r.stdout, /^Claude {3}Title c-new {3}5 minutes ago {3}CLI\n {9}tool --resume c-new$/m);
  assert.match(r.stdout, /^Codex {4}Title x-mid {3}2 hours ago {5}CLI$/m);
});

test("--all: no folder filter, resume lines start with cd, limited to 10 by default", async () => {
  const many = Array.from({ length: 25 }, (_, i) => session(`s${i}`, i, { cwd: `C:\\p${i}` }));
  const r = await sessions(["--all"], [withSessions("claude", many)]);
  assert.deepEqual(calls[0].opts, { cwd: undefined });
  assert.match(r.stdout, /^\nSessions in all folders\n/);
  assert.match(r.stdout, /^ +cd "C:\\p0"; tool --resume s0$/m);
  assert.equal([...r.stdout.matchAll(/--resume/g)].length, 10);
  assert.match(r.stdout, /15 older sessions not shown \(use --limit to show more\)/);
});

test("--pager: marks the output as pageable and lifts the --all limit; off by default", async () => {
  const many = Array.from({ length: 25 }, (_, i) => session(`s${i}`, i, { cwd: `C:\\p${i}` }));
  const paged = await sessions(["--all", "--pager"], [withSessions("claude", many)]);
  assert.equal(paged.page, true);
  assert.equal([...paged.stdout.matchAll(/--resume/g)].length, 25);
  const limited = await sessions(["--all", "--pager", "--limit", "3"], [withSessions("claude", many)]);
  assert.equal([...limited.stdout.matchAll(/--resume/g)].length, 3);
  assert.equal((await sessions(["--all"], [withSessions("claude", many)])).page, undefined);
});

test("--limit: caps the list and validates its value", async () => {
  const r = await sessions(["--limit", "2"], sources());
  assert.equal([...r.stdout.matchAll(/--resume/g)].length, 2);
  assert.match(r.stdout, /1 older session not shown/);
  for (const bad of ["0", "-1", "2.5", "x"]) {
    const e = await sessions([`--limit=${bad}`], sources());
    assert.equal(e.exitCode, 2, bad);
    assert.match(e.stderr, /--limit must be a positive whole number/);
  }
});

test("--provider: only the listed agents run", async () => {
  const r = await sessions(["--provider", "CODEX"], sources());
  assert.equal(r.exitCode, 0);
  assert.deepEqual(calls.map((c) => c.name), ["codex"]);
  const bad = await sessions(["--provider", "bogus"], sources());
  assert.equal(bad.exitCode, 2);
  assert.match(bad.stderr, /unknown provider: bogus\. Known providers: claude, codex/);
});

test("no sessions: a message, exit 0", async () => {
  const r = await sessions([], [withSessions("claude", [])]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /\nNo sessions found\.\n/);
});

test("an unreadable agent is reported and does not hide the others; all failing exits 1", async () => {
  const r = await sessions([], [failing("claude"), ...sources().slice(1)]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /tool --resume x-mid/);
  assert.match(r.stdout, /^Claude {3}could not read: store unreadable$/m);
  const all = await sessions([], [failing("claude")]);
  assert.equal(all.exitCode, 1);
  assert.match(all.stdout, /No sessions could be read\./);
  const thrown = await sessions([], [fake("claude", () => Promise.reject(new Error("boom")))]);
  assert.match(thrown.stdout, /could not read: boom/);
});

test("untitled sessions and long titles", async () => {
  const long = "x".repeat(80);
  const r = await sessions([], [withSessions("claude", [session("a", 1, { title: null }), session("b", 2, { title: long })])]);
  assert.match(r.stdout, /\(untitled\)/);
  assert.match(r.stdout, new RegExp(`x{59}… {3}2 minutes ago`));
  const narrow = await sessions([], [withSessions("claude", [session("b", 2, { title: long })])], {
    isTTY: true,
    env: { NO_COLOR: "1" },
    columns: 56,
  });
  // 56 columns - "Claude" - "CLI" - "2 minutes ago" - three gaps = 25 characters of title.
  assert.match(narrow.stdout, /^Claude {3}x{24}… {3}2 minutes ago {3}CLI$/m);
});

test("client column: last, for every session; Unknown when not known", async () => {
  const r = await sessions(
    [],
    [
      withSessions("codex", [
        session("cli", 5),
        session("app", 120, { client: "desktop" }),
        session("vsc", 200, { client: "vscode" }),
        session("old", 300, { client: undefined }),
        session("vis", 400, { client: "visual-studio" }),
      ]),
    ],
  );
  assert.match(r.stdout, /^Codex {3}Title cli {3}5 minutes ago {3}CLI$/m);
  assert.match(r.stdout, /^Codex {3}Title app {3}2 hours ago {5}Desktop App$/m);
  assert.match(r.stdout, /^Codex {3}Title vsc {3}3 hours ago {5}VS Code$/m);
  assert.match(r.stdout, /^Codex {3}Title old {3}5 hours ago {5}Unknown$/m);
  assert.match(r.stdout, /^Codex {3}Title vis {3}6 hours ago {5}Visual Studio$/m);
  assert.match(r.stdout, /^ {8}tool --resume cli$/m, "the resume line stays under the title");
});

test("--json: sessions and errors, ISO dates, optional fields only when known", async () => {
  const srcs = [
    withSessions("claude", [session("a", 1, { branch: "main", model: "m1", client: "desktop" }), session("b", 2, { startedAt: null, client: undefined })]),
    failing("codex"),
  ];
  const r = await sessions(["--json"], srcs);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed.sessions[0], {
    provider: "Claude",
    id: "a",
    title: "Title a",
    cwd: HERE,
    startedAt: ago(31).toISOString(),
    lastUsedAt: ago(1).toISOString(),
    resumeCommand: "tool --resume a",
    client: "desktop",
    branch: "main",
    model: "m1",
  });
  assert.equal(parsed.sessions[1].startedAt, null);
  assert.equal("branch" in parsed.sessions[1], false);
  assert.equal(parsed.sessions[1].client, null, "unknown client is null");
  assert.deepEqual(parsed.errors, [{ provider: "Codex", error: "store unreadable" }]);
});

test("color: TTY gets colors, pipe and --no-color stay plain", async () => {
  const tty = { isTTY: true, env: {} };
  assert.ok((await sessions([], sources(), tty)).stdout.includes("\x1b["));
  assert.ok(!(await sessions(["--no-color"], sources(), tty)).stdout.includes("\x1b["));
  assert.ok(!(await sessions([], sources())).stdout.includes("\x1b["));
});

test("--help, unknown flags and positional args", async () => {
  const h = await sessions(["--help"], sources());
  assert.equal(h.exitCode, 0);
  assert.match(h.stdout, /Usage: agentsctl sessions \[options\]/);
  assert.match(h.stdout, /--provider <names> .*\(claude, codex\)/);
  for (const argv of [["--bogus"], ["extra"]]) {
    const r = await sessions(argv, sources());
    assert.equal(r.exitCode, 2, argv.join(" "));
    assert.match(r.stderr, /^agentsctl sessions: /);
  }
  assert.deepEqual(calls, []);
});
