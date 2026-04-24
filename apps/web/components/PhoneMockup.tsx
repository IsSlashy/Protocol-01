"use client";

import { memo, useState } from "react";

/**
 * PhoneMockup — Interactive wallet UI preview.
 *
 * Mirrors the real Protocol 01 mobile app:
 * - Real 01-miku wordmark image header (not a styled "01" square)
 * - Real token logos (SOL gradient bars, USDC circle, Bonk)
 * - Privacy Summary Pill identical to the mobile PrivacySummaryPill
 * - 4-tab LiquidGlassTabBar (Wallet / Privacy / Streams / Agent), each
 *   tab button is a real button — clicking swaps the screen content.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Real token icons — SVG, matching the brand logos used in-app
// ─────────────────────────────────────────────────────────────────────────────

const SolLogo = ({ size = 36 }: { size?: number }) => (
  <div
    className="rounded-full flex items-center justify-center relative overflow-hidden"
    style={{ width: size, height: size, backgroundColor: "#0a0a0c" }}
  >
    <svg width={size * 0.64} height={size * 0.58} viewBox="0 0 504 400" fill="none">
      <defs>
        <linearGradient id="sol-a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#00FFA3" />
          <stop offset="100%" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <path fill="url(#sol-a)" d="M64.6 237.9l-48.5 52a12 12 0 00-2 12.9 12 12 0 0010 7h411a12 12 0 008.4-3.4l48.5-52c5.5-5.9 1.5-15.8-6.5-15.8H73a12 12 0 00-8.4 3.4z" />
      <path fill="url(#sol-a)" d="M64.6 6.4L16.1 58.4a12 12 0 00-2 12.9 12 12 0 0010 7h411a12 12 0 008.4-3.4l48.5-52c5.5-5.9 1.5-15.8-6.5-15.8H73a12 12 0 00-8.4 3.4z" />
      <path fill="url(#sol-a)" d="M439.4 121l-48.5-52a12 12 0 00-8.4-3.4h-411a12 12 0 00-10 7 12 12 0 002 12.9l48.5 52a12 12 0 008.4 3.4h411c8 0 12-9.9 6.5-15.8h1.5z" />
    </svg>
  </div>
);

const UsdcLogo = ({ size = 36 }: { size?: number }) => (
  <div
    className="rounded-full flex items-center justify-center"
    style={{ width: size, height: size, backgroundColor: "#2775CA" }}
  >
    <svg width={size * 0.65} height={size * 0.65} viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="16" fill="#2775CA" />
      <path d="M20.5 18.5c0-2.38-1.43-3.2-4.3-3.54-2.05-.27-2.46-.82-2.46-1.78 0-.96.69-1.58 2.06-1.58 1.23 0 1.92.41 2.26 1.37.07.21.27.34.48.34h1.1c.28 0 .5-.22.5-.5v-.04a3.5 3.5 0 00-3.16-2.85V8.5c0-.28-.22-.5-.55-.5h-1.03c-.28 0-.5.22-.5.55V9.9c-2.05.28-3.35 1.64-3.35 3.34 0 2.26 1.37 3.15 4.24 3.49 1.92.34 2.53.75 2.53 1.85 0 1.1-.96 1.85-2.26 1.85-1.78 0-2.4-.75-2.6-1.78-.07-.28-.28-.41-.48-.41h-1.17a.49.49 0 00-.5.48v.04c.27 1.71 1.37 2.94 3.62 3.28v1.44c0 .28.22.5.54.5h1.03c.28 0 .5-.22.5-.55v-1.44c2.05-.34 3.42-1.78 3.42-3.55z" fill="#FFFFFF" />
      <path d="M12.6 25.54a10.34 10.34 0 01-6.6-9.58c0-4.38 2.8-8.14 6.74-9.6.34-.15.48-.36.48-.76v-.96c0-.27-.14-.48-.48-.55-.07 0-.2 0-.27.07a12.42 12.42 0 000 23.56c.14.07.27.07.41.07.27-.07.41-.28.41-.55v-.96c0-.21-.2-.48-.7-.74zm6.86-21.35c-.14-.07-.28-.07-.42-.07-.27.07-.4.28-.4.55v.96c0 .28.2.48.54.69a10.34 10.34 0 016.6 9.58c0 4.38-2.8 8.14-6.73 9.6-.34.14-.48.36-.48.76v.96c0 .27.14.48.48.55.07 0 .2 0 .27-.07A12.42 12.42 0 0019.46 4.2z" fill="#FFFFFF" />
    </svg>
  </div>
);

const BonkLogo = ({ size = 36 }: { size?: number }) => (
  <div
    className="rounded-full flex items-center justify-center"
    style={{
      width: size,
      height: size,
      background: "linear-gradient(135deg, #F5A623 0%, #d97706 100%)",
    }}
  >
    <span className="text-white font-black" style={{ fontSize: size * 0.32 }}>
      B
    </span>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Tab views — one per bottom-tab
// ─────────────────────────────────────────────────────────────────────────────

const WalletView = () => (
  <>
    {/* Balance Card */}
    <div
      className="mx-4 p-4 rounded-2xl border border-[#2a2a30]/60"
      style={{ background: "linear-gradient(180deg, #131315 0%, #0c0c0e 100%)" }}
    >
      <div className="text-center">
        <span className="text-[#606068] text-[9px] tracking-[0.18em] font-mono uppercase">
          Total balance
        </span>
        <p className="text-white text-[28px] font-bold tracking-tight mt-1">
          $2,847
          <span className="text-white/50 text-lg">.63</span>
        </p>
        <div className="flex items-center justify-center gap-1.5 mt-1">
          <SolLogo size={16} />
          <span className="text-[#808088] text-[12px]">12.5000 SOL</span>
        </div>
      </div>
    </div>

    {/* Action Buttons */}
    <div className="flex justify-center gap-4 py-3 px-4">
      <ActionButton
        label="Send"
        labelColor="white/80"
        bg="linear-gradient(135deg, #39c5bb 0%, #00ffe5 100%)"
        iconStroke="#0a0a0c"
        path="M12 19V5M5 12l7-7 7 7"
      />
      <ActionButton
        label="Receive"
        labelColor="#39c5bb"
        bg="rgba(57,197,187,0.15)"
        iconStroke="#39c5bb"
        path="M12 5v14M5 12l7 7 7-7"
      />
      <ActionButton
        label="Swap"
        labelColor="#3b82f6"
        bg="rgba(59,130,246,0.15)"
        iconStroke="#3b82f6"
        path="M7 16V4m0 12l-3-3m3 3l3-3M17 8v12m0-12l3 3m-3-3l-3 3"
      />
    </div>

    {/* Privacy Summary Pill */}
    <div className="mx-4 mb-3">
      <div
        className="px-3.5 py-3 rounded-2xl flex items-center gap-3 border"
        style={{
          background: "rgba(12, 12, 14, 0.6)",
          borderColor: "rgba(57, 197, 187, 0.1)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div
          className="w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0"
          style={{ backgroundColor: "rgba(57, 197, 187, 0.08)" }}
        >
          <svg width="16" height="16" viewBox="0 0 512 512" fill="#39c5bb">
            <path d="M256 32c-28 0-96 32-160 48v80c0 112 64 208 160 320 96-112 160-208 160-320V80c-64-16-132-48-160-48zm0 48v338c-74-94-122-170-122-258V97c37-11 85-29 122-45z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-white/80 font-medium text-[10px] tracking-wide">
              Private balance
            </p>
            <span
              className="inline-flex items-center gap-0.5 px-1 py-[1px] rounded"
              style={{ backgroundColor: "rgba(245, 158, 11, 0.12)" }}
            >
              <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round">
                <circle cx="6" cy="6" r="2" />
                <circle cx="18" cy="6" r="2" />
                <circle cx="12" cy="18" r="2" />
                <path d="M6 6l12 12M18 6L12 18M6 6l6 12" />
              </svg>
              <span className="text-[6px] font-bold tracking-wider" style={{ color: "#f59e0b" }}>
                MPC
              </span>
            </span>
          </div>
          <p className="text-white text-[13px] font-bold mt-0.5">
            3.2000 <span className="text-white/50 text-[11px] font-semibold">SOL</span>
          </p>
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </div>
    </div>

    {/* Assets */}
    <div className="px-3 mb-2.5">
      <p className="text-[#606068] text-[8px] tracking-[0.12em] mb-2 font-semibold">ASSETS</p>

      <AssetRow icon={<SolLogo />} name="Solana" symbol="SOL" amount="12.5000" fiat="$2,847.63" />
      <AssetRow icon={<UsdcLogo />} name="USD Coin" symbol="USDC" amount="250.00" fiat="$250.00" />
      <AssetRow icon={<BonkLogo />} name="Bonk" symbol="BONK" amount="5.2M" fiat="$42.18" last />
    </div>

    {/* Recent Activity */}
    <div className="px-3 pb-20">
      <div className="flex justify-between items-center mb-2">
        <p className="text-[#606068] text-[8px] tracking-[0.12em] font-semibold">RECENT ACTIVITY</p>
        <span className="text-[#39c5bb] text-[8px] font-medium">See All</span>
      </div>
      <div className="space-y-1.5">
        <ActivityRow type="send" label="Sent SOL" to="to 7xM4...kR2p" amount="-0.5 SOL" time="2m ago" color="#ff77a8" />
        <ActivityRow type="receive" label="Received SOL" to="from Faucet" amount="+1.0 SOL" time="15m ago" color="#39c5bb" />
        <ActivityRow type="shield" label="Shield" to="ZK Pool" amount="-2.0 SOL" time="1h ago" color="#39c5bb" />
      </div>
    </div>
  </>
);

const PrivacyView = () => (
  <div className="px-4 pb-20">
    {/* Hero card — matches PrivacyDashboard's heroCard:
        icon chip top-left + "Shielded Balance" label, big balance
        underneath, status chips for mature/maturing notes. */}
    <div
      className="rounded-2xl p-4 mb-3"
      style={{
        background:
          "linear-gradient(180deg, rgba(57,197,187,0.11) 0%, rgba(57,197,187,0.02) 100%)",
        border: "1px solid rgba(57,197,187,0.18)",
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <div
          className="w-8 h-8 rounded-[10px] flex items-center justify-center"
          style={{ backgroundColor: "rgba(57,197,187,0.14)" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#39c5bb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        </div>
        <span className="text-[#a0a0a8] text-[10px] tracking-wide font-medium">
          Shielded balance
        </span>
      </div>

      <p className="text-white text-[30px] font-bold tracking-tight leading-none">
        3.2000 <span className="text-white/40 text-[16px] font-medium">SOL</span>
      </p>

      <div className="flex items-center gap-2 mt-3">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full" style={{ backgroundColor: "rgba(57,197,187,0.12)" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-[#39c5bb]" />
          <span className="text-[#39c5bb] text-[9px] font-semibold">2 ready</span>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full" style={{ backgroundColor: "rgba(255,204,0,0.1)" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-[#ffcc00]" />
          <span className="text-[#ffcc00] text-[9px] font-semibold">1 maturing</span>
        </div>
      </div>
    </div>

    {/* 2×2 action grid — mirrors ACTION_CONFIGS from the real
        PrivacyDashboard: Deposit / Withdraw / Send / Receive, each with
        its native accent color and Ionicons-style glyph. */}
    <div className="grid grid-cols-2 gap-2 mb-3">
      <PrivacyActionBtn label="Deposit" accent="#39c5bb" bg="rgba(57,197,187,0.14)">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v8M8 12l4 4 4-4" />
      </PrivacyActionBtn>
      <PrivacyActionBtn label="Withdraw" accent="#ff77a8" bg="rgba(255,119,168,0.14)">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16V8M8 12l4-4 4 4" />
      </PrivacyActionBtn>
      <PrivacyActionBtn label="Send" accent="#8B8BFF" bg="rgba(139,139,255,0.14)">
        <path d="M22 2L11 13" />
        <path d="M22 2l-7 20-4-9-9-4z" />
      </PrivacyActionBtn>
      <PrivacyActionBtn label="Receive" accent="#8B8BFF" bg="rgba(139,139,255,0.14)">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="M7 10l5 5 5-5M12 15V3" />
      </PrivacyActionBtn>
    </div>

    {/* Feature card — Private Send (Privacy Router), with NEW badge */}
    <button
      type="button"
      className="w-full mb-3 p-3 rounded-2xl flex items-center gap-3 bg-transparent border-none cursor-pointer"
      style={{
        background: "#131315",
        border: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <div className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0" style={{ backgroundColor: "rgba(57,197,187,0.12)" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#39c5bb" strokeWidth="2" strokeLinecap="round">
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4M8 6h8M8 18h8" />
        </svg>
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1.5">
          <p className="text-white font-semibold text-[11px]">Private Send</p>
          <span
            className="px-1 py-[1px] rounded text-[6px] font-bold tracking-wider"
            style={{ background: "linear-gradient(90deg, #39c5bb 0%, #00ffe5 100%)", color: "#0a0a0c" }}
          >
            NEW
          </span>
        </div>
        <p className="text-[#808088] text-[8.5px] mt-0.5">
          Route through multiple wallets with time delays
        </p>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#606068" strokeWidth="2" strokeLinecap="round">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>

    {/* Your notes — collapsible header + a few rows like the real app */}
    <div className="mb-2 flex items-center justify-between px-1">
      <p className="text-white text-[11px] font-semibold">Your notes</p>
      <div className="flex items-center gap-1.5">
        <span className="text-[#606068] text-[10px] font-semibold">3</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#606068" strokeWidth="2" strokeLinecap="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
    </div>
    <div className="space-y-1.5">
      <NoteRow amount="1.0000" status="mature" />
      <NoteRow amount="2.0000" status="mature" />
      <NoteRow amount="0.2000" status="maturing" />
    </div>
  </div>
);

const StreamsView = () => {
  const [section, setSection] = useState<"personal" | "services">("services");

  // Personal = peer-to-peer recurring payments the user set up themselves
  const personal = [
    { service: "Gym membership",  tag: "Recurring payment", amount: "0.02", period: "monthly", next: "in 7 days",  progress: 0.77, color: "#f59e0b", initial: "G", logo: "generic" as const },
    { service: "Rent (Anna)",     tag: "Recurring payment", amount: "1.20", period: "monthly", next: "in 3 days",  progress: 0.9,  color: "#8b5cf6", initial: "A", logo: "generic" as const },
  ];

  // Services = attested subscriptions from the on-chain service registry
  const services = [
    { service: "Netflix",         tag: "Entertainment",     amount: "0.10", period: "monthly", next: "in 4 days",  progress: 0.87, color: "#e50914", initial: "N", logo: "netflix" as const, verified: true },
    { service: "Spotify",         tag: "Music",             amount: "0.05", period: "monthly", next: "in 11 days", progress: 0.65, color: "#1db954", initial: "S", logo: "spotify" as const, verified: true },
    { service: "YouTube Premium", tag: "Entertainment",     amount: "0.08", period: "monthly", next: "in 18 days", progress: 0.4,  color: "#ff0000", initial: "Y", logo: "youtube" as const, verified: true },
  ];

  const list = section === "personal" ? personal : services;
  const totalMonthly = list.reduce((sum, s) => sum + parseFloat(s.amount), 0);
  const nextDays = Math.min(...list.map((s) => parseInt(s.next.match(/\d+/)?.[0] ?? "99", 10)));

  return (
    <div className="px-4 pb-20">
      {/* Header with title + action button */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-white font-semibold text-[14px]">Streams</p>
        <div className="flex items-center gap-1.5">
          <div className="w-7 h-7 rounded-full bg-[#151518] flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </div>
          <button type="button" className="w-7 h-7 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer" style={{ background: "linear-gradient(135deg, #39c5bb 0%, #00ffe5 100%)" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0a0a0c" strokeWidth="3" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>

      {/* Stats banner — live from the active section */}
      <div
        className="rounded-2xl p-3 mb-3 flex items-center justify-around"
        style={{ background: "#131315", border: "1px solid rgba(255,255,255,0.04)" }}
      >
        <div className="text-center flex-1">
          <p className="text-white text-[15px] font-bold">{list.length}</p>
          <p className="text-[#606068] text-[8px] tracking-wider uppercase mt-0.5">Active</p>
        </div>
        <div className="w-px h-6 bg-[#2a2a30]" />
        <div className="text-center flex-1">
          <p className="text-[#39c5bb] text-[15px] font-bold">{totalMonthly.toFixed(2)} <span className="text-[9px] text-[#39c5bb]/60 font-medium">SOL/mo</span></p>
          <p className="text-[#606068] text-[8px] tracking-wider uppercase mt-0.5">Total</p>
        </div>
        <div className="w-px h-6 bg-[#2a2a30]" />
        <div className="text-center flex-1">
          <p className="text-white text-[15px] font-bold">{nextDays}d</p>
          <p className="text-[#606068] text-[8px] tracking-wider uppercase mt-0.5">Next</p>
        </div>
      </div>

      {/* Segmented control — actually switches the content below */}
      <div
        className="rounded-[12px] p-[3px] mb-3 flex"
        style={{ background: "#131315", border: "1px solid rgba(255,255,255,0.04)" }}
      >
        {(["personal", "services"] as const).map((id) => {
          const active = section === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className="flex-1 py-1.5 rounded-[10px] text-[10px] font-semibold bg-transparent border-none cursor-pointer transition-colors"
              style={{
                color: active ? "#39c5bb" : "#606068",
                background: active ? "rgba(57,197,187,0.14)" : "transparent",
              }}
            >
              {id === "personal" ? "Personal" : "Services"}
            </button>
          );
        })}
      </div>

      {/* Subscription cards */}
      <div className="space-y-2">
        {list.map((s) => (
          <StreamCard key={s.service} {...s} />
        ))}
      </div>
    </div>
  );
};

const AgentView = () => (
  <div className="flex flex-col h-full px-4 pt-1 pb-16">
    <div className="flex items-center gap-2 mb-3">
      <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg, #39c5bb 0%, #00ffe5 100%)" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="#0a0a0c">
          <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" />
        </svg>
      </div>
      <div>
        <p className="text-white font-semibold text-[11px]">Privacy Agent</p>
        <p className="text-[#606068] text-[8px]">Claude · 4.7 · encrypted</p>
      </div>
    </div>

    <div className="flex-1 space-y-2 overflow-hidden">
      <AgentMsg from="user" text="Can I unshield 1 SOL without leaking timing?" />
      <AgentMsg
        from="agent"
        text="Yes. I'll route via p01_liquidity.prefund, split the output across 3 stealth recipients, and add 1-4s jitter. No chain observer can correlate the unshield with your main wallet."
      />
      <AgentMsg from="user" text="Go" />
      <AgentMsg from="agent" text="Started. Stealth signer funded (0.85 SOL rent). Proof upload: batch 2/7." loading />
    </div>

    <div
      className="mt-2 flex items-center gap-2 px-3 py-2 rounded-full"
      style={{ backgroundColor: "#151518", border: "1px solid rgba(57,197,187,0.12)" }}
    >
      <span className="text-[#606068] text-[10px] flex-1">Ask anything…</span>
      <div className="w-6 h-6 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg, #39c5bb 0%, #00ffe5 100%)" }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0a0a0c" strokeWidth="3" strokeLinecap="round">
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      </div>
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Small primitives used by the views above
// ─────────────────────────────────────────────────────────────────────────────

const ActionButton = ({ label, labelColor, bg, iconStroke, path }: {
  label: string; labelColor: string; bg: string; iconStroke: string; path: string;
}) => (
  <div className="flex flex-col items-center gap-1.5">
    <div
      className="w-[46px] h-[46px] rounded-full flex items-center justify-center"
      style={{ background: bg }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={iconStroke} strokeWidth="2.5" strokeLinecap="round">
        <path d={path} />
      </svg>
    </div>
    <span
      className="text-[10px] font-medium"
      style={labelColor.startsWith("#") ? { color: labelColor } : undefined}
    >
      <span className={labelColor.startsWith("#") ? "" : `text-${labelColor}`}>{label}</span>
    </span>
  </div>
);

const AssetRow = ({ icon, name, symbol, amount, fiat, last = false }: {
  icon: React.ReactNode; name: string; symbol: string; amount: string; fiat: string; last?: boolean;
}) => (
  <div
    className={`flex items-center justify-between p-2.5 bg-[#131315] rounded-xl border border-[#2a2a30]/40 ${last ? "" : "mb-1.5"}`}
  >
    <div className="flex items-center gap-2.5">
      {icon}
      <div>
        <p className="text-white font-semibold text-[11px]">{name}</p>
        <p className="text-[#606068] text-[9px]">{symbol}</p>
      </div>
    </div>
    <div className="text-right">
      <p className="text-white font-semibold text-[11px]">{amount}</p>
      <p className="text-[#606068] text-[9px]">{fiat}</p>
    </div>
  </div>
);

const ActivityRow = ({ type, label, to, amount, time, color }: {
  type: "send" | "receive" | "shield"; label: string; to: string; amount: string; time: string; color: string;
}) => (
  <div className="flex justify-between items-center p-2.5 bg-[#131315] rounded-xl border border-[#2a2a30]/30">
    <div className="flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: `${color}18` }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
          {type === "send" && <path d="M12 19V5M5 12l7-7 7 7" />}
          {type === "receive" && <path d="M12 5v14M5 12l7 7 7-7" />}
          {type === "shield" && <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />}
        </svg>
      </div>
      <div>
        <p className="text-white text-[10px] font-semibold">{label}</p>
        <p className="text-[#505058] text-[8px]">{to} · {time}</p>
      </div>
    </div>
    <span className="text-[10px] font-semibold" style={{ color }}>{amount}</span>
  </div>
);

const PrivacyActionBtn = ({ label, accent, bg, children }: {
  label: string; accent: string; bg: string; children: React.ReactNode;
}) => (
  <button
    type="button"
    className="py-4 rounded-2xl flex flex-col items-center justify-center gap-1.5 bg-transparent border-none cursor-pointer"
    style={{ background: bg }}
  >
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
    <span className="text-[10px] font-semibold" style={{ color: accent }}>{label}</span>
  </button>
);

const NoteRow = ({ amount, status }: { amount: string; status: "mature" | "maturing" }) => {
  const color = status === "mature" ? "#39c5bb" : "#ffcc00";
  const bg = status === "mature" ? "rgba(57,197,187,0.14)" : "rgba(255,204,0,0.1)";
  return (
    <div className="flex items-center gap-2.5 p-2.5 bg-[#131315] rounded-xl border border-[#2a2a30]/30">
      <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ backgroundColor: bg }}>
        {status === "mature" ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        )}
      </div>
      <div className="flex-1">
        <p className="text-white text-[11px] font-semibold">{amount} SOL</p>
        <p className="text-[#606068] text-[8.5px]">{status === "mature" ? "Ready to use" : "Maturing…"}</p>
      </div>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#606068" strokeWidth="2" strokeLinecap="round">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </div>
  );
};

// Cyberpunk-flavoured service glyphs. Each mark lives on a dark tile so
// the brand color reads as an accent (not a full bg fill), with a scanline
// overlay + chromatic aberration ghosts for the P01 aesthetic. We avoid
// lifting real trademarked logomarks — the shapes evoke each service
// without reproducing its official mark.
const ServiceGlyph = ({ logo, color, initial }: { logo: "netflix" | "spotify" | "youtube" | "generic"; color: string; initial: string }) => {
  return (
    <div
      className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 relative overflow-hidden"
      style={{
        background: `radial-gradient(circle at 30% 20%, ${color}30 0%, #0a0a0c 70%), #0a0a0c`,
        border: `1px solid ${color}55`,
        boxShadow: `0 0 10px ${color}35, inset 0 0 12px ${color}18`,
      }}
    >
      {/* Scanline overlay */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.35]"
        style={{
          background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.06) 2px, rgba(255,255,255,0.06) 3px)",
        }}
      />
      {/* Chromatic aberration ghost left (cyan) */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none mix-blend-screen" style={{ transform: "translateX(-1.2px)" }}>
        <GlyphMark logo={logo} color="rgba(57,197,187,0.6)" initial={initial} />
      </div>
      {/* Chromatic aberration ghost right (pink) */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none mix-blend-screen" style={{ transform: "translateX(1.2px)" }}>
        <GlyphMark logo={logo} color="rgba(255,45,122,0.6)" initial={initial} />
      </div>
      {/* Main glyph on brand color */}
      <div className="relative">
        <GlyphMark logo={logo} color={color} initial={initial} />
      </div>
    </div>
  );
};

const GlyphMark = ({ logo, color, initial }: { logo: "netflix" | "spotify" | "youtube" | "generic"; color: string; initial: string }) => {
  if (logo === "netflix") {
    // Two angled bars suggesting the N without copying the wordmark
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill={color}>
        <rect x="5" y="4" width="4" height="16" rx="0.5" />
        <rect x="15" y="4" width="4" height="16" rx="0.5" />
        <polygon points="9,4 15,20 15,14 9,-2" opacity="0" />
        <polygon points="9,4 15,4 15,20 13,20 9,8" />
      </svg>
    );
  }
  if (logo === "spotify") {
    // Three concentric arcs — the abstract "sound wave" motif
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
        <path d="M6 9c4-2 10-2 14 0" />
        <path d="M7 13c3.3-1.5 8-1.5 11.3 0" />
        <path d="M8 17c2.5-1 6.5-1 9 0" />
      </svg>
    );
  }
  if (logo === "youtube") {
    // Rounded rectangle with triangle play — universal play icon
    return (
      <svg width="22" height="18" viewBox="0 0 24 24" fill={color}>
        <path d="M3 7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7z" fillOpacity="0.35" />
        <polygon points="10,7.5 17,12 10,16.5" fill="#0a0a0c" />
      </svg>
    );
  }
  // Generic — styled bold letter with subtle drop
  return (
    <span
      className="font-black text-[14px] tracking-tight"
      style={{ color, fontFamily: "var(--font-display), ui-monospace, monospace" }}
    >
      {initial}
    </span>
  );
};

const StreamCard = ({ service, tag, amount, period, next, progress, color, initial, logo, verified = false }: {
  service: string;
  tag: string;
  amount: string;
  period: string;
  next: string;
  progress: number;
  color: string;
  initial: string;
  logo: "netflix" | "spotify" | "youtube" | "generic";
  verified?: boolean;
}) => (
  <div
    className="p-3 rounded-2xl relative overflow-hidden"
    style={{ background: "#131315", border: "1px solid rgba(255,255,255,0.04)" }}
  >
    <div className="flex items-center gap-2.5">
      <div className="relative shrink-0">
        <ServiceGlyph logo={logo} color={color} initial={initial} />
        {verified && (
          <div
            className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center"
            style={{ backgroundColor: "#39c5bb", border: "1.5px solid #131315" }}
          >
            <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="#0a0a0c" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l5 5 9-9" />
            </svg>
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-white text-[11.5px] font-semibold truncate">{service}</p>
        <p className="text-[#606068] text-[8.5px] mt-0.5">{tag} · {period}</p>
      </div>

      <div className="text-right shrink-0">
        <p className="text-white text-[11px] font-bold">{amount} <span className="text-[#606068] text-[8px] font-medium">SOL</span></p>
        <p className="text-[#606068] text-[8px] mt-0.5">{next}</p>
      </div>
    </div>

    {/* Progress bar — time elapsed in current period */}
    <div className="mt-2.5 h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.04)" }}>
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.round(progress * 100)}%`,
          background: `linear-gradient(90deg, ${color}80 0%, ${color} 100%)`,
        }}
      />
    </div>
  </div>
);

const AgentMsg = ({ from, text, loading = false }: { from: "user" | "agent"; text: string; loading?: boolean }) => (
  <div className={`flex ${from === "user" ? "justify-end" : "justify-start"}`}>
    <div
      className="px-3 py-2 rounded-2xl max-w-[85%]"
      style={{
        background: from === "user" ? "rgba(57,197,187,0.18)" : "#151518",
        border: from === "user" ? "1px solid rgba(57,197,187,0.25)" : "1px solid rgba(255,255,255,0.05)",
        borderBottomRightRadius: from === "user" ? 4 : 16,
        borderBottomLeftRadius: from === "agent" ? 4 : 16,
      }}
    >
      <p className="text-white/90 text-[9.5px] leading-snug">{text}</p>
      {loading && (
        <div className="flex gap-0.5 mt-1">
          <span className="w-1 h-1 rounded-full bg-[#39c5bb]" style={{ animation: "pulse-dot 1.2s ease-in-out infinite" }} />
          <span className="w-1 h-1 rounded-full bg-[#39c5bb]" style={{ animation: "pulse-dot 1.2s ease-in-out 0.2s infinite" }} />
          <span className="w-1 h-1 rounded-full bg-[#39c5bb]" style={{ animation: "pulse-dot 1.2s ease-in-out 0.4s infinite" }} />
        </div>
      )}
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// 4-tab bar — interactive
// ─────────────────────────────────────────────────────────────────────────────

type Tab = "wallet" | "privacy" | "streams" | "agent";

const TABS: { id: Tab; label: string; icon: (active: boolean) => React.ReactNode }[] = [
  {
    id: "wallet",
    label: "Wallet",
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? "#39c5bb" : "none"} stroke={active ? "none" : "#606068"} strokeWidth="2">
        <path d="M19 7h-1V6a3 3 0 0 0-3-3H5a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-8a3 3 0 0 0-3-3zm-3 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" />
      </svg>
    ),
  },
  {
    id: "privacy",
    label: "Privacy",
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? "#39c5bb" : "none"} stroke={active ? "none" : "#606068"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        {!active && <path d="M9 12l2 2 4-4" />}
      </svg>
    ),
  },
  {
    id: "streams",
    label: "Streams",
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? "#39c5bb" : "none"} stroke={active ? "none" : "#606068"} strokeWidth="2" strokeLinecap="round">
        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
      </svg>
    ),
  },
  {
    id: "agent",
    label: "Agent",
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? "#39c5bb" : "none"} stroke={active ? "none" : "#606068"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" />
        <path d="M18 14l.75 2.25L21 17l-2.25.75L18 20l-.75-2.25L15 17l2.25-.75z" />
      </svg>
    ),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Root mockup
// ─────────────────────────────────────────────────────────────────────────────

function PhoneMockup() {
  const [activeTab, setActiveTab] = useState<Tab>("wallet");
  const activeIndex = TABS.findIndex((t) => t.id === activeTab);

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
        @keyframes pulse-dot {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }
        @keyframes tab-fade-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .phone-container { animation: phone-enter 1s ease-out forwards; }
        .phone-container:hover { transform: scale(1.02) translateY(-5px); }
        .tab-content { animation: tab-fade-in 0.3s ease-out forwards; }
        @media (prefers-reduced-motion: reduce) {
          .glow-layer { animation: none !important; opacity: 0.6 !important; }
          .phone-container, .tab-content { animation: none !important; opacity: 1 !important; }
        }
      `,
        }}
      />

      {/* === NEON GLOW BACKGROUND === */}
      <div
        className="absolute -bottom-40 left-1/2 w-[450px] h-[350px] -z-10 glow-layer"
        style={{
          background: "radial-gradient(ellipse 70% 60% at center, rgba(57,197,187,0.45) 0%, rgba(57,197,187,0.15) 35%, transparent 65%)",
          filter: "blur(50px)",
          animation: "glow-pulse-cyan 4s ease-in-out infinite",
          willChange: "opacity, transform",
        }}
      />
      <div
        className="absolute -right-24 top-[20%] w-[280px] h-[450px] -z-10 glow-layer"
        style={{
          background: "radial-gradient(ellipse 60% 70% at center, rgba(255,119,168,0.4) 0%, rgba(255,119,168,0.1) 40%, transparent 65%)",
          filter: "blur(70px)",
          animation: "glow-pulse-pink-right 5s ease-in-out infinite",
          willChange: "opacity, transform",
        }}
      />
      <div
        className="absolute -left-20 top-[30%] w-[220px] h-[320px] -z-10 glow-layer"
        style={{
          background: "radial-gradient(ellipse at center, rgba(255,119,168,0.25) 0%, transparent 55%)",
          filter: "blur(55px)",
          animation: "glow-pulse-pink-left 6s ease-in-out infinite 1s",
          willChange: "opacity",
        }}
      />
      <div
        className="absolute -top-20 left-1/2 -translate-x-1/2 w-[300px] h-[200px] -z-10 glow-layer"
        style={{
          background: "radial-gradient(ellipse at center, rgba(0,255,229,0.15) 0%, transparent 50%)",
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
                  <div className="absolute inset-0.5 bg-[#39c5bb] rounded-sm" style={{ width: "70%" }} />
                </div>
              </div>
            </div>

            {/* App Header */}
            <div className="pt-5 px-5 pb-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                <img
                  src="/01-miku.png"
                  alt="Protocol 01"
                  className="h-7 w-auto object-contain"
                  style={{ filter: "drop-shadow(0 0 8px rgba(255,119,168,0.25))" }}
                />
                <div>
                  <p className="text-white font-bold text-[12px] tracking-[0.08em]">
                    PROTOCOL 01
                  </p>
                  <span className="inline-block mt-0.5 px-1.5 py-[1px] bg-[#ff77a8]/15 text-[#ff77a8] text-[7px] rounded font-bold tracking-wider">
                    DEVNET
                  </span>
                </div>
              </div>
              <div className="flex gap-1.5">
                <div className="w-9 h-9 rounded-full bg-[#151518] flex items-center justify-center">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2" />
                    <rect x="8" y="8" width="8" height="8" rx="1" />
                  </svg>
                </div>
                <div className="w-9 h-9 rounded-full bg-[#151518] flex items-center justify-center">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Scrollable tab content — re-keyed so the fade-in plays on switch */}
            <div key={activeTab} className="flex-1 overflow-hidden tab-content">
              {activeTab === "wallet" && <WalletView />}
              {activeTab === "privacy" && <PrivacyView />}
              {activeTab === "streams" && <StreamsView />}
              {activeTab === "agent" && <AgentView />}
            </div>

            {/* Glass Tab Bar — 4 interactive tabs */}
            <div className="absolute bottom-3 left-3 right-3">
              <div
                className="flex items-center py-1.5 rounded-[20px] relative overflow-hidden"
                style={{
                  background: "rgba(10,10,12,0.65)",
                  backdropFilter: "blur(20px)",
                  WebkitBackdropFilter: "blur(20px)",
                  border: "0.5px solid rgba(57,197,187,0.18)",
                  boxShadow: "0 8px 32px -8px rgba(0,0,0,0.6)",
                }}
              >
                <div
                  className="absolute top-0 left-0 right-0 h-[1px]"
                  style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)" }}
                />

                {/* Active pill — slides to the selected tab */}
                <div
                  className="absolute top-[5px] bottom-[5px] rounded-[14px] overflow-hidden transition-[left] duration-300 ease-out"
                  style={{
                    left: `calc(${(activeIndex * 100) / TABS.length}% + 4px)`,
                    width: `calc(${100 / TABS.length}% - 8px)`,
                    border: "1px solid rgba(57,197,187,0.25)",
                    boxShadow: "0 0 8px rgba(57,197,187,0.15)",
                  }}
                >
                  <div className="absolute inset-0" style={{ background: "rgba(57,197,187,0.12)" }} />
                </div>

                {TABS.map((tab) => {
                  const active = tab.id === activeTab;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className="flex flex-col items-center gap-[2px] py-1.5 z-10 cursor-pointer bg-transparent border-none"
                      style={{ width: `${100 / TABS.length}%` }}
                    >
                      {tab.icon(active)}
                      <span
                        className="text-[8px] font-medium transition-colors"
                        style={{ color: active ? "#39c5bb" : "#606068" }}
                      >
                        {tab.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Subtle scanlines */}
            <div
              className="absolute inset-0 pointer-events-none opacity-[0.015]"
              style={{
                background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 4px)",
              }}
            />
          </div>

          {/* Glass reflection */}
          <div
            className="absolute inset-0 rounded-[50px] pointer-events-none"
            style={{ background: "linear-gradient(135deg, rgba(255,255,255,0.06) 0%, transparent 40%)" }}
          />
        </div>
      </div>

      {/* Reflection under phone */}
      <div
        className="absolute -bottom-12 left-1/2 -translate-x-1/2 w-[220px] h-28 -z-10"
        style={{
          background: "radial-gradient(ellipse 80% 50% at center top, rgba(57,197,187,0.2) 0%, transparent 60%)",
          filter: "blur(15px)",
        }}
      />
    </div>
  );
}

export default memo(PhoneMockup);
