import assert from "node:assert/strict";
import { test } from "node:test";
import { withPrintDispatch, markPrintCommandSent, printOutcome, PrinterRefusal } from "../dist/refusal.js";

test("a fresh-report timeout before dispatch is not sent, regardless of its words", async () => {
  await withPrintDispatch(async () => {
    const timeout = new Error("Timed out waiting for a fresh MQTT safety report");
    assert.equal(printOutcome(timeout), "not-sent");
    assert.equal(printOutcome(new Error("arbitrary new firmware wording")), "not-sent");
    markPrintCommandSent();
    assert.equal(printOutcome(timeout), "unknown", "a lost reply after dispatch must stay uncertain");
    assert.equal(printOutcome(new PrinterRefusal("printer-command-rejected", "refused")), "rejected");
  });
});

test("concurrent calls do not borrow another print's dispatch truth", async () => {
  await withPrintDispatch(async () => {
    markPrintCommandSent();
    await withPrintDispatch(async () => {
      await Promise.resolve();
      assert.equal(printOutcome(new Error()), "not-sent");
    });
    assert.equal(printOutcome(new Error()), "unknown");
  });
  assert.equal(printOutcome(new Error()), "unknown", "untracked operations cannot claim nothing was sent");
});
