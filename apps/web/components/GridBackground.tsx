"use client";

import { memo } from "react";

/**
 * GridBackground - Optimized version
 *
 * Changes from original:
 * - Replaced 20 framer-motion symbols with 8 CSS-animated symbols
 * - Pre-defined symbol positions (no useEffect/useState)
 * - All animations use CSS keyframes (GPU-accelerated)
 * - Memoized to prevent re-renders
 */

// Pre-defined floating symbols - no state needed
const floatingSymbols = [
  { id: 1, x: "12%", y: "18%", size: 14, delay: "0s", duration: "6s" },
  { id: 2, x: "78%", y: "25%", size: 18, delay: "1s", duration: "7s" },
  { id: 3, x: "45%", y: "12%", size: 16, delay: "2s", duration: "5s" },
  { id: 4, x: "88%", y: "65%", size: 20, delay: "0.5s", duration: "8s" },
  { id: 5, x: "22%", y: "72%", size: 15, delay: "1.5s", duration: "6s" },
  { id: 6, x: "65%", y: "85%", size: 17, delay: "2.5s", duration: "7s" },
  { id: 7, x: "8%", y: "45%", size: 13, delay: "3s", duration: "5s" },
  { id: 8, x: "55%", y: "55%", size: 19, delay: "0.8s", duration: "8s" },
];

function GridBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* CSS Animations */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes float-symbol {
          0%, 100% {
            transform: translateY(-10px) rotate(0deg);
            opacity: 0.1;
          }
          50% {
            transform: translateY(10px) rotate(45deg);
            opacity: 0.3;
          }
        }

        @keyframes grid-scan {
          from { background-position: 0% 0%; }
          to { background-position: 100% 0%; }
        }

        @media (prefers-reduced-motion: reduce) {
          .float-symbol, .grid-scan { animation: none !important; }
        }
      `}} />

      {/* Main grid pattern - more visible */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(57, 197, 187, 0.08) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(57, 197, 187, 0.08) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
        }}
      />

      {/* Secondary finer grid */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(57, 197, 187, 0.03) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(57, 197, 187, 0.03) 1px, transparent 1px)
          `,
          backgroundSize: '20px 20px',
        }}
      />

      {/* Floating + symbols - CSS animated */}
      {floatingSymbols.map((symbol) => (
        <span
          key={symbol.id}
          className="absolute text-[#39c5bb]/20 font-mono select-none float-symbol"
          style={{
            left: symbol.x,
            top: symbol.y,
            fontSize: `${symbol.size}px`,
            animation: `float-symbol ${symbol.duration} ease-in-out infinite`,
            animationDelay: symbol.delay,
            willChange: "transform, opacity",
          }}
        >
          +
        </span>
      ))}

      {/* Corner brackets decorations */}
      <div className="absolute top-8 left-8">
        <svg width="40" height="40" viewBox="0 0 40 40" className="text-[#39c5bb]/40">
          <path d="M0 40 L0 0 L40 0" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>
      <div className="absolute top-8 right-8">
        <svg width="40" height="40" viewBox="0 0 40 40" className="text-[#39c5bb]/40">
          <path d="M40 40 L40 0 L0 0" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>
      <div className="absolute bottom-8 left-8">
        <svg width="40" height="40" viewBox="0 0 40 40" className="text-[#39c5bb]/40">
          <path d="M0 0 L0 40 L40 40" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>
      <div className="absolute bottom-8 right-8">
        <svg width="40" height="40" viewBox="0 0 40 40" className="text-[#39c5bb]/40">
          <path d="M40 0 L40 40 L0 40" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>

      {/* Animated grid lines that pulse - CSS animated */}
      <div
        className="absolute inset-0 grid-scan"
        style={{
          backgroundImage: `
            linear-gradient(90deg, transparent 49.5%, rgba(57, 197, 187, 0.1) 50%, transparent 50.5%)
          `,
          backgroundSize: '300px 100%',
          animation: 'grid-scan 20s linear infinite',
          willChange: 'background-position',
        }}
      />

      {/* Gradient overlays for depth */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#0a0a0c] via-transparent to-[#0a0a0c] opacity-60" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#0a0a0c] via-transparent to-[#0a0a0c] opacity-40" />

      {/* Vignette effect */}
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 0%, rgba(10, 10, 12, 0.8) 100%)',
        }}
      />
    </div>
  );
}

export default memo(GridBackground);
