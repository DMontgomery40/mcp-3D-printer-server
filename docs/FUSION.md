# Fusion MCP

[Back to README](../README.md)

Your agent can design a part from scratch in Autodesk Fusion, export it, and
hand the STL to the slicer and printer tools in this server. Fusion keeps the
design parametric, so a later change ("make it 1 mm wider") can be a single
parameter edit instead of a new mesh.

This server does not bundle Fusion. It connects as an MCP client over stdio to
[faust-machines/fusion360-mcp-server](https://github.com/faust-machines/fusion360-mcp-server)
(MIT), which talks over TCP to that project's Fusion360MCP add-in running
inside Fusion. Fusion and its licence, including Autodesk's free personal-use
licence, are yours. Printer tools work without Fusion configured. Scan cleanup
and touch-ups still use [Blender](BLENDER.md).

## Set it up

The server and the add-in are pinned to commit `19b9f1e95192`. The PyPI
release (0.1.0) crashes under `mcp` 2.x ([issue #30](https://github.com/faust-machines/fusion360-mcp-server/issues/30)),
and that commit pins `mcp>=1.0,<2`.

1. Install [Autodesk Fusion](https://www.autodesk.com/products/fusion-360) and
   [uv](https://docs.astral.sh/uv/getting-started/installation/).
2. Install the add-in from the same commit: copy the repository's `addon/`
   folder at `19b9f1e95192` to
   `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/Fusion360MCP`.
   In Fusion, open **Utilities → Add-Ins → Scripts and Add-Ins**, select
   **Fusion360MCP**, and turn on **Run on Startup**.
3. Give this server its settings, in the same env file as `BLENDER_MCP_*`
   (your agent can do this during [setup](SETUP.md)):

   | Variable | Value |
   |---|---|
   | `FUSION_MCP_COMMAND` | The full path to `uvx` |
   | `FUSION_MCP_ARGS` | `["--from","git+https://github.com/faust-machines/fusion360-mcp-server@19b9f1e95192","fusion360-mcp-server","--mode","socket"]` (the default when unset) |
   | `FUSION_MCP_TIMEOUT_MS` | Optional, default `180000`. The first start downloads the pinned server |
   | `FUSION_MCP_HOST` | Optional, default `localhost`. Passed through to the Fusion server |

   `FUSION_MCP_PORT` (default 9876) is passed through too. Blender's MCP
   addon also listens on 9876 by default, so if you run both, move one of
   them: set `FUSION_MCP_PORT` for the Fusion server and the add-in, or
   `BLENDER_PORT` for Blender.
4. Open Fusion and open or create any design once (**File → New Design**);
   see [the bootstrap gap](#the-bootstrap-gap-issue-12) below.

Check it: ask your agent to call `fusion_mcp_status`. `connected: true` means
the Fusion server started and the add-in answered.

## How the pieces fit

| Step | Tool | What it does |
|---|---|---|
| Check Fusion | `fusion_mcp_status` | `{configured, connected, addinReachable, fusionRunning, tools[], launched, pin, server, error}`. `launch: true` opens Fusion on this Mac when it isn't running and waits up to 90 s for the add-in |
| Start a design | `fusion_mcp_new_design` | Opens a new parametric design document through `execute_code` |
| Model | `fusion_mcp_call` | Forwards any of the server's 93 tools: `create_sketch`, `extrude`, `revolve`, `create_hole`, `create_thread`, `fillet`, `shell`, `boolean_operation`, `create_parameter`, `set_parameter`, `check_interference`, `execute_code`, … |
| Export | `fusion_mcp_export` | Writes `<name>.stl`, `<name>.f3d` and `<name>.parameters.json` into `output_dir` and returns their absolute paths as `stl`, `f3d` and `parameters` |
| Check and print | `get_stl_info`, `lay_flat`, `slice_stl`, … | The usual path, with every print safety check |

`fusion_mcp_status` checks the add-in by sending it the protocol's `ping`
over TCP and requiring its `pong`, so another program on the same port
(such as Blender's addon) is not mistaken for Fusion. `fusionRunning` comes
from the Fusion process on macOS. Elsewhere, or when `FUSION_MCP_HOST` is
another computer, it is whether the add-in answered.

`fusion_mcp_export` exports one body as the STL: the only visible solid body,
or the one named in `body_name`. It stages the files, checks that Fusion wrote
them, validates the STL as a finite triangle mesh, and only then publishes all
three. Existing files are never overwritten, and on any failure nothing is
left behind. The parameters file holds the design's user parameters (`name`,
`value`, `expression`, `unit`, `comment`), read through `execute_code`,
because `get_parameters` returns its result as Python text rather than JSON.
Fusion and this server must share the file system, so keep `FUSION_MCP_HOST`
local for exports.

**Units.** Fusion works in centimetres internally, and most tools take
lengths in centimetres. STL files carry no units and slicers read them as
millimetres. `fusion_mcp_export` compares the STL's size with the Fusion
body's size and reports `stlUnits` (`mm`, `cm`, or `unknown`) and the body's
`fusionSizeMm`. If the STL came out in centimetres, the result warns you to
scale it by 10 before slicing. Compare `boundingBox.dimensions` with what you
asked for before printing.

## The bootstrap gap (issue #12)

At the pinned commit every Fusion tool, including `execute_code`, needs an
active design. When Fusion sits on its home screen with no document open, no
tool can create the first one
([issue #12](https://github.com/faust-machines/fusion360-mcp-server/issues/12)).
`fusion_mcp_new_design` works once any design is open; on the home screen it
fails with instructions to open or create a design once in Fusion. The fix
proposed upstream lets `execute_code` run without a design; move the pin only
after it lands and the acceptance check below passes.

## Check a Fusion install end to end

PRD §8.9's acceptance check, run on a Mac with Fusion before the pin moves:

1. Start a "make something that fits" pass for a dimensioned bracket.
2. `fusion_mcp_export` returns STL, F3D and parameters.
3. `get_stl_info` matches the requested dimensions within ±0.2 mm.
4. A follow-up that changes one dimension by 1 mm is a single `set_parameter`,
   and the re-export matches within ±0.2 mm.
5. `slice_stl` succeeds on the P1S profile.

Evidence for this release: the pinned server was started through this
bridge with `uvx` and listed its 93 tools, and the bridge's tests run
against a stdio peer that reproduces that commit's recorded output. The
acceptance check above has not been run here, because Fusion was not
installed on the test Mac.

## Safety and limits

- `fusion_mcp_call` can change your open Fusion design. Calls are never
  retried automatically; after a timeout, look at Fusion before trying
  again, because the request may still have run.
- Fusion executables come only from server configuration. No tool accepts
  an executable or command argument.
- Printer access codes and other server secrets are not passed to the
  Fusion server process; only `FUSION_*` settings are.
- The client stays connected for the life of this server, so the Fusion
  server starts once. If it exits, the next call starts it again.
- `measure_distance` is broken at the pinned commit
  ([issue #27](https://github.com/faust-machines/fusion360-mcp-server/issues/27)).
  Measure the exported STL with `get_stl_info` instead.
- A valid STL is not a guarantee of a good print. Check the reported
  dimensions, slice it, and look at the preview before printing.
