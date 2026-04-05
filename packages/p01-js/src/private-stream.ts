/**
 * Private Stream Module
 *
 * Client-side orchestration for privacy-preserving payment streams using
 * the ZK shielded pool (Tornado Cash-style denominated pools).
 *
 * A private stream = N notes shielded upfront, then unshielded at jittered
 * intervals to the recipient. Each tick uses a fresh stealth address when
 * enabled, preventing on-chain correlation of stream payments.
 *
 * Security properties:
 * - Sender privacy: ZK proofs break the on-chain link between depositor and recipient
 * - Recipient privacy (optional): stealth addresses ensure each tick goes to a unique address
 * - Timing privacy: jittered intervals prevent cadence-based correlation
 * - Amount privacy: fixed denominations make all payments identical on-chain
 *
 * @module private-stream
 */

import {
  generateStealthAddress,
} from './security/stealth';
import type { StealthMetaAddress } from './security/types';
import type { ShieldReceipt } from './shielded-pool';

// Re-export ShieldReceipt so consumers of private-stream don't need a separate import
export type { ShieldReceipt } from './shielded-pool';

/**
 * Configuration for creating a private stream.
 */
export interface PrivateStreamConfig {
  /** Token type for all payments */
  token: 'SOL' | 'USDC';
  /** Amount per tick (must match a pool denomination) */
  denomination: number;
  /** Total number of payments to execute */
  totalTicks: number;
  /** Recipient address (used when useStealthAddress is false) */
  recipientAddress: string;
  /** Whether to derive a unique stealth address for each tick */
  useStealthAddress: boolean;
  /** Recipient's spending public key (hex). Required if useStealthAddress is true. */
  recipientSpendingPubKey?: string;
  /** Recipient's viewing public key (hex). Required if useStealthAddress is true. */
  recipientViewingPubKey?: string;
  /** Whether to route unshields through a relayer (hides sender IP) */
  useRelayer: boolean;
  /** Relayer endpoint URL. Required if useRelayer is true. */
  relayerUrl?: string;
  /** Jitter configuration for timing randomization */
  jitter: {
    /** Minimum interval between ticks in milliseconds */
    minIntervalMs: number;
    /** Maximum interval between ticks in milliseconds */
    maxIntervalMs: number;
  };
}

/** Possible states of a private stream */
export type StreamStatus = 'pending' | 'active' | 'paused' | 'cancelled' | 'completed';

/**
 * Serializable state of a private stream.
 * Can be persisted and restored across app restarts.
 */
export interface PrivateStreamState {
  /** Unique stream identifier */
  id: string;
  /** Stream configuration (immutable after creation) */
  config: PrivateStreamConfig;
  /** Current status */
  status: StreamStatus;
  /** Number of ticks successfully completed */
  ticksCompleted: number;
  /** Number of ticks remaining */
  ticksRemaining: number;
  /** Remaining unspent receipts (one per pending tick) */
  receipts: ShieldReceipt[];
  /** Already-unshielded receipts (for audit trail) */
  spentReceipts: ShieldReceipt[];
  /** Timestamp (ms) when the next tick should fire */
  nextTickAt: number;
  /** Consecutive failed unshield attempts */
  failedAttempts: number;
  /** Stream creation timestamp (ms) */
  createdAt: number;
  /** Timestamp of last successful tick, or null if none */
  lastTickAt: number | null;
  /** Transaction signatures from completed ticks */
  completedSignatures: string[];
}

// ============ Constants ============

/** Minimum jitter ratio (range / average) to prevent timing correlation */
const MIN_JITTER_RATIO = 0.3;

/** Maximum consecutive failures before auto-pause */
const MAX_CONSECUTIVE_FAILURES = 10;

/** Minimum catch-up delay in ms */
const CATCHUP_MIN_DELAY_MS = 5_000;

/** Maximum catch-up delay in ms */
const CATCHUP_MAX_DELAY_MS = 30_000;

/** Maximum retry backoff in ms (5 minutes) */
const MAX_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/** Base retry delay in ms */
const BASE_RETRY_DELAY_MS = 1_000;

// ============ Helpers ============

/** CSPRNG-backed random float in [0, 1) */
function secureRandom(): number {
  const arr = new Uint32Array(1);
  globalThis.crypto.getRandomValues(arr);
  return arr[0] / 0x100000000;
}

/**
 * Generate a unique stream ID.
 */
function generateStreamId(): string {
  const timestamp = Date.now().toString(36);
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  const random = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `pstream_${timestamp}${random}`;
}

/**
 * Compute a random integer in [min, max] (inclusive).
 */
function randomIntInRange(min: number, max: number): number {
  return Math.floor(secureRandom() * (max - min + 1)) + min;
}

/**
 * Validate jitter configuration.
 * Throws if the jitter ratio is below the minimum threshold.
 */
function validateJitter(jitter: PrivateStreamConfig['jitter']): void {
  const { minIntervalMs, maxIntervalMs } = jitter;

  if (minIntervalMs < 0 || maxIntervalMs < 0) {
    throw new Error('Jitter intervals must be non-negative.');
  }

  if (maxIntervalMs < minIntervalMs) {
    throw new Error('maxIntervalMs must be >= minIntervalMs.');
  }

  const average = (minIntervalMs + maxIntervalMs) / 2;

  if (average === 0) {
    throw new Error('Average interval must be > 0.');
  }

  const range = maxIntervalMs - minIntervalMs;
  const ratio = range / average;

  if (ratio < MIN_JITTER_RATIO) {
    const pct = (ratio * 100).toFixed(1);
    throw new Error(
      `Insufficient jitter. The interval range must be at least 30% of the average interval. ` +
      `Without sufficient randomization, timing analysis can correlate stream payments. ` +
      `Current jitter ratio: ${pct}%. Required: >= 30%.`
    );
  }
}

/**
 * Validate the full stream configuration.
 */
function validateConfig(config: PrivateStreamConfig): void {
  if (config.totalTicks < 1) {
    throw new Error('totalTicks must be at least 1.');
  }

  if (config.denomination <= 0) {
    throw new Error('denomination must be positive.');
  }

  if (!config.recipientAddress) {
    throw new Error('recipientAddress is required.');
  }

  if (config.useStealthAddress) {
    if (!config.recipientSpendingPubKey || !config.recipientViewingPubKey) {
      throw new Error(
        'recipientSpendingPubKey and recipientViewingPubKey are required when useStealthAddress is true.'
      );
    }
  }

  if (config.useRelayer && !config.relayerUrl) {
    throw new Error('relayerUrl is required when useRelayer is true.');
  }

  validateJitter(config.jitter);
}

/**
 * Derive a fresh stealth address for a tick.
 * Returns the base58 one-time address.
 */
function deriveTickStealthAddress(
  spendingPubKeyHex: string,
  viewingPubKeyHex: string,
): string {
  // Decode the hex keys into a StealthMetaAddress
  const spendPub = hexToUint8Array(spendingPubKeyHex);
  const viewPub = hexToUint8Array(viewingPubKeyHex);

  // Build a minimal StealthMetaAddress for generateStealthAddress
  const metaAddress: StealthMetaAddress = {
    scanPublicKey: viewPub,
    spendPublicKey: spendPub,
    encoded: '', // not needed for generation
  };

  const stealth = generateStealthAddress(metaAddress);
  return stealth.address;
}

/**
 * Convert a hex string to Uint8Array.
 */
function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

// ============ PrivateStream Class ============

/**
 * A client-side private payment stream.
 *
 * Orchestrates the timed unshielding of pre-shielded notes to a recipient,
 * with jittered timing and optional stealth addresses for each tick.
 *
 * Lifecycle:
 * 1. Create with `PrivateStream.create(config)`
 * 2. Shield notes externally and attach receipts via `setReceipts()`
 * 3. Start execution with `start(executeUnshield)`
 * 4. Optionally pause/resume/cancel
 * 5. Serialize with `toJSON()` for persistence; restore with `PrivateStream.fromJSON()`
 */
export class PrivateStream {
  private state: PrivateStreamState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private executeUnshield: ((receipt: ShieldReceipt, recipientAddress: string) => Promise<string>) | null = null;
  private isExecutingTick: boolean = false;

  private constructor(state: PrivateStreamState) {
    this.state = state;
  }

  // ============ Static Constructors ============

  /**
   * Create a new private stream from configuration.
   *
   * Validates jitter requirements, stealth address parameters, and
   * creates the initial stream state. Receipts must be attached
   * separately via `setReceipts()` before calling `start()`.
   *
   * @param config - Stream configuration
   * @returns New PrivateStream instance in 'pending' status
   * @throws Error if configuration is invalid (e.g. insufficient jitter)
   */
  static create(config: PrivateStreamConfig): PrivateStream {
    validateConfig(config);

    const state: PrivateStreamState = {
      id: generateStreamId(),
      config: { ...config },
      status: 'pending',
      ticksCompleted: 0,
      ticksRemaining: config.totalTicks,
      receipts: [],
      spentReceipts: [],
      nextTickAt: 0,
      failedAttempts: 0,
      createdAt: Date.now(),
      lastTickAt: null,
      completedSignatures: [],
    };

    return new PrivateStream(state);
  }

  /**
   * Restore a private stream from serialized JSON state.
   *
   * @param json - JSON string from a previous `toJSON()` call
   * @returns Restored PrivateStream instance
   * @throws Error if JSON is malformed
   */
  static fromJSON(json: string): PrivateStream {
    const state: PrivateStreamState = JSON.parse(json);
    return new PrivateStream(state);
  }

  // ============ State Accessors ============

  /**
   * Get the current stream state (read-only snapshot).
   */
  getStatus(): PrivateStreamState {
    return { ...this.state };
  }

  /**
   * Get all remaining (unspent) receipts.
   */
  getReceipts(): ShieldReceipt[] {
    return [...this.state.receipts];
  }

  /**
   * Attach shield receipts to the stream.
   * Must be called before `start()` with exactly `totalTicks` receipts.
   *
   * @param receipts - Array of shield receipts (one per tick)
   * @throws Error if wrong number of receipts
   */
  setReceipts(receipts: ShieldReceipt[]): void {
    if (this.state.status !== 'pending') {
      throw new Error('Can only set receipts on a pending stream.');
    }
    if (receipts.length !== this.state.config.totalTicks) {
      throw new Error(
        `Expected ${this.state.config.totalTicks} receipts, got ${receipts.length}.`
      );
    }
    this.state.receipts = [...receipts];
    this.state.ticksRemaining = receipts.length;
  }

  // ============ Execution Control ============

  /**
   * Start executing stream ticks.
   *
   * Each tick unshields one receipt to the recipient (or to a fresh stealth
   * address if enabled). Ticks are spaced at random intervals within the
   * configured jitter range.
   *
   * If the stream was previously paused and `nextTickAt` is in the past,
   * missed ticks are caught up with random spacing (not all at once).
   *
   * @param executeUnshield - Async function that performs the actual unshield.
   *   Receives a receipt and a recipient address, returns the tx signature.
   */
  start(
    executeUnshield: (receipt: ShieldReceipt, recipientAddress: string) => Promise<string>,
  ): void {
    if (this.state.receipts.length === 0 && this.state.ticksRemaining > 0) {
      throw new Error('No receipts attached. Call setReceipts() before start().');
    }

    if (this.state.status === 'completed' || this.state.status === 'cancelled') {
      throw new Error(`Cannot start a ${this.state.status} stream.`);
    }

    this.executeUnshield = executeUnshield;
    this.state.status = 'active';
    this.state.failedAttempts = 0;

    // Schedule the first tick
    if (this.state.nextTickAt === 0) {
      // Brand new stream: schedule first tick with jitter
      this.scheduleNextTick();
    } else {
      // Resuming: check if we're behind schedule
      const now = Date.now();
      if (this.state.nextTickAt <= now) {
        // We missed at least one tick — start catch-up
        this.startCatchUp();
      } else {
        // Future tick already scheduled
        const delay = this.state.nextTickAt - now;
        this.setTimer(delay);
      }
    }
  }

  /**
   * Pause execution. Clears all timers.
   * Can be resumed later with `start()`.
   */
  pause(): void {
    if (this.state.status !== 'active') {
      return; // Already paused or terminal
    }
    this.clearTimer();
    this.state.status = 'paused';
  }

  /**
   * Resume a paused stream. Alias for calling `start()` again with
   * the same executeUnshield callback.
   */
  resume(): void {
    if (this.state.status !== 'paused') {
      throw new Error('Can only resume a paused stream.');
    }
    if (!this.executeUnshield) {
      throw new Error('No executeUnshield callback. Call start() instead.');
    }
    this.start(this.executeUnshield);
  }

  /**
   * Cancel the stream. Returns remaining receipts so the sender
   * can manually unshield them back to themselves.
   *
   * @returns Array of unspent receipts
   */
  cancel(): ShieldReceipt[] {
    this.clearTimer();
    this.state.status = 'cancelled';
    const remaining = [...this.state.receipts];
    return remaining;
  }

  // ============ Serialization ============

  /**
   * Serialize the stream state to JSON for persistence.
   * Timer state is NOT serialized; call `start()` after restoring.
   */
  toJSON(): string {
    return JSON.stringify(this.state);
  }

  // ============ Private Methods ============

  /**
   * Schedule the next tick with a random delay within jitter bounds.
   */
  private scheduleNextTick(): void {
    const { minIntervalMs, maxIntervalMs } = this.state.config.jitter;
    const delay = randomIntInRange(minIntervalMs, maxIntervalMs);
    this.state.nextTickAt = Date.now() + delay;
    this.setTimer(delay);
  }

  /**
   * Execute catch-up ticks for missed intervals.
   * Ticks are spaced with random 5-30s delays to avoid burst patterns.
   */
  private startCatchUp(): void {
    const catchUpDelay = randomIntInRange(CATCHUP_MIN_DELAY_MS, CATCHUP_MAX_DELAY_MS);
    this.state.nextTickAt = Date.now() + catchUpDelay;
    this.setTimer(catchUpDelay);
  }

  /**
   * Set the execution timer.
   */
  private setTimer(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.executeTick(), delayMs);
  }

  /**
   * Clear any pending timer.
   */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Execute a single tick: unshield one receipt to the recipient.
   */
  private async executeTick(): Promise<void> {
    if (this.state.status !== 'active') return;
    if (this.isExecutingTick) return; // Guard against re-entrancy
    if (!this.executeUnshield) return;
    if (this.state.receipts.length === 0) {
      this.state.status = 'completed';
      return;
    }

    this.isExecutingTick = true;

    // Determine the recipient address for this tick
    let recipientAddress: string;
    if (this.state.config.useStealthAddress) {
      recipientAddress = deriveTickStealthAddress(
        this.state.config.recipientSpendingPubKey!,
        this.state.config.recipientViewingPubKey!,
      );
    } else {
      recipientAddress = this.state.config.recipientAddress;
    }

    // Take the first receipt
    const receipt = this.state.receipts[0];

    try {
      const signature = await this.executeUnshield(receipt, recipientAddress);

      // Success — move receipt to spent, record signature
      this.state.receipts.shift();
      this.state.spentReceipts.push(receipt);
      this.state.ticksCompleted += 1;
      this.state.ticksRemaining -= 1;
      this.state.failedAttempts = 0;
      this.state.lastTickAt = Date.now();
      this.state.completedSignatures.push(signature);

      // Check completion
      if (this.state.ticksRemaining === 0) {
        this.state.status = 'completed';
        this.isExecutingTick = false;
        return;
      }

      // Check if we're still behind schedule (catch-up mode)
      const now = Date.now();
      const expectedNextTick = this.state.lastTickAt +
        (this.state.config.jitter.minIntervalMs + this.state.config.jitter.maxIntervalMs) / 2;

      if (this.state.nextTickAt < now && expectedNextTick < now) {
        // Still catching up — use catch-up spacing
        this.isExecutingTick = false;
        this.startCatchUp();
      } else {
        // Normal scheduling
        this.isExecutingTick = false;
        this.scheduleNextTick();
      }
    } catch (_error) {
      this.state.failedAttempts += 1;

      if (this.state.failedAttempts >= MAX_CONSECUTIVE_FAILURES) {
        // Auto-pause after too many failures
        this.state.status = 'paused';
        this.isExecutingTick = false;
        return;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, ..., max 5min
      const backoff = Math.min(
        BASE_RETRY_DELAY_MS * Math.pow(2, this.state.failedAttempts - 1),
        MAX_RETRY_BACKOFF_MS,
      );
      this.state.nextTickAt = Date.now() + backoff;
      this.isExecutingTick = false;
      this.setTimer(backoff);
    }
  }
}
