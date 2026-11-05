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

Accepted aliases include `fulu_orca`, `fulu-orca`, `orca-studio`, and `orca_bambulab`. Set `SLICER_TYPE` to choose it: Bambu printers default to Bambu Studio, because FULU v1.0.0's command line segfaults on every slice until [FULU #56](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/pull/56) and [#57](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/pull/57) are released.

- `slice_stl` runs the FULU/Orca project command line (`--slice 0 --export-3mf`) with your model and nozzle's machine preset, resolved from the FULU installation's own profile tree, to produce a sliced Bambu 3MF. `SLICER_PROFILE` is a process profile only; see [Bambu-compatible slicing](./SLICING.md#bambu-compatible-slicing).
- `print_3mf` can auto-slice an unsliced 3MF through FULU OrcaSlicer-bambulab, then inspect, upload, and start the sliced project through this server's local Bambu print path. A failed slice never uploads the original.
- `check_fulu_orca_setup` checks the FULU executable, the platform runtime payload, the setup commands, and optionally the BambuNetwork bridge handshake.
- `fulu_bambu_network_rpc` calls the FULU bridge protocol for diagnostics. Raw print methods are refused.
- With `connection_mode: "bambu_network"` (or `BAMBU_DEFAULT_CONNECTION_MODE=bambu_network`), `print_3mf`, `cancel_print`, `pause_print` and `resume_print` go through FULU's bridge: see [print and control through FULU's BambuNetwork route](#print-and-control-through-fulus-bambunetwork-route).

What stays deliberately explicit:

- The server's default Bambu print path is local MQTT plus FTPS. Every route, the bridge included, still needs `PRINTER_HOST`, `BAMBU_SERIAL`, and `BAMBU_TOKEN`: fresh printer state is read over LAN MQTT before every print.
- FULU's BambuNetwork bridge is a separate runtime. The server uses it only when the route says so (`connection_mode`, `BAMBU_DEFAULT_CONNECTION_MODE`, or `counterpart_print_route`); it never switches routes on its own.
- `BAMBU_MODEL` stays mandatory for Bambu print operations, because a wrong machine preset can produce dangerous G-code.

## Current status

This integration has been bench-tested against FULU macOS release artifacts with a Benchy smoke test. That testing found and fixed a real server bug: Bambu-family project slicers must load Orca/Bambu preset JSON with `--load-settings`, not the invalid `--load-machine` flag.

- **Bambu Studio still works as a fallback.** With `SLICER_TYPE=bambustudio` and `SLICER_PATH=/Applications/BambuStudio.app/Contents/MacOS/BambuStudio`, the same Benchy 3MF sliced into a printable Bambu project. This is the known-good command-line path while FULU's platform packaging settles.
- **macOS FULU CLI slicing is not proven.** On the test Mac, the FULU arm64 and x86_64 macOS bundles hit the same command-line slicing problem: one run crashed with `SIGSEGV` inside OrcaSlicer's CLI processing, and repeated attempts left uninterruptible macOS processes that ignored `SIGKILL`. `check_fulu_orca_setup` can inspect the bundle and bridge payload, but treat macOS FULU CLI slicing as unfinished until FULU ships a stable macOS command-line runtime. GUI slicing and export are unaffected.
- **Linux bridge probing works with FULU's v1.0.0 host.** In the maintainer's x86-64 Linux test container (QEMU emulation), FULU's v1.0.0 Linux host loaded the 02.05.02.58 networking plug-in, and `check_fulu_orca_setup` reported a ready bridge through the default command and through the documented `cat` wrapper. A host launched directly returned exit code 101 with its explanation, and a missing plug-in folder returned the `file open failed` explanation. No printer was contacted by those probes. The bridge print and control route came later, ported from bambu-printer-mcp (see below); this server has tested it only against a fake FULU host.
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

## Print and control through FULU's BambuNetwork route

This route is ported from [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md#print-through-the-bridge), where it printed on the maintainer's P1S with Developer Mode off. Bambu firmware with authorization control (01.08.05 and later on the P1 series) refuses third-party LAN commands with HMS 0500-0500-0001-0007 unless LAN Only Mode and Developer Mode are on. FULU's networking plug-in signs and encrypts commands as Bambu Studio does, so the printer accepts them. The trade-off is that this route depends on Bambu's closed networking plug-in. This server has run it only against a fake FULU host that reproduces the real host's behaviour; it has not printed on real hardware here.

Configure it in the server environment:

| Setting | Purpose |
|---|---|
| `BAMBU_DEFAULT_CONNECTION_MODE` | `lan_mqtt_ftps` (default: direct LAN MQTT/FTPS) or `bambu_network` (FULU's bridge). bambu-printer-mcp's `bambu_native` (X2D) and `bambu_connect` modes are refused here. |
| `BAMBU_DEFAULT_CONNECTION_TYPE` | For `bambu_network`: `lan` (the plug-in's authenticated local session) or `cloud` (Bambu Cloud; needs a signed-in agent). Default `cloud`, as in bambu-printer-mcp. |
| `BAMBU_NETWORK_BRIDGE_COMMAND` | The trusted host command. Falls back to `FULU_BAMBU_BRIDGE_COMMAND`, then to the host `check_fulu_orca_setup` discovers next to FULU's OrcaSlicer-bambulab. |
| `BAMBU_NETWORK_CONFIG_DIR` | Writable agent config folder, which also holds `control-trace.log`. Default `~/.config/mcp-3d-printer-server/bambu-network`. |
| `BAMBU_NETWORK_COUNTRY_CODE`, `BAMBU_NETWORK_USER_INFO`, `BAMBU_NETWORK_CERT_DIR` | Region (default `US`), optional `net.change_user` JSON for cloud sign-in, and an optional certificate folder. By default the server writes Bambu's public `printer.cer` and `slicer_base64.cer` (pinned by SHA-256) to `cert` inside the config folder; LAN sessions need `printer.cer`. |
| `BAMBU_NETWORK_CLIENT_NAME`, `BAMBU_NETWORK_CLIENT_VERSION` | The client identity sent with `net.set_extra_http_header` before the agent starts, as FULU's GUI sends it. Defaults `BambuStudio` and `02.05.02.51`; the device id is kept in `client-device-id` inside the config folder. |
| `PJARCZAK_BAMBU_PLUGIN_DIR` | The networking plug-in folder (`libbambu_networking.so`, `libBambuSource.so`); on Linux the server passes their absolute paths to the host. |
| `BAMBU_NETWORK_BRIDGE_IMAGE` | Instead of a command: a Docker image holding FULU's Linux host. See [Run the host in Docker](#run-the-host-in-docker). A command, when set, wins; the image comes before a discovered FULU install. |

### Run the host in Docker

On a Mac, or any machine without the x86-64 Linux runtime installed natively, the server can run FULU's Linux host in a Docker image itself, as bambu-printer-mcp does. Set `BAMBU_NETWORK_BRIDGE_IMAGE` instead of `BAMBU_NETWORK_BRIDGE_COMMAND`:

| Setting | Purpose |
|---|---|
| `BAMBU_NETWORK_BRIDGE_IMAGE` | The image. It holds FULU's host runtime in `/fulu` (`pjarczak_bambu_linux_host` and `ca-certificates.crt`) and the 02.05.02.5x networking plug-in in `/plugins` (`libbambu_networking.so`, `libBambuSource.so`), on an x86-64 Linux with glibc 2.38 or later (Ubuntu 24.04). |
| `BAMBU_NETWORK_BRIDGE_DOCKER` | The `docker` executable. Default `docker` on the server's `PATH`; a desktop client's `PATH` often lacks Homebrew, so give the full path. |
| `BAMBU_NETWORK_BRIDGE_DOCKER_HOST` | Optional `docker --host`, such as a Colima profile's `unix://…/docker.sock`. The global Docker context is never changed. |
| `BAMBU_NETWORK_BRIDGE_COLIMA_PROFILE` | Optional. When Docker doesn't answer, the server runs `colima start --profile <name> --activate=false` once and waits for it. A running profile is never stopped or restarted. |
| `BAMBU_NETWORK_BRIDGE_COLIMA_HOME` | Optional `COLIMA_HOME` for that profile. |
| `BAMBU_NETWORK_BRIDGE_COLIMA` | Optional `colima` executable. Default `colima`. |

The server runs `docker run --rm -i --platform linux/amd64 --network host` with the image's host piped through `cat` (FULU #50) and the plug-in paths, CA bundle and country/expected-version settings passed in. It mounts, at the same absolute paths, the folders the host must see:

- this server's own agent config folder (`BAMBU_NETWORK_CONFIG_DIR`, default `~/.config/mcp-3d-printer-server/bambu-network`). The host aborts when it can't open that folder (FULU #54): a hand-written launcher that mounted only bambu-printer-mcp's folder made this server's FULU route crash. Each print's checked snapshot is written to `print-snapshots` inside it, because the plug-in uploads that file;
- `BAMBU_NETWORK_CERT_DIR`, when it is set outside the config folder.

The Docker VM must share those folders with the computer. Colima shares your home folder by default, but not `/tmp` or `/var/folders` (macOS's temporary folders), which is why the snapshots don't go there.

`counterpart_print_route` reads the route and changes it (`{"route": "lan"}` or `{"route": "cloud"}`) in the running server and in the `.env` file in its working directory. Arguments override the defaults per call: `print_3mf`, `cancel_print`, `pause_print` and `resume_print` take `connection_mode` and `connection_type`. A job is always controlled over the connection that printed it, so Stop and Pause for a FULU print never fall back to plain MQTT.

**Printing.** `print_3mf` with `bambu_network` runs the same gate as the LAN path first: it inspects a private snapshot of the sliced plate, checks the AMS mapping (`ams_slots`, `ams_mapping`, or `use_ams: false` for the external spool), and validates a fresh LAN MQTT report twice. Then it opens the plug-in's own session. For `lan` the server connects with the access code, installs the printer's certificate and waits for the connection, as Bambu Studio does, and sends `net.start_local_print`; a synchronous `-4030` ("send msg failed", nothing published) is retried once after another certificate exchange. For `cloud`, after the printer's cloud session and certificate, it follows Bambu Studio's order for a cloud-bound printer on the LAN: `net.start_local_print_with_record` (LAN upload, task recorded in the account), then `net.start_print` only if that failed before the print command (results `-2010` to `-2140` other than a missing or oversized file), with the printer checked again before the second send; a printer with no storage goes straight to `net.start_print`. A `-3120`, HTTP 403 "internal blocking" from `net.start_print` is Bambu Cloud refusing to create the task ([BambuStudio #8404](https://github.com/bambulab/BambuStudio/issues/8404)). The fresh MQTT report is checked again immediately before the print frame. The job carries Bambu Studio's `ams_mapping`, `ams_mapping2` and `ams_mapping_info`, the Send dialog's calibration options as Bambu Studio resolves them for the model, and the server's unique `checked-…` name as the task name, which binds a later `resume_print` to the inspected file. A non-zero plug-in result is an error that names the code and the plug-in's last messages. Success means the plug-in accepted the job; check `counterpart_print_progress` or `get_printer_status` to see the printer start it.

**Stop, Pause, Resume.** Over `bambu_network`, each control opens the plug-in's authenticated session, sends the command, and stays connected until the printer answers. A refusal fails with the printer's `err_code` (for example `0502400A`); a `-4` or `-4030` send is retried after reinstalling the certificate, three tries in all; any other plug-in result is final and never replayed. Every FULU event and send in a control session is appended to `control-trace.log` in the config folder, without the access code. Resume keeps the checked-job rules in the [README](../README.md#resume_print): Bambu's plug-in placed the file, so a resume re-reads it over FTPS when it can, and asks a person through MCP elicitation when it cannot.

## Upstream bugs and workarounds

These failures come from upstream software, not from this server. The server works around them where it can and names them in its errors; the fixes belong upstream. Evidence for the certificate, `-4030` and FULU CLI rows comes from [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) 1.1.34's testing on the maintainer's P1S; this server has no bridge print path.

| Upstream component | Bug | What you see | What this server does | Upstream status |
|---|---|---|---|---|
| FULU Linux host v1.0.0 | Reopens stdout through `/proc/self/fd`, which fails for a socket ([FULU #50](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/50)) | Exit code 101 from every Node.js client | Pipes the default Linux host through `cat`, explains exit 101, and documents the [`cat` wrapper](#linux) | Open |
| FULU Linux host v1.0.0 | Opens the plug-in libraries from its working directory, ignoring `PJARCZAK_BAMBU_PLUGIN_DIR` ([FULU #51](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/51)) | `validate failed: file open failed` | Passes absolute library paths on Linux; the probe reports not ready and names the setting | Open |
| FULU Linux host v1.0.0 | Exits when its input closes, dropping requests it has not answered | A probe with no handshake, or a crash in `stderr` | Keeps the input open until every request is answered | Not reported |
| FULU Linux host runtime | Ships `slicer_base64.cer` without Bambu's `printer.cer` ([FULU #52](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/52)) | LAN connections fail: `on_local_connect` reports status 1 | Not reached here: printer connection and print methods are refused, and prints use the direct MQTT/FTPS path | Open |
| FULU Linux host v1.0.0 | Segfaults on `connect_printer`, `disconnect_printer` or `destroy_agent` for an agent with no certificate folder ([FULU #53](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/53)) | The host exits mid-request | Not reached here: those methods are refused | Open |
| FULU Linux host v1.0.0 | Aborts when `create_agent` gets a log folder that doesn't exist ([FULU #54](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/54)) | `fulu_bambu_network_rpc` reports the host's exit with boost's `create_directory` error | Pass an existing `log_dir` | Open |
| FULU Linux host v1.0.0 | Aborts with `terminate called without an active exception` when its input closes after an agent exists ([FULU #55](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/issues/55)) | That message in stderr after `net.create_agent`, once every request is answered | Nothing: results are complete before the host exits | Open |
| FULU OrcaSlicer-bambulab v1.0.0 CLI | Asks the GUI application whether it is closing in `PartPlate::invalidate_plate_name_texture` | Every CLI run segfaults | Reports the signal with the slicer's output; export from the GUI, or use upstream OrcaSlicer's or Bambu Studio's CLI | Fixes proposed in [FULU #56](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/pull/56) and [FULU #57](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/pull/57); #57 backports OrcaSlicer's filament-variant guards, which the CLI hits next. FULU's CLI also has the OrcaSlicer 2.4.2 `check_outside` crash below until it takes [#14415](https://github.com/OrcaSlicer/OrcaSlicer/pull/14415) |
| OrcaSlicer 2.4.2 CLI | `PartPlate::check_outside` calls the GUI's Plater when scale or a tilt moves an object below the bed while arranging; related to the closed [OrcaSlicer #13328](https://github.com/OrcaSlicer/OrcaSlicer/issues/13328) | `slice_stl` segfaults for those transforms | Applies STL transforms to a mesh copy and refuses the 3MF case; see [Bambu-compatible slicing](./SLICING.md#bambu-compatible-slicing) | Fixed after 2.4.2 by packerlschupfer in [OrcaSlicer #14415](https://github.com/OrcaSlicer/OrcaSlicer/pull/14415), released in 2.5.0-alpha; the workaround stays while 2.4.2 is the latest stable release |
| Bambu networking plug-in | Needs its own LAN session and the printer's application certificate before it can encrypt a print command | `start_local_print` returns `-4030` after uploading | Not reached here: raw bridge print methods are refused | Plug-in design |
