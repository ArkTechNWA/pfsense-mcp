/**
 * Claude diagnostic executor
 *
 * Runs Claude Code with the user's API key to diagnose pfSense issues.
 * Completely passive - only runs when pfSense pushes an emergency.
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as db from "../db";
import * as crypto from "../crypto";
import { sendAlert } from "../alerter";

const execAsync = promisify(exec);

// Event processing queue (simple in-memory, debounces flapping)
interface QueuedEvent {
  event: db.Event;
  device: db.Device;
  addedAt: number;
}

const eventQueue: Map<string, QueuedEvent> = new Map();
const DEBOUNCE_MS = 30 * 1000; // 30 seconds debounce for same event type

/**
 * Queue an event for diagnostic processing
 */
export async function queueDiagnostic(event: db.Event, device: db.Device): Promise<void> {
  const key = `${device.token}:${event.event_type}`;

  // Check if we already have this type queued
  const existing = eventQueue.get(key);
  if (existing) {
    // Update with newer event data, reset timer
    existing.event = event;
    existing.addedAt = Date.now();
    console.log(`[Executor] Debounced event ${event.event_type} for ${device.name || device.token.slice(0, 8)}`);
    return;
  }

  // Add to queue
  eventQueue.set(key, { event, device, addedAt: Date.now() });

  // Schedule processing after debounce period
  setTimeout(() => processQueuedEvent(key), DEBOUNCE_MS);
}

/**
 * Process a queued event
 */
async function processQueuedEvent(key: string): Promise<void> {
  const queued = eventQueue.get(key);
  if (!queued) return;

  // Check if it was recently updated (debounce extension)
  const elapsed = Date.now() - queued.addedAt;
  if (elapsed < DEBOUNCE_MS) {
    // Re-schedule
    setTimeout(() => processQueuedEvent(key), DEBOUNCE_MS - elapsed);
    return;
  }

  // Remove from queue
  eventQueue.delete(key);

  // Process
  await runDiagnostic(queued.event, queued.device);
}

/**
 * Run Claude diagnostic for an event
 */
async function runDiagnostic(event: db.Event, device: db.Device): Promise<void> {
  console.log(`[Executor] Running diagnostic for event ${event.id}: ${event.event_type}`);

  const startTime = Date.now();

  try {
    // Decrypt API key
    const apiKey = crypto.decryptApiKey(device.api_key_encrypted, device.token);
    if (!apiKey) {
      throw new Error("Failed to decrypt API key");
    }

    // Select prompt based on event type
    const promptFile = selectPrompt(event.event_type);
    const promptPath = path.join(__dirname, "../../prompts", promptFile);
    let prompt: string;

    try {
      prompt = await fs.readFile(promptPath, "utf-8");
    } catch {
      // Fallback to generic prompt
      prompt = await fs.readFile(path.join(__dirname, "../../prompts/emergency-generic.md"), "utf-8");
    }

    // Parse raw data for context
    const context = event.raw_data ? JSON.parse(event.raw_data) : {};

    // Build full prompt
    const fullPrompt = `${prompt}

## Event Details
- Type: ${event.event_type}
- Severity: ${event.severity}
- Summary: ${event.summary}
- Time: ${new Date(event.created_at).toISOString()}

## Context from pfSense
\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`
`;

    // Run Claude Code
    const result = await execAsync(
      `claude --print -p "${escapeForShell(fullPrompt)}"`,
      {
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: apiKey,
        },
        timeout: 120000, // 2 minute timeout
        maxBuffer: 1024 * 1024, // 1MB output buffer
      }
    );

    const durationMs = Date.now() - startTime;

    // Store diagnostic result
    const diagnostic = db.insertDiagnostic(
      event.id,
      promptFile,
      result.stdout,
      extractSuggestions(result.stdout),
      durationMs
    );

    console.log(`[Executor] Diagnostic ${diagnostic.id} completed in ${durationMs}ms`);

    // Send alert to user
    await sendAlert(device, event, result.stdout);

  } catch (error) {
    const durationMs = Date.now() - startTime;
    console.error(`[Executor] Diagnostic failed after ${durationMs}ms:`, error);

    // Store error diagnostic
    db.insertDiagnostic(
      event.id,
      "error",
      `Diagnostic failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      durationMs
    );

    // Alert user about failure
    await sendAlert(device, event, `Diagnostic failed: ${error instanceof Error ? error.message : "Unknown error"}\n\nPlease check your API key and try again.`);
  }
}

/**
 * Select prompt file based on event type
 */
function selectPrompt(eventType: string): string {
  const promptMap: Record<string, string> = {
    "lan_down": "emergency-lan-down.md",
    "wan_down": "emergency-wan-down.md",
    "interface_down": "emergency-interface-down.md",
    "service_crash": "emergency-service.md",
    "gateway_down": "emergency-gateway.md",
    "high_cpu": "emergency-resource.md",
    "high_memory": "emergency-resource.md",
    "disk_full": "emergency-resource.md",
    "config_error": "emergency-config.md",
  };

  return promptMap[eventType] || "emergency-generic.md";
}

/**
 * Extract suggested actions from Claude's response
 */
function extractSuggestions(response: string): string[] {
  const suggestions: string[] = [];

  // Look for numbered lists or bullet points with action verbs
  const lines = response.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Match "1. ", "- ", "* " followed by action verbs
    if (/^(\d+\.|[-*])\s+(restart|check|verify|run|execute|inspect|review|update|modify|configure)/i.test(trimmed)) {
      suggestions.push(trimmed.replace(/^(\d+\.|[-*])\s+/, ""));
    }
  }

  return suggestions.slice(0, 5); // Max 5 suggestions
}

/**
 * Escape string for shell command
 */
function escapeForShell(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/\n/g, "\\n");
}

/**
 * Get queue status
 */
export function getQueueStatus(): { pending: number; keys: string[] } {
  return {
    pending: eventQueue.size,
    keys: Array.from(eventQueue.keys()),
  };
}
