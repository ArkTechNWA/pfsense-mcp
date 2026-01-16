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

import { initDatabase, closeDatabase, getRrdCache, setRrdCache } from "./db.js";
import { NeverhangManager, NeverhangError } from "./neverhang.js";
import { PfSenseClient } from "./pfsense-client.js";
import { TOOLS } from "./tools/index.js";

const SERVER_NAME = "pfsense-mcp";
const SERVER_VERSION = "0.1.1";

// Guardian relay configuration
const GUARDIAN_RELAY_URL = process.env.GUARDIAN_RELAY_URL || "https://pfsense-mcp.arktechnwa.com";
const GUARDIAN_ADMIN_KEY = process.env.GUARDIAN_ADMIN_KEY || "";
const DEVICE_TOKEN = process.env.PFSENSE_DEVICE_TOKEN || "default";

// Guardian v2: Prefer relay cache over direct pfSense queries
const USE_RELAY_CACHE = process.env.PFSENSE_USE_RELAY_CACHE !== "false";
const MCP_CLIENT_ID = `pfsense-mcp-${process.pid}`;

// Global state
let db: Database.Database;
let client: PfSenseClient;
let neverhang: NeverhangManager;

// RRD metric configuration
// RRD metric definitions with column indices and transform functions
// Each metric specifies which columns to use and how to compute the final value
const RRD_METRIC_MAP: Record<string, {
  file: string;
  transform: (values: number[]) => number;
  description: string;
}> = {
  cpu: {
    file: "system-processor.rrd",
    // Columns: user(0), nice(1), system(2), interrupt(3), processes(4)
    // Sum user + nice + system + interrupt, skip processes (it's a count, not %)
    transform: (v) => (v[0] || 0) + (v[1] || 0) + (v[2] || 0) + (v[3] || 0),
    description: "CPU usage %"
  },
  memory: {
    file: "system-memory.rrd",
    // Columns: active(0), inactive(1), free(2), cache(3), wire(4), userwire(5), laundry(6), buffers(7)
    // Used memory = 100 - free
    transform: (v) => 100 - (v[2] || 0),
    description: "Memory usage %"
  },
  states: {
    file: "system-states.rrd",
    // Columns: pfrate(0), pfstates(1), pfnat(2), srcip(3), dstip(4)
    // Use pfstates (index 1) - the actual connection count
    transform: (v) => v[1] || 0,
    description: "Firewall states count"
  },
  traffic_lan: {
    file: "lan-traffic.rrd",
    // Sum inpass + outpass for total throughput (bytes/sec)
    transform: (v) => (v[0] || 0) + (v[1] || 0),
    description: "LAN traffic bytes/sec"
  },
  traffic_wan: {
    file: "wan-traffic.rrd",
    // Sum inpass + outpass for total throughput (bytes/sec)
    transform: (v) => (v[0] || 0) + (v[1] || 0),
    description: "WAN traffic bytes/sec"
  },
  gateway_quality: {
    file: "WAN_DHCP-quality.rrd",
    // Columns: loss(0), delay(1) - use delay (latency in ms)
    transform: (v) => v[1] || 0,
    description: "Gateway latency ms"
  },
};

const RRD_PERIOD_MAP: Record<string, string> = {
  "1h": "end-1h",
  "4h": "end-4h",
  "1d": "end-1d",
  "1w": "end-1w",
  "1m": "end-1m",
};

// Delay between RRD fetches to avoid CPU spikes on ARM
const RRD_FETCH_DELAY_MS = 500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// =============================================================================
// RRD INCREMENTAL SYNC (immutable historical data)
// =============================================================================

interface RrdPoint {
  timestamp: number;
  value: number;
}

/**
 * Get last timestamps from relay (what we already have)
 */
async function getRelayLastTimestamps(): Promise<Record<string, number>> {
  if (!GUARDIAN_ADMIN_KEY || !GUARDIAN_RELAY_URL) return {};

  try {
    const res = await fetch(`${GUARDIAN_RELAY_URL}/api/admin/points/${DEVICE_TOKEN}/last`, {
      headers: { "X-Admin-Key": GUARDIAN_ADMIN_KEY },
    });
    if (!res.ok) return {};
    const data = await res.json() as { last_timestamps: Record<string, number> };
    return data.last_timestamps || {};
  } catch {
    return {};
  }
}

/**
 * Fetch RRD data from pfSense since a timestamp
 * Returns timestamp/value pairs for incremental sync
 */
async function fetchRrdDataSince(metric: string, sinceTs?: number): Promise<RrdPoint[]> {
  const config = RRD_METRIC_MAP[metric];
  if (!config) throw new Error(`Unknown metric: ${metric}`);

  // If we have a last timestamp, start from there; otherwise get 1 month of history
  const startTime = sinceTs ? Math.floor(sinceTs / 1000) : "end-1m";

  // Use nice to reduce CPU priority
  console.error(`[RRD] Fetching ${metric} since ${sinceTs ? new Date(sinceTs).toISOString() : "1 month ago"}...`);
  const cmdResponse = await client.runCommand(
    `nice -n 19 rrdtool fetch /var/db/rrd/${config.file} AVERAGE --start ${startTime}`
  );

  const output = cmdResponse.data?.output || "";
  if (!output) return [];

  // Parse rrdtool output: "timestamp: value1 value2 ..."
  const lines = output.trim().split("\n");
  const points: RrdPoint[] = [];

  for (const line of lines) {
    // Skip header line and lines with all NaN
    if (!line.includes(":") || line.includes("nan nan nan")) continue;

    const match = line.match(/^(\d+):\s+(.+)$/);
    if (!match) continue;

    const timestamp = parseInt(match[1]) * 1000; // Convert to ms
    const rawValues = match[2].trim().split(/\s+/);

    // Parse all values into numbers
    const values: number[] = rawValues.map(v => {
      const val = parseFloat(v);
      return (!isNaN(val) && isFinite(val)) ? val : 0;
    });

    // Check if we have any valid data (not all zeros from NaN)
    const hasValid = rawValues.some(v => !v.includes("nan"));

    // Apply metric-specific transform
    const result = config.transform(values);

    // Only include points newer than sinceTs (if provided) and with valid data
    if (hasValid && (!sinceTs || timestamp > sinceTs)) {
      points.push({ timestamp, value: result });
    }
  }

  console.error(`[RRD] Fetched ${metric}: ${points.length} new points`);
  return points;
}

/**
 * Push new points to relay (incremental)
 */
async function pushPointsToRelay(metric: string, points: RrdPoint[]): Promise<number> {
  if (!GUARDIAN_ADMIN_KEY || !GUARDIAN_RELAY_URL || points.length === 0) return 0;

  const res = await fetch(`${GUARDIAN_RELAY_URL}/api/admin/points`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": GUARDIAN_ADMIN_KEY,
    },
    body: JSON.stringify({
      device_token: DEVICE_TOKEN,
      metric,
      points,
    }),
  });

  if (!res.ok) {
    console.error(`[RRD] Failed to push ${metric}: ${res.status}`);
    return 0;
  }

  const data = await res.json() as { inserted: number };
  console.error(`[RRD] Pushed ${metric}: ${data.inserted} new points stored`);
  return data.inserted;
}

/**
 * Incremental sync: fetch only new data since last relay timestamp
 */
async function syncRrdData(): Promise<{ synced: number; points: number }> {
  if (!GUARDIAN_ADMIN_KEY || !GUARDIAN_RELAY_URL) {
    return { synced: 0, points: 0 };
  }

  // Get what relay already has
  const lastTimestamps = await getRelayLastTimestamps();
  const metrics = Object.keys(RRD_METRIC_MAP);

  let totalSynced = 0;
  let totalPoints = 0;

  for (let i = 0; i < metrics.length; i++) {
    const metric = metrics[i];
    const lastTs = lastTimestamps[metric];

    try {
      const points = await fetchRrdDataSince(metric, lastTs);
      if (points.length > 0) {
        const inserted = await pushPointsToRelay(metric, points);
        totalPoints += inserted;
        totalSynced++;
      }
    } catch (err) {
      console.error(`[RRD] Error syncing ${metric}:`, err);
    }

    // Gentle delay between fetches (skip after last one)
    if (i < metrics.length - 1) {
      await sleep(RRD_FETCH_DELAY_MS);
    }
  }

  return { synced: totalSynced, points: totalPoints };
}

// =============================================================================
// LEGACY BLOB FUNCTIONS (for backward compatibility during migration)
// =============================================================================

/**
 * Fetch RRD data from pfSense (LEGACY - blob per period)
 */
async function fetchRrdData(metric: string, period: string): Promise<number[]> {
  const config = RRD_METRIC_MAP[metric];
  if (!config) throw new Error(`Unknown metric: ${metric}`);

  const timeSpec = RRD_PERIOD_MAP[period];
  if (!timeSpec) throw new Error(`Unknown period: ${period}`);

  const cmdResponse = await client.runCommand(
    `nice -n 19 rrdtool fetch /var/db/rrd/${config.file} AVERAGE --start ${timeSpec}`
  );

  const output = cmdResponse.data?.output || "";
  if (!output) throw new Error("No data returned from rrdtool");

  const lines = output.trim().split("\n");
  const dataLines = lines.filter((l) => l.includes(":") && !l.includes("nan nan nan"));

  const values: number[] = [];
  for (const line of dataLines) {
    const parts = line.trim().split(/\s+/);
    let sum = 0;
    for (let i = 1; i < parts.length; i++) {
      const val = parseFloat(parts[i]);
      if (!isNaN(val)) sum += val;
    }
    if (sum > 0 || parts.length > 1) values.push(sum);
  }

  return values;
}

/**
 * Push RRD data to Guardian relay (LEGACY - blob per period)
 */
async function pushRrdToRelay(metric: string, period: string, data: number[]): Promise<void> {
  if (!GUARDIAN_ADMIN_KEY || !GUARDIAN_RELAY_URL) return;

  await fetch(`${GUARDIAN_RELAY_URL}/api/admin/rrd`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": GUARDIAN_ADMIN_KEY,
    },
    body: JSON.stringify({
      device_token: DEVICE_TOKEN,
      metric,
      period,
      data,
    }),
  });
}

/**
 * Check for pending commands and execute them
 */
async function checkAndExecuteCommands(): Promise<{ checked: boolean; executed: number; error?: string }> {
  if (!GUARDIAN_ADMIN_KEY || !GUARDIAN_RELAY_URL) {
    return { checked: false, executed: 0, error: "missing_env_vars" };
  }

  try {
    // Check in with relay to get pending commands
    const checkinRes = await fetch(`${GUARDIAN_RELAY_URL}/api/admin/checkin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": GUARDIAN_ADMIN_KEY,
      },
      body: JSON.stringify({ device_token: DEVICE_TOKEN, results: [] }),
    });

    if (!checkinRes.ok) {
      return { checked: false, executed: 0, error: `checkin_failed_${checkinRes.status}` };
    }

    const checkinData = await checkinRes.json() as { commands?: Array<{ id: number; command: string }> };
    const commands = checkinData.commands;
    if (!commands || commands.length === 0) {
      return { checked: true, executed: 0 };
    }

    const results: Array<{ id: number; result: string }> = [];

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      try {
        // Handle fetch-rrd commands
        if (cmd.command.startsWith("fetch-rrd:")) {
          const [, metric, period] = cmd.command.split(":");
          const data = await fetchRrdData(metric, period);
          await pushRrdToRelay(metric, period, data);
          results.push({ id: cmd.id, result: "success" });

          // Gentle delay between fetches to avoid CPU spikes on ARM
          if (i < commands.length - 1) {
            await sleep(RRD_FETCH_DELAY_MS);
          }
        } else {
          results.push({ id: cmd.id, result: "unknown_command" });
        }
      } catch (err) {
        results.push({ id: cmd.id, result: `error: ${err instanceof Error ? err.message : err}` });
      }
    }

    // Report results back to relay
    if (results.length > 0) {
      await fetch(`${GUARDIAN_RELAY_URL}/api/admin/checkin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": GUARDIAN_ADMIN_KEY,
        },
        body: JSON.stringify({ device_token: DEVICE_TOKEN, results }),
      });
    }
    return { checked: true, executed: results.filter(r => r.result === "success").length };
  } catch (err) {
    return { checked: false, executed: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// =============================================================================
// GUARDIAN V2 RELAY QUERY
// =============================================================================

interface RelayQueryResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  cache_info: {
    cached: boolean;
    cached_at?: number;
    ttl_remaining_ms?: number;
    source?: string;
  };
}

/**
 * Query the relay cache for a tool's data
 * Returns null if relay doesn't have cached data or is unavailable
 */
async function queryRelayCache<T>(tool: string): Promise<{ data: T; cache_info: RelayQueryResponse["cache_info"] } | null> {
  if (!USE_RELAY_CACHE || !GUARDIAN_RELAY_URL) {
    return null;
  }

  try {
    const url = new URL(`/api/v2/query/${tool}`, GUARDIAN_RELAY_URL);
    url.searchParams.set("device_token", DEVICE_TOKEN);

    const response = await fetch(url.toString(), {
      headers: {
        "X-Device-Token": DEVICE_TOKEN,
        "X-Client-Id": MCP_CLIENT_ID,
      },
      signal: AbortSignal.timeout(5000), // 5 second timeout for relay
    });

    if (!response.ok) {
      console.error(`[Relay] Query ${tool} failed: ${response.status}`);
      return null;
    }

    const result = await response.json() as RelayQueryResponse<T>;

    if (result.success && result.data) {
      console.error(`[Relay] Cache hit for ${tool} (TTL: ${result.cache_info.ttl_remaining_ms}ms)`);
      return { data: result.data, cache_info: result.cache_info };
    }

    console.error(`[Relay] Cache miss for ${tool}: ${result.error || "no data"}`);
    return null;
  } catch (error) {
    console.error(`[Relay] Query ${tool} error:`, error);
    return null;
  }
}

interface CommandQueueResponse {
  success: boolean;
  command_id?: number;
  status?: string;
  result?: unknown;
  error?: string;
}

/**
 * Queue a WRITE command through the relay for Guardian to execute
 * Returns command_id for async tracking, or polls for result if waitForResult=true
 */
async function queueRelayCommand(
  tool: string,
  params: Record<string, unknown>,
  waitForResult: boolean = false,
  timeoutMs: number = 30000
): Promise<CommandQueueResponse | null> {
  if (!USE_RELAY_CACHE || !GUARDIAN_RELAY_URL) {
    return null;
  }

  try {
    // Queue the command
    const queueUrl = new URL("/api/v2/command", GUARDIAN_RELAY_URL);
    const queueResponse = await fetch(queueUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Token": DEVICE_TOKEN,
        "X-Client-Id": MCP_CLIENT_ID,
      },
      body: JSON.stringify({
        device_token: DEVICE_TOKEN,
        tool,
        params,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!queueResponse.ok) {
      const error = await queueResponse.json() as { error?: string; message?: string };
      console.error(`[Relay] Command queue failed: ${error.message || error.error}`);
      return null;
    }

    const queued = await queueResponse.json() as CommandQueueResponse;
    console.error(`[Relay] Command queued: ${tool} (id: ${queued.command_id})`);

    if (!waitForResult) {
      return queued;
    }

    // Poll for result
    const startTime = Date.now();
    const statusUrl = new URL(`/api/v2/command/${queued.command_id}`, GUARDIAN_RELAY_URL);

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Poll every 1s

      const statusResponse = await fetch(statusUrl.toString(), {
        headers: {
          "X-Device-Token": DEVICE_TOKEN,
          "X-Client-Id": MCP_CLIENT_ID,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!statusResponse.ok) continue;

      const status = await statusResponse.json() as CommandQueueResponse;

      if (status.status === "executed") {
        console.error(`[Relay] Command ${queued.command_id} completed`);
        return status;
      }
    }

    console.error(`[Relay] Command ${queued.command_id} timed out waiting for result`);
    return { success: false, command_id: queued.command_id, status: "timeout", error: "Command queued but execution timed out" };
  } catch (error) {
    console.error(`[Relay] Command queue error:`, error);
    return null;
  }
}

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

      // Get system status for dashboard
      let systemData: Record<string, unknown> = {};
      try {
        const sysResponse = await client.getSystemStatus();
        const sysRaw = sysResponse.data as unknown as Record<string, unknown>;
        if (sysRaw) {
          systemData = {
            uptime: sysRaw.uptime ?? null,
            platform: sysRaw.platform ?? null,
            cpu: {
              model: sysRaw.cpu_model ?? null,
              count: sysRaw.cpu_count ?? null,
              usage_percent: sysRaw.cpu_usage ?? null,
              temperature_c: sysRaw.temp_c ?? null,
            },
            memory: { usage_percent: sysRaw.mem_usage ?? null },
            disk: { usage_percent: sysRaw.disk_usage ?? null },
          };
        }
      } catch {
        // System status failed, continue without it
      }

      // Get interface data
      let interfaceData: Record<string, unknown> = {};
      try {
        const ifResponse = await client.getInterfaceStatuses();
        const ifList = (ifResponse.data || []) as unknown as Array<Record<string, unknown>>;
        for (const iface of ifList) {
          const name = (iface.name || iface.descr || 'unknown') as string;
          interfaceData[name.toLowerCase()] = {
            status: iface.status,
            ipaddr: iface.ipaddr,
            inbytes: iface.inbytes,
            outbytes: iface.outbytes,
            inpkts: iface.inpkts,
            outpkts: iface.outpkts,
          };
        }
      } catch {
        // Interface status failed, continue without it
      }

      const healthData = {
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
        system: systemData,
        interfaces: interfaceData,
      };

      // Push metrics to Guardian relay (fire and forget)
      if (GUARDIAN_ADMIN_KEY && GUARDIAN_RELAY_URL) {
        fetch(`${GUARDIAN_RELAY_URL}/api/admin/metrics`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Key": GUARDIAN_ADMIN_KEY,
          },
          body: JSON.stringify({
            device_token: DEVICE_TOKEN,
            metrics: healthData,
          }),
        }).catch(() => {
          // Silently fail - don't break health check for relay issues
        });

        // Incremental RRD sync - fetch only new data since last relay timestamp
        // Niced and eased to be gentle on the ARM CPU
        let syncStatus: { synced: number; points: number; error?: string } = { synced: 0, points: 0 };
        try {
          syncStatus = await syncRrdData();
        } catch (err) {
          console.error("[RRD] Error in syncRrdData:", err);
          syncStatus = { synced: 0, points: 0, error: err instanceof Error ? err.message : String(err) };
        }
        (healthData as Record<string, unknown>).rrd_sync = syncStatus;

        // Check for pending commands (legacy - still needed for restart-dns etc)
        let commandStatus: { checked: boolean; executed: number; error?: string } = { checked: false, executed: 0, error: "not_run" };
        try {
          commandStatus = await checkAndExecuteCommands();
        } catch (err) {
          console.error("[Commands] Error in checkAndExecuteCommands:", err);
          commandStatus = { checked: false, executed: 0, error: err instanceof Error ? err.message : String(err) };
        }
        (healthData as Record<string, unknown>).commands = commandStatus;
      }

      return healthData;
    }

    // ========================================================================
    // SYSTEM
    // ========================================================================
    case "pf_system_info": {
      // Try relay cache first
      const cached = await queryRelayCache<{ hostname?: string; platform?: string; version?: string }>("pf_system_info");
      if (cached) {
        return { ...cached.data, _source: "relay_cache" };
      }

      // Fall back to direct pfSense query
      const response = await client.getSystemInfo();
      return response.data;
    }

    case "pf_system_status": {
      // Try relay cache first (Guardian v2 pushes this as hot data)
      interface SystemStatusCache {
        uptime?: string;
        uptime_seconds?: number;
        platform?: string;
        version?: string;
        cpu?: { model?: string; count?: number; usage_percent?: number; load_avg?: number[]; temperature_c?: number | null };
        memory?: { usage_percent?: number; total_mb?: number; used_mb?: number };
        disk?: { usage_percent?: number; total_gb?: number; used_gb?: number };
      }
      const cached = await queryRelayCache<SystemStatusCache>("pf_system_status");
      if (cached) {
        const d = cached.data;
        return {
          uptime: d.uptime ?? null,
          platform: d.platform ?? null,
          cpu: d.cpu ?? null,
          memory: d.memory ?? null,
          disk: d.disk ?? null,
          _source: "relay_cache",
        };
      }

      // Fall back to direct pfSense query
      const response = await client.getSystemStatus();
      const data = response.data as unknown as Record<string, unknown>;
      if (!data) return { error: "No data returned" };

      // v2 API returns flat structure, not nested
      return {
        uptime: data.uptime ?? null,
        platform: data.platform ?? null,
        cpu: {
          model: data.cpu_model ?? null,
          count: data.cpu_count ?? null,
          usage_percent: data.cpu_usage ?? null,
          load_avg: data.cpu_load_avg ?? null,
          temperature_c: data.temp_c ?? null,
        },
        memory: {
          usage_percent: data.mem_usage ?? null,
        },
        swap: {
          usage_percent: data.swap_usage ?? null,
        },
        disk: {
          usage_percent: data.disk_usage ?? null,
        },
        mbuf_usage: data.mbuf_usage ?? null,
      };
    }

    // ========================================================================
    // INTERFACES
    // ========================================================================
    case "pf_interface_list": {
      // Try relay cache first
      type InterfaceListCache = Record<string, unknown>;
      const cached = await queryRelayCache<InterfaceListCache>("pf_interface_list");
      if (cached) {
        // Convert from object to array format
        const interfaces = Object.values(cached.data);
        return interfaces.length > 0 ? interfaces : cached.data;
      }

      // Fall back to direct pfSense query
      const response = await client.getInterfaces();
      return response.data;
    }

    case "pf_interface_status": {
      const iface = args.interface as string;
      if (!iface) throw new Error("interface parameter required");

      // Try relay cache first
      type InterfaceStatusCache = Record<string, { name: string; status: string; ip_address?: string; [key: string]: unknown }>;
      const cached = await queryRelayCache<InterfaceStatusCache>("pf_interface_status");
      if (cached) {
        const ifaceData = cached.data[iface] || cached.data[iface.toLowerCase()];
        if (ifaceData) {
          return { ...ifaceData, _source: "relay_cache" };
        }
        // Interface not in cache, fall through to direct query
      }

      // Fall back to direct pfSense query
      const response = await client.getInterfaceStatuses();
      const statuses = (response.data || []) as unknown as Array<Record<string, unknown>>;
      // Find by interface name (wan, lan) or device name (mvneta0, igb0)
      const match = statuses.find((s) =>
        s.name === iface || s.if === iface || s.descr === iface
      );
      if (!match) {
        throw new Error(`Interface '${iface}' not found. Available: ${statuses.map((s) => s.name || s.descr).join(', ')}`);
      }
      return match;
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
      // Try relay cache first (Guardian v2 pushes this as warm data)
      type DhcpLeaseCache = Array<{ ip: string; mac: string; hostname?: string; status: string; type: string; start?: string; end?: string }>;
      const cachedLeases = await queryRelayCache<DhcpLeaseCache>("pf_dhcp_leases");
      if (cachedLeases && Array.isArray(cachedLeases.data)) {
        let leases = cachedLeases.data;
        // Filter by status if requested
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
          _source: "relay_cache",
        }));
      }

      // Fall back to direct pfSense query
      // Note: pfSense API uses different field names (starts/ends/act vs start/end/status)
      const response = await client.getDhcpLeases();
      let leases = response.data || [];

      // Filter by status (API uses 'act' field: static, dynamic, active, expired)
      const status = args.status as string | undefined;
      if (status && status !== "all") {
        leases = leases.filter((l) => {
          const entry = l as unknown as Record<string, unknown>;
          const leaseStatus = (entry.act || l.status || "") as string;
          return leaseStatus === status || leaseStatus.includes(status);
        });
      }

      return leases.map((l) => {
        const entry = l as unknown as Record<string, unknown>;
        return {
          ip: l.ip,
          mac: l.mac,
          hostname: l.hostname || "(unknown)",
          status: (entry.act || l.status || "unknown") as string,
          type: l.type || "dynamic",
          start: (entry.starts || l.start || null) as string | null,
          end: (entry.ends || l.end || null) as string | null,
        };
      });
    }

    // ========================================================================
    // GATEWAYS
    // ========================================================================
    case "pf_gateway_status": {
      // Try relay cache first (Guardian v2 pushes this as hot data)
      type GatewayCache = Array<{ name: string; status: string; latency_ms?: number | null; loss_percent?: number; monitor_ip?: string }>;
      const cached = await queryRelayCache<GatewayCache>("pf_gateway_status");
      if (cached && Array.isArray(cached.data)) {
        return cached.data.map((g) => ({ ...g, _source: "relay_cache" }));
      }

      // Fall back to direct pfSense query
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
      // Try relay cache first (Guardian v2 pushes this as warm data)
      type ServicesCache = Array<{ name: string; description: string; status: string; enabled: boolean }>;
      const cached = await queryRelayCache<ServicesCache>("pf_services_list");
      if (cached && Array.isArray(cached.data)) {
        return cached.data.map((s) => ({ ...s, _source: "relay_cache" }));
      }

      // Fall back to direct pfSense query
      const response = await client.getServices();
      return (response.data || []).map((s) => ({
        name: s.name,
        description: s.description,
        enabled: s.enabled,
        status: s.status,
      }));
    }

    case "pf_service_start": {
      const service = args.service as string;
      if (!service) throw new Error("service parameter required");

      // Try queueing through relay for deferred execution
      const queued = await queueRelayCommand("pf_service_start", { service });
      if (queued && queued.success) {
        return {
          success: true,
          action: "queued",
          service,
          command_id: queued.command_id,
          message: "Command queued for Guardian execution. Service will start on next check-in.",
          _source: "relay_queue",
        };
      }

      // Fall back to direct pfSense API
      await client.startService(service);
      return { success: true, action: "started", service };
    }

    case "pf_service_stop": {
      const service = args.service as string;
      if (!service) throw new Error("service parameter required");

      // Try queueing through relay for deferred execution
      const queued = await queueRelayCommand("pf_service_stop", { service });
      if (queued && queued.success) {
        return {
          success: true,
          action: "queued",
          service,
          command_id: queued.command_id,
          message: "Command queued for Guardian execution. Service will stop on next check-in.",
          _source: "relay_queue",
        };
      }

      // Fall back to direct pfSense API
      await client.stopService(service);
      return { success: true, action: "stopped", service };
    }

    case "pf_service_restart": {
      const service = args.service as string;
      if (!service) throw new Error("service parameter required");

      // Try queueing through relay for deferred execution
      const queued = await queueRelayCommand("pf_service_restart", { service });
      if (queued && queued.success) {
        return {
          success: true,
          action: "queued",
          service,
          command_id: queued.command_id,
          message: "Command queued for Guardian execution. Service will restart on next check-in.",
          _source: "relay_queue",
        };
      }

      // Fall back to direct pfSense API
      await client.restartService(service);
      return { success: true, action: "restarted", service };
    }

    // ========================================================================
    // DIAGNOSTICS
    // ========================================================================
    case "pf_diag_ping": {
      const host = args.host as string;
      if (!host) throw new Error("host parameter required");
      const count = Math.min((args.count as number) || 3, 10);
      // Use command_prompt to run ping (v2 API doesn't have dedicated ping endpoint)
      const response = await client.runCommand(`ping -c ${count} ${host}`);
      return {
        command: `ping -c ${count} ${host}`,
        output: response.data?.output || "",
      };
    }

    case "pf_diag_arp": {
      // Try relay cache first (Guardian v2 pushes this as warm data)
      type ArpCache = Array<{ ip: string; mac: string; interface: string; hostname?: string; type: string }>;
      const cachedArp = await queryRelayCache<ArpCache>("pf_diag_arp");
      if (cachedArp && Array.isArray(cachedArp.data)) {
        return cachedArp.data.map((e) => ({
          ip: e.ip,
          mac: e.mac,
          interface: e.interface,
          hostname: e.hostname,
          type: e.type,
          _source: "relay_cache",
        }));
      }

      // Fall back to direct pfSense query
      // Note: pfSense API uses hyphenated field names (ip-address, mac-address)
      const response = await client.arpTable();
      const arpData = response.data || [];
      return arpData.map((e) => {
        const entry = e as unknown as Record<string, unknown>;
        return {
          ip: (entry["ip-address"] || entry.ip || e.ip) as string,
          mac: (entry["mac-address"] || entry.mac || e.mac) as string,
          interface: e.interface,
          hostname: e.hostname,
          type: e.type,
        };
      });
    }

    // ========================================================================
    // RRD HISTORICAL DATA
    // ========================================================================
    case "pf_rrd": {
      const metric = args.metric as string;
      const period = (args.period as string) || "1h";

      if (!metric) throw new Error("metric parameter required");

      // Check A.L.A.N. cache first
      const cached = getRrdCache(db, metric, period);
      if (cached) {
        console.error(`[RRD] Cache hit: ${metric}/${period}`);
        return JSON.parse(cached.data);
      }

      // Map metric to RRD file and column selection
      const metricMap: Record<string, { file: string; cols: string[] }> = {
        cpu: { file: "system-processor.rrd", cols: ["user", "system", "interrupt"] },
        memory: { file: "system-memory.rrd", cols: ["active", "inactive", "free", "cache", "wired"] },
        states: { file: "system-states.rrd", cols: ["pfstates"] },
        traffic_lan: { file: "lan-traffic.rrd", cols: ["inpass", "outpass"] },
        traffic_wan: { file: "wan-traffic.rrd", cols: ["inpass", "outpass"] },
        gateway_quality: { file: "WAN_DHCP-quality.rrd", cols: ["loss", "delay"] },
      };

      const config = metricMap[metric];
      if (!config) {
        throw new Error(`Unknown metric: ${metric}. Available: ${Object.keys(metricMap).join(", ")}`);
      }

      // Map period to rrdtool time spec
      const periodMap: Record<string, string> = {
        "1h": "end-1h",
        "4h": "end-4h",
        "1d": "end-1d",
        "1w": "end-1w",
        "1m": "end-1m",
      };

      const timeSpec = periodMap[period];
      if (!timeSpec) throw new Error(`Unknown period: ${period}`);

      // Fetch from pfSense via rrdtool
      console.error(`[RRD] Fetching ${metric}/${period} from pfSense...`);
      const cmdResponse = await client.runCommand(
        `rrdtool fetch /var/db/rrd/${config.file} AVERAGE --start ${timeSpec}`
      );

      const output = cmdResponse.data?.output || "";
      if (!output) throw new Error("No data returned from rrdtool");

      // Parse rrdtool output
      const lines = output.trim().split("\n");
      const headerLine = lines.find((l) => l.includes(":") === false && l.trim().length > 0);
      const dataLines = lines.filter((l) => l.includes(":") && !l.includes("nan nan nan"));

      // Parse header (column names)
      const headers = headerLine?.trim().split(/\s+/) || config.cols;

      // Parse data points
      const dataPoints: Array<{ timestamp: number; values: Record<string, number> }> = [];
      for (const line of dataLines) {
        const [tsStr, ...valStrs] = line.trim().split(/\s+/);
        const timestamp = parseInt(tsStr.replace(":", ""), 10);

        const values: Record<string, number> = {};
        headers.forEach((col, i) => {
          const val = parseFloat(valStrs[i]);
          if (!isNaN(val)) values[col] = val;
        });

        if (Object.keys(values).length > 0) {
          dataPoints.push({ timestamp, values });
        }
      }

      // Build result
      const result = {
        metric,
        period,
        file: config.file,
        columns: headers,
        data_points: dataPoints.length,
        data: dataPoints,
        fetched_at: Date.now(),
      };

      // Store in A.L.A.N. cache
      setRrdCache(db, metric, period, JSON.stringify(result));
      console.error(`[RRD] Cached ${metric}/${period}: ${dataPoints.length} points`);

      return result;
    }

    // ========================================================================
    // GUARDIAN RELAY
    // ========================================================================
    case "pf_guardian_devices": {
      if (!GUARDIAN_ADMIN_KEY) {
        throw new Error("GUARDIAN_ADMIN_KEY not configured");
      }
      const email = args.email as string | undefined;
      const url = new URL("/api/admin/devices", GUARDIAN_RELAY_URL);
      if (email) url.searchParams.set("email", email);

      const response = await fetch(url.toString(), {
        headers: { "X-Admin-Key": GUARDIAN_ADMIN_KEY },
      });
      if (!response.ok) {
        throw new Error(`Guardian API error: ${response.status}`);
      }
      return await response.json();
    }

    case "pf_guardian_events": {
      if (!GUARDIAN_ADMIN_KEY) {
        throw new Error("GUARDIAN_ADMIN_KEY not configured");
      }
      const email = args.email as string | undefined;
      const limit = Math.min((args.limit as number) || 20, 100);
      const url = new URL("/api/admin/events", GUARDIAN_RELAY_URL);
      if (email) url.searchParams.set("email", email);
      url.searchParams.set("limit", limit.toString());

      const response = await fetch(url.toString(), {
        headers: { "X-Admin-Key": GUARDIAN_ADMIN_KEY },
      });
      if (!response.ok) {
        throw new Error(`Guardian API error: ${response.status}`);
      }
      return await response.json();
    }

    case "pf_guardian_health": {
      if (!GUARDIAN_ADMIN_KEY) {
        throw new Error("GUARDIAN_ADMIN_KEY not configured");
      }
      const url = new URL("/api/admin/health", GUARDIAN_RELAY_URL);

      const response = await fetch(url.toString(), {
        headers: { "X-Admin-Key": GUARDIAN_ADMIN_KEY },
      });
      if (!response.ok) {
        throw new Error(`Guardian API error: ${response.status}`);
      }
      return await response.json();
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
