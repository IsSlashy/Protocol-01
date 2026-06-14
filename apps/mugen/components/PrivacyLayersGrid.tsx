'use client';

import {
  Wifi,
  Coins,
  Shuffle,
  Waves,
  Cpu,
  Layers,
  Route,
  Link2,
  Brain,
  Users,
  Clock,
  RefreshCw,
} from 'lucide-react';

type LayerSpec = {
  id: string;
  title: string;
  desc: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  status: 'live' | 'soon';
};

const LAYERS: LayerSpec[] = [
  {
    id: 'L0',
    title: 'Network Privacy',
    desc: '5-hop Nym mixnet routes your requests through encrypted mix nodes — the destination never sees your IP. Browser demo live; mobile via WebView in Phase 2.',
    icon: Wifi,
    status: 'live',
  },
  {
    id: 'L1',
    title: 'Natural Fiat',
    desc: 'Pay any arbitrary amount. We split it into canonical denominations behind the scenes.',
    icon: Coins,
    status: 'live',
  },
  {
    id: 'L2',
    title: 'Treasury Buffer',
    desc: 'MoonPay → Treasury routing wallet → stealth recipient with randomized delay. Breaks the direct on-chain link between the KYC\'d on-ramp deposit and the final wallet. Single-region MVP live; multi-region rotation in Phase 2.',
    icon: Shuffle,
    status: 'live',
  },
  {
    id: 'L3',
    title: 'Distributed Noise',
    desc: 'Each submission triggers indistinguishable decoys from a pool of noise wallets — chain observers can\'t tell real from fake. Server-side pool MVP live; distributed user-generated noise in Phase 2.',
    icon: Waves,
    status: 'live',
  },
  {
    id: 'L4',
    title: 'MagicBlock PER',
    desc: 'Sub-50ms private execution inside Intel TDX validators. Latency demo live; full delegation in Phase 2.',
    icon: Cpu,
    status: 'live',
  },
  {
    id: 'L5',
    title: 'Pools + Compression',
    desc: 'Thousand-deep anonymity sets per denomination give each note indistinguishable neighbours. Denominated pool programs deployed; hard-gate minimum anonymity check + Light Protocol compression ship in Phase 2.',
    icon: Layers,
    status: 'soon',
  },
  {
    id: 'L6',
    title: 'Privacy Router',
    desc: 'Three rounds of automatic re-shielding compound anonymity before funds settle. Router SDK module exists; full 3-cycle orchestration ships in Phase 2.',
    icon: Route,
    status: 'soon',
  },
  {
    id: 'L7',
    title: 'CoinJoin + Channels',
    desc: 'Multiple users merge into one atomic transaction so no single input maps to one output.',
    icon: Link2,
    status: 'soon',
  },
  {
    id: 'L8',
    title: 'Arcium MPC',
    desc: 'Encrypted maker offers, gated by a FROST quorum (L9). MPC circuits built and deployed on devnet. Today matching still runs through a server-side index; on-chain blind matching is in progress.',
    icon: Brain,
    status: 'soon',
  },
  {
    id: 'L9',
    title: 'FROST Relayers',
    desc: '2-of-3 (MVP) signer quorum gates every MPC submission. MVP uses independent keypairs, not yet aggregated FROST-Ed25519. A single signer cannot unilaterally front-run or censor.',
    icon: Users,
    status: 'live',
  },
  {
    id: 'L10',
    title: 'PoH Timing',
    desc: "Solana's Proof-of-History acts as a trusted clock to prevent timing correlation attacks.",
    icon: Clock,
    status: 'soon',
  },
  {
    id: 'L11',
    title: 'Crypto Agility',
    desc: 'Post-quantum primitives (STARK + ML-KEM-768) give a 50-year privacy horizon.',
    icon: RefreshCw,
    status: 'live',
  },
];

export default function PrivacyLayersGrid() {
  return (
    <div
      className="three-col"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '1rem',
      }}
    >
      {LAYERS.map((layer, i) => {
        const isBlue = i % 2 === 0;
        const tint = isBlue ? '#3b82f6' : '#8b5cf6';
        const Icon = layer.icon;
        return (
          <div
            key={layer.id}
            style={{
              position: 'relative',
              background: 'rgba(255,255,255,0.03)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '16px',
              padding: '1.25rem',
              minHeight: '160px',
              boxShadow: isBlue
                ? '0 8px 24px rgba(59,130,246,0.08)'
                : '0 8px 24px rgba(139,92,246,0.08)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.55rem',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: '1px',
                background: `linear-gradient(90deg, transparent, ${tint}40, transparent)`,
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div
                style={{
                  width: '2.25rem',
                  height: '2.25rem',
                  borderRadius: '10px',
                  background: `linear-gradient(135deg, ${tint}25, ${tint}08)`,
                  border: `1px solid ${tint}40`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon size={16} style={{ color: tint }} />
              </div>
              <span
                style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: '0.6rem',
                  color: tint,
                  letterSpacing: '0.15em',
                  textTransform: 'uppercase',
                }}
              >
                {layer.id}
              </span>
            </div>
            <h4
              style={{
                fontFamily: "'Orbitron',sans-serif",
                fontSize: '0.85rem',
                fontWeight: 700,
                color: 'white',
                margin: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                flexWrap: 'wrap',
              }}
            >
              {layer.title}
              {layer.status === 'live' ? (
                <span
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: '0.55rem',
                    fontWeight: 500,
                    color: '#22c55e',
                    background: 'rgba(34,197,94,0.1)',
                    border: '1px solid rgba(34,197,94,0.3)',
                    padding: '0.1rem 0.4rem',
                    borderRadius: '4px',
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                  }}
                >
                  Live
                </span>
              ) : (
                <span
                  style={{
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: '0.55rem',
                    fontWeight: 500,
                    color: '#8888aa',
                    background: 'rgba(136,136,170,0.08)',
                    border: '1px solid rgba(136,136,170,0.2)',
                    padding: '0.1rem 0.4rem',
                    borderRadius: '4px',
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                  }}
                >
                  Soon
                </span>
              )}
            </h4>
            <p
              style={{
                fontSize: '0.75rem',
                color: '#8888aa',
                lineHeight: 1.55,
                margin: 0,
              }}
            >
              {layer.desc}
            </p>
          </div>
        );
      })}
    </div>
  );
}
