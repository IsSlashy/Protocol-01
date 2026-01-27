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
      "ZK-SNARKs enable private transfers where amounts and participants are hidden. We use Groth16 proofs verified on-chain using Solana's native alt_bn128 syscalls.",
    details: [
      "Circom circuits with ~12,000 constraints for efficient proving",
      "Poseidon hash function (ZK-friendly) for commitments and Merkle trees",
      "Groth16 verification using Solana's native BN254 pairing precompiles",
      "Proof generation takes <2 seconds on modern devices",
      "Trusted setup completed with secure MPC ceremony",
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
    title: "Shielded Pool Architecture",
    icon: <Lock className="w-6 h-6" />,
    description:
      "The shielded pool stores encrypted notes in a Merkle tree. Users can deposit (shield), transfer privately, and withdraw (unshield) while maintaining complete privacy.",
    details: [
      "Note = Hash(amount, owner_pubkey, randomness, token_mint)",
      "Sparse Merkle tree with depth 20 (~1M notes capacity)",
      "Nullifiers prevent double-spending without revealing which note was spent",
      "Historical roots accepted for concurrent transactions",
      "Supports SOL and any SPL token",
    ],
    codeExample: `// Shielded note structure
Note = {
  amount: u64,           // Hidden from observers
  owner_pubkey: [u8; 32], // Derived from spending key
  randomness: [u8; 32],   // Blinding factor
  commitment: Poseidon(amount, owner, randomness, mint)
}`,
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
      "Used for note commitments and Merkle tree hashing",
      "Parameters: BN254 curve, x^5 S-box, 8 full rounds",
      "Compatible with circomlib implementation",
    ],
    codeExample: `// Poseidon hash in circuit
template NoteCommitment() {
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
      "A Merkle tree stores all note commitments, allowing users to prove membership without revealing which note they own. The root is stored on-chain and updated with each deposit.",
    details: [
      "Binary tree with Poseidon hash at each node",
      "Depth 20 = 2^20 = ~1 million notes capacity",
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
      "Nullifiers are unique identifiers that prevent double-spending without revealing which note was spent. Each note can only produce one valid nullifier.",
    details: [
      "Nullifier = Poseidon(commitment, spending_key_hash)",
      "Stored on-chain in a set (prevents reuse)",
      "Cannot be linked back to the original note",
      "Spending key proves ownership without revealing identity",
      "Bloom filter optimization for gas efficiency",
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
    id: "client-sdk",
    title: "Client SDK Architecture",
    icon: <Code className="w-6 h-6" />,
    description:
      "Two SDKs for different privacy levels. SpecterClient for stealth addresses, ShieldedClient for ZK proofs. Both run client-side for maximum privacy.",
    details: [
      "TypeScript/JavaScript SDK with full type definitions",
      "WASM-compiled circuits for browser compatibility",
      "Web Worker isolation for proof generation",
      "Automatic note management and encryption",
      "Streaming payments with SPL token support",
    ],
    codeExample: `// === P-01 SDK - Stealth Addresses ===
import { P01Client } from '@p01/sdk';

const client = new P01Client({ cluster: 'devnet' });
const wallet = await P01Client.createWallet();
await client.connect(wallet);

// Send private transfer (stealth address)
await client.sendPrivate(recipientStealthAddress, 1.5);

// Create payment stream
await client.createStream(recipient, 10, 30); // 10 SOL over 30 days

// === P-01 SDK - ZK Shielded Pool ===
import { ShieldedClient } from '@p01/sdk/zk';

const zkClient = new ShieldedClient({ connection, wallet });
await zkClient.initialize(seedPhrase);

// Shield tokens (deposit to private pool)
await zkClient.shield(1_000_000_000n); // 1 SOL

// Private ZK transfer
const zkAddress = ShieldedClient.decodeZkAddress("zk:...");
await zkClient.transfer(zkAddress, 500_000_000n);

// Unshield (withdraw to public)
await zkClient.unshield(publicKey, 500_000_000n);`,
  },
];

const ArchitectureDiagram = () => (
  <div className="bg-[#151518] border border-[#2a2a30] p-6 rounded-lg">
    <div className="flex flex-col items-center gap-4">
      {/* Client Layer */}
      <div className="w-full">
        <div className="text-xs text-[#555560] uppercase tracking-wider mb-2 text-center">Client Layer</div>
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-[#0a0a0c] border border-[#39c5bb]/30 p-3 rounded text-center">
            <div className="text-[#39c5bb] font-bold text-sm">MOBILE APP</div>
            <div className="text-[#555560] text-xs mt-1">React Native</div>
          </div>
          <div className="bg-[#0a0a0c] border border-[#39c5bb]/30 p-3 rounded text-center">
            <div className="text-[#39c5bb] font-bold text-sm">EXTENSION</div>
            <div className="text-[#555560] text-xs mt-1">Chrome</div>
          </div>
          <div className="bg-[#0a0a0c] border border-[#39c5bb]/30 p-3 rounded text-center">
            <div className="text-[#39c5bb] font-bold text-sm">SDK</div>
            <div className="text-[#555560] text-xs mt-1">TypeScript</div>
          </div>
        </div>
      </div>

      {/* Arrow */}
      <div className="text-[#39c5bb] text-2xl">↓</div>

      {/* ZK-SDK Layer */}
      <div className="w-full max-w-md">
        <div className="bg-[#0a0a0c] border border-[#ff77a8]/30 p-4 rounded text-center">
          <div className="text-[#ff77a8] font-bold">ZK-SDK (WASM)</div>
          <div className="flex justify-center gap-4 mt-2 text-xs text-[#888892]">
            <span>Prover</span>
            <span>•</span>
            <span>Poseidon</span>
            <span>•</span>
            <span>Note Mgmt</span>
          </div>
        </div>
      </div>

      {/* Arrow */}
      <div className="text-[#ff77a8] text-2xl">↓</div>

      {/* Protocol Layer */}
      <div className="w-full">
        <div className="text-xs text-[#555560] uppercase tracking-wider mb-2 text-center">Protocol Layer</div>
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-[#0a0a0c] border border-[#00ffe5]/30 p-3 rounded text-center">
            <div className="text-[#00ffe5] font-bold text-sm">STEALTH</div>
            <div className="text-[#555560] text-xs mt-1">ECDH</div>
          </div>
          <div className="bg-[#0a0a0c] border border-[#00ffe5]/30 p-3 rounded text-center">
            <div className="text-[#00ffe5] font-bold text-sm">SHIELDED</div>
            <div className="text-[#555560] text-xs mt-1">Groth16</div>
          </div>
          <div className="bg-[#0a0a0c] border border-[#00ffe5]/30 p-3 rounded text-center">
            <div className="text-[#00ffe5] font-bold text-sm">STREAMS</div>
            <div className="text-[#555560] text-xs mt-1">SPL</div>
          </div>
        </div>
      </div>

      {/* Arrow */}
      <div className="text-[#00ffe5] text-2xl">↓</div>

      {/* Relay Layer */}
      <div className="w-full">
        <div className="text-xs text-[#555560] uppercase tracking-wider mb-2 text-center">Relay Layer</div>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-[#0a0a0c] border border-[#ff77a8]/30 p-3 rounded text-center">
            <div className="text-[#ff77a8] font-bold text-sm">RELAYER</div>
            <div className="text-[#555560] text-xs mt-1">ZK Verification + Private Transfers</div>
          </div>
          <div className="bg-[#0a0a0c] border border-[#ff77a8]/30 p-3 rounded text-center">
            <div className="text-[#ff77a8] font-bold text-sm">ROADMAP</div>
            <div className="text-[#555560] text-xs mt-1">On-chain Solana program</div>
          </div>
        </div>
      </div>

      {/* Arrow */}
      <div className="text-[#ff77a8] text-2xl">↓</div>

      {/* Blockchain Layer */}
      <div className="w-full max-w-md">
        <div className="bg-[#0a0a0c] border border-[#ff2d7a]/30 p-4 rounded text-center">
          <div className="text-[#ff2d7a] font-bold">SOLANA BLOCKCHAIN</div>
          <div className="flex justify-center gap-4 mt-2 text-xs text-[#888892]">
            <span>alt_bn128</span>
            <span>•</span>
            <span>SPL Tokens</span>
            <span>•</span>
            <span>Anchor</span>
          </div>
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
                  <span>No double-spending: Nullifiers are unique per note</span>
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
            {technologies.slice(0, 8).map((tech) => (
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
