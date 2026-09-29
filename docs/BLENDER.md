# Blender MCP

[Back to README](../README.md)

Your agent can edit or model a part in Blender, export a verified STL, and hand
it to the slicer and printer tools in this server. No Blender knowledge needed:
ask for the result ("make this case fit my phone") and the agent does the
modelling through a Blender MCP server.

This server does not bundle Blender. It connects to a standard Blender MCP
server, [mcp-for-blender](https://github.com/ahujasid/mcp-for-blender)
(formerly `blender-mcp`), as an MCP client over stdio. Printer tools work
without Blender configured.

## Set it up

1. Install [Blender](https://www.blender.org/download/) and
   [uv](https://docs.astral.sh/uv/getting-started/installation/).
2. Install the matching Blender addon: `uvx mcp-for-blender install-addon`,
   or download `addon.py` from the
   [mcp-for-blender repository](https://github.com/ahujasid/mcp-for-blender)
   and install it under *Edit → Preferences → Add-ons*. Enable it.
3. Open Blender. The addon starts its connection automatically (see the
   *MCP for Blender* sidebar tab). Keep Blender open while your agent works:
   the addon does not run in background (`blender -b`) mode.
4. Give this server two settings (your agent can do this during
   [setup](SETUP.md)):
   - `BLENDER_MCP_COMMAND`: the full path to `uvx`
   - `BLENDER_MCP_ARGS`: `["mcp-for-blender"]`

   Optional: `BLENDER_HOST` / `BLENDER_PORT` if the addon listens somewhere
   other than `localhost:9876`, and `BLENDER_MCP_TIMEOUT_MS` (default 120000).
   Blender and this server must share a filesystem, because STL paths are
   passed between them.

Check it: ask your agent to call `blender_mcp_status` with `connect: true`.
It lists the Blender tools it discovered. A connected MCP server does not by
itself prove the addon is running; `get_scene_info` through `blender_mcp_call`
does.

## How the pieces fit

| Step | Tool | What it does |
|---|---|---|
| Inspect the input | `get_stl_info` | Size, bounding box, and triangle count of the downloaded model |
| Discover Blender | `blender_mcp_status` | Tool names and summaries; `tool_names` returns full schemas for the tools you'll call |
| Model or edit | `blender_mcp_call` | Forwards any Blender MCP tool, usually `execute_blender_code`, with the user's own words in `user_prompt` |
| Export for printing | `blender_mcp_export_stl` | Writes named scene objects to a new STL and reports the measured size |
| Quick mesh fixes | `blender_mcp_edit_model` | Imports an STL, applies `decimate`, `remesh`, or `boolean_union`, and exports a new STL |
| Slice and print | `slice_stl`, `print_3mf`, … | The usual printer path, with all print safety checks |

`blender_mcp_export_stl` exists because Blender MCP's own `export_scene`
writes GLB or FBX, not STL. The export reads the evaluated geometry (modifiers
applied) in world space and writes it directly, so it never changes your
selection, active object, or mode. It checks Blender's receipt, validates the
file, refuses to overwrite anything, and returns `output_verified: true` with
the triangle count and `bounding_box.dimensions` measured from the written
bytes.

**Units.** STL files carry no units; slicers read them as millimetres. An STL
imported into Blender keeps its numbers (163.4 mm becomes 163.4 Blender
units), so export it with the default `scale: 1`. If the agent modelled from
scratch in real metres, the export warns that the part is under 1 unit
across; export again with `scale: 1000`. Always compare the reported
dimensions with what you expect before slicing.

## Worked example: refit a phone case for a new phone

This example ran end to end through this server on 2026-09-29: Blender 5.0.1
with mcp-for-blender 2.1.1, driven by an MCP client over stdio. The request:

> "Here's an iPhone 16 Pro Max case. Make it fit my iPhone 17 Pro Max."

1. **Get the model and the facts.** The agent downloaded a free case
   ([*iPhone 16 Pro Max Case* by Andrej on Printables](https://www.printables.com/model/1397793-iphone-16-pro-max-case),
   CC BY-NC-SA) and Apple's official
   [dimensional drawings](https://developer.apple.com/accessories/) for both
   phones. `get_stl_info` reported the case at 167.2 × 81.8 × 12.25 mm.
2. **Measure the case in Blender.** Through `execute_blender_code`, it
   imported the STL and ray-cast the inside: a 164.2 × 77.8 mm cavity (so the
   designer left 1.2 mm of length and 0.2 mm of width play), 1.5–2 mm walls,
   a camera opening in one corner, and cut-outs for the action button and
   Camera Control.
3. **Compare the phones.** Apple's drawings put the 17 Pro Max at
   163.43 × 77.98 × 8.75 mm (16 Pro Max: 163.03 × 77.58 × 8.25). Every button
   sits exactly 0.20 mm further from the top, which is the same position
   relative to the phone's centre. The camera changed completely: a
   full-width plateau raised 2.55 mm, about 70 mm wide and reaching 48 mm down
   from the top edge, and the
   bottom speaker ports extend 4.9 mm further on one side.
4. **Refit, don't scale.** Scaling would thicken walls and move buttons.
   Instead the agent stretched the case at its centre planes: +0.2 mm per side
   in length and width, and +0.5 mm of depth above the phone's mid-line, which
   also moves the button openings up the 0.25 mm the new phone needs. It cut a
   plateau opening with 1.0 mm lengthwise and 0.5 mm crosswise clearance,
   added three speaker holes, and filled a 1.6 mm border around the new
   opening so no half-cut grill holes were left as thin slivers.
5. **Check the fit.** It built a phone stand-in from Apple's numbers and
   intersected it with the case: the camera plateau cleared by 0 mm³ of
   overlap, and the body overlapped only 7.8 mm³ along the bottom 0.28 mm of
   the cavity edge, where the stand-in's square edges meet the case's small
   fillet (the real phone's edges are rounded). The same check against the
   original case overlapped 283 mm³, which confirms the test catches a
   real misfit.
6. **Export and verify.** `blender_mcp_export_stl` wrote a new
   167.6 × 82.2 × 12.75 mm STL (194,652 triangles, no non-manifold edges).
7. **Slice.** `slice_stl` sliced it with the installed Bambu Studio for a P1S
   with a 0.4 mm nozzle and Bambu TPU 95A HF (flexible, as phone cases
   usually are): 230 °C nozzle, 35 °C textured plate, about 1 h 38 min and
   21 g of filament. The next step is the print tools, which check the file
   and the printer and ask before starting.

Evidence levels: geometry, fit calculations, file validation, and slicing were
checked in software. The printed case, snap fit, and TPU behaviour were not
tested in this run, and the plateau's lower edge is not dimensioned on Apple's drawing,
so it was scaled from the drawing (±0.3 mm) and given extra clearance.

## Check a Blender install end to end

`scripts/blender-live-check.mjs` launches a separate Blender with factory
settings (never your open scene), loads the addon on a spare port, drives
this server over stdio, and checks that an exported 40 × 20 × 10 box
measures exactly that:

```bash
npm run build
BLENDER_EXECUTABLE=/Applications/Blender.app/Contents/MacOS/Blender \
BLENDER_ADDON_PATH=/path/to/mcp-for-blender/addon.py \
node scripts/blender-live-check.mjs
```

## Safety and limits

- `blender_mcp_call` can change your open scene. Calls are never retried
  automatically; after a timeout, look at Blender before trying again,
  because the request may still be running.
- Blender executables come only from server configuration.
  Per-call executable overrides stay disabled unless
  `MCP_ALLOW_EXECUTABLE_ARG=1`.
- Printer access codes and other server secrets are not passed to the
  Blender process; only `BLENDER_*` settings are.
- A valid STL is not a guarantee of a good print. Check the reported
  dimensions, slice it, and look at the preview before printing.
- `BLENDER_MCP_BRIDGE_COMMAND` keeps older custom bridge executables working
  for `blender_mcp_edit_model`; their results report `output_verified: false`.
