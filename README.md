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

**Only print on Bambu Lab printers?** [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) is a Bambu-focused fork of this project with more Bambu features, including AMS inventory and matching, camera snapshots, X2D support, and a Claude Desktop extension.

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
MCP_ALLOW_EXECUTABLE_ARG. Leave print confirmation on: do not set
PRINT_REQUIRE_CONFIRMATION=0 or BAMBU_REQUIRE_CONFIRMATION=0 unless I ask
for a headless setup.

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

- **"Here's a phone case on MakerWorld. Make it fit my iPhone 17 Pro Max and print it."**\
  Your agent reads Apple's dimensional drawings, refits the case in Blender around the new camera and buttons, checks the fit, exports a verified STL, slices it for your printer, and asks before it starts the print. [See it worked through](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/BLENDER.md#worked-example-refit-a-phone-case-for-a-new-phone).
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
  It slices with the PETG filament profile you've set up and checks the job's peak temperatures. The server then asks you to confirm before the print starts.
- **"Print the bracket I sliced last night on the Bambu."**\
  It checks the plate's model, nozzle, bed type, materials, and temperatures against the live printer, then asks you to confirm before it uploads and starts the job.
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
| Model or refit a part in Blender | [Blender guide](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/BLENDER.md) and [Blender tools](#blender-mcp) |
| See release changes or contributor credit | [Changelog](./CHANGELOG.md), [releases](https://github.com/DMontgomery40/mcp-3D-printer-server/releases), and [contributors](./CONTRIBUTORS.md) |

</details>

<details>
<summary><strong>What's new</strong></summary>

## What's new

See the [changelog](./CHANGELOG.md) for versioned changes. The next release brings the print safety gate to every printer backend: a human confirms every print start and positive heating command, and the server checks the exact G-code against hardware and material ceilings. It also adds Bambu-compatible CLI slicing with resolved machine presets and a template registry, `blender_mcp_export_stl` for verified STL export from Blender, and this documentation site. Release 1.2.9 fixes Bambu FTPS uploads that failed with "Premature close" ([#22](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/22)), adds standard Blender MCP discovery, forwarding, and verified STL edits, requires the Bambu printer model for raw print starts, and isolates each server's scratch files. Separately, [#20](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/20) and [#21](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/21) made per-call executable selectors, such as a slicer path or bridge command, require an explicit opt-in.

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
- A print and heating safety gate on every backend: the exact G-code is inspected, every heater target is checked against hardware and material ceilings, the printer's state is checked, and a human confirms through MCP elicitation. Heater-off and cancel are never gated
- Slicing through PrusaSlicer, Slic3r, OrcaSlicer, CuraEngine, FULU OrcaSlicer-bambulab, or Bambu Studio command lines, with G-code peak-temperature checks and a one-call process-and-print pipeline
- Bambu-compatible CLI slicing with the exact model and nozzle machine preset resolved from your slicer installation, filament slots and colours, placement options, and a local template registry
- Bambu Lab project printing: upload a sliced `.3mf` over FTPS and start it over MQTT with the plate's G-code path, MD5, AMS mapping, and calibration flags, after checking the plate against a fresh printer report; auto-slice unsliced projects with FULU OrcaSlicer-bambulab or Bambu Studio
- Required Bambu printer model for print operations, asked for through MCP elicitation when missing
- FULU OrcaSlicer-bambulab setup inspection and diagnostic BambuNetwork bridge RPC, with raw print methods refused
- Optional Blender MCP bridge: discover a standard Blender MCP server's tools, forward calls, export named scene objects to a verified STL, and run verified STL edits
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

Every print start and positive heating command, on every backend, goes through a [safety gate](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md#print-and-heating-safety): the server inspects the exact G-code it will start, checks each heater target against hardware and material ceilings, checks that the printer is ready, and asks a human to confirm through MCP elicitation. Turning a heater off (`temperature: 0`) and `cancel_print` are never gated.

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

Upload G-code to the printer, and optionally start it. Pass `gcode_path` for a local file, or `gcode` with the content (or a local path). `filename` defaults to the basename of `gcode_path`; when printing, use a plain filename so the started file is exactly the uploaded one.

```json
{
  "type": "klipper",
  "host": "192.168.1.50",
  "port": "7125",
  "gcode_path": "/path/to/benchy.gcode",
  "print": true,
  "material": "PETG"
}
```

- Without `print`, the file is only uploaded and nothing is inspected or started.
- With `print: true`, the exact uploaded bytes are inspected first (every `S` and `R` heater target, tool changes, and hardware and material ceilings), the printer's state is checked, and a human confirms before the job starts.
- Printing needs a declared material: slicer metadata in the file (`; filament_type = PLA`) or the `material` argument, which must not contradict the file.
- On Bambu printers, files go to `cache/` over FTPS, and printing also needs the model (`bambu_model` or `BAMBU_MODEL`). Automatic printing after upload supports `.gcode` only; print `.3mf` projects with `print_3mf`.

#### start_print

Start a G-code file that is already stored on the printer. The server downloads that exact file, inspects it, checks the printer's state, asks a human to confirm, and then starts a uniquely named checked copy. This works on Bambu Lab, OctoPrint, Klipper (Moonraker), and Duet. Repetier, Prusa, and Creality refuse, because their adapters have no verified download route; use `upload_gcode` with `print: true` instead.

```json
{
  "type": "octoprint",
  "host": "192.168.1.100",
  "filename": "benchy.gcode",
  "material": "PLA"
}
```

Pass `material` when the file has no `filament_type` metadata. On Bambu printers it also needs the model and supports `.gcode` files only; bare filenames are looked up in `cache/`.

#### cancel_print

Cancel the current print job. Cancelling is never gated and also cancels checked prints still waiting to start. There is no pause or resume tool; cancelling is not resumable.

```json
{
  "type": "prusa",
  "host": "192.168.1.120"
}
```

#### set_printer_temperature

Set a target temperature for a printer component. Use `bed` or `extruder`; Bambu also accepts `nozzle`, `tool`, and `tool0`. OctoPrint nozzle targets are sent to `tool0`.

```json
{
  "type": "klipper",
  "host": "192.168.1.50",
  "port": "7125",
  "component": "extruder",
  "temperature": 215,
  "material": "PLA"
}
```

- `temperature` must be a finite number of 0 or more. `0` switches the heater off and is never gated.
- Positive targets are checked before connecting against independent hardware ceilings and the material's ceiling, need a ready printer, and ask a human to confirm.
- Positive nozzle heating needs `material` (for example PLA, PETG, or ABS), including for spools without RFID.
- On Bambu printers, positive heating also needs `bambu_model` (or `BAMBU_MODEL`), and nozzle heating uses `nozzle_diameter` (0.2, 0.4, 0.6, or 0.8; default `NOZZLE_DIAMETER` or 0.4). Both are checked against the live printer.

</details>

<details>
<summary><strong>Bambu-Specific Tools</strong></summary>

### Bambu-Specific Tools

These tools work with `PRINTER_TYPE=bambu` (or `type: "bambu"`). Set up LAN Only Mode, the serial number, the access code, and the model as described in [Bambu Lab setup](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SETUP.md#bambu-lab).

#### print_3mf

Upload a sliced `.3mf` project to a Bambu printer over FTPS and start it with an MQTT `project_file` command that carries the plate's G-code path, its MD5, the AMS mapping, and the calibration flags. **`bambu_model` is required** (or `BAMBU_MODEL`); without it the server asks through MCP elicitation when the client supports it, or returns an error. The wrong model can crash the bed into the nozzle.

Before anything is uploaded, the server inspects a private copy of the selected plate (model, nozzle, bed type, materials, and every heater target). It checks them against per-model hardware limits, material ceilings, and a fresh MQTT report of the printer's model, serial, nozzle, state, errors, and loaded filament. A human then confirms, and the report is checked again before dispatch.

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

- If the project has no plate G-code, the server tries to [auto-slice it](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SLICING.md#print_3mf-auto-slicing) with FULU OrcaSlicer-bambulab or Bambu Studio. If slicing fails, or the selected plate still has no G-code, it stops with an error and never uploads the original project.
- `ams_mapping` is an object whose values are AMS slot numbers. When it is omitted, the mapping embedded in the 3MF is used; with no mapping at all, the print runs without AMS. `use_ams: false` turns AMS off.
- After sending the command, the server watches fresh reports for up to 15 seconds (`BAMBU_DISPATCH_CHECK_MS`) and returns `dispatch: "started"` or `"unconfirmed"`. If the firmware refuses the command (HMS 0500-0500-0001-0007 on firmware 01.08.05 and later without Developer Mode), the call fails and says so; the checked file stays on the printer's storage.
- `nozzle_type` (`stainless_steel`, `hardened_steel`, `tungsten_carbide`, `brass`) sets the installed nozzle when the project must be auto-sliced. The job's nozzle type must match the printer's report.
- `bed_type` is one of `textured_plate`, `cool_plate`, `engineering_plate`, or `hot_plate` (default `BED_TYPE`, else `textured_plate`). It must match the plate's bed metadata, so a file sliced for another plate, or without bed metadata, is refused until `bed_type` matches.
- `nozzle_diameter` accepts 0.2, 0.4, 0.6, or 0.8 (default `NOZZLE_DIAMETER` or 0.4).
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

Call one FULU BambuNetwork bridge method for diagnostics. Read-only methods such as `bridge.handshake`, `bridge.runtime_info`, and `net.get_user_print_info` are allowed by default. Agent and session setup methods require `allow_mutating_method: true`. Raw print methods (such as `net.start_print`), printer messages (`net.send_message`), file transfers, and unknown methods are refused, because they would bypass the print safety gate; print with `print_3mf`. `bambu_model` is informational only. See [bridge RPC](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/FULU.md#bridge-rpc).

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

Slice an STL or 3MF with the configured slicer and return the output path: G-code for PrusaSlicer, Slic3r, generic OrcaSlicer, and CuraEngine, or a sliced `.3mf` for the Bambu-compatible path.

The **Bambu-compatible path** is used for Bambu Studio, FULU OrcaSlicer-bambulab, and OrcaSlicer when the call passes `bambu_model`:

- The machine preset always comes from `bambu_model` (or `BAMBU_MODEL`, asked for when missing) and `nozzle_diameter` (default `NOZZLE_DIAMETER` or 0.4). The exact `<model> <diameter> nozzle` preset must exist in the selected slicer installation. Its `inherits` and `include` chains are resolved before the slicer runs.
- `slicer_profile` (or `SLICER_PROFILE`) is a process profile only. A `machine;process` list is rejected with instructions.
- Slicing accepts `p1s`, `p1p`, `p2s`, `x1c`, `x1e`, `a1`, `a1mini`, `h2d`, `h2s`, and `h2c` when the installed slicer has that preset. Printing still accepts only the seven models in `BAMBU_MODEL`.
- The output must contain a nonempty `Metadata/plate_<n>.gcode`. Failures stop with the slicer's exit code or signal, the tails of its output, and slicing-specific advice.

```json
{
  "stl_path": "/path/to/phone-case.stl",
  "slicer_type": "bambustudio",
  "bambu_model": "p1s",
  "nozzle_diameter": "0.4",
  "bed_type": "textured_plate",
  "load_filaments": "/path/to/filaments/tpu-95a-hf.json",
  "arrange": true,
  "orient": false
}
```

Options for the Bambu-compatible path:

| Argument | What it does |
|---|---|
| `bed_type` | Build plate: `textured_plate`, `cool_plate`, `engineering_plate`, or `hot_plate` (default `BED_TYPE` or `textured_plate`) |
| `nozzle_type` | Installed nozzle: `stainless_steel`, `hardened_steel`, `tungsten_carbide`, or `brass` (default `BAMBU_NOZZLE_TYPE`, else the preset's stock nozzle). Printing requires it to match the printer's reported nozzle |
| `load_filaments` | Filament profile JSON paths in slot order, `;`-separated. One profile applies to every slot; otherwise give one per slot. `filament_profile` is an alias |
| `load_filament_ids` | Comma-separated filament IDs mapping filaments to objects, such as `1,2,3,1` |
| `filament_colours` | One `#RRGGBB` per filament slot, `;`-separated. Defaults to the input 3MF's colours, then each profile's colour |
| `template_3mf_path`, `template_name`, `template_dir` | Reuse a 3MF's or profile's slicer settings as the process profile (defaults: `BAMBU_TEMPLATE_3MF_PATH`, `BAMBU_TEMPLATE_DIR`). An explicit `slicer_profile` takes precedence |
| `uptodate`, `min_save`, `skip_modified_gcodes` | Refresh 3MF presets to the installed slicer, write a smaller 3MF, or ignore custom G-code embedded in an input 3MF |
| `orient`, `arrange`, `ensure_on_bed`, `repetitions`, `clone_objects`, `skip_objects`, `slice_plate` | Placement: auto-orient, auto-arrange (set `false` to keep a layout), drop floating models onto the bed, copies, per-object clone counts, objects to skip, and which plate to slice (0 = all) |
| `scale`, `rotate`, `rotate_x`, `rotate_y` | Transform before slicing (uniform scale; rotations in degrees) |
| `enable_timelapse`, `allow_mix_temp` | Insert timelapse parking moves; allow filaments with different temperature needs on one plate |

Generic slicers keep their own profile formats: PrusaSlicer and Slic3r load one exported config, and generic OrcaSlicer takes `machine.json;process.json`, optionally followed by `|filament.json`. `slicer_type`, `slicer_profile`, and `filament_profile` fall back to `SLICER_TYPE`, `SLICER_PROFILE`, and `FILAMENT_PROFILE`. The slicer executable comes from `SLICER_PATH`; a per-call `slicer_path` requires `MCP_ALLOW_EXECUTABLE_ARG=1`. See the [slicing guide](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/SLICING.md#bambu-compatible-slicing).

#### slice_with_template

Slice an STL or 3MF with a named template from the local template registry. The template supplies the process settings; the machine preset still comes from `bambu_model` and `nozzle_diameter`. It takes the same arguments as `slice_stl`, and an explicit `slicer_profile` in the call overrides the template.

```json
{
  "stl_path": "/path/to/bracket.stl",
  "template_name": "p1s-petg-strong",
  "bambu_model": "p1s"
}
```

#### list_templates

List the saved slicing templates (`.3mf`, `.json`, `.config`) in the registry directory, `BAMBU_TEMPLATE_DIR` (default `~/Sync/bambu/templates`), or in `template_dir`.

```json
{}
```

#### save_template

Copy a local `.3mf`, `.json`, or `.config` file into the template registry. `template_name` defaults to the source filename without its extension.

```json
{
  "source_path": "/path/to/p1s-petg-strong.3mf",
  "template_name": "p1s-petg-strong"
}
```

#### get_slice_settings

Read the slicer settings in a 3MF, an extracted `project_settings.config`, or a profile JSON without slicing: layer height, infill, walls, supports, brim, bed, printer, and filaments. Pass `source_path`, or `template_name` to read a saved template.

```json
{
  "template_name": "p1s-petg-strong"
}
```

#### confirm_temperatures

Report every heater target in a G-code file: `S` and `R` forms, tool-addressed targets, RepRapFirmware `G10`/`M568`, and Klipper `SET_HEATER_TEMPERATURE`. An expected `extruder_temp` or `bed_temp` matches only when it equals the file's highest target, which the result returns as `peak`. It is read-only; the printing tools enforce their own safety gate.

```json
{
  "gcode_path": "/path/to/model.gcode",
  "extruder_temp": 240,
  "bed_temp": 80
}
```

#### process_and_print_stl

Extend an STL's base, slice it, and print it through the same checked print gate as `upload_gcode` and `print_3mf`, including the human confirmation. If you pass `extruder_temp` or `bed_temp`, each must equal the sliced job's highest target (`S` and `R` forms, every tool); a mismatch stops before anything is uploaded. Pass `material` when the sliced G-code has no `filament_type` metadata. On a Bambu printer with a Bambu-compatible slicer, the sliced `.3mf` goes through the `print_3mf` checks, and the printer model is required.

```json
{
  "stl_path": "/path/to/model.stl",
  "extension_inches": 0.1,
  "extruder_temp": 210,
  "bed_temp": 60,
  "material": "PLA",
  "type": "octoprint",
  "host": "192.168.1.100"
}
```

Use `slice_stl`, `confirm_temperatures`, and `upload_gcode` separately when you want to review the sliced file before the print is offered for confirmation.

</details>

<details>
<summary><strong>Advanced Tools</strong></summary>

### Advanced Tools

#### Blender MCP

Connect a standard stdio Blender MCP server with `BLENDER_MCP_COMMAND` (for example, the full path to `uvx`) and `BLENDER_MCP_ARGS` (for example `["mcp-for-blender"]`). The [mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) project was formerly published as `blender-mcp`, which still works as a compatibility wrapper. Install and enable its addon in Blender and start the addon's connection. Blender and this server must be able to read the same local files. Printer tools work without Blender configured. Keep Blender open while your agent works: the addon does not run in background mode. See the [Blender guide](https://github.com/DMontgomery40/mcp-3D-printer-server/blob/main/docs/BLENDER.md) for setup, units, and a worked example that refits a phone case for a new phone end to end.

#### blender_mcp_status

Inspect the Blender MCP configuration. With `connect: true`, it starts the configured server, initializes it, and lists its tools by name and summary. Pass `tool_names` to get the full input schemas of the tools you are about to call (`include_schemas: true` returns all of them, which is large). A successful connection does not prove the addon inside Blender is running; call `get_scene_info` through `blender_mcp_call` to check that.

```json
{
  "connect": true,
  "tool_names": ["execute_blender_code"]
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

#### blender_mcp_export_stl

Export named objects from the live Blender scene to a new STL for slicing. Use it after modelling or editing through `blender_mcp_call`; Blender MCP's own `export_scene` writes GLB or FBX, not STL. The export writes world-space geometry with modifiers applied, without changing the scene, selection, or mode.

```json
{
  "object_names": ["PhoneCase"],
  "output_path": "/path/to/phone-case.stl",
  "user_prompt": "Make it fit my iPhone 17 Pro Max."
}
```

- The result reports `output_verified: true`, the triangle count, and `bounding_box.dimensions` measured from the written file. Compare the dimensions with what you expect before slicing.
- STL files carry no units and slicers read them as millimetres. An imported STL keeps its numbers, so the default `scale: 1` is right. If a part was modelled in metres, the result warns that it is under 1 unit across; export again with `scale: 1000`.
- `output_path` must be new and its parent must exist; nothing is ever overwritten. On any Blender error, mismatched receipt, or invalid file, nothing is published.

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
10. **Safety checks read files and reports, not the physical printer.** A declared material cannot prove what spool is loaded, and a finished-job report cannot prove the bed is clear, which is why a human confirms. Klipper macro parameters that name a heater are checked, but macro bodies stored on the printer cannot be inspected. On Duet/RepRapFirmware, selecting a tool (`T0`) heats it to the temperature already stored on the printer; activation-only `M568` and `M144` are refused, but a plain tool change is allowed because every firmware uses it. The safety gate is tested with mocked printer transports and loopback HTTP APIs, plus one real Bambu P1S run that reached the firmware's command check; other printer systems have not been exercised on real hardware in this release.
11. **Remote starts need a download route.** `start_print` of a file already on the printer works on Bambu Lab, OctoPrint, Klipper, and Duet. Repetier, Prusa, and Creality refuse it; upload the local G-code with `print: true` instead.

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
- Keep print confirmation on. The server asks a human through MCP elicitation before every print start and positive heating command, and refuses clients that cannot ask. `PRINT_REQUIRE_CONFIRMATION=0` (all printers) or `BAMBU_REQUIRE_CONFIRMATION=0` (Bambu only) opts out for headless setups; the first print after a finished job still asks.
- Heater ceilings come only from server configuration (`PRINTER_MAX_NOZZLE_TEMP`, `PRINTER_MAX_BED_TEMP`, `PRINTER_MAX_CHAMBER_TEMP`, or Bambu's per-model limits). Tool arguments and G-code never raise them.
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
