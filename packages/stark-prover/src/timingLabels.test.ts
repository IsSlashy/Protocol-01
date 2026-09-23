/**
 * Which blob the published devnet timings were measured with. Audit v1,
 * finding F49 (stark-prover part).
 *
 * The per-circuit figures (C7 8.0 s, C1 5.8 s, ...) come from
 * docs/BENCHMARK-2026-09-13.md §6/§6b, measured on 2026-09-13 with the blob of
 * that day, 0ad6d7f1… (265,324 B). On 2026-09-20 the package reshipped
 * d5583d41… (262,363 B, NTT low-degree extension), then 241caaab… (240,172 B,
 * C2/C4/C5 exports removed) on 2026-09-23, and the README and the
 * CHANGELOG went on quoting the old figures next to the new blob as if they
 * were its own. Nobody has re-measured them with the shipped blob; until someone does,
 * each place that quotes them names the blob and the date, and says so.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG = resolve(__dirname, '..');
const OLD = '0ad6d7f1';
const NEW = '241caaab';

/** The paragraph (blank-line separated) that quotes the C7 end-to-end figure. */
function timingParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .filter((p) => /C7 8\.0 s/.test(p));
}

describe.each([
  ['README.md'],
  ['CHANGELOG.md'],
])('%s labels the devnet timings with the blob they were measured on (F49)', (file) => {
  const text = readFileSync(resolve(PKG, file), 'utf8');
  const paras = timingParagraphs(text);

  it('quotes the figures somewhere (otherwise this test has nothing to guard)', () => {
    expect(paras.length).toBeGreaterThan(0);
  });

  it('every paragraph quoting them names the 2026-09-13 blob and date, and says the shipped blob was not re-measured', () => {
    for (const p of paras) {
      expect(p, p).toContain(OLD);
      expect(p, p).toContain('2026-09-13');
      const notRemeasured = /not\s+(been\s+)?re-?measured/i;
      const at = p.search(notRemeasured);
      expect(at, `${p}\n-- does not say it was not re-measured`).toBeGreaterThanOrEqual(0);
      expect(p, p).toContain(NEW);
    }
  });
});
