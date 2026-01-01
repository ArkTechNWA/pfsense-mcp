#!/bin/bash
# pfsense-mcp launcher - loads API keys from pass store

export PFSENSE_HOST="192.168.1.1"
export PFSENSE_API_KEY="$(pass show api/pfsense-rest-api-key)"
export GUARDIAN_ADMIN_KEY="$(pass show api/pfsense-relay-admin-key)"

exec node "$(dirname "$0")/dist/index.js"
