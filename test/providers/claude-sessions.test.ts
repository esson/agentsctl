import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeClient, createClaudeSessions, encodeProjectDir, parseClaudeTranscript } from "../../src/providers/claude/sessions.js";

// Transcripts are built from the record shapes seen in real Claude Code 2.1.x files
// (docs/providers/claude-sessions.md), written to temp folders. The real store is never read.

const CWD = "C:\\work\\app";
const jsonl = (...records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

const user = (ts: string, content: unknown, extra: object = {}) => ({
  type: "user",
  timestamp: ts,
  cwd: CWD,
  gitBranch: "main",
  isSidechain: false,
  message: { role: "user", content },
  ...extra,
});
const assistant = (ts: string, model = "claude-sonnet-5-5", extra: object = {}) => ({
  type: "assistant",
  timestamp: ts,
  cwd: CWD,
  gitBranch: "main",
  isSidechain: false,
  message: { role: "assistant", model, content: [{ type: "text", text: "ok" }] },
  ...extra,
});

const FALLBACK = new Date("2026-01-01T00:00:00Z");

test("parse: title, times, folder, branch, model and resume command", () => {
  const s = parseClaudeTranscript(
    "abc",
    jsonl(
      { type: "permission-mode", permissionMode: "auto", sessionId: "abc" },
      user("2026-10-12T08:00:00Z", "Fix the build\nmore detail"),
      assistant("2026-10-12T08:01:00Z"),
      { type: "ai-title", aiTitle: "Old title", sessionId: "abc" },
      { type: "ai-title", aiTitle: "Fix failing build", sessionId: "abc" },
      user("2026-10-12T09:00:00Z", "next", { gitBranch: "feature/x" }),
      assistant("2026-10-12T09:05:00Z", "claude-opus-5-5", { gitBranch: "feature/x" }),
    ),
    FALLBACK,
  );
  assert.deepEqual(s, {
    id: "abc",
    title: "Fix failing build",
    cwd: CWD,
    startedAt: new Date("2026-10-12T08:00:00Z"),
    lastUsedAt: new Date("2026-10-12T09:05:00Z"),
    resumeCommand: "claude --resume abc",
    resumeArgv: ["claude", "--resume", "abc"],
    branch: "feature/x",
    model: "claude-opus-5-5",
  });
});

test("parse: a name the user gave wins over the generated title", () => {
  const records = [
    user("2026-10-12T08:00:00Z", "hi"),
    assistant("2026-10-12T08:01:00Z"),
    { type: "ai-title", aiTitle: "Generated", sessionId: "s" },
  ];
  assert.equal(parseClaudeTranscript("s", jsonl(...records, { type: "agent-name", agentName: "my-task" }), FALLBACK)?.title, "my-task");
  assert.equal(parseClaudeTranscript("s", jsonl(...records, { type: "custom-title", customTitle: "Renamed" }), FALLBACK)?.title, "Renamed");
});

test("parse: falls back to the first real prompt, skipping meta records, commands and tool results", () => {
  const s = parseClaudeTranscript(
    "s",
    jsonl(
      user("2026-10-12T08:00:00Z", "<local-command-caveat>ignore</local-command-caveat>", { isMeta: true }),
      user("2026-10-12T08:00:01Z", "<command-name>/model</command-name>"),
      user("2026-10-12T08:00:02Z", [{ type: "tool_result", content: "x" }]),
      user("2026-10-12T08:00:03Z", [{ type: "text", text: "  Explain the parser  " }]),
      assistant("2026-10-12T08:01:00Z"),
    ),
    FALLBACK,
  );
  assert.equal(s?.title, "Explain the parser");
  const none = parseClaudeTranscript("s", jsonl(user("2026-10-12T08:00:00Z", "<command-name>/x</command-name>"), assistant("2026-10-12T08:01:00Z")), FALLBACK);
  assert.equal(none?.title, null);
});

test("parse: no assistant reply or no folder -> not a session", () => {
  assert.equal(parseClaudeTranscript("s", jsonl(user("2026-10-12T08:00:00Z", "hi")), FALLBACK), null);
  const sidechainOnly = jsonl(user("2026-10-12T08:00:00Z", "hi"), assistant("2026-10-12T08:01:00Z", "m", { isSidechain: true }));
  assert.equal(parseClaudeTranscript("s", sidechainOnly, FALLBACK), null);
  const noCwd = jsonl({ type: "assistant", timestamp: "2026-10-12T08:01:00Z", message: { model: "m" } });
  assert.equal(parseClaudeTranscript("s", noCwd, FALLBACK), null);
});

test("parse: tolerates a partial last line and a missing timestamp; ignores <synthetic> models", () => {
  const text = jsonl(user("2026-10-12T08:00:00Z", "hi"), assistant("2026-10-12T08:01:00Z", "<synthetic>")) + '{"type":"assis';
  const s = parseClaudeTranscript("s", text, FALLBACK);
  assert.equal(s?.lastUsedAt.toISOString(), "2026-10-12T08:01:00.000Z");
  assert.equal(s?.model, undefined);
  const noTime = parseClaudeTranscript("s", jsonl({ ...assistant("x"), timestamp: undefined }), FALLBACK);
  assert.equal(noTime?.lastUsedAt, FALLBACK);
  assert.equal(noTime?.startedAt, null);
});

test("client from the records' entrypoint: CLI, VS Code extension, desktop app; others unknown", () => {
  assert.equal(claudeClient("cli"), "cli");
  assert.equal(claudeClient("claude-vscode"), "vscode");
  assert.equal(claudeClient("claude-desktop"), "desktop");
  assert.equal(claudeClient("sdk-ts"), undefined);
  assert.equal(claudeClient(undefined), undefined);
  const records = (entrypoint: string) =>
    jsonl(user("2026-10-12T08:00:00Z", "hi", { entrypoint }), assistant("2026-10-12T08:01:00Z", "m", { entrypoint }));
  assert.equal(parseClaudeTranscript("s", records("claude-vscode"), FALLBACK)?.client, "vscode");
  assert.equal(parseClaudeTranscript("s", records("cli"), FALLBACK)?.client, "cli");
});

test("encodeProjectDir matches Claude Code's folder names", () => {
  assert.equal(encodeProjectDir("C:\\dev\\code\\personal\\agentsctl"), "C--dev-code-personal-agentsctl");
  assert.equal(encodeProjectDir("C:\\Users\\me\\.config"), "C--Users-me--config");
});

// ---- list() against a temp projects folder

function projects(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-"));
  const write = (dir: string, file: string, text: string) => {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, file), text);
  };
  const convo = (cwd: string, ts: string) =>
    jsonl({ ...user(ts, "hi"), cwd }, { ...assistant(ts), cwd }, { type: "ai-title", aiTitle: `in ${cwd}` });
  write("C--work-app", "one.jsonl", convo(CWD, "2026-10-12T08:00:00Z"));
  write("C--work-app", "two.jsonl", convo(CWD, "2026-10-13T08:00:00Z"));
  write("C--work-app", "empty.jsonl", jsonl(user("2026-10-12T08:00:00Z", "hi")));
  write("C--work-app", "notes.txt", "not a transcript");
  // Same encoded name as C:\work\app, different real folder: must not match.
  write("C--work-app", "collision.jsonl", convo("C:\\work-app", "2026-10-14T08:00:00Z"));
  // Subagent transcripts are never sessions of their own.
  write(path.join("C--work-app", "one", "subagents"), "agent-1.jsonl", convo(CWD, "2026-10-15T08:00:00Z"));
  write("C--other", "three.jsonl", convo("C:\\other", "2026-10-11T08:00:00Z"));
  return root;
}

test("list: exact folder only, sessions without a conversation and subagents left out", async () => {
  const root = projects();
  const r = await createClaudeSessions({ projectsDir: root }).list({ cwd: "c:\\WORK\\app\\" });
  assert.ok(r.ok);
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["one", "two"]);
  assert.equal(r.provider, "Claude");
});

test("list: every folder when cwd is undefined", async () => {
  const r = await createClaudeSessions({ projectsDir: projects() }).list({});
  assert.ok(r.ok);
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["collision", "one", "three", "two"]);
});

test("list: no projects folder means Claude is not installed -> no sessions, no error", async () => {
  const r = await createClaudeSessions({ projectsDir: path.join(os.tmpdir(), "agentsctl-missing-dir") }).list({});
  assert.deepEqual(r, { provider: "Claude", ok: true, sessions: [] });
});

test("list: the file time is used when a transcript has no timestamps", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-"));
  mkdirSync(path.join(root, "C--work-app"));
  const file = path.join(root, "C--work-app", "s.jsonl");
  writeFileSync(file, jsonl({ type: "assistant", cwd: CWD, message: { model: "m" } }));
  const mtime = new Date("2026-05-05T05:05:05Z");
  utimesSync(file, mtime, mtime);
  const r = await createClaudeSessions({ projectsDir: root }).list({ cwd: CWD });
  assert.ok(r.ok);
  assert.equal(r.sessions[0].lastUsedAt.getTime(), mtime.getTime());
});
