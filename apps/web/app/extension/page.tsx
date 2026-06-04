"use client";

import Link from "next/link";
import { Download, ShieldCheck, Puzzle, FolderOpen, ToggleRight, MousePointerClick, AlertTriangle } from "lucide-react";
import { useT } from "@/i18n";

const VERSION = "0.5.0";
const ZIP = `/protocol01-extension-${VERSION}.zip`;
const FOLDER = `protocol01-extension-${VERSION}`;
const codeCls = "text-p01-cyan";

export default function ExtensionPage() {
  const t = useT();

  const steps: { icon: React.ComponentType<{ className?: string }>; title: string; body: React.ReactNode }[] = [
    {
      icon: Download,
      title: t("extensionPage.step1Title"),
      body: (
        <>
          {t("extensionPage.step1a")} <code className={codeCls}>.zip</code> {t("extensionPage.step1b")}{" "}
          <code className={codeCls}>{FOLDER}</code>.
        </>
      ),
    },
    {
      icon: Puzzle,
      title: t("extensionPage.step2Title"),
      body: (
        <>
          {t("extensionPage.step2a")} <code className={codeCls}>chrome://extensions</code> (Opera:{" "}
          <code className={codeCls}>opera://extensions</code>, Edge: <code className={codeCls}>edge://extensions</code>, Brave:{" "}
          <code className={codeCls}>brave://extensions</code>).
        </>
      ),
    },
    {
      icon: ToggleRight,
      title: t("extensionPage.step3Title"),
      body: (
        <>
          {t("extensionPage.step3a")} <span className="text-white font-medium">{t("extensionPage.step3mode")}</span>{" "}
          {t("extensionPage.step3b")}
        </>
      ),
    },
    {
      icon: FolderOpen,
      title: t("extensionPage.step4Title"),
      body: (
        <>
          {t("extensionPage.step4a")} <span className="text-white font-medium">{t("extensionPage.step4action")}</span>{" "}
          {t("extensionPage.step4b")} <code className={codeCls}>{FOLDER}</code>.
        </>
      ),
    },
    {
      icon: MousePointerClick,
      title: t("extensionPage.step5Title"),
      body: <>{t("extensionPage.step5")}</>,
    },
  ];

  return (
    <main className="min-h-screen bg-p01-void text-white">
      <section className="relative py-20 px-4">
        <div className="max-w-3xl mx-auto">
          {/* Badge */}
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="text-[10px] font-mono text-p01-cyan tracking-[0.3em] uppercase">{t("extensionPage.badge")}</span>
            <span className="text-[10px] font-mono tracking-[0.2em] uppercase px-2 py-0.5 rounded-full border border-amber-400/40 text-amber-300 bg-amber-400/10">
              {t("extensionPage.betaBadge")}
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold text-center font-display mb-3">
            {t("extensionPage.title")}
          </h1>
          <p className="text-center text-p01-text-muted/70 max-w-xl mx-auto mb-2">
            {t("extensionPage.subtitle")}
          </p>
          <p className="text-center text-xs font-mono text-p01-text-muted/50 mb-10">
            v{VERSION} · {t("extensionPage.compat")}
          </p>

          {/* Download */}
          <div className="flex flex-col items-center gap-3 mb-12">
            <a
              href={ZIP}
              download
              className="inline-flex items-center gap-3 px-8 py-4 rounded-xl bg-p01-cyan text-p01-void font-display font-bold tracking-wide hover:bg-p01-cyan-dim transition-colors shadow-[0_0_40px_rgba(57,197,187,0.25)]"
            >
              <Download className="w-5 h-5" />
              {t("extensionPage.download")}
            </a>
            <span className="text-[11px] font-mono text-p01-text-muted/50">{FOLDER}.zip</span>
          </div>

          {/* Steps */}
          <div className="space-y-3">
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <div key={step.title} className="flex items-start gap-4 p-4 rounded-xl border border-p01-border bg-p01-surface/40">
                  <div className="shrink-0 w-10 h-10 rounded-lg bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
                    <Icon className="w-5 h-5 text-p01-cyan" />
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-white">{step.title}</h3>
                    <p className="text-sm text-p01-text-muted/70 mt-0.5">{step.body}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Devnet / beta notice */}
          <div className="mt-10 flex items-start gap-3 p-4 rounded-xl border border-amber-400/30 bg-amber-400/5">
            <AlertTriangle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-100/80">
              <span className="font-semibold text-amber-200">{t("extensionPage.betaTitle")}</span> {t("extensionPage.betaBody")}
            </p>
          </div>

          {/* Trust line */}
          <div className="mt-6 flex items-center justify-center gap-2 text-xs text-p01-text-muted/50">
            <ShieldCheck className="w-4 h-4 text-p01-cyan" />
            {t("extensionPage.trust")}
          </div>

          <div className="mt-10 text-center">
            <Link href="/" className="text-sm font-mono text-p01-cyan hover:underline">{t("extensionPage.back")}</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
