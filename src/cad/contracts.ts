import { CAD_REFUSAL_CODES } from "./refusal.js";
import { cadExampleLines } from "./examples.js";
/** cad/1 is an optional engine owned by the printer MCP. Readiness comes from cad_status, not the capability. */
export function cadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["0", "false", "off"].includes(
    env.CAD_ENABLED?.trim().toLowerCase() ?? "",
  );
}
export const CAD_CAPABILITY = {
  contract: "cad/1",
  status: "cad_status",
  setup: "cad_setup",
  run: "cad_run",
  checkFit: "cad_check_fit",
  examples: "cad_examples",
  prompt: "cad_design",
} as const;
const storage = {
  type: "object",
  properties: {
    expected_download_bytes: { type: "integer" },
    expected_installed_bytes: { type: "integer" },
    installed_bytes: { type: ["integer", "null"] },
    measurement: { type: "string", const: "allocated-last-setup" },
    measured_at: { type: "string" },
  },
  required: [
    "expected_download_bytes",
    "expected_installed_bytes",
    "installed_bytes",
    "measurement",
  ],
};
const status = {
  storage,
  configured: { type: "boolean" },
  ready: { type: "boolean" },
  python: { type: ["string", "null"] },
  build123d: { type: "string" },
  platform: { type: "string" },
  error: { type: "string" },
};
const failure = {
  type: "object",
  properties: {
    status: { type: "string", const: "error" },
    code: { type: "string", enum: [...CAD_REFUSAL_CODES] },
    message: { type: "string" },
    tool: { type: "string" },
    retryable: { type: "boolean" },
    suggestion: { type: "string" },
    storage,
  },
  required: ["status", "code", "message", "tool", "retryable", "suggestion"],
};
const output = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  anyOf: [{ type: "object", properties, required }, failure],
});
const timeout = {
  type: "integer",
  minimum: 100,
  maximum: 900000,
  description:
    "Total queue wait, preparation, execution and inspection deadline. Default 120000 ms; cancellation kills the dispatched process group.",
};
export const CAD_TOOLS = [
  {
    name: "cad_status",
    description:
      "Read the optional code-CAD runtime's last verified readiness and pinned version, without starting Python or installing anything.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
    outputSchema: output(status, [
      "configured",
      "ready",
      "python",
      "build123d",
      "platform",
      "storage",
    ]),
  },
  {
    name: "cad_setup",
    description:
      "Check the optional confined build123d runtime. With install: true, use uv to install pinned Python/packages in this MCP's data directory and prove a confined build plus STL/STEP round trip. On macOS, the data directory must be on an internal disk with file ownership enabled; external/network volumes are refused before installation. Native signatures are never modified. Never starts Blender, Fusion or a printer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        install: {
          type: "boolean",
          default: false,
          description:
            "Install and verify the pinned optional runtime; false only checks it.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: output(
      {
        ...status,
        supported: { type: "boolean" },
        installed: { type: "boolean" },
        message: { type: "string" },
      },
      ["supported", "configured", "ready", "storage"],
    ),
  },
  {
    name: "cad_run",
    description:
      "Build parametric CAD headlessly in OS confinement. Read cad_design first: declare literal P = {...} and build() returning a build123d Shape. Supply script OR script_path; parameters overrides saved named values in one call before derived dimensions. Calls wait for the environment’s exclusive execution slot up to their own deadline and report queue_wait_ms. Each call creates a private immutable subfolder under allowed output_dir, never overwriting previous artifacts. The saved .py and .parameters.json are the recovery checkpoint even after cancellation. Returns independently measured geometry, STL/STEP, six orthographic renders, a perspective view and a contact sheet; valid geometry is not a physical-fit or motion proof.",
    inputSchema: {
      type: "object" as const,
      properties: {
        inputs: {
          type: "array",
          maxItems: 16,
          items: {
            type: "object",
            properties: { name: { type: "string" }, path: { type: "string" } },
            required: ["name", "path"],
            additionalProperties: false,
          },
          description:
            "Explicit named files [{name, path}]. Content-addressed immutable input bundles are reused; snapshot_bytes_added/reused report storage. Only the selected declared bundle is exposed to build() as INPUTS[name]; nested path is declared for remote path policy.",
        },
        mode: {
          type: "string",
          enum: ["solid", "mesh"],
          default: "solid",
          description:
            "solid returns build123d B-rep with STL/STEP; mesh returns trimesh.Trimesh with STL and an explicit unavailable STEP.",
        },
        script: {
          type: "string",
          maxLength: 262144,
          description:
            "Python source declaring literal named P parameters and build() returning a Shape.",
        },
        script_path: {
          type: "string",
          description:
            "Allowed saved .py checkpoint to rebuild or edit instead of resending script.",
        },
        parameters: {
          type: "object",
          additionalProperties: true,
          description:
            "Overrides for names already declared in P; saved values are retained.",
        },
        output_dir: {
          type: "string",
          description:
            "Existing allowed directory; a unique immutable run subfolder is created beneath it.",
        },
        name: {
          type: "string",
          maxLength: 64,
          description:
            "Plain file stem for STL, STEP, Python and parameter artifacts.",
        },
        final: {
          type: "boolean",
          default: false,
          description:
            "Mark the selected result. The protected cad-result.json records this flag and all returned validation; select completed final records after restart and still inspect valid/checks.",
        },
        timeout_ms: timeout,
      },
      required: ["output_dir", "name"],
      additionalProperties: false,
    },
    outputSchema: output(
      {
        status: { type: "string", const: "completed" },
        final: { type: "boolean" },
        completed_at: { type: "string" },
        lineage_id: { type: "string" },
        result_manifest: { type: "string" },
        queue_wait_ms: { type: "integer" },
        snapshot_bytes_added: { type: "integer" },
        snapshot_bytes_reused: { type: "integer" },
        input_hashes: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        valid: { type: "boolean" },
        units: { const: "mm", type: "string" },
        script: { type: "string" },
        parameters: { type: "string" },
        stl: { type: "string" },
        step: { type: ["string", "null"] },
        step_unavailable: { type: "string" },
        inputs: { type: "object", additionalProperties: { type: "string" } },
        input_manifest: { type: "string" },
        bounds_mm: {
          type: "array",
          items: { type: "array", items: { type: "number" } },
        },
        size_mm: { type: "array", items: { type: "number" } },
        volume_mm3: { type: ["number", "null"] },
        step_volume_mm3: { type: ["number", "null"] },
        solid_count: { type: "integer" },
        mesh_components: { type: "integer" },
        checks: {
          type: "object",
          additionalProperties: { type: ["boolean", "null"] },
        },
        renders: { type: "object", additionalProperties: { type: "string" } },
        seconds: { type: "number" },
      },
      [
        "valid",
        "status",
        "final",
        "completed_at",
        "lineage_id",
        "result_manifest",
        "queue_wait_ms",
        "snapshot_bytes_added",
        "snapshot_bytes_reused",
        "script",
        "parameters",
        "stl",
        "step",
        "bounds_mm",
        "solid_count",
        "checks",
        "renders",
      ],
    ),
  },
  {
    name: "cad_examples",
    description:
      "The code engine's cookbook: worked build123d designs from simple to complex, each modelled on the best bought version of the thing, with its concept, published sizes and script. Without arguments, lists them (name, title, the pattern each shows, the product it is modelled on). With name, returns that example's record and full script to adapt. Read-only; starts no process.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "An example's name from the list; omit to list them.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: output(
      {
        examples: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              title: { type: "string" },
              pattern: { type: "string" },
              modelled_on: { type: "string" },
            },
            required: ["name", "title", "pattern"],
          },
        },
        usage: { type: "string" },
        name: { type: "string" },
        title: { type: "string" },
        pattern: { type: "string" },
        modelled_on: { type: "string" },
        published_sizes: { type: "string" },
        concept: { type: "string" },
        what_makes_this_good: { type: "string" },
        script: { type: "string" },
      },
      [],
    ),
  },
  {
    name: "cad_check_fit",
    description:
      "Check two allowed watertight manifold STL meshes in millimetres. Applies only the explicit rigid transform to reference: XYZ rotation in degrees about the origin, then translation. Never silently scales a scan. Reports Boolean interference volume and minimum surface gap (zero on contact/intersection), plus a clearance verdict; intentional support contact also has zero gap. Fails rather than guessing for open meshes or excessive triangle workload.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model: {
          type: "string",
          description: "Allowed watertight manifold model STL in millimetres.",
        },
        reference: {
          type: "string",
          description:
            "Allowed reference/scan STL in millimetres; never rescaled implicitly.",
        },
        transform: {
          type: "object",
          description:
            "Rigid transform applied only to reference: XYZ rotation about origin, then translation.",
          properties: {
            translation_mm: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 3,
            },
            rotation_deg: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 3,
            },
          },
          additionalProperties: false,
        },
        clearance_mm: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description:
            "Required global minimum surface gap; intentional support contact has zero gap.",
        },
        timeout_ms: timeout,
      },
      required: ["model", "reference"],
      additionalProperties: false,
    },
    outputSchema: output(
      {
        units: { type: "string", const: "mm" },
        interference_volume_mm3: { type: "number" },
        minimum_gap_mm: { type: "number" },
        clearance_mm: { type: "number" },
        clear: { type: "boolean" },
        transform: { type: "object" },
        method: { type: "string" },
        reference_rescaled: { type: "boolean", const: false },
      },
      [
        "interference_volume_mm3",
        "minimum_gap_mm",
        "clear",
        "transform",
        "reference_rescaled",
      ],
    ),
  },
];
export const CAD_DESIGN_PROMPT = {
  name: "cad_design",
  title: "Parametric code-CAD design",
  description:
    "MCP-owned rules for headless build123d designs and one-call parameter revisions.",
  text: `Use code-CAD for dimensioned functional designs and parameter edits. Build in millimetres with build123d 0.13.0; the MCP owns the Python environment, execution, export, validation and rendering. Check cad_status and use cad_setup with install: true when needed. No Blender, Fusion, network or printer access is available to your script.
Form first: build the product's shape, not a profile pushed up. Before any geometry, write the concept in a few lines: the bought product you are following, its mechanism, the load path, the print orientation and why. build123d has loft (through sections of different shape), sweep (a section along a path or a Helix), revolve, fillet, chamfer, offset and shell as well as extrude; use the one the product's surface calls for: lofted where a hand closes round it, revolved where it turns, swept where it runs like a bent rod or a thread, filleted where two surfaces meet under load. Extrude a flat profile only for something that really is a plate or a lever, or for a print-in-place mechanism or spring that must lie in the layers, and say that reason in the result. Choose the print orientation after the form: split a part, turn it or accept a modest support before flattening its design.
Worked examples: cad_examples lists this engine's cookbook (each modelled on a bought product, with its concept, published sizes and script) and returns one script by name. When the request works like one of these, read that example first and adapt its pattern, never its sizes:
${cadExampleLines()}
What the cookbook taught about this engine: return several bodies as Compound([a, b]); bodies that touch or overlap come back invalid, so leave a real gap (0.2 mm or more) or union them, and check that solid_count equals the bodies you intend (for a print-in-place mechanism that count is the first evidence nothing fused). fillet() often fails on the edges of an outline unioned from many curves, where chamfer() usually succeeds: fillet or chamfer simple bodies before the booleans that complicate them, and when a chamfer fails too, apply it to the plain body and union the details on afterwards. Do not round a sketch by growing and shrinking it with offset(): the solid looks right and its STEP comes back with no solids (the step_solids check fails). A whole Sphere() exports open at its poles: trim them (Sphere(r) & Box(2 * r, 2 * r, 2 * r - 0.1)). One fillet of the same radius over every edge of a box can export open: fillet in two passes with different radii. A model with moving parts takes a pose parameter: the assembled pose to judge it, the print plate to make it.
Declare exactly one top-level P = {...} dictionary of JSON-compatible literal named parameters. Put every functional dimension in P; derive geometry from P. Define build() to return a build123d Shape or Compound of disjoint solid parts. Do not put construction or exports in a __main__ block: cad_run calls build() and exports the result. Imports, functions and derived P entries are fine. Parameters are applied to the literal defaults before derived expressions execute. For solid designs without inputs, the script and parameters file alone reconstruct it. For input-dependent designs, declare inputs as an array of {name, path} files: cad_run snapshots only those allowed files, exposes INPUTS[alias] to your script, and saves an inputs manifest. Retain the snapshots too for recovery; subsequent script_path edits reuse them unless inputs is explicitly supplied. No other personal files are readable. For a mesh-only experiment use mode: "mesh" and return a trimesh.Trimesh from build(); it exports and checks STL plus the same renders, with step: null and an explicit reason. It does not manufacture a fake parametric STEP or promise scan-cleanup capability.
Call cad_run with script, output_dir and a plain name. It saves <name>.py and <name>.parameters.json before running, then exports <name>.stl and <name>.step in a fresh subfolder. For an edit, one cad_run with script_path pointing to the earlier .py, parameters containing just the changed dimension, output_dir and name regenerates it without resending the script. Existing parameter values are retained; unknown names and type changes are refused. A killed run can be retried from its checkpoint in a new workspace; mutations are never replayed automatically.
Captured mesh preparation: load_scan(name, source_units="m" or "mm", up_axis="x"|"-x"|"y"|"-y"|"z"|"-z", ground=True) is provided to build(). Name must be a declared input. Declare source units and the object's usage-up axis explicitly: the helper converts metres to millimetres, applies a rigid up-axis rotation and translates the lowest Z to zero; it never guesses scale or fits to calipers. Geometry/texture references must be declared inputs too; snapshots preserve distinct original filenames. Exports must be millimetres, Z up, in the orientation the object is used.
Fit reference workflow: return load_scan("scan", source_units="m", up_axis="y") from build() in mode: "mesh" to export an unchanged, prepared reference STL for cad_check_fit. Declare every linked OBJ/MTL/texture asset. If you crop, simplify, fill, or otherwise alter this reference, report exactly what you excluded/changed and that the fit check proves only that reduced reference in the stated pose. A fit check against a scan is information; it must never resize or override an interface specified by measured dimensions. Keep those measured interfaces and report the discrepancy.
Result selection and edits: set final: true only on the result you select. cad-result.json in each immediate run folder is protected from script writes and retains final, completed_at, lineage_id (source hash), full checks and artifact paths; clients can discover the latest completed final record after restart without rebuilding. Final is a selection marker, not a replacement for valid/checks. Queued calls may expire with cad-queue-timeout before dispatch; do not automatically replay. Unchanged declared files reuse a read-only content-addressed bundle under output_dir/.cad-inputs, preserving filenames and restricting reads to that bundle. Keep this shared cache with the saved runs.
Mesh cleanup workflow: return a trimesh.Trimesh in mode: "mesh". Load the prepared mesh, fit needed geometry with NumPy/SciPy, rebuild regular sections/features with build123d or manifold3d CrossSection/extrusion/revolve, and combine meshes with manifold3d booleans. scikit-image supplies marching cubes for voxel/SDF work; Shapely supplies planar operations; Pillow supplies image/texture reads. Keep numeric choices in P and regenerate from declared inputs. Validate closure, winding, manifold status, dimensions and all six views using cad_run. What to regularise, infer, preserve or label comes from the caller's cleanup rules, not this engine prompt.
The result includes paths, millimetre bounds/size, mesh and STEP volumes, solid count, watertight/manifold/winding/STEP checks, six orthographic renders (front, back, left, right, top, bottom), a perspective view from the front right and above, and a contact sheet with the perspective view large beside the six. Judge the form from the perspective view first: would a person recognise the product and want it? Then inspect all six; revise visible defects. A valid mesh or nominal parameter does not prove the requested dimension: measure the actual exported interfaces. Use cad_check_fit on a model and reference STL with an explicit rigid transform; report raw-scan interference and minimum gap. Calipers are authoritative but disagreement with a scan is unresolved measurement evidence, not permission to silently rescale it. Check assembly/insertion paths and actual articulated poses, not sums of local joint limits or reference points alone. Printing, clearance under load, supports and motion need separate evidence.
Fit, flexure and thread parameters: put each interface's nominal size, its source (measured, published, or assumed), the print correction, and the design fit in P as separate named values, so a fit report revises one number without resending the script. Model every dimension you claim: a parameter the geometry never uses (a wallet or case width that no cut or wall reads) is a defect; use it or remove it. Shape flexures so their bending lies in the layer plane of the exported print orientation, with the stroke, preload, and hard-stop gap as P values; build the stopped pose as well as the rest pose when checking. Model printed threads as explicit coarse geometry with the same pitch on both sides and clearance as a radial P offset; never scale a screw to clear its hole.
Check insertion and articulated poses with cad_check_fit against each object state that matters (the bare product, the product in its case, and the case with its attachment as its own reference envelope), including the widest section on the way in. Report interference and minimum gap per state. In your summary, attach each "fits", "holds", and "prints without supports" claim to the check or slice number that shows it; a valid flag alone shows none of them. Apply fdm_design and fdm_slicing too. When a part meets a real object apply fdm_fit, and when it flexes, grips, snaps or springs apply fdm_flexures: if they were not attached, read them with the design_guidance tool before choosing that fit or spring. Never invoke a printer as part of constructing CAD.`,
};
