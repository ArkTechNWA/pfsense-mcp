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
