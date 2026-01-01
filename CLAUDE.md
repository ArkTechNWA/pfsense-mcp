# pfsense-mcp - Claude Code Instructions

## CRITICAL: API Documentation

**pfSense API docs are ON THE DEVICE:**
```
https://192.168.1.1/api/v2/documentation
```

DO NOT search externally for pfSense API endpoints. The Swagger docs are right there.

## Architecture

- **MCP Server**: `src/` - Tools for Claude to control pfSense
- **Relay Service**: `relay-service/` - Guardian dashboard + emergency alerts
- **NEVERHANG**: Circuit breaker for API reliability
- **A.L.A.N.**: Persistent learning database (SQLite)

## Dashboard

Live at: https://pfsense-mcp.arktechnwa.com/dashboard

Metrics pushed by `pf_health` tool to relay service.

## Environment Variables

```
PFSENSE_HOST=https://192.168.1.1
PFSENSE_API_KEY=<from pfSense API settings>
PFSENSE_API_SECRET=<from pfSense API settings>
GUARDIAN_RELAY_URL=https://pfsense-mcp.arktechnwa.com
GUARDIAN_ADMIN_KEY=<relay admin key>
PFSENSE_DEVICE_TOKEN=meldrey-netgate2100
```
