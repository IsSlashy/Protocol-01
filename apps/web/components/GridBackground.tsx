"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";

interface FloatingSymbol {
  id: number;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
}

export default function GridBackground() {
  const [symbols, setSymbols] = useState<FloatingSymbol[]>([]);

  useEffect(() => {
    // Generate floating + symbols
    const newSymbols: FloatingSymbol[] = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: 12 + Math.random() * 16,
      delay: Math.random() * 4,
      duration: 4 + Math.random() * 4,
    }));
    setSymbols(newSymbols);
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden">
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

      {/* Floating + symbols */}
      {symbols.map((symbol) => (
        <motion.div
          key={symbol.id}
          className="absolute text-p01-cyan/20 font-mono select-none"
          style={{
            left: `${symbol.x}%`,
            top: `${symbol.y}%`,
            fontSize: `${symbol.size}px`,
          }}
          animate={{
            y: [-10, 10, -10],
            opacity: [0.1, 0.3, 0.1],
            rotate: [0, 45, 0],
          }}
          transition={{
            duration: symbol.duration,
            delay: symbol.delay,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        >
          +
        </motion.div>
      ))}

      {/* Corner brackets decorations */}
      <div className="absolute top-8 left-8">
        <svg width="40" height="40" viewBox="0 0 40 40" className="text-p01-cyan/40">
          <path d="M0 40 L0 0 L40 0" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>
      <div className="absolute top-8 right-8">
        <svg width="40" height="40" viewBox="0 0 40 40" className="text-p01-cyan/40">
          <path d="M40 40 L40 0 L0 0" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>
      <div className="absolute bottom-8 left-8">
        <svg width="40" height="40" viewBox="0 0 40 40" className="text-p01-cyan/40">
          <path d="M0 0 L0 40 L40 40" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>
      <div className="absolute bottom-8 right-8">
        <svg width="40" height="40" viewBox="0 0 40 40" className="text-p01-cyan/40">
          <path d="M40 0 L40 40 L0 40" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>

      {/* Animated grid lines that pulse */}
      <motion.div
        className="absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(90deg, transparent 49.5%, rgba(57, 197, 187, 0.1) 50%, transparent 50.5%)
          `,
          backgroundSize: '300px 100%',
        }}
        animate={{
          backgroundPosition: ['0% 0%', '100% 0%'],
        }}
        transition={{
          duration: 20,
          repeat: Infinity,
          ease: "linear",
        }}
      />

      {/* Gradient overlays for depth */}
      <div className="absolute inset-0 bg-gradient-to-b from-p01-void via-transparent to-p01-void opacity-60" />
      <div className="absolute inset-0 bg-gradient-to-r from-p01-void via-transparent to-p01-void opacity-40" />

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
