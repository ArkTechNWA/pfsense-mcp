#!/bin/sh
#
# pfSense Guardian v2 - Manifest-Driven Data Push
#
# Pushes pfSense data to relay based on manifest configuration.
# MCP clients query relay instead of pfSense directly.
#
# Architecture:
#   Guardian → pushes hot/warm data → Relay ← queries ← MCP clients
#
# Installation:
#   1. Copy to /usr/local/bin/pfsense-guardian
#   2. chmod +x /usr/local/bin/pfsense-guardian
#   3. Configure /usr/local/etc/pfsense-guardian/config
#   4. Add to cron:
#      * * * * * /usr/local/bin/pfsense-guardian push-hot
#      */5 * * * * /usr/local/bin/pfsense-guardian push-warm
#
# The manifest tells Guardian what to collect and at what interval.
# A.L.A.N. on the relay learns query patterns and adjusts the manifest.
#

set -e

# Configuration
CONFIG_DIR="/usr/local/etc/pfsense-guardian"
CONFIG_FILE="${CONFIG_DIR}/config"
TOKEN_FILE="${CONFIG_DIR}/token"
MANIFEST_FILE="${CONFIG_DIR}/manifest.json"
LOG_FILE="/var/log/pfsense-guardian.log"
VERSION="2.0.0"

# Defaults
RELAY_URL="${RELAY_URL:-https://pfsense-mcp.arktechnwa.com}"

# Load configuration
load_config() {
    if [ -f "$CONFIG_FILE" ]; then
        . "$CONFIG_FILE"
    fi

    if [ -f "$TOKEN_FILE" ]; then
        DEVICE_TOKEN=$(cat "$TOKEN_FILE")
    fi

    if [ -z "$DEVICE_TOKEN" ]; then
        echo "Error: No device token. Run: pfsense-guardian init" >&2
        exit 1
    fi
}

# Generate device token
generate_token() {
    openssl rand -hex 32
}

# Sign a payload with HMAC
sign_payload() {
    local payload="$1"
    local timestamp="$2"
    echo -n "${payload}${timestamp}" | openssl dgst -sha256 -hmac "$DEVICE_TOKEN" | awk '{print $2}'
}

# Log message
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [Guardian] $1" >> "$LOG_FILE"
}

# =============================================================================
# DATA COLLECTION FUNCTIONS
# =============================================================================

# Collect system status (hot data)
collect_system() {
    local uptime_raw=$(sysctl -n kern.boottime 2>/dev/null | sed 's/.*sec = \([0-9]*\).*/\1/')
    local uptime_seconds=$(($(date +%s) - ${uptime_raw:-0}))
    local uptime_human=$(uptime | awk -F'up ' '{print $2}' | awk -F',' '{print $1}')

    local platform=$(uname -m)
    local version=$(cat /etc/version 2>/dev/null || uname -r)

    # CPU info
    local cpu_model=$(sysctl -n hw.model 2>/dev/null | tr -d '\n')
    local cpu_count=$(sysctl -n hw.ncpu 2>/dev/null || echo "1")
    local cpu_usage=$(top -b -n 1 2>/dev/null | grep "CPU:" | awk '{print int($2)}' || echo "0")
    local load_avg=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2","$3","$4}' || echo "0,0,0")
    local cpu_temp=$(sysctl -n dev.cpu.0.temperature 2>/dev/null | tr -d 'C' || echo "null")

    # Memory info
    local page_size=$(sysctl -n hw.pagesize 2>/dev/null || echo "4096")
    local mem_active=$(sysctl -n vm.stats.vm.v_active_count 2>/dev/null || echo "0")
    local mem_total=$(sysctl -n hw.physmem 2>/dev/null || echo "1")
    local mem_used=$((mem_active * page_size))
    local mem_total_mb=$((mem_total / 1024 / 1024))
    local mem_used_mb=$((mem_used / 1024 / 1024))
    local mem_pct=$((mem_used * 100 / mem_total))

    # Disk info
    local disk_info=$(df -h / | tail -1)
    local disk_total=$(echo "$disk_info" | awk '{gsub(/G/,"",$2); print $2}')
    local disk_used=$(echo "$disk_info" | awk '{gsub(/G/,"",$3); print $3}')
    local disk_pct=$(echo "$disk_info" | awk '{gsub(/%/,"",$5); print $5}')

    cat <<EOF
{
    "uptime": "$uptime_human",
    "uptime_seconds": $uptime_seconds,
    "platform": "$platform",
    "version": "$version",
    "cpu": {
        "model": "$cpu_model",
        "count": $cpu_count,
        "usage_percent": $cpu_usage,
        "load_avg": [$load_avg],
        "temperature_c": $cpu_temp
    },
    "memory": {
        "usage_percent": $mem_pct,
        "total_mb": $mem_total_mb,
        "used_mb": $mem_used_mb
    },
    "disk": {
        "usage_percent": $disk_pct,
        "total_gb": ${disk_total:-0},
        "used_gb": ${disk_used:-0}
    }
}
EOF
}

# Collect gateway status (hot data)
collect_gateways() {
    # Use pfSense's gateway status
    local gw_json="["
    local first=true

    # Try to get gateway status from dpinger
    for gw_file in /var/db/rrd/*-quality.rrd 2>/dev/null; do
        if [ -f "$gw_file" ]; then
            local gw_name=$(basename "$gw_file" | sed 's/-quality.rrd//')
            local status="online"
            local latency="null"
            local loss="0"

            # Check if gateway is responding
            local monitor_ip=$(pfctl -ss 2>/dev/null | grep -m1 "dpinger.*$gw_name" | awk '{print $5}' | cut -d: -f1 || echo "")

            if [ -n "$monitor_ip" ]; then
                # Ping test
                if ping -c 1 -t 2 "$monitor_ip" >/dev/null 2>&1; then
                    latency=$(ping -c 3 -t 3 "$monitor_ip" 2>/dev/null | tail -1 | awk -F'/' '{print $5}' || echo "null")
                else
                    status="offline"
                fi
            fi

            if [ "$first" = true ]; then
                first=false
            else
                gw_json="${gw_json},"
            fi

            gw_json="${gw_json}{\"name\":\"$gw_name\",\"status\":\"$status\",\"latency_ms\":$latency,\"loss_percent\":$loss,\"monitor_ip\":\"$monitor_ip\"}"
        fi
    done

    # Fallback: basic gateway check
    if [ "$first" = true ]; then
        local wan_ip=$(ifconfig wan 2>/dev/null | grep "inet " | awk '{print $2}' || echo "")
        local status="online"
        if ! ping -c 1 -t 3 8.8.8.8 >/dev/null 2>&1; then
            status="offline"
        fi
        gw_json="${gw_json}{\"name\":\"WAN_DHCP\",\"status\":\"$status\",\"latency_ms\":null,\"loss_percent\":0,\"monitor_ip\":\"8.8.8.8\"}"
    fi

    echo "${gw_json}]"
}

# Collect interface data (hot data)
collect_interfaces() {
    local json="{"
    local first=true

    for iface in $(ifconfig -l | tr ' ' '\n' | grep -v "lo0\|pflog\|pfsync\|enc\|gif\|gre"); do
        local info=$(ifconfig "$iface" 2>/dev/null)
        if [ -z "$info" ]; then continue; fi

        local friendly_name="$iface"
        local status="down"
        echo "$info" | grep -q "status: active\|UP" && status="up"

        local ip_addr=$(echo "$info" | grep "inet " | head -1 | awk '{print $2}' || echo "null")
        [ -z "$ip_addr" ] && ip_addr="null" || ip_addr="\"$ip_addr\""

        local mac_addr=$(echo "$info" | grep "ether " | awk '{print $2}' || echo "00:00:00:00:00:00")

        # Traffic stats from netstat
        local stats=$(netstat -ibnd -I "$iface" 2>/dev/null | tail -1)
        local in_bytes=$(echo "$stats" | awk '{print $7}' || echo "0")
        local out_bytes=$(echo "$stats" | awk '{print $10}' || echo "0")
        local in_packets=$(echo "$stats" | awk '{print $5}' || echo "0")
        local out_packets=$(echo "$stats" | awk '{print $8}' || echo "0")
        local in_errors=$(echo "$stats" | awk '{print $6}' || echo "0")
        local out_errors=$(echo "$stats" | awk '{print $9}' || echo "0")

        # Speed detection
        local speed="null"
        local media=$(echo "$info" | grep "media:" | head -1)
        echo "$media" | grep -q "1000" && speed="1000"
        echo "$media" | grep -q "100baseT" && speed="100"
        echo "$media" | grep -q "10baseT" && speed="10"
        echo "$media" | grep -q "10Gbase" && speed="10000"

        if [ "$first" = true ]; then
            first=false
        else
            json="${json},"
        fi

        json="${json}\"$iface\":{\"name\":\"$iface\",\"friendly_name\":\"$friendly_name\",\"status\":\"$status\",\"ip_address\":$ip_addr,\"mac_address\":\"$mac_addr\",\"in_bytes\":${in_bytes:-0},\"out_bytes\":${out_bytes:-0},\"in_packets\":${in_packets:-0},\"out_packets\":${out_packets:-0},\"in_errors\":${in_errors:-0},\"out_errors\":${out_errors:-0},\"speed_mbps\":$speed}"
    done

    echo "${json}}"
}

# Collect services (warm data)
collect_services() {
    local json="["
    local first=true

    # Key pfSense services
    for svc in unbound dhcpd ntpd dpinger sshd nginx php-fpm; do
        local running="false"
        local enabled="true"
        pgrep -f "$svc" >/dev/null 2>&1 && running="true"

        local desc=""
        case "$svc" in
            unbound) desc="DNS Resolver" ;;
            dhcpd) desc="DHCP Server" ;;
            ntpd) desc="NTP Server" ;;
            dpinger) desc="Gateway Monitor" ;;
            sshd) desc="SSH Server" ;;
            nginx) desc="Web Server" ;;
            php-fpm) desc="PHP FastCGI" ;;
            *) desc="$svc" ;;
        esac

        if [ "$first" = true ]; then
            first=false
        else
            json="${json},"
        fi

        local status="stopped"
        [ "$running" = "true" ] && status="running"

        json="${json}{\"name\":\"$svc\",\"description\":\"$desc\",\"status\":\"$status\",\"enabled\":$enabled}"
    done

    echo "${json}]"
}

# Collect DHCP leases (warm data)
collect_dhcp_leases() {
    local lease_file="/var/dhcpd/var/db/dhcpd.leases"
    local json="["
    local first=true

    if [ -f "$lease_file" ]; then
        # Parse lease file
        local current_ip=""
        local current_mac=""
        local current_hostname=""
        local current_start=""
        local current_end=""

        while IFS= read -r line; do
            case "$line" in
                "lease "*)
                    current_ip=$(echo "$line" | awk '{print $2}')
                    ;;
                *"hardware ethernet"*)
                    current_mac=$(echo "$line" | awk '{print $3}' | tr -d ';')
                    ;;
                *"client-hostname"*)
                    current_hostname=$(echo "$line" | sed 's/.*"\(.*\)".*/\1/')
                    ;;
                *"starts "*)
                    current_start=$(echo "$line" | awk '{print $3" "$4}' | tr -d ';')
                    ;;
                *"ends "*)
                    current_end=$(echo "$line" | awk '{print $3" "$4}' | tr -d ';')
                    ;;
                "}")
                    if [ -n "$current_ip" ] && [ -n "$current_mac" ]; then
                        if [ "$first" = true ]; then
                            first=false
                        else
                            json="${json},"
                        fi

                        local hostname_json="null"
                        [ -n "$current_hostname" ] && hostname_json="\"$current_hostname\""

                        json="${json}{\"ip\":\"$current_ip\",\"mac\":\"$current_mac\",\"hostname\":$hostname_json,\"start\":\"$current_start\",\"end\":\"$current_end\",\"status\":\"active\"}"
                    fi
                    current_ip=""
                    current_mac=""
                    current_hostname=""
                    current_start=""
                    current_end=""
                    ;;
            esac
        done < "$lease_file"
    fi

    echo "${json}]"
}

# Collect ARP table (warm data)
collect_arp_table() {
    local json="["
    local first=true

    arp -an 2>/dev/null | while read -r line; do
        local ip=$(echo "$line" | grep -o '([^)]*)'  | tr -d '()')
        local mac=$(echo "$line" | awk '{print $4}')
        local iface=$(echo "$line" | awk '{print $NF}')

        if [ -n "$ip" ] && [ -n "$mac" ] && [ "$mac" != "(incomplete)" ]; then
            if [ "$first" = true ]; then
                first=false
                echo -n "{"
            else
                echo -n ",{"
            fi
            echo -n "\"ip\":\"$ip\",\"mac\":\"$mac\",\"interface\":\"$iface\",\"hostname\":null}"
        fi
    done

    # Wrap in array if empty
    local result=$(arp -an 2>/dev/null | grep -v incomplete | head -50 | while read -r line; do
        local ip=$(echo "$line" | grep -o '([^)]*)'  | tr -d '()')
        local mac=$(echo "$line" | awk '{print $4}')
        local iface=$(echo "$line" | awk '{print $NF}')

        if [ -n "$ip" ] && [ -n "$mac" ]; then
            echo "{\"ip\":\"$ip\",\"mac\":\"$mac\",\"interface\":\"$iface\",\"hostname\":null}"
        fi
    done | paste -sd, -)

    echo "[${result}]"
}

# =============================================================================
# PUSH FUNCTIONS
# =============================================================================

# Send push to relay
send_push() {
    local payload="$1"
    local timestamp=$(date +%s)000
    local signature=$(sign_payload "$payload" "$timestamp")

    curl -s -X POST "${RELAY_URL}/api/v2/push" \
        -H "Content-Type: application/json" \
        -H "X-Device-Token: ${DEVICE_TOKEN}" \
        -H "X-Timestamp: ${timestamp}" \
        -H "X-Signature: ${signature}" \
        -d "$payload"
}

# Fetch manifest from relay
fetch_manifest() {
    local response=$(curl -s -H "X-Device-Token: ${DEVICE_TOKEN}" "${RELAY_URL}/api/v2/manifest")

    if echo "$response" | grep -q '"manifest"'; then
        echo "$response" | jq '.manifest' > "$MANIFEST_FILE" 2>/dev/null
        log "Manifest updated: $(cat "$MANIFEST_FILE" | jq -c '.version' 2>/dev/null)"

        # Process any pending commands
        local pending=$(echo "$response" | jq -r '.pending_commands // []')
        if [ "$pending" != "[]" ] && [ "$pending" != "null" ]; then
            process_commands "$pending"
        fi
    else
        log "Failed to fetch manifest: $response"
    fi
}

# Process pending commands from the relay
process_commands() {
    local commands="$1"
    local count=$(echo "$commands" | jq 'length')

    if [ "$count" -gt 0 ]; then
        log "Processing $count pending commands..."

        echo "$commands" | jq -c '.[]' | while read -r cmd; do
            local id=$(echo "$cmd" | jq -r '.id')
            local tool=$(echo "$cmd" | jq -r '.tool')
            local params=$(echo "$cmd" | jq -r '.params // {}')

            log "Executing command $id: $tool"
            execute_command "$id" "$tool" "$params"
        done
    fi
}

# Execute a single command
execute_command() {
    local cmd_id="$1"
    local tool="$2"
    local params="$3"

    local success="false"
    local result=""
    local error=""

    # Parse tool JSON if it's a JSON string
    if echo "$tool" | grep -q '^{'; then
        params=$(echo "$tool" | jq -r '.params // {}')
        tool=$(echo "$tool" | jq -r '.tool')
    fi

    case "$tool" in
        pf_service_start)
            local service=$(echo "$params" | jq -r '.service // empty')
            if [ -n "$service" ]; then
                log "Starting service: $service"
                if /usr/local/sbin/pfSsh.php playback svc start "$service" 2>/dev/null; then
                    success="true"
                    result="Service $service started"
                else
                    error="Failed to start service $service"
                fi
            else
                error="Missing service parameter"
            fi
            ;;

        pf_service_stop)
            local service=$(echo "$params" | jq -r '.service // empty')
            if [ -n "$service" ]; then
                log "Stopping service: $service"
                if /usr/local/sbin/pfSsh.php playback svc stop "$service" 2>/dev/null; then
                    success="true"
                    result="Service $service stopped"
                else
                    error="Failed to stop service $service"
                fi
            else
                error="Missing service parameter"
            fi
            ;;

        pf_service_restart)
            local service=$(echo "$params" | jq -r '.service // empty')
            if [ -n "$service" ]; then
                log "Restarting service: $service"
                if /usr/local/sbin/pfSsh.php playback svc restart "$service" 2>/dev/null; then
                    success="true"
                    result="Service $service restarted"
                else
                    error="Failed to restart service $service"
                fi
            else
                error="Missing service parameter"
            fi
            ;;

        pf_diag_ping)
            local host=$(echo "$params" | jq -r '.host // empty')
            local count=$(echo "$params" | jq -r '.count // 3')
            if [ -n "$host" ]; then
                log "Pinging: $host (count: $count)"
                result=$(ping -c "$count" "$host" 2>&1)
                if [ $? -eq 0 ]; then
                    success="true"
                else
                    error="Ping failed"
                fi
            else
                error="Missing host parameter"
            fi
            ;;

        *)
            error="Unknown tool: $tool"
            ;;
    esac

    # Report result back to relay
    report_command_result "$cmd_id" "$success" "$result" "$error"
}

# Report command execution result to relay
report_command_result() {
    local cmd_id="$1"
    local success="$2"
    local result="$3"
    local error="$4"

    # Escape result for JSON
    result=$(echo "$result" | jq -Rs '.')
    error=$(echo "$error" | jq -Rs '.')

    local payload=$(cat <<EOF
{
    "success": $success,
    "result": $result,
    "error": $error
}
EOF
)

    local response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "X-Device-Token: ${DEVICE_TOKEN}" \
        "${RELAY_URL}/api/v2/command/${cmd_id}/result" \
        -d "$payload")

    if echo "$response" | grep -q '"success":true'; then
        log "Command $cmd_id result reported successfully"
    else
        log "Failed to report command $cmd_id result: $response"
    fi
}

# Push hot data (system, gateways, interfaces)
push_hot() {
    load_config

    log "Collecting hot data..."

    local system=$(collect_system)
    local gateways=$(collect_gateways)
    local interfaces=$(collect_interfaces)

    local payload=$(cat <<EOF
{
    "hot": {
        "system": $system,
        "gateways": $gateways,
        "interfaces": $interfaces
    },
    "meta": {
        "timestamp": $(date +%s)000,
        "manifest_version": "1.0.0",
        "guardian_version": "$VERSION",
        "push_type": "hot"
    }
}
EOF
)

    log "Pushing hot data..."
    local result=$(send_push "$payload")

    if echo "$result" | grep -q '"success":true'; then
        log "Hot push successful"
    else
        log "Hot push failed: $result"
    fi
}

# Push warm data (services, DHCP, ARP)
push_warm() {
    load_config

    log "Collecting warm data..."

    local services=$(collect_services)
    local dhcp=$(collect_dhcp_leases)
    local arp=$(collect_arp_table)

    local payload=$(cat <<EOF
{
    "warm": {
        "services": $services,
        "dhcp_leases": $dhcp,
        "arp_table": $arp
    },
    "meta": {
        "timestamp": $(date +%s)000,
        "manifest_version": "1.0.0",
        "guardian_version": "$VERSION",
        "push_type": "warm"
    }
}
EOF
)

    log "Pushing warm data..."
    local result=$(send_push "$payload")

    if echo "$result" | grep -q '"success":true'; then
        log "Warm push successful"
    else
        log "Warm push failed: $result"
    fi
}

# Push both hot and warm data
push_full() {
    push_hot
    push_warm
}

# =============================================================================
# INITIALIZATION
# =============================================================================

init_device() {
    mkdir -p "$CONFIG_DIR"

    if [ -f "$TOKEN_FILE" ]; then
        echo "Device already initialized. Token: $(cat "$TOKEN_FILE" | head -c 16)..."
        echo "To re-initialize, delete $TOKEN_FILE"
        exit 0
    fi

    DEVICE_TOKEN=$(generate_token)
    echo "$DEVICE_TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"

    cat > "$CONFIG_FILE" <<EOF
# pfSense Guardian v2 Configuration
RELAY_URL="${RELAY_URL}"
EOF

    echo "Guardian v2 initialized!"
    echo "Token: $DEVICE_TOKEN"
    echo ""
    echo "Next steps:"
    echo "  1. Register at: ${RELAY_URL}/register"
    echo "  2. Add cron jobs:"
    echo "     * * * * * /usr/local/bin/pfsense-guardian push-hot"
    echo "     */5 * * * * /usr/local/bin/pfsense-guardian push-warm"
    echo ""
    echo "Token saved to: $TOKEN_FILE"
}

# Test relay connection
test_relay() {
    load_config

    echo "Testing connection to: $RELAY_URL"

    local response=$(curl -s "${RELAY_URL}/api/v2/health")
    if echo "$response" | grep -q '"status":"ok"'; then
        echo "Relay Guardian v2 API is healthy!"
        echo "$response" | jq '.' 2>/dev/null || echo "$response"
    else
        echo "Failed to connect to relay"
        exit 1
    fi
}

# Show status
show_status() {
    load_config

    echo "Guardian v2 Status"
    echo "=================="
    echo "Device Token: ${DEVICE_TOKEN:0:16}..."
    echo "Relay URL: $RELAY_URL"
    echo "Version: $VERSION"
    echo ""
    echo "Hot Data Preview:"
    echo "  System: $(collect_system | jq -c '{cpu: .cpu.usage_percent, mem: .memory.usage_percent, disk: .disk.usage_percent}')"
    echo "  Gateways: $(collect_gateways | jq -c 'length') gateways"
    echo "  Interfaces: $(collect_interfaces | jq -c 'keys | length') interfaces"
    echo ""
    echo "Warm Data Preview:"
    echo "  Services: $(collect_services | jq -c '[.[] | select(.status=="running")] | length') running"
    echo "  DHCP Leases: $(collect_dhcp_leases | jq -c 'length') leases"
    echo "  ARP Entries: $(collect_arp_table | jq -c 'length') entries"
}

# Show usage
usage() {
    cat <<EOF
pfSense Guardian v2 - Manifest-Driven Data Push

Usage: pfsense-guardian <command>

Commands:
    init        Initialize device (generate token)
    push-hot    Push hot data (system, gateways, interfaces) - run every minute
    push-warm   Push warm data (services, DHCP, ARP) - run every 5 minutes
    push-full   Push all data (hot + warm)
    fetch       Fetch latest manifest from relay
    test        Test connection to relay
    status      Show current status and data preview
    help        Show this help

Cron Setup:
    * * * * * /usr/local/bin/pfsense-guardian push-hot
    */5 * * * * /usr/local/bin/pfsense-guardian push-warm

Configuration:
    $CONFIG_FILE

Logs:
    $LOG_FILE
EOF
}

# Main
case "${1:-help}" in
    init)
        init_device
        ;;
    push-hot)
        push_hot
        ;;
    push-warm)
        push_warm
        ;;
    push-full|push)
        push_full
        ;;
    fetch)
        load_config
        fetch_manifest
        ;;
    test)
        test_relay
        ;;
    status)
        show_status
        ;;
    help|--help|-h)
        usage
        ;;
    *)
        echo "Unknown command: $1"
        usage
        exit 1
        ;;
esac
