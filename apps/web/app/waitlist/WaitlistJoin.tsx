"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { useT, useLocale } from "@/i18n";
import { SERIF_DISPLAY, SERIF_SMALL } from "./serif";

/**
 * WaitlistJoin: the whole hero of /waitlist. Overline, heading, lede, form.
 *
 * The wiring is cloned from components/WaitlistForm.tsx, deliberately, line for
 * line: the same POST, the same body shape, the same client pre-check, the same
 * error mapping, the same honeypot, the same `?src=` campaign effect. Only the
 * presentation is new. That old component is NOT imported and NOT edited, it
 * still renders the Protocol 01 identity (pink #ff2d7a, cyan glow shadows,
 * Orbitron via font-display), components/CTA.tsx renders it on the home page,
 * and __tests__/components/WaitlistForm.test.tsx asserts its DOM.
 *
 * WHY THE HEADING LIVES HERE and not in page.tsx: t() is a context hook, and
 * page.tsx has to stay a server component so it can export metadata. A heading
 * written up there would be hardcoded English sitting directly above a French
 * lede. Every string below is a t() call, so this hero has no hardcoded copy at
 * all. The one literal is the brand name, which is not translated anywhere on
 * the site.
 *
 * THE HEADING IS NOT THE BUTTON. waitlist.heroCta ("Join the waitlist") is the
 * submit label, and it was briefly the h1 as well, which put the same sentence in
 * the heading, on the button and on the foot exit in the same viewport, and gave
 * a submit button and an anchor one accessible name for two different actions.
 * The h1 is waitlist.heroTitle, a new key carrying the one sentence the rest of
 * the page does not say, and the foot exit is waitlist.backToForm.
 *
 * Two dictionary strings are deliberately NOT rendered. Same call as
 * app/waitlist/confirmed/page.tsx, for the same two reasons:
 *
 *  - waitlist.subtitle1 still says "Protocol 01" in both locales (en.ts:343,
 *    fr.ts:344), so rendering it puts the retired name in the first sentence of
 *    the page being rebranded. It also promises "you get a spot when the next
 *    wave opens", and there is no wave, no queue position and no date that this
 *    list can honour.
 *  - waitlist.subtitle2 says "one confirmation email, zero spam". The count is
 *    wrong: app/api/waitlist/route.ts:26 resends the confirmation up to
 *    MAX_RESENDS = 5 times, and app/api/waitlist/remind/route.ts adds one
 *    reminder on top.
 *
 * waitlist.consent carries the lede in their place. It is already translated,
 * and it is the one sentence here a reader can check: the unsubscribe link in
 * every mail resolves to /api/waitlist/unsubscribe, which hard-deletes the
 * record. Because it now sits beside the form it is no longer repeated under the
 * submit button. The mail behaviour it leaves out (five resends, a ten minute
 * cooldown, one reminder) is stated in bands 01 and 02 of ./WaitlistBands.tsx.
 *
 * Both subtitle keys are still rendered elsewhere (app/_home/HomeSections.tsx and
 * components/CTA.tsx), so routing around them here only protects this page.
 * Rewording them is a dictionary edit and is reported upward with the new keys
 * this hero needs, since one agent applies every i18n change at the end.
 *
 * Things that look cosmetic here and are not:
 *
 *  - `locale` is POSTed. lib/waitlist/email.ts picks the confirmation email's
 *    language from it, so dropping it emails every French signup in English.
 *  - `interest` is omitted from the body when the select is empty. The empty
 *    option therefore keeps value="" and the spread stays conditional.
 *  - the honeypot is off-screen, not display:none (bots skip those), and out of
 *    both the tab order and the a11y tree. A non-empty `website` makes
 *    app/api/waitlist/route.ts:46 answer a fake { ok: true } and store nothing.
 *  - the form carries noValidate so the browser never pre-empts EMAIL_RE and
 *    the error line stays the one the reader sees.
 *  - the aria-live region is rendered whether or not there is an error, so a
 *    screen reader announces the change instead of a new node appearing.
 *  - the id="join" on the panel is the target of the footer exit in
 *    ./WaitlistExits.tsx and of any /waitlist#join link.
 *
 * `source` defaults to "waitlist-page", which sanitizeSource accepts as-is and
 * which adds one `wl:src:waitlist-page` counter to the admin breakdown. A
 * campaign link (/waitlist?src=x) still overrides it.
 */

type Interest = "mobile" | "extension" | "sdk";
type Status = "idle" | "submitting" | "success" | "error";
type ErrorKey = "errorInvalid" | "errorRateLimited" | "errorServer";

// Mirrors the server-side pre-validation. Deliberately loose: the backend is the
// source of truth, this only catches obvious typos before a round-trip.
const EMAIL_RE = /^\S+@\S+\.\S+$/;

export default function WaitlistJoin({
  source = "waitlist-page",
}: {
  source?: string;
}) {
  const t = useT();
  const { locale } = useLocale();

  // A campaign link (/waitlist?src=x) overrides the on-page origin so a channel
  // can be measured on its own. The server sanitizes it again.
  const [campaign, setCampaign] = useState<string | null>(null);
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("src");
    if (raw) setCampaign(raw.toLowerCase().replace(/[^a-z0-9_.:/-]/g, "").slice(0, 32) || null);
  }, []);

  const [email, setEmail] = useState("");
  const [interest, setInterest] = useState<Interest | "">("");
  const [website, setWebsite] = useState(""); // honeypot, stays empty for humans
  const [status, setStatus] = useState<Status>("idle");
  const [errorKey, setErrorKey] = useState<ErrorKey>("errorServer");

  const submitting = status === "submitting";
  const hasError = status === "error";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;

    if (!EMAIL_RE.test(email.trim())) {
      setErrorKey("errorInvalid");
      setStatus("error");
      return;
    }

    setStatus("submitting");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          ...(interest ? { interest } : {}),
          source: campaign ?? source,
          locale,
          website,
        }),
      });

      if (res.ok) {
        setStatus("success");
        return;
      }

      let error = "";
      try {
        const data = await res.json();
        error = typeof data?.error === "string" ? data.error : "";
      } catch {
        // Non-JSON error body, fall through to the generic message.
      }

      if (error === "invalid_email") setErrorKey("errorInvalid");
      else if (error === "rate_limited") setErrorKey("errorRateLimited");
      else setErrorKey("errorServer");
      setStatus("error");
    } catch {
      // Network failure, treat like a generic server error.
      setErrorKey("errorServer");
      setStatus("error");
    }
  }

  return (
    <>
      {/* Brand plus the name of the list. The brand is a literal, the name of
          the list goes through waitlist.navLabel so a French reader gets
          "Liste d'attente". */}
      <p className="styx-overline">
        Styx Protocol &middot; {t("waitlist.navLabel")}
      </p>

      {/* One translated string, never split. A styx-em italic or a gleam word
          would have to cut the sentence, and the cut point differs per locale,
          so the hero's motion is the rule draw below it and the page's one text
          gleam stays on the styx-gleam-rule in band 03.
          NOT waitlist.heroCta: that key is the submit button's label ten lines
          below, and a headline that repeats its own button says nothing. It also
          gave the button and the foot exit one accessible name for two different
          actions. waitlist.heroTitle is the sentence the hero is for, and it is
          checkable: the unsubscribe link in every mail deletes the record. */}
      <h1 className="styx-h1" style={SERIF_DISPLAY}>
        {t("waitlist.heroTitle")}
      </h1>

      <div className="styx-hero-rule" aria-hidden="true" />

      <div className="styx-hero-body">
        {/* alignSelf overrides .styx-hero-body's `align-items: end`, which is
            right when the second column is a button row. Here it is a tall
            panel, so the lede sits at the top of the row instead of sinking. */}
        <p className="styx-lede" style={{ alignSelf: "start" }}>
          {t("waitlist.consent")}
        </p>

        {status === "success" ? (
          /* The form is replaced, not decorated. The old corner ticks and the
             cyan glow are gone; the seal is the tick and the accent overline. */
          <div id="join" className="styx-panel" role="status" aria-live="polite">
            <div className="styx-panel-head">
              <p className="styx-form-ok">{t("waitlist.badge")}</p>
            </div>
            <div className="styx-panel-body">
              <p style={{ margin: "0 0 1rem", lineHeight: 1 }}>
                <Check
                  size={22}
                  strokeWidth={1.5}
                  style={{ color: "var(--styx-accent)" }}
                  aria-hidden="true"
                />
              </p>
              <h2 className="styx-h3" style={SERIF_SMALL}>
                {t("waitlist.successTitle")}
              </h2>
              <p className="styx-card-note">{t("waitlist.successBody")}</p>
              <p className="styx-note" style={{ marginTop: "0.9rem" }}>
                {t("waitlist.successNote")}
              </p>
            </div>
          </div>
        ) : (
          /* styx-sweep gives the panel the one hover gesture. No panel head:
             every heading available for one would have been a sentence with no
             dictionary key, and the field labels already name the two inputs.
             app/_home/WaitlistPanel.tsx renders the same form the same way. */
          <div id="join" className="styx-panel styx-sweep">
            <div className="styx-panel-body">
              <form onSubmit={handleSubmit} noValidate className="styx-stack">
                <div className="styx-field">
                  <label className="styx-label" htmlFor="waitlist-email">
                    {t("waitlist.emailLabel")}
                  </label>
                  <input
                    id="waitlist-email"
                    className="styx-input"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("waitlist.emailPlaceholder")}
                    aria-label={t("waitlist.emailLabel")}
                    aria-invalid={hasError}
                    disabled={submitting}
                  />
                </div>

                {/* Honeypot: off-screen (not display:none, which some bots skip)
                    and hidden from assistive tech + tab order. Real users never
                    fill it. Copied verbatim, and deliberately unstyled. */}
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  style={{ position: "absolute", left: "-9999px", width: "1px", height: "1px", overflow: "hidden" }}
                />

                <div className="styx-field">
                  <label className="styx-label" htmlFor="waitlist-interest">
                    {t("waitlist.interestLabel")}
                  </label>
                  {/* Native arrow kept: .styx-select does not strip the
                      appearance, so there is no chevron to draw. The values are
                      whitelisted by INTERESTS in lib/waitlist/validate.ts, and
                      the empty one must stay "" so `interest` is omitted from
                      the request body. */}
                  <select
                    id="waitlist-interest"
                    className="styx-select"
                    value={interest}
                    onChange={(e) => setInterest(e.target.value as Interest | "")}
                    aria-label={t("waitlist.interestLabel")}
                    disabled={submitting}
                  >
                    <option value="">{t("waitlist.interestNone")}</option>
                    <option value="mobile">{t("waitlist.interestMobile")}</option>
                    <option value="extension">{t("waitlist.interestExtension")}</option>
                    <option value="sdk">{t("waitlist.interestSdk")}</option>
                  </select>
                </div>

                {/* Status region, always present so screen readers announce
                    changes rather than an insertion. Amber, the sanctioned
                    colour for something the reader must not miss, replaces the
                    old pink. */}
                <div aria-live="polite" style={{ minHeight: "1.25rem" }}>
                  {hasError && (
                    <p className="styx-form-error">{t(`waitlist.${errorKey}`)}</p>
                  )}
                </div>

                <button
                  type="submit"
                  className="styx-btn"
                  disabled={submitting}
                  style={{ width: "100%" }}
                >
                  {submitting ? (
                    <>
                      <span className="styx-dot" aria-hidden="true" />
                      {t("waitlist.submitting")}
                    </>
                  ) : (
                    t("waitlist.submit")
                  )}
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
