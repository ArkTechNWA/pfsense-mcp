/**
 * Database layer for pfsense-emergency-relay
 * SQLite with automatic 24-hour TTL on all records
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type {
  HotPushPayload,
  WarmPushPayload,
  ManifestConfig,
  QueryStats,
  DataCategory,
} from "../types/cache";

const DB_DIR = process.env.RELAY_DB_DIR || path.join(process.env.HOME || "/tmp", ".cache", "pfsense-relay");
const DB_PATH = path.join(DB_DIR, "relay.db");
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let db: Database.Database;

export function initDatabase(): void {
  // Ensure directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Create tables
  db.exec(`
    -- Registered devices (pfSense instances)
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      name TEXT,
      email TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      relay_url TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );

    -- Incoming events (webhooks from pfSense)
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      device_token TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      summary TEXT NOT NULL,
      raw_data TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (device_token) REFERENCES devices(token)
    );

    -- Claude diagnostic results
    CREATE TABLE IF NOT EXISTS diagnostics (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL,
      prompt_used TEXT NOT NULL,
      claude_response TEXT NOT NULL,
      actions_suggested TEXT,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id)
    );

    -- Pending commands (from email replies, awaiting pfSense pickup)
    CREATE TABLE IF NOT EXISTS pending_commands (
      id INTEGER PRIMARY KEY,
      device_token TEXT NOT NULL,
      command TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      result TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      executed_at INTEGER,
      FOREIGN KEY (device_token) REFERENCES devices(token)
    );

    -- Alert history (dedup tracking)
    CREATE TABLE IF NOT EXISTS alert_history (
      id INTEGER PRIMARY KEY,
      device_token TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      alert_hash TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE(device_token, alert_hash)
    );

    -- Live metrics from MCP (NEVERHANG + A.L.A.N. + system stats)
    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY,
      device_token TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (device_token) REFERENCES devices(token)
    );

    -- RRD historical data (LEGACY - blob per period, being phased out)
    CREATE TABLE IF NOT EXISTS rrd_data (
      id INTEGER PRIMARY KEY,
      device_token TEXT NOT NULL,
      metric TEXT NOT NULL,
      period TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (device_token) REFERENCES devices(token),
      UNIQUE(device_token, metric, period)
    );

    -- RRD time-series points (NEW - immutable historical data)
    -- Each row is a single data point at a specific timestamp
    -- Historical data never changes - only append new points
    CREATE TABLE IF NOT EXISTS rrd_points (
      id INTEGER PRIMARY KEY,
      device_token TEXT NOT NULL,
      metric TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      value REAL NOT NULL,
      FOREIGN KEY (device_token) REFERENCES devices(token),
      UNIQUE(device_token, metric, timestamp)
    );

    -- Dashboard sessions (persistent across restarts)
    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      session_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_token);
    CREATE INDEX IF NOT EXISTS idx_events_expires ON events(expires_at);
    CREATE INDEX IF NOT EXISTS idx_diagnostics_expires ON diagnostics(expires_at);
    CREATE INDEX IF NOT EXISTS idx_commands_device ON pending_commands(device_token);
    CREATE INDEX IF NOT EXISTS idx_commands_status ON pending_commands(status);
    CREATE INDEX IF NOT EXISTS idx_alerts_device ON alert_history(device_token);
    CREATE INDEX IF NOT EXISTS idx_metrics_device ON metrics(device_token);
    CREATE INDEX IF NOT EXISTS idx_metrics_created ON metrics(created_at);
    CREATE INDEX IF NOT EXISTS idx_rrd_device ON rrd_data(device_token);
    CREATE INDEX IF NOT EXISTS idx_rrd_metric ON rrd_data(metric);
    CREATE INDEX IF NOT EXISTS idx_rrd_points_lookup ON rrd_points(device_token, metric, timestamp);
    CREATE INDEX IF NOT EXISTS idx_rrd_points_time ON rrd_points(timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON dashboard_sessions(expires_at);
  `);

  // Run cleanup on startup
  cleanupExpired();

  // Initialize Guardian v2 cache tables
  initCacheTables();
}

/**
 * Remove all expired records
 */
export function cleanupExpired(): number {
  const now = Date.now();

  const events = db.prepare("DELETE FROM events WHERE expires_at < ?").run(now);
  const diags = db.prepare("DELETE FROM diagnostics WHERE expires_at < ?").run(now);
  const cmds = db.prepare("DELETE FROM pending_commands WHERE expires_at < ?").run(now);
  const alerts = db.prepare("DELETE FROM alert_history WHERE expires_at < ?").run(now);
  const sessions = db.prepare("DELETE FROM dashboard_sessions WHERE expires_at < ?").run(now);

  const total = events.changes + diags.changes + cmds.changes + alerts.changes + sessions.changes;
  if (total > 0) {
    console.log(`[DB] Cleaned up ${total} expired records`);
  }
  return total;
}

// =============================================================================
// DEVICE OPERATIONS
// =============================================================================

export interface Device {
  id: number;
  token: string;
  name: string | null;
  email: string;
  api_key_encrypted: string;
  relay_url: string | null;
  created_at: number;
  last_seen_at: number | null;
}

export function registerDevice(
  token: string,
  email: string,
  apiKeyEncrypted: string,
  name?: string,
  relayUrl?: string
): Device {
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO devices (token, name, email, api_key_encrypted, relay_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      email = excluded.email,
      api_key_encrypted = excluded.api_key_encrypted,
      name = COALESCE(excluded.name, devices.name),
      relay_url = COALESCE(excluded.relay_url, devices.relay_url)
    RETURNING *
  `);

  return stmt.get(token, name || null, email, apiKeyEncrypted, relayUrl || null, now) as Device;
}

export function getDevice(token: string): Device | null {
  return db.prepare("SELECT * FROM devices WHERE token = ?").get(token) as Device | null;
}

export function updateDeviceLastSeen(token: string): void {
  db.prepare("UPDATE devices SET last_seen_at = ? WHERE token = ?").run(Date.now(), token);
}

// =============================================================================
// EVENT OPERATIONS
// =============================================================================

export interface Event {
  id: number;
  device_token: string;
  event_type: string;
  severity: string;
  summary: string;
  raw_data: string | null;
  created_at: number;
  expires_at: number;
}

export function insertEvent(
  deviceToken: string,
  eventType: string,
  severity: string,
  summary: string,
  rawData?: object
): Event {
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO events (device_token, event_type, severity, summary, raw_data, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);

  return stmt.get(
    deviceToken,
    eventType,
    severity,
    summary,
    rawData ? JSON.stringify(rawData) : null,
    now,
    now + TTL_MS
  ) as Event;
}

export function getRecentEvents(deviceToken: string, limit: number = 10): Event[] {
  return db.prepare(`
    SELECT * FROM events
    WHERE device_token = ? AND expires_at > ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(deviceToken, Date.now(), limit) as Event[];
}

// =============================================================================
// DIAGNOSTIC OPERATIONS
// =============================================================================

export interface Diagnostic {
  id: number;
  event_id: number;
  prompt_used: string;
  claude_response: string;
  actions_suggested: string | null;
  duration_ms: number | null;
  created_at: number;
  expires_at: number;
}

export function insertDiagnostic(
  eventId: number,
  promptUsed: string,
  claudeResponse: string,
  actionsSuggested?: string[],
  durationMs?: number
): Diagnostic {
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO diagnostics (event_id, prompt_used, claude_response, actions_suggested, duration_ms, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);

  return stmt.get(
    eventId,
    promptUsed,
    claudeResponse,
    actionsSuggested ? JSON.stringify(actionsSuggested) : null,
    durationMs || null,
    now,
    now + TTL_MS
  ) as Diagnostic;
}

// =============================================================================
// COMMAND QUEUE OPERATIONS
// =============================================================================

export interface PendingCommand {
  id: number;
  device_token: string;
  command: string;
  source: string;
  status: string;
  result: string | null;
  created_at: number;
  expires_at: number;
  executed_at: number | null;
}

export function queueCommand(
  deviceToken: string,
  command: string,
  source: string
): PendingCommand {
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO pending_commands (device_token, command, source, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `);

  return stmt.get(deviceToken, command, source, now, now + TTL_MS) as PendingCommand;
}

export function getPendingCommands(deviceToken: string): PendingCommand[] {
  return db.prepare(`
    SELECT * FROM pending_commands
    WHERE device_token = ? AND status = 'pending' AND expires_at > ?
    ORDER BY created_at ASC
  `).all(deviceToken, Date.now()) as PendingCommand[];
}

export function markCommandExecuted(commandId: number, result: string): void {
  db.prepare(`
    UPDATE pending_commands
    SET status = 'executed', result = ?, executed_at = ?
    WHERE id = ?
  `).run(result, Date.now(), commandId);
}

export function getCommandById(commandId: number): PendingCommand | null {
  return db.prepare(`
    SELECT * FROM pending_commands WHERE id = ?
  `).get(commandId) as PendingCommand | null;
}

// =============================================================================
// ALERT DEDUP
// =============================================================================

export function shouldSendAlert(deviceToken: string, alertType: string, alertHash: string): boolean {
  const existing = db.prepare(`
    SELECT id FROM alert_history
    WHERE device_token = ? AND alert_hash = ? AND expires_at > ?
  `).get(deviceToken, alertHash, Date.now());

  return !existing;
}

export function recordAlertSent(deviceToken: string, alertType: string, alertHash: string): void {
  const now = Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO alert_history (device_token, alert_type, alert_hash, sent_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(deviceToken, alertType, alertHash, now, now + TTL_MS);
}

// =============================================================================
// STATS
// =============================================================================

export function getStats(): {
  devices: number;
  events_24h: number;
  diagnostics_24h: number;
  pending_commands: number;
} {
  const now = Date.now();

  return {
    devices: (db.prepare("SELECT COUNT(*) as c FROM devices").get() as any).c,
    events_24h: (db.prepare("SELECT COUNT(*) as c FROM events WHERE expires_at > ?").get(now) as any).c,
    diagnostics_24h: (db.prepare("SELECT COUNT(*) as c FROM diagnostics WHERE expires_at > ?").get(now) as any).c,
    pending_commands: (db.prepare("SELECT COUNT(*) as c FROM pending_commands WHERE status = 'pending'").get() as any).c,
  };
}

export function closeDatabase(): void {
  if (db) {
    db.close();
  }
}

// =============================================================================
// ADMIN QUERIES
// =============================================================================

export function getAllDevices(): Device[] {
  return db.prepare("SELECT * FROM devices ORDER BY last_seen_at DESC").all() as Device[];
}

export function getDevicesByEmail(email: string): Device[] {
  return db.prepare("SELECT * FROM devices WHERE email = ? ORDER BY last_seen_at DESC").all(email) as Device[];
}

export function getAllRecentEvents(limit: number = 50): Event[] {
  const now = Date.now();
  return db.prepare(`
    SELECT * FROM events
    WHERE expires_at > ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(now, limit) as Event[];
}

export function getRecentEventsByEmail(email: string, limit: number = 20): Event[] {
  const now = Date.now();
  return db.prepare(`
    SELECT e.* FROM events e
    JOIN devices d ON e.device_token = d.token
    WHERE d.email = ? AND e.expires_at > ?
    ORDER BY e.created_at DESC
    LIMIT ?
  `).all(email, now, limit) as Event[];
}

// =============================================================================
// METRICS OPERATIONS
// =============================================================================

export interface Metrics {
  id: number;
  device_token: string;
  metrics_json: string;
  created_at: number;
}

export function storeMetrics(deviceToken: string, metrics: object): Metrics {
  const now = Date.now();

  // Auto-create device if it doesn't exist (for MCP-pushed metrics)
  const existingDevice = db.prepare("SELECT token FROM devices WHERE token = ?").get(deviceToken);
  if (!existingDevice) {
    db.prepare(`
      INSERT INTO devices (token, email, api_key_encrypted, created_at, name)
      VALUES (?, 'mcp-auto@local', 'none', ?, ?)
    `).run(deviceToken, now, deviceToken.substring(0, 20));
  }

  // Keep only last 100 metrics per device
  db.prepare(`
    DELETE FROM metrics WHERE device_token = ? AND id NOT IN (
      SELECT id FROM metrics WHERE device_token = ? ORDER BY created_at DESC LIMIT 99
    )
  `).run(deviceToken, deviceToken);

  const stmt = db.prepare(`
    INSERT INTO metrics (device_token, metrics_json, created_at)
    VALUES (?, ?, ?)
    RETURNING *
  `);

  return stmt.get(deviceToken, JSON.stringify(metrics), now) as Metrics;
}

export function getLatestMetrics(deviceToken: string): { device_token: string; metrics: object; updated_at: string } | null {
  const row = db.prepare(`
    SELECT * FROM metrics
    WHERE device_token = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(deviceToken) as Metrics | undefined;

  if (!row) return null;

  return {
    device_token: row.device_token,
    metrics: JSON.parse(row.metrics_json),
    updated_at: new Date(row.created_at).toISOString(),
  };
}

export function getAllLatestMetrics(): Array<{ device_token: string; device_name: string | null; metrics: object; updated_at: string }> {
  // Get latest metrics for each device
  const rows = db.prepare(`
    SELECT m.*, d.name as device_name
    FROM metrics m
    JOIN devices d ON m.device_token = d.token
    WHERE m.id IN (
      SELECT MAX(id) FROM metrics GROUP BY device_token
    )
    ORDER BY m.created_at DESC
  `).all() as Array<Metrics & { device_name: string | null }>;

  return rows.map((row) => ({
    device_token: row.device_token,
    device_name: row.device_name,
    metrics: JSON.parse(row.metrics_json),
    updated_at: new Date(row.created_at).toISOString(),
  }));
}

export function getMetricsHistory(deviceToken: string, limit: number = 60): Array<{ metrics: object; created_at: number }> {
  const rows = db.prepare(`
    SELECT metrics_json, created_at FROM metrics
    WHERE device_token = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(deviceToken, limit) as Array<{ metrics_json: string; created_at: number }>;

  return rows.map((row) => ({
    metrics: JSON.parse(row.metrics_json),
    created_at: row.created_at,
  }));
}

// Schedule cleanup every hour
setInterval(cleanupExpired, 60 * 60 * 1000);

// =============================================================================
// GUARDIAN V2 CACHE OPERATIONS
// =============================================================================

// Default manifest for new devices
const DEFAULT_MANIFEST: ManifestConfig = {
  version: "1.0.0",
  updated_at: Date.now(),
  hot: {
    interval_seconds: 30,
    collect: ["system", "gateways", "interfaces"],
  },
  warm: {
    interval_seconds: 300,
    collect: ["services", "dhcp_leases", "arp_table"],
  },
  cold: {
    note: "Pulled on demand by relay",
    items: ["firewall_rules", "firewall_states", "rrd"],
  },
  thresholds: {
    cpu: 80,
    memory: 85,
    disk: 90,
  },
};

/**
 * Initialize Guardian v2 cache tables
 */
export function initCacheTables(): void {
  db.exec(`
    -- Guardian v2: Hot/Warm data cache
    CREATE TABLE IF NOT EXISTS device_cache (
      id INTEGER PRIMARY KEY,
      device_token TEXT NOT NULL,
      cache_type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      cached_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      UNIQUE(device_token, cache_type)
    );

    -- Guardian v2: Per-device manifest config
    CREATE TABLE IF NOT EXISTS device_manifests (
      id INTEGER PRIMARY KEY,
      device_token TEXT UNIQUE NOT NULL,
      manifest_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      guardian_version TEXT
    );

    -- Guardian v2: A.L.A.N. query statistics
    CREATE TABLE IF NOT EXISTS query_stats (
      id INTEGER PRIMARY KEY,
      tool TEXT NOT NULL,
      device_token TEXT,
      queried_at INTEGER NOT NULL,
      latency_ms INTEGER,
      source TEXT
    );

    -- Guardian v2: A.L.A.N. promotion decisions
    CREATE TABLE IF NOT EXISTS promotion_history (
      id INTEGER PRIMARY KEY,
      tool TEXT NOT NULL,
      from_category TEXT,
      to_category TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL NOT NULL,
      decided_at INTEGER NOT NULL
    );

    -- Indexes for cache tables
    CREATE INDEX IF NOT EXISTS idx_cache_device ON device_cache(device_token);
    CREATE INDEX IF NOT EXISTS idx_cache_type ON device_cache(cache_type);
    CREATE INDEX IF NOT EXISTS idx_query_stats_tool ON query_stats(tool);
    CREATE INDEX IF NOT EXISTS idx_query_stats_time ON query_stats(queried_at);
  `);

  console.log("[DB] Guardian v2 cache tables initialized");
}

/**
 * Store hot data from Guardian push
 */
export function storeHotCache(deviceToken: string, data: HotPushPayload, ttlMs: number = 60000): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO device_cache (device_token, cache_type, data_json, cached_at, ttl_ms, source)
    VALUES (?, 'hot', ?, ?, ?, 'guardian_push')
    ON CONFLICT(device_token, cache_type) DO UPDATE SET
      data_json = excluded.data_json,
      cached_at = excluded.cached_at,
      ttl_ms = excluded.ttl_ms,
      source = excluded.source
  `).run(deviceToken, JSON.stringify(data), now, ttlMs);
}

/**
 * Store warm data from Guardian push
 */
export function storeWarmCache(deviceToken: string, data: WarmPushPayload, ttlMs: number = 600000): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO device_cache (device_token, cache_type, data_json, cached_at, ttl_ms, source)
    VALUES (?, 'warm', ?, ?, ?, 'guardian_push')
    ON CONFLICT(device_token, cache_type) DO UPDATE SET
      data_json = excluded.data_json,
      cached_at = excluded.cached_at,
      ttl_ms = excluded.ttl_ms,
      source = excluded.source
  `).run(deviceToken, JSON.stringify(data), now, ttlMs);
}

/**
 * Get cached data if not expired
 */
export function getCachedData(
  deviceToken: string,
  cacheType: "hot" | "warm"
): { data: HotPushPayload | WarmPushPayload; cached_at: number; ttl_remaining_ms: number; source: string } | null {
  const row = db.prepare(`
    SELECT data_json, cached_at, ttl_ms, source
    FROM device_cache
    WHERE device_token = ? AND cache_type = ?
  `).get(deviceToken, cacheType) as { data_json: string; cached_at: number; ttl_ms: number; source: string } | undefined;

  if (!row) return null;

  const now = Date.now();
  const ttlRemaining = row.cached_at + row.ttl_ms - now;

  // Return null if expired
  if (ttlRemaining <= 0) return null;

  return {
    data: JSON.parse(row.data_json),
    cached_at: row.cached_at,
    ttl_remaining_ms: ttlRemaining,
    source: row.source,
  };
}

/**
 * Get device manifest (or default)
 */
export function getDeviceManifest(deviceToken: string): ManifestConfig {
  const row = db.prepare(`
    SELECT manifest_json FROM device_manifests WHERE device_token = ?
  `).get(deviceToken) as { manifest_json: string } | undefined;

  if (!row) return { ...DEFAULT_MANIFEST, updated_at: Date.now() };
  return JSON.parse(row.manifest_json);
}

/**
 * Update device manifest
 */
export function updateDeviceManifest(deviceToken: string, manifest: ManifestConfig, guardianVersion?: string): void {
  const now = Date.now();
  manifest.updated_at = now;

  db.prepare(`
    INSERT INTO device_manifests (device_token, manifest_json, updated_at, guardian_version)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_token) DO UPDATE SET
      manifest_json = excluded.manifest_json,
      updated_at = excluded.updated_at,
      guardian_version = COALESCE(excluded.guardian_version, device_manifests.guardian_version)
  `).run(deviceToken, JSON.stringify(manifest), now, guardianVersion || null);
}

/**
 * Record a query for A.L.A.N. stats
 */
export function recordQuery(tool: string, deviceToken: string | null, latencyMs: number, source: string): void {
  db.prepare(`
    INSERT INTO query_stats (tool, device_token, queried_at, latency_ms, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(tool, deviceToken, Date.now(), latencyMs, source);

  // Cleanup old stats (keep 7 days)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM query_stats WHERE queried_at < ?").run(cutoff);
}

/**
 * Get query stats for A.L.A.N. analysis
 */
export function getQueryStats(): QueryStats[] {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const rows = db.prepare(`
    SELECT
      tool,
      COUNT(CASE WHEN queried_at >= ? THEN 1 END) as count_24h,
      COUNT(*) as count_7d,
      AVG(latency_ms) as avg_latency_ms,
      MAX(queried_at) as last_queried_at,
      GROUP_CONCAT(DISTINCT source) as sources
    FROM query_stats
    WHERE queried_at >= ?
    GROUP BY tool
    ORDER BY count_7d DESC
  `).all(oneDayAgo, sevenDaysAgo) as Array<{
    tool: string;
    count_24h: number;
    count_7d: number;
    avg_latency_ms: number;
    last_queried_at: number;
    sources: string;
  }>;

  return rows.map((row) => ({
    tool: row.tool,
    count_24h: row.count_24h || 0,
    count_7d: row.count_7d || 0,
    avg_latency_ms: Math.round(row.avg_latency_ms || 0),
    last_queried_at: row.last_queried_at,
    sources: row.sources ? row.sources.split(",") : [],
  }));
}

/**
 * Record a promotion decision
 */
export function recordPromotion(
  tool: string,
  fromCategory: DataCategory | null,
  toCategory: DataCategory,
  reason: string,
  confidence: number
): void {
  db.prepare(`
    INSERT INTO promotion_history (tool, from_category, to_category, reason, confidence, decided_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tool, fromCategory, toCategory, reason, confidence, Date.now());
}

/**
 * Get recent promotion decisions
 */
export function getRecentPromotions(limit: number = 20): Array<{
  tool: string;
  from_category: string | null;
  to_category: string;
  reason: string;
  confidence: number;
  decided_at: number;
}> {
  return db.prepare(`
    SELECT * FROM promotion_history
    ORDER BY decided_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    tool: string;
    from_category: string | null;
    to_category: string;
    reason: string;
    confidence: number;
    decided_at: number;
  }>;
}

/**
 * Get cache stats for health endpoint
 */
export function getCacheStats(): {
  hot_devices: number;
  warm_devices: number;
  total_queries_24h: number;
  manifests: number;
} {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const hotCount = (db.prepare(`
    SELECT COUNT(DISTINCT device_token) as c FROM device_cache
    WHERE cache_type = 'hot' AND cached_at + ttl_ms > ?
  `).get(now) as any).c;

  const warmCount = (db.prepare(`
    SELECT COUNT(DISTINCT device_token) as c FROM device_cache
    WHERE cache_type = 'warm' AND cached_at + ttl_ms > ?
  `).get(now) as any).c;

  const queryCount = (db.prepare(`
    SELECT COUNT(*) as c FROM query_stats WHERE queried_at >= ?
  `).get(oneDayAgo) as any).c;

  const manifestCount = (db.prepare(`
    SELECT COUNT(*) as c FROM device_manifests
  `).get() as any).c;

  return {
    hot_devices: hotCount,
    warm_devices: warmCount,
    total_queries_24h: queryCount,
    manifests: manifestCount,
  };
}

// =============================================================================
// RRD HISTORICAL DATA
// =============================================================================

export interface RrdData {
  id: number;
  device_token: string;
  metric: string;
  period: string;
  data_json: string;
  created_at: number;
}

export function storeRrdData(deviceToken: string, metric: string, period: string, data: object): RrdData {
  const now = Date.now();

  // Upsert: replace existing data for same device/metric/period
  db.prepare(`
    DELETE FROM rrd_data WHERE device_token = ? AND metric = ? AND period = ?
  `).run(deviceToken, metric, period);

  const stmt = db.prepare(`
    INSERT INTO rrd_data (device_token, metric, period, data_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `);

  return stmt.get(deviceToken, metric, period, JSON.stringify(data), now) as RrdData;
}

export function getRrdData(deviceToken: string, metric?: string): RrdData[] {
  if (metric) {
    return db.prepare(`
      SELECT * FROM rrd_data
      WHERE device_token = ? AND metric = ?
      ORDER BY created_at DESC
    `).all(deviceToken, metric) as RrdData[];
  }

  return db.prepare(`
    SELECT * FROM rrd_data
    WHERE device_token = ?
    ORDER BY metric, period
  `).all(deviceToken) as RrdData[];
}

export function getAllRrdSummary(): Array<{ device_token: string; metrics: string[]; updated_at: string }> {
  const rows = db.prepare(`
    SELECT device_token, GROUP_CONCAT(DISTINCT metric) as metrics, MAX(created_at) as updated_at
    FROM rrd_data
    GROUP BY device_token
  `).all() as Array<{ device_token: string; metrics: string; updated_at: number }>;

  return rows.map((row) => ({
    device_token: row.device_token,
    metrics: row.metrics ? row.metrics.split(",") : [],
    updated_at: new Date(row.updated_at).toISOString(),
  }));
}

// =============================================================================
// RRD TIME-SERIES POINTS (NEW - immutable historical data)
// =============================================================================

export interface RrdPoint {
  id: number;
  device_token: string;
  metric: string;
  timestamp: number;
  value: number;
}

/**
 * Get the last timestamp we have for a metric (for incremental sync)
 */
export function getLastTimestamp(deviceToken: string, metric: string): number | null {
  const row = db.prepare(`
    SELECT MAX(timestamp) as last_ts
    FROM rrd_points
    WHERE device_token = ? AND metric = ?
  `).get(deviceToken, metric) as { last_ts: number | null } | undefined;

  return row?.last_ts || null;
}

/**
 * Get last timestamps for all metrics (batch query for efficiency)
 */
export function getAllLastTimestamps(deviceToken: string): Record<string, number> {
  const rows = db.prepare(`
    SELECT metric, MAX(timestamp) as last_ts
    FROM rrd_points
    WHERE device_token = ?
    GROUP BY metric
  `).all(deviceToken) as Array<{ metric: string; last_ts: number }>;

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.metric] = row.last_ts;
  }
  return result;
}

/**
 * Store new RRD points (batch insert, skip duplicates)
 * Returns number of new points inserted
 */
export function storeRrdPoints(
  deviceToken: string,
  metric: string,
  points: Array<{ timestamp: number; value: number }>
): number {
  if (points.length === 0) return 0;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO rrd_points (device_token, metric, timestamp, value)
    VALUES (?, ?, ?, ?)
  `);

  let inserted = 0;
  const insertMany = db.transaction((pts: Array<{ timestamp: number; value: number }>) => {
    for (const pt of pts) {
      const result = stmt.run(deviceToken, metric, pt.timestamp, pt.value);
      inserted += result.changes;
    }
  });

  insertMany(points);
  return inserted;
}

/**
 * Get RRD points for a metric within a time range
 */
export function getRrdPoints(
  deviceToken: string,
  metric: string,
  startTime: number,
  endTime?: number
): RrdPoint[] {
  if (endTime) {
    return db.prepare(`
      SELECT * FROM rrd_points
      WHERE device_token = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `).all(deviceToken, metric, startTime, endTime) as RrdPoint[];
  }

  return db.prepare(`
    SELECT * FROM rrd_points
    WHERE device_token = ? AND metric = ? AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(deviceToken, metric, startTime) as RrdPoint[];
}

/**
 * Get RRD points for dashboard (by period shorthand)
 */
export function getRrdPointsByPeriod(
  deviceToken: string,
  metric: string,
  period: string
): RrdPoint[] {
  const now = Date.now();
  const periodMs: Record<string, number> = {
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
    "1m": 30 * 24 * 60 * 60 * 1000,
  };

  const startTime = now - (periodMs[period] || periodMs["1h"]);
  return getRrdPoints(deviceToken, metric, startTime, now);
}

/**
 * Get summary of stored points per metric
 */
export function getRrdPointsSummary(deviceToken: string): Array<{
  metric: string;
  count: number;
  oldest: number;
  newest: number;
}> {
  return db.prepare(`
    SELECT
      metric,
      COUNT(*) as count,
      MIN(timestamp) as oldest,
      MAX(timestamp) as newest
    FROM rrd_points
    WHERE device_token = ?
    GROUP BY metric
  `).all(deviceToken) as Array<{ metric: string; count: number; oldest: number; newest: number }>;
}

// =============================================================================
// DASHBOARD SESSION OPERATIONS (persistent across restarts)
// =============================================================================

export interface DashboardSession {
  session_id: string;
  email: string;
  expires_at: number;
  created_at: number;
}

export function createSession(sessionId: string, email: string, expiresAt: number): DashboardSession {
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO dashboard_sessions (session_id, email, expires_at, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      email = excluded.email,
      expires_at = excluded.expires_at
    RETURNING *
  `);

  return stmt.get(sessionId, email, expiresAt, now) as DashboardSession;
}

export function getSession(sessionId: string): DashboardSession | null {
  return db.prepare("SELECT * FROM dashboard_sessions WHERE session_id = ?").get(sessionId) as DashboardSession | null;
}

export function deleteSession(sessionId: string): void {
  db.prepare("DELETE FROM dashboard_sessions WHERE session_id = ?").run(sessionId);
}
