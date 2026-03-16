# Agent Instructions for mcp-3D-printer-server

## Release Rules

- **Always bump the npm version** (`npm version patch`) and `npm publish` after any change that gets pushed to main -- code, docs, config, anything.
- Commit the version bump and push it as part of the same push.

## Before Pushing

1. `npm run build` -- must be zero errors.
2. `node --test tests/behavior.test.mjs` -- must pass all tests.
3. `npm version patch` -- bump the version.
4. `npm publish` -- publish to npm.
5. Commit the version bump, push everything.

## Key Context

- Multi-printer MCP server supporting 7 printer types.
- Bambu adapter has safety-critical model validation (BAMBU_MODEL required).
- `dist/` is gitignored -- do not try to commit it.
- `BAMBU_MODEL` env var must be explicitly set to `""` in test environments to override dotenv loading from `.env`.
- Safety-critical changes here should also be ported to bambu-printer-mcp.
