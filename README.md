# MCP 3D Printer Server

## Description

This is a server that allows MCP users to connect with the API endpoints of these 3D Printers: 

- OctoPrint
- Klipper (Moonraker)
- Duet
- Repetier
- Bambu Labs
- Prusa Connect
- Creality/Ender

This server is a Model Context Protocol (MCP) server for connecting Claude with 3D printer management systems. It allows Claude to interact with 3D printers through the APIs of various printer management systems such as OctoPrint, Klipper (via Moonraker), Duet, Repetier, and Bambu Labs printers.

## Features

- Get printer status (temperatures, print progress, etc.)
- List files on the printer
- Upload G-code files to the printer
- Start, cancel, and monitor print jobs
- Set printer temperatures

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
git clone https://github.com/yourusername/mcp-3d-printer-server.git
cd mcp-3d-printer-server
npm install
npm link  # Makes the command available globally
```

## Configuration

Create a `.env` file in the directory where you'll run the server or set environment variables:

```env
# Required for authentication with your printer management system
API_KEY=your_api_key_here

# Default printer connection settings
PRINTER_HOST=localhost
PRINTER_PORT=80
PRINTER_TYPE=octoprint  # Options: octoprint, klipper, duet, repetier, bambu

# Optional: Directory for temporary files
TEMP_DIR=/path/to/temp/dir

# Bambu Labs specific configuration
BAMBU_SERIAL=your_printer_serial
BAMBU_TOKEN=your_access_token
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

- Authentication: Serial number and access token required
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

### get_printer_status

Get the current status of the 3D printer.

```json
{
  "host": "192.168.1.100",
  "type": "octoprint",
  "api_key": "YOUR_API_KEY"
}
```

For Bambu printers:

```json
{
  "host": "192.168.1.100",
  "type": "bambu",
  "bambu_serial": "YOUR_PRINTER_SERIAL",
  "bambu_token": "YOUR_ACCESS_TOKEN"
}
```

### list_printer_files

List files available on the printer.

```json
{
  "host": "192.168.1.100",
  "type": "octoprint",
  "api_key": "YOUR_API_KEY"
}
```

### upload_gcode

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

### start_print

Start printing a file that is already on the printer.

```json
{
  "host": "192.168.1.100",
  "type": "octoprint",
  "api_key": "YOUR_API_KEY",
  "filename": "my_print.gcode"
}
```

### cancel_print

Cancel the current print job.

```json
{
  "host": "192.168.1.100",
  "type": "octoprint",
  "api_key": "YOUR_API_KEY"
}
```

### set_printer_temperature

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

## Available Resources

- `printer://{host}/status` - Current status of the 3D printer
- `printer://{host}/files` - List of files available on the 3D printer
- `printer://{host}/file/{filename}` - Content of a specific file on the 3D printer

## Example Commands for Claude

Here are some example commands you can give to Claude after connecting the MCP server:

- "What's the current status of my 3D printer?"
- "Show me the list of files on my printer."
- "Upload this G-code to my printer: [G-code content]"
- "Start printing the file named 'benchy.gcode'."
- "Cancel the current print job."
- "Set the extruder temperature to 200°C."
- "Set the bed temperature to 60°C."

## Bambu Lab Printer Limitations

Due to the nature of the Bambu Lab printer API, there are some limitations:

1. **Starting prints**: Starting a print requires the 3MF project file path, gcode file name, print name, and MD5 hash. The simplified API in this server doesn't support this fully yet.

2. **Temperature control**: The Bambu API doesn't provide direct methods to set temperatures. This would require custom G-code commands.

3. **File management**: Files must be uploaded to the "gcodes" directory on the printer.

## License

GPL-2.0