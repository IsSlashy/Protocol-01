"use client";

import Hero from "@/components/Hero";
import Problem from "@/components/Problem";
import HowItWorks from "@/components/HowItWorks";
import Features from "@/components/Features";
import Ecosystem from "@/components/Ecosystem";
import CTA from "@/components/CTA";
import Footer from "@/components/Footer";
import { useT, LanguageSwitcher } from "@/i18n";

export default function Home() {
  const t = useT();
  return (
    <>
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-p01-void/80 backdrop-blur-lg border-b border-p01-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            {/* Logo */}
            <a href="/" className="flex items-center gap-2.5">
              <img src="/icon.png" alt="Protocol 01" className="w-7 h-7 rounded-md" />
              <span className="text-sm font-bold text-white tracking-wider hidden sm:inline">PROTOCOL 01</span>
            </a>

            {/* Nav Links — essentials only */}
            <div className="hidden md:flex items-center gap-5">
              <a href="/docs" className="text-xs text-p01-text-muted hover:text-white transition-colors font-mono uppercase tracking-wider">{t('nav.docs')}</a>
              <a href="/roadmap" className="text-xs text-p01-text-muted hover:text-white transition-colors font-mono uppercase tracking-wider">{t('nav.roadmap')}</a>
              <a href="/sdk-demo" className="text-xs text-p01-text-dim hover:text-p01-text-muted transition-colors font-mono uppercase tracking-wider">SDK</a>
              <a href="/founder" className="text-xs text-p01-text-dim hover:text-p01-text-muted transition-colors font-mono uppercase tracking-wider">Founder</a>
            </div>

            {/* Right — language + download */}
            <div className="flex items-center gap-2">
              <LanguageSwitcher className="hidden sm:flex" />
              <a href="#download" className="btn-primary text-xs px-4 py-1.5">{t('nav.download')}</a>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <Hero />

      {/* Demo Video */}
      <section className="relative py-16 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <span className="text-[10px] font-mono text-p01-cyan tracking-[0.3em] uppercase">{t('demo.badge')}</span>
          <h2 className="text-2xl sm:text-3xl font-bold text-white mt-2 mb-8 font-display">{t('demo.title')}</h2>
          <div className="relative rounded-2xl overflow-hidden border border-p01-border shadow-[0_0_60px_rgba(57,197,187,0.1)]">
            <video
              src="/demo.mp4"
              controls
              playsInline
              preload="metadata"
              poster="/icon.png"
              className="w-full aspect-video bg-p01-void"
            />
          </div>
        </div>
      </section>

      <div id="problem">
        <Problem />
      </div>

      <HowItWorks />

      <div id="features">
        <Features />
      </div>

      <Ecosystem />

      <div id="download">
        <CTA />
      </div>

      <Footer />
    </>
  );
}
