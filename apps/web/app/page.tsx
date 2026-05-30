"use client";

import Hero from "@/components/Hero";
import Trust from "@/components/Trust";
import Problem from "@/components/Problem";
import HowItWorks from "@/components/HowItWorks";
import Features from "@/components/Features";
import ValueProp from "@/components/ValueProp";
import Ecosystem from "@/components/Ecosystem";
import CTA from "@/components/CTA";
import Footer from "@/components/Footer";
import SiteHeader from "@/components/SiteHeader";
import { useT } from "@/i18n";

export default function Home() {
  const t = useT();
  return (
    <>
      <SiteHeader />

      {/* Main Content */}
      <Hero />

      {/* Trust — built on / recognized by */}
      <Trust />

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

      {/* Why it pays — value per audience */}
      <ValueProp />

      <Ecosystem />

      <div id="download">
        <CTA />
      </div>

      <Footer cta={false} />
    </>
  );
}
