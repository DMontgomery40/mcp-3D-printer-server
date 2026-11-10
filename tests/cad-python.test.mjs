import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const worker = fileURLToPath(new URL("../src/cad/worker.py", import.meta.url));
const python = process.platform === "win32" ? "python" : "python3";
const optionalPython = {
  skip:
    process.platform === "win32" ||
    spawnSync(python, ["--version"], { timeout: 10000 }).status !== 0
      ? "requires an existing POSIX Python for stdlib helper tests"
      : false,
};
function run(body) {
  const r = spawnSync(
    python,
    [
      "-I",
      "-c",
      `import runpy,ast,json,resource\nm=runpy.run_path(${JSON.stringify(worker)})\n${body}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
test(
  "parameter overrides apply before derived expressions, with unknown names rejected",
  optionalPython,
  () => {
    const value = run(
      `tree,node,p=m['parameters']("P={'width':10.0}\\nP['twice']=P['width']*2",{'width':11})\nnode.value=ast.Name(id='params',ctx=ast.Load());ast.fix_missing_locations(tree)\nn={'params':p};exec(compile(tree,'test','exec'),n);assert n['P']['twice']==22\ntry: m['parameters']("P={'width':10}",{'typo':1})\nexcept ValueError: pass\nelse: raise AssertionError('unknown override was accepted')\nprint('ok')`,
    );
    assert.match(value, /ok/);
  },
);
test(
  "CAD resource caps never try to raise an inherited hard limit",
  optionalPython,
  () => {
    run(
      `caps=[]\nresource.getrlimit=lambda kind:(100,100)\nresource.setrlimit=lambda kind,pair:caps.append(pair)\nm['limits']()\nassert all(soft<=100 and hard<=100 for soft,hard in caps),caps`,
    );
  },
);

test(
  "Darwin does not apply unsupported RLIMIT_DATA memory limits",
  optionalPython,
  () => {
    run(
      `m['limits'].__globals__['sys'].platform='darwin'\nresource.getrlimit=lambda kind:(100,100)\ndef set_limit(kind,pair):\n if kind==resource.RLIMIT_DATA: raise ValueError('unsupported finite DATA limit')\nresource.setrlimit=set_limit\nm['limits']()`,
    );
  },
);
