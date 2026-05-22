# mcp-3D-printer-server

## Release Rules

- **Always bump the npm version** (`npm version patch`) and `npm publish` after any change that gets pushed to main -- code, docs, config, anything.
- Commit the version bump and push it as part of the same push.

## Build & Test

- `npm run build` must pass clean (zero tsc errors) before committing.
- `node --test tests/behavior.test.mjs` must pass all tests before pushing.
- Tests use the compiled `dist/index.js` -- always build before testing.
- `dist/` is gitignored in this repo (unlike bambu-printer-mcp).

## Architecture

- Multi-printer MCP server: OctoPrint, Klipper, Duet, Repetier, Bambu, Prusa Connect, Creality.
- `PRINTER_TYPE` env var selects the printer adapter.
- Bambu adapter uses `basic-ftp` directly for uploads and `bambu-node` for MQTT commands.
- Transports: stdio (default) and streamable-http.

## Safety

- `BAMBU_MODEL` is required for Bambu print operations. Server uses MCP elicitation to ask if missing.
- Never skip model validation -- wrong model = wrong G-code = potential hardware damage.

## Relationship to bambu-printer-mcp

- bambu-printer-mcp is a stripped-down Bambu-only fork of this repo.
- Safety-critical changes must be ported to both repos.
