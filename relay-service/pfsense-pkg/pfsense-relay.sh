#!/bin/sh
#
# pfSense Emergency Relay Client
#
# Tiny script that runs on pfSense to:
# 1. Detect network emergencies (LAN down, WAN up)
# 2. Send webhooks to the relay service
# 3. Check in for pending commands
# 4. Execute approved commands
#
# Installation:
#   1. Copy to /usr/local/bin/pfsense-relay
#   2. chmod +x /usr/local/bin/pfsense-relay
#   3. Configure /usr/local/etc/pfsense-relay/config
#   4. Add to cron: */5 * * * * /usr/local/bin/pfsense-relay check
#

set -e

# Configuration
CONFIG_DIR="/usr/local/etc/pfsense-relay"
CONFIG_FILE="${CONFIG_DIR}/config"
TOKEN_FILE="${CONFIG_DIR}/token"
LOG_FILE="/var/log/pfsense-relay.log"

# Defaults
RELAY_URL="${RELAY_URL:-https://pfsense-mcp.arktechnwa.com}"
CHECK_INTERVAL=300  # 5 minutes

# Load configuration
load_config() {
    if [ -f "$CONFIG_FILE" ]; then
        . "$CONFIG_FILE"
    fi

    if [ -f "$TOKEN_FILE" ]; then
        DEVICE_TOKEN=$(cat "$TOKEN_FILE")
    fi

    if [ -z "$DEVICE_TOKEN" ]; then
        echo "Error: No device token. Run: pfsense-relay init" >&2
        exit 1
    fi
}

# Generate device token
generate_token() {
    # Use OpenSSL to generate a secure random token
    openssl rand -hex 32
}

# Sign a payload with HMAC
sign_payload() {
    local payload="$1"
    local timestamp="$2"
    echo -n "${payload}${timestamp}" | openssl dgst -sha256 -hmac "$DEVICE_TOKEN" | awk '{print $2}'
}

# Send webhook to relay
send_webhook() {
    local endpoint="$1"
    local payload="$2"
    local timestamp=$(date +%s)000  # Milliseconds
    local signature=$(sign_payload "$payload" "$timestamp")

    curl -s -X POST "${RELAY_URL}${endpoint}" \
        -H "Content-Type: application/json" \
        -H "X-Device-Token: ${DEVICE_TOKEN}" \
        -H "X-Timestamp: ${timestamp}" \
        -H "X-Signature: ${signature}" \
        -d "$payload"
}

# Log message
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

# Check interface status
check_interface() {
    local iface="$1"
    ifconfig "$iface" 2>/dev/null | grep -q "status: active"
}

# Get interface IP
get_interface_ip() {
    local iface="$1"
    ifconfig "$iface" 2>/dev/null | grep "inet " | awk '{print $2}'
}

# Check if WAN has connectivity
check_wan_connectivity() {
    # Try to ping common DNS servers
    ping -c 1 -t 3 8.8.8.8 >/dev/null 2>&1 || \
    ping -c 1 -t 3 1.1.1.1 >/dev/null 2>&1
}

# Check LAN status
check_lan_status() {
    local lan_iface=$(pfctl -sr 2>/dev/null | grep -m1 "on em1\|on igb1\|on re1" | awk '{print $NF}' || echo "em1")

    # Check if LAN interface is up
    if ! check_interface "$lan_iface"; then
        echo "down"
        return
    fi

    # Check if DHCP server is running
    if ! pgrep -f dhcpd >/dev/null 2>&1; then
        echo "dhcp_down"
        return
    fi

    echo "up"
}

# Detect emergencies
detect_emergencies() {
    local emergencies=""

    # Check WAN connectivity
    if ! check_wan_connectivity; then
        emergencies="${emergencies}wan_down,"
    fi

    # Check LAN status
    local lan_status=$(check_lan_status)
    case "$lan_status" in
        down)
            emergencies="${emergencies}lan_down,"
            ;;
        dhcp_down)
            emergencies="${emergencies}dhcp_down,"
            ;;
    esac

    # Check for high CPU
    local cpu_usage=$(top -b -n 1 | grep "CPU:" | awk '{print int($2)}' 2>/dev/null || echo "0")
    if [ "$cpu_usage" -gt 90 ]; then
        emergencies="${emergencies}high_cpu,"
    fi

    # Check for high memory
    local mem_used=$(sysctl -n vm.stats.vm.v_active_count 2>/dev/null || echo "0")
    local mem_total=$(sysctl -n vm.stats.vm.v_page_count 2>/dev/null || echo "1")
    local mem_pct=$((mem_used * 100 / mem_total))
    if [ "$mem_pct" -gt 90 ]; then
        emergencies="${emergencies}high_memory,"
    fi

    # Check for disk space
    local disk_pct=$(df -h / | tail -1 | awk '{print int($5)}')
    if [ "$disk_pct" -gt 90 ]; then
        emergencies="${emergencies}disk_full,"
    fi

    # Trim trailing comma
    echo "$emergencies" | sed 's/,$//'
}

# Build context payload
build_context() {
    local wan_ip=$(get_interface_ip "wan" 2>/dev/null || echo "unknown")
    local lan_ip=$(get_interface_ip "lan" 2>/dev/null || echo "unknown")
    local uptime=$(uptime | awk -F'up ' '{print $2}' | awk -F',' '{print $1}')
    local hostname=$(hostname)
    local version=$(cat /etc/version 2>/dev/null || echo "unknown")

    cat <<EOF
{
    "hostname": "$hostname",
    "version": "$version",
    "uptime": "$uptime",
    "wan_ip": "$wan_ip",
    "lan_ip": "$lan_ip",
    "interfaces": $(ifconfig -l | tr ' ' '\n' | grep -v "lo0\|pflog\|pfsync" | head -5 | xargs -I{} sh -c 'echo "{}: $(ifconfig {} 2>/dev/null | grep -q "status: active" && echo up || echo down)"' | jq -Rs 'split("\n") | map(select(length > 0)) | map(split(": ") | {(.[0]): .[1]}) | add' 2>/dev/null || echo "{}"),
    "services": {
        "dhcpd": $(pgrep -f dhcpd >/dev/null && echo "true" || echo "false"),
        "unbound": $(pgrep -f unbound >/dev/null && echo "true" || echo "false"),
        "sshd": $(pgrep -f sshd >/dev/null && echo "true" || echo "false")
    }
}
EOF
}

# Send emergency alert
send_emergency() {
    local event_type="$1"
    local summary="$2"
    local severity="${3:-warning}"

    local context=$(build_context)
    local payload=$(cat <<EOF
{
    "type": "$event_type",
    "severity": "$severity",
    "summary": "$summary",
    "context": $context
}
EOF
)

    log "Sending emergency: $event_type - $summary"
    result=$(send_webhook "/emergency" "$payload")
    log "Relay response: $result"
}

# Check in with relay for commands
checkin() {
    load_config

    local payload='{"results": []}'
    local response=$(send_webhook "/checkin" "$payload")

    if echo "$response" | grep -q '"commands"'; then
        # Parse and execute commands
        echo "$response" | jq -r '.commands[]? | "\(.id)|\(.command)"' 2>/dev/null | while IFS='|' read -r id cmd; do
            if [ -n "$id" ] && [ -n "$cmd" ]; then
                log "Executing command $id: $cmd"
                execute_command "$id" "$cmd"
            fi
        done
    fi
}

# Execute a command from the relay
execute_command() {
    local cmd_id="$1"
    local cmd="$2"
    local result=""

    case "$cmd" in
        "restart dhcp"|"restart dhcpd")
            result=$(/etc/rc.d/dhcpd restart 2>&1)
            ;;
        "restart dns"|"restart unbound")
            result=$(/etc/rc.d/unbound restart 2>&1)
            ;;
        "status")
            result=$(build_context)
            ;;
        "help")
            result="Available commands: restart dhcp, restart dns, status, help"
            ;;
        *)
            result="Unknown command: $cmd"
            ;;
    esac

    # Report result back
    local payload=$(cat <<EOF
{
    "type": "command_result",
    "data": {
        "id": $cmd_id,
        "command": "$cmd",
        "result": $(echo "$result" | jq -Rs '.')
    }
}
EOF
)
    send_webhook "/report" "$payload"
}

# Initialize device
init_device() {
    mkdir -p "$CONFIG_DIR"

    if [ -f "$TOKEN_FILE" ]; then
        echo "Device already initialized. Token: $(cat "$TOKEN_FILE" | head -c 16)..."
        echo "To re-initialize, delete $TOKEN_FILE"
        exit 0
    fi

    # Generate token
    DEVICE_TOKEN=$(generate_token)
    echo "$DEVICE_TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"

    # Create default config
    cat > "$CONFIG_FILE" <<EOF
# pfSense Relay Configuration
RELAY_URL="${RELAY_URL}"
CHECK_INTERVAL=300
EOF

    echo "Device initialized!"
    echo "Token: $DEVICE_TOKEN"
    echo ""
    echo "Next steps:"
    echo "  1. Register at: ${RELAY_URL}/register"
    echo "  2. Add cron job: */5 * * * * /usr/local/bin/pfsense-relay check"
    echo ""
    echo "Token saved to: $TOKEN_FILE"
}

# Main check routine
check() {
    load_config

    local emergencies=$(detect_emergencies)

    if [ -n "$emergencies" ]; then
        # Send emergency for each detected issue
        echo "$emergencies" | tr ',' '\n' | while read -r emergency; do
            if [ -n "$emergency" ]; then
                case "$emergency" in
                    wan_down)
                        send_emergency "wan_down" "WAN connectivity lost" "critical"
                        ;;
                    lan_down)
                        send_emergency "lan_down" "LAN interface down" "critical"
                        ;;
                    dhcp_down)
                        send_emergency "service_crash" "DHCP server not running" "warning"
                        ;;
                    high_cpu)
                        send_emergency "high_cpu" "CPU usage over 90%" "warning"
                        ;;
                    high_memory)
                        send_emergency "high_memory" "Memory usage over 90%" "warning"
                        ;;
                    disk_full)
                        send_emergency "disk_full" "Disk usage over 90%" "warning"
                        ;;
                esac
            fi
        done
    fi

    # Always check in for pending commands
    checkin
}

# Test connectivity to relay
test_relay() {
    load_config

    echo "Testing connection to: $RELAY_URL"

    local response=$(curl -s "${RELAY_URL}/health")
    if echo "$response" | grep -q '"status":"ok"'; then
        echo "Relay is healthy!"
        echo "$response" | jq '.' 2>/dev/null || echo "$response"
    else
        echo "Failed to connect to relay"
        exit 1
    fi
}

# Show usage
usage() {
    cat <<EOF
pfSense Emergency Relay Client

Usage: pfsense-relay <command>

Commands:
    init        Initialize device (generate token)
    check       Check for emergencies and pending commands
    test        Test connection to relay
    status      Show current status
    help        Show this help

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
    check)
        check
        ;;
    test)
        test_relay
        ;;
    status)
        load_config
        echo "Device Token: ${DEVICE_TOKEN:0:16}..."
        echo "Relay URL: $RELAY_URL"
        echo "Emergencies: $(detect_emergencies || echo "none")"
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
