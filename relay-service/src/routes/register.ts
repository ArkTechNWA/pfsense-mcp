/**
 * Device registration routes
 */

import { Router, Request, Response } from "express";
import * as db from "../db";
import * as crypto from "../crypto";

const router = Router();

/**
 * GET /register
 * Show registration page (simple HTML form)
 */
router.get("/register", (req: Request, res: Response) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>pfSense Emergency Relay - Register</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #00d9ff; }
    form { background: #16213e; padding: 20px; border-radius: 8px; }
    label { display: block; margin: 15px 0 5px; color: #aaa; }
    input, textarea { width: 100%; padding: 10px; border: 1px solid #333; border-radius: 4px; background: #0f0f23; color: #fff; box-sizing: border-box; }
    input:focus, textarea:focus { border-color: #00d9ff; outline: none; }
    button { background: #00d9ff; color: #000; border: none; padding: 12px 24px; border-radius: 4px; cursor: pointer; margin-top: 20px; font-weight: bold; }
    button:hover { background: #00b8d4; }
    .note { font-size: 0.85em; color: #888; margin-top: 5px; }
    code { background: #0f0f23; padding: 2px 6px; border-radius: 3px; }
    .success { background: #1b4332; padding: 15px; border-radius: 4px; margin: 20px 0; }
    .success code { display: block; margin: 10px 0; padding: 10px; white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>
  <h1>pfSense Emergency Relay</h1>
  <p>Register your pfSense device to receive emergency Claude diagnostics.</p>

  <form method="POST" action="/register">
    <label for="device_token">Device Token</label>
    <input type="text" id="device_token" name="device_token" required
           placeholder="Paste token from pfSense pkg">
    <p class="note">Run <code>cat /usr/local/etc/pfsense-relay/token</code> on pfSense</p>

    <label for="email">Email Address</label>
    <input type="email" id="email" name="email" required
           placeholder="you@example.com">
    <p class="note">Emergency alerts and diagnostic reports will be sent here</p>

    <label for="api_key">Anthropic API Key</label>
    <input type="password" id="api_key" name="api_key" required
           placeholder="sk-ant-...">
    <p class="note">Your key is encrypted and only used for your device's diagnostics</p>

    <label for="name">Device Name (optional)</label>
    <input type="text" id="name" name="name"
           placeholder="home-router">
    <p class="note">Friendly name to identify this device</p>

    <button type="submit">Register Device</button>
  </form>
</body>
</html>
  `);
});

/**
 * POST /register
 * Process device registration
 */
router.post("/register", (req: Request, res: Response) => {
  try {
    const { device_token, email, api_key, name } = req.body;

    if (!device_token || !email || !api_key) {
      return res.status(400).send(`
        <h1>Missing Fields</h1>
        <p>Device token, email, and API key are required.</p>
        <a href="/register">Try again</a>
      `);
    }

    // Validate API key format
    if (!api_key.startsWith("sk-ant-")) {
      return res.status(400).send(`
        <h1>Invalid API Key</h1>
        <p>Anthropic API keys start with 'sk-ant-'.</p>
        <a href="/register">Try again</a>
      `);
    }

    // Encrypt API key
    const encryptedKey = crypto.encryptApiKey(api_key, device_token);

    // Register device
    const device = db.registerDevice(
      device_token,
      email,
      encryptedKey,
      name || undefined
    );

    console.log(`[Register] Device registered: ${device.name || device.token.slice(0, 8)} (${email})`);

    res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Registration Complete</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #00ff88; }
    .success { background: #1b4332; padding: 15px; border-radius: 4px; margin: 20px 0; }
    code { background: #0f0f23; padding: 2px 6px; border-radius: 3px; display: block; margin: 10px 0; padding: 10px; white-space: pre-wrap; }
    .note { color: #888; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>Registration Complete!</h1>

  <div class="success">
    <p><strong>Device:</strong> ${device.name || "Unnamed"}</p>
    <p><strong>Email:</strong> ${device.email}</p>
    <p><strong>Token:</strong> ${device.token.slice(0, 8)}...${device.token.slice(-8)}</p>
  </div>

  <h2>Next Steps</h2>
  <p>Configure your pfSense pkg with this relay URL:</p>
  <code>RELAY_URL="${req.protocol}://${req.get("host")}"</code>

  <p>Test the connection:</p>
  <code>pfsense-relay-test</code>

  <p class="note">Emergency alerts will be sent to ${device.email}</p>
</body>
</html>
    `);
  } catch (error) {
    console.error("[Register] Error:", error);
    res.status(500).send(`
      <h1>Registration Failed</h1>
      <p>An error occurred. Please try again.</p>
      <a href="/register">Try again</a>
    `);
  }
});

/**
 * GET /device/:token
 * Check device status (limited info, no sensitive data)
 */
router.get("/device/:token", (req: Request, res: Response) => {
  const device = db.getDevice(req.params.token);

  if (!device) {
    return res.status(404).json({ error: "device_not_found" });
  }

  res.json({
    name: device.name,
    email: device.email.replace(/(.{2}).*@/, "$1***@"),
    registered_at: new Date(device.created_at).toISOString(),
    last_seen: device.last_seen_at ? new Date(device.last_seen_at).toISOString() : null,
    recent_events: db.getRecentEvents(device.token, 5).length,
  });
});

export default router;
