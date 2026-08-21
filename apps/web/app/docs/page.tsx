"use client";

import { useState, useEffect, useMemo } from "react";
import { useT } from "@/i18n";
import {
  Download,
  FileText,
  Menu,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { NAV_GROUPS, TOPIC_ORDER, SPECIAL_TITLE_KEYS } from "@/components/docs/nav";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";
import DocsRail, { type ResolvedGroup } from "./_components/DocsRail";
import DocsToc, { type TocItem } from "./_components/DocsToc";
import DocsPalette, { type SearchItem } from "./_components/DocsPalette";

interface TechSection {
  id: string;
  i18nKey: string;
  detailCount: number;
  codeExample?: string;
  /**
   * i18n key for the badge in the code panel head. Defaults to
   * `docs.footerDevnet`. It used to be the hardcoded English literal "devnet"
   * on every sample, which (a) served French readers an untranslated word where
   * a t() call belongs and (b) claimed a deployment for the one sample whose own
   * body says "NOT SHIPPED. No program is deployed for this". A badge is a
   * claim, so it comes from the entry now.
   */
  statusKey?: string;
}

const technologies: TechSection[] = [
  {
    id: "stealth-addresses",
    i18nKey: "stealthAddresses",
    detailCount: 8,
    codeExample: `// v1: Generate stealth address (X25519 ECDH)
const ephemeral = Keypair.generate();
const sharedSecret = x25519(ephemeral.secretKey, recipientPubkey);
const stealthKey = deriveStealthKey(sharedSecret, recipientPubkey);

// v2: Hybrid key encapsulation (X25519 + ML-KEM-768, FIPS 203).
// Break one half and the other still holds. This covers the address the
// recipient stands behind; the transaction signature is still Ed25519.
const { ciphertext, sharedSecret: hybridSecret } =
  mlKem768.encapsulate(recipientMlKemPubkey);
const combinedSecret = hkdf(x25519Secret, hybridSecret);`,
  },
  {
    id: "zk-proofs",
    i18nKey: "zkProofs",
    // 10th detail added 2026-08-06: it states why no bit-level security figure
    // appears here. Deleting the old "124-bit" claim without saying anything
    // would read as an oversight rather than a measurement.
    detailCount: 10,
    codeExample: `// STARK proof: hash-based, no trusted setup. There is no elliptic curve
// anywhere in the proof system, so Shor has nothing to attack in it.
const starkProof = await starkProver.generateProof(secret);

// Upload proof buffer -> on-chain FRI verifier -> 809,812 CU measured
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
    detailCount: 7,
    codeExample: `// Shielded pool flow (v1.0.2, STARK V3)
// 1. User generates a STARK proof locally (no remote prover)
const starkProof = await starkProver.generateProof(noteInputs);

// 2. Optional: instant path via p01_liquidity prefund so the user
//    doesn't have to front ~0.85 SOL of proof-buffer rent
await liquidity.prefund({ ephemeralSigner, proofBuffer, amount });

// 3. Buffer verifies on-chain -> funds release to a one-time
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
    detailCount: 5,
    codeExample: `// Nullifier computation
const spendingKeyHash = Poseidon([spendingKey]);
const nullifier = Poseidon([commitment, spendingKeyHash]);
// On-chain: require(!nullifierSet.contains(nullifier))`,
  },
  {
    id: "solana-integration",
    i18nKey: "solanaIntegration",
    detailCount: 6,
    codeExample: `// v1.0.2: every spend verifies through the custom on-chain
// FRI verifier (no Winterfell dep, Goldilocks + Blake3, 809,812 CU).
let positions = fiat_shamir_positions(trace_root, commitment);
for pos in positions {
    verify_merkle_path(proof, pos, trace_root)?;
    verify_poseidon_round(trace_row, round_constants)?;
}

// LEGACY (pre-April 2026, now retired from every spend path).
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
    detailCount: 6,
    codeExample: `// Trustless on-chain relay flow (v1.0.2, STARK V3)
//
// WHICH CLIENTS ACTUALLY RELAY. Mobile does. The web app relays exactly
// ONE leg, since 2026-08-21: funding the ephemeral that deposits. The
// wallet pays this deployment in a single signature and the deployment
// funds that key from a separate address, so the deposit transaction
// does not name the buyer. Everything else /app sends is still
// self-submitted from the browser, including the ~280 proof-buffer chunk
// transactions, each under the same ephemeral key whose pubkey seeds the
// buffer PDAs — so the IP still reaches the RPC throughout, and this
// deployment sees the funding request and where it came from.
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

// 2. Upload the proof to a buffer account (~120 KB, ~9-15 KB compact)
//    then call the on-chain FRI verifier (no Winterfell dep,
//    custom Goldilocks + Blake3 implementation, 809,812 CU measured)
await submitStarkProof(program, proofBuffer, circuitId);

// 3. Instruction reads the verified buffer and releases funds
//    to a one-time stealth recipient (ECDH + ML-KEM-768 hybrid)
await program.methods.unshieldDenominatedStark(...)
  .accounts({ pool, recipient: stealthAddress, nullifierPda })
  .rpc();
// Legacy snarkjs.groth16 path fully retired. See Migration History`,
  },
  {
    id: "streams-privacy",
    i18nKey: "streamsPrivacy",
    detailCount: 6,
    codeExample: `// Subscription with privacy noise (not ZK)
await p01.createSubscription({
  amount: 9.99,
  interval: 'monthly',
  privacyOptions: {
    amountNoise: 10,    // 10% random variation either way
    timingNoise: 12,    // 12 hours random delay either way
    useStealth: true    // Pay to ephemeral address
  }
});
// On-chain: payment is visible but harder to correlate`,
  },
  {
    id: "denominated-pools",
    i18nKey: "denominatedPools",
    detailCount: 8,
    codeExample: `// Shield: the deposit is signed by an ephemeral, not by the wallet.
//
// UPDATED 2026-08-21. The wallet no longer funds that ephemeral. It pays
// THIS DEPLOYMENT once — the denomination plus 0.3% protocol plus 1%
// operator, one signature — and the deployment funds the ephemeral from
// a different address it controls. Two transfers, neither naming both
// ends; what still ties them is the amount and the minutes between them.
// (SOL only. USDC deposits still use the wallet directly: the ephemeral
// has no funded token account.)
//
// 1 SOL is the only denomination open to deposits: 0.1 is closed by
// policy so the anonymity set stops splitting, and 10 and above are over
// the relay's ceiling.
const stealthKp = deriveStealthSigner(wallet, timestamp);
await payDeployment(wallet, till, feeWallet, 1); // <- public: wallet -> deployment
await relayToBuyer(paymentSignature, stealthKp.publicKey); // deployment -> ephemeral
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
    detailCount: 7,
    codeExample: `// Confidential deposit: public tokens become hidden balance
const oldCommitment = poseidon([0, salt, owner, mint]);
const newCommitment = poseidon([amount, newSalt, owner, mint]);
const { proof } = await prover.prove({
  old_balance: 0, new_balance: amount,
  public_credit: amount, public_debit: 0,
  private_credit: 0, private_debit: 0,
  old_salt: salt, new_salt: newSalt
});

// Confidential transfer: sender and recipient balances stay hidden
// Amount commitment links the two operations cryptographically
const amountCommitment = poseidon([transferAmount, amountSalt]);`,
  },
  {
    id: "subscription-vaults",
    i18nKey: "subscriptionVaults",
    detailCount: 6,
    codeExample: `// The subscriber opens the vault, funded from a note already in the
// denominated pool. There is no retailer-side init and no wallet-keyed
// variant: the vault PDA is seeded on subscriberCommitment, so the
// address does not name the payer. That commitment is a caller-supplied
// label, NOT proof-bound on chain, the client is what keeps a wallet
// pubkey out of it.
await program.methods.subscribePrivateStark(
  nullifier,             // [u8;32] spends the funding note
  merkleRoot,            // [u8;32] pool root the note is proven against
  minEpoch,              // u64
  subscriberCommitment,  // [u8;32] PDA seed, never the wallet
  rate,                  // u64 per-period amount
  intervalSlots,         // u64 slots between periods
  vkHashSubscriber,      // [u8;32]
  starkCommitment,       // u64
  licenseCommitment      // Option<[u8;32]>, or null, LAST arg
).accounts({
  payer, retailer, vault, denominatedPool, merkleTree,
  nullifierRecord, c1ProofBuffer, c3ProofBuffer, systemProgram,
}).rpc();

// Anyone can push the claim, the program pays vault.retailer and
// nobody else, so no signature from the merchant is required.
await program.methods.claimPeriod()
  .accounts({ retailer, vault, systemProgram })
  .rpc();`,
  },
  {
    id: "p2p-sharing",
    i18nKey: "p2pSharing",
    detailCount: 6,
    codeExample: `// BLE: Sender (central) connects to receiver (peripheral)
// 1. ECDH key exchange
const sharedKey = x25519(senderPrivateKey, receiverPublicKey);

// 2. Encrypt note data
const encrypted = nacl.box(noteJSON, nonce, sharedKey);

// 3. Fragment and send over BLE characteristics
await bleTransport.sendFragmented(encrypted, characteristicUUID);

// NFC: Sender emulates tag via HCE
// Receiver taps phone, then APDU: SELECT -> GET LENGTH -> GET DATA
// Data encrypted with nacl.secretbox(noteJSON, nonce, pinDerivedKey)`,
  },
  {
    id: "client-sdk",
    i18nKey: "clientSdk",
    // 8 -> 10: the arcium-sdk entry was replaced by stark-prover, and the two
    // packages the list never had (privacy-sdk, merchant-sdk) were added.
    detailCount: 10,
    codeExample: `// === @protocol-01/specter-sdk: Core Privacy SDK ===
import { P01Client, createWallet, sendPrivate } from '@protocol-01/specter-sdk';
const client = new P01Client({ cluster: 'devnet' });
await sendPrivate({ amount: 1.5, recipient: stealthMetaAddress });

// === @protocol-01/zk-sdk: ZK Shielded Pool ===
import { ShieldedClient } from '@protocol-01/zk-sdk';
const zkClient = new ShieldedClient({ rpcUrl, programId });
await zkClient.shield(1_000_000_000n, notes);

// === @protocol-01/zkspl-sdk: Confidential Balances ===
import { ZkSplClient } from '@protocol-01/zkspl-sdk';
await zkspl.deposit(amount, proof);   // Public -> confidential
await zkspl.send(amount, recipient);  // Confidential transfer

// === @protocol-01/p01-js: Merchant Integration ===
import { Protocol01 } from '@protocol-01/p01-js';
await p01.createSubscription({ amount: 9.99, interval: 'monthly' });

// === @protocol-01/privacy-toolkit: Merkle + Poseidon ===
import { IncrementalMerkleTree, poseidon2 } from '@protocol-01/privacy-toolkit';

// === @protocol-01/auth-sdk: Auth Integration ===
import { P01AuthClient } from '@protocol-01/auth-sdk';

// === @protocol-01/rpc-config: RPC Infrastructure ===
import { RpcConnectionManager } from '@protocol-01/rpc-config';
const conn = RpcConnectionManager.getConnection(); // Auto-fallback chain`,
  },
  {
    id: "auto-shield",
    i18nKey: "autoShield",
    detailCount: 7,
    codeExample: `// Auto-Shield flow (autonomous runner)
// 1. User opens Receive, a stealth address is generated
const seed = hmac(sha256, viewingSecretKey, "p01_auto_receive_42");
const keypair = Keypair.fromSeed(seed);
// Display keypair.publicKey as QR code

// 2. Sender sends SOL to the stealth address (any wallet)
// 3. Runner detects funds and auto-shields
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
    detailCount: 7,
    codeExample: `// Receiver: share meta-address
const keys = await getOrCreateStealthKeys();
const metaAddress = createMetaAddress(keys);
// yields "st:012u2trSt1XytE271..."

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
    detailCount: 7,
    codeExample: `// Split 1 SOL into 10 notes of 0.1 SOL
const result = await splitNote(
  sourcePool,  // 1 SOL pool
  targetPool,  // 0.1 SOL pool
  receipt,     // Source note receipt
  10,          // Number of outputs
  outputSecrets,
  proofGenerator,
);
// yields 10 new notes in the 0.1 SOL pool`,
  },
  {
    id: "privacy-router",
    i18nKey: "privacyRouter",
    detailCount: 8,
    codeExample: `// Start a Paranoid-level private send
const route = await startPrivateRoute({
  amount: 0.1,
  destination: "7gWpzSZA...",
  privacyLevel: 5, // Paranoid
  spendingKeyHash,
});
// 14 hops over ~2 days
// Shield -> Unshield -> Reshield -> ... -> Final delivery
// Each hop uses a different stealth address
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
    // The per-category counts used to sum to 49 against a headline of 56: the
    // web, price, clipboard and datetime tools had no category. They do now,
    // and the thirteen categories add up to the 56 in AGENT_TOOLS.
    detailCount: 15,
    codeExample: `// User: "What's my balance and shield 0.1 SOL"
// Agent calls tools:
const balance = await executeTool("wallet_balance", {});
// yields { sol: "3.69", usd: "$520.13" }

// Agent responds and calls shield tool:
await executeTool("privacy_shield", { amount: 0.1 });
// Redirects to Privacy -> Shield screen`,
  },
  {
    id: "quantum-wallet",
    i18nKey: "quantumWallet",
    detailCount: 8,
    // Nothing is deployed for this one, on devnet or anywhere else, and the
    // sample says so in its first two lines.
    statusKey: "roadmap.planned",
    codeExample: `// Quantum Wallet: STARK-authorized fund custody.
// NOT SHIPPED. No program is deployed for this and no date is promised.
// What follows is the design, so the shape can be reviewed early.
// Funds spent via Poseidon preimage proof, not Ed25519 signature.

// 1. Init at first launch: silent, transparent migration
const seedSecret = hkdf(seedPhrase, "p01_quantum_v1");
const commitment = poseidonGl(seedSecret, salt);  // Goldilocks
const ownerId = poseidonGl(seedSecret, "id_v1");
const pda = derivePda(["qw", ownerId], P01_QUANTUM_WALLET_ID);
await initQuantumWallet({ commitment, recoveryPubkey: null });

// 2. Receive: your address is the PDA. Senders use SystemProgram.transfer
// like any other wallet. They don't know it's quantum-protected.

// 3. Send: STARK proves "I know the preimage of commitment"
const proof = await starkProver.generateProof({
  seedSecret, salt, recipient, amount, nonce, circuitId: 7,
});
await uploadProofBuffer(proof);
await withdraw({ amount, recipient, proofBuffer });

// The threat this answers: Shor breaks Ed25519 once a large enough
// quantum computer exists. This page does not claim to know when.
// Under that design an attacker who steals your gas keypair can pay
// fees in your name and CANNOT move your funds, because custody is
// knowledge of a hash preimage (which Grover only speeds up
// quadratically) rather than a signature.`,
  },
  {
    id: "migration-history",
    i18nKey: "migrationHistory",
    detailCount: 6,
    codeExample: `// BEFORE: Groth16 / BN254 (retired April 2026)
// const { proof } = await snarkjs.groth16.fullProve(
//   inputs, "transfer.wasm", "transfer.zkey"
// );
// BN254 pairings (Shor-vulnerable), 30 MB .ptau trusted setup,
// snarkjs + circomlib runtime, alt_bn128 syscalls

// AFTER: Winterfell STARKs over Goldilocks (current)
const proof = await starkProver.generateProof(secret);
// Hash-based (Blake3 + Poseidon), no trusted setup, custom on-chain
// FRI verifier, 7 AIRs (one per accepted circuit id), 9-15 KB proofs`,
  },
];

/**
 * Circuit ids the deployed verifier accepts, counted from the source of truth:
 * `get_circuit_config` in programs/p01_stark_verifier/src/compact_proof.rs maps
 * 0..=6 and returns None above that, and `boundary_assertions_reject_unknown_circuit`
 * pins the rejection for 7, 8, 100 and 255. One AIR module each in stark/src/air/.
 */
const STARK_CIRCUIT_COUNT = 7;

/**
 * The stack, layer by layer.
 *
 * The per-layer `hex` field is gone: it carried #39c5bb, #ff2d7a, #ff77a8,
 * #00ffe5 and #ffcc00, drove the node borders, the node labels, the arrows and
 * a set of alpha suffixes, and there is no Styx equivalent to remap it onto. A
 * layer is now marked by its `styx-index` tick, which is the one place cyan is
 * allowed to appear.
 */
const docsArchLayers = [
  {
    nameKey: "docs.layerClient",
    nodes: [
      { labelKey: "docs.nodeMobileApp", subKey: "docs.nodeMobileSub" },
      { labelKey: "docs.nodeExtension", subKey: "docs.nodeExtensionSub" },
      { labelKey: "docs.nodeWebApp", subKey: "docs.nodeWebSub" },
      { labelKey: "docs.nodeAiAgent", subKey: "docs.nodeAiSub" },
    ],
  },
  {
    nameKey: "docs.layerPrivacy",
    nodes: [
      { labelKey: "docs.nodeAutoShield", subKey: "docs.nodeAutoShieldSub" },
      { labelKey: "docs.nodePrivacyRouter", subKey: "docs.nodePrivacyRouterSub" },
      { labelKey: "docs.nodeMetaAddr", subKey: "docs.nodeMetaAddrSub" },
    ],
  },
  {
    nameKey: "docs.layerSdk",
    // The ten packages published under @protocol-01 that are part of the current
    // stack. @protocol-01/arcium-sdk is also on npm but is NOT here: Arcium was
    // removed from the protocol on 2026-07-17, same reason the MPC node was
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
    nodes: [
      { labelKey: "docs.nodeStealth", subKey: "docs.nodeStealthSub" },
      { labelKey: "docs.nodeShielded", subKey: "docs.nodeShieldedSub" },
      { labelKey: "docs.nodeDenominated", subKey: "docs.nodeDenominatedSub" },
      { labelKey: "docs.nodeNoteSplit", subKey: "docs.nodeNoteSplitSub" },
      { labelKey: "docs.nodeZkspl", subKey: "docs.nodeZksplProtoSub" },
      { labelKey: "docs.nodePayments", subKey: "docs.nodePaymentsSub" },
      { labelKey: "docs.nodeVaults", subKey: "docs.nodeVaultsSub" },
      // "MPC / Arcium Cerberus" node removed 2026-07-27 — Arcium is not part of
      // this protocol any more. See the note on `guarantees` in SecurityTopic.
    ],
  },
  {
    nameKey: "docs.layerVerification",
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
    nodes: [
      { labelKey: "docs.nodePrograms", subKey: "docs.nodeProgramsSub" },
      { labelKey: "docs.nodeSplTokens", subKey: "docs.nodeSplSub" },
      { labelKey: "docs.nodeZkVerif", subKey: "docs.nodeZkVerifSub" },
    ],
  },
];

// Mirrors the old column counts so no layer reflows: 2 nodes stay paired, 4 sit
// on one line, everything longer settles into three columns.
function layerGridClass(count: number): string {
  if (count <= 2) return "styx-grid-2";
  if (count === 4) return "styx-grid-4";
  return "styx-grid-3";
}

/**
 * The stack diagram.
 *
 * Rebuilt as a panel of labelled bands. Deleted with the old identity: the
 * injected <style> block and its four keyframe sets, the perspective grid, the
 * radial glow pulse, the vertical dataflow lines, the drifting particles, the
 * scanline, the vignette, the noise texture, the coloured arrow connectors and
 * the per-node onMouseEnter handlers that wrote a boxShadow halo onto
 * currentTarget. Every layer and every node survives, in order.
 *
 * One key does not: `docs.archTitle`, which held the same string as
 * `docs.archSectionTitle` and so printed the section heading twice. See the
 * note on the panel head.
 */
function ArchitectureDiagram({ t }: { t: (key: string) => string }) {
  return (
    <div className="styx-panel">
      {/* No overline above the panel title. `docs.archTitle` holds the SAME
          string as `docs.archSectionTitle` in both locales ("System
          Architecture" in en, "Architecture systeme" in fr), and this panel
          sits directly under the h2 built from archSectionTitle, so the
          overline printed that heading a second time two lines below itself.
          The panel keeps its own name, `docs.archSubtitle` ("Protocol Stack"),
          which is the only label here that says something the h2 does not. */}
      <div className="styx-panel-head">
        <p className="styx-h3" style={{ margin: 0 }}>
          {t("docs.archSubtitle")}
        </p>
      </div>

      <div className="styx-panel-body styx-stack-lg">
        {docsArchLayers.map((layer) => (
          <div key={layer.nameKey}>
            <p className="styx-index">{t(layer.nameKey)}</p>
            <div
              className={`styx-grid ${layerGridClass(layer.nodes.length)}`}
              style={{ marginTop: "0.9rem" }}
            >
              {layer.nodes.map((node) => (
                <div
                  key={node.labelKey}
                  className="styx-card styx-sweep"
                  style={{ padding: "0.9rem 1rem" }}
                >
                  <p
                    className="styx-mono"
                    style={{
                      margin: 0,
                      color: "var(--styx-paper)",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {t(node.labelKey)}
                  </p>
                  <p className="styx-card-note" style={{ marginTop: "0.25rem" }}>
                    {t(node.subKey)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div
        className="flex flex-wrap items-center gap-3 px-6 py-5"
        style={{ borderTop: "1px solid var(--styx-rule-soft)" }}
      >
        <span className="styx-chip">
          <span className="styx-dot" aria-hidden="true" />
          {t("docs.archEncrypted")}
        </span>
        <span className="styx-chip">{t("docs.archFlow")}</span>
      </div>
    </div>
  );
}

// A single technology rendered as a full docs topic (always open).
function TechTopic({ tech, t }: { tech: TechSection; t: (key: string) => string }) {
  const title = t(`docs.sections.${tech.i18nKey}.title`);
  const description = t(`docs.sections.${tech.i18nKey}.desc`);
  const details = Array.from({ length: tech.detailCount }, (_, i) =>
    t(`docs.sections.${tech.i18nKey}.detail${i + 1}`),
  );

  return (
    <article>
      <h1
        className="styx-h1"
        style={{
          margin: 0,
          fontSize: "clamp(2rem, 4.2vw, 3.1rem)",
          maxWidth: "26ch",
        }}
      >
        {title}
      </h1>
      <div
        className="styx-gleam-rule"
        aria-hidden="true"
        style={{ margin: "1.75rem 0 2.25rem" }}
      />

      <section id={`${tech.id}-overview`}>
        <p className="styx-lede">{description}</p>
      </section>

      <section id={`${tech.id}-features`} style={{ marginTop: "3.25rem" }}>
        <h2 className="styx-index">{t("docs.keyFeatures")}</h2>
        <ul
          className="m-0 flex list-none flex-col gap-2.5 p-0"
          style={{ marginTop: "1.35rem" }}
        >
          {details.map((detail, i) => (
            <li
              key={i}
              className="flex"
              style={{
                color: "var(--styx-muted)",
                fontSize: "0.9375rem",
                lineHeight: 1.65,
              }}
            >
              <span className="styx-check" aria-hidden="true">
                &#10003;
              </span>
              <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>
                {detail}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {tech.codeExample && (
        <section id={`${tech.id}-code`} style={{ marginTop: "3.25rem" }}>
          <h2 className="styx-index">{t("docs.codeExample")}</h2>
          <div style={{ marginTop: "1.35rem" }}>
            {/* The <pre> inside `#<id>-code` is load-bearing: the docs test suite
                reads every sample through `#<id>-code pre`. */}
            <Reveal className="styx-code-panel styx-reveal">
              <div className="styx-code-head">
                <span>{tech.id}</span>
                <span>{t(tech.statusKey ?? "docs.footerDevnet")}</span>
              </div>
              <pre
                className="styx-code"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {tech.codeExample}
              </pre>
            </Reveal>
          </div>
        </section>
      )}
    </article>
  );
}

// ── Special (non-technologies) topics ──────────────────────────
function ArchitectureTopic({ t }: { t: (k: string) => string }) {
  return (
    <article>
      <h1
        className="styx-h1"
        style={{
          margin: 0,
          fontSize: "clamp(2.4rem, 5vw, 3.6rem)",
          maxWidth: "22ch",
        }}
      >
        {t("docs.heroTitle1")}{" "}
        {/* The page's single gleam. One word, one motion signature. */}
        <span className="styx-gleam">{t("docs.heroTitle2")}</span>
      </h1>
      <div className="styx-hero-rule" aria-hidden="true" />
      <p className="styx-lede">{t("docs.heroSubtitle")}</p>

      {/* The one amber note on the page, and the one thing a reader of these
          pages must not miss. Several sections below are translated copy this
          port cannot edit (i18n/* is not ours) and a few of them still read as
          if the deposit-to-withdrawal link were hidden. It is not.

          Built out of keys that already exist in en.ts and fr.ts, never out of
          literals: the first draft of this box was hardcoded English, which
          silently served French readers an English admission, i.e. it dropped
          the honesty note for exactly the audience that cannot check the code.
          Adding keys is not an option here (i18n/ is off limits to this pass),
          so the box says what the catalogue can already say in both locales:
          devnet only, unaudited, and the deposit-to-withdrawal link is open. */}
      <div className="styx-admission" style={{ marginTop: "2.5rem" }}>
        <p className="styx-admission-title">{t("docs.footerDevnet")}</p>
        <p className="styx-admission-body">{t("docs.footerDisclaimer")}</p>
        <p className="styx-admission-body" style={{ marginTop: "0.6rem" }}>
          {t("docs.sections.denominatedPools.desc")}
        </p>
      </div>

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
      <div className="styx-grid styx-grid-4" style={{ marginTop: "2.5rem" }}>
        <Reveal className="styx-card styx-reveal">
          <p className="styx-card-label">{t("docs.statCircuits")}</p>
          <p className="styx-card-value">{STARK_CIRCUIT_COUNT}</p>
        </Reveal>
        <Reveal className="styx-card styx-reveal" delay={80}>
          <p className="styx-card-label">{t("docs.statPrograms")}</p>
          <p className="styx-card-value">14</p>
        </Reveal>
        <Reveal className="styx-card styx-reveal" delay={160}>
          <p className="styx-card-label">{t("docs.statSdks")}</p>
          <p className="styx-card-value">11</p>
        </Reveal>
        <Reveal className="styx-card styx-reveal" delay={240}>
          <p className="styx-card-label">{t("docs.statModules")}</p>
          <p className="styx-card-value">{technologies.length}</p>
        </Reveal>
      </div>

      <section id="architecture-diagram" style={{ marginTop: "3.5rem" }}>
        <h2 className="styx-index">{t("docs.archSectionTitle")}</h2>
        <div style={{ marginTop: "1.35rem" }}>
          <Reveal className="styx-reveal">
            <ArchitectureDiagram t={t} />
          </Reveal>
        </div>
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
  // has to be added to i18n/en.ts + fr.ts (which this pass does not own) and
  // shipping a vaguer version of a false claim is still shipping it. The site
  // ships two locales since ja.ts was removed on 2026-08-11, so there is no
  // third catalogue to keep in step.
  // Reinstate only alongside a measured anonymity set greater than 1.
  const threats = ['threatAmounts'];
  // 'guaranteeMpc' removed 2026-07-27: it published "MPC threshold: 1-of-N honest
  // node via Arcium Cerberus protocol" as a SECURITY GUARANTEE. Arcium was removed
  // from the protocol (privacy-sdk 1.0.2 dropped the mpc module), so nothing
  // delivered that guarantee. Do not reinstate without a deployed MPC path.
  const guarantees = ['guaranteeSound', 'guaranteeComplete', 'guaranteeZk', 'guaranteeNoDouble'];
  const harden = [
    ['hardenSpendingKey', 'hardenPin', 'hardenLockout'],
    ['hardenSecureStore', 'hardenClipboard', 'hardenBlur'],
    ['hardenBackup', 'hardenBiometric', 'hardenLockScreen'],
  ];
  return (
    <article>
      <h1
        className="styx-h1"
        style={{
          margin: 0,
          fontSize: "clamp(2rem, 4.2vw, 3.1rem)",
          maxWidth: "26ch",
        }}
      >
        {t("docs.securityTitle")}
      </h1>
      <div
        className="styx-gleam-rule"
        aria-hidden="true"
        style={{ margin: "1.75rem 0 2.25rem" }}
      />

      {/* The four guarantees below are translated copy this port cannot edit,
          and they are absolutes about a verifier nobody has audited. Amber
          instead of a rewrite, since rewriting would mean editing i18n/*.

          Same rule as the admission on the architecture topic: existing keys
          only. A hardcoded English paragraph here would have left French readers
          with four unqualified absolutes and no caveat at all. */}
      <div className="styx-admission">
        <p className="styx-admission-title">
          {t("docs.footerBeta")} &middot; {t("docs.footerDevnet")}
        </p>
        <p className="styx-admission-body">{t("docs.footerDisclaimer")}</p>
      </div>

      <div
        id="security-model"
        className="styx-grid styx-grid-2"
        style={{ marginTop: "2.5rem" }}
      >
        <div className="styx-card">
          <h2 className="styx-index">{t("docs.threatModel")}</h2>
          <ul
            className="m-0 flex list-none flex-col gap-2.5 p-0"
            style={{ marginTop: "1.35rem" }}
          >
            {threats.map((k) => (
              <li
                key={k}
                className="flex"
                style={{
                  color: "var(--styx-muted)",
                  fontSize: "0.9375rem",
                  lineHeight: 1.65,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    flex: "none",
                    marginRight: "0.6rem",
                    fontFamily: "var(--styx-mono)",
                    color: "var(--styx-faint)",
                  }}
                >
                  &middot;
                </span>
                <span className="min-w-0">{t(`docs.${k}`)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="styx-card">
          <h2 className="styx-index">{t("docs.guarantees")}</h2>
          <ul
            className="m-0 flex list-none flex-col gap-2.5 p-0"
            style={{ marginTop: "1.35rem" }}
          >
            {guarantees.map((k) => (
              <li
                key={k}
                className="flex"
                style={{
                  color: "var(--styx-muted)",
                  fontSize: "0.9375rem",
                  lineHeight: 1.65,
                }}
              >
                <span className="styx-check" aria-hidden="true">
                  &#10003;
                </span>
                <span className="min-w-0">{t(`docs.${k}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div id="security-hardening" className="styx-panel" style={{ marginTop: "2.5rem" }}>
        <div className="styx-panel-head">
          <h2 className="styx-index">{t("docs.securityHardening")}</h2>
        </div>
        <div className="styx-panel-body">
          <div className="grid gap-6 md:grid-cols-3">
            {harden.map((col, ci) => (
              <ul key={ci} className="m-0 flex list-none flex-col gap-2.5 p-0">
                {col.map((k) => (
                  <li
                    key={k}
                    className="flex"
                    style={{
                      color: "var(--styx-muted)",
                      fontSize: "0.875rem",
                      lineHeight: 1.6,
                    }}
                  >
                    <span className="styx-check" aria-hidden="true">
                      &#10003;
                    </span>
                    <span className="min-w-0">{t(`docs.${k}`)}</span>
                  </li>
                ))}
              </ul>
            ))}
          </div>
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

  // No pt-24 here: StyxShell reserves the fixed bar's 4rem on `.styx`
  // (`.styx-has-chrome`), and `.styx [id]` carries scroll-margin-top so anchors
  // do not land underneath it either.
  return (
    <div
      className="styx-container"
      style={{
        paddingTop: "clamp(2.5rem, 5vw, 4rem)",
        paddingBottom: "clamp(3rem, 6vw, 5rem)",
      }}
    >
      {/* Mobile controls */}
      <div className="mb-8 flex items-center justify-between lg:hidden">
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          className="styx-btn-ghost"
          style={{ padding: "0.55rem 0.95rem" }}
        >
          <Menu size={14} aria-hidden="true" />
          {t('docs.menu')}
        </button>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="styx-btn-ghost"
          style={{ padding: "0.55rem" }}
          aria-label={t('docs.searchPlaceholder')}
        >
          <Search size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="flex gap-8 xl:gap-10">
        <DocsRail
          groups={groups}
          activeId={activeId}
          onSelect={go}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          onOpenSearch={() => setSearchOpen(true)}
          searchLabel={t('docs.searchPlaceholder')}
          searchHint={t('docs.searchHint')}
        />

        <main className="min-w-0 flex-1 pb-10">
          {/* The topic's place in TOPIC_ORDER, as the marginal numeral. Decorative
              and aria-hidden: the rail, the pager and the h1 already say where
              the reader is, and a bare number read aloud says nothing. */}
          {idx >= 0 && (
            <span className="styx-numeral" aria-hidden="true">
              {String(idx + 1).padStart(2, '0')}
            </span>
          )}
          <TopicContent id={activeId} t={t} />

          {/* Prev / Next pager. Buttons, not links: navigation here is a state
              change plus a history.replaceState hash rewrite. Their accessible
              names stay "Previous <title>" / "Next <title>" so an exact-name
              query for a topic title can only reach the rail. */}
          <div style={{ marginTop: "4rem" }}>
            <div className="styx-gleam-rule" aria-hidden="true" />
            <div
              className="flex items-start justify-between gap-4"
              style={{ marginTop: "1.75rem" }}
            >
              {prevId ? (
                <button
                  type="button"
                  onClick={() => go(prevId)}
                  className="styx-btn-ghost styx-sweep"
                  style={{ padding: "0.85rem 1.25rem", textAlign: "left" }}
                >
                  <ChevronLeft
                    size={14}
                    aria-hidden="true"
                    style={{ flex: "none", color: "var(--styx-faint)" }}
                  />
                  <span style={{ display: "block" }}>
                    <span
                      className="styx-card-label"
                      style={{ display: "block", margin: 0 }}
                    >
                      {t('docs.previous')}
                    </span>
                    <span
                      style={{
                        display: "block",
                        fontFamily: "var(--styx-sans)",
                        fontSize: "0.875rem",
                        letterSpacing: "normal",
                        textTransform: "none",
                        color: "var(--styx-paper)",
                      }}
                    >
                      {titleFor(prevId)}
                    </span>
                  </span>
                </button>
              ) : (
                <span />
              )}
              {nextId ? (
                <button
                  type="button"
                  onClick={() => go(nextId)}
                  className="styx-btn-ghost styx-sweep ml-auto"
                  style={{ padding: "0.85rem 1.25rem", textAlign: "right" }}
                >
                  <span style={{ display: "block" }}>
                    <span
                      className="styx-card-label"
                      style={{ display: "block", margin: 0 }}
                    >
                      {t('docs.next')}
                    </span>
                    <span
                      style={{
                        display: "block",
                        fontFamily: "var(--styx-sans)",
                        fontSize: "0.875rem",
                        letterSpacing: "normal",
                        textTransform: "none",
                        color: "var(--styx-paper)",
                      }}
                    >
                      {titleFor(nextId)}
                    </span>
                  </span>
                  <ChevronRight
                    size={14}
                    aria-hidden="true"
                    style={{ flex: "none", color: "var(--styx-faint)" }}
                  />
                </button>
              ) : (
                <span />
              )}
            </div>
          </div>
        </main>

        <DocsToc items={toc} title={t('docs.onThisPage')} />
      </div>

      <DocsPalette
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
    <StyxShell>
      <DocsBody t={t} />

      {/* Design document download.
          FROZEN: /protocol-01-design-document.pdf is the real asset at
          apps/web/public/protocol-01-design-document.pdf. The filename carries
          "protocol-01" and is not renamed by the rebrand; nor is the `download`
          attribute dropped. */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-center">
          <a
            href="/protocol-01-design-document.pdf"
            download
            className="styx-btn-ghost styx-sweep"
          >
            <FileText size={14} aria-hidden="true" style={{ flex: "none" }} />
            <span
              style={{
                fontFamily: "var(--styx-sans)",
                fontSize: "0.9375rem",
                letterSpacing: "normal",
                textTransform: "none",
              }}
            >
              {t('docs.designDoc')}
            </span>
            <span className="styx-card-label" style={{ margin: 0 }}>
              {t('docs.designDocMeta')}
            </span>
            <Download size={13} aria-hidden="true" style={{ flex: "none" }} />
          </a>
          <p className="styx-note" style={{ marginTop: "1.1rem" }}>
            {t('docs.designDocRevision')}
          </p>
        </div>
      </section>
    </StyxShell>
  );
}
