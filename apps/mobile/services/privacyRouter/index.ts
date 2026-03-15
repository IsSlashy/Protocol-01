/**
 * Privacy Router — Optional enhanced privacy for shielded transactions.
 *
 * Splits funds across up to 20 intermediate wallets with randomized time delays,
 * making it impossible to trace the source, destination, or amount.
 *
 * How it works:
 * 1. Amount is split into N notes of a fixed denomination
 * 2. Each note is shielded into the anonymity pool
 * 3. After random maturation delays, notes are unshielded to stealth addresses
 * 4. Stealth addresses re-shield for additional hops (based on privacy level)
 * 5. Final unshield delivers to the real destination
 *
 * All routing data is encrypted with the user's spending key and stored locally.
 * The route can be reconstructed from the spending key alone (deterministic derivation).
 *
 * Security properties:
 * - No intermediate address is linkable to the sender or recipient
 * - Time delays break temporal correlation
 * - Fixed denominations prevent amount-based analysis
 * - All secrets are derived deterministically (recoverable from spending key)
 * - Route data is encrypted at rest (XSalsa20-Poly1305 via nacl.secretbox)
 *
 * Usage:
 *   import { initPrivacyRouter, startPrivateRoute, getRouteEstimate } from '@/services/privacyRouter';
 *
 *   // At app startup (after auth)
 *   await initPrivacyRouter({ spendingKeyHash, callbacks });
 *
 *   // Estimate before committing
 *   const estimate = getRouteEstimate({ amount: 10, privacyLevel: 3 });
 *
 *   // Start a route
 *   const route = await startPrivateRoute({ amount: 10, destination: '...', privacyLevel: 3, spendingKeyHash });
 */

import {
  PrivacyLevel,
  PrivacyRoute,
  RouteProgress,
  RouteFeeEstimate,
  PrivacyRouterConfig,
  HopExecutionCallbacks,
  PRIVACY_LEVEL_CONFIGS,
} from './types';
import { planRoute, estimateFees } from './routePlanner';
import {
  saveRoute,
  loadRoute,
  loadAllRoutes,
  deleteRoute,
} from './routeCipher';
import {
  registerPrivacyRouterTask,
  scheduleRoute,
  cancelRoute as cancelScheduledRoute,
  checkPendingRoutes,
  executeHop,
} from './scheduler';

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type {
  PrivacyLevel,
  PrivacyRoute,
  RouteProgress,
  RouteFeeEstimate,
  PrivacyRouterConfig,
  HopExecutionCallbacks,
} from './types';
export { PRIVACY_LEVEL_CONFIGS } from './types';
export type { RouteHop, Denomination, RouteStatus } from './types';
export { deriveRouteStealthKeypair, deriveStealthAddress, deriveHopKeypairs } from './stealthManager';
export { encryptRoute, decryptRoute, RouteCipherError } from './routeCipher';
export { PRIVACY_ROUTER_TASK } from './scheduler';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Default router configuration */
const DEFAULT_CONFIG: PrivacyRouterConfig = {
  minHopDelay: 15 * 60_000, // 15 minutes
  maxHopDelay: 240 * 60_000, // 4 hours
  minAnonymitySet: 10, // minimum pool depth
  enforcePoolDepth: true,
  maxRetries: 3,
  retryDelay: 30_000, // 30 seconds
};

/** Current router configuration (merged with defaults) */
let _config: PrivacyRouterConfig = { ...DEFAULT_CONFIG };

/** Monotonic nonce counter for route IDs */
let _nonce = 0;

/** Whether the router has been initialized */
let _initialized = false;

/** Spending key hash for the current session */
let _sessionSpendingKeyHash: string | null = null;

/** Execution callbacks for hop processing */
let _callbacks: HopExecutionCallbacks | null = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the Privacy Router.
 *
 * Must be called once after user authentication, before creating routes.
 * Registers the background task for executing scheduled hops.
 *
 * @param params.spendingKeyHash - Hex-encoded hash of the spending key
 * @param params.callbacks - Shield/unshield callbacks (decoupled from services)
 * @param params.config - Optional configuration overrides
 */
export async function initPrivacyRouter(params: {
  spendingKeyHash: string;
  callbacks: HopExecutionCallbacks;
  config?: Partial<PrivacyRouterConfig>;
}): Promise<void> {
  const { spendingKeyHash, callbacks, config } = params;

  _sessionSpendingKeyHash = spendingKeyHash;
  _callbacks = callbacks;

  if (config) {
    _config = { ..._config, ...config };
  }

  // Load the current nonce from existing routes
  try {
    const existingRoutes = await loadAllRoutes(spendingKeyHash);
    if (existingRoutes.length > 0) {
      _nonce = Math.max(...existingRoutes.map((r) => r.nonce)) + 1;
    }
  } catch {
    _nonce = Date.now(); // Fallback: use timestamp as nonce
  }

  // Register background task
  await registerPrivacyRouterTask(spendingKeyHash, callbacks);

  _initialized = true;
  console.log('[PrivacyRouter] Initialized');
}

// ---------------------------------------------------------------------------
// Route creation
// ---------------------------------------------------------------------------

/**
 * Create and start a new privacy route.
 *
 * Plans the route, encrypts and saves it to SecureStore, and schedules
 * all hops for background execution.
 *
 * @param params.amount - Amount to send in SOL
 * @param params.destination - Base58 pubkey or stealth address of the final recipient
 * @param params.privacyLevel - Privacy level (1-5)
 * @param params.spendingKeyHash - Hex-encoded hash of the spending key
 * @returns The complete privacy route plan
 * @throws Error if the router is not initialized or parameters are invalid
 */
export async function startPrivateRoute(params: {
  amount: number;
  destination: string;
  privacyLevel: PrivacyLevel;
  spendingKeyHash: string;
}): Promise<PrivacyRoute> {
  assertInitialized();

  const { amount, destination, privacyLevel, spendingKeyHash } = params;

  // Validate amount
  if (amount <= 0) {
    throw new PrivacyRouterError('INVALID_PARAMS', 'Amount must be positive');
  }
  if (amount < 0.1) {
    throw new PrivacyRouterError(
      'INVALID_PARAMS',
      'Minimum routable amount is 0.1 SOL (smallest denomination)',
    );
  }

  // Plan the route
  const currentNonce = _nonce++;
  const route = planRoute({
    amount,
    destination,
    privacyLevel,
    spendingKeyHash,
    nonce: currentNonce,
    config: _config,
  });

  // Save encrypted route and schedule execution
  await scheduleRoute(route, spendingKeyHash);

  console.log(
    `[PrivacyRouter] Route started: ${route.id.slice(0, 8)}... ` +
      `(${route.hops.length} hops, ~${formatDuration(route.estimatedCompletionAt - route.createdAt)})`,
  );

  return route;
}

// ---------------------------------------------------------------------------
// Fee estimation
// ---------------------------------------------------------------------------

/**
 * Get a fee estimate without starting a route.
 *
 * Useful for showing the user what a route will cost before they commit.
 *
 * @param params.amount - Amount in SOL
 * @param params.privacyLevel - Privacy level (1-5)
 * @returns Detailed fee breakdown
 */
export function getRouteEstimate(params: {
  amount: number;
  privacyLevel: PrivacyLevel;
}): RouteFeeEstimate {
  return estimateFees(params);
}

// ---------------------------------------------------------------------------
// Route monitoring
// ---------------------------------------------------------------------------

/**
 * Get the progress of an active route.
 *
 * @param routeId - The route ID
 * @param spendingKeyHash - Hex-encoded spending key hash
 * @returns Route progress for UI display, or null if the route is not found
 */
export async function getRouteProgress(
  routeId: string,
  spendingKeyHash: string,
): Promise<RouteProgress | null> {
  const route = await loadRoute(routeId, spendingKeyHash);
  if (!route) return null;

  const totalHops = route.hops.length;
  const completedHops = route.hops.filter((h) => h.status === 'completed').length;
  const percentComplete =
    totalHops > 0 ? Math.round((completedHops / totalHops) * 100) : 0;

  // Find the currently executing or next pending hop
  const currentHop =
    route.hops.find(
      (h) =>
        h.status === 'shielding' ||
        h.status === 'unshielding' ||
        h.status === 'reshielding',
    ) ?? route.hops.find((h) => h.status === 'pending');

  // Estimate time remaining
  const now = Date.now();
  const remainingHops = route.hops.filter(
    (h) => h.status !== 'completed' && h.status !== 'failed',
  );
  const latestScheduledAt =
    remainingHops.length > 0
      ? Math.max(...remainingHops.map((h) => h.scheduledAt))
      : now;
  const estimatedTimeRemaining = formatDuration(
    Math.max(0, latestScheduledAt - now),
  );

  return {
    routeId,
    totalHops,
    completedHops,
    currentStatus: route.status,
    percentComplete,
    estimatedTimeRemaining,
    currentHop,
  };
}

// ---------------------------------------------------------------------------
// Route management
// ---------------------------------------------------------------------------

/**
 * Cancel an active route.
 *
 * Marks all pending hops as failed. Already-completed hops cannot be undone.
 * The user should manually unshield any notes that were already shielded
 * into intermediate pools.
 *
 * @param routeId - The route ID to cancel
 * @param spendingKeyHash - Hex-encoded spending key hash
 */
export async function cancelPrivateRoute(
  routeId: string,
  spendingKeyHash: string,
): Promise<void> {
  assertInitialized();
  await cancelScheduledRoute(routeId, spendingKeyHash);
  console.log(`[PrivacyRouter] Route ${routeId.slice(0, 8)}... cancelled`);
}

/**
 * List all routes (active and completed).
 *
 * @param spendingKeyHash - Hex-encoded spending key hash
 * @returns Array of all routes, sorted by creation time (newest first)
 */
export async function listRoutes(
  spendingKeyHash: string,
): Promise<PrivacyRoute[]> {
  const routes = await loadAllRoutes(spendingKeyHash);
  return routes.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Resume route execution after app restart.
 *
 * Checks for any routes with pending hops whose scheduled time has passed
 * and executes them. Should be called after initPrivacyRouter() on app startup.
 *
 * @param spendingKeyHash - Hex-encoded spending key hash
 */
export async function resumeRoutes(
  spendingKeyHash: string,
): Promise<void> {
  if (!_callbacks) {
    console.warn('[PrivacyRouter] Cannot resume: no execution callbacks set');
    return;
  }

  const pending = await checkPendingRoutes(spendingKeyHash);

  if (pending.length === 0) {
    console.log('[PrivacyRouter] No pending hops to resume');
    return;
  }

  console.log(`[PrivacyRouter] Resuming ${pending.length} pending hops`);

  for (const { hop, route } of pending) {
    try {
      await executeHop(hop, route, spendingKeyHash, _callbacks);
    } catch (error) {
      console.error(
        `[PrivacyRouter] Failed to resume hop ${hop.id.slice(0, 8)}...:`,
        error,
      );
    }
  }
}

/**
 * Delete a completed or failed route from storage.
 *
 * Only deletes routes that are not actively being processed.
 *
 * @param routeId - The route ID to delete
 * @param spendingKeyHash - Hex-encoded spending key hash
 */
export async function removeRoute(
  routeId: string,
  spendingKeyHash: string,
): Promise<void> {
  const route = await loadRoute(routeId, spendingKeyHash);

  if (route && route.status !== 'completed' && route.status !== 'failed') {
    throw new PrivacyRouterError(
      'ROUTE_ACTIVE',
      'Cannot delete an active route. Cancel it first.',
    );
  }

  await deleteRoute(routeId);
  console.log(`[PrivacyRouter] Route ${routeId.slice(0, 8)}... deleted`);
}

// ---------------------------------------------------------------------------
// Feature availability
// ---------------------------------------------------------------------------

/**
 * Check if the Privacy Router feature is available.
 *
 * Returns true if the router has been initialized and has valid
 * execution callbacks configured.
 */
export function isPrivacyRouterAvailable(): boolean {
  return _initialized && _callbacks !== null && _sessionSpendingKeyHash !== null;
}

/**
 * Check if there are any active (non-completed, non-failed) routes.
 *
 * @param spendingKeyHash - Hex-encoded spending key hash
 * @returns True if there are active routes
 */
export async function hasActiveRoutes(
  spendingKeyHash: string,
): Promise<boolean> {
  const routes = await loadAllRoutes(spendingKeyHash);
  return routes.some(
    (r) => r.status !== 'completed' && r.status !== 'failed',
  );
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class PrivacyRouterError extends Error {
  code:
    | 'NOT_INITIALIZED'
    | 'INVALID_PARAMS'
    | 'ROUTE_ACTIVE'
    | 'ROUTE_NOT_FOUND'
    | 'EXECUTION_FAILED';

  constructor(
    code: PrivacyRouterError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'PrivacyRouterError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Assert that the router has been initialized.
 */
function assertInitialized(): void {
  if (!_initialized) {
    throw new PrivacyRouterError(
      'NOT_INITIALIZED',
      'Privacy Router not initialized. Call initPrivacyRouter() first.',
    );
  }
}

/**
 * Format a duration in milliseconds as a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}
