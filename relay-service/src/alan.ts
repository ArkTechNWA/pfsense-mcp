/**
 * A.L.A.N. - Adaptive Learning for Autonomous Networking
 *
 * Analyzes query patterns and adjusts Guardian manifests to:
 * - Promote frequently-queried cold data → warm
 * - Promote frequently-queried warm data → hot
 * - Demote rarely-queried hot data → warm
 * - Demote rarely-queried warm data → cold
 */

import * as db from "./db";
import type {
  ManifestConfig,
  QueryStats,
  DataCategory,
  HotDataType,
  WarmDataType,
  ColdDataType,
} from "./types/cache";

// Tool → data category mapping
const TOOL_CATEGORY_MAP: Record<string, { category: DataCategory; dataType: string }> = {
  // Hot data tools
  system_status: { category: "hot", dataType: "system" },
  pf_system_status: { category: "hot", dataType: "system" },
  system_info: { category: "hot", dataType: "system" },
  pf_system_info: { category: "hot", dataType: "system" },
  gateway_status: { category: "hot", dataType: "gateways" },
  pf_gateway_status: { category: "hot", dataType: "gateways" },
  interface_list: { category: "hot", dataType: "interfaces" },
  interface_status: { category: "hot", dataType: "interfaces" },
  pf_interface_list: { category: "hot", dataType: "interfaces" },
  pf_interface_status: { category: "hot", dataType: "interfaces" },

  // Warm data tools
  services_list: { category: "warm", dataType: "services" },
  pf_services_list: { category: "warm", dataType: "services" },
  dhcp_leases: { category: "warm", dataType: "dhcp_leases" },
  pf_dhcp_leases: { category: "warm", dataType: "dhcp_leases" },
  diag_arp: { category: "warm", dataType: "arp_table" },
  pf_diag_arp: { category: "warm", dataType: "arp_table" },

  // Cold data tools
  firewall_rules: { category: "cold", dataType: "firewall_rules" },
  pf_firewall_rules: { category: "cold", dataType: "firewall_rules" },
  firewall_states: { category: "cold", dataType: "firewall_states" },
  pf_firewall_states: { category: "cold", dataType: "firewall_states" },
  pf_rrd: { category: "cold", dataType: "rrd" },
};

// Thresholds for promotion/demotion decisions
const PROMOTION_THRESHOLDS = {
  // Promote cold → warm if queried more than N times in 24h
  cold_to_warm_queries_24h: 10,
  // Promote warm → hot if queried more than N times in 24h
  warm_to_hot_queries_24h: 50,
  // Demote hot → warm if queried less than N times in 7d
  hot_to_warm_queries_7d: 5,
  // Demote warm → cold if queried less than N times in 7d
  warm_to_cold_queries_7d: 2,
  // Minimum confidence to execute promotion
  min_confidence: 0.7,
};

export interface PromotionCandidate {
  tool: string;
  dataType: string;
  fromCategory: DataCategory | null;
  toCategory: DataCategory;
  reason: string;
  confidence: number;
  stats: QueryStats;
}

/**
 * Analyze query patterns and suggest promotions
 */
export function analyzeAndSuggestPromotions(): PromotionCandidate[] {
  const stats = db.getQueryStats();
  const candidates: PromotionCandidate[] = [];

  for (const stat of stats) {
    const mapping = TOOL_CATEGORY_MAP[stat.tool];
    if (!mapping) continue;

    const { category: currentCategory, dataType } = mapping;

    // Check for promotion candidates
    if (currentCategory === "cold") {
      // Cold → Warm promotion
      if (stat.count_24h >= PROMOTION_THRESHOLDS.cold_to_warm_queries_24h) {
        const confidence = Math.min(
          stat.count_24h / (PROMOTION_THRESHOLDS.cold_to_warm_queries_24h * 2),
          1.0
        );
        candidates.push({
          tool: stat.tool,
          dataType,
          fromCategory: "cold",
          toCategory: "warm",
          reason: `Queried ${stat.count_24h} times in 24h (threshold: ${PROMOTION_THRESHOLDS.cold_to_warm_queries_24h})`,
          confidence,
          stats: stat,
        });
      }
    } else if (currentCategory === "warm") {
      // Warm → Hot promotion
      if (stat.count_24h >= PROMOTION_THRESHOLDS.warm_to_hot_queries_24h) {
        const confidence = Math.min(
          stat.count_24h / (PROMOTION_THRESHOLDS.warm_to_hot_queries_24h * 2),
          1.0
        );
        candidates.push({
          tool: stat.tool,
          dataType,
          fromCategory: "warm",
          toCategory: "hot",
          reason: `Queried ${stat.count_24h} times in 24h (threshold: ${PROMOTION_THRESHOLDS.warm_to_hot_queries_24h})`,
          confidence,
          stats: stat,
        });
      }

      // Warm → Cold demotion
      if (stat.count_7d <= PROMOTION_THRESHOLDS.warm_to_cold_queries_7d) {
        const confidence =
          1.0 - stat.count_7d / PROMOTION_THRESHOLDS.warm_to_cold_queries_7d;
        candidates.push({
          tool: stat.tool,
          dataType,
          fromCategory: "warm",
          toCategory: "cold",
          reason: `Only queried ${stat.count_7d} times in 7d (threshold: ${PROMOTION_THRESHOLDS.warm_to_cold_queries_7d})`,
          confidence: Math.max(confidence, 0.5),
          stats: stat,
        });
      }
    } else if (currentCategory === "hot") {
      // Hot → Warm demotion
      if (stat.count_7d <= PROMOTION_THRESHOLDS.hot_to_warm_queries_7d) {
        const confidence =
          1.0 - stat.count_7d / PROMOTION_THRESHOLDS.hot_to_warm_queries_7d;
        candidates.push({
          tool: stat.tool,
          dataType,
          fromCategory: "hot",
          toCategory: "warm",
          reason: `Only queried ${stat.count_7d} times in 7d (threshold: ${PROMOTION_THRESHOLDS.hot_to_warm_queries_7d})`,
          confidence: Math.max(confidence, 0.5),
          stats: stat,
        });
      }
    }
  }

  // Sort by confidence (highest first)
  return candidates.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Apply a promotion to a device's manifest
 */
export function applyPromotion(
  deviceToken: string,
  candidate: PromotionCandidate
): boolean {
  if (candidate.confidence < PROMOTION_THRESHOLDS.min_confidence) {
    console.log(
      `[A.L.A.N.] Skipping low-confidence promotion: ${candidate.tool} (${candidate.confidence.toFixed(2)})`
    );
    return false;
  }

  const manifest = db.getDeviceManifest(deviceToken);

  // Remove from old category
  if (candidate.fromCategory === "hot") {
    manifest.hot.collect = manifest.hot.collect.filter(
      (t) => t !== candidate.dataType
    ) as HotDataType[];
  } else if (candidate.fromCategory === "warm") {
    manifest.warm.collect = manifest.warm.collect.filter(
      (t) => t !== candidate.dataType
    ) as WarmDataType[];
  } else if (candidate.fromCategory === "cold") {
    manifest.cold.items = manifest.cold.items.filter(
      (t) => t !== candidate.dataType
    ) as ColdDataType[];
  }

  // Add to new category
  if (candidate.toCategory === "hot") {
    if (!manifest.hot.collect.includes(candidate.dataType as HotDataType)) {
      manifest.hot.collect.push(candidate.dataType as HotDataType);
    }
  } else if (candidate.toCategory === "warm") {
    if (!manifest.warm.collect.includes(candidate.dataType as WarmDataType)) {
      manifest.warm.collect.push(candidate.dataType as WarmDataType);
    }
  } else if (candidate.toCategory === "cold") {
    if (!manifest.cold.items.includes(candidate.dataType as ColdDataType)) {
      manifest.cold.items.push(candidate.dataType as ColdDataType);
    }
  }

  // Update manifest version
  const [major, minor, patch] = manifest.version.split(".").map(Number);
  manifest.version = `${major}.${minor}.${patch + 1}`;

  // Save manifest
  db.updateDeviceManifest(deviceToken, manifest);

  // Record promotion
  db.recordPromotion(
    candidate.tool,
    candidate.fromCategory,
    candidate.toCategory,
    candidate.reason,
    candidate.confidence
  );

  console.log(
    `[A.L.A.N.] Applied promotion: ${candidate.dataType} (${candidate.fromCategory || "null"} → ${candidate.toCategory}) for ${deviceToken.slice(0, 8)}...`
  );

  return true;
}

/**
 * Run A.L.A.N. analysis for all devices with cached data
 */
export function runAnalysis(): {
  candidates: PromotionCandidate[];
  applied: number;
} {
  console.log("[A.L.A.N.] Running analysis...");

  const candidates = analyzeAndSuggestPromotions();
  let applied = 0;

  // For now, we don't auto-apply - just suggest
  // In the future, this could auto-apply to all devices with the tool

  console.log(`[A.L.A.N.] Found ${candidates.length} promotion candidates`);

  return { candidates, applied };
}

/**
 * Schedule periodic A.L.A.N. analysis
 */
export function startPeriodicAnalysis(intervalMs: number = 60 * 60 * 1000): NodeJS.Timeout {
  console.log(`[A.L.A.N.] Starting periodic analysis (every ${intervalMs / 1000}s)`);

  return setInterval(() => {
    try {
      runAnalysis();
    } catch (error) {
      console.error("[A.L.A.N.] Analysis error:", error);
    }
  }, intervalMs);
}
