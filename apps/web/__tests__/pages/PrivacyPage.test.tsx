import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import PrivacyPolicy from '@/app/privacy/page';

/**
 * /privacy is the one page on the site where copy IS the product, so this suite
 * asserts what the page says, in both languages, and nothing about how it looks.
 *
 * WHY IT EXISTS. app/privacy/page.tsx cannot edit i18n/, so a paragraph that is
 * true except for one clause has that clause cut out at render time from a list
 * of verbatim literals. A verbatim literal stops matching the moment somebody
 * repunctuates the dictionary, and two copy sweeps crossed every locale in the
 * three days before this file was written (789facba, 6c7fe15d). Before the page
 * grew its second stage, that meant a false clause could silently reappear in a
 * legal document with nothing watching. This is the thing that watches.
 *
 * Both directions are covered on purpose:
 *
 *   1. Nothing untrue reaches the reader. Matched on the IDEA, loosely, not on
 *      the literal the page cuts, so rewording the dictionary cannot make these
 *      assertions pass by accident.
 *   2. The disclosures that must survive the cut are still there. This is the
 *      drift alarm: if a literal stops matching, the page refuses the whole
 *      paragraph and these assertions fail, which turns a silent falsehood into
 *      a loud missing sentence.
 *
 * The suite deliberately does not assert the exact wording of a filtered
 * paragraph. The honest rewrite lives in i18n/en.ts and i18n/fr.ts and will
 * change those words; an assertion on them would only teach the next author to
 * loosen a test.
 */

/** Which dictionary the mocked useT() resolves against for the next render. */
const locale = vi.hoisted(() => ({ current: 'en' as 'en' | 'fr' }));

// The shared mock in __tests__/setup.tsx resolves English only. This page ships a
// French filter list too, so the mock is widened here to switch catalogues
// between renders. Everything else about it is identical.
vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const catalogues: Record<string, unknown> = {
    en: (await import('@/i18n/en')).default,
    fr: (await import('@/i18n/fr')).default,
  };

  const lookup = (path: string): string => {
    let current: unknown = catalogues[locale.current];
    for (const part of path.split('.')) {
      if (current == null || typeof current !== 'object') return path;
      current = (current as Record<string, unknown>)[part];
    }
    return typeof current === 'string' ? current : path;
  };

  return {
    ...actual,
    useT: () => lookup,
    useLocale: () => ({ locale: locale.current, setLocale: vi.fn(), t: lookup }),
  };
});

/** Everything a reader of that locale can read on the page, as one string. */
function renderIn(which: 'en' | 'fr'): { text: string; root: HTMLElement } {
  locale.current = which;
  const { container } = render(<PrivacyPolicy />);
  return { text: container.textContent ?? '', root: container };
}

afterEach(() => {
  cleanup();
  locale.current = 'en';
});

/**
 * Claims the page may never print, per locale, each with the evidence that
 * settles it. Patterns are short and case-insensitive so they keep matching
 * through a reword: the point is to catch the idea, not one spelling of it.
 */
const UNTRUE_EN: ReadonlyArray<[string, RegExp]> = [
  // No decoy or cover-traffic mechanism ships; that design is parked.
  ['decoy mechanisms among the shipped defences', /decoy/i],
  // The withdrawal republishes the deposit commitment, so the pairing is trivial.
  ['the depositor/withdrawer link is broken', /cryptographically broken/i],
  ['pairing a commitment to a user is infeasible', /computationally infeasible/i],
  // Unlinkability of payments to one wallet, same defect one section down.
  ['stealth addresses stop payments being linked', /preventing observers/i],
  // The remote prover receives nullifiers and note secrets.
  ['secrets never leave the user', /never leaves your control/i],
  // lib/waitlist/store.ts is a user store keyed by email.
  ['no user databases', /do not operate user databases/i],
  // middleware.ts reads x-vercel-ip-country and sets the styx-country cookie;
  // app/api/waitlist/route.ts reads x-real-ip / x-forwarded-for.
  ['no IP logging or geolocation', /do not log ip addresses/i],
  // Server-side retention nobody outside can check.
  ['proof data is never persisted', /never persisted/i],
  ['proof data is discarded immediately', /discarded immediately/i],
  // The STARK is hash-based; "quantum-resistant" is not a measured claim here.
  ['quantum resistance', /quantum-resistant/i],
];

const UNTRUE_FR: ReadonlyArray<[string, RegExp]> = [
  ['decoy mechanisms among the shipped defences', /leurre/i],
  ['the depositor/withdrawer link is broken', /cryptographiquement rompu/i],
  [
    'pairing a commitment to a user is infeasible',
    /computationnellement infaisable/i,
  ],
  ['stealth addresses stop payments being linked', /empêchant les observateurs/i],
  ['secrets never leave the user', /ne quittent jamais votre contrôle/i],
  ['no user databases', /n['’]exploitons aucune base de données/i],
  ['no IP logging or geolocation', /n['’]enregistre pas les adresses ip/i],
  ['proof data is never persisted', /jamais persistées/i],
  ['proof data is discarded immediately', /supprimées immédiatement/i],
  ['quantum resistance', /résistantes? au quantique/i],
];

/**
 * Disclosures that must survive the clause cut, per locale.
 *
 * These are the reason the page cuts a clause instead of dropping the paragraph:
 * each one is something the reader is owed. If a cut literal drifts, the page
 * withholds the paragraph and one of these fails.
 */
const MUST_SURVIVE_EN: ReadonlyArray<[string, RegExp]> = [
  ['on-chain metadata is inherently public', /inherently public/i],
  ['stealth addresses exist at all', /one-time addresses/i],
  ['a prover service exists at all', /prover service/i],
];

const MUST_SURVIVE_FR: ReadonlyArray<[string, RegExp]> = [
  ['on-chain metadata is inherently public', /intrinsèquement publiques/i],
  ['stealth addresses exist at all', /adresses à usage unique/i],
  ['a prover service exists at all', /service de preuve/i],
];

describe('PrivacyPolicy -- claims the page may not make', () => {
  it.each(UNTRUE_EN)('English never says: %s', (_claim, pattern) => {
    expect(renderIn('en').text).not.toMatch(pattern);
  });

  it.each(UNTRUE_FR)('French never says: %s', (_claim, pattern) => {
    expect(renderIn('fr').text).not.toMatch(pattern);
  });
});

describe('PrivacyPolicy -- disclosures that must survive the filter', () => {
  it.each(MUST_SURVIVE_EN)('English still discloses: %s', (_what, pattern) => {
    expect(renderIn('en').text).toMatch(pattern);
  });

  it.each(MUST_SURVIVE_FR)('French still discloses: %s', (_what, pattern) => {
    expect(renderIn('fr').text).toMatch(pattern);
  });
});

describe('PrivacyPolicy -- the filter cannot leak its own plumbing', () => {
  // A key the page asks for and the dictionary does not have comes back from t()
  // as the dotted path. Printing "privacyPolicy.s6.i3" at a reader would be the
  // same defect as printing a false sentence, so the page treats an unresolved
  // key as absent copy.
  it.each(['en', 'fr'] as const)('%s prints no raw i18n key path', (which) => {
    expect(renderIn(which).text).not.toMatch(/privacyPolicy\./);
  });

  // The antipattern this page is built to avoid: a heading that keeps a claim
  // while the description carrying the evidence is suppressed. Every step row
  // must have both halves, in both languages.
  it.each(['en', 'fr'] as const)('%s renders no term without its description', (which) => {
    const { root } = renderIn(which);
    const steps = Array.from(root.querySelectorAll('li.styx-step'));

    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.querySelector('h3')?.textContent?.trim()).toBeTruthy();
      expect(
        step.querySelector('p.styx-step-body')?.textContent?.trim(),
      ).toBeTruthy();
    }
  });

  // Section 4 numbers its rows from what renders, not from the key names, so the
  // list cannot claim to be four items long while showing two.
  it.each(['en', 'fr'] as const)('%s numbers each step list from 01 with no gap', (which) => {
    const { root } = renderIn(which);
    const lists = Array.from(root.querySelectorAll('ul.styx-steps'));

    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      const indexes = Array.from(
        list.querySelectorAll('span.styx-step-index'),
      ).map((el) => el.textContent);
      expect(indexes).toEqual(
        indexes.map((_v, i) => String(i + 1).padStart(2, '0')),
      );
    }
  });
});

describe('PrivacyPolicy -- a reader can read the section numbers', () => {
  /**
   * The regression this guards. An earlier pass took the ordinal out of the <h2>
   * and left it in `.styx-numeral`, whose only colour declaration is
   * `color: var(--styx-rule)`, rgba(234, 231, 223, 0.14) on #070709, near 1.35:1,
   * plus a clipped screen-reader copy. On a ten-section policy that cites its own
   * numbers, no sighted reader could read one. The number belongs in the heading;
   * the oversized numeral repeats it and stays decorative.
   */
  it.each(['en', 'fr'] as const)('%s prints 1 to 10 inside the headings', (which) => {
    const { root } = renderIn(which);
    const visible = Array.from(root.querySelectorAll('h2.styx-h2')).map((h) =>
      (h.textContent ?? '').trim(),
    );

    for (let n = 1; n <= 10; n += 1) {
      expect(
        visible.some((heading) => heading.startsWith(`${n}.`)),
      ).toBe(true);
    }
  });

  it.each(['en', 'fr'] as const)('%s keeps the big numeral decorative', (which) => {
    const { root } = renderIn(which);
    const numerals = Array.from(root.querySelectorAll('span.styx-numeral'));

    expect(numerals).toHaveLength(10);
    numerals.forEach((numeral, i) => {
      // Zero-padded, hidden from assistive tech, and never the only copy of the
      // number: the heading beside it carries the same ordinal in readable ink.
      expect(numeral.textContent).toBe(String(i + 1).padStart(2, '0'));
      expect(numeral).toHaveAttribute('aria-hidden', 'true');
      const heading = numeral.parentElement?.querySelector('h2');
      expect(heading?.textContent?.trim()).toMatch(
        new RegExp(`^${i + 1}\\.`),
      );
    });
  });
});
