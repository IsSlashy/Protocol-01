/**
 * vitest setup file for the benchmark's live-flow runs (see
 * vitest.bench.config.mts). Prefixes every console line with an epoch timestamp
 * of sub-millisecond resolution, taken in the test process when the harness
 * calls console.* — so vitest's own buffering of console output cannot shift it.
 *
 * It only ADDS a prefix; it changes nothing the harness does. Do not combine it
 * with P01_LIVE_TIMESTAMPS=1 (the runner unsets it), which adds a second,
 * coarser prefix.
 */
const origin = performance.timeOrigin;
const stamp = () => `[bench-t ${(origin + performance.now()).toFixed(1)}]`;

for (const m of ['log', 'info', 'warn', 'error'] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => orig(stamp(), ...a);
}
