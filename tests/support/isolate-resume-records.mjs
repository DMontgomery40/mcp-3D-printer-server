// Tests never touch the real resume records: one folder per test process, inherited by the servers it starts
// and removed when it exits. A test that checks resume across servers gives each server its own folder.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bambu-resume-test-"));
process.env.BAMBU_RESUME_STATE_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
