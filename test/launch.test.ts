import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandLine, quoteArg, runAttached } from "../src/launch.js";

test("quoteArg: plain ids and paths as they are, others quoted for cmd.exe or sh", () => {
  assert.equal(quoteArg("01a1f2c3-4d5e", "win32"), "01a1f2c3-4d5e");
  assert.equal(quoteArg("C:\\work\\app.sln", "win32"), "C:\\work\\app.sln");
  assert.equal(quoteArg("C:\\My Work\\app.sln", "win32"), '"C:\\My Work\\app.sln"');
  assert.equal(quoteArg("", "win32"), '""', "start's empty window title");
  assert.equal(quoteArg("a&b", "win32"), '"a&b"');
  assert.equal(quoteArg("/home/me/my app", "linux"), "'/home/me/my app'");
  assert.equal(quoteArg("it's", "linux"), "'it'\\''s'");
});

test("commandLine: start with an empty title and a solution path", () => {
  assert.equal(commandLine(["start", "", "C:\\My Work\\App.sln"], "win32"), 'start "" "C:\\My Work\\App.sln"');
  assert.equal(commandLine(["claude", "--resume", "79f8ccaa"], "linux"), "claude --resume 79f8ccaa");
});

test("runAttached: runs in the given folder and returns the exit code", async () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-")));
  const script = path.join(dir, "probe.cjs");
  writeFileSync(script, 'require("fs").writeFileSync("cwd.txt", process.cwd()); process.exit(7);');
  const code = await runAttached([process.execPath, script], dir);
  assert.equal(code, 7);
  assert.equal(readFileSync(path.join(dir, "cwd.txt"), "utf8").toLowerCase(), dir.toLowerCase());
});
