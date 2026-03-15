/**
 * Scheduler — Time-delayed execution of privacy route hops.
 *
 * Uses expo-task-manager for background execution and expo-background-fetch
 * for periodic wake-ups. Each hop is checked against its scheduledAt timestamp
 * and executed when the time arrives.
 *
 * Background execution model:
 * - iOS: Background fetch wakes the app every ~15 minutes (OS-controlled minimum)
 * - Android: BackgroundFetch with startOnBoot + stopOnTerminate=false
 * - Foreground: Active routes are polled when the app is open
 *
 * The scheduler is stateless — all route state lives in encrypted SecureStore.
 * On each wake-up, it loads pending routes, finds due hops, and executes them.
 *
 * IMPORTANT: The executeHop function accepts callback functions for shield/unshield
 * operations, keeping the Privacy Router decoupled from other services.
 */

import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { PrivacyRoute, RouteHop, HopExecutionCallbacks } from './types';
import { loadAllRoutes, saveRoute } from './routeCipher';
import { deriveRouteStealthKeypair } from './stealthManager';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Background task name for periodic route processing */
export const PRIVACY_ROUTER_TASK = 'PRIVACY_ROUTER_BACKGROUND_TASK';

/** Minimum background fetch interval in seconds (iOS minimum is 15 min) */
const BACKGROUND_FETCH_INTERVAL_S = 15 * 60;

/** Maximum number of hops to execute in a single wake-up cycle */
const MAX_HOPS_PER_CYCLE = 5;

// ---------------------------------------------------------------------------
// Module state (in-memory only, not persisted)
// ---------------------------------------------------------------------------

/** Currently registered execution callbacks (set by initPrivacyRouter) */
let _executionCallbacks: HopExecutionCallbacks | null = null;

/** Spending key hash for the current session (set by initPrivacyRouter) */
let _spendingKeyHash: string | null = null;

/** Whether the background task has been registered */
let _taskRegistered = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register the background task for periodic route processing.
 * Call once at app startup, after authentication.
 *
 * @param spendingKeyHash - Hex-encoded spending key hash for route decryption
 * @param callbacks - Shield/unshield callbacks for hop execution
 */
export async function registerPrivacyRouterTask(
  spendingKeyHash: string,
  callbacks: HopExecutionCallbacks,
): Promise<void> {
  _spendingKeyHash = spendingKeyHash;
  _executionCallbacks = callbacks;

  if (_taskRegistered) return;

  try {
    // Define the background task
    TaskManager.defineTask(PRIVACY_ROUTER_TASK, async () => {
      try {
        if (!_spendingKeyHash || !_executionCallbacks) {
          return BackgroundFetch.BackgroundFetchResult.NoData;
        }

        const pendingHops = await checkPendingRoutes(_spendingKeyHash);

        if (pendingHops.length === 0) {
          return BackgroundFetch.BackgroundFetchResult.NoData;
        }

        // Execute up to MAX_HOPS_PER_CYCLE hops in this wake-up
        let executed = 0;
        for (const { hop, route } of pendingHops.slice(0, MAX_HOPS_PER_CYCLE)) {
          const result = await executeHop(hop, route, _spendingKeyHash, _executionCallbacks);
          if (result.success) {
            executed++;
          }
        }

        return executed > 0
          ? BackgroundFetch.BackgroundFetchResult.NewData
          : BackgroundFetch.BackgroundFetchResult.Failed;
      } catch (error) {
        console.error('[PrivacyRouter] Background task error:', error);
        return BackgroundFetch.BackgroundFetchResult.Failed;
      }
    });

    // Register for periodic wake-ups
    await BackgroundFetch.registerTaskAsync(PRIVACY_ROUTER_TASK, {
      minimumInterval: BACKGROUND_FETCH_INTERVAL_S,
      stopOnTerminate: false,
      startOnBoot: true,
    });

    _taskRegistered = true;
    console.log('[PrivacyRouter] Background task registered');
  } catch (error) {
    console.error('[PrivacyRouter] Failed to register background task:', error);
    // Non-fatal: foreground polling will still work
  }
}

/**
 * Schedule all pending hops for a route.
 *
 * In practice, this saves the route to encrypted storage and ensures
 * the background task is registered. The background task will pick up
 * hops as their scheduledAt times arrive.
 *
 * @param route - The route to schedule
 * @param spendingKeyHash - Hex-encoded spending key hash
 */
export async function scheduleRoute(
  route: PrivacyRoute,
  spendingKeyHash: string,
): Promise<void> {
  // Save route to encrypted storage (the scheduler reads from storage)
  await saveRoute(route, spendingKeyHash);
  console.log(
    `[PrivacyRouter] Route ${route.id.slice(0, 8)}... scheduled with ${route.hops.length} hops`,
  );
}

/**
 * Cancel all pending hops for a route.
 *
 * Marks all pending hops as failed and updates the route status.
 * Does NOT unshield any already-shielded notes (that requires cancelPrivateRoute).
 *
 * @param routeId - The route ID to cancel
 * @param spendingKeyHash - Hex-encoded spending key hash
 */
export async function cancelRoute(
  routeId: string,
  spendingKeyHash: string,
): Promise<void> {
  const routes = await loadAllRoutes(spendingKeyHash);
  const route = routes.find((r) => r.id === routeId);

  if (!route) {
    console.warn(`[PrivacyRouter] Route ${routeId.slice(0, 8)}... not found for cancellation`);
    return;
  }

  // Mark all non-completed hops as failed
  for (const hop of route.hops) {
    if (hop.status !== 'completed') {
      hop.status = 'failed';
    }
  }

  route.status = 'failed';
  await saveRoute(route, spendingKeyHash);

  console.log(`[PrivacyRouter] Route ${routeId.slice(0, 8)}... cancelled`);
}

/**
 * Get the next hop that needs execution (scheduledAt has passed, status is pending).
 *
 * @param route - The route to check
 * @returns The next pending hop, or null if none are due
 */
export function getNextPendingHop(route: PrivacyRoute): RouteHop | null {
  const now = Date.now();

  // Find the first pending hop whose scheduled time has passed
  // Hops should already be sorted by scheduledAt in the route
  for (const hop of route.hops) {
    if (hop.status === 'pending' && hop.scheduledAt <= now) {
      return hop;
    }
  }

  return null;
}

/**
 * Check all routes for hops that need attention.
 * Used by both background task and foreground polling.
 *
 * @param spendingKeyHash - Hex-encoded spending key hash
 * @returns Array of {hop, route} pairs that are due for execution
 */
export async function checkPendingRoutes(
  spendingKeyHash: string,
): Promise<Array<{ hop: RouteHop; route: PrivacyRoute }>> {
  const routes = await loadAllRoutes(spendingKeyHash);
  const pending: Array<{ hop: RouteHop; route: PrivacyRoute }> = [];
  const now = Date.now();

  for (const route of routes) {
    // Skip completed or failed routes
    if (route.status === 'completed' || route.status === 'failed') {
      continue;
    }

    for (const hop of route.hops) {
      if (hop.status === 'pending' && hop.scheduledAt <= now) {
        pending.push({ hop, route });
      }
    }
  }

  // Sort by scheduledAt (oldest first)
  pending.sort((a, b) => a.hop.scheduledAt - b.hop.scheduledAt);

  return pending;
}

/**
 * Execute a single hop in a privacy route.
 *
 * Handles shield, unshield, and reshield operations by calling the
 * provided execution callbacks. Updates the hop and route status,
 * then persists to encrypted storage.
 *
 * @param hop - The hop to execute
 * @param route - The parent route
 * @param spendingKeyHash - Hex-encoded spending key hash
 * @param callbacks - Shield/unshield operation callbacks
 * @returns Execution result with success status and optional tx signature
 */
export async function executeHop(
  hop: RouteHop,
  route: PrivacyRoute,
  spendingKeyHash: string,
  callbacks: HopExecutionCallbacks,
): Promise<{
  success: boolean;
  txSignature?: string;
  error?: string;
}> {
  const hopLabel = `${hop.type}[${hop.id.slice(0, 8)}...]`;

  try {
    console.log(`[PrivacyRouter] Executing hop: ${hopLabel}`);

    // Derive the stealth keypair for this hop
    const keypair = deriveRouteStealthKeypair({
      spendingKeyHash,
      routeId: route.id,
      hopIndex: hop.hopIndex,
      outputIndex: 0, // Output index is encoded in the hop ID
    });

    let result: { txSignature: string; commitment?: string };

    switch (hop.type) {
      case 'shield': {
        // Update status to shielding
        updateHopStatus(hop, route, 'shielding');
        await saveRoute(route, spendingKeyHash);

        const shieldResult = await callbacks.shield({
          amount: hop.amount,
          denomination: hop.poolDenomination,
          fromKeypair: keypair.secretKey,
        });

        hop.commitment = shieldResult.commitment;
        result = shieldResult;
        break;
      }

      case 'unshield': {
        // Update status to unshielding
        updateHopStatus(hop, route, 'unshielding');
        await saveRoute(route, spendingKeyHash);

        if (!hop.nullifier) {
          throw new Error('Unshield hop missing nullifier');
        }

        const unshieldResult = await callbacks.unshield({
          nullifier: hop.nullifier,
          denomination: hop.poolDenomination,
          toAddress: hop.stealthAddress,
          fromKeypair: keypair.secretKey,
        });

        result = unshieldResult;
        break;
      }

      case 'reshield': {
        // Reshield = unshield to stealth address + re-shield from that address
        updateHopStatus(hop, route, 'reshielding');
        await saveRoute(route, spendingKeyHash);

        if (!hop.nullifier) {
          throw new Error('Reshield hop missing nullifier');
        }

        // Step 1: Unshield to stealth address
        await callbacks.unshield({
          nullifier: hop.nullifier,
          denomination: hop.poolDenomination,
          toAddress: hop.stealthAddress,
          fromKeypair: keypair.secretKey,
        });

        // Step 2: Re-shield from stealth address
        const reshieldResult = await callbacks.shield({
          amount: hop.amount,
          denomination: hop.poolDenomination,
          fromKeypair: keypair.secretKey,
        });

        hop.commitment = reshieldResult.commitment;
        result = reshieldResult;
        break;
      }

      default:
        throw new Error(`Unknown hop type: ${hop.type}`);
    }

    // Mark hop as completed
    hop.status = 'completed';
    hop.executedAt = Date.now();
    hop.txSignature = result.txSignature;
    hop.retryCount = 0;

    // Update route status
    updateRouteStatus(route);
    await saveRoute(route, spendingKeyHash);

    console.log(`[PrivacyRouter] Hop completed: ${hopLabel} (tx: ${result.txSignature.slice(0, 16)}...)`);

    return {
      success: true,
      txSignature: result.txSignature,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    console.error(`[PrivacyRouter] Hop failed: ${hopLabel}:`, errorMessage);

    // Increment retry count
    hop.retryCount++;

    // If we've exceeded max retries, mark as failed
    const maxRetries = 3;
    if (hop.retryCount >= maxRetries) {
      hop.status = 'failed';
      updateRouteStatus(route);
    } else {
      // Push scheduledAt forward for retry
      hop.scheduledAt = Date.now() + 30_000 * hop.retryCount; // exponential-ish backoff
      hop.status = 'pending';
    }

    await saveRoute(route, spendingKeyHash);

    return {
      success: false,
      error: errorMessage,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Update a hop's status and reflect it on the route's overall status.
 */
function updateHopStatus(
  hop: RouteHop,
  route: PrivacyRoute,
  status: RouteHop['status'],
): void {
  hop.status = status;

  // Propagate the active status to the route
  if (
    status === 'shielding' ||
    status === 'unshielding' ||
    status === 'reshielding'
  ) {
    route.status = status;
  }
}

/**
 * Determine the overall route status based on individual hop statuses.
 */
function updateRouteStatus(route: PrivacyRoute): void {
  const statuses = route.hops.map((h) => h.status);

  if (statuses.every((s) => s === 'completed')) {
    route.status = 'completed';
  } else if (statuses.some((s) => s === 'failed')) {
    // If any hop has permanently failed, the route is failed
    const failedHops = route.hops.filter(
      (h) => h.status === 'failed' && h.retryCount >= 3,
    );
    if (failedHops.length > 0) {
      route.status = 'failed';
    }
  } else if (statuses.some((s) => s === 'shielding')) {
    route.status = 'shielding';
  } else if (statuses.some((s) => s === 'unshielding')) {
    route.status = 'unshielding';
  } else if (statuses.some((s) => s === 'reshielding')) {
    route.status = 'reshielding';
  } else if (statuses.some((s) => s === 'maturing')) {
    route.status = 'maturing';
  } else {
    route.status = 'pending';
  }
}
