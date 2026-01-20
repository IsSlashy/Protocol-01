"use client";

import { motion } from "framer-motion";

export default function PhoneMockup() {
  return (
    <div className="relative w-[340px] h-[700px]">

      {/* === NEON GLOW BACKGROUND (diffuse, no borders) === */}

      {/* Main cyan glow - bottom center (like light reflecting up) */}
      <motion.div
        className="absolute -bottom-40 left-1/2 -translate-x-1/2 w-[450px] h-[350px] -z-10"
        style={{
          background: 'radial-gradient(ellipse 70% 60% at center, rgba(57, 197, 187, 0.45) 0%, rgba(57, 197, 187, 0.15) 35%, transparent 65%)',
          filter: 'blur(50px)',
        }}
        animate={{
          opacity: [0.6, 0.85, 0.6],
          scale: [1, 1.08, 1],
        }}
        transition={{
          duration: 4,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />

      {/* Pink/Magenta glow - right side */}
      <motion.div
        className="absolute -right-24 top-[20%] w-[280px] h-[450px] -z-10"
        style={{
          background: 'radial-gradient(ellipse 60% 70% at center, rgba(255, 119, 168, 0.4) 0%, rgba(255, 119, 168, 0.1) 40%, transparent 65%)',
          filter: 'blur(70px)',
        }}
        animate={{
          opacity: [0.5, 0.7, 0.5],
          x: [0, 15, 0],
        }}
        transition={{
          duration: 5,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />

      {/* Subtle pink glow - left side */}
      <motion.div
        className="absolute -left-20 top-[30%] w-[220px] h-[320px] -z-10"
        style={{
          background: 'radial-gradient(ellipse at center, rgba(255, 119, 168, 0.25) 0%, transparent 55%)',
          filter: 'blur(55px)',
        }}
        animate={{
          opacity: [0.35, 0.55, 0.35],
        }}
        transition={{
          duration: 6,
          repeat: Infinity,
          ease: 'easeInOut',
          delay: 1,
        }}
      />

      {/* Bright cyan accent - top */}
      <motion.div
        className="absolute -top-20 left-1/2 -translate-x-1/2 w-[300px] h-[200px] -z-10"
        style={{
          background: 'radial-gradient(ellipse at center, rgba(0, 255, 229, 0.15) 0%, transparent 50%)',
          filter: 'blur(40px)',
        }}
        animate={{
          opacity: [0.2, 0.35, 0.2],
        }}
        transition={{
          duration: 5,
          repeat: Infinity,
          ease: 'easeInOut',
          delay: 2,
        }}
      />

      {/* === PHONE MOCKUP === */}
      <motion.div
        className="relative z-10"
        initial={{ opacity: 0, y: 50 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1, ease: 'easeOut' }}
        whileHover={{
          scale: 1.02,
          y: -5,
          transition: { type: 'spring', stiffness: 300, damping: 20 }
        }}
      >
        {/* Phone frame - modern design, no ugly borders */}
        <div
          className="relative w-[280px] h-[580px] bg-[#0a0a0c] rounded-[50px] overflow-hidden mx-auto"
          style={{
            boxShadow: `
              0 0 0 1px rgba(255, 255, 255, 0.08),
              0 30px 60px -15px rgba(0, 0, 0, 0.85),
              0 0 80px -10px rgba(57, 197, 187, 0.25),
              0 0 120px -20px rgba(255, 119, 168, 0.15)
            `,
          }}
        >

          {/* Dynamic Island / Notch */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 w-28 h-7 bg-black rounded-full z-20 flex items-center justify-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-[#1a1a1e] border border-[#2a2a30]" />
            <div className="w-14 h-3.5 rounded-full bg-[#1a1a1e]" />
          </div>

          {/* Screen content */}
          <div className="absolute inset-[3px] top-2 bg-[#0a0a0c] rounded-[47px] overflow-hidden">

            {/* Status bar */}
            <div className="pt-2 px-8 flex justify-between items-center text-white/70 text-xs font-medium">
              <span>9:41</span>
              <div className="flex items-center gap-1.5">
                <div className="flex gap-0.5">
                  {[1, 2, 3, 4].map((_, i) => (
                    <div key={i} className={`w-1 h-${i + 1} ${i < 3 ? 'bg-white/70' : 'bg-white/30'} rounded-sm`} style={{ height: `${4 + i * 2}px` }} />
                  ))}
                </div>
                <div className="w-6 h-3 border border-white/50 rounded-sm relative ml-1">
                  <div className="absolute inset-0.5 bg-[#39c5bb] rounded-sm" style={{ width: '70%' }} />
                </div>
              </div>
            </div>

            {/* App Header */}
            <div className="pt-8 px-5 pb-4 flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-[#151518] border border-[#39c5bb]/30 flex items-center justify-center">
                <span className="text-[#ff77a8] font-bold text-sm">P-01</span>
              </div>
              <div>
                <p className="text-white font-semibold text-lg tracking-wide">PROTOCOL 01</p>
                <p className="text-[#39c5bb] text-sm flex items-center gap-1.5">
                  <motion.span
                    className="w-2 h-2 rounded-full bg-[#39c5bb]"
                    animate={{ opacity: [1, 0.4, 1] }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                  />
                  Connected
                </p>
              </div>
            </div>

            {/* Balance card */}
            <div className="mx-5 p-5 bg-gradient-to-br from-[#151518] to-[#101014] rounded-2xl border border-[#2a2a30]/60">
              <p className="text-[#707078] text-xs tracking-[0.2em] mb-2 font-medium">STEALTH BALANCE</p>
              <p className="text-white text-4xl font-bold tracking-tight">
                $12,847<span className="text-2xl text-[#707078]">.00</span>
              </p>
              <p className="text-[#39c5bb] text-sm mt-2 flex items-center gap-1.5 font-medium">
                <span className="text-[#00ffe5]">◆</span>
                4.2847 SOL
              </p>
            </div>

            {/* Action buttons */}
            <div className="flex justify-center gap-4 py-5 px-5">
              {[
                { icon: '↑', label: 'Send', color: '#39c5bb' },
                { icon: '↓', label: 'Receive', color: '#39c5bb' },
                { icon: '⇄', label: 'Swap', color: '#39c5bb' },
                { icon: '◇', label: 'Buy', color: '#ff77a8' },
              ].map((action, i) => (
                <div key={i} className="flex flex-col items-center gap-1.5">
                  <div
                    className="w-13 h-13 rounded-2xl flex items-center justify-center text-lg border transition-all"
                    style={{
                      width: '52px',
                      height: '52px',
                      backgroundColor: `${action.color}12`,
                      borderColor: `${action.color}35`,
                      color: action.color,
                    }}
                  >
                    {action.icon}
                  </div>
                  <span className="text-[#707078] text-xs">{action.label}</span>
                </div>
              ))}
            </div>

            {/* Recent Activity */}
            <div className="px-5">
              <p className="text-[#707078] text-xs tracking-[0.15em] mb-3 font-medium">RECENT ACTIVITY</p>
              <div className="space-y-2">
                {[
                  { type: 'stealth', label: 'Stealth TX', amount: '-0.5 SOL', time: '2m ago', color: '#ff77a8' },
                  { type: 'received', label: 'Received', amount: '+1.2 SOL', time: '1h ago', color: '#39c5bb' },
                ].map((tx, i) => (
                  <div key={i} className="flex justify-between items-center p-3.5 bg-[#151518]/90 rounded-xl border border-[#2a2a30]/40">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-9 h-9 rounded-xl flex items-center justify-center text-sm"
                        style={{
                          backgroundColor: `${tx.color}18`,
                          color: tx.color,
                        }}
                      >
                        ◆
                      </div>
                      <div>
                        <p className="text-white text-sm font-medium">{tx.label}</p>
                        <p className="text-[#606068] text-xs">{tx.time}</p>
                      </div>
                    </div>
                    <span className="text-sm font-medium" style={{ color: tx.color }}>
                      {tx.amount}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom nav */}
            <div className="absolute bottom-5 left-5 right-5">
              <div className="flex justify-around items-center py-2.5 px-3 bg-[#151518]/95 rounded-2xl border border-[#2a2a30]/40 backdrop-blur-sm">
                {[
                  { icon: '⌂', active: true },
                  { icon: '◈', active: false },
                  { icon: '💬', active: false },
                  { icon: '⚙', active: false },
                ].map((item, i) => (
                  <div
                    key={i}
                    className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all ${
                      item.active
                        ? 'text-[#39c5bb] bg-[#39c5bb]/15'
                        : 'text-[#606068]'
                    }`}
                  >
                    {item.icon}
                  </div>
                ))}
              </div>
            </div>

            {/* Subtle scanlines */}
            <div
              className="absolute inset-0 pointer-events-none opacity-[0.03]"
              style={{
                background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 4px)',
              }}
            />
          </div>

          {/* Glass reflection on phone */}
          <div
            className="absolute inset-0 rounded-[50px] pointer-events-none"
            style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 40%)',
            }}
          />
        </div>
      </motion.div>

      {/* === REFLECTION UNDER PHONE (subtle glow) === */}
      <div
        className="absolute -bottom-12 left-1/2 -translate-x-1/2 w-[220px] h-28 -z-10"
        style={{
          background: 'radial-gradient(ellipse 80% 50% at center top, rgba(57, 197, 187, 0.2) 0%, transparent 60%)',
          filter: 'blur(15px)',
        }}
      />

    </div>
  );
}
