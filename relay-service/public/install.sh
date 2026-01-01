#!/bin/sh
#
# pfSense Guardian Installer
# https://pfsense-mcp.arktechnwa.com
#
# Run: fetch -o - https://pfsense-mcp.arktechnwa.com/install.sh | sh
#

set -e

RELAY_URL="https://pfsense-mcp.arktechnwa.com"
INSTALL_DIR="/usr/local/etc/pfsense-guardian"
SCRIPT_PATH="${INSTALL_DIR}/guardian.sh"
CONFIG_PATH="${INSTALL_DIR}/config"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo "${CYAN}║                                                           ║${NC}"
echo "${CYAN}║   ${GREEN}pfSense Guardian${CYAN}                                       ║${NC}"
echo "${CYAN}║   AI-powered emergency monitoring                         ║${NC}"
echo "${CYAN}║                                                           ║${NC}"
echo "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if running on pfSense
if [ ! -f /etc/version ]; then
    echo "${RED}Error: This doesn't look like pfSense.${NC}"
    exit 1
fi

PFSENSE_VERSION=$(cat /etc/version)
echo "${GREEN}✓${NC} Detected pfSense ${PFSENSE_VERSION}"

# Get user input
echo ""
echo "${YELLOW}Setup${NC}"
echo "────────────────────────────────────────"
printf "Email address: "
read EMAIL

if [ -z "$EMAIL" ]; then
    echo "${RED}Error: Email is required.${NC}"
    exit 1
fi

printf "Anthropic API key (sk-ant-...): "
stty -echo
read API_KEY
stty echo
echo ""

if [ -z "$API_KEY" ]; then
    echo "${RED}Error: API key is required.${NC}"
    exit 1
fi

# Validate API key format
case "$API_KEY" in
    sk-ant-*)
        echo "${GREEN}✓${NC} API key format valid"
        ;;
    *)
        echo "${RED}Error: API key should start with 'sk-ant-'${NC}"
        exit 1
        ;;
esac

# Generate device token (hostname + random)
HOSTNAME=$(hostname)
DEVICE_TOKEN=$(head -c 32 /dev/urandom | sha256 | cut -d' ' -f1)
DEVICE_NAME="${HOSTNAME}-guardian"

echo ""
echo "${YELLOW}Registering with relay...${NC}"

# Register with relay
REGISTER_RESPONSE=$(fetch -qo - \
    --method POST \
    --header "Content-Type: application/x-www-form-urlencoded" \
    --body "device_token=${DEVICE_TOKEN}&email=${EMAIL}&api_key=${API_KEY}&name=${DEVICE_NAME}" \
    "${RELAY_URL}/register" 2>&1) || {
    echo "${RED}Error: Failed to register with relay${NC}"
    echo "$REGISTER_RESPONSE"
    exit 1
}

# Check for error in response
case "$REGISTER_RESPONSE" in
    *"error"*)
        echo "${RED}Error: Registration failed${NC}"
        echo "$REGISTER_RESPONSE"
        exit 1
        ;;
esac

echo "${GREEN}✓${NC} Registered as ${DEVICE_NAME}"

# Create install directory
mkdir -p "$INSTALL_DIR"

# Save config
cat > "$CONFIG_PATH" << EOF
RELAY_URL="${RELAY_URL}"
DEVICE_TOKEN="${DEVICE_TOKEN}"
DEVICE_NAME="${DEVICE_NAME}"
EMAIL="${EMAIL}"
EOF
chmod 600 "$CONFIG_PATH"

echo "${GREEN}✓${NC} Config saved to ${CONFIG_PATH}"

# Install guardian script
cat > "$SCRIPT_PATH" << 'GUARDIAN'
#!/bin/sh
#
# pfSense Guardian - Health Monitor
# Checks system health and reports emergencies to relay
#

CONFIG="/usr/local/etc/pfsense-guardian/config"
[ -f "$CONFIG" ] && . "$CONFIG"

# Thresholds
CPU_THRESHOLD=90
MEM_THRESHOLD=90
DISK_THRESHOLD=90

send_alert() {
    TYPE="$1"
    SEVERITY="$2"
    SUMMARY="$3"
    CONTEXT="$4"
    
    TIMESTAMP=$(($(date +%s) * 1000))
    PAYLOAD="{\"type\":\"${TYPE}\",\"severity\":\"${SEVERITY}\",\"summary\":\"${SUMMARY}\",\"context\":${CONTEXT}}"
    SIGNATURE=$(echo -n "${TIMESTAMP}.${PAYLOAD}" | openssl dgst -sha256 -hmac "$DEVICE_TOKEN" | awk '{print $2}')
    
    fetch -qo /dev/null \
        --method POST \
        --header "Content-Type: application/json" \
        --header "X-Device-Token: ${DEVICE_TOKEN}" \
        --header "X-Timestamp: ${TIMESTAMP}" \
        --header "X-Signature: ${SIGNATURE}" \
        --body "$PAYLOAD" \
        "${RELAY_URL}/emergency" 2>/dev/null
}

# Check CPU
CPU_USAGE=$(top -b -n 1 | grep "CPU:" | awk '{print int($2)}')
if [ "$CPU_USAGE" -gt "$CPU_THRESHOLD" ]; then
    TOP_PROC=$(ps auxww | sort -k 3 -r | head -2 | tail -1 | awk '{print $11}')
    send_alert "high_cpu" "warning" "CPU usage at ${CPU_USAGE}% - top process: ${TOP_PROC}" \
        "{\"cpu_percent\":${CPU_USAGE},\"top_process\":\"${TOP_PROC}\"}"
fi

# Check Memory
MEM_USAGE=$(top -b -n 1 | grep "Mem:" | awk '{used=$3; total=$1; gsub(/M/,"",used); gsub(/M/,"",total); print int(used/total*100)}')
if [ "$MEM_USAGE" -gt "$MEM_THRESHOLD" ]; then
    send_alert "high_memory" "warning" "Memory usage at ${MEM_USAGE}%" \
        "{\"memory_percent\":${MEM_USAGE}}"
fi

# Check Disk
DISK_USAGE=$(df -h / | tail -1 | awk '{print int($5)}')
if [ "$DISK_USAGE" -gt "$DISK_THRESHOLD" ]; then
    send_alert "disk_full" "warning" "Disk usage at ${DISK_USAGE}%" \
        "{\"disk_percent\":${DISK_USAGE}}"
fi

# Check Gateways
/usr/local/sbin/pfSsh.php playback gatewaystatus | grep -q "down" && {
    DOWN_GW=$(/usr/local/sbin/pfSsh.php playback gatewaystatus | grep "down" | head -1 | awk '{print $1}')
    send_alert "gateway_down" "critical" "Gateway ${DOWN_GW} is down" \
        "{\"gateway\":\"${DOWN_GW}\"}"
}

# Check critical services
for SVC in unbound dpinger; do
    if ! pgrep -q "$SVC"; then
        send_alert "service_crash" "critical" "${SVC} service is not running" \
            "{\"service\":\"${SVC}\"}"
    fi
done

# Checkin (heartbeat)
TIMESTAMP=$(($(date +%s) * 1000))
PAYLOAD="{\"status\":\"healthy\",\"cpu\":${CPU_USAGE:-0},\"memory\":${MEM_USAGE:-0},\"disk\":${DISK_USAGE:-0}}"
SIGNATURE=$(echo -n "${TIMESTAMP}.${PAYLOAD}" | openssl dgst -sha256 -hmac "$DEVICE_TOKEN" | awk '{print $2}')

fetch -qo /dev/null \
    --method POST \
    --header "Content-Type: application/json" \
    --header "X-Device-Token: ${DEVICE_TOKEN}" \
    --header "X-Timestamp: ${TIMESTAMP}" \
    --header "X-Signature: ${SIGNATURE}" \
    --body "$PAYLOAD" \
    "${RELAY_URL}/checkin" 2>/dev/null

GUARDIAN
chmod 755 "$SCRIPT_PATH"

echo "${GREEN}✓${NC} Guardian script installed"

# Install cron job
CRON_ENTRY="*/5 * * * * ${SCRIPT_PATH} > /dev/null 2>&1"
(crontab -l 2>/dev/null | grep -v pfsense-guardian; echo "$CRON_ENTRY") | crontab -

echo "${GREEN}✓${NC} Cron job installed (every 5 minutes)"

# Run first check
echo ""
echo "${YELLOW}Running first health check...${NC}"
$SCRIPT_PATH && echo "${GREEN}✓${NC} Health check complete"

# Success!
echo ""
echo "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo "${GREEN}║                                                           ║${NC}"
echo "${GREEN}║   ${CYAN}All done!${GREEN}                                              ║${NC}"
echo "${GREEN}║                                                           ║${NC}"
echo "${GREEN}║   Your pfSense is now protected by AI-powered monitoring. ║${NC}"
echo "${GREEN}║                                                           ║${NC}"
echo "${GREEN}║   Bookmark your dashboard:                                ║${NC}"
echo "${GREEN}║   ${YELLOW}${RELAY_URL}/dashboard${GREEN}               ║${NC}"
echo "${GREEN}║                                                           ║${NC}"
echo "${GREEN}║   Alerts will be sent to: ${CYAN}${EMAIL}${GREEN}            ║${NC}"
echo "${GREEN}║                                                           ║${NC}"
echo "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

