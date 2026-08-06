"use client";

import { motion } from "framer-motion";
import {
  Briefcase,
  Check,
  Clock,
  Mail,
  MapPin,
  MessageCircle,
  Minus,
  PieChart,
  Zap,
} from "lucide-react";
import { useT } from "@/i18n";
import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";

const fadeUp = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } };
const stagger = { visible: { transition: { staggerChildren: 0.1 } } };

// Single source of truth for the application channels. The founder chose the
// direct personal address over careers@ so applications land in a mailbox that
// is known to work, and the public Discord as the second channel.
const APPLY_EMAIL = "amirramy.chatbi@gmail.com";
const APPLY_DISCORD = "https://discord.gg/EfqnVmb2dV";

const MISSION_KEYS = ["m1", "m2", "m3", "m4", "m5", "m6"] as const;
const PROFILE_KEYS = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
const NOT_KEYS = ["n1", "n2", "n3"] as const;
const OFFER_KEYS = ["o1", "o2", "o3", "o4"] as const;
const CONTEXT_KEYS = ["p1", "p2", "p3"] as const;

/**
 * Google JobPosting structured data. `datePosted` is a literal, not `new Date()`:
 * a moving date would tell crawlers the posting is re-published on every render,
 * and Google demotes listings whose date keeps sliding.
 */
const JOB_LD = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Co-founder, Business Development",
  description:
    "Co-founder role owning the entire commercial surface of Protocol 01, a privacy layer for Solana: first merchants on the payment SDK, ecosystem partnerships, narrative, and the fundraising track. Compensation is equity.",
  datePosted: "2026-08-06",
  employmentType: ["FULL_TIME", "PART_TIME"],
  hiringOrganization: {
    "@type": "Organization",
    name: "Protocol 01",
    sameAs: "https://protocol-01.dev",
    logo: "https://protocol-01.dev/icon.png",
  },
  jobLocationType: "TELECOMMUTE",
  applicantLocationRequirements: { "@type": "Country", name: "Europe" },
  directApply: false,
};

function SectionCard({
  icon,
  title,
  items,
  tone = "cyan",
  t,
  prefix,
}: {
  icon: React.ReactNode;
  title: string;
  items: readonly string[];
  tone?: "cyan" | "dim";
  t: (k: string) => string;
  prefix: string;
}) {
  const accent = tone === "cyan" ? "text-p01-cyan" : "text-p01-text-dim";
  return (
    <motion.div
      variants={fadeUp}
      className="bg-p01-surface border border-p01-border rounded-2xl p-6"
    >
      <div className="flex items-center gap-2.5 mb-4">
        <span className={accent}>{icon}</span>
        <h3 className="text-white font-semibold text-sm font-display tracking-wide">{title}</h3>
      </div>
      <ul className="space-y-2.5">
        {items.map((k) => (
          <li key={k} className="flex items-start gap-2.5 text-sm text-p01-text-secondary leading-relaxed">
            <span className={`${accent} mt-1 shrink-0`}>
              {tone === "cyan" ? <Check size={13} /> : <Minus size={13} />}
            </span>
            {t(`${prefix}.${k}`)}
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

export default function CareersPage() {
  const t = useT();

  const meta = [
    { icon: <MapPin size={13} />, value: t("careers.role.location") },
    { icon: <Clock size={13} />, value: t("careers.role.commitment") },
    { icon: <PieChart size={13} />, value: t("careers.role.comp") },
    { icon: <Zap size={13} />, value: t("careers.role.start") },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JOB_LD) }}
      />
      <SiteHeader />

      <main className="min-h-screen pt-28 pb-16 px-4">
        <div className="max-w-4xl mx-auto">
          {/* Hero */}
          <motion.section
            className="mb-14"
            initial="hidden"
            animate="visible"
            variants={stagger}
          >
            <motion.div variants={fadeUp} className="flex items-center gap-3 mb-4">
              <span className="text-[10px] font-mono text-p01-cyan tracking-[0.3em] uppercase">
                {t("careers.badge")}
              </span>
              <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border border-p01-cyan/30 text-p01-cyan">
                {t("careers.openCount")}
              </span>
            </motion.div>
            <motion.h1
              variants={fadeUp}
              className="text-3xl sm:text-4xl font-bold text-white font-display tracking-tight mb-5 whitespace-pre-line"
            >
              {t("careers.heroTitle")}
            </motion.h1>
            <motion.p
              variants={fadeUp}
              className="text-p01-text-secondary text-base leading-relaxed max-w-2xl"
            >
              {t("careers.heroDesc")}
            </motion.p>
          </motion.section>

          {/* Context — the honest state of the company */}
          <motion.section
            className="mb-16"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-50px" }}
            variants={stagger}
          >
            <motion.div variants={fadeUp} className="mb-4">
              <span className="text-[10px] font-mono text-p01-cyan tracking-[0.3em] uppercase">
                {t("careers.context.badge")}
              </span>
              <h2 className="text-xl sm:text-2xl font-bold text-white mt-2 font-display">
                {t("careers.context.title")}
              </h2>
            </motion.div>
            <motion.div
              variants={fadeUp}
              className="bg-p01-surface border border-p01-border rounded-2xl p-6 sm:p-8 space-y-4 text-p01-text-secondary leading-relaxed"
            >
              {CONTEXT_KEYS.map((k) => (
                <p key={k}>{t(`careers.context.${k}`)}</p>
              ))}
            </motion.div>
          </motion.section>

          {/* The role */}
          <motion.section
            id="bd-cofounder"
            className="mb-16 scroll-mt-24"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-50px" }}
            variants={stagger}
          >
            <motion.h2
              variants={fadeUp}
              className="text-[10px] font-mono text-p01-text-dim tracking-[0.3em] uppercase mb-4"
            >
              {t("careers.rolesTitle")}
            </motion.h2>

            {/* Role header */}
            <motion.div
              variants={fadeUp}
              className="bg-p01-surface border border-p01-cyan/25 rounded-2xl p-6 sm:p-8 mb-4"
            >
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-p01-cyan/10 border border-p01-cyan/25 flex items-center justify-center shrink-0">
                  <Briefcase size={19} className="text-p01-cyan" />
                </div>
                <div className="min-w-0">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-p01-cyan">
                    {t("careers.role.tag")}
                  </span>
                  <h3 className="text-xl sm:text-2xl font-bold text-white font-display mt-1">
                    {t("careers.role.title")}
                  </h3>
                </div>
              </div>

              <div className="flex flex-wrap gap-x-5 gap-y-2 mt-5">
                {meta.map((m) => (
                  <span
                    key={m.value}
                    className="flex items-center gap-1.5 text-xs font-mono text-p01-text-dim"
                  >
                    <span className="text-p01-cyan/70">{m.icon}</span>
                    {m.value}
                  </span>
                ))}
              </div>

              <p className="text-p01-text-secondary text-sm leading-relaxed mt-5 pt-5 border-t border-p01-border">
                {t("careers.role.summary")}
              </p>
            </motion.div>

            {/* Role detail */}
            <div className="grid sm:grid-cols-2 gap-4">
              <SectionCard
                icon={<Check size={15} />}
                title={t("careers.role.missionTitle")}
                items={MISSION_KEYS}
                prefix="careers.role.mission"
                t={t}
              />
              <SectionCard
                icon={<Check size={15} />}
                title={t("careers.role.profileTitle")}
                items={PROFILE_KEYS}
                prefix="careers.role.profile"
                t={t}
              />
              <SectionCard
                icon={<Minus size={15} />}
                title={t("careers.role.notTitle")}
                items={NOT_KEYS}
                prefix="careers.role.not"
                tone="dim"
                t={t}
              />
              <SectionCard
                icon={<Check size={15} />}
                title={t("careers.role.offerTitle")}
                items={OFFER_KEYS}
                prefix="careers.role.offer"
                t={t}
              />
            </div>
          </motion.section>

          {/* Apply */}
          <motion.section
            className="mb-12"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-50px" }}
            variants={stagger}
          >
            <motion.div
              variants={fadeUp}
              className="relative overflow-hidden bg-p01-surface border border-p01-border rounded-2xl p-6 sm:p-8"
            >
              <div
                className="pointer-events-none absolute inset-x-0 top-0 h-px"
                style={{
                  background:
                    "linear-gradient(90deg, transparent, rgba(57,197,187,0.35) 20%, rgba(57,197,187,0.35) 80%, transparent)",
                }}
              />
              <h2 className="text-xl font-bold text-white font-display mb-2">
                {t("careers.role.applyTitle")}
              </h2>
              <p className="text-p01-text-secondary text-sm leading-relaxed max-w-xl">
                {t("careers.role.applyDesc")}
              </p>

              <div className="flex flex-wrap items-center gap-3 mt-6">
                <a
                  href={`mailto:${APPLY_EMAIL}?subject=${encodeURIComponent(
                    "Co-founder BD application",
                  )}`}
                  className="btn-primary text-xs px-5 py-2.5 inline-flex items-center gap-2"
                >
                  <Mail size={14} />
                  {APPLY_EMAIL}
                </a>
                <a
                  href={APPLY_DISCORD}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-5 py-2.5 border border-p01-border rounded-lg text-xs text-p01-text-muted hover:text-white hover:border-p01-cyan/40 transition-all inline-flex items-center gap-2"
                >
                  <MessageCircle size={14} />
                  {t("careers.role.applyDiscordLabel")}
                </a>
              </div>

              <p className="text-p01-text-dim text-xs mt-5 font-mono">
                {t("careers.role.applyNote")}
              </p>
            </motion.div>
          </motion.section>

          {/* Spontaneous applications */}
          <motion.section
            className="text-center"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={stagger}
          >
            <motion.h2 variants={fadeUp} className="text-white font-semibold text-sm mb-2">
              {t("careers.noOtherTitle")}
            </motion.h2>
            <motion.p
              variants={fadeUp}
              className="text-p01-text-dim text-sm leading-relaxed max-w-xl mx-auto"
            >
              {t("careers.noOtherDesc")}
            </motion.p>
          </motion.section>
        </div>
      </main>

      <Footer />
    </>
  );
}
