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

// =============================================================================
// RRD HISTORICAL DATA
// =============================================================================

// POST /api/admin/rrd - Push RRD data from MCP
router.post("/api/admin/rrd", requireAdminKey, (req: Request, res: Response) => {
  const { device_token, metric, period, data } = req.body;

  if (!device_token || !metric || !period || !data) {
    res.status(400).json({ error: "device_token, metric, period, and data required" });
    return;
  }

  // Store RRD data (upserts by device/metric/period)
  db.storeRrdData(device_token, metric, period, data);

  res.json({ success: true, stored_at: new Date().toISOString() });
});

// GET /api/admin/rrd/:token - Get RRD data for a device
router.get("/api/admin/rrd/:token", requireAdminKey, (req: Request, res: Response) => {
  const metric = req.query.metric as string | undefined;
  const rrdData = db.getRrdData(req.params.token, metric);

  if (rrdData.length === 0) {
    res.status(404).json({ error: "No RRD data found for device" });
    return;
  }

  res.json({
    device_token: req.params.token,
    count: rrdData.length,
    data: rrdData.map((r) => ({
      metric: r.metric,
      period: r.period,
      data: JSON.parse(r.data_json),
      updated_at: new Date(r.created_at).toISOString(),
    })),
  });
});

// GET /api/admin/rrd - Get summary of all RRD data
router.get("/api/admin/rrd", requireAdminKey, (req: Request, res: Response) => {
  const summary = db.getAllRrdSummary();

  res.json({
    count: summary.length,
    devices: summary,
  });
});

// =============================================================================
// RRD TIME-SERIES POINTS (NEW - immutable historical data)
// =============================================================================

// GET /api/admin/points/:token/last - Get last timestamps for all metrics
router.get("/api/admin/points/:token/last", requireAdminKey, (req: Request, res: Response) => {
  const timestamps = db.getAllLastTimestamps(req.params.token);

  res.json({
    device_token: req.params.token,
    last_timestamps: timestamps,
  });
});

// GET /api/admin/points/:token/summary - Get summary of stored points
router.get("/api/admin/points/:token/summary", requireAdminKey, (req: Request, res: Response) => {
  const summary = db.getRrdPointsSummary(req.params.token);

  res.json({
    device_token: req.params.token,
    metrics: summary.map((s) => ({
      metric: s.metric,
      count: s.count,
      oldest: new Date(s.oldest).toISOString(),
      newest: new Date(s.newest).toISOString(),
      span_hours: Math.round((s.newest - s.oldest) / (1000 * 60 * 60)),
    })),
  });
});

// POST /api/admin/points - Push new points (incremental sync)
router.post("/api/admin/points", requireAdminKey, (req: Request, res: Response) => {
  const { device_token, metric, points } = req.body;

  if (!device_token || !metric || !points) {
    res.status(400).json({ error: "device_token, metric, and points required" });
    return;
  }

  if (!Array.isArray(points)) {
    res.status(400).json({ error: "points must be an array" });
    return;
  }

  const inserted = db.storeRrdPoints(device_token, metric, points);

  res.json({
    success: true,
    metric,
    received: points.length,
    inserted,  // New points (duplicates ignored)
    stored_at: new Date().toISOString(),
  });
});

// GET /api/admin/points/:token/:metric - Get points by time range or period
router.get("/api/admin/points/:token/:metric", requireAdminKey, (req: Request, res: Response) => {
  const { token, metric } = req.params;
  const period = req.query.period as string | undefined;
  const start = req.query.start as string | undefined;
  const end = req.query.end as string | undefined;

  let points;
  if (period) {
    // Period shorthand: 1h, 4h, 1d, 1w, 1m
    points = db.getRrdPointsByPeriod(token, metric, period);
  } else if (start) {
    // Explicit time range
    const startTs = parseInt(start);
    const endTs = end ? parseInt(end) : Date.now();
    points = db.getRrdPoints(token, metric, startTs, endTs);
  } else {
    // Default to last hour
    points = db.getRrdPointsByPeriod(token, metric, "1h");
  }

  res.json({
    device_token: token,
    metric,
    count: points.length,
    points: points.map((p) => ({
      timestamp: p.timestamp,
      value: p.value,
      time: new Date(p.timestamp).toISOString(),
    })),
  });
});

// =============================================================================
// COMMAND QUEUE (for MCP to check for pending commands)
// =============================================================================

// POST /api/admin/checkin - MCP checks in for pending commands
router.post("/api/admin/checkin", requireAdminKey, (req: Request, res: Response) => {
  const { device_token, results } = req.body;

  if (!device_token) {
    res.status(400).json({ error: "device_token required" });
    return;
  }

  // Process any command results from this request
  if (results && Array.isArray(results)) {
    for (const r of results) {
      if (r.id && r.result !== undefined) {
        db.markCommandExecuted(r.id, typeof r.result === 'string' ? r.result : JSON.stringify(r.result));
        console.log(`[Admin/Checkin] Command ${r.id} executed: ${String(r.result).slice(0, 50)}...`);
      }
    }
  }

  // Get pending commands for this device
  const commands = db.getPendingCommands(device_token);

  // Update device last seen
  db.updateDeviceLastSeen(device_token);

  res.json({
    commands: commands.map((c: any) => ({
      id: c.id,
      command: c.command,
      source: c.source,
    })),
  });
});

export default router;
