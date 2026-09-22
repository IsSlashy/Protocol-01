'use client';

import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { usePathname } from 'next/navigation';

/**
 * Vercel Analytics and Speed Insights, mounted everywhere EXCEPT the routes
 * that render the pay app.
 *
 * 🚨 WHY THIS EXISTS. Both were mounted in the root layout, and `app/(pay)` is a
 * route group with no layout of its own, so they inherited straight onto `/app`.
 * That is the screen where a deposit and a withdrawal are performed, so the
 * analytics endpoint saw the IP and the page path of both halves of every flow,
 * in a dataset of its own with its own access and retention. Commit 71f3aa15
 * took them off `/app`.
 *
 * 🚨 `/` IS A PAY ROUTE TOO, SINCE 2026-09-12. `app/page.tsx` renders
 * `_home/HomeSimple.tsx`, which mounts the same `<WalletProvider><PayApp/>` that
 * `/app` frames. This guard kept excluding `/app` alone for eight days, and its
 * test stayed green because it looked for the literal `'/app'` in this file
 * (sweep 2 round 1, network lens). The list below is held to the import graph
 * now: `__tests__/lib/analyticsScope.test.ts` walks every `page.tsx` under
 * `app/`, finds the ones that reach `components/pay/PayApp.tsx`, and renders
 * this guard on each ("no beacon mounts on any route that renders the pay
 * app"). A page that starts mounting the pay app without being listed here
 * turns that case red.
 *
 * ⚠️ WHAT THIS COSTS, SO NOBODY "FIXES" IT BACK. The landing page reports no
 * pageviews and no web vitals any more. That is the price of putting the
 * product on the landing page. Every other page keeps both ("every other page
 * still mounts both beacons").
 *
 * ⚠️ WHAT THIS DOES NOT CHANGE. Vercel hosts the site and receives the IP, path
 * and time of every page and `/api/*` request regardless; the privacy policy
 * says so. The guard removes a SECOND store of pay-page visits, not the host.
 *
 * ⛔ A CHILD LAYOUT CANNOT FIX THIS, which is why the guard is a component and
 * not a file move. Next.js layouts nest: `app/(pay)/layout.tsx` would render
 * INSIDE the root layout, so it can add to the tree but never remove what the
 * parent already mounted. The only place the decision can be taken is inside the
 * mount itself.
 */

/**
 * Every route that renders `<PayApp/>`.
 *
 * ⚠️ EACH ENTRY IS A PREFIX ON PURPOSE, except `/`. `/app`, `/app/`, and
 * anything below it are all the pay surface: matching on equality would leave a
 * future `/app/settings` reporting again, silently. `/` is matched whole,
 * because it is a prefix of every route on the site.
 */
const PAY_APP_ROUTES = ['/', '/app'] as const;

/**
 * True when `pathname` renders the pay app, and ALSO when it cannot be read.
 * `usePathname()` is null outside the App Router; a guard that does not know
 * where it is answers the private way ("an unknown pathname mounts nothing").
 */
function isPayAppRoute(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string' || pathname.length === 0) return true;
  const path = pathname.replace(/\/+$/, '') || '/';
  return PAY_APP_ROUTES.some((route) =>
    route === '/' ? path === '/' : path === route || path.startsWith(`${route}/`),
  );
}

/**
 * The filter both beacons are mounted with: an event whose URL is a pay route
 * is dropped, and so is one whose URL cannot be read.
 *
 * 🚨 WHY A FILTER AS WELL AS THE UNMOUNT. Each component injects a script once
 * and the script STAYS in the page. A visitor who lands on `/docs` and follows
 * the header to `/` by client-side navigation reaches the pay app with both
 * scripts loaded; unmounting a React component does not unload them. Speed
 * Insights in particular reports when the page is hidden or left, which is the
 * end of a pay session.
 *
 * ⚠️ NOT MEASURED: what Vercel's remote scripts do with the filter. They are
 * not in this repository. What is tested is that the filter is handed over and
 * answers correctly ("hands both beacons a filter that drops an event for a pay
 * route"). Both packages type `beforeSend` as allowed to return null
 * (`@vercel/analytics` 1.6.1 and `@vercel/speed-insights` 2.0.0,
 * `dist/next/index.d.mts`); that null means "do not send" is their contract, not
 * something this repository can observe.
 */
function dropPayAppEvents<E extends { url: string }>(event: E): E | null {
  if (typeof event?.url !== 'string') return null;
  try {
    // The base only makes a relative URL parseable; it is never requested.
    return isPayAppRoute(new URL(event.url, 'https://base.invalid').pathname) ? null : event;
  } catch {
    return null;
  }
}

export default function AnalyticsExceptPrivateApp() {
  const pathname = usePathname();
  if (isPayAppRoute(pathname)) return null;
  return (
    <>
      <Analytics beforeSend={dropPayAppEvents} />
      <SpeedInsights beforeSend={dropPayAppEvents} />
    </>
  );
}
