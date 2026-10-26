# FULU OrcaSlicer-bambulab and the BambuNetwork bridge

[Back to README](../README.md) · [Slicing guide](./SLICING.md) · [Setup reference](./SETUP.md)

We support the **[FULU Foundation](https://www.fulu.org/), [Louis Rossmann](https://www.youtube.com/@rossmanngroup), and the [OrcaSlicer-bambulab contributors](https://github.com/FULU-Foundation/OrcaSlicer-bambulab)**. Owners should be free to repair their printers, choose open-source software, and keep working hardware from being made worse by locked-down software. This server treats the FULU OrcaSlicer-bambulab fork as a first-class slicer for Bambu Lab projects.

This guide applies to Bambu Lab printers (`PRINTER_TYPE=bambu`). Other printer backends use their own slicers; see the [slicing guide](./SLICING.md).

## What the integration does

Set the slicer in the server environment:

```env
PRINTER_TYPE=bambu
SLICER_TYPE=orcaslicer-bambulab
SLICER_PATH=/path/to/FULU/OrcaSlicer
FULU_ORCA_PLUGIN_DIR=/path/to/FULU/runtime/payload
BAMBU_MODEL=p1s
```

Accepted aliases include `fulu_orca`, `fulu-orca`, `orca-studio`, and `orca_bambulab`. For Bambu printers, this is the default slicer when `SLICER_TYPE` is not set.

- `slice_stl` runs the FULU/Orca project command line (`--slice 0 --export-3mf`) with your model and nozzle's machine preset, resolved from the FULU installation's own profile tree, to produce a sliced Bambu 3MF. `SLICER_PROFILE` is a process profile only; see [Bambu-compatible slicing](./SLICING.md#bambu-compatible-slicing).
- `print_3mf` can auto-slice an unsliced 3MF through FULU OrcaSlicer-bambulab, then inspect, confirm, upload, and start the sliced project through this server's local Bambu print path. A failed slice never uploads the original.
- `check_fulu_orca_setup` checks the FULU executable, the platform runtime payload, the setup commands, and optionally the BambuNetwork bridge handshake.
- `fulu_bambu_network_rpc` calls the FULU bridge protocol for diagnostics. Raw print methods are refused.

What stays deliberately explicit:

- The server's Bambu print path is local MQTT plus FTPS. It still needs `PRINTER_HOST`, `BAMBU_SERIAL`, and `BAMBU_TOKEN`.
- FULU's BambuNetwork bridge is a separate runtime. The server can inspect it, probe it, and send guarded RPC calls, but it never silently switches a print from local LAN control to BambuNetwork or cloud control.
- `BAMBU_MODEL` stays mandatory for Bambu print operations, because a wrong machine preset can produce dangerous G-code.

## Current status

This integration has been bench-tested against FULU macOS release artifacts with a Benchy smoke test. That testing found and fixed a real server bug: Bambu-family project slicers must load Orca/Bambu preset JSON with `--load-settings`, not the invalid `--load-machine` flag.

- **Bambu Studio still works as a fallback.** With `SLICER_TYPE=bambustudio` and `SLICER_PATH=/Applications/BambuStudio.app/Contents/MacOS/BambuStudio`, the same Benchy 3MF sliced into a printable Bambu project. This is the known-good command-line path while FULU's platform packaging settles.
- **macOS FULU CLI slicing is not proven.** On the test Mac, the FULU arm64 and x86_64 macOS bundles hit the same command-line slicing problem: one run crashed with `SIGSEGV` inside OrcaSlicer's CLI processing, and repeated attempts left uninterruptible macOS processes that ignored `SIGKILL`. `check_fulu_orca_setup` can inspect the bundle and bridge payload, but treat macOS FULU CLI slicing as unfinished until FULU ships a stable macOS command-line runtime. GUI slicing and export are unaffected.
- **Linux bridge probing works with FULU's v1.0.0 host.** In the maintainer's x86-64 Linux test container (QEMU emulation), FULU's v1.0.0 Linux host loaded the 02.05.02.58 networking plug-in, and `check_fulu_orca_setup` reported a ready bridge through the default command and through the documented `cat` wrapper. A host launched directly returned exit code 101 with its explanation, and a missing plug-in folder returned the `file open failed` explanation. No printer was contacted: this server has no bridge print path.
- **Windows needs testers.** The WSL 2 setup path, payload checks, and bridge command shape are represented here, but the full Windows path still needs real reports that exercise `install_runtime.ps1`, `verify_runtime.ps1`, bridge probing, CLI slicing, and a known-safe print workflow.

Please report your OS, CPU architecture, FULU release asset name, the `check_fulu_orca_setup` result, the slicer's stderr, and whether the Bambu Studio fallback works for the same model.

## Runtime setup by platform

FULU's source tree ships macOS (Lima) and Windows (WSL) runtime scripts. This server knows those layouts and returns the exact commands through `check_fulu_orca_setup`.

### Windows

Enable WSL and the virtual machine platform:

```bat
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

Restart Windows, then run the FULU package scripts from the directory that contains `install_runtime.ps1`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install_runtime.ps1 -PackageDir . -PluginDir .
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\verify_runtime.ps1 -PackageDir . -PluginDir .
```

### Linux

Install the FULU OrcaSlicer-bambulab build normally, set `SLICER_TYPE=orcaslicer-bambulab`, and point `SLICER_PATH` at the executable.

Bridge diagnostics use FULU's x86-64 Linux host runtime (`linux_host_runtime_<commit>.tar.gz` from the [FULU release](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/releases)), which contains `pjarczak_bambu_linux_host` and its ABI variants. The host also needs the 02.05.02.5x networking plug-in (`libbambu_networking.so` and `libBambuSource.so`) that FULU OrcaSlicer downloads to `~/.config/OrcaSlicer/plugins`.

The v1.0.0 host has upstream bugs that affect every Node.js client, including this server:

1. **Exit code 101.** The host reopens its stdout through `/proc/self/fd`, which fails for the socket Node.js gives a child process ([FULU #50](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/50)). When `FULU_ORCA_PLUGIN_DIR` (or the slicer's folder) holds `pjarczak_bambu_linux_host`, the default bridge command already pipes the host through `cat`. For your own `FULU_BAMBU_BRIDGE_COMMAND`, use a wrapper that gives the host a real pipe:

   ```sh
   #!/bin/sh
   # /opt/fulu-runtime/fulu-host-wrapper.sh
   "/opt/fulu-runtime/pjarczak_bambu_linux_host" "$@" | cat
   ```

   Through `cat`, the bridge's exit status is `cat`'s. A host crash then shows in the probe's `stderr`, for example `Segmentation fault`, instead of in the exit code.
2. **`validate failed: file open failed`.** The host opens the plug-in libraries from its working directory instead of `PJARCZAK_BAMBU_PLUGIN_DIR` ([FULU #51](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/51)). On Linux the server passes `PJARCZAK_BAMBU_NETWORK_SO` and `PJARCZAK_BAMBU_SOURCE_SO` as absolute paths inside `PJARCZAK_BAMBU_PLUGIN_DIR`, unless you set them. Without that folder the probe reports the bridge as not ready and names the missing setting.
3. **Unanswered requests on exit.** The host exits as soon as its input closes, dropping requests it has not answered yet. The server keeps the input open until every request in a probe or RPC call has a response.

For a shell-launched MCP, the bridge configuration has this shape; replace the paths with your installation:

```bash
export FULU_BAMBU_BRIDGE_COMMAND="'/opt/fulu-runtime/fulu-host-wrapper.sh'"
export PJARCZAK_BAMBU_PLUGIN_DIR="$HOME/.config/OrcaSlicer/plugins"
```

Use the same values in a desktop client's `env` object, and quote paths containing spaces inside the bridge command.

### macOS

Set the app payload directory, then run the scripts FULU copies into the app bundle:

```bash
export FULU_ORCA_PLUGIN_DIR="/Applications/OrcaSlicer.app/Contents/MacOS"
bash "$FULU_ORCA_PLUGIN_DIR/install_runtime_macos.sh" -PackageDir "$FULU_ORCA_PLUGIN_DIR" -PluginDir "$FULU_ORCA_PLUGIN_DIR"
bash "$FULU_ORCA_PLUGIN_DIR/verify_runtime_macos.sh" -PackageDir "$FULU_ORCA_PLUGIN_DIR" -PluginDir "$FULU_ORCA_PLUGIN_DIR"
```

The default installed runtime is:

```text
~/Library/Application Support/OrcaSlicer/macos-bridge/runtime
```

Set `PJARCZAK_MAC_RUNTIME_DIR` if yours is elsewhere. The bridge command has this shape:

```bash
"/Applications/OrcaSlicer.app/Contents/MacOS/pjarczak-bambu-linux-host-wrapper" "$HOME/Library/Application Support/OrcaSlicer/macos-bridge/runtime/pjarczak_bambu_linux_host"
```

If your app is named `Orca Studio.app` or lives elsewhere, use its real `Contents/MacOS` path for `FULU_ORCA_PLUGIN_DIR`.

## Check the setup through MCP

Ask your agent to call `check_fulu_orca_setup`. With the executable, payload directory, and bridge command configured in the server environment, a probe needs only:

```json
{
  "platform": "darwin",
  "run_bridge_probe": true
}
```

The result reports missing payload files, the install and verify commands, the environment values to use, and the bridge handshake, capabilities, and runtime information when probing is enabled. A probe is `ok` only when the host answered every request and loaded the networking plug-in. Its `hints` explain exit code 101 and a plug-in the host could not open. On Linux, `pluginLibraries` shows the library paths the server passes to the host. macOS bundle notes and the macOS wrapper command appear only for `platform: "darwin"`, and the wrapper command only when the bundle contains the wrapper.

> **Per-call executable selectors require `MCP_ALLOW_EXECUTABLE_ARG=1`.**
> By default the bridge command and its derived paths come from server environment configuration (`FULU_BAMBU_BRIDGE_COMMAND`, `SLICER_PATH`, `FULU_ORCA_PLUGIN_DIR`, `PJARCZAK_MAC_RUNTIME_DIR`). Passing `bridge_command`, or passing `slicer_path`, `plugin_dir`, or `runtime_dir` with `run_bridge_probe: true`, returns an error that names the opt-in flag. Inspection without probing can still use the path arguments. These values choose which local program the server launches, so accepting them lets whatever is steering the model (a downloaded model's description, a README in an archive, 3MF metadata) choose that program. Set the flag only for trusted, interactive diagnostics.

## Bridge RPC

`fulu_bambu_network_rpc` speaks FULU's bridge frame protocol: little-endian binary frames with JSON bodies, using methods such as `bridge.handshake`, `bridge.capabilities`, `bridge.runtime_info`, and `net.get_user_print_info`.

- **Allowed by default:** `bridge.handshake`, `bridge.capabilities`, `bridge.runtime_info`, `bridge.ping`, `bridge.poll_events`, `ft.capabilities`, and `net.*` methods whose names begin with `is_`, `get_`, `build_`, `query_`, or `check_`.
- **Agent and session setup** (`net.create_agent`, `net.start`, `net.init_log`, `net.set_config_dir`, `net.set_country_code`, `net.connect_server`, `net.change_user`) requires `allow_mutating_method: true`. These methods do not address a printer.
- **Refused:** raw print methods (`net.start_print`, `net.start_local_print`, `net.start_local_print_with_record`, `net.start_send_gcode_to_sdcard`, `net.start_sdcard_print`), printer messages such as `net.send_message`, file transfers, and unknown methods. They would bypass the inspected print, heating, and printer-state gate. `allow_mutating_method` never enables them, and `bambu_model` is informational only. Print through `print_3mf`, which runs the full [safety gate](./SETUP.md#print-and-heating-safety).

A safe diagnostic call:

```json
{
  "method": "bridge.runtime_info"
}
```

The server exposes the bridge for diagnostics without pretending a cloud print can be safely inferred from a local filename.

## Upstream bugs and workarounds

These failures come from upstream software, not from this server. The server works around them where it can and names them in its errors; the fixes belong upstream. Evidence for the certificate, `-4030` and FULU CLI rows comes from [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) 1.1.34's testing on the maintainer's P1S; this server has no bridge print path.

| Upstream component | Bug | What you see | What this server does | Upstream status |
|---|---|---|---|---|
| FULU Linux host v1.0.0 | Reopens stdout through `/proc/self/fd`, which fails for a socket ([FULU #50](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/50)) | Exit code 101 from every Node.js client | Pipes the default Linux host through `cat`, explains exit 101, and documents the [`cat` wrapper](#linux) | Open |
| FULU Linux host v1.0.0 | Opens the plug-in libraries from its working directory, ignoring `PJARCZAK_BAMBU_PLUGIN_DIR` ([FULU #51](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/51)) | `validate failed: file open failed` | Passes absolute library paths on Linux; the probe reports not ready and names the setting | Open |
| FULU Linux host v1.0.0 | Exits when its input closes, dropping requests it has not answered | A probe with no handshake, or a crash in `stderr` | Keeps the input open until every request is answered | Not reported |
| FULU Linux host runtime | Ships `slicer_base64.cer` without Bambu's `printer.cer`, and crashes on `connect_printer`/`disconnect_printer` before any certificate folder is set | LAN connections fail or the host segfaults | Not reached here: printer connection and print methods are refused, and prints use the direct MQTT/FTPS path | Not yet reported |
| FULU OrcaSlicer-bambulab v1.0.0 CLI | Asks the GUI application whether it is closing in `PartPlate::invalidate_plate_name_texture` | Every CLI run segfaults | Reports the signal with the slicer's output; export from the GUI, or use upstream OrcaSlicer's or Bambu Studio's CLI | Fixes being proposed upstream |
| OrcaSlicer 2.4.2 CLI | `PartPlate::check_outside` calls the GUI's Plater when scale or a tilt moves an object below the bed while arranging; related to the closed [OrcaSlicer #13328](https://github.com/OrcaSlicer/OrcaSlicer/issues/13328) | `slice_stl` segfaults for those transforms | Applies STL transforms to a mesh copy and refuses the 3MF case; see [Bambu-compatible slicing](./SLICING.md#bambu-compatible-slicing) | Not yet reported |
| Bambu networking plug-in | Needs its own LAN session and the printer's application certificate before it can encrypt a print command | `start_local_print` returns `-4030` after uploading | Not reached here: raw bridge print methods are refused | Plug-in design |
