import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../../src/cli.js";
import type { ListOptions, Session, SessionResult, SessionSource } from "../../src/sessions/types.js";

// Fake sources: no files. `calls` records each list() call with its options.
let calls: ListOptions[] = [];

function session(id: string, cwd: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    title: `Title ${id}`,
    cwd,
    startedAt: null,
    lastUsedAt: new Date(2026, 9, 15, 12, 0),
    resumeCommand: `tool --resume ${id}`,
    resumeArgv: ["tool", "--resume", id],
    client: "cli",
    ...extra,
  };
}

function source(name: string, result: SessionResult): SessionSource {
  return {
    name: name.toLowerCase(),
    displayName: name,
    async list(opts: ListOptions) {
      calls.push(opts);
      return result;
    },
  };
}

const sources = () => [
  source("Claude", {
    provider: "Claude",
    ok: true,
    sessions: [session("79f8ccaa-3abb", "C:\\work\\app"), session("79f1d2e3-0000", "C:\\work\\lib")],
  }),
  source("Codex", { provider: "Codex", ok: true, sessions: [session("01a1f2c3", "\\\\?\\C:\\work\\docs")] }),
];

const resume = (argv: string[], srcs: SessionSource[] = sources()) =>
  run(["resume", ...argv], { providers: [], sessionSources: srcs, cwd: "C:\\elsewhere" });

test.beforeEach(() => {
  calls = [];
});

test("resume: finds the session in every folder and describes the command to run in its folder", async () => {
  const r = await resume(["79f8ccaa-3abb"]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "");
  assert.deepEqual(calls, [{}, {}], "all folders, every agent");
  assert.deepEqual(r.exec, { argv: ["tool", "--resume", "79f8ccaa-3abb"], cwd: "C:\\work\\app" });
  assert.equal(r.stderr, 'Resuming Claude session "Title 79f8ccaa-3abb" in C:\\work\\app\n> cd "C:\\work\\app"; tool --resume 79f8ccaa-3abb\n');
});

test("resume: a unique prefix is enough, case-insensitive; the \\\\?\\ prefix is dropped from the folder", async () => {
  const r = await resume(["01A1"]);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.exec, { argv: ["tool", "--resume", "01a1f2c3"], cwd: "C:\\work\\docs" });
});

test("resume: an ambiguous prefix lists the matches and runs nothing", async () => {
  const r = await resume(["79f"]);
  assert.equal(r.exitCode, 2);
  assert.equal(r.exec, undefined);
  assert.match(r.stderr, /'79f' matches 2 sessions; give more of the id:/);
  assert.match(r.stderr, /^ {2}79f8ccaa-3abb {3}Claude session "Title 79f8ccaa-3abb" in C:\\work\\app$/m);
  assert.match(r.stderr, /^ {2}79f1d2e3-0000 {3}Claude session "Title 79f1d2e3-0000" in C:\\work\\lib$/m);
});

test("resume: a long list of matches is cut at 10, long titles are shortened", async () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    session(`aa${String(i).padStart(2, "0")}`, "C:\\a", { title: "x".repeat(80), lastUsedAt: new Date(2026, 9, 15, 12, i) }),
  );
  const r = await resume(["aa"], [source("Codex", { provider: "Codex", ok: true, sessions: many })]);
  assert.equal(r.exitCode, 2);
  const ids = [...r.stderr.matchAll(/^ {2}(aa\d\d) /gm)].map((m) => m[1]);
  assert.deepEqual(ids, ["aa02", "aa03", "aa04", "aa05", "aa06", "aa07", "aa08", "aa09", "aa10", "aa11"], "the 10 newest, newest last");
  assert.match(r.stderr, /:\n {2}… 2 older not shown\n {2}aa02 /);
  assert.match(r.stderr, /"x{49}…"/);
});

test("resume: an exact id wins over longer ids that start with it", async () => {
  const srcs = [source("Cursor", { provider: "Cursor", ok: true, sessions: [session("abc", "C:\\a"), session("abcd", "C:\\b")] })];
  const r = await resume(["abc"], srcs);
  assert.equal(r.exitCode, 0);
  assert.equal(r.exec?.cwd, "C:\\a");
});

test("resume: --dry-run prints the cd and resume line instead of running it", async () => {
  const r = await resume(["79f8ccaa-3abb", "--dry-run"]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.exec, undefined);
  assert.equal(r.stdout, 'cd "C:\\work\\app"; tool --resume 79f8ccaa-3abb\n');
});

test("resume: unknown id exits 1 and mentions agents that could not be read", async () => {
  const srcs = [...sources(), source("Copilot", { provider: "Copilot", ok: false, error: "store unreadable" })];
  const r = await resume(["nope"], srcs);
  assert.equal(r.exitCode, 1);
  assert.equal(r.exec, undefined);
  assert.equal(r.stderr, "agentsctl resume: no session with id 'nope'\nCopilot could not be read: store unreadable\n");
});

test("resume: usage errors and help", async () => {
  for (const argv of [[], ["a", "b"], ["--bogus", "a"]]) {
    const r = await resume(argv);
    assert.equal(r.exitCode, 2, argv.join(" "));
    assert.match(r.stderr, /^agentsctl resume: /);
  }
  const help = await resume(["--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /^Usage: agentsctl resume <id> \[options\]$/m);
  assert.equal(calls.length, 0, "no store is read for usage errors or help");
});

test("the top-level help lists resume", async () => {
  const r = await run([], { providers: [], sessionSources: [] });
  assert.match(r.stdout, /^ {2}resume +Resume a saved session by its id/m);
});
