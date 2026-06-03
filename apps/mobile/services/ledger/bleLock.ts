/**
 * bleLock — strict mutual-exclusion mutex for the device's single BLE radio.
 *
 * PRIMARY coexistence mechanism (spec §1C, Finding #12).
 *
 * Two independent subsystems want the BLE radio:
 *   1. P2P note-sharing  (services/sharing/transport/ble.ts — ble-plx central/peripheral)
 *   2. Ledger hardware   (services/ledger/transport.ts      — @ledgerhq react-native-hw-transport-ble)
 *
 * Both ride react-native-ble-plx's NATIVE BleManager singleton under the hood, so
 * running a Ledger connect/scan/sign *concurrently* with a note-share scan/connect
 * races the same native GATT queue and produces "Operation was rejected" /
 * disconnect storms. We do NOT try to share a JS BleManager instance (that plan is
 * unverified against the Ledger transport's real API — Finding #12). Instead every
 * BLE-touching entry point acquires this async mutex FIRST and releases it on
 * teardown. Never `new BleManager()` in the Ledger path; never `.destroy()` the
 * shared native manager from either consumer.
 *
 * Constraint accepted (spec OPEN-Q #3): a Ledger sign and a BLE note-share cannot
 * run at the literal same instant. They serialize. This is a real, intentional UX
 * limit, not a bug.
 *
 * The lock is a single in-process FIFO queue. `acquireBleLock()` resolves with a
 * `release` function; callers MUST call it (use try/finally). `withBleLock(fn)`
 * wraps that pattern. A non-reentrant holder token guarantees a stale release can
 * never advance the queue out from under a newer owner.
 */

export type BleLockOwner = 'ledger' | 'note-sharing' | string;

/** Opaque per-acquisition identity; doubles as the holder tag + owner label. */
interface HolderToken {
  owner: BleLockOwner;
}

interface Waiter {
  token: HolderToken;
  grant: () => void;
}

let _held = false;
let _currentHolder: HolderToken | null = null;
const _queue: Waiter[] = [];

/**
 * Hand ownership to the next queued waiter, or mark the radio free.
 * Called only from a release closure that currently owns the lock.
 */
function _advance(): void {
  const next = _queue.shift();
  if (next) {
    _currentHolder = next.token;
    next.grant();
  } else {
    _held = false;
    _currentHolder = null;
  }
}

/**
 * Acquire the BLE lock. Resolves once the radio is free, returning a `release`
 * function. The release is idempotent (calling it twice is a no-op).
 */
export function acquireBleLock(owner: BleLockOwner = 'unknown'): Promise<() => void> {
  const token: HolderToken = { owner };

  const makeRelease = (): (() => void) => () => {
    if (_currentHolder !== token) return; // not the active holder (or already released)
    _advance();
  };

  return new Promise<() => void>((resolve) => {
    const grant = () => {
      _held = true;
      _currentHolder = token;
      resolve(makeRelease());
    };

    if (!_held) {
      grant();
    } else {
      _queue.push({ token, grant });
    }
  });
}

/**
 * Run `fn` while holding the BLE lock; always releases, even on throw.
 */
export async function withBleLock<T>(
  owner: BleLockOwner,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireBleLock(owner);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** True if some consumer currently holds the BLE radio. */
export function isBleLocked(): boolean {
  return _held;
}

/**
 * The human-readable owner tag of the current holder (for UX guards /
 * diagnostics). Returns null when the radio is free.
 */
export function currentBleLockOwner(): BleLockOwner | null {
  return _currentHolder?.owner ?? null;
}
