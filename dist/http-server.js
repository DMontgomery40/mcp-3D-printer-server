#!/usr/bin/env node
var _a;
(_a = process.env).MCP_TRANSPORT ?? (_a.MCP_TRANSPORT = "streamable-http");
if (!process.env.MCP_HTTP_PORT && process.env.HTTP_PORT) {
    process.env.MCP_HTTP_PORT = process.env.HTTP_PORT;
}
void import("./index.js");
export {};
