/**
 * Private Subscription Module
 *
 * Platform-agnostic subscription engine that processes recurring payments
 * through a ZK shielded pool, providing sender anonymity. When combined
 * with stealth addresses, both sender and recipient are hidden.
 *
 * Extracted from: apps/mobile/services/solana/privateSubscription.ts
 *
 * Mobile-specific concerns (ZkService singleton, Keypair wallet access)
 * are replaced with a generic `executePayment` callback, making this
 * module usable in any JavaScript runtime (Node, browser, React Native).
 *
 * @module private-subscription
 */

// Re-export ShieldReceipt from the shielded-pool module for convenience
import type { ShieldReceipt } from './shielded-pool';
export type { ShieldReceipt } from './shielded-pool';

// ============ Configuration ============

/**
 * Configuration for a private subscription.
 */
export interface PrivateSubscriptionConfig {
  /** Token to use for payments */
  token: 'SOL' | 'USDC';
  /** Denomination per payment period (in human-readable units, e.g. 0.1 SOL) */
  denomination: number;
  /** Merchant's public wallet address (used when useStealthAddress is false) */
  merchantAddress: string;
  /** Merchant's spending public key for stealth address derivation */
  merchantSpendingPubKey?: string;
  /** Merchant's viewing public key for stealth address derivation */
  merchantViewingPubKey?: string;
  /** Payment interval in milliseconds (e.g., 30 days = 2_592_000_000) */
  intervalMs: number;
  /** Whether to derive a fresh stealth address per payment period */
  useStealthAddress: boolean;
  /** Whether to route payments through a relayer for additional anonymity */
  useRelayer: boolean;
  /** Relayer endpoint URL (required when useRelayer is true) */
  relayerUrl?: string;
  /** Automatically continue payments when receipts are available */
  autoRenew: boolean;
  /** Maximum number of payment periods (0 = unlimited) */
  maxPeriods: number;
  /** Timing jitter range — each payment is delayed by a random duration within this window */
  jitter: {
    /** Minimum additional delay in milliseconds */
    minIntervalMs: number;
    /** Maximum additional delay in milliseconds */
    maxIntervalMs: number;
  };
}

// ============ Status ============

/**
 * Lifecycle status of a private subscription.
 */
export type SubscriptionStatus =
  | 'pending'    // Waiting for receipts or first payment
  | 'active'     // Payments are being processed on schedule
  | 'paused'     // Temporarily halted by user
  | 'cancelled'  // Permanently stopped; unused receipts returned
  | 'expired';   // Reached maxPeriods limit

// ============ State ============

/**
 * Serializable state of a private subscription.
 * Can be persisted to disk / AsyncStorage and restored later.
 */
export interface PrivateSubscriptionState {
  /** Unique subscription identifier */
  id: string;
  /** Full configuration snapshot */
  config: PrivateSubscriptionConfig;
  /** Current lifecycle status */
  status: SubscriptionStatus;
  /** Number of successfully completed payment periods */
  periodsCompleted: number;
  /** Remaining periods (Infinity encoded as -1 in JSON) */
  periodsRemaining: number;
  /** Unspent receipts available for future payments */
  receipts: ShieldReceipt[];
  /** Receipts that have already been consumed */
  spentReceipts: ShieldReceipt[];
  /** Timestamp (ms) of the next scheduled payment */
  nextPaymentAt: number;
  /** Consecutive failed payment attempts (resets on success) */
  failedAttempts: number;
  /** Timestamp (ms) when the subscription was created */
  createdAt: number;
  /** Timestamp (ms) of the last successful payment, or null */
  lastPaymentAt: number | null;
  /** Transaction signatures from all completed payments */
  completedSignatures: string[];
}

// ============ Result Types ============

/**
 * Result of a single payment execution.
 * Returned by the `executePayment` callback supplied to `start()`.
 */
export interface PrivatePaymentResult {
  success: boolean;
  signature?: string;
  stealthAddress?: string;
  ephemeralPublicKey?: string;
  viewTag?: string;
  error?: string;
}

// ============ Constants ============

/** Maximum consecutive failures before auto-pause */
const MAX_FAILURES_BEFORE_PAUSE = 10;

/** Retry backoff schedule (ms): 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 300s (cap) */
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

// ============ Helpers ============

/**
 * Generate a random subscription ID.
 */
function generateSubscriptionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 10);
  return `psub_${ts}${rand}`;
}

/**
 * Compute a random jittered delay within the configured window.
 */
function computeJitteredDelay(jitter: PrivateSubscriptionConfig['jitter']): number {
  const { minIntervalMs, maxIntervalMs } = jitter;
  return minIntervalMs + Math.random() * (maxIntervalMs - minIntervalMs);
}

/**
 * Compute exponential backoff delay for retry attempt `n` (0-indexed).
 */
function retryDelay(attempt: number): number {
  const base = 1000; // 1 second
  const delay = base * Math.pow(2, attempt);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * Validate that jitter spread is at least 30% of the average.
 * This prevents trivially fingerprintable payment timing.
 *
 * Throws a descriptive error when the constraint is violated.
 */
function validateJitter(jitter: PrivateSubscriptionConfig['jitter']): void {
  if (jitter.minIntervalMs < 0) {
    throw new Error(
      'PrivateSubscription: jitter.minIntervalMs must be >= 0'
    );
  }
  if (jitter.maxIntervalMs < jitter.minIntervalMs) {
    throw new Error(
      'PrivateSubscription: jitter.maxIntervalMs must be >= jitter.minIntervalMs'
    );
  }

  const spread = jitter.maxIntervalMs - jitter.minIntervalMs;
  const average = (jitter.minIntervalMs + jitter.maxIntervalMs) / 2;

  // If average is 0 (both values are 0), jitter is effectively disabled — allow it.
  if (average === 0) return;

  const minSpreadRatio = 0.3; // 30%
  if (spread < average * minSpreadRatio) {
    throw new Error(
      `PrivateSubscription: insufficient jitter — spread (${spread} ms) must be ` +
      `>= 30% of average (${average} ms = ${average * minSpreadRatio} ms minimum spread). ` +
      `Increase maxIntervalMs or decrease minIntervalMs to improve payment timing privacy.`
    );
  }
}

/**
 * Validate the full subscription configuration.
 */
function validateConfig(config: PrivateSubscriptionConfig): void {
  if (config.denomination <= 0) {
    throw new Error('PrivateSubscription: denomination must be > 0');
  }
  if (config.intervalMs <= 0) {
    throw new Error('PrivateSubscription: intervalMs must be > 0');
  }
  if (!config.merchantAddress) {
    throw new Error('PrivateSubscription: merchantAddress is required');
  }
  if (config.useStealthAddress) {
    if (!config.merchantSpendingPubKey || !config.merchantViewingPubKey) {
      throw new Error(
        'PrivateSubscription: merchantSpendingPubKey and merchantViewingPubKey ' +
        'are required when useStealthAddress is true'
      );
    }
  }
  if (config.useRelayer && !config.relayerUrl) {
    throw new Error(
      'PrivateSubscription: relayerUrl is required when useRelayer is true'
    );
  }
  if (config.maxPeriods < 0) {
    throw new Error('PrivateSubscription: maxPeriods must be >= 0');
  }

  validateJitter(config.jitter);
}

// ============ Serialization Helpers ============

/**
 * ShieldReceipt fields are all JSON-safe (strings and numbers),
 * so no special serialization is needed. These helpers exist for
 * symmetry and future-proofing in case the receipt type gains
 * non-JSON-safe fields (e.g., bigint).
 */
function serializeReceipt(r: ShieldReceipt): Record<string, unknown> {
  return { ...r };
}

function deserializeReceipt(obj: Record<string, unknown>): ShieldReceipt {
  return obj as unknown as ShieldReceipt;
}

// ============ Main Class ============

/**
 * Platform-agnostic private subscription engine.
 *
 * Manages the lifecycle of a recurring ZK-private payment:
 *   - Jittered timing to resist traffic analysis
 *   - Stealth address derivation per period (optional)
 *   - Exponential-backoff retry with auto-pause after 10 failures
 *   - Serializable state for persistence across app restarts
 *
 * The class does NOT depend on any wallet or ZK service directly.
 * Instead, callers provide an `executePayment` callback when starting
 * the subscription, which bridges to the platform-specific ZK layer.
 */
export class PrivateSubscription {
  private state: PrivateSubscriptionState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private executePaymentFn:
    | ((receipt: ShieldReceipt, recipientAddress: string, periodIndex: number) => Promise<string>)
    | null = null;

  // ---- Construction ----

  private constructor(state: PrivateSubscriptionState) {
    this.state = state;
  }

  /**
   * Create a new subscription from a configuration and a pool of receipts.
   *
   * Validates the config (including jitter spread >= 30% of average) and
   * prepares the initial state. The subscription starts in 'pending' status
   * and must be activated with `start()`.
   *
   * @param config - Subscription configuration
   * @param receipts - Pre-shielded receipts to fund the subscription
   * @returns A new PrivateSubscription instance
   * @throws Error if config is invalid or jitter spread is insufficient
   */
  static create(
    config: PrivateSubscriptionConfig,
    receipts: ShieldReceipt[],
  ): PrivateSubscription {
    validateConfig(config);

    const periodsRemaining =
      config.maxPeriods > 0
        ? Math.min(config.maxPeriods, receipts.length)
        : receipts.length;

    const now = Date.now();
    const jitterDelay = computeJitteredDelay(config.jitter);

    const state: PrivateSubscriptionState = {
      id: generateSubscriptionId(),
      config,
      status: 'pending',
      periodsCompleted: 0,
      periodsRemaining,
      receipts: [...receipts],
      spentReceipts: [],
      nextPaymentAt: now + config.intervalMs + jitterDelay,
      failedAttempts: 0,
      createdAt: now,
      lastPaymentAt: null,
      completedSignatures: [],
    };

    return new PrivateSubscription(state);
  }

  /**
   * Restore a subscription from its serialized JSON state.
   *
   * @param json - JSON string produced by `toJSON()`
   * @returns Restored PrivateSubscription instance
   */
  static fromJSON(json: string): PrivateSubscription {
    const raw = JSON.parse(json);

    // Re-hydrate receipts through deserializer (future-proofs non-JSON-safe fields)
    const receipts = (raw.receipts || []).map(deserializeReceipt);
    const spentReceipts = (raw.spentReceipts || []).map(deserializeReceipt);

    const state: PrivateSubscriptionState = {
      ...raw,
      receipts,
      spentReceipts,
    };

    return new PrivateSubscription(state);
  }

  // ---- Public API ----

  /**
   * Get the current subscription state (read-only snapshot).
   */
  getInfo(): PrivateSubscriptionState {
    return { ...this.state };
  }

  /**
   * Start (or restart) the subscription payment loop.
   *
   * The `executePayment` callback is invoked for each period and must
   * return a transaction signature string on success or throw on failure.
   *
   * @param executePayment - Platform-specific payment executor.
   *   Receives: (receipt, recipientAddress, periodIndex) => Promise<signature>
   *   - `receipt`: the ShieldReceipt to spend
   *   - `recipientAddress`: where to send (may be a derived stealth address)
   *   - `periodIndex`: 0-based index of this payment period
   */
  start(
    executePayment: (
      receipt: ShieldReceipt,
      recipientAddress: string,
      periodIndex: number,
    ) => Promise<string>,
  ): void {
    if (this.state.status === 'cancelled' || this.state.status === 'expired') {
      throw new Error(
        `PrivateSubscription: cannot start a ${this.state.status} subscription`
      );
    }

    this.executePaymentFn = executePayment;
    this.state.status = 'active';
    this.scheduleNextPayment();
  }

  /**
   * Pause the subscription. The current timer is cleared and the status
   * changes to 'paused'. Use `resume()` to continue.
   */
  pause(): void {
    if (this.state.status !== 'active') return;
    this.clearTimer();
    this.state.status = 'paused';
  }

  /**
   * Resume a paused subscription.
   */
  resume(): void {
    if (this.state.status !== 'paused') return;
    this.state.status = 'active';
    this.scheduleNextPayment();
  }

  /**
   * Permanently cancel the subscription and return all unspent receipts.
   *
   * @returns Array of ShieldReceipt objects that were never consumed
   */
  cancel(): ShieldReceipt[] {
    this.clearTimer();
    this.state.status = 'cancelled';
    this.executePaymentFn = null;
    const unused = [...this.state.receipts];
    // Do NOT clear receipts from state — they remain for auditing.
    // The caller receives the array and can re-shield or use them elsewhere.
    return unused;
  }

  /**
   * Add more receipts to fund additional periods.
   *
   * If the subscription was in 'pending' status (waiting for receipts
   * due to autoRenew), it transitions back to 'active' and schedules
   * the next payment.
   *
   * @param receipts - Additional ShieldReceipt objects
   */
  addReceipts(receipts: ShieldReceipt[]): void {
    if (this.state.status === 'cancelled' || this.state.status === 'expired') {
      throw new Error(
        `PrivateSubscription: cannot add receipts to a ${this.state.status} subscription`
      );
    }

    this.state.receipts.push(...receipts);
    this.recalculatePeriodsRemaining();

    // If we were waiting for receipts (autoRenew + pending), resume.
    if (
      this.state.status === 'pending' &&
      this.state.config.autoRenew &&
      this.state.receipts.length > 0 &&
      this.executePaymentFn
    ) {
      this.state.status = 'active';
      this.scheduleNextPayment();
    }
  }

  /**
   * Serialize the subscription to a JSON string for persistence.
   *
   * All receipt fields are JSON-safe (strings/numbers) so no lossy conversion occurs.
   */
  toJSON(): string {
    const serializable = {
      ...this.state,
      receipts: this.state.receipts.map(serializeReceipt),
      spentReceipts: this.state.spentReceipts.map(serializeReceipt),
    };
    return JSON.stringify(serializable);
  }

  // ---- Internal Scheduling ----

  private scheduleNextPayment(): void {
    this.clearTimer();

    if (this.state.status !== 'active') return;

    const now = Date.now();
    const delay = Math.max(0, this.state.nextPaymentAt - now);

    this.timer = setTimeout(() => {
      this.processPayment();
    }, delay);
  }

  private async processPayment(): Promise<void> {
    if (this.state.status !== 'active') return;
    if (!this.executePaymentFn) return;

    // Check if we've reached maxPeriods
    if (
      this.state.config.maxPeriods > 0 &&
      this.state.periodsCompleted >= this.state.config.maxPeriods
    ) {
      this.clearTimer();
      this.state.status = 'expired';
      return;
    }

    // Check if we have receipts
    if (this.state.receipts.length === 0) {
      if (this.state.config.autoRenew) {
        // Wait for more receipts
        this.clearTimer();
        this.state.status = 'pending';
        return;
      } else {
        this.clearTimer();
        this.state.status = 'expired';
        return;
      }
    }

    // Pick the first available receipt
    const receipt = this.state.receipts[0];

    // Determine recipient address for this period
    const recipientAddress = this.resolveRecipientAddress(
      this.state.periodsCompleted
    );

    try {
      const signature = await this.executePaymentFn(
        receipt,
        recipientAddress,
        this.state.periodsCompleted,
      );

      // Success — move receipt to spent pool
      this.state.receipts.shift();
      this.state.spentReceipts.push(receipt);

      this.state.periodsCompleted += 1;
      this.state.failedAttempts = 0;
      this.state.lastPaymentAt = Date.now();
      this.state.completedSignatures.push(signature);

      this.recalculatePeriodsRemaining();

      // Check if we just hit maxPeriods
      if (
        this.state.config.maxPeriods > 0 &&
        this.state.periodsCompleted >= this.state.config.maxPeriods
      ) {
        this.state.status = 'expired';
        return;
      }

      // Schedule next period
      const jitterDelay = computeJitteredDelay(this.state.config.jitter);
      this.state.nextPaymentAt =
        Date.now() + this.state.config.intervalMs + jitterDelay;
      this.scheduleNextPayment();
    } catch (err: unknown) {
      this.state.failedAttempts += 1;

      if (this.state.failedAttempts >= MAX_FAILURES_BEFORE_PAUSE) {
        this.clearTimer();
        this.state.status = 'paused';
        return;
      }

      // Exponential backoff retry
      const delay = retryDelay(this.state.failedAttempts - 1);
      this.state.nextPaymentAt = Date.now() + delay;
      this.scheduleNextPayment();
    }
  }

  /**
   * Resolve the recipient address for a given period.
   *
   * When stealth addresses are enabled, each period uses a deterministically
   * different "seed" so the platform-specific executePayment callback can
   * derive a unique stealth address. The actual DKSAP derivation happens
   * in the callback (or a layer above) because it requires cryptographic
   * primitives that may differ between platforms.
   *
   * When stealth addresses are disabled, the plain merchantAddress is returned.
   */
  private resolveRecipientAddress(periodIndex: number): string {
    if (this.state.config.useStealthAddress) {
      // Return a tagged address string that the executePayment callback
      // can parse to derive the stealth address. Format:
      //   stealth:<spendPubKey>:<viewPubKey>:<periodIndex>
      return [
        'stealth',
        this.state.config.merchantSpendingPubKey!,
        this.state.config.merchantViewingPubKey!,
        periodIndex.toString(),
      ].join(':');
    }
    return this.state.config.merchantAddress;
  }

  private recalculatePeriodsRemaining(): void {
    const { maxPeriods } = this.state.config;
    if (maxPeriods > 0) {
      this.state.periodsRemaining = Math.min(
        maxPeriods - this.state.periodsCompleted,
        this.state.receipts.length,
      );
    } else {
      this.state.periodsRemaining = this.state.receipts.length;
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
