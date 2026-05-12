"use client";

import React from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { useT } from "@/i18n";
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
  Network,
  Download,
  FileText,
  Archive,
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
  i18nKey: string;
  icon: React.ReactNode;
  detailCount: number;
  codeExample?: string;
}

const technologies: TechSection[] = [
  {
    id: "stealth-addresses",
    i18nKey: "stealthAddresses",
    icon: <EyeOff className="w-6 h-6" />,
    detailCount: 8,
    codeExample: `// v1: Generate stealth address (X25519 ECDH)
const ephemeral = Keypair.generate();
const sharedSecret = x25519(ephemeral.secretKey, recipientPubkey);
const stealthKey = deriveStealthKey(sharedSecret, recipientPubkey);

// v2: Hybrid quantum-resistant (X25519 + ML-KEM-768)
const { ciphertext, sharedSecret: hybridSecret } =
  mlKem768.encapsulate(recipientMlKemPubkey);
const combinedSecret = hkdf(x25519Secret, hybridSecret);`,
  },
  {
    id: "zk-proofs",
    i18nKey: "zkProofs",
    icon: <Shield className="w-6 h-6" />,
    detailCount: 9,
    codeExample: `// STARK proof (quantum-resistant, hash-based, no trusted setup)
const starkProof = await starkProver.generateProof(secret);

// Upload proof buffer → on-chain FRI verifier → ~889K CU
await submitStarkProof(program, proofBuffer, commitment, circuitId);
// 6 AIRs over Goldilocks field, 124-bit soundness with DEEP-ALI
// Replaces legacy Groth16/BN254 (see "Legacy / Migration History")`,
  },
  {
    id: "shielded-pool",
    i18nKey: "shieldedPool",
    icon: <Lock className="w-6 h-6" />,
    detailCount: 7,
    codeExample: `// Shielded pool flow (v1.0.0 — STARK V3, quantum-safe)
// 1. User generates a STARK proof locally (no remote prover)
const starkProof = await starkProver.generateProof(noteInputs);

// 2. Optional: instant path via p01_liquidity prefund so the user
//    doesn't have to front ~0.85 SOL of proof-buffer rent
await liquidity.prefund({ ephemeralSigner, proofBuffer, amount });

// 3. Buffer verifies on-chain → funds release to a one-time
//    ECDH + ML-KEM-768 stealth recipient. Observer sees only
//    "ephemeral signer → stealth recipient" — never the user's wallet.
const tx = await unshieldDenominatedStark({ proofBuffer, stealthRecipient });`,
  },
  {
    id: "poseidon-hash",
    i18nKey: "poseidonHash",
    icon: <Hash className="w-6 h-6" />,
    detailCount: 5,
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
    i18nKey: "merkleTree",
    icon: <GitBranch className="w-6 h-6" />,
    detailCount: 5,
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
    i18nKey: "nullifiers",
    icon: <Key className="w-6 h-6" />,
    detailCount: 5,
    codeExample: `// Nullifier computation
const spendingKeyHash = Poseidon([spendingKey]);
const nullifier = Poseidon([commitment, spendingKeyHash]);
// On-chain: require(!nullifierSet.contains(nullifier))`,
  },
  {
    id: "solana-integration",
    i18nKey: "solanaIntegration",
    icon: <Cpu className="w-6 h-6" />,
    detailCount: 6,
    codeExample: `// v1.0.0 — Every spend verifies through the custom on-chain
// FRI verifier (no Winterfell dep, Goldilocks + Blake3, ~889K CU).
let positions = fiat_shamir_positions(trace_root, commitment);
for pos in positions {
    verify_merkle_path(proof, pos, trace_root)?;
    verify_poseidon_round(trace_row, round_constants)?;
}

// LEGACY (pre-April 2026, now retired from every spend path) —
// BN254 Groth16 pairing via the sol_alt_bn128 syscall. Kept here
// only for historical reference; the code still exists in the
// repo history but no instruction dispatches to it in v1.0.0+.
//
//   let pairing_result = sol_alt_bn128_pairing(&[...]);
//   require!(pairing_result == 1, "Invalid Groth16 proof");`,
  },
  {
    id: "private-relay",
    i18nKey: "privateRelay",
    icon: <Zap className="w-6 h-6" />,
    detailCount: 6,
    codeExample: `// Trustless on-chain relay flow (v1.0.0 — STARK V3 + relayer-routed)
// 1. Client generates a STARK proof locally via the WASM prover
//    (spending key stays on device; no remote prover fallback)
const starkProof = await starkProver.generateProof({
  secret, nullifierPreimage, merklePath, pathIndices,
});

// 2. Upload the proof to a buffer account (~120 KB, ~9–15 KB compact)
//    then call the on-chain FRI verifier (no Winterfell dep,
//    custom Goldilocks + Blake3 implementation, ~889K CU)
await submitStarkProof(program, proofBuffer, circuitId);

// 3. Instruction reads the verified buffer and releases funds
//    to a one-time stealth recipient (ECDH + ML-KEM-768 hybrid)
await program.methods.unshieldDenominatedStark(...)
  .accounts({ pool, recipient: stealthAddress, nullifierPda })
  .rpc();
// Legacy snarkjs.groth16 path fully retired — see Migration History`,
  },
  {
    id: "arcium-mpc",
    i18nKey: "arciumMpc",
    icon: <Network className="w-6 h-6" />,
    detailCount: 8,
    codeExample: `// @protocol-01/arcium-sdk — MPC confidential compute
import { ArciumClient } from '@protocol-01/arcium-sdk';

const mpc = new ArciumClient({ connection, wallet, programId });
await mpc.initialize(); // X25519 key exchange + Rescue cipher setup

// Without MPC: nullifier posted in the clear on-chain
// With MPC:    nodes compute SHA3(nullifier) together, only hash goes on-chain
await mpc.commitNullifier(nullifierPreimage, secret);

// Without MPC: relayer sees full transaction content
// With MPC:    transaction split across nodes, nobody sees the plaintext
await mpc.confidentialRelay(encryptedTransaction);

// Without MPC: RPC lookup reveals who you searched for
// With MPC:    query goes through MPC, target stays anonymous
const metaAddress = await mpc.privateLookup(targetHash);`,
  },
  {
    id: "sealed-bid-auctions",
    i18nKey: "sealedBidAuctions",
    icon: <Lock className="w-6 h-6" />,
    detailCount: 8,
    codeExample: `// Sealed-Bid Auction — Arcium MPC + ZK Escrow
import { createAuction, submitSealedBid, finalizeAuction } from '@protocol-01/arcium-sdk';

// 1. Seller creates auction
await createAuction(client, program, { auctionId, pool, deadline });

// 2. Bidder locks funds in escrow (Groth16 proof pre-authorizes both outcomes)
//    Note: escrow surface still uses Groth16 — STARK migration scheduled.
await escrowShield(proof, nullifier, merkleRoot, auctionId, payCommit, refundCommit);

// 3. Bidder submits encrypted bid (MPC — no one sees the amount)
await submitSealedBid(client, program, auctionId, bidAmount, escrowNullifier);

// 4. After deadline: MPC reveals winner, escrow auto-settles
const result = await finalizeAuction(client, program, auctionId);
// Winner's funds → seller | Losers' funds → refunded. No trust needed.`,
  },
  {
    id: "streams-privacy",
    i18nKey: "streamsPrivacy",
    icon: <Layers className="w-6 h-6" />,
    detailCount: 6,
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
    id: "denominated-pools",
    i18nKey: "denominatedPools",
    icon: <Layers className="w-6 h-6" />,
    detailCount: 8,
    codeExample: `// Shield: stealth intermediary hides wallet origin
const stealthKp = deriveStealthSigner(wallet, timestamp);
await fundStealth(wallet, stealthKp, 0.1); // small fee fund
await program.methods.shieldDenominated(commitment, epoch)
  .accounts({ pool, depositor: stealthKp.publicKey })
  .signers([stealthKp]).rpc();

// Unshield: stealth signer + stealth ECDH recipient
// Wallet NEVER appears as signer, fee payer, or recipient
const signer = deriveEphemeralSigner();
const recipient = generateStealthAddress(metaAddress); // ECDH one-time
await program.methods.unshieldDenominatedStark(starkProof)
  .accounts({ pool, recipient: recipient.address, nullifierPda })
  .signers([signer]).rpc();
// Auto-sweep: recipient → wallet (delayed 3-7s for decorrelation)`,
  },
  {
    id: "zkspl",
    i18nKey: "zkspl",
    icon: <Lock className="w-6 h-6" />,
    detailCount: 7,
    codeExample: `// Confidential deposit — public tokens become hidden balance
const oldCommitment = poseidon([0, salt, owner, mint]);
const newCommitment = poseidon([amount, newSalt, owner, mint]);
const { proof } = await prover.prove({
  old_balance: 0, new_balance: amount,
  public_credit: amount, public_debit: 0,
  private_credit: 0, private_debit: 0,
  old_salt: salt, new_salt: newSalt
});

// Confidential transfer — sender and recipient balances stay hidden
// Amount commitment links the two operations cryptographically
const amountCommitment = poseidon([transferAmount, amountSalt]);`,
  },
  {
    id: "subscription-vaults",
    i18nKey: "subscriptionVaults",
    icon: <Zap className="w-6 h-6" />,
    detailCount: 6,
    codeExample: `// Retailer creates a subscription vault
await program.methods.initSubscriptionVault(
  amount,       // per-period amount (lamports or token units)
  interval,     // seconds between payments
  tokenMint     // SOL (system_program::ID) or SPL token
).accounts({ vault, retailer }).rpc();

// Subscriber joins (normal mode)
await program.methods.subscribeNormal()
  .accounts({ vault, subscriber, subscriberRecord })
  .rpc();

// Retailer claims a payment period
await program.methods.claimPeriod()
  .accounts({ vault, subscriberRecord, retailer })
  .rpc();`,
  },
  {
    id: "p2p-sharing",
    i18nKey: "p2pSharing",
    icon: <Eye className="w-6 h-6" />,
    detailCount: 6,
    codeExample: `// BLE: Sender (central) connects to receiver (peripheral)
// 1. ECDH key exchange
const sharedKey = x25519(senderPrivateKey, receiverPublicKey);

// 2. Encrypt note data
const encrypted = nacl.box(noteJSON, nonce, sharedKey);

// 3. Fragment and send over BLE characteristics
await bleTransport.sendFragmented(encrypted, characteristicUUID);

// NFC: Sender emulates tag via HCE
// Receiver taps phone → APDU commands: SELECT → GET LENGTH → GET DATA
// Data encrypted with nacl.secretbox(noteJSON, nonce, pinDerivedKey)`,
  },
  {
    id: "client-sdk",
    i18nKey: "clientSdk",
    icon: <Code className="w-6 h-6" />,
    detailCount: 8,
    codeExample: `// === @protocol-01/specter-sdk — Core Privacy SDK ===
import { P01Client, createWallet, sendPrivate } from '@protocol-01/specter-sdk';
const client = new P01Client({ cluster: 'devnet' });
await sendPrivate({ amount: 1.5, recipient: stealthMetaAddress });

// === @protocol-01/zk-sdk — ZK Shielded Pool ===
import { ShieldedClient } from '@protocol-01/zk-sdk';
const zkClient = new ShieldedClient({ rpcUrl, programId });
await zkClient.shield(1_000_000_000n, notes);

// === @protocol-01/zkspl-sdk — Confidential Balances ===
import { ZkSplClient } from '@protocol-01/zkspl-sdk';
await zkspl.deposit(amount, proof);   // Public → confidential
await zkspl.send(amount, recipient);  // Confidential transfer

// === @protocol-01/arcium-sdk — MPC Compute ===
import { ArciumClient } from '@protocol-01/arcium-sdk';
await mpc.commitNullifier(preimage);  // SHA3 via MPC nodes

// === @protocol-01/p01-js — Merchant Integration ===
import { Protocol01 } from '@protocol-01/p01-js';
await p01.createSubscription({ amount: 9.99, interval: 'monthly' });

// === @protocol-01/privacy-toolkit — Merkle + Poseidon ===
import { IncrementalMerkleTree, poseidon2 } from '@protocol-01/privacy-toolkit';

// === @protocol-01/auth-sdk — Auth Integration ===
import { P01AuthClient } from '@protocol-01/auth-sdk';

// === @protocol-01/rpc-config — RPC Infrastructure ===
import { RpcConnectionManager } from '@protocol-01/rpc-config';
const conn = RpcConnectionManager.getConnection(); // Auto-fallback chain`,
  },
  {
    id: "auto-shield",
    i18nKey: "autoShield",
    icon: <Shield className="w-6 h-6" />,
    detailCount: 7,
    codeExample: `// Auto-Shield flow (autonomous runner)
// 1. User opens Receive → stealth address generated
const seed = hmac(sha256, viewingSecretKey, "p01_auto_receive_42");
const keypair = Keypair.fromSeed(seed);
// Display keypair.publicKey as QR code

// 2. Sender sends SOL to the stealth address (any wallet)
// 3. Runner detects funds → auto-shields
const balance = await connection.getBalance(stealthAddress);
if (balance > MIN_THRESHOLD) {
  await shield(pool, progressCb, undefined, keypair);
  // Main wallet never visible on-chain
}`,
  },
  {
    id: "stealth-meta-addresses",
    i18nKey: "stealthMetaAddresses",
    icon: <Key className="w-6 h-6" />,
    detailCount: 7,
    codeExample: `// Receiver: share meta-address
const keys = await getOrCreateStealthKeys();
const metaAddress = createMetaAddress(keys);
// → "st:012u2trSt1XytE271..."

// Sender: Private Send auto-derives stealth destination
if (isMetaAddress(destination)) {
  const stealth = deriveStealthForRecipient(destination);
  finalDestination = stealth.address;
  // Both sender + receiver hidden on-chain
}`,
  },
  {
    id: "note-splitting",
    i18nKey: "noteSplitting",
    icon: <GitBranch className="w-6 h-6" />,
    detailCount: 7,
    codeExample: `// Split 1 SOL into 10 × 0.1 SOL
const result = await splitNote(
  sourcePool,  // 1 SOL pool
  targetPool,  // 0.1 SOL pool
  receipt,     // Source note receipt
  10,          // Number of outputs
  outputSecrets,
  proofGenerator,
);
// → 10 new notes in 0.1 SOL pool`,
  },
  {
    id: "privacy-router",
    i18nKey: "privacyRouter",
    icon: <Zap className="w-6 h-6" />,
    detailCount: 8,
    codeExample: `// Start a Paranoid-level private send
const route = await startPrivateRoute({
  amount: 0.1,
  destination: "7gWpzSZA...",
  privacyLevel: 5, // Paranoid
  spendingKeyHash,
});
// → 14 hops over ~2 days
// → Shield → Unshield → Reshield → ... → Final delivery
// → Each hop uses a different stealth address`,
  },
  {
    id: "ai-agent",
    i18nKey: "aiAgent",
    icon: <Cpu className="w-6 h-6" />,
    detailCount: 14,
    codeExample: `// User: "What's my balance and shield 0.1 SOL"
// Agent calls tools:
const balance = await executeTool("wallet_balance", {});
// → { sol: "3.69", usd: "$520.13" }

// Agent responds and calls shield tool:
await executeTool("privacy_shield", { amount: 0.1 });
// → Redirects to Privacy → Shield screen`,
  },
  {
    id: "quantum-wallet",
    i18nKey: "quantumWallet",
    icon: <Key className="w-6 h-6" />,
    detailCount: 8,
    codeExample: `// Quantum Wallet — STARK-authorized fund custody (coming Q3 2026)
// Funds spent via Poseidon preimage proof, not Ed25519 signature.

// 1. Init at first launch — silent, transparent migration
const seedSecret = hkdf(seedPhrase, "p01_quantum_v1");
const commitment = poseidonGl(seedSecret, salt);  // Goldilocks
const ownerId = poseidonGl(seedSecret, "id_v1");
const pda = derivePda(["qw", ownerId], P01_QUANTUM_WALLET_ID);
await initQuantumWallet({ commitment, recoveryPubkey: null });

// 2. Receive — your address is the PDA. Senders use SystemProgram.transfer
// like any other wallet. They don't know it's quantum-protected.

// 3. Send — STARK proves "I know the preimage of commitment"
const proof = await starkProver.generateProof({
  seedSecret, salt, recipient, amount, nonce, circuitId: 7,
});
await uploadProofBuffer(proof);
await withdraw({ amount, recipient, proofBuffer });

// Threat: Shor breaks Ed25519 ≥ 2030. Attacker steals your gas keypair
// → can pay fees in your name, CANNOT move your funds.
// Custody = preimage knowledge (Grover-resistant), not signature.`,
  },
  {
    id: "migration-history",
    i18nKey: "migrationHistory",
    icon: <Archive className="w-6 h-6" />,
    detailCount: 6,
    codeExample: `// BEFORE — Groth16 / BN254 (retired April 2026)
// const { proof } = await snarkjs.groth16.fullProve(
//   inputs, "transfer.wasm", "transfer.zkey"
// );
// → BN254 pairings (Shor-vulnerable), 30 MB .ptau trusted setup,
//   snarkjs + circomlib runtime, alt_bn128 syscalls

// AFTER — Winterfell STARKs over Goldilocks (current)
const proof = await starkProver.generateProof(secret);
// → Hash-based (Blake3 + Poseidon), no trusted setup,
//   custom on-chain FRI verifier, 6 AIRs, ~9-15 KB proofs`,
  },
];

const docsArchLayers = [
  {
    nameKey: "docs.layerClient",
    hex: "#39c5bb",
    nodes: [
      { labelKey: "docs.nodeMobileApp", subKey: "docs.nodeMobileSub" },
      { labelKey: "docs.nodeExtension", subKey: "docs.nodeExtensionSub" },
      { labelKey: "docs.nodeWebApp", subKey: "docs.nodeWebSub" },
      { labelKey: "docs.nodeAiAgent", subKey: "docs.nodeAiSub" },
    ],
  },
  {
    nameKey: "docs.layerPrivacy",
    hex: "#ff2d7a",
    nodes: [
      { labelKey: "docs.nodeAutoShield", subKey: "docs.nodeAutoShieldSub" },
      { labelKey: "docs.nodePrivacyRouter", subKey: "docs.nodePrivacyRouterSub" },
      { labelKey: "docs.nodeMetaAddr", subKey: "docs.nodeMetaAddrSub" },
    ],
  },
  {
    nameKey: "docs.layerSdk",
    hex: "#ff77a8",
    nodes: [
      { labelKey: "docs.nodeSpecterSdk", subKey: "docs.nodeSpecterSub" },
      { labelKey: "docs.nodeZkSdk", subKey: "docs.nodeZkSub" },
      { labelKey: "docs.nodeZksplSdk", subKey: "docs.nodeZksplSub" },
      { labelKey: "docs.nodeArciumSdk", subKey: "docs.nodeArciumSub" },
      { labelKey: "docs.nodeP01Js", subKey: "docs.nodeP01JsSub" },
      { labelKey: "docs.nodePrivacyToolkit", subKey: "docs.nodePrivacyToolkitSub" },
      { labelKey: "docs.nodeAuthSdk", subKey: "docs.nodeAuthSub" },
      { labelKey: "docs.nodeRpcConfig", subKey: "docs.nodeRpcSub" },
    ],
  },
  {
    nameKey: "docs.layerProtocol",
    hex: "#00ffe5",
    nodes: [
      { labelKey: "docs.nodeStealth", subKey: "docs.nodeStealthSub" },
      { labelKey: "docs.nodeShielded", subKey: "docs.nodeShieldedSub" },
      { labelKey: "docs.nodeDenominated", subKey: "docs.nodeDenominatedSub" },
      { labelKey: "docs.nodeNoteSplit", subKey: "docs.nodeNoteSplitSub" },
      { labelKey: "docs.nodeZkspl", subKey: "docs.nodeZksplProtoSub" },
      { labelKey: "docs.nodePayments", subKey: "docs.nodePaymentsSub" },
      { labelKey: "docs.nodeVaults", subKey: "docs.nodeVaultsSub" },
      { labelKey: "docs.nodeMpc", subKey: "docs.nodeMpcSub" },
    ],
  },
  {
    nameKey: "docs.layerVerification",
    hex: "#ff77a8",
    nodes: [
      { labelKey: "docs.nodeOnChainRelayer", subKey: "docs.nodeRelayerSub" },
      { labelKey: "docs.nodeStarkVerifier", subKey: "docs.nodeStarkSub" },
      { labelKey: "docs.nodeQuantumVault", subKey: "docs.nodeQuantumSub" },
      { labelKey: "docs.nodeBundler", subKey: "docs.nodeBundlerSub" },
      { labelKey: "docs.nodeCrank", subKey: "docs.nodeCrankSub" },
    ],
  },
  {
    nameKey: "docs.layerSolana",
    hex: "#ffcc00",
    nodes: [
      { labelKey: "docs.nodePrograms", subKey: "docs.nodeProgramsSub" },
      { labelKey: "docs.nodeSplTokens", subKey: "docs.nodeSplSub" },
      { labelKey: "docs.nodeZkVerif", subKey: "docs.nodeZkVerifSub" },
    ],
  },
];

const ArchitectureDiagram = ({ t }: { t: (key: string) => string }) => (
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
        {t('docs.archTitle')}
      </h3>
      <h4 className="text-xl sm:text-2xl font-bold text-white text-center mb-10 uppercase tracking-wider">
        {t('docs.archSubtitle')}
      </h4>

      <div className="flex flex-col items-center gap-0">
        {docsArchLayers.map((layer, layerIndex) => (
          <React.Fragment key={layer.nameKey}>
            {/* Layer */}
            <div className="w-full max-w-2xl">
              {/* Layer label */}
              <div className="flex items-center gap-3 mb-3">
                <div className="w-1.5 h-1.5" style={{ backgroundColor: layer.hex }} />
                <span className="text-[10px] sm:text-xs font-mono uppercase tracking-[0.2em]" style={{ color: layer.hex }}>
                  {t(layer.nameKey)}
                </span>
                <div className="flex-1 h-px" style={{ backgroundColor: `${layer.hex}15` }} />
              </div>

              {/* Nodes grid */}
              <div className={`grid gap-2 sm:gap-3 ${layer.nodes.length === 2 ? 'grid-cols-2' : layer.nodes.length === 4 ? 'grid-cols-2 sm:grid-cols-4' : layer.nodes.length >= 5 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-3'}`}>
                {layer.nodes.map((node) => (
                  <div
                    key={node.labelKey}
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
                      {t(node.labelKey)}
                    </div>
                    <div className="text-[10px] sm:text-xs text-[#555560] mt-1 font-mono">
                      {t(node.subKey)}
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
            {t('docs.archEncrypted')}
          </span>
        </div>
        <span className="text-[#2a2a30]">|</span>
        <div className="flex items-center gap-2">
          <Zap className="w-3 h-3 text-[#39c5bb]" />
          <span className="text-[10px] sm:text-xs font-mono text-[#555560] uppercase tracking-wider">
            {t('docs.archFlow')}
          </span>
        </div>
      </div>
    </div>
  </div>
);

function TechAccordion({ tech, index, t }: { tech: TechSection; index: number; t: (key: string) => string }) {
  const [open, setOpen] = React.useState(false);
  const title = t(`docs.sections.${tech.i18nKey}.title`);
  const description = t(`docs.sections.${tech.i18nKey}.desc`);
  const details = Array.from({ length: tech.detailCount }, (_, i) => t(`docs.sections.${tech.i18nKey}.detail${i + 1}`));

  return (
    <motion.div
      id={tech.id}
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.03 }}
      className="border border-white/[0.06] rounded-2xl overflow-hidden bg-white/[0.02] backdrop-blur-sm hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors"
    >
      {/* Header — always visible, clickable */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-4 p-4 sm:p-5 text-left cursor-pointer hover:bg-[#1a1a1f] transition-colors"
      >
        <div className="w-10 h-10 bg-[#39c5bb]/10 border border-[#39c5bb]/30 flex items-center justify-center text-[#39c5bb] shrink-0">
          {tech.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-bold text-white">{title}</h3>
          <p className="text-xs text-[#888892] mt-0.5 truncate">{description}</p>
        </div>
        <motion.div
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="text-[#555560] shrink-0"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </motion.div>
      </button>

      {/* Expandable content */}
      <motion.div
        initial={false}
        animate={{
          height: open ? "auto" : 0,
          opacity: open ? 1 : 0,
        }}
        transition={{ duration: 0.3, ease: "easeInOut" }}
        className="overflow-hidden"
      >
        <div className="px-4 sm:px-5 pb-5 pt-1 border-t border-[#2a2a30]">
          <p className="text-[#888892] text-sm leading-relaxed mb-4">{description}</p>

          <h4 className="text-xs font-bold text-[#39c5bb] uppercase tracking-wider mb-3">
            {t('docs.keyFeatures')}
          </h4>
          <ul className="space-y-1.5 mb-5">
            {details.map((detail, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-[#888892]">
                <CheckCircle className="w-3.5 h-3.5 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                <span className="break-words">{detail}</span>
              </li>
            ))}
          </ul>

          {tech.codeExample && (
            <>
              <h4 className="text-xs font-bold text-[#ff77a8] uppercase tracking-wider mb-2">
                {t('docs.codeExample')}
              </h4>
              <pre className="bg-[#0a0a0c] border border-[#2a2a30] p-3 rounded-lg overflow-x-auto text-xs font-mono text-[#888892] whitespace-pre-wrap break-words">
                {tech.codeExample}
              </pre>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function DocsPage() {
  const t = useT();
  return (
    <div className="min-h-screen bg-[#0a0a0c]" style={{ wordWrap: 'break-word', overflowWrap: 'break-word' }}>
      {/* Header — sticky nav */}
      <header className="border-b border-[#2a2a30] bg-[#0a0a0c]/90 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <div className="flex items-center justify-between">
            <Link href="/" className="flex items-center gap-3 group">
              <img src="/icon.png" alt="Protocol 01" className="w-8 h-8 rounded-lg" />
              <div className="hidden sm:flex items-center gap-2">
                <span className="text-sm font-bold text-white tracking-wider">PROTOCOL 01</span>
                <span className="text-[#555560]">/</span>
                <span className="text-sm font-mono text-[#39c5bb] tracking-wider">DOCS</span>
              </div>
              <span className="sm:hidden text-sm font-mono text-[#39c5bb] tracking-wider">DOCS</span>
            </Link>
            <div className="flex items-center gap-4">
              <Link href="/roadmap" className="hidden sm:flex text-xs font-mono text-[#555560] hover:text-[#888892] transition-colors uppercase tracking-wider">
                {t('docs.navRoadmap')}
              </Link>
              <Link href="/#download" className="hidden sm:flex text-xs font-mono text-[#555560] hover:text-[#888892] transition-colors uppercase tracking-wider">
                {t('docs.navDownload')}
              </Link>
              <Link
                href="/"
                className="flex items-center gap-1.5 text-sm text-[#888892] hover:text-[#39c5bb] transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('docs.navHome')}</span>
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero — compact + impactful */}
      <section className="relative overflow-hidden border-b border-[#2a2a30]">
        {/* Subtle gradient background */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#39c5bb]/[0.03] via-transparent to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#ff77a8]/[0.02] via-transparent to-[#39c5bb]/[0.02]" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center"
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-[#39c5bb]/10 border border-[#39c5bb]/20 rounded-full mb-6">
              <div className="w-1.5 h-1.5 bg-[#39c5bb] rounded-full animate-pulse" />
              <span className="text-xs font-mono text-[#39c5bb] uppercase tracking-widest">{t('docs.badge')}</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-5 tracking-tight">
              {t('docs.heroTitle1')}{" "}
              <span className="bg-gradient-to-r from-[#39c5bb] to-[#00ffe5] bg-clip-text text-transparent">
                {t('docs.heroTitle2')}
              </span>
            </h1>

            <p className="text-base sm:text-lg text-[#888892] max-w-2xl mx-auto leading-relaxed mb-8">
              {t('docs.heroSubtitle')}
            </p>

            {/* Quick stats */}
            <div className="flex flex-wrap items-center justify-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-[#39c5bb]" />
                <span className="text-[#888892]"><span className="text-white font-bold">10</span> {t('docs.statCircuits')}</span>
              </div>
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[#ff77a8]" />
                <span className="text-[#888892]"><span className="text-white font-bold">14</span> {t('docs.statPrograms')}</span>
              </div>
              <div className="flex items-center gap-2">
                <Code className="w-4 h-4 text-[#00ffe5]" />
                <span className="text-[#888892]"><span className="text-white font-bold">17</span> {t('docs.statSdks')}</span>
              </div>
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-[#ffcc00]" />
                <span className="text-[#888892]"><span className="text-white font-bold">14</span> {t('docs.statModules')}</span>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Architecture Overview */}
      <section className="py-12 px-4 sm:px-6 lg:px-8 border-b border-[#2a2a30]">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
            <Layers className="w-6 h-6 text-[#39c5bb]" />
            {t('docs.archSectionTitle')}
          </h2>
          <ArchitectureDiagram t={t} />
        </div>
      </section>

      {/* Technologies — Collapsible Accordion */}
      <section className="py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-3">
            <Zap className="w-6 h-6 text-[#ff77a8]" />
            {t('docs.coreTechTitle')}
          </h2>
          <p className="text-[#888892] mb-8 text-sm">
            {technologies.length} {t('docs.coreTechDesc')}
          </p>

          <div className="space-y-2">
            {technologies.map((tech, index) => (
              <TechAccordion key={tech.id} tech={tech} index={index} t={t} />
            ))}
          </div>
        </div>
      </section>

      {/* Security Considerations */}
      <section className="py-12 px-4 sm:px-6 lg:px-8 border-t border-[#2a2a30]">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-3">
            <Shield className="w-6 h-6 text-[#ff2d7a]" />
            {t('docs.securityTitle')}
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-6 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors">
              <h3 className="text-lg font-bold text-white mb-4">{t('docs.threatModel')}</h3>
              <ul className="space-y-2 text-sm text-[#888892]">
                <li className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-[#ff2d7a] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.threatObservers')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-[#ff2d7a] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.threatAmounts')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-[#ff2d7a] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.threatPatterns')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-[#ff2d7a] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.threatBalance')}</span>
                </li>
              </ul>
            </div>
            <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-6 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors">
              <h3 className="text-lg font-bold text-white mb-4">{t('docs.guarantees')}</h3>
              <ul className="space-y-2 text-sm text-[#888892]">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.guaranteeSound')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.guaranteeComplete')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.guaranteeZk')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.guaranteeNoDouble')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.guaranteeMpc')}</span>
                </li>
              </ul>
            </div>
          </div>

          {/* Security Hardening */}
          <div className="mt-6 bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-6 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors">
            <h3 className="text-lg font-bold text-white mb-4">{t('docs.securityHardening')}</h3>
            <div className="grid md:grid-cols-3 gap-4 text-sm text-[#888892]">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.hardenSpendingKey')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.hardenPin')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.hardenLockout')}</span>
                </li>
              </ul>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.hardenSecureStore')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.hardenClipboard')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.hardenBlur')}</span>
                </li>
              </ul>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.hardenBackup')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.hardenBiometric')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.hardenLockScreen')}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Privacy: With vs Without MPC */}
      <section id="mpc-comparison" className="py-12 px-4 sm:px-6 lg:px-8 border-t border-[#2a2a30]">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-2 flex items-center gap-3">
            <Network className="w-6 h-6 text-[#f59e0b]" />
            {t('docs.mpcTitle')}
          </h2>
          <p className="text-[#888892] mb-8 max-w-3xl">
            {t('docs.mpcDesc')}{' '}
            {t('docs.mpcArciumIs')} <strong className="text-white">{t('docs.mpcDescUpgrade')}</strong> {t('docs.mpcDescRest')}
          </p>

          {/* Comparison table */}
          <div className="overflow-x-auto bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] rounded-2xl">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#2a2a30]">
                  <th className="text-left py-3 px-4 text-[#555560] font-mono uppercase tracking-wider text-xs">{t('docs.mpcTableOperation')}</th>
                  <th className="text-left py-3 px-4 text-[#39c5bb] font-mono uppercase tracking-wider text-xs">{t('docs.mpcTableWithout')}</th>
                  <th className="text-left py-3 px-4 text-[#f59e0b] font-mono uppercase tracking-wider text-xs">{t('docs.mpcTableWith')}</th>
                </tr>
              </thead>
              <tbody className="text-[#888892]">
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">{t('docs.mpcRowAmounts')}</td>
                  <td className="py-3 px-4"><CheckCircle className="w-4 h-4 text-[#39c5bb] inline mr-2" />{t('docs.mpcRowAmountsVal')}</td>
                  <td className="py-3 px-4"><CheckCircle className="w-4 h-4 text-[#39c5bb] inline mr-2" />{t('docs.mpcRowAmountsVal')}</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">{t('docs.mpcRowLink')}</td>
                  <td className="py-3 px-4"><CheckCircle className="w-4 h-4 text-[#39c5bb] inline mr-2" />{t('docs.mpcRowLinkVal')}</td>
                  <td className="py-3 px-4"><CheckCircle className="w-4 h-4 text-[#39c5bb] inline mr-2" />{t('docs.mpcRowLinkVal')}</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">{t('docs.mpcRowNullifier')}</td>
                  <td className="py-3 px-4"><Eye className="w-4 h-4 text-[#ff2d7a] inline mr-2" />{t('docs.mpcRowNullifierWithout')}</td>
                  <td className="py-3 px-4"><EyeOff className="w-4 h-4 text-[#f59e0b] inline mr-2" />{t('docs.mpcRowNullifierWith')}</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">{t('docs.mpcRowRelay')}</td>
                  <td className="py-3 px-4"><Eye className="w-4 h-4 text-[#ff2d7a] inline mr-2" />{t('docs.mpcRowRelayWithout')}</td>
                  <td className="py-3 px-4"><EyeOff className="w-4 h-4 text-[#f59e0b] inline mr-2" />{t('docs.mpcRowRelayWith')}</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">{t('docs.mpcRowRegistry')}</td>
                  <td className="py-3 px-4"><Eye className="w-4 h-4 text-[#ff2d7a] inline mr-2" />{t('docs.mpcRowRegistryWithout')}</td>
                  <td className="py-3 px-4"><EyeOff className="w-4 h-4 text-[#f59e0b] inline mr-2" />{t('docs.mpcRowRegistryWith')}</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">{t('docs.mpcRowAudit')}</td>
                  <td className="py-3 px-4"><span className="text-[#555560]">—</span> {t('docs.mpcRowAuditWithout')}</td>
                  <td className="py-3 px-4"><EyeOff className="w-4 h-4 text-[#f59e0b] inline mr-2" />{t('docs.mpcRowAuditWith')}</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">{t('docs.mpcRowVote')}</td>
                  <td className="py-3 px-4"><span className="text-[#555560]">—</span> {t('docs.mpcRowVoteWithout')}</td>
                  <td className="py-3 px-4"><EyeOff className="w-4 h-4 text-[#f59e0b] inline mr-2" />{t('docs.mpcRowVoteWith')}</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 font-medium text-white">{t('docs.mpcRowTrust')}</td>
                  <td className="py-3 px-4 text-[#888892]">{t('docs.mpcRowTrustWithout')}</td>
                  <td className="py-3 px-4 text-[#888892]">{t('docs.mpcRowTrustWith')}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Visual summary */}
          <div className="grid md:grid-cols-2 gap-6 mt-8">
            <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-6 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors">
              <div className="flex items-center gap-3 mb-4">
                <Shield className="w-5 h-5 text-[#39c5bb]" />
                <h3 className="text-lg font-bold text-white">{t('docs.mpcOffTitle')}</h3>
              </div>
              <ul className="space-y-2 text-sm text-[#888892]">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.mpcOffItem1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.mpcOffItem2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.mpcOffItem3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-[#ff2d7a] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.mpcOffItem4')}</span>
                </li>
              </ul>
            </div>
            <div className="bg-white/[0.03] backdrop-blur-sm border border-white/[0.08] p-6 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors">
              <div className="flex items-center gap-3 mb-4">
                <Network className="w-5 h-5 text-[#f59e0b]" />
                <h3 className="text-lg font-bold text-white">{t('docs.mpcOnTitle')}</h3>
              </div>
              <ul className="space-y-2 text-sm text-[#888892]">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#f59e0b] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.mpcOnItem1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#f59e0b] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.mpcOnItem2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#f59e0b] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.mpcOnItem3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#f59e0b] flex-shrink-0 mt-0.5" />
                  <span>{t('docs.mpcOnItem4')}</span>
                </li>
              </ul>
            </div>
          </div>

          <p className="text-xs text-[#555560] mt-6 text-center font-mono">
            {t('docs.mpcFootnote')}
          </p>
        </div>
      </section>

      {/* Quick Links */}
      <section className="py-12 px-4 sm:px-6 lg:px-8 border-t border-[#2a2a30]">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-6">{t('docs.quickNav')}</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {technologies.map((tech) => (
              <a
                key={tech.id}
                href={`#${tech.id}`}
                className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-4 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-[#39c5bb]">{tech.icon}</span>
                  <span className="text-sm text-white font-medium">{t(`docs.sections.${tech.i18nKey}.title`).split(' ')[0]}</span>
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* Design Document Download */}
      <section className="py-8 px-4 sm:px-6 lg:px-8 border-t border-[#2a2a30]">
        <div className="max-w-7xl mx-auto flex items-center justify-center">
          <a
            href="/protocol-01-design-document.pdf"
            download
            className="group flex items-center gap-3 px-5 py-3 border rounded-2xl transition-all duration-300 bg-white/[0.02] backdrop-blur-sm border-white/[0.06] hover:bg-white/[0.05] hover:border-white/[0.12]"
          >
            <FileText className="w-4 h-4 text-[#555560] group-hover:text-[#39c5bb] transition-colors" />
            <div>
              <span className="text-sm text-[#888892] group-hover:text-white transition-colors">
                {t('docs.designDoc')}
              </span>
              <span className="text-xs text-[#555560] ml-2 font-mono">{t('docs.designDocMeta')}</span>
            </div>
            <Download className="w-3.5 h-3.5 text-[#555560] group-hover:text-[#39c5bb] transition-colors" />
          </a>
        </div>
        <p className="text-center text-[10px] text-[#555560] font-mono mt-3 tracking-wider">
          {t('docs.designDocRevision')}
        </p>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#2a2a30] py-8 px-4">
        <div className="max-w-7xl mx-auto text-center space-y-3">
          <div className="flex items-center justify-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-[0.2em] px-2 py-0.5 border border-[#39c5bb]/30 text-[#39c5bb] rounded">
              {t('docs.footerBeta')}
            </span>
            <span className="text-[#2a2a30]">·</span>
            <span className="text-[10px] font-mono text-[#555560] uppercase tracking-wider">
              {t('docs.footerDevnet')}
            </span>
          </div>
          <p className="text-[#555560] text-sm font-mono">
            &copy; {new Date().getFullYear()} PROTOCOL 01 | {t('docs.footerBuilt')}
          </p>
          <p className="text-[10px] text-[#555560]/50 font-mono">
            {t('docs.footerDisclaimer')}
          </p>
        </div>
      </footer>
    </div>
  );
}
