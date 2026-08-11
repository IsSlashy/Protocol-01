"use client";

import Link from "next/link";
import { useT } from "@/i18n";
import StyxShell from "../../_styx/StyxShell";
import Reveal from "../../_styx/Reveal";

/**
 * /waitlist/removed — the unsubscribe landing.
 *
 * Reached ONLY by a 302 from GET /api/waitlist/unsubscribe?token=… after the
 * record, its token index and the mailing set have already been deleted server
 * side. So this page takes no params, reads no cookies, guards nothing and
 * fetches nothing: it is one sentence and a way back. Do not add a searchParams
 * read or a "confirm" fetch here, and do not rename the route — the redirect
 * target is a literal in app/api/waitlist/unsubscribe/route.ts.
 *
 * It stays a client component for exactly one reason: useT() is a context hook.
 *
 * Ported off app/waitlist/WaitlistResult.tsx rather than through it. That
 * component is shared with /waitlist/confirmed and /waitlist/invalid, so the
 * presentation is rebuilt here and the shared file is left untouched.
 *
 * Copy discipline: the two sentences of meaning are t() calls, unchanged keys,
 * so French still works. Nothing is added around them. In particular the port
 * does not amplify removedBody with "no trace" / "erased forever" prose — the
 * signup-time aggregate counters (wl:cnt:total, wl:day:*, wl:loc:*, …) are never
 * decremented, and there is no suppression list, so the same address can be
 * added again later. The old chrome's three false footer claims are gone with
 * components/Footer.tsx and are not reintroduced.
 */
export default function WaitlistRemovedPage() {
  const t = useT();

  return (
    <StyxShell>
      <section className="styx-container-narrow styx-hero">
        {/* The only new English on the page, and deliberately meaning-free:
            brand plus the name of the list, both untranslatable anyway. */}
        <p className="styx-overline">Styx Protocol &middot; Waitlist</p>

        {/* The class sits on the <span>, not on the <h1>, and this is not a
            preference. Measured in the browser on 2026-08-11: styx.css line 69
            resets `.styx :is(h1, h2, …)` to `font-family: inherit; font-weight:
            inherit; letter-spacing: normal` to escape the root stylesheet's
            Orbitron — but that selector scores (0,1,1) and therefore outranks
            `.styx-h1` at (0,1,0). A real <h1 className="styx-h1"> consequently
            renders Inter 400 at letter-spacing normal; the identical class on a
            <p> renders Newsreader 300 at -2.08px, which is why the kit page
            looks correct. styx.css is off limits from a page, so the heading
            keeps its semantics and the serif voice moves one element inward.
            The two inline rules are layout only — no colour, no font stack, no
            spacing value of our own. Reported upward for a shared fix; delete
            the wrapper the day `.styx-h1` wins on its own. */}
        <h1 style={{ margin: 0 }}>
          <span className="styx-h1" style={{ display: "block" }}>
            {t("waitlist.removedTitle")}
          </span>
        </h1>

        {/* The cyan tick and the scaleX draw are the seal and the arrival
            gesture. No glow, no icon tile. */}
        <div className="styx-hero-rule" aria-hidden="true" />

        <Reveal className="styx-stack-lg styx-reveal">
          <p className="styx-lede">{t("waitlist.removedBody")}</p>
          <div className="styx-btn-row">
            {/* "/" verbatim, as it was before the port. Re-joining happens on
                the home page, where components/CTA.tsx mounts
                components/WaitlistForm.tsx. Do not retarget this at /waitlist. */}
            <Link href="/" className="styx-btn">
              {t("waitlist.backHome")}
            </Link>
          </div>
        </Reveal>

        {/* The page's whole motion budget: the header already spends the text
            gleam on FOUNDER, so the body gets the hairline version only. */}
        <div
          className="styx-gleam-rule"
          aria-hidden="true"
          style={{ marginTop: "clamp(3rem, 7vw, 5rem)" }}
        />
      </section>
    </StyxShell>
  );
}
