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

- `slice_stl` runs the FULU/Orca project command line (`--slice 0 --export-3mf`) with your model's machine preset to produce a sliced Bambu 3MF.
- `print_3mf` can auto-slice an unsliced 3MF through FULU OrcaSlicer-bambulab, then upload and start the sliced project through this server's local Bambu print path.
- `check_fulu_orca_setup` checks the FULU executable, the platform runtime payload, the setup commands, and optionally the BambuNetwork bridge handshake.
- `fulu_bambu_network_rpc` calls the FULU bridge protocol for diagnostics and development.

What stays deliberately explicit:

- The server's Bambu print path is local MQTT plus FTPS. It still needs `PRINTER_HOST`, `BAMBU_SERIAL`, and `BAMBU_TOKEN`.
- FULU's BambuNetwork bridge is a separate runtime. The server can inspect it, probe it, and send guarded RPC calls, but it never silently switches a print from local LAN control to BambuNetwork or cloud control.
- `BAMBU_MODEL` stays mandatory for Bambu print operations, because a wrong machine preset can produce dangerous G-code.

## Current status

This integration has been bench-tested against FULU macOS release artifacts with a Benchy smoke test. That testing found and fixed a real server bug: Bambu-family project slicers must load Orca/Bambu preset JSON with `--load-settings`, not the invalid `--load-machine` flag.

- **Bambu Studio still works as a fallback.** With `SLICER_TYPE=bambustudio` and `SLICER_PATH=/Applications/BambuStudio.app/Contents/MacOS/BambuStudio`, the same Benchy 3MF sliced into a printable Bambu project. This is the known-good command-line path while FULU's platform packaging settles.
- **macOS FULU CLI slicing is not proven.** On the test Mac, the FULU arm64 and x86_64 macOS bundles hit the same command-line slicing problem: one run crashed with `SIGSEGV` inside OrcaSlicer's CLI processing, and repeated attempts left uninterruptible macOS processes that ignored `SIGKILL`. `check_fulu_orca_setup` can inspect the bundle and bridge payload, but treat macOS FULU CLI slicing as unfinished until FULU ships a stable macOS command-line runtime. GUI slicing and export are unaffected.
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

Install the FULU OrcaSlicer-bambulab build normally, set `SLICER_TYPE=orcaslicer-bambulab`, and point `SLICER_PATH` at the executable. For bridge-level diagnostics, set `FULU_BAMBU_BRIDGE_COMMAND` to the packaged `pjarczak_bambu_linux_host`.

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

The result reports missing payload files, the install and verify commands, the environment values to use, and the bridge handshake, capabilities, and runtime information when probing is enabled.

> **Per-call executable selectors require `MCP_ALLOW_EXECUTABLE_ARG=1`.**
> By default the bridge command and its derived paths come from server environment configuration (`FULU_BAMBU_BRIDGE_COMMAND`, `SLICER_PATH`, `FULU_ORCA_PLUGIN_DIR`, `PJARCZAK_MAC_RUNTIME_DIR`). Passing `bridge_command`, or passing `slicer_path`, `plugin_dir`, or `runtime_dir` with `run_bridge_probe: true`, returns an error that names the opt-in flag. Inspection without probing can still use the path arguments. These values choose which local program the server launches, so accepting them lets whatever is steering the model (a downloaded model's description, a README in an archive, 3MF metadata) choose that program. Set the flag only for trusted, interactive diagnostics.

## Bridge RPC

`fulu_bambu_network_rpc` speaks FULU's bridge frame protocol: little-endian binary frames with JSON bodies, using methods such as `bridge.handshake`, `bridge.capabilities`, `bridge.runtime_info`, and `net.get_user_print_info`.

- **Allowed by default:** `bridge.handshake`, `bridge.capabilities`, `bridge.runtime_info`, `bridge.ping`, `bridge.poll_events`, and `net.*` methods whose names begin with `is_`, `get_`, `build_`, `query_`, or `check_`.
- **Everything else** can change account, printer, cloud, or print state, and requires `allow_mutating_method: true`.
- **Print methods** (`net.start_print`, `net.start_local_print`, `net.start_local_print_with_record`, `net.start_send_gcode_to_sdcard`, `net.start_sdcard_print`) also require the Bambu printer model.

A safe diagnostic call:

```json
{
  "method": "bridge.runtime_info"
}
```

A mutating call has to say so explicitly:

```json
{
  "method": "net.start_print",
  "allow_mutating_method": true,
  "bambu_model": "p1s",
  "payload": {
    "client_job_id": 1,
    "params": {
      "dev_id": "YOUR_PRINTER_ID"
    }
  }
}
```

That second example is intentionally incomplete: a real BambuNetwork print call needs FULU's full print parameter payload. The point is that the server exposes the bridge without pretending a cloud print can be safely inferred from a local filename.

<!-- lead: sync after safety + blender integration -->
