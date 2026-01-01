#!/bin/sh
#
# pfSense Guardian Bootstrap Installer
# https://pfsense-mcp.arktechnwa.com
#
# Run on pfSense:
#   fetch -o - https://pfsense-mcp.arktechnwa.com/bootstrap.sh | sh
#

set -e

RELAY_URL="https://pfsense-mcp.arktechnwa.com"
VERSION="0.1.0"

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                                                           ║"
echo "║   pfSense Guardian Installer                              ║"
echo "║   AI-powered emergency monitoring                         ║"
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# Check if running on pfSense
if [ ! -f /etc/version ]; then
    if [ ! -d /cf/conf ]; then
        echo "Error: This doesn't look like pfSense."
        exit 1
    fi
fi

PFSENSE_VERSION=$(cat /etc/version 2>/dev/null || echo "unknown")
echo "[OK] Detected pfSense ${PFSENSE_VERSION}"

# Download package files
echo ""
echo "Downloading package files..."

fetch -qo /usr/local/pkg/pfsense-guardian.xml "${RELAY_URL}/repo/pkg/pfsense-guardian.xml"
echo "[OK] Downloaded package manifest"

fetch -qo /usr/local/pkg/pfsense-guardian.inc "${RELAY_URL}/repo/pkg/pfsense-guardian.inc"
echo "[OK] Downloaded package functions"

# Register with pfSense package system
echo ""
echo "Registering package..."

/usr/local/bin/php -q << 'EOPHP'
<?php
require_once("config.inc");
require_once("pkg-utils.inc");

// Add to installed packages
$pkg_config = array(
    'name' => 'pfSense-Guardian',
    'descr' => 'AI-powered emergency monitoring',
    'website' => 'https://pfsense-mcp.arktechnwa.com',
    'version' => '0.1.0',
    'configurationfile' => 'pfsense-guardian.xml'
);

// Check if already installed
$installed = false;
if (is_array($config['installedpackages']['package'])) {
    foreach ($config['installedpackages']['package'] as $pkg) {
        if ($pkg['name'] == 'pfSense-Guardian') {
            $installed = true;
            break;
        }
    }
}

if (!$installed) {
    $pkg_config['include_file'] = '/usr/local/pkg/pfsense-guardian.inc';
    $config['installedpackages']['package'][] = $pkg_config;
    write_config("Installed pfSense Guardian package");
    echo "Package registered.\n";
} else {
    echo "Package already registered.\n";
}

// Add menu entry if not exists
$menu_exists = false;
if (is_array($config['installedpackages']['menu'])) {
    foreach ($config['installedpackages']['menu'] as $menu) {
        if ($menu['name'] == 'pfSense Guardian') {
            $menu_exists = true;
            break;
        }
    }
}

if (!$menu_exists) {
    $config['installedpackages']['menu'][] = array(
        'name' => 'pfSense Guardian',
        'tooltiptext' => 'AI-powered emergency monitoring',
        'section' => 'Services',
        'url' => '/pkg_edit.php?xml=pfsense-guardian.xml'
    );
    write_config("Added pfSense Guardian menu");
    echo "Menu entry added.\n";
}

// Clear cache
@unlink("/tmp/config.cache");

// Initialize config section if needed
if (!isset($config['installedpackages']['pfsenseguardian']['config'][0])) {
    $config['installedpackages']['pfsenseguardian']['config'][0] = array(
        'enable' => '',
        'email' => '',
        'apikey' => '',
        'cpu_threshold' => '90',
        'mem_threshold' => '90',
        'disk_threshold' => '90',
        'interval' => '5'
    );
    write_config("Initialized pfSense Guardian configuration");
}

// Run install function
require_once("/usr/local/pkg/pfsense-guardian.inc");
pfsense_guardian_install();

echo "Installation complete.\n";
?>
EOPHP

echo "[OK] Package registered"

# Success!
echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                                                           ║"
echo "║   INSTALLATION COMPLETE!                                  ║"
echo "║                                                           ║"
echo "║   Next steps:                                             ║"
echo "║   1. Go to Services -> pfSense Guardian                   ║"
echo "║   2. Enter your email and Anthropic API key               ║"
echo "║   3. Check 'Enable Guardian' and click Save               ║"
echo "║                                                           ║"
echo "║   Dashboard: https://pfsense-mcp.arktechnwa.com/dashboard ║"
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""
