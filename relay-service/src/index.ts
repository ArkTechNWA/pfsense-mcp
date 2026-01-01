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
import cookieParser from "cookie-parser";
import * as db from "./db";
import * as alerter from "./alerter";
import { getQueueStatus } from "./executor";
import webhookRoutes from "./routes/webhook";
import registerRoutes from "./routes/register";
import adminRoutes from "./routes/admin";
import dashboardRoutes from "./routes/dashboard";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

const app = express();

// Middleware
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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
app.use(dashboardRoutes);

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
