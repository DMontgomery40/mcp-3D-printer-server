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
  prompt: "cad_design",
} as const;
const status = {
  configured: { type: "boolean" },
  ready: { type: "boolean" },
  python: { type: ["string", "null"] },
  build123d: { type: "string" },
  platform: { type: "string" },
  error: { type: "string" },
};
const output = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
});
const timeout = {
  type: "integer",
  minimum: 100,
  maximum: 900000,
  description:
    "Total execution plus inspection deadline. Default 120000 ms; cancellation kills the dispatched process group.",
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
      ["supported", "configured", "ready"],
    ),
  },
  {
    name: "cad_run",
    description:
      "Build parametric CAD headlessly in OS confinement. Read cad_design first: declare literal P = {...} and build() returning a build123d Shape. Supply script OR script_path; parameters overrides saved named values in one call before derived dimensions. Each call creates a private immutable subfolder under allowed output_dir, never overwriting previous artifacts. The saved .py and .parameters.json are the recovery checkpoint even after cancellation. Returns independently measured geometry, STL/STEP, six renders and a contact sheet; valid geometry is not a physical-fit or motion proof.",
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
            "Explicit named files [{name, path}]. Immutable snapshots are exposed to build() as INPUTS[name]; nested path is declared for remote path policy.",
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
        timeout_ms: timeout,
      },
      required: ["output_dir", "name"],
      additionalProperties: false,
    },
    outputSchema: output(
      {
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
Declare exactly one top-level P = {...} dictionary of JSON-compatible literal named parameters. Put every functional dimension in P; derive geometry from P. Define build() to return a build123d Shape or Compound of disjoint solid parts. Do not put construction or exports in a __main__ block: cad_run calls build() and exports the result. Imports, functions and derived P entries are fine. Parameters are applied to the literal defaults before derived expressions execute. For solid designs without inputs, the script and parameters file alone reconstruct it. For input-dependent designs, declare inputs as an array of {name, path} files: cad_run snapshots only those allowed files, exposes INPUTS[alias] to your script, and saves an inputs manifest. Retain the snapshots too for recovery; subsequent script_path edits reuse them unless inputs is explicitly supplied. No other personal files are readable. For a mesh-only experiment use mode: "mesh" and return a trimesh.Trimesh from build(); it exports and checks STL plus six renders, with step: null and an explicit reason. It does not manufacture a fake parametric STEP or promise scan-cleanup capability.
Call cad_run with script, output_dir and a plain name. It saves <name>.py and <name>.parameters.json before running, then exports <name>.stl and <name>.step in a fresh subfolder. For an edit, one cad_run with script_path pointing to the earlier .py, parameters containing just the changed dimension, output_dir and name regenerates it without resending the script. Existing parameter values are retained; unknown names and type changes are refused. A killed run can be retried from its checkpoint in a new workspace; mutations are never replayed automatically.
Captured mesh preparation: load_scan(name, source_units="m" or "mm", up_axis="x"|"-x"|"y"|"-y"|"z"|"-z", ground=True) is provided to build(). Name must be a declared input. Declare source units and the object's usage-up axis explicitly: the helper converts metres to millimetres, applies a rigid up-axis rotation and translates the lowest Z to zero; it never guesses scale or fits to calipers. Geometry/texture references must be declared inputs too; snapshots preserve distinct original filenames. Exports must be millimetres, Z up, in the orientation the object is used.
Mesh cleanup workflow: return a trimesh.Trimesh in mode: "mesh". Load the prepared mesh, fit needed geometry with NumPy/SciPy, rebuild regular sections/features with build123d or manifold3d CrossSection/extrusion/revolve, and combine meshes with manifold3d booleans. scikit-image supplies marching cubes for voxel/SDF work; Shapely supplies planar operations; Pillow supplies image/texture reads. Keep numeric choices in P and regenerate from declared inputs. Validate closure, winding, manifold status, dimensions and all six views using cad_run. What to regularise, infer, preserve or label comes from the caller's cleanup rules, not this engine prompt.
The result includes paths, millimetre bounds/size, mesh and STEP volumes, solid count, watertight/manifold/winding/STEP checks, six orthographic renders (front, back, left, right, top, bottom) and contact sheet. Inspect all six; revise visible defects. A valid mesh or nominal parameter does not prove the requested dimension: measure the actual exported interfaces. Use cad_check_fit on a model and reference STL with an explicit rigid transform; report raw-scan interference and minimum gap. Calipers are authoritative but disagreement with a scan is unresolved measurement evidence, not permission to silently rescale it. Check assembly/insertion paths and actual articulated poses, not sums of local joint limits or reference points alone. Printing, clearance under load, supports and motion need separate evidence. Apply fdm_design and fdm_slicing too; never invoke a printer as part of constructing CAD.`,
};
