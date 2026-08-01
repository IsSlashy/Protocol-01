/**
 * Locale key parity.
 *
 * `ja` is a first-class locale in this app, not a nice-to-have. A sweep on this
 * repo edited `en` and `fr`, declared the job done in its commit message, and
 * left stale strings rendering in Japanese for a week. Nothing caught it,
 * because nothing was watching.
 *
 * This is what watches. It fails the moment a key exists in one dictionary and
 * not in the other two, in either direction, so a half-finished translation
 * pass cannot be merged as green.
 */
import { describe, it, expect } from 'vitest';
import en from './en';
import fr from './fr';
import ja from './ja';

type Dict = Record<string, unknown>;

/** Flatten a nested dictionary into dotted leaf paths. */
function leafKeys(obj: Dict, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...leafKeys(v as Dict, full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const DICTS: ReadonlyArray<readonly [string, Dict]> = [
  ['en', en as unknown as Dict],
  ['fr', fr as unknown as Dict],
  ['ja', ja as unknown as Dict],
];

describe('mobile i18n: en, fr and ja carry identical key sets', () => {
  const keys = new Map(DICTS.map(([name, d]) => [name, new Set(leafKeys(d))]));

  it('every dictionary is non-trivial (guards against an empty import)', () => {
    for (const [name, set] of keys) {
      expect(set.size, `${name} has suspiciously few keys`).toBeGreaterThan(100);
    }
  });

  for (const [a] of DICTS) {
    for (const [b] of DICTS) {
      if (a === b) continue;
      it(`no key present in ${a} is missing from ${b}`, () => {
        const missing = [...keys.get(a)!].filter((k) => !keys.get(b)!.has(k));
        expect(missing, `missing from ${b}: ${missing.join(', ')}`).toEqual([]);
      });
    }
  }

  it('the no-refund copy exists and is translated in all three locales', () => {
    // The founder's requirement: the subscriber must be told the money is
    // one-way BEFORE they pay, in whatever language they are running.
    const required = [
      'subscribe.oneWayTitle',
      'subscribe.oneWayBody',
      'subscribe.finalTitle',
      'subscribe.finalBody',
      'subscribe.pauseResumeBody',
      'streams.noRefundNotice',
      'streams.stillOwedSuffix',
    ];
    for (const [name, set] of keys) {
      for (const k of required) {
        expect(set.has(k), `${name} is missing ${k}`).toBe(true);
      }
    }

    // …and the translations must actually differ from English, otherwise the
    // key exists but the locale is still rendering English at the user.
    const read = (d: Dict, dotted: string): string =>
      dotted.split('.').reduce<any>((acc, part) => acc?.[part], d) as string;
    for (const k of required) {
      expect(read(fr as unknown as Dict, k), `fr.${k} is untranslated`).not.toBe(
        read(en as unknown as Dict, k),
      );
      expect(read(ja as unknown as Dict, k), `ja.${k} is untranslated`).not.toBe(
        read(en as unknown as Dict, k),
      );
    }
  });
});
