# Contributors

Thank you to everyone who builds, tests, reports problems, and shares real printer evidence. This project supports seven printer systems, and no one person owns all of that hardware, so your reports are how it improves.

## Merged contributions

| Contributor | Contribution |
| --- | --- |
| [Javier Cortejoso (jcortejoso)](https://github.com/jcortejoso) | Reads the FULU bridge command from server configuration by default, with an explicit opt-in for per-call bridge commands, in [#20](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/20). [#21](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/21) extends the same gate to every per-call executable selector. |
| [Ewan Monro (heyitsmeez)](https://github.com/heyitsmeez) | Reports in [#17](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/17) that a top-level `anyOf` in the `upload_gcode` input schema made the Anthropic API reject every tool, and fixes it in [#18](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/18). |
| [David Gageot (dgageot)](https://github.com/dgageot) | Fixes the Docker build and hardens the image (non-root user, pinned base image, production dependencies only, build caching) in [#3](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/3). |
| [Frank Fiegel (punkpeye)](https://github.com/punkpeye) | Adds the [Glama MCP directory](https://glama.ai/mcp/servers/7f6v2enbgk) listing badge in [#1](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/1). |
| [Lawrence Sinclair (lwsinclair)](https://github.com/lwsinclair) | Adds the MseeP.ai security listing badge in [#5](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/5). |

## Bug reports and printer evidence

| Contributor | Contribution |
| --- | --- |
| [Lickitysplitted](https://github.com/Lickitysplitted) | Diagnoses Bambu FTPS "Premature close" upload failures on an X1C as missing TLS session reuse in [#22](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/22). Release 1.2.9 addresses it; confirmation on that X1C firmware is still outstanding. |
| [CrowSoda](https://github.com/CrowSoda) | Tries slicing and printing on a Creality K1 Max through Klipper and Moonraker, and reports invalid OrcaSlicer CLI flags, missing filament-profile support, and unregistered upload and start tools in [#16](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/16). All three are fixed. |
| [dongio20](https://github.com/dongio20) | Reports the PrusaLink 0.8.1 status 404, with firmware details and the working endpoint, in [#11](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/11). Fixed in [#15](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/15). |
| [Remco Veldkamp (remcoder)](https://github.com/remcoder) | Reports that a large OctoPrint file list (324 files, about 500 KB of JSON) overflows a model's context window in [#4](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/4). The full list is still returned; this is documented as a limitation. |
| [Jose Martinez (josemartinezbli)](https://github.com/josemartinezbli) | Reports that `SLICER_PROFILE` was ambiguous for PrusaSlicer and OrcaSlicer, with slicer error output, in [#7](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/7). The slicing guide now documents profiles per slicer. |
| [Gioele Molinari (gioelemo)](https://github.com/gioelemo) | Shares a Prusa Connect configuration in [#9](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/9). The Prusa adapter now normalizes `connect.prusa3d.com` to HTTPS; cloud access has not been confirmed on hardware. |
| [BruceJin (BruceJqs)](https://github.com/BruceJqs) | Reports that a per-call `bridge_command` in `blender_mcp_edit_model` could launch an arbitrary local executable (CWE-78) in [#14](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/14). Per-call executable selectors now require the server-side `MCP_ALLOW_EXECUTABLE_ARG=1` opt-in ([#20](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/20), [#21](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/21)). |
| [0xBrandon (0x4272616E646F6E)](https://github.com/0x4272616E646F6E) | Asks for network (SSE) serving in [#6](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/6). The server now provides a streamable HTTP transport. |

## Requests and proposals not yet merged

| Contributor | Contribution |
| --- | --- |
| [Raza Sharif (razashariff)](https://github.com/razashariff) | Proposes cryptographic signing, replay protection, and agent identity checks before print commands in [#13](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/13). Signing is not implemented; since 1.2.10, every print start and positive heating command requires human confirmation through MCP elicitation, and printed files are inspected before dispatch. |
| [DarkCraven (sweidinger)](https://github.com/sweidinger) | Requests Klipper print-job status (progress, file, times) beyond Moonraker's `/printer/info` in [#12](https://github.com/DMontgomery40/mcp-3D-printer-server/issues/12). Not yet implemented. |
| [Hex (hexatriene)](https://github.com/hexatriene) | Proposes migrating Bambu support to `bambu-js` v3 for H2D support and FTP operations in [#10](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/10). Closed without merging; the server keeps `bambu-node` for MQTT and uses `basic-ftp` directly for uploads. |
| [Jean-Laurent de Morlhon (jeanlaurent)](https://github.com/jeanlaurent) | Proposes Docker support in [#2](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/2). Closed without merging; the repository's Docker setup was later fixed in #3. |

## Project maintainer

- [David Montgomery (DMontgomery40)](https://github.com/DMontgomery40): project maintainer and Bambu Lab hardware testing.

See the [full contribution history](https://github.com/DMontgomery40/mcp-3D-printer-server/graphs/contributors) for commit authorship. Credit here includes bug reports, printer evidence, and reviewed proposals as well as merged code.

## Open-source community and interoperability

Special thanks to the [FULU Foundation](https://www.fulu.org/), [Louis Rossmann](https://www.youtube.com/@rossmanngroup), and the [OrcaSlicer-bambulab contributors](https://github.com/FULU-Foundation/OrcaSlicer-bambulab) for their work supporting user control and interoperable tools. This is community recognition, separate from code authorship in this repository. The Bambu-only fork, [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp), credits its own contributors in its [CONTRIBUTORS.md](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/CONTRIBUTORS.md).
