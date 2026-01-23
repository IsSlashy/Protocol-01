"use client";

import { memo } from "react";
import Image from "next/image";
import Link from "next/link";
import GlitchLogo01 from "./GlitchLogo01";
import PhoneMockup from "./PhoneMockup";

/**
 * Hero - Optimized version
 *
 * Changes from original:
 * - Replaced JS setState animations with CSS keyframes
 * - SystemStatus now uses CSS glitch animation
 * - CorruptionNoise now uses CSS animation
 * - Removed framer-motion infinite animations
 * - GPU-accelerated transforms
 */

// Terminal-style status text - CSS animated
const SystemStatus = memo(function SystemStatus() {
  return (
    <div className="mt-6 flex flex-col items-start">
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes text-glitch-status {
          0%, 75%, 100% {
            transform: translateX(0) skewX(0deg);
          }
          76% {
            transform: translateX(4px) skewX(2deg);
          }
          78% {
            transform: translateX(-3px) skewX(-1deg);
          }
          80% {
            transform: translateX(2px) skewX(1deg);
          }
          82% {
            transform: translateX(0) skewX(0deg);
          }
        }

        @keyframes chromatic-cyan {
          0%, 75%, 100% { opacity: 0; transform: translateX(0); }
          76% { opacity: 0.7; transform: translateX(-5px); }
          82% { opacity: 0; transform: translateX(0); }
        }

        @keyframes chromatic-pink {
          0%, 75%, 100% { opacity: 0; transform: translateX(0); }
          76% { opacity: 0.7; transform: translateX(5px); }
          82% { opacity: 0; transform: translateX(0); }
        }

        @keyframes blink-square {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }

        @media (prefers-reduced-motion: reduce) {
          .status-glitch { animation: none !important; }
        }
      `}} />

      {/* System status label */}
      <span
        className="text-[#ff2d7a] text-xs font-bold tracking-[6px] mb-3 font-mono"
        style={{ letterSpacing: "0.4em" }}
      >
        [ SYSTEM STATUS ]
      </span>

      {/* UNTRACEABLE - with chromatic glitch */}
      <div className="relative h-[60px] flex items-center">
        {/* Cyan ghost layer - CSS animated */}
        <span
          className="absolute text-[#39c5bb] text-4xl sm:text-5xl font-black tracking-wider status-glitch"
          style={{
            fontFamily: "var(--font-display)",
            animation: "chromatic-cyan 2.5s steps(1) infinite",
            willChange: "opacity, transform",
          }}
        >
          UNTRACEABLE
        </span>

        {/* Pink ghost layer - CSS animated */}
        <span
          className="absolute text-[#ff2d7a] text-4xl sm:text-5xl font-black tracking-wider status-glitch"
          style={{
            fontFamily: "var(--font-display)",
            animation: "chromatic-pink 2.5s steps(1) infinite",
            animationDelay: "0.1s",
            willChange: "opacity, transform",
          }}
        >
          UNTRACEABLE
        </span>

        {/* Main text - CSS animated */}
        <span
          className="text-white text-4xl sm:text-5xl font-black tracking-wider status-glitch"
          style={{
            fontFamily: "var(--font-display)",
            animation: "text-glitch-status 2.5s steps(1) infinite",
            willChange: "transform",
          }}
        >
          UNTRACEABLE
        </span>
      </div>

      {/* Status indicator - terminal style with blinking square */}
      <div className="flex items-center mt-4">
        <div
          className="w-2 h-2 bg-[#39c5bb] mr-3"
          style={{ animation: "blink-square 1s ease-in-out infinite" }}
        />
        <span
          className="text-[#555560] text-xs tracking-[4px] font-mono uppercase"
          style={{ letterSpacing: "0.3em" }}
        >
          READY
        </span>
      </div>
    </div>
  );
});

// Corruption noise effect - CSS animated
const CorruptionNoise = memo(function CorruptionNoise() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes noise-flash {
          0%, 70%, 100% { opacity: 0; }
          72% { opacity: 0.18; }
          74% { opacity: 0; }
          85% { opacity: 0.15; }
          87% { opacity: 0; }
        }

        @media (prefers-reduced-motion: reduce) {
          .noise-layer { animation: none !important; opacity: 0 !important; }
        }
      `}} />
      <div
        className="absolute inset-0 pointer-events-none z-20 noise-layer"
        style={{
          animation: "noise-flash 4s steps(1) infinite",
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          mixBlendMode: "overlay",
          willChange: "opacity",
        }}
      />
    </>
  );
});

function Hero() {
  return (
    <section className="relative min-h-screen flex items-center overflow-hidden">
      {/* CSS Animations for Hero elements */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes fade-in-left {
          from { opacity: 0; transform: translateX(-20px); }
          to { opacity: 1; transform: translateX(0); }
        }

        @keyframes fade-in-scale {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }

        @keyframes pulse-opacity {
          0%, 100% { opacity: 0.2; }
          50% { opacity: 0.4; }
        }

        @keyframes scroll-bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(10px); }
        }

        @keyframes scroll-dot {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(8px); }
        }

        @media (prefers-reduced-motion: reduce) {
          .hero-animate { animation: none !important; opacity: 1 !important; transform: none !important; }
        }
      `}} />

      {/* Corruption noise overlay */}
      <CorruptionNoise />

      {/* Miku background - semi-transparent, centered between 01 and phone */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[5] overflow-hidden">
        <div
          className="relative w-[500px] h-[500px] lg:w-[700px] lg:h-[700px] hero-animate"
          style={{
            animation: "fade-in-scale 1.2s ease-out 0.3s forwards",
            opacity: 0,
          }}
        >
          {/* Scan lines overlay */}
          <div
            className="absolute inset-0 z-10"
            style={{
              background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)',
            }}
          />
          {/* Cyan glow */}
          <div className="absolute inset-0 bg-gradient-radial from-[#39c5bb]/10 via-transparent to-transparent" />
          {/* The image */}
          <Image
            src="/Miku.png"
            alt=""
            fill
            className="object-contain opacity-[0.15] mix-blend-lighten"
            style={{
              filter: 'grayscale(30%) contrast(1.1)',
              maskImage: 'radial-gradient(ellipse 80% 80% at 50% 50%, black 40%, transparent 70%)',
              WebkitMaskImage: 'radial-gradient(ellipse 80% 80% at 50% 50%, black 40%, transparent 70%)',
            }}
            priority
          />
        </div>
      </div>

      {/* Main content - Asymmetric layout */}
      <div className="relative z-10 w-full max-w-7xl mx-auto px-6 lg:px-12 py-20">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-8 items-center">
          {/* Left side - Text content */}
          <div className="order-2 lg:order-1">
            {/* Protocol badge - sharp, no rounded-full, no soft glow */}
            <div
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#151518] border border-[#39c5bb]/40 mb-6 hero-animate"
              style={{
                animation: "fade-in-left 0.5s ease-out forwards",
                opacity: 0,
              }}
            >
              <span className="w-2 h-2 bg-[#39c5bb]" />
              <span className="text-sm text-[#39c5bb] font-mono uppercase tracking-wider">
                Protocol Active
              </span>
            </div>

            {/* Massive 01 - Using PNG image with ULTRAKILL glitch */}
            <div
              className="mb-2 hero-animate"
              style={{
                animation: "fade-in-scale 0.8s ease-out 0.2s forwards",
                opacity: 0,
              }}
            >
              <GlitchLogo01 />
            </div>

            {/* Terminal-style system status */}
            <div
              className="hero-animate"
              style={{
                animation: "fade-in-up 0.5s ease-out 0.4s forwards",
                opacity: 0,
              }}
            >
              <SystemStatus />
            </div>

            {/* Description - industrial monospace */}
            <div
              className="text-[#888892] text-base max-w-lg mt-8 mb-8 font-mono leading-loose hero-animate"
              style={{
                animation: "fade-in-up 0.5s ease-out 0.5s forwards",
                opacity: 0,
              }}
            >
              <p>Anonymous transactions.</p>
              <p>Private streams.</p>
              <p>Zero-knowledge communications.</p>
              <p className="text-[#39c5bb]">Total invisibility.</p>
            </div>

            {/* CTA Buttons - sharp edges, no soft shadows */}
            <div
              className="flex flex-wrap gap-4 mb-12 hero-animate"
              style={{
                animation: "fade-in-up 0.5s ease-out 0.6s forwards",
                opacity: 0,
              }}
            >
              <button className="px-6 py-3 bg-[#39c5bb] text-[#0a0a0c] font-bold uppercase tracking-wider flex items-center gap-2 hover:bg-[#2a9d95] transition-colors">
                <svg
                  className="w-5 h-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                Initialize Protocol
              </button>
              <Link href="/docs" className="px-6 py-3 bg-transparent border border-[#39c5bb] text-[#39c5bb] font-bold uppercase tracking-wider flex items-center gap-2 hover:bg-[#39c5bb]/10 transition-colors">
                <svg
                  className="w-5 h-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                Documentation
              </Link>
            </div>

            {/* Stats Row - industrial style */}
            <div
              className="grid grid-cols-3 gap-6 hero-animate"
              style={{
                animation: "fade-in 0.5s ease-out 0.8s forwards",
                opacity: 0,
              }}
            >
              {[
                { value: "0", label: "Data Leaks", color: "text-[#39c5bb]" },
                { value: "100%", label: "Anonymous", color: "text-[#ff2d7a]" },
                { value: "ZK", label: "Verified", color: "text-[#00ffe5]" },
              ].map((stat, index) => (
                <div key={index} className="text-left">
                  <div
                    className={`text-3xl sm:text-4xl font-bold ${stat.color}`}
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {stat.value}
                  </div>
                  <div className="text-xs text-[#555560] uppercase tracking-wider mt-1 font-mono">
                    {stat.label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right side - Phone Mockup */}
          <div className="order-1 lg:order-2 flex justify-center lg:justify-end">
            <PhoneMockup />
          </div>
        </div>
      </div>

      {/* Corner data streams - raw monospace */}
      <div className="absolute top-0 left-0 w-64 h-64 overflow-hidden pointer-events-none">
        <div
          className="absolute top-4 left-4 font-mono text-xs text-[#39c5bb]/30 whitespace-pre"
          style={{ animation: "pulse-opacity 3s ease-in-out infinite" }}
        >
          {`00110101 01010011
01000101 01000011
01010101 01010010
01000101 00100000`}
        </div>
      </div>

      <div className="absolute bottom-0 right-0 w-64 h-64 overflow-hidden pointer-events-none">
        <div
          className="absolute bottom-4 right-4 font-mono text-xs text-[#ff2d7a]/30 whitespace-pre text-right"
          style={{
            animation: "pulse-opacity 3s ease-in-out infinite",
            animationDelay: "1.5s",
          }}
        >
          {`PROTOCOL::01
STATUS::ACTIVE
LEAK::NONE
TRACE::NULL`}
        </div>
      </div>

      {/* Scroll indicator - sharp, industrial */}
      <div
        className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 hero-animate"
        style={{
          animation: "fade-in 0.5s ease-out 2s forwards",
          opacity: 0,
        }}
      >
        <div
          className="flex flex-col items-center gap-2"
          style={{ animation: "scroll-bounce 1.5s ease-in-out infinite" }}
        >
          <span className="text-xs text-[#555560] font-mono uppercase tracking-widest">
            Scroll
          </span>
          <div className="w-6 h-10 border-2 border-[#2a2a30] flex items-start justify-center p-2">
            <div
              className="w-1 h-2 bg-[#39c5bb]"
              style={{ animation: "scroll-dot 1.5s ease-in-out infinite" }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

export default memo(Hero);
