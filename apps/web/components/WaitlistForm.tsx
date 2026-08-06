"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useT, useLocale } from "@/i18n";

type WaitlistSource = "hero" | "cta" | "extension-page";
type Interest = "mobile" | "extension" | "sdk";
type Status = "idle" | "submitting" | "success" | "error";
type ErrorKey = "errorInvalid" | "errorRateLimited" | "errorServer";

// Mirrors the server-side pre-validation. Deliberately loose — the backend is
// the source of truth, this only catches obvious typos before a round-trip.
const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Shared field chrome: sharp corners, dark well, cyan focus glow. The pink
// error variant is applied on the email input only (the field that can fail).
const fieldBase =
  "w-full bg-[#0a0a0c] border font-mono text-sm px-4 py-3.5 transition-all duration-200 focus:outline-none caret-[#39c5bb] placeholder:text-[#555560]";
const fieldIdle =
  "border-[#2a2a30] hover:border-[#3a3a42] focus:border-[#39c5bb] focus:shadow-[0_0_0_1px_rgba(57,197,187,0.35),0_0_18px_rgba(57,197,187,0.12)]";
const fieldError =
  "border-[#ff2d7a]/70 focus:border-[#ff2d7a] focus:shadow-[0_0_0_1px_rgba(255,45,122,0.35),0_0_18px_rgba(255,45,122,0.12)]";

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="flex items-center gap-2 mb-2">
      <span className="w-1.5 h-1.5 bg-[#39c5bb]" aria-hidden />
      <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#888892]">
        {children}
      </span>
    </label>
  );
}

export default function WaitlistForm({ source = "cta" }: { source?: WaitlistSource }) {
  const t = useT();
  const { locale } = useLocale();

  // A campaign link (protocol-01.dev/?src=x) overrides the on-page origin so a
  // channel can be measured on its own. The server sanitizes it again.
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
      <div
        role="status"
        aria-live="polite"
        className="max-w-md mx-auto border border-[#39c5bb]/40 bg-[#39c5bb]/[0.06] p-6 text-center relative overflow-hidden"
      >
        {/* corner ticks — terminal frame feel */}
        <span className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-[#39c5bb]" aria-hidden />
        <span className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-[#39c5bb]" aria-hidden />
        <span className="absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-[#39c5bb]" aria-hidden />
        <span className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-[#39c5bb]" aria-hidden />

        <div className="w-12 h-12 bg-[#39c5bb]/15 flex items-center justify-center text-[#39c5bb] mx-auto mb-4">
          <Check className="w-6 h-6" />
        </div>
        <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[#39c5bb] mb-2">
          {t("waitlist.badge")}
        </p>
        <h3 className="font-display font-bold text-white text-lg mb-2">{t("waitlist.successTitle")}</h3>
        <p className="text-sm text-p01-text-muted">{t("waitlist.successBody")}</p>
        <p className="text-xs text-p01-text-dim mt-3">{t("waitlist.successNote")}</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="max-w-md mx-auto text-left">
      <FieldLabel htmlFor="waitlist-email">{t("waitlist.emailLabel")}</FieldLabel>
      <input
        id="waitlist-email"
        type="email"
        inputMode="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t("waitlist.emailPlaceholder")}
        aria-label={t("waitlist.emailLabel")}
        aria-invalid={hasError}
        disabled={submitting}
        className={`${fieldBase} text-white ${hasError ? fieldError : fieldIdle}`}
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

      <div className="mt-5">
        <FieldLabel htmlFor="waitlist-interest">{t("waitlist.interestLabel")}</FieldLabel>
        <div className="relative">
          <select
            id="waitlist-interest"
            value={interest}
            onChange={(e) => setInterest(e.target.value as Interest | "")}
            aria-label={t("waitlist.interestLabel")}
            disabled={submitting}
            className={`${fieldBase} ${fieldIdle} appearance-none pr-10 cursor-pointer ${
              interest === "" ? "text-[#888892]" : "text-white"
            }`}
          >
            <option value="">{t("waitlist.interestNone")}</option>
            <option value="mobile">{t("waitlist.interestMobile")}</option>
            <option value="extension">{t("waitlist.interestExtension")}</option>
            <option value="sdk">{t("waitlist.interestSdk")}</option>
          </select>
          <ChevronDown
            size={16}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-[#39c5bb] pointer-events-none"
            aria-hidden
          />
        </div>
      </div>

      {/* Status region — always present so screen readers announce changes. */}
      <div aria-live="polite" className="min-h-[1.5rem] mt-3">
        {hasError && (
          <p className="flex items-center gap-2 text-sm font-mono text-[#ff2d7a]">
            <span className="w-1.5 h-1.5 bg-[#ff2d7a] shrink-0" aria-hidden />
            {t(`waitlist.${errorKey}`)}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="w-full mt-2 px-6 py-3.5 bg-[#39c5bb] text-[#0a0a0c] font-bold uppercase tracking-wider transition-all duration-200 hover:bg-[#2a9d95] hover:shadow-[0_0_24px_rgba(57,197,187,0.3)] active:translate-y-px disabled:opacity-60 disabled:cursor-not-allowed disabled:shadow-none"
      >
        {submitting ? (
          <span className="inline-flex items-center gap-2">
            <span className="w-2 h-2 bg-[#0a0a0c] animate-pulse" aria-hidden />
            {t("waitlist.submitting")}
          </span>
        ) : (
          t("waitlist.submit")
        )}
      </button>

      <p className="text-xs text-p01-text-dim mt-3 leading-relaxed">{t("waitlist.consent")}</p>
    </form>
  );
}
