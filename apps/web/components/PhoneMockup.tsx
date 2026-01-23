"use client";

import { memo } from "react";

/**
 * PhoneMockup - Optimized version
 *
 * Changes from original:
 * - Replaced framer-motion infinite animations with CSS animations
 * - GPU-accelerated transforms via will-change
 * - Reduced blur values slightly for performance
 * - Memoized component to prevent re-renders
 */
function PhoneMockup() {
  return (
    <div className="relative w-[340px] h-[700px]">
      {/* CSS Animations for glow effects */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes glow-pulse-cyan {
          0%, 100% { opacity: 0.6; transform: translate(-50%, 0) scale(1); }
          50% { opacity: 0.85; transform: translate(-50%, 0) scale(1.08); }
        }

        @keyframes glow-pulse-pink-right {
          0%, 100% { opacity: 0.5; transform: translateX(0); }
          50% { opacity: 0.7; transform: translateX(15px); }
        }

        @keyframes glow-pulse-pink-left {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 0.55; }
        }

        @keyframes glow-pulse-top {
          0%, 100% { opacity: 0.2; }
          50% { opacity: 0.35; }
        }

        @keyframes phone-enter {
          from { opacity: 0; transform: translateY(50px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .phone-container {
          animation: phone-enter 1s ease-out forwards;
        }

        .phone-container:hover {
          transform: scale(1.02) translateY(-5px);
        }

        @media (prefers-reduced-motion: reduce) {
          .glow-layer { animation: none !important; opacity: 0.6 !important; }
          .phone-container { animation: none !important; opacity: 1 !important; }
        }
      `}} />

      {/* === NEON GLOW BACKGROUND (diffuse, no borders) === */}

      {/* Main cyan glow - bottom center (like light reflecting up) */}
      <div
        className="absolute -bottom-40 left-1/2 w-[450px] h-[350px] -z-10 glow-layer"
        style={{
          background: 'radial-gradient(ellipse 70% 60% at center, rgba(57, 197, 187, 0.45) 0%, rgba(57, 197, 187, 0.15) 35%, transparent 65%)',
          filter: 'blur(50px)',
          animation: 'glow-pulse-cyan 4s ease-in-out infinite',
          willChange: 'opacity, transform',
        }}
      />

      {/* Pink/Magenta glow - right side */}
      <div
        className="absolute -right-24 top-[20%] w-[280px] h-[450px] -z-10 glow-layer"
        style={{
          background: 'radial-gradient(ellipse 60% 70% at center, rgba(255, 119, 168, 0.4) 0%, rgba(255, 119, 168, 0.1) 40%, transparent 65%)',
          filter: 'blur(70px)',
          animation: 'glow-pulse-pink-right 5s ease-in-out infinite',
          willChange: 'opacity, transform',
        }}
      />

      {/* Subtle pink glow - left side */}
      <div
        className="absolute -left-20 top-[30%] w-[220px] h-[320px] -z-10 glow-layer"
        style={{
          background: 'radial-gradient(ellipse at center, rgba(255, 119, 168, 0.25) 0%, transparent 55%)',
          filter: 'blur(55px)',
          animation: 'glow-pulse-pink-left 6s ease-in-out infinite 1s',
          willChange: 'opacity',
        }}
      />

      {/* Bright cyan accent - top */}
      <div
        className="absolute -top-20 left-1/2 -translate-x-1/2 w-[300px] h-[200px] -z-10 glow-layer"
        style={{
          background: 'radial-gradient(ellipse at center, rgba(0, 255, 229, 0.15) 0%, transparent 50%)',
          filter: 'blur(40px)',
          animation: 'glow-pulse-top 5s ease-in-out infinite 2s',
          willChange: 'opacity',
        }}
      />

      {/* === PHONE MOCKUP === */}
      <div
        className="relative z-10 phone-container transition-transform duration-300 ease-out"
      >
        {/* Phone frame - modern design, no ugly borders */}
        <div
          className="relative w-[280px] h-[600px] bg-[#0a0a0c] rounded-[50px] overflow-hidden mx-auto"
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
          <div className="absolute top-3 left-1/2 -translate-x-1/2 w-24 h-6 bg-black rounded-full z-20 flex items-center justify-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#1a1a1e] border border-[#2a2a30]" />
            <div className="w-12 h-3 rounded-full bg-[#1a1a1e]" />
          </div>

          {/* Screen content */}
          <div className="absolute inset-[3px] top-2 bg-[#0a0a0c] rounded-[47px] overflow-hidden">

            {/* Status bar */}
            <div className="pt-2 px-7 flex justify-between items-center text-white/70 text-[10px] font-medium">
              <span>9:41</span>
              <div className="flex items-center gap-1">
                <div className="flex gap-0.5">
                  {[1, 2, 3, 4].map((_, i) => (
                    <div key={i} className={`w-0.5 ${i < 3 ? 'bg-white/70' : 'bg-white/30'} rounded-sm`} style={{ height: `${3 + i * 1.5}px` }} />
                  ))}
                </div>
                <div className="w-5 h-2.5 border border-white/50 rounded-sm relative ml-1">
                  <div className="absolute inset-0.5 bg-[#39c5bb] rounded-sm" style={{ width: '70%' }} />
                </div>
              </div>
            </div>

            {/* App Header - FIDELE A L'APP */}
            <div className="pt-6 px-4 pb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[#ff77a8] font-bold text-xl">01</span>
                <div>
                  <p className="text-white font-bold text-sm tracking-wide">PROTOCOL 01</p>
                  <span className="px-1.5 py-0.5 bg-[#39c5bb]/20 text-[#39c5bb] text-[8px] rounded font-medium">
                    DEVNET
                  </span>
                </div>
              </div>
              <div className="flex gap-1.5">
                <div className="w-7 h-7 rounded-lg border border-[#2a2a30] flex items-center justify-center text-white/60 text-xs">
                  ⌇
                </div>
                <div className="w-7 h-7 rounded-lg border border-[#2a2a30] flex items-center justify-center text-white/60 text-xs">
                  ⚙
                </div>
              </div>
            </div>

            {/* Balance Card - FIDELE A L'APP */}
            <div className="mx-3 p-3 bg-[#151518] rounded-2xl border border-[#2a2a30]">
              <div className="flex items-center gap-1.5 text-[#808088] text-[10px] mb-2">
                <span>Wallet Address</span>
                <span className="text-[#808088] text-[8px]">📋</span>
              </div>

              <div className="text-center py-2">
                <p className="text-white text-3xl font-bold">$2,847.00</p>
                <p className="text-[#808088] mt-1 flex items-center justify-center gap-1.5 text-sm">
                  <span className="w-4 h-4 rounded-full bg-gradient-to-br from-[#9945FF] to-[#14F195] flex items-center justify-center text-[8px]">◎</span>
                  12.5 SOL
                </p>
              </div>
            </div>

            {/* Action Buttons - COULEURS CORRECTES */}
            <div className="flex justify-center gap-3 py-3 px-3">
              {[
                { icon: '↑', label: 'Send', bg: '#39c5bb', text: 'black' },
                { icon: '↓', label: 'Receive', bg: '#39c5bb', text: 'black' },
                { icon: '⇄', label: 'Swap', bg: '#6366f1', text: 'white' },
                { icon: '💳', label: 'Buy', bg: '#ec4899', text: 'white' },
              ].map((action, i) => (
                <div key={i} className="flex flex-col items-center gap-1">
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center text-base font-medium"
                    style={{
                      backgroundColor: action.bg,
                      color: action.text,
                    }}
                  >
                    {action.icon}
                  </div>
                  <span className="text-white text-[10px]">{action.label}</span>
                </div>
              ))}
            </div>

            {/* Faucet Card - NOUVEAU */}
            <div className="mx-3 p-3 rounded-xl flex items-center justify-between"
              style={{
                background: 'linear-gradient(135deg, #1a1a2e 0%, #2d1f3d 100%)',
              }}
            >
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-full flex items-center justify-center"
                  style={{
                    background: 'linear-gradient(135deg, #f97316 0%, #ec4899 100%)',
                  }}
                >
                  <span className="text-white text-sm">💧</span>
                </div>
                <div>
                  <p className="text-white font-medium text-xs">Get Test SOL</p>
                  <p className="text-[#808088] text-[8px]">Tap to receive 1 SOL from faucet</p>
                </div>
              </div>
              <span className="text-[#ff77a8] text-lg">›</span>
            </div>

            {/* Assets Section */}
            <div className="px-3 mt-3">
              <p className="text-[#808088] text-[9px] tracking-wider mb-1.5 font-medium">ASSETS</p>
              <div className="p-2.5 bg-[#151518] rounded-xl flex items-center justify-between border border-[#2a2a30]/50">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#9945FF] to-[#14F195] flex items-center justify-center">
                    <span className="text-white font-bold text-xs">◎</span>
                  </div>
                  <div>
                    <p className="text-white font-medium text-xs">Solana</p>
                    <p className="text-[#808088] text-[9px]">SOL</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-white font-medium text-xs">12.5</p>
                  <p className="text-[#808088] text-[9px]">$2,847.00</p>
                </div>
              </div>
            </div>

            {/* Recent Activity */}
            <div className="px-3 mt-3">
              <div className="flex justify-between items-center mb-1.5">
                <p className="text-[#808088] text-[9px] tracking-wider font-medium">RECENT ACTIVITY</p>
                <button className="text-[#39c5bb] text-[9px] font-medium">See All</button>
              </div>
              <div className="space-y-1.5">
                {[
                  { type: 'send', label: 'Send', amount: '-0.5 SOL', time: '2m ago', color: '#ff77a8' },
                  { type: 'receive', label: 'Received', amount: '+1.2 SOL', time: '1h ago', color: '#39c5bb' },
                ].map((tx, i) => (
                  <div key={i} className="flex justify-between items-center p-2.5 bg-[#151518] rounded-xl border border-[#2a2a30]/40">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center text-xs"
                        style={{
                          backgroundColor: `${tx.color}20`,
                          color: tx.color,
                        }}
                      >
                        {tx.type === 'send' ? '↑' : '↓'}
                      </div>
                      <div>
                        <p className="text-white text-[11px] font-medium">{tx.label}</p>
                        <p className="text-[#606068] text-[8px]">{tx.time}</p>
                      </div>
                    </div>
                    <span className="text-[11px] font-medium" style={{ color: tx.color }}>
                      {tx.amount}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom nav - 3 TABS SEULEMENT */}
            <div className="absolute bottom-4 left-3 right-3">
              <div className="flex justify-around items-center py-2 px-2 bg-[#151518]/95 rounded-2xl border border-[#2a2a30]/40 backdrop-blur-sm">
                {[
                  { icon: '💼', label: 'Wallet', active: true },
                  { icon: '💧', label: 'Streams', active: false },
                  { icon: '✨', label: 'Agent', active: false },
                ].map((item, i) => (
                  <div key={i} className="flex flex-col items-center gap-0.5">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all text-sm ${
                        item.active
                          ? 'bg-[#39c5bb]/20'
                          : ''
                      }`}
                    >
                      <span className={item.active ? 'text-[#39c5bb]' : 'text-[#606068]'}>
                        {item.icon}
                      </span>
                    </div>
                    <span className={`text-[8px] ${item.active ? 'text-[#39c5bb]' : 'text-[#606068]'}`}>
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Subtle scanlines */}
            <div
              className="absolute inset-0 pointer-events-none opacity-[0.02]"
              style={{
                background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 4px)',
              }}
            />
          </div>

          {/* Glass reflection on phone */}
          <div
            className="absolute inset-0 rounded-[50px] pointer-events-none"
            style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, transparent 40%)',
            }}
          />
        </div>
      </div>

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

export default memo(PhoneMockup);
