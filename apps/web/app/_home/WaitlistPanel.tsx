"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useT, useLocale } from "@/i18n";
import SerifHeading from "./SerifHeading";

/**
 * WaitlistPanel — the home page signup form, in the Styx voice.
 *
 * This is components/WaitlistForm.tsx restyled, NOT reworked. components/ is off
 * limits for this port and that file still carries the Protocol 01 identity
 * (pink #ff2d7a error text, a cyan focus halo, an Orbitron heading in the success
 * panel), so it could not be dropped into a Styx band. Everything that touches
 * the network or the stored record is therefore copied across byte-for-byte:
 *
 *  - EMAIL_RE, and the pre-validation that sets errorInvalid without a round-trip
 *  - the double-submit guard (`if (submitting) return`) and noValidate
 *  - the ?src= campaign useEffect, with the same sanitizer and the same 32-char
 *    slice, still OVERRIDING the `source` prop in the body. Lose it and every
 *    campaign signup is mislabelled, silently.
 *  - the honeypot `website` input: off-screen at left:-9999px, deliberately NOT
 *    display:none, because bots skip those. Its value is still posted.
 *  - fetch("/api/waitlist"), POST, Content-Type: application/json, the same body
 *    shape and key order, and no cache/credentials/next options added
 *  - the invalid_email / rate_limited / else error mapping, the non-JSON body
 *    fallback and the network-failure catch
 *  - aria-live="polite" on the status region, aria-invalid on the email field,
 *    and the disabled-while-submitting states
 *  - all seventeen waitlist.* keys, including the success panel, so French keeps
 *    working. No sentence here is hardcoded English.
 *
 * The only changes are presentational: styx-field/styx-label/styx-input/
 * styx-select/styx-btn/styx-form-error, and a hairline panel instead of the
 * cornered terminal frame.
 */

type WaitlistSource = "hero" | "cta" | "extension-page";
type Interest = "mobile" | "extension" | "sdk";
type Status = "idle" | "submitting" | "success" | "error";
type ErrorKey = "errorInvalid" | "errorRateLimited" | "errorServer";

// Mirrors the server-side pre-validation. Deliberately loose — the backend is
// the source of truth, this only catches obvious typos before a round-trip.
const EMAIL_RE = /^\S+@\S+\.\S+$/;

export default function WaitlistPanel({
  source = "cta",
}: {
  source?: WaitlistSource;
}) {
  const t = useT();
  const { locale } = useLocale();

  // A campaign link (/?src=x) overrides the on-page origin so a channel can be
  // measured on its own. The server sanitizes it again.
  const [campaign, setCampaign] = useState<string | null>(null);
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("src");
    if (raw)
      setCampaign(
        raw
          .toLowerCase()
          .replace(/[^a-z0-9_.:/-]/g, "")
          .slice(0, 32) || null,
      );
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
        // Non-JSON error body — fall through to the generic message.
      }

      if (error === "invalid_email") setErrorKey("errorInvalid");
      else if (error === "rate_limited") setErrorKey("errorRateLimited");
      else setErrorKey("errorServer");
      setStatus("error");
    } catch {
      // Network failure — treat like a generic server error.
      setErrorKey("errorServer");
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div role="status" aria-live="polite" className="styx-panel">
        <div className="styx-panel-head">
          <p className="styx-card-label" style={{ margin: 0 }}>
            <span className="styx-check" aria-hidden="true">
              &#10003;
            </span>
            {t("waitlist.badge")}
          </p>
          <SerifHeading level={3} innerStyle={{ margin: "0.7rem 0 0" }}>
            {t("waitlist.successTitle")}
          </SerifHeading>
        </div>
        <div className="styx-panel-body">
          <div className="styx-prose">
            <p>{t("waitlist.successBody")}</p>
          </div>
          <p className="styx-note" style={{ marginTop: "0.9rem" }}>
            {t("waitlist.successNote")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="styx-panel styx-sweep">
      <div className="styx-panel-body">
        <div className="styx-stack">
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

          {/* Honeypot — off-screen (not display:none, which some bots skip) and
              hidden from assistive tech + tab order. Real users never fill it. */}
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            style={{
              position: "absolute",
              left: "-9999px",
              width: "1px",
              height: "1px",
              overflow: "hidden",
            }}
          />

          <div className="styx-field">
            <label className="styx-label" htmlFor="waitlist-interest">
              {t("waitlist.interestLabel")}
            </label>
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

          {/* Status region — always present so screen readers announce changes. */}
          <div aria-live="polite" style={{ minHeight: "1.5rem" }}>
            {hasError && (
              <p className="styx-form-error">{t(`waitlist.${errorKey}`)}</p>
            )}
          </div>

          <div className="styx-btn-row">
            <button type="submit" className="styx-btn" disabled={submitting}>
              {submitting ? t("waitlist.submitting") : t("waitlist.submit")}
            </button>
          </div>

          <p className="styx-note">{t("waitlist.consent")}</p>
        </div>
      </div>
    </form>
  );
}
