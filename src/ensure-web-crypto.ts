// Node.js 18 exposes Web Crypto only as node:crypto's webcrypto, but the MCP
// SDK's streamable HTTP transport calls the global crypto, which
// @hono/node-server 2.x no longer installs. Newer Node.js already provides it.
import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}
