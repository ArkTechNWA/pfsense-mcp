<?php
/*
 * pfsense-guardian.inc
 *
 * AI-powered emergency monitoring for pfSense
 * Part of the pfSense-MCP project
 * https://pfsense-mcp.arktechnwa.com
 */

require_once("config.inc");
require_once("functions.inc");
require_once("util.inc");
require_once("pfsense-utils.inc");
require_once("pkg-utils.inc");

define('GUARDIAN_RELAY_URL', 'https://pfsense-mcp.arktechnwa.com');
define('GUARDIAN_SCRIPT', '/usr/local/bin/pfsense-guardian');
define('GUARDIAN_CONFIG', '/usr/local/etc/pfsense-guardian.conf');

/**
 * Install the package
 */
function pfsense_guardian_install() {
    global $config;

    // Generate device token if not exists
    if (empty($config['installedpackages']['pfsenseguardian']['config'][0]['device_token'])) {
        $config['installedpackages']['pfsenseguardian']['config'][0]['device_token'] =
            hash('sha256', uniqid(gethostname(), true) . random_bytes(32));
        write_config("pfSense Guardian: Generated device token");
    }

    // Install the guardian script
    pfsense_guardian_install_script();

    // Initial sync
    pfsense_guardian_resync();

    log_error("pfSense Guardian: Package installed");
}

/**
 * Uninstall the package
 */
function pfsense_guardian_deinstall() {
    // Remove cron job
    install_cron_job(GUARDIAN_SCRIPT, false);

    // Remove files
    @unlink(GUARDIAN_SCRIPT);
    @unlink(GUARDIAN_CONFIG);

    log_error("pfSense Guardian: Package uninstalled");
}

/**
 * Resync configuration (called on config changes)
 */
function pfsense_guardian_resync() {
    global $config;

    $guardian_config = $config['installedpackages']['pfsenseguardian']['config'][0];

    if (empty($guardian_config)) {
        return;
    }

    // Write config file
    $conf = array(
        'RELAY_URL' => GUARDIAN_RELAY_URL,
        'DEVICE_TOKEN' => $guardian_config['device_token'],
        'EMAIL' => $guardian_config['email'],
        'API_KEY' => $guardian_config['apikey'],
        'CPU_THRESHOLD' => $guardian_config['cpu_threshold'] ?: 90,
        'MEM_THRESHOLD' => $guardian_config['mem_threshold'] ?: 90,
        'DISK_THRESHOLD' => $guardian_config['disk_threshold'] ?: 90,
    );

    $conf_str = "";
    foreach ($conf as $key => $value) {
        $conf_str .= "{$key}=\"{$value}\"\n";
    }

    file_put_contents(GUARDIAN_CONFIG, $conf_str);
    chmod(GUARDIAN_CONFIG, 0600);

    // Install/update script
    pfsense_guardian_install_script();

    // Setup cron
    $interval = $guardian_config['interval'] ?: 5;
    $enabled = ($guardian_config['enable'] == 'on');

    if ($enabled && !empty($guardian_config['email']) && !empty($guardian_config['apikey'])) {
        // Register with relay if not already
        pfsense_guardian_register();

        // Install cron job
        install_cron_job(GUARDIAN_SCRIPT, true, "*/{$interval}", "*", "*", "*", "*", "root");
        log_error("pfSense Guardian: Enabled with {$interval} minute interval");
    } else {
        // Remove cron job
        install_cron_job(GUARDIAN_SCRIPT, false);
        log_error("pfSense Guardian: Disabled");
    }
}

/**
 * Register device with relay
 */
function pfsense_guardian_register() {
    global $config;

    $guardian_config = $config['installedpackages']['pfsenseguardian']['config'][0];

    $post_data = array(
        'device_token' => $guardian_config['device_token'],
        'email' => $guardian_config['email'],
        'api_key' => $guardian_config['apikey'],
        'name' => gethostname() . '-guardian',
    );

    $ch = curl_init(GUARDIAN_RELAY_URL . '/register');
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($post_data));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);

    $response = curl_exec($ch);
    $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($http_code == 200 || $http_code == 201) {
        log_error("pfSense Guardian: Registered with relay");
        return true;
    } else {
        log_error("pfSense Guardian: Registration failed (HTTP {$http_code}): {$response}");
        return false;
    }
}

/**
 * Install the guardian monitoring script
 */
function pfsense_guardian_install_script() {
    $script = <<<'SCRIPT'
#!/bin/sh
#
# pfSense Guardian - Health Monitor
# https://pfsense-mcp.arktechnwa.com
#

CONFIG="/usr/local/etc/pfsense-guardian.conf"
[ -f "$CONFIG" ] || exit 1
. "$CONFIG"

send_alert() {
    TYPE="$1"
    SEVERITY="$2"
    SUMMARY="$3"
    CONTEXT="$4"

    TIMESTAMP=$(($(date +%s) * 1000))
    PAYLOAD="{\"type\":\"${TYPE}\",\"severity\":\"${SEVERITY}\",\"summary\":\"${SUMMARY}\",\"context\":${CONTEXT}}"
    SIGNATURE=$(echo -n "${TIMESTAMP}.${PAYLOAD}" | openssl dgst -sha256 -hmac "$DEVICE_TOKEN" 2>/dev/null | awk '{print $2}')

    /usr/local/bin/curl -s -o /dev/null \
        -X POST \
        -H "Content-Type: application/json" \
        -H "X-Device-Token: ${DEVICE_TOKEN}" \
        -H "X-Timestamp: ${TIMESTAMP}" \
        -H "X-Signature: ${SIGNATURE}" \
        -d "$PAYLOAD" \
        "${RELAY_URL}/emergency" 2>/dev/null
}

# Check CPU (FreeBSD style)
CPU_IDLE=$(top -b -d 1 | grep "CPU:" | head -1 | sed 's/.*,//;s/% idle.*//' | tr -d ' ')
CPU_IDLE_INT=$(printf "%.0f" "${CPU_IDLE:-0}")
CPU_USAGE=$((100 - CPU_IDLE_INT))
if [ "$CPU_USAGE" -gt "${CPU_THRESHOLD:-90}" ]; then
    TOP_PROC=$(ps auxww -o %cpu,comm | sort -rn | head -2 | tail -1 | awk '{print $2}')
    send_alert "high_cpu" "warning" "CPU usage at ${CPU_USAGE}% - top process: ${TOP_PROC}" \
        "{\"cpu_percent\":${CPU_USAGE},\"top_process\":\"${TOP_PROC}\"}"
fi

# Check Memory
MEM_INFO=$(top -b -d 1 | grep "^Mem:" | head -1)
MEM_ACTIVE=$(echo "$MEM_INFO" | grep -o '[0-9]*M Active' | grep -o '[0-9]*')
MEM_TOTAL=$(sysctl -n hw.physmem 2>/dev/null)
MEM_TOTAL_MB=$((MEM_TOTAL / 1024 / 1024))
if [ -n "$MEM_ACTIVE" ] && [ "$MEM_TOTAL_MB" -gt 0 ]; then
    MEM_USAGE=$((MEM_ACTIVE * 100 / MEM_TOTAL_MB))
    if [ "$MEM_USAGE" -gt "${MEM_THRESHOLD:-90}" ]; then
        send_alert "high_memory" "warning" "Memory usage at ${MEM_USAGE}%" \
            "{\"memory_percent\":${MEM_USAGE}}"
    fi
fi

# Check Disk
DISK_USAGE=$(df -h / | tail -1 | awk '{gsub(/%/,""); print $5}')
if [ "$DISK_USAGE" -gt "${DISK_THRESHOLD:-90}" ]; then
    send_alert "disk_full" "warning" "Disk usage at ${DISK_USAGE}%" \
        "{\"disk_percent\":${DISK_USAGE}}"
fi

# Check Gateways
GW_STATUS=$(/usr/local/sbin/pfSsh.php playback gatewaystatus 2>/dev/null)
if echo "$GW_STATUS" | grep -qi "down"; then
    DOWN_GW=$(echo "$GW_STATUS" | grep -i "down" | head -1 | awk '{print $1}')
    send_alert "gateway_down" "critical" "Gateway ${DOWN_GW} is down" \
        "{\"gateway\":\"${DOWN_GW}\"}"
fi

# Check critical services (only ones that run as actual processes)
# dpinger: gateway monitor, always runs
# unbound: DNS resolver, only if enabled in config
# Skip filterdns - not a standalone process, causes false positives

# dpinger should always be running
if ! /bin/pgrep -q "dpinger" 2>/dev/null; then
    send_alert "service_crash" "critical" "dpinger (gateway monitor) is not running" \
        "{\"service\":\"dpinger\"}"
fi

# unbound only if DNS resolver is enabled (check config exists and has unbound)
if [ -f /var/unbound/unbound.conf ] && ! /bin/pgrep -q "unbound" 2>/dev/null; then
    send_alert "service_crash" "critical" "unbound (DNS resolver) is not running" \
        "{\"service\":\"unbound\"}"
fi

# Checkin (heartbeat)
TIMESTAMP=$(($(date +%s) * 1000))
PAYLOAD="{\"status\":\"healthy\",\"cpu\":${CPU_USAGE:-0},\"memory\":${MEM_USAGE:-0},\"disk\":${DISK_USAGE:-0}}"
SIGNATURE=$(echo -n "${TIMESTAMP}.${PAYLOAD}" | openssl dgst -sha256 -hmac "$DEVICE_TOKEN" 2>/dev/null | awk '{print $2}')

/usr/local/bin/curl -s -o /dev/null \
    -X POST \
    -H "Content-Type: application/json" \
    -H "X-Device-Token: ${DEVICE_TOKEN}" \
    -H "X-Timestamp: ${TIMESTAMP}" \
    -H "X-Signature: ${SIGNATURE}" \
    -d "$PAYLOAD" \
    "${RELAY_URL}/checkin" 2>/dev/null

exit 0
SCRIPT;

    file_put_contents(GUARDIAN_SCRIPT, $script);
    chmod(GUARDIAN_SCRIPT, 0755);
}

?>
