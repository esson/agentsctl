import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NERD_FONT_CHARS, page, pagerCandidates } from "../src/pager.js";

test("pagerCandidates: AGENTSCTL_PAGER, then PAGER, then less (and Git's less on Windows)", () => {
  assert.deepEqual(pagerCandidates({ AGENTSCTL_PAGER: "more", PAGER: "most" }, "linux"), [{ shell: "more" }]);
  assert.deepEqual(pagerCandidates({ PAGER: "less -S" }, "linux"), [{ shell: "less -S" }]);
  assert.deepEqual(pagerCandidates({}, "linux"), [{ file: "less" }]);
  assert.deepEqual(pagerCandidates({ ProgramFiles: "D:\\Apps" }, "win32"), [
    { file: "less" },
    { file: "D:\\Apps\\Git\\usr\\bin\\less.exe" },
  ]);
});

test("pagerCandidates: an empty pager or cat turns paging off", () => {
  assert.deepEqual(pagerCandidates({ PAGER: "" }, "linux"), []);
  assert.deepEqual(pagerCandidates({ AGENTSCTL_PAGER: " cat ", PAGER: "less" }, "linux"), []);
});

test("page: the text reaches the pager's stdin, with LESS and LESSUTFCHARDEF unless they are set", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-"));
  const out = path.join(dir, "paged.txt");
  // A stand-in pager that writes $LESS, $LESSUTFCHARDEF and its input to a file.
  const script = path.join(dir, "pager.cjs");
  writeFileSync(script, `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => require("fs").writeFileSync(process.argv[2], process.env.LESS + "|" + process.env.LESSUTFCHARDEF + "|" + s));`);
  const pager = `"${process.execPath}" "${script}" "${out}"`;
  assert.equal(await page("line 1\nline 2\n", { ...process.env, AGENTSCTL_PAGER: pager, LESS: undefined, LESSUTFCHARDEF: undefined }), "paged");
  assert.equal(readFileSync(out, "utf8"), `FRX|${NERD_FONT_CHARS}|line 1\nline 2\n`);
  assert.equal(await page("x", { ...process.env, AGENTSCTL_PAGER: pager, LESS: "R", LESSUTFCHARDEF: "e000:p" }), "paged");
  assert.equal(readFileSync(out, "utf8"), "R|e000:p|x");
});

test("page: off and failed are reported so the caller prints the text itself", async () => {
  assert.equal(await page("x", { PAGER: "cat" }), "off");
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentsctl-test-"));
  const script = path.join(dir, "broken.cjs");
  writeFileSync(script, "process.stdin.resume(); process.stdin.on('end', () => process.exit(3));");
  assert.equal(await page("x", { ...process.env, AGENTSCTL_PAGER: `"${process.execPath}" "${script}"` }), "failed");
});
