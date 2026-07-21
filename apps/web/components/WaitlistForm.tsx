"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { useT, useLocale } from "@/i18n";

type WaitlistSource = "hero" | "cta" | "extension-page";
type Interest = "mobile" | "extension" | "sdk" | "merchant";
type Status = "idle" | "submitting" | "success" | "error";
type ErrorKey = "errorInvalid" | "errorRateLimited" | "errorServer";

// Mirrors the server-side pre-validation. Deliberately loose — the backend is
// the source of truth, this only catches obvious typos before a round-trip.
const EMAIL_RE = /^\S+@\S+\.\S+$/;

const inputCls =
  "w-full bg-[#0a0a0c] border border-[#2a2a30] focus:border-[#39c5bb] focus:outline-none text-white font-mono px-4 py-3 transition-colors";

export default function WaitlistForm({ source = "cta" }: { source?: WaitlistSource }) {
  const t = useT();
  const { locale } = useLocale();

  const [email, setEmail] = useState("");
  const [interest, setInterest] = useState<Interest | "">("");
  const [website, setWebsite] = useState(""); // honeypot — stays empty for humans
  const [status, setStatus] = useState<Status>("idle");
  const [errorKey, setErrorKey] = useState<ErrorKey>("errorServer");

  const submitting = status === "submitting";

  async function handleSubmit(e: React.FormEvent) {
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
          source,
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
      <div
        role="status"
        aria-live="polite"
        className="max-w-md mx-auto rounded-2xl border border-[#39c5bb]/40 bg-[#39c5bb]/[0.06] p-6 text-center"
      >
        <div className="w-12 h-12 rounded-xl bg-[#39c5bb]/15 flex items-center justify-center text-[#39c5bb] mx-auto mb-4">
          <Check className="w-6 h-6" />
        </div>
        <h3 className="font-display font-bold text-white text-lg mb-2">{t("waitlist.successTitle")}</h3>
        <p className="text-sm text-p01-text-muted">{t("waitlist.successBody")}</p>
        <p className="text-xs text-p01-text-dim mt-3">{t("waitlist.successNote")}</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="max-w-md mx-auto text-left">
      <label
        htmlFor="waitlist-email"
        className="block text-xs font-mono uppercase tracking-wider text-p01-text-dim mb-2"
      >
        {t("waitlist.emailLabel")}
      </label>
      <input
        id="waitlist-email"
        type="email"
        inputMode="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t("waitlist.emailPlaceholder")}
        aria-label={t("waitlist.emailLabel")}
        aria-invalid={status === "error"}
        disabled={submitting}
        className={`${inputCls} placeholder:text-p01-text-dim`}
      />

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
        style={{ position: "absolute", left: "-9999px", width: "1px", height: "1px", overflow: "hidden" }}
      />

      <label
        htmlFor="waitlist-interest"
        className="block text-xs font-mono uppercase tracking-wider text-p01-text-dim mb-2 mt-4"
      >
        {t("waitlist.interestLabel")}
      </label>
      <select
        id="waitlist-interest"
        value={interest}
        onChange={(e) => setInterest(e.target.value as Interest | "")}
        aria-label={t("waitlist.interestLabel")}
        disabled={submitting}
        className={inputCls}
      >
        <option value="">{t("waitlist.interestNone")}</option>
        <option value="mobile">{t("waitlist.interestMobile")}</option>
        <option value="extension">{t("waitlist.interestExtension")}</option>
        <option value="sdk">{t("waitlist.interestSdk")}</option>
        <option value="merchant">{t("waitlist.interestMerchant")}</option>
      </select>

      {/* Status region — always present so screen readers announce changes. */}
      <div aria-live="polite" className="min-h-[1.25rem] mt-3">
        {status === "error" && (
          <p className="text-sm font-mono text-[#ff2d7a]">{t(`waitlist.${errorKey}`)}</p>
        )}
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="w-full mt-2 px-6 py-3 bg-[#39c5bb] text-[#0a0a0c] font-bold uppercase tracking-wider hover:bg-[#2a9d95] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {submitting ? t("waitlist.submitting") : t("waitlist.submit")}
      </button>

      <p className="text-xs text-p01-text-dim mt-3">{t("waitlist.consent")}</p>
    </form>
  );
}
