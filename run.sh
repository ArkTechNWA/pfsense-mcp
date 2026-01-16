#!/bin/bash
# pfsense-mcp launcher - loads API keys from pass store

export PFSENSE_HOST="192.168.1.1"
export PFSENSE_API_KEY="$(pass show api/pfsense/rest-api-key)"
export GUARDIAN_ADMIN_KEY="$(pass show api/pfsense/relay-admin-key)"
export GUARDIAN_RELAY_URL="${GUARDIAN_RELAY_URL:-https://pfsense-mcp.arktechnwa.com}"
export PFSENSE_DEVICE_TOKEN="${PFSENSE_DEVICE_TOKEN:-f7b13f3ab3877808112206f8155f99cb40180b59a763b6ce4a0921f55f090436}"

exec node "$(dirname "$0")/dist/index.js"
