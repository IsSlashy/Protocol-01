/**
 * Security middleware for the P01 Bundle Engine.
 *
 * 1. Rate limiter — privacy-preserving (HMAC of IP, key rotates on restart)
 * 2. Security headers — anti-fingerprinting, anti-clickjacking
 *
 * Design principles:
 * - NEVER store or log real IP addresses
 * - NEVER leak server internals (Express version, stack traces)
 * - Minimal attack surface — block everything except what's needed
 */

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Privacy-preserving rate limiter
// ---------------------------------------------------------------------------

/**
 * HMAC key generated at startup — cannot reverse IPs, and rotates on
 * every restart so historical rate-limit data is not linkable across deploys.
 */
const RATE_KEY = crypto.randomBytes(32);

/** Requests per minute per client hash */
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '120', 10);

/** Window duration (ms) */
const RATE_WINDOW_MS = 60_000;

interface RateEntry {
  count: number;
  resetAt: number;
}

const rateMap = new Map<string, RateEntry>();

// Purge stale entries every 2 minutes to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateMap) {
    if (now > entry.resetAt) rateMap.delete(key);
  }
}, 120_000).unref();

/**
 * Hash a client identifier using HMAC-SHA256.
 * The relay never stores or has access to the original IP.
 */
function hashClient(req: Request): string {
  const raw = req.ip || req.socket?.remoteAddress || 'unknown';
  return crypto
    .createHmac('sha256', RATE_KEY)
    .update(raw)
    .digest('hex')
    .slice(0, 16);
}

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const clientHash = hashClient(req);
  const now = Date.now();

  let entry = rateMap.get(clientHash);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateMap.set(clientHash, entry);
  }

  entry.count++;

  // Standard rate-limit headers (contain no PII)
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_RPM);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_RPM - entry.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

  if (entry.count > RATE_LIMIT_RPM) {
    res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfterSec: Math.ceil((entry.resetAt - now) / 1000),
    });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Block framing (clickjacking)
  res.setHeader('X-Frame-Options', 'DENY');
  // Strict CSP — JSON API only, no scripts
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  // Disable referrer leaking
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Block FLoC / Topics API tracking
  res.setHeader('Permissions-Policy', 'interest-cohort=(), browsing-topics=()');
  // Force HTTPS (1 year, include subdomains)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Don't leak Express
  res.removeHeader('X-Powered-By');

  next();
}

// ---------------------------------------------------------------------------
// Request sanitizer — strip identifying metadata from incoming requests
// ---------------------------------------------------------------------------

export function stripMetadata(req: Request, _res: Response, next: NextFunction): void {
  // These headers could identify or fingerprint the client
  delete req.headers['x-forwarded-for'];
  delete req.headers['x-real-ip'];
  delete req.headers['x-forwarded-proto'];
  delete req.headers['x-forwarded-host'];
  delete req.headers['user-agent'];
  delete req.headers['referer'];
  delete req.headers['origin'];
  delete req.headers['cookie'];
  delete req.headers['authorization'];
  delete req.headers['x-request-id'];
  delete req.headers['x-correlation-id'];
  delete req.headers['x-client-ip'];
  delete req.headers['cf-connecting-ip'];
  delete req.headers['true-client-ip'];
  delete req.headers['x-cluster-client-ip'];
  delete req.headers['fastly-client-ip'];
  delete req.headers['x-forwarded'];
  delete req.headers['forwarded-for'];
  delete req.headers['forwarded'];

  next();
}
