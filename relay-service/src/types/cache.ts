/**
 * Cache types for Guardian v2 push/query architecture
 *
 * Guardian pushes data to relay based on manifest.
 * MCP clients query relay instead of pfSense directly.
 * A.L.A.N. learns patterns and adjusts manifest.
 */

// =============================================================================
// MANIFEST TYPES
// =============================================================================

export interface ManifestConfig {
  version: string;
  updated_at: number;
  hot: {
    interval_seconds: number;
    collect: HotDataType[];
  };
  warm: {
    interval_seconds: number;
    collect: WarmDataType[];
  };
  cold: {
    note: string;
    items: ColdDataType[];
  };
  thresholds: {
    cpu: number;
    memory: number;
    disk: number;
  };
}

export type HotDataType = 'system' | 'gateways' | 'interfaces';
export type WarmDataType = 'services' | 'dhcp_leases' | 'arp_table';
export type ColdDataType = 'firewall_rules' | 'firewall_states' | 'rrd';

export type DataCategory = 'hot' | 'warm' | 'cold';

// =============================================================================
// PUSHED DATA TYPES
// =============================================================================

export interface SystemData {
  uptime: string;
  uptime_seconds: number;
  platform: string;
  version: string;
  cpu: {
    model: string;
    count: number;
    usage_percent: number;
    load_avg: [number, number, number];
    temperature_c: number | null;
  };
  memory: {
    usage_percent: number;
    total_mb: number;
    used_mb: number;
  };
  disk: {
    usage_percent: number;
    total_gb: number;
    used_gb: number;
  };
}

export interface GatewayData {
  name: string;
  status: 'online' | 'offline' | 'unknown';
  latency_ms: number | null;
  loss_percent: number;
  monitor_ip: string;
}

export interface InterfaceData {
  name: string;
  friendly_name: string;
  status: 'up' | 'down';
  ip_address: string | null;
  mac_address: string;
  in_bytes: number;
  out_bytes: number;
  in_packets: number;
  out_packets: number;
  in_errors: number;
  out_errors: number;
  speed_mbps: number | null;
}

export interface ServiceData {
  name: string;
  description: string;
  status: 'running' | 'stopped';
  enabled: boolean;
}

export interface DhcpLeaseData {
  ip: string;
  mac: string;
  hostname: string | null;
  start: string;
  end: string;
  status: 'active' | 'expired' | 'static';
}

export interface ArpEntryData {
  ip: string;
  mac: string;
  interface: string;
  hostname: string | null;
}

// =============================================================================
// PUSH PAYLOAD TYPES
// =============================================================================

export interface HotPushPayload {
  system: SystemData;
  gateways: GatewayData[];
  interfaces: Record<string, InterfaceData>;
}

export interface WarmPushPayload {
  services?: ServiceData[];
  dhcp_leases?: DhcpLeaseData[];
  arp_table?: ArpEntryData[];
}

export interface GuardianPushPayload {
  hot?: HotPushPayload;
  warm?: WarmPushPayload;
  meta: {
    timestamp: number;
    manifest_version: string;
    guardian_version: string;
    push_type: 'hot' | 'warm' | 'full';
  };
}

// =============================================================================
// CACHE STATE
// =============================================================================

export interface CachedData<T> {
  data: T;
  cached_at: number;
  ttl_ms: number;
  source: 'guardian_push' | 'relay_pull';
}

export interface DeviceCache {
  device_token: string;
  hot: CachedData<HotPushPayload> | null;
  warm: CachedData<WarmPushPayload> | null;
  last_push_at: number | null;
  manifest_version: string | null;
}

// =============================================================================
// QUERY TYPES
// =============================================================================

export interface QueryRequest {
  tool: string;
  device_token?: string;  // Optional, defaults to configured device
  params?: Record<string, unknown>;
}

export interface QueryResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  cache_info: {
    cached: boolean;
    cached_at?: number;
    ttl_remaining_ms?: number;
    source?: 'guardian_push' | 'relay_pull' | 'direct';
  };
}

// =============================================================================
// A.L.A.N. TYPES
// =============================================================================

export interface QueryStats {
  tool: string;
  count_24h: number;
  count_7d: number;
  avg_latency_ms: number;
  last_queried_at: number;
  sources: string[];  // Which devices/users query this
}

export interface PromotionDecision {
  tool: string;
  from_category: DataCategory | null;
  to_category: DataCategory;
  reason: string;
  confidence: number;
  decided_at: number;
}

// =============================================================================
// COMMAND QUEUE (for WRITE operations)
// =============================================================================

export interface WriteCommand {
  id: string;
  device_token: string;
  tool: string;
  params: Record<string, unknown>;
  queued_at: number;
  expires_at: number;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}
