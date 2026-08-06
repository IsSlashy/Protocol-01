"use client";

import React, { useState, useEffect, useMemo } from "react";
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
  CheckCircle,
  Download,
  FileText,
  Archive,
  Menu,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import Sidebar, { type ResolvedGroup } from "@/components/docs/Sidebar";
import TopicToc, { type TocItem } from "@/components/docs/TopicToc";
import DocsSearch, { type SearchItem } from "@/components/docs/DocsSearch";
import { NAV_GROUPS, TOPIC_ORDER, SPECIAL_TITLE_KEYS } from "@/components/docs/nav";
import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";

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
    // 10th detail added 2026-08-06: it states why no bit-level security figure
    // appears here. Deleting the old "124-bit" claim without saying anything
    // would read as an oversight rather than a measurement.
    detailCount: 10,
    codeExample: `// STARK proof (quantum-resistant, hash-based, no trusted setup)
const starkProof = await starkProver.generateProof(secret);

// Upload proof buffer → on-chain FRI verifier → 809,812 CU measured
await submitStarkProof(program, proofBuffer, commitment, circuitId);
// 7 AIRs over the Goldilocks field. DEEP-ALI quotient check at the OOD
// point is implemented (programs/p01_stark_verifier/src/verify.rs:670-673).
// No soundness bit-count is published here. The one this line used to
// carry came from "queries x log2(blowup)", arithmetic that was measured
// to be wrong for this FRI configuration, and no measured figure has
// replaced it. Do not reinstate a bit-count without one.
// Replaces legacy Groth16/BN254 (see "Legacy / Migration History")`,
  },
  {
    id: "shielded-pool",
    i18nKey: "shieldedPool",
    icon: <Lock className="w-6 h-6" />,
    detailCount: 7,
    codeExample: `// Shielded pool flow (v1.0.2 — STARK V3, quantum-safe)
// 1. User generates a STARK proof locally (no remote prover)
const starkProof = await starkProver.generateProof(noteInputs);

// 2. Optional: instant path via p01_liquidity prefund so the user
//    doesn't have to front ~0.85 SOL of proof-buffer rent
await liquidity.prefund({ ephemeralSigner, proofBuffer, amount });

// 3. Buffer verifies on-chain → funds release to a one-time
//    recipient. The unshield transaction itself names an ephemeral
//    signer and that one-time recipient, not the user's wallet.
const tx = await unshieldDenominatedStark({ proofBuffer, stealthRecipient });

// WHAT THIS DOES NOT HIDE. The wallet pre-funds the ephemeral signer in
// a public transfer one hop earlier, so an observer sees
// "wallet -> ephemeral" and then "ephemeral -> one-time recipient" a
// minute apart for a distinctive amount. And the unshield republishes
// the note commitment the DEPOSIT published, so the exit is publicly
// matchable to the deposit (measured on devnet: leaf 16, commitment
// 8901821612542787864, present in both transactions). The anonymity set
// is 1 until the C7 spend circuit ships.`,
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
    codeExample: `// v1.0.2 — Every spend verifies through the custom on-chain
// FRI verifier (no Winterfell dep, Goldilocks + Blake3, 809,812 CU).
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
    codeExample: `// Trustless on-chain relay flow (v1.0.2 — STARK V3)
//
// WHICH CLIENTS ACTUALLY RELAY. Mobile does. The web app does not: /app
// submits every transaction straight from the browser, including the
// ~280 proof-buffer chunk transactions, each under the same ephemeral
// key whose pubkey seeds the buffer PDAs. Relaying only the final
// transaction would buy nothing while those chunks are self-submitted,
// so it was deliberately not done.
//
// WHAT THE RELAYER HIDES WHEN IT IS USED. The IP address and the outer
// fee payer. Not the signer: the inner transaction is signed with the
// user's key BEFORE it is encrypted to the relayer, so the relayer
// cannot rewrite the signer set and the user's key is still in the
// transaction that lands on chain.
//
// 1. Client generates a STARK proof locally via the WASM prover
//    (spending key stays on device; no remote prover fallback)
const starkProof = await starkProver.generateProof({
  secret, nullifierPreimage, merklePath, pathIndices,
});

// 2. Upload the proof to a buffer account (~120 KB, ~9–15 KB compact)
//    then call the on-chain FRI verifier (no Winterfell dep,
//    custom Goldilocks + Blake3 implementation, 809,812 CU measured)
await submitStarkProof(program, proofBuffer, circuitId);

// 3. Instruction reads the verified buffer and releases funds
//    to a one-time stealth recipient (ECDH + ML-KEM-768 hybrid)
await program.methods.unshieldDenominatedStark(...)
  .accounts({ pool, recipient: stealthAddress, nullifierPda })
  .rpc();
// Legacy snarkjs.groth16 path fully retired — see Migration History`,
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
    codeExample: `// Shield: the deposit is signed by an ephemeral, not by the wallet.
// The wallet is still what funds that ephemeral, in the clear, on the
// line above the deposit — so the wallet is one public hop away, not
// removed. (SOL only. USDC deposits still use the wallet directly:
// the ephemeral has no funded token account.)
const stealthKp = deriveStealthSigner(wallet, timestamp);
await fundStealth(wallet, stealthKp, 0.1); // <- public: wallet -> ephemeral
await program.methods.shieldDenominated(commitment, epoch)
  .accounts({ pool, depositor: stealthKp.publicKey })
  .signers([stealthKp]).rpc();

// Unshield: ephemeral signer + a one-time recipient.
// The wallet is not the signer, the fee payer, or the payee of THIS
// transaction. It is not absent from the flow: it pre-funded the
// ephemeral, and on web the withdrawal explicitly refuses to pay the
// wallet that pre-funded it, so the funds land on a derived payout
// address the user moves on separately, when they choose to.
const signer = deriveEphemeralSigner();
const recipient = derivePayoutAddress(root, pool, leafIndex); // per-note
await program.methods.unshieldDenominatedStark(starkProof)
  .accounts({ pool, recipient: recipient.address, nullifierPda })
  .signers([signer]).rpc();

// Deposit and withdrawal are NOT unlinkable. The withdrawal publishes
// the same note commitment the deposit published, so the two are
// publicly matchable by anyone. Fixed denominations remove the amount
// as a distinguisher; they do not break that link. The mobile client
// also sweeps the one-time recipient to the wallet a few seconds later,
// which is a convenience, not decorrelation.`,
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
    codeExample: `// The subscriber opens the vault, funded from a note already in the
// denominated pool. There is no retailer-side init and no wallet-keyed
// variant: the vault PDA is seeded on subscriberCommitment, so the
// address does not name the payer. That commitment is a caller-supplied
// label, NOT proof-bound on chain — the client is what keeps a wallet
// pubkey out of it.
await program.methods.subscribePrivateStark(
  nullifier,             // [u8;32] spends the funding note
  merkleRoot,            // [u8;32] pool root the note is proven against
  minEpoch,              // u64
  subscriberCommitment,  // [u8;32] PDA seed — never the wallet
  rate,                  // u64 per-period amount
  intervalSlots,         // u64 slots between periods
  vkHashSubscriber,      // [u8;32]
  starkCommitment,       // u64
  licenseCommitment      // Option<[u8;32]>, or null — LAST arg
).accounts({
  payer, retailer, vault, denominatedPool, merkleTree,
  nullifierRecord, c1ProofBuffer, c3ProofBuffer, systemProgram,
}).rpc();

// Anyone can push the claim — the program pays vault.retailer and
// nobody else, so no signature from the merchant is required.
await program.methods.claimPeriod()
  .accounts({ retailer, vault, systemProgram })
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
    // 8 -> 10: the arcium-sdk entry was replaced by stark-prover, and the two
    // packages the list never had (privacy-sdk, merchant-sdk) were added.
    detailCount: 10,
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
  // The deposit is signed by the stealth keypair, so the main wallet is
  // not the depositor on this path. It is only absent while the funds
  // never touch it: the wallet still appears the moment it tops the
  // stealth address up, and the later withdrawal republishes this
  // deposit's commitment either way.
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
  // The RECEIVER is hidden: the payee on-chain is a fresh one-time
  // address that nothing links back to the meta-address.
  // The SENDER is not. The transfer is signed and fee-paid by the
  // sender's own wallet, so the sender and the amount are both public.
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
// → Each hop uses a different stealth address
//
// What the hops buy today is time and address churn, NOT an unlinkable
// path: every unshield republishes the commitment of the deposit it
// spends, so each hop can be matched to the one before it by commitment
// alone. The chain of hops is walkable until the C7 spend circuit
// removes that republication.`,
  },
  {
    id: "ai-agent",
    i18nKey: "aiAgent",
    icon: <Cpu className="w-6 h-6" />,
    // The per-category counts used to sum to 49 against a headline of 56: the
    // web, price, clipboard and datetime tools had no category. They do now,
    // and the thirteen categories add up to the 56 in AGENT_TOOLS.
    detailCount: 15,
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

/**
 * Circuit ids the deployed verifier accepts, counted from the source of truth:
 * `get_circuit_config` in programs/p01_stark_verifier/src/compact_proof.rs maps
 * 0..=6 and returns None above that, and `boundary_assertions_reject_unknown_circuit`
 * pins the rejection for 7, 8, 100 and 255. One AIR module each in stark/src/air/.
 */
const STARK_CIRCUIT_COUNT = 7;

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
    // The ten packages published under @protocol-01 that are part of the current
    // stack. @protocol-01/arcium-sdk is also on npm but is NOT here: Arcium was
    // removed from Protocol 01 on 2026-07-17, same reason the MPC node was
    // dropped from the protocol layer below.
    nodes: [
      { labelKey: "docs.nodePrivacySdk", subKey: "docs.nodePrivacySdkSub" },
      { labelKey: "docs.nodeSpecterSdk", subKey: "docs.nodeSpecterSub" },
      { labelKey: "docs.nodeZkSdk", subKey: "docs.nodeZkSub" },
      { labelKey: "docs.nodeStarkProver", subKey: "docs.nodeStarkProverSub" },
      { labelKey: "docs.nodeZksplSdk", subKey: "docs.nodeZksplSub" },
      { labelKey: "docs.nodeMerchantSdk", subKey: "docs.nodeMerchantSdkSub" },
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
      // "MPC / Arcium Cerberus" node removed 2026-07-27 — Arcium is not part of
      // Protocol 01 any more. See the note on `guarantees` in SecurityTopic.
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

// A single technology rendered as a full docs topic (always open).
function TechTopic({ tech, t }: { tech: TechSection; t: (key: string) => string }) {
  const title = t(`docs.sections.${tech.i18nKey}.title`);
  const description = t(`docs.sections.${tech.i18nKey}.desc`);
  const details = Array.from({ length: tech.detailCount }, (_, i) =>
    t(`docs.sections.${tech.i18nKey}.detail${i + 1}`),
  );

  return (
    <article>
      <div className="flex items-center gap-4 mb-5">
        <div className="w-12 h-12 bg-[#39c5bb]/10 border border-[#39c5bb]/30 rounded-xl flex items-center justify-center text-[#39c5bb] shrink-0">
          {tech.icon}
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">{title}</h1>
      </div>

      <section id={`${tech.id}-overview`} className="scroll-mt-24">
        <p className="text-[#888892] leading-relaxed mb-8">{description}</p>
      </section>

      <section id={`${tech.id}-features`} className="scroll-mt-24 mb-8">
        <h2 className="text-xs font-bold text-[#39c5bb] uppercase tracking-wider mb-3">
          {t('docs.keyFeatures')}
        </h2>
        <ul className="space-y-2">
          {details.map((detail, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-[#888892]">
              <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
              <span className="break-words">{detail}</span>
            </li>
          ))}
        </ul>
      </section>

      {tech.codeExample && (
        <section id={`${tech.id}-code`} className="scroll-mt-24">
          <h2 className="text-xs font-bold text-[#ff77a8] uppercase tracking-wider mb-2">
            {t('docs.codeExample')}
          </h2>
          <pre className="bg-[#0a0a0c] border border-[#2a2a30] p-4 rounded-xl overflow-x-auto text-xs font-mono text-[#888892] whitespace-pre-wrap break-words">
            {tech.codeExample}
          </pre>
        </section>
      )}
    </article>
  );
}

// ── Special (non-technologies) topics ──────────────────────────
function ArchitectureTopic({ t }: { t: (k: string) => string }) {
  return (
    <article>
      <h1 className="text-2xl sm:text-3xl font-bold text-white mb-3 tracking-tight">
        {t('docs.heroTitle1')}{' '}
        <span className="bg-gradient-to-r from-[#39c5bb] to-[#00ffe5] bg-clip-text text-transparent">
          {t('docs.heroTitle2')}
        </span>
      </h1>
      <p className="text-[#888892] leading-relaxed max-w-2xl mb-6">{t('docs.heroSubtitle')}</p>
      <div className="flex flex-wrap items-center gap-5 text-sm mb-10">
        {/* Every number here is counted from the tree, not carried over from an
            older revision:
              7  = circuit ids the on-chain verifier accepts (0..6; 7+ returns
                   UnsupportedCircuit), one AIR module each in stark/src/air/.
                   Was "10 ZK Circuits", a mixed count of STARKs plus the three
                   legacy Groth16 artifacts still sitting in the Android assets.
              14 = Cargo workspace members under programs/ (p01_arcium excluded
                   from the build, so 15 directories, 14 programs).
              11 = @protocol-01 packages resolving on npm. The repo holds 16, of
                   which pay-core is private and 4 are unpublished.
              21 = topics rendered by this page (the `technologies` array).
                   Was 14, i.e. the count before seven modules were added. */}
        <div className="flex items-center gap-2"><Shield className="w-4 h-4 text-[#39c5bb]" /><span className="text-[#888892]"><span className="text-white font-bold">{STARK_CIRCUIT_COUNT}</span> {t('docs.statCircuits')}</span></div>
        <div className="flex items-center gap-2"><Cpu className="w-4 h-4 text-[#ff77a8]" /><span className="text-[#888892]"><span className="text-white font-bold">14</span> {t('docs.statPrograms')}</span></div>
        <div className="flex items-center gap-2"><Code className="w-4 h-4 text-[#00ffe5]" /><span className="text-[#888892]"><span className="text-white font-bold">11</span> {t('docs.statSdks')}</span></div>
        <div className="flex items-center gap-2"><Layers className="w-4 h-4 text-[#ffcc00]" /><span className="text-[#888892]"><span className="text-white font-bold">{technologies.length}</span> {t('docs.statModules')}</span></div>
      </div>
      <section id="architecture-diagram" className="scroll-mt-24">
        <h2 className="text-lg font-bold text-white mb-5 flex items-center gap-2">
          <Layers className="w-5 h-5 text-[#39c5bb]" />
          {t('docs.archSectionTitle')}
        </h2>
        <ArchitectureDiagram t={t} />
      </section>
    </article>
  );
}

function SecurityTopic({ t }: { t: (k: string) => string }) {
  // 'threatObservers', 'threatPatterns' and 'threatBalance' removed 2026-08-04.
  //
  // They published, as the security model, three absolutes the protocol is
  // measured NOT to deliver today:
  //   · "Blockchain observers cannot link senders and recipients" — a pool
  //     withdrawal republishes the note commitment its deposit published, so the
  //     two are publicly matchable. Confirmed on devnet: leaf 16, commitment
  //     8901821612542787864, present in both the deposit and the withdrawal
  //     transaction. The anonymity set is 1 until the C7 spend circuit ships
  //     (docs/C7_SPEND_CIRCUIT_PLAN.md). On the stealth path the sender is not
  //     hidden at all — the wallet signs and pays the transfer.
  //   · "Spending patterns cannot be analyzed" and "Balance tracking is
  //     impossible for third parties" — both follow from the same link. With
  //     deposits and withdrawals matchable and pool denominations public, a
  //     third party can reconstruct exactly that.
  //
  // Same treatment as 'guaranteeMpc' below: the claim is deleted from what the
  // page renders rather than softened, because the honest replacement wording
  // has to be added to i18n/en.ts + fr.ts + ja.ts (which this pass does not own)
  // and shipping a vaguer version of a false claim is still shipping it.
  // Reinstate only alongside a measured anonymity set greater than 1.
  const threats = ['threatAmounts'];
  // 'guaranteeMpc' removed 2026-07-27: it published "MPC threshold: 1-of-N honest
  // node via Arcium Cerberus protocol" as a SECURITY GUARANTEE. Arcium was removed
  // from Protocol 01 (privacy-sdk 1.0.2 dropped the mpc module), so nothing
  // delivered that guarantee. Do not reinstate without a deployed MPC path.
  const guarantees = ['guaranteeSound', 'guaranteeComplete', 'guaranteeZk', 'guaranteeNoDouble'];
  const harden = [
    ['hardenSpendingKey', 'hardenPin', 'hardenLockout'],
    ['hardenSecureStore', 'hardenClipboard', 'hardenBlur'],
    ['hardenBackup', 'hardenBiometric', 'hardenLockScreen'],
  ];
  return (
    <article>
      <h1 className="text-2xl sm:text-3xl font-bold text-white mb-6 flex items-center gap-3 tracking-tight">
        <Shield className="w-7 h-7 text-[#ff2d7a]" />
        {t('docs.securityTitle')}
      </h1>
      <div id="security-model" className="scroll-mt-24 grid md:grid-cols-2 gap-6">
        <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-6 rounded-2xl">
          <h2 className="text-lg font-bold text-white mb-4">{t('docs.threatModel')}</h2>
          <ul className="space-y-2 text-sm text-[#888892]">
            {threats.map((k) => (
              <li key={k} className="flex items-start gap-2">
                <Eye className="w-4 h-4 text-[#ff2d7a] flex-shrink-0 mt-0.5" />
                <span>{t(`docs.${k}`)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-6 rounded-2xl">
          <h2 className="text-lg font-bold text-white mb-4">{t('docs.guarantees')}</h2>
          <ul className="space-y-2 text-sm text-[#888892]">
            {guarantees.map((k) => (
              <li key={k} className="flex items-start gap-2">
                <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                <span>{t(`docs.${k}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div id="security-hardening" className="scroll-mt-24 mt-6 bg-white/[0.02] backdrop-blur-sm border border-white/[0.06] p-6 rounded-2xl">
        <h2 className="text-lg font-bold text-white mb-4">{t('docs.securityHardening')}</h2>
        <div className="grid md:grid-cols-3 gap-4 text-sm text-[#888892]">
          {harden.map((col, ci) => (
            <ul key={ci} className="space-y-2">
              {col.map((k) => (
                <li key={k} className="flex items-start gap-2">
                  <CheckCircle className="w-4 h-4 text-[#39c5bb] flex-shrink-0 mt-0.5" />
                  <span>{t(`docs.${k}`)}</span>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>
    </article>
  );
}

// Resolve which component renders a given topic id.
function TopicContent({ id, t }: { id: string; t: (k: string) => string }) {
  if (id === 'architecture') return <ArchitectureTopic t={t} />;
  if (id === 'security') return <SecurityTopic t={t} />;
  const tech = technologies.find((x) => x.id === id);
  return tech ? <TechTopic tech={tech} t={t} /> : null;
}

// The sidebar + content-switcher + on-this-page shell.
function DocsBody({ t }: { t: (k: string) => string }) {
  const [activeId, setActiveId] = useState<string>(TOPIC_ORDER[0]);
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const titleFor = (id: string): string => {
    if (SPECIAL_TITLE_KEYS[id]) return t(SPECIAL_TITLE_KEYS[id]);
    const tech = technologies.find((x) => x.id === id);
    return tech ? t(`docs.sections.${tech.i18nKey}.title`) : id;
  };

  const groups: ResolvedGroup[] = useMemo(
    () =>
      NAV_GROUPS.map((g) => ({
        label: t(g.labelKey),
        items: g.ids.map((id) => ({ id, title: titleFor(id) })),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  const searchItems: SearchItem[] = useMemo(
    () =>
      NAV_GROUPS.flatMap((g) =>
        g.ids.map((id) => ({ id, title: titleFor(id), group: t(g.labelKey) })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  // Open the topic referenced by the URL hash on first load (deep-links).
  useEffect(() => {
    const h = window.location.hash.replace('#', '');
    if (h && TOPIC_ORDER.includes(h)) setActiveId(h);
  }, []);

  // Ctrl/Cmd+K toggles search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (id: string) => {
    setActiveId(id);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${id}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const idx = TOPIC_ORDER.indexOf(activeId);
  const prevId = idx > 0 ? TOPIC_ORDER[idx - 1] : null;
  const nextId = idx >= 0 && idx < TOPIC_ORDER.length - 1 ? TOPIC_ORDER[idx + 1] : null;

  const toc: TocItem[] = (() => {
    if (activeId === 'security') {
      return [
        { href: '#security-model', label: t('docs.threatModel') },
        { href: '#security-hardening', label: t('docs.securityHardening') },
      ];
    }
    const tech = technologies.find((x) => x.id === activeId);
    if (tech) {
      const items: TocItem[] = [
        { href: `#${tech.id}-overview`, label: t('docs.overview') },
        { href: `#${tech.id}-features`, label: t('docs.keyFeatures') },
      ];
      if (tech.codeExample) items.push({ href: `#${tech.id}-code`, label: t('docs.codeExample') });
      return items;
    }
    return [];
  })();

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-24 pb-8">
      {/* Mobile controls */}
      <div className="lg:hidden flex items-center justify-between mb-6">
        <button
          onClick={() => setNavOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#2a2a30] text-[#888892] text-sm hover:text-white transition-colors"
        >
          <Menu className="w-4 h-4" />
          {t('docs.menu')}
        </button>
        <button
          onClick={() => setSearchOpen(true)}
          className="flex items-center justify-center w-9 h-9 rounded-lg border border-[#2a2a30] text-[#888892] hover:text-white transition-colors"
          aria-label={t('docs.searchPlaceholder')}
        >
          <Search className="w-4 h-4" />
        </button>
      </div>

      <div className="flex gap-8">
        <Sidebar
          groups={groups}
          activeId={activeId}
          onSelect={go}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          onOpenSearch={() => setSearchOpen(true)}
          searchLabel={t('docs.searchPlaceholder')}
          searchHint={t('docs.searchHint')}
        />

        <main className="flex-1 min-w-0 pb-10">
          <TopicContent id={activeId} t={t} />

          {/* Prev / Next pager */}
          <div className="mt-12 pt-6 border-t border-[#2a2a30] flex items-center justify-between gap-4">
            {prevId ? (
              <button
                onClick={() => go(prevId)}
                className="group flex items-center gap-2 text-left px-4 py-3 rounded-xl border border-[#2a2a30] hover:border-[#39c5bb]/40 transition-colors"
              >
                <ChevronLeft className="w-4 h-4 text-[#555560] group-hover:text-[#39c5bb]" />
                <span>
                  <span className="block text-[10px] font-mono uppercase tracking-wider text-[#555560]">{t('docs.previous')}</span>
                  <span className="text-sm text-white">{titleFor(prevId)}</span>
                </span>
              </button>
            ) : (
              <span />
            )}
            {nextId ? (
              <button
                onClick={() => go(nextId)}
                className="group flex items-center gap-2 text-right px-4 py-3 rounded-xl border border-[#2a2a30] hover:border-[#39c5bb]/40 transition-colors ml-auto"
              >
                <span>
                  <span className="block text-[10px] font-mono uppercase tracking-wider text-[#555560]">{t('docs.next')}</span>
                  <span className="text-sm text-white">{titleFor(nextId)}</span>
                </span>
                <ChevronRight className="w-4 h-4 text-[#555560] group-hover:text-[#39c5bb]" />
              </button>
            ) : (
              <span />
            )}
          </div>
        </main>

        <TopicToc items={toc} title={t('docs.onThisPage')} />
      </div>

      <DocsSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        items={searchItems}
        onSelect={go}
        placeholder={t('docs.searchPlaceholder')}
        emptyLabel={t('docs.searchEmpty')}
      />
    </div>
  );
}

export default function DocsPage() {
  const t = useT();
  return (
    <div className="min-h-screen bg-[#0a0a0c]" style={{ wordWrap: 'break-word', overflowWrap: 'break-word' }}>
      <SiteHeader />

      <DocsBody t={t} />

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
      <Footer />
    </div>
  );
}
