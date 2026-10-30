# Changelog

## 1.2.18 — 2026-10-30

### Dependencies

- Refresh the installation lock to `@hono/node-server` 2.1.5 for GHSA-rmxm-3fg6-px4f using `npm audit fix` without forcing dependency ranges. The MCP SDK already accepts this version. The updated dependency declares Node 20 or newer; no patched 1.x release is available. This lock controls reproducible installs, not existing consumers’ locks. Validation uses offline tests and mocked transports; no printer is contacted.

## 1.2.17 — 2026-10-27

### Fixed

- Accept the official OrcaSlicer `M620.17 T<nozzle> S<target> L-1` preheat for an unused nozzle on X2D, H2D and H2D Pro. Keep the target bounded by the hardware limit and every declared material, restrict the physical nozzle to 0 or 1, and do not invent a filament/AMS position. Ported from bambu-printer-mcp 1.1.38 following [ZombieLurker's H2D report](https://github.com/DMontgomery40/bambu-printer-mcp/issues/73). Reproduced and validated here with offline file-inspection regressions; no physical print was run.

### Dependencies

- Update the MCP SDK to 1.32.2 and Axios to 1.21.0 within their supported major versions. Verify MCP startup and HTTP header/body handling alongside the adapter and package tests. Thank you to the [MCP TypeScript SDK contributors](https://github.com/modelcontextprotocol/typescript-sdk) and [Axios contributors](https://github.com/axios/axios/releases/tag/v1.21.0).

## 1.2.16 — 2026-10-26

### Documentation
- Show the documentation site's social card directly below the README title and link it to the site.

## 1.2.15 — 2026-10-26

### Documentation
- Link the upstream reports for FULU's Linux host: the missing `printer.cer` ([FULU #52](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/52)), the segfault on printer-connection calls before a certificate folder is set ([FULU #53](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/53)), the abort on a missing `create_agent` log folder ([FULU #54](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/54)), and the abort when its input closes after an agent exists ([FULU #55](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/55)). This server refuses the methods behind #52 and #53. `fulu_bambu_network_rpc` can reach #54 with a missing `log_dir`, and #55 after `net.create_agent` once every request is answered; that abort is the one 1.2.14's validation saw.
- Link the proposed fixes for FULU's CLI crash, [FULU #56](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/pull/56) and [FULU #57](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/pull/57). With both, a patched macOS arm64 build answers `--help` and slices a P1S cube; FULU v1.0.0 crashes on both.
- Credit OrcaSlicer's fix for the 2.4.2 `PartPlate::check_outside` CLI crash: [OrcaSlicer #14415](https://github.com/OrcaSlicer/OrcaSlicer/pull/14415) by packerlschupfer, released in 2.5.0-alpha. The STL transform workaround stays while 2.4.2 is the latest stable release; FULU's CLI has the same crash until it takes that fix.

### Tests
- Write the STL manipulator smoke test's outputs to a scratch folder that it removes. Every `npm test` run used to leave six output folders in the repository's `test/` directory.

## 1.2.14 — 2026-10-25

Ported from [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) 1.1.34. Its evidence came from real P1S runs and an x86-64 Linux FULU container; this repository's validation is noted in each entry.

### Fixed

- Let H2D printers with stock nozzles print. Every print stopped with `Printer nozzle 0 information is unreliable, abnormal or unknown` because the HS01 nozzles report `stat: 1` permanently. Bambu Studio reads bit 0 of `stat` as "information unreliable" and bits 1-2 as abnormal or unknown. Nozzles that report no identity chip (`sn: "N/A"`) now pass bit 0, and their configured diameter and type are still compared with the job. The Bambu print prompt names them so a person confirms they match the installed hotends, and checks log them once per printer on stderr, so a headless setup still records them. Abnormal or unknown nozzles still block, and a chipped nozzle with unreliable information asks for a refresh on the printer. Reported by [MorganFreeeman](https://github.com/MorganFreeeman) in [bambu-printer-mcp #67](https://github.com/DMontgomery40/bambu-printer-mcp/issues/67) with idle and mid-print H2D firmware 01.04.00.00 reports. Validated here with that report in mocked-status regressions; no H2D hardware was available.
- Say "declined or cancelled" when a person or the MCP client declines a hardware confirmation, instead of advising a client with elicitation support; clients without elicitation still get that advice. Ordinary print and heating prompts name the opt-out that applies to the printer: `PRINT_REQUIRE_CONFIRMATION=0`, or also `BAMBU_REQUIRE_CONFIRMATION=0` for Bambu printers. Bed-clearance confirmations say a person must accept them. Also from [bambu-printer-mcp #67](https://github.com/DMontgomery40/bambu-printer-mcp/issues/67); validated with mocked Bambu and generic adapters.
- Stop `get_printer_status` on Bambu printers from reporting `UNKNOWN` when the printer's first MQTT push is a sparse hello (model and modules). The read returned as soon as any data had arrived; it now waits, within its existing 1.5 s bound, until the full status has merged. bambu-printer-mcp saw this twice on a P1S; validated here with a delayed-push regression.
- Stop `slice_stl` option combinations from crashing OrcaSlicer's CLI. OrcaSlicer 2.4.2 segfaults in `PartPlate::check_outside`, which needs the GUI, when `scale` or `rotate_x`/`rotate_y` moves an object below the bed while arranging, the default for STL input. For STL input with OrcaSlicer or FULU, the server applies scale and rotations to a copy of the mesh in Orca's own order (scale, then X, then Y, then Z) and omits those flags; for 3MF input with `arrange: true` it refuses that combination with an explanation. `repetitions` on an STL now uses Orca's `--clone-objects`, which cannot be combined with `clone_objects`. The `repetitions`, `arrange` and `clone_objects` descriptions now state the CLI's real limits. Bambu Studio keeps every flag. bambu-printer-mcp verified the crash and fix against OrcaSlicer 2.4.2 on Linux, including the 10 × 20 × 30 mm rotation-order check; this repository's regressions use a fake CLI that records the mesh it receives.
- Report how a Bambu-compatible slicer failed: Bambu Studio and OrcaSlicer failures now name the CLI's own reason, from the `result.json` it writes on Linux or from its exit code, next to the existing exit code or signal and output tails. Validated with a fake CLI.
- Make FULU BambuNetwork bridge probes work with FULU's v1.0.0 Linux host. The host exits when its input closes, dropping requests it has not answered, so every probe and RPC call returned no responses; the server now keeps the input open until each request is answered. On Linux it passes `PJARCZAK_BAMBU_NETWORK_SO` and `PJARCZAK_BAMBU_SOURCE_SO` inside `PJARCZAK_BAMBU_PLUGIN_DIR` unless set, because the host opens them from its working directory ([FULU #51](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/51)). The default Linux bridge command pipes the host through `cat`, because the host exits 101 on the socket stdout Node.js provides ([FULU #50](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/50)); probes and RPC results explain exit code 101, and the FULU guide documents a wrapper for custom commands. A handshake from a host that could not load the networking plug-in is no longer reported as ready, and `file open failed` names the missing setting. A host that stops answering times out with its stderr, how many requests went unanswered and any hints, and Linux setup checks report the library paths that reach the host, including ones you set. macOS bundle notes and wrapper commands appear only for macOS, and the wrapper command only when the wrapper exists. Linux host bugs were reported with diagnosis and upstream issues by [Aaron Roberts (aaroberts)](https://github.com/aaroberts) in [bambu-printer-mcp #68](https://github.com/DMontgomery40/bambu-printer-mcp/issues/68). Validated with a fake host that exits on end of input, and in the maintainer's x86-64 Linux container (QEMU emulation) against FULU's real v1.0.0 host and networking plug-in 02.05.02.58: probes were ready through the default command and the wrapper, a directly launched host returned exit 101 with its explanation, and a missing plug-in folder returned the `file open failed` explanation. `net.create_agent` through `fulu_bambu_network_rpc` created an agent; the host then aborted while exiting, after answering. No printer was contacted. bambu-printer-mcp's bridge LAN printing, certificate, `-4030` and job-name changes do not apply: this server refuses raw bridge print and printer-connection methods and prints over its direct MQTT/FTPS path.

### Documentation

- Add the FULU guide's Linux host setup and an "Upstream bugs and workarounds" table naming FULU #50 and #51, the FULU runtime's missing `printer.cer`, the FULU v1.0.0 CLI crash, the OrcaSlicer 2.4.2 `check_outside` crash (related to the closed [OrcaSlicer #13328](https://github.com/OrcaSlicer/OrcaSlicer/issues/13328)), and the Bambu plug-in's `-4030` design, with what this server does about each.

### Dependencies

- Move the direct `zod` dependency to 4.6.7 for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), memory exhaustion when validating oversized constrained collections; every zod 3 release is affected. The MCP SDK and zod-to-json-schema both accept zod 4, and this server does not import zod itself. Update body-parser to 2.4.0 ([GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)), fast-uri to 3.1.9, follow-redirects to 1.16.2, hono to 4.13.14 and ip-address to 10.7.5 for their new advisories. `npm audit` now reports no vulnerabilities. The documentation site's VitePress development server still pulls vite 6.4.3 and esbuild with advisories that have no VitePress 1.x fix; they affect only `vitepress dev`, not the published static site.

## 1.2.13 — 2026-10-20

### Dependencies

- Refresh the reproducible installation/test lock from MQTT.js 5.10.4 to 5.16.1, including its fix for reconnecting when the previous stream is already destroyed. Keep bambu-node pinned at 3.22.21 and preserve the server's checked MQTT wire format and rejection guard. Thank you to [Henk Kraal (hkraal)](https://github.com/hkraal) and the [MQTT.js maintainers](https://github.com/mqttjs/MQTT.js/releases/tag/v5.16.1).
- Update the documentation build's source-map-js to 1.2.2 for [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), which addresses indexed source-map offsets blocking the event loop. Thank you to [7rulnik](https://github.com/7rulnik/source-map-js/pull/79). Refresh compatible Node 18 typings and MQTT's required transitive packages.

The root lock controls `npm ci`, including CI and reproducible local installs; npm does not ship that lock to consumers. Existing parent projects can retain older transitive MQTT versions and must refresh their own locks. This is not a new published MQTT minimum or a claim that every advisory is resolved. Remaining nodemon/chokidar/braces and VitePress/Vite/esbuild development-server advisories have no compatible automatic fix; no major upgrade or downgrade is forced. Printer safety behavior is unchanged and no physical printer operation is performed.

## 1.2.12 — 2026-10-13

### Fixed

- Correct fresh H2C (`31B`) and H2D Pro (`239`) returned-serial identity without trusting configured identity or suppressing conflicts. Accept a cloud print-job identifier in `model_id` only when another recognized observed model or returned serial identifies the printer; unknown actual model fields still reject. Port reports from Adam (@adamkaplan, [fork #47](https://github.com/DMontgomery40/bambu-printer-mcp/issues/47)) and JaviOFC ([fork #36](https://github.com/DMontgomery40/bambu-printer-mcp/issues/36)).
- Accept Bambu Studio 02.08 P2S per-variant nozzle tables alongside the selected plate header, and the exact P2S `M145 P0/P1` airduct forms. Preserve selected extruder/variant conflicts and independent thermal checks. Port Izzy Mansurov's (@sapoepsilon) code and regressions from [fork #33](https://github.com/DMontgomery40/bambu-printer-mcp/pull/33), including the subsequent selection-validation corrections.
- Accept the official H2C startup forms only inside its single bounded executable startup block, with independent base/derived nozzle and bed checks and declared filament positions. Keep configuration `layer_change_gcode` keys from ending startup; actual layer markers and extrusion still close it. Reject unchecked `G383 U` targets outside the allowance. Thanks to Adam for [fork #48](https://github.com/DMontgomery40/bambu-printer-mcp/issues/48) and the exact vendor template evidence.
- Accept the official X2D bare material-switch `B` flag and exact `M620.22 I<declared filament> P1` runout-purge form while rejecting unsupported variants and preserving heater ceilings. Thanks to Travis Cashman (@travismcashan) for [fork #44](https://github.com/DMontgomery40/bambu-printer-mcp/issues/44). These are file-inspection changes; no native X2D helper is added to this server.

### Dependencies

- Update basic-ftp to 6.2.3 for [GHSA-r4jh-29pc-gfqr](https://github.com/patrickjuchli/basic-ftp/security/advisories/GHSA-r4jh-29pc-gfqr): rejected control-character passwords/resume paths no longer cause an uncaught exception or leave the client unusable, and rejected PASS errors omit the password. Keep bambu-node pinned and preserve the parent's direct MQTT wire-shape and rejection guard.

Validation uses mocked transports, the pinned official H2C template, unsafe-file mutations, and clean package installations. No physical printer operation is performed or claimed.

## 1.2.11 — 2026-10-06

This release also includes the safety, slicing, Blender, and documentation
changes prepared as 1.2.10 below. Version 1.2.10 was not published to npm.

### Fixed

- Send Moonraker's configured `API_KEY` as `X-Api-Key` on every request,
  including multipart uploads and remote-file inspection downloads. Thanks to
  Jack Manning (@EastArctica) for [#30](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/30)
  and Klipper 0.13.0 authentication evidence. Loopback tests cover authenticated
  and trusted-client configurations; no maintainer physical print was run.
- Correct fresh Bambu A1/A1 mini serial identity (`039` / `030`) and accept the
  official A1/A1 mini `M109 H` wait parameter without weakening independently
  checked S/R temperature targets. Port the fork's fixes reported by @Steavie
  ([#39](https://github.com/DMontgomery40/bambu-printer-mcp/issues/39)) and implemented
  by @nitpreet22 ([#41](https://github.com/DMontgomery40/bambu-printer-mcp/pull/41)).
  Covered by mocked identity and file-inspection regressions.
- Keep model parsing, slicing, and STL diagnostics on stderr so they cannot
  corrupt stdio MCP messages, following @travismcashan's report in the fork's
  [#44](https://github.com/DMontgomery40/bambu-printer-mcp/issues/44). Subprocess
  regressions check the compiled parser and slicer.
- Make Bambu file metadata lookup read-only through the shared FTPS client;
  remove the obsolete `bambu-js` dependency that created directories during reads.

### Dependencies and interoperability

- Update the MCP SDK to 1.32.1, basic-ftp to 6.2.2, JSZip to 3.10.2, dotenv
  within version 16, and proxy-addr to its patched release. The production npm
  audit reports no vulnerabilities; unresolved nodemon watcher advisories are
  development-only and remain deferred rather than forcing an unsafe downgrade.
- Verify discovery, invocation, and STL export with upstream mcp-for-blender
  2.1.9 and the former blender-mcp 2.0.0 package in isolated Blender 5.0.1.
  The exported fixture has 12 triangles and measures 40 × 20 × 10 mm. This
  verifies application interoperability, not a user's live scene or a print.

### Discovery

- Add the official MCP Registry ownership field and server metadata for the
  npm package. The listing documents printer backend configuration and marks
  API keys and Bambu LAN access codes as secrets.

## 1.2.10 — repository changes, not published to npm

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
