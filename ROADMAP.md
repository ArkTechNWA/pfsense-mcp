# pfclaude Roadmap

Two parallel tracks: the MCP server (Claude Code side) and the pfSense package.

---

## Track A: MCP Server (pfclaude-mcp)

### Phase A0: Foundation ✓
- [x] README.md with full spec
- [x] ROADMAP.md
- [ ] LICENSE, package.json, tsconfig
- [ ] Example configs

### Phase A1: Core API Client
- [ ] pfSense API client
- [ ] Authentication (API key, HTTPS)
- [ ] Basic connectivity test
- [ ] NEVERHANG timeouts

### Phase A2: Read Operations
- [ ] System info/status
- [ ] Interface list/status/stats
- [ ] Firewall rules (view)
- [ ] DHCP leases
- [ ] Logs (all types)
- [ ] Diagnostics (ping, traceroute, etc)

### Phase A3: Service Control
- [ ] Interface restart
- [ ] Service restart
- [ ] State table flush
- [ ] Cache clearing

### Phase A4: Configuration
- [ ] Firewall rule CRUD
- [ ] NAT rule CRUD
- [ ] DHCP configuration
- [ ] Static routes
- [ ] Gateway management

### Phase A5: Dangerous Operations
- [ ] System reboot/shutdown
- [ ] Package management
- [ ] Config backup/restore

### Phase A6: Polish
- [ ] Comprehensive error handling
- [ ] Test suite
- [ ] npm publish

---

## Track B: pfSense Package

### Phase B0: Package Skeleton
- [ ] pfSense package structure
- [ ] Menu integration
- [ ] Basic settings page
- [ ] Installation scripts

### Phase B1: API Server
- [ ] REST API endpoints
- [ ] API key authentication
- [ ] Rate limiting
- [ ] IP whitelist
- [ ] Lockout on failed auth

### Phase B2: Watchdog Daemon
- [ ] Health check framework
- [ ] Adaptive frequency
- [ ] CPU awareness
- [ ] State machine (healthy → concerned → degraded → emergency)

### Phase B3: Trigger System
- [ ] Tier 1: Basic monitoring
- [ ] Tier 2: Concern triggers
- [ ] Tier 3: Emergency triggers
- [ ] Configurable thresholds

### Phase B4: Autonomous Actions
- [ ] Action framework
- [ ] Permission checking
- [ ] Always-safe actions
- [ ] Diagnostic actions
- [ ] Restorative actions (gated)
- [ ] Failover actions (gated)
- [ ] Defensive actions (gated)

### Phase B5: Notifications
- [ ] Email (SMTP) outbound
- [ ] Pushover integration
- [ ] Webhook support
- [ ] Telegram bot
- [ ] Escalation levels

### Phase B6: Email Commands
- [ ] Email parsing daemon
- [ ] Command authentication (PIN, whitelist)
- [ ] Command execution
- [ ] Response generation

### Phase B7: Pattern Memory
- [ ] SQLite database
- [ ] Pattern learning
- [ ] Baseline tracking
- [ ] Recommendation engine

### Phase B8: Haiku Integration (optional)
- [ ] Batch job scheduler
- [ ] Log sanitization
- [ ] API integration
- [ ] Insight storage

### Phase B9: Cloud Beacon (optional)
- [ ] Beacon protocol
- [ ] Status publishing
- [ ] Command relay
- [ ] Docker image for self-hosted receiver

### Phase B10: WebGUI
- [ ] Settings page
- [ ] Permission matrix UI
- [ ] Status dashboard
- [ ] Log viewer
- [ ] Test tools

### Phase B11: Polish
- [ ] Documentation
- [ ] Package signing
- [ ] FreeBSD port submission
- [ ] pfSense package repo submission

---

## Version Targets

### MCP Server (@arktechnwa/pfclaude-mcp)

| Version | Phase | Description |
|---------|-------|-------------|
| 0.1.0 | A1-A2 | Read-only operations |
| 0.2.0 | A3 | Service control |
| 0.3.0 | A4 | Configuration |
| 0.4.0 | A5 | Dangerous operations |
| 1.0.0 | A6 | Production release |

### pfSense Package

| Version | Phase | Description |
|---------|-------|-------------|
| 0.1.0 | B0-B1 | API server only |
| 0.2.0 | B2-B3 | Watchdog + triggers |
| 0.3.0 | B4 | Autonomous actions |
| 0.4.0 | B5-B6 | Notifications + email commands |
| 0.5.0 | B7 | Pattern memory |
| 0.6.0 | B8-B9 | Haiku + cloud beacon |
| 0.7.0 | B10 | Full WebGUI |
| 1.0.0 | B11 | Production release |

---

## Current Focus

**Phase A0 + B0** — Foundation and scaffolding.

This is the most ambitious project in the toolshed. Two codebases, two languages (TypeScript + PHP), two deployment targets. But also the most interesting.
