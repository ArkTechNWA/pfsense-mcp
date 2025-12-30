#!/bin/bash
# pfsense-mcp launcher - loads API key from pass store

export PFSENSE_HOST="192.168.1.1"
export PFSENSE_API_KEY="$(pass show api/pfsense-rest-api-key)"

exec node "$(dirname "$0")/dist/index.js"
