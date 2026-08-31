'use client';

import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { usePathname } from 'next/navigation';

/**
 * Vercel Analytics and Speed Insights, mounted everywhere EXCEPT the privacy app.
 *
 * 🚨 WHY THIS EXISTS. Both were mounted in the root layout, and `app/(pay)` is a
 * route group with no layout of its own, so they inherited straight onto `/app`.
 * That is the screen where a deposit and a withdrawal are performed, so the
 * analytics endpoint saw the IP and the page path of both halves of every flow —
 * the two things an observer needs to join a shield to the spend that follows it.
 * `docs/LEAK-LEDGER.md:44` records it as D1.
 *
 * ⛔ A CHILD LAYOUT CANNOT FIX THIS, which is why the guard is a component and
 * not a file move. Next.js layouts nest: `app/(pay)/layout.tsx` would render
 * INSIDE the root layout, so it can add to the tree but never remove what the
 * parent already mounted. The only place the decision can be taken is inside the
 * mount itself.
 *
 * ⚠️ THE PREFIX IS A PREFIX ON PURPOSE. `/app`, `/app/`, and anything below it
 * are all the privacy surface. Matching on equality would leave a future
 * `/app/settings` reporting again, silently, and nothing else in the tree would
 * notice.
 */
export default function AnalyticsExceptPrivateApp() {
  const pathname = usePathname();
  if (pathname === '/app' || pathname?.startsWith('/app/')) return null;
  return (
    <>
      <Analytics />
      <SpeedInsights />
    </>
  );
}
