/**
 * Alert dispatcher - sends notifications to device owners
 *
 * Supports email with reply capability (RINGTWICE pattern)
 */

import nodemailer from "nodemailer";
import * as db from "../db";
import * as crypto from "../crypto";

// Email configuration from environment
const SMTP_HOST = process.env.SMTP_HOST || "localhost";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || "relay@pfsense-mcp.arktechnwa.com";
const RELAY_DOMAIN = process.env.RELAY_DOMAIN || "pfsense-mcp.arktechnwa.com";

// Create transporter
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

/**
 * Send alert email to device owner
 */
export async function sendAlert(
  device: db.Device,
  event: db.Event,
  diagnosticResult: string
): Promise<void> {
  // Generate alert hash for dedup
  const alertHash = crypto.hashAlert(event.event_type, event.summary);

  // Check if we already sent this alert recently
  if (!db.shouldSendAlert(device.token, event.event_type, alertHash)) {
    console.log(`[Alerter] Skipping duplicate alert for ${event.event_type}`);
    return;
  }

  // Build email
  const subject = buildSubject(event);
  const body = buildBody(device, event, diagnosticResult);
  const replyTo = buildReplyTo(device.token);

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: device.email,
      replyTo: replyTo,
      subject: subject,
      text: body,
      html: buildHtmlBody(device, event, diagnosticResult, replyTo),
    });

    // Record that we sent this alert
    db.recordAlertSent(device.token, event.event_type, alertHash);

    console.log(`[Alerter] Sent ${event.severity} alert to ${device.email}`);
  } catch (error) {
    console.error(`[Alerter] Failed to send email:`, error);
  }
}

/**
 * Build email subject
 */
function buildSubject(event: db.Event): string {
  const severityEmoji: Record<string, string> = {
    critical: "🔴",
    warning: "🟡",
    info: "🔵",
  };

  const emoji = severityEmoji[event.severity] || "⚪";
  return `${emoji} [pfSense] ${event.event_type}: ${event.summary.slice(0, 50)}`;
}

/**
 * Build plain text email body
 */
function buildBody(device: db.Device, event: db.Event, diagnosticResult: string): string {
  return `
pfSense Emergency Alert
========================

Device: ${device.name || "Unnamed"}
Event: ${event.event_type}
Severity: ${event.severity.toUpperCase()}
Time: ${new Date(event.created_at).toISOString()}

Summary:
${event.summary}

--- Claude Diagnostic ---

${diagnosticResult}

--- Reply Commands ---

You can reply to this email with commands:

  restart dhcp     - Restart DHCP service
  restart dns      - Restart DNS resolver
  status           - Get current status
  help             - List available commands

Commands will be queued and executed on next pfSense check-in.

---
pfsense-mcp.arktechnwa.com
`;
}

/**
 * Build HTML email body
 */
function buildHtmlBody(
  device: db.Device,
  event: db.Event,
  diagnosticResult: string,
  replyTo: string
): string {
  const severityColor: Record<string, string> = {
    critical: "#dc3545",
    warning: "#ffc107",
    info: "#17a2b8",
  };

  const color = severityColor[event.severity] || "#6c757d";

  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: system-ui, sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; }
    .header { background: ${color}; color: #fff; padding: 20px; }
    .header h1 { margin: 0; font-size: 1.2em; }
    .meta { background: #f8f9fa; padding: 15px 20px; border-bottom: 1px solid #dee2e6; }
    .meta table { width: 100%; }
    .meta td { padding: 5px 0; }
    .meta td:first-child { font-weight: bold; width: 100px; }
    .content { padding: 20px; }
    .diagnostic { background: #1a1a2e; color: #e0e0e0; padding: 15px; border-radius: 4px; white-space: pre-wrap; font-family: monospace; font-size: 0.9em; }
    .commands { background: #e7f5ff; padding: 15px; border-radius: 4px; margin-top: 20px; }
    .commands code { background: #d0ebff; padding: 2px 6px; border-radius: 3px; }
    .footer { background: #f8f9fa; padding: 15px 20px; text-align: center; color: #666; font-size: 0.85em; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>pfSense Emergency Alert</h1>
    </div>

    <div class="meta">
      <table>
        <tr><td>Device:</td><td>${device.name || "Unnamed"}</td></tr>
        <tr><td>Event:</td><td>${event.event_type}</td></tr>
        <tr><td>Severity:</td><td>${event.severity.toUpperCase()}</td></tr>
        <tr><td>Time:</td><td>${new Date(event.created_at).toLocaleString()}</td></tr>
      </table>
    </div>

    <div class="content">
      <h3>Summary</h3>
      <p>${event.summary}</p>

      <h3>Claude Diagnostic</h3>
      <div class="diagnostic">${escapeHtml(diagnosticResult)}</div>

      <div class="commands">
        <strong>Reply Commands</strong>
        <p>Reply to this email with commands:</p>
        <ul>
          <li><code>restart dhcp</code> - Restart DHCP service</li>
          <li><code>restart dns</code> - Restart DNS resolver</li>
          <li><code>status</code> - Get current status</li>
          <li><code>help</code> - List available commands</li>
        </ul>
      </div>
    </div>

    <div class="footer">
      Reply to: ${replyTo}<br>
      <a href="https://pfsense-mcp.arktechnwa.com">pfsense-mcp.arktechnwa.com</a>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Build reply-to address for command routing
 */
function buildReplyTo(deviceToken: string): string {
  // Use plus addressing for routing
  const shortToken = deviceToken.slice(0, 16);
  return `relay+${shortToken}@${RELAY_DOMAIN}`;
}

/**
 * Process incoming email reply (called by email poller)
 */
export async function processEmailReply(
  fromAddress: string,
  toAddress: string,
  subject: string,
  body: string
): Promise<void> {
  console.log(`[Alerter] Processing email reply from ${fromAddress}`);

  // Extract device token from to address
  const match = toAddress.match(/relay\+([a-f0-9]+)@/i);
  if (!match) {
    console.log(`[Alerter] Could not extract device token from ${toAddress}`);
    return;
  }

  const shortToken = match[1];

  // Find device by partial token match
  // (We stored full token, need to query with LIKE)
  // For now, this is a limitation - we'd need to store the short token mapping
  console.log(`[Alerter] Looking for device with token starting: ${shortToken}`);

  // Extract command from body (first line, stripped)
  const command = body.split("\n")[0].trim().toLowerCase();

  if (!command) {
    console.log(`[Alerter] No command found in email body`);
    return;
  }

  console.log(`[Alerter] Command received: ${command}`);

  // TODO: Look up full device token and queue command
  // db.queueCommand(fullToken, command, "email");
}

/**
 * Escape HTML entities
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/\n/g, "<br>");
}

/**
 * Verify SMTP connection
 */
export async function verifySmtp(): Promise<boolean> {
  try {
    await transporter.verify();
    console.log("[Alerter] SMTP connection verified");
    return true;
  } catch (error) {
    console.error("[Alerter] SMTP verification failed:", error);
    return false;
  }
}

// Magic link for dashboard login
export async function sendMagicLink(email: string, loginUrl: string, durationLabel?: string): Promise<void> {
  const sessionInfo = durationLabel ? `Session will last ${durationLabel}.` : "Session will last 1 day.";

  const mailOptions = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'pfSense Guardian - Login Link',
    text: `Click here to log in to your Guardian dashboard:\n\n${loginUrl}\n\nThis link expires in 1 hour. ${sessionInfo}\n\nIf you didn't request this, ignore this email.`,
    html: `
      <h2>pfSense Guardian Login</h2>
      <p>Click the link below to access your dashboard:</p>
      <p><a href="${loginUrl}" style="display:inline-block;background:#00d9ff;color:#000;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:bold;">Log In</a></p>
      <p style="color:#888;font-size:0.9em;">This link expires in 1 hour. ${sessionInfo}</p>
      <p style="color:#888;font-size:0.9em;">If you didn't request this, ignore this email.</p>
    `
  };

  await transporter.sendMail(mailOptions);
}
