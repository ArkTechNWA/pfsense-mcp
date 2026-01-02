/**
 * Dashboard v2 - Modern pfSense Guardian Dashboard
 *
 * Features:
 * - Dark theme with CSS variables
 * - Collapsible sidebar with device list
 * - Top rail KPIs (Health, Circuit, A.L.A.N., Gateway, States)
 * - Period selector for RRD data (1H/4H/1D/1W/1M)
 * - Expandable events with Claude diagnostics
 * - Working control buttons
 */

import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import * as db from "../db";
import * as alerter from "../alerter";

const router = Router();

// In-memory token store (ephemeral - clears on restart, but that's OK for magic links)
const authTokens = new Map<string, { email: string; expires: number; sessionDuration: number }>();

const TOKEN_EXPIRY = 60 * 60 * 1000;  // 1 hour for magic links

// Session duration options (in milliseconds)
const DURATION_OPTIONS: Record<string, { label: string; ms: number }> = {
  "1h":   { label: "1 hour",  ms: 60 * 60 * 1000 },
  "1d":   { label: "1 day",   ms: 24 * 60 * 60 * 1000 },
  "1w":   { label: "1 week",  ms: 7 * 24 * 60 * 60 * 1000 },
  "1y":   { label: "1 year",  ms: 365 * 24 * 60 * 60 * 1000 },
};

const DEFAULT_DURATION = "1d";
const DEFAULT_REFRESH_INTERVAL = 5 * 60 * 1000;  // 5 minutes

// Extend Request type
interface AuthRequest extends Request {
  userEmail?: string;
}

// Request magic link
router.post("/auth/request", async (req: Request, res: Response) => {
  console.log("[Dashboard] Auth request for:", req.body.email);
  const { email, duration } = req.body;
  if (!email) {
    return res.status(400).json({ error: "email_required" });
  }

  const devices = db.getDevicesByEmail(email);
  console.log("[Dashboard] Found devices:", devices?.length || 0);
  if (!devices || devices.length === 0) {
    return res.json({ success: true, message: "If this email has registered devices, a login link was sent." });
  }

  const selectedDuration = DURATION_OPTIONS[duration] ? duration : DEFAULT_DURATION;
  const sessionDuration = DURATION_OPTIONS[selectedDuration].ms;

  const token = crypto.randomBytes(32).toString("hex");
  authTokens.set(token, { email, expires: Date.now() + TOKEN_EXPIRY, sessionDuration });

  const loginUrl = `https://pfsense-mcp.arktechnwa.com/auth/verify?token=${token}`;
  const durationLabel = DURATION_OPTIONS[selectedDuration].label;

  try {
    console.log("[Dashboard] Sending magic link to:", email, "duration:", durationLabel);
    await alerter.sendMagicLink(email, loginUrl, durationLabel);
    console.log("[Dashboard] Magic link sent!");
    res.json({ success: true, message: `Check your email for a login link (valid 1 hour, session lasts ${durationLabel}).` });
  } catch (err) {
    console.error("[Dashboard] Failed to send magic link:", err);
    res.status(500).json({ error: "email_failed" });
  }
});

// Verify magic link
router.get("/auth/verify", (req: Request, res: Response) => {
  const { token } = req.query;
  const auth = authTokens.get(token as string);
  if (!auth || Date.now() > auth.expires) {
    authTokens.delete(token as string);
    return res.redirect("/dashboard/login?error=expired");
  }

  const sessionId = crypto.randomBytes(32).toString("hex");
  const sessionExpiry = Date.now() + auth.sessionDuration;
  db.createSession(sessionId, auth.email, sessionExpiry);
  authTokens.delete(token as string);

  res.cookie("pfsense_session", sessionId, {
    httpOnly: true,
    secure: true,
    maxAge: auth.sessionDuration,
    sameSite: "lax",
  });
  res.redirect("/dashboard");
});

// Auth middleware
function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.pfsense_session;
  const session = db.getSession(sessionId);
  if (!session || Date.now() > session.expires_at) {
    db.deleteSession(sessionId);
    return res.redirect("/dashboard/login");
  }
  req.userEmail = session.email;
  next();
}

// API auth middleware
function requireAuthAPI(req: AuthRequest, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.pfsense_session;
  const session = db.getSession(sessionId);
  if (!session || Date.now() > session.expires_at) {
    db.deleteSession(sessionId);
    return res.status(401).json({ error: "unauthorized" });
  }
  req.userEmail = session.email;
  next();
}

// Login page
router.get("/dashboard/login", (req: Request, res: Response) => {
  const error = req.query.error === "expired" ? "Link expired. Please request a new one." : "";
  const durationOptions = Object.entries(DURATION_OPTIONS)
    .map(([key, opt]) => `<option value="${key}"${key === DEFAULT_DURATION ? " selected" : ""}>${opt.label}</option>`)
    .join("");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>pfSense Guardian - Login</title>
  <meta name=viewport content="width=device-width,initial-scale=1">
  <style>
    :root {
      --bg-0: #0a0a14;
      --bg-1: #12121e;
      --bg-2: #1a1a2e;
      --text-primary: #f0f0f0;
      --text-secondary: #a0a0b0;
      --cyan: #00d9ff;
      --green: #00ff88;
    }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg-0); color: var(--text-primary); margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { width: 100%; max-width: 400px; }
    h1 { color: var(--cyan); margin: 0 0 8px 0; font-size: 1.8em; }
    .subtitle { color: var(--text-secondary); margin-bottom: 30px; }
    .field { margin-bottom: 20px; }
    label { display: block; color: var(--text-secondary); font-size: 0.85em; margin-bottom: 6px; }
    input, select { width: 100%; padding: 14px 16px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; background: var(--bg-2); color: var(--text-primary); font-size: 1em; }
    input:focus, select:focus { outline: none; border-color: var(--cyan); }
    button { width: 100%; padding: 14px; background: var(--cyan); color: #000; border: none; border-radius: 8px; font-size: 1em; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
    button:hover { opacity: 0.9; }
    .msg { padding: 16px; background: var(--bg-2); border-radius: 8px; margin-top: 20px; text-align: center; }
    .error { background: rgba(255,68,68,0.15); color: #ff8888; }
  </style>
</head>
<body>
  <div class="container">
    <h1>pfSense Guardian</h1>
    <p class="subtitle">Network monitoring dashboard</p>
    ${error ? '<div class="msg error">' + error + '</div>' : ''}
    <form id="loginForm">
      <div class="field">
        <label>Email address</label>
        <input type="email" name="email" placeholder="you@example.com" required>
      </div>
      <div class="field">
        <label>Stay logged in for</label>
        <select name="duration">${durationOptions}</select>
      </div>
      <button type="submit">Send Login Link</button>
    </form>
    <div id="msg" class="msg" style="display:none"></div>
  </div>
  <script>
    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const email = e.target.email.value;
      const duration = e.target.duration.value;
      const msg = document.getElementById('msg');
      msg.style.display = 'block';
      msg.className = 'msg';
      msg.textContent = 'Sending...';
      try {
        const res = await fetch('/auth/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, duration })
        });
        const data = await res.json();
        msg.textContent = data.message || 'Check your email!';
      } catch (err) {
        msg.className = 'msg error';
        msg.textContent = 'Error sending link. Try again.';
      }
    };
  </script>
</body>
</html>`);
});

function formatTimeSince(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

// API: Dashboard status
router.get("/api/dashboard/status", requireAuthAPI, (req: AuthRequest, res: Response) => {
  const devices = db.getDevicesByEmail(req.userEmail!);
  const recentEvents = db.getRecentEventsByEmail(req.userEmail!, 20);

  const deviceData = devices.map((d: any) => {
    const latestMetrics = db.getLatestMetrics(d.token);
    const metricsHistory = db.getMetricsHistory(d.token, 60);

    return {
      name: d.name || d.token.slice(0, 8),
      token: d.token,
      lastSeen: d.last_seen_at,
      timeSince: d.last_seen_at ? formatTimeSince(d.last_seen_at) : "never",
      metrics: latestMetrics?.metrics || null,
      metricsHistory: metricsHistory.map(h => ({
        metrics: h.metrics,
        timestamp: h.created_at,
      })),
    };
  });

  const eventData = recentEvents.map((e: any) => ({
    id: e.id,
    severity: e.severity,
    type: e.event_type,
    summary: e.summary,
    time: formatTimeSince(e.created_at),
    raw_data: e.raw_data ? JSON.parse(e.raw_data) : null,
  }));

  res.json({
    timestamp: Date.now(),
    refreshInterval: DEFAULT_REFRESH_INTERVAL,
    devices: deviceData,
    events: eventData,
  });
});

// API: RRD data for specific metric
router.get("/api/dashboard/rrd/:metric", requireAuthAPI, (req: AuthRequest, res: Response) => {
  const devices = db.getDevicesByEmail(req.userEmail!);
  if (devices.length === 0) {
    return res.status(404).json({ error: "No devices found" });
  }

  const device = devices[0];
  const metric = req.params.metric;
  const period = (req.query.period as string) || "1h";
  const rrdData = db.getRrdData(device.token, metric);

  const periodData = rrdData.find((r: any) => r.period === period);
  if (!periodData) {
    return res.status(404).json({ error: "No data for this period" });
  }

  res.json({
    device: device.name || device.token.slice(0, 8),
    metric,
    period,
    data: JSON.parse(periodData.data_json),
    updated_at: new Date(periodData.created_at).toISOString(),
  });
});

// API: All available RRD metrics
router.get("/api/dashboard/rrd", requireAuthAPI, (req: AuthRequest, res: Response) => {
  const devices = db.getDevicesByEmail(req.userEmail!);
  if (devices.length === 0) {
    return res.status(404).json({ error: "No devices found" });
  }

  const device = devices[0];
  const allRrd = db.getRrdData(device.token);

  const metrics: Record<string, string[]> = {};
  allRrd.forEach((r: any) => {
    if (!metrics[r.metric]) metrics[r.metric] = [];
    metrics[r.metric].push(r.period);
  });

  res.json({
    device: device.name || device.token.slice(0, 8),
    available_metrics: Object.entries(metrics).map(([metric, periods]) => ({ metric, periods })),
  });
});

// API: Execute action
router.post("/api/dashboard/action", requireAuthAPI, async (req: AuthRequest, res: Response) => {
  const { action, device_token } = req.body;

  const devices = db.getDevicesByEmail(req.userEmail!);
  const device = devices.find((d: any) => d.token === device_token);
  if (!device) {
    return res.status(403).json({ error: "Device not found" });
  }

  // Queue command for device pickup
  const command = db.queueCommand(device_token, action, "dashboard");

  res.json({
    success: true,
    command_id: command.id,
    message: `Command '${action}' queued. Device will execute on next check-in.`,
  });
});

// Main dashboard
router.get("/dashboard", requireAuth, (req: AuthRequest, res: Response) => {
  const devices = db.getDevicesByEmail(req.userEmail!);

  // Initial data for server-side render
  const deviceData = devices.map((d: any) => {
    const latestMetrics = db.getLatestMetrics(d.token);
    return {
      name: d.name || d.token.slice(0, 8),
      token: d.token,
      lastSeen: d.last_seen_at,
      timeSince: d.last_seen_at ? formatTimeSince(d.last_seen_at) : "never",
      metrics: latestMetrics?.metrics || null,
    };
  });

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>pfSense Guardian</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    /* ========================================
       CSS VARIABLES - Dark Theme Foundation
       ======================================== */
    :root {
      --bg-0: #0a0a14;
      --bg-1: #12121e;
      --bg-2: #1a1a2e;
      --bg-3: #222236;
      --bg-hover: #2a2a44;
      --border-subtle: rgba(255,255,255,0.08);
      --border-medium: rgba(255,255,255,0.12);
      --text-primary: #f0f0f0;
      --text-secondary: #a0a0b0;
      --text-muted: #666680;
      --cyan: #00d9ff;
      --green: #00ff88;
      --yellow: #ffaa00;
      --red: #ff4444;
      --purple: #a855f7;
      --gradient-good: linear-gradient(90deg, #00ff88 0%, #00d9ff 100%);
      --gradient-warn: linear-gradient(90deg, #ffaa00 0%, #ff6600 100%);
      --gradient-bad: linear-gradient(90deg, #ff4444 0%, #cc0000 100%);
      --sidebar-width: 220px;
      --topnav-height: 52px;
      --toprail-height: 80px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg-0); color: var(--text-primary); }

    /* ========================================
       GRID LAYOUT
       ======================================== */
    .dashboard {
      display: grid;
      grid-template-areas:
        "topnav topnav"
        "sidebar main";
      grid-template-columns: var(--sidebar-width) 1fr;
      grid-template-rows: var(--topnav-height) 1fr;
      height: 100vh;
      overflow: hidden;
    }

    /* Mobile: sidebar hidden by default */
    @media (max-width: 768px) {
      .dashboard {
        grid-template-columns: 1fr;
        grid-template-areas: "topnav" "main";
      }
      .sidebar {
        position: fixed;
        left: 0;
        top: var(--topnav-height);
        bottom: 0;
        width: var(--sidebar-width);
        transform: translateX(-100%);
        transition: transform 0.25s ease;
        z-index: 100;
      }
      .sidebar.open { transform: translateX(0); }
      .sidebar-overlay {
        display: none;
        position: fixed;
        inset: 0;
        top: var(--topnav-height);
        background: rgba(0,0,0,0.5);
        z-index: 99;
      }
      .sidebar.open + .sidebar-overlay { display: block; }
    }

    /* ========================================
       TOP NAVIGATION
       ======================================== */
    .topnav {
      grid-area: topnav;
      background: var(--bg-1);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      padding: 0 16px;
      gap: 16px;
    }
    .menu-toggle {
      display: none;
      background: none;
      border: none;
      color: var(--text-primary);
      font-size: 1.4em;
      cursor: pointer;
      padding: 8px;
    }
    @media (max-width: 768px) {
      .menu-toggle { display: block; }
    }
    .logo {
      font-weight: 600;
      font-size: 1.1em;
      color: var(--cyan);
    }
    .device-select {
      background: var(--bg-2);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      color: var(--text-primary);
      padding: 6px 12px;
      font-size: 0.9em;
      cursor: pointer;
    }
    .topnav-spacer { flex: 1; }
    .user-area {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .user-email {
      color: var(--text-secondary);
      font-size: 0.85em;
    }
    .logout-btn {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.85em;
      padding: 6px 12px;
      border-radius: 4px;
      transition: all 0.2s;
    }
    .logout-btn:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    /* ========================================
       SIDEBAR
       ======================================== */
    .sidebar {
      grid-area: sidebar;
      background: var(--bg-1);
      border-right: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    .sidebar-section {
      padding: 16px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .sidebar-section h3 {
      font-size: 0.7em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }
    .device-list {
      list-style: none;
    }
    .device-list li {
      padding: 10px 12px;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 4px;
      transition: background 0.15s;
    }
    .device-list li:hover { background: var(--bg-hover); }
    .device-list li.active { background: var(--bg-3); }
    .device-list .device-name { display: block; font-weight: 500; }
    .device-list .device-status {
      font-size: 0.8em;
      color: var(--text-muted);
    }
    .sidebar-footer {
      margin-top: auto;
      padding: 16px;
      border-top: 1px solid var(--border-subtle);
    }
    .refresh-indicator {
      font-size: 0.8em;
      color: var(--text-muted);
    }
    .refresh-indicator .live {
      color: var(--green);
    }

    /* ========================================
       MAIN CONTENT
       ======================================== */
    .main {
      grid-area: main;
      background: var(--bg-0);
      overflow-y: auto;
      padding: 20px;
    }

    /* ========================================
       TOP RAIL - KPIs
       ======================================== */
    .toprail {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .kpi {
      background: var(--bg-2);
      border-radius: 10px;
      padding: 14px 18px;
      min-width: 120px;
      flex: 1;
      text-align: center;
    }
    .kpi-label {
      display: block;
      font-size: 0.7em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .kpi-value {
      font-size: 1.6em;
      font-weight: 700;
    }
    .kpi-value.good { color: var(--green); }
    .kpi-value.warn { color: var(--yellow); }
    .kpi-value.bad { color: var(--red); }
    .circuit-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 0.75em;
      font-weight: 600;
      text-transform: uppercase;
    }
    .circuit-badge.closed { background: rgba(0,255,136,0.15); color: var(--green); }
    .circuit-badge.open { background: rgba(255,68,68,0.15); color: var(--red); }
    .circuit-badge.half_open { background: rgba(255,170,0,0.15); color: var(--yellow); }

    /* ========================================
       PERIOD SELECTOR
       ======================================== */
    .period-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 20px;
    }
    .period-label {
      font-size: 0.8em;
      color: var(--text-muted);
      margin-right: 4px;
    }
    .period-btn {
      background: var(--bg-2);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      color: var(--text-secondary);
      padding: 6px 12px;
      font-size: 0.8em;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .period-btn:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }
    .period-btn.active {
      background: var(--cyan);
      color: #000;
      border-color: var(--cyan);
    }

    /* ========================================
       METRICS GRID
       ======================================== */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--bg-2);
      border-radius: 10px;
      padding: 18px;
    }
    .metric-card h3 {
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 14px;
    }

    /* Resource bars */
    .resource-bar {
      margin-bottom: 14px;
    }
    .resource-bar:last-child { margin-bottom: 0; }
    .bar-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .bar-label { font-size: 0.85em; color: var(--text-secondary); }
    .bar-value { font-size: 0.85em; font-weight: 600; }
    .bar-track {
      height: 6px;
      background: var(--bg-0);
      border-radius: 3px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .bar-fill.good { background: var(--gradient-good); }
    .bar-fill.warn { background: var(--gradient-warn); }
    .bar-fill.bad { background: var(--gradient-bad); }
    .bar-chart {
      height: 32px;
      margin-top: 6px;
    }
    .bar-chart svg {
      width: 100%;
      height: 100%;
    }

    /* Traffic charts */
    .traffic-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .traffic-label { font-size: 0.85em; color: var(--text-secondary); }
    .traffic-value { font-size: 0.85em; font-weight: 600; color: var(--cyan); }
    .traffic-chart {
      height: 48px;
      margin-top: 8px;
    }
    .traffic-chart svg {
      width: 100%;
      height: 100%;
    }

    /* Gateway stats */
    .gateway-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .gateway-stat .value {
      font-size: 1.4em;
      font-weight: 700;
    }
    .gateway-stat .label {
      font-size: 0.75em;
      color: var(--text-muted);
    }

    /* ========================================
       EVENTS SECTION
       ======================================== */
    .events-section {
      margin-bottom: 24px;
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .section-header h2 {
      font-size: 0.9em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
    }
    .event-card {
      background: var(--bg-2);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .event-card:hover { background: var(--bg-3); }
    .event-header {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .event-sev {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .event-sev.critical { background: var(--red); }
    .event-sev.warning { background: var(--yellow); }
    .event-sev.info { background: var(--cyan); }
    .event-type {
      font-size: 0.8em;
      color: var(--text-muted);
      text-transform: uppercase;
    }
    .event-time {
      font-size: 0.8em;
      color: var(--text-muted);
      margin-left: auto;
    }
    .event-summary {
      margin-top: 6px;
      font-size: 0.9em;
    }
    .event-details {
      display: none;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-subtle);
    }
    .event-card.expanded .event-details { display: block; }
    .event-raw {
      background: var(--bg-0);
      border-radius: 6px;
      padding: 12px;
      font-family: monospace;
      font-size: 0.8em;
      overflow-x: auto;
      white-space: pre-wrap;
    }

    /* ========================================
       CONTROLS SECTION
       ======================================== */
    .controls-section {
      background: var(--bg-2);
      border-radius: 10px;
      padding: 18px;
    }
    .controls-section h2 {
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 14px;
    }
    .control-grid {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .control-btn {
      background: var(--bg-0);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      color: var(--cyan);
      padding: 10px 16px;
      font-size: 0.85em;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .control-btn:hover {
      background: var(--cyan);
      color: #000;
    }
    .control-btn.loading {
      opacity: 0.6;
      pointer-events: none;
    }
    .control-btn.danger {
      color: var(--red);
    }
    .control-btn.danger:hover {
      background: var(--red);
      color: #fff;
    }
    .control-output {
      margin-top: 14px;
      padding: 12px;
      background: var(--bg-0);
      border-radius: 6px;
      font-family: monospace;
      font-size: 0.8em;
      display: none;
    }
    .control-output.visible { display: block; }

    /* ========================================
       EMPTY STATE
       ======================================== */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
    }
    .empty-state h2 {
      color: var(--text-secondary);
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <div class="dashboard">
    <!-- TOP NAVIGATION -->
    <nav class="topnav">
      <button class="menu-toggle" id="menuToggle">&#9776;</button>
      <span class="logo">pfSense Guardian</span>
      <select class="device-select" id="deviceSelect">
        ${deviceData.map((d: any, i: number) =>
          `<option value="${d.token}"${i === 0 ? ' selected' : ''}>${d.name}</option>`
        ).join('')}
      </select>
      <span class="topnav-spacer"></span>
      <div class="user-area">
        <span class="user-email">${req.userEmail}</span>
        <a href="/auth/logout" class="logout-btn">Logout</a>
      </div>
    </nav>

    <!-- SIDEBAR -->
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-section">
        <h3>Devices</h3>
        <ul class="device-list" id="deviceList">
          ${deviceData.map((d: any, i: number) => `
            <li class="${i === 0 ? 'active' : ''}" data-token="${d.token}">
              <span class="device-name">${d.name}</span>
              <span class="device-status">${d.timeSince}</span>
            </li>
          `).join('')}
        </ul>
      </div>
      <div class="sidebar-footer">
        <div class="refresh-indicator">
          <span class="live">&#9679;</span> Live &mdash; <span id="countdown">5:00</span>
        </div>
      </div>
    </aside>
    <div class="sidebar-overlay" id="sidebarOverlay"></div>

    <!-- MAIN CONTENT -->
    <main class="main" id="mainContent">
      ${deviceData.length === 0 ? `
        <div class="empty-state">
          <h2>No devices registered</h2>
          <p>Register a pfSense device to see metrics here.</p>
        </div>
      ` : `
        <!-- TOP RAIL KPIs -->
        <div class="toprail" id="toprail">
          <div class="kpi">
            <span class="kpi-label">Health</span>
            <span class="kpi-value good" id="kpiHealth">--</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Circuit</span>
            <span class="circuit-badge closed" id="kpiCircuit">CLOSED</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">A.L.A.N.</span>
            <span class="kpi-value good" id="kpiAlan">--%</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Gateway</span>
            <span class="kpi-value good" id="kpiGateway">--ms</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">States</span>
            <span class="kpi-value" id="kpiStates">--</span>
          </div>
        </div>

        <!-- PERIOD SELECTOR -->
        <div class="period-row">
          <span class="period-label">Period:</span>
          <button class="period-btn active" data-period="1h">1H</button>
          <button class="period-btn" data-period="4h">4H</button>
          <button class="period-btn" data-period="1d">1D</button>
          <button class="period-btn" data-period="1w">1W</button>
          <button class="period-btn" data-period="1m">1M</button>
        </div>

        <!-- METRICS GRID -->
        <div class="metrics-grid">
          <!-- RESOURCES -->
          <div class="metric-card" id="resourcesCard">
            <h3>System Resources</h3>
            <div class="resource-bar" id="cpuBar">
              <div class="bar-header">
                <span class="bar-label">CPU</span>
                <span class="bar-value">--%</span>
              </div>
              <div class="bar-track"><div class="bar-fill good" style="width:0%"></div></div>
              <div class="bar-chart"></div>
            </div>
            <div class="resource-bar" id="memoryBar">
              <div class="bar-header">
                <span class="bar-label">Memory</span>
                <span class="bar-value">--%</span>
              </div>
              <div class="bar-track"><div class="bar-fill good" style="width:0%"></div></div>
              <div class="bar-chart"></div>
            </div>
            <div class="resource-bar" id="diskBar">
              <div class="bar-header">
                <span class="bar-label">Disk</span>
                <span class="bar-value">--%</span>
              </div>
              <div class="bar-track"><div class="bar-fill good" style="width:0%"></div></div>
              <div class="bar-chart"></div>
            </div>
          </div>

          <!-- TRAFFIC -->
          <div class="metric-card" id="trafficCard">
            <h3>Network Traffic</h3>
            <div class="traffic-row">
              <span class="traffic-label">WAN</span>
              <span class="traffic-value" id="wanTraffic">-- Mbps</span>
            </div>
            <div class="traffic-chart" id="wanChart"></div>
            <div class="traffic-row" style="margin-top:16px">
              <span class="traffic-label">LAN</span>
              <span class="traffic-value" id="lanTraffic">-- Mbps</span>
            </div>
            <div class="traffic-chart" id="lanChart"></div>
          </div>

          <!-- GATEWAY -->
          <div class="metric-card" id="gatewayCard">
            <h3>Gateway Quality</h3>
            <div class="gateway-stats">
              <div class="gateway-stat">
                <div class="value good" id="gwLatency">--</div>
                <div class="label">Latency (ms)</div>
              </div>
              <div class="gateway-stat">
                <div class="value good" id="gwLoss">--</div>
                <div class="label">Packet Loss (%)</div>
              </div>
            </div>
            <div class="traffic-chart" id="gatewayChart" style="margin-top:16px"></div>
          </div>
        </div>

        <!-- EVENTS -->
        <div class="events-section">
          <div class="section-header">
            <h2>Recent Events</h2>
          </div>
          <div id="eventsList"></div>
        </div>

        <!-- CONTROLS -->
        <div class="controls-section">
          <h2>Device Controls</h2>
          <div class="control-grid">
            <button class="control-btn" data-action="ping">
              <span>&#9889;</span> Ping WAN
            </button>
            <button class="control-btn" data-action="diagnose">
              <span>&#128269;</span> Diagnose
            </button>
            <button class="control-btn danger" data-action="restart-dns">
              <span>&#8635;</span> Restart DNS
            </button>
          </div>
          <div class="control-output" id="controlOutput"></div>
        </div>
      `}
    </main>
  </div>

  <script>
    // ========================================
    // STATE
    // ========================================
    const State = {
      currentDevice: '${deviceData[0]?.token || ''}',
      selectedPeriod: '1h',
      refreshInterval: ${DEFAULT_REFRESH_INTERVAL},
      countdown: ${DEFAULT_REFRESH_INTERVAL / 1000},
      devices: ${JSON.stringify(deviceData)},
      rrdCache: {}
    };

    // ========================================
    // UTILITIES
    // ========================================
    function formatTimeSince(ts) {
      if (!ts) return 'never';
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.floor(hours / 24) + 'd ago';
    }

    function barClass(pct) {
      return pct > 80 ? 'bad' : pct > 50 ? 'warn' : 'good';
    }

    function renderAreaChart(data, color1, color2, height = 32) {
      if (!data || data.length < 2) return '';
      const w = 200, h = height, pad = 2;
      const max = Math.max(...data) || 1;
      const min = Math.min(...data) || 0;
      const range = max - min || 1;
      const stepX = (w - pad * 2) / (data.length - 1);

      const points = data.map((v, i) => {
        const x = pad + i * stepX;
        const y = h - pad - ((v - min) / range) * (h - pad * 2);
        return x + ',' + y;
      }).join(' ');

      const gradId = 'g' + Math.random().toString(36).slice(2, 8);
      return '<svg viewBox="0 0 ' + w + ' ' + h + '">' +
        '<defs><linearGradient id="' + gradId + '" x1="0%" y1="0%" x2="100%" y2="0%">' +
          '<stop offset="0%" stop-color="' + color1 + '" stop-opacity="0.4"/>' +
          '<stop offset="100%" stop-color="' + color2 + '" stop-opacity="0.4"/>' +
        '</linearGradient></defs>' +
        '<path d="M' + pad + ',' + (h - pad) + ' L' + points + ' L' + (w - pad) + ',' + (h - pad) + 'Z" fill="url(#' + gradId + ')"/>' +
        '<polyline points="' + points + '" fill="none" stroke="' + color2 + '" stroke-width="1.5" stroke-opacity="0.8"/>' +
      '</svg>';
    }

    function extractHistory(history, type) {
      if (!history || !history.length) return [];
      return history.slice().reverse().map(h => {
        const sys = h.metrics?.system || {};
        if (type === 'cpu') return sys.cpu?.usage_percent || 0;
        if (type === 'memory') return sys.memory?.usage_percent || 0;
        if (type === 'disk') return sys.disk?.usage_percent || 0;
        return 0;
      }).slice(-30);
    }

    // ========================================
    // UI UPDATES
    // ========================================
    function updateKPIs(metrics) {
      if (!metrics) return;

      const sys = metrics.system || {};
      const nev = metrics.neverhang || {};
      const alan = metrics.alan || {};
      const gw = metrics.gateway || {};

      // Health score (composite)
      const cpuPct = sys.cpu?.usage_percent || 0;
      const memPct = sys.memory?.usage_percent || 0;
      const successRate = typeof alan.success_rate_24h === 'number' ? alan.success_rate_24h : 1;
      const healthScore = Math.round((1 - Math.max(cpuPct, memPct) / 100 * 0.3) * successRate * 100);
      const healthEl = document.getElementById('kpiHealth');
      healthEl.textContent = healthScore + '%';
      healthEl.className = 'kpi-value ' + barClass(100 - healthScore);

      // Circuit
      const circuitEl = document.getElementById('kpiCircuit');
      const circuit = nev.circuit || 'closed';
      circuitEl.textContent = circuit.toUpperCase();
      circuitEl.className = 'circuit-badge ' + circuit;

      // A.L.A.N.
      const alanEl = document.getElementById('kpiAlan');
      const alanPct = Math.round(successRate * 100);
      alanEl.textContent = alanPct + '%';
      alanEl.className = 'kpi-value ' + (alanPct >= 90 ? 'good' : alanPct >= 70 ? 'warn' : 'bad');

      // Gateway
      const gwEl = document.getElementById('kpiGateway');
      const latency = gw.latency_ms || 0;
      gwEl.textContent = latency + 'ms';
      gwEl.className = 'kpi-value ' + (latency < 50 ? 'good' : latency < 100 ? 'warn' : 'bad');

      // States (if available)
      const statesEl = document.getElementById('kpiStates');
      statesEl.textContent = metrics.firewall_states || '--';
    }

    function updateResources(metrics, history) {
      if (!metrics) return;

      const sys = metrics.system || {};
      const bars = [
        { id: 'cpuBar', type: 'cpu', pct: sys.cpu?.usage_percent || 0 },
        { id: 'memoryBar', type: 'memory', pct: sys.memory?.usage_percent || 0 },
        { id: 'diskBar', type: 'disk', pct: sys.disk?.usage_percent || 0 }
      ];

      bars.forEach(bar => {
        const el = document.getElementById(bar.id);
        const cls = barClass(bar.pct);
        const colors = cls === 'bad' ? ['#ff4444', '#cc0000'] : cls === 'warn' ? ['#ffaa00', '#ff6600'] : ['#00ff88', '#00d9ff'];

        el.querySelector('.bar-value').textContent = Math.round(bar.pct) + '%';
        el.querySelector('.bar-fill').className = 'bar-fill ' + cls;
        el.querySelector('.bar-fill').style.width = bar.pct + '%';

        const histData = extractHistory(history, bar.type);
        el.querySelector('.bar-chart').innerHTML = renderAreaChart(histData, colors[0], colors[1]);
      });
    }

    function updateGateway(metrics) {
      if (!metrics) return;
      const gw = metrics.gateway || {};

      const latencyEl = document.getElementById('gwLatency');
      const latency = gw.latency_ms || 0;
      latencyEl.textContent = latency;
      latencyEl.className = 'value ' + (latency < 50 ? 'good' : latency < 100 ? 'warn' : 'bad');

      const lossEl = document.getElementById('gwLoss');
      const loss = gw.packet_loss || 0;
      lossEl.textContent = loss;
      lossEl.className = 'value ' + (loss < 1 ? 'good' : loss < 5 ? 'warn' : 'bad');
    }

    function updateEvents(events) {
      const container = document.getElementById('eventsList');
      if (!events || events.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:20px"><p>No events in the last 24 hours</p></div>';
        return;
      }

      container.innerHTML = events.map(e => {
        const hasDetails = e.raw_data && Object.keys(e.raw_data).length > 0;
        return '<div class="event-card" data-id="' + e.id + '">' +
          '<div class="event-header">' +
            '<span class="event-sev ' + e.severity + '"></span>' +
            '<span class="event-type">' + e.type + '</span>' +
            '<span class="event-time">' + e.time + '</span>' +
          '</div>' +
          '<div class="event-summary">' + e.summary + '</div>' +
          (hasDetails ? '<div class="event-details"><pre class="event-raw">' + JSON.stringify(e.raw_data, null, 2) + '</pre></div>' : '') +
        '</div>';
      }).join('');
    }

    // ========================================
    // DATA FETCHING
    // ========================================
    async function fetchStatus() {
      try {
        const res = await fetch('/api/dashboard/status');
        if (res.status === 401) {
          window.location.href = '/dashboard/login';
          return;
        }
        const data = await res.json();

        // Update state
        State.devices = data.devices;
        if (data.refreshInterval) {
          State.refreshInterval = data.refreshInterval;
        }

        // Find current device
        const device = data.devices.find(d => d.token === State.currentDevice) || data.devices[0];
        if (device) {
          updateKPIs(device.metrics);
          updateResources(device.metrics, device.metricsHistory);
          updateGateway(device.metrics);
        }

        updateEvents(data.events);

        // Update device list
        updateDeviceList(data.devices);

      } catch (err) {
        console.error('Fetch error:', err);
      }
    }

    async function fetchRrd(metric, period) {
      const cacheKey = metric + '-' + period;
      if (State.rrdCache[cacheKey]) {
        return State.rrdCache[cacheKey];
      }
      try {
        const res = await fetch('/api/dashboard/rrd/' + metric + '?period=' + period);
        if (!res.ok) return null;
        const data = await res.json();
        State.rrdCache[cacheKey] = data;
        return data;
      } catch (err) {
        console.error('RRD fetch error:', err);
        return null;
      }
    }

    async function executeAction(action) {
      const btn = document.querySelector('[data-action="' + action + '"]');
      if (!btn) return;

      btn.classList.add('loading');
      btn.disabled = true;

      try {
        const res = await fetch('/api/dashboard/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, device_token: State.currentDevice })
        });
        const data = await res.json();

        const output = document.getElementById('controlOutput');
        output.textContent = data.message || JSON.stringify(data, null, 2);
        output.classList.add('visible');
      } catch (err) {
        console.error('Action error:', err);
      } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    }

    function updateDeviceList(devices) {
      const list = document.getElementById('deviceList');
      list.innerHTML = devices.map(d =>
        '<li class="' + (d.token === State.currentDevice ? 'active' : '') + '" data-token="' + d.token + '">' +
          '<span class="device-name">' + d.name + '</span>' +
          '<span class="device-status">' + (d.timeSince || 'never') + '</span>' +
        '</li>'
      ).join('');
    }

    // ========================================
    // EVENT HANDLERS
    // ========================================
    function initEventHandlers() {
      // Sidebar toggle (mobile)
      document.getElementById('menuToggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
      });
      document.getElementById('sidebarOverlay').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
      });

      // Device select (dropdown)
      document.getElementById('deviceSelect').addEventListener('change', (e) => {
        State.currentDevice = e.target.value;
        fetchStatus();
        // Update sidebar active state
        document.querySelectorAll('.device-list li').forEach(li => {
          li.classList.toggle('active', li.dataset.token === State.currentDevice);
        });
      });

      // Device list (sidebar)
      document.getElementById('deviceList').addEventListener('click', (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        State.currentDevice = li.dataset.token;
        document.getElementById('deviceSelect').value = State.currentDevice;
        document.querySelectorAll('.device-list li').forEach(l => l.classList.remove('active'));
        li.classList.add('active');
        fetchStatus();
        document.getElementById('sidebar').classList.remove('open');
      });

      // Period selector
      document.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
          e.target.classList.add('active');
          State.selectedPeriod = e.target.dataset.period;
          State.rrdCache = {}; // Clear cache on period change
          fetchStatus();
        });
      });

      // Event cards (expand/collapse)
      document.getElementById('eventsList').addEventListener('click', (e) => {
        const card = e.target.closest('.event-card');
        if (card) card.classList.toggle('expanded');
      });

      // Control buttons
      document.querySelectorAll('.control-btn[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          executeAction(btn.dataset.action);
        });
      });
    }

    // ========================================
    // COUNTDOWN & REFRESH
    // ========================================
    function formatCountdown(secs) {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return m + ':' + String(s).padStart(2, '0');
    }

    function tick() {
      State.countdown--;
      if (State.countdown <= 0) {
        State.countdown = State.refreshInterval / 1000;
        fetchStatus();
      }
      document.getElementById('countdown').textContent = formatCountdown(State.countdown);
    }

    // ========================================
    // INIT
    // ========================================
    initEventHandlers();
    fetchStatus();
    setInterval(tick, 1000);
  </script>
</body>
</html>`);
});

// Logout
router.get("/auth/logout", (req: Request, res: Response) => {
  const sessionId = req.cookies?.pfsense_session;
  db.deleteSession(sessionId);
  res.clearCookie("pfsense_session");
  res.redirect("/dashboard/login");
});

export default router;
