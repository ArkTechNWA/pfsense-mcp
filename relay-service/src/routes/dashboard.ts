/**
 * Dashboard routes with magic link auth
 *
 * Features:
 * - Magic link authentication with user-selectable session duration
 * - Auto-refreshing dashboard synced to device check-in intervals
 */

import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import * as db from "../db";
import * as alerter from "../alerter";

const router = Router();

// In-memory token store (ephemeral - clears on restart)
const authTokens = new Map<string, { email: string; expires: number; sessionDuration: number }>();
const sessions = new Map<string, { email: string; expires: number }>();

const TOKEN_EXPIRY = 60 * 60 * 1000;  // 1 hour for magic links

// Session duration options (in milliseconds)
const DURATION_OPTIONS: Record<string, { label: string; ms: number }> = {
  "1h":   { label: "1 hour",  ms: 60 * 60 * 1000 },
  "1d":   { label: "1 day",   ms: 24 * 60 * 60 * 1000 },
  "1w":   { label: "1 week",  ms: 7 * 24 * 60 * 60 * 1000 },
  "1y":   { label: "1 year",  ms: 365 * 24 * 60 * 60 * 1000 },
};

const DEFAULT_DURATION = "1d";
const DEFAULT_REFRESH_INTERVAL = 5 * 60 * 1000;  // 5 minutes (matches Guardian default)

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

  // Check if this email has any devices
  const devices = db.getDevicesByEmail(email);
  console.log("[Dashboard] Found devices:", devices?.length || 0);
  if (!devices || devices.length === 0) {
    return res.json({ success: true, message: "If this email has registered devices, a login link was sent." });
  }

  // Validate duration
  const selectedDuration = DURATION_OPTIONS[duration] ? duration : DEFAULT_DURATION;
  const sessionDuration = DURATION_OPTIONS[selectedDuration].ms;

  // Generate token
  const token = crypto.randomBytes(32).toString("hex");
  authTokens.set(token, { email, expires: Date.now() + TOKEN_EXPIRY, sessionDuration });

  // Send email
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

  // Create session with user-selected duration
  const sessionId = crypto.randomBytes(32).toString("hex");
  const sessionExpiry = Date.now() + auth.sessionDuration;
  sessions.set(sessionId, { email: auth.email, expires: sessionExpiry });
  authTokens.delete(token as string);

  // Set cookie and redirect
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
  const session = sessions.get(sessionId);

  if (!session || Date.now() > session.expires) {
    sessions.delete(sessionId);
    return res.redirect("/dashboard/login");
  }

  req.userEmail = session.email;
  next();
}

// API auth middleware (returns JSON instead of redirect)
function requireAuthAPI(req: AuthRequest, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.pfsense_session;
  const session = sessions.get(sessionId);

  if (!session || Date.now() > session.expires) {
    sessions.delete(sessionId);
    return res.status(401).json({ error: "unauthorized" });
  }

  req.userEmail = session.email;
  next();
}

// Login page with duration selection
router.get("/dashboard/login", (req: Request, res: Response) => {
  const error = req.query.error === "expired" ? "Link expired. Please request a new one." : "";

  const durationOptions = Object.entries(DURATION_OPTIONS)
    .map(([key, opt]) => `<option value="${key}"${key === DEFAULT_DURATION ? " selected" : ""}>${opt.label}</option>`)
    .join("");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>pfSense Guardian - Login</title>
  <meta name=viewport content=width=device-width,initial-scale=1>
  <style>
    body { font-family: system-ui; background: #1a1a2e; color: #eee; margin: 0; padding: 40px 20px; }
    .container { max-width: 400px; margin: 0 auto; }
    h1 { color: #00d9ff; }
    input, select { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #333; border-radius: 4px; background: #16213e; color: #eee; box-sizing: border-box; }
    select { cursor: pointer; }
    button { width: 100%; padding: 12px; background: #00d9ff; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
    button:hover { background: #00b8d4; }
    .msg { padding: 15px; background: #16213e; border-radius: 4px; margin: 20px 0; }
    .error { background: #4a1a1a; color: #ff8888; }
    label { color: #888; font-size: 0.9em; }
    .field { margin: 15px 0; }
  </style>
</head>
<body>
  <div class=container>
    <h1>pfSense Guardian</h1>
    <p>Enter your email to receive a login link.</p>
    ${error ? '<div class="msg error">' + error + '</div>' : ''}
    <form id=loginForm>
      <div class=field>
        <input type=email name=email placeholder=you@example.com required>
      </div>
      <div class=field>
        <label>Stay logged in for:</label>
        <select name=duration>${durationOptions}</select>
      </div>
      <button type=submit>Send Login Link</button>
    </form>
    <div id=msg class=msg style=display:none></div>
  </div>
  <script>
    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const email = e.target.email.value;
      const duration = e.target.duration.value;
      const msg = document.getElementById('msg');
      msg.style.display = 'block';
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
  if (mins < 60) return mins + " min ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + " hr ago";
  const days = Math.floor(hours / 24);
  return days + " day" + (days > 1 ? "s" : "") + " ago";
}

// API endpoint for RRD historical data
router.get("/api/dashboard/rrd/:metric", requireAuthAPI, (req: AuthRequest, res: Response) => {
  const devices = db.getDevicesByEmail(req.userEmail!);
  if (devices.length === 0) {
    return res.status(404).json({ error: "No devices found" });
  }

  // Get RRD data for user's first device (expand later for multi-device)
  const device = devices[0];
  const metric = req.params.metric;
  const rrdData = db.getRrdData(device.token, metric);

  if (rrdData.length === 0) {
    return res.status(404).json({ error: "No RRD data available for this metric" });
  }

  // Return all periods for this metric
  res.json({
    device: device.name || device.token.slice(0, 8),
    metric,
    periods: rrdData.map((r) => ({
      period: r.period,
      data: JSON.parse(r.data_json),
      updated_at: new Date(r.created_at).toISOString(),
    })),
  });
});

// API endpoint for all available RRD metrics
router.get("/api/dashboard/rrd", requireAuthAPI, (req: AuthRequest, res: Response) => {
  const devices = db.getDevicesByEmail(req.userEmail!);
  if (devices.length === 0) {
    return res.status(404).json({ error: "No devices found" });
  }

  const device = devices[0];
  const allRrd = db.getRrdData(device.token);

  // Group by metric
  const metrics: Record<string, string[]> = {};
  allRrd.forEach((r) => {
    if (!metrics[r.metric]) metrics[r.metric] = [];
    metrics[r.metric].push(r.period);
  });

  res.json({
    device: device.name || device.token.slice(0, 8),
    available_metrics: Object.entries(metrics).map(([metric, periods]) => ({ metric, periods })),
  });
});

// API endpoint for dashboard data (for auto-refresh)
router.get("/api/dashboard/status", requireAuthAPI, (req: AuthRequest, res: Response) => {
  const devices = db.getDevicesByEmail(req.userEmail!);
  const recentEvents = db.getRecentEventsByEmail(req.userEmail!, 20);

  // Fetch metrics for each device
  const deviceData = devices.map((d: any) => {
    const latestMetrics = db.getLatestMetrics(d.token);
    const metricsHistory = db.getMetricsHistory(d.token, 30);

    return {
      name: d.name || d.token.slice(0, 8),
      token: d.token,
      lastSeen: d.last_seen_at,
      lastSeenFormatted: d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "Waiting for check-in",
      timeSince: d.last_seen_at ? formatTimeSince(d.last_seen_at) : "",
      metrics: latestMetrics?.metrics || null,
      metricsHistory: metricsHistory.map(h => ({
        metrics: h.metrics,
        timestamp: h.created_at,
      })),
    };
  });

  const eventData = recentEvents.map((e: any) => ({
    severity: e.severity,
    type: e.event_type,
    summary: e.summary,
    time: new Date(e.created_at).toLocaleString(),
  }));

  res.json({
    timestamp: Date.now(),
    refreshInterval: DEFAULT_REFRESH_INTERVAL,
    devices: deviceData,
    events: eventData,
  });
});

// Dashboard with auto-refresh and NEVERHANG/ALAN metrics
router.get("/dashboard", requireAuth, (req: AuthRequest, res: Response) => {
  const devices = db.getDevicesByEmail(req.userEmail!);
  const recentEvents = db.getRecentEventsByEmail(req.userEmail!, 20);

  // Fetch metrics for initial render
  const deviceMetrics = devices.map((d: any) => {
    const latestMetrics = db.getLatestMetrics(d.token);
    return {
      ...d,
      name: d.name || d.token.slice(0, 8),
      metrics: latestMetrics?.metrics || null,
    };
  });

  const eventRows = recentEvents.map((e: any) => `
    <tr data-event>
      <td><span class=sev-${e.severity}>${e.severity}</span></td>
      <td>${e.event_type}</td>
      <td>${e.summary}</td>
      <td>${new Date(e.created_at).toLocaleString()}</td>
    </tr>
  `).join("");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>pfSense Guardian - Dashboard</title>
  <meta name=viewport content=width=device-width,initial-scale=1>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui; background: #1a1a2e; color: #eee; margin: 0; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #00d9ff; margin-bottom: 5px; }
    .email { color: #888; margin-bottom: 20px; }
    h2 { color: #00ff88; border-bottom: 1px solid #333; padding-bottom: 10px; margin-top: 30px; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
    th { background: #16213e; }
    .sev-critical { color: #ff4444; font-weight: bold; }
    .sev-warning { color: #ffaa00; }
    .sev-info { color: #00d9ff; }
    a { color: #00d9ff; }
    .logout { float: right; }
    .note { color: #666; font-size: 0.9em; margin-top: 10px; }
    .refresh-status { color: #666; font-size: 0.85em; text-align: right; margin-bottom: 20px; }
    .refresh-status .live { color: #00ff88; }

    /* Device cards */
    .device-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; }
    .device-card { background: #16213e; border-radius: 8px; padding: 20px; }
    .device-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
    .device-name { font-size: 1.3em; color: #00d9ff; }
    .device-seen { font-size: 0.85em; color: #666; }

    /* Metrics grid */
    .metrics-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 15px; }
    .metric-card { background: #0f3460; border-radius: 6px; padding: 12px; text-align: center; }
    .metric-value { font-size: 1.8em; font-weight: bold; }
    .metric-label { font-size: 0.75em; color: #888; margin-top: 4px; }
    .metric-good { color: #00ff88; }
    .metric-warn { color: #ffaa00; }
    .metric-bad { color: #ff4444; }

    /* Status cards */
    .status-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-top: 15px; }
    .status-card { background: #0f3460; border-radius: 6px; padding: 12px; }
    .status-title { font-size: 0.8em; color: #888; margin-bottom: 8px; }
    .status-main { font-size: 1.2em; }
    .status-detail { font-size: 0.75em; color: #666; margin-top: 4px; }

    /* Circuit states */
    .circuit-closed { color: #00ff88; }
    .circuit-open { color: #ff4444; }
    .circuit-half_open { color: #ffaa00; }

    /* Awaiting data */
    .awaiting { color: #666; font-style: italic; }
  </style>
</head>
<body>
  <div class=container>
    <a href=/auth/logout class=logout>Logout</a>
    <h1>pfSense Guardian</h1>
    <p class=email>${req.userEmail}</p>
    <p class=refresh-status>
      <span class=live>&#9679;</span> Live &mdash;
      Next refresh in <span id=countdown>5:00</span>
    </p>

    <div class="device-grid" id="deviceGrid">
      ${deviceMetrics.length === 0 ? '<p class="awaiting">No devices registered. <a href="/register">Register a device</a></p>' :
        deviceMetrics.map((d: any) => {
          const m = d.metrics || {};
          const sys = m.system || {};
          const nev = m.neverhang || {};
          const alan = m.alan || {};
          const cpuPct = sys.cpu?.usage_percent || 0;
          const memPct = sys.memory?.usage_percent || 0;
          const diskPct = sys.disk?.usage_percent || 0;
          const gaugeClass = (pct: number) => pct > 80 ? 'metric-bad' : pct > 50 ? 'metric-warn' : 'metric-good';
          const lastSeen = d.last_seen_at ? formatTimeSince(d.last_seen_at) : 'never';

          return `
          <div class="device-card" data-token="${d.token}">
            <div class="device-header">
              <span class="device-name">${d.name}</span>
              <span class="device-seen">Last seen: ${lastSeen}</span>
            </div>

            ${d.metrics ? `
            <div class="metrics-grid">
              <div class="metric-card">
                <div class="metric-value ${gaugeClass(cpuPct)}">${Math.round(cpuPct)}%</div>
                <div class="metric-label">CPU</div>
              </div>
              <div class="metric-card">
                <div class="metric-value ${gaugeClass(memPct)}">${Math.round(memPct)}%</div>
                <div class="metric-label">Memory</div>
              </div>
              <div class="metric-card">
                <div class="metric-value ${gaugeClass(diskPct)}">${Math.round(diskPct)}%</div>
                <div class="metric-label">Disk</div>
              </div>
            </div>

            <div class="status-row">
              <div class="status-card">
                <div class="status-title">NEVERHANG</div>
                <div class="status-main circuit-${nev.circuit || 'closed'}">${(nev.circuit || 'closed').toUpperCase()}</div>
                <div class="status-detail">${nev.failures || 0} failures • ${nev.recoveries || 0} recoveries</div>
              </div>
              <div class="status-card">
                <div class="status-title">A.L.A.N.</div>
                <div class="status-main">${alan.queries_24h || 0} queries</div>
                <div class="status-detail">${Math.round((alan.success_rate_24h || 1) * 100)}% success rate</div>
              </div>
            </div>
            ` : '<p class="awaiting">Awaiting metrics...</p>'}
          </div>`;
        }).join('')
      }
    </div>

    <h2>Recent Events</h2>
    <table id=eventsTable>
      <tr><th>Severity</th><th>Type</th><th>Summary</th><th>Time</th></tr>
      ${eventRows || "<tr><td colspan=4>No events yet</td></tr>"}
    </table>

    <p class=note>Events expire after 24 hours. Dashboard auto-refreshes every 5 minutes.</p>
  </div>
  <script>
    let refreshInterval = ${DEFAULT_REFRESH_INTERVAL};
    let countdown = refreshInterval / 1000;
    let countdownEl = document.getElementById('countdown');

    function formatCountdown(secs) {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return m + ':' + String(s).padStart(2, '0');
    }

    function formatTimeSince(ts) {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + ' min ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + ' hr ago';
      const days = Math.floor(hours / 24);
      return days + ' day' + (days > 1 ? 's' : '') + ' ago';
    }

    function gaugeClass(pct) {
      return pct > 80 ? 'metric-bad' : pct > 50 ? 'metric-warn' : 'metric-good';
    }

    function updateCountdown() {
      countdown--;
      if (countdown <= 0) {
        countdown = refreshInterval / 1000;
        fetchStatus();
      }
      countdownEl.textContent = formatCountdown(countdown);
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/dashboard/status');
        if (res.status === 401) {
          window.location.href = '/dashboard/login';
          return;
        }
        const data = await res.json();

        if (data.refreshInterval && data.refreshInterval !== refreshInterval) {
          refreshInterval = data.refreshInterval;
          countdown = refreshInterval / 1000;
        }

        // Update device cards
        const grid = document.getElementById('deviceGrid');
        grid.innerHTML = data.devices.length === 0
          ? '<p class="awaiting">No devices registered. <a href="/register">Register a device</a></p>'
          : data.devices.map(d => {
              const m = d.metrics || {};
              const sys = m.system || {};
              const nev = m.neverhang || {};
              const alan = m.alan || {};
              const cpuPct = sys.cpu?.usage_percent || 0;
              const memPct = sys.memory?.usage_percent || 0;
              const diskPct = sys.disk?.usage_percent || 0;
              const lastSeen = d.lastSeen ? formatTimeSince(d.lastSeen) : 'never';

              return '<div class="device-card" data-token="' + d.token + '">' +
                '<div class="device-header">' +
                  '<span class="device-name">' + d.name + '</span>' +
                  '<span class="device-seen">Last seen: ' + lastSeen + '</span>' +
                '</div>' +
                (d.metrics ? (
                  '<div class="metrics-grid">' +
                    '<div class="metric-card"><div class="metric-value ' + gaugeClass(cpuPct) + '">' + Math.round(cpuPct) + '%</div><div class="metric-label">CPU</div></div>' +
                    '<div class="metric-card"><div class="metric-value ' + gaugeClass(memPct) + '">' + Math.round(memPct) + '%</div><div class="metric-label">Memory</div></div>' +
                    '<div class="metric-card"><div class="metric-value ' + gaugeClass(diskPct) + '">' + Math.round(diskPct) + '%</div><div class="metric-label">Disk</div></div>' +
                  '</div>' +
                  '<div class="status-row">' +
                    '<div class="status-card">' +
                      '<div class="status-title">NEVERHANG</div>' +
                      '<div class="status-main circuit-' + (nev.circuit || 'closed') + '">' + (nev.circuit || 'closed').toUpperCase() + '</div>' +
                      '<div class="status-detail">' + (nev.failures || 0) + ' failures • ' + (nev.recoveries || 0) + ' recoveries</div>' +
                    '</div>' +
                    '<div class="status-card">' +
                      '<div class="status-title">A.L.A.N.</div>' +
                      '<div class="status-main">' + (alan.queries_24h || 0) + ' queries</div>' +
                      '<div class="status-detail">' + Math.round((alan.success_rate_24h || 1) * 100) + '% success rate</div>' +
                    '</div>' +
                  '</div>'
                ) : '<p class="awaiting">Awaiting metrics...</p>') +
              '</div>';
            }).join('');

        // Update events table
        const evtTable = document.getElementById('eventsTable');
        const evtRows = data.events.map(e =>
          '<tr data-event><td><span class="sev-' + e.severity + '">' + e.severity + '</span></td>' +
          '<td>' + e.type + '</td><td>' + e.summary + '</td><td>' + e.time + '</td></tr>'
        ).join('') || '<tr><td colspan=4>No events yet</td></tr>';
        evtTable.innerHTML = '<tr><th>Severity</th><th>Type</th><th>Summary</th><th>Time</th></tr>' + evtRows;

      } catch (err) {
        console.error('Failed to refresh:', err);
      }
    }

    setInterval(updateCountdown, 1000);
  </script>
</body>
</html>`);
});

// Logout
router.get("/auth/logout", (req: Request, res: Response) => {
  const sessionId = req.cookies?.pfsense_session;
  sessions.delete(sessionId);
  res.clearCookie("pfsense_session");
  res.redirect("/dashboard/login");
});

export default router;
