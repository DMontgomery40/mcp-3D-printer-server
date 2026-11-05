# Changelog

## [1.2.33] – 2026-11-05

### Fixed

- A template's or project's process settings extract to a file named by their content, so two projects sliced at once can't overwrite each other's settings and slice with the wrong layer height, walls or infill. Checked with a concurrent extraction test.
- A 3MF that carries its own process settings (a designer's Bambu Studio or Orca project) now slices with them on the Bambu-compatible CLI route: `slice_stl` takes its layer height, walls, infill and the rest of its process unless the call names `slicer_profile`, `template_name` or `template_3mf_path`, and `print_3mf`'s auto-slice does the same unless the call names `slicer_profile`. A configured default profile or template used to replace them. The machine still comes from `bambu_model` and the nozzle, so a project made for another printer can't bring its machine settings along. A 3MF with no process of its own, such as one from `counterpart_make_3mf`, still slices with the preset. Found when a designer's fold-and-snap caliper card (0.16 mm layers, 100% infill) was printed at the preset's values and no longer folded. Checked with a stand-in slicer. On Bambu Studio 2.8.2, that designer's file sliced through this same route (its own file as `template_3mf_path`) kept 0.16 mm, 100% infill, 2 walls and 6 top and 4 bottom layers, where the default route gave the preset's 0.2 mm and 15%.
- `strength` `strong` and `max` only raise walls and infill: a process that already has more walls or denser infill keeps them. Strong used to write 4 walls and 25% infill as given, which lowered that caliper card's 100% infill. On PrusaSlicer and Slic3r the floor is read against the loaded config's own `perimeters` and `fill_density`. An explicit `wall_loops` or `sparse_infill_density` is still written as given. Checked with a stand-in slicer only.

## [1.2.32] – 2026-11-04

### Added

- `counterpart_printer_info` reports `capabilities.slicing`: whether `slice_stl` can apply supports, copies (`repetitions`) and auto-orient with the slicer this server uses for that printer. The Bambu-compatible CLI route takes all three, generic OrcaSlicer takes supports, and PrusaSlicer, Slic3r and Cura take none. For a Bambu printer on OrcaSlicer, that assumes the call passes the printer's `bambu_model`. Clients such as Counterpart offer those choices from this instead of knowing which slicers accept what. Same field as bambu-printer-mcp 1.1.58. Checked with mocked transports only.

### Changed

- `slice_stl` with `repetitions` above 1 on a slicer that can't make copies (anything but the Bambu-compatible CLI route) now says so and slices nothing; it used to slice one copy without a word. Checked with stand-in slicers only.

## [1.2.31] – 2026-11-04

### Added

- A printer refusal on `print_3mf` carries a stable `code` in its structured error: `printer-command-rejected` when the printer refuses the print command itself (Bambu HMS 0500-0500-0001-0007, MQTT command verification; the file is on the printer, nothing is printing), and `printer-not-ready` when the printer isn't in a state that can start a print. The message and suggestion are unchanged. Clients such as Counterpart can act on the code instead of matching the wording, which changes with printers and firmware. Checked with mocked MQTT only. Same change as bambu-printer-mcp 1.1.57.

## [1.2.30] – 2026-11-04

### Added

- `slice_stl` and `slice_with_template` take `quality` (`draft`, `standard`, `fine`) and `strength` (`standard`, `strong`, `max`). The server turns them into the slicer's own settings: Draft and Fine set the layer height for the nozzle in use (0.28 and 0.12 mm on a 0.4 mm nozzle, scaled with it), Strong and Max set walls and infill (4 walls at 25%, 6 at 40%), and Standard leaves the resolved preset alone. An explicit `layer_height`, `wall_loops` or `sparse_infill_density` still wins. Clients such as Counterpart can now send the person's choice instead of carrying slicer numbers. Checked with stand-in slicers only. For PrusaSlicer, Slic3r and generic OrcaSlicer the layer height scales with `nozzle_diameter` (or `NOZZLE_DIAMETER`), which must match the profile's nozzle; Cura takes only Standard. Same change as bambu-printer-mcp 1.1.56.

## [1.2.29] – 2026-11-04

### Changed

- With no method given, a FULU print over Bambu Cloud goes the way Bambu Studio sends it to a cloud-bound printer it can reach on the LAN (`PrintJob.cpp`): `start_local_print_with_record`, which uploads to the printer over the LAN and records the task in the account, in the account's cloud session. When that fails before the print command (the plug-in's `-2010` to `-2140` preparation results, other than a missing or oversized file), the same checked job goes once through `start_print`, with the printer checked again first. Any other failure may have reached the printer and is not sent again. A printer that reports no storage goes straight to `start_print`, as in Studio. Same change as bambu-printer-mcp 1.1.55. On a P1S with firmware 01.10.00.00, `start_print` alone returns `-3120`, HTTP 403 "internal blocking", every time. Errors name `-2120`, `-2130` and `-3120`. Checked with the stand-in host and intercepted transports only; not yet on a printer.

## [1.2.28] – 2026-11-04

### Added

- `slice_stl` takes `enable_support`, `support_type` (`normal(auto)`, `tree(auto)`, `normal(manual)`, `tree(manual)`) and `support_threshold_angle`, written over the selected process profile like `layer_height` and `wall_loops`. Bambu Studio and OrcaSlicer only; PrusaSlicer and Cura refuse them. Tested with the fake Bambu Studio CLI install; bambu-printer-mcp 1.1.54 checks the same keys against the installed Bambu Studio 02.08.02.61. No printer was involved.

## [1.2.27] – 2026-11-04

### Added

- Every tool now carries the four MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) from one table, `src/tool-annotations.ts`, so clients can tell reads from actions without parsing descriptions. Before, 7 of 45 tools had partial annotations. Destructive means the tool may end or replace something that exists: `cancel_print`, `upload_gcode` (same file name), `camera_snapshot` with `save_path`, `get_slice_settings` (a same-named 3MF replaces the extracted settings file), `save_template`, `counterpart_print_route` with a route, and the pass-through calls `fulu_bambu_network_rpc`, `blender_mcp_call` and `fusion_mcp_call`. Starting a print and heating are marked additive, matching the no-confirmation decision. Annotations are hints for clients; every safety check still applies. A test lists the tools over stdio and fails for any tool without all four.

### Fixed

- Resume a Bambu job that the printer paused itself. A P1S paused by Pause or by a `pause_at_layers` stop reports `print_error` 0300_8013 ("paused by the user" / "paused by the pause command in the file"), and Resume refused it as a print error, so a paused job could only be resumed at the printer. The notice is excused only for Resume, only while the printer reports PAUSE; any other print error still refuses, and starting a job still needs no error. Ported from bambu-printer-mcp.
- FULU's BambuNetwork agent now receives the client headers FULU's own GUI sends before `net.start` (Bambu Studio 02.05.02.51 on Linux, with a per-install device id kept in the config folder). Bambu's cloud issues the printer-control certificate and creates print tasks for this client; without the headers the agent was an unknown client. `BAMBU_NETWORK_CLIENT_NAME` and `BAMBU_NETWORK_CLIENT_VERSION` override the name and version. Ported from bambu-printer-mcp.
- Evidence: mocked Bambu MQTT/FTPS boundaries and the fake FULU host only; no printer was contacted.

## [1.2.26] – 2026-11-04

### Changed

- Start prints and positive heating without a server-side confirmation prompt, on every printer type. The client's own print action is the approval and the printer runs its own checks, so clients without MCP elicitation support now print and heat normally. `PRINT_REQUIRE_CONFIRMATION` and `BAMBU_REQUIRE_CONFIRMATION` are removed. File inspection, hardware and material ceilings, declared materials, fresh printer state (read, rechecked before upload and again before dispatch) and Bambu identity checks are unchanged. Matches bambu-printer-mcp.
- `resume_print` asks a person only when the printer cannot hand the file back for re-reading (PrusaLink, Repetier, Creality), where the job is matched by name only. OctoPrint, Klipper and Duet (DSF) re-read the file, compare its SHA-256 and resume without a prompt. `PRINT_CONFIRMATION_TIMEOUT_MS` now bounds that prompt and the Bambu printer-model prompt.
- Stop treating a finished job as a bed-clearance case: a printer that reports a finished or cancelled job (Moonraker complete or cancelled, PrusaLink FINISHED or STOPPED, Creality finished, Bambu FINISH) starts the next print like an idle one. Matches bambu-printer-mcp's bed-check removal ([bambu-printer-mcp #90](https://github.com/DMontgomery40/bambu-printer-mcp/pull/90)).
- Evidence: mocked Bambu MQTT/FTPS boundaries and loopback HTTP printer APIs only; no real printer was used.

### Fixed

- Include the authenticated control reply module in the npm package. The route imported it but the explicit package allowlist omitted it, so a packed install exited before MCP initialization. The packed-install smoke test covers startup and discovery through all three entrypoints.

- Keep authenticated FULU Pause, Resume and Stop request IDs as strings in Studio's 20000–29999 window, with a shared counter across LAN, cloud and retries that wraps inside the window. A cloud-bound P1S 01.10 rejects larger IDs with 0502400A even when their signatures are valid. Preserve reply correlation and the delivery hold; remove guidance claiming controls require Studio/Handy or Developer Mode. Automated regressions cover both transports and wraparound; hardware validation is limited to the maintainer's P1S.

- An `ams_mapping` object (and the 3MF's own mapping) is ordered by project filament index, as bambu-printer-mcp orders it. Before, its tray values were sorted, so `{"0": 3, "1": 0}` sent tray 0 for filament 0.
- Bambu printers slice with Bambu Studio when `SLICER_TYPE` is not set, as bambu-printer-mcp does. The previous default, FULU OrcaSlicer-bambulab, crashes on every command-line slice in its only release (v1.0.0, macOS DMG and Linux builds; fixes in FULU #56 and #57 are not released), so `slice_stl`, estimates and auto-slicing failed for every Bambu user without a slicer setting. FULU's Orca stays fully supported with `SLICER_TYPE=orcaslicer-bambulab`.
- A relative `TEMP_DIR` (such as `./temp`) is resolved against the server's working directory, as bambu-printer-mcp 1.1.44 does. Bambu Studio fails every 3MF export to a relative output folder ("Project export to temp/…/…_sliced.3mf failed").

- Accept Bambu Studio 2.9 layer-temperature changes (`M104 M S<temperature>` with an optional `T` selector) in the Bambu file inspector. Preserve hardware/material ceilings, tool validation, and rejection of numeric markers, other heaters and extra parameters. Reproduced using isolated Studio 02.09.01.70 output; no physical print was run. This ports the fix prepared in [bambu-printer-mcp #97](https://github.com/DMontgomery40/bambu-printer-mcp/pull/97).

- Update `basic-ftp` to 6.2.5, including its 6.2.4 fix for directory listings containing inherited-property fact names. Offline listing reproduction fails with 6.2.3 and preserves the file name and size with 6.2.5; no printer was contacted.

- Resolve H2C first-layer temperature tables by the selected filament index and extruder variant instead of treating every variant row as a filament. Preserve unique bindings, header agreement and independent base/offset ceilings. Ports the correction reported by [Steve Pritchard (sjpritchard)](https://github.com/DMontgomery40/bambu-printer-mcp/issues/81); an unchanged Studio 2.9 H2C slice passes offline inspection after reproducing the failure.

- `print_3mf` with a `plate_index` prints, inspects and checks pauses on that plate on every route: FULU's BambuNetwork route used to inspect and dispatch plate 1, and a pre-sliced file's requested pauses were checked against plate 1. Tested with the fake FULU host; no printer was contacted.

### Added

- `slice_stl`, `slice_with_template` and `print_3mf` accept `pause_at_layers`, matching bambu-printer-mcp. Bambu Studio and Bambu-compatible OrcaSlicer CLIs place the printer's own pause before each requested 1-based layer (2 or greater), using a first slice to find exact heights. Existing project pauses and custom G-code are preserved. Output must contain every requested pause; already sliced files missing one are refused before dispatch. Other slicers refuse the option rather than ignoring it. Evidence: fake slicer/MCP tests only; no physical print or real slicer was run in this port.

- Bambu AMS inventory and tray choice, ported from bambu-printer-mcp:
  - `get_printer_filaments` reads the AMS from the printer's MQTT report for `PRINTER_TYPE=bambu` instead of refusing. The result carries bambu-printer-mcp's fields unchanged (`trays` with absolute `slot`, `loaded`, `tray_type`, `tray_color`, `tray_info_idx` and the resolved Bambu Studio/Orca filament profile; `summary`; `recommended`; `load_filaments_all`), plus counterpart/1 `slots` for every loaded AMS tray and the external spool (`254`, and `254`/`255` on dual-nozzle printers) with `source: "printer"`. Optional `bambu_model` and `nozzle_diameter` pick model-specific profiles. `counterpart_printer_info` reports `filaments: "ams"` for Bambu.
  - `print_3mf` accepts `ams_slots`: one tray per used filament in plate order, expanded to the project-level `ams_mapping` from the plate's `filament_ids` and the G-code header, as bambu-printer-mcp does. `ams_mapping` also accepts the project-level array. Tray values are checked (0–15, 128–254, and 255 on dual-nozzle printers), `ams_slots` must name exactly one tray per used filament, and the fresh-state check still compares each mapped tray's material with the file. `use_ams: false` maps every used filament to the external spool of its nozzle on the wire. Counterpart's printer handoff sends exactly these arguments.
  - Evidence: mocked MQTT reports and FTPS/MQTT dispatch only; no real printer was used.
- Bambu `pause_print` and `resume_print`, and `counterpart_printer_info` reports `pause` and `resume` for Bambu, ported from bambu-printer-mcp:
  - Pause and stop (`cancel_print`) are never gated. Stop also retires the job's resume record.
  - Resume keeps bambu-printer-mcp's checked-job safety: only the job this server inspected and started, while a fresh report shows it paused under its unique name, with the fresh-state check repeated. Its bytes are re-read over FTPS (the uploaded 3MF, else the `cache/<name>_plate_<n>.gcode` a P1S extracts from it) and their SHA-256 compared; a changed file retires the record. A file this server uploaded that cannot be re-read refuses the resume. Only a file Bambu's plug-in placed (FULU's BambuNetwork route) that cannot be re-read asks a person through MCP elicitation.
  - Every MQTT report retires a record whose job ended or was replaced, even when nobody polls.
  - Checked 3MF prints are started with their unique remote name as `subtask_name`, as bambu-printer-mcp does, so the printer reports back which job is paused.
  - Evidence: in-process FTPS/MQTT fakes only; no real printer was paused or resumed.
- Bambu connection routes, including FULU's authenticated BambuNetwork route, ported from bambu-printer-mcp, so a P1S on authorization firmware without Developer Mode prints and is controlled over the local network:
  - One route decision (`resolveConnection`) for `print_3mf`, `cancel_print`, `pause_print` and `resume_print`: `connection_mode` (`lan_mqtt_ftps`, the default, or `bambu_network`) and `connection_type` (`lan` or `cloud`; `cloud` when unset, as in bambu-printer-mcp), defaulting to `BAMBU_DEFAULT_CONNECTION_MODE` and `BAMBU_DEFAULT_CONNECTION_TYPE`. A job is controlled over the connection that printed it. bambu-printer-mcp's `bambu_native` (X2D) and `bambu_connect` modes are refused with a clear error; nothing is sent over another connection.
  - `print_3mf` with `bambu_network` runs the same gates as the LAN path (inspection of the exact snapshot bytes, the AMS mapping, fresh LAN MQTT state before the bridge starts and again immediately before the print frame), then opens the plug-in's own session: `net.start_local_print` for `lan`, `net.start_print` for `cloud`. It sends Bambu Studio's `ams_mapping`, `ams_mapping2` and `ams_mapping_info`, the Send dialog's calibration options as Bambu Studio resolves them, and the unique checked name as the task name. A synchronous -4030 is retried once after the certificate exchange; other non-zero results report the plug-in's code and messages. The job is recorded for a checked resume.
  - Stop, Pause and Resume over `bambu_network` go through the plug-in's authenticated session, held open until the printer answers; a refusal reports the printer's `err_code`, a -4/-4030 send is retried after reinstalling the certificate (three tries), and every event and send is written to `control-trace.log` in the bridge's config folder without the access code.
  - New `counterpart_print_route` tool, same contract as bambu-printer-mcp's: reads the route (`lan` or `cloud`, with the resolved mode and type) and changes it in the running server and in the `.env` file in its working directory when one exists (`savedTo`).
  - The bridge host is `BAMBU_NETWORK_BRIDGE_COMMAND` (bambu-printer-mcp's name), else `FULU_BAMBU_BRIDGE_COMMAND`, else the host `check_fulu_orca_setup` discovers next to FULU's OrcaSlicer-bambulab. Its config folder defaults to `~/.config/mcp-3d-printer-server/bambu-network` (`BAMBU_NETWORK_CONFIG_DIR`). `fulu_bambu_network_rpc` still refuses raw print methods.
  - Evidence: a fake FULU host process that reproduces the real v1.0.0 host and plug-in behaviour bambu-printer-mcp recorded on a P1S, plus patched printer state; no real FULU host, plug-in, printer or Bambu Cloud was used by this server.

- Serves design guidance for agents that design or edit models to print as MCP prompts: `fdm_design`, `fdm_multicolor`, `fdm_assembly` and `fdm_after_slice`, plus the resource `guidance://fdm/capability-guidance` for bridges and overhangs. The server's `instructions` point every client to them. The text is David Montgomery's FDM design prompt pack of 3 November 2026, unchanged; bambu-printer-mcp serves the same guidance. Tested over a real stdio MCP connection; whether an agent follows it is a model behavior, not tested here.

### Documentation

- README, `docs/FULU.md`, `docs/SETUP.md` and `.env.example` describe Bambu AMS inventory and tray choice, Bambu pause, resume and stop, the connection routes (`BAMBU_DEFAULT_CONNECTION_MODE`, `BAMBU_DEFAULT_CONNECTION_TYPE`, `counterpart_print_route`) and printing and controlling through FULU's BambuNetwork route, including its evidence limits here (a fake FULU host only).

## [1.2.25] – 2026-11-02

### Fixed

- `lay_flat` rests a model on a face that is its real bottom. Before, it turned the face-normal group with the largest area to face down and moved the lowest point to Z=0, without checking that those faces were the lowest. The stove gap filler from Scan to Make (six T strips) printed upside down: its cap undersides' 23,838 mm² face down but sit 12 mm above the fin tips, so it stood on its fins.
  - A pose qualifies only when some face, turned down, lies on the rotated model's lowest plane, within 0.5% of its height and at most 0.2 mm. The candidate poses are the 64 largest face groups and the model's six axes, so a domed part can flip exactly.
  - Among qualifying poses, `lay_flat` picks the one with the least part and support volume per mm² of bed contact. Support is the overhang more than 45° from vertical, times its height above the bed. Ties go to the larger contact, then to the face that already points down.
  - When no pose qualifies, the model is unchanged. The text result is still the STL path, and the new `structuredContent` `{path, laid_flat, message}` says why.
  - The gap filler now comes out cap-down, fin tips 14.4 mm up. This is checked from the output vertices only. The same rule in bambu-printer-mcp was also checked by slicing with Bambu Studio 02.08.02.61 for a P1S, which gave no warning; that slice was not repeated here.
- `slice_stl` returns Bambu Studio's own checks on the Bambu-compatible CLI route, and OrcaSlicer's where it writes the same `result.json`. When the CLI writes `result.json` (Bambu Studio 02.08.02.61 writes it on macOS on success too), `structuredContent.slicer_result` carries it parsed and unchanged: `error_string`, `return_code` and each `sliced_plates[].warning_message`. Before, the run's output directory was deleted with `result.json` in it, and warnings such as "It seems object … has floating cantilever. Please re-orient the object or enable support generation." were lost.
  - The text result stays the sliced file's path.
  - A failed slice is an error result whose text starts with Studio's `error_string` (unless it reports success), then each plate's `warning_message`, then the exit code, slicer output and suggestion, with no `Error: ` prefix. Its `structuredContent` carries `slicer_result` beside the existing `slicer` details.
  - A `result.json` reporting a nonzero `return_code` fails the slice even when the CLI exits 0.
  - The G-code slicers (PrusaSlicer, Cura, Slic3r, generic OrcaSlicer without a Bambu preset) write no `result.json` and return `structuredContent` `{path}` only.
  - Tested with real `result.json` files from Bambu Studio 02.08.02.61 slicing the Scan to Make stove gap filler for a P1S on macOS, replayed by a fake CLI. The optional installed-Studio test also checks `slicer_result` on macOS; CI skips it. OrcaSlicer's `result.json` follows the same libslic3r format but was not run here.

## [1.2.24] – 2026-11-02

### Fixed

- `fusion_mcp_status` reports the Fusion360MCP add-in as reachable. The pinned add-in answers a ping on its fast path with `{"ok":true,"status":"pong"}`, and the bridge accepted only `{"pong":true}`, so it reported `connected: false` with a running add-in. Verified against a live Fusion with the add-in at `19b9f1e95192` through bambu-printer-mcp's identical bridge, and with socket fixtures here.

## [1.2.23] – 2026-11-02

### Removed

- Remove bed-clearance checks. A finished, complete, cancelled or stopped job prints like an idle printer. There is no "remove the previous part and debris" confirmation or forced human prompt, and no "the build plate is clear" line in print confirmations. The printer detects an occupied bed itself during bed leveling. Print confirmations keep their spool and file checks, and `PRINT_REQUIRE_CONFIRMATION=0` now skips every print prompt. Verified with the full suite (570 tests) using mocked printers; no physical print was run.

## [1.2.22] – 2026-11-02

### Fixed

- `camera_snapshot` tries both 127.0.0.1 and ::1 for a `localhost` snapshot URL. Node 18 resolves `localhost` to ::1 first with no IPv4 fallback, so a webcam that listens on IPv4 only was missed. Verified with the OctoPrint Classic Webcam test on Node 18.20.8 and the full suite on Node 22.

## [1.2.21] – 2026-11-02

### Added

- Add the `counterpart/1` tools that bambu-printer-mcp also implements, so one client can watch and control either server: `counterpart_printer_info` (server, printer identity and detected capabilities), `counterpart_print_progress` (one state, job, progress, time, layer, temperature and problem shape per firmware), `camera_snapshot` (bambu-printer-mcp's arguments and result plus `capturedAt`), `get_printer_filaments` (one external slot, with Spoolman through Moonraker), `pause_print` and `resume_print`. Each declares an `outputSchema` and returns `structuredContent` plus the same JSON as text; their errors carry text only, because MCP clients validate structured content against the schema even on errors.
- Pause is never gated. Resume reheats and moves the printer, so it is gated like a print start. It resumes only the job this server instance inspected and started, after a fresh report that the same job is paused, and after a person confirms through MCP elicitation (unless the server sets `PRINT_REQUIRE_CONFIRMATION=0`). OctoPrint, Klipper and Duet re-download the file and compare its SHA-256 with the inspected bytes before asking; PrusaLink, Repetier and Creality have no download route here, so the job is matched by name only. The printer is read again after the confirmation. Cancelling the job, or a report that it ended, retires it, so a later job that reuses the name is never resumed. A stop or heater-off request cancels a pending resume. A job started elsewhere, or before a restart, is refused. OctoPrint drops a resume sent while it is still pausing, so transitional states are reported as `job.stage` and resume waits for a settled pause.
- `upload_gcode` and `start_print` results name the remote job in `jobName` (for `start_print`, the checked copy that actually starts), matching `job.name` in `counterpart_print_progress`.
- `slice_stl` and `slice_with_template` accept `layer_height`, `wall_loops` and `sparse_infill_density`, written over the selected profile: Orca and Bambu Studio process keys on the Bambu-compatible and generic OrcaSlicer paths, and `--layer-height`, `--perimeters` and `--fill-density` for PrusaSlicer and Slic3r. Cura refuses them. Profile files are never modified.
- `get_printer_filaments` slots carry `profile`, the installed slicer filament profile for the slot's material, as an absolute path `slice_stl` takes as `load_filaments`: from Spoolman's material when Spoolman reports one, otherwise the configured `FILAMENT_PROFILE`; omitted when nothing resolves. OrcaSlicer bundled, system and user presets, and PrusaSlicer/Slic3r `filament/*.ini` presets, are matched exactly on `filament_type`, preferring a profile whose `compatible_printers` lists the printer in `SLICER_PROFILE`. bambu-printer-mcp's resolver did not fit: it looks up Bambu profiles by AMS `tray_info_idx`, which other printers do not report.
- **Behaviour change:** PrusaSlicer and Slic3r now load a filament preset. `filament_profile`, `load_filaments` or `FILAMENT_PROFILE` must be one `.ini` preset and is passed as a second `--load` after `slicer_profile`; before, it was silently ignored. A `.json` or a list is refused with instructions. Generic slicers (PrusaSlicer, Slic3r, generic OrcaSlicer) now honour `load_filaments` as well as its alias `filament_profile`; before, only the Bambu CLI path read `load_filaments`. For generic OrcaSlicer, a filament chosen for the call replaces the `|filament.json` default in `SLICER_PROFILE` instead of becoming a second slot, and a filament preset that `inherits` installed presets is passed to `--load-filaments` with its chain merged in (the CLI does not resolve `inherits`, so a bundled preset would slice without its own temperatures). A preset whose parent is not installed is passed unchanged.
- `PRINTER_CAMERA_SNAPSHOT_URL` overrides the camera source for any printer, and `REPETIER_SLUG` selects the Repetier-Server printer for the new tools.

- Add an optional Autodesk Fusion bridge (`src/fusion-mcp-bridge.ts`) to faust-machines/fusion360-mcp-server pinned at `19b9f1e95192`, configured with `FUSION_MCP_COMMAND`, `FUSION_MCP_ARGS` (defaulting to the pinned server in socket mode), `FUSION_MCP_TIMEOUT_MS` and `FUSION_MCP_HOST`. `fusion_mcp_status` reports configuration, the Fusion process, whether the add-in answers its ping within a 2 s hard deadline (Blender's addon is not mistaken for it), and the server's tools; `launch: true` opens Fusion on macOS with `--env FUSION_MCP_PORT=<port>` and waits up to 90 s. The add-in port defaults to 9877 (PRD §8.9) because Blender's MCP addon holds the faust default, 9876; the bridge passes it to the Fusion server too. `fusion_mcp_call` forwards any discovered tool with its full content and errors and never retries. `fusion_mcp_new_design` opens a parametric design through `execute_code`. `fusion_mcp_export` writes `<name>.stl`, `<name>.f3d` and `<name>.parameters.json`, verifies the STL and its units against the Fusion body, and never overwrites. Unlike the Blender bridge, the client stays connected for the life of the server. Only `FUSION_*` settings reach the Fusion process. Closing stdin now shuts the server down, so a host that disconnects without a signal does not leave it, or the Fusion child, running.

### Evidence

- The pinned Fusion server started through the bridge with `uvx` and listed its 93 tools; Fusion itself was not installed, so no design was built or exported live. The bridge's tests use a stdio peer that reproduces that commit's recorded `--mode mock` output. At that commit no tool works while Fusion shows its home screen without an open document (faust-machines issue #12), so `fusion_mcp_new_design` explains how to open one.
- OctoPrint 1.11.2 and 1.8.7 (virtual printer) and Klipper with Moonraker 1.5.0 on simulavr, with Spoolman 0.27.1: info, progress, camera snapshot, filaments, a checked upload-and-print through MCP with the confirmation answered, pause, resume (re-read bytes and its own confirmation), cancel, and a refused resume after the cancel. `jobName` equalled the reported `job.name` on all three. These are simulators, not printers.
- PrusaLink, Duet (standalone `rr_*` and DSF), Repetier-Server and Creality follow their API documentation and are covered by recorded-shape mapping tests and loopback HTTP mocks only. Repetier's `done`, `printTime`, `printedTimeComp` and `@pause` are not in its API manual. Creality's Moonraker ports (7125, then 4408) come from community K1 setups. Duet uses `rr_model` flags `d99v` instead of `d99f`, because `f` omits `job.file`.
- The Bambu mapping is tested offline and matches bambu-printer-mcp's encodings. This server has no Bambu camera, pause or resume path.

## 1.2.20 — 2026-10-30

### Fixed

- Keep already-horizontal faces eligible when `lay_flat` chooses the largest flat face. Thin plates now rest on their broad face at Z=0 instead of standing on an edge, including after repeated calls. When up- and down-facing areas tie exactly, as for a plate with a raised block or lettering, keep the face that already points down so a seated part is not flipped. Validate with generated STL geometry in horizontal, upside-down, edge-on, and tilted orientations and with a raised block in either face order; no printer or live Blender scene is used.

### Tests

- Verify malformed HTTP JSON returns a structured 400 response while the active MCP session remains usable. Exercise loopback HTTP only; no real printer or live Blender scene is used.

## 1.2.19 — 2026-10-30

### Fixed

- Restore Node.js 18 support removed in 1.2.18. The MCP SDK's streamable HTTP transport calls the global `crypto`, which Node.js 18 lacks and `@hono/node-server` 2.x no longer installs; the server now provides it from `node:crypto` when missing. The package again declares Node.js 18 or newer and CI tests 18 through 24. Fresh npm installs on Node.js 18 resolve `@hono/node-server` 1.19.17, as they did for 1.2.18 apart from an engine warning. That version is inside GHSA-rmxm-3fg6-px4f's range, which affects only `serveStatic`; this server does not use it. Node.js 20 or newer installs the patched 2.1.5, which the repository lock keeps, so Node.js 18 CI and clones run it outside its declared Node.js 20 range. A regression starts the HTTP and SSE entrypoints without the global; the full suite and packed-install test pass on Node.js 18.20.8 and 24. Offline tests only; no printer is contacted.

## 1.2.18 — 2026-10-30

### Changed

- Require Node.js 20 or newer. Node.js 18 reached end-of-life in April 2025, and the patched `@hono/node-server` relies on the global Web Crypto API that Node.js 18 does not expose by default, so streamable HTTP fails there. CI now tests Node.js 20, 22 and 24.

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
