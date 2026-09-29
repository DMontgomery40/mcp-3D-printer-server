# MCP 3D Printer Server

> **Thank you, [FULU Foundation](https://www.fulu.org/), [Louis Rossmann](https://www.youtube.com/@rossmanngroup), and the [OrcaSlicer-bambulab contributors](https://github.com/FULU-Foundation/OrcaSlicer-bambulab).** Thank you for standing up for consumer ownership, open-source developers, repair rights, and owners whose working hardware should not be made worse by locked-down software.
>
> This server treats the FULU OrcaSlicer-bambulab fork as a first-class slicer for Bambu Lab projects. See the [FULU guide](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/FULU.md) for setup and current status.

[![npm version](https://img.shields.io/npm/v/mcp-3d-printer-server.svg)](https://www.npmjs.com/package/mcp-3d-printer-server)
[![Downloads](https://img.shields.io/npm/dm/mcp-3d-printer-server.svg)](https://www.npmjs.com/package/mcp-3d-printer-server)
[![License: GPL-2.0](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![Tested with Node.js 24](https://img.shields.io/badge/tested%20with-Node.js%2024-green.svg)](https://nodejs.org/en/download/)
[![GitHub stars](https://img.shields.io/github/stars/DMontgomery40/mcp-3D-printer-server.svg?style=social&label=Star)](https://github.com/DMontgomery40/mcp-3D-printer-server)

An MCP server that connects Claude, Codex, and other MCP clients to 3D printers running OctoPrint, Klipper (Moonraker), Duet, Repetier-Server, Bambu Lab, PrusaLink or Prusa Connect, and Creality. Your agent can check status, upload and start jobs, cancel prints, edit STL meshes, run your slicer, and hand models to Blender through an optional Blender MCP bridge.

**[Browse the documentation site](https://dmontgomery40.github.io/mcp-3D-printer-server/)** for searchable setup guides, per-printer credentials, slicing, and the full tool reference. It is generated from this README and the docs folder.

**Only print on Bambu Lab printers?** [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) is a Bambu-focused fork of this project with more Bambu features, including AMS inventory and matching, camera snapshots, and print preflight checks.

Built with help from our [contributors](./CONTRIBUTORS.md). Thank you to everyone sharing fixes, careful bug reports, and real printer testing!

---

## Set up with your agent

Tell your agent which **printer system** you use (OctoPrint, Klipper, Bambu Lab, Prusa, and so on) and its **address**, if you know them, then copy and paste this:

```text
Install mcp-3d-printer-server in the agent/harness I'm using now.

Read https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md
for the current setup instructions and supported printer backends.

Detect my OS and harness, then use its native MCP configuration or installer.
Preserve my existing servers and settings. Prefer the published npm package
(npx -y mcp-3d-printer-server, stdio); use Node.js 24 if a runtime is needed.

Ask which printer system I use and set PRINTER_TYPE to match. Never guess it.
Then ask only for the values that backend needs:
- octoprint: PRINTER_HOST, PRINTER_PORT if not 80, API_KEY
- klipper (Moonraker): PRINTER_HOST, PRINTER_PORT (usually 7125)
- duet: PRINTER_HOST, PRINTER_PORT if not 80
- repetier: PRINTER_HOST, PRINTER_PORT (usually 3344), API_KEY
- bambu: PRINTER_HOST, BAMBU_SERIAL, BAMBU_TOKEN (the LAN access code),
  and BAMBU_MODEL
- prusa: PRINTER_HOST (PrusaLink address or connect.prusa3d.com), API_KEY
- creality: PRINTER_HOST, PRINTER_PORT if not 80, API_KEY (bearer token)
For Bambu Lab, confirm the exact printer model with me; never guess it, and
explain any LAN Only Mode or Developer Mode setting I need to enable.
Keep keys, tokens, and access codes in local/private configuration; do not
repeat them in chat.

Bambu Lab has the most hardware testing. The other backends use each
system's HTTP API and rely on community reports, so tell me plainly if a
backend does not respond as the guide describes.

Offer these optional extras, and set them up only if I choose them:
- Blender MCP for model edits: uvx mcp-for-blender (formerly blender-mcp,
  which now installs it as a compatibility wrapper). Its Blender addon must be
  installed, enabled, and connected inside Blender.
- A slicer for slice_stl: look for an installed PrusaSlicer, OrcaSlicer,
  FULU OrcaSlicer-bambulab, Bambu Studio, or CuraEngine before suggesting
  an install.
Configure executables in the server environment. Do not enable
MCP_ALLOW_EXECUTABLE_ARG.

Verify that the MCP initializes, lists its tools, and reads printer status.
Do not start a print or change printer settings, including temperatures, as
a setup test. Tell me what worked and whether I need to restart or reload
the harness.
```

[Setup reference](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md) · [Printer backends](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md#choose-your-printer-backend) · [Slicing guide](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SLICING.md) · [Blender MCP](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md#blender-mcp-optional)

## What to ask your agent

Ask for the result you want, not the steps. Current models plan across tools: they search the web, read photos, look up exact dimensions, edit models, slice, and print. Expect a question or two when a choice matters, such as which printer or filament to use, or whether to start the print.

This server provides the printer, slicing, and mesh tools. Web search, photos, and Blender edits come from your agent and its other connections, such as a [Blender MCP server](#blender-mcp). What your agent can read back depends on the printer system; see [printer backends](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md#choose-your-printer-backend).

### Start from anything

<!-- lead: verify phone example -->

- **"Here's a phone case on MakerWorld. Make it fit my iPhone 17 Pro Max and print it."**\
  Your agent looks up the phone's published dimensions, refits the case in Blender, slices it for your printer, and checks with you before it starts the print.
- **"Can you print a replacement?"** *(with a photo of a snapped cabinet clip)*\
  It asks for a measurement or two where the fit matters, models the part, and prints it on the printer you choose.
- **"Make this bracket 20% bigger and give it a thicker base."**\
  It scales the STL, extends the base, and reports the new dimensions before it slices anything.

### Check on any printer

- **"How far along is the Bambu print?"**\
  It requests a fresh status report and gives you progress, the current layer, and time remaining.
- **"Is the Prusa done yet?"**\
  It reads the printer's status through PrusaLink and reports its state and job progress.
- **"What are the bed and nozzle temperatures on the OctoPrint printer?"**\
  It reads OctoPrint's printer state, including current and target temperatures.
- **"The first layer isn't sticking. Cancel it."**\
  It sends the cancel command through that printer's backend, then checks the printer's status.

### Slice and print

- **"Print this in PETG."** *(with an STL)*\
  It slices with the PETG filament profile you've set up, checks the temperatures in the G-code, and uploads the job once you confirm.
- **"Print the bracket I sliced last night on the Bambu."**\
  It checks that the `.3mf` contains sliced plate G-code, then uploads and starts it for your configured printer model.
- **"Send benchy.gcode to the Klipper printer, but don't start it yet."**\
  It uploads the file through Moonraker so you can start it later.

<details>
<summary><strong>Start here</strong></summary>

## Start here

| I want to… | Read next |
|---|---|
| Connect this MCP to my agent | [Copy the setup request](#set-up-with-your-agent) |
| See what my agent can do with it | [What to ask your agent](#what-to-ask-your-agent) |
| Find the credentials for my printer | [Printer backend setup](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md#printer-backend-setup) |
| Configure it by hand, with Docker, or over HTTP | [Installation and configuration reference](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md) |
| Slice from my agent or troubleshoot slicing | [Slicing guide](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SLICING.md) |
| Use open-source slicing for a Bambu Lab printer | [FULU guide](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/FULU.md) |
| Edit an STL through Blender | [Blender MCP](#blender-mcp) |
| See release changes or contributor credit | [Changelog](./CHANGELOG.md), [releases](https://github.com/DMontgomery40/mcp-3D-printer-server/releases), and [contributors](./CONTRIBUTORS.md) |

</details>

<details>
<summary><strong>What's new</strong></summary>

## What's new

See the [changelog](./CHANGELOG.md) for versioned changes. Release 1.2.9 fixes Bambu FTPS uploads that failed with "Premature close" ([#22](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/22)), adds standard Blender MCP discovery, forwarding, and verified STL edits, requires the Bambu printer model for raw print starts, and isolates each server's scratch files. Per-call executable selectors, such as a slicer path or bridge command, now require an explicit opt-in.

</details>

<details>
<summary><strong>Table of Contents</strong></summary>

## Table of Contents

- [Set up with your agent](#set-up-with-your-agent)
- [What to ask your agent](#what-to-ask-your-agent)
- [Start here](#start-here)
- [What's new](#whats-new)
- [Description](#description)
- [FULU and open-source printing](#fulu-and-open-source-printing)
- [Features](#features)
- [Available Tools](#available-tools)
  - [STL Manipulation Tools](#stl-manipulation-tools)
  - [Printer Control Tools](#printer-control-tools)
  - [Bambu-Specific Tools](#bambu-specific-tools)
  - [Slicing Tools](#slicing-tools)
  - [Advanced Tools](#advanced-tools)
- [Available Resources](#available-resources)
- [Printer Limitations](#printer-limitations)
- [General Limitations and Considerations](#general-limitations-and-considerations)
- [MCP Safety Notes](#mcp-safety-notes)
- [License](#license)
- [Acknowledgements](#acknowledgements)

</details>

<details>
<summary><strong>Description</strong></summary>

## Description

`mcp-3d-printer-server` is a Model Context Protocol server for 3D printers. It gives an agent printer control (status, files, upload, start, cancel, and temperatures), STL mesh tools, slicer automation, Bambu Lab project printing, and an optional bridge to a Blender MCP server. One `PRINTER_TYPE` selects the default backend, and every printer tool accepts a per-call `type` and `host`, so one server can reach more than one printer.

| Backend | `PRINTER_TYPE` | Testing evidence |
|---|---|---|
| Bambu Lab | `bambu` | Most tested, including maintainer hardware testing shared with the Bambu-only fork |
| OctoPrint | `octoprint` | Community-reported |
| Klipper (Moonraker) | `klipper` | Community-reported, including a Creality K1 Max through Moonraker |
| PrusaLink and Prusa Connect | `prusa` | Community-reported |
| Duet | `duet` | Implemented; no hardware reports yet |
| Repetier-Server | `repetier` | Implemented; no hardware reports yet |
| Creality | `creality` | Implemented; no hardware reports yet |

What each backend reads and sends differs. See [printer backend setup](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md#printer-backend-setup) for the exact API calls, credentials, and linked reports.

**Note on resource usage.** The STL tools load the entire mesh into memory. Large or complex files (over about 10 MB) can use a lot of memory. See [General Limitations and Considerations](#general-limitations-and-considerations).

</details>

<details>
<summary><strong>FULU and open-source printing</strong></summary>

## FULU and open-source printing

[FULU OrcaSlicer-bambulab](https://github.com/FULU-Foundation/OrcaSlicer-bambulab) is a first-class slicer target for Bambu Lab projects (`SLICER_TYPE=orcaslicer-bambulab`; aliases include `fulu-orca` and `orca-studio`), and the default slicer when `PRINTER_TYPE=bambu` and no slicer is configured. `slice_stl` and `print_3mf` auto-slicing use its project command line, and `check_fulu_orca_setup` inspects the install and runtime payload.

The optional FULU **BambuNetwork bridge** is a separate runtime. `fulu_bambu_network_rpc` can probe it and send guarded RPC calls, but the server never switches a print from its local MQTT and FTPS path to BambuNetwork or the cloud on its own.

**[Follow the FULU guide](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/FULU.md)** for platform runtime setup, bridge probes, and the current macOS and Windows testing status.

</details>

<details>
<summary><strong>Features</strong></summary>

## Features

- Seven printer backends, selected with `PRINTER_TYPE`: OctoPrint, Klipper (Moonraker), Duet, Repetier-Server, Bambu Lab, PrusaLink or Prusa Connect, and Creality
- Per-call `type`, `host`, `port`, and `api_key` arguments for working with more than one printer
- Printer status, file listing, G-code upload from inline content or a local path, starting a stored file, cancelling a job, and setting bed or nozzle temperatures
- STL tools: inspect dimensions, scale, rotate, translate, extend the base, merge vertices, center, lay flat, transform one section of a model, and render multi-angle SVG previews
- Slicing through PrusaSlicer, Slic3r, OrcaSlicer, CuraEngine, FULU OrcaSlicer-bambulab, or Bambu Studio command lines, with G-code temperature checks and a one-call process-and-print pipeline
- Bambu Lab project printing: upload a sliced `.3mf` over FTPS and start it over MQTT with the plate's G-code path, MD5, AMS mapping, and calibration flags; auto-slice unsliced projects with FULU OrcaSlicer-bambulab or Bambu Studio
- Required Bambu printer model for print operations, asked for through MCP elicitation when missing
- FULU OrcaSlicer-bambulab setup inspection and guarded BambuNetwork bridge RPC
- Optional Blender MCP bridge: discover a standard Blender MCP server's tools, forward calls, and run verified STL edits
- Slicer, bridge, and Blender executables come from server configuration unless you explicitly opt in to per-call selectors
- MCP resources for printer status, files, and file details
- Transports: stdio (default) and streamable HTTP, plus a Docker image

</details>

<details>
<summary><strong>Available Tools</strong></summary>

## Available Tools

<details>
<summary><strong>STL Manipulation Tools</strong></summary>

### STL Manipulation Tools

All STL tools load the full mesh into memory. Tools that change a model write a new file to the server's temporary directory, named after the input with a suffix such as `_scaled`, and return its path; the input file is not modified.

#### get_stl_info

Inspect an STL file without modifying it. Returns the bounding box, dimensions, center, vertex count, and face count.

```json
{
  "stl_path": "/path/to/model.stl"
}
```

#### scale_stl

Scale a model uniformly with `scale_factor`, or per axis with `scale_x`, `scale_y`, and `scale_z`. When any axis value is given, unspecified axes stay at 1.0.

```json
{
  "stl_path": "/path/to/model.stl",
  "scale_factor": 1.2
}
```

```json
{
  "stl_path": "/path/to/model.stl",
  "scale_x": 1.2,
  "scale_y": 1.0,
  "scale_z": 1.5
}
```

#### rotate_stl

Rotate a model around the X, Y, and Z axes, in degrees. Omitted axes default to 0.

```json
{
  "stl_path": "/path/to/model.stl",
  "rotate_x": 0,
  "rotate_y": 0,
  "rotate_z": 90
}
```

#### translate_stl

Move a model along the X, Y, and Z axes, in millimeters. Omitted axes default to 0.

```json
{
  "stl_path": "/path/to/model.stl",
  "translate_x": 10,
  "translate_y": 5,
  "translate_z": 0
}
```

#### extend_stl_base

Add solid geometry underneath the model to raise and widen its base. `extension_inches` is in **inches** and is converted to millimeters (25.4 mm per inch).

```json
{
  "stl_path": "/path/to/model.stl",
  "extension_inches": 0.25
}
```

#### merge_vertices

Merge vertices closer together than `tolerance` (millimeters, default 0.01). This can close small gaps and slightly simplify the mesh.

```json
{
  "stl_path": "/path/to/model.stl",
  "tolerance": 0.01
}
```

#### center_model

Move the model so the center of its bounding box is at the origin (0, 0, 0).

```json
{
  "stl_path": "/path/to/model.stl"
}
```

#### lay_flat

Find the model's largest flat face and rotate the model so that face rests on the XY plane (Z = 0). Works best on models with a clearly dominant flat face.

```json
{
  "stl_path": "/path/to/model.stl"
}
```

#### modify_stl_section

Apply a scale, rotation, or translation to one section of a model: the `top`, `bottom`, or `center` third of its bounding box, or a `custom` box. `value_x`, `value_y`, and `value_z` are scale factors, degrees, or millimeters depending on `transformation_type`.

```json
{
  "stl_path": "/path/to/model.stl",
  "section": "top",
  "transformation_type": "scale",
  "value_x": 1.5,
  "value_y": 1.5,
  "value_z": 1.5
}
```

A `custom` section requires all six bounds:

```json
{
  "stl_path": "/path/to/model.stl",
  "section": "custom",
  "transformation_type": "rotate",
  "value_x": 0,
  "value_y": 0,
  "value_z": 45,
  "custom_min_x": -10,
  "custom_min_y": 0,
  "custom_min_z": -10,
  "custom_max_x": 10,
  "custom_max_y": 20,
  "custom_max_z": 10
}
```

#### generate_stl_visualization

Render an SVG with front, side, top, and isometric views of a model. `width` and `height` set each view's size in pixels (default 300).

```json
{
  "stl_path": "/path/to/model.stl",
  "width": 400,
  "height": 400
}
```

The SVG is a simplified schematic, not a photorealistic render.

</details>

<details>
<summary><strong>Printer Control Tools</strong></summary>

### Printer Control Tools

Every printer tool accepts `host`, `port`, `type`, and `api_key`, and Bambu printers also use `bambu_serial` and `bambu_token`. Omitted values fall back to `PRINTER_HOST`, `PRINTER_PORT`, `PRINTER_TYPE`, `API_KEY`, `BAMBU_SERIAL`, and `BAMBU_TOKEN`. Keep keys in the server configuration rather than passing them in calls.

What each call does depends on the backend; see [printer backend setup](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md#printer-backend-setup) for the exact API routes.

#### get_printer_status

Read the printer's current status. The response is the backend's own status data: Bambu returns temperatures, job state, progress, layers, time remaining, and AMS data; OctoPrint returns printer state and temperatures; Klipper returns the Moonraker host state only.

```json
{
  "type": "klipper",
  "host": "192.168.1.50",
  "port": "7125"
}
```

#### list_printer_files

List the files stored on the printer or its host software. On Bambu printers it lists the `cache/`, `timelapse/`, and `logs/` directories.

```json
{
  "type": "octoprint",
  "host": "192.168.1.100"
}
```

#### upload_gcode

Upload G-code to the printer, and optionally start it. Pass `gcode_path` for a local file, or `gcode` with the content (or a local path). `filename` defaults to the basename of `gcode_path`. With `print: true` the backend starts the job after the upload; on Bambu printers that also requires the printer model (`bambu_model` or `BAMBU_MODEL`).

<!-- lead: sync after safety + blender integration -->

```json
{
  "type": "klipper",
  "host": "192.168.1.50",
  "port": "7125",
  "gcode_path": "/path/to/benchy.gcode",
  "print": false
}
```

On Bambu printers, files go to `cache/` over FTPS. Automatic printing after upload supports `.gcode` only; print `.3mf` projects with `print_3mf`.

#### start_print

Start a file that is already on the printer. On Bambu printers it requires the printer model and supports `.gcode` files only; bare filenames are looked up in `cache/`.

<!-- lead: sync after safety + blender integration -->

```json
{
  "type": "octoprint",
  "host": "192.168.1.100",
  "filename": "benchy.gcode"
}
```

#### cancel_print

Cancel the current print job. There is no pause or resume tool; cancelling is not resumable.

```json
{
  "type": "prusa",
  "host": "192.168.1.120"
}
```

#### set_printer_temperature

Set a target temperature for a printer component. Use `bed` or `extruder`; Bambu also accepts `nozzle`, `tool`, and `tool0`, and limits targets to 0 through 300 °C.

<!-- lead: sync after safety + blender integration -->

```json
{
  "type": "klipper",
  "host": "192.168.1.50",
  "port": "7125",
  "component": "bed",
  "temperature": 60
}
```

</details>

<details>
<summary><strong>Bambu-Specific Tools</strong></summary>

### Bambu-Specific Tools

These tools work with `PRINTER_TYPE=bambu` (or `type: "bambu"`). Set up LAN Only Mode, the serial number, the access code, and the model as described in [Bambu Lab setup](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md#bambu-lab).

#### print_3mf

Upload a sliced `.3mf` project to a Bambu printer over FTPS and start it with an MQTT `project_file` command that carries the plate's G-code path, its MD5, the AMS mapping, and the calibration flags. **`bambu_model` is required** (or `BAMBU_MODEL`); without it the server asks through MCP elicitation when the client supports it, or returns an error. The wrong model can crash the bed into the nozzle.

<!-- lead: sync after safety + blender integration -->

```json
{
  "three_mf_path": "/path/to/bracket.gcode.3mf",
  "bambu_model": "p1s",
  "bed_type": "textured_plate",
  "use_ams": true,
  "ams_mapping": { "Generic PLA": 0 },
  "bed_leveling": true,
  "flow_calibration": true,
  "vibration_calibration": true,
  "layer_inspect": true,
  "timelapse": false
}
```

- If the project has no plate G-code, the server tries to [auto-slice it](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SLICING.md#print_3mf-auto-slicing) with FULU OrcaSlicer-bambulab or Bambu Studio. If slicing fails, it stops with an error before uploading.
- `ams_mapping` is an object whose values are AMS slot numbers. When it is omitted, the mapping embedded in the 3MF is used; with no mapping at all, the print runs without AMS. `use_ams: false` turns AMS off.
- `bed_type` is one of `textured_plate`, `cool_plate`, `engineering_plate`, or `hot_plate` (default `textured_plate`, or `BED_TYPE`).
- Calibration flags default to on (timelapse to off) when omitted.
- `layer_height`, `nozzle_temperature`, `bed_temperature`, and `support_enabled` are accepted but not applied: those settings are baked into the sliced file. Change them in the slicer.
- A success response means the command was sent, not that the print started cleanly. Check the printer's status afterward.

#### check_fulu_orca_setup

Inspect a FULU OrcaSlicer-bambulab install: the executable, the platform runtime payload, the install and verify commands, and optionally a BambuNetwork bridge handshake. Paths default to the server environment; see [checking the setup](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/FULU.md#check-the-setup-through-mcp).

```json
{
  "platform": "darwin",
  "run_bridge_probe": true
}
```

`bridge_command`, and `slicer_path`, `plugin_dir`, or `runtime_dir` with `run_bridge_probe: true`, require `MCP_ALLOW_EXECUTABLE_ARG=1`.

#### fulu_bambu_network_rpc

Call one FULU BambuNetwork bridge method. Read-only methods such as `bridge.handshake`, `bridge.runtime_info`, and `net.get_user_print_info` are allowed by default; anything that can change account, printer, cloud, or print state requires `allow_mutating_method: true`, and print methods also require `bambu_model`. See [bridge RPC](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/FULU.md#bridge-rpc).

```json
{
  "method": "bridge.handshake"
}
```

The bridge command comes from `FULU_BAMBU_BRIDGE_COMMAND`; a per-call `bridge_command` requires `MCP_ALLOW_EXECUTABLE_ARG=1`.

</details>

<details>
<summary><strong>Slicing Tools</strong></summary>

### Slicing Tools

See the [slicing guide](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SLICING.md) for slicer types, profiles, and troubleshooting. Slicing a file yourself in the slicer's GUI and uploading the result is the most predictable path.

#### slice_stl

Slice an STL (or a 3MF, for Bambu project slicers) with the configured slicer and return the output path: G-code for PrusaSlicer, Slic3r, OrcaSlicer, and CuraEngine, or a sliced `.3mf` for FULU OrcaSlicer-bambulab and Bambu Studio. Bambu project slicers require `bambu_model` (or `BAMBU_MODEL`) to load the right machine preset.

<!-- lead: sync after safety + blender integration -->

```json
{
  "stl_path": "/path/to/model.stl",
  "slicer_type": "orcaslicer",
  "slicer_profile": "/path/to/machine.json;/path/to/process.json",
  "filament_profile": "/path/to/petg.json"
}
```

`slicer_type`, `slicer_profile`, and `filament_profile` fall back to `SLICER_TYPE`, `SLICER_PROFILE`, and `FILAMENT_PROFILE`. `nozzle_diameter` (default 0.4) selects the Bambu machine preset. The slicer executable comes from `SLICER_PATH`; a per-call `slicer_path` requires `MCP_ALLOW_EXECUTABLE_ARG=1`.

#### confirm_temperatures

Read the extruder and bed temperatures from a G-code file and compare them with the values you expect. It reports matches and mismatches and does not change the file.

```json
{
  "gcode_path": "/path/to/model.gcode",
  "extruder_temp": 240,
  "bed_temp": 80
}
```

#### process_and_print_stl

Extend an STL's base, slice it, optionally compare temperatures, then upload it and **start printing immediately**. A temperature mismatch is logged as a warning and does not stop the upload. For a Bambu printer with a Bambu project slicer, the sliced `.3mf` goes through the same upload and print command as `print_3mf`, and the printer model is required.

<!-- lead: sync after safety + blender integration -->

```json
{
  "stl_path": "/path/to/model.stl",
  "extension_inches": 0.1,
  "extruder_temp": 210,
  "bed_temp": 60,
  "type": "octoprint",
  "host": "192.168.1.100"
}
```

Use `slice_stl`, `confirm_temperatures`, and `upload_gcode` separately when you want to review the result before the printer starts.

</details>

<details>
<summary><strong>Advanced Tools</strong></summary>

### Advanced Tools

#### Blender MCP

Connect a standard stdio Blender MCP server with `BLENDER_MCP_COMMAND` (for example, the full path to `uvx`) and `BLENDER_MCP_ARGS` (for example `["mcp-for-blender"]`). The [mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) project was formerly published as `blender-mcp`, which still works as a compatibility wrapper. Install and enable its addon in Blender and start the addon's connection. Blender and this server must be able to read the same local files. Printer tools work without Blender configured. See [Blender MCP setup](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md#blender-mcp-optional).

<!-- lead: sync after safety + blender integration -->

#### blender_mcp_status

Inspect the Blender MCP configuration. With `connect: true`, it starts the configured server, initializes it, and lists its tools and input schemas. A successful connection does not prove the addon inside Blender is running; call `get_scene_info` through `blender_mcp_call` to check that.

```json
{
  "connect": true
}
```

#### blender_mcp_call

Call a tool the Blender MCP server advertises, such as `get_scene_info` or `execute_blender_code`, with arguments matching its discovered schema. The full MCP result, including images and errors, is returned. Calls can change the active Blender scene and are never retried automatically. Preserve the user's own words in `user_prompt` when the remote tool asks for it.

```json
{
  "tool_name": "get_scene_info",
  "arguments": { "user_prompt": "Inspect the scene before preparing a print." }
}
```

#### blender_mcp_edit_model

Import an STL into Blender, apply ordered edits, and export a new STL. Supported operations are `decimate:<ratio>` (greater than 0, up to 1), `remesh:<voxel size>` (positive, in STL units), and `boolean_union:<STL path>`. Use `blender_mcp_call` for anything else.

```json
{
  "stl_path": "/path/to/model.stl",
  "output_path": "/path/to/model-edited.stl",
  "operations": ["decimate:0.5"],
  "user_prompt": "Reduce the triangle count for printing.",
  "execute": false
}
```

- The default (`execute: false`) validates the request and returns the plan and generated Python without launching Blender. Set `execute: true` to apply it, reusing the preview's `output_path`.
- Omitting `output_path` selects a unique `model-edited-<id>.stl` beside the input. Existing input and output files are never overwritten.
- The edit requires Object Mode, preserves existing scene objects and selection, and publishes the new STL only after checking a matching export receipt and a valid, finite triangle mesh. Binary STLs up to 256 MiB are validated in small chunks; ASCII STLs are limited to 4 MiB.
- Requests have connection, discovery, and call deadlines (`BLENDER_MCP_TIMEOUT_MS`, default 120000) that also cover file validation. Interrupted edits are never replayed; inspect Blender before retrying, because an edit may already have started.
- A valid STL is not proof of printability. Inspect the result before slicing.

Legacy `BLENDER_MCP_BRIDGE_COMMAND` shell commands remain supported when no standard command is configured. They receive JSON on stdin (`modelPath`, `operations`, `source`, and `stlPath`) and the same JSON in `MCP_BLENDER_PAYLOAD`, and their results report `output_verified: false`. A per-call `bridge_command` requires `MCP_ALLOW_EXECUTABLE_ARG=1`.

</details>

</details>

<details>
<summary><strong>Available Resources</strong></summary>

## Available Resources

Resources follow the MCP resource protocol. They use the configured `PRINTER_TYPE` and credentials; the host segment selects the printer address.

- `printer://{host}/status`: the printer's current status, as returned by `get_printer_status`
- `printer://{host}/files`: the file list, as returned by `list_printer_files`
- `printer://{host}/file/{filename}`: details for one file. On Bambu printers this only reports whether the file exists.

For example, `printer://192.168.1.100/status` reads the status of the printer at that address.

</details>

<details>
<summary><strong>Printer Limitations</strong></summary>

## Printer Limitations

1. **Status depth varies by backend.** Bambu status includes progress, layers, and time remaining. OctoPrint status comes from `/api/printer` (state and temperatures, not job progress). Klipper status comes from Moonraker's `/printer/info`, which reports the host state but not job progress or temperatures. Duet, Repetier, and Creality responses have not been verified on hardware.
2. **Cancel, but no pause.** There is no pause or resume tool. `cancel_print` stops the job.
3. **Plain HTTP for most backends.** OctoPrint, Klipper, Duet, Repetier, and Creality adapters connect over `http://`. The Prusa adapter uses HTTPS for Prusa Connect, an `https://` host, or port 443.
4. **Klipper and Duet send no credentials.** Moonraker must trust the MCP host, and a password-protected Duet cannot be reached yet.
5. **Command sent is not print finished.** A success response means the printer or its host accepted the request. Check status, and the printer itself, before you walk away.
6. **Bambu prints need a sliced project and the right model.** `print_3mf` needs a `.3mf` with `Metadata/plate_<n>.gcode`, uploads it to `cache/`, and starts plate 1. Print settings such as layer height and temperatures cannot be changed at print time. `start_print` handles plain `.gcode` files only.
7. **Bambu AMS mapping is simple.** `ams_mapping` values are sorted and padded to five entries; real behavior still depends on firmware, loaded filament, and the project's metadata. For AMS inventory and color matching, see [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp).
8. **Bambu temperatures go through G-code.** Temperature targets are sent as `M104` or `M140` over MQTT, so the printer's firmware and current state decide whether they apply.
9. **Bambu networking assumes a trusted LAN.** MQTT and FTPS use the printer's self-signed certificate. Uploads use TLS 1.2 with session reuse; confirmation on the X1C firmware reported in [#22](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/22) is still outstanding.

<!-- lead: sync after safety + blender integration -->

</details>

<details>
<summary><strong>General Limitations and Considerations</strong></summary>

## General Limitations and Considerations

### Memory usage

- STL tools load the whole mesh into memory as Three.js geometry. Files over about 10 MB can use several hundred MB of RAM.
- Running several operations in a row on large files can build up memory between garbage collection cycles.
- There is no built-in memory cap. On constrained systems, avoid processing several large files at once.

### STL manipulation limitations

- `lay_flat` looks for the largest flat face; results on organic or rounded models can be unpredictable.
- `extend_stl_base` adds new geometry beneath the model. Complex or non-planar undersides can produce gaps or intersections at the join, so inspect the result.
- `merge_vertices` with a large tolerance can change the model's shape. The 0.01 mm default is safe for most models.
- `modify_stl_section` works best on simple geometry. Non-manifold meshes (holes, overlapping faces, internal geometry) can produce unexpected results for any transformation; repair them first in your slicer or a mesh tool.

### Visualization limitations

- `generate_stl_visualization` produces a simplified schematic, not a true 3D render, and very detailed models may lose detail.

### Performance considerations

- Slicing can take from seconds to several minutes, depending on the model and your CPU. Slicer runs time out after `SLICER_TIMEOUT_MS` (10 minutes by default).
- Large uploads depend on your network and the printer's storage speed.
- Bambu MQTT connections are reused. If a printer restarts or the network drops, the next call reconnects.

</details>

<details>
<summary><strong>MCP Safety Notes</strong></summary>

## MCP Safety Notes

Prompt injection is an open problem for tool-using agents. A downloaded model's description, a README inside an archive, 3MF metadata, or a web page can all contain instructions aimed at your agent. Practical mitigations:

- Treat tool output and downloaded files as untrusted input.
- Keep printer keys and access codes in server configuration, with the least privilege your printer software allows.
- Keep per-call executable selectors off. Slicer, bridge, and Blender commands come from server configuration unless `MCP_ALLOW_EXECUTABLE_ARG=1` is set.
- Confirm prints yourself. Many MCP clients can ask before each tool call; keep that on for tools that start prints or change temperatures.
- Run the streamable HTTP transport on a trusted network. It binds to `127.0.0.1` by default and has no built-in authentication.
- Set `BAMBU_MODEL` correctly and never substitute a similar model.

</details>

<details>
<summary><strong>License</strong></summary>

## License

GPL-2.0. See [LICENSE](./LICENSE) for the full text.

</details>

<details>
<summary><strong>Acknowledgements</strong></summary>

## Acknowledgements

Thank you to the **[FULU Foundation](https://www.fulu.org/), [Louis Rossmann](https://www.youtube.com/@rossmanngroup), and the [OrcaSlicer-bambulab community](https://github.com/FULU-Foundation/OrcaSlicer-bambulab)** for advancing user choice, repair rights, and interoperable tools.

Bambu Lab support builds on community protocol research, including [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI). The Bambu-only fork, [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp), shares its Blender MCP integration and FTPS fixes with this project.

This project is listed in the [Glama MCP server directory](https://glama.ai/mcp/servers/7f6v2enbgk). See [CONTRIBUTORS.md](./CONTRIBUTORS.md) for the people whose code, reports, and printer testing shaped it.

</details>
