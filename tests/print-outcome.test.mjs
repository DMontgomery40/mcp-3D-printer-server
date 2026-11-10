import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GenericPrinterImplementation } from "../dist/printers/generic-base.js";
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

// Missing required inputs fail before any network access. Exercise the actual
// MCP response, rather than constructing a structured result in the test.
test("every Counterpart dispatch tool returns structured dispatch truth", { timeout: 20_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-print-outcome-"));
  const client = new Client({ name: "dispatch-truth-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    cwd: directory,
    env: { ...process.env, MCP_TRANSPORT: "stdio", PRINTER_TYPE: "bambu", PRINTER_HOST: "192.0.2.10",
      BAMBU_SERIAL: "TEST_SERIAL", BAMBU_TOKEN: "TEST_TOKEN", BAMBU_MODEL: "" },
    stderr: "pipe",
  });
  transport.stderr?.resume();
  t.after(async () => {
    await client.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  for (const name of ["print_3mf", "upload_gcode", "process_and_print_stl"]) {
    await t.test(name, async () => {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent?.printOutcome, "not-sent", JSON.stringify(result));
    });
  }
});

// Both firmware families share this production gate: atomic upload-and-start
// (OctoPrint/Repetier), and upload followed by a separate start command.
for (const atomic of [false, true]) {
  test(`generic ${atomic ? "atomic upload" : "separate start"} tracks the real dispatch boundary`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "generic-print-outcome-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "job.gcode");
    await fs.writeFile(file, "; filament_type = PLA\nM104 S215\nM140 S60\nG28\nG1 X10 Y10 E1\nM104 S0\n");
    for (const phase of ["preflight", "upload", "dispatch"]) {
      const events = [];
      class MockPrinter extends GenericPrinterImplementation {
        printerLabel = "Mock";
        uploadStartsPrint = atomic;
        async readPrinterState() {
          if (phase === "preflight") throw new Error("fresh report unavailable");
          return { ready: true, state: "idle" };
        }
        async rawUploadFile(_host, _port, _key, _file, _name, print) {
          events.push(print ? "dispatch" : "upload");
          if (phase === "upload" || print) throw new Error("upload reply lost");
          return {};
        }
        async rawStartJob() { events.push("dispatch"); throw new Error("start reply lost"); }
      }
      const printer = new MockPrinter({});
      await withPrintDispatch(async () => {
        await assert.rejects(printer.uploadFile("192.0.2.11", "80", "TEST", file, "job.gcode", true), error => {
          assert.equal(printOutcome(error), phase === "preflight" || (!atomic && phase === "upload") ? "not-sent" : "unknown");
          return true;
        });
      });
      assert.deepEqual(events, phase === "preflight" ? [] : atomic ? ["dispatch"] : phase === "upload" ? ["upload"] : ["upload", "dispatch"]);
    }
  });
}
