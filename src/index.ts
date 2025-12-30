/**
 * pfsense-mcp - MCP server for pfSense
 *
 * Bidirectional AI control of your firewall with NEVERHANG reliability
 * and A.L.A.N. persistent learning.
 *
 * @author Claude (claude@arktechnwa.com) + Meldrey
 * @license MIT
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";

import { initDatabase, closeDatabase } from "./db.js";
import { NeverhangManager, NeverhangError } from "./neverhang.js";
import { PfSenseClient } from "./pfsense-client.js";
import { TOOLS } from "./tools/index.js";

const SERVER_NAME = "pfsense-mcp";
const SERVER_VERSION = "0.1.0";

// Global state
let db: Database.Database;
let client: PfSenseClient;
let neverhang: NeverhangManager;

/**
 * Execute a tool with NEVERHANG protection
 */
async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  // Check circuit breaker
  const canExecute = neverhang.canExecute();
  if (!canExecute.allowed) {
    throw new NeverhangError("circuit_open", canExecute.reason || "Circuit open", 0);
  }

  const { timeout_ms } = neverhang.getTimeout(name);
  const start = Date.now();

  try {
    const result = await executeToolInner(name, args, timeout_ms);
    const duration = Date.now() - start;
    neverhang.recordSuccess(name, duration);
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    const errorType = error instanceof NeverhangError ? error.type : "api_error";
    neverhang.recordFailure(name, duration, errorType);
    throw error;
  }
}

/**
 * Inner tool execution (route to handlers)
 */
async function executeToolInner(
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  switch (name) {
    // ========================================================================
    // HEALTH
    // ========================================================================
    case "pf_health": {
      const stats = neverhang.getStats();
      const alanStats = neverhang.getDatabaseStats();

      // Try a quick ping
      let pingResult: { ok: boolean; latency_ms: number } = { ok: false, latency_ms: 0 };
      try {
        pingResult = await neverhang.health.ping();
      } catch {
        // Ping failed, already recorded
      }

      return {
        pfsense: {
          reachable: pingResult.ok,
          latency_ms: pingResult.latency_ms,
          host: client.getBaseUrl(),
        },
        neverhang: {
          status: stats.status,
          circuit: stats.circuit,
          circuit_opens_in_seconds: stats.circuit_opens_in
            ? Math.ceil(stats.circuit_opens_in / 1000)
            : null,
          latency_p95_ms: stats.latency_p95_ms,
          recent_failures: stats.recent_failures,
          uptime_percent: neverhang.getUptimePercent(),
        },
        alan: alanStats
          ? {
              queries_24h: alanStats.queries_24h,
              success_rate_24h: Math.round(alanStats.success_rate_24h * 100) + "%",
              avg_latency_by_complexity: alanStats.avg_latency_by_complexity,
              health_trend: alanStats.health_trend,
            }
          : null,
      };
    }

    // ========================================================================
    // SYSTEM
    // ========================================================================
    case "pf_system_info": {
      const response = await client.getSystemInfo();
      return response.data;
    }

    case "pf_system_status": {
      const response = await client.getSystemStatus();
      const data = response.data;
      if (!data) return { error: "No data returned" };

      return {
        uptime_seconds: data.uptime,
        uptime_human: formatUptime(data.uptime),
        datetime: data.datetime,
        cpu: {
          usage_percent: data.cpu.usage,
          temperature_c: data.cpu.temperature,
        },
        memory: {
          total_mb: Math.round(data.memory.total / 1024 / 1024),
          used_mb: Math.round(data.memory.used / 1024 / 1024),
          usage_percent: data.memory.usage,
        },
        disk: {
          total_gb: Math.round(data.disk.total / 1024 / 1024 / 1024),
          used_gb: Math.round(data.disk.used / 1024 / 1024 / 1024),
          usage_percent: data.disk.usage,
        },
      };
    }

    // ========================================================================
    // INTERFACES
    // ========================================================================
    case "pf_interface_list": {
      const response = await client.getInterfaces();
      return response.data;
    }

    case "pf_interface_status": {
      const iface = args.interface as string;
      if (!iface) throw new Error("interface parameter required");
      const response = await client.getInterfaceStatus(iface);
      return response.data;
    }

    // ========================================================================
    // FIREWALL
    // ========================================================================
    case "pf_firewall_rules": {
      const response = await client.getFirewallRules();
      let rules = response.data || [];

      // Filter by interface if specified
      const iface = args.interface as string | undefined;
      if (iface) {
        rules = rules.filter((r) => r.interface === iface);
      }

      return rules.map((r) => ({
        id: r.id,
        type: r.type,
        interface: r.interface,
        protocol: r.protocol,
        source: r.source,
        destination: r.destination,
        description: r.descr,
        disabled: r.disabled || false,
      }));
    }

    case "pf_firewall_states": {
      const response = await client.getFirewallStates();
      const limit = (args.limit as number) || 100;
      const states = (response.data || []).slice(0, limit);

      return states.map((s) => ({
        interface: s.interface,
        protocol: s.protocol,
        source: s.src,
        destination: s.dst,
        state: s.state,
        age: s.age,
        packets: s.pkts,
        bytes: s.bytes,
      }));
    }

    // ========================================================================
    // DHCP
    // ========================================================================
    case "pf_dhcp_leases": {
      const response = await client.getDhcpLeases();
      let leases = response.data || [];

      // Filter by status
      const status = args.status as string | undefined;
      if (status && status !== "all") {
        leases = leases.filter((l) => l.status === status);
      }

      return leases.map((l) => ({
        ip: l.ip,
        mac: l.mac,
        hostname: l.hostname || "(unknown)",
        status: l.status,
        type: l.type,
        start: l.start,
        end: l.end,
      }));
    }

    // ========================================================================
    // GATEWAYS
    // ========================================================================
    case "pf_gateway_status": {
      const response = await client.getGatewayStatus();
      return (response.data || []).map((g) => ({
        name: g.name,
        gateway: g.gateway,
        monitor: g.monitor,
        status: g.status,
        latency_ms: g.delay,
        stddev_ms: g.stddev,
        loss_percent: g.loss,
      }));
    }

    // ========================================================================
    // SERVICES
    // ========================================================================
    case "pf_services_list": {
      const response = await client.getServices();
      return (response.data || []).map((s) => ({
        name: s.name,
        description: s.description,
        enabled: s.enabled,
        status: s.status,
      }));
    }

    // ========================================================================
    // DIAGNOSTICS
    // ========================================================================
    case "pf_diag_ping": {
      const host = args.host as string;
      if (!host) throw new Error("host parameter required");
      const count = Math.min((args.count as number) || 3, 10);
      const response = await client.ping_host(host, count);
      return response.data;
    }

    case "pf_diag_arp": {
      const response = await client.arpTable();
      return (response.data || []).map((e) => ({
        ip: e.ip,
        mac: e.mac,
        interface: e.interface,
        hostname: e.hostname,
        type: e.type,
      }));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);

  return parts.join(" ") || "< 1m";
}

/**
 * Main entry point
 */
async function main() {
  // Initialize A.L.A.N. database
  db = initDatabase();

  // Initialize pfSense client
  try {
    client = new PfSenseClient();
    console.error(`[pfsense-mcp] Configured for ${client.getBaseUrl()}`);
  } catch (error) {
    console.error("[pfsense-mcp] Warning: PFSENSE_HOST not set, tools will fail until configured");
    // Create a dummy client that will fail on use
    client = new PfSenseClient({ host: "unconfigured" });
  }

  // Initialize NEVERHANG with health ping
  neverhang = new NeverhangManager(
    {},
    async () => {
      await client.ping();
    },
    db
  );
  neverhang.start();

  // Create MCP server
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await executeTool(name, (args as Record<string, unknown>) || {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof NeverhangError
          ? `${error.type}: ${error.message}\n${error.suggestion}`
          : error instanceof Error
          ? error.message
          : "Unknown error";

      return {
        content: [
          {
            type: "text",
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.error("[pfsense-mcp] Shutting down...");
    neverhang.stop();
    closeDatabase(db);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[pfsense-mcp] v${SERVER_VERSION} running with NEVERHANG + A.L.A.N.`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
