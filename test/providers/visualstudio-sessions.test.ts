import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MsgpackReader } from "../../src/providers/copilot/msgpack.js";
import { createVisualStudioSessions, parseRecentList, parseVisualStudioChat } from "../../src/providers/copilot/visualstudio.js";

// Chat files are built with the shape seen in real Visual Studio 18 Copilot Chat files
// (docs/providers/copilot-sessions.md), written to temp folders. The real files are never read.

/** Minimal MessagePack encoder for the test data (maps, arrays, strings, small ints, null, bools). */
function pack(v: unknown): Buffer {
  if (v === null || v === undefined) return Buffer.from([0xc0]);
  if (v === true) return Buffer.from([0xc3]);
  if (v === false) return Buffer.from([0xc2]);
  if (typeof v === "number") {
    if (Number.isInteger(v) && v >= 0 && v < 128) return Buffer.from([v]);
    const b = Buffer.alloc(9);
    b[0] = 0xcb;
    b.writeDoubleBE(v, 1);
    return b;
  }
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([s.length < 32 ? Buffer.from([0xa0 | s.length]) : Buffer.from([0xd9, s.length]), s]);
  }
  if (Array.isArray(v)) return Buffer.concat([Buffer.from([0x90 | v.length]), ...v.map(pack)]);
  const entries = Object.entries(v as object);
  return Buffer.concat([Buffer.from([0x80 | entries.length]), ...entries.flatMap(([k, x]) => [pack(k), pack(x)])]);
}

const header = (over: object = {}) => ({
  Name: null,
  TimeCreated: "2026-10-12T08:00:00.000Z",
  IsThread: true,
  ConversationMode: "Default",
  ...over,
});
const userMessage = (text: string) => [0, { Content: [[3, { Id: "p1", Content: text }]], Model: { ModelId: "auto" } }];
const reply = [1, { Content: [[3, { Id: "p2", Content: "ok" }]] }];
const chatFile = (...items: unknown[]) => Buffer.concat([Buffer.from([1]), ...items.map(pack)]);

const LAST = new Date("2026-10-13T09:00:00Z");

test("MsgpackReader: values in sequence, timestamps, and an error on truncated input", () => {
  const ts = Buffer.from([0xd6, 0xff, 0, 0, 0, 60]); // timestamp 32: 60 s after the epoch
  const r = new MsgpackReader(Buffer.concat([pack({ a: [1, "x", null, true] }), pack(-0.5), ts]));
  assert.deepEqual(r.next(), { a: [1, "x", null, true] });
  assert.equal(r.next(), -0.5);
  assert.deepEqual(r.next(), new Date(60_000));
  assert.ok(r.done);
  assert.throws(() => new MsgpackReader(Buffer.from([0xa5, 0x61])).next(), /truncated/);
});

test("parseVisualStudioChat: first prompt as the title, created time, client and resume command", () => {
  const s = parseVisualStudioChat("c1", chatFile(header(), userMessage("Fix the build\nmore"), reply), "C:\\work\\app\\src", 'start "x.sln"', LAST);
  assert.deepEqual(s, {
    id: "c1",
    title: "Fix the build",
    cwd: "C:\\work\\app\\src",
    startedAt: new Date("2026-10-12T08:00:00Z"),
    lastUsedAt: LAST,
    resumeCommand: 'start "x.sln"',
    client: "visual-studio",
  });
});

test("parseVisualStudioChat: a Name wins; no prompt or another format version -> not a session", () => {
  assert.equal(parseVisualStudioChat("c1", chatFile(header({ Name: "Named chat" }), userMessage("hi")), "C:\\a", "x", LAST)?.title, "Named chat");
  assert.equal(parseVisualStudioChat("c1", chatFile(header(), reply), "C:\\a", "x", LAST), null);
  const v2 = chatFile(header(), userMessage("hi"));
  v2[0] = 2;
  assert.equal(parseVisualStudioChat("c1", v2, "C:\\a", "x", LAST), null);
});

test("parseRecentList: FullPath of each entry in CodeContainers.Offline", () => {
  const entries = [
    { Key: "C:\\work\\app\\src\\App.sln", Value: { LocalProperties: { FullPath: "C:\\work\\app\\src\\App.sln", Type: 0 } } },
    { Key: "C:\\work\\lib", Value: { LocalProperties: { FullPath: "C:\\work\\lib", Type: 1 } } },
  ];
  const escaped = JSON.stringify(entries).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const xml = `<content><collection name="CodeContainers.Offline"><value name="value">${escaped}</value></collection></content>`;
  assert.deepEqual(parseRecentList(xml), ["C:\\work\\app\\src\\App.sln", "C:\\work\\lib"]);
  assert.deepEqual(parseRecentList("<content/>"), []);
});

// ---- list() against a temp Visual Studio data folder and temp solution folders

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-"));
  const repo = path.join(root, "repo");
  const solution = path.join(repo, "src");
  const addChat = (folder: string, solutionName: string, id: string, file: Buffer) => {
    const dir = path.join(folder, ".vs", solutionName, "copilot-chat", "802b1dc9", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, id), file);
    utimesSync(path.join(dir, id), LAST, LAST);
  };
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(solution, { recursive: true });
  writeFileSync(path.join(solution, "App.sln"), "");
  addChat(solution, "App", "chat-1", chatFile(header(), userMessage("In the solution")));
  addChat(solution, "App", "empty", chatFile(header()));
  addChat(solution, "App", "broken", Buffer.from([1, 0xa5, 0x61]));
  // An opened folder without a solution file, outside any git repository.
  const loose = path.join(root, "loose");
  addChat(loose, "loose", "chat-2", chatFile(header(), userMessage("Loose folder")));

  const vsData = path.join(root, "VisualStudio");
  mkdirSync(path.join(vsData, "18.0_abc"), { recursive: true });
  const recent = [path.join(solution, "App.sln"), loose].map((p) => ({ Key: p, Value: { LocalProperties: { FullPath: p } } }));
  const escaped = JSON.stringify(recent).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  writeFileSync(
    path.join(vsData, "18.0_abc", "ApplicationPrivateSettings.xml"),
    `<content><collection name="CodeContainers.Offline"><value name="value">${escaped}</value></collection></content>`,
  );
  return { root, repo, solution, loose, source: createVisualStudioSessions({ vsDataDir: vsData }) };
}

test("list: every recent solution's chats for --all; resume opens the solution, or the folder", async () => {
  const { source, solution, loose } = setup();
  const r = await source.list({});
  assert.ok(r.ok);
  assert.equal(r.provider, "Copilot");
  const byId = Object.fromEntries(r.sessions.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ["chat-1", "chat-2"]);
  assert.equal(byId["chat-1"].resumeCommand, `start "${path.join(solution, "App.sln")}"`);
  assert.equal(byId["chat-2"].resumeCommand, `start devenv "${loose}"`);
  assert.equal(byId["chat-1"].lastUsedAt.getTime(), LAST.getTime());
});

test("list: a solution below the current folder counts within the same git repository", async () => {
  const { source, repo, solution, root } = setup();
  const ids = async (cwd: string) => {
    const r = await source.list({ cwd });
    assert.ok(r.ok);
    return r.sessions.map((s) => s.id).sort();
  };
  assert.deepEqual(await ids(solution), ["chat-1"], "the solution folder itself");
  assert.deepEqual(await ids(repo), ["chat-1"], "the repository root above it");
  assert.deepEqual(await ids(root), [], "not from outside the repository");
});

test("list: the current folder is checked even when it is not in the recent list", async () => {
  const { root } = setup();
  const other = path.join(root, "other");
  const dir = path.join(other, ".vs", "Other", "copilot-chat", "h", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "chat-3"), chatFile(header(), userMessage("Not recent")));
  const r = await createVisualStudioSessions({ vsDataDir: path.join(root, "no-vs") }).list({ cwd: other });
  assert.ok(r.ok);
  assert.deepEqual(r.sessions.map((s) => s.id), ["chat-3"]);
});
