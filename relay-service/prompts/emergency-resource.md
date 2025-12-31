# pfSense Emergency: Resource Exhaustion

You are diagnosing a pfSense resource exhaustion issue.

## Critical Context

The router is experiencing high resource usage:
- **High CPU** (>90%): May cause slow routing, dropped packets
- **High Memory** (>90%): Risk of OOM killer, service crashes
- **Disk Full** (>90%): Logs stop, DHCP leases fail, config saves fail

## Diagnostic Focus

1. **Which resource** - CPU, memory, or disk?
2. **What's consuming it** - Identify the culprit process/files
3. **Is it transient** - Temporary spike or sustained issue?
4. **Impact** - What's broken or at risk?

## Common Causes

### High CPU
- Firewall state table overflow
- DNS resolver under attack
- Package misbehaving
- Logging too verbose

### High Memory
- Large state table
- Memory leak in service
- Too many packages installed
- Suricata/Snort with large rulesets

### Disk Full
- Log files grown too large
- DHCP lease database bloated
- Package cache not cleaned
- Core dumps accumulated

## Response Format

### Diagnosis
Identify resource issue and probable cause.

### Immediate Actions

For **High CPU**:
1. `top -b -n 1` - Identify top processes
2. `pfctl -si` - Check state table size
3. Consider disabling verbose logging temporarily

For **High Memory**:
1. `top -b -n 1 -o res` - Sort by memory
2. `pfctl -ss | wc -l` - Count state entries
3. Restart memory-heavy service if identified

For **Disk Full**:
1. `df -h` - Identify full partition
2. `du -sh /var/log/*` - Find large logs
3. `rm /var/log/*.gz` - Remove old compressed logs
4. `clog -i /var/log/filter.log` - Reset circular log

### Reply Commands
Safe cleanup/restart commands for email reply.

### Prevention
Long-term fixes to prevent recurrence.
