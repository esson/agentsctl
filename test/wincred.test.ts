import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCredentialBlob } from "../src/wincred.js";

test("decodes UTF-16LE blobs (cmdkey / Win32 tools)", () => {
  assert.equal(decodeCredentialBlob(Buffer.from("gho_abc123", "utf16le")), "gho_abc123");
});

test("decodes UTF-8 blobs (gh / go-keyring)", () => {
  assert.equal(decodeCredentialBlob(Buffer.from("gho_abc123", "utf8")), "gho_abc123");
});

test("empty blob decodes to empty string", () => {
  assert.equal(decodeCredentialBlob(Buffer.alloc(0)), "");
});
