import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const data = process.env.CAD_E2E_DATA_DIR;
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const source =
  'from build123d import Box\nP = {"width":10.0,"depth":20.0,"height":30.0}\nP["derived_width"] = P["width"]\ndef build():\n return Box(P["derived_width"],P["depth"],P["height"])\n';

test(
  "real code-CAD over stdio builds, edits, measures fit, recovers a cancelled checkpoint and refuses hostile code",
  {
    skip: !data && "set CAD_E2E_DATA_DIR to an installed, verified CAD runtime",
    timeout: 900000,
  },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cad-real-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const c = new Client({ name: "cad-real-test", version: "1" });
    const tr = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MCP_TRANSPORT: "stdio",
        BAMBU_MODEL: "",
        BAMBU_PRINTER_HOST: "127.0.0.1",
        TEMP_DIR: dir,
        CAD_DATA_DIR: data,
        CAD_PARENT_CANARY: "host-only-test-canary",
      },
      stderr: "pipe",
    });
    tr.stderr?.on("data", () => {});
    t.after(() => c.close());
    await c.connect(tr);
    await c.listTools();
    const call = async (name, args) => {
      const r = await c.callTool({ name, arguments: args }, undefined, {
        timeout: 240000,
      });
      assert.notEqual(r.isError, true, JSON.stringify(r));
      return r.structuredContent;
    };
    const status = await call("cad_status", {});
    if (!status.ready) {
      t.skip("CAD runtime exists but is not ready: run cad_setup first");
      return;
    }
    const original = await call("cad_run", {
      script: source,
      output_dir: dir,
      name: "part.v1",
      timeout_ms: 180000,
    });
    assert.equal(original.valid, true);
    assert.match(original.stl, /part\.v1\.stl$/);
    assert.deepEqual(original.size_mm, [10, 20, 30]);
    assert.equal(original.solid_count, 1);
    assert.equal(Object.keys(original.renders).length, 7);
    const asym = await call("cad_run", {
      script:
        "from build123d import Box,Pos\nP={}\ndef build():\n return Box(10,20,30)+Pos(4,9,14)*Box(6,6,6)",
      output_dir: dir,
      name: "asymmetric",
      timeout_ms: 180000,
    });
    const centres = {};
    for (const [name, file] of Object.entries(asym.renders)) {
      if (name === "contact") continue;
      const { data: pix, info } = await sharp(file)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let sum = 0,
        n = 0;
      for (let i = 0; i < pix.length; i += info.channels)
        if (pix[i + 2] > pix[i + 1] && pix[i + 1] > pix[i]) {
          sum += (i / info.channels) % info.width;
          n++;
        }
      assert.ok(n > 1000);
      centres[name] = sum / n;
    }
    for (const [a, b] of [
      ["front", "back"],
      ["left", "right"],
      ["top", "bottom"],
    ])
      assert.ok(
        Math.abs(centres[a] + centres[b] - 799) < 2,
        JSON.stringify(centres),
      );
    assert.ok(centres.left > centres.right + 4, JSON.stringify(centres));
    assert.ok(centres.bottom > centres.top + 4, JSON.stringify(centres));
    const edit = await call("cad_run", {
      script_path: original.script,
      parameters: { width: 11 },
      output_dir: dir,
      name: "edited",
      timeout_ms: 180000,
    });
    assert.deepEqual(edit.size_mm, [11, 20, 30]);
    const meshSource =
      "import trimesh\nP={'lift':1.0}\ndef build():\n m=trimesh.load(INPUTS['scan'],force='mesh')\n m.apply_translation([0,0,P['lift']])\n return m\n";
    const meshResult = await call("cad_run", {
      script: meshSource,
      mode: "mesh",
      inputs: [{ name: "scan", path: original.stl }],
      output_dir: dir,
      name: "mesh-edit",
      timeout_ms: 180000,
    });
    assert.equal(meshResult.valid, true);
    assert.equal(meshResult.step, null);
    assert.match(meshResult.step_unavailable, /B-rep/);
    assert.deepEqual(meshResult.size_mm, [10, 20, 30]);
    assert.equal(meshResult.bounds_mm[0][2], -14);
    assert.ok(meshResult.inputs.scan);
    const meshAgain = await call("cad_run", {
      script_path: meshResult.script,
      mode: "mesh",
      parameters: { lift: 2 },
      output_dir: dir,
      name: "mesh-revised",
      timeout_ms: 180000,
    });
    assert.equal(meshAgain.bounds_mm[0][2], -13);
    const rawScan = path.join(dir, "metres-yup.stl");
    const vertices = [
      [0, 0, 0],
      [0.01, 0, 0],
      [0.01, 0.03, 0],
      [0, 0.03, 0],
      [0, 0, 0.02],
      [0.01, 0, 0.02],
      [0.01, 0.03, 0.02],
      [0, 0.03, 0.02],
    ];
    const faces = [
      [0, 2, 1],
      [0, 3, 2],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [1, 2, 6],
      [1, 6, 5],
      [2, 3, 7],
      [2, 7, 6],
      [3, 0, 4],
      [3, 4, 7],
    ];
    await fs.writeFile(
      rawScan,
      "solid scan\n" +
        faces
          .map(
            (face) =>
              "facet normal 0 0 0\nouter loop\n" +
              face.map((i) => "vertex " + vertices[i].join(" ")).join("\n") +
              "\nendloop\nendfacet",
          )
          .join("\n") +
        "\nendsolid scan",
    );
    const prepared = await call("cad_run", {
      script:
        "P={}\ndef build():\n return load_scan('scan',source_units='m',up_axis='y')",
      mode: "mesh",
      inputs: [{ name: "scan", path: rawScan }],
      output_dir: dir,
      name: "prepared",
      timeout_ms: 180000,
    });
    assert.equal(prepared.valid, true);
    for (let i = 0; i < 3; i++)
      assert.ok(Math.abs(prepared.size_mm[i] - [10, 20, 30][i]) < 0.001);
    assert.equal(prepared.bounds_mm[0][2], 0);
    assert.ok(Math.abs(prepared.volume_mm3 - 6000) < 0.01);
    const invertedSource = meshSource.replace(
      "m.apply_translation([0,0,P['lift']])",
      "m.invert()",
    );
    const inverted = await call("cad_run", {
      script: invertedSource,
      mode: "mesh",
      inputs: [{ name: "scan", path: original.stl }],
      output_dir: dir,
      name: "inverted",
      timeout_ms: 180000,
    });
    assert.equal(inverted.valid, false);
    assert.equal(inverted.checks.positive_volume, false);
    const invertedFit = await c.callTool(
      {
        name: "cad_check_fit",
        arguments: { model: original.stl, reference: inverted.stl },
      },
      undefined,
      { timeout: 240000 },
    );
    assert.equal(invertedFit.isError, true);
    const fit = await call("cad_check_fit", {
      model: original.stl,
      reference: original.stl,
      transform: { translation_mm: [14, 0, 0] },
      clearance_mm: 4,
    });
    assert.equal(fit.interference_volume_mm3, 0);
    assert.ok(Math.abs(fit.minimum_gap_mm - 4) < 1e-6);
    assert.equal(fit.clear, true);
    const overlap = await call("cad_check_fit", {
      model: original.stl,
      reference: original.stl,
      transform: { translation_mm: [5, 0, 0] },
    });
    assert.ok(Math.abs(overlap.interference_volume_mm3 - 3000) < 0.01);
    assert.equal(overlap.minimum_gap_mm, 0);
    assert.equal(overlap.clear, false);
    const unknown = await c.callTool({
      name: "cad_run",
      arguments: {
        script_path: original.script,
        parameters: { typo: 5 },
        output_dir: dir,
        name: "unknown",
      },
    });
    assert.equal(unknown.isError, true);
    // A killed build must leave a source + parameter checkpoint whose defaults can still rebuild.
    const slow =
      'from build123d import Box\nimport time\nP={"delay":2.0}\ndef build():\n time.sleep(P["delay"])\n return Box(2,3,4)';
    const killed = await c.callTool({
      name: "cad_run",
      arguments: {
        script: slow,
        output_dir: dir,
        name: "killed",
        timeout_ms: 100,
      },
    });
    assert.equal(killed.isError, true);
    assert.match(killed.content[0].text, /Checkpoint retained/);
    const job = (await fs.readdir(dir)).find((n) =>
      n.startsWith("cad-killed-"),
    );
    assert.ok(job);
    const recovered = await call("cad_run", {
      script_path: path.join(dir, job, "killed.py"),
      output_dir: dir,
      name: "recovered",
      timeout_ms: 180000,
    });
    assert.deepEqual(recovered.size_mm, [2, 3, 4]);
    const logTarget = path.join(dir, "protected-log-target");
    await fs.writeFile(logTarget, "unchanged");
    const logAttack = `from build123d import Box\nimport os\nP={}\ndef build():\n os.symlink(${JSON.stringify(logTarget)},'build.log')\n return Box(1,2,3)`;
    const logReply = await c.callTool(
      {
        name: "cad_run",
        arguments: {
          script: logAttack,
          output_dir: dir,
          name: "log-attack",
          timeout_ms: 180000,
        },
      },
      undefined,
      { timeout: 240000 },
    );
    assert.equal(logReply.isError, true);
    assert.equal(await fs.readFile(logTarget, "utf8"), "unchanged");
    const hardlinkTarget = path.join(data, "runtime", "cad-hardlink-probe");
    await fs.writeFile(hardlinkTarget, "unchanged");
    t.after(() => fs.unlink(hardlinkTarget).catch(() => {}));
    const hardlinkScript = `from build123d import Box\nimport os\nP={}\ndef build():\n os.link(${JSON.stringify(hardlinkTarget)},'link-probe')\n open('link-probe','w').write('changed')\n return Box(1,2,3)`;
    const linked = await c.callTool(
      {
        name: "cad_run",
        arguments: {
          script: hardlinkScript,
          output_dir: dir,
          name: "hardlink",
          timeout_ms: 180000,
        },
      },
      undefined,
      { timeout: 240000 },
    );
    assert.equal(
      linked.isError,
      true,
      "a runtime hardlink must not become writable through the job",
    );
    assert.equal(await fs.readFile(hardlinkTarget, "utf8"), "unchanged");
    assert.ok(Number.isInteger(tr.pid) && tr.pid > 0);
    const parentRead = await c.callTool(
      {
        name: "cad_run",
        arguments: {
          script: `from build123d import Box\nimport psutil\nP={'pid':${tr.pid}}\ndef build():\n info=psutil.Process(P['pid']).environ()\n print('parent canary readable:', 'CAD_PARENT_CANARY' in info)\n return Box(1,2,3)`,
          output_dir: dir,
          name: "parent-environment",
          timeout_ms: 180000,
        },
      },
      undefined,
      { timeout: 240000 },
    );
    assert.equal(
      parentRead.isError,
      true,
      "a script must not read the MCP parent's environment",
    );
    assert.match(
      parentRead.content[0].text,
      /AccessDenied|Permission|NoSuchProcess|permitted|denied/,
    );
    const inputBefore = await fs.readFile(original.stl);
    const inputWrite = await c.callTool(
      {
        name: "cad_run",
        arguments: {
          script:
            "from pathlib import Path\nP={}\ndef build():\n Path(INPUTS['scan']).write_bytes(b'no')\n",
          inputs: [{ name: "scan", path: original.stl }],
          mode: "mesh",
          output_dir: dir,
          name: "input-write",
          timeout_ms: 180000,
        },
      },
      undefined,
      { timeout: 240000 },
    );
    assert.equal(inputWrite.isError, true);
    assert.match(
      inputWrite.content[0].text,
      /permitted|denied|Permission|Read-only/i,
    );
    assert.deepEqual(await fs.readFile(original.stl), inputBefore);
    const attacks = [
      "import socket\nsocket.create_connection(('192.0.2.1',443),timeout=1)",
      `from pathlib import Path\nPath(${JSON.stringify(original.stl)}).read_bytes()`,
      `from pathlib import Path\nPath(${JSON.stringify(path.join(dir, "outside.txt"))}).write_text('no')`,
      `from pathlib import Path\nlist(Path(${JSON.stringify(path.join(os.homedir(), ".ssh"))}).iterdir())`,
    ];
    for (let i = 0; i < attacks.length; i++) {
      const r = await c.callTool(
        {
          name: "cad_run",
          arguments: {
            script: "P={}\ndef build():\n return None\n" + attacks[i],
            output_dir: dir,
            name: "hostile" + i,
            timeout_ms: 180000,
          },
        },
        undefined,
        { timeout: 240000 },
      );
      assert.equal(r.isError, true, JSON.stringify(r));
      assert.match(
        r.content[0].text,
        /permitted|denied|reachable|Network|Permission/i,
      );
    }
    assert.equal(
      await fs.stat(path.join(dir, "outside.txt")).then(
        () => true,
        () => false,
      ),
      false,
    );
  },
);
