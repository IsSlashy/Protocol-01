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
  Network,
  Download,
  FileText,
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
      "v1: X25519 (Curve25519) for efficiency on Solana",
      "v2: X25519 + ML-KEM-768 (FIPS 203) hybrid ECDH — quantum-resistant",
      "View tags: 1-byte filter enables O(1) scanning without full decryption",
      "On-chain registry (EIP-5564 for Solana) via p01_registry program",
    ],
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
    title: "Zero-Knowledge Proofs (Groth16 + STARK)",
    icon: <Shield className="w-6 h-6" />,
    description:
      "Dual proof system: Groth16 ZK-SNARKs for compact on-chain verification via BN254 pairing, and STARKs (Winterfell) for quantum-resistant proofs over the Goldilocks field. STARKs are hash-based — immune to Shor's algorithm — and are now the default for denominated pool unshielding.",
    details: [
      "6 Groth16 circuits: transfer (12,222c), denominated_pool (4,273c), denominated_transfer (5,628c), confidential_balance (1,382c), balance_proof (644c), subscriber_ownership (~500c)",
      "6 STARK AIRs: subscriber_ownership, pool_commitment, balance_proof, merkle_path, confidential_balance, transfer",
      "STARK: Winterfell prover, Goldilocks field (2^64 - 2^32 + 1), Poseidon AIR (x^7, 30 rounds)",
      "Compact STARK proofs (9-15KB) with Blake3 Merkle trees, 16 FRI queries, 128-bit security",
      "On-chain STARK verifier: custom FRI implementation, ~889K CU per verification",
      "On-chain Groth16: BN254 alt_bn128 pairing precompiles, ~200K CU verification",
      "Mobile WASM STARK prover via WebView (82KB module, all 6 circuits)",
      "Trusted setup: Groth16 with pot20_final.ptau + beacon finalization (ceremony pending 3+ contributors)",
      "Quantum-safe: STARKs are hash-based — immune to both Shor's and Grover's algorithms",
    ],
    codeExample: `// Groth16 proof (BN254, compact, fast verification)
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  { inputs, merkle_path, nullifiers },
  "transfer.wasm", "transfer.zkey"
);

// STARK proof (quantum-resistant, hash-based)
const starkProof = await starkProver.generateProof(secret);
// Upload proof buffer → verify on-chain → ~889K CU
await submitStarkProof(program, proofBuffer, commitment, circuitId);`,
  },
  {
    id: "shielded-pool",
    title: "Shielded Pool & Relayer",
    icon: <Lock className="w-6 h-6" />,
    description:
      "Private transfers go through the relayer. The user generates a ZK proof client-side, funds the relayer, and the relayer executes the transfer to a stealth address. On-chain, only the relayer-to-stealth-address link is visible — the original sender is completely hidden.",
    details: [
      "User generates ZK proof locally — Groth16 or STARK (sender never revealed)",
      "User funds relayer with amount + 0.5% fee + gas",
      "Relayer verifies proof off-chain, then sends to stealth address",
      "On-chain visibility: Relayer → Stealth Address only",
      "Sparse Merkle tree with depth 20 for commitment tracking",
      "Instant shield/unshield (~3s) via filledSubtrees optimization — no full tree sync",
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
      "Operates natively over prime fields (BN254 for Groth16, Goldilocks for STARK)",
      "~300x fewer constraints than Keccak in Circom circuits",
      "Used for commitments, nullifiers, and Merkle tree hashing",
      "Parameters: BN254 (x^5 S-box, 8 full rounds) + Goldilocks (x^7 S-box, 30 full rounds)",
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
      "alt_bn128 syscalls for BN254 Groth16 verification (~200K CU)",
      "Custom FRI verifier for STARK proofs — Goldilocks field (~889K CU)",
      "13 Anchor programs: zk_shielded, zkSPL, specter, subscriptions, streams, quantum_vault, STARK_verifier, registry, relayer, trustless, fee_splitter, whitelist, arcium",
      "Quantum vault: WOTS+ signatures, hash-timelock, commit-then-reveal (SHA-256 based)",
      "Cross-program invocations for token transfers and proof verification",
      "370+ automated tests: stress tests, E2E flows, SDK unit tests, Rust STARK tests",
    ],
    codeExample: `// On-chain Groth16 verification (BN254)
let pairing_result = sol_alt_bn128_pairing(&[...]);
require!(pairing_result == 1, "Invalid Groth16 proof");

// On-chain STARK verification (Goldilocks + Blake3)
let positions = fiat_shamir_positions(trace_root, commitment);
for pos in positions {
    verify_merkle_path(proof, pos, trace_root)?;
    verify_poseidon_round(trace_row, round_constants)?;
}`,
  },
  {
    id: "private-relay",
    title: "On-Chain Relayer (Trustless)",
    icon: <Zap className="w-6 h-6" />,
    description:
      "Fully on-chain relayer program (p01_relayer) that verifies ZK proofs and executes private transfers to stealth addresses. No backend server — the relayer is a Solana program, eliminating trust in any third party.",
    details: [
      "On-chain Solana program — no backend server, fully trustless",
      "User generates ZK proof client-side (spending key never leaves device)",
      "Relayer PDA escrows transfer amount + fee (0.5%) + gas + rent",
      "On-chain verification: proof checked by the program before executing transfer",
      "Sends to stealth address — no on-chain link to the original sender",
      "Local-only proving: snarkjs in WebView (mobile) or browser (extension)",
    ],
    codeExample: `// Trustless on-chain relay flow
// 1. User generates ZK proof locally (spending key stays on device)
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  { inputs, merkle_path, nullifiers },
  "transfer.wasm", "transfer.zkey"
);

// 2. Submit proof to on-chain relayer program
await program.methods.relayTransfer(proof, publicSignals, stealthAddress)
  .accounts({ relayerPda, pool, recipient: stealthAddress })
  .rpc();
// On-chain: relayer verifies proof → transfers to stealth address`,
  },
  {
    id: "arcium-mpc",
    title: "Multi-Party Computation (Arcium)",
    icon: <Network className="w-6 h-6" />,
    description:
      "ZK proofs hide amounts and break the sender-receiver link. But some metadata remains: the relayer sees your transaction, nullifiers are posted in the clear, and registry lookups are observable. Arcium MPC eliminates these residual leaks by distributing every sensitive operation across a decentralized network of nodes — no single node ever sees the plaintext. It is an optional layer that users toggle on for maximum privacy.",
    details: [
      "Nullifier hiding: MPC nodes jointly compute SHA3(nullifier) — only the hash goes on-chain, the actual nullifier stays encrypted",
      "Confidential relay: your transaction is encrypted and split across MPC nodes (Rescue-CTR). They reconstruct and execute it together — no single relayer sees the content",
      "Anonymous registry lookup: query a stealth meta-address through MPC — nobody knows who you looked up",
      "Confidential balance audit: prove solvency to an auditor without revealing individual balances",
      "Threshold stealth scan: your viewing key is sharded across nodes — no single node can scan your payments",
      "Private governance: encrypted ballots tallied inside MPC — only the final result is revealed",
      "Cerberus protocol: 1-of-N honest node guarantees correctness. 9 circuits deployed on Solana devnet",
      "Graceful fallback: every MPC operation degrades to the standard (non-MPC) path when disabled — zero overhead",
    ],
    codeExample: `// @p01/arcium-sdk — MPC confidential compute
import { ArciumClient } from '@p01/arcium-sdk';

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
    id: "denominated-pools",
    title: "Denominated Privacy Pools",
    icon: <Layers className="w-6 h-6" />,
    description:
      "Tornado Cash-style fixed-denomination pools for SOL and USDC. All deposits in a pool are the same value, making them indistinguishable. Epoch-based time delays prevent timing correlation attacks.",
    details: [
      "Fixed denominations: 0.1/1/10/100 SOL or 1/10/100/1000 USDC",
      "Commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)",
      "PDA-per-nullifier for atomic double-spend prevention (not Bloom filter)",
      "Epoch-based maturity: deposit_epoch <= min_epoch enforced in circuit and on-chain",
      "Merkle tree depth 15 = 32,768 notes per pool",
      "Circuit: denominated_pool.circom (4,273 non-linear constraints)",
      "P2P note sharing via BLE and NFC for offline transfers",
    ],
    codeExample: `// Shield into a 1 SOL denominated pool
const commitment = poseidon([nullifierPreimage, secret, epoch, tokenMint]);
await program.methods.shieldDenominated(commitment, epoch)
  .accounts({ pool, depositor, systemProgram })
  .rpc();

// Unshield with STARK proof (quantum-resistant, default)
const starkProof = await starkProver.generateProof(secret);
await program.methods.unshieldDenominatedStark(starkProof, commitment)
  .accounts({ pool, recipient, nullifierPda, starkBuffer })
  .rpc();

// Or with Groth16 proof (classic, faster verification)
const { proof } = await snarkjs.groth16.fullProve(inputs,
  "denominated_pool.wasm", "denominated_pool.zkey");
await program.methods.unshieldDenominated(proof, nullifier, root, minEpoch)
  .rpc();`,
  },
  {
    id: "zkspl",
    title: "Confidential Balances (zkSPL)",
    icon: <Lock className="w-6 h-6" />,
    description:
      "Account-model confidential tokens using Poseidon hash commitments. Unlike UTXO-based shielded pools, zkSPL maintains a single balance commitment per account that updates with each operation. Quantum-resistant by design.",
    details: [
      "Balance commitment = Poseidon(balance, salt, owner_pubkey, token_mint)",
      "Amount commitment = Poseidon(amount, amount_salt) links sender and recipient",
      "Single circuit handles deposit, withdraw, send, and receive operations",
      "Conservation law: old_balance + credits === new_balance + debits",
      "Balance proof: proves balance >= threshold via Num2Bits(64) range check",
      "Circuit: confidential_balance.circom (1,382 constraints)",
      "SDK: @p01/zkspl-sdk with ZkSplClient, ZkSplProver, LocalStateManager",
    ],
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
    title: "Subscription Vaults",
    icon: <Zap className="w-6 h-6" />,
    description:
      "On-chain recurring payment vaults with configurable intervals. Retailers create vaults, subscribers deposit funds, and a crank claims payments each period. Supports both normal (public) and ZK-private subscriber modes.",
    details: [
      "Vault PDA stores: retailer, amount, interval, token mint, subscriber count",
      "Normal mode: subscriber identity visible, straightforward recurring payments",
      "Private mode: ZK proof of subscription ownership without revealing identity",
      "Auto-pause on insufficient funds, resume when topped up",
      "Retailer claim periods with on-chain settlement",
      "Circuit: subscriber_ownership.circom for private subscriber proofs",
    ],
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
    title: "P2P Note Sharing (BLE + NFC)",
    icon: <Eye className="w-6 h-6" />,
    description:
      "Share denominated pool notes between devices offline using Bluetooth Low Energy or NFC. Notes are encrypted end-to-end and can be transferred without internet connectivity.",
    details: [
      "BLE: X25519 ECDH key exchange with nacl.box encryption",
      "NFC: Host Card Emulation (HCE) with PIN-derived nacl.secretbox",
      "Anti-MITM fingerprint verification for BLE connections",
      "Fragmentation protocol for large payloads over BLE characteristics",
      "Native Android modules: BluetoothGattServer + HostApduService",
      "Works offline — no internet or blockchain access needed for transfer",
    ],
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
    title: "Client SDK Architecture",
    icon: <Code className="w-6 h-6" />,
    description:
      "Eight TypeScript SDKs covering every use case: stealth wallets, ZK proofs, confidential tokens, MPC compute, merchant integration, Merkle trees, authentication, and RPC infrastructure. All run client-side for maximum privacy.",
    details: [
      "@p01/specter-sdk — Core privacy: stealth wallets, transfers, quantum vault, registry, indexer",
      "@p01/zk-sdk — ZK primitives: ShieldedClient, Note, MerkleTree, ZkProver, viewing keys",
      "@p01/zkspl-sdk — Confidential tokens: deposit, withdraw, transfer, balance proof",
      "@p01/arcium-sdk — MPC compute: ArciumClient, 6 use-case modules, Rescue cipher",
      "@p01/p01-js — Merchant SDK: Protocol01 client, subscriptions, payments, React components",
      "@p01/privacy-toolkit — Incremental Merkle tree, Poseidon, amount hash, proof format",
      "@p01/auth-sdk — Auth integration: P01AuthClient, P01AuthServer, session management",
      "@p01/rpc-config — RPC infrastructure: connection manager, priority fallback chain, URL sanitization",
    ],
    codeExample: `// === @p01/specter-sdk — Core Privacy SDK ===
import { P01Client, createWallet, sendPrivate } from '@p01/specter-sdk';
const client = new P01Client({ cluster: 'devnet' });
await sendPrivate({ amount: 1.5, recipient: stealthMetaAddress });

// === @p01/zk-sdk — ZK Shielded Pool ===
import { ShieldedClient } from '@p01/zk-sdk';
const zkClient = new ShieldedClient({ rpcUrl, programId });
await zkClient.shield(1_000_000_000n, notes);

// === @p01/zkspl-sdk — Confidential Balances ===
import { ZkSplClient } from '@p01/zkspl-sdk';
await zkspl.deposit(amount, proof);   // Public → confidential
await zkspl.send(amount, recipient);  // Confidential transfer

// === @p01/arcium-sdk — MPC Compute ===
import { ArciumClient } from '@p01/arcium-sdk';
await mpc.commitNullifier(preimage);  // SHA3 via MPC nodes

// === @p01/p01-js — Merchant Integration ===
import { Protocol01 } from '@p01/p01-js';
await p01.createSubscription({ amount: 9.99, interval: 'monthly' });

// === @p01/privacy-toolkit — Merkle + Poseidon ===
import { IncrementalMerkleTree, poseidon2 } from '@p01/privacy-toolkit';

// === @p01/auth-sdk — Auth Integration ===
import { P01AuthClient } from '@p01/auth-sdk';

// === @p01/rpc-config — RPC Infrastructure ===
import { RpcConnectionManager } from '@p01/rpc-config';
const conn = RpcConnectionManager.getConnection(); // Auto-fallback chain`,
  },
  {
    id: "auto-shield",
    title: "Auto-Shield Receive",
    icon: <Shield className="w-6 h-6" />,
    description:
      "When receiving funds, the app generates a one-time stealth address instead of exposing the main wallet. Incoming funds are automatically detected and shielded into the privacy pool — the main wallet is never visible to senders.",
    details: [
      "Receive screen generates fresh stealth addresses (HMAC-derived from viewing secret key)",
      "Autonomous runner polls every 5 minutes for incoming funds on stealth addresses",
      "When balance detected (>0.05 SOL), auto-shields to the best matching denomination pool",
      "Main wallet NEVER appears on-chain for incoming transfers",
      "Stealth receive addresses tracked in SecureStore with cleanup after 7 days",
      "Settings toggle in Privacy Settings to enable/disable auto-shielding",
      "Compatible with any Solana wallet sender — no Protocol 01 required on sender side",
    ],
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
    id: "tor-relay",
    title: "Privacy Relay (Tor Routing)",
    icon: <Network className="w-6 h-6" />,
    description:
      "All RPC calls from the mobile app are routed through a 3-tier privacy relay. The relay strips identifying headers, adds timing jitter, and routes through Tor — upstream RPC providers never see the user's real IP address.",
    details: [
      "Tier 1 (Client): fetchMiddleware strips User-Agent, Origin, Referer + adds 30-120ms jitter",
      "Tier 2 (Relay): Express server with HMAC rate limiter (zero IP storage), security headers, metadata stripping",
      "Tier 3 (Tor): SOCKS5 proxy with circuit rotation every 10 minutes via random authentication",
      "Deployed on Railway — single container (Node 22 Alpine + Tor sidecar)",
      "Supports batch JSON-RPC forwarding for getParsedTransactions",
      "Helius RPC upstream via Tor — API key hidden, IP anonymized",
      "Fallback: app works without relay (Tier 1 client-side protection always active)",
      "13K+ requests tested with 100% Tor routing and 0 errors",
    ],
    codeExample: `// 3-tier privacy architecture
// Tier 1: Client-side (always active)
const connection = new Connection(relayUrl, {
  fetchMiddleware: privacyFetchMiddleware, // Strip headers + jitter
});

// Tier 2: Relay server (Railway)
app.use(stripMetadata);     // 20+ headers removed
app.use(securityHeaders);   // HSTS, CSP, no-referrer
app.use(rateLimiter);       // HMAC-hashed IP (zero storage)

// Tier 3: Tor SOCKS5
const agent = new SocksProxyAgent("socks5h://tor:9050");
// Circuit rotates every 10min via random SOCKS auth`,
  },
  {
    id: "stealth-meta-addresses",
    title: "Stealth Meta-Addresses (P01-to-P01)",
    icon: <Key className="w-6 h-6" />,
    description:
      "For P01-to-P01 transfers, users share a persistent stealth meta-address (st:01...). The sender's Private Send auto-derives a fresh one-time stealth destination — both sender AND receiver are fully hidden on-chain.",
    details: [
      "Meta-address format: st:01<base58(spending_ed25519_pub + viewing_x25519_pub)>",
      "v2 hybrid: st:02<base58(spending + viewing + ML-KEM-768 pub)> — quantum-resistant",
      "Persistent stealth keys (Ed25519 + X25519) stored in SecureStore",
      "Private Send detects meta-addresses and auto-derives stealth destination",
      "QR scanner auto-detects st:01/st:02 and routes to Private Send",
      "On-chain trail: stealth_sender → pool → stealth_receiver (no real wallet visible)",
      "Receive screen shows compact 'Copy P01 ID' for easy sharing",
    ],
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
    title: "Cross-Pool Note Splitting",
    icon: <GitBranch className="w-6 h-6" />,
    description:
      "Split a high-denomination note into multiple lower-denomination notes across pools. Enables the Privacy Router to break large amounts into smaller, harder-to-trace pieces with a single ZK proof.",
    details: [
      "On-chain instruction: split_note in zk_shielded program (deployed on devnet)",
      "Circuit: note_split.circom (~10K constraints, max 20 outputs)",
      "Denomination conservation enforced: source = numOutputs × target",
      "Same nullifier PDA pattern as unshield (atomic double-spend prevention)",
      "Protocol fee: 0.3% of source denomination",
      "Groth16 proof verifies ownership + output commitment correctness",
      "Mobile SDK: splitNote() function with proofGenerator callback",
    ],
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
    title: "Multi-Hop Privacy Router",
    icon: <Zap className="w-6 h-6" />,
    description:
      "The Privacy Router plans and executes multi-hop routes through the privacy pool system. Routes include shield, unshield, reshield, and split operations with configurable timing delays to maximize anonymity.",
    details: [
      "5 privacy levels: Minimal (1 hop) → Paranoid (14+ hops, 20 splits)",
      "Autonomous runner executes hops in background (60s polling, Android foreground service)",
      "Timing jitter: random delays between hops (hours) prevent correlation",
      "Note locking: notes in active routes are locked (cannot withdraw or re-send)",
      "Consent popup: irreversibility warning before route starts",
      "Route progress: locked notes show hop X/Y, progress bar, next hop ETA",
      "Routes encrypted in SecureStore, survive app restarts",
      "In-app notification on each hop completion",
    ],
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
    title: "AI Agent (56 Tools)",
    icon: <Cpu className="w-6 h-6" />,
    description:
      "On-device AI agent with 56 tools covering wallet operations, privacy actions, Solana network queries, DeFi analytics, and device features. Runs locally (Gemma 3 via llama.rn) — no data leaves the device.",
    details: [
      "Wallet (6): balance, address, send, history, airdrop, stealth receive",
      "Privacy (5): shield, notes list, private send, route status, privacy level",
      "Solana (6): slot, epoch, TPS, tx lookup, account info, rent calculator",
      "Token/DeFi (6): token balance, swap quote, swap execute, TVL, lending rates, portfolio",
      "Analytics (3): gas tracker, whale watch, market dominance",
      "Staking (3): stake info, APY, validators",
      "NFT (2): list NFTs, floor price",
      "Social (2): protocol info, trending tokens",
      "Conversion (3): SOL/USD, SOL/lamports, epoch/date",
      "Device (3): share, haptic, notification",
      "Alerts (3): set price alert, list alerts, clear alerts",
      "Utility (4): calculate, validate address, base58 encode, generate keypair",
      "Memory (3): save, read, list persistent agent memory",
      "Tool-use loop: up to 3 rounds of tool execution per message",
    ],
    codeExample: `// User: "What's my balance and shield 0.1 SOL"
// Agent calls tools:
const balance = await executeTool("wallet_balance", {});
// → { sol: "3.69", usd: "$520.13" }

// Agent responds and calls shield tool:
await executeTool("privacy_shield", { amount: 0.1 });
// → Redirects to Privacy → Shield screen`,
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
      { label: "@p01/specter-sdk", sub: "Stealth & Wallets" },
      { label: "@p01/zk-sdk", sub: "Groth16 + STARK Prover" },
      { label: "@p01/zkspl-sdk", sub: "Confidential Balances" },
      { label: "@p01/arcium-sdk", sub: "MPC Compute" },
      { label: "@p01/p01-js", sub: "Merchant SDK" },
      { label: "@p01/privacy-toolkit", sub: "Merkle + Poseidon" },
      { label: "@p01/auth-sdk", sub: "Auth Integration" },
      { label: "@p01/rpc-config", sub: "RPC Fallback Chain" },
    ],
  },
  {
    name: "Protocol Layer",
    hex: "#00ffe5",
    nodes: [
      { label: "STEALTH", sub: "ECDH Addresses" },
      { label: "SHIELDED", sub: "ZK Pool + Merkle Tree" },
      { label: "DENOMINATED", sub: "Fixed-Denom Pools" },
      { label: "zkSPL", sub: "Confidential Balances" },
      { label: "PAYMENTS", sub: "Streams & Subscriptions" },
      { label: "VAULTS", sub: "Subscription Vaults" },
      { label: "MPC", sub: "Arcium Cerberus" },
    ],
  },
  {
    name: "Verification Layer",
    hex: "#ff77a8",
    nodes: [
      { label: "ON-CHAIN RELAYER", sub: "Trustless ZK Relay" },
      { label: "STARK VERIFIER", sub: "FRI + Goldilocks" },
      { label: "QUANTUM VAULT", sub: "WOTS+ / Hash-Timelock" },
      { label: "CRANK", sub: "Auto Subscription Payments" },
    ],
  },
  {
    name: "Solana Blockchain",
    hex: "#ffcc00",
    nodes: [
      { label: "13 PROGRAMS", sub: "Anchor 0.32.1 / Rust" },
      { label: "SPL Tokens", sub: "Token Standard" },
      { label: "alt_bn128 + FRI", sub: "ZK Verification" },
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
              <div className={`grid gap-2 sm:gap-3 ${layer.nodes.length === 2 ? 'grid-cols-2' : layer.nodes.length === 4 ? 'grid-cols-2 sm:grid-cols-4' : layer.nodes.length >= 5 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-3'}`}>
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

function TechAccordion({ tech, index }: { tech: TechSection; index: number }) {
  const [open, setOpen] = React.useState(false);

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
          <h3 className="text-base font-bold text-white">{tech.title}</h3>
          <p className="text-xs text-[#888892] mt-0.5 truncate">{tech.description}</p>
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
          <p className="text-[#888892] text-sm leading-relaxed mb-4">{tech.description}</p>

          <h4 className="text-xs font-bold text-[#39c5bb] uppercase tracking-wider mb-3">
            Key Features
          </h4>
          <ul className="space-y-1.5 mb-5">
            {tech.details.map((detail, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-[#888892]">
                <CheckCircle className="w-3.5 h-3.5 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                <span className="break-words">{detail}</span>
              </li>
            ))}
          </ul>

          {tech.codeExample && (
            <>
              <h4 className="text-xs font-bold text-[#ff77a8] uppercase tracking-wider mb-2">
                Code Example
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
  return (
    <div className="min-h-screen bg-[#0a0a0c]" style={{ wordWrap: 'break-word', overflowWrap: 'break-word' }}>
      {/* Header — sticky nav */}
      <header className="border-b border-[#2a2a30] bg-[#0a0a0c]/90 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
          <div className="flex items-center justify-between">
            <Link href="/" className="flex items-center gap-3 group">
              <div className="w-8 h-8 bg-[#39c5bb]/10 border border-[#39c5bb]/30 flex items-center justify-center group-hover:border-[#39c5bb]/60 transition-colors">
                <span className="text-[#39c5bb] font-mono font-bold text-[10px]">P01</span>
              </div>
              <div className="hidden sm:flex items-center gap-2">
                <span className="text-sm font-bold text-white tracking-wider">PROTOCOL 01</span>
                <span className="text-[#555560]">/</span>
                <span className="text-sm font-mono text-[#39c5bb] tracking-wider">DOCS</span>
              </div>
              <span className="sm:hidden text-sm font-mono text-[#39c5bb] tracking-wider">DOCS</span>
            </Link>
            <div className="flex items-center gap-4">
              <Link href="/roadmap" className="hidden sm:flex text-xs font-mono text-[#555560] hover:text-[#888892] transition-colors uppercase tracking-wider">
                Roadmap
              </Link>
              <Link href="/#download" className="hidden sm:flex text-xs font-mono text-[#555560] hover:text-[#888892] transition-colors uppercase tracking-wider">
                Download
              </Link>
              <Link
                href="/"
                className="flex items-center gap-1.5 text-sm text-[#888892] hover:text-[#39c5bb] transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Home</span>
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
              <span className="text-xs font-mono text-[#39c5bb] uppercase tracking-widest">Technical Documentation</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-5 tracking-tight">
              Privacy{" "}
              <span className="bg-gradient-to-r from-[#39c5bb] to-[#00ffe5] bg-clip-text text-transparent">
                Technologies
              </span>
            </h1>

            <p className="text-base sm:text-lg text-[#888892] max-w-2xl mx-auto leading-relaxed mb-8">
              Zero-knowledge proofs, multi-party computation, and post-quantum cryptography — delivering true financial privacy on Solana.
            </p>

            {/* Quick stats */}
            <div className="flex flex-wrap items-center justify-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-[#39c5bb]" />
                <span className="text-[#888892]"><span className="text-white font-bold">6</span> ZK Circuits</span>
              </div>
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[#ff77a8]" />
                <span className="text-[#888892]"><span className="text-white font-bold">13</span> Programs</span>
              </div>
              <div className="flex items-center gap-2">
                <Code className="w-4 h-4 text-[#00ffe5]" />
                <span className="text-[#888892]"><span className="text-white font-bold">8</span> SDKs</span>
              </div>
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-[#ffcc00]" />
                <span className="text-[#888892]"><span className="text-white font-bold">22</span> Modules</span>
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
            System Architecture
          </h2>
          <ArchitectureDiagram />
        </div>
      </section>

      {/* Technologies — Collapsible Accordion */}
      <section className="py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-3">
            <Zap className="w-6 h-6 text-[#ff77a8]" />
            Core Technologies
          </h2>
          <p className="text-[#888892] mb-8 text-sm">
            {technologies.length} modules — click to expand technical details and code examples.
          </p>

          <div className="space-y-2">
            {technologies.map((tech, index) => (
              <TechAccordion key={tech.id} tech={tech} index={index} />
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
            <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-6 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors">
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
            <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-6 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors">
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
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>MPC threshold: 1-of-N honest node via Arcium Cerberus protocol</span>
                </li>
              </ul>
            </div>
          </div>

          {/* Security Hardening */}
          <div className="mt-6 bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-6 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors">
            <h3 className="text-lg font-bold text-white mb-4">Security Hardening (Mobile)</h3>
            <div className="grid md:grid-cols-3 gap-4 text-sm text-[#888892]">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>Spending key never leaves device — no remote prover fallback</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>PIN: SHA-256 hashed with per-device salt, constant-time compare</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>Progressive lockout: 5→30s, 8→60s, 10→300s</span>
                </li>
              </ul>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>All secrets in hardware-backed SecureStore (not AsyncStorage)</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>Clipboard auto-clear after 60s on all sensitive copies</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>App switcher blur prevents screenshot leaks</span>
                </li>
              </ul>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>android:allowBackup=&quot;false&quot; (prevents adb backup)</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>Biometric auth: device fallback when hardware unavailable</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>Lock screen enforced even when security_method=&quot;none&quot;</span>
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
            Privacy: With &amp; Without MPC
          </h2>
          <p className="text-[#888892] mb-8 max-w-3xl">
            Protocol 01 is private by default — ZK proofs hide amounts and break the sender-receiver link.
            Arcium MPC is an <strong className="text-white">optional upgrade</strong> that eliminates the remaining metadata leaks.
            Toggle it on in the app for maximum privacy, or leave it off for fast, already-private transactions.
          </p>

          {/* Comparison table */}
          <div className="overflow-x-auto bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] rounded-2xl">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#2a2a30]">
                  <th className="text-left py-3 px-4 text-[#555560] font-mono uppercase tracking-wider text-xs">Operation</th>
                  <th className="text-left py-3 px-4 text-[#39c5bb] font-mono uppercase tracking-wider text-xs">Without MPC</th>
                  <th className="text-left py-3 px-4 text-[#f59e0b] font-mono uppercase tracking-wider text-xs">With MPC (Arcium)</th>
                </tr>
              </thead>
              <tbody className="text-[#888892]">
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">Amounts</td>
                  <td className="py-3 px-4"><CheckCircle className="w-4 h-4 text-[#39c5bb] inline mr-2" />Hidden by ZK proof</td>
                  <td className="py-3 px-4"><CheckCircle className="w-4 h-4 text-[#39c5bb] inline mr-2" />Hidden by ZK proof</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">Sender → Receiver link</td>
                  <td className="py-3 px-4"><CheckCircle className="w-4 h-4 text-[#39c5bb] inline mr-2" />Broken by stealth addresses</td>
                  <td className="py-3 px-4"><CheckCircle className="w-4 h-4 text-[#39c5bb] inline mr-2" />Broken by stealth addresses</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">Nullifier</td>
                  <td className="py-3 px-4"><Eye className="w-4 h-4 text-[#ff2d7a] inline mr-2" />Posted in the clear on-chain</td>
                  <td className="py-3 px-4"><EyeOff className="w-4 h-4 text-[#f59e0b] inline mr-2" />MPC nodes compute SHA3 jointly — only hash on-chain</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">Relay</td>
                  <td className="py-3 px-4"><Eye className="w-4 h-4 text-[#ff2d7a] inline mr-2" />On-chain relayer sees TX content</td>
                  <td className="py-3 px-4"><EyeOff className="w-4 h-4 text-[#f59e0b] inline mr-2" />TX split &amp; encrypted — no single node sees plaintext</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">Registry lookup</td>
                  <td className="py-3 px-4"><Eye className="w-4 h-4 text-[#ff2d7a] inline mr-2" />RPC query reveals search target</td>
                  <td className="py-3 px-4"><EyeOff className="w-4 h-4 text-[#f59e0b] inline mr-2" />Query goes through MPC — target stays anonymous</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">Balance audit</td>
                  <td className="py-3 px-4"><span className="text-[#555560]">—</span> Not available</td>
                  <td className="py-3 px-4"><EyeOff className="w-4 h-4 text-[#f59e0b] inline mr-2" />Prove solvency without revealing individual balances</td>
                </tr>
                <tr className="border-b border-[#2a2a30]/50">
                  <td className="py-3 px-4 font-medium text-white">Governance vote</td>
                  <td className="py-3 px-4"><span className="text-[#555560]">—</span> Not available</td>
                  <td className="py-3 px-4"><EyeOff className="w-4 h-4 text-[#f59e0b] inline mr-2" />Encrypted ballots — only final tally revealed</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 font-medium text-white">Trust assumption</td>
                  <td className="py-3 px-4 text-[#888892]">Relayer is honest (can't steal, can observe)</td>
                  <td className="py-3 px-4 text-[#888892]">1-of-N honest node (Cerberus protocol)</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Visual summary */}
          <div className="grid md:grid-cols-2 gap-6 mt-8">
            <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-6 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors">
              <div className="flex items-center gap-3 mb-4">
                <Shield className="w-5 h-5 text-[#39c5bb]" />
                <h3 className="text-lg font-bold text-white">MPC Off — Already Private</h3>
              </div>
              <ul className="space-y-2 text-sm text-[#888892]">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>STARK &amp; Groth16 proofs hide amounts and ownership</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>Stealth addresses make every payment unlinkable</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>Denominated pools prevent amount-based correlation</span>
                </li>
                <li className="flex items-start gap-2">
                  <Eye className="w-4 h-4 text-[#ff2d7a] flex-shrink-0 mt-0.5" />
                  <span>Some metadata visible: nullifiers, relay content, lookup targets</span>
                </li>
              </ul>
            </div>
            <div className="bg-white/[0.03] backdrop-blur-sm border border-white/[0.08] p-6 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors">
              <div className="flex items-center gap-3 mb-4">
                <Network className="w-5 h-5 text-[#f59e0b]" />
                <h3 className="text-lg font-bold text-white">MPC On — Maximum Privacy</h3>
              </div>
              <ul className="space-y-2 text-sm text-[#888892]">
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#f59e0b] flex-shrink-0 mt-0.5" />
                  <span>Everything above, plus all metadata leaks eliminated</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#f59e0b] flex-shrink-0 mt-0.5" />
                  <span>Nullifiers encrypted — only SHA3 hash reaches the chain</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#f59e0b] flex-shrink-0 mt-0.5" />
                  <span>Relay is threshold-decrypted — no single point of observation</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#f59e0b] flex-shrink-0 mt-0.5" />
                  <span>Unlocks balance audits, private voting, threshold stealth scan</span>
                </li>
              </ul>
            </div>
          </div>

          <p className="text-xs text-[#555560] mt-6 text-center font-mono">
            MPC adds ~1-2s per operation · Zero overhead when disabled · Toggle on/off in Privacy Zone
          </p>
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
                className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-4 rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-colors"
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
                Design & Architecture Document
              </span>
              <span className="text-xs text-[#555560] ml-2 font-mono">PDF · 17 pages</span>
            </div>
            <Download className="w-3.5 h-3.5 text-[#555560] group-hover:text-[#39c5bb] transition-colors" />
          </a>
        </div>
        <p className="text-center text-[10px] text-[#555560] font-mono mt-3 tracking-wider">
          PROGRESSIVELY UPDATED · LAST REVISION MARCH 2026
        </p>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#2a2a30] py-8 px-4">
        <div className="max-w-7xl mx-auto text-center space-y-3">
          <div className="flex items-center justify-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-[0.2em] px-2 py-0.5 border border-[#39c5bb]/30 text-[#39c5bb] rounded">
              Beta
            </span>
            <span className="text-[#2a2a30]">·</span>
            <span className="text-[10px] font-mono text-[#555560] uppercase tracking-wider">
              Devnet Only
            </span>
          </div>
          <p className="text-[#555560] text-sm font-mono">
            &copy; {new Date().getFullYear()} PROTOCOL 01 | Built from scratch for privacy
          </p>
          <p className="text-[10px] text-[#555560]/50 font-mono">
            This software is in active development. Not audited. Use at your own risk.
          </p>
        </div>
      </footer>
    </div>
  );
}
