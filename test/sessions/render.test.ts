import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFolder, sameFolder } from "../../src/sessions/folders.js";
import { formatAgo, resumeLine, truncate } from "../../src/sessions/render.js";

test("formatAgo: one unit, then a date from 30 days on", () => {
  const now = new Date(2026, 9, 15, 12, 0);
  const minus = (ms: number) => new Date(now.getTime() - ms);
  assert.equal(formatAgo(minus(30_000), now), "just now");
  assert.equal(formatAgo(minus(60_000), now), "1 minute ago");
  assert.equal(formatAgo(minus(59 * 60_000), now), "59 minutes ago");
  assert.equal(formatAgo(minus(3 * 3600_000 + 5), now), "3 hours ago");
  assert.equal(formatAgo(minus(86400_000), now), "1 day ago");
  assert.equal(formatAgo(minus(29 * 86400_000), now), "29 days ago");
  assert.equal(formatAgo(new Date(2026, 7, 12, 9, 0), now), "12 Aug");
  assert.equal(formatAgo(new Date(2025, 11, 1), now), "1 Dec 2025");
  assert.equal(formatAgo(new Date(now.getTime() + 60_000), now), "just now", "clock skew is not 'in the future'");
});

test("truncate: keeps short text, cuts long text with an ellipsis", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("exactly10!", 10), "exactly10!");
  assert.equal(truncate("hello world again", 8), "hello w…");
  assert.equal(truncate("hello   world", 9), "hello…", "no spaces before the ellipsis");
});

test("resumeLine: plain for one folder, cd first for all folders (without \\\\?\\)", () => {
  const s = {
    id: "1",
    title: null,
    cwd: "\\\\?\\C:\\work\\app",
    startedAt: null,
    lastUsedAt: new Date(),
    resumeCommand: "codex resume 1",
  };
  assert.equal(resumeLine(s, false), "codex resume 1");
  assert.equal(resumeLine(s, true), 'cd "C:\\work\\app"; codex resume 1');
});

test("sameFolder on Windows: case, trailing separators, \\\\?\\ prefix, slashes", () => {
  const w = (a: string, b: string) => sameFolder(a, b, "win32");
  assert.ok(w("C:\\work\\app", "c:\\WORK\\app\\"));
  assert.ok(w("\\\\?\\C:\\work\\app", "C:\\work\\app"));
  assert.ok(w("C:/work/app", "C:\\work\\app"));
  assert.ok(w("C:\\work\\.\\app", "C:\\work\\app"));
  assert.ok(!w("C:\\work\\app", "C:\\work\\app\\sub"), "no subfolders");
  assert.ok(!w("C:\\work\\app", "C:\\work"), "no parents");
  assert.equal(normalizeFolder("C:\\", "win32"), "c:\\", "a root keeps its separator");
});

test("sameFolder on POSIX: case-sensitive, trailing slash ignored", () => {
  assert.ok(sameFolder("/home/me/app/", "/home/me/app", "linux"));
  assert.ok(!sameFolder("/home/me/App", "/home/me/app", "linux"));
  assert.equal(normalizeFolder("/", "linux"), "/");
});
