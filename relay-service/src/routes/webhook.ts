/**
 * Webhook routes - receives emergency alerts from pfSense
 */

import { Router, Request, Response } from "express";
import * as db from "../db";
import * as crypto from "../crypto";
import { queueDiagnostic } from "../executor";

const router = Router();

// Replay protection window (5 minutes)
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * POST /emergency
 * Main webhook endpoint for pfSense alerts
 */
router.post("/emergency", async (req: Request, res: Response) => {
  try {
    const deviceToken = req.headers["x-device-token"] as string;
    const timestamp = req.headers["x-timestamp"] as string;
    const signature = req.headers["x-signature"] as string;

    // Validate required headers
    if (!deviceToken || !timestamp || !signature) {
      return res.status(400).json({
        error: "missing_headers",
        message: "Required headers: X-Device-Token, X-Timestamp, X-Signature",
      });
    }

    // Check timestamp freshness (replay protection)
    const timestampMs = parseInt(timestamp, 10);
    const now = Date.now();
    if (isNaN(timestampMs) || Math.abs(now - timestampMs) > TIMESTAMP_TOLERANCE_MS) {
      return res.status(401).json({
        error: "timestamp_invalid",
        message: "Timestamp too old or invalid",
      });
    }

    // Look up device
    const device = db.getDevice(deviceToken);
    if (!device) {
      return res.status(401).json({
        error: "device_not_found",
        message: "Device not registered. Visit /register to set up.",
      });
    }

    // Verify signature
    const payload = JSON.stringify(req.body);
    if (!crypto.verifySignature(payload, timestamp, signature, deviceToken)) {
      return res.status(401).json({
        error: "signature_invalid",
        message: "Webhook signature verification failed",
      });
    }

    // Update last seen
    db.updateDeviceLastSeen(deviceToken);

    // Parse event
    const { type, severity, summary, context } = req.body;

    if (!type || !summary) {
      return res.status(400).json({
        error: "invalid_payload",
        message: "Required fields: type, summary",
      });
    }

    // Store event
    const event = db.insertEvent(
      deviceToken,
      type,
      severity || "warning",
      summary,
      { context, received_at: new Date().toISOString() }
    );

    console.log(`[Webhook] Event ${event.id} from ${device.name || deviceToken.slice(0, 8)}: ${type} - ${summary}`);

    // Queue for diagnostic processing
    await queueDiagnostic(event, device);

    res.json({
      success: true,
      event_id: event.id,
      message: "Event received and queued for processing",
    });
  } catch (error) {
    console.error("[Webhook] Error:", error);
    res.status(500).json({
      error: "internal_error",
      message: "Failed to process webhook",
    });
  }
});

/**
 * POST /checkin
 * pfSense checks in to pick up pending commands
 */
router.post("/checkin", async (req: Request, res: Response) => {
  try {
    const deviceToken = req.headers["x-device-token"] as string;
    const timestamp = req.headers["x-timestamp"] as string;
    const signature = req.headers["x-signature"] as string;

    if (!deviceToken || !timestamp || !signature) {
      return res.status(400).json({ error: "missing_headers" });
    }

    const device = db.getDevice(deviceToken);
    if (!device) {
      return res.status(401).json({ error: "device_not_found" });
    }

    // Verify signature
    const payload = JSON.stringify(req.body || {});
    if (!crypto.verifySignature(payload, timestamp, signature, deviceToken)) {
      return res.status(401).json({ error: "signature_invalid" });
    }

    db.updateDeviceLastSeen(deviceToken);

    // Get pending commands
    const commands = db.getPendingCommands(deviceToken);

    // Process any command results from this request
    const results = req.body.results as Array<{ id: number; result: string }> | undefined;
    if (results && Array.isArray(results)) {
      for (const r of results) {
        db.markCommandExecuted(r.id, r.result);
        console.log(`[Checkin] Command ${r.id} executed: ${r.result.slice(0, 50)}...`);
      }
    }

    res.json({
      commands: commands.map((c) => ({
        id: c.id,
        command: c.command,
        source: c.source,
      })),
    });
  } catch (error) {
    console.error("[Checkin] Error:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /report
 * pfSense reports diagnostic results or status updates
 */
router.post("/report", async (req: Request, res: Response) => {
  try {
    const deviceToken = req.headers["x-device-token"] as string;

    if (!deviceToken) {
      return res.status(400).json({ error: "missing_token" });
    }

    const device = db.getDevice(deviceToken);
    if (!device) {
      return res.status(401).json({ error: "device_not_found" });
    }

    db.updateDeviceLastSeen(deviceToken);

    const { type, data } = req.body;

    console.log(`[Report] ${type} from ${device.name || deviceToken.slice(0, 8)}:`, data);

    // Store as event for audit trail
    db.insertEvent(deviceToken, `report_${type}`, "info", JSON.stringify(data).slice(0, 200), data);

    res.json({ success: true });
  } catch (error) {
    console.error("[Report] Error:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
