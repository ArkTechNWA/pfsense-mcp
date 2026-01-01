#!/bin/bash
#
# Build pfSense Guardian package
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="0.1.1"
PKG_NAME="pfSense-pkg-guardian"
STAGING_DIR="/tmp/guardian-pkg-staging"

echo "Building ${PKG_NAME} v${VERSION}..."

# Clean staging
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# Create directory structure
mkdir -p "$STAGING_DIR/usr/local/pkg"
mkdir -p "$STAGING_DIR/usr/local/share/${PKG_NAME}"

# Copy files
cp "$SCRIPT_DIR/pkg/pfsense-guardian.xml" "$STAGING_DIR/usr/local/pkg/"
cp "$SCRIPT_DIR/pkg/pfsense-guardian.inc" "$STAGING_DIR/usr/local/pkg/"

# Create +MANIFEST
cat > "$STAGING_DIR/+MANIFEST" << EOF
name: "${PKG_NAME}"
version: "${VERSION}"
origin: "sysutils/${PKG_NAME}"
comment: "AI-powered emergency monitoring for pfSense"
desc: "pfSense Guardian monitors your firewall for emergencies and uses Claude AI to diagnose issues and suggest fixes. Alerts are sent via email with detailed analysis."
maintainer: "mod@arktechnwa.com"
www: "https://pfsense-mcp.arktechnwa.com"
prefix: "/usr/local"
deps: {}
categories: ["sysutils"]
EOF

# Create +INSTALL script
cat > "$STAGING_DIR/+INSTALL" << 'EOF'
#!/bin/sh
if [ "$2" = "POST-INSTALL" ]; then
    /usr/local/bin/php -q <<EOPHP
<?php
require_once("pkg-utils.inc");
\$pkg_info = array();
\$pkg_info['name'] = "pfSense-Guardian";
\$pkg_info['descr'] = "AI-powered emergency monitoring";
\$pkg_info['website'] = "https://pfsense-mcp.arktechnwa.com";
\$pkg_info['version'] = "${VERSION}";
\$pkg_info['configurationfile'] = "pfsense-guardian.xml";
pkg_add_package_info(\$pkg_info);
EOPHP
fi
EOF
chmod +x "$STAGING_DIR/+INSTALL"

# Create +DEINSTALL script
cat > "$STAGING_DIR/+DEINSTALL" << 'EOF'
#!/bin/sh
if [ "$2" = "DEINSTALL" ]; then
    /usr/local/bin/php -q <<EOPHP
<?php
require_once("pkg-utils.inc");
pkg_delete_package_info("pfSense-Guardian");
EOPHP
fi
EOF
chmod +x "$STAGING_DIR/+DEINSTALL"

# Create plist
cat > "$STAGING_DIR/+COMPACT_MANIFEST" << EOF
name: "${PKG_NAME}"
version: "${VERSION}"
origin: "sysutils/${PKG_NAME}"
EOF

# Build the package
echo "Creating package..."
cd "$STAGING_DIR"

# Create txz package (FreeBSD pkg format)
tar -cJf "../${PKG_NAME}-${VERSION}.pkg" \
    +MANIFEST +INSTALL +DEINSTALL +COMPACT_MANIFEST \
    usr/

mv "../${PKG_NAME}-${VERSION}.pkg" "$SCRIPT_DIR/repo/All/"

echo "Package built: repo/All/${PKG_NAME}-${VERSION}.pkg"

# Generate repo metadata
echo "Generating repo metadata..."
cd "$SCRIPT_DIR/repo"

cat > meta.conf << EOF
version = 2;
packing_format = "txz";
EOF

cat > packagesite.yaml << EOF
---
${PKG_NAME}:
  name: "${PKG_NAME}"
  version: "${VERSION}"
  origin: "sysutils/${PKG_NAME}"
  comment: "AI-powered emergency monitoring for pfSense"
  desc: "pfSense Guardian monitors your firewall for emergencies and uses Claude AI to diagnose issues and suggest fixes."
  maintainer: "mod@arktechnwa.com"
  www: "https://pfsense-mcp.arktechnwa.com"
  prefix: "/usr/local"
  deps: {}
  categories: ["sysutils"]
  pkgsize: $(stat -f%z "All/${PKG_NAME}-${VERSION}.pkg" 2>/dev/null || stat -c%s "All/${PKG_NAME}-${VERSION}.pkg")
  path: "All/${PKG_NAME}-${VERSION}.pkg"
EOF

echo "Done! Deploy repo/ to https://pfsense-mcp.arktechnwa.com/repo/"
