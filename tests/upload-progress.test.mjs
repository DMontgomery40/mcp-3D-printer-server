import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadProgressReporter, UPLOAD_STAGE_META } from "../dist/upload-progress.js";

test("upload progress is bytes sent of the file's bytes, marked as the upload stage, once per whole percent", () => {
  const sent = [];
  const report = uploadProgressReporter(params => sent.push(params));
  const total = 18_362_734;
  for (let bytes = 0; bytes <= total; bytes += 65_536) report(bytes, total);
  report(total, total);
  assert.equal(sent.length, 101, "0% through 100%, each once");
  assert.deepEqual(sent.map(p => Math.floor(p.progress * 100 / p.total)), Array.from({ length: 101 }, (_, i) => i));
  assert.ok(sent.every(p => p.total === total && p._meta["counterpart/stage"] === "upload"));
  assert.deepEqual(UPLOAD_STAGE_META, { "counterpart/stage": "upload" });
  assert.equal(sent.at(-1).progress, total);
});
