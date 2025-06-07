#!/bin/bash
cd /Users/davidmontgomery/mcp-3D-printer-server
npm run build 2>&1
echo "Build exit code: $?"
