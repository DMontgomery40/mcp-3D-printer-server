#!/bin/bash

# Load environment variables from .env file if it exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Build the Docker image
docker build -t mcp-3d-printer-server .

# Run the Docker container
docker run --rm -it \
  --network host \
  -e PRINTER_HOST="${PRINTER_HOST}" \
  -e PRINTER_PORT="${PRINTER_PORT}" \
  -e PRINTER_TYPE="${PRINTER_TYPE}" \
  -e API_KEY="${API_KEY}" \
  -e BAMBU_SERIAL="${BAMBU_SERIAL}" \
  -e BAMBU_TOKEN="${BAMBU_TOKEN}" \
  -e TEMP_DIR="/app/temp" \
  -e SLICER_TYPE="${SLICER_TYPE}" \
  -e SLICER_PATH="${SLICER_PATH}" \
  -e SLICER_PROFILE="${SLICER_PROFILE}" \
  -v "$(pwd)/temp:/app/temp" \
  mcp-3d-printer-server
