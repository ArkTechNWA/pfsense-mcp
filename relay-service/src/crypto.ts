/**
 * Encryption utilities for API key storage
 *
 * API keys are encrypted using the device token as part of the key derivation.
 * This means:
 * - Relay stores encrypted keys, can't decrypt without device proving identity
 * - Device token acts as a "password" that unlocks the API key
 * - If device token is compromised, only that device's key is at risk
 */

import CryptoJS from "crypto-js";
import crypto from "crypto";

// Server-side secret (from environment)
const SERVER_SECRET = process.env.RELAY_SECRET || "change-me-in-production";

/**
 * Derive encryption key from device token + server secret
 */
function deriveKey(deviceToken: string): string {
  return CryptoJS.PBKDF2(deviceToken, SERVER_SECRET, {
    keySize: 256 / 32,
    iterations: 10000,
  }).toString();
}

/**
 * Encrypt API key for storage
 */
export function encryptApiKey(apiKey: string, deviceToken: string): string {
  const key = deriveKey(deviceToken);
  const encrypted = CryptoJS.AES.encrypt(apiKey, key).toString();
  return encrypted;
}

/**
 * Decrypt API key for use
 */
export function decryptApiKey(encryptedKey: string, deviceToken: string): string {
  const key = deriveKey(deviceToken);
  const decrypted = CryptoJS.AES.decrypt(encryptedKey, key);
  return decrypted.toString(CryptoJS.enc.Utf8);
}

/**
 * Generate a secure device token
 */
export function generateDeviceToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Generate HMAC signature for webhook verification
 */
export function generateSignature(payload: string, timestamp: string, secret: string): string {
  return CryptoJS.HmacSHA256(`${timestamp}.${payload}`, secret).toString();
}

/**
 * Verify webhook signature
 */
export function verifySignature(
  payload: string,
  timestamp: string,
  signature: string,
  secret: string
): boolean {
  const expected = generateSignature(payload, timestamp, secret);

  // Timing-safe comparison
  if (expected.length !== signature.length) return false;

  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Hash for alert deduplication (not security-sensitive)
 */
export function hashAlert(eventType: string, summary: string): string {
  return CryptoJS.SHA256(`${eventType}:${summary}`).toString().slice(0, 16);
}
