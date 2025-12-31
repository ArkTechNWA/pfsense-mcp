/**
 * Database layer for pfsense-emergency-relay
 * SQLite with automatic 24-hour TTL on all records
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

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

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_token);
    CREATE INDEX IF NOT EXISTS idx_events_expires ON events(expires_at);
    CREATE INDEX IF NOT EXISTS idx_diagnostics_expires ON diagnostics(expires_at);
    CREATE INDEX IF NOT EXISTS idx_commands_device ON pending_commands(device_token);
    CREATE INDEX IF NOT EXISTS idx_commands_status ON pending_commands(status);
    CREATE INDEX IF NOT EXISTS idx_alerts_device ON alert_history(device_token);
  `);

  // Run cleanup on startup
  cleanupExpired();
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

  const total = events.changes + diags.changes + cmds.changes + alerts.changes;
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

// Schedule cleanup every hour
setInterval(cleanupExpired, 60 * 60 * 1000);
