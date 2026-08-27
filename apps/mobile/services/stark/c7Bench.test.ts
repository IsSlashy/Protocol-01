/**
 * The benchmark drives a real prover on a device and a real prover in Node, so
 * the only thing testable here is its ARITHMETIC and its REFUSALS — which is
 * worth testing, because a benchmark that reports a mean instead of a median,
 * or that accepts a single run, produces a number people then quote.
 */

import { describe, it, expect, vi } from 'vitest';
import { runC7Bench, median, describeC7Headroom, type SpendProver } from './c7Bench';
import { C7_BENCH_WITNESS, C7_EXPECTED_PROOF_SIZE } from './spendWitness';

/** A prover that returns canned durations, so the statistics are checkable. */
function fakeProver(durations: number[], proofSize = C7_EXPECTED_PROOF_SIZE): { prove: SpendProver; seen: unknown[] } {
  const seen: unknown[] = [];
  let i = 0;
  const prove: SpendProver = async (w) => {
    seen.push(w);
    return {
      proofHex: 'ab'.repeat(8),
      proofSize,
      durationMs: durations[i++ % durations.length],
      publicInputs: ['1', '2', '3', '4', '5', '6'],
    };
  };
  return { prove, seen };
}

describe('median', () => {
  it('is the middle of an odd sample, not the mean', () => {
    // These are the five real Node samples from 2026-08-27. The mean is 5,277 —
    // the single 8,604 outlier drags it 12% above the median.
    expect(median([4767, 8604, 4715, 3775, 4524])).toBe(4715);
    expect(median([1, 2, 3])).toBe(2);
  });

  it('averages the two middles of an even sample', () => {
    expect(median([1, 2, 3, 4])).toBe(3); // (2+3)/2 = 2.5, rounded
    expect(median([10, 20])).toBe(15);
  });

  it('refuses an empty sample rather than returning NaN', () => {
    expect(() => median([])).toThrow(/median of nothing/);
  });
});

describe('runC7Bench', () => {
  it('refuses fewer than three runs — one run is not a measurement', async () => {
    const { prove } = fakeProver([1000]);
    await expect(runC7Bench(prove, 1)).rejects.toThrow(/at least 3 runs, got 1/);
    await expect(runC7Bench(prove, 2)).rejects.toThrow(/at least 3 runs/);
    await expect(runC7Bench(prove, 2.5)).rejects.toThrow(/at least 3 runs/);
  });

  it('reports median, min and max over the requested runs', async () => {
    const { prove, seen } = fakeProver([4767, 8604, 4715, 3775, 4524]);
    const r = await runC7Bench(prove, 5, () => {});
    expect(seen).toHaveLength(5);
    expect(r.proverMedianMs).toBe(4715);
    expect(r.proverMinMs).toBe(3775);
    expect(r.proverMaxMs).toBe(8604);
    expect(r.samples).toHaveLength(5);
  });

  it('drives the canonical witness, so the number is comparable to the desktop one', async () => {
    const { prove, seen } = fakeProver([100]);
    await runC7Bench(prove, 3, () => {});
    expect(seen[0]).toBe(C7_BENCH_WITNESS);
  });

  it('emits the [P01PERF] line in the exact 2026-08-03 device format', async () => {
    const lines: string[] = [];
    const { prove } = fakeProver([1482]);
    await runC7Bench(prove, 3, (l) => lines.push(l));
    // The device capture read:
    //   [P01PERF] circuit=3 prover=1482 ms bridge=1546 ms proofSize=78157
    // A logcat line and a stdout line must be the same string, or comparing
    // them becomes a translation step somebody eventually gets wrong.
    // Asserted by prefix/suffix rather than one regex so the line is compared
    // literally, character for character, against the recorded device format.
    expect(lines[0].startsWith('[P01PERF] circuit=7 prover=1482 ms bridge=')).toBe(true);
    expect(lines[0].endsWith(' ms proofSize=' + C7_EXPECTED_PROOF_SIZE)).toBe(true);
    expect(lines[3]).toBe('[P01PERF] circuit=7 median=1482 ms min=1482 ms max=1482 ms n=3');
  });

  it('flags a proof size that is not the measured one', async () => {
    const lines: string[] = [];
    const { prove } = fakeProver([100], 78_157); // C3's size, not C7's
    const r = await runC7Bench(prove, 3, (l) => lines.push(l));
    expect(r.sizeAsExpected).toBe(false);
    expect(lines.join('\n')).toMatch(/wire format moved/);
  });

  it('accepts the measured size without complaint', async () => {
    const lines: string[] = [];
    const r = await runC7Bench(fakeProver([100]).prove, 3, (l) => lines.push(l));
    expect(r.sizeAsExpected).toBe(true);
    expect(lines.join('\n')).not.toMatch(/wire format moved/);
  });

  it('falls back to wall time when the prover reports no durationMs', async () => {
    const prove = (async () => ({
      proofHex: '', proofSize: C7_EXPECTED_PROOF_SIZE, publicInputs: [],
    })) as unknown as SpendProver;
    const r = await runC7Bench(prove, 3, () => {});
    expect(Number.isFinite(r.proverMedianMs)).toBe(true);
  });

  it('logs to console by default', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runC7Bench(fakeProver([100]).prove, 3);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('describeC7Headroom', () => {
  const result = { proverMedianMs: 4715 } as never;

  it('never lets a Node number be quoted as a device number', () => {
    const s = describeC7Headroom(result, 'node');
    expect(s).toMatch(/measured in NODE/);
    expect(s).toMatch(/correction factor to a phone is UNKNOWN/);
  });

  it('says so plainly when the number IS from a device', () => {
    const s = describeC7Headroom(result, 'device');
    expect(s).toMatch(/measured ON DEVICE/);
    expect(s).not.toMatch(/UNKNOWN/);
  });

  it('quotes the 180 s ceiling the provider actually enforces', () => {
    expect(describeC7Headroom(result, 'node')).toMatch(/180000 ms/);
    expect(describeC7Headroom(result, 'node')).toMatch(/~38x headroom/);
  });

  it('does not divide by zero on an impossibly fast prover', () => {
    expect(describeC7Headroom({ proverMedianMs: 0 } as never, 'node')).toMatch(/~180000x/);
  });
});
