/**
 * Payment-mode diagnostics — structured logs for every payment flow.
 *
 * Modes covered (one tag per flow so the same grep filters by mode):
 *   classic-recurring-p2p     wallet-funded recurring sub, peer pubkey
 *   classic-recurring-p2b     wallet-funded recurring sub, merchant slug
 *   zk-recurring              subscribePrivateStark (vault, ZK-funded)
 *   zk-oneshot                unshield -> retailer one-shot ZK payment
 *   vault-claim               retailer claimPeriod
 *   vault-pause-resume        pause/resume on a SubscriptionVault
 *   stream-create             escrow-based stream creation
 *   stream-process            scheduled stream payment processing
 *
 * Output shape: one JSON line per event prefixed with [P01_PAY:<mode>].
 * Grep with:
 *   adb logcat -s ReactNativeJS | grep P01_PAY
 *
 * Includes a ghost-error detector identical in spirit to the BLE module: if
 * an error fires within 10s of a successful payment of the same mode, emit
 * a [P01_PAY_GHOST_ERROR] line so we can correlate cleanup-related errors
 * with the operations they trail.
 */

export type PaymentMode =
  | 'classic-recurring-p2p'
  | 'classic-recurring-p2b'
  | 'zk-recurring'
  | 'zk-oneshot'
  | 'vault-claim'
  | 'vault-pause-resume'
  | 'stream-create'
  | 'stream-process'
  | 'stream-cancel'
  | 'stream-pause-resume';

const GHOST_WINDOW_MS = 10_000;

const lastSuccessByMode: Map<PaymentMode, { ts: number; sig?: string; vault?: string }> =
  new Map();

function safeJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v === 'object' && typeof (v as { toBase58?: () => string }).toBase58 === 'function') {
      try { return (v as { toBase58: () => string }).toBase58(); } catch { return String(v); }
    }
    return v;
  });
}

export function payLog(
  mode: PaymentMode,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  const ts = new Date().toISOString();
  const line = safeJson({ ts, mode, event, ...payload });
  // eslint-disable-next-line no-console
  console.log(`[P01_PAY:${mode}] ${line}`);
}

export function markPayComplete(
  mode: PaymentMode,
  payload: Record<string, unknown> = {},
): void {
  lastSuccessByMode.set(mode, {
    ts: Date.now(),
    sig: typeof payload.signature === 'string' ? payload.signature : undefined,
    vault: typeof payload.vault === 'string' ? payload.vault : undefined,
  });
  payLog(mode, 'pay-complete', payload);
}

export function resetGhostWindow(mode?: PaymentMode): void {
  if (mode) {
    lastSuccessByMode.delete(mode);
  } else {
    lastSuccessByMode.clear();
  }
}

/**
 * Always returns the original message untouched. Side effect: emits a
 * [P01_PAY_GHOST_ERROR] line if the error fires within GHOST_WINDOW_MS of a
 * pay-complete in the same mode.
 */
export function inspectPayError(
  mode: PaymentMode,
  errorMsg: string,
  source: string,
): string {
  const last = lastSuccessByMode.get(mode);
  if (last) {
    const ageMs = Date.now() - last.ts;
    if (ageMs < GHOST_WINDOW_MS) {
      const line = safeJson({
        ts: new Date().toISOString(),
        mode,
        msAfterPayComplete: ageMs,
        previousSignature: last.sig,
        previousVault: last.vault,
        error: errorMsg,
        source,
      });
      // eslint-disable-next-line no-console
      console.log(`[P01_PAY_GHOST_ERROR] ${line}`);
    }
  }
  // Always log the regular error too so the timeline is complete.
  payLog(mode, 'pay-error', { error: errorMsg, source });
  return errorMsg;
}

/**
 * Wrap a payment-bearing async operation with start/success/error logs.
 * The label is appended to the mode tag so two flows of the same mode (e.g.
 * subscribe vs claim) stay distinguishable in the trace.
 *
 * Returns whatever the inner function returns; rethrows the same error so
 * existing error-handling paths are untouched.
 */
export async function tracePaymentCall<T>(
  mode: PaymentMode,
  label: string,
  meta: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  payLog(mode, `${label}-start`, meta);
  try {
    const result = await fn();
    payLog(mode, `${label}-ok`, {
      ...meta,
      durationMs: Date.now() - startedAt,
      result:
        typeof result === 'string'
          ? result
          : result && typeof result === 'object'
            ? '[object]'
            : result,
    });
    return result;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const code = err?.code ?? err?.errorCode ?? null;
    inspectPayError(mode, msg, `${label}-throw`);
    payLog(mode, `${label}-fail`, {
      ...meta,
      durationMs: Date.now() - startedAt,
      errorCode: code,
      errorMessage: msg.slice(0, 200),
    });
    throw err;
  }
}
