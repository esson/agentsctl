import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatFolderName, chatToSession, createCursorSessions } from "../../src/providers/cursor/sessions.js";

// meta.json files are built from the shape seen in real Cursor agent 2026.10.01 chats
// (docs/providers/cursor-sessions.md), written to temp folders. The real store is never read.

const APP = "C:\\work\\app";
const META = {
  schemaVersion: 1,
  createdAtMs: Date.parse("2026-10-12T08:00:00Z"),
  updatedAtMs: Date.parse("2026-10-12T09:00:00Z"),
  hasConversation: true,
  title: "Fix the build",
  cwd: APP,
};

test("chatToSession: title, times, folder and resume command", () => {
  assert.deepEqual(chatToSession("c1", META, APP), {
    id: "c1",
    title: "Fix the build",
    cwd: APP,
    startedAt: new Date("2026-10-12T08:00:00Z"),
    lastUsedAt: new Date("2026-10-12T09:00:00Z"),
    resumeCommand: "agent --resume c1",
    resumeArgv: ["agent", "--resume", "c1"],
    client: "cli",
  });
  assert.equal(chatToSession("c1", { ...META, title: undefined }, APP)?.title, null);
});

test("chatToSession: subagents, empty chats and chats without a folder are not sessions", () => {
  assert.equal(chatToSession("c1", { ...META, isSubagent: true }, APP), null);
  assert.equal(chatToSession("c1", { ...META, hasConversation: false }, APP), null);
  assert.equal(chatToSession("c1", META, undefined), null);
});

test("chatFolderName is the md5 of the folder path", () => {
  assert.equal(chatFolderName(APP), "8cbd8a2117eb4d156d9d9d3d5b045d9b");
  assert.notEqual(chatFolderName("C:\\a"), chatFolderName("c:\\a"));
});

// ---- list() against a temp chats folder

function chats(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-"));
  const add = (folder: string, id: string, meta: object | string) => {
    mkdirSync(path.join(root, folder, id), { recursive: true });
    writeFileSync(path.join(root, folder, id, "meta.json"), typeof meta === "string" ? meta : JSON.stringify(meta));
  };
  const app = chatFolderName(APP);
  const { cwd: _, ...noCwd } = META;
  add(app, "one", META);
  add(app, "older", noCwd); // older agent versions: no cwd, the sibling's folder applies
  add(app, "empty", { ...META, hasConversation: false });
  add(app, "sub", { ...noCwd, isSubagent: true });
  add(app, "partial", '{"schemaVersion":1,"crea');
  mkdirSync(path.join(root, app, "no-meta"));
  add(chatFolderName("C:\\work\\app-two"), "two", { ...META, cwd: "C:\\work\\app-two" });
  // Only chats without cwd: the folder is known only when it hashes to the wanted folder.
  add(chatFolderName("C:\\work\\lone"), "lone", noCwd);
  return root;
}

test("list: chats with a conversation, exact folder only; a missing cwd comes from a sibling", async () => {
  const r = await createCursorSessions({ chatsDir: chats() }).list({ cwd: "c:\\WORK\\app\\" });
  assert.ok(r.ok);
  assert.equal(r.provider, "Cursor");
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["older", "one"]);
  assert.ok(r.sessions.every((s) => s.cwd === APP));
});

test("list: a chat without any known folder matches by the folder hash, and is skipped for --all", async () => {
  const root = chats();
  const lone = await createCursorSessions({ chatsDir: root }).list({ cwd: "c:\\work\\lone\\" });
  assert.ok(lone.ok);
  assert.deepEqual(lone.sessions.map((s) => s.id), ["lone"]);
  const all = await createCursorSessions({ chatsDir: root }).list({});
  assert.ok(all.ok);
  assert.deepEqual(all.sessions.map((s) => s.id).sort(), ["older", "one", "two"]);
});

test("list: no chats folder means the Cursor agent is not installed -> no sessions, no error", async () => {
  const r = await createCursorSessions({ chatsDir: path.join(os.tmpdir(), "agentsctl-missing-dir") }).list({});
  assert.deepEqual(r, { provider: "Cursor", ok: true, sessions: [] });
});
