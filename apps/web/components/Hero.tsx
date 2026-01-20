"use client";

import { motion } from "framer-motion";
import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import GlitchLogo01 from "./GlitchLogo01";
import PhoneMockup from "./PhoneMockup";

// Terminal-style status text with its own glitch rhythm
function SystemStatus() {
  const [textGlitch, setTextGlitch] = useState({
    offsetX: 0,
    skew: 0,
    showCyan: false,
    showPink: false,
    cyanX: 0,
    pinkX: 0,
  });

  const performTextGlitch = useCallback(() => {
    const intensity = Math.random();
    if (intensity > 0.5) {
      setTextGlitch({
        offsetX: (Math.random() - 0.5) * 8,
        skew: (Math.random() - 0.5) * 4,
        showCyan: true,
        showPink: true,
        cyanX: -3 - Math.random() * 4,
        pinkX: 3 + Math.random() * 4,
      });

      setTimeout(() => {
        setTextGlitch({
          offsetX: 0,
          skew: 0,
          showCyan: false,
          showPink: false,
          cyanX: 0,
          pinkX: 0,
        });
      }, 80 + Math.random() * 120);
    }
  }, []);

  useEffect(() => {
    // Text glitch: slower rhythm 800-1500ms (ULTRAKILL style)
    let timerId: NodeJS.Timeout;

    const scheduleTextGlitch = () => {
      const delay = 800 + Math.random() * 700; // Slower than logo
      timerId = setTimeout(() => {
        performTextGlitch();
        scheduleTextGlitch();
      }, delay);
    };

    scheduleTextGlitch();
    return () => clearTimeout(timerId);
  }, [performTextGlitch]);

  return (
    <div className="mt-6 flex flex-col items-start">
      {/* System status label */}
      <span
        className="text-[#ff2d7a] text-xs font-bold tracking-[6px] mb-3 font-mono"
        style={{ letterSpacing: "0.4em" }}
      >
        [ SYSTEM STATUS ]
      </span>

      {/* UNTRACEABLE - with chromatic glitch */}
      <div className="relative h-[60px] flex items-center">
        {/* Cyan ghost layer */}
        {textGlitch.showCyan && (
          <span
            className="absolute text-[#39c5bb] text-4xl sm:text-5xl font-black tracking-wider opacity-70"
            style={{
              transform: `translateX(${textGlitch.cyanX}px)`,
              fontFamily: "var(--font-display)",
            }}
          >
            UNTRACEABLE
          </span>
        )}

        {/* Pink ghost layer */}
        {textGlitch.showPink && (
          <span
            className="absolute text-[#ff2d7a] text-4xl sm:text-5xl font-black tracking-wider opacity-70"
            style={{
              transform: `translateX(${textGlitch.pinkX}px)`,
              fontFamily: "var(--font-display)",
            }}
          >
            UNTRACEABLE
          </span>
        )}

        {/* Main text */}
        <span
          className="text-white text-4xl sm:text-5xl font-black tracking-wider"
          style={{
            transform: `translateX(${textGlitch.offsetX}px) skewX(${textGlitch.skew}deg)`,
            fontFamily: "var(--font-display)",
            transition: "transform 0.05s ease-out",
          }}
        >
          UNTRACEABLE
        </span>
      </div>

      {/* Status indicator - industrial style */}
      <div className="flex items-center mt-4">
        <div className="w-2 h-2 bg-[#39c5bb] mr-3" />
        <span
          className="text-[#555560] text-xs tracking-[4px] font-mono uppercase"
          style={{ letterSpacing: "0.3em" }}
        >
          READY
        </span>
      </div>
    </div>
  );
}

// Corruption noise effect - raw, not soft
function CorruptionNoise() {
  const [noiseOpacity, setNoiseOpacity] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      if (Math.random() > 0.8) {
        setNoiseOpacity(0.15 + Math.random() * 0.1);
        setTimeout(() => setNoiseOpacity(0), 80);
      }
    }, 150);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="absolute inset-0 pointer-events-none z-20"
      style={{
        opacity: noiseOpacity,
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        mixBlendMode: "overlay",
      }}
    />
  );
}

export default function Hero() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <section className="relative min-h-screen flex items-center overflow-hidden">
      {/* Corruption noise overlay */}
      <CorruptionNoise />

      {/* Miku background - semi-transparent, centered between 01 and phone */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[5] overflow-hidden">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.2, delay: 0.3 }}
          className="relative w-[500px] h-[500px] lg:w-[700px] lg:h-[700px]"
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
        </motion.div>
      </div>

      {/* Main content - Asymmetric layout */}
      <div className="relative z-10 w-full max-w-7xl mx-auto px-6 lg:px-12 py-20">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-8 items-center">
          {/* Left side - Text content */}
          <div className="order-2 lg:order-1">
            {/* Protocol badge - sharp, no rounded-full, no soft glow */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.5 }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#151518] border border-[#39c5bb]/40 mb-6"
            >
              <span className="w-2 h-2 bg-[#39c5bb]" />
              <span className="text-sm text-[#39c5bb] font-mono uppercase tracking-wider">
                Protocol Active
              </span>
            </motion.div>

            {/* Massive 01 - Using PNG image with ULTRAKILL glitch */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.8, delay: 0.2 }}
              className="mb-2"
            >
              <GlitchLogo01 />
            </motion.div>

            {/* Terminal-style system status */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.4 }}
            >
              {mounted && <SystemStatus />}
            </motion.div>

            {/* Description - industrial monospace */}
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="text-[#888892] text-base max-w-lg mt-8 mb-8 font-mono leading-relaxed"
            >
              Anonymous Solana wallet with stealth addresses for private
              transactions. Stream payments, encrypted messaging, and
              zero-knowledge proofs.{" "}
              <span className="text-[#39c5bb]">Complete financial privacy.</span>
            </motion.p>

            {/* CTA Buttons - sharp edges, no soft shadows */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.6 }}
              className="flex flex-wrap gap-4 mb-12"
            >
              <a
                href="#download"
                className="px-6 py-3 bg-[#39c5bb] text-[#0a0a0c] font-bold uppercase tracking-wider flex items-center gap-2 hover:bg-[#2a9d95] transition-colors"
              >
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
              </a>
              <a
                href="#features"
                className="px-6 py-3 bg-transparent border border-[#39c5bb] text-[#39c5bb] font-bold uppercase tracking-wider flex items-center gap-2 hover:bg-[#39c5bb]/10 transition-colors"
              >
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
              </a>
            </motion.div>

            {/* Stats Row - industrial style */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.8 }}
              className="grid grid-cols-3 gap-6"
            >
              {[
                { value: "100%", label: "Private", color: "text-[#39c5bb]" },
                { value: "ZK", label: "Proofs", color: "text-[#ff2d7a]" },
                { value: "No", label: "KYC", color: "text-[#00ffe5]" },
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
            </motion.div>
          </div>

          {/* Right side - Phone Mockup */}
          <div className="order-1 lg:order-2 flex justify-center lg:justify-end">
            <PhoneMockup />
          </div>
        </div>
      </div>

      {/* Corner data streams - raw monospace */}
      <div className="absolute top-0 left-0 w-64 h-64 overflow-hidden pointer-events-none">
        <motion.div
          className="absolute top-4 left-4 font-mono text-xs text-[#39c5bb]/30 whitespace-pre"
          animate={{ opacity: [0.2, 0.4, 0.2] }}
          transition={{ duration: 3, repeat: Infinity }}
        >
          {`00110101 01010011
01000101 01000011
01010101 01010010
01000101 00100000`}
        </motion.div>
      </div>

      <div className="absolute bottom-0 right-0 w-64 h-64 overflow-hidden pointer-events-none">
        <motion.div
          className="absolute bottom-4 right-4 font-mono text-xs text-[#ff2d7a]/30 whitespace-pre text-right"
          animate={{ opacity: [0.2, 0.4, 0.2] }}
          transition={{ duration: 3, repeat: Infinity, delay: 1.5 }}
        >
          {`PROTOCOL::01
STATUS::ACTIVE
LEAK::NONE
TRACE::NULL`}
        </motion.div>
      </div>

      {/* Scroll indicator - sharp, industrial */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 2 }}
        className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20"
      >
        <motion.div
          animate={{ y: [0, 10, 0] }}
          transition={{ duration: 1.5, repeat: Infinity }}
          className="flex flex-col items-center gap-2"
        >
          <span className="text-xs text-[#555560] font-mono uppercase tracking-widest">
            Scroll
          </span>
          <div className="w-6 h-10 border-2 border-[#2a2a30] flex items-start justify-center p-2">
            <motion.div
              animate={{ y: [0, 8, 0] }}
              transition={{ duration: 1.5, repeat: Infinity }}
              className="w-1 h-2 bg-[#39c5bb]"
            />
          </div>
        </motion.div>
      </motion.div>
    </section>
  );
}
