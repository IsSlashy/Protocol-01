/**
 * The design system holds, or this fails.
 *
 * WHY A SOURCE SCAN AND NOT A RENDER TEST
 * ───────────────────────────────────────
 * This suite runs in node with no React Native renderer, which is why every
 * test in `app/` is a scan (`no-refund-warning`, `privacy-claims`). That
 * constraint fits what has to be guarded here anyway: the properties below are
 * ABSENCES across ~42,500 lines, and an absence is a fact about the source. No
 * amount of rendering one screen proves the other fifty-nine did not drift.
 *
 * 🚨 WHAT THIS EXISTS TO STOP, MEASURED 2026-08-23. Before the realignment,
 * SEVENTY files carried hardcoded colour literals that bypassed
 * `constants/theme.ts` entirely. Retuning the theme moved nothing in those
 * files: they had their own copy of the old palette, inline, in StyleSheet
 * objects. A design system that can be ignored one `'#ffffff'` at a time is a
 * suggestion, and it had been ignored into two visually different products.
 *
 * ⛔ IF ONE OF THESE FAILS, FIX THE SCREEN, NOT THE TEST. Adding a file to an
 * allowlist to go green is how the seventy happened.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(__dirname, '..');
const SCANNED = ['app', 'components'];

/** Every source file a screen is built from. Tests and generated code excluded. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.expo' || name === 'dist') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(full);
      }
    }
  };
  for (const d of SCANNED) walk(join(ROOT, d));
  return out;
}

const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

/** Comments must not be able to fail a check about code. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FILES = sources();

describe('the palette is not bypassed', () => {
  /**
   * The retired values. Each one was in the app on 2026-08-22 and each one is
   * now wrong: pure white where the brand uses warm paper, the old cool
   * greyscale, hot pink, the #00ffe5 neon that appears nowhere on the site, and
   * a green in a system whose first rule is that there is no green.
   */
  const RETIRED = [
    '#ffffff', '#fff', // pure white: the brand's text is #eae7df
    '#0a0a0c', '#0f0f12', '#151518', '#1a1a1f', // the old cool greyscale
    '#2a2a30', '#3a3a40', // the old opaque borders
    '#ff77a8', '#ff2d7a', // pink, retired
    '#00ffe5', // the neon that is not on the site
    '#ffcc00', // the old yellow; caution is #d9a24a
    '#ff3366', // the old red
    '#10b981', // green, forbidden by the system's own first line
    '#888892', '#555560', // the old muted greys
  ];

  it('no screen carries a retired colour literal', () => {
    const hits: string[] = [];
    for (const f of FILES) {
      const code = codeOnly(readFileSync(f, 'utf8')).toLowerCase();
      for (const hex of RETIRED) {
        // Word boundary on the right so #fff does not match inside #ffcc00.
        if (new RegExp(hex + '(?![0-9a-f])').test(code)) {
          hits.push(`${rel(f)}  ${hex}`);
        }
      }
    }
    expect(
      hits,
      `These files carry a colour the design system retired on 2026-08-23.\n` +
        `Import it from constants/theme.ts instead:\n  ${hits.join('\n  ')}`,
    ).toEqual([]);
  });
});

/**
 * 🚨 THE RATCHET, AND WHY THE TEST ABOVE WAS NOT ENOUGH.
 *
 * The retired-colour check only forbids SIXTEEN specific values. An adversarial
 * pass over this suite found the hole immediately: 176 hardcoded hex literals
 * survive across 30 files, and every one of them passes, because they are all
 * the CURRENT brand colours. The right value, written the wrong way.
 *
 * That is not a cosmetic complaint. It is exactly the state the app was in on
 * 2026-08-22, one palette earlier: seventy files each holding their own copy of
 * what was then the right value. When the palette moved, none of them moved
 * with it, and retuning `constants/theme.ts` changed nothing on screen. A
 * design system that can be inlined is a design system with a countdown on it.
 *
 * Fixing all 176 in this pass would mean editing thirty screens the same day
 * they were rewritten, which is how a rework acquires the bug nobody can bisect.
 * So this is a RATCHET instead: the number may fall, never rise. Every screen
 * touched from here should leave it lower, and a new screen cannot add one
 * without turning this red and having to explain itself.
 *
 * ⛔ IF THIS FAILS BECAUSE THE COUNT WENT UP, MOVE THE COLOUR INTO
 * `constants/theme.ts`. Do not raise the ceiling.
 */
describe('hardcoded colours cannot spread', () => {
  /** Measured 2026-08-23, immediately after the rework. Only ever lower. */
  const CEILING = 176;

  it('does not exceed the ceiling recorded at the rework', () => {
    const perFile: { file: string; n: number }[] = [];
    let total = 0;
    for (const f of FILES) {
      const found = codeOnly(readFileSync(f, 'utf8')).match(/'#[0-9a-fA-F]{3,8}'/g);
      if (found) {
        total += found.length;
        perFile.push({ file: rel(f), n: found.length });
      }
    }
    perFile.sort((a, b) => b.n - a.n);
    expect(
      total,
      `Hardcoded colour literals went from ${CEILING} to ${total}.\n` +
        `Move the colour into constants/theme.ts rather than raising this number.\n` +
        `Worst files:\n  ` +
        perFile.slice(0, 8).map((x) => `${x.n}  ${x.file}`).join('\n  '),
    ).toBeLessThanOrEqual(CEILING);
  });
});

describe('the retired brand assets are gone', () => {
  it('nothing references the 01 raster', () => {
    // Founder ruling 2026-08-23. The mark is a serif S cut by a cyan diagonal,
    // composed in components/common/Wordmark.tsx, not an image.
    const hits = FILES.filter((f) => codeOnly(readFileSync(f, 'utf8')).includes('01-miku'));
    expect(hits.map(rel), 'The 01 logo is retired. Use components/common/Wordmark.').toEqual([]);
  });

  it('the Wordmark composes the mark rather than loading one', () => {
    // 🚨 The first attempt at this component on the Chrome extension INVENTED a
    // glyph. The mark already existed. If this file starts loading an image,
    // somebody has replaced a composed mark with a guess again.
    const w = readFileSync(join(ROOT, 'components/common/Wordmark.tsx'), 'utf8');
    expect(w).toMatch(/FontFamily\.display/);
    expect(w).toMatch(/<Line/);
    expect(codeOnly(w)).not.toMatch(/require\(.*\.png|<Image/);
  });
});

describe('the tab bar reflects the product', () => {
  const layout = readFileSync(join(ROOT, 'app/(main)/_layout.tsx'), 'utf8');

  it('has no Agent destination', () => {
    // Retired 2026-08-23: nobody was going to use an on-device chat box.
    // The route stays registered so a deep link still resolves, but with
    // href:null it is not a destination.
    const code = codeOnly(layout);
    const agentBlock = code.slice(code.indexOf('name="(agent)"'));
    expect(agentBlock).toMatch(/href:\s*null/);
    expect(code).not.toMatch(/title:\s*'Agent'/);
  });

  it('names the tabs after what they do', () => {
    const code = codeOnly(layout);
    // "Privacy" is a state; the screen performs an action. "Streams" was the
    // name of the parked personal-payment feature.
    expect(code).toMatch(/title:\s*'Shield'/);
    expect(code).toMatch(/title:\s*'Subs'/);
    expect(code).toMatch(/title:\s*'Discover'/);
    expect(code).not.toMatch(/title:\s*'Privacy'/);
    expect(code).not.toMatch(/title:\s*'Streams'/);
  });
});

describe('the theme has one source of truth', () => {
  const theme = readFileSync(join(ROOT, 'constants/theme.ts'), 'utf8');

  it('text is warm paper, never white', () => {
    expect(theme).toMatch(/text:\s*'#eae7df'/);
    expect(theme).toMatch(/textPrimary:\s*'#eae7df'/);
  });

  it('the convenience export does not drift from the palette it is convenient for', () => {
    // 🚨 IT DID. `P01Colors` was a second copy of the whole palette under a
    // different name, and it still held hot pink, the neon, the old yellow and
    // a green after `Colors` had been realigned. It now aliases `Colors`, so it
    // cannot say something different.
    const block = theme.slice(theme.indexOf('export const P01Colors'));
    const literals = block.match(/'#[0-9a-fA-F]{3,8}'/g) ?? [];
    expect(
      literals,
      `P01Colors must reference Colors.*, not restate hex values: ${literals.join(', ')}`,
    ).toEqual([]);
  });

  it('carries a display face, so headings are not just bold body text', () => {
    // Until 2026-08-23 every heading was Inter-Bold. Newsreader is what the
    // website and the extension set headings in.
    expect(theme).toMatch(/display:\s*'Newsreader-Light'/);
  });

  it('and that face is actually loaded, which is the half that gets forgotten', () => {
    // ⚠️ A fontFamily that is not registered falls back SILENTLY on both
    // platforms. That is how a typeface nobody chose ends up being the one
    // everybody sees.
    const loader = readFileSync(join(ROOT, 'hooks/useLoadFonts.ts'), 'utf8');
    expect(loader).toMatch(/'Newsreader-Light':/);
    expect(loader).toMatch(/'Newsreader-Regular':/);
  });
});
