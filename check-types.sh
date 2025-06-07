#!/bin/bash
cd /Users/davidmontgomery/mcp-3D-printer-server

echo "Running TypeScript compiler..."
./node_modules/.bin/tsc --noEmit 2>&1

if [ $? -eq 0 ]; then
    echo "TypeScript compilation successful!"
else
    echo "TypeScript compilation failed"
fi
