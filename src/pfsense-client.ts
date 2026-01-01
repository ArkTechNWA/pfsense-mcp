/**
 * pfSense API Client
 *
 * HTTP client for the pfSense-API package.
 * Supports both API key and username/password authentication.
 *
 * API Docs: https://github.com/jaredhendrickson13/pfsense-api
 */

import { NeverhangError, type FailureType } from "./neverhang.js";

export interface PfSenseConfig {
  host: string;
  port?: number;
  apiKey?: string;
  username?: string;
  password?: string;
  verifySsl?: boolean;
  timeout?: number;
}

export interface ApiResponse<T = unknown> {
  status: "ok" | "error";
  code: number;
  return?: number;
  message: string;
  data?: T;
}

/**
 * pfSense API Client
 *
 * Environment variables:
 * - PFSENSE_HOST: Router IP or hostname (required)
 * - PFSENSE_PORT: API port (default: 443)
 * - PFSENSE_API_KEY: API key for authentication
 * - PFSENSE_USERNAME: Username for basic auth (if no API key)
 * - PFSENSE_PASSWORD: Password for basic auth
 * - PFSENSE_VERIFY_SSL: Verify SSL certificate (default: false for self-signed)
 */
export class PfSenseClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private verifySsl: boolean;

  constructor(config?: Partial<PfSenseConfig>) {
    const host = config?.host || process.env.PFSENSE_HOST;
    if (!host) {
      throw new Error("PFSENSE_HOST environment variable is required");
    }

    const port = config?.port || parseInt(process.env.PFSENSE_PORT || "443", 10);
    this.baseUrl = `https://${host}:${port}/api/v2`;
    this.verifySsl = config?.verifySsl ?? (process.env.PFSENSE_VERIFY_SSL === "true");

    // Set up authentication
    this.headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };

    const apiKey = config?.apiKey || process.env.PFSENSE_API_KEY;
    if (apiKey) {
      // RESTAPI v2 uses X-API-Key header
      this.headers["X-API-Key"] = apiKey;
    } else {
      const username = config?.username || process.env.PFSENSE_USERNAME;
      const password = config?.password || process.env.PFSENSE_PASSWORD;
      if (username && password) {
        const credentials = Buffer.from(`${username}:${password}`).toString("base64");
        this.headers["Authorization"] = `Basic ${credentials}`;
      }
    }
  }

  /**
   * Make an API request to pfSense
   */
  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    endpoint: string,
    body?: unknown,
    timeoutMs?: number
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;
    const start = Date.now();

    const controller = new AbortController();
    const timeout = timeoutMs || 10000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchOptions: RequestInit = {
        method,
        headers: this.headers,
        signal: controller.signal,
      };

      if (body && (method === "POST" || method === "PUT")) {
        fetchOptions.body = JSON.stringify(body);
      }

      // Handle self-signed certificates
      // Note: In Node.js, we need to use a custom agent for this
      // For now, we'll set NODE_TLS_REJECT_UNAUTHORIZED if verifySsl is false
      if (!this.verifySsl) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      }

      const response = await fetch(url, fetchOptions);
      const duration = Date.now() - start;

      clearTimeout(timeoutId);

      // Handle HTTP errors
      if (!response.ok) {
        const errorType = this.classifyHttpError(response.status);
        const errorBody = await response.text().catch(() => "");
        throw new NeverhangError(
          errorType,
          `HTTP ${response.status}: ${response.statusText}. ${errorBody}`,
          duration
        );
      }

      const data = await response.json() as ApiResponse<T>;

      // Handle API-level errors
      if (data.status === "error") {
        throw new NeverhangError(
          "api_error",
          data.message || "Unknown API error",
          duration
        );
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      const duration = Date.now() - start;

      if (error instanceof NeverhangError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new NeverhangError("timeout", `Request timed out after ${timeout}ms`, duration);
        }
        if (error.message.includes("ECONNREFUSED") || error.message.includes("ENOTFOUND")) {
          throw new NeverhangError("connection_failed", `Cannot connect to ${this.baseUrl}`, duration);
        }
        throw new NeverhangError("api_error", error.message, duration, { cause: error });
      }

      throw new NeverhangError("api_error", "Unknown error", duration);
    }
  }

  private classifyHttpError(status: number): FailureType {
    switch (status) {
      case 401:
        return "auth_failed";
      case 403:
        return "permission_denied";
      case 404:
        return "not_found";
      default:
        return "api_error";
    }
  }

  // ==========================================================================
  // CONVENIENCE METHODS
  // ==========================================================================

  async get<T = unknown>(endpoint: string, timeout?: number): Promise<ApiResponse<T>> {
    return this.request<T>("GET", endpoint, undefined, timeout);
  }

  async post<T = unknown>(endpoint: string, body?: unknown, timeout?: number): Promise<ApiResponse<T>> {
    return this.request<T>("POST", endpoint, body, timeout);
  }

  async put<T = unknown>(endpoint: string, body?: unknown, timeout?: number): Promise<ApiResponse<T>> {
    return this.request<T>("PUT", endpoint, body, timeout);
  }

  async delete<T = unknown>(endpoint: string, timeout?: number): Promise<ApiResponse<T>> {
    return this.request<T>("DELETE", endpoint, undefined, timeout);
  }

  // ==========================================================================
  // HEALTH CHECK
  // ==========================================================================

  /**
   * Ping the API to check connectivity
   * Used by NEVERHANG health monitor
   */
  async ping(): Promise<void> {
    // The status/system endpoint is lightweight and always available
    await this.get("/status/system", 5000);
  }

  /**
   * Get base URL for debugging
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  // ==========================================================================
  // SYSTEM ENDPOINTS (v2 API)
  // ==========================================================================

  async getSystemStatus(): Promise<ApiResponse<SystemStatus>> {
    return this.get<SystemStatus>("/status/system");
  }

  async getSystemInfo(): Promise<ApiResponse<SystemInfo>> {
    return this.get<SystemInfo>("/system/version");
  }

  // ==========================================================================
  // INTERFACE ENDPOINTS (v2 API)
  // ==========================================================================

  async getInterfaces(): Promise<ApiResponse<InterfaceInfo[]>> {
    return this.get<InterfaceInfo[]>("/interfaces");
  }

  async getInterfaceStatus(iface: string): Promise<ApiResponse<InterfaceStatus>> {
    // v2 API: get specific interface by ID, then fetch status data
    return this.get<InterfaceStatus>(`/interface?id=${iface}`);
  }

  // ==========================================================================
  // FIREWALL ENDPOINTS (v2 API)
  // ==========================================================================

  async getFirewallRules(): Promise<ApiResponse<FirewallRule[]>> {
    return this.get<FirewallRule[]>("/firewall/rules");
  }

  async getFirewallStates(): Promise<ApiResponse<FirewallState[]>> {
    return this.get<FirewallState[]>("/firewall/states");
  }

  // ==========================================================================
  // DHCP ENDPOINTS (v2 API)
  // ==========================================================================

  async getDhcpLeases(): Promise<ApiResponse<DhcpLease[]>> {
    return this.get<DhcpLease[]>("/status/dhcp_server/leases");
  }

  // ==========================================================================
  // GATEWAY ENDPOINTS (v2 API)
  // ==========================================================================

  async getGatewayStatus(): Promise<ApiResponse<GatewayStatus[]>> {
    return this.get<GatewayStatus[]>("/status/gateways");
  }

  // ==========================================================================
  // SERVICE ENDPOINTS (v2 API)
  // ==========================================================================

  async getServices(): Promise<ApiResponse<ServiceStatus[]>> {
    return this.get<ServiceStatus[]>("/status/services");
  }

  async startService(service: string): Promise<ApiResponse<void>> {
    return this.post<void>(`/service/${service}/start`);
  }

  async stopService(service: string): Promise<ApiResponse<void>> {
    return this.post<void>(`/service/${service}/stop`);
  }

  async restartService(service: string): Promise<ApiResponse<void>> {
    return this.post<void>(`/service/${service}/restart`);
  }

  // ==========================================================================
  // DIAGNOSTIC ENDPOINTS (v2 API)
  // ==========================================================================

  async runCommand(command: string): Promise<ApiResponse<CommandResult>> {
    // Use command_prompt for arbitrary diagnostics (including ping)
    return this.post<CommandResult>("/diagnostics/command_prompt", { shell_cmd: command });
  }

  async arpTable(): Promise<ApiResponse<ArpEntry[]>> {
    return this.get<ArpEntry[]>("/diagnostics/arp_table");
  }
}

// ==========================================================================
// TYPE DEFINITIONS
// ==========================================================================

export interface SystemStatus {
  uptime: number;
  datetime: {
    date: string;
    time: string;
    timezone: string;
  };
  cpu: {
    usage: number;
    temperature?: number;
  };
  memory: {
    total: number;
    used: number;
    free: number;
    usage: number;
  };
  disk: {
    total: number;
    used: number;
    free: number;
    usage: number;
  };
}

export interface SystemInfo {
  hostname: string;
  domain: string;
  version: string;
  version_patch?: string;
  platform: string;
  serial?: string;
  netgate_device_id?: string;
}

export interface InterfaceInfo {
  name: string;
  descr: string;
  if: string;
  enable: boolean;
  ipaddr?: string;
  subnet?: number;
  gateway?: string;
  mac?: string;
}

export interface InterfaceStatus {
  name: string;
  status: "up" | "down" | "no carrier";
  ipaddr?: string;
  subnet?: number;
  gateway?: string;
  mac?: string;
  media?: string;
  inpkts: number;
  outpkts: number;
  inbytes: number;
  outbytes: number;
  inerrs: number;
  outerrs: number;
}

export interface FirewallRule {
  id: number;
  tracker: string;
  type: "pass" | "block" | "reject";
  interface: string;
  ipprotocol: "inet" | "inet6" | "inet46";
  protocol: string;
  source: string;
  destination: string;
  descr?: string;
  disabled?: boolean;
}

export interface FirewallState {
  interface: string;
  protocol: string;
  src: string;
  dst: string;
  state: string;
  age: string;
  expires: string;
  pkts: number;
  bytes: number;
}

export interface DhcpLease {
  ip: string;
  mac: string;
  hostname?: string;
  start: string;
  end: string;
  status: "active" | "expired" | "static";
  type: "dynamic" | "static";
}

export interface GatewayStatus {
  name: string;
  gateway: string;
  monitor: string;
  status: "online" | "offline" | "unknown";
  delay: number;
  stddev: number;
  loss: number;
}

export interface ServiceStatus {
  name: string;
  description: string;
  enabled: boolean;
  status: "running" | "stopped";
}

export interface CommandResult {
  output: string;
  return_code?: number;
}

export interface ArpEntry {
  ip: string;
  mac: string;
  interface: string;
  hostname?: string;
  expires: string;
  type: "dynamic" | "permanent";
}
