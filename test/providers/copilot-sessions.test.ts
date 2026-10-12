import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createCopilotSessions, parseCopilotSession, parseWorkspaceYaml } from "../../src/providers/copilot/sessions.js";

// workspace.yaml and events.jsonl are built from the shapes seen in real Copilot CLI 1.0.98 files
// (docs/providers/copilot-sessions.md), written to temp folders. The real store is never read.

const jsonl = (...records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const start = (ts: string) => ({ type: "session.start", timestamp: ts, data: { context: { cwd: "C:\\work\\app" } } });
const ask = (ts: string, content: string) => ({ type: "user.message", timestamp: ts, data: { content } });
const modelChange = (ts: string, newModel: string) => ({ type: "session.model_change", timestamp: ts, data: { newModel } });
const reply = (ts: string) => ({ type: "assistant.message", timestamp: ts, data: { content: "ok" } });

const WS = {
  id: "s1",
  cwd: "C:\\work\\app",
  branch: "main",
  client_name: "github/cli",
  name: "Fix the build",
  created_at: "2026-10-12T08:00:00.000Z",
  updated_at: "2026-10-12T08:05:00.000Z",
};

test("parseWorkspaceYaml: plain, quoted and block scalars", () => {
  const ws = parseWorkspaceYaml(
    [
      "id: s1",
      "cwd: C:\\work\\app",
      'name: "Fix: the \\"build\\""',
      "branch: 'it''s'",
      "summary: |-",
      "  # Heading",
      "",
      "  second line",
      "user_named: false",
      "empty:",
      "",
    ].join("\r\n"),
  );
  assert.deepEqual(ws, {
    id: "s1",
    cwd: "C:\\work\\app",
    name: 'Fix: the "build"',
    branch: "it's",
    summary: "# Heading\n\nsecond line",
    user_named: "false",
    empty: "",
  });
});

test("parse: title, times, folder, branch, latest model and resume command", () => {
  const events = jsonl(
    start("2026-10-12T08:00:00Z"),
    modelChange("2026-10-12T08:00:01Z", "claude-sonnet-5.5"),
    ask("2026-10-12T08:00:02Z", "Why does it fail?"),
    reply("2026-10-12T08:01:00Z"),
    modelChange("2026-10-12T09:00:00Z", "gpt-6-sol"),
    { type: "session.shutdown", timestamp: "2026-10-14T10:00:00Z", data: {} },
  );
  assert.deepEqual(parseCopilotSession("s1", WS, events), {
    id: "s1",
    title: "Fix the build",
    cwd: "C:\\work\\app",
    startedAt: new Date("2026-10-12T08:00:00Z"),
    lastUsedAt: new Date("2026-10-14T10:00:00Z"),
    resumeCommand: "copilot --resume s1",
    resumeArgv: ["copilot", "--resume", "s1"],
    branch: "main",
    model: "gpt-6-sol",
    client: "cli",
  });
});

test("parse: title falls back to the older summary field, then the first prompt", () => {
  const events = jsonl(start("2026-10-12T08:00:00Z"), ask("2026-10-12T08:00:02Z", "  Explain this\nmore"));
  const { name: _, ...unnamed } = WS;
  assert.equal(parseCopilotSession("s1", { ...unnamed, summary: "Old summary" }, events)?.title, "Old summary");
  assert.equal(parseCopilotSession("s1", unnamed, events)?.title, "Explain this");
});

test("parse: no user message or no folder -> not a session; partial last line tolerated", () => {
  assert.equal(parseCopilotSession("s1", WS, jsonl(start("2026-10-12T08:00:00Z"))), null);
  const { cwd: _, ...noCwd } = WS;
  assert.equal(parseCopilotSession("s1", noCwd, jsonl(ask("2026-10-12T08:00:02Z", "hi"))), null);
  const partial = jsonl(ask("2026-10-12T08:00:02Z", "hi")) + '{"type":"assis';
  assert.equal(parseCopilotSession("s1", WS, partial)?.lastUsedAt.toISOString(), "2026-10-12T08:00:02.000Z");
});

// ---- list() against a temp Copilot folder (session-state/ and, optionally, the desktop app's data.db)

function copilotHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-"));
  const root = path.join(home, "session-state");
  mkdirSync(root);
  const add = (id: string, ws: Record<string, string>, events?: string) => {
    mkdirSync(path.join(root, id));
    const yaml = Object.entries({ ...ws, id }).map(([k, v]) => `${k}: ${v}`).join("\n");
    writeFileSync(path.join(root, id, "workspace.yaml"), yaml + "\n");
    if (events !== undefined) writeFileSync(path.join(root, id, "events.jsonl"), events);
  };
  const convo = jsonl(start("2026-10-12T08:00:00Z"), ask("2026-10-12T08:00:02Z", "hi"));
  const { client_name: _, ...older } = WS;
  add("cli", WS, convo);
  add("older", older, convo); // older CLI versions wrote no client_name
  add("desktop", { ...WS, client_name: "github/autopilot" }, convo);
  add("terminal", { ...WS, client_name: "wta-master" }, convo);
  add("no-events", WS);
  add("no-prompt", WS, jsonl(start("2026-10-12T08:00:00Z")));
  add("sub", { ...WS, cwd: "C:\\work\\app\\src" }, convo);
  mkdirSync(path.join(root, "no-yaml"));
  writeFileSync(path.join(root, "stray.txt"), "");
  return home;
}

/** The desktop app's session list, with the columns read (data.db has many more). */
function addDataDb(home: string, rows: [id: string, sessionType: string, archivedAt: string | null][]): void {
  const db = new Database(path.join(home, "data.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, session_type TEXT, archived_at TEXT)");
  const insert = db.prepare("INSERT INTO sessions (id, title, session_type, archived_at) VALUES (?, 't', ?, ?)");
  for (const r of rows) insert.run(...r);
  db.close();
}

test("list: CLI and desktop app sessions with a prompt, exact folder only; desktop ones marked", async () => {
  const r = await createCopilotSessions({ copilotHome: copilotHome() }).list({ cwd: "c:\\WORK\\app\\" });
  assert.ok(r.ok);
  assert.equal(r.provider, "Copilot");
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["cli", "desktop", "older"]);
  assert.deepEqual(Object.fromEntries(r.sessions.map((s) => [s.id, s.client])), { cli: "cli", desktop: "desktop", older: "cli" });
});

test("list: every folder when cwd is undefined", async () => {
  const r = await createCopilotSessions({ copilotHome: copilotHome() }).list({});
  assert.ok(r.ok);
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["cli", "desktop", "older", "sub"]);
});

test("list: the desktop app's list marks its older sessions and hides archived ones", async () => {
  const home = copilotHome();
  // "older" has no client_name but is a desktop project; "cli" is a CLI session the app shows; "sub" is archived.
  addDataDb(home, [
    ["older", "project", null],
    ["cli", "cli_session", null],
    ["sub", "general_chat", "2026-10-13T10:00:00Z"],
  ]);
  const r = await createCopilotSessions({ copilotHome: home }).list({});
  assert.ok(r.ok);
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["cli", "desktop", "older"]);
  assert.deepEqual(Object.fromEntries(r.sessions.map((s) => [s.id, s.client])), { cli: "cli", desktop: "desktop", older: "desktop" });
});

test("list: an unreadable data.db only loses the extra information", async () => {
  const home = copilotHome();
  writeFileSync(path.join(home, "data.db"), "not a database");
  const r = await createCopilotSessions({ copilotHome: home }).list({});
  assert.ok(r.ok);
  assert.equal(r.sessions.length, 4);
});

test("list: no session-state folder means Copilot is not installed -> no sessions, no error", async () => {
  const r = await createCopilotSessions({ copilotHome: path.join(os.tmpdir(), "agentsctl-missing-dir") }).list({});
  assert.deepEqual(r, { provider: "Copilot", ok: true, sessions: [] });
});
