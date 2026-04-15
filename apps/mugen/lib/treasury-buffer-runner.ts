/**
 * Treasury Buffer tick logic.
 *
 * Previously this module owned a `setInterval(..., 15_000)` loop booted
 * from API request handlers. That pattern doesn't survive Vercel Fluid
 * Compute — once the request finishes the runtime is frozen and any
 * pending timers are killed. The work is now driven by a Vercel Cron
 * calling `/api/cron/treasury-buffer-tick` on the same cadence.
 *
 * This file retains the single-tick helper so the cron route stays thin,
 * and so a local script can call it directly if ever needed for debugging.
 */
import { Connection } from '@solana/web3.js';
import {
  executeReadyPayouts,
  getBufferKeypairForRunner,
  pollForIncomingFunds,
} from './treasury-buffer';

/** Cadence that used to drive the setInterval loop — preserved in a const so the
 *  cron schedule in vercel.json can be justified against it. */
export const TREASURY_BUFFER_TICK_INTERVAL_MS = 15_000;

function resolveRpcUrl(): string {
  return process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
}

export interface TreasuryBufferTickResult {
  funded: number;
  paid: number;
  error?: string;
}

/**
 * Execute one tick of the treasury-buffer runner: poll the buffer wallet
 * for incoming funds and dispatch any payouts that are ready. Errors are
 * captured into the return value — the cron route converts that to HTTP.
 */
export async function runTreasuryBufferTick(): Promise<TreasuryBufferTickResult> {
  const connection = new Connection(resolveRpcUrl(), 'confirmed');
  try {
    const funded = await pollForIncomingFunds(connection);
    const paid = await executeReadyPayouts(
      connection,
      getBufferKeypairForRunner(),
    );
    if (funded > 0 || paid > 0) {
      // eslint-disable-next-line no-console
      console.log(`[treasury-buffer-tick] funded=${funded} paid=${paid}`);
    }
    return { funded, paid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[treasury-buffer-tick] error:', message);
    return { funded: 0, paid: 0, error: message };
  }
}

// ─── Deprecated shims (kept so stale imports fail loudly rather than silently) ──

/**
 * @deprecated The setInterval-based runner was removed for Vercel Fluid
 * Compute compatibility. Trigger `/api/cron/treasury-buffer-tick` via the
 * Vercel cron registered in vercel.json instead.
 */
export function startTreasuryBufferRunner(): void {
  // eslint-disable-next-line no-console
  console.warn(
    '[treasury-buffer-runner] startTreasuryBufferRunner() is a no-op; ' +
      'work is now driven by Vercel Cron → /api/cron/treasury-buffer-tick.',
  );
}

/** @deprecated See startTreasuryBufferRunner. */
export function stopTreasuryBufferRunner(): void {
  // no-op
}
