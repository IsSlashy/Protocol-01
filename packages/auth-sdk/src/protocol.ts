/**
 * Protocol 01 Auth Protocol Utilities
 *
 * Handles encoding/decoding of auth payloads and URL generation
 */

import { AuthQRPayload, AuthDeepLink, AuthResponse } from './types';

/** Protocol version */
export const PROTOCOL_VERSION = 1;

/** Protocol identifier */
export const PROTOCOL_ID = 'p01-auth';

/** Default session TTL (5 minutes) */
export const DEFAULT_SESSION_TTL = 5 * 60 * 1000;

/** Maximum session TTL (30 minutes) */
export const MAX_SESSION_TTL = 30 * 60 * 1000;

/** Challenge length in bytes */
export const CHALLENGE_LENGTH = 32;

/**
 * Generate a random session ID
 */
export function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a random challenge string
 */
export function generateChallenge(): string {
  const bytes = new Uint8Array(CHALLENGE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Encode auth payload to base64url
 */
export function encodePayload(payload: AuthQRPayload): string {
  const json = JSON.stringify(payload);
  // Use base64url encoding (URL-safe)
  if (typeof btoa !== 'undefined') {
    return btoa(json)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }
  // Node.js environment
  return Buffer.from(json)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decode auth payload from base64url
 */
export function decodePayload(encoded: string): AuthQRPayload {
  // Restore base64 padding and characters
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }

  let json: string;
  if (typeof atob !== 'undefined') {
    json = atob(base64);
  } else {
    json = Buffer.from(base64, 'base64').toString('utf8');
  }

  const payload = JSON.parse(json) as AuthQRPayload;

  // Validate payload
  if (payload.protocol !== PROTOCOL_ID) {
    throw new Error(`Invalid protocol: ${payload.protocol}`);
  }
  if (payload.v !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${payload.v}`);
  }

  return payload;
}

/**
 * Generate deep link URL for QR code
 */
export function generateDeepLink(payload: AuthQRPayload): AuthDeepLink {
  const encoded = encodePayload(payload);
  return `p01://auth?payload=${encoded}` as AuthDeepLink;
}

/**
 * Parse deep link URL to extract payload
 */
export function parseDeepLink(url: string): AuthQRPayload | null {
  try {
    // Handle both p01:// and https:// schemes
    const urlObj = new URL(url.replace('p01://', 'https://p01.app/'));

    if (urlObj.pathname !== '/auth' && !url.startsWith('p01://auth')) {
      return null;
    }

    const payload = urlObj.searchParams.get('payload');
    if (!payload) {
      return null;
    }

    return decodePayload(payload);
  } catch (error) {
    console.error('[P01Auth] Failed to parse deep link:', error);
    return null;
  }
}

/**
 * Check if a URL is a P01 auth deep link
 */
export function isAuthDeepLink(url: string): boolean {
  return url.startsWith('p01://auth') || url.includes('p01.app/auth');
}

/**
 * Create the message to be signed for authentication
 * Format: "P01-AUTH:{service}:{session}:{challenge}:{timestamp}"
 */
export function createSignMessage(
  serviceId: string,
  sessionId: string,
  challenge: string,
  timestamp: number
): string {
  return `P01-AUTH:${serviceId}:${sessionId}:${challenge}:${timestamp}`;
}

/**
 * Verify that a timestamp is within acceptable range
 */
export function isTimestampValid(timestamp: number, maxAgeMs: number = 60000): boolean {
  const now = Date.now();
  return timestamp > now - maxAgeMs && timestamp < now + 5000; // Allow 5s future
}

/**
 * Check if session is expired
 */
export function isSessionExpired(expiresAt: number): boolean {
  return Date.now() > expiresAt;
}

/**
 * Generate callback URL with auth response as query params
 * (Alternative to POST callback)
 */
export function generateCallbackUrl(
  baseUrl: string,
  response: AuthResponse
): string {
  const url = new URL(baseUrl);
  url.searchParams.set('session', response.sessionId);
  url.searchParams.set('wallet', response.wallet);
  url.searchParams.set('signature', response.signature);
  url.searchParams.set('timestamp', response.timestamp.toString());
  if (response.subscriptionProof) {
    url.searchParams.set('proof', encodePayload(response.subscriptionProof as any));
  }
  return url.toString();
}
