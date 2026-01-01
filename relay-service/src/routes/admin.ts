/**
 * Admin API routes for Guardian relay
 *
 * Protected by X-Admin-Key header
 */

import { Router, Request, Response, NextFunction } from "express";
import * as db from "../db";

const router = Router();
const ADMIN_KEY = process.env.RELAY_ADMIN_KEY || "";

// Middleware: require admin key
function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-admin-key"];
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    res.status(401).json({ error: "Invalid admin key" });
    return;
  }
  next();
}

// GET /api/admin/devices - List all registered devices
router.get("/api/admin/devices", requireAdminKey, (req: Request, res: Response) => {
  const email = req.query.email as string | undefined;
  const devices = email ? db.getDevicesByEmail(email) : db.getAllDevices();

  res.json({
    count: devices.length,
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      email: d.email,
      last_seen: d.last_seen_at ? new Date(d.last_seen_at).toISOString() : null,
      created: new Date(d.created_at).toISOString(),
    })),
  });
});

// GET /api/admin/events - List recent events
router.get("/api/admin/events", requireAdminKey, (req: Request, res: Response) => {
  const email = req.query.email as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const events = db.getAllRecentEvents(limit);

  res.json({
    count: events.length,
    events: events.map((e) => ({
      id: e.id,
      device_token: e.device_token.substring(0, 8) + "...",
      type: e.event_type,
      severity: e.severity,
      summary: e.summary,
      created: new Date(e.created_at).toISOString(),
    })),
  });
});

// GET /api/admin/health - Relay health status
router.get("/api/admin/health", requireAdminKey, (req: Request, res: Response) => {
  const stats = db.getStats();

  res.json({
    status: "ok",
    uptime_seconds: Math.floor(process.uptime()),
    stats,
  });
});

// POST /api/admin/metrics - Push metrics from MCP
router.post("/api/admin/metrics", requireAdminKey, (req: Request, res: Response) => {
  const { device_token, metrics } = req.body;

  if (!device_token || !metrics) {
    res.status(400).json({ error: "device_token and metrics required" });
    return;
  }

  // Store metrics
  db.storeMetrics(device_token, metrics);

  res.json({ success: true, stored_at: new Date().toISOString() });
});

// GET /api/admin/metrics/:token - Get latest metrics for device
router.get("/api/admin/metrics/:token", requireAdminKey, (req: Request, res: Response) => {
  const metrics = db.getLatestMetrics(req.params.token);

  if (!metrics) {
    res.status(404).json({ error: "No metrics found for device" });
    return;
  }

  res.json(metrics);
});

// GET /api/admin/metrics - Get all latest metrics
router.get("/api/admin/metrics", requireAdminKey, (req: Request, res: Response) => {
  const allMetrics = db.getAllLatestMetrics();

  res.json({
    count: allMetrics.length,
    metrics: allMetrics,
  });
});

export default router;
