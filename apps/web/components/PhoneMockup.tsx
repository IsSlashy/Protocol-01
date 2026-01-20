"use client";

import { motion } from "framer-motion";

export default function PhoneMockup() {
  // Floating particles configuration
  const floatingParticles = [
    { symbol: '+', x: '-8%', y: '20%', color: 'rgba(57, 197, 187, 0.5)' },
    { symbol: '◇', x: '108%', y: '30%', color: 'rgba(255, 119, 168, 0.4)' },
    { symbol: '+', x: '-5%', y: '65%', color: 'rgba(57, 197, 187, 0.4)' },
    { symbol: '◇', x: '105%', y: '55%', color: 'rgba(255, 119, 168, 0.5)' },
    { symbol: '○', x: '15%', y: '-5%', color: 'rgba(57, 197, 187, 0.3)' },
    { symbol: '+', x: '85%', y: '105%', color: 'rgba(255, 119, 168, 0.4)' },
    { symbol: '◆', x: '-10%', y: '45%', color: 'rgba(0, 255, 229, 0.3)' },
    { symbol: '□', x: '110%', y: '75%', color: 'rgba(57, 197, 187, 0.3)' },
  ];

  return (
    <div className="relative w-[320px] h-[680px]">

      {/* === NEON GLOW EFFECTS (behind phone) === */}

      {/* Main cyan glow - bottom left */}
      <motion.div
        className="absolute -inset-20 -z-10"
        style={{
          background: 'radial-gradient(ellipse at 20% 80%, #39c5bb 0%, transparent 50%)',
          filter: 'blur(80px)',
        }}
        animate={{
          opacity: [0.4, 0.6, 0.4],
          scale: [1, 1.05, 1],
        }}
        transition={{
          duration: 4,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />

      {/* Pink glow - top right */}
      <motion.div
        className="absolute -inset-20 -z-10"
        style={{
          background: 'radial-gradient(ellipse at 85% 15%, #ff77a8 0%, transparent 50%)',
          filter: 'blur(80px)',
        }}
        animate={{
          opacity: [0.3, 0.5, 0.3],
          scale: [1, 1.08, 1],
        }}
        transition={{
          duration: 5,
          repeat: Infinity,
          ease: 'easeInOut',
          delay: 1,
        }}
      />

      {/* Bright cyan accent glow */}
      <motion.div
        className="absolute -inset-16 -z-10"
        style={{
          background: 'radial-gradient(ellipse at 50% 100%, #00ffe5 0%, transparent 40%)',
          filter: 'blur(60px)',
        }}
        animate={{
          opacity: [0.15, 0.25, 0.15],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: 'easeInOut',
          delay: 0.5,
        }}
      />

      {/* === LIGHT RAYS / STREAKS === */}
      <div className="absolute inset-0 -z-5 overflow-hidden pointer-events-none">
        {[...Array(8)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute"
            style={{
              left: `${8 + i * 12}%`,
              width: '2px',
              height: '180%',
              top: '-40%',
              background: `linear-gradient(to bottom,
                transparent 0%,
                ${i % 2 === 0 ? 'rgba(57, 197, 187, 0.5)' : 'rgba(255, 119, 168, 0.4)'} 50%,
                transparent 100%
              )`,
              filter: 'blur(1px)',
            }}
            animate={{
              opacity: [0.1, 0.4, 0.1],
              scaleY: [0.9, 1.1, 0.9],
            }}
            transition={{
              duration: 2.5 + i * 0.3,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: i * 0.2,
            }}
          />
        ))}
      </div>

      {/* === ANIMATED LIGHT BARS (vertical moving) === */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none -z-5">
        {/* Left bar */}
        <motion.div
          className="absolute left-[10%] w-[1px] h-[50%]"
          style={{
            background: 'linear-gradient(to bottom, transparent 0%, #39c5bb 50%, transparent 100%)',
            filter: 'blur(1px)',
          }}
          animate={{
            y: ['-100%', '300%'],
            opacity: [0, 0.6, 0],
          }}
          transition={{
            duration: 3,
            repeat: Infinity,
            ease: 'linear',
          }}
        />

        {/* Right bar */}
        <motion.div
          className="absolute right-[10%] w-[1px] h-[50%]"
          style={{
            background: 'linear-gradient(to bottom, transparent 0%, #ff77a8 50%, transparent 100%)',
            filter: 'blur(1px)',
          }}
          animate={{
            y: ['300%', '-100%'],
            opacity: [0, 0.5, 0],
          }}
          transition={{
            duration: 4,
            repeat: Infinity,
            ease: 'linear',
            delay: 1.5,
          }}
        />

        {/* Center bar */}
        <motion.div
          className="absolute left-[50%] w-[1px] h-[40%]"
          style={{
            background: 'linear-gradient(to bottom, transparent 0%, #00ffe5 50%, transparent 100%)',
            filter: 'blur(2px)',
          }}
          animate={{
            y: ['-50%', '250%'],
            opacity: [0, 0.3, 0],
          }}
          transition={{
            duration: 5,
            repeat: Infinity,
            ease: 'linear',
            delay: 2,
          }}
        />
      </div>

      {/* === FLOATING PARTICLES === */}
      {floatingParticles.map((p, i) => (
        <motion.span
          key={i}
          className="absolute text-xl font-light select-none pointer-events-none"
          style={{
            left: p.x,
            top: p.y,
            color: p.color,
            textShadow: `0 0 10px ${p.color}`,
          }}
          animate={{
            y: [0, -20, 0],
            x: [0, i % 2 === 0 ? 8 : -8, 0],
            opacity: [0.3, 0.7, 0.3],
            rotate: [0, i % 2 === 0 ? 15 : -15, 0],
          }}
          transition={{
            duration: 4 + i * 0.5,
            repeat: Infinity,
            delay: i * 0.3,
            ease: 'easeInOut',
          }}
        >
          {p.symbol}
        </motion.span>
      ))}

      {/* === PHONE WITH HOVER EFFECT === */}
      <motion.div
        className="relative z-10"
        initial={{ opacity: 0, y: 40, rotateY: -10 }}
        animate={{ opacity: 1, y: 0, rotateY: 0 }}
        transition={{ duration: 0.8, ease: 'easeOut', delay: 0.3 }}
        whileHover={{
          scale: 1.03,
          rotateY: 5,
          rotateX: -2,
          transition: { type: 'spring', stiffness: 200, damping: 15 }
        }}
        style={{ perspective: '1200px', transformStyle: 'preserve-3d' }}
      >
        {/* Phone frame */}
        <div
          className="relative w-[280px] h-[580px] bg-[#0a0a0c] rounded-[3rem] border-2 border-[#2a2a30] overflow-hidden mx-auto"
          style={{
            boxShadow: `
              0 25px 60px rgba(0, 0, 0, 0.7),
              0 0 40px rgba(57, 197, 187, 0.1),
              inset 0 1px 0 rgba(255, 255, 255, 0.05)
            `,
          }}
        >
          {/* Phone edge highlight - top */}
          <div className="absolute top-0 left-8 right-8 h-[1px] bg-gradient-to-r from-transparent via-white/20 to-transparent" />

          {/* Notch */}
          <div className="absolute top-3 left-1/2 -translate-x-1/2 w-24 h-6 bg-black rounded-full z-20">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-[#1a1a1a] border border-[#2a2a30]" />
          </div>

          {/* Screen content */}
          <div className="absolute inset-3 top-10 rounded-[2.5rem] overflow-hidden bg-[#0a0a0c]">
            {/* Status bar */}
            <div className="flex justify-between items-center px-6 py-2 text-xs text-[#888892] font-mono">
              <span>9:41</span>
              <div className="flex items-center gap-2">
                <div className="flex gap-0.5">
                  <div className="w-1 h-2 bg-[#39c5bb] rounded-sm" />
                  <div className="w-1 h-2 bg-[#39c5bb] rounded-sm" />
                  <div className="w-1 h-2 bg-[#39c5bb] rounded-sm" />
                  <div className="w-1 h-2 bg-[#39c5bb]/30 rounded-sm" />
                </div>
                <div className="w-5 h-2.5 border border-[#39c5bb]/50 rounded-sm relative">
                  <div className="absolute left-0.5 top-0.5 bottom-0.5 w-3 bg-[#39c5bb] rounded-sm" />
                </div>
              </div>
            </div>

            {/* App header */}
            <div className="px-5 py-3">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-[#151518] border border-[#39c5bb]/40 flex items-center justify-center">
                  <span className="text-[#ff77a8] font-bold text-sm">P-01</span>
                </div>
                <div>
                  <div className="text-white font-bold text-sm tracking-wide">PROTOCOL 01</div>
                  <div className="text-[#39c5bb] text-xs font-mono flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#39c5bb] animate-pulse" />
                    Connected
                  </div>
                </div>
              </div>
            </div>

            {/* Balance card */}
            <div className="mx-4 p-4 bg-gradient-to-br from-[#151518] to-[#0f0f12] rounded-2xl border border-[#2a2a30]">
              <div className="text-[#888892] text-xs font-mono tracking-wider mb-1">STEALTH BALANCE</div>
              <div className="text-3xl font-bold text-white mb-1">$12,847<span className="text-xl text-[#888892]">.00</span></div>
              <div className="text-[#39c5bb] text-sm font-mono flex items-center gap-1">
                <span className="text-[#00ffe5]">◆</span> 4.2847 SOL
              </div>
            </div>

            {/* Quick actions */}
            <div className="flex justify-center gap-4 py-5 px-4">
              {[
                { icon: '↑', label: 'Send', color: '#39c5bb' },
                { icon: '↓', label: 'Receive', color: '#39c5bb' },
                { icon: '⇄', label: 'Swap', color: '#39c5bb' },
                { icon: '◇', label: 'Buy', color: '#ff77a8' },
              ].map((action, i) => (
                <div key={i} className="flex flex-col items-center gap-1.5">
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center text-lg border transition-all"
                    style={{
                      backgroundColor: `${action.color}15`,
                      borderColor: `${action.color}40`,
                      color: action.color,
                    }}
                  >
                    {action.icon}
                  </div>
                  <span className="text-[#888892] text-xs font-mono">{action.label}</span>
                </div>
              ))}
            </div>

            {/* Recent activity */}
            <div className="px-4">
              <div className="text-[#888892] text-xs font-mono tracking-wider mb-2">RECENT ACTIVITY</div>
              <div className="space-y-2">
                {[
                  { type: 'stealth', label: 'Stealth TX', amount: '-0.5 SOL', time: '2m ago', color: '#ff77a8' },
                  { type: 'received', label: 'Received', amount: '+1.2 SOL', time: '1h ago', color: '#39c5bb' },
                ].map((tx, i) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-[#151518]/80 rounded-xl border border-[#2a2a30]/50">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-sm"
                        style={{
                          backgroundColor: `${tx.color}20`,
                          color: tx.color,
                        }}
                      >
                        {tx.type === 'stealth' ? '◈' : '◆'}
                      </div>
                      <div>
                        <div className="text-white text-sm font-medium">{tx.label}</div>
                        <div className="text-[#555560] text-xs">{tx.time}</div>
                      </div>
                    </div>
                    <div className="text-sm font-mono" style={{ color: tx.color }}>
                      {tx.amount}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom nav */}
            <div className="absolute bottom-3 left-3 right-3 flex justify-around py-2.5 bg-[#151518]/90 backdrop-blur-sm rounded-2xl border border-[#2a2a30]/50">
              {[
                { icon: '⌂', active: true },
                { icon: '◈', active: false },
                { icon: '💬', active: false },
                { icon: '⚙', active: false },
              ].map((item, i) => (
                <div
                  key={i}
                  className={`w-10 h-10 rounded-xl flex items-center justify-center text-base transition-all ${
                    item.active
                      ? 'text-[#39c5bb] bg-[#39c5bb]/15'
                      : 'text-[#555560]'
                  }`}
                >
                  {item.icon}
                </div>
              ))}
            </div>

            {/* Scanlines overlay */}
            <div
              className="absolute inset-0 pointer-events-none opacity-20"
              style={{
                background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.15) 2px, rgba(0,0,0,0.15) 4px)',
              }}
            />
          </div>

          {/* Glass reflection effect */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, transparent 40%, transparent 60%, rgba(255,255,255,0.02) 100%)',
            }}
          />

          {/* Phone edge glow */}
          <div className="absolute inset-0 rounded-[3rem] pointer-events-none" style={{
            boxShadow: 'inset 0 0 20px rgba(57, 197, 187, 0.05)',
          }} />
        </div>
      </motion.div>

      {/* === REFLECTION UNDER PHONE === */}
      <div
        className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-[70%] h-20 pointer-events-none"
        style={{
          background: 'linear-gradient(to bottom, rgba(57, 197, 187, 0.2), transparent)',
          filter: 'blur(20px)',
          transform: 'scaleY(0.3)',
          opacity: 0.4,
        }}
      />

      {/* Pink reflection accent */}
      <div
        className="absolute -bottom-6 left-[60%] w-[30%] h-12 pointer-events-none"
        style={{
          background: 'linear-gradient(to bottom, rgba(255, 119, 168, 0.15), transparent)',
          filter: 'blur(15px)',
          transform: 'scaleY(0.4)',
          opacity: 0.3,
        }}
      />

      {/* === CORNER ACCENTS === */}
      <motion.div
        className="absolute -top-3 -right-3 w-6 h-6 border-t-2 border-r-2 border-[#39c5bb]/60 pointer-events-none"
        animate={{ opacity: [0.4, 0.8, 0.4] }}
        transition={{ duration: 2, repeat: Infinity }}
      />
      <motion.div
        className="absolute -bottom-3 -left-3 w-6 h-6 border-b-2 border-l-2 border-[#ff77a8]/60 pointer-events-none"
        animate={{ opacity: [0.4, 0.8, 0.4] }}
        transition={{ duration: 2, repeat: Infinity, delay: 1 }}
      />
      <motion.div
        className="absolute -top-3 -left-3 w-4 h-4 border-t border-l border-[#00ffe5]/40 pointer-events-none"
        animate={{ opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 3, repeat: Infinity, delay: 0.5 }}
      />
      <motion.div
        className="absolute -bottom-3 -right-3 w-4 h-4 border-b border-r border-[#00ffe5]/40 pointer-events-none"
        animate={{ opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 3, repeat: Infinity, delay: 1.5 }}
      />

      {/* === DATA STREAM EFFECT (side) === */}
      <div className="absolute -right-16 top-1/4 font-mono text-[10px] text-[#39c5bb]/30 leading-tight pointer-events-none">
        <motion.div
          animate={{ opacity: [0.2, 0.5, 0.2] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          01100101<br/>
          11001010<br/>
          00110011<br/>
          10101010
        </motion.div>
      </div>

      <div className="absolute -left-14 bottom-1/4 font-mono text-[10px] text-[#ff77a8]/30 leading-tight pointer-events-none">
        <motion.div
          animate={{ opacity: [0.2, 0.5, 0.2] }}
          transition={{ duration: 2.5, repeat: Infinity, delay: 0.5 }}
        >
          P-01::TX<br/>
          STEALTH<br/>
          ACTIVE<br/>
          ██████
        </motion.div>
      </div>

    </div>
  );
}
