/**
 * Noise Engine tick logic.
 *
 * Previously this module owned a `setInterval(..., 5_000)` loop booted
 * from API request handlers. That pattern doesn't survive Vercel Fluid
 * Compute — once the request finishes the runtime is frozen and any
 * pending timers are killed. The work is now driven by a Vercel Cron
 * calling `/api/cron/noise-tick` on the same cadence (crons run at a
 * minimum of 1 minute on Vercel, so we keep the export for posterity
 * but the effective cadence is coarser).
 */
import { runPendingDecoys } from './noise-engine';

/** Cadence that used to drive the setInterval loop — preserved for docs
 *  and to justify the cron schedule in vercel.json. */
export const NOISE_ENGINE_TICK_INTERVAL_MS = 5_000;

export interface NoiseEngineTickResult {
  executed: number;
  failed: number;
  skipped: number;
  error?: string;
}

/**
 * Execute one tick of the noise-engine runner: fire any scheduled decoys
 * whose `scheduledFor` is due. Errors are captured into the return value —
 * the cron route converts that to HTTP.
 */
export async function runNoiseEngineTick(): Promise<NoiseEngineTickResult> {
  if (process.env.NOISE_ENGINE_DISABLED === '1') {
    return { executed: 0, failed: 0, skipped: 0 };
  }
  try {
    const summary = await runPendingDecoys();
    if (summary.executed > 0 || summary.failed > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[noise-engine-tick] executed=${summary.executed} failed=${summary.failed} skipped=${summary.skipped}`,
      );
    }
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[noise-engine-tick] error:', message);
    return { executed: 0, failed: 0, skipped: 0, error: message };
  }
}

// ─── Deprecated shims (kept so stale imports fail loudly rather than silently) ──

/**
 * @deprecated The setInterval-based runner was removed for Vercel Fluid
 * Compute compatibility. Trigger `/api/cron/noise-tick` via the Vercel
 * cron registered in vercel.json instead.
 */
export function startNoiseEngineRunner(): void {
  // eslint-disable-next-line no-console
  console.warn(
    '[noise-engine-runner] startNoiseEngineRunner() is a no-op; ' +
      'work is now driven by Vercel Cron → /api/cron/noise-tick.',
  );
}

/** @deprecated See startNoiseEngineRunner. */
export function stopNoiseEngineRunner(): void {
  // no-op
}
