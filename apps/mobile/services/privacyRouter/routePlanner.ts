/**
 * Route Planner — Computes optimal multi-hop privacy routes.
 *
 * Given an amount, destination, and privacy level, the planner:
 * 1. Chooses the best denomination to minimize splits while maximizing pool usage
 * 2. Generates deterministic stealth addresses for each intermediate hop
 * 3. Computes random (but deterministic) delays for each hop
 * 4. Estimates total fees and completion time
 * 5. Returns a complete PrivacyRoute with all hops populated
 *
 * All randomness is derived from HMAC(spendingKeyHash, context) so that
 * routes are fully reproducible from the spending key + nonce alone.
 */

import {
  PrivacyRoute,
  PrivacyLevel,
  RouteHop,
  RouteFeeEstimate,
  Denomination,
  PRIVACY_LEVEL_CONFIGS,
  PrivacyRouterConfig,
} from './types';
import { deriveStealthAddress, deriveStealthSecret } from './stealthManager';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

// ---------------------------------------------------------------------------
// Protocol fee constants
// ---------------------------------------------------------------------------

/** Shield fee in basis points (0.3%) */
const SHIELD_FEE_BPS = 30;

/** Unshield fee in basis points (0.5%) */
const UNSHIELD_FEE_BPS = 50;

/** Basis point denominator */
const BPS_DENOMINATOR = 10_000;

/** Base Solana transaction fee in lamports */
const TX_FEE_LAMPORTS = 5_000;

/** Lamports per SOL */
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Available denominations (in SOL) — must match on-chain pools */
const AVAILABLE_DENOMINATIONS: Denomination[] = [0.1, 0.5, 1, 5, 10];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan a complete privacy route.
 *
 * This is the core algorithm. It computes the optimal denomination split,
 * generates all intermediate stealth addresses, schedules delays, and
 * produces a complete route plan that can be executed by the scheduler.
 *
 * @param params.amount - Amount to send in SOL
 * @param params.destination - Base58 pubkey of the final recipient
 * @param params.privacyLevel - Privacy level (1-5)
 * @param params.spendingKeyHash - Hex-encoded hash of the spending key (for deterministic derivation)
 * @param params.nonce - Monotonic counter (ensures unique route IDs)
 * @param params.config - Optional overrides for router configuration
 * @returns Complete PrivacyRoute ready for execution
 */
export function planRoute(params: {
  amount: number;
  destination: string;
  privacyLevel: PrivacyLevel;
  spendingKeyHash: string;
  nonce: number;
  config?: Partial<PrivacyRouterConfig>;
}): PrivacyRoute {
  const { amount, destination, privacyLevel, spendingKeyHash, nonce, config } =
    params;

  // Validate inputs
  if (amount <= 0) {
    throw new Error('Amount must be positive');
  }
  if (!destination || destination.length < 32) {
    throw new Error('Invalid destination address');
  }

  const levelConfig = PRIVACY_LEVEL_CONFIGS[privacyLevel];
  const { hops: numHops, splits: maxSplits } = levelConfig;

  // Merge config with level-specific defaults
  const minDelay = config?.minHopDelay ?? levelConfig.minDelayMs;
  const maxDelay = config?.maxHopDelay ?? levelConfig.maxDelayMs;

  // Generate deterministic route ID
  const routeId = generateRouteId(spendingKeyHash, nonce);

  // Choose optimal denomination
  const { denomination, count } = chooseDenomination(amount, maxSplits);
  const numOutputs = count;

  // Build all hops across all cycles
  const hops: RouteHop[] = [];
  const now = Date.now();
  let currentTime = now;
  let globalHopIndex = 0;

  for (let cycle = 0; cycle < numHops; cycle++) {
    const isFinalCycle = cycle === numHops - 1;

    // --- Shield phase ---
    // Shield each split into the anonymity pool
    for (let outputIdx = 0; outputIdx < numOutputs; outputIdx++) {
      const delay = generateDelay(
        // First shield of first cycle starts sooner
        cycle === 0 ? Math.floor(minDelay / 4) : minDelay,
        cycle === 0 ? Math.floor(maxDelay / 4) : Math.floor(maxDelay / 2),
        routeId,
        globalHopIndex,
      );

      const stealthPubkey = deriveStealthAddress({
        spendingKeyHash,
        routeId,
        hopIndex: globalHopIndex,
        outputIndex: outputIdx,
      });

      const stealthSecret = deriveStealthSecret({
        spendingKeyHash,
        routeId,
        hopIndex: globalHopIndex,
        outputIndex: outputIdx,
      });

      const scheduledAt =
        currentTime + delay + outputIdx * generateDelay(1000, 5000, routeId, globalHopIndex * 1000 + outputIdx);

      hops.push({
        id: generateHopId(routeId, globalHopIndex, outputIdx, 'shield'),
        hopIndex: globalHopIndex,
        type: 'shield',
        poolDenomination: denomination,
        amount: denomination,
        stealthAddress: stealthPubkey.toBase58(),
        stealthSecret,
        scheduledAt,
        status: 'pending',
        retryCount: 0,
      });
    }

    // Advance time past the shield phase + maturation window
    const shieldPhaseEnd =
      currentTime +
      maxDelay / 2 +
      numOutputs * 5000;

    // --- Maturation delay ---
    const maturationDelay = generateDelay(minDelay, maxDelay, routeId, globalHopIndex + 1000);
    currentTime = shieldPhaseEnd + maturationDelay;
    globalHopIndex++;

    // --- Unshield phase ---
    for (let outputIdx = 0; outputIdx < numOutputs; outputIdx++) {
      const delay = generateDelay(minDelay, maxDelay, routeId, globalHopIndex + outputIdx);

      // On the final cycle, unshield directly to destination.
      // On intermediate cycles, unshield to a new stealth address for re-shielding.
      const unshieldTarget = isFinalCycle
        ? destination
        : deriveStealthAddress({
            spendingKeyHash,
            routeId,
            hopIndex: globalHopIndex + 100, // offset to avoid collision with shield addresses
            outputIndex: outputIdx,
          }).toBase58();

      const stealthSecret = deriveStealthSecret({
        spendingKeyHash,
        routeId,
        hopIndex: globalHopIndex,
        outputIndex: outputIdx,
      });

      const scheduledAt =
        currentTime + delay + outputIdx * generateDelay(2000, 10000, routeId, globalHopIndex * 1000 + outputIdx);

      hops.push({
        id: generateHopId(routeId, globalHopIndex, outputIdx, 'unshield'),
        hopIndex: globalHopIndex,
        type: 'unshield',
        poolDenomination: denomination,
        amount: denomination,
        stealthAddress: unshieldTarget,
        stealthSecret,
        scheduledAt,
        status: 'pending',
        retryCount: 0,
      });
    }

    // Advance time past unshield phase
    currentTime =
      currentTime + maxDelay + numOutputs * 10000;
    globalHopIndex++;

    // --- Re-shield phase (if not final cycle) ---
    if (!isFinalCycle) {
      for (let outputIdx = 0; outputIdx < numOutputs; outputIdx++) {
        const delay = generateDelay(
          Math.floor(minDelay / 2),
          Math.floor(maxDelay / 2),
          routeId,
          globalHopIndex + outputIdx,
        );

        const stealthPubkey = deriveStealthAddress({
          spendingKeyHash,
          routeId,
          hopIndex: globalHopIndex,
          outputIndex: outputIdx,
        });

        const stealthSecret = deriveStealthSecret({
          spendingKeyHash,
          routeId,
          hopIndex: globalHopIndex,
          outputIndex: outputIdx,
        });

        const scheduledAt =
          currentTime + delay + outputIdx * generateDelay(1000, 5000, routeId, globalHopIndex * 1000 + outputIdx);

        hops.push({
          id: generateHopId(routeId, globalHopIndex, outputIdx, 'reshield'),
          hopIndex: globalHopIndex,
          type: 'reshield',
          poolDenomination: denomination,
          amount: denomination,
          stealthAddress: stealthPubkey.toBase58(),
          stealthSecret,
          scheduledAt,
          status: 'pending',
          retryCount: 0,
        });
      }

      currentTime =
        currentTime + maxDelay / 2 + numOutputs * 5000;
      globalHopIndex++;
    }
  }

  // Sort hops by scheduled time for execution order
  hops.sort((a, b) => a.scheduledAt - b.scheduledAt);

  // Calculate fee estimate
  const fees = estimateFees({ amount, privacyLevel });

  const estimatedCompletionAt = hops.length > 0
    ? Math.max(...hops.map((h) => h.scheduledAt))
    : now;

  return {
    id: routeId,
    nonce,
    privacyLevel,
    totalAmount: amount,
    sourceDenomination: denomination,
    targetDenomination: denomination,
    numOutputs,
    numHops,
    destination,
    hops,
    status: 'pending',
    createdAt: now,
    estimatedCompletionAt,
    totalFeeEstimate: fees.totalFees,
  };
}

/**
 * Estimate fees for a route without building the full plan.
 *
 * @param params.amount - Amount in SOL
 * @param params.privacyLevel - Privacy level (1-5)
 * @returns Detailed fee breakdown
 */
export function estimateFees(params: {
  amount: number;
  privacyLevel: PrivacyLevel;
}): RouteFeeEstimate {
  const { amount, privacyLevel } = params;
  const levelConfig = PRIVACY_LEVEL_CONFIGS[privacyLevel];
  const { hops, splits } = levelConfig;

  const { denomination, count } = chooseDenomination(amount, splits);
  const effectiveAmount = denomination * count;

  // Each cycle has: count shields + count unshields
  // Plus (hops-1) re-shield operations (unshield + re-shield combined)
  const numShields = count * hops;
  const numUnshields = count * hops;
  // Re-shield = unshield + shield in one step (counted above in subsequent cycles)
  const totalTxs = numShields + numUnshields;

  // Protocol fees
  const shieldFees =
    (effectiveAmount * numShields * SHIELD_FEE_BPS) / BPS_DENOMINATOR / hops;
  const unshieldFees =
    (effectiveAmount * numUnshields * UNSHIELD_FEE_BPS) / BPS_DENOMINATOR / hops;

  // Network fees (base Solana TX fee per transaction)
  const networkFees = (totalTxs * TX_FEE_LAMPORTS) / LAMPORTS_PER_SOL;

  const totalFees = shieldFees + unshieldFees + networkFees;
  const totalCostPercent =
    amount > 0 ? (totalFees / amount) * 100 : 0;

  // Duration estimate
  const minDuration = levelConfig.minDelayMs * hops * 2; // shield + unshield phases
  const maxDuration = levelConfig.maxDelayMs * hops * 2;
  const estimatedDuration = formatDurationRange(minDuration, maxDuration);

  return {
    shieldFees: roundSol(shieldFees),
    unshieldFees: roundSol(unshieldFees),
    networkFees: roundSol(networkFees),
    totalFees: roundSol(totalFees),
    totalCostPercent: Math.round(totalCostPercent * 100) / 100,
    numTransactions: totalTxs,
    estimatedDuration,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Choose the optimal denomination for splitting an amount.
 *
 * Strategy: find the largest denomination where the number of splits
 * fits within maxSplits, and the total coverage (denom * count) is
 * as close to the amount as possible.
 */
function chooseDenomination(
  amount: number,
  maxSplits: number,
): { denomination: Denomination; count: number } {
  // Sort denominations from largest to smallest
  const sorted = [...AVAILABLE_DENOMINATIONS].sort((a, b) => b - a);

  let bestDenom: Denomination = sorted[sorted.length - 1]!;
  let bestCount = Math.min(Math.floor(amount / bestDenom), maxSplits);
  let bestCoverage = bestDenom * bestCount;

  for (const denom of sorted) {
    const count = Math.floor(amount / denom);

    if (count <= 0) continue;
    if (count > maxSplits) continue;

    const coverage = denom * count;

    // Prefer: higher coverage, and among equal coverage, fewer splits
    if (
      coverage > bestCoverage ||
      (coverage === bestCoverage && count < bestCount)
    ) {
      bestDenom = denom;
      bestCount = count;
      bestCoverage = coverage;
    }
  }

  // Ensure at least 1 output
  if (bestCount <= 0) {
    bestCount = 1;
  }

  return { denomination: bestDenom, count: bestCount };
}

/**
 * Generate a deterministic pseudo-random delay in [min, max] range.
 *
 * Uses HMAC-SHA256(seed, index) to produce a deterministic but
 * unpredictable value. The same inputs always produce the same delay.
 */
function generateDelay(
  min: number,
  max: number,
  seed: string,
  index: number,
): number {
  const context = `delay:${seed}:${index}`;
  const hash = sha256(new TextEncoder().encode(context));

  // Use the first 4 bytes as a uint32, normalize to [0, 1)
  const value =
    ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0;
  const normalized = value / 0xffffffff;

  return Math.floor(min + normalized * (max - min));
}

/**
 * Generate a deterministic route ID from the spending key hash and nonce.
 */
function generateRouteId(spendingKeyHash: string, nonce: number): string {
  const context = `privacy_route:${nonce}`;
  const keyBytes = hexToBytes(spendingKeyHash);
  const contextBytes = new TextEncoder().encode(context);
  const hash = hmac(sha256, keyBytes, contextBytes);
  return bytesToHex(hash);
}

/**
 * Generate a deterministic hop ID from the route ID, hop index, output index, and type.
 */
function generateHopId(
  routeId: string,
  hopIndex: number,
  outputIndex: number,
  type: string,
): string {
  const context = `${routeId}:${hopIndex}:${outputIndex}:${type}`;
  const hash = sha256(new TextEncoder().encode(context));
  // Use first 16 bytes for a shorter but still unique ID
  return bytesToHex(hash.slice(0, 16));
}

/**
 * Format a duration range as a human-readable string.
 */
function formatDurationRange(minMs: number, maxMs: number): string {
  const formatSingle = (ms: number): string => {
    const hours = ms / (60 * 60 * 1000);
    if (hours < 1) {
      return `${Math.round(ms / (60 * 1000))}min`;
    }
    if (hours < 24) {
      return `${Math.round(hours)}h`;
    }
    return `${Math.round(hours / 24)}d`;
  };

  return `${formatSingle(minMs)}-${formatSingle(maxMs)}`;
}

/**
 * Round a SOL amount to 9 decimal places (lamport precision).
 */
function roundSol(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
}

/**
 * Convert a hex string to a Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd length');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert a Uint8Array to a hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
