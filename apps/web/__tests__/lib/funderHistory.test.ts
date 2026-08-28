import { describe, expect, it } from 'vitest';
import {
  P11_FUNDER_WALK_LIMIT,
  funderHistoryVerdict,
} from '@/lib/privacy/funderHistory';

describe('the headroom P11 needs on the float', () => {
  it('reads the measured 2026-08-28 float as comfortable', () => {
    const v = funderHistoryVerdict(58);
    expect(v.level).toBe('ok');
    expect(v.note).toContain('58');
  });

  it('⚠️ an unread history is UNKNOWN, never healthy', () => {
    const v = funderHistoryVerdict(null);
    expect(v.level).toBe('unknown');
    // The sentence must not let a reader take silence for a pass.
    expect(v.note).toContain('not fine');
  });

  it('warns before the wall, not at it', () => {
    expect(funderHistoryVerdict(599).level).toBe('ok');
    expect(funderHistoryVerdict(600).level).toBe('warn');
  });

  it('🚨 calls a truncated walk INCONCLUSIVE and says it is not green', () => {
    const v = funderHistoryVerdict(P11_FUNDER_WALK_LIMIT);
    expect(v.level).toBe('exhausted');
    expect(v.note).toContain('INCONCLUSIVE');
    expect(v.note).toContain('not green');
  });

  it('pins the limit to what the probe actually walks', () => {
    // verify/p01-verify.mjs: `const historyLimit = Math.min(1000, chunkLimit + 1)`
    expect(P11_FUNDER_WALK_LIMIT).toBe(1000);
  });

  it('always reports the raw number, so a reader can re-check the judgement', () => {
    for (const n of [0, 58, 600, 1000, 5000]) {
      expect(funderHistoryVerdict(n).length).toBe(n);
      expect(funderHistoryVerdict(n).limit).toBe(1000);
    }
  });
});
