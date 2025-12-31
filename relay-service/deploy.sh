#!/bin/bash
#
# Deploy pfsense-emergency-relay to VPS
#
# Usage: ./deploy.sh [vps-host]
#
# Default: vps-claude
#

set -e

VPS="${1:-vps-claude}"
DEPLOY_PATH="/var/www/pfsense-mcp.arktechnwa.com"
SERVICE_NAME="pfsense-relay"

echo "═══════════════════════════════════════════════════════"
echo "  Deploying pfsense-emergency-relay to $VPS"
echo "═══════════════════════════════════════════════════════"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Build locally first
echo "[1/6] Building TypeScript..."
cd "$SCRIPT_DIR"
npm run build

# Copy to VPS
echo "[2/6] Copying to $VPS:$DEPLOY_PATH..."
ssh "$VPS" "sudo mkdir -p $DEPLOY_PATH && sudo chown \$USER:\$USER $DEPLOY_PATH"
rsync -avz --exclude 'node_modules' --exclude '.git' \
    "$SCRIPT_DIR/" "$VPS:$DEPLOY_PATH/"

# Install dependencies on VPS
echo "[3/6] Installing dependencies on VPS..."
ssh "$VPS" "cd $DEPLOY_PATH && npm install --production"

# Create .env if it doesn't exist
echo "[4/6] Checking environment config..."
ssh "$VPS" "cat > /tmp/relay-env-check.sh << 'ENVSCRIPT'
if [ ! -f $DEPLOY_PATH/.env ]; then
    echo 'Creating .env template...'
    cat > $DEPLOY_PATH/.env << 'ENV'
PORT=3847
HOST=127.0.0.1
RELAY_SECRET=CHANGE_ME_$(openssl rand -hex 16)
SMTP_HOST=mail.arktechnwa.com
SMTP_PORT=587
SMTP_USER=relay@arktechnwa.com
SMTP_PASS=CHANGE_ME
SMTP_FROM=relay@pfsense-mcp.arktechnwa.com
RELAY_DOMAIN=pfsense-mcp.arktechnwa.com
ENV
    echo '⚠️  Edit $DEPLOY_PATH/.env with real values!'
else
    echo '.env already exists, skipping'
fi
ENVSCRIPT
bash /tmp/relay-env-check.sh"

# Set up PM2
echo "[5/6] Configuring PM2..."
ssh "$VPS" "cat > $DEPLOY_PATH/ecosystem.config.js << 'PM2CONFIG'
module.exports = {
  apps: [{
    name: 'pfsense-relay',
    script: 'dist/index.js',
    cwd: '$DEPLOY_PATH',
    env_file: '$DEPLOY_PATH/.env',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
PM2CONFIG"

# Start/restart PM2
ssh "$VPS" "cd $DEPLOY_PATH && pm2 delete $SERVICE_NAME 2>/dev/null || true && pm2 start ecosystem.config.js && pm2 save"

# Set up nginx
echo "[6/6] Configuring nginx..."
ssh "$VPS" "sudo tee /etc/nginx/conf.d/pfsense-mcp.conf > /dev/null << 'NGINX'
server {
    listen 80;
    server_name pfsense-mcp.arktechnwa.com;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name pfsense-mcp.arktechnwa.com;

    ssl_certificate /etc/letsencrypt/live/arktechnwa.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/arktechnwa.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3847;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX"

ssh "$VPS" "sudo nginx -t && sudo systemctl reload nginx"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Deployed!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Edit .env:  ssh $VPS 'nano $DEPLOY_PATH/.env'"
echo "  2. Restart:    ssh $VPS 'pm2 restart pfsense-relay'"
echo "  3. Check logs: ssh $VPS 'pm2 logs pfsense-relay'"
echo "  4. Test:       curl https://pfsense-mcp.arktechnwa.com/health"
echo ""
