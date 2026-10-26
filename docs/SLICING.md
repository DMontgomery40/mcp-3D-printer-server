# Slicing guide

[Back to README](../README.md) · [Agent setup](../README.md#set-up-with-your-agent) · [Setup reference](./SETUP.md) · [FULU guide](./FULU.md)

## Choose a path

There are two ways to get a printable file.

**Path A: slice in your slicer's GUI, then hand the file to the server.** Slice, check the preview, and export. Then upload a `.gcode` file with `upload_gcode`, or print a sliced Bambu `.3mf` with `print_3mf`. You see exactly what will print, so this is the most predictable path.

```
Model ──► slicer GUI ──► sliced .gcode / .gcode.3mf ──► upload_gcode or print_3mf
          slice + preview + export
```

**Path B: let the server run your slicer's command line.** `slice_stl` runs the configured slicer and returns the output path. Your agent can then check temperatures with `confirm_temperatures` and upload the result. This is what makes "edit this model and print it" work end to end, but it depends on your installed slicer and profiles.

```
STL / 3MF ──► slice_stl ──► slicer CLI ──► .gcode (or sliced .3mf for Bambu) ──► upload_gcode / print_3mf
```

Printing a file that is already sliced needs no slicer on the MCP host. Either way, every print start goes through the [print safety gate](./SETUP.md#print-and-heating-safety), including a human confirmation.

## Slicer types and aliases

Set `SLICER_TYPE` in the server environment, or pass `slicer_type` to a tool.

| `SLICER_TYPE` | Slicer | Output | Also accepted |
|---|---|---|---|
| `prusaslicer` | PrusaSlicer | G-code | `prusa` |
| `slic3r` | Slic3r | G-code | |
| `orcaslicer` | OrcaSlicer | G-code, or a sliced Bambu `.3mf` when the call passes `bambu_model` | `orca`, `orca-slicer` |
| `cura` | CuraEngine | G-code | `curaengine` |
| `orcaslicer-bambulab` | [FULU OrcaSlicer-bambulab](https://github.com/FULU-Foundation/OrcaSlicer-bambulab) | Sliced Bambu `.3mf` | `fulu-orca`, `fulu_orca`, `orca-studio`, `orca_studio`, `orcastudio`, `orca-bambulab`, `orca_bambulab`, `orcaslicer_bambulab` |
| `bambustudio` | Bambu Studio | Sliced Bambu `.3mf` | `bambu-studio`, `bambu_studio` |

The environment variable accepts every alias. A tool's `slicer_type` argument accepts the canonical names plus `fulu_orca`, `fulu-orca`, `orca-studio`, and `orca_bambulab`.

When `SLICER_TYPE` is not set, the server uses `orcaslicer-bambulab` if `PRINTER_TYPE=bambu`, and `prusaslicer` otherwise.

### Where the server looks for the slicer

`SLICER_PATH` always wins. Without it:

- **FULU OrcaSlicer-bambulab** uses `FULU_ORCA_PATH`, `ORCASLICER_BAMBULAB_PATH`, or `ORCA_SLICER_BAMBULAB_PATH`, then the first existing path among `/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer`, `/Applications/Orca Studio.app/Contents/MacOS/OrcaSlicer`, `/Applications/OrcaStudio.app/Contents/MacOS/OrcaStudio`, `/usr/local/bin/orcaslicer`, and `/usr/bin/orcaslicer`, then `orcaslicer` on `PATH`.
- **Bambu Studio** tries `/Applications/BambuStudio.app/Contents/MacOS/BambuStudio`, `/Applications/Bambu Studio.app/Contents/MacOS/BambuStudio`, `/usr/local/bin/bambustudio`, and `/usr/bin/bambustudio`, then `bambustudio` on `PATH`.
- **PrusaSlicer, Slic3r, OrcaSlicer, and CuraEngine** need `SLICER_PATH`.

A per-call `slicer_path` is refused unless `MCP_ALLOW_EXECUTABLE_ARG=1`; see [executable settings](./SETUP.md#executable-settings-stay-in-server-configuration). Slicer runs time out after `SLICER_TIMEOUT_MS` (10 minutes by default).

## Profiles

`SLICER_PROFILE` (or the `slicer_profile` argument) and `FILAMENT_PROFILE` (or `filament_profile`) mean different things for each slicer:

| Slicer | `SLICER_PROFILE` | Filament profile |
|---|---|---|
| PrusaSlicer, Slic3r | One config file exported from the slicer (File > Export > Export Config), containing printer, print, and filament settings | Not used; include filament settings in the exported config |
| Generic OrcaSlicer (no `bambu_model`) | Machine and process JSON files separated by `;`, optionally followed by a filament file (see below) | Loaded with `--load-filaments` |
| CuraEngine | A Cura definition JSON | Not used |
| Bambu Studio, FULU OrcaSlicer-bambulab, or OrcaSlicer with `bambu_model` | **One process profile only.** The machine preset always comes from the printer model and nozzle; a `machine;process` list is rejected with instructions | `;`-separated, in slot order, loaded with `--load-filaments` |

For generic OrcaSlicer, a filament file can ride along in the profile setting after a pipe character:

```env
SLICER_PROFILE=/path/to/machine.json;/path/to/process.json|/path/to/filament.json
```

Generic OrcaSlicer writes `plate_1.gcode`; the server renames it after the input model and returns that path. Do not use this form for Bambu Lab slicing: pass `bambu_model` (or use Bambu Studio or FULU OrcaSlicer-bambulab) and give only a process profile.

## Bambu-compatible slicing

Bambu Studio, FULU OrcaSlicer-bambulab, and OrcaSlicer with `bambu_model` produce a sliced Bambu `.3mf`. Before the slicer runs, the server prepares the profiles itself:

1. **Machine preset.** It takes the model from `bambu_model` (or `BAMBU_MODEL`, asked for through elicitation when missing) and the nozzle from `nozzle_diameter` (or `NOZZLE_DIAMETER`, default 0.4), and finds the exact `<model> <diameter> nozzle` machine preset, such as `Bambu Lab P1S 0.4 nozzle`, in the selected installation's `BBL` profile tree. The tree is found from `SLICER_PATH`, or set with `BAMBU_PROFILES_ROOT` for AppImages and non-standard installs. A preset is never borrowed from another installation.
2. **Resolution.** `inherits` and `include` chains are flattened, and the model's `cli_config.json` entry is validated. Custom process and filament parents are looked up in `BAMBU_SLICER_PROFILE_DIRS` (default: the slicers' user `system/BBL` directories), never machine presets.
3. **Process and filaments.** `slicer_profile`, a template, or `BAMBU_TEMPLATE_3MF_PATH` supplies process settings. Machine settings carried by process, filament, or template files are dropped, so they cannot replace the selected preset's start G-code.
4. **Checks.** Missing presets, wrong nozzle sizes, missing parents or includes, cycles, malformed profiles, missing process or filament files, and machine/process lists in `slicer_profile` all stop before the slicer runs.
5. **Output.** The result must contain a nonempty `Metadata/plate_<n>.gcode`. A checksum-only archive, missing output, or a stale file from an earlier run is an error. Slicer failures report the exit code or signal, whether it timed out, the tails of stdout and stderr, and slicing-specific suggestions. Bambu Studio and OrcaSlicer failures also name the CLI's own reason, from the `result.json` it writes on Linux or from its exit code.

Slicing accepts `p1s`, `p1p`, `p2s`, `x1c`, `x1e`, `a1`, `a1mini`, `h2d`, `h2s`, and `h2c` when the installed slicer has that preset. Printing accepts `p1s`, `p1p`, `x1c`, `x1e`, `a1`, `a1mini`, and `h2d`.

`slice_stl` and `slice_with_template` also take `bed_type`, `nozzle_type`, `load_filaments`, `load_filament_ids`, `filament_colours`, template selection, and the Bambu CLI placement and transform options (`orient`, `arrange`, `ensure_on_bed`, `repetitions`, `clone_objects`, `skip_objects`, `slice_plate`, `scale`, `rotate`, `rotate_x`, `rotate_y`, `uptodate`, `min_save`, `skip_modified_gcodes`, `enable_timelapse`, `allow_mix_temp`). See the [slicing tools reference](../README.md#slice_stl).

**OrcaSlicer CLI limits.** OrcaSlicer 2.4.2's CLI segfaults in `PartPlate::check_outside`, which needs the GUI, when `scale`, `rotate_x` or `rotate_y` moves an object below the bed while it arranges, the default for STL input. OrcaSlicer fixed this after 2.4.2 in [#14415](https://github.com/OrcaSlicer/OrcaSlicer/pull/14415), first released in 2.5.0-alpha. Orca rotates about the object's origin, so even a rotation that shrinks a part's height can crash it. For STL input with `orcaslicer` or `orcaslicer-bambulab`, the server applies `scale`, `rotate_x`, `rotate_y` and, with any of them, `rotate` to a copy of the mesh, and omits those flags. It follows Orca's own composition, whatever the argument order: scale, then X, then Y, then Z. A 10 × 20 × 30 mm box turned 90° about Z and X is therefore 20 mm tall. Orca then places the copy on the plate, and the copy is deleted after slicing. A `rotate` alone stays a CLI flag. For a 3MF, `arrange: true` with `scale` above 1, `rotate_x` or `rotate_y` is refused before slicing; set `arrange` to false or transform the object in the slicer. `repetitions` on an STL becomes Orca's `--clone-objects` and cannot be combined with `clone_objects`. `clone_objects` takes one total copy count: the CLI counts copies per input file, and this tool loads one file. Bambu Studio receives every flag unchanged. The crash and its fix were found in bambu-printer-mcp 1.1.34 with a 140-run OrcaSlicer 2.4.2 option matrix on Linux; this server's regressions use a fake CLI that records the mesh it receives.

**Evidence.** Bambu Studio 02.01.01.52 sliced a P1S 0.4 nozzle job through this path, including a 9.7 MB refitted phone-case STL in Bambu TPU 95A HF (230 °C nozzle, 35 °C plate, about 1 h 38 min and 21 g); see the [Blender guide's worked example](./BLENDER.md#worked-example-refit-a-phone-case-for-a-new-phone). Before this change, Bambu Studio rejected the raw inherited P1S preset with exit 239 ("process not compatible with printer"). Other slicer versions and models have not been tested here.

## Slicing templates

A template is a saved `.3mf`, `.json`, or `.config` file whose slicer settings are reused as the process profile. Templates live in a local registry, `BAMBU_TEMPLATE_DIR` (default `~/Sync/bambu/templates`); every tool also accepts a `template_dir` override.

- `save_template` copies a file into the registry under a name (default: the source filename).
- `list_templates` lists the saved templates.
- `get_slice_settings` shows a template's or file's layer height, infill, walls, supports, brim, bed, printer, and filaments without slicing.
- `slice_with_template` slices with a named template. The machine preset still comes from `bambu_model` and `nozzle_diameter`, and an explicit `slicer_profile` in the call overrides the template.

`slice_stl` accepts `template_3mf_path` or `template_name` too, and uses `BAMBU_TEMPLATE_3MF_PATH` as a default template when set.

## Printing what you sliced

- **G-code (any backend):** `upload_gcode` with `gcode_path` and `print: true` inspects the exact file, checks the printer, asks a human to confirm, and starts it. Without `print`, the file is only uploaded. Printing needs a declared material: `; filament_type` in the G-code or the `material` argument.
- **Sliced Bambu `.3mf`:** `print_3mf` inspects the selected plate, compares it with a fresh printer report, asks a human to confirm, then uploads the project over FTPS and starts it over MQTT. It works only with `PRINTER_TYPE=bambu`, and `bed_type` must match the plate's bed metadata. The job's nozzle type must also match the printer's reported nozzle: Bambu machine presets assume the stock nozzle (stainless steel on P1S, P1P, and A1; hardened steel on X1C and X1E), so if you upgraded yours, slice with `nozzle_type` (or set `BAMBU_NOZZLE_TYPE`). After the print command, the server watches the printer's reports and says whether it started, stayed silent, or was refused by the firmware.
- **Check first:** `confirm_temperatures` reports every heater target in a G-code file (`S` and `R` forms, tool-addressed, RepRapFirmware `G10`/`M568`, and Klipper `SET_HEATER_TEMPERATURE`). An expected temperature matches only when it equals the file's highest target, returned as `peak`. It does not change the file.

### `print_3mf` auto-slicing

If a `.3mf` passed to `print_3mf` has no plate G-code, the server tries to slice it first with the configured Bambu-compatible slicer and your printer model's machine preset. If slicing fails, or the selected plate still has no G-code, `print_3mf` stops with an error and never uploads the original project. Export a sliced plate from the GUI (Path A) for the most predictable result.

Layer height, temperatures, and other slicer settings are baked into the sliced file. Change them in the slicer and slice again; `print_3mf` accepts `layer_height`, `nozzle_temperature`, `bed_temperature`, and `support_enabled` but does not apply them.

### `process_and_print_stl`

This one-call pipeline extends the model's base (`extension_inches`, converted at 25.4 mm per inch), slices it, and prints it through the same checked gate as `upload_gcode` and `print_3mf`, including the human confirmation. If you pass `extruder_temp` or `bed_temp`, each must equal the sliced job's highest target (`S` and `R` forms, every tool); otherwise nothing is uploaded. Pass `material` when the sliced G-code has no `filament_type` metadata. For a Bambu printer with a Bambu-compatible slicer, the sliced `.3mf` goes through the `print_3mf` checks.

Use the separate `slice_stl`, `confirm_temperatures`, and `upload_gcode` steps when you want to inspect the sliced file before the print is offered for confirmation.

## Slicing in Docker

The Docker image does not include a slicer, and a slicer installed on the host generally cannot run inside the container because of library and OS differences. To slice in a container, build a derived image that installs a Linux build of your slicer, set `SLICER_PATH` to its path inside the container, and set `BAMBU_PROFILES_ROOT` if its profile tree is not found automatically. See [Running with Docker](./SETUP.md#running-with-docker).

## Troubleshooting

- **The slicer opens its GUI or hangs:** some slicers fall back to the GUI when the command line is incomplete. Configure a complete `SLICER_PROFILE` and check that `SLICER_PATH` points at the executable, not the app bundle folder.
- **PrusaSlicer ignores my settings:** `SLICER_PROFILE` must be a single exported config file, not a folder of profiles.
- **Bambu slicing cannot find the machine preset:** point `SLICER_PATH` at the executable inside a full Bambu Studio, OrcaSlicer, or FULU OrcaSlicer-bambulab install that includes your model and nozzle, or set `BAMBU_PROFILES_ROOT` to its profile tree. `SLICER_PROFILE` cannot supply a machine preset.
- **`slicer_profile` is rejected for listing a machine preset:** on the Bambu-compatible path, pass only the process profile. The machine preset comes from `bambu_model` and `nozzle_diameter`.
- **A custom process or filament profile's parent is missing:** add the directory holding it to `BAMBU_SLICER_PROFILE_DIRS`.
- **The slice fails with an exit code:** read the reported reason, output tails and suggestions. The reason after the command comes from the CLI's `result.json` or its exit code; for example Bambu Studio's exit 239 (`-17`) means the process profile does not fit the printer preset, and exit 206 (`-50`) means no object sits fully on a plate.
- **A 3MF slice with `scale`, `rotate_x` or `rotate_y` is refused for OrcaSlicer:** with `arrange: true` that combination crashes Orca's CLI. Set `arrange` to false, or apply the transform in the slicer and export the project; see [OrcaSlicer CLI limits](#bambu-compatible-slicing).
- **FULU OrcaSlicer-bambulab CLI crashes:** FULU v1.0.0's CLI crashes on every run in `PartPlate::invalidate_plate_name_texture` (fixes proposed in [FULU #56](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/pull/56) and [FULU #57](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/pull/57)); see [upstream bugs](./FULU.md#upstream-bugs-and-workarounds) and [current FULU status](./FULU.md#current-status). Export from FULU's GUI, or use upstream OrcaSlicer's or Bambu Studio's CLI.
- **Long slices time out:** raise `SLICER_TIMEOUT_MS`.
