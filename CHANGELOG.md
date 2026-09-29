# Changelog

## Unreleased

- Slicing:
  - Resolve BambuStudio, OrcaSlicer, and FULU OrcaSlicer-bambulab CLI profiles
    before slicing. The exact model/nozzle machine preset must exist in the
    selected installation, `inherits` and `include` chains are flattened, and
    the model's `cli_config.json` entry is validated. A raw inherited preset
    such as P1S 0.4 is no longer passed to BambuStudio, which rejected it with
    exit 239 ("process not compatible with printer").
  - Stop before running the slicer on missing presets, wrong nozzle sizes,
    missing parents or includes, cycles, malformed profiles, missing process
    or filament files, and machine/process lists in `slicer_profile`.
  - Report slicer failures with the exit code or signal, timeout state, and
    stdout/stderr tails, plus slicer-specific suggestions instead of printer
    connectivity advice.
  - Require a nonempty `Metadata/plate_<n>.gcode` in Bambu-compatible output.
    A checksum-only archive, missing output, or stale file from an earlier run
    is an error.
  - Drop machine settings carried by process or filament files, including
    template 3MF project settings exported for another printer, so they
    cannot replace the selected preset's start G-code.
  - Add `bed_type`, `load_filaments`, `load_filament_ids`, `filament_colours`,
    template selection, and the Bambu CLI placement and transform options to
    `slice_stl`. Slicing accepts `p2s`, `h2s`, and `h2c` when the installed
    slicer includes those presets. Generic OrcaSlicer keeps its
    `machine;process|filament` path unless the call passes `bambu_model`.
  - Add `slice_with_template`, `list_templates`, `save_template`, and
    `get_slice_settings` for a local template registry (`BAMBU_TEMPLATE_DIR`).
  - Add `BAMBU_PROFILES_ROOT`, `BAMBU_SLICER_PROFILE_DIRS`,
    `BAMBU_TEMPLATE_DIR`, and `BAMBU_TEMPLATE_3MF_PATH` configuration.

## 1.2.9

- Address Bambu FTPS upload failures reported in #22 by using TLS 1.2 control
  and data channels with explicit host identity and verified session reuse,
  including the Node 22/24 wrapped-socket session regression. Physical X1C firmware
  confirmation remains outstanding; no printer commands were sent in testing.
- Port standard Blender MCP discovery, tool forwarding, and verified STL edit
  support from the Bambu fork. Preserve this server's legacy shell/stdin bridge.
- Validate binary STL edits in bounded memory and cap ASCII inputs at 4 MiB.
- Apply edit deadlines and cancellation to STL validation as well as MCP calls.
- Require the Bambu model on raw print starts and upload-with-print, matching
  the fork's safety checks. Keep uploads without printing available.
- Isolate server and inline-upload scratch paths to prevent filename traversal
  and collisions from overwriting or deleting unrelated files.
- Refresh vulnerable dependencies, pin the supported bambu-node API version,
  declare the TypeScript build dependency, build before npm packing, and report
  the actual package version during MCP initialization.
- Keep generated dist files out of Git and validate clean builds, protocols,
  package installation, and Docker builds in CI.
