"use client";

import { motion } from "framer-motion";
import { useEffect, useState, useMemo } from "react";

interface Particle {
  id: number;
  symbol: string;
  x: string;
  y: string;
  size: number;
  depth: number;
  drift: number;
}

interface MeshPoint {
  x: string;
  y: string;
  size: number;
}

interface MeshLine {
  from: number;
  to: number;
}

// Génération de particules avec profondeur variable
function generateParticles(): Particle[] {
  const symbols = ["+", "◇", "○", "×", "△"];
  const particles: Particle[] = [];

  // Layer lointain (petits, transparents, lents) - 15 particules
  for (let i = 0; i < 15; i++) {
    particles.push({
      id: i,
      symbol: symbols[Math.floor(Math.random() * symbols.length)],
      x: `${5 + Math.random() * 90}%`,
      y: `${5 + Math.random() * 90}%`,
      size: 6 + Math.random() * 4,
      depth: 0.03 + Math.random() * 0.04,
      drift: (Math.random() - 0.5) * 8,
    });
  }

  // Layer moyen - 10 particules
  for (let i = 15; i < 25; i++) {
    particles.push({
      id: i,
      symbol: symbols[Math.floor(Math.random() * symbols.length)],
      x: `${5 + Math.random() * 90}%`,
      y: `${5 + Math.random() * 90}%`,
      size: 10 + Math.random() * 6,
      depth: 0.08 + Math.random() * 0.05,
      drift: (Math.random() - 0.5) * 12,
    });
  }

  // Layer proche (gros, plus visibles, rapides) - 8 particules
  for (let i = 25; i < 33; i++) {
    particles.push({
      id: i,
      symbol: symbols[Math.floor(Math.random() * symbols.length)],
      x: `${5 + Math.random() * 90}%`,
      y: `${5 + Math.random() * 90}%`,
      size: 16 + Math.random() * 10,
      depth: 0.14 + Math.random() * 0.08,
      drift: (Math.random() - 0.5) * 16,
    });
  }

  return particles;
}

// Points du mesh network
const meshPoints: MeshPoint[] = [
  { x: "12%", y: "18%", size: 2.5 },
  { x: "35%", y: "8%", size: 2 },
  { x: "58%", y: "22%", size: 3 },
  { x: "82%", y: "12%", size: 2.5 },
  { x: "88%", y: "45%", size: 3.5 },
  { x: "72%", y: "68%", size: 2 },
  { x: "45%", y: "78%", size: 3 },
  { x: "18%", y: "62%", size: 2.5 },
  { x: "8%", y: "35%", size: 2 },
  { x: "50%", y: "45%", size: 4 },
  { x: "92%", y: "82%", size: 2 },
  { x: "25%", y: "88%", size: 2.5 },
];

// Connexions du mesh
const meshLines: MeshLine[] = [
  { from: 0, to: 1 },
  { from: 1, to: 2 },
  { from: 2, to: 3 },
  { from: 3, to: 4 },
  { from: 4, to: 5 },
  { from: 5, to: 6 },
  { from: 6, to: 7 },
  { from: 7, to: 8 },
  { from: 8, to: 0 },
  { from: 0, to: 9 },
  { from: 2, to: 9 },
  { from: 5, to: 9 },
  { from: 7, to: 9 },
  { from: 4, to: 10 },
  { from: 5, to: 10 },
  { from: 6, to: 11 },
  { from: 7, to: 11 },
  { from: 1, to: 9 },
  { from: 6, to: 9 },
];

export default function DepthBackground() {
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    setParticles(generateParticles());
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
      {/* LAYER 1 - Base gradient avec hints de couleur */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 80% 50% at 25% 0%, rgba(57, 197, 187, 0.06) 0%, transparent 50%),
            radial-gradient(ellipse 60% 40% at 75% 100%, rgba(255, 119, 168, 0.04) 0%, transparent 50%),
            radial-gradient(ellipse 100% 100% at 50% 50%, rgba(57, 197, 187, 0.02) 0%, transparent 70%),
            #0a0a0c
          `,
        }}
      />

      {/* LAYER 2 - Perspective grid ULTRAKILL style */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Grille horizontale avec perspective */}
        <div
          className="absolute w-[300%] h-[150%] left-[-100%] top-[35%]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(57, 197, 187, 0.05) 1px, transparent 1px),
              linear-gradient(90deg, rgba(57, 197, 187, 0.03) 1px, transparent 1px)
            `,
            backgroundSize: "100px 100px",
            transform: "perspective(500px) rotateX(70deg)",
            transformOrigin: "center top",
            maskImage:
              "linear-gradient(to bottom, transparent 0%, black 15%, black 60%, transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent 0%, black 15%, black 60%, transparent 100%)",
          }}
        />

        {/* Lignes de fuite additionnelles */}
        <div
          className="absolute w-full h-full"
          style={{
            background: `
              linear-gradient(180deg,
                transparent 0%,
                transparent 50%,
                rgba(57, 197, 187, 0.02) 50.5%,
                transparent 51%,
                transparent 100%
              )
            `,
          }}
        />
      </div>

      {/* LAYER 3 - Mesh network SVG */}
      <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
        <defs>
          {/* Gradient pour les lignes */}
          <linearGradient
            id="mesh-gradient-cyan-pink"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#39c5bb" />
            <stop offset="100%" stopColor="#ff77a8" />
          </linearGradient>

          {/* Gradient inversé */}
          <linearGradient
            id="mesh-gradient-pink-cyan"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#ff77a8" />
            <stop offset="100%" stopColor="#39c5bb" />
          </linearGradient>

          {/* Glow filter pour les points */}
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Lignes de connexion */}
        {meshLines.map((line, i) => (
          <motion.line
            key={`line-${i}`}
            x1={meshPoints[line.from].x}
            y1={meshPoints[line.from].y}
            x2={meshPoints[line.to].x}
            y2={meshPoints[line.to].y}
            stroke={
              i % 2 === 0
                ? "url(#mesh-gradient-cyan-pink)"
                : "url(#mesh-gradient-pink-cyan)"
            }
            strokeWidth="1"
            initial={{ opacity: 0.02, pathLength: 0.8 }}
            animate={{
              opacity: [0.02, 0.06, 0.02],
              pathLength: [0.8, 1, 0.8],
            }}
            transition={{
              duration: 5 + (i % 4),
              delay: i * 0.2,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        ))}

        {/* Points du mesh avec glow */}
        {meshPoints.map((point, i) => (
          <motion.circle
            key={`point-${i}`}
            cx={point.x}
            cy={point.y}
            r={point.size}
            fill={i % 3 === 0 ? "#39c5bb" : i % 3 === 1 ? "#ff77a8" : "#39c5bb"}
            filter="url(#glow)"
            initial={{ opacity: 0.08 }}
            animate={{
              opacity: [0.08, 0.25, 0.08],
              r: [point.size, point.size * 1.3, point.size],
            }}
            transition={{
              duration: 3 + (i % 3),
              delay: i * 0.15,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        ))}
      </svg>

      {/* LAYER 4 - Particules flottantes avec profondeur */}
      {particles.map((p) => (
        <motion.span
          key={p.id}
          className="absolute font-light select-none pointer-events-none"
          style={{
            left: p.x,
            top: p.y,
            fontSize: p.size,
            color: p.depth > 0.12 ? "#ff77a8" : "#39c5bb",
            textShadow:
              p.depth > 0.15
                ? `0 0 ${p.size / 2}px ${p.depth > 0.12 ? "rgba(255, 119, 168, 0.5)" : "rgba(57, 197, 187, 0.5)"}`
                : "none",
          }}
          initial={{ opacity: p.depth }}
          animate={{
            y: [0, -40 * p.depth, 0],
            x: [0, p.drift, 0],
            opacity: [p.depth, p.depth * 1.8, p.depth],
            rotate: [0, p.drift > 0 ? 10 : -10, 0],
          }}
          transition={{
            duration: 8 / (p.depth + 0.1),
            repeat: Infinity,
            ease: "easeInOut",
            delay: p.id * 0.1,
          }}
        >
          {p.symbol}
        </motion.span>
      ))}

      {/* LAYER 5 - Scanlines animées (CRT effect) */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `repeating-linear-gradient(
            0deg,
            transparent 0px,
            transparent 3px,
            rgba(57, 197, 187, 0.008) 3px,
            rgba(57, 197, 187, 0.008) 4px
          )`,
        }}
        animate={{ y: [0, 16] }}
        transition={{
          duration: 12,
          repeat: Infinity,
          ease: "linear",
        }}
      />

      {/* Scanline pulse horizontal occasionnel */}
      <motion.div
        className="absolute left-0 right-0 h-[2px] pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(57, 197, 187, 0.15), transparent)",
        }}
        initial={{ top: "-2px", opacity: 0 }}
        animate={{
          top: ["0%", "100%"],
          opacity: [0, 0.5, 0.5, 0],
        }}
        transition={{
          duration: 8,
          repeat: Infinity,
          ease: "linear",
          repeatDelay: 4,
        }}
      />

      {/* LAYER 6 - Vignette profonde */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `
            radial-gradient(ellipse 120% 80% at 50% 50%, transparent 30%, rgba(10, 10, 12, 0.4) 70%, rgba(10, 10, 12, 0.7) 100%)
          `,
        }}
      />

      {/* Vignette corners accentuée */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `
            radial-gradient(ellipse at 0% 0%, rgba(10, 10, 12, 0.5) 0%, transparent 50%),
            radial-gradient(ellipse at 100% 0%, rgba(10, 10, 12, 0.5) 0%, transparent 50%),
            radial-gradient(ellipse at 0% 100%, rgba(10, 10, 12, 0.5) 0%, transparent 50%),
            radial-gradient(ellipse at 100% 100%, rgba(10, 10, 12, 0.5) 0%, transparent 50%)
          `,
        }}
      />

      {/* LAYER 7 - Noise texture subtile */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.025] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* Holographic shimmer occasionnel (Kangel Y2K) */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `linear-gradient(
            135deg,
            transparent 40%,
            rgba(57, 197, 187, 0.03) 45%,
            rgba(255, 119, 168, 0.03) 50%,
            rgba(57, 197, 187, 0.03) 55%,
            transparent 60%
          )`,
          backgroundSize: "200% 200%",
        }}
        animate={{
          backgroundPosition: ["-100% -100%", "200% 200%"],
        }}
        transition={{
          duration: 15,
          repeat: Infinity,
          ease: "linear",
        }}
      />
    </div>
  );
}
