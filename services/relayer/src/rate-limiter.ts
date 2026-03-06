/**
 * In-memory sliding window rate limiter middleware for Express.
 *
 * Uses a sliding window counter approach: each IP gets a list of request
 * timestamps. On each request, expired timestamps (older than the window)
 * are pruned. If the remaining count exceeds the limit, the request is
 * rejected with HTTP 429 and a Retry-After header.
 *
 * Includes automatic cleanup of stale entries to prevent memory leaks.
 */

import { Request, Response, NextFunction } from 'express';
import winston from 'winston';

interface WindowEntry {
  timestamps: number[];
}

interface RateLimiterOptions {
  /** Maximum number of requests allowed within the window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Label for logging (e.g. "proof", "general"). */
  label: string;
  /** Optional logger instance. */
  logger?: winston.Logger;
}

/**
 * Extract the client IP from the request, respecting X-Forwarded-For
 * when the app is behind a reverse proxy.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    // X-Forwarded-For can be a comma-separated list; take the first (original client)
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Create a rate-limiting Express middleware using a sliding window algorithm.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const { maxRequests, windowMs, label, logger } = options;
  const store = new Map<string, WindowEntry>();

  // Periodically clean up entries that have no recent timestamps.
  // Runs every 5 minutes to prevent unbounded memory growth.
  const CLEANUP_INTERVAL = 5 * 60 * 1000;
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of store) {
      // Remove timestamps outside the window
      entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);
      // Delete the entry entirely if empty
      if (entry.timestamps.length === 0) {
        store.delete(ip);
      }
    }
  }, CLEANUP_INTERVAL);

  // Allow the Node process to exit even if this timer is pending
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  return function rateLimiterMiddleware(req: Request, res: Response, next: NextFunction) {
    const ip = getClientIp(req);
    const now = Date.now();

    let entry = store.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(ip, entry);
    }

    // Prune timestamps outside the current window
    entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);

    if (entry.timestamps.length >= maxRequests) {
      // Calculate when the oldest request in the window expires
      const oldestInWindow = entry.timestamps[0];
      const retryAfterMs = windowMs - (now - oldestInWindow);
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

      if (logger) {
        logger.warn(`[RateLimit:${label}] IP ${ip} exceeded ${maxRequests} req/${windowMs / 1000}s on ${req.method} ${req.path}`);
      }

      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many requests',
        retryAfterSeconds,
        limit: maxRequests,
        windowSeconds: windowMs / 1000,
      });
    }

    // Record this request
    entry.timestamps.push(now);

    // Set informational rate-limit headers (draft standard)
    res.set('X-RateLimit-Limit', String(maxRequests));
    res.set('X-RateLimit-Remaining', String(maxRequests - entry.timestamps.length));
    res.set('X-RateLimit-Reset', String(Math.ceil((now + windowMs) / 1000)));

    next();
  };
}
