/**
 * pfSense MCP Tools
 *
 * Phase A1-A2: Core infrastructure + read operations
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// Tool definitions for MCP
export const TOOLS: Tool[] = [
  // ==========================================================================
  // HEALTH & DIAGNOSTICS
  // ==========================================================================
  {
    name: "pf_health",
    description:
      "Get pfSense health status including NEVERHANG circuit breaker state, " +
      "A.L.A.N. learning metrics, and connectivity status. Always call this first " +
      "to verify pfSense is reachable.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ==========================================================================
  // SYSTEM
  // ==========================================================================
  {
    name: "pf_system_info",
    description:
      "Get pfSense system information: hostname, domain, version, platform.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "pf_system_status",
    description:
      "Get pfSense system status: uptime, CPU usage, memory usage, disk usage.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ==========================================================================
  // INTERFACES
  // ==========================================================================
  {
    name: "pf_interface_list",
    description:
      "List all network interfaces with their configuration and status.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "pf_interface_status",
    description:
      "Get detailed status for a specific interface including traffic stats.",
    inputSchema: {
      type: "object",
      properties: {
        interface: {
          type: "string",
          description: "Interface name (e.g., 'wan', 'lan', 'igb0')",
        },
      },
      required: ["interface"],
    },
  },

  // ==========================================================================
  // FIREWALL
  // ==========================================================================
  {
    name: "pf_firewall_rules",
    description:
      "List all firewall rules. Shows rule type, interface, protocol, source, destination.",
    inputSchema: {
      type: "object",
      properties: {
        interface: {
          type: "string",
          description: "Filter by interface (optional)",
        },
      },
      required: [],
    },
  },
  {
    name: "pf_firewall_states",
    description:
      "Get current firewall state table. Shows active connections.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of states to return (default: 100)",
        },
      },
      required: [],
    },
  },

  // ==========================================================================
  // DHCP
  // ==========================================================================
  {
    name: "pf_dhcp_leases",
    description:
      "Get DHCP leases. Shows IP, MAC, hostname, status, and lease times.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["active", "expired", "static", "all"],
          description: "Filter by lease status (default: all)",
        },
      },
      required: [],
    },
  },

  // ==========================================================================
  // GATEWAYS
  // ==========================================================================
  {
    name: "pf_gateway_status",
    description:
      "Get gateway status. Shows online/offline status, latency, packet loss.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ==========================================================================
  // SERVICES
  // ==========================================================================
  {
    name: "pf_services_list",
    description:
      "List all services with their status (running/stopped).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ==========================================================================
  // DIAGNOSTICS
  // ==========================================================================
  {
    name: "pf_diag_ping",
    description:
      "Ping a host from pfSense. Useful for testing connectivity from the router's perspective.",
    inputSchema: {
      type: "object",
      properties: {
        host: {
          type: "string",
          description: "Hostname or IP address to ping",
        },
        count: {
          type: "number",
          description: "Number of ping packets (default: 3, max: 10)",
        },
      },
      required: ["host"],
    },
  },
  {
    name: "pf_diag_arp",
    description:
      "Get ARP table. Shows IP-to-MAC mappings for devices on the network.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// Tool name type for type safety
export type ToolName = typeof TOOLS[number]["name"];
