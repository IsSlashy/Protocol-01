"use client";

import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";
import { useT } from "@/i18n";

export default function PrivacyPolicy() {
  const t = useT();

  return (
    <div className="min-h-screen bg-p01-void">
      <SiteHeader />

      {/* Content */}
      <article className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-24">
        <header className="mb-16 text-center">
          <div className="inline-block px-4 py-1.5 rounded-full bg-p01-cyan/10 border border-p01-cyan/20 mb-6">
            <span className="text-p01-cyan text-xs font-mono tracking-widest uppercase">
              {t("privacyPolicy.legalBadge")}
            </span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-display font-bold text-white mb-4">
            {t("privacyPolicy.title")}
          </h1>
          <p className="text-p01-text-muted text-lg">
            {t("privacyPolicy.lastUpdatedLabel")}{" "}
            {t("privacyPolicy.lastUpdatedDate")}
          </p>
        </header>

        <div className="prose prose-invert max-w-none space-y-10 text-p01-text-muted leading-relaxed">
          {/* 1 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              {t("privacyPolicy.s1.heading")}
            </h2>
            <p>{t("privacyPolicy.s1.p1")}</p>
            <p>{t("privacyPolicy.s1.p2")}</p>
          </section>

          {/* 2 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              {t("privacyPolicy.s2.heading")}
            </h2>
            <p>
              {t("privacyPolicy.s2.introBefore")}
              <strong className="text-white"> {t("privacyPolicy.s2.introWord")}</strong>{" "}
              {t("privacyPolicy.s2.introAfter")}
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>
                <strong className="text-white">{t("privacyPolicy.s2.keys.k1.term")}</strong>{" "}
                — {t("privacyPolicy.s2.keys.k1.desc")}
              </li>
              <li>
                <strong className="text-white">{t("privacyPolicy.s2.keys.k2.term")}</strong>{" "}
                — {t("privacyPolicy.s2.keys.k2.desc")}
              </li>
              <li>
                <strong className="text-white">{t("privacyPolicy.s2.keys.k3.term")}</strong>{" "}
                — {t("privacyPolicy.s2.keys.k3.desc")}
              </li>
              <li>
                <strong className="text-white">{t("privacyPolicy.s2.keys.k4.term")}</strong>{" "}
                — {t("privacyPolicy.s2.keys.k4.desc")}
              </li>
              <li>
                <strong className="text-white">{t("privacyPolicy.s2.keys.k5.term")}</strong>{" "}
                — {t("privacyPolicy.s2.keys.k5.desc")}
              </li>
            </ul>
          </section>

          {/* 3 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              {t("privacyPolicy.s3.heading")}
            </h2>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              {t("privacyPolicy.s3.sub31Title")}
            </h3>
            <p>{t("privacyPolicy.s3.sub31p")}</p>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              {t("privacyPolicy.s3.sub32Title")}
            </h3>
            <p>{t("privacyPolicy.s3.sub32p")}</p>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              {t("privacyPolicy.s3.sub33Title")}
            </h3>
            <p>{t("privacyPolicy.s3.sub33p")}</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>{t("privacyPolicy.s3.sub33i1")}</li>
              <li>{t("privacyPolicy.s3.sub33i2")}</li>
              <li>{t("privacyPolicy.s3.sub33i3")}</li>
            </ul>
            <h3 className="text-lg font-semibold text-white mt-6 mb-2">
              {t("privacyPolicy.s3.sub34Title")}
            </h3>
            <p>{t("privacyPolicy.s3.sub34p")}</p>
          </section>

          {/* 4 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              {t("privacyPolicy.s4.heading")}
            </h2>
            <p>{t("privacyPolicy.s4.intro")}</p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>
                <strong className="text-white">{t("privacyPolicy.s4.keys.k1.term")}</strong>{" "}
                — {t("privacyPolicy.s4.keys.k1.desc")}
              </li>
              <li>
                <strong className="text-white">{t("privacyPolicy.s4.keys.k2.term")}</strong>{" "}
                — {t("privacyPolicy.s4.keys.k2.desc")}
              </li>
              <li>
                <strong className="text-white">{t("privacyPolicy.s4.keys.k3.term")}</strong>{" "}
                — {t("privacyPolicy.s4.keys.k3.desc")}
              </li>
              <li>
                <strong className="text-white">{t("privacyPolicy.s4.keys.k4.term")}</strong>{" "}
                — {t("privacyPolicy.s4.keys.k4.desc")}
              </li>
            </ul>
          </section>

          {/* 5 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              {t("privacyPolicy.s5.heading")}
            </h2>
            <p>{t("privacyPolicy.s5.intro")}</p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>
                <strong className="text-white">{t("privacyPolicy.s5.privyTerm")}</strong>{" "}
                — {t("privacyPolicy.s5.privyDescBefore")}{" "}
                <a
                  href="https://privy.io/privacy"
                  className="text-p01-cyan hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("privacyPolicy.s5.privyLink")}
                </a>
                .
              </li>
              <li>
                <strong className="text-white">{t("privacyPolicy.s5.heliusTerm")}</strong>{" "}
                — {t("privacyPolicy.s5.heliusDesc")}
              </li>
              <li>
                <strong className="text-white">{t("privacyPolicy.s5.jupiterTerm")}</strong>{" "}
                — {t("privacyPolicy.s5.jupiterDesc")}
              </li>
            </ul>
            <p className="mt-4">{t("privacyPolicy.s5.outro")}</p>
          </section>

          {/* 6 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              {t("privacyPolicy.s6.heading")}
            </h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>{t("privacyPolicy.s6.i1")}</li>
              <li>{t("privacyPolicy.s6.i2")}</li>
              <li>{t("privacyPolicy.s6.i3")}</li>
            </ul>
          </section>

          {/* 7 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              {t("privacyPolicy.s7.heading")}
            </h2>
            <p>{t("privacyPolicy.s7.intro")}</p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>
                <strong className="text-white">{t("privacyPolicy.s7.keys.k1.term")}</strong>{" "}
                — {t("privacyPolicy.s7.keys.k1.desc")}
              </li>
              <li>
                <strong className="text-white">{t("privacyPolicy.s7.keys.k2.term")}</strong>{" "}
                — {t("privacyPolicy.s7.keys.k2.desc")}
              </li>
              <li>
                <strong className="text-white">{t("privacyPolicy.s7.keys.k3.term")}</strong>{" "}
                — {t("privacyPolicy.s7.keys.k3.desc")}
              </li>
            </ul>
          </section>

          {/* 8 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              {t("privacyPolicy.s8.heading")}
            </h2>
            <p>{t("privacyPolicy.s8.p")}</p>
          </section>

          {/* 9 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              {t("privacyPolicy.s9.heading")}
            </h2>
            <p>{t("privacyPolicy.s9.p")}</p>
          </section>

          {/* 10 */}
          <section>
            <h2 className="text-2xl font-display font-bold text-white mb-4">
              {t("privacyPolicy.s10.heading")}
            </h2>
            <p>
              {t("privacyPolicy.s10.contactBefore")}{" "}
              <a
                href="mailto:privacy@protocol-01.com"
                className="text-p01-cyan hover:underline"
              >
                privacy@protocol-01.com
              </a>
            </p>
            <p className="mt-2">
              {t("privacyPolicy.s10.socialBefore")}{" "}
              <a
                href="https://x.com/Protocol01_"
                className="text-p01-cyan hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("privacyPolicy.s10.socialTwitter")}
              </a>{" "}
              {t("privacyPolicy.s10.socialOr")}{" "}
              <a
                href="https://discord.gg/EfqnVmb2dV"
                className="text-p01-cyan hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("privacyPolicy.s10.socialDiscord")}
              </a>
              .
            </p>
          </section>
        </div>

        {/* Footer links */}
        <div className="mt-16 pt-8 border-t border-p01-border flex flex-wrap gap-6 justify-center text-sm text-p01-text-muted">
          <Link href="/terms" className="hover:text-white transition-colors">
            {t("privacyPolicy.footer.terms")}
          </Link>
          <Link href="/licenses" className="hover:text-white transition-colors">
            {t("privacyPolicy.footer.licenses")}
          </Link>
          <Link href="/" className="hover:text-white transition-colors">
            {t("privacyPolicy.footer.home")}
          </Link>
        </div>
      </article>

      <Footer />
    </div>
  );
}
