/**
 * WHERE THE ANALYTICS BEACONS ARE MOUNTED — measured, not assumed.
 *
 * BE HONEST ABOUT WHAT THIS IS. It reads the root layout as text, it derives
 * the routes that mount the pay app from the import graph under `app/`, and it
 * renders the real guard on each of them with the two Vercel components
 * replaced by markers. It cannot prove no beacon fires in a browser; it proves
 * the guard mounts neither component on any route that renders `<PayApp/>`,
 * and that the filter it hands both components drops an event for such a route.
 *
 * 🚨 THE FACT IT PINS. `@vercel/analytics` and `@vercel/speed-insights` were
 * mounted in the ROOT layout, and `app/(pay)` is a route group with no layout of
 * its own, so both inherited straight onto `/app` — the screen where a deposit
 * and a withdrawal happen. The analytics endpoint therefore saw the IP and the
 * page path of both halves of every flow, in a dataset separate from the
 * function logs (commit 71f3aa15 carries the founder's intent; the ledger has
 * no row for it).
 *
 * 🚨 WHY THE ROUTES ARE DERIVED (sweep 2 round 1, network lens). This file used
 * to grep the guard for the literal `'/app'`. On 2026-09-12 the pay app moved
 * onto `/` (`app/page.tsx` → `_home/HomeSimple.tsx` → `<PayApp/>`), the guard
 * kept excluding `/app` only, and this file stayed green while the beacon
 * loaded on the page where deposits, subscriptions and withdrawals are made. A
 * literal cannot notice the app moving. The import graph can: whichever page
 * reaches `components/pay/PayApp.tsx` is a pay route, today and after the next
 * move.
 *
 * ⛔ A GREEN RUN IS NOT PRIVACY. Vercel hosts the page and sees the IP, path and
 * time of every request anyway (the privacy policy says so). What this holds is
 * narrower: no SECOND dataset of pay-page visits.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const WEB = join(__dirname, '../..');

function codeOf(rel: string): string {
  return readFileSync(join(WEB, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const ROOT_LAYOUT = 'app/layout.tsx';
const GUARD = 'components/AnalyticsExceptPrivateApp.tsx';
const PAY_APP = 'components/pay/PayApp.tsx';

// ── The guard, rendered for real, with the two beacons replaced by markers ───

const seen = vi.hoisted(() => ({
  pathname: '/' as string | null,
  analyticsProps: [] as Record<string, unknown>[],
  speedProps: [] as Record<string, unknown>[],
}));

vi.mock('next/navigation', () => ({ usePathname: () => seen.pathname }));
vi.mock('@vercel/analytics/next', async () => {
  const React = await import('react');
  return {
    Analytics: (props: Record<string, unknown>) => {
      seen.analyticsProps.push(props);
      return React.createElement('i', { 'data-beacon': 'analytics' });
    },
  };
});
vi.mock('@vercel/speed-insights/next', async () => {
  const React = await import('react');
  return {
    SpeedInsights: (props: Record<string, unknown>) => {
      seen.speedProps.push(props);
      return React.createElement('i', { 'data-beacon': 'speed-insights' });
    },
  };
});

const { default: Guard } = await import('@/components/AnalyticsExceptPrivateApp');

/** The beacons the guard mounts at `pathname`, by marker name. */
function beaconsAt(pathname: string | null): string[] {
  seen.pathname = pathname;
  const html = renderToStaticMarkup(createElement(Guard));
  return Array.from(html.matchAll(/data-beacon="([^"]+)"/g)).map((m) => m[1]!);
}

// ── Which routes mount the pay app: the import graph, not a list ────────────

const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '/index.tsx', '/index.ts', '/index.js'];

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(WEB, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null; // a package: it cannot mount our component
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const importCache = new Map<string, string[]>();

/** Every local module a file pulls in at runtime. `import type` mounts nothing. */
function importsOf(file: string): string[] {
  const cached = importCache.get(file);
  if (cached) return cached;
  const code = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const specs = new Set<string>();
  const patterns = [
    /\bimport\s+(?!type\b)[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?!type\b)[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) specs.add(m[1]!);
  const out: string[] = [];
  for (const spec of specs) {
    const hit = resolveImport(file, spec);
    if (hit) out.push(hit);
  }
  importCache.set(file, out);
  return out;
}

function reaches(entry: string, target: string): boolean {
  const stack = [entry];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (file === target) return true;
    if (visited.has(file)) continue;
    visited.add(file);
    if (!/\.(tsx?|jsx?|mjs)$/.test(file)) continue;
    stack.push(...importsOf(file));
  }
  return false;
}

function pagesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // `_private` folders are not routable; `api` holds no pages.
      if (name.startsWith('_') || name === 'api') continue;
      out.push(...pagesUnder(full));
    } else if (/^page\.(tsx|ts|jsx|js)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** `app/(pay)/app/page.tsx` → `/app`; `[slug]` becomes a sample segment. */
function routeOf(page: string): string {
  const segments = relative(join(WEB, 'app'), dirname(page))
    .split(sep)
    .filter((s) => s.length > 0 && !/^\(.*\)$/.test(s))
    .map((s) => s.replace(/^\[+\.{0,3}(.+?)\]+$/, 'sample-$1'));
  return '/' + segments.join('/');
}

/** A page mounts what it imports AND what every layout above it imports. */
function entriesFor(page: string): string[] {
  const entries = [page];
  const appRoot = join(WEB, 'app');
  for (let dir = dirname(page); dir.startsWith(appRoot); dir = dirname(dir)) {
    // The ROOT layout is every route's ancestor; it is checked on its own below.
    if (dir === appRoot) break;
    for (const name of ['layout.tsx', 'layout.ts', 'template.tsx', 'template.ts']) {
      const f = join(dir, name);
      if (existsSync(f)) entries.push(f);
    }
  }
  return entries;
}

const TARGET = join(WEB, PAY_APP);
const ALL_PAGES = pagesUnder(join(WEB, 'app'));
const PAY_ROUTES = ALL_PAGES.filter((p) => entriesFor(p).some((e) => reaches(e, TARGET))).map(routeOf);
const OTHER_ROUTES = ALL_PAGES.map(routeOf).filter((r) => !PAY_ROUTES.includes(r));

beforeEach(() => {
  seen.analyticsProps.length = 0;
  seen.speedProps.length = 0;
});

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

  it('the root layout itself does not reach the pay app', () => {
    // If it did, EVERY route would be a pay route and the derivation below
    // would have to say so instead of listing two.
    expect(reaches(join(WEB, ROOT_LAYOUT), TARGET)).toBe(false);
  });

  it('the derivation finds the routes known to mount the pay app, and routes that do not', () => {
    // Anti-vacuity for everything below: an import walker that resolved nothing
    // would derive an empty list, and "no beacon on any of zero routes" is green.
    expect(PAY_ROUTES, 'the landing page mounts <PayApp/> since 2026-09-12').toContain('/');
    expect(PAY_ROUTES, 'the framed app mounts <PayApp/>').toContain('/app');
    expect(OTHER_ROUTES).toContain('/docs');
    expect(OTHER_ROUTES).toContain('/privacy');
    expect(OTHER_ROUTES.length).toBeGreaterThan(PAY_ROUTES.length);
  });

  it('no beacon mounts on any route that renders the pay app', () => {
    const mounted = PAY_ROUTES.map((route) => ({ route, beacons: beaconsAt(route) })).filter(
      (r) => r.beacons.length > 0,
    );
    expect(mounted, 'a beacon is mounted on a route that renders <PayApp/>').toEqual([]);
  });

  it('the guard excludes the privacy surface by prefix, not by equality', () => {
    // Equality alone would leave a future `/app/settings` reporting again,
    // silently, and nothing else in the tree would notice. Rendered, not
    // grepped: the literal this case used to look for is how the move onto `/`
    // went unseen.
    for (const path of ['/app', '/app/', '/app/settings', '/app/a/b']) {
      expect(beaconsAt(path), `a beacon mounts at ${path}`).toEqual([]);
    }
    // `/` is a prefix of every route, so it is matched whole: the rest of the
    // site keeps its analytics.
    expect(beaconsAt('/')).toEqual([]);
    expect(beaconsAt('/application')).toEqual(['analytics', 'speed-insights']);
  });

  it('every other page still mounts both beacons, so the guard is a scope and not an off switch', () => {
    const silent = OTHER_ROUTES.filter((route) => beaconsAt(route).length !== 2);
    expect(silent, 'a non-pay route lost its analytics').toEqual([]);
  });

  it('an unknown pathname mounts nothing', () => {
    // `usePathname()` is null outside the App Router. A guard that cannot tell
    // where it is has to assume the private answer.
    expect(beaconsAt(null)).toEqual([]);
  });

  /**
   * The mount is not the whole story. Both scripts are injected once and STAY
   * in the page: a visitor who lands on `/docs` and follows the header link to
   * `/` by client-side navigation arrives on the pay app with both scripts
   * already loaded, and unmounting a React component does not unload a script.
   * Both packages take a `beforeSend` filter, and the guard hands them one that
   * drops any event whose URL is a pay route. What the remote script does with
   * it is Vercel's code and is NOT measured here; what is measured is that the
   * filter exists and answers correctly.
   */
  it('hands both beacons a filter that drops an event for a pay route', () => {
    beaconsAt('/docs');
    const filters = [seen.analyticsProps.at(-1)?.beforeSend, seen.speedProps.at(-1)?.beforeSend];
    expect(filters.map((f) => typeof f), 'a beacon is mounted with no beforeSend filter').toEqual([
      'function',
      'function',
    ]);
    for (const filter of filters as ((e: { type: string; url: string }) => unknown)[]) {
      for (const route of PAY_ROUTES) {
        const event = { type: 'pageview', url: `https://styx.cash${route}?treasury=1#app` };
        expect(filter(event), `an event for ${route} was let through`).toBeNull();
      }
      expect(filter({ type: 'pageview', url: 'https://styx.cash/app/settings' })).toBeNull();
      expect(filter({ type: 'pageview', url: '/app' }), 'a relative pay URL was let through').toBeNull();
      expect(filter({ type: 'pageview', url: 'http://' }), 'an unreadable URL was let through').toBeNull();
      expect(filter({ type: 'pageview' } as never), 'an event with no URL was let through').toBeNull();
      const docs = { type: 'pageview', url: 'https://styx.cash/docs' };
      expect(filter(docs), 'the filter drops everything, so it proves nothing').toBe(docs);
    }
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
