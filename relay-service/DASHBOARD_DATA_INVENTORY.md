# pfSense Guardian Dashboard - Data Inventory

**Purpose**: Catalog ALL available data for uber-dashboard design.

---

## THE GAP

| What We Show | What We Have |
|--------------|--------------|
| 8 data points per device | 50+ fields in database |
| 30-point histograms | 100 metrics history + 5 RRD periods |
| Event summary only | Full raw_data JSON + Claude diagnostics |
| No command visibility | Pending commands queue with status |
| Static buttons | Control endpoints ready to wire |

---

## DATA SOURCES BY CATEGORY

### 1. REAL-TIME HEALTH (sub-second freshness)

| Metric | Source | Values | Insight |
|--------|--------|--------|---------|
| Circuit Breaker | NEVERHANG | closed/open/half_open | Service reliability |
| Failure Count | NEVERHANG | integer | Recent instability |
| Recovery Count | NEVERHANG | integer | Self-healing capacity |
| Success Rate 24h | A.L.A.N. | 0-100% | Overall reliability |
| Queries 24h | A.L.A.N. | integer | Usage volume |
| P95 Latency | A.L.A.N. | ms by complexity | Performance ceiling |

### 2. SYSTEM RESOURCES (5-minute refresh)

| Metric | Source | Values | Insight |
|--------|--------|--------|---------|
| CPU Usage | pf_system_status | 0-100% | Processing load |
| Memory Usage | pf_system_status | 0-100% | RAM pressure |
| Disk Usage | pf_system_status | 0-100% | Storage capacity |
| Uptime | pf_system_status | duration | Stability indicator |

### 3. NETWORK STATE (on-demand)

| Metric | Source | Values | Insight |
|--------|--------|--------|---------|
| Gateway Latency | pf_gateway_status | ms | WAN quality |
| Packet Loss | pf_gateway_status | 0-100% | Connection reliability |
| Active States | pf_firewall_states | count + details | Connection load |
| Interface Stats | pf_interface_status | bytes/packets/errors | Traffic analysis |
| DHCP Leases | pf_dhcp_leases | IP/MAC/hostname | Device inventory |
| ARP Table | pf_diag_arp | IP→MAC mappings | Network topology |

### 4. HISTORICAL TRENDS (RRD - 5 time windows)

| Metric | Periods Available | Data Points | Insight |
|--------|-------------------|-------------|---------|
| CPU | 1h, 4h, 1d, 1w, 1m | 60+ per period | Load patterns |
| Memory | 1h, 4h, 1d, 1w, 1m | 60+ per period | Memory trends |
| Traffic LAN | 1h, 4h, 1d, 1w, 1m | 60+ per period | Internal bandwidth |
| Traffic WAN | 1h, 4h, 1d, 1w, 1m | 60+ per period | External bandwidth |
| Firewall States | 1h, 4h, 1d, 1w, 1m | 60+ per period | Connection density |
| Gateway Quality | 1h, 4h, 1d, 1w, 1m | 60+ per period | WAN reliability |

### 5. EVENTS & INCIDENTS (24h rolling window)

| Field | Currently Shown | Available But Hidden |
|-------|-----------------|----------------------|
| Severity | ✅ color badge | - |
| Event Type | ✅ text | - |
| Summary | ✅ text | - |
| Timestamp | ✅ relative | absolute timestamp |
| Raw Data | ❌ | Full JSON context |
| Claude Diagnosis | ❌ | AI analysis + recommendations |
| Suggested Actions | ❌ | Actionable next steps |
| Diagnosis Duration | ❌ | AI response time |

### 6. COMMAND QUEUE (invisible to users)

| Field | Purpose |
|-------|---------|
| Command | What to execute |
| Source | Where it came from (email reply, manual) |
| Status | pending/executed |
| Result | Execution output |
| Created At | When queued |
| Executed At | When completed |

### 7. DEVICE METADATA

| Field | Currently Shown | Available |
|-------|-----------------|-----------|
| Name | ✅ | - |
| Token | ✅ (truncated) | full token |
| Last Seen | ✅ | - |
| Email | ❌ | registration email |
| Created At | ❌ | device age |
| Relay URL | ❌ | callback endpoint |

---

## COMPUTED INSIGHTS (derivable)

### Health Scores
- **Overall Health**: weighted(circuit_state, success_rate, latency_p95)
- **Capacity Headroom**: 100 - max(cpu, memory, disk)
- **Reliability Score**: success_rate × (1 - recent_failures/threshold)

### Trends
- **Load Trend**: CPU/Memory slope over last hour
- **Traffic Trend**: WAN bandwidth slope
- **Incident Frequency**: events per hour/day

### Anomalies
- **Resource Spike**: current > 2σ from historical mean
- **Latency Degradation**: p95 > baseline + threshold
- **Connection Surge**: states > normal × 2

---

## API ENDPOINTS (exist but unused)

```
GET /api/dashboard/status     ← Used (basic metrics)
GET /api/dashboard/rrd        ← EXISTS, NEVER CALLED (lists all RRD metrics)
GET /api/dashboard/rrd/:metric ← EXISTS, NEVER CALLED (full time-series)
```

---

## UI CONTROLS (exist but broken)

```html
<button data-action="ping">Ping</button>   <!-- No JS handler -->
<button data-action="diag">Diagnose</button> <!-- No JS handler -->
```

---

## WHAT AN UBER-DASHBOARD COULD SHOW

### Primary View: Device Health Overview
- Large health score indicator (computed)
- Circuit breaker state with visual indicator
- Resource gauges (CPU/MEM/DISK) with trend arrows
- Gateway quality badge

### Secondary View: Time-Series Explorer
- Period selector (1h/4h/1d/1w/1m)
- Multi-metric overlay charts
- Anomaly highlighting
- Zoom and pan

### Tertiary View: Event Timeline
- Severity-filtered event stream
- Expandable cards with raw_data
- Claude diagnosis inline
- Action buttons that work

### Quaternary View: Network Topology
- Device map from DHCP/ARP
- Connection flow from firewall states
- Traffic heatmap

### Control Panel
- Service restart buttons (wired)
- Ping diagnostic (wired)
- Command queue visibility
- Manual command injection

---

## DESIGN CONSTRAINTS

1. **Single Page**: All in dashboard.ts (server-rendered HTML)
2. **No Build Step**: Pure HTML/CSS/JS in template literal
3. **Auth Required**: Magic link + session cookie
4. **Multi-Device**: Must scale to N devices per user
5. **Mobile Responsive**: Current uses CSS grid, needs sidebar collapse

---

## REFERENCE: Database Tables

```sql
devices           -- Registration (persistent)
events            -- Incidents (24h TTL)
diagnostics       -- Claude analysis (24h TTL)
pending_commands  -- Command queue (24h TTL)
alert_history     -- Dedup tracking (24h TTL)
metrics           -- Live snapshots (last 100/device)
rrd_data          -- Historical trends (per metric/period)
dashboard_sessions -- Auth sessions (user-selected TTL)
```

---

*This inventory is the foundation for uber-dashboard design.*
