/**
 * Ledger BLE transport wrapper (mobile, Nano X only).
 *
 * Wraps @ledgerhq/react-native-hw-transport-ble so the rest of the app sees a
 * tiny, lock-aware surface:
 *   - observeBleState  : BLE radio on/off (does NOT take the lock — read-only)
 *   - listenForDevices : scan for Ledger devices       (under bleLock)
 *   - openTransport    : connect to a chosen device     (under bleLock)
 *   - closeTransport   : disconnect                      (releases bleLock)
 *
 * COEXISTENCE (spec §1C, Finding #12): scan + connect run while holding the
 * shared `bleLock` so they never race the note-sharing subsystem over the single
 * native ble-plx GATT queue. We ride @ledgerhq's NATIVE ble-plx singleton — we do
 * NOT construct our own BleManager and we NEVER `.destroy()` the shared manager.
 *
 * Lifecycle: one long-lived transport per connected Ledger. The lock is held for
 * the whole connected session (acquired at openTransport, released at
 * closeTransport) so a sign cannot interleave with a note-share. Real Nano X
 * validation on RN 0.81.5 × ble-plx 3.5.1 is deferred to device testing.
 */

import BleTransport from '@ledgerhq/react-native-hw-transport-ble';
import type Transport from '@ledgerhq/hw-transport';
import { acquireBleLock } from './bleLock';

/** A discovered Ledger device (subset of ble-plx Device we actually use). */
export interface LedgerDevice {
  id: string;
  name: string | null;
}

export interface BleStateEvent {
  type: string;
  available: boolean;
}

/** Subscription handle compatible with both ble-plx and hw-transport observers. */
export interface LedgerSubscription {
  unsubscribe: () => void;
}

/**
 * True if BLE transport is supported on this device/build. Nano S/S Plus have no
 * BLE; capability-gate the UI on this + a "Nano X only" note.
 */
export async function isLedgerBleSupported(): Promise<boolean> {
  try {
    return await BleTransport.isSupported();
  } catch {
    return false;
  }
}

/**
 * Observe BLE radio availability (powered on/off, unauthorized, etc.).
 * Read-only — does NOT take the bleLock.
 */
export function observeBleState(
  onState: (event: BleStateEvent) => void,
  onError?: (err: Error) => void,
): LedgerSubscription {
  const sub = BleTransport.observeState({
    next: (e) => onState(e),
    error: (err: unknown) => onError?.(err instanceof Error ? err : new Error(String(err))),
    complete: () => {},
  });
  return { unsubscribe: () => sub.unsubscribe() };
}

/**
 * Scan for nearby Ledger devices. Holds the bleLock for the duration of the
 * scan; `stop()` releases it. Each discovered device is reported via `onDevice`.
 */
export async function listenForDevices(
  onDevice: (device: LedgerDevice) => void,
  onError?: (err: Error) => void,
): Promise<{ stop: () => void }> {
  const release = await acquireBleLock('ledger');
  let stopped = false;

  let sub: { unsubscribe: () => void } | null = null;
  try {
    sub = BleTransport.listen({
      next: (event: {
        type: string;
        descriptor?: { id?: string; name?: string | null; localName?: string | null };
        device?: { id?: string; name?: string | null; localName?: string | null };
      }) => {
        // ble-plx scan "add" events carry the device as `descriptor` (id + name).
        if (event?.type === 'add') {
          const d = event.device ?? event.descriptor ?? {};
          if (d?.id) onDevice({ id: d.id, name: d.name ?? d.localName ?? null });
        }
      },
      error: (err: unknown) => onError?.(err instanceof Error ? err : new Error(String(err))),
      complete: () => {},
    });
  } catch (err) {
    release();
    throw err;
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { sub?.unsubscribe(); } catch { /* ok */ }
    release();
  };

  return { stop };
}

/**
 * Open a transport to a specific device id. The bleLock is held for the entire
 * connected session and released by `closeTransport`. `timeoutMs` bounds the
 * connect attempt.
 *
 * IMPORTANT: pass the same `release` returned here to closeTransport. To keep the
 * surface small we manage the lock internally via a module-level registry keyed
 * by transport instance.
 */
const _releaseByTransport = new WeakMap<Transport, () => void>();

export async function openTransport(
  deviceId: string,
  timeoutMs = 30_000,
): Promise<Transport> {
  const release = await acquireBleLock('ledger');
  try {
    const transport = await BleTransport.open(deviceId, timeoutMs);
    _releaseByTransport.set(transport as unknown as Transport, release);
    return transport as unknown as Transport;
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Close a transport and release the BLE radio lock. Never throws.
 * Does NOT `.destroy()` any shared manager — only closes this transport.
 */
export async function closeTransport(transport: Transport | null): Promise<void> {
  if (!transport) return;
  try {
    await transport.close();
  } catch {
    /* already closed */
  }
  const release = _releaseByTransport.get(transport);
  if (release) {
    _releaseByTransport.delete(transport);
    try { release(); } catch { /* idempotent */ }
  }
}
