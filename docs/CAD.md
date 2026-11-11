# Optional code-CAD engine

Code-CAD makes dimensioned functional parts without starting a design app. It uses build123d 0.13.0 (OpenCascade), with pinned trimesh, Manifold3D and Pillow for mesh checks and rendering. Blender and Fusion integrations remain available and unchanged. The same environment supports captured-mesh scripts. A separate prototype completed three cleanup workers in roughly 350–380 seconds with closed/manifold, byte-reproducible output scripts; its organic comparison used different rules, so this is not a universal quality/speed claim. This release supplies the libraries and coordinate preparation, not cleanup policy or algorithms.

A local prototype made a holder cavity at 65.800 × 28.800 mm, performed an exact +1 mm height edit in 137 seconds, and produced a valid articulated-unicorn mesh and STEP in 657 seconds after two historical Blender attempts timed out at 901 seconds with no model. The unicorn had actual endpoint errors and joint collisions in a claimed pose; the holders met calipers but collided with the inflated raw scan. Initial holder worker passes took 238–893 seconds, including the cold native-import stall; code-CAD is not uniformly fast. The sample is small, the environments differed, and no physical print or fit was verified. These results justify an optional tool for measured parts, not a promise that every design works.

## Leave it out or remove it

Nothing downloads or runs Python merely because this MCP is installed. `cad_setup` without arguments checks only; installation requires `{"install":true}`.

Set **`CAD_ENABLED=0`** in the MCP's environment and restart it to leave the engine out. No `cad_*` tools, `cad_design` prompt or `capabilities.cad` are registered. This does not disable printing, mesh tools, Blender or Fusion, and does not remove files.

To remove a downloaded runtime, first stop MCP instances using it, then move its CAD data folder to Trash with your file manager:

- macOS: `~/Library/Application Support/mcp-3d-printer-server/cad`.
- Linux: `${XDG_DATA_HOME:-~/.local/share}/mcp-3d-printer-server/cad`.
- A custom **`CAD_DATA_DIR`** replaces that location; remove that folder instead.

This folder contains the private Python environment, managed interpreter, package cache and setup/fit working files. Saved designs are under the `output_dir` chosen for `cad_run`, so removing the environment leaves those outputs alone. Keep input snapshots with a saved input-dependent design. Re-enable by removing `CAD_ENABLED=0`, restarting the MCP and running setup again when you want it.

Allow about **1.5 GiB**, including the download cache; platform wheels and cache state affect the exact size. Set `CAD_DATA_DIR` to a different private folder **before** setup if needed. On macOS it must be on an internal disk with file ownership enabled; USB/external and network volumes are refused. If internal space is tight, leave this engine disabled. Cache and temporary installer files stay under that data folder, not the system temporary directory. `uv` must already be on the MCP's PATH. Setup downloads a managed Python 3.12 and only binary wheels from the complete pins shipped in `src/cad/requirements.lock`; it never uses the system/site Python environment or passes printer/provider credentials to subprocesses.

## Readiness and isolation

`cad_status` returns `{configured, ready, python, build123d, platform, error?}` from local files and a verification marker; it starts no process. Readiness means the installed runtime last passed the setup checks for these bundled helpers/pins, not that arbitrary generated CAD is correct. A changed helper or lock file, or moving the runtime to a different filesystem, requires verification again.

`cad_setup {install:true}` serializes against other CAD operations, checks supported storage, installs or synchronizes the private environment, verifies imports, then performs a confined build and STL/STEP round trip and denial probes. Native files are never re-signed. On macOS, setup checks that the data volume is internal and has file ownership enabled before downloading anything. The observed stalls occurred on an external USB APFS volume mounted `noowners,nosuid`; a fresh internal-disk environment completed setup in 56.88 seconds with the full CAD/cleanup pins (first import 28.08 seconds, confined smoke 15.07 seconds; an earlier smaller environment took 39.30 seconds), without signature or provenance changes. This storage comparison does not prove every external drive is affected, but only the internal configuration has acceptance evidence. Import and smoke deadlines remain bounded; a failure leaves readiness false and reports its cause.

- **macOS:** Seatbelt (`sandbox-exec`) denies network, Apple events, Mach service lookup, other-process inspection/environment reads, signals, hard links and process forking. Personal home, volume and temporary data (including macOS Data-volume aliases) are unreadable except the private environment, bundled helpers, this job and explicit input snapshots. Public OS runtime files remain readable. Only the job folder is writable; source, parameters, request and input snapshots are protected read-only.
- **Linux:** `bubblewrap` (`bwrap`) creates fresh user, mount, PID and network namespaces with an empty filesystem, read-only system/runtime mounts, only the job writable, and protected checkpoints/input mounts. Install bubblewrap with your distribution's package manager. If user namespaces or bubblewrap are missing/blocked, setup/run fails closed; it never retries unconfined. Network namespace isolation prevents reaching the host/network; it is not a general seccomp syscall filter.
- Other platforms fail closed. No Windows confinement is implemented.

Subprocesses have wall deadlines, bounded diagnostics, inherited-hard-limit-aware CPU/file/descriptor caps (plus an address-space cap on Linux; macOS does not support the finite data-memory limit used on other hosts), and cancellation kills their dispatched process group. CAD code is not allowed to spawn other applications on macOS; Linux descendants stay in the PID namespace. An engine-valid model is not a print-safety approval: printer operations retain their existing gates.

## Output and input paths

By default CAD outputs and selected inputs must be under this MCP instance's `TEMP_DIR`, the root already used for generated STL files. Additional roots are trusted configuration **`CAD_OUTPUT_DIRS`**, separated by `:` on macOS/Linux. Calls cannot add roots or executables. Paths are canonicalized; a symlink that leaves the roots is refused. The caller supplies an existing output directory, and each run creates a private unique child folder there. Repeating a call never overwrites an earlier output. The automatically created default `TEMP_DIR` uses the system temporary area; this server leaves it on exit, and the system may reclaim it. For checkpoints and renders that must survive an MCP restart, configure a persistent `TEMP_DIR` or `CAD_OUTPUT_DIRS` and choose an `output_dir` there. A configured `TEMP_DIR` is retained. This follows the existing STL storage policy; the environment and saved designs have separate lifetimes.

Inputs are an explicit array of `{name, path}` entries with up to 16 local regular files, at most 64 MiB each / 256 MiB total. The MCP snapshots them into the job's read-only `inputs/` folder. Scripts use `INPUTS["alias"]`; original user files and unrelated home files are not exposed. A path allowed by this MCP may still be refused by a remote client's narrower path policy.

## Script and edit contract

```python
from build123d import Box
P = {"width": 65.8, "depth": 28.8, "height": 70.0}

def build():
    return Box(P["width"], P["depth"], P["height"])
```

Declare exactly one top-level literal `P = {...}` dictionary of named JSON-compatible values. The MCP validates overrides against those names and types, substitutes effective values **before** derived expressions run, and invokes `build()`; it does not run a `__main__` export block. Functional dimensions belong in P. Unknown names, nonfinite values, excessive parameters and scalar/container type changes fail before user code executes. This intentionally narrower contract makes a parameter edit and recovery reproducible.

```json
{"script":"...source above...","output_dir":"/allowed/designs","name":"bracket"}
```

A solid `build()` returns a valid build123d Shape or Compound. `cad_run` exports `<name>.stl` and `<name>.step`, then a **separate trusted process** checks them and renders front/back/left/right/top/bottom, a perspective view (`perspective`: three-quarter, from the front right and above, depth-buffered and smooth-shaded; it adds about half a second to a second per run) and a contact sheet with the perspective view large beside the six. Model stdout is diagnostic text, never the validation receipt. The result includes paths, bounds/size in millimetres, STL/STEP volume, solid/component counts, and watertight/manifold/winding/STEP checks. `valid` describes geometry checks, not compliance with a user's request. Judge the form from the perspective view, inspect the six orthographic views, and measure actual interfaces, assembly paths and articulated poses. A solid result whose STEP holds no solid body fails the `step_solids` check.

For the next change, send just the saved script path and changed parameters:

```json
{"script_path":"/allowed/designs/cad-bracket-.../bracket.py","parameters":{"height":71.0},"output_dir":"/allowed/designs","name":"bracket-revised"}
```

The earlier parameter file is merged, preserving other choices. The source and effective parameters are saved **before execution**; on a timeout/cancellation the error gives checkpoint paths. For a solid design without inputs, those two files are enough to recover with another `cad_run`. Input-dependent designs also need their saved input snapshots and `<name>.inputs.json`; script-path edits reuse those snapshots by default, or `inputs` can explicitly replace them. There is no automatic replay of interrupted execution.

## Worked examples

`cad_examples` lists the engine's cookbook and returns one script by name; `cad_design` names each in a line. Every example is modelled on a bought product, cites the published sizes it used, states its concept (what it is for, the mechanism, the load path, the print orientation and why) and comes back `valid` from `cad_run` with the number of bodies its concept names. The scripts live in `src/cad/examples/`; `tests/cad-examples.test.mjs` checks each record and, with `CAD_E2E_DATA_DIR` set, builds every one through `cad_run`. They are patterns to adapt, not sizes to reuse.

On Linux the sandbox's own root is mounted read-only (`--remount-ro /`), so only the run's job folder and `/tmp` take writes; bubblewrap 0.11 otherwise leaves the folders above each bind writable inside the sandbox, and setup's forbidden-write proof fails.

## Mesh experiments in the same environment

```python
import trimesh
P = {"lift_mm": 1.0}

def build():
    scan = trimesh.load(INPUTS["scan"], force="mesh")
    scan.apply_translation([0, 0, P["lift_mm"]])
    return scan
```

Call with `mode: "mesh"` and `inputs: [{"name": "scan", "path": "/allowed/scan.stl"}]`. A mesh-mode `build()` returns `trimesh.Trimesh`; the MCP exports STL, independently checks it and creates the same renders. It reports **`step: null`** with `step_unavailable`, since a mesh edit has no parametric B-rep. It does not create a misleading faceted STEP. STEP-specific checks/volume are null, and `valid` refers to the mesh checks. This input/mesh path runs cleanup scripts without embedding regularization or inference policy in the MCP.

## Scan fit

`cad_check_fit` takes `model`, `reference`, optional `transform: {rotation_deg:[x,y,z], translation_mm:[x,y,z]}`, optional `clearance_mm` and a deadline. XYZ rotations are about the origin, followed by translation, applied only to the reference. Scaling is not supported implicitly or through the transform.

It returns Manifold3D float32 Boolean interference volume and float64 minimum triangle-surface distance, including vertex/face and edge/edge minima, with AABB pruning. Gap is zero at contact or overlap; the `clear` verdict requires no interference and at least the requested global gap. A bottle resting on a holder floor therefore has zero global gap even if side clearance is correct. Measure a selected interface separately when that distinction matters.

Both meshes must be positively wound, watertight and manifold. It refuses unsupported meshes or workloads above 250,000 triangles per mesh / ten million candidate triangle pairs rather than guessing. Single-pose results do not establish a continuous insertion path or articulation. Calipers and scans can disagree: report both measurements, never silently resize the reference to manufacture a fit.


## Captured scan coordinates

Inside build(), use `load_scan("scan", source_units="m", up_axis="y")` for a declared metre/Y-up capture. Units must explicitly be `m` or `mm`; up_axis is the object's usage-up direction in the source frame (`x`, `-x`, `y`, `-y`, `z`, `-z`). The helper returns a trimesh mesh in millimetres, Z up, with its lowest Z translated to 0 by default (`ground=False` preserves height). It preserves real size: the only scale is the declared unit conversion, followed by the smallest rigid rotation from the declared up axis and translation; there is no guessed scale or fit-to-calipers. Inspect the size and orientation before rebuilding. Exports are millimetres, Z up, in the orientation the object is used.

Snapshots preserve distinct original filenames so flat OBJ/MTL/texture references can resolve among declared files. Declare every referenced asset; undeclared absolute files and network resources remain blocked. Duplicate original filenames are refused instead of overwriting an input. For subdirectory references, construct the resolver from the declared INPUTS explicitly. Mesh visuals remain available during script work; STL output carries geometry only.

## Library licences

The runtime includes the following direct libraries. Transitive dependencies keep their own wheel notices; this is not a claim that every bundled component has the same licence.

| Library | Pin | Project licence |
|---|---|---|
| build123d |0.13.0| Apache-2.0 |
| NumPy |2.5.4| BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 (metadata expression) |
| SciPy |1.18.1| BSD-3-Clause; bundled third-party notices also apply |
| trimesh |5.2.0| MIT |
| manifold3d |3.5.4| Apache-2.0 |
| scikit-image |0.26.0| BSD-3-Clause with bundled notices |
| Pillow |13.0.0| MIT-CMU (HPND) |
| Shapely |2.1.2| BSD-3-Clause |
| Rtree (proximity checks) |1.4.1| MIT |

The OCP wrapper is Apache-2.0; its OpenCascade kernel is LGPL-2.1 with the OCCT exception. Shapely's GEOS is LGPL-2.1. Preserve those notices and exceptions when distributing native components. Sources: [build123d](https://pypi.org/project/build123d/0.13.0/), [NumPy](https://pypi.org/project/numpy/2.5.4/), [SciPy](https://pypi.org/project/scipy/1.18.1/), [trimesh](https://pypi.org/project/trimesh/5.2.0/), [Manifold](https://github.com/elalish/manifold/blob/master/LICENSE), [scikit-image](https://pypi.org/project/scikit-image/0.26.0/), [Pillow](https://pypi.org/project/pillow/13.0.0/), [Shapely/GEOS](https://pypi.org/project/shapely/2.1.2/), [Rtree](https://pypi.org/project/rtree/1.4.1/), [OCCT](https://dev.opencascade.org/resources/licensing). Neither pymeshlab, Open3D nor bpy is installed.

## Sizes and stable failures

`storage.expected_download_bytes` and `expected_installed_bytes` are maintained budget estimates for a fresh pinned installation: currently 350 MiB download and 1.5 GiB installed, including managed Python and retained uv cache. Platform wheels and existing caches change the actual transfer/footprint. After setup, `storage.installed_bytes` reports allocated filesystem bytes of runtime/python/cache, deduplicating hardlinks and not following symlinks. It excludes scan inputs, models and working files. `measured_at` records the measurement; `measurement: "allocated-last-setup"` makes clear that fast status reads the cached value, with no Python/du process or recursive walk. Null means an existing environment has not yet been measured; zero means no environment is present.

All CAD failures use the normal tool refusal envelope: `isError: true`, with `structuredContent: {status:"error", code, message, tool, retryable:false, suggestion, storage}`. The output schema explicitly accepts this failure shape. Display the provided sentence/suggestion and carry the code; never match wording. Known conditions:

| Code | Condition |
|---|---|
| `cad-uv-missing` | uv is absent from the MCP's PATH |
| `cad-data-volume-refused` | macOS storage is external/network/ownership-disabled or cannot be verified |
| `cad-setup-busy` | setup was not dispatched because another operation is running/queued |
| `cad-operation-busy` | a fit check was not dispatched because the environment is busy |
| `cad-queue-timeout` | a run's deadline expired before dispatch |
| `cad-not-ready` | setup verification is required |
| `cad-confinement-unavailable` | unsupported execution platform |
| `cad-disabled` | the family is disabled |
| `cad-failed` | other argument/build/validation failure; the message carries detail |

## Queue, selection and input storage

One operation executes per data directory. Runs queue using filesystem tickets (including across MCP processes), wait within their own total timeout, support cancellation, and report `queue_wait_ms`. Timeout covers queue, preparation, build and inspection; `seconds` still measures build/inspection separately. Setup and fit checks refuse busy operations. Nothing automatically replays a request. A timeout/cancel before dispatch creates no build; a dispatched run retains its source/parameter checkpoint.

Every run has `cad-result.json`, created before user code and protected by confinement. It moves atomically from pending to completed with the complete returned receipt: final flag, completed timestamp, lineage/source hash, bounds, volume, solid count, checks and render/artifact paths. Failed builds record failed/final:false. `final:true` is explicit selection, not a guarantee of requested fit or geometric validity. After restart, enumerate only immediate `cad-*` run folders and read their `cad-result.json`; select the latest completed final record for the design, inspect valid/checks, and do not rebuild to recover its validation. The lineage identifier is the saved source's SHA-256, unchanged by parameter overrides.

Input snapshots now live in output-root `.cad-inputs/<content-set-hash>/` bundles, outside the writable run folder. A bundle contains exactly the declared files and preserves their basenames for linked assets. Source and cached content are hashed; unchanged bundles are reused, including a saved script's inputs across output directories when those paths remain allowed. A private data-directory index accelerates locating existing bundles. Only the selected bundle is exposed read-only to Python; other bundles and undeclared originals remain unreadable. Changing the selected file set creates a separate bundle so undeclared assets are never exposed. Results report added/reused snapshot bytes and per-alias hashes.

Keep the shared bundles referenced by `.inputs.json` alongside retained designs; deleting one run does not delete shared inputs. Delete an input bundle only when no saved run references it. Removing the runtime leaves those output-root bundles and saved runs intact. The data directory may be explicitly shared between identical CAD builds/pins; readiness fingerprints include the actual compiled helpers, so mismatched builds require verification. Defaults remain package-owned separate directories.

## Openings and scan fit references

Six orthographic views use deterministic bounded depth shading plus boundary/crease/silhouette edges. True through-holes show the background; a window backed by another wall gains depth contrast and edges. Coplanar triangulation diagonals are not drawn. This stays a lightweight preview with approximate painter ordering, not a photoreal or self-intersection proof.

To prepare a fit reference, return `load_scan("scan", source_units="m", up_axis="y")` from build() in mesh mode, declaring all linked scan assets. cad_run exports the prepared reference STL in millimetres/Z-up without changing physical size. If you crop, simplify, fill or otherwise alter the reference, disclose exactly what changed and that the fit result covers only that reference and stated pose. A scan fit check is information; it must never resize an interface defined by measured dimensions. Preserve those measured interfaces and report a scan discrepancy.
