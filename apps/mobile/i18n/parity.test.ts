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

/**
 * No locale may SHIP a subscription-cancellation promise, whether or not a
 * screen currently renders it.
 *
 * `streams.cancelAnytime` sat in all three dictionaries reading "Cancel
 * anytime, no penalties" / "Annulez a tout moment, sans penalite" / the same
 * in Japanese, long after cancellation was deleted, and every test in this
 * repo stayed green — the key had no reader, so `no-refund-warning.test.ts`,
 * which scans SCREENS, could never see it. A dictionary is shipped code: the
 * next screen to reach for a subscription bullet gets whatever is sitting
 * there.
 *
 * The distinction being drawn is subscription cancellation, not the word
 * "cancel". `common.cancel` ("Cancel", a dialog dismiss) and
 * `streams.cancelStream` (stopping a LOCAL client-side schedule, which holds
 * no prepaid balance and is refused outright when `stream.vaultAddress` is
 * set) are legitimate and must keep passing.
 */
describe('no locale ships a subscription cancellation or refund promise', () => {
  /** Promises: "cancel anytime", and any refund verb next to a cancel word. */
  const PROMISES: readonly RegExp[] = [
    /cancel (?:anytime|any time|at any time)/i,
    /annulez? à tout moment/i,
    /いつでも(?:キャンセル|解約)/,
    /refund(?:ed|able)?[^.]{0,60}\bcancel/i,
    /\bcancel(?:led|ling)?\b[^.]{0,60}refund(?:ed|able)?/i,
    /rembours[^.]{0,60}annul/i,
    /annul[^.]{0,60}rembours/i,
    /返金[^。]{0,40}(?:キャンセル|解約)/,
    /(?:キャンセル|解約)[^。]{0,40}返金/,
  ];

  /**
   * Sentences that state the rule truthfully and so contain both words.
   * Enumerated by hand, in every locale, rather than loosening the rules
   * above: adding a true sentence is a decision someone makes on purpose; a
   * loosened regex forgives every future false claim as well.
   */
  const TRUE_STATEMENTS: readonly RegExp[] = [
    /cannot be cancelled or refunded/gi,
    /no cancellation and no refund/gi,
    /cannot refund you/gi,
    /ni annulation ni remboursement/gi,
    /ne peut être ni annulé ni remboursé/gi,
    // "cannot be cancelled and cannot be refunded" / "no cancellation and no
    // refund", the two ja phrasings that carry the rule.
    /(?:キャンセル|解約)も返金もできません/g,
    /(?:キャンセル|解約)も返金も不可/g,
  ];

  /** Every leaf string in a dictionary, with its dotted key. */
  function leafStrings(obj: Dict, prefix = ''): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(obj)) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        out.push(...leafStrings(v as Dict, full));
      } else if (typeof v === 'string') {
        out.push([full, v]);
      }
    }
    return out;
  }

  it.each(DICTS)('%s', (_name, dict) => {
    const offenders = leafStrings(dict)
      .map(([k, v]) => [k, TRUE_STATEMENTS.reduce((s, re) => s.replace(re, ' '), v)] as const)
      .filter(([, v]) => PROMISES.some((re) => re.test(v)))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it('the detector fires on the exact string that shipped in all three', () => {
    // Regression fixture. These were the live values of `streams.cancelAnytime`.
    for (const shipped of [
      'Cancel anytime, no penalties',
      'Annulez à tout moment, sans pénalité',
      'いつでもキャンセル可能、ペナルティなし',
    ]) {
      expect(PROMISES.some((re) => re.test(shipped)), shipped).toBe(true);
    }
  });

  it('and stays silent on the cancel words that are legitimate', () => {
    for (const ok of [
      'Cancel',
      'Cancel Stream',
      'Cancel "%{name}"? This stops all future payments.',
      'Connection Cancelled',
      'This subscription cannot be cancelled or refunded.',
    ]) {
      const stripped = TRUE_STATEMENTS.reduce((s, re) => s.replace(re, ' '), ok);
      expect(PROMISES.filter((re) => re.test(stripped)), ok).toEqual([]);
    }
  });
});
