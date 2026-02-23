"use client";

import { memo } from "react";

/**
 * PhoneMockup — Premium wallet UI preview
 *
 * Faithful recreation of the real P-01 mobile app with:
 * - Proper gradient action buttons (Send=cyan gradient, Receive=cyan dim, Swap=blue dim)
 * - Shielded Wallet card with ZK badge
 * - Solana gradient token icon
 * - Glass tab bar matching LiquidGlassTabBar
 * - SVG icons instead of emoji
 * - Proper P-01 design system colors
 */
function PhoneMockup() {
  return (
    <div className="relative w-[340px] h-[700px]">
      {/* CSS Animations */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
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
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
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
      `,
        }}
      />

      {/* === NEON GLOW BACKGROUND === */}
      <div
        className="absolute -bottom-40 left-1/2 w-[450px] h-[350px] -z-10 glow-layer"
        style={{
          background:
            "radial-gradient(ellipse 70% 60% at center, rgba(57,197,187,0.45) 0%, rgba(57,197,187,0.15) 35%, transparent 65%)",
          filter: "blur(50px)",
          animation: "glow-pulse-cyan 4s ease-in-out infinite",
          willChange: "opacity, transform",
        }}
      />
      <div
        className="absolute -right-24 top-[20%] w-[280px] h-[450px] -z-10 glow-layer"
        style={{
          background:
            "radial-gradient(ellipse 60% 70% at center, rgba(255,119,168,0.4) 0%, rgba(255,119,168,0.1) 40%, transparent 65%)",
          filter: "blur(70px)",
          animation: "glow-pulse-pink-right 5s ease-in-out infinite",
          willChange: "opacity, transform",
        }}
      />
      <div
        className="absolute -left-20 top-[30%] w-[220px] h-[320px] -z-10 glow-layer"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(255,119,168,0.25) 0%, transparent 55%)",
          filter: "blur(55px)",
          animation: "glow-pulse-pink-left 6s ease-in-out infinite 1s",
          willChange: "opacity",
        }}
      />
      <div
        className="absolute -top-20 left-1/2 -translate-x-1/2 w-[300px] h-[200px] -z-10 glow-layer"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(0,255,229,0.15) 0%, transparent 50%)",
          filter: "blur(40px)",
          animation: "glow-pulse-top 5s ease-in-out infinite 2s",
          willChange: "opacity",
        }}
      />

      {/* === PHONE === */}
      <div className="relative z-10 phone-container transition-transform duration-300 ease-out">
        <div
          className="relative w-[280px] h-[600px] bg-[#0a0a0c] rounded-[50px] overflow-hidden mx-auto"
          style={{
            boxShadow: `
              0 0 0 1px rgba(255,255,255,0.08),
              0 30px 60px -15px rgba(0,0,0,0.85),
              0 0 80px -10px rgba(57,197,187,0.25),
              0 0 120px -20px rgba(255,119,168,0.15)
            `,
          }}
        >
          {/* Dynamic Island */}
          <div className="absolute top-3 left-1/2 -translate-x-1/2 w-24 h-6 bg-black rounded-full z-20 flex items-center justify-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#1a1a1e] border border-[#2a2a30]" />
            <div className="w-12 h-3 rounded-full bg-[#1a1a1e]" />
          </div>

          {/* Screen */}
          <div className="absolute inset-[3px] top-2 bg-[#0a0a0c] rounded-[47px] overflow-hidden flex flex-col">
            {/* Status bar */}
            <div className="pt-2 px-7 flex justify-between items-center text-white/70 text-[10px] font-medium shrink-0">
              <span>9:41</span>
              <div className="flex items-center gap-1">
                <div className="flex gap-0.5">
                  {[1, 2, 3, 4].map((_, i) => (
                    <div
                      key={i}
                      className={`w-0.5 ${i < 3 ? "bg-white/70" : "bg-white/30"} rounded-sm`}
                      style={{ height: `${3 + i * 1.5}px` }}
                    />
                  ))}
                </div>
                <div className="w-5 h-2.5 border border-white/50 rounded-sm relative ml-1">
                  <div
                    className="absolute inset-0.5 bg-[#39c5bb] rounded-sm"
                    style={{ width: "70%" }}
                  />
                </div>
              </div>
            </div>

            {/* App Header */}
            <div className="pt-5 px-4 pb-2 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                {/* P-01 Logo */}
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#ff77a8] to-[#ff4488] flex items-center justify-center">
                  <span className="text-white font-black text-[11px]">01</span>
                </div>
                <div>
                  <p className="text-white font-bold text-[13px] tracking-wider">
                    PROTOCOL 01
                  </p>
                  <span className="inline-block mt-0.5 px-1.5 py-[1px] bg-[#ff77a8]/15 text-[#ff77a8] text-[7px] rounded font-bold tracking-wider">
                    DEVNET
                  </span>
                </div>
              </div>
              <div className="flex gap-1.5">
                <div className="w-8 h-8 rounded-xl bg-[#151518] border border-[#2a2a30]/60 flex items-center justify-center">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M4 7h16M4 12h16M4 17h16" />
                  </svg>
                </div>
                <div className="w-8 h-8 rounded-xl bg-[#151518] border border-[#2a2a30]/60 flex items-center justify-center">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-hidden">
              {/* Balance Card */}
              <div className="mx-3 p-3.5 rounded-2xl border border-[#2a2a30]/60"
                style={{ background: "linear-gradient(180deg, #131315 0%, #0c0c0e 100%)" }}
              >
                <div className="flex items-center gap-1.5 mb-2.5">
                  <span className="text-[#606068] text-[10px]">Wallet Address</span>
                  <span className="text-[#606068] text-[10px] ml-1 px-1.5 py-0.5 bg-[#1a1a1e] rounded text-[8px] font-mono">
                    8xK3...m4Fq
                  </span>
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#606068"
                    strokeWidth="2"
                    className="ml-0.5"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </div>

                <div className="text-center py-1.5">
                  <p className="text-white text-[28px] font-bold tracking-tight">
                    $2,847
                    <span className="text-white/50 text-lg">.63</span>
                  </p>
                  <div className="flex items-center justify-center gap-1.5 mt-1">
                    <div className="w-4 h-4 rounded-full bg-gradient-to-br from-[#9945FF] to-[#14F195] flex items-center justify-center">
                      <span className="text-white text-[6px] font-bold">◎</span>
                    </div>
                    <span className="text-[#808088] text-[13px]">12.5000 SOL</span>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-center gap-4 py-3 px-4">
                {/* Send — gradient cyan */}
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    className="w-[46px] h-[46px] rounded-full flex items-center justify-center"
                    style={{
                      background:
                        "linear-gradient(135deg, #39c5bb 0%, #00ffe5 100%)",
                    }}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#0a0a0c"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    >
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </div>
                  <span className="text-white/80 text-[10px] font-medium">
                    Send
                  </span>
                </div>

                {/* Receive — dim cyan */}
                <div className="flex flex-col items-center gap-1.5">
                  <div className="w-[46px] h-[46px] rounded-full flex items-center justify-center bg-[#39c5bb]/15">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#39c5bb"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    >
                      <path d="M12 5v14M5 12l7 7 7-7" />
                    </svg>
                  </div>
                  <span className="text-[#39c5bb] text-[10px] font-medium">
                    Receive
                  </span>
                </div>

                {/* Swap — dim blue */}
                <div className="flex flex-col items-center gap-1.5">
                  <div className="w-[46px] h-[46px] rounded-full flex items-center justify-center bg-[#3b82f6]/15">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#3b82f6"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    >
                      <path d="M7 16V4m0 12l-3-3m3 3l3-3M17 8v12m0-12l3 3m-3-3l-3 3" />
                    </svg>
                  </div>
                  <span className="text-[#3b82f6] text-[10px] font-medium">
                    Swap
                  </span>
                </div>
              </div>

              {/* Shielded Wallet Card */}
              <div className="mx-3 mb-2.5">
                <div
                  className="p-3 rounded-xl flex items-center gap-2.5"
                  style={{
                    background:
                      "linear-gradient(90deg, rgba(57,197,187,0.12) 0%, rgba(57,197,187,0.04) 100%)",
                    border: "1px solid rgba(57,197,187,0.15)",
                  }}
                >
                  <div className="w-9 h-9 rounded-full bg-[#39c5bb]/15 flex items-center justify-center shrink-0">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#39c5bb"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      <path d="M9 12l2 2 4-4" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold text-[11px]">
                      Shielded Wallet
                    </p>
                    <p className="text-[#808088] text-[8px]">
                      0.0000 SOL shielded
                    </p>
                  </div>
                  <span className="px-1.5 py-0.5 bg-[#39c5bb]/20 text-[#39c5bb] text-[7px] font-bold rounded tracking-wider">
                    ZK
                  </span>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#39c5bb"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
              </div>

              {/* Assets */}
              <div className="px-3 mb-2.5">
                <p className="text-[#606068] text-[8px] tracking-[0.12em] mb-2 font-semibold">
                  ASSETS
                </p>

                {/* SOL */}
                <div className="flex items-center justify-between p-2.5 bg-[#131315] rounded-xl border border-[#2a2a30]/40 mb-1.5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#9945FF] to-[#14F195] flex items-center justify-center">
                      <span className="text-white font-bold text-[10px]">
                        ◎
                      </span>
                    </div>
                    <div>
                      <p className="text-white font-semibold text-[11px]">
                        Solana
                      </p>
                      <p className="text-[#606068] text-[9px]">SOL</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-white font-semibold text-[11px]">
                      12.5000
                    </p>
                    <p className="text-[#606068] text-[9px]">$2,847.63</p>
                  </div>
                </div>

                {/* USDC */}
                <div className="flex items-center justify-between p-2.5 bg-[#131315] rounded-xl border border-[#2a2a30]/40 mb-1.5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-full bg-[#2775CA] flex items-center justify-center">
                      <span className="text-white font-bold text-[10px]">
                        $
                      </span>
                    </div>
                    <div>
                      <p className="text-white font-semibold text-[11px]">
                        USD Coin
                      </p>
                      <p className="text-[#606068] text-[9px]">USDC</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-white font-semibold text-[11px]">
                      250.00
                    </p>
                    <p className="text-[#606068] text-[9px]">$250.00</p>
                  </div>
                </div>

                {/* BONK */}
                <div className="flex items-center justify-between p-2.5 bg-[#131315] rounded-xl border border-[#2a2a30]/40">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-full bg-[#F5A623] flex items-center justify-center">
                      <span className="text-[10px]">🐕</span>
                    </div>
                    <div>
                      <p className="text-white font-semibold text-[11px]">
                        Bonk
                      </p>
                      <p className="text-[#606068] text-[9px]">BONK</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-white font-semibold text-[11px]">
                      5.2M
                    </p>
                    <p className="text-[#606068] text-[9px]">$42.18</p>
                  </div>
                </div>
              </div>

              {/* Recent Activity */}
              <div className="px-3 pb-20">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[#606068] text-[8px] tracking-[0.12em] font-semibold">
                    RECENT ACTIVITY
                  </p>
                  <span className="text-[#39c5bb] text-[8px] font-medium">
                    See All
                  </span>
                </div>
                <div className="space-y-1.5">
                  {[
                    {
                      type: "send",
                      label: "Sent SOL",
                      to: "to 7xM4...kR2p",
                      amount: "-0.5 SOL",
                      time: "2m ago",
                      color: "#ff77a8",
                    },
                    {
                      type: "receive",
                      label: "Received SOL",
                      to: "from Faucet",
                      amount: "+1.0 SOL",
                      time: "15m ago",
                      color: "#39c5bb",
                    },
                    {
                      type: "shield",
                      label: "Shield",
                      to: "ZK Pool",
                      amount: "-2.0 SOL",
                      time: "1h ago",
                      color: "#39c5bb",
                    },
                  ].map((tx, i) => (
                    <div
                      key={i}
                      className="flex justify-between items-center p-2.5 bg-[#131315] rounded-xl border border-[#2a2a30]/30"
                    >
                      <div className="flex items-center gap-2.5">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center"
                          style={{
                            backgroundColor: `${tx.color}18`,
                          }}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke={tx.color}
                            strokeWidth="2.5"
                            strokeLinecap="round"
                          >
                            {tx.type === "send" && (
                              <path d="M12 19V5M5 12l7-7 7 7" />
                            )}
                            {tx.type === "receive" && (
                              <path d="M12 5v14M5 12l7 7 7-7" />
                            )}
                            {tx.type === "shield" && (
                              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                            )}
                          </svg>
                        </div>
                        <div>
                          <p className="text-white text-[10px] font-semibold">
                            {tx.label}
                          </p>
                          <p className="text-[#505058] text-[8px]">
                            {tx.to} · {tx.time}
                          </p>
                        </div>
                      </div>
                      <span
                        className="text-[10px] font-semibold"
                        style={{ color: tx.color }}
                      >
                        {tx.amount}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Glass Tab Bar */}
            <div className="absolute bottom-3 left-3 right-3">
              <div
                className="flex justify-around items-center py-1.5 rounded-[20px] relative overflow-hidden"
                style={{
                  background: "rgba(10,10,12,0.65)",
                  backdropFilter: "blur(20px)",
                  WebkitBackdropFilter: "blur(20px)",
                  border: "0.5px solid rgba(57,197,187,0.18)",
                  boxShadow: "0 8px 32px -8px rgba(0,0,0,0.6)",
                }}
              >
                {/* Top highlight */}
                <div
                  className="absolute top-0 left-0 right-0 h-[1px]"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)",
                  }}
                />

                {/* Active pill indicator (behind Wallet tab) */}
                <div
                  className="absolute left-[6px] top-[5px] bottom-[5px] rounded-[14px] overflow-hidden"
                  style={{
                    width: "calc(33.33% - 8px)",
                    border: "1px solid rgba(57,197,187,0.25)",
                    boxShadow: "0 0 8px rgba(57,197,187,0.15)",
                  }}
                >
                  <div
                    className="absolute inset-0"
                    style={{
                      background: "rgba(57,197,187,0.12)",
                    }}
                  />
                </div>

                {[
                  {
                    label: "Wallet",
                    active: true,
                    icon: (
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="#39c5bb"
                        stroke="none"
                      >
                        <path d="M19 7h-1V6a3 3 0 0 0-3-3H5a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-8a3 3 0 0 0-3-3zm-3 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" />
                      </svg>
                    ),
                  },
                  {
                    label: "Streams",
                    active: false,
                    icon: (
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#606068"
                        strokeWidth="2"
                        strokeLinecap="round"
                      >
                        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
                      </svg>
                    ),
                  },
                  {
                    label: "Agent",
                    active: false,
                    icon: (
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#606068"
                        strokeWidth="2"
                        strokeLinecap="round"
                      >
                        <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" />
                        <path d="M18 14l.75 2.25L21 17l-2.25.75L18 20l-.75-2.25L15 17l2.25-.75z" />
                      </svg>
                    ),
                  },
                ].map((item, i) => (
                  <div
                    key={i}
                    className="flex flex-col items-center gap-[2px] py-1.5 z-10"
                    style={{ width: "33.33%" }}
                  >
                    {item.icon}
                    <span
                      className="text-[8px] font-medium"
                      style={{
                        color: item.active ? "#39c5bb" : "#606068",
                      }}
                    >
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Subtle scanlines */}
            <div
              className="absolute inset-0 pointer-events-none opacity-[0.015]"
              style={{
                background:
                  "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 4px)",
              }}
            />
          </div>

          {/* Glass reflection */}
          <div
            className="absolute inset-0 rounded-[50px] pointer-events-none"
            style={{
              background:
                "linear-gradient(135deg, rgba(255,255,255,0.06) 0%, transparent 40%)",
            }}
          />
        </div>
      </div>

      {/* Reflection under phone */}
      <div
        className="absolute -bottom-12 left-1/2 -translate-x-1/2 w-[220px] h-28 -z-10"
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at center top, rgba(57,197,187,0.2) 0%, transparent 60%)",
          filter: "blur(15px)",
        }}
      />
    </div>
  );
}

export default memo(PhoneMockup);
