/**
 * Locale key parity for the marketing site.
 *
 * `fr` is live for visitors in France, Canada and Switzerland, not a
 * nice-to-have. A sweep on this repo once edited `en` only, declared the job
 * done in its commit message, and left stale strings rendering in the other
 * language. Nothing caught it, because nothing was watching.
 *
 * This is what watches. It fails the moment a key exists in one dictionary and
 * not in the other, in either direction, so a half-finished translation pass
 * cannot be merged as green.
 *
 * Japanese was removed on 2026-08-11 along with the language switcher; the site
 * now picks a language from the visitor's country. The `ja` dictionary is
 * preserved in the identity archive, so if it ever returns, add it back to
 * DICTS below and the parity guard covers it again for free.
 */
import { describe, it, expect } from 'vitest';
import en from '@/i18n/en';
import fr from '@/i18n/fr';

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

function read(d: Dict, dotted: string): unknown {
  return dotted.split('.').reduce<any>((acc, part) => acc?.[part], d);
}

const DICTS: ReadonlyArray<readonly [string, Dict]> = [
  ['en', en as unknown as Dict],
  ['fr', fr as unknown as Dict],
];

describe('web i18n: en and fr carry identical key sets', () => {
  const keys = new Map(DICTS.map(([name, d]) => [name, new Set(leafKeys(d))]));

  it('every dictionary is non-trivial (guards against an empty import)', () => {
    for (const [name, set] of keys) {
      expect(set.size, `${name} has suspiciously few keys`).toBeGreaterThan(500);
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
});

describe('web i18n: the site does not promise cancellation it cannot deliver', () => {
  // The protocol has no cancellation instruction and cannot refund a
  // subscriber. Marketing copy that says otherwise is a false claim, and this
  // repo already carries 46 of those on record. These assertions are the
  // guardrail: they name the exact keys that used to make the promise.
  const RECANTED = [
    'sdkDemo.p01Sub3',
    'sdkDemo.featCancelAnytime',
    'sdkDemo.youCanDesc',
    'sdkDemo.cancelOneClick',
    'sdkDemo.priceLockedDesc',
  ];

  it('no subscriber-facing key claims the user can cancel', () => {
    for (const [name, d] of DICTS) {
      for (const k of RECANTED) {
        const v = read(d, k);
        expect(typeof v, `${name}.${k} is missing`).toBe('string');
        // The Japanese alternative stays in the pattern: it costs nothing and
        // keeps the guard correct if that dictionary is ever restored.
        expect(
          /cancel|annul|キャンセル/i.test(v as string) &&
            !/cannot be cancelled|ne peuvent pas .{0,20}annul|キャンセルでき/i.test(
              v as string,
            ),
          `${name}.${k} still promises cancellation: ${v}`,
        ).toBe(false);
      }
    }
  });

  it('the one-way rule is stated, and translated, in both locales', () => {
    for (const [name, d] of DICTS) {
      for (const k of ['sdkDemo.noRefundTitle', 'sdkDemo.noRefundDesc']) {
        expect(typeof read(d, k), `${name}.${k} is missing`).toBe('string');
      }
    }
    // …and fr is not silently rendering the English string.
    for (const k of ['sdkDemo.noRefundTitle', 'sdkDemo.noRefundDesc']) {
      expect(read(fr as unknown as Dict, k), `fr.${k} is untranslated`).not.toBe(
        read(en as unknown as Dict, k),
      );
    }
  });

  /**
   * Arcium left Protocol 01 on 2026-07-17. The nodes stopped rendering that day,
   * but 51 strings describing MPC compute, a Cerberus 1-of-N honest-node
   * guarantee and a whole "With & Without MPC" comparison table stayed in every
   * dictionary, invisible, and one edit away from rendering again.
   *
   * They are gone. This keeps them gone: any locale string naming Arcium fails
   * here, in any language, whether or not a component renders it today.
   *
   * If Arcium is ever adopted again, delete this test in the commit that ships
   * the integration — not before.
   */
  it('names no removed technology in any locale', () => {
    for (const [name, d] of DICTS) {
      const offenders = leafKeys(d)
        .filter((k) => /arcium|cerberus/i.test(String(read(d, k))))
        .map((k) => `${name}.${k}`);
      expect(offenders, 'Arcium is not part of Protocol 01').toEqual([]);
    }
  });
});
