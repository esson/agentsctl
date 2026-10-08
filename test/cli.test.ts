import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli.js";
import type { Provider } from "../src/providers/types.js";

// Dispatcher only; the subcommands have their own tests (test/usage/cli.test.ts).
const now = () => new Date(2026, 8, 23, 14, 30);
let calls = 0;

const providers = (): Provider[] => [
  {
    name: "codex",
    displayName: "Codex",
    async collect() {
      calls++;
      return { provider: "Codex", ok: true, windows: [] };
    },
  },
];

test.beforeEach(() => {
  calls = 0;
});

test("no subcommand, --help and -h: command list on stdout, exit 0, nothing runs", async () => {
  for (const argv of [[], ["--help"], ["-h"]]) {
    const r = await run(argv, { providers: providers(), sessionSources: [], now });
    assert.equal(r.exitCode, 0, argv.join(" "));
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /Usage: agentsctl <command> \[options\]/);
    assert.match(r.stdout, /^ {2}usage +\S/m);
    assert.match(r.stdout, /^ {2}sessions +\S/m);
  }
  assert.equal(calls, 0);
});

test("unknown subcommand or leading option: exit 2 with help on stderr, nothing runs", async () => {
  for (const [argv, message] of [
    [["bogus"], "agentsctl: unknown command 'bogus'"],
    [["toString"], "agentsctl: unknown command 'toString'"],
    [["--json"], "agentsctl: unknown option '--json'"],
    [["--json", "usage"], "agentsctl: unknown option '--json'"],
  ] as const) {
    const r = await run([...argv], { providers: providers(), sessionSources: [], now });
    assert.equal(r.exitCode, 2, argv.join(" "));
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.startsWith(`${message}\n`), r.stderr);
    assert.match(r.stderr, /Usage: agentsctl <command>/);
  }
  assert.equal(calls, 0);
});

test("usage: runs the usage command with the remaining arguments", async () => {
  const r = await run(["usage", "--json"], { providers: providers(), sessionSources: [], now });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(JSON.parse(r.stdout), [{ provider: "Codex", ok: true, windows: [] }]);
  assert.equal(calls, 1);
});

test("usage --help: the usage command's own help", async () => {
  const r = await run(["usage", "--help"], { providers: providers(), sessionSources: [], now });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /Usage: agentsctl usage \[options\]/);
  assert.equal(calls, 0);
});
