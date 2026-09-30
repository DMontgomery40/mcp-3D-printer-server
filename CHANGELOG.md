# Changelog

## Unreleased

### Fixed

- Keep the server alive and answer `get_printer_status` for Bambu printers that
  broadcast reports but do not answer bambu-node's initial request (seen on two
  X1 Carbons on firmware 01.07 in LAN Only Mode; the cause is unknown, and
  Developer Mode does not exist on that firmware). The unanswered request used to become an unhandled rejection that
  terminated the server, and bambu-node's `connect()` never resolved, which
  also hung every concurrent caller. The client now proceeds 8 s after the MQTT
  session is up, concurrent callers share that bounded wait, a failed or late
  connection is evicted, and `get_printer_status` returns the latest broadcast
  report with `commandsAnswered: false` and a LAN Only Mode / Developer Mode hint when its own
  status request also goes unanswered. Evidence: a stub MQTT client for the
  crash and its guard, and read-only status calls (three concurrent) against two
  real X1 Carbons on 2026-09-30; no print, heating or motion command was sent.
  The guard ignores any unawaited bambu-node command timeout, not only the
  initial one.

## 1.2.10

### Safety

- Port the bambu-printer-mcp print safety gate to every Bambu print and heat
  route (print_3mf, start_print, upload_gcode with print, process_and_print_stl,
  set_printer_temperature). Each route inspects a private snapshot of the exact
  selected plate or G-code (every S/R heater target and tool change), enforces
  per-model hardware and declared-material ceilings, and checks a fresh MQTT
  report of the printer's model, serial, nozzle, state, errors and loaded
  filament before, after the human confirmation and again before dispatch.
- Ask a human through MCP elicitation before every print start and positive
  heating command. PRINT_REQUIRE_CONFIRMATION=0 (all printers) or
  BAMBU_REQUIRE_CONFIRMATION=0 (Bambu only) opts out for headless clients; a
  printer reporting a finished job still asks. Clients without elicitation are
  refused with instructions.
- Validate temperatures as finite, non-negative numbers before connecting.
  Heater-off (0) and cancel are never gated and cancel pending checked prints.
- Start remote files only after downloading and inspecting them, then start a
  uniquely named checked copy (Bambu, OctoPrint, Moonraker, Duet). Repetier,
  Prusa and Creality refuse remote starts because no verified download route
  exists; upload the local G-code with print=true instead.
- Gate OctoPrint, Klipper/Moonraker, Duet, Repetier, Prusa and Creality with
  shared thermal checks: independent nozzle/bed/chamber ceilings (defaults
  300/120/60 °C, server-only PRINTER_MAX_NOZZLE_TEMP, PRINTER_MAX_BED_TEMP,
  PRINTER_MAX_CHAMBER_TEMP), material ceilings, a declared material for
  positive nozzle heating (G-code filament_type or the new material argument),
  and adapter state checks that refuse printing, paused, errored, offline or
  unreadable printers. Klipper macro parameters that name a heater are checked;
  macro bodies on the printer cannot be inspected.
- Stop again when a cancel arrives while an OctoPrint or Repetier
  upload-and-print is still uploading, so the cancellation wins.
- Pass `nozzle_type` and `bed_type` through `process_and_print_stl` slicing.
- Refuse RepRapFirmware `M144` bed standby/activation, which heats to stored
  temperatures the job does not show.
- Refuse RepRapFirmware `M568 A1/A2` tool activation unless the job itself set
  that tool's standby/active target first; activation-only commands would heat
  to an uninspected printer-side value.
- Fix process_and_print_stl, which only logged a temperature mismatch and kept
  printing and whose check missed R targets. Expected extruder_temp/bed_temp
  must now equal the sliced job's highest S/R target or nothing is uploaded.
- Stop print_3mf from uploading the original project when auto-slicing fails
  or the selected plate has no G-code.
- Behavior changes: print_3mf compares bed_type (default BED_TYPE, else
  textured_plate) with the sliced plate's bed metadata, so a file sliced for
  another plate or without bed metadata is refused until bed_type matches.
  Moonraker complete/cancelled, PrusaLink FINISHED/STOPPED and Bambu FINISH
  count as a finished job, so the first print after a previous job always asks
  a human to confirm the bed is clear, even with confirmation opted out.
  Generic print uploads need a plain filename so the started file is exactly
  the uploaded one.
- Refuse raw FULU bridge print methods, printer messages and unknown methods in
  fulu_bambu_network_rpc; allow_mutating_method now covers only agent/session
  setup methods.
- Publish Bambu safety commands with string sequence ids and keep bambu-node's
  internal parser errors (H2-series serials, PAUSE to IDLE after a cancel) from
  terminating the server, without patching bambu-node.
- Fix OctoPrint nozzle targets (tool0 instead of extruder) and use the DSF
  raw-text /machine/code and PUT /machine/file routes for Duet.
- Give people 10 minutes to answer confirmation prompts
  (PRINT_CONFIRMATION_TIMEOUT_MS) instead of the MCP SDK's 60-second default,
  and report an unanswered prompt as a timeout. Previously a slow answer was
  reported as missing elicitation support, which pointed users at disabling
  the prompt.
- Report what a Bambu printer did after a print command instead of assuming
  success: watch fresh reports (BAMBU_DISPATCH_CHECK_MS, default 15 s) and
  return `dispatch: "started"` or `"unconfirmed"`, or fail with an explanation
  when firmware 01.08.05+ refuses the command (HMS 0500-0500-0001-0007, needs
  LAN Only Mode and Developer Mode). Found on a real P1S, where the old code
  reported "sent successfully" while nothing printed.
- List Bambu files over FTPS directly (ported from bambu-printer-mcp): the
  previous bambu-js listing returned empty folders on every failure,
  including on a healthy P1S with 286 files.
- Explain credential rejections (Bambu MQTT "Not authorized", FTPS 530,
  HTTP 401/403) as a changed access code or API key instead of advising a
  retry, and mark safety refusals as not retryable.
- Evidence: unit tests and MCP-level tests with mocked MQTT/FTPS boundaries and
  loopback HTTP printer APIs cover every gate. One real P1S run (firmware
  01.08.05 or later, LAN Only Mode off) exercised the Bambu path: fresh MQTT
  status and AMS reads, the nozzle-type gate correctly refusing a job sliced
  for a stainless nozzle on a hardened-steel printer, human confirmation, and
  the checked FTPS upload. The firmware then refused the start command (HMS
  0500-0500-0001-0007), so nothing printed; that finding produced the dispatch
  check above, whose logic is unit-tested but not yet seen against the
  firmware. No printer was heated. The other backends are verified against
  mocked APIs only.

### Slicing

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
- Give every STL edit and slice its own output folder, so concurrent requests
  for same-named inputs cannot replace each other's result before it is used
  or printed, and write prepared slicer profiles atomically.
- Extend bases under the model (Z-up) instead of along Y; `extend_stl_base`
  and `process_and_print_stl` previously added the base to the model's side.
- Require a nonempty `Metadata/plate_<n>.gcode` in Bambu-compatible output.
  A checksum-only archive, missing output, or stale file from an earlier run
  is an error.
- Add `nozzle_type` (and `BAMBU_NOZZLE_TYPE`) so jobs can be sliced for the
  installed nozzle. Bambu machine presets assume the stock nozzle (stainless
  steel on P1S/P1P/A1), and the print gate compares the job with the
  printer's report, so a P1S with a hardened-steel nozzle could never print a
  CLI-sliced job.
- Keep OrcaSlicer's absolute-extrusion normalization when the machine preset
  owns the layer-change G-code, so isolating machine settings cannot pair
  absolute E with the machine's `G92 E0` resets.
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

### Blender MCP

- Add `blender_mcp_export_stl`, which exports named objects from the live
  Blender scene to a new, verified STL. It writes world-space evaluated
  geometry without changing the scene, selection, or mode, checks the export
  receipt and triangle count, never overwrites files, reports bounding-box
  dimensions measured from the written file, supports `scale`, and warns when
  geometry looks like it was modelled in metres. Blender MCP's own
  `export_scene` writes GLB/FBX only, so edits made through
  `execute_blender_code` previously had no verified path to a printable STL.
- Report measured bounding boxes for every verified STL, including
  `blender_mcp_edit_model` results.
- `blender_mcp_status` lists tool names and summaries by default (about 8 KB
  instead of 60 KB against mcp-for-blender 2.1.1) and returns full input
  schemas through `tool_names` or `include_schemas`.
- Surface the Blender addon's own exception message when an export fails, and
  point configuration errors at the renamed `mcp-for-blender` package and the
  addon's GUI-only requirement.
- Add `scripts/blender-live-check.mjs`, an opt-in check against a real,
  isolated factory-settings Blender. Verified with Blender 5.0.1 and
  mcp-for-blender 2.1.1, together with an end-to-end phone-case refit
  (import, measure, refit, fit check, export, and a real BambuStudio P1S
  slice). No physical print was made.

### Documentation

- Restructure the README around a copy-and-paste "Set up with your agent"
  request and "What to ask your agent" examples, move manual configuration to
  docs/SETUP.md, and add docs/SLICING.md, docs/FULU.md, docs/BLENDER.md, and
  CONTRIBUTORS.md.
- Publish a generated documentation site to GitHub Pages
  (https://dmontgomery40.github.io/mcp-3D-printer-server/).
- Make AGENTS.md the tracked source of truth for release, review, community
  triage, safety, and Blender rules.

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
