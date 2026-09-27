# Changelog

## 1.2.9

- Address Bambu FTPS upload failures reported in #22 by using TLS 1.2 control
  and data channels with verified session reuse. Physical X1C firmware
  confirmation remains outstanding; no printer commands were sent in testing.
- Port standard Blender MCP discovery, tool forwarding, and verified STL edit
  support from the Bambu fork. Preserve this server's legacy shell/stdin bridge.
- Require the Bambu model on raw print starts and upload-with-print, matching
  the fork's safety checks. Keep uploads without printing available.
- Isolate server and inline-upload scratch paths to prevent filename traversal
  and collisions from overwriting or deleting unrelated files.
- Refresh vulnerable dependencies, pin the supported bambu-node API version,
  declare the TypeScript build dependency, build before npm packing, and report
  the actual package version during MCP initialization.
- Keep generated dist files out of Git and validate clean builds, protocols,
  package installation, and Docker builds in CI.
