"use client";

import { motion } from "framer-motion";

export default function PhoneMockup() {
  return (
    <motion.div
      className="relative"
      initial={{ opacity: 0, x: 50, rotateY: -15 }}
      animate={{ opacity: 1, x: 0, rotateY: 0 }}
      transition={{ duration: 0.8, delay: 0.4 }}
      style={{ perspective: '1000px' }}
    >
      {/* Phone frame - industrial, sharp edges reduced */}
      <div
        className="relative w-[280px] h-[560px] bg-[#0f0f12] rounded-[40px] border-4 border-[#2a2a30] overflow-hidden"
        style={{
          boxShadow: '0 25px 50px rgba(0, 0, 0, 0.6)',
        }}
      >
        {/* Notch */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-24 h-6 bg-p01-void rounded-full z-20" />

        {/* Screen content */}
        <div className="absolute inset-4 rounded-[32px] overflow-hidden bg-p01-void">
          {/* Status bar */}
          <div className="flex justify-between items-center px-6 py-2 text-xs text-p01-text-muted font-mono">
            <span>9:41</span>
            <div className="flex items-center gap-1">
              <div className="w-4 h-2 border border-p01-cyan/50 rounded-sm relative">
                <div className="absolute left-0.5 top-0.5 bottom-0.5 w-2 bg-p01-cyan rounded-sm" />
              </div>
            </div>
          </div>

          {/* App header */}
          <div className="px-6 py-4">
            <div className="flex items-center gap-3">
              {/* P-01 Logo mini */}
              <div className="w-10 h-10 rounded-xl bg-p01-surface border border-p01-cyan/30 flex items-center justify-center">
                <span className="text-p01-cyan font-display font-bold text-sm">P-01</span>
              </div>
              <div>
                <div className="text-white font-display font-bold text-sm">PROTOCOL 01</div>
                <div className="text-p01-cyan text-xs font-mono">● Connected</div>
              </div>
            </div>
          </div>

          {/* Balance card */}
          <div className="mx-4 p-4 bg-p01-surface rounded-2xl border border-p01-border">
            <div className="text-p01-text-muted text-xs font-mono mb-1">STEALTH BALANCE</div>
            <div className="text-2xl font-display font-bold text-white mb-1">$12,847.00</div>
            <div className="text-p01-cyan text-sm font-mono">◆ 4.2847 SOL</div>
          </div>

          {/* Quick actions - industrial square */}
          <div className="grid grid-cols-3 gap-3 px-4 mt-4">
            {[
              { icon: '↑', label: 'Send' },
              { icon: '↓', label: 'Receive' },
              { icon: '⟳', label: 'Swap' },
            ].map((action, i) => (
              <div key={i} className="flex flex-col items-center gap-1 p-3 bg-[#151518]/50 border border-[#2a2a30]/50">
                <div className="w-8 h-8 bg-[#39c5bb]/10 border border-[#39c5bb]/30 flex items-center justify-center text-[#39c5bb]">
                  {action.icon}
                </div>
                <span className="text-xs text-[#888892] font-mono">{action.label}</span>
              </div>
            ))}
          </div>

          {/* Recent activity */}
          <div className="px-4 mt-4">
            <div className="text-p01-text-muted text-xs font-mono mb-2">RECENT ACTIVITY</div>
            <div className="space-y-2">
              {[
                { type: 'stealth', amount: '-0.5 SOL', time: '2m ago' },
                { type: 'received', amount: '+1.2 SOL', time: '1h ago' },
              ].map((tx, i) => (
                <div key={i} className="flex items-center justify-between p-2 bg-p01-surface/30 rounded-lg">
                  <div className="flex items-center gap-2">
                    <div className={`w-6 h-6 flex items-center justify-center text-xs ${
                      tx.type === 'stealth' ? 'bg-[#ff2d7a]/20 text-[#ff2d7a]' : 'bg-[#39c5bb]/20 text-[#39c5bb]'
                    }`}>
                      {tx.type === 'stealth' ? '◈' : '◆'}
                    </div>
                    <div>
                      <div className="text-white text-xs font-mono">{tx.type === 'stealth' ? 'Stealth TX' : 'Received'}</div>
                      <div className="text-p01-text-dim text-xs">{tx.time}</div>
                    </div>
                  </div>
                  <div className={`text-xs font-mono ${tx.type === 'stealth' ? 'text-[#ff2d7a]' : 'text-[#39c5bb]'}`}>
                    {tx.amount}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Bottom nav */}
          <div className="absolute bottom-4 left-4 right-4 flex justify-around py-2 bg-p01-surface/80 backdrop-blur-sm rounded-2xl border border-p01-border/50">
            {['⌂', '◈', '⚙'].map((icon, i) => (
              <div
                key={i}
                className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg ${
                  i === 0 ? 'text-p01-cyan bg-p01-cyan/10' : 'text-p01-text-muted'
                }`}
              >
                {icon}
              </div>
            ))}
          </div>

          {/* Scanlines overlay */}
          <div
            className="absolute inset-0 pointer-events-none opacity-30"
            style={{
              background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.1) 2px, rgba(0,0,0,0.1) 4px)',
            }}
          />
        </div>

        {/* Reflection/glare effect */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 50%)',
          }}
        />
      </div>

      {/* Floating elements around phone - industrial squares */}
      <motion.div
        className="absolute -top-4 -right-4 w-8 h-8 border border-[#39c5bb]/40"
        animate={{ rotate: [0, 90, 180, 270, 360], y: [-5, 5, -5] }}
        transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
      />
      <motion.div
        className="absolute -bottom-6 -left-6 text-[#ff2d7a]/40 font-mono text-2xl"
        animate={{ opacity: [0.2, 0.6, 0.2], scale: [1, 1.1, 1] }}
        transition={{ duration: 3, repeat: Infinity }}
      >
        ◈
      </motion.div>
      <motion.div
        className="absolute top-1/4 -right-8 text-[#39c5bb]/30 font-mono"
        animate={{ x: [-5, 5, -5], opacity: [0.2, 0.5, 0.2] }}
        transition={{ duration: 4, repeat: Infinity }}
      >
        {"{ }"}
      </motion.div>
    </motion.div>
  );
}
