/**
 * Guardian v2 routes - push-based caching architecture
 *
 * Guardian on pfSense pushes data to relay based on manifest.
 * MCP clients query relay instead of pfSense directly.
 * A.L.A.N. learns patterns and adjusts manifest.
 */

import { Router, Request, Response } from "express";
import * as db from "../db";
import * as crypto from "../crypto";
import type {
  GuardianPushPayload,
  HotPushPayload,
  WarmPushPayload,
  QueryResponse,
} from "../types/cache";

const router = Router();

// =============================================================================
// MANIFEST ENDPOINT (Guardian fetches this to know what to collect)
// =============================================================================

/**
 * GET /api/v2/manifest
 * Guardian fetches its manifest to know what data to push and at what interval
 */
router.get("/api/v2/manifest", (req: Request, res: Response) => {
  try {
    const deviceToken = req.headers["x-device-token"] as string;

    if (!deviceToken) {
      return res.status(400).json({
        error: "missing_token",
        message: "X-Device-Token header required",
      });
    }

    const device = db.getDevice(deviceToken);
    if (!device) {
      // Auto-create device for first-time manifest fetch
      console.log(`[Guardian v2] New device manifest request: ${deviceToken.slice(0, 8)}...`);
    }

    const manifest = db.getDeviceManifest(deviceToken);

    // Also return any pending write commands
    const pendingCommands = db.getPendingCommands(deviceToken);

    res.json({
      manifest,
      pending_commands: pendingCommands.map((c) => ({
        id: c.id,
        tool: c.command,
        params: {},
        queued_at: c.created_at,
      })),
    });
  } catch (error) {
    console.error("[Guardian v2] Manifest error:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

// =============================================================================
// PUSH ENDPOINT (Guardian pushes collected data here)
// =============================================================================

/**
 * POST /api/v2/push
 * Guardian pushes hot/warm data collected from pfSense
 */
router.post("/api/v2/push", async (req: Request, res: Response) => {
  try {
    const deviceToken = req.headers["x-device-token"] as string;
    const timestamp = req.headers["x-timestamp"] as string;
    const signature = req.headers["x-signature"] as string;

    if (!deviceToken || !timestamp || !signature) {
      return res.status(400).json({
        error: "missing_headers",
        message: "Required headers: X-Device-Token, X-Timestamp, X-Signature",
      });
    }

    // Verify device exists (or auto-create)
    let device = db.getDevice(deviceToken);
    if (!device) {
      // Auto-create device for Guardian pushes
      device = db.registerDevice(
        deviceToken,
        "guardian-auto@local",
        "none",
        deviceToken.slice(0, 20),
        undefined
      );
      console.log(`[Guardian v2] Auto-registered device: ${deviceToken.slice(0, 8)}...`);
    }

    // Verify signature
    const payload = JSON.stringify(req.body);
    if (!crypto.verifySignature(payload, timestamp, signature, deviceToken)) {
      return res.status(401).json({
        error: "signature_invalid",
        message: "Push signature verification failed",
      });
    }

    db.updateDeviceLastSeen(deviceToken);

    const pushData = req.body as GuardianPushPayload;

    if (!pushData.meta) {
      return res.status(400).json({
        error: "invalid_payload",
        message: "Missing meta field in push payload",
      });
    }

    // Get current manifest to calculate TTLs
    const manifest = db.getDeviceManifest(deviceToken);

    // Store hot data if present
    if (pushData.hot) {
      const hotTtlMs = manifest.hot.interval_seconds * 2 * 1000; // 2x interval
      db.storeHotCache(deviceToken, pushData.hot, hotTtlMs);
      console.log(`[Guardian v2] Hot cache updated: ${deviceToken.slice(0, 8)}...`);
    }

    // Store warm data if present
    if (pushData.warm) {
      const warmTtlMs = manifest.warm.interval_seconds * 2 * 1000;
      db.storeWarmCache(deviceToken, pushData.warm, warmTtlMs);
      console.log(`[Guardian v2] Warm cache updated: ${deviceToken.slice(0, 8)}...`);
    }

    // Update manifest version tracking
    if (pushData.meta.guardian_version || pushData.meta.manifest_version) {
      db.updateDeviceManifest(deviceToken, manifest, pushData.meta.guardian_version);
    }

    res.json({
      success: true,
      cached: {
        hot: !!pushData.hot,
        warm: !!pushData.warm,
      },
      next_push: {
        hot_in_seconds: manifest.hot.interval_seconds,
        warm_in_seconds: manifest.warm.interval_seconds,
      },
    });
  } catch (error) {
    console.error("[Guardian v2] Push error:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

// =============================================================================
// QUERY ENDPOINTS (MCP clients query cached data here)
// =============================================================================

/**
 * GET /api/v2/query/:tool
 * MCP clients query for specific pfSense data
 */
router.get("/api/v2/query/:tool", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const { tool } = req.params;
  const deviceToken = (req.query.device_token as string) || (req.headers["x-device-token"] as string);
  const source = (req.headers["x-client-id"] as string) || "unknown";

  try {
    if (!deviceToken) {
      return res.status(400).json({
        success: false,
        error: "missing_device_token",
        cache_info: { cached: false },
      });
    }

    let response: QueryResponse;

    // Route query to appropriate data source
    switch (tool) {
      // Hot data (system, gateways, interfaces)
      case "system_status":
      case "pf_system_status":
        response = queryHotData(deviceToken, "system");
        break;

      case "gateway_status":
      case "pf_gateway_status":
        response = queryHotData(deviceToken, "gateways");
        break;

      case "interface_list":
      case "interface_status":
      case "pf_interface_list":
      case "pf_interface_status":
        response = queryHotData(deviceToken, "interfaces", req.query.interface as string);
        break;

      // Warm data (services, DHCP, ARP)
      case "services_list":
      case "pf_services_list":
        response = queryWarmData(deviceToken, "services");
        break;

      case "dhcp_leases":
      case "pf_dhcp_leases":
        response = queryWarmData(deviceToken, "dhcp_leases");
        break;

      case "diag_arp":
      case "pf_diag_arp":
        response = queryWarmData(deviceToken, "arp_table");
        break;

      // System info (hot data subset)
      case "system_info":
      case "pf_system_info":
        response = queryHotData(deviceToken, "system_info");
        break;

      default:
        // Unknown tool - record the query for A.L.A.N. to learn
        response = {
          success: false,
          error: `Tool '${tool}' not cached. Guardian may need manifest update.`,
          cache_info: { cached: false },
        };
    }

    // Record query for A.L.A.N. learning
    const latency = Date.now() - startTime;
    db.recordQuery(tool, deviceToken, latency, source);

    res.json(response);
  } catch (error) {
    console.error(`[Guardian v2] Query error (${tool}):`, error);
    res.status(500).json({
      success: false,
      error: "internal_error",
      cache_info: { cached: false },
    });
  }
});

/**
 * Query hot data from cache
 */
function queryHotData(deviceToken: string, field: string, subfield?: string): QueryResponse {
  const cached = db.getCachedData(deviceToken, "hot");

  if (!cached) {
    return {
      success: false,
      error: "Hot data not cached. Guardian may not be pushing.",
      cache_info: { cached: false },
    };
  }

  const hotData = cached.data as HotPushPayload;
  let data: unknown;

  switch (field) {
    case "system":
      data = hotData.system;
      break;
    case "system_info":
      // Extract just the static system info
      data = hotData.system
        ? {
            hostname: "pfSense", // Guardian should push this
            platform: hotData.system.platform,
            version: hotData.system.version,
          }
        : null;
      break;
    case "gateways":
      data = hotData.gateways;
      break;
    case "interfaces":
      if (subfield && hotData.interfaces) {
        data = hotData.interfaces[subfield] || null;
      } else {
        data = hotData.interfaces;
      }
      break;
    default:
      data = null;
  }

  if (!data) {
    return {
      success: false,
      error: `Field '${field}' not present in hot cache`,
      cache_info: {
        cached: true,
        cached_at: cached.cached_at,
        ttl_remaining_ms: cached.ttl_remaining_ms,
        source: cached.source as "guardian_push" | "relay_pull" | "direct",
      },
    };
  }

  return {
    success: true,
    data,
    cache_info: {
      cached: true,
      cached_at: cached.cached_at,
      ttl_remaining_ms: cached.ttl_remaining_ms,
      source: cached.source as "guardian_push" | "relay_pull" | "direct",
    },
  };
}

/**
 * Query warm data from cache
 */
function queryWarmData(deviceToken: string, field: string): QueryResponse {
  const cached = db.getCachedData(deviceToken, "warm");

  if (!cached) {
    return {
      success: false,
      error: "Warm data not cached. Guardian may not be pushing.",
      cache_info: { cached: false },
    };
  }

  const warmData = cached.data as WarmPushPayload;
  let data: unknown;

  switch (field) {
    case "services":
      data = warmData.services;
      break;
    case "dhcp_leases":
      data = warmData.dhcp_leases;
      break;
    case "arp_table":
      data = warmData.arp_table;
      break;
    default:
      data = null;
  }

  if (!data) {
    return {
      success: false,
      error: `Field '${field}' not present in warm cache`,
      cache_info: {
        cached: true,
        cached_at: cached.cached_at,
        ttl_remaining_ms: cached.ttl_remaining_ms,
        source: cached.source as "guardian_push" | "relay_pull" | "direct",
      },
    };
  }

  return {
    success: true,
    data,
    cache_info: {
      cached: true,
      cached_at: cached.cached_at,
      ttl_remaining_ms: cached.ttl_remaining_ms,
      source: cached.source as "guardian_push" | "relay_pull" | "direct",
    },
  };
}

// =============================================================================
// A.L.A.N. ENDPOINTS (learning and manifest adjustment)
// =============================================================================

/**
 * GET /api/v2/alan/stats
 * View A.L.A.N. query statistics
 */
router.get("/api/v2/alan/stats", (req: Request, res: Response) => {
  try {
    const stats = db.getQueryStats();
    const promotions = db.getRecentPromotions(10);
    const cacheStats = db.getCacheStats();

    res.json({
      query_stats: stats,
      recent_promotions: promotions,
      cache: cacheStats,
    });
  } catch (error) {
    console.error("[A.L.A.N.] Stats error:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /api/v2/alan/promote
 * Manually trigger a promotion decision (admin/debugging)
 */
router.post("/api/v2/alan/promote", (req: Request, res: Response) => {
  try {
    const { tool, from_category, to_category, reason } = req.body;

    if (!tool || !to_category || !reason) {
      return res.status(400).json({
        error: "missing_fields",
        message: "Required: tool, to_category, reason",
      });
    }

    db.recordPromotion(tool, from_category || null, to_category, reason, 1.0);

    // TODO: Actually update manifest when promotion happens
    console.log(`[A.L.A.N.] Manual promotion: ${tool} → ${to_category}`);

    res.json({ success: true });
  } catch (error) {
    console.error("[A.L.A.N.] Promote error:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

// =============================================================================
// HEALTH/DEBUG ENDPOINTS
// =============================================================================

/**
 * GET /api/v2/health
 * Guardian v2 health check
 */
router.get("/api/v2/health", (req: Request, res: Response) => {
  try {
    const cacheStats = db.getCacheStats();

    res.json({
      status: "ok",
      version: "2.0.0",
      cache: cacheStats,
      architecture: "guardian-push",
    });
  } catch (error) {
    console.error("[Guardian v2] Health error:", error);
    res.status(500).json({ status: "error" });
  }
});

/**
 * GET /api/v2/cache/:device_token
 * Debug: view cached data for a device
 */
router.get("/api/v2/cache/:device_token", (req: Request, res: Response) => {
  try {
    const { device_token } = req.params;

    const hot = db.getCachedData(device_token, "hot");
    const warm = db.getCachedData(device_token, "warm");
    const manifest = db.getDeviceManifest(device_token);

    res.json({
      device_token,
      hot: hot
        ? {
            cached_at: new Date(hot.cached_at).toISOString(),
            ttl_remaining_ms: hot.ttl_remaining_ms,
            source: hot.source,
            data_keys: Object.keys(hot.data),
          }
        : null,
      warm: warm
        ? {
            cached_at: new Date(warm.cached_at).toISOString(),
            ttl_remaining_ms: warm.ttl_remaining_ms,
            source: warm.source,
            data_keys: Object.keys(warm.data),
          }
        : null,
      manifest,
    });
  } catch (error) {
    console.error("[Guardian v2] Cache debug error:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

// =============================================================================
// COMMAND QUEUE ENDPOINTS (for WRITE operations)
// =============================================================================

/**
 * POST /api/v2/command
 * MCP clients queue a command for Guardian to execute
 */
router.post("/api/v2/command", (req: Request, res: Response) => {
  try {
    const deviceToken = (req.body.device_token as string) || (req.headers["x-device-token"] as string);
    const { tool, params } = req.body;
    const source = (req.headers["x-client-id"] as string) || "mcp-client";

    if (!deviceToken) {
      return res.status(400).json({
        error: "missing_device_token",
        message: "device_token required in body or X-Device-Token header",
      });
    }

    if (!tool) {
      return res.status(400).json({
        error: "missing_tool",
        message: "tool parameter required",
      });
    }

    // Validate allowed commands (whitelist WRITE operations)
    const allowedTools = [
      "pf_service_start",
      "pf_service_stop",
      "pf_service_restart",
      "pf_diag_ping",
    ];

    if (!allowedTools.includes(tool)) {
      return res.status(400).json({
        error: "invalid_tool",
        message: `Tool '${tool}' not allowed for remote execution. Allowed: ${allowedTools.join(", ")}`,
      });
    }

    // Serialize the command with params
    const commandPayload = JSON.stringify({ tool, params: params || {} });
    const command = db.queueCommand(deviceToken, commandPayload, source);

    console.log(`[Guardian v2] Command queued: ${tool} for ${deviceToken.slice(0, 8)}... (id: ${command.id})`);

    res.json({
      success: true,
      command_id: command.id,
      tool,
      params: params || {},
      status: "pending",
      message: "Command queued. Guardian will execute on next check-in.",
    });
  } catch (error) {
    console.error("[Guardian v2] Command queue error:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * GET /api/v2/command/:id
 * Check status of a queued command
 */
router.get("/api/v2/command/:id", (req: Request, res: Response) => {
  try {
    const commandId = parseInt(req.params.id, 10);

    if (isNaN(commandId)) {
      return res.status(400).json({ error: "invalid_command_id" });
    }

    const command = db.getCommandById(commandId);

    if (!command) {
      return res.status(404).json({ error: "command_not_found" });
    }

    // Parse command JSON
    let parsed: { tool?: string; params?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(command.command);
    } catch {
      parsed = { tool: command.command };
    }

    res.json({
      id: command.id,
      tool: parsed.tool || command.command,
      params: parsed.params || {},
      status: command.status,
      result: command.result,
      queued_at: command.created_at,
      executed_at: command.executed_at,
    });
  } catch (error) {
    console.error("[Guardian v2] Command status error:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /api/v2/command/:id/result
 * Guardian reports command execution result
 */
router.post("/api/v2/command/:id/result", (req: Request, res: Response) => {
  try {
    const commandId = parseInt(req.params.id, 10);
    const deviceToken = req.headers["x-device-token"] as string;
    const { success, result, error: execError } = req.body;

    if (isNaN(commandId)) {
      return res.status(400).json({ error: "invalid_command_id" });
    }

    if (!deviceToken) {
      return res.status(400).json({ error: "missing_device_token" });
    }

    // Mark command as executed
    const resultJson = JSON.stringify({
      success: success ?? !execError,
      result: result || null,
      error: execError || null,
      reported_at: Date.now(),
    });

    db.markCommandExecuted(commandId, resultJson);

    console.log(`[Guardian v2] Command ${commandId} executed: ${success ? "success" : "failed"}`);

    res.json({ success: true });
  } catch (error) {
    console.error("[Guardian v2] Command result error:", error);
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
