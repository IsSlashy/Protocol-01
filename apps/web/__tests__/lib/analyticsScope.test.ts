/**
 * WHERE THE ANALYTICS BEACONS ARE MOUNTED — measured, not assumed.
 *
 * BE HONEST ABOUT WHAT THIS IS: it reads two files as text. It cannot prove no
 * beacon fires on `/app`; it proves the mount is not written where it would.
 *
 * 🚨 THE FACT IT PINS. `@vercel/analytics` and `@vercel/speed-insights` were
 * mounted in the ROOT layout, and `app/(pay)` is a route group with no layout of
 * its own, so both inherited straight onto `/app` — the screen where a deposit
 * and a withdrawal happen. The analytics endpoint therefore saw the IP and the
 * page path of both halves of every flow, which is the join an observer needs.
 * `docs/LEAK-LEDGER.md:44` records it as D1.
 *
 * ⛔ A GREEN RUN IS NOT PRIVACY. It records that the root layout delegates the
 * decision, and that the component taking it excludes the privacy surface by
 * PREFIX. It is designed to go red in both directions — when a raw mount comes
 * back to the root, and when the guard stops excluding `/app`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '../..');

function codeOf(rel: string): string {
  return readFileSync(join(WEB, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const ROOT_LAYOUT = 'app/layout.tsx';
const GUARD = 'components/AnalyticsExceptPrivateApp.tsx';

describe('analytics never mount on the privacy app', () => {
  it('the root layout does not mount either beacon directly', () => {
    const code = codeOf(ROOT_LAYOUT);
    expect(code, 'the root layout imports @vercel/analytics again').not.toMatch(
      /from\s+['"]@vercel\/analytics/,
    );
    expect(code, 'the root layout imports @vercel/speed-insights again').not.toMatch(
      /from\s+['"]@vercel\/speed-insights/,
    );
    expect(code, 'the root layout renders <Analytics /> again').not.toMatch(/<\s*Analytics\b/);
    expect(code, 'the root layout renders <SpeedInsights /> again').not.toMatch(
      /<\s*SpeedInsights\b/,
    );
  });

  it('the root layout delegates to the guard', () => {
    expect(codeOf(ROOT_LAYOUT)).toMatch(/<\s*AnalyticsExceptPrivateApp\s*\/>/);
  });

  it('the guard excludes the privacy surface by prefix, not by equality', () => {
    const code = codeOf(GUARD);
    // Both halves matter. Equality alone would leave a future `/app/settings`
    // reporting again, silently, and nothing else in the tree would notice.
    expect(code, "the guard stopped checking the bare '/app' route").toMatch(/['"]\/app['"]/);
    expect(code, 'the guard stopped checking the /app/ PREFIX').toMatch(
      /startsWith\(\s*['"]\/app\/['"]\s*\)/,
    );
    expect(code, 'the guard no longer returns null for the privacy surface').toMatch(
      /return\s+null/,
    );
  });

  it('the guard is the only file that mounts the beacons', () => {
    // Anti-vacuity: if the guard did not import them, every assertion above
    // would pass while no analytics existed anywhere and the test measured
    // nothing about scoping.
    const code = codeOf(GUARD);
    expect(code).toMatch(/from\s+['"]@vercel\/analytics/);
    expect(code).toMatch(/from\s+['"]@vercel\/speed-insights/);
  });
});
