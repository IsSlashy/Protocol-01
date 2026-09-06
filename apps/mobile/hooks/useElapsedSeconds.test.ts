/**
 * The visible clock, and the screens that gate on it.
 *
 * [PERF 2026-09-06] The July latency doc's cheapest large finding: shield and
 * unshield showed NOTHING during their longest phase because every progress
 * element was gated on the store's `isLoading`, which flips only after the
 * proof is generated. These tests pin the two halves of the fix: the label
 * formatter, and the gates in the four screens (read from the source, the
 * way this repo's other anti-vacuity tests do, because a screen cannot be
 * rendered in this Node environment).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatElapsedLabel } from './useElapsedSeconds';

const screens = join(__dirname, '..', 'app', '(main)', '(privacy)');
const src = (f: string) => readFileSync(join(screens, f), 'utf8');

describe('formatElapsedLabel', () => {
  it('leaves a fresh step alone and appends the seconds once the flow has run a while', () => {
    expect(formatElapsedLabel('Proving', 0)).toBe('Proving');
    expect(formatElapsedLabel('Proving', 2)).toBe('Proving');
    expect(formatElapsedLabel('Proving', 3)).toBe('Proving (3s)');
    expect(formatElapsedLabel('Proving', 47)).toBe('Proving (47s)');
  });
  it('never prints the clock twice when the pipeline heartbeat already carries one', () => {
    expect(formatElapsedLabel('Confirming the upload... (12s)', 30)).toBe('Confirming the upload... (12s)');
  });
  it('an empty label yields just the clock (the batch header)', () => {
    expect(formatElapsedLabel('', 9)).toBe('(9s)');
    expect(formatElapsedLabel('', 1)).toBe('');
  });
});

describe('the screens gate their progress on the synchronous flag, not on the store alone', () => {
  it('denominated-unshield: busy = isLoading || isProving || submitting, and both progress blocks use it', () => {
    const s = src('denominated-unshield.tsx');
    expect(s).toContain('const busy = isLoading || isProving || submitting;');
    expect(s).toContain('const elapsed = useElapsedSeconds(busy);');
    expect(s).toContain('const canSubmit = !!selectedNote && !busy;');
    // No progress element may still be gated on the store flag alone.
    expect(s).not.toMatch(/\{isLoading && \(/);
    expect((s.match(/\{busy && \(/g) ?? []).length).toBe(2);
    expect((s.match(/formatElapsedLabel\(/g) ?? []).length).toBe(2);
  });
  it('denominated-shield: the deposit clock runs from the tap, before the store flips', () => {
    const s = src('denominated-shield.tsx');
    expect(s).toContain('const busy = isLoading || submitting;');
    expect(s).toContain('const elapsed = useElapsedSeconds(busy);');
    expect(s).toMatch(/\{busy && \([\s\S]*formatElapsedLabel\(progress \|\| 'Depositing\./);
  });
  it('subscribe-private: the clock covers proof, upload and vault', () => {
    const s = src('subscribe-private.tsx');
    expect(s).toContain('const elapsed = useElapsedSeconds(isLoading || starkStatus !== null);');
    expect((s.match(/formatElapsedLabel\(starkStatus \?\? progress \?\? 'Processing\.\.\.', elapsed\)/g) ?? []).length).toBe(2);
  });
  it('denominated-unshield-batch: the batch header carries the clock while running', () => {
    const s = src('denominated-unshield-batch.tsx');
    expect(s).toContain('const elapsed = useElapsedSeconds(running);');
    expect(s).toContain("formatElapsedLabel('', elapsed)");
  });
});
