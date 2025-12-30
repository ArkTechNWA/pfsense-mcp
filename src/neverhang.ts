/**
 * NEVERHANG v2.0 + A.L.A.N. - Reliability is a methodology
 *
 * Adapted for pfSense HTTP API:
 * - HealthMonitor: Proactive pfSense connectivity detection
 * - CircuitBreaker: Fast-fail when pfSense is known-bad (persistent)
 * - AdaptiveTimeout: Adjust timeouts based on operation complexity
 * - NeverhangError: Failure taxonomy with actionable information
 * - A.L.A.N.: Persistent SQLite state across restarts
 */

import Database from "better-sqlite3";
import {
  loadCircuitState,
  saveCircuitState,
  recordHealthCheck,
  recordApiCall,
  getP95Latency,
  getDatabaseStats,
  type DatabaseStats,
} from "./db.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface NeverhangConfig {
  // Timeouts
  base_timeout_ms: number;
  connection_timeout_ms: number;
  health_check_timeout_ms: number;

  // Circuit breaker
  circuit_failure_threshold: number;
  circuit_failure_window_ms: number;
  circuit_open_duration_ms: number;
  circuit_recovery_threshold: number;

  // Health monitor
  health_check_interval_ms: number;
  health_degraded_interval_ms: number;

  // Adaptive timeout
  adaptive_timeout: boolean;
  min_timeout_ms: number;
  max_timeout_ms: number;
}

export const DEFAULT_NEVERHANG_CONFIG: NeverhangConfig = {
  // Timeouts - tuned for LAN API calls
  base_timeout_ms: 10000,
  connection_timeout_ms: 3000,
  health_check_timeout_ms: 5000,

  // Circuit breaker
  circuit_failure_threshold: 5,
  circuit_failure_window_ms: 60000,
  circuit_open_duration_ms: 30000,
  circuit_recovery_threshold: 2,

  // Health monitor
  health_check_interval_ms: 30000,
  health_degraded_interval_ms: 5000,

  // Adaptive timeout
  adaptive_timeout: true,
  min_timeout_ms: 2000,
  max_timeout_ms: 60000,
};

// ============================================================================
// FAILURE TAXONOMY
// ============================================================================

export type FailureType =
  | "timeout"
  | "connection_failed"
  | "circuit_open"
  | "api_error"
  | "auth_failed"
  | "permission_denied"
  | "not_found"
  | "cancelled";

export class NeverhangError extends Error {
  readonly type: FailureType;
  readonly duration_ms: number;
  readonly retryable: boolean;
  readonly suggestion: string;

  constructor(
    type: FailureType,
    message: string,
    duration_ms: number,
    options?: { cause?: Error }
  ) {
    super(message, options);
    this.name = "NeverhangError";
    this.type = type;
    this.duration_ms = duration_ms;
    this.retryable = type !== "permission_denied" && type !== "auth_failed";
    this.suggestion = NeverhangError.getSuggestion(type);
  }

  static getSuggestion(type: FailureType): string {
    switch (type) {
      case "timeout":
        return "pfSense may be under load. Try again or check router status.";
      case "connection_failed":
        return "Check network connectivity to pfSense. Is the host reachable?";
      case "circuit_open":
        return "pfSense marked unhealthy. Automatic retry pending.";
      case "api_error":
        return "API returned an error. Check pfSense logs.";
      case "auth_failed":
        return "API key invalid or expired. Check PFSENSE_API_KEY.";
      case "permission_denied":
        return "API key lacks permission for this operation.";
      case "not_found":
        return "Endpoint or resource not found. Is pfSense-API package installed?";
      case "cancelled":
        return "Request was cancelled.";
      default:
        return "Unknown error occurred.";
    }
  }

  toJSON() {
    return {
      type: this.type,
      message: this.message,
      duration_ms: this.duration_ms,
      retryable: this.retryable,
      suggestion: this.suggestion,
    };
  }
}

// ============================================================================
// HEALTH MONITOR
// ============================================================================

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthState {
  status: HealthStatus;
  last_check: Date | null;
  last_success: Date | null;
  last_failure: Date | null;
  latency_ms: number;
  latency_samples: number[];
  consecutive_failures: number;
  consecutive_successes: number;
}

export class HealthMonitor {
  private state: HealthState;
  private config: NeverhangConfig;
  private pingFn: () => Promise<void>;
  private intervalId: NodeJS.Timeout | null = null;
  private db: Database.Database | null = null;

  constructor(config: NeverhangConfig, pingFn: () => Promise<void>, db?: Database.Database) {
    this.config = config;
    this.pingFn = pingFn;
    this.db = db ?? null;
    this.state = {
      status: "healthy", // Assume healthy until proven otherwise
      last_check: null,
      last_success: null,
      last_failure: null,
      latency_ms: 0,
      latency_samples: [],
      consecutive_failures: 0,
      consecutive_successes: 0,
    };
  }

  async ping(): Promise<{ ok: boolean; latency_ms: number }> {
    const start = Date.now();
    try {
      await this.pingFn();
      const latency = Date.now() - start;
      this.recordSuccess(latency);
      return { ok: true, latency_ms: latency };
    } catch {
      const latency = Date.now() - start;
      this.recordFailure();
      return { ok: false, latency_ms: latency };
    }
  }

  private recordSuccess(latency_ms: number): void {
    this.state.last_check = new Date();
    this.state.last_success = new Date();
    this.state.latency_ms = latency_ms;
    this.state.consecutive_failures = 0;
    this.state.consecutive_successes++;

    // Keep last 10 samples for p95
    this.state.latency_samples.push(latency_ms);
    if (this.state.latency_samples.length > 10) {
      this.state.latency_samples.shift();
    }

    // Status transitions
    if (this.state.status === "unhealthy" && this.state.consecutive_successes >= 1) {
      this.state.status = "degraded";
      console.error("[neverhang] Health: unhealthy -> degraded");
    } else if (this.state.status === "degraded" && this.state.consecutive_successes >= 3) {
      this.state.status = "healthy";
      console.error("[neverhang] Health: degraded -> healthy");
    }

    // Record to A.L.A.N.
    if (this.db) {
      recordHealthCheck(this.db, this.state.status, latency_ms, true);
    }
  }

  private recordFailure(): void {
    this.state.last_check = new Date();
    this.state.last_failure = new Date();
    this.state.consecutive_successes = 0;
    this.state.consecutive_failures++;

    // Status transitions
    if (this.state.status === "healthy" && this.state.consecutive_failures >= 1) {
      this.state.status = "degraded";
      console.error("[neverhang] Health: healthy -> degraded");
    } else if (this.state.status === "degraded" && this.state.consecutive_failures >= 3) {
      this.state.status = "unhealthy";
      console.error("[neverhang] Health: degraded -> unhealthy");
    }

    // Record to A.L.A.N.
    if (this.db) {
      recordHealthCheck(this.db, this.state.status, null, false);
    }
  }

  getHealth(): HealthState {
    return { ...this.state };
  }

  getLatencyP95(): number {
    if (this.state.latency_samples.length === 0) return 0;
    const sorted = [...this.state.latency_samples].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  startBackgroundCheck(): void {
    if (this.intervalId) return;

    const check = async () => {
      await this.ping();

      // Adjust interval based on health
      const interval =
        this.state.status === "healthy"
          ? this.config.health_check_interval_ms
          : this.config.health_degraded_interval_ms;

      this.intervalId = setTimeout(check, interval);
    };

    // Start after initial delay
    this.intervalId = setTimeout(check, 5000);
  }

  stopBackgroundCheck(): void {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number[];
  opened_at: Date | null;
  half_open_successes: number;
}

export class CircuitBreaker {
  private state: CircuitBreakerState;
  private config: NeverhangConfig;
  private db: Database.Database | null = null;

  constructor(config: NeverhangConfig, db?: Database.Database) {
    this.config = config;
    this.db = db ?? null;

    // Load state from A.L.A.N. if available
    if (this.db) {
      const saved = loadCircuitState(this.db);
      this.state = {
        state: saved.state === "half_open" ? "half-open" : saved.state as CircuitState,
        failures: saved.failure_count > 0 && saved.last_failure_at
          ? Array(saved.failure_count).fill(saved.last_failure_at)
          : [],
        opened_at: saved.opened_at ? new Date(saved.opened_at) : null,
        half_open_successes: saved.recovery_successes,
      };
      console.error(`[ALAN] Loaded circuit state: ${this.state.state}`);
    } else {
      this.state = {
        state: "closed",
        failures: [],
        opened_at: null,
        half_open_successes: 0,
      };
    }
  }

  private persistState(): void {
    if (!this.db) return;
    saveCircuitState(this.db, {
      state: this.state.state === "half-open" ? "half_open" : this.state.state,
      failure_count: this.state.failures.length,
      last_failure_at: this.state.failures.length > 0
        ? this.state.failures[this.state.failures.length - 1]
        : null,
      opened_at: this.state.opened_at?.getTime() ?? null,
      recovery_successes: this.state.half_open_successes,
    });
  }

  canExecute(): boolean {
    this.cleanOldFailures();

    switch (this.state.state) {
      case "closed":
        return true;

      case "open":
        // Check if it's time to try half-open
        if (this.state.opened_at) {
          const elapsed = Date.now() - this.state.opened_at.getTime();
          if (elapsed >= this.config.circuit_open_duration_ms) {
            this.state.state = "half-open";
            this.state.half_open_successes = 0;
            console.error("[neverhang] Circuit: open -> half-open (testing)");
            return true;
          }
        }
        return false;

      case "half-open":
        return true;
    }
  }

  recordSuccess(): void {
    if (this.state.state === "half-open") {
      this.state.half_open_successes++;
      if (this.state.half_open_successes >= this.config.circuit_recovery_threshold) {
        this.state.state = "closed";
        this.state.failures = [];
        this.state.opened_at = null;
        console.error("[neverhang] Circuit: half-open -> closed (recovered)");
        this.persistState();
      }
    }
  }

  recordFailure(excludeFromCircuit: boolean = false): void {
    if (excludeFromCircuit) return;

    this.state.failures.push(Date.now());
    this.cleanOldFailures();

    if (this.state.state === "half-open") {
      // Any failure in half-open reopens the circuit
      this.state.state = "open";
      this.state.opened_at = new Date();
      console.error("[neverhang] Circuit: half-open -> open (test failed)");
      this.persistState();
      return;
    }

    if (this.state.state === "closed") {
      if (this.state.failures.length >= this.config.circuit_failure_threshold) {
        this.state.state = "open";
        this.state.opened_at = new Date();
        console.error(
          `[neverhang] Circuit: closed -> open (${this.state.failures.length} failures)`
        );
        this.persistState();
      }
    }
  }

  private cleanOldFailures(): void {
    const cutoff = Date.now() - this.config.circuit_failure_window_ms;
    this.state.failures = this.state.failures.filter((t) => t > cutoff);
  }

  getState(): CircuitState {
    this.cleanOldFailures();
    return this.state.state;
  }

  getOpenDuration(): number | null {
    if (this.state.state !== "open" || !this.state.opened_at) return null;
    return Date.now() - this.state.opened_at.getTime();
  }

  getTimeUntilHalfOpen(): number | null {
    if (this.state.state !== "open" || !this.state.opened_at) return null;
    const elapsed = Date.now() - this.state.opened_at.getTime();
    const remaining = this.config.circuit_open_duration_ms - elapsed;
    return Math.max(0, remaining);
  }

  getRecentFailures(): number {
    this.cleanOldFailures();
    return this.state.failures.length;
  }
}

// ============================================================================
// OPERATION COMPLEXITY
// ============================================================================

export type OperationComplexity =
  | "simple"      // Status checks, info reads
  | "interface"   // Interface operations
  | "firewall"    // Firewall rule operations
  | "config"      // Configuration changes
  | "dangerous";  // Reboot, shutdown, packages

export function classifyOperation(toolName: string): OperationComplexity {
  // Simple reads
  if (toolName.includes("_info") || toolName.includes("_status") ||
      toolName.includes("_list") || toolName.includes("_leases") ||
      toolName.includes("_logs") || toolName === "pf_health") {
    return "simple";
  }

  // Interface operations
  if (toolName.includes("interface")) {
    if (toolName.includes("restart") || toolName.includes("enable") || toolName.includes("disable")) {
      return "interface";
    }
    return "simple";
  }

  // Firewall operations
  if (toolName.includes("firewall") || toolName.includes("nat") || toolName.includes("alias")) {
    if (toolName.includes("add") || toolName.includes("delete") || toolName.includes("modify")) {
      return "firewall";
    }
    return "simple";
  }

  // Dangerous operations
  if (toolName.includes("reboot") || toolName.includes("shutdown") ||
      toolName.includes("packages") || toolName.includes("backup")) {
    return "dangerous";
  }

  // Config changes
  if (toolName.includes("_config") || toolName.includes("_add") ||
      toolName.includes("_delete") || toolName.includes("_modify")) {
    return "config";
  }

  return "simple";
}

// ============================================================================
// ADAPTIVE TIMEOUT
// ============================================================================

export class AdaptiveTimeout {
  private config: NeverhangConfig;

  constructor(config: NeverhangConfig) {
    this.config = config;
  }

  getTimeout(
    toolName: string,
    healthStatus: HealthStatus,
    userOverride?: number
  ): { timeout_ms: number; reason: string } {
    // User override takes precedence (capped)
    if (userOverride !== undefined) {
      const capped = Math.min(
        Math.max(userOverride, this.config.min_timeout_ms),
        this.config.max_timeout_ms
      );
      return { timeout_ms: capped, reason: `user override (capped to ${capped}ms)` };
    }

    if (!this.config.adaptive_timeout) {
      return { timeout_ms: this.config.base_timeout_ms, reason: "adaptive disabled" };
    }

    const complexity = classifyOperation(toolName);
    let multiplier = 1.0;
    const reasons: string[] = [];

    // Complexity multipliers
    switch (complexity) {
      case "simple":
        // No change
        break;
      case "interface":
        multiplier *= 2.0;
        reasons.push("interface op (2x)");
        break;
      case "firewall":
        multiplier *= 1.5;
        reasons.push("firewall op (1.5x)");
        break;
      case "config":
        multiplier *= 2.0;
        reasons.push("config change (2x)");
        break;
      case "dangerous":
        multiplier *= 6.0; // Reboots take time
        reasons.push("dangerous op (6x)");
        break;
    }

    // Health multiplier
    switch (healthStatus) {
      case "healthy":
        // No change
        break;
      case "degraded":
        multiplier *= 0.5;
        reasons.push("degraded health (0.5x)");
        break;
      case "unhealthy":
        // Should be blocked by circuit breaker, but just in case
        multiplier *= 0.25;
        reasons.push("unhealthy (0.25x)");
        break;
    }

    let timeout = this.config.base_timeout_ms * multiplier;
    timeout = Math.min(
      Math.max(timeout, this.config.min_timeout_ms),
      this.config.max_timeout_ms
    );

    return {
      timeout_ms: Math.round(timeout),
      reason: reasons.length > 0 ? reasons.join(", ") : "base timeout",
    };
  }
}

// ============================================================================
// NEVERHANG MANAGER (Unified Interface)
// ============================================================================

export interface NeverhangStats {
  status: HealthStatus;
  circuit: CircuitState;
  circuit_opens_in: number | null;
  latency_ms: number;
  latency_p95_ms: number;
  recent_failures: number;
  last_success: Date | null;
  last_failure: Date | null;
}

export class NeverhangManager {
  readonly config: NeverhangConfig;
  readonly health: HealthMonitor;
  readonly circuit: CircuitBreaker;
  readonly timeout: AdaptiveTimeout;
  private db: Database.Database | null = null;

  private startTime: Date;
  private totalCalls: number = 0;
  private successfulCalls: number = 0;

  constructor(config: Partial<NeverhangConfig>, pingFn: () => Promise<void>, db?: Database.Database) {
    this.config = { ...DEFAULT_NEVERHANG_CONFIG, ...config };
    this.db = db ?? null;
    this.health = new HealthMonitor(this.config, pingFn, db);
    this.circuit = new CircuitBreaker(this.config, db);
    this.timeout = new AdaptiveTimeout(this.config);
    this.startTime = new Date();
  }

  start(): void {
    this.health.startBackgroundCheck();
  }

  stop(): void {
    this.health.stopBackgroundCheck();
  }

  canExecute(): { allowed: boolean; reason?: string } {
    if (!this.circuit.canExecute()) {
      const timeLeft = this.circuit.getTimeUntilHalfOpen();
      return {
        allowed: false,
        reason: `Circuit open. Retry in ${Math.ceil((timeLeft || 0) / 1000)}s`,
      };
    }
    return { allowed: true };
  }

  getTimeout(toolName: string, userOverride?: number): { timeout_ms: number; reason: string } {
    const healthState = this.health.getHealth();
    return this.timeout.getTimeout(toolName, healthState.status, userOverride);
  }

  recordSuccess(toolName: string, durationMs: number): void {
    this.totalCalls++;
    this.successfulCalls++;
    this.circuit.recordSuccess();

    const complexity = classifyOperation(toolName);

    // Record to A.L.A.N.
    if (this.db) {
      recordApiCall(this.db, toolName, complexity, durationMs, true);
    }
  }

  recordFailure(toolName: string, durationMs: number, errorType?: string): void {
    this.totalCalls++;
    this.circuit.recordFailure(false);

    const complexity = classifyOperation(toolName);

    // Record to A.L.A.N.
    if (this.db) {
      recordApiCall(this.db, toolName, complexity, durationMs, false, errorType);
    }
  }

  /**
   * Get P95 latency for a complexity level from A.L.A.N.
   */
  getP95ForComplexity(complexity: string): number | null {
    if (!this.db) return null;
    return getP95Latency(this.db, complexity);
  }

  /**
   * Get A.L.A.N. database statistics
   */
  getDatabaseStats(): DatabaseStats | null {
    if (!this.db) return null;
    return getDatabaseStats(this.db);
  }

  getStats(): NeverhangStats {
    const healthState = this.health.getHealth();
    return {
      status: healthState.status,
      circuit: this.circuit.getState(),
      circuit_opens_in: this.circuit.getTimeUntilHalfOpen(),
      latency_ms: healthState.latency_ms,
      latency_p95_ms: this.health.getLatencyP95(),
      recent_failures: this.circuit.getRecentFailures(),
      last_success: healthState.last_success,
      last_failure: healthState.last_failure,
    };
  }

  getUptimePercent(): number {
    if (this.totalCalls === 0) return 100;
    return Math.round((this.successfulCalls / this.totalCalls) * 100);
  }
}
