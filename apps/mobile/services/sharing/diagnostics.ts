/**
 * BLE diagnostics — tagged structured logs for the P2P sharing flow.
 *
 * Every event is emitted as a single JSON line with a [P01_BLE] (or
 * [P01_BLE_GHOST_ERROR]) prefix so it survives logcat fragmentation and is
 * grep-able with:
 *   adb logcat -s ReactNativeJS | grep P01_BLE
 *
 * The "ghost error" detector flags the case where `onError` fires within a
 * few seconds of `onShareComplete` — this is the exact pattern when a
 * programmatic disconnect (cleanup) is mis-interpreted as a peer-disconnect
 * failure even though the share itself succeeded.
 */

const GHOST_WINDOW_MS = 10_000;

let lastShareCompleteAt: number | null = null;
let lastShareCompleteContext: { direction: string; peerId?: string } | null = null;

export function bleLog(event: string, payload: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, event, ...payload }, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  // eslint-disable-next-line no-console
  console.log(`[P01_BLE] ${line}`);
}

export function markShareComplete(direction: 'sent' | 'received', peerId?: string): void {
  lastShareCompleteAt = Date.now();
  lastShareCompleteContext = { direction, peerId };
  bleLog('share-complete', { direction, peerId });
}

/**
 * Reset the ghost window — call this when a fresh session starts so we don't
 * incorrectly flag errors from a brand-new attempt as ghosts of the previous
 * one.
 */
export function resetGhostWindow(): void {
  lastShareCompleteAt = null;
  lastShareCompleteContext = null;
}

/**
 * Inspect an outgoing onError invocation. If the error fires within
 * GHOST_WINDOW_MS of the last successful share, emit a separate
 * [P01_BLE_GHOST_ERROR] line that captures the timing — this is the smoking
 * gun for "share works but UI shows an error a few seconds later".
 *
 * Always returns the original error message untouched so the caller can pass
 * it through to the existing error path.
 */
export function inspectError(error: string, source: string): string {
  if (lastShareCompleteAt) {
    const ageMs = Date.now() - lastShareCompleteAt;
    if (ageMs < GHOST_WINDOW_MS) {
      const ctx = lastShareCompleteContext;
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        msAfterShareComplete: ageMs,
        error,
        source,
        previousShareDirection: ctx?.direction,
        previousSharePeerId: ctx?.peerId,
      });
      // eslint-disable-next-line no-console
      console.log(`[P01_BLE_GHOST_ERROR] ${line}`);
    }
  }
  return error;
}

export function logStateTransition(prev: string | undefined, next: string | undefined, extra: Record<string, unknown> = {}): void {
  bleLog('state-transition', {
    from: prev ?? 'none',
    to: next ?? 'none',
    ...extra,
  });
}
