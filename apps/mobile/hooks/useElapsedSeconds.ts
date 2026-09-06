/**
 * useElapsedSeconds — a visible clock for the long flows.
 *
 * [PERF 2026-09-06] docs/MOBILE_PROVER_LATENCY.md: "shield and unshield show
 * the user nothing during their longest phase". The store's `isLoading` flips
 * only after the proof is generated, and every progress element was gated on
 * it, so the first 3 to 10 seconds of a deposit or a withdrawal were a dead
 * button. The screens now gate on their own synchronous `submitting` flag as
 * well, and print the seconds elapsed next to the current step so a slow
 * confirmation and a hang stop looking the same.
 */
import { useEffect, useState } from 'react';

/** Seconds elapsed since `active` last became true; 0 while inactive. */
export function useElapsedSeconds(active: boolean, tickMs = 1000): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setSeconds(0);
    const id = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, tickMs);
    return () => clearInterval(id);
  }, [active, tickMs]);
  return seconds;
}

/**
 * Pure: `label` with ` (Ns)` appended once the flow has run for at least
 * `minSeconds`. A step that already carries its own heartbeat from the
 * pipeline (`... (12s)`) is left alone so the clock is never printed twice.
 */
export function formatElapsedLabel(label: string, seconds: number, minSeconds = 3): string {
  const base = label ?? '';
  if (seconds < minSeconds) return base;
  if (/\(\d+s\)\s*$/.test(base)) return base;
  return base.length > 0 ? `${base} (${seconds}s)` : `(${seconds}s)`;
}
