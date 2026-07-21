"use client";

import Link from "next/link";
import { CheckCircle, XCircle, CircleOff } from "lucide-react";
import { useT } from "@/i18n";
import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";

type Variant = "confirmed" | "invalid" | "removed";

// cyan check / pink cross / neutral off-list icon
const ICONS: Record<Variant, { Icon: typeof CheckCircle; color: string }> = {
  confirmed: { Icon: CheckCircle, color: "#39c5bb" },
  invalid: { Icon: XCircle, color: "#ff2d7a" },
  removed: { Icon: CircleOff, color: "#888892" },
};

export default function WaitlistResult({
  variant,
  titleKey,
  bodyKey,
}: {
  variant: Variant;
  titleKey: string;
  bodyKey: string;
}) {
  const t = useT();
  const { Icon, color } = ICONS[variant];

  return (
    <div className="min-h-screen bg-p01-void text-white flex flex-col">
      <SiteHeader />
      {/* section, not <main>: the root layout already renders the page inside a <main> */}
      <section className="flex-1 flex items-center justify-center px-4 py-32">
        <div className="max-w-md w-full text-center rounded-2xl border border-p01-border bg-p01-surface/40 p-10">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6"
            style={{ backgroundColor: color + "15", color }}
          >
            <Icon className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold font-display mb-3">{t(titleKey)}</h1>
          <p className="text-p01-text-muted mb-8">{t(bodyKey)}</p>
          <Link
            href="/"
            className="inline-flex items-center justify-center px-6 py-3 bg-[#39c5bb] text-[#0a0a0c] text-sm font-bold uppercase tracking-wider hover:bg-[#2a9d95] transition-colors"
          >
            {t("waitlist.backHome")}
          </Link>
        </div>
      </section>
      <Footer />
    </div>
  );
}
