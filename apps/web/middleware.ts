import { NextResponse, type NextRequest } from "next/server";

/**
 * Country detection for locale selection.
 *
 * The site ships two languages: French for visitors in France, Canada and
 * Switzerland, English for everyone else. There is no language switcher; the
 * choice follows the visitor's location.
 *
 * Why middleware rather than reading the header in the layout: calling
 * `headers()` inside the root layout would opt EVERY page out of static
 * rendering, which is a heavy price for one string. Middleware runs per request
 * without doing that, so it copies the geo header into a readable cookie and the
 * client provider picks it up. Pages stay static.
 *
 * `x-vercel-ip-country` only exists on Vercel. In local development it is
 * absent, no cookie is written, and i18n falls back to the browser's own
 * language region. See i18n/index.tsx for that fallback.
 */
const COUNTRY_COOKIE = "styx-country";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  const country = request.headers.get("x-vercel-ip-country");
  if (!country) return response;

  // Only rewrite the cookie when it actually changed, so a visitor who does not
  // move does not get a fresh Set-Cookie on every navigation.
  if (request.cookies.get(COUNTRY_COOKIE)?.value === country) return response;

  response.cookies.set(COUNTRY_COOKIE, country, {
    path: "/",
    sameSite: "lax",
    // Readable by the client provider on purpose: it carries a country code,
    // nothing sensitive, and httpOnly would make it useless here.
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
}

export const config = {
  /**
   * Pages only. API routes do not render copy, and static assets would just
   * burn invocations.
   */
  matcher: [
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|mp4|mp3|zip|pdf|txt|xml|ico)$).*)",
  ],
};
