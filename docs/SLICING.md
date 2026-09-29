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

Printing a file that is already sliced needs no slicer on the MCP host.

## Slicer types and aliases

Set `SLICER_TYPE` in the server environment, or pass `slicer_type` to a tool.

| `SLICER_TYPE` | Slicer | Output | Also accepted |
|---|---|---|---|
| `prusaslicer` | PrusaSlicer | G-code | `prusa` |
| `slic3r` | Slic3r | G-code | |
| `orcaslicer` | OrcaSlicer | G-code | `orca`, `orca-slicer` |
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

`SLICER_PROFILE` (or the `slicer_profile` argument) and `FILAMENT_PROFILE` (or `filament_profile`) mean slightly different things for each slicer:

| Slicer | Command the server runs | `SLICER_PROFILE` | Filament profile |
|---|---|---|---|
| PrusaSlicer, Slic3r | `--slice --output <file>.gcode --load <profile> <model>` | One config file exported from the slicer (File > Export > Export Config), containing printer, print, and filament settings | Not used; include filament settings in the exported config |
| OrcaSlicer | `--slice 0 --outputdir <dir>`, then each settings file as `--load-settings` and each filament as `--load-filaments` | Machine and process JSON files separated by `;`, optionally followed by a filament file (see below) | Loaded with `--load-filaments` |
| CuraEngine | `slice -l <model> -o <file>.gcode [-j <profile>]` | A Cura definition JSON | Not used |
| FULU OrcaSlicer-bambulab, Bambu Studio | `--slice 0 --export-3mf <file>_sliced.3mf --load-settings <preset> [--load-filaments <filament>] <model>` | Replaces the automatic machine preset; see below | Loaded with `--load-filaments` |

For OrcaSlicer, a filament file can ride along in the profile setting after a pipe character:

```env
SLICER_PROFILE=/path/to/machine.json;/path/to/process.json|/path/to/filament.json
```

OrcaSlicer writes `plate_1.gcode`; the server renames it after the input model and returns that path.

### Bambu machine presets

For FULU OrcaSlicer-bambulab and Bambu Studio, the server needs the printer model (`BAMBU_MODEL` or `bambu_model`, asked for through elicitation when missing) and loads that model's bundled machine preset:

| `BAMBU_MODEL` | Machine preset (with `NOZZLE_DIAMETER`, default 0.4) |
|---|---|
| `p1s` | `Bambu Lab P1S 0.4 nozzle` |
| `p1p` | `Bambu Lab P1P 0.4 nozzle` |
| `x1c` | `Bambu Lab X1 Carbon 0.4 nozzle` |
| `x1e` | `Bambu Lab X1E 0.4 nozzle` |
| `a1` | `Bambu Lab A1 0.4 nozzle` |
| `a1mini` | `Bambu Lab A1 mini 0.4 nozzle` |
| `h2d` | `Bambu Lab H2D 0.4 nozzle` |

The preset JSON is looked up in the slicer bundle's `Resources/profiles/BBL/machine` directory (or the equivalent `resources` directory on Linux). If it is missing, slicing stops with an error.

When you set `SLICER_PROFILE` for these slicers, it is loaded **instead of** the automatic machine preset. Make sure it is a settings file for your exact printer model and nozzle.

<!-- lead: sync after safety + blender integration -->

## Printing what you sliced

- **G-code (any backend):** `upload_gcode` with `gcode_path` and `print: true` uploads and starts it. Without `print`, the file is only uploaded; start it later with `start_print`. On Bambu printers, uploading with `print: true` or calling `start_print` requires the printer model.
- **Sliced Bambu `.3mf`:** `print_3mf` uploads the project over FTPS and starts it over MQTT. It works only with `PRINTER_TYPE=bambu`.
- **Check first:** `confirm_temperatures` reads the extruder and bed temperatures from a G-code file and compares them with the values you expect. It reports; it does not change the file.

### `print_3mf` auto-slicing

If a `.3mf` passed to `print_3mf` has no plate G-code, the server tries to slice it first with the configured Bambu project slicer and your printer model's machine preset. If slicing fails, the error is logged and the original project still has no plate G-code, so `print_3mf` stops with an error before uploading anything. Export a sliced plate from the GUI (Path A) for the most predictable result.

Layer height, temperatures, and other slicer settings are baked into the sliced file. Change them in the slicer and slice again; the printer's print command cannot override them.

### `process_and_print_stl`

This one-call pipeline extends the model's base (`extension_inches`, converted at 25.4 mm per inch), slices it, and then:

- For a G-code result, optionally compares `extruder_temp` and `bed_temp` with the G-code, then uploads the file and **starts printing immediately**. A temperature mismatch is logged as a warning; it does not stop the upload.
- For a sliced Bambu `.3mf` on a Bambu printer, sends it through the same upload and print command as `print_3mf`.

Use the separate `slice_stl`, `confirm_temperatures`, and `upload_gcode` steps when you want to inspect the result before the printer starts.

<!-- lead: sync after safety + blender integration -->

## Slicing in Docker

The Docker image does not include a slicer, and a slicer installed on the host generally cannot run inside the container because of library and OS differences. To slice in a container, build a derived image that installs a Linux build of your slicer, and set `SLICER_PATH` to its path inside the container. See [Running with Docker](./SETUP.md#running-with-docker).

## Troubleshooting

- **The slicer opens its GUI or hangs:** some slicers fall back to the GUI when the command line is incomplete. Configure a complete `SLICER_PROFILE` and check that `SLICER_PATH` points at the executable, not the app bundle folder.
- **PrusaSlicer ignores my settings:** `SLICER_PROFILE` must be a single exported config file, not a folder of profiles.
- **Bambu slicing cannot find the machine preset:** point `SLICER_PATH` at the executable inside a full FULU OrcaSlicer-bambulab or Bambu Studio install, or set `SLICER_PROFILE` to a machine settings file for your exact model.
- **FULU OrcaSlicer-bambulab CLI crashes on macOS:** see [current FULU status](./FULU.md#current-status); Bambu Studio's CLI is a known-good alternative.
- **Long slices time out:** raise `SLICER_TIMEOUT_MS`.
