import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { codexClient, createCodexSessions, threadToSession, type ThreadRow } from "../../src/providers/codex/sessions.js";

// The `threads` table is built with the columns seen in a real state_5.sqlite (Codex CLI 0.162)
// (docs/providers/codex-sessions.md), in temp folders. The real store is never read.

const row = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "t1",
  cwd: "\\\\?\\C:\\work\\app",
  name: "Fix the build",
  title: "Why does the build fail?\nmore detail",
  created_at_ms: Date.parse("2026-10-12T08:00:00Z"),
  updated_at_ms: Date.parse("2026-10-12T09:00:00Z"),
  git_branch: "main",
  model: "gpt-6-sol",
  source: "cli",
  originator: "codex-tui",
  ...over,
});

test("threadToSession: name, times, folder as stored, branch, model and resume command", () => {
  assert.deepEqual(threadToSession(row()), {
    id: "t1",
    title: "Fix the build",
    cwd: "\\\\?\\C:\\work\\app",
    startedAt: new Date("2026-10-12T08:00:00Z"),
    lastUsedAt: new Date("2026-10-12T09:00:00Z"),
    resumeCommand: "codex resume t1",
    branch: "main",
    model: "gpt-6-sol",
    client: "cli",
  });
});

test("codexClient: from the originator, else from the source; vscode without originator is unknown", () => {
  assert.equal(codexClient("vscode", "codex-tui"), "cli");
  assert.equal(codexClient("vscode", "Codex Desktop"), "desktop");
  assert.equal(codexClient("vscode", "codex_work_desktop"), "desktop");
  assert.equal(codexClient("vscode", "codex_vscode"), "vscode");
  assert.equal(codexClient("cli", null), "cli");
  assert.equal(codexClient("vscode", null), undefined);
  assert.equal("client" in (threadToSession(row({ source: "vscode", originator: null })) ?? {}), false);
});

test("threadToSession: first prompt line until the thread is named; no folder or time -> null", () => {
  assert.equal(threadToSession(row({ name: null }))?.title, "Why does the build fail?");
  assert.equal(threadToSession(row({ name: "  ", title: "" }))?.title, null);
  assert.equal(threadToSession(row({ updated_at_ms: null }))?.lastUsedAt.toISOString(), "2026-10-12T08:00:00.000Z");
  assert.equal(threadToSession(row({ cwd: null })), null);
  assert.equal(threadToSession(row({ created_at_ms: null, updated_at_ms: null })), null);
  const bare = threadToSession(row({ git_branch: null, model: null }));
  assert.ok(bare && !("branch" in bare) && !("model" in bare));
});

// ---- list() against a temp Codex home

const SCHEMA = `CREATE TABLE threads (
  id TEXT PRIMARY KEY, rollout_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
  source TEXT, thread_source TEXT, cwd TEXT, title TEXT, name TEXT, first_user_message TEXT,
  archived INTEGER, git_branch TEXT, model TEXT, originator TEXT)`;

function codexHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-"));
  const db = new Database(path.join(home, "state_5.sqlite"));
  db.exec(SCHEMA);
  const insert = db.prepare(`INSERT INTO threads (id, created_at_ms, updated_at_ms, source, thread_source, cwd,
    title, name, first_user_message, archived) VALUES (?, 1, ?, ?, ?, ?, 'hi', ?, ?, ?)`);
  const app = "\\\\?\\C:\\work\\app";
  insert.run("cli", 2, "cli", "user", app, "CLI session", "hi", 0);
  insert.run("vscode", 3, "vscode", "user", app, "IDE session", "hi", 0);
  insert.run("archived", 4, "cli", "user", app, "Archived", "hi", 1);
  insert.run("empty", 5, "cli", "user", app, null, "", 0);
  insert.run("guardian", 6, '{"subagent":{"other":"guardian"}}', "guardian_review", app, "Guardian", "hi", 0);
  insert.run("spawned", 7, '{"subagent":{"thread_spawn":{}}}', "subagent", app, "Subagent", "hi", 0);
  insert.run("sub", 8, "cli", "user", `${app}\\sub`, "Subfolder", "hi", 0);
  db.prepare(`INSERT INTO threads (id, updated_at_ms, source, cwd, first_user_message, archived, originator)
    VALUES ('desktop', 10, 'vscode', ?, 'hi', 0, 'Codex Desktop')`).run(app);
  insert.run("wsl", 9, "cli", "user", "\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me", "WSL", "hi", 0);
  db.close();
  return home;
}

test("list: interactive, unarchived sessions with a prompt, exact folder only", async () => {
  const r = await createCodexSessions({ codexHome: codexHome() }).list({ cwd: "c:\\WORK\\app\\" });
  assert.ok(r.ok);
  assert.equal(r.provider, "Codex");
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["cli", "desktop", "vscode"]);
  assert.deepEqual(Object.fromEntries(r.sessions.map((s) => [s.id, s.client])), { cli: "cli", desktop: "desktop", vscode: undefined });
});

test("list: every folder when cwd is undefined; \\\\?\\UNC\\ folders match their \\\\host form", async () => {
  const source = createCodexSessions({ codexHome: codexHome() });
  const all = await source.list({});
  assert.ok(all.ok);
  assert.deepEqual(all.sessions.map((s) => s.id).sort(), ["cli", "desktop", "sub", "vscode", "wsl"]);
  const wsl = await source.list({ cwd: "\\\\wsl.localhost\\Ubuntu\\home\\me" });
  assert.ok(wsl.ok);
  assert.deepEqual(wsl.sessions.map((s) => s.id), ["wsl"]);
});

test("list: the newest state_<N>.sqlite is read", async () => {
  const home = codexHome();
  const db = new Database(path.join(home, "state_12.sqlite"));
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO threads (id, updated_at_ms, source, cwd, first_user_message, archived)
    VALUES ('newer', 1, 'cli', 'C:\\work\\app', 'hi', 0)`).run();
  db.close();
  const r = await createCodexSessions({ codexHome: home }).list({});
  assert.ok(r.ok);
  assert.deepEqual(r.sessions.map((s) => s.id), ["newer"]);
});

test("list: no Codex home or no state database -> no sessions, no error", async () => {
  const missing = await createCodexSessions({ codexHome: path.join(os.tmpdir(), "agentsctl-missing-dir") }).list({});
  assert.deepEqual(missing, { provider: "Codex", ok: true, sessions: [] });
  const home = mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-"));
  writeFileSync(path.join(home, "logs_2.sqlite"), "");
  assert.deepEqual(await createCodexSessions({ codexHome: home }).list({}), { provider: "Codex", ok: true, sessions: [] });
});

test("list: an unreadable database is reported as an error", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-"));
  writeFileSync(path.join(home, "state_5.sqlite"), "not a database");
  const r = await createCodexSessions({ codexHome: home }).list({});
  assert.equal(r.ok, false);
});
