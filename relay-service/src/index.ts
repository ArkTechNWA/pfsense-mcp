#!/usr/bin/env node
/**
 * pfSense Emergency Relay
 *
 * Passive relay service that receives emergency webhooks from pfSense,
 * runs Claude diagnostics using the user's API key, and sends alerts.
 *
 * Principles:
 * - Passive: Never initiates connections to pfSense
 * - User's key: Each device uses their own Anthropic API key
 * - Self-hostable: Works at pfsense-mcp.arktechnwa.com or run your own
 * - Ephemeral: All data expires after 24 hours
 */

import express from "express";
import * as db from "./db";
import * as alerter from "./alerter";
import { getQueueStatus } from "./executor";
import webhookRoutes from "./routes/webhook";
import registerRoutes from "./routes/register";
import adminRoutes from "./routes/admin";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

const app = express();

// Middleware
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Routes
app.use(webhookRoutes);
app.use(registerRoutes);
app.use(adminRoutes);

// Health check
app.get("/health", (req, res) => {
  const stats = db.getStats();
  const queue = getQueueStatus();

  res.json({
    status: "ok",
    uptime: process.uptime(),
    stats,
    queue,
  });
});

// Admin stats (protected in production)
app.get("/stats", (req, res) => {
  // In production, add authentication here
  const stats = db.getStats();
  const queue = getQueueStatus();

  res.json({
    database: stats,
    queue: queue,
    memory: process.memoryUsage(),
    uptime: process.uptime(),
  });
});

// Dashboard - live metrics with NEVERHANG + A.L.A.N.
app.get("/dashboard", (req, res) => {
  const stats = db.getStats();
  const allMetrics = db.getAllLatestMetrics();
  const devices = db.getAllDevices();

  // Build history cache for sparklines (fetch once per device)
  const historyCache: Map<string, Array<{ metrics: any; created_at: number }>> = new Map();
  for (const m of allMetrics) {
    historyCache.set(m.device_token, db.getMetricsHistory(m.device_token, 30));
  }

  // Sparkline renderer - ASCII art histogram
  const renderSparkline = (history: Array<{ metrics: any; created_at: number }>, path: string, current: number): string => {
    if (history.length < 2) return '<span class="sparkline dim">awaiting data...</span>';

    // Extract values from history (oldest to newest for left-to-right display)
    const values: number[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i].metrics;
      let val = 0;
      if (path === 'cpu') val = m.system?.cpu?.usage_percent || 0;
      else if (path === 'mem') val = m.system?.memory?.usage_percent || 0;
      else if (path === 'disk') val = m.system?.disk?.usage_percent || 0;
      values.push(val);
    }

    // Normalize to 0-7 scale for 8 levels
    const chars = ' ▁▂▃▄▅▆▇';
    let spark = '';
    for (const v of values) {
      const idx = Math.min(7, Math.floor(v / 12.5));
      spark += chars[idx];
    }

    // Current position indicator (gauge bar)
    const barWidth = 20;
    const pos = Math.min(barWidth - 1, Math.floor(current / 100 * barWidth));
    let gauge = '';
    for (let i = 0; i < barWidth; i++) {
      gauge += i === pos ? '+' : '-';
    }

    return `<span class="sparkline">[${gauge}]</span><br><span class="sparkline hist">${spark}</span>`;
  };

  // Helper functions for rendering
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatTimeAgo = (timestamp: number): string => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  };

  const gaugeClass = (pct: number): string => pct > 80 ? 'bad' : pct > 50 ? 'warn' : 'good';

  // Render device metrics cards
  let metricsHtml = '';
  if (allMetrics.length > 0) {
    for (const m of allMetrics) {
      const metrics = m.metrics as any;
      const neverhang = metrics.neverhang || {};
      const alan = metrics.alan || {};
      const system = metrics.system || {};
      const deviceName = m.device_name || 'pfSense';
      const healthClass = neverhang.status || 'neutral';
      const circuitClass = neverhang.circuit || 'closed';
      const cpuPct = system.cpu?.usage_percent || 0;
      const memPct = system.memory?.usage_percent || 0;
      const diskPct = system.disk?.usage_percent || 0;

      // Interface card HTML (built first so we can include it in cartouche)
      let ifaceHtml = '';
      if (metrics.interfaces) {
        let ifaceRows = '';
        for (const [name, iface] of Object.entries(metrics.interfaces)) {
          const i = iface as any;
          ifaceRows += `
          <div class="device-row">
            <div>
              <div class="device-name">${name.toUpperCase()}</div>
              <div class="device-seen">${i.ipaddr || 'no ip'} • ${i.status || 'unknown'}</div>
            </div>
            <div style="text-align: right; font-size: 11px; color: #666;">
              ↓ ${formatBytes(i.inbytes || 0)}<br>
              ↑ ${formatBytes(i.outbytes || 0)}
            </div>
          </div>`;
        }
        ifaceHtml = `
        <div class="card neutral">
          <h2>Interfaces</h2>
          ${ifaceRows}
        </div>`;
      }

      // Get history for sparklines
      const history = historyCache.get(m.device_token) || [];

      metricsHtml += `
    <div class="cartouche ${healthClass}">
      <div class="cartouche-header">${deviceName}</div>
      <div class="cartouche-grid">
        <div class="card ${healthClass}">
          <h2>NEVERHANG</h2>
          <div style="margin-bottom: 16px;">
            <span class="circuit ${circuitClass}">${circuitClass.toUpperCase()}</span>
          </div>
          <div class="metric"><span class="metric-label">Status</span><span class="metric-value">${neverhang.status || 'unknown'}</span></div>
          <div class="metric"><span class="metric-label">Latency P95</span><span class="metric-value">${neverhang.latency_p95_ms || 0}ms</span></div>
          <div class="metric"><span class="metric-label">Recent Failures</span><span class="metric-value ${(neverhang.recent_failures || 0) > 0 ? 'bad' : 'good'}">${neverhang.recent_failures || 0}</span></div>
          <div class="metric"><span class="metric-label">Uptime</span><span class="metric-value good">${neverhang.uptime_percent || 100}%</span></div>
        </div>

        <div class="card neutral">
          <h2>A.L.A.N.</h2>
          <div class="big-number">${alan.success_rate_24h || '—'}</div>
          <div class="big-label">Success Rate (24h)</div>
          <div class="metric" style="margin-top: 16px;"><span class="metric-label">Queries (24h)</span><span class="metric-value">${alan.queries_24h || 0}</span></div>
        </div>

        <div class="card neutral">
          <h2>System</h2>
          <div class="metric">
            <span class="metric-label">CPU</span>
            <span class="metric-value ${gaugeClass(cpuPct)}">${cpuPct}%</span>
          </div>
          <div class="gauge"><div class="gauge-fill ${gaugeClass(cpuPct)}" style="width: ${cpuPct}%"></div></div>
          <div class="sparkline-row">${renderSparkline(history, 'cpu', cpuPct)}</div>

          <div class="metric" style="margin-top: 12px;">
            <span class="metric-label">Memory</span>
            <span class="metric-value ${gaugeClass(memPct)}">${memPct}%</span>
          </div>
          <div class="gauge"><div class="gauge-fill ${gaugeClass(memPct)}" style="width: ${memPct}%"></div></div>
          <div class="sparkline-row">${renderSparkline(history, 'mem', memPct)}</div>

          <div class="metric" style="margin-top: 12px;">
            <span class="metric-label">Disk</span>
            <span class="metric-value ${gaugeClass(diskPct)}">${diskPct}%</span>
          </div>
          <div class="gauge"><div class="gauge-fill ${gaugeClass(diskPct)}" style="width: ${diskPct}%"></div></div>
          <div class="sparkline-row">${renderSparkline(history, 'disk', diskPct)}</div>

          <div class="metric" style="margin-top: 12px;"><span class="metric-label">Uptime</span><span class="metric-value">${system.uptime || 'unknown'}</span></div>
          <div class="metric"><span class="metric-label">Platform</span><span class="metric-value">${system.platform || 'unknown'}</span></div>
        </div>

        ${ifaceHtml}
      </div>
    </div>`;
    }
  } else {
    metricsHtml = `
    <div class="card neutral" style="grid-column: 1 / -1;">
      <div class="empty">
        <div class="empty-icon">📡</div>
        <p>No metrics yet. Connect MCP to push live data.</p>
        <p style="margin-top: 12px; font-size: 12px;">POST /api/admin/metrics with X-Admin-Key header</p>
      </div>
    </div>`;
  }

  // Render devices list
  let devicesHtml = '';
  if (devices.length > 0) {
    for (const d of devices) {
      devicesHtml += `
        <div class="device-row">
          <div>
            <div class="device-name">${d.name || 'Unnamed'}</div>
            <div class="device-seen">${d.email}</div>
          </div>
          <div class="device-seen">${d.last_seen_at ? formatTimeAgo(d.last_seen_at) : 'never'}</div>
        </div>`;
    }
  } else {
    devicesHtml = '<div class="empty"><p>No devices registered</p></div>';
  }

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Guardian Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'JetBrains Mono', 'SF Mono', monospace; background: #0a0a0f; color: #e0e0e0; min-height: 100vh; }

    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 20px 30px; border-bottom: 1px solid #2a2a4a; }
    .header h1 { font-size: 24px; color: #00d9ff; font-weight: 600; }
    .header .tagline { color: #666; font-size: 12px; margin-top: 4px; }

    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; padding: 20px; }

    .card { background: #12121a; border: 1px solid #2a2a4a; border-radius: 12px; padding: 20px; }
    .card h2 { font-size: 14px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .card h2::before { content: ''; width: 8px; height: 8px; border-radius: 50%; }
    .card.healthy h2::before { background: #00ff88; box-shadow: 0 0 8px #00ff88; }
    .card.degraded h2::before { background: #ffaa00; box-shadow: 0 0 8px #ffaa00; }
    .card.unhealthy h2::before { background: #ff4444; box-shadow: 0 0 8px #ff4444; }
    .card.neutral h2::before { background: #00d9ff; box-shadow: 0 0 8px #00d9ff; }

    .cartouche { grid-column: 1 / -1; background: #0d0d14; border: 1px solid #1a1a2a; border-radius: 16px; padding: 20px; }
    .cartouche.healthy { border-color: rgba(0,255,136,0.3); box-shadow: 0 0 20px rgba(0,255,136,0.05); }
    .cartouche.degraded { border-color: rgba(255,170,0,0.3); box-shadow: 0 0 20px rgba(255,170,0,0.05); }
    .cartouche.unhealthy { border-color: rgba(255,68,68,0.3); box-shadow: 0 0 20px rgba(255,68,68,0.05); }
    .cartouche-header { font-size: 12px; text-transform: uppercase; letter-spacing: 3px; color: #00d9ff; margin-bottom: 16px; font-weight: 600; }
    .cartouche-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
    @media (max-width: 1200px) { .cartouche-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 600px) { .cartouche-grid { grid-template-columns: 1fr; } }
    .cartouche .card { margin: 0; background: #12121a; }

    .metric { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #1a1a2a; }
    .metric:last-child { border-bottom: none; }
    .metric-label { color: #888; }
    .metric-value { color: #fff; font-weight: 600; }
    .metric-value.good { color: #00ff88; }
    .metric-value.warn { color: #ffaa00; }
    .metric-value.bad { color: #ff4444; }

    .big-number { font-size: 48px; font-weight: 700; color: #00d9ff; line-height: 1; }
    .big-label { font-size: 12px; color: #666; margin-top: 8px; }

    .circuit { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .circuit.closed { background: rgba(0,255,136,0.15); color: #00ff88; border: 1px solid #00ff88; }
    .circuit.open { background: rgba(255,68,68,0.15); color: #ff4444; border: 1px solid #ff4444; }
    .circuit.half-open { background: rgba(255,170,0,0.15); color: #ffaa00; border: 1px solid #ffaa00; }

    .gauge { height: 8px; background: #1a1a2a; border-radius: 4px; overflow: hidden; margin-top: 8px; }
    .gauge-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
    .gauge-fill.good { background: linear-gradient(90deg, #00ff88, #00d9ff); }
    .gauge-fill.warn { background: linear-gradient(90deg, #ffaa00, #ff6600); }
    .gauge-fill.bad { background: linear-gradient(90deg, #ff4444, #ff0000); }

    .sparkline-row { margin-top: 4px; font-size: 10px; line-height: 1.3; }
    .sparkline { font-family: 'JetBrains Mono', monospace; color: #555; letter-spacing: -1px; }
    .sparkline.hist { color: #00d9ff; letter-spacing: 0; }
    .sparkline.dim { color: #333; font-style: italic; }

    .device-row { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #1a1a2a; border-radius: 8px; margin-bottom: 8px; }
    .device-name { font-weight: 600; }
    .device-seen { font-size: 12px; color: #666; }

    .empty { text-align: center; padding: 40px; color: #444; }
    .empty-icon { font-size: 48px; margin-bottom: 16px; }

    .footer { text-align: center; padding: 20px; color: #444; font-size: 12px; }
    .footer a { color: #00d9ff; text-decoration: none; }

    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .live { animation: pulse 2s infinite; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Guardian Dashboard</h1>
    <p class="tagline">NEVERHANG + A.L.A.N. • Auto-refresh 30s • <span class="live">LIVE</span></p>
  </div>

  <div class="grid">
    <div class="card neutral">
      <h2>Relay Status</h2>
      <div class="metric"><span class="metric-label">Devices</span><span class="metric-value">${stats.devices}</span></div>
      <div class="metric"><span class="metric-label">Events (24h)</span><span class="metric-value">${stats.events_24h}</span></div>
      <div class="metric"><span class="metric-label">Diagnostics (24h)</span><span class="metric-value">${stats.diagnostics_24h}</span></div>
      <div class="metric"><span class="metric-label">Pending Commands</span><span class="metric-value">${stats.pending_commands}</span></div>
    </div>

    ${metricsHtml}

    <div class="card neutral">
      <h2>Registered Devices</h2>
      ${devicesHtml}
    </div>
  </div>

  <div class="footer">
    <a href="/">← Back to Home</a> • Guardian Dashboard • Powered by NEVERHANG + A.L.A.N.
  </div>
</body>
</html>`);
});

// Root - landing page
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>pfSense Emergency Relay</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #eee; margin: 0; padding: 40px 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { color: #00d9ff; margin-bottom: 10px; }
    .tagline { color: #888; margin-bottom: 40px; }
    .card { background: #16213e; border-radius: 8px; padding: 25px; margin: 20px 0; }
    .card h2 { color: #00ff88; margin-top: 0; }
    code { background: #0f0f23; padding: 2px 8px; border-radius: 4px; }
    pre { background: #0f0f23; padding: 15px; border-radius: 4px; overflow-x: auto; }
    a { color: #00d9ff; }
    .btn { display: inline-block; background: #00d9ff; color: #000; padding: 12px 24px; border-radius: 4px; text-decoration: none; font-weight: bold; }
    .btn:hover { background: #00b8d4; }
    .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; }
    .feature { background: #0f3460; padding: 20px; border-radius: 8px; }
    .feature h3 { color: #00d9ff; margin-top: 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>pfSense Emergency Relay</h1>
    <p class="tagline">Claude-powered diagnostics when your network needs help</p>

    <div class="features">
      <div class="feature">
        <h3>🔒 Passive</h3>
        <p>Never polls your router. pfSense pushes alerts only when needed.</p>
      </div>
      <div class="feature">
        <h3>🔑 Your Key</h3>
        <p>Uses your Anthropic API key. We never see it in plaintext.</p>
      </div>
      <div class="feature">
        <h3>📧 Reply Commands</h3>
        <p>Reply to alert emails with commands. Execute remotely.</p>
      </div>
      <div class="feature">
        <h3>⏱️ Ephemeral</h3>
        <p>All data expires after 24 hours. Auto-sanitized.</p>
      </div>
    </div>

    <div class="card">
      <h2>Get Started</h2>
      <ol>
        <li>Install the tiny pkg on your pfSense</li>
        <li><a href="/register">Register your device</a> with your API key</li>
        <li>Receive Claude-powered diagnostics when things break</li>
      </ol>
      <a href="/register" class="btn">Register Device</a>
      <a href="/dashboard" class="btn" style="margin-left: 12px; background: #00ff88;">View Dashboard</a>
    </div>

    <div class="card">
      <h2>Self-Host</h2>
      <p>Run your own relay:</p>
      <pre>docker run -d \\
  -e SMTP_HOST=smtp.example.com \\
  -e SMTP_USER=you@example.com \\
  -e SMTP_PASS=secret \\
  -e RELAY_SECRET=your-secret-key \\
  -p 443:3000 \\
  arktechnwa/pfsense-emergency-relay</pre>
    </div>

    <div class="card">
      <h2>API Endpoints</h2>
      <ul>
        <li><code>POST /emergency</code> - Receive alerts from pfSense</li>
        <li><code>POST /checkin</code> - pfSense picks up pending commands</li>
        <li><code>POST /report</code> - pfSense reports status</li>
        <li><code>GET /health</code> - Service health check</li>
        <li><code>GET /register</code> - Device registration</li>
      </ul>
    </div>

    <p style="text-align: center; color: #666; margin-top: 40px;">
      Part of <a href="https://github.com/ArkTechNWA/pfsense-mcp">pfsense-mcp</a>
    </p>
  </div>
</body>
</html>
  `);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[Server] Error:", err);
  res.status(500).json({ error: "internal_error", message: err.message });
});

// Startup
async function main() {
  console.log("=".repeat(60));
  console.log("  pfSense Emergency Relay");
  console.log("  Passive · User Keys · Self-Hostable · Ephemeral");
  console.log("=".repeat(60));

  // Initialize database
  console.log("[Server] Initializing database...");
  db.initDatabase();

  // Verify SMTP
  console.log("[Server] Verifying SMTP connection...");
  await alerter.verifySmtp();

  // Start server
  app.listen(PORT, HOST, () => {
    console.log(`[Server] Listening on ${HOST}:${PORT}`);
    console.log(`[Server] Registration: http://${HOST}:${PORT}/register`);
    console.log("[Server] Ready for webhooks");
  });

  // Graceful shutdown
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function shutdown() {
  console.log("\n[Server] Shutting down...");
  db.closeDatabase();
  process.exit(0);
}

main().catch((err) => {
  console.error("[Server] Fatal error:", err);
  process.exit(1);
});
