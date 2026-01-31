"use client";

import React from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import {
  Shield,
  Lock,
  Zap,
  Code,
  Layers,
  Eye,
  EyeOff,
  Key,
  Hash,
  GitBranch,
  Cpu,
  ArrowLeft,
  ExternalLink,
  CheckCircle,
} from "lucide-react";

// ============ P-01 Theme Constants ============
const THEME = {
  primaryColor: "#39c5bb",
  primaryBright: "#00ffe5",
  secondaryColor: "#ff77a8",
  pinkHot: "#ff2d7a",
  backgroundColor: "#0a0a0c",
  surfaceColor: "#151518",
  elevatedColor: "#1f1f24",
  textColor: "#ffffff",
  mutedColor: "#888892",
  dimColor: "#555560",
  borderColor: "#2a2a30",
};

interface TechSection {
  id: string;
  title: string;
  icon: React.ReactNode;
  description: string;
  details: string[];
  codeExample?: string;
}

const technologies: TechSection[] = [
  {
    id: "stealth-addresses",
    title: "Stealth Addresses (ECDH)",
    icon: <EyeOff className="w-6 h-6" />,
    description:
      "Stealth addresses allow recipients to receive funds without revealing their public address. Each payment creates a unique one-time address using Elliptic Curve Diffie-Hellman key exchange.",
    details: [
      "Sender generates ephemeral keypair for each transaction",
      "Shared secret computed using ECDH between sender ephemeral key and recipient's public key",
      "One-time address derived: P = H(shared_secret) * G + recipient_pubkey",
      "Only the recipient can detect and spend funds using their private key",
      "Implemented using Curve25519 for efficiency on Solana",
    ],
    codeExample: `// Generate stealth address
const ephemeral = Keypair.generate();
const sharedSecret = x25519(ephemeral.secretKey, recipientPubkey);
const stealthKey = deriveStealthKey(sharedSecret, recipientPubkey);`,
  },
  {
    id: "zk-proofs",
    title: "Zero-Knowledge Proofs (Groth16)",
    icon: <Shield className="w-6 h-6" />,
    description:
      "ZK-SNARKs hide basic transfers on-chain — amounts, senders, and recipients are invisible. This applies to direct private transfers only. Streams and subscriptions use a separate obscurement module (noise). Proofs are verified on-chain using Solana's native alt_bn128 syscalls.",
    details: [
      "Used for private transfers only (not streams or subscriptions)",
      "Circom circuits with ~12,000 constraints for efficient proving",
      "Poseidon hash function (ZK-friendly) for commitments and Merkle trees",
      "Groth16 verification using Solana's native BN254 pairing precompiles",
      "Proof generation takes <2 seconds on modern devices",
    ],
    codeExample: `// Generate ZK proof for private transfer
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  { inputs, merkle_path, nullifiers },
  "transfer.wasm",
  "transfer.zkey"
);`,
  },
  {
    id: "shielded-pool",
    title: "Shielded Pool & Relayer",
    icon: <Lock className="w-6 h-6" />,
    description:
      "Private transfers go through the relayer. The user generates a ZK proof client-side, funds the relayer, and the relayer executes the transfer to a stealth address. On-chain, only the relayer-to-stealth-address link is visible — the original sender is completely hidden.",
    details: [
      "User generates Groth16 proof locally (sender never revealed)",
      "User funds relayer with amount + 0.5% fee + gas",
      "Relayer verifies proof off-chain, then sends to stealth address",
      "On-chain visibility: Relayer → Stealth Address only",
      "Sparse Merkle tree with depth 20 for commitment tracking",
      "Supports SOL and any SPL token",
    ],
    codeExample: `// Private transfer flow via relayer
// 1. User generates ZK proof client-side
const { proof, publicSignals } = await generateProof(inputs);

// 2. User funds relayer (amount + fee + gas)
await fundRelayer(amount, feeBps: 50, gasCost);

// 3. Relayer verifies & sends to stealth address
// On-chain: only "Relayer → StealthAddress" is visible
const tx = await relayer.privateSend(proof, stealthAddress);`,
  },
  {
    id: "poseidon-hash",
    title: "Poseidon Hash Function",
    icon: <Hash className="w-6 h-6" />,
    description:
      "Poseidon is a ZK-friendly hash function designed specifically for use inside arithmetic circuits. It's significantly more efficient than traditional hashes like SHA-256 or Keccak in ZK contexts.",
    details: [
      "Operates natively over prime fields (BN254 scalar field)",
      "~300x fewer constraints than Keccak in Circom circuits",
      "Used for commitments, nullifiers, and Merkle tree hashing",
      "Parameters: BN254 curve, x^5 S-box, 8 full rounds",
      "Compatible with circomlib implementation",
    ],
    codeExample: `// Poseidon commitment in circuit
template Commitment() {
    signal input amount;
    signal input ownerPubkey;
    signal input randomness;
    signal output commitment;

    component hash = Poseidon(4);
    hash.inputs[0] <== amount;
    hash.inputs[1] <== ownerPubkey;
    hash.inputs[2] <== randomness;
    hash.inputs[3] <== tokenMint;
    commitment <== hash.out;
}`,
  },
  {
    id: "merkle-tree",
    title: "Merkle Tree Proofs",
    icon: <GitBranch className="w-6 h-6" />,
    description:
      "A Merkle tree stores all commitments, allowing users to prove they have funds in the shielded pool without revealing which commitment they own. The root is stored on-chain and updated with each deposit.",
    details: [
      "Binary tree with Poseidon hash at each node",
      "Depth 20 = 2^20 = ~1 million commitments capacity",
      "Proof size: 20 siblings + 20 path indices",
      "Incremental insertions for gas efficiency",
      "Precomputed zero values for empty subtrees",
    ],
    codeExample: `// Merkle proof verification in circuit
for (var i = 0; i < TREE_DEPTH; i++) {
    left = pathIndices[i] == 0 ? current : siblings[i];
    right = pathIndices[i] == 0 ? siblings[i] : current;
    current = Poseidon(left, right);
}
root === computedRoot; // Must match on-chain root`,
  },
  {
    id: "nullifiers",
    title: "Nullifier Mechanism",
    icon: <Key className="w-6 h-6" />,
    description:
      "Nullifiers are unique identifiers that prevent double-spending without revealing which commitment was spent. Each commitment can only produce one valid nullifier.",
    details: [
      "Nullifier = Poseidon(commitment, spending_key_hash)",
      "Stored on-chain in a set (prevents reuse)",
      "Cannot be linked back to the original commitment",
      "Spending key proves ownership without revealing identity",
      "Tracked by the relayer to prevent replay attacks",
    ],
    codeExample: `// Nullifier computation
const spendingKeyHash = Poseidon([spendingKey]);
const nullifier = Poseidon([commitment, spendingKeyHash]);
// On-chain: require(!nullifierSet.contains(nullifier))`,
  },
  {
    id: "solana-integration",
    title: "Solana On-Chain Verification",
    icon: <Cpu className="w-6 h-6" />,
    description:
      "Protocol 01 leverages Solana's native cryptographic syscalls for efficient on-chain ZK proof verification, achieving verification in under 200K compute units.",
    details: [
      "alt_bn128 syscalls for BN254 curve operations",
      "Native pairing checks for Groth16 verification",
      "Anchor framework for type-safe program development",
      "Compute budget: ~200K CU for full proof verification",
      "Cross-program invocations for token transfers",
    ],
    codeExample: `// On-chain Groth16 verification
let pairing_result = sol_alt_bn128_pairing(
    &[pi_a_neg, vk_alpha, pi_b, vk_beta, pi_c, vk_gamma, ...]
);
require!(pairing_result == 1, "Invalid proof");`,
  },
  {
    id: "private-relay",
    title: "Private Relay Architecture",
    icon: <Zap className="w-6 h-6" />,
    description:
      "User-funded relayer that verifies ZK proofs and executes private transfers to stealth addresses, breaking the on-chain link between sender and recipient.",
    details: [
      "User funds relayer with transfer amount + fee (0.5%) + gas + rent",
      "Relayer verifies ZK proof server-side (Groth16 snarkjs verification)",
      "Relayer sends to stealth address — no on-chain link to the sender",
      "Currently a self-hosted backend service (Node.js)",
      "Roadmap: on-chain Solana program for fully decentralized relay",
    ],
    codeExample: `// Private relay flow
// 1. User generates ZK proof client-side
const { proof, publicSignals } = await generateProof(inputs);

// 2. User funds relayer with amount + fee + gas
const fundTx = await fundRelayer(amount, fee, gasCost, rentCost);

// 3. Relayer verifies proof and sends to stealth address
// POST /api/private-send
{
  proof,           // Groth16 ZK proof
  publicSignals,   // Nullifier + commitments
  recipient,       // Stealth address (unlinkable)
  amount           // Transfer amount
}
// Result: recipient receives funds with no link to sender`,
  },
  {
    id: "streams-privacy",
    title: "Streams & Subscriptions Privacy",
    icon: <Layers className="w-6 h-6" />,
    description:
      "Streams and subscriptions do NOT use ZK proofs. They are separate modules with their own privacy model based on obscurement. Users can add noise to amounts and timing to make payments harder to analyze, but they are not fully hidden like ZK transfers.",
    details: [
      "Streams: time-locked escrow payments (P2P or P2B) — visible on-chain",
      "Subscriptions: delegated recurring payments via crank — visible on-chain",
      "Amount noise: 0-20% random variation on each payment",
      "Timing noise: 0-24 hours random delay on payment execution",
      "Optional stealth address for recipient obscurement",
      "Privacy level: obscurement (not full anonymity like ZK transfers)",
    ],
    codeExample: `// Subscription with privacy noise (not ZK)
await p01.createSubscription({
  amount: 9.99,
  interval: 'monthly',
  privacyOptions: {
    amountNoise: 10,    // ±10% random variation
    timingNoise: 12,    // ±12 hours random delay
    useStealth: true    // Pay to ephemeral address
  }
});
// On-chain: payment is visible but harder to correlate`,
  },
  {
    id: "client-sdk",
    title: "Client SDK Architecture",
    icon: <Code className="w-6 h-6" />,
    description:
      "Three SDKs for different use cases. P01Client for stealth wallets & transfers, ShieldedClient for ZK proofs, and Protocol01 for merchant integration. All run client-side for maximum privacy.",
    details: [
      "TypeScript SDKs with full type definitions",
      "Stealth address generation & scanning (ECDH)",
      "Groth16 proof generation for shielded transfers",
      "Payment streams & recurring subscriptions",
      "React hooks for wallet, streams and subscriptions",
    ],
    codeExample: `// === @p01/specter-sdk — Stealth Wallets & Transfers ===
import { P01Client, createWallet, sendPrivate } from '@p01/specter-sdk';

const client = new P01Client({ cluster: 'devnet' });
const wallet = await createWallet();
await client.connect(wallet);

// Send to stealth address (recipient unlinkable on-chain)
await sendPrivate({ amount: 1.5, recipient: stealthMetaAddress });

// Create payment stream (time-locked escrow)
await client.createStream({ recipient, amount: 10, duration: 30 * 86400 });

// === @p01/zk-sdk — ZK Shielded Pool ===
import { ShieldedClient } from '@p01/zk-sdk';

const zkClient = new ShieldedClient({ rpcUrl, programId });

// Shield tokens (deposit into private Merkle tree pool)
await zkClient.shield(1_000_000_000n, notes);

// Private transfer (Groth16 proof — amount hidden on-chain)
await zkClient.transfer(proofInputs);

// Unshield (withdraw back to public address)
await zkClient.unshield(outputNotes, 500_000_000n);

// === @p01/sdk — Merchant Integration ===
import { Protocol01 } from '@p01/sdk';

const p01 = new Protocol01({ merchantId: 'my-saas', merchantName: 'My App' });
await p01.createSubscription({ amount: 9.99, interval: 'monthly' });`,
  },
];

const docsArchLayers = [
  {
    name: "Client Layer",
    hex: "#39c5bb",
    nodes: [
      { label: "MOBILE APP", sub: "React Native / Expo" },
      { label: "EXTENSION", sub: "Chrome / Brave" },
      { label: "WEB APP", sub: "Next.js" },
    ],
  },
  {
    name: "SDK Layer",
    hex: "#ff77a8",
    nodes: [
      { label: "@p01/sdk", sub: "Merchant Integration" },
      { label: "@p01/specter-sdk", sub: "Stealth & Wallets" },
      { label: "@p01/zk-sdk", sub: "Groth16 Prover" },
    ],
  },
  {
    name: "Protocol Layer",
    hex: "#00ffe5",
    nodes: [
      { label: "STEALTH", sub: "ECDH Addresses" },
      { label: "SHIELDED", sub: "ZK Pool + Merkle Tree" },
      { label: "PAYMENTS", sub: "Streams & Subscriptions" },
    ],
  },
  {
    name: "Relay Layer",
    hex: "#ff77a8",
    nodes: [
      { label: "RELAYER", sub: "ZK Verify + Transfer" },
      { label: "CRANK", sub: "Auto Subscription Payments" },
    ],
  },
  {
    name: "Solana Blockchain",
    hex: "#ffcc00",
    nodes: [
      { label: "7 PROGRAMS", sub: "Anchor / Rust" },
      { label: "SPL Tokens", sub: "Token Standard" },
      { label: "alt_bn128", sub: "ZK Curve Ops" },
    ],
  },
];

const ArchitectureDiagram = () => (
  <div className="relative border border-[#2a2a30] bg-[#0a0a0c] p-6 sm:p-10 overflow-hidden">
    {/* Injected CSS for diagram animations */}
    <style dangerouslySetInnerHTML={{ __html: `
      @keyframes doc-dataflow {
        0% { transform: translateY(-100%); opacity: 0; }
        10% { opacity: 1; }
        90% { opacity: 1; }
        100% { transform: translateY(800%); opacity: 0; }
      }
      @keyframes doc-scan {
        0% { transform: translateY(-100%); }
        100% { transform: translateY(100%); }
      }
      @keyframes doc-glow-pulse {
        0%, 100% { opacity: 0.03; }
        50% { opacity: 0.07; }
      }
      @keyframes doc-particle-drift {
        0%, 100% { transform: translateY(0) translateX(0); opacity: 0.08; }
        25% { transform: translateY(-15px) translateX(5px); opacity: 0.15; }
        50% { transform: translateY(-8px) translateX(-3px); opacity: 0.1; }
        75% { transform: translateY(-20px) translateX(8px); opacity: 0.18; }
      }
      @media (prefers-reduced-motion: reduce) {
        .doc-animated { animation: none !important; }
      }
    `}} />

    {/* BG Layer 1 — Perspective grid */}
    <div className="absolute inset-0 overflow-hidden">
      <div className="absolute w-[200%] h-[120%] left-[-50%] top-[20%]" style={{
        backgroundImage: `
          linear-gradient(rgba(57, 197, 187, 0.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(57, 197, 187, 0.025) 1px, transparent 1px)
        `,
        backgroundSize: '60px 60px',
        transform: 'perspective(600px) rotateX(55deg)',
        transformOrigin: 'center top',
        maskImage: 'linear-gradient(to bottom, transparent 0%, black 20%, black 50%, transparent 90%)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 20%, black 50%, transparent 90%)',
      }} />
    </div>

    {/* BG Layer 2 — Radial glow pulse */}
    <div className="absolute inset-0 doc-animated" style={{
      background: `
        radial-gradient(ellipse 60% 40% at 30% 20%, rgba(57, 197, 187, 0.06) 0%, transparent 60%),
        radial-gradient(ellipse 50% 35% at 70% 80%, rgba(255, 119, 168, 0.04) 0%, transparent 60%)
      `,
      animation: 'doc-glow-pulse 6s ease-in-out infinite',
    }} />

    {/* BG Layer 3 — Vertical data flow lines */}
    <div className="absolute inset-0 overflow-hidden">
      {[15, 35, 55, 75, 90].map((x, i) => (
        <div key={i} className="absolute doc-animated" style={{
          left: `${x}%`,
          top: 0,
          width: '1px',
          height: '12%',
          background: `linear-gradient(to bottom, transparent, ${i % 2 === 0 ? 'rgba(57,197,187,0.15)' : 'rgba(255,119,168,0.12)'}, transparent)`,
          animation: `doc-dataflow ${5 + i * 0.7}s linear infinite`,
          animationDelay: `${i * 1.2}s`,
        }} />
      ))}
    </div>

    {/* BG Layer 4 — Floating particles */}
    <div className="absolute inset-0">
      {[
        { x: '10%', y: '15%', s: '+', c: '#39c5bb' },
        { x: '85%', y: '25%', s: '◇', c: '#ff77a8' },
        { x: '20%', y: '70%', s: '○', c: '#00ffe5' },
        { x: '75%', y: '80%', s: '×', c: '#ffcc00' },
        { x: '50%', y: '45%', s: '△', c: '#39c5bb' },
        { x: '92%', y: '55%', s: '+', c: '#ff77a8' },
      ].map((p, i) => (
        <span key={i} className="absolute font-light select-none pointer-events-none doc-animated" style={{
          left: p.x, top: p.y,
          fontSize: 10 + (i % 3) * 2,
          color: p.c,
          animation: `doc-particle-drift ${7 + i}s ease-in-out infinite`,
          animationDelay: `${i * 1.1}s`,
        }}>{p.s}</span>
      ))}
    </div>

    {/* BG Layer 5 — Scanline */}
    <div className="absolute left-0 right-0 h-[1px] doc-animated" style={{
      background: 'linear-gradient(90deg, transparent 10%, rgba(57,197,187,0.08) 50%, transparent 90%)',
      animation: 'doc-scan 8s linear infinite',
    }} />

    {/* BG Layer 6 — Vignette */}
    <div className="absolute inset-0 pointer-events-none" style={{
      background: 'radial-gradient(ellipse 80% 70% at 50% 50%, transparent 20%, rgba(10,10,12,0.5) 80%, rgba(10,10,12,0.8) 100%)',
    }} />

    {/* BG Layer 7 — Noise texture */}
    <div className="absolute inset-0 pointer-events-none opacity-[0.015] mix-blend-overlay" style={{
      backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
    }} />

    <div className="relative z-10">
      <h3 className="text-xs font-mono text-[#555560] uppercase tracking-[0.3em] text-center mb-2">
        System Architecture
      </h3>
      <h4 className="text-xl sm:text-2xl font-bold text-white text-center mb-10 uppercase tracking-wider">
        Protocol Stack
      </h4>

      <div className="flex flex-col items-center gap-0">
        {docsArchLayers.map((layer, layerIndex) => (
          <React.Fragment key={layer.name}>
            {/* Layer */}
            <div className="w-full max-w-2xl">
              {/* Layer label */}
              <div className="flex items-center gap-3 mb-3">
                <div className="w-1.5 h-1.5" style={{ backgroundColor: layer.hex }} />
                <span className="text-[10px] sm:text-xs font-mono uppercase tracking-[0.2em]" style={{ color: layer.hex }}>
                  {layer.name}
                </span>
                <div className="flex-1 h-px" style={{ backgroundColor: `${layer.hex}15` }} />
              </div>

              {/* Nodes grid */}
              <div className={`grid gap-2 sm:gap-3 ${layer.nodes.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                {layer.nodes.map((node) => (
                  <div
                    key={node.label}
                    className="bg-[#111114] border p-3 sm:p-4 text-center transition-all duration-300 hover:bg-[#151518]"
                    style={{ borderColor: `${layer.hex}25` }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.borderColor = `${layer.hex}60`;
                      (e.currentTarget as HTMLElement).style.boxShadow = `0 0 20px ${layer.hex}10, inset 0 1px 0 ${layer.hex}15`;
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.borderColor = `${layer.hex}25`;
                      (e.currentTarget as HTMLElement).style.boxShadow = 'none';
                    }}
                  >
                    <div className="text-xs sm:text-sm font-bold font-mono tracking-wide" style={{ color: layer.hex }}>
                      {node.label}
                    </div>
                    <div className="text-[10px] sm:text-xs text-[#555560] mt-1 font-mono">
                      {node.sub}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Connector arrow between layers */}
            {layerIndex < docsArchLayers.length - 1 && (
              <div className="flex flex-col items-center py-2">
                <div className="w-px h-4" style={{ backgroundColor: `${layer.hex}40` }} />
                <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent" style={{ borderTopColor: `${layer.hex}60` }} />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Bottom status bar */}
      <div className="flex items-center justify-center gap-3 mt-8 pt-6 border-t border-[#2a2a30]">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 bg-[#39c5bb] animate-pulse" />
          <span className="text-[10px] sm:text-xs font-mono text-[#555560] uppercase tracking-wider">
            End-to-end encrypted
          </span>
        </div>
        <span className="text-[#2a2a30]">|</span>
        <div className="flex items-center gap-2">
          <Zap className="w-3 h-3 text-[#39c5bb]" />
          <span className="text-[10px] sm:text-xs font-mono text-[#555560] uppercase tracking-wider">
            From client to settlement
          </span>
        </div>
      </div>
    </div>
  </div>
);

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0c]" style={{ wordWrap: 'break-word', overflowWrap: 'break-word' }}>
      {/* Header */}
      <header className="border-b border-[#2a2a30] bg-[#0a0a0c]/95 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <Link href="/" className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[#39c5bb]/10 border border-[#39c5bb]/40 flex items-center justify-center">
                <span className="text-[#39c5bb] font-mono font-bold text-xs">P01</span>
              </div>
              <span className="text-xl font-bold text-white tracking-wider">
                DOCUMENTATION
              </span>
            </Link>
            <Link
              href="/"
              className="flex items-center gap-2 text-[#888892] hover:text-[#39c5bb] transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-16 px-4 sm:px-6 lg:px-8 border-b border-[#2a2a30]">
        <div className="max-w-7xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center"
          >
            <h1 className="text-4xl sm:text-5xl font-bold text-white mb-4">
              Privacy Technologies
            </h1>
            <p className="text-lg text-[#888892] max-w-2xl mx-auto leading-relaxed">
              Protocol 01 combines cutting-edge cryptography to deliver true financial privacy on Solana.
              <br className="hidden sm:block" />
              Every component is built from scratch for maximum security and efficiency.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Architecture Overview */}
      <section className="py-12 px-4 sm:px-6 lg:px-8 border-b border-[#2a2a30]">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
            <Layers className="w-6 h-6 text-[#39c5bb]" />
            System Architecture
          </h2>
          <ArchitectureDiagram />
        </div>
      </section>

      {/* Technologies */}
      <section className="py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-8 flex items-center gap-3">
            <Zap className="w-6 h-6 text-[#ff77a8]" />
            Core Technologies
          </h2>

          <div className="space-y-8">
            {technologies.map((tech, index) => (
              <motion.div
                key={tech.id}
                id={tech.id}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.05 }}
                className="bg-[#151518] border border-[#2a2a30] rounded-lg overflow-hidden"
              >
                <div className="p-6 border-b border-[#2a2a30]">
                  <div className="flex items-center gap-4 mb-4">
                    <div className="w-12 h-12 bg-[#39c5bb]/10 border border-[#39c5bb]/40 flex items-center justify-center text-[#39c5bb]">
                      {tech.icon}
                    </div>
                    <h3 className="text-xl font-bold text-white">{tech.title}</h3>
                  </div>
                  <p className="text-[#888892] whitespace-normal break-words leading-relaxed">{tech.description}</p>
                </div>

                <div className="p-6 bg-[#0a0a0c]/50">
                  <h4 className="text-sm font-bold text-[#39c5bb] uppercase tracking-wider mb-4">
                    Key Features
                  </h4>
                  <ul className="space-y-2 mb-6">
                    {tech.details.map((detail, i) => (
                      <li key={i} className="flex items-start gap-3 text-sm text-[#888892]">
                        <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                        <span className="break-words">{detail}</span>
                      </li>
                    ))}
                  </ul>

                  {tech.codeExample && (
                    <>
                      <h4 className="text-sm font-bold text-[#ff77a8] uppercase tracking-wider mb-3">
                        Code Example
                      </h4>
                      <pre className="bg-[#0a0a0c] border border-[#2a2a30] p-4 rounded-lg overflow-x-auto text-xs sm:text-sm font-mono text-[#888892] whitespace-pre-wrap break-words">
                        {tech.codeExample}
                      </pre>
                    </>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Security Considerations */}
      <section className="py-12 px-4 sm:px-6 lg:px-8 border-t border-[#2a2a30]">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
            <Shield className="w-6 h-6 text-[#ff2d7a]" />
            Security Model
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-[#151518] border border-[#2a2a30] p-6 rounded-lg">
              <h3 className="text-lg font-bold text-white mb-4">Threat Model</h3>
              <ul className="space-y-2 text-sm text-[#888892]">
                <li className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-[#ff2d7a] flex-shrink-0 mt-0.5" />
                  <span>Blockchain observers cannot link senders and recipients</span>
                </li>
                <li className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-[#ff2d7a] flex-shrink-0 mt-0.5" />
                  <span>Transaction amounts are hidden in shielded transfers</span>
                </li>
                <li className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-[#ff2d7a] flex-shrink-0 mt-0.5" />
                  <span>Spending patterns cannot be analyzed</span>
                </li>
                <li className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-[#ff2d7a] flex-shrink-0 mt-0.5" />
                  <span>Balance tracking is impossible for third parties</span>
                </li>
              </ul>
            </div>
            <div className="bg-[#151518] border border-[#2a2a30] p-6 rounded-lg">
              <h3 className="text-lg font-bold text-white mb-4">Guarantees</h3>
              <ul className="space-y-2 text-sm text-[#888892]">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>Sound: Invalid proofs cannot be generated</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>Complete: Valid spends always produce valid proofs</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>Zero-knowledge: Proofs reveal nothing beyond validity</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>No double-spending: Nullifiers are unique per commitment</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Quick Links */}
      <section className="py-12 px-4 sm:px-6 lg:px-8 border-t border-[#2a2a30]">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-6">Quick Navigation</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {technologies.map((tech) => (
              <a
                key={tech.id}
                href={`#${tech.id}`}
                className="bg-[#151518] border border-[#2a2a30] p-4 rounded-lg hover:border-[#39c5bb]/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-[#39c5bb]">{tech.icon}</span>
                  <span className="text-sm text-white font-medium">{tech.title.split(' ')[0]}</span>
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#2a2a30] py-8 px-4">
        <div className="max-w-7xl mx-auto text-center">
          <p className="text-[#555560] text-sm font-mono">
            &copy; {new Date().getFullYear()} PROTOCOL 01 | Built from scratch for privacy
          </p>
        </div>
      </footer>
    </div>
  );
}
