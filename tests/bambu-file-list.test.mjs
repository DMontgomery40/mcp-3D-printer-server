import assert from "node:assert/strict";
import { test } from "node:test";
import { Client as FTPClient } from "basic-ftp";
import { BambuImplementation } from "../dist/printers/bambu.js";

// Read-only Bambu file listing, ported from bambu-printer-mcp's fix: absolute
// paths, no directory creation, and real FTPS failures instead of empty lists.
function ftp(t, entries, { accessError, listErrors = {} } = {}) {
  const calls = [];
  t.mock.method(FTPClient.prototype, "access", async (options) => {
    calls.push(["access", options.port, options.secure]);
    if (accessError) throw accessError;
  });
  t.mock.method(FTPClient.prototype, "list", async (path) => {
    calls.push(["list", path]);
    if (listErrors[path]) throw listErrors[path];
    assert.ok(Object.hasOwn(entries, path), `unexpected listing: ${path}`);
    return entries[path];
  });
  t.mock.method(FTPClient.prototype, "ensureDir", async () => assert.fail("listing must never create or change directories"));
  t.mock.method(FTPClient.prototype, "close", () => calls.push(["close"]));
  return calls;
}
const dir = (name) => ({ name, isDirectory: true });
const file = (name) => ({ name, isDirectory: false });

test("Bambu file listing reads cache, timelapse, and logs over FTPS with absolute paths", async (t) => {
  const calls = ftp(t, { "/": [dir("cache"), dir("timelapse"), file("box.gcode.3mf")], "/cache": [file("part.3mf")], "/timelapse": [file("video.mp4")] });
  const result = await new BambuImplementation().getFiles("127.0.0.1", "990", "SERIAL:CODE");
  assert.deepEqual(result.files, ["cache/part.3mf", "timelapse/video.mp4"]);
  assert.deepEqual(result.directories.logs, [], "an absent optional folder is empty, not an error");
  assert.deepEqual(calls[0], ["access", 990, "implicit"]);
  assert.deepEqual(calls.at(-1), ["close"]);
});

test("Bambu file listing surfaces credential and listing failures instead of empty results", async (t) => {
  for (const [name, options] of [
    ["rejected access code", { accessError: Object.assign(new Error("530 Login incorrect."), { code: 530 }) }],
    ["listing failure", { listErrors: { "/cache": new Error("550 Permission denied") } }],
  ]) {
    await t.test(name, async (t) => {
      const calls = ftp(t, { "/": [dir("cache")], "/cache": [] }, options);
      await assert.rejects(new BambuImplementation().getFiles("127.0.0.1", "990", "SERIAL:CODE"), /530|550/);
      assert.deepEqual(calls.at(-1), ["close"], "the FTPS session is always closed");
    });
  }
});
