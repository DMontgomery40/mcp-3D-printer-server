# MCP 3D Printer Server

[![npm version](https://img.shields.io/npm/v/mcp-3d-printer-server.svg)](https://www.npmjs.com/package/mcp-3d-printer-server)
[![License: GPL-2.0](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.9%2B-blue)](https://www.typescriptlang.org/)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)](https://github.com/yourusername/mcp-3d-printer-server/graphs/commit-activity)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://makeapullrequest.com)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-green.svg)](https://nodejs.org/en/download/)
[![Downloads](https://img.shields.io/npm/dm/mcp-3d-printer-server.svg)](https://www.npmjs.com/package/mcp-3d-printer-server)
[![GitHub stars](https://img.shields.io/github/stars/dmontgomery40/mcp-3d-printer-server.svg?style=social&label=Star)](https://github.com/yourusername/mcp-3d-printer-server)

<a href="https://glama.ai/mcp/servers/7f6v2enbgk">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/7f6v2enbgk/badge" alt="3D Printer Server MCP server" />
</a>

<details>
<summary><strong>✨ What's New / Significant Updates (as of last session)</strong></summary>

- **Bambu `.3mf` Printing:** Added the `print_3mf` tool specifically for Bambu Lab printers. This uploads the `.3mf` file and sends the print command directly via MQTT based on OpenBambuAPI specs.
- **Direct MQTT Communication (Bambu):** Refactored Bambu command handling (`print_3mf`, `cancelJob`) to use direct MQTT (TLS port 8883) instead of relying solely on `bambu-js` for commands.
- **`.3mf` File Parsing:** Implemented a parser (`src/3mf_parser.ts`) to read metadata and Bambu-specific slicer settings (from `project_settings.config`) within `.3mf` files.
- **Bambu Preset Resources:** Added support for reading Bambu Studio preset files (`machine`, `filament`, `process`) as MCP resources (e.g., `preset://bambu/process/MyPreset`) if `BAMBU_STUDIO_CONFIG_PATH` is set.
- **OrcaSlicer Integration:** Added support for using OrcaSlicer via its command-line interface for the `slice_stl` tool.
- **New STL Manipulation Tools:** Added `merge_vertices`, `center_model`, and `lay_flat` tools for basic model preparation using `three.js`.
- **Configuration Update:** Added `BAMBU_STUDIO_CONFIG_PATH` environment variable for preset loading.
- **FTP Usage Note:** Acknowledged in documentation that file operations for Bambu currently use potentially unsecured FTP via `bambu-js`.

</details>

<details>
<summary><strong>🗺️ Roadmap / TODO</strong></summary>

- **Achieve Feature Parity:** Bring functionality (status detail, file operations, direct printing where possible, preset handling) for OctoPrint, Klipper, Duet, Repetier, Prusa Connect, and Creality Cloud up to the level of robustness planned for the Bambu implementation.
- **Implement Full Bambu MQTT Status:** Refactor `getStatus` for Bambu to subscribe to MQTT reports and maintain real-time state.
- **Implement Robust AMS Mapping:** Replace placeholder logic; correctly parse and use AMS mapping from `.3mf` slicer config or user overrides for the MQTT print command.
- **Implement `.3mf` Print Overrides:** Add logic to the `print_3mf` tool to handle user-provided overrides (e.g., calibration flags) and potentially common slicer settings if feasible via MQTT/G-code.
- **Calculate MD5 Hash:** Add logic to calculate and include the MD5 hash of the `.3mf` file in the MQTT print command (optional but recommended by protocol).
- **Refactor Bambu File Ops:** Investigate replacing `bambu-js` FTP operations (`getFiles`, `uploadFile`) with direct MQTT methods if possible/stable, or contribute FTPS support to `bambu-js`.
- **Add Preset Discovery Logic:** Improve preset resource listing (currently lists based on potential filenames, could parse index files if they exist).
- **Expand `.3mf` Support:** Add `.3mf` printing support for other printer types where applicable.
- **Error Handling & Reporting:** Enhance MQTT error handling and reporting of print progress/completion.
- **Testing:** Conduct thorough runtime testing of all new Bambu features.

</details>

<details>
<summary>Click to expand Table of Contents</summary>

## Table of Contents

- [Description](#description)
- [Features](#features)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [Install from npm](#install-from-npm)
  - [Install from source](#install-from-source)
  - [Running with Docker](#running-with-docker)
    - [Using Slicers with Docker](#using-slicers-with-docker)
- [Configuration](#configuration)
- [Usage with Claude Desktop](#usage-with-claude-desktop)
- [Supported Printer Management Systems](#supported-printer-management-systems)
  - [OctoPrint](#octoprint)
  - [Klipper (via Moonraker)](#klipper-via-moonraker)
  - [Duet](#duet)
  - [Repetier](#repetier)
  - [Bambu Labs](#bambu-labs)
    - [Finding Your Bambu Printer's Serial Number and Access Token](#finding-your-bambu-printers-serial-number-and-access-token)
    - [Bambu Communication Notes (MQTT & FTP)](#bambu-communication-notes-mqtt--ftp)
  - [Prusa Connect](#prusa-connect)
    - [Setting up Prusa Connect](#setting-up-prusa-connect)
  - [Creality Cloud](#creality-cloud)
    - [Setting up Creality Cloud](#setting-up-creality-cloud)
- [Available Tools](#available-tools)
  - [STL Manipulation Tools](#stl-manipulation-tools)
  - [Printer Control Tools](#printer-control-tools)
  - [Bambu-Specific Tools](#bambu-specific-tools)
- [Available Resources](#available-resources)
  - [Printer Resources](#printer-resources)
  - [Bambu Preset Resources](#bambu-preset-resources)
- [Example Commands for LLM](#example-commands-for-claude)
- [Bambu Lab Printer Limitations](#bambu-lab-printer-limitations)
- [Limitations and Considerations](#limitations-and-considerations)
  - [Memory Usage](#memory-usage)
  - [STL Manipulation Limitations](#stl-manipulation-limitations)
  - [Visualization Limitations](#visualization-limitations)
  - [Performance Considerations](#performance-considerations)
  - [Testing Recommendations](#testing-recommendations)
- [Badges](#badges)
- [License](#license)

</details>

## Description

This is a server that allows MCP users to connect with the API endpoints of these 3D Printers: 

- OctoPrint
- Klipper (Moonraker)
- Duet
- Repetier
- Bambu Labs
- Prusa Connect
- Creality/Ender

This server is a Model Context Protocol (MCP) server for connecting Claude with 3D printer management systems. It allows MCP to interact with 3D printers through the APIs of various printer management systems such as OctoPrint, Klipper (via Moonraker), Duet, Repetier, and Bambu Labs printers.

**Note on Resource Usage**: This MCP server includes advanced 3D model manipulation features that can be memory-intensive when working with large STL files. Please see the "Limitations and Considerations" section for important information about memory usage and performance.

## Features

- Get printer status (temperatures, print progress, etc.)
- List files on the printer
- Upload G-code files to the printer
- Start, cancel, and monitor print jobs
- Set printer temperatures
- Advanced STL file manipulation:
  - Extend base for better adhesion
  - Scale models uniformly or along specific axes
  - Rotate models around any axis
  - Translate (move) models
  - Modify specific sections of STL files (top, bottom, center, or custom)
- Comprehensive STL analysis with detailed model information
- Generate multi-angle SVG visualizations of STL files
- Real-time progress reporting for long operations
- Error handling with detailed diagnostics
- Slice STL files to generate G-code
- Confirm temperature settings in G-code files
- Complete end-to-end workflow from STL modification to printing
- Print `.3mf` files directly on Bambu Lab printers (via MQTT command)
- Read Bambu Studio preset files (printer, filament, process) as resources

## Installation

### Prerequisites

- Node.js 18 or higher
- npm or yarn

### Install from npm

```bash
npm install -g mcp-3d-printer-server
```

### Install from source

```bash
git clone https://github.com/dmontgomery40/mcp-3d-printer-server.git
cd mcp-3d-printer-server
npm install
npm link  # Makes the command available globally
```

### Running with Docker

You can also run the server using Docker and Docker Compose for a containerized environment.

1.  Ensure you have Docker and Docker Compose installed.
2.  Copy `.env.example` to `.env` and configure your settings.
3.  Build and run the container:
    ```bash
    docker-compose up --build -d
    ```

#### Using Slicers with Docker

Please note that the default Docker setup **cannot directly use a slicer installed on your host machine**. Mounting the slicer executable directly from the host into the container is unreliable due to operating system and library differences between your host and the container.

The recommended approach is to **install your preferred slicer *inside* the Docker image**. This makes the container self-sufficient.

To do this, you will need to modify the `Dockerfile`. Here's a conceptual example of how you might add PrusaSlicer or OrcaSlicer (specific commands may vary depending on the slicer, its dependencies, and current Alpine packages):

```dockerfile
# ... other Dockerfile commands ...

# Example: Install PrusaSlicer or OrcaSlicer (adjust command as needed)
# Check Alpine package repositories first (e.g., apk add prusaslicer or apk add orcaslicer)
# If not available, download and install manually (e.g., AppImage):
# RUN apk add --no-cache fuse # FUSE might be needed for AppImages
# RUN wget https://example.com/path/to/OrcaSlicer_Linux_Vxxxx.AppImage -O /usr/local/bin/orcaslicer && \
#     chmod +x /usr/local/bin/orcaslicer

# Set the SLICER_PATH env var accordingly in docker-compose.yml or when running
# Example for installed executable:
ENV SLICER_PATH=/usr/local/bin/orcaslicer 

# ... rest of Dockerfile ...
```

After modifying the `Dockerfile`, rebuild your image (`docker-compose build`). You'll also need to ensure the `SLICER_PATH` environment variable in your `.env` file or `docker-compose.yml` points to the correct path *inside the container* (e.g., `/usr/local/bin/orcaslicer`). Set `SLICER_TYPE` to `orcaslicer` as well.

Apologies for not including a specific slicer out-of-the-box, but given the wide variety of slicers (PrusaSlicer, OrcaSlicer, Cura, etc.) and configurations available, pre-installing one would unnecessarily bloat the image for many users. If a particular slicer becomes a very common request, I can certainly look into adding official support for it in a future version.

## Configuration

Create a `.env` file in the directory where you'll run the server or set environment variables:

```env
# Required for authentication with your printer management system
API_KEY=your_api_key_here

# Default printer connection settings
PRINTER_HOST=localhost
PRINTER_PORT=80 # Port for non-Bambu HTTP APIs
PRINTER_TYPE=octoprint  # Options: octoprint, klipper, duet, repetier, bambu, prusa, creality

# Optional: Directory for temporary files
TEMP_DIR=/path/to/temp/dir

# Bambu Labs specific configuration
BAMBU_SERIAL=your_printer_serial # REQUIRED for Bambu
BAMBU_TOKEN=your_access_token    # REQUIRED for Bambu

# Slicer configuration (for slice_stl tool)
SLICER_TYPE=prusaslicer  # Options: prusaslicer, cura, slic3r, orcaslicer
SLICER_PATH=/path/to/slicer/executable
SLICER_PROFILE=/path/to/slicer/profile

# Optional: Path to Bambu Studio user config dir (for loading presets)
# Example macOS: /Users/your_user/Library/Application Support/BambuStudio/user/YOUR_USER_ID
# Example Windows: C:\Users\your_user\AppData\Roaming\BambuStudio\user\YOUR_USER_ID
# Example Linux: /home/your_user/.config/BambuStudio/user/YOUR_USER_ID
BAMBU_STUDIO_CONFIG_PATH=
```

## Usage with Claude Desktop

1. Edit your Claude Desktop configuration file:

```json
{
  "mcpServers": {
    "3dprint": {
      "command": "mcp-3d-printer-server",
      "env": {
        "API_KEY": "your_api_key_here",
        "PRINTER_HOST": "your_printer_ip",
        "PRINTER_TYPE": "octoprint"
      }
    }
  }
}
```

2. For Bambu Labs printers:

```json
{
  "mcpServers": {
    "3dprint": {
      "command": "mcp-3d-printer-server",
      "env": {
        "PRINTER_HOST": "your_printer_ip",
        "PRINTER_TYPE": "bambu",
        "BAMBU_SERIAL": "your_printer_serial",
        "BAMBU_TOKEN": "your_access_token"
      }
    }
  }
}
```

3. Restart Claude Desktop
4. Connect to your printer through Claude

## Supported Printer Management Systems

### OctoPrint

OctoPrint is a popular web interface for 3D printers. It provides a REST API for controlling the printer.

- Default port: 80 (http) or 443 (https)
- Authentication: API key required

### Klipper (via Moonraker)

Klipper is a firmware for 3D printers that works with the Moonraker API server.

- Default port: 7125
- Authentication: Depends on your Moonraker configuration

### Duet

Duet is a control board for 3D printers with its own web interface (DuetWebControl).

- Default port: 80 (http) or 443 (https)
- Authentication: Depends on your Duet configuration

### Repetier

Repetier-Server is a host software for 3D printers.

- Default port: 3344
- Authentication: API key required

### Bambu Labs

Bambu Lab printers use MQTT for status and control and FTP for file operations.

- Authentication: Serial number and access token required (set `BAMBU_SERIAL` and `BAMBU_TOKEN`)
- Requirements: Printer must be on the same network or have cloud connection enabled
- Compatible with: X1C, P1S, P1P, A1, and other Bambu Lab printers

#### Finding Your Bambu Printer's Serial Number and Access Token

To connect to your Bambu Lab printer, you need two things:

1. **Printer Serial Number**: 
   - Look on the back or bottom of your printer for a sticker with a serial number (typically starts with "01P" or "01A" followed by numbers/letters)
   - Alternatively, open Bambu Studio, connect to your printer, go to Device > Device Management, and view your printer's information

2. **Access Token**: 
   - The access token is a security code needed to connect directly to your printer
   - For P1 Series printers: Go to the touchscreen, select Settings > Network > LAN Mode, and you'll see the access code
   - For X1 Series printers: Go to the touchscreen, select Settings > Network > LAN Mode, and enable LAN Mode to see the access code
   - For A1 Mini: Use the Bambu Handy app to connect to your printer, then go to Settings > Network > LAN Mode

**Note**: If your printer is not on the same local network or you can't find the access token, you may need to update your printer's firmware to the latest version to enable LAN Mode.

#### Bambu Communication Notes (MQTT & FTP)

- **MQTT:** This server uses the local MQTT protocol (port 8883, TLS) based on community findings (e.g., [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI)) to send commands like starting prints and cancelling jobs.
- **FTP:** File listing and uploading currently rely on the FTP server running on the printer (via the `bambu-js` library helper). **Note:** This FTP connection might be **unsecured (plain FTP)** based on current library limitations. Use with awareness of your network security.

### Prusa Connect

Prusa Connect is Prusa's own cloud-based solution for managing their printers.

- Default port: 80 (http) or 443 (https)
- Authentication: API key required
- Compatible with: Prusa MK4, Prusa Mini, Prusa XL, and other Prusa printers with Prusa Connect

#### Setting up Prusa Connect

1. Make sure your Prusa printer is updated to the latest firmware
2. Connect your printer to your Wi-Fi network
3. Create a Prusa Connect account and register your printer
4. Generate an API key from the Prusa Connect web interface under Settings > API Access

### Creality Cloud

Creality Cloud is Creality's management system for their printers.

- Default port: 80 (http) or 443 (https)
- Authentication: Bearer token required
- Compatible with: Ender series, CR series, and other Creality printers with network capabilities

#### Setting up Creality Cloud

1. Install the Creality Cloud app on your mobile device
2. Create an account and add your printer
3. Enable local network access for your printer
4. Generate a token from the Creality Cloud app under Settings > Developer Options

## Available Tools

<details>
<summary>Click to expand STL Manipulation Tools</summary>

### STL Manipulation Tools

> **Memory Usage Warning**: The following STL manipulation tools load entire 3D models into memory. For large or complex STL files (>10MB), these operations can consume significant memory. When using these tools within the MCP environment, be mindful of memory constraints.

#### get_stl_info

Get detailed information about an STL file, including dimensions, vertex count, and bounding box.

```json
{
  "stl_path": "/path/to/file.stl"
}
```

#### extend_stl_base

Extend the base of an STL file by a specified amount.

```json
{
  "stl_path": "/path/to/file.stl",
  "extension_inches": 2
}
```

#### scale_stl

Scale an STL model uniformly or along specific axes.

```json
{
  "stl_path": "/path/to/file.stl",
  "scale_factor": 1.5
}
```

Or for non-uniform scaling:

```json
{
  "stl_path": "/path/to/file.stl",
  "scale_x": 1.2,
  "scale_y": 1.0,
  "scale_z": 1.5
}
```

#### rotate_stl

Rotate an STL model around specific axes (in degrees).

```json
{
  "stl_path": "/path/to/file.stl",
  "rotate_x": 45,
  "rotate_y": 0,
  "rotate_z": 90
}
```

#### translate_stl

Move an STL model along specific axes (in millimeters).

```json
{
  "stl_path": "/path/to/file.stl",
  "translate_x": 10,
  "translate_y": 5,
  "translate_z": 0
}
```

#### merge_vertices

Merge vertices that are closer than a specified tolerance. Helps close small gaps and can slightly simplify the mesh.

```json
{
  "stl_path": "/path/to/model.stl",
  "tolerance": 0.01 // Optional, default = 0.01mm
}
```

#### center_model

Translate the model so the center of its bounding box is at the world origin (0,0,0).

```json
{
  "stl_path": "/path/to/model.stl"
}
```

#### lay_flat

Attempt to identify the largest flat surface of the model (that isn't already facing directly up or down) and rotate the model so this face is oriented downwards on the XY plane (Z=0). Useful for orienting models for printing.

```json
{
  "stl_path": "/path/to/model.stl"
}
```

#### modify_stl_section

Apply a specific transformation to a selected section of an STL file. This allows for detailed modifications of specific parts of a model.

```json
{
  "stl_path": "/path/to/file.stl",
  "section": "top",
  "transformation_type": "scale",
  "value_x": 1.5,
  "value_y": 1.5, 
  "value_z": 1.5
}
```

For custom section bounds:

```json
{
  "stl_path": "/path/to/file.stl",
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

Generate an SVG visualization of an STL file from multiple angles (front, side, top, and isometric views).

```json
{
  "stl_path": "/path/to/file.stl",
  "width": 400,
  "height": 400
}
```

#### slice_stl

Slice an STL file to generate G-code.

```json
{
  "stl_path": "/path/to/file.stl",
  "slicer_type": "prusaslicer",
  "slicer_path": "/path/to/prusaslicer",
  "slicer_profile": "/path/to/profile.ini"
}
```

#### confirm_temperatures

Confirm temperature settings in a G-code file.

```json
{
  "gcode_path": "/path/to/file.gcode",
  "extruder_temp": 200,
  "bed_temp": 60
}
```

#### process_and_print_stl

Process an STL file (extend base), slice it, confirm temperatures, and start printing.

```json
{
  "stl_path": "/path/to/file.stl",
  "extension_inches": 2,
  "extruder_temp": 200,
  "bed_temp": 60,
  "host": "192.168.1.100",
  "type": "octoprint",
  "api_key": "YOUR_API_KEY"
}
```

**Note:** Automatic orientation for optimal printing (minimizing supports, etc.) is a complex task typically handled by slicer GUIs (like OrcaSlicer or PrusaSlicer) and is not implemented in this server.

</details>

<details>
<summary>Click to expand Printer Control Tools</summary>

### Printer Control Tools

#### get_printer_status

Get the current status of the 3D printer.

```json
{
  "host": "192.168.1.100",
  "type": "octoprint",
  "api_key": "YOUR_API_KEY"
}
```

For Bambu printers, this currently only confirms MQTT connection.

#### list_printer_files

List files available on the printer.

```json
{
  "host": "192.168.1.100",
  "type": "octoprint",
  "api_key": "YOUR_API_KEY"
}
```

For Bambu printers, lists files in the `gcodes` directory via FTP.

#### upload_gcode

Upload a G-code file to the printer.

```json
{
  "host": "192.168.1.100",
  "type": "octoprint",
  "api_key": "YOUR_API_KEY",
  "filename": "my_print.gcode",
  "gcode": "G28\nG1 X100 Y100 Z10 F3000\n...",
  "print": true
}
```

For Bambu printers, uploads to the `gcodes` directory via FTP. Cannot start print automatically.

#### start_print

Start printing a file that is already on the printer.

```json
{
  "host": "192.168.1.100",
  "type": "octoprint",
  "api_key": "YOUR_API_KEY",
  "filename": "my_print.gcode"
}
```

**Not recommended for Bambu printers.** Use `print_3mf` for Bambu `.3mf` files.

#### cancel_print

Cancel the current print job.

```json
{
  "host": "192.168.1.100",
  "type": "octoprint",
  "api_key": "YOUR_API_KEY"
}
```

For Bambu printers, sends the `stop_print` command via MQTT.

#### set_printer_temperature

Set the temperature of a printer component.

```json
{
  "host": "192.168.1.100",
  "type": "octoprint",
  "api_key": "YOUR_API_KEY",
  "component": "extruder",
  "temperature": 200
}
```

**Not supported for Bambu printers** via direct MQTT commands.

</details>

<details open>
<summary>Click to expand Bambu-Specific Tools</summary>

### Bambu-Specific Tools

#### print_3mf

Uploads a `.3mf` file to a Bambu printer via FTP and initiates the print job via an MQTT command. Allows overriding some print parameters like AMS mapping.

```json
{
  "three_mf_path": "/path/to/your_model.3mf",
  "host": "your_bambu_ip", // Optional if default is set
  "bambu_serial": "YOUR_SERIAL", // Optional if default is set
  "bambu_token": "YOUR_TOKEN", // Optional if default is set
  // Optional Overrides:
  "use_ams": true, // Default: true
  "ams_mapping": [0, 1, 2, 3], // Array of AMS slot indices to use
  "bed_leveling": true, // Default: true
  "flow_calibration": false, // Default: false
  "vibration_calibration": false, // Default: false
  "timelapse": false // Default: false
}
```

**Note:** Overriding slicer settings like layer height or temperature via this tool is not supported by the printer's MQTT command. Apply those changes before generating the `.3mf` file.

</details>

## Available Resources

<details>
<summary>Click to expand Printer Resources</summary>

### Printer Resources

- `printer://{host}/status` - Current status of the 3D printer (limited for Bambu currently)
- `printer://{host}/files` - List of files available on the 3D printer (FTP for Bambu)
- `printer://{host}/file/{filename}` - Content of a specific G-code file (checks existence only for Bambu)

</details>

<details open>
<summary>Click to expand Bambu Preset Resources</summary>

### Bambu Preset Resources

If the `BAMBU_STUDIO_CONFIG_PATH` environment variable is set to your Bambu Studio user settings directory, you can read your saved presets.

- `preset://bambu/machine/{preset_name}` - Reads a machine preset file (e.g., `Bambu Lab P1S 0.4 nozzle.json`)
- `preset://bambu/filament/{preset_name}` - Reads a filament preset file (e.g., `Generic PLA.json`)
- `preset://bambu/process/{preset_name}` - Reads a process preset file (e.g., `0.20mm Standard @BBL P1S.json`)

**Example Usage:**
"Read the content of my Bambu process preset named '0.16mm Optimal @BBL P1S'"
(Claude would call ReadResource with `preset://bambu/process/0.16mm%20Optimal%20%40BBL%20P1S`)

</details>

## Example Commands for Claude

Here are some example commands you can give to Claude after connecting the MCP server:

### Printer Control
- "What's the current status of my 3D printer?"
- "Show me the list of files on my printer."
- "Upload this G-code to my printer: [G-code content]"
- "Start printing the file named 'benchy.gcode'."
- "Cancel the current print job."
- "Set the extruder temperature to 200°C."
- "Set the bed temperature to 60°C."

### STL Manipulation and Printing
- "Take this STL file and extend the base by 2 inches, then send to slicer and queue up in my printer."
- "Extend the base of model.stl by 1.5 inches."
- "Scale this STL file by 150% uniformly."
- "Scale model.stl to be twice as wide but keep the same height."
- "Rotate this model 90 degrees around the Z axis."
- "Move this STL model up by 5mm to create a gap underneath."
- "Can you modify just the top part of this model to make it 20% larger?"
- "Analyze this STL file and tell me its dimensions and details."
- "Generate a visualization of this STL file so I can see what it looks like."
- "Create SVG visualizations of my model from different angles."
- "Make the base of this model wider without changing its height."
- "Slice the modified STL file using PrusaSlicer."
- "Confirm that the temperatures in the G-code are 200°C for the extruder and 60°C for the bed."
- "Process this STL file, make the base 2 inches longer, slice it, and start printing, but confirm the temperatures first."
- "Print `~/Downloads/my_model.3mf` on the Bambu printer."
- "Upload `~/Desktop/calibration_cube.3mf` to the Bambu printer using AMS slots 0 and 2, and turn off bed leveling."
- "Cancel the print job on my Bambu P1S."
- "What are the settings in my Bambu filament preset 'Generic PETG'?"
- "Show me my Bambu process presets."

## Bambu Lab Printer Limitations

Due to the nature of the Bambu Lab printer API, there are some limitations:

1. **Starting prints**: Starting a print requires the 3MF project file path, gcode file name, print name, and MD5 hash. The simplified API in this server doesn't support this fully yet.

2. **Temperature control**: The Bambu API doesn't provide direct methods to set temperatures. This would require custom G-code commands.

3. **File management**: Files must be uploaded to the "gcodes" directory on the printer.

4. **FTP Security:** File operations currently use the printer's FTP server, which may be unsecured (plain FTP).

5. **Parameter Overrides:** Only parameters supported by the MQTT `project_file` command can be overridden via the `print_3mf` tool (e.g., AMS usage, calibration flags). Slicer settings like layer height or temperature cannot be changed at print time via this command.

6. **Status Updates:** Full real-time status monitoring via MQTT needs further implementation.

## Limitations and Considerations

### Memory Usage
- **Large STL Files**: Processing large or complex STL files can consume significant memory. The entire STL geometry is loaded into memory during operations.
- **Multiple Operations**: Running multiple STL operations in sequence (especially on large files) may cause memory to accumulate if garbage collection doesn't keep up.
- **MCP Environment**: Since this runs as an MCP server, be aware that Claude's MCP environment has memory constraints. Complex operations on very large STL files may cause out-of-memory issues.

### STL Manipulation Limitations
- **Section Modification**: The section-specific modification feature works best on simpler geometries. Complex or non-manifold meshes may produce unexpected results.
- **Base Extension**: The base extension algorithm works by adding a new geometry underneath the model. For models with complex undersides, results may not be perfect.
- **Error Handling**: While we've added robust error handling, some edge cases in complex STL files might still cause issues.

### Visualization Limitations
- **SVG Representation**: The SVG visualization is a simplified schematic representation, not a true 3D render.
- **Complex Models**: For very complex models, the visualization may not accurately represent all details.

### Performance Considerations
- **Slicing Operations**: External slicer processes can be CPU-intensive and may take considerable time for complex models.
- **Progress Reporting**: For large files, progress updates may appear to stall at certain processing stages.

### Testing Recommendations
- Start with smaller STL files (< 10MB) to test functionality
- Monitor memory usage when processing large files
- Test modifications on simple geometries before attempting complex ones
- Consider running on a system with at least 4GB of available RAM for larger operations

## Badges

| Badge | Description |
|-------|-------------|
| [![npm version](https://img.shields.io/npm/v/mcp-3d-printer-server.svg)](https://www.npmjs.com/package/mcp-3d-printer-server) | The current version of the package on npm |
| [![License: GPL-2.0](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html) | This project is licensed under GPL-2.0 |
| [![TypeScript](https://img.shields.io/badge/TypeScript-4.9%2B-blue)](https://www.typescriptlang.org/) | This project is written in TypeScript 4.9+ |
| [![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)](https://github.com/yourusername/mcp-3d-printer-server/graphs/commit-activity) | This project is actively maintained |
| [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://makeapullrequest.com) | We welcome contributions via Pull Requests |
| [![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-green.svg)](https://nodejs.org/en/download/) | Requires Node.js 18.0.0 or higher |
| [![Downloads](https://img.shields.io/npm/dm/mcp-3d-printer-server.svg)](https://www.npmjs.com/package/mcp-3d-printer-server) | Number of downloads per month from npm |
| [![GitHub stars](https://img.shields.io/github/stars/dmontgomery40/mcp-3d-printer-server.svg?style=social&label=Star)](https://github.com/yourusername/mcp-3d-printer-server) | Number of GitHub stars this project has received |

## License

GPL-2.0
