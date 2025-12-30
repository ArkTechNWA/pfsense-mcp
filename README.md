# pfclaude

A bidirectional AI agent for pfSense. Two components, one package: an MCP server for Claude Code control, and an emergency brain that activates when your network needs help.

**Status:** Planning
**Author:** Claude (claude@arktechnwa.com) + Meldrey
**License:** MIT
**Organization:** [ArktechNWA](https://github.com/ArktechNWA)

---

## Why?

Your AI assistant can help configure firewalls, but it's blind to your network's health. It can't see if your WAN is down, can't check DHCP leases, can't restart a stuck interface.

Worse: when your network breaks, you lose access to your AI assistant entirely.

pfclaude solves both problems:
1. **Normal mode**: Claude Code controls pfSense via MCP — full visibility, full capability
2. **Emergency mode**: When Claude Code is unreachable, pfSense's onboard brain activates — diagnostics, notifications, autonomous recovery

---

## Philosophy

1. **Maximum capability** — Expose everything pfSense can do
2. **User controls exposure** — Checkbox permissions, not hardcoded limits
3. **Maximum availability** — Multiple transport channels, graceful fallbacks
4. **Lightweight emergency brain** — Minimal resource usage, adaptive monitoring
5. **Bidirectional communication** — Email commands work even when network is broken

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Claude Code (workstation)                                       │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ pfclaude-mcp                                                │ │
│ │  - Full pfSense API passthrough                             │ │
│ │  - All operations: firewall, NAT, DHCP, VPN, logs, etc.     │ │
│ │  - Authenticated over HTTPS                                 │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
           ↕ HTTPS + API Key (primary)
           ↕ SSH (fallback)
┌─────────────────────────────────────────────────────────────────┐
│ pfSense Router                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ pfClaude Package                                            │ │
│ │                                                             │ │
│ │  NORMAL MODE          │  EMERGENCY MODE                     │ │
│ │  ─────────────        │  ──────────────                     │ │
│ │  API Server           │  Watchdog Daemon                    │ │
│ │  ↕ MCP talks here     │  ↳ Health monitors                  │ │
│ │                       │  ↳ Trigger detection                │ │
│ │  Full pfSense ops     │  ↳ Decision engine                  │ │
│ │  Auth'd requests      │  ↳ Autonomous actions               │ │
│ │                       │  ↳ Notification dispatch            │ │
│ │                       │                                     │ │
│ │  ───────────────────────────────────────────────────────── │ │
│ │  SHARED INFRASTRUCTURE                                      │ │
│ │  • Permission matrix (checkboxes)                           │ │
│ │  • SMTP client (outbound alerts)                            │ │
│ │  • Email parser (inbound commands)                          │ │
│ │  • Cloud beacon (optional status sync)                      │ │
│ │  • Local knowledge base (patterns, history)                 │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Authentication

### API Authentication

Simple, proven security:

```json
{
  "auth": {
    "api_key": "randomly-generated-64-char-key",
    "require_https": true,
    "ip_whitelist": ["192.168.1.0/24", "10.0.0.5"],
    "rate_limit": 100,
    "lockout_threshold": 5,
    "lockout_duration": 900
  }
}
```

- API key transmitted in header: `X-PfClaude-Key: <key>`
- HTTPS required (uses pfSense's existing certificate)
- Optional IP whitelist (only accept from known Claude IPs)
- Rate limiting: 100 requests/min default
- Failed auth lockout: 5 failures → 15 min ban

### Email Authentication

For inbound email commands:

```
Subject: [PFCLAUDE:1234] status
```

- Sender must be in whitelist
- PIN must match configured value
- Timestamp validation (reject if >5min old)
- Rate limit: 10 commands/hour

---

## Trigger Conditions

**Tiered detection with configurable thresholds:**

### Tier 1: Monitoring (always on, ultra-light)

| Check | Description | Default |
|-------|-------------|---------|
| Interface link state | Is the physical link up? | ✓ |
| Heartbeat reception | Has Claude Code checked in? | ✓ |
| Gateway reachability | Can we ping default gateway? | ✓ |
| WAN connectivity | Can we reach external IPs? | ✓ |

### Tier 2: Concern (triggers increased monitoring)

| Check | Description | Default |
|-------|-------------|---------|
| Packet loss > 10% | Network degraded | ✓ |
| Latency spike > 3x | Something's congested | ✓ |
| DNS resolution failing | Name lookups broken | ✓ |
| DHCP not responding | Clients can't get IPs | ✓ |
| Unusual traffic volume | 5x normal (attack? loop?) | ✓ |

### Tier 3: Emergency (activates autonomous response)

| Check | Description | Default |
|-------|-------------|---------|
| LAN interface down | Physical link lost | ✓ |
| N consecutive heartbeat misses | Default: 3 | ✓ |
| Gateway unreachable for N seconds | Default: 60 | ✓ |
| WAN up but LAN unreachable | Asymmetric failure | ✓ |
| All monitored hosts unreachable | Total LAN failure | ✓ |

---

## Health Check Design

**Lightweight, adaptive, CPU-aware:**

```
┌─────────────────────────────────────────────────────────────────┐
│ ADAPTIVE FREQUENCY                                              │
│                                                                 │
│ State: HEALTHY     → Check every 60s                            │
│ State: CONCERNED   → Check every 15s                            │
│ State: DEGRADED    → Check every 5s                             │
│ State: EMERGENCY   → Check every 2s (active response mode)      │
│                                                                 │
│ CPU AWARENESS                                                   │
│ • If system load > 80%, halve check frequency                   │
│ • If memory < 10% free, disable non-critical checks             │
│ • Never consume > 2% CPU for monitoring                         │
│                                                                 │
│ HYSTERESIS                                                      │
│ • Each check returns: OK (0), WARN (1), FAIL (2)                │
│ • Aggregate score determines state transition                   │
│ • Need 3 consecutive same-state readings to transition          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Autonomous Actions

**User configures what pfClaude can do WITHOUT asking:**

### Always Safe (default: enabled)

| Action | Description |
|--------|-------------|
| Log events locally | Always on |
| Send email notification | Alert user |
| Update cloud beacon status | External visibility |
| Capture diagnostic snapshot | Preserve state |

### Diagnostic (default: enabled)

| Action | Description |
|--------|-------------|
| Run connectivity tests | ping, traceroute |
| Capture interface statistics | Counters, errors |
| Gather recent log entries | Context for diagnosis |
| Check service status | What's running/stopped |
| Query ARP/NDP tables | Who's on the network |

### Restorative (default: disabled)

| Action | Description |
|--------|-------------|
| Restart specific interface | Often fixes link issues |
| Flush connection state table | Clears stuck connections |
| Restart DHCP service | Fixes lease issues |
| Restart DNS resolver | Fixes resolution issues |
| Clear ARP cache | Fixes stale entries |
| Restart specific service | Configurable list |

### Failover (default: disabled)

| Action | Description |
|--------|-------------|
| Switch to backup WAN gateway | Major network change |
| Enable/disable interface | Significant impact |
| Apply emergency ruleset | Pre-configured safe rules |
| Trigger CARP failover | HA environments |

### Defensive (default: disabled)

| Action | Description |
|--------|-------------|
| Block IPs exceeding threshold | Anti-DoS |
| Enable emergency rate limiting | Protect resources |
| Activate lockdown ruleset | Maximum security |
| Disable non-essential services | Reduce attack surface |

---

## Local Intelligence

### Pattern Memory

```json
{
  "pattern_memory": {
    "enabled": true,
    "database": "/var/db/pfclaude/patterns.db",
    "max_size_mb": 10,
    "retention_days": 90
  }
}
```

- Stores: "Last time X happened, Y was the cause"
- Learns: "Interface restart fixed this 3/4 times"
- Tracks: Normal baselines (traffic, latency, errors)
- SQLite DB, <10MB footprint

### Haiku Batch Analysis (optional)

```json
{
  "haiku_analysis": {
    "enabled": true,
    "schedule": "0 3 * * *",
    "api_key_env": "PFCLAUDE_ANTHROPIC_KEY",
    "sanitize": ["ip", "mac", "hostname"],
    "max_log_lines": 1000
  }
}
```

- Nightly batch: Send sanitized logs to Anthropic
- Haiku analyzes patterns, anomalies, recommendations
- Results stored locally as "learned insights"
- Cost: ~$0.01/day for typical home network

---

## Notification Channels

**User configures their own escalation paths:**

```json
{
  "notifications": {
    "email": {
      "enabled": true,
      "smtp_server": "smtp.gmail.com",
      "smtp_port": 587,
      "username_env": "SMTP_USER",
      "password_env": "SMTP_PASS",
      "recipients": ["you@example.com"]
    },
    "pushover": {
      "enabled": false,
      "api_key_env": "PUSHOVER_KEY",
      "user_key_env": "PUSHOVER_USER"
    },
    "webhook": {
      "enabled": false,
      "url": "https://your-service.com/webhook",
      "headers": {"Authorization": "Bearer xxx"}
    },
    "telegram": {
      "enabled": false,
      "bot_token_env": "TELEGRAM_TOKEN",
      "chat_id": "123456789"
    },
    "cloud_beacon": {
      "enabled": false,
      "url": "https://your-beacon.com/status",
      "shared_secret_env": "BEACON_SECRET"
    }
  }
}
```

### Escalation Levels

| Level | Actions |
|-------|---------|
| INFO | Log only |
| NOTICE | Log + cloud beacon |
| WARNING | Log + cloud + email |
| CRITICAL | Log + cloud + email + push + webhook |
| EMERGENCY | ALL channels + repeated alerts until ack'd |

---

## Email Commands

**When WAN works but LAN doesn't, email becomes the control channel:**

### Command Format

```
To: pfclaude@your-pfsense.com
Subject: [PFCLAUDE:1234] status
Body: (optional context)
```

### Available Commands

| Command | Description |
|---------|-------------|
| `status` | Current state summary |
| `changes <N>m` | What changed in last N minutes |
| `logs <N>` | Last N log lines |
| `diagnose` | Run full diagnostic suite |
| `restart <iface>` | Restart interface (if permitted) |
| `help` | List available commands |

### Example Response

```
Subject: Re: [PFCLAUDE:1234] status

pfClaude Status Report
Generated: 2025-12-29 15:42:00 UTC

SYSTEM: DEGRADED (score: 4/10)

Interfaces:
  WAN  (igb0): UP - 98.2.1.45 - 12ms latency
  LAN  (igb1): UP - 192.168.1.1 - NO TRAFFIC 5min  ← Problem
  OPT1 (igb2): DOWN - disabled

Recent Events:
  15:37 - LAN traffic dropped to zero
  15:38 - DHCP requests stopped
  15:40 - Watchdog entered CONCERNED state

Recommended: Check switch connectivity to LAN port
```

---

## Cloud Beacon (optional)

**For checking router status from anywhere:**

```json
{
  "cloud_beacon": {
    "enabled": true,
    "url": "https://your-beacon-server.com/api/beacon",
    "router_id": "home-pfsense",
    "shared_secret_env": "BEACON_SECRET",
    "frequency_healthy": 60,
    "frequency_degraded": 15
  }
}
```

### Self-Hosted Option

Docker image provided for running your own beacon receiver:

```bash
docker run -d -p 8080:8080 \
  -e BEACON_SECRET=your-secret \
  arktechnwa/pfclaude-beacon
```

Features:
- Receives status beacons from pfSense
- Stores recent logs (configurable retention)
- Web dashboard for status checks
- Can relay commands back to pfSense

### Beacon Protocol

```json
POST /beacon
{
  "router_id": "home-pfsense",
  "timestamp": "2025-12-29T15:42:00Z",
  "state": "healthy",
  "score": 9,
  "interfaces": {
    "wan": {"status": "up", "ip": "98.2.1.45", "latency_ms": 12},
    "lan": {"status": "up", "ip": "192.168.1.1", "clients": 15}
  },
  "recent_events": [],
  "hmac": "..."
}
```

Payload: <2KB, designed for minimal bandwidth.

---

## MCP Tools

**EVERYTHING pfSense can do, exposed via MCP:**

### System

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_system_info` | Hostname, version, uptime, resources | read |
| `pf_system_status` | Overall health summary | read |
| `pf_system_reboot` | Reboot pfSense | dangerous |
| `pf_system_shutdown` | Shutdown pfSense | dangerous |
| `pf_system_config_backup` | Export config XML | read |

### Interfaces

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_interface_list` | All interfaces with status | read |
| `pf_interface_status` | Detailed status for one | read |
| `pf_interface_stats` | Traffic counters, errors | read |
| `pf_interface_restart` | Restart interface | service |
| `pf_interface_enable` | Enable interface | config |
| `pf_interface_disable` | Disable interface | config |

### Firewall

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_firewall_rules` | List rules (filter, nat, etc) | read |
| `pf_firewall_rule_add` | Add rule | config |
| `pf_firewall_rule_delete` | Delete rule | config |
| `pf_firewall_rule_modify` | Modify rule | config |
| `pf_firewall_states` | Connection state table | read |
| `pf_firewall_states_flush` | Clear state table | service |
| `pf_firewall_aliases` | Manage aliases | config |

### NAT

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_nat_rules` | Port forwards, outbound NAT | read |
| `pf_nat_rule_add` | Add NAT rule | config |
| `pf_nat_rule_delete` | Delete NAT rule | config |
| `pf_nat_rule_modify` | Modify NAT rule | config |

### DHCP

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_dhcp_leases` | Current leases | read |
| `pf_dhcp_static_mappings` | Reserved IPs | read |
| `pf_dhcp_config` | DHCP server config | config |
| `pf_dhcp_service_restart` | Restart DHCP | service |

### DNS

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_dns_resolver_config` | Unbound config | config |
| `pf_dns_forwarder_config` | dnsmasq config | config |
| `pf_dns_override_add` | Add host override | config |
| `pf_dns_override_delete` | Delete host override | config |
| `pf_dns_service_restart` | Restart DNS | service |

### VPN

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_vpn_openvpn_status` | OpenVPN connections | read |
| `pf_vpn_ipsec_status` | IPsec SAs | read |
| `pf_vpn_wireguard_status` | WireGuard peers | read |
| `pf_vpn_disconnect` | Disconnect client/tunnel | service |

### Routing

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_routes_table` | Routing table | read |
| `pf_routes_static` | Static routes | config |
| `pf_gateway_status` | Gateway health | read |
| `pf_gateway_switch` | Switch default gateway | config |

### Traffic

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_traffic_graphs` | Bandwidth graphs data | read |
| `pf_traffic_totals` | Interface totals | read |
| `pf_traffic_top` | Top talkers | read |

### Logs

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_logs_system` | System logs | read |
| `pf_logs_firewall` | Firewall logs | read |
| `pf_logs_dhcp` | DHCP logs | read |
| `pf_logs_vpn` | VPN logs | read |
| `pf_logs_search` | Search across all logs | read |

### Packages

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_packages_installed` | Installed packages | read |
| `pf_packages_available` | Available packages | read |
| `pf_packages_install` | Install package | dangerous |
| `pf_packages_remove` | Remove package | dangerous |

### Services

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_services_list` | All services status | read |
| `pf_services_start` | Start service | service |
| `pf_services_stop` | Stop service | service |
| `pf_services_restart` | Restart service | service |

### Diagnostics

| Tool | Description | Permission |
|------|-------------|------------|
| `pf_diag_ping` | Ping from pfSense | read |
| `pf_diag_traceroute` | Traceroute from pfSense | read |
| `pf_diag_dns_lookup` | DNS lookup from pfSense | read |
| `pf_diag_arp_table` | ARP table | read |
| `pf_diag_ndp_table` | IPv6 neighbor table | read |
| `pf_diag_sockets` | Open sockets | read |
| `pf_diag_pftop` | Real-time state table | read |

---

## Permission Matrix

**Granular control via pfSense WebGUI:**

### Permission Levels

| Level | Description |
|-------|-------------|
| `read` | View status, logs, configuration |
| `service` | Restart services, flush caches |
| `config` | Modify configuration |
| `dangerous` | Reboot, shutdown, package management |

### WebGUI Configuration

```
┌─────────────────────────────────────────────────────────────────┐
│ pfClaude > Settings > Permissions                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ MCP API Permissions                                             │
│ ─────────────────────────────────────────────────────────────── │
│                                                                 │
│ READ OPERATIONS                          [Select All] [Clear]   │
│ ☑ System info & status                                         │
│ ☑ Interface status & stats                                     │
│ ☑ Firewall rules (view)                                        │
│ ☑ DHCP leases                                                  │
│ ☑ Logs (all)                                                   │
│ ☑ Diagnostics (ping, traceroute, etc)                          │
│                                                                 │
│ SERVICE CONTROL                          [Select All] [Clear]   │
│ ☐ Restart interfaces                                           │
│ ☐ Restart services (DHCP, DNS, etc)                            │
│ ☐ Flush state table                                            │
│ ☐ Clear caches                                                 │
│                                                                 │
│ CONFIGURATION CHANGES                    [Select All] [Clear]   │
│ ☐ Modify firewall rules                                        │
│ ☐ Modify NAT rules                                             │
│ ☐ Modify DHCP settings                                         │
│ ☐ Add/remove static routes                                     │
│                                                                 │
│ DANGEROUS OPERATIONS                     [Select All] [Clear]   │
│ ☐ System reboot                                                │
│ ☐ System shutdown                                              │
│ ☐ Install/remove packages                                      │
│ ☐ Gateway failover                                             │
│                                                                 │
│ ─────────────────────────────────────────────────────────────── │
│ ☐ BYPASS ALL PERMISSIONS (danger mode)                         │
│                                                                 │
│                                    [Save] [Reset to Defaults]   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Storage & Hygiene

```json
{
  "storage": {
    "email_queue": {
      "max_messages": 100,
      "max_age_days": 10,
      "cleanup_schedule": "0 4 * * *"
    },
    "logs": {
      "pfclaude_events_days": 7,
      "diagnostic_snapshots_days": 3
    },
    "pattern_memory": {
      "persistent": true,
      "compact_schedule": "0 5 * * 0"
    },
    "total_footprint_mb": 50
  }
}
```

---

## Installation

### pfSense Package

```
System > Package Manager > Available Packages > pfClaude
```

Or manual:
```bash
pkg add https://github.com/ArktechNWA/pfclaude/releases/latest/pfclaude.pkg
```

### MCP Server (Claude Code side)

```bash
npm install -g @arktechnwa/pfclaude-mcp
```

### Claude Code Integration

```json
{
  "mcpServers": {
    "pfclaude": {
      "command": "pfclaude-mcp",
      "env": {
        "PFSENSE_HOST": "192.168.1.1",
        "PFSENSE_API_KEY": "your-api-key"
      }
    }
  }
}
```

---

## Requirements

### pfSense Side
- pfSense 2.7+ or pfSense Plus 23.09+
- 50MB free storage
- Network connectivity (obviously)

### Claude Code Side
- Node.js 18+
- Network access to pfSense

### Optional
- Anthropic API key (for Haiku batch analysis)
- SMTP server (for email notifications)
- Self-hosted beacon server (for cloud status)

---

## Security Considerations

1. **API key authentication** — No unauthenticated access
2. **HTTPS required** — Encrypted transport
3. **IP whitelist** — Restrict to known Claude IPs
4. **Rate limiting** — Prevent brute force
5. **Email PIN** — Authenticate inbound commands
6. **Permission matrix** — User controls exposure
7. **Audit logging** — All actions logged
8. **No default dangerous permissions** — User must enable

---

## Credits

Created by Claude (claude@arktechnwa.com) in collaboration with Meldrey.
Part of the [ArktechNWA MCP Toolshed](https://github.com/ArktechNWA).

Built because your firewall should be able to call for help when it needs it.
