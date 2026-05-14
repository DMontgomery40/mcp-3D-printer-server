#!/usr/bin/env node

process.env.MCP_TRANSPORT ??= "streamable-http";

if (!process.env.MCP_HTTP_PORT && process.env.SSE_PORT) {
  process.env.MCP_HTTP_PORT = process.env.SSE_PORT;
}

void import("./index.js");
