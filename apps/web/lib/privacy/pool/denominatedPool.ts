/**
 * Denominated Pool Service — Extension
 *
 * Goldilocks V3 denominated pool support for the extension. Implements
 * shield (circuit 6), unshield (circuits 1 + 3), and note-to-note private
 * transfer (circuits 1 + 3 + 6), plus the note material needed for private
 * subscribe (circuit 1). C3 (merkle_path) was realigned + redeployed on-chain
 * 2026-05-29 (slot 465731409), so unshield and transfer both verify.
 *
 * All math is ported BYTE-FOR-BYTE from
 * apps/mobile/services/denominatedPool/index.ts. Do NOT invent or improve
 * any formula — even a single bit difference = on-chain InvalidProof.
 *
 * WASM note: starkProver.generateMerkleUpdateProof (C6) and
 * starkProver.generatePoolCommitmentProof (C1) are already in the
 * extension WASM. No rebuild required.
 *
 * Proof upload: uses the extension's legacy submitAndVerifyStarkProof
 * (non-uniform 145 KB pipeline is NOT required for the extension — the
 * on-chain handler accepts the legacy buffer format for C6 and C1).
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';
import {
  getPoolHistoryStore,
  hasGivenUpOnSignature,
  inFlightPoolWalks,
  loadPoolHistory,
  poolHistoryKey,
  rememberGivenUpSignature,
  rememberReadThisSession,
  wasReadThisSession,
  MAX_HISTORY_GAPS,
  MAX_HISTORY_READ_ATTEMPTS,
  MAX_HISTORY_RETRY_ENTRIES,
  POOL_HISTORY_VERSION,
  type CachedCommitmentEntry,
  type PoolHistoryGap,
} from './poolHistoryCache';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { sendWithFreshBlockhash } from './sendTx';
// The jitter's own bounds, imported rather than retyped: the deposit ceiling
// below has to know the WORST amount `jitterPrefund` can ask a wallet for, and
// a second copy of those two numbers would drift.
import { PREFUND_MAX_EXTRA_STEPS, PREFUND_STEP_LAMPORTS } from './prefundAmount';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';

// anchorEventDiscriminator — Anchor event disc is sha256("event:<Name>")[0..8]
// (same as mobile line 439). Used by fetchPoolCommitments.
function anchorEventDiscriminator(name: string): Uint8Array {
  return sha256(utf8ToBytes(`event:${name}`)).slice(0, 8);
}

// Goldilocks Poseidon primitives — from the extension's own copy (already
// parity-tested against the Rust reference).
import {
  goldilocksHash2to1,
  computeGoldilocksZeroCascade,
  GOLDILOCKS_MODULUS,
} from './goldilocks-poseidon';

// Stark proof upload — extension's legacy pipeline (non-uniform).
import {
  submitAndVerifyStarkProof,
  closeStarkProofBuffer,
  buildStarkProofUploadBatch,
  buildCloseProofBufferIx,
  getProofBufferPDA,
  RELAY_PLACEHOLDER_BLOCKHASH,
  CIRCUIT_MERKLE_UPDATE,
  CIRCUIT_POOL_COMMITMENT,
  CIRCUIT_SPEND,
  CIRCUIT_MERKLE_PATH,
  type GenericStarkProof,
  type WalletSigner,
} from './stark';

// STARK WASM prover singleton.
import { starkProver } from './starkProver';
import type { StoredMerklePath } from './unshieldFromPath';

// NOTE: `./noteCrypto` (post-quantum note encryption) and
// `./relayEphemeralRecovery` (deterministic ephemeral + crash breadcrumbs) used
// to be imported here for the note-to-note transfer path. That path is deleted
// (see the tombstone below `buildTransferDenominatedStarkV3Ix`); both modules
// are still live and imported by shieldEphemeral/unshieldEphemeral/poolHandlers.

// ---------------------------------------------------------------------------
// Re-export circuit IDs and signer type so consumers can import from here.
// ---------------------------------------------------------------------------
export { CIRCUIT_POOL_COMMITMENT, CIRCUIT_MERKLE_PATH, CIRCUIT_MERKLE_UPDATE, CIRCUIT_SPEND, type WalletSigner };

// ---------------------------------------------------------------------------
// Constants (mirror mobile lines 43-108)
// ---------------------------------------------------------------------------

/** zk_shielded program — matches mobile line 43. */
export const ZK_SHIELDED_PROGRAM_ID = new PublicKey(
  'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c',
);

/** Native SOL mint = SystemProgram (line 47). */
const NATIVE_SOL_MINT = SystemProgram.programId;

/** USDC devnet mint (lines 49-51). */
export const USDC_DEVNET_MINT = new PublicKey(
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
);

/** Tree depth — matches mobile line 77. */
export const MERKLE_DEPTH = 15;

/**
 * The depth circuit 6 proves, since 2026-08-29.
 *
 * C6 was cut from 15 to 12 to free 128 unconstrained trace rows for a blinding
 * region. The pool tree is still MERKLE_DEPTH (15) deep; the circuit now covers
 * only its bottom 12 levels, and `shield_denominated_v3` folds the remaining 3
 * on chain against the pool account's own `filled_subtrees`.
 *
 * ⛔ SENDING 15 PATH ELEMENTS INTO THE C6 PROVER PANICS INSIDE THE WASM. The
 * trace builder asserts the mask length for the depth it was handed, so the
 * failure lands mid-proof on the deposit path with no useful message. Slice
 * first -- the same shape C7 already uses for its own depth-12 cut.
 */
/**
 * [ZK-DEPTH-11 2026-08-30] 12 -> 11.
 *
 * The circuit gave up one Merkle level so its blinding region could grow from
 * 128 rows to 160. That was not cosmetic: `full_wire_ledger.rs` MEASURED the
 * row mask short of what the constrained openings plus the quotient publish on
 * C3, and standing on a margin of 20 on C6 and C7.
 *
 * ⛔ THE WALK IS NOW FOUR LEVELS, NOT THREE. Slice 11 for the circuit and send
 * 15 - 11 = 4 siblings/directions to the instruction. Sending three is a root
 * the handler folds short, which fails the ring check after the whole upload.
 *
 * ⚠️ The pool tree is STILL MERKLE_DEPTH (15) deep and still holds 2^15 notes.
 * This constant moves the split between circuit and instruction, never the
 * capacity.
 */
const C6_SUBTREE_DEPTH = 11;

/** Slots per epoch — matches mobile line 78. */
const SLOTS_PER_EPOCH = 7200;

const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  'ComputeBudget111111111111111111111111111111',
);

/**
 * Per-pool fee_escrow PDA. Mirrors mobile deriveFeeEscrowPDA lines 70-75.
 * Seeds: [b"fee_escrow", pool.key()].
 */
export function deriveFeeEscrowPDA(poolPDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_escrow'), poolPDA.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID,
  );
}

/**
 * Compute budget instructions. Mirrors mobile buildComputeBudgetIxs lines
 * 93-108.
 */
export function buildComputeBudgetIxs(
  cuLimit = 300_000,
  cuPriceMicroLamports = 1000,
): TransactionInstruction[] {
  const limitData = Buffer.alloc(5);
  limitData.writeUInt8(2, 0);
  limitData.writeUInt32LE(cuLimit, 1);

  const priceData = Buffer.alloc(9);
  priceData.writeUInt8(3, 0);
  priceData.writeBigUInt64LE(BigInt(cuPriceMicroLamports), 1);

  return [
    new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: limitData }),
    new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: priceData }),
  ];
}

/**
 * ⛔ [close-v1, audit v1 F05, web mitigation of a founder item] NO C1 + C3
 * SPEND IS BUILT UNLESS THE DEPLOYMENT OPTS IN.
 *
 * The deployed v3 withdrawal and v3 subscription verify C1 and C3, which bind
 * neither the payee, nor the new note, nor the merchant, and a proof does not
 * depend on who uploads it: anyone who copies the public proof bytes out of the
 * buffers can land the spend first, to themselves (audit v1 F05, measured in
 * litesvm: 995,000,000 lamports taken). Only a program change closes that
 * (founder). Until then the web client refuses to build one, before any
 * request, proof, payment or upload, unless
 * `NEXT_PUBLIC_P01_ALLOW_C1C3_SPEND === '1'` (default off). Circuit 7 (the v4
 * withdrawal and subscription) is not affected and not gated.
 *
 * The message starts with the stable code `C1C3_SPEND_DISABLED:` (close-v1
 * contract C2): the worker passes it through, the panels map the code to their
 * own words. It names no note value. Pinned by
 * `closeV1L3C1C3SpendDisabled.test.ts`.
 */
export const C1C3_SPEND_DISABLED = 'C1C3_SPEND_DISABLED';

export function c1c3SpendAllowed(): boolean {
  // Literal property access, so Next inlines the build-time value in the worker bundle.
  return process.env.NEXT_PUBLIC_P01_ALLOW_C1C3_SPEND === '1';
}

export function assertC1C3SpendAllowed(spend: 'withdrawal' | 'subscription'): void {
  if (c1c3SpendAllowed()) return;
  throw new Error(
    `${C1C3_SPEND_DISABLED}: this ${spend} would use the older C1 + C3 proof pair, which this ` +
      'site no longer builds: on the deployed program anyone who copies those public proofs ' +
      'can land the spend to themselves first. Nothing was proved, funded or sent, and the ' +
      'note stays in the pool.',
  );
}

/**
 * [close-v1, audit v1 F01/F06] Stable code of a pool tree the event history
 * provably cannot rebuild (contract C2). See `prepareShieldInsert`.
 */
export const POOL_TREE_DIVERGED = 'POOL_TREE_DIVERGED';

/** The spend-side refusal (see `poolTreeDiverged`). Names no root, leaf or count. */
export function poolTreeDivergedError(spend: 'withdrawal' | 'subscription'): Error {
  return new Error(
    `${POOL_TREE_DIVERGED}: this ${spend} was stopped before any proof: the pool's complete leaf ` +
      'history does not rebuild the on-chain Merkle root, so a leaf on chain is not where its ' +
      'event says, and no path this client builds would be accepted. Nothing was proved, funded ' +
      'or sent, and the note is untouched. Retrying will not help until the pool is repaired.',
  );
}

/**
 * ⛔ [close-v1, audit v1 F28, web mitigation of a founder item] A POOL WHOSE
 * TREE HOLDS A NON-CANONICAL VALUE TAKES NO DEPOSIT FROM THIS CLIENT.
 *
 * The deployed program reads EVERY `filled_subtrees` entry, and the root,
 * through `felt_from_bytes` (shield_denominated_v3.rs:47-58, 435-437, 453): the
 * upper 24 bytes must be zero and the low limb below the Goldilocks modulus,
 * or the insert fails InvalidMerkleRoot. Nothing stops a depositor from
 * storing such a value (a raw commitment, or a hint), and from then on every
 * deposit and v3 transfer into the pool is refused, for ever (audit v1 F28,
 * litesvm; v4 withdrawals still land). The web root fold reads only the levels
 * the next insertion turns right at, so a bad value at an unread level passed
 * the pre-flight: the proof was generated, the float paid, and the insert
 * refused on chain. This check mirrors the program's, over the raw bytes, and
 * throws `POOL_DEPOSITS_BRICKED:` before any proof, payment or upload. It names
 * no value and no level. Pinned by `closeV1L3PoolPreflight.test.ts`.
 */
export const POOL_DEPOSITS_BRICKED = 'POOL_DEPOSITS_BRICKED';

function isCanonicalFelt32(bytes: Uint8Array): boolean {
  for (let i = 8; i < 32; i++) if (bytes[i] !== 0) return false;
  let v = 0n;
  for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(bytes[b]!);
  return v < GOLDILOCKS_MODULUS;
}

/** MerkleTreeStateV3: disc(8) | pool(32) | root@40 | leaf_count@72 | depth@80 | vec len@81 | entries@85. */
export function treeHoldsNonCanonicalValue(treeData: Uint8Array): boolean {
  if (treeData.length < 85) return false;
  if (!isCanonicalFelt32(treeData.subarray(40, 72))) return true;
  const count = new DataView(treeData.buffer, treeData.byteOffset, treeData.byteLength).getUint32(81, true);
  for (let i = 0; i < count; i++) {
    const at = 85 + i * 32;
    if (at + 32 > treeData.length) break;
    if (!isCanonicalFelt32(treeData.subarray(at, at + 32))) return true;
  }
  return false;
}

function assertTreeValuesCanonical(treeData: Uint8Array): void {
  if (!treeHoldsNonCanonicalValue(treeData)) return;
  throw new Error(
    `${POOL_DEPOSITS_BRICKED}: this pool's tree holds a value the program refuses to read, so ` +
      'the program rejects every deposit into it until the pool is repaired. Nothing was proved, ' +
      'funded or sent. Withdrawals are not affected.',
  );
}

/**
 * Convert slot to epoch. Mirrors mobile slotToEpoch lines 721-723.
 */
export function slotToEpoch(slot: number): bigint {
  return BigInt(Math.floor(slot / SLOTS_PER_EPOCH));
}

// ---------------------------------------------------------------------------
// Pool configuration types (mirror mobile lines 114-130)
// ---------------------------------------------------------------------------

/**
 * Which denominated pool family a request targets.
 *
 * This used to be the literal `'SOL'` in every request type, which meant the
 * Pool tab silently kept shielding SOL after the header switched to USDC — the
 * user believed they were shielding one asset while the worker shielded another.
 * `findPoolV3` and `getPoolsForTokenV3` already handled both; only the types
 * were closed.
 *
 * Starknet assets are deliberately NOT in this union. Their pool path is the
 * STRK20 Privacy Pool, whose SDK is access-gated (`chains/starknet.ts:205`
 * wires `shieldToStealth` to a throwing gate), so there is no pool this client
 * can reach for STRK or ETH today and pretending otherwise in a type would be
 * the same defect one layer down.
 */
export type PoolToken = PoolConfig['token'];

export interface PoolConfig {
  token: 'SOL' | 'USDC';
  tokenMint: PublicKey;
  denomination: number;
  denominationAtomic: bigint;
  decimals: number;
  poolPDA: PublicKey;
  treePDA: PublicKey;
  vaultATA?: PublicKey;
  version?: 'v2' | 'v3';
  /**
   * Whether this pool still accepts NEW deposits. Absent is treated as closed
   * (`depositBlockFor`), so a pool added to the table without a decision is not
   * silently opened.
   *
   * ⛔ THIS IS AN ENTRANCE FLAG AND NOTHING ELSE. It is read by exactly one
   * decision — `depositBlockFor`, which `handlePoolShieldPrepare` consults
   * before it prepares a deposit. It is NOT read by scanning, note-blob
   * resolution, unshield, subscribe or float recovery, and it must never be:
   * the 0.1 SOL pool is closed here and held 10 UNSPENT notes worth 1.0 SOL
   * when measured on chain 2026-08-20. Filtering `SOL_POOLS_V3` /
   * `ALL_POOLS_V3` / `getPoolsForTokenV3` on this field would report those
   * notes as gone. You close the entrance, never the exit.
   *
   * 🚨 A PREVIOUS ROUND ADDED THIS FLAG AND ONLY A REACT CHIP READ IT, so the
   * deposit engine was fail-OPEN for every other caller — a script, the live
   * devnet harness, a future client. The guarantee lives in the worker handler;
   * the picker is only the convenience.
   */
  deposits?: 'open' | 'closed';
}

// ---------------------------------------------------------------------------
// V3/V4 pool tables (mirror mobile lines 2732-2848)
// ---------------------------------------------------------------------------

export const SOL_POOLS_V3: PoolConfig[] = [
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 0.1, decimals: 9,
    denominationAtomic: 100_000_000n,
    poolPDA: new PublicKey('HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG'),
    treePDA: new PublicKey('43MRQ91VrrxkD2PqV4QXNJG3BUmu8JmbDUTtWt2dYBAU'),
    version: 'v3',
    // ⛔ CLOSED. ONE DENOMINATION, AND IT IS 1 SOL. Founder decision 2026-08-21.
    //
    // This pool was briefly reopened the same day on an argument that was
    // arithmetically right and strategically wrong. The arithmetic: an anonymity
    // set counts NOTES, not lamports, so the same capital buys ten times more of
    // them here (42.9 SOL = ~420 notes at 0.1, ~42 at 1). The mistake was
    // forgetting what the number is FOR.
    //
    // An anonymity set in a pool the demo does not use is worth nothing to the
    // claim the demo makes. Quoting 420 while showing a spend from a pool of 42
    // is exactly the true-sentence-that-reads-false this project has already
    // paid for. A set does not add across denominations, it SPLITS — so the
    // right move is one denomination everywhere, and the one that already
    // carries the proven journey.
    //
    // Measured 2026-08-21: 41 leaves, 12 unspent notes. They stay scannable,
    // spendable, subscribable and sweepable — closing an entrance is not closing
    // an exit, and the read paths below never consult this flag.
    deposits: 'closed',
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 1, decimals: 9,
    denominationAtomic: 1_000_000_000n,
    poolPDA: new PublicKey('6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS'),
    treePDA: new PublicKey('GGJQwEigkoSk3pzg6eiLtt1cu2kYfCtV5JewNJsMkNdi'),
    version: 'v3',
    // 🎯 THE ONE OPEN POOL. Every deposit this project makes lands here, and
    // that is a decision rather than an accident (founder, 2026-08-21).
    //
    // Three reasons, in the order they matter:
    //  1. An anonymity set does not add across denominations, it SPLITS. Two
    //     half-full pools are strictly worse than one full one.
    //  2. It is the pool the frozen demo journey runs through, so the number we
    //     quote and the spend we show come from the same place. A set measured
    //     somewhere else is a true sentence that reads as a false one.
    //  3. It is under the relay ceiling (MAX_RELAY_LAMPORTS), which 10 SOL and
    //     up are not.
    //
    // Measured 2026-08-20: 34 leaves, 11 unspent notes. The deposit campaign
    // (depositCampaign.test.ts) exists to move that second number and nothing
    // else — it is the only lever on the anonymity set that is not code.
    // Frozen demo: shield 5DiMyNkJdZxa… leaf 33, subscribe 4E39AJ37BFZq…
    // vault 7xUisNg8HKhg… 1.00340344 SOL.
    deposits: 'open',
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 10, decimals: 9,
    denominationAtomic: 10_000_000_000n,
    poolPDA: new PublicKey('H91CcAemoNktnW785XfnMjQqwThRNe127X5c2XuwtvwQ'),
    treePDA: new PublicKey('AFLnk8gEVY38zG6fopuNb2oHyPZyjVsvyN3wqNVVyWFs'),
    version: 'v3',
    // Over the relay's 2.5 SOL ceiling: a deposit here needs the denomination
    // plus 0.3% plus ~0.57 SOL of proof rent up front, which the relay refuses
    // outright — measured 2026-08-20, 0 leaves in this pool and 100% of
    // attempts would take the money and land nothing. `depositBlockFor` blocks
    // it on the arithmetic too, which is what stays true if this flag is
    // flipped back by hand.
    deposits: 'closed',
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 100, decimals: 9,
    denominationAtomic: 100_000_000_000n,
    poolPDA: new PublicKey('AWWQ2QpB6omxywWU5RQYD7D5QvC5kjqo71Vj8QJxCUKu'),
    treePDA: new PublicKey('2DNoAGmpBmq3uTgqVVgE8yKcnGtVk4gkL5n5QHgU97G1'),
    version: 'v3',
    // Over the relay's 2.5 SOL ceiling: a deposit here needs the denomination
    // plus 0.3% plus ~0.57 SOL of proof rent up front, which the relay refuses
    // outright — measured 2026-08-20, 0 leaves in this pool and 100% of
    // attempts would take the money and land nothing. `depositBlockFor` blocks
    // it on the arithmetic too, which is what stays true if this flag is
    // flipped back by hand.
    deposits: 'closed',
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 500, decimals: 9,
    denominationAtomic: 500_000_000_000n,
    poolPDA: new PublicKey('A6Dp4q8rVMmhM1F4bXL8VV6BER4xGgmiqoYXQhfhGGAh'),
    treePDA: new PublicKey('BvDHQeryXC1WBYyqdnDsw6QZEUxk3ht86adiwuGm1eme'),
    version: 'v3',
    // Over the relay's 2.5 SOL ceiling: a deposit here needs the denomination
    // plus 0.3% plus ~0.57 SOL of proof rent up front, which the relay refuses
    // outright — measured 2026-08-20, 0 leaves in this pool and 100% of
    // attempts would take the money and land nothing. `depositBlockFor` blocks
    // it on the arithmetic too, which is what stays true if this flag is
    // flipped back by hand.
    deposits: 'closed',
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 1000, decimals: 9,
    denominationAtomic: 1_000_000_000_000n,
    poolPDA: new PublicKey('ASMW2Gtg9q2J64jaLhVqHmXBFUmuFtRi9WQoKNdVed7X'),
    treePDA: new PublicKey('ANwpHYapKrw94pxcDfg7ggAad2MwmG5Gr4NYMvLC7Yb1'),
    version: 'v3',
    // Over the relay's 2.5 SOL ceiling: a deposit here needs the denomination
    // plus 0.3% plus ~0.57 SOL of proof rent up front, which the relay refuses
    // outright — measured 2026-08-20, 0 leaves in this pool and 100% of
    // attempts would take the money and land nothing. `depositBlockFor` blocks
    // it on the arithmetic too, which is what stays true if this flag is
    // flipped back by hand.
    deposits: 'closed',
  },
];

// USDC V3 — vaultATA derived lazily (getAssociatedTokenAddress).
export const USDC_POOLS_V3: PoolConfig[] = [
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 1, decimals: 6,
    denominationAtomic: 1_000_000n,
    poolPDA: new PublicKey('AnBmWYRKGmcPSVTSgYZJeFgqaHmyLTzT1VJbmejXVSib'),
    treePDA: new PublicKey('FwxkCXBSGjeNqjEpbBGAjuYB5fLV4iqddMbqPq9UDpcz'),
    version: 'v3',
    // No USDC leg exists end-to-end: the panel's shield/withdraw calls are
    // hardcoded to SOL (`PoolPanel.tsx`, `poolIsSolOnly`) and no relay route
    // funds a USDC deposit. Closed rather than offered.
    deposits: 'closed',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 10, decimals: 6,
    denominationAtomic: 10_000_000n,
    poolPDA: new PublicKey('58xgMmQJQbh2H5QMvw7Sw9CmnEGww17i4YtESJU7pcm4'),
    treePDA: new PublicKey('H4syFMw5HovpQ8usEJiPsp69T8VUK6HbnNAcFAS8BewQ'),
    version: 'v3',
    // No USDC leg exists end-to-end: the panel's shield/withdraw calls are
    // hardcoded to SOL (`PoolPanel.tsx`, `poolIsSolOnly`) and no relay route
    // funds a USDC deposit. Closed rather than offered.
    deposits: 'closed',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 100, decimals: 6,
    denominationAtomic: 100_000_000n,
    poolPDA: new PublicKey('Dm6XJCkrqEjd9iC6uMyeaJQ5ADNB4Dd3ap3cCjyUP2RA'),
    treePDA: new PublicKey('GkDqmFJYRx3FJYSbVAULde4WU8q31WSZmHkT1g5HuYKs'),
    version: 'v3',
    // No USDC leg exists end-to-end: the panel's shield/withdraw calls are
    // hardcoded to SOL (`PoolPanel.tsx`, `poolIsSolOnly`) and no relay route
    // funds a USDC deposit. Closed rather than offered.
    deposits: 'closed',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 1000, decimals: 6,
    denominationAtomic: 1_000_000_000n,
    poolPDA: new PublicKey('BwVswgqjXayXBbwu3WXrbB2MxcJdoRr5KC1aUfwqmGxT'),
    treePDA: new PublicKey('FpmYv4NiAGYKZDvytGEzcmaajZ9voHRjLFpqU8rCunZb'),
    version: 'v3',
    // No USDC leg exists end-to-end: the panel's shield/withdraw calls are
    // hardcoded to SOL (`PoolPanel.tsx`, `poolIsSolOnly`) and no relay route
    // funds a USDC deposit. Closed rather than offered.
    deposits: 'closed',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 10000, decimals: 6,
    denominationAtomic: 10_000_000_000n,
    poolPDA: new PublicKey('5tjCa8FS41pdAg7dzH6wVePVDPJvbiBSbQxYRwgtXC3w'),
    treePDA: new PublicKey('ABjs9guDCV1th3ixp4hmx2SkGdNBKXuDEptzcBnZjVj4'),
    version: 'v3',
    // No USDC leg exists end-to-end: the panel's shield/withdraw calls are
    // hardcoded to SOL (`PoolPanel.tsx`, `poolIsSolOnly`) and no relay route
    // funds a USDC deposit. Closed rather than offered.
    deposits: 'closed',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 20000, decimals: 6,
    denominationAtomic: 20_000_000_000n,
    poolPDA: new PublicKey('A6nJv8ib2ek5WjUzknw7ijRRvfTH4Q2Ds63VNpq7FefM'),
    treePDA: new PublicKey('Fw7UvkiBwZyNrUo8WohZWagHLwwArrdKrW6t1PRvzVii'),
    version: 'v3',
    // No USDC leg exists end-to-end: the panel's shield/withdraw calls are
    // hardcoded to SOL (`PoolPanel.tsx`, `poolIsSolOnly`) and no relay route
    // funds a USDC deposit. Closed rather than offered.
    deposits: 'closed',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 50000, decimals: 6,
    denominationAtomic: 50_000_000_000n,
    poolPDA: new PublicKey('27evdDgKsXYa73dpBtULcZMyNMNhk9zhHsFFtNT92M3w'),
    treePDA: new PublicKey('BCoV7J3uaq57bsLGBTubnS1en31GxXnexoXBWJ4e8YpL'),
    version: 'v3',
    // No USDC leg exists end-to-end: the panel's shield/withdraw calls are
    // hardcoded to SOL (`PoolPanel.tsx`, `poolIsSolOnly`) and no relay route
    // funds a USDC deposit. Closed rather than offered.
    deposits: 'closed',
  },
];

export const ALL_POOLS_V3: PoolConfig[] = [...SOL_POOLS_V3, ...USDC_POOLS_V3];

/** Mirror mobile getPoolsForTokenV3 line 2842. */
export function getPoolsForTokenV3(token: 'SOL' | 'USDC'): PoolConfig[] {
  return token === 'SOL' ? SOL_POOLS_V3 : USDC_POOLS_V3;
}

/**
 * Which pools a scan sweeps when the caller names no denomination.
 *
 * ⚠️ READ-SIDE, and deliberately NOT one of the deposit-side exports below —
 * do not substitute it for either. A scan is an EXIT, and the block below is
 * about entrances.
 *
 * A default scan reads every pool it is given, and each one costs a floor of
 * roughly a minute of RPC (measured 2026-08-12 on Helius). One denomination is
 * live — 1 SOL, the founder decision of 2026-08-21 and the one the demo spends
 * from — so sweeping the other buys a minute per scan for notes almost nobody
 * holds.
 *
 * 🚨 WHAT THIS COSTS, MEASURED 2026-08-28 AND NOT GUESSED: the 0.1 SOL pool
 * holds 53 unspent notes against the 1 SOL pool's 46 — MORE live notes than the
 * denomination the demo spends from. After this they no longer appear in a scan
 * that names no denomination, so a holder sees a balance that does not mention
 * them. Founder decision, taken with that number in front of it.
 *
 * ⛔ THEY ARE NOT UNREACHABLE, and that distinction is the whole design. An
 * explicit `denomination: 0.1` request still resolves through `findPoolV3` and
 * scans, spends, subscribes and sweeps exactly as before. Closing an entrance
 * is not closing an exit, and neither is narrowing a default.
 */
export const DEFAULT_SCAN_DENOMINATIONS: Readonly<Record<string, number[]>> = {
  SOL: [1],
  USDC: [],
};

/** The pools a denomination-less scan should read. See the note above. */
export function getPoolsToScanByDefault(token: 'SOL' | 'USDC'): PoolConfig[] {
  const wanted = DEFAULT_SCAN_DENOMINATIONS[token] ?? [];
  return getPoolsForTokenV3(token).filter((p) => wanted.includes(p.denomination));
}

/** Mirror mobile findPoolV3 line 2846. */
export function findPoolV3(token: 'SOL' | 'USDC', denomination: number): PoolConfig | undefined {
  return ALL_POOLS_V3.find(p => p.token === token && p.denomination === denomination);
}

// ---------------------------------------------------------------------------
// Which pools accept a NEW deposit — the entrance, never the exit
// ---------------------------------------------------------------------------
//
// ⛔ EVERY EXPORT BELOW IS DEPOSIT-SIDE. None of them may ever be substituted
// for `SOL_POOLS_V3`, `ALL_POOLS_V3`, `getPoolsForTokenV3` or `findPoolV3` on a
// read path. Scanning, note-blob resolution, unshield, subscribe and float
// recovery enumerate the FULL table; the 0.1 SOL pool is closed here and held
// 10 unspent notes (1.0 SOL) on 2026-08-20.
//
// TWO INDEPENDENT REASONS A POOL IS BLOCKED, and the order matters:
//
//  1. `over-relay-cap` — ARITHMETIC. The relay that funds a deposit refuses
//     anything above MAX_RELAY_LAMPORTS, and a shield's pre-fund is the
//     denomination plus 0.3% plus ~0.57 SOL of refundable proof rent. For
//     10/100/500/1000 SOL that sum is over the cap, so the deposit takes the
//     buyer's money and delivers nothing, 100% of the time. Measured from
//     source 2026-08-20.
//  2. `closed` — POLICY. The `deposits` flag on the pool.
//
// The arithmetic OUTRANKS the flag, deliberately: it is the reason that stays
// true if someone flips a flag back by hand, so a hand-reopened 10 SOL pool is
// still refused while the relay cannot fund it.

/**
 * The relay's per-call ceiling, MIRRORED from `app/api/relay-to-buyer/route.ts`
 * (the `MAX_RELAY_LAMPORTS` literal, 2_500_000_000 as of 2026-08-20).
 *
 * 🚨 IT IS A MIRROR, NOT THE SOURCE. That route belongs to another lot and a
 * Next route module cannot be imported from a node unit test, so the value is
 * copied here and `relayCapDenominations.test.ts` fs-reads the route's own
 * source and asserts the two agree. If the route moves its cap, that test goes
 * red — instead of this picker quietly offering a denomination the relay would
 * refuse.
 */
export const MAX_RELAY_LAMPORTS = 2_500_000_000;

/**
 * The non-denomination half of a shield's pre-fund: proof-buffer rent, the
 * ephemeral's tx-fee budget and the rent margin.
 *
 * MEASURED on devnet, not estimated. A 1 SOL deposit pre-funded 1,573,486,080
 * lamports (`shieldEphemeral.ts:270`). The real figure varies with the C6 proof
 * size, which is far below the 0.01 SOL granularity the jitter rounds to.
 *
 * ⚠️ CORRECTED 2026-08-21 — THE SPLIT WAS WRONG, AND IT WAS THE HALF PEOPLE QUOTE.
 * This used to read "of which 1,003,475,300 was value, leaving 570,010,780 of
 * refundable rent". The value leg is not that number: `shieldEphemeral.ts:293`
 * computes it as `denominationAtomic + denominationAtomic * 30 / 10_000`, which
 * for a 1 SOL note is 1,003,000,000 EXACTLY — see `shieldValueLamports` below.
 * The 475,300 difference is buffer rent from a slightly larger proof, and calling
 * it value overstates what a buyer pays on the RELAYED path, where the value leg
 * is literally the amount their wallet sends to the till.
 *
 * The honest split of that run: 1,003,000,000 value + 570,486,080 non-value
 * (buffer rent, the 3,000,000 tx budget, the 2,000,000 rent margin). This
 * constant sits 475,300 BELOW that run's non-value part, which is why everything
 * derived from it must carry headroom rather than sit on the number.
 */
const SHIELD_RENT_LEG_LAMPORTS = 570_010_780;

/** `fee::SHIELD_FEE_BPS = 30` (0.3%), `shield_denominated_v3.rs:218-220`. */
const SHIELD_FEE_BPS = 30n;
const BPS_DENOMINATOR = 10_000n;

/**
 * The bare pre-fund `prepareShield` computes, before jitter.
 *
 * Mirrors `shieldEphemeral.ts:277-281` term for term, INCLUDING the fact that
 * it adds `denominationAtomic` straight into a lamport sum for every token. For
 * USDC that over-states the SOL a deposit needs — but it is what the deposit
 * path actually asks the relay for, so it is what the relay actually refuses,
 * and an estimate that disagreed with the code would be the wrong kind of
 * accurate.
 */
function shieldPrefundBareLamports(denominationAtomic: bigint): number {
  const protocolFee = Number((denominationAtomic * SHIELD_FEE_BPS) / BPS_DENOMINATOR);
  return Number(denominationAtomic) + protocolFee + SHIELD_RENT_LEG_LAMPORTS;
}

/**
 * The most `jitterPrefund` can turn `bare` into: rounded UP to a whole 0.01 SOL
 * plus up to four more of them.
 *
 * The headroom is not decoration. Without it the ceiling would admit a
 * denomination that fits on an average draw and fails on an unlucky one — a
 * deposit that works most days is worse to debug than one that never works.
 */
function shieldPrefundWorstCase(bare: number): number {
  const rounded = Math.ceil(bare / PREFUND_STEP_LAMPORTS) * PREFUND_STEP_LAMPORTS;
  return rounded + PREFUND_MAX_EXTRA_STEPS * PREFUND_STEP_LAMPORTS;
}

/**
 * What a wallet must hold, worst case, to shield one note into `pool`.
 *
 * This is the number the relay compares against its cap, which is why the
 * picker's ceiling is arithmetic over this rather than a hand-kept list of
 * "good" denominations — a list goes stale silently the moment either constant
 * moves, which is the same failure shape as a flag only one view reads.
 */
/**
 * The VALUE leg of a shield: the denomination plus the protocol's own 0.3%.
 *
 * Mirrors `shieldEphemeral.ts:293` term for term, and it is the number that
 * matters to a buyer on the relayed path — it is exactly what leaves their
 * wallet for the till, and exactly what `/api/relay-to-buyer` reads back as
 * `received` from the till's balance delta.
 *
 * ⛔ NOT the pre-fund. `estimateShieldPrefundLamports` adds the refundable
 * proof rent, which on a relayed deposit the FLOAT fronts and gets back — so
 * quoting it to the buyer overstates what they pay and, worse, promises them a
 * refund that goes somewhere else.
 */
export function shieldValueLamports(pool: PoolConfig): number {
  const protocolFee = Number((pool.denominationAtomic * SHIELD_FEE_BPS) / BPS_DENOMINATOR);
  return Number(pool.denominationAtomic) + protocolFee;
}

export function estimateShieldPrefundLamports(pool: PoolConfig): number {
  return shieldPrefundWorstCase(shieldPrefundBareLamports(pool.denominationAtomic));
}

/**
 * The largest denomination, in whole token units, whose worst-case pre-fund
 * still fits under the relay cap. Derived, never asserted: binary search over
 * `estimateShieldPrefundLamports` itself, so it cannot drift from the function
 * the block decision uses.
 *
 * For SOL today it lands at ~1.884 — above the 1 SOL demo pool and far below
 * the 10 SOL rung, which is the whole reason exactly one SOL pool survives.
 */
export function maxRelayableDenomination(token: PoolToken): number {
  const decimals = getPoolsForTokenV3(token)[0]?.decimals ?? 9;
  // `estimate(atomic) >= atomic` for every token, so nothing above the cap can
  // fit and the cap itself is a safe upper bound for the search.
  let lo = 0n;
  let hi = BigInt(MAX_RELAY_LAMPORTS);
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (shieldPrefundWorstCase(shieldPrefundBareLamports(mid)) <= MAX_RELAY_LAMPORTS) {
      lo = mid;
    } else {
      hi = mid - 1n;
    }
  }
  return Number(lo) / 10 ** decimals;
}

export type DepositBlockReason = 'closed' | 'over-relay-cap';

export interface DepositBlock {
  reason: DepositBlockReason;
  /** Shown to the user verbatim. Says what is blocked AND what still works. */
  message: string;
}

/**
 * Why this pool cannot take a new deposit, or `null` if it can.
 *
 * The single decision both halves read: the worker handler refuses on it, and
 * the panel renders it. One function so the screen and the engine cannot
 * disagree — the previous round shipped exactly that disagreement.
 */
export function depositBlockFor(pool: PoolConfig): DepositBlock | null {
  // ⚠️ THE RELAY CAP IS A LAMPORT BOUND, SO IT ONLY MEANS ANYTHING FOR SOL.
  //
  // `estimateShieldPrefundLamports` runs on `denominationAtomic`, and for a
  // 6-decimal USDC pool those atoms are not lamports. An earlier version
  // compared them anyway and told the buyer a 1000 USDC deposit "needs about
  // 1.57 SOL up front" — a number with no meaning, in the wrong unit, rendered
  // verbatim to the user. Non-SOL pools fall through to the plain closure
  // below, whose sentence is true for every token.
  const required = pool.token === 'SOL' ? estimateShieldPrefundLamports(pool) : 0;
  if (required > MAX_RELAY_LAMPORTS) {
    return {
      reason: 'over-relay-cap',
      message:
        `The ${pool.denomination} ${pool.token} pool is closed to new deposits: funding one ` +
        `needs about ${(required / 1e9).toFixed(2)} SOL up front and the relay refuses ` +
        `anything above ${(MAX_RELAY_LAMPORTS / 1e9).toFixed(1)} SOL, so the deposit would ` +
        `take the money and never land. Notes you already hold there stay spendable.`,
    };
  }
  // Anything not explicitly opened is closed. A pool added to the table without
  // a decision must not be silently offered.
  if (pool.deposits !== 'open') {
    return {
      reason: 'closed',
      message:
        `The ${pool.denomination} ${pool.token} pool is closed to new deposits so that every ` +
        `deposit lands in one anonymity set instead of splitting across six. Notes you ` +
        `already hold there stay spendable — you can still withdraw or subscribe with them.`,
    };
  }
  return null;
}

/**
 * The pools a picker may OFFER. Deposit-side only.
 *
 * ⛔ Never use this to enumerate pools for scanning, spending or recovery — see
 * `denominationsForRecovery`.
 */
export function poolsOpenForDeposit(token: PoolToken): PoolConfig[] {
  return getPoolsForTokenV3(token).filter((p) => depositBlockFor(p) === null);
}

/**
 * Every denomination, closed or not, for the float-recovery sweep.
 *
 * 🚨 THIS EXISTS SO RECOVERY CAN NEVER BE KEYED TO THE DEPOSIT PICKER. It was
 * once the denomination selector, and a user with ~1 SOL of proof-buffer rent
 * stranded in the 0.1 SOL pool clicked Recover and read "nothing stranded"
 * about a pool that was never searched (`PoolPanel.tsx`, `handleRecover`).
 * Closing the 0.1 pool to deposits makes that coupling fatal rather than
 * unlucky, so the two lists are separate functions with separate names.
 */
export function denominationsForRecovery(token: PoolToken): number[] {
  return getPoolsForTokenV3(token)
    .map((p) => p.denomination)
    .sort((a, b) => a - b);
}

/**
 * Thrown by the deposit engine when a pool will not take a new note.
 *
 * ⚠️ NEITHER `instanceof` NOR `name` SURVIVES THE WORKER BOUNDARY, and an
 * earlier version of this comment claimed `name` did. `workerClient.ts:93`
 * rejects with `new Error(out.error)` — a PLAIN Error built from the message
 * string — so a main-thread caller writing
 * `err.name === 'PoolClosedToDepositsError'` gets `'Error'` and the branch never
 * fires. Only `message` crosses.
 *
 * So the GUARANTEE is not this class: it is the refusal at
 * `poolHandlers.ts:1421`, which runs inside the worker before anything moves.
 * This class exists for callers that reach the handler directly — the live
 * devnet harness does — and to carry `reason` to them. A UI that wants to branch
 * on the cause must ask `depositBlockFor` itself, which is synchronous, pure,
 * and on the same side of the boundary as the screen.
 */
export class PoolClosedToDepositsError extends Error {
  readonly reason: DepositBlockReason;

  constructor(block: DepositBlock) {
    super(block.message);
    this.name = 'PoolClosedToDepositsError';
    this.reason = block.reason;
  }
}

// ---------------------------------------------------------------------------
// Types (mirror mobile lines 241-256, 550-553)
// ---------------------------------------------------------------------------

export interface ShieldReceipt {
  secret: bigint;
  nullifierPreimage: bigint;
  /**
   * Third input to the commitment: `poseidon(nullifier, poseidon(X, mint))`.
   *
   * It was the real `deposit_epoch` (slot / 7200) until commitment blinding
   * landed; it is now a 63-bit PRF blinding derived from the wallet seed
   * (`noteBlinding.ts`). Nothing on-chain reads it — C1's public inputs are
   * `[nullifier, commitment]` and this value is a PRIVATE witness — so the
   * rename is purely descriptive and the two are interchangeable at the field
   * level. Legacy notes still carry a real epoch here and MUST keep working.
   *
   * The serialized form (`ShareableNote.deposit_epoch`, and the same key in the
   * PQ-encrypted note blob written by `poolHandlers.ts`) deliberately keeps its
   * old name: changing the wire key without a version bump would make
   * `extractStoredPath` stop matching previously stored blobs and silently drop
   * the stored Merkle path.
   *
   * NEVER publish this value in instruction data. See `UNSHIELD_MIN_EPOCH`.
   */
  noteBlinding: bigint;
  tokenMint: bigint;
  commitment: bigint;
  leafIndex: number;
  denomination: bigint;
  pool: string;
  token: 'SOL' | 'USDC';
  denominationHuman: number;
  shieldedAt: number;
  merklePathElements?: bigint[];
  merklePathIndices?: number[];
  merkleRoot?: bigint;
  /** Provenance: a self-shielded note vs one received via a private transfer. */
  source?: 'shielded' | 'received';
}

export interface OnChainCommitment {
  commitment: bigint;
  leafIndex: number;
  /**
   * The fee payer of the transaction that inserted this leaf, base58.
   *
   * 🚨 WHY A NOTE'S DEPOSITOR IS WORTH CARRYING AROUND. Spending a note
   * republishes, in cleartext, the exact commitment its deposit emitted — the
   * program forces it (`subscribe_private_stark.rs`: the C1 inputs hash binds
   * the argument, C3 proves it is a leaf, the root must be the pool's). So a
   * stranger walks spend → commitment → deposit in one hop, and lands on
   * whoever paid for that deposit.
   *
   * If that is the same wallet now spending the note, then routing the spend
   * through a third-party funder buys NOTHING: the wallet is still one hop away
   * through the deposit. That configuration is the single way to do everything
   * else right and still be found, and it is invisible from the spend screen.
   *
   * Free to collect: this scan already fetches the full transaction for every
   * pool signature in order to read the event log. The payer is
   * `accountKeys[0]` of what is already in hand.
   *
   * `null` when the transaction carried no readable header.
   */
  depositPayer: string | null;
  /**
   * The slot the deposit landed in.
   *
   * 🚨 WHAT MAKES A NOTE'S AGE MEASURABLE, AND WHY AGE IS NOT COSMETIC.
   * A note minted the moment it is bought carries the buyer's clock. MEASURED
   * 2026-08-18: the purchase settled at 05:31:35 and the depositing ephemeral
   * was funded at 05:31:36 — one second — so walking spend → commitment →
   * deposit → its funder → "the transfer one second earlier" names the buyer
   * with no guessing at all. A crowd does not dilute a one-second window: a
   * thousand buyers a day still leave exactly one transfer in that second.
   *
   * Age is the only thing that turns that join back into a guess. An issuer
   * that will only hand out notes deposited long ago cannot mint to order, so
   * the deposit stops carrying any information about who asked for it.
   *
   * Free to collect: the scan already holds the transaction. `null` when the
   * response carried no slot.
   */
  depositSlot: number | null;
  /** The insert transaction, so a caller can show or verify the claim. */
  signature: string;
}

/**
 * The fee payer of a fetched transaction, across both message versions.
 *
 * Always the FIRST static account key and never one loaded from an address
 * lookup table, which is what makes this safe to read without resolving
 * lookups — the same property probe P6 relies on.
 */
function feePayerOf(tx: {
  transaction: { message: unknown };
}): string | null {
  const msg = tx.transaction.message as {
    accountKeys?: Array<{ toBase58(): string }>;
    staticAccountKeys?: Array<{ toBase58(): string }>;
  };
  const first = msg.staticAccountKeys?.[0] ?? msg.accountKeys?.[0];
  return first ? first.toBase58() : null;
}

// ---------------------------------------------------------------------------
// Field arithmetic helpers (mirror mobile lines 2518-2538)
// ---------------------------------------------------------------------------

/**
 * poseidonHash2 — alias for goldilocksHash2to1.
 * Mirrors mobile import alias: `goldilocksHash2to1 as poseidonHash2`.
 */
const poseidonHash2 = goldilocksHash2to1;

/** U64_MASK — matches mobile U64_MASK_V3 = (1n << 64n) - 1n. */
export const U64_MASK_V3 = (1n << 64n) - 1n;

/** Reduce x into Goldilocks field. Mirrors mobile toGoldilocks. */
function toGoldilocks(x: bigint): bigint {
  const r = x % GOLDILOCKS_MODULUS;
  return r < 0n ? r + GOLDILOCKS_MODULUS : r;
}

// ---------------------------------------------------------------------------
// Note material derivation (mirror mobile lines 332-350)
// ---------------------------------------------------------------------------

/** BN254 field order used by deriveNoteMaterial for `% FIELD_ORDER` reduction
 * (same as mobile: notes use HKDF output reduced mod FIELD_ORDER). */
const FIELD_ORDER = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

/**
 * Derive (secret, nullifierPreimage) deterministically.
 *
 * HKDF-SHA256, salt='p01-note-v1', info=`<poolPDA.base58>:<counter>:{secret|nullifier}`.
 * Mirrors mobile deriveNoteMaterial lines 332-350.
 *
 * NOTE: inputs are reduced mod FIELD_ORDER (BN254 order), NOT Goldilocks.
 * The C6/C1 circuits then reduce them mod Goldilocks via `& U64_MASK_V3`
 * inside createCommitmentV3. This matches the mobile verbatim.
 */
export function deriveNoteMaterial(
  walletSeed: Uint8Array,
  poolPDA: PublicKey,
  counter: number,
): { secret: bigint; nullifierPreimage: bigint } {
  const salt = utf8ToBytes('p01-note-v1');
  const base = concatBytes(
    utf8ToBytes(poolPDA.toBase58() + ':'),
    utf8ToBytes(String(counter)),
  );
  const secretBytes = hkdf(sha256, walletSeed, salt, concatBytes(base, utf8ToBytes(':secret')), 32);
  const nullifierBytes = hkdf(sha256, walletSeed, salt, concatBytes(base, utf8ToBytes(':nullifier')), 32);
  const toField = (bs: Uint8Array) => {
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bs[i]);
    return n % FIELD_ORDER;
  };
  return { secret: toField(secretBytes), nullifierPreimage: toField(nullifierBytes) };
}

// ---------------------------------------------------------------------------
// pubkeyToField (mirror mobile lines 427-432)
// ---------------------------------------------------------------------------

/**
 * Encode a Solana pubkey as a BN254 field element (big-endian bytes mod
 * FIELD_ORDER). Mirrors mobile pubkeyToField lines 427-432.
 */
export function pubkeyToField(pubkey: PublicKey): bigint {
  const bytes = pubkey.toBytes();
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bytes[i]);
  return n % FIELD_ORDER;
}

// ---------------------------------------------------------------------------
// V3 Commitment and Nullifier (mirror mobile lines 2560-2590)
// ---------------------------------------------------------------------------

/**
 * V3 commitment — three sequential t=3 (hash2) calls.
 *
 *   nullifier  = poseidon(nullifier_preimage & u64mask, secret & u64mask)
 *   epoch_hash = poseidon(deposit_epoch & u64mask,      token_mint & u64mask)
 *   commitment = poseidon(nullifier, epoch_hash)
 *
 * Mirrors mobile createCommitmentV3 lines 2560-2575.
 * MUST match the on-chain AIR formula in
 * stark/src/air/denominated_pool.rs lines 349-351.
 *
 * The third argument keeps its historical name because this function IS the
 * shared formula and its parameter order is load-bearing across three clients.
 * Its MEANING changed: for notes shielded since commitment blinding it is
 * `ShieldReceipt.noteBlinding`, a 63-bit PRF value; for legacy notes it is a
 * real `slot / 7200` epoch. The circuit accepts any field element, which is
 * exactly what keeps legacy notes provable — never add a range check here.
 */
export function createCommitmentV3(
  nullifierPreimage: bigint,
  secret: bigint,
  depositEpoch: bigint,
  tokenMint: bigint,
): bigint {
  const nullifier = poseidonHash2(
    toGoldilocks(nullifierPreimage & U64_MASK_V3),
    toGoldilocks(secret & U64_MASK_V3),
  );
  const epochHash = poseidonHash2(
    toGoldilocks(depositEpoch & U64_MASK_V3),
    toGoldilocks(tokenMint & U64_MASK_V3),
  );
  return poseidonHash2(nullifier, epochHash);
}

/**
 * V3 nullifier = poseidon(nullifier_preimage, secret).
 * Mirrors mobile createNullifierV3 lines 2582-2590.
 */
export function createNullifierV3(
  nullifierPreimage: bigint,
  secret: bigint,
): bigint {
  return poseidonHash2(
    toGoldilocks(nullifierPreimage & U64_MASK_V3),
    toGoldilocks(secret & U64_MASK_V3),
  );
}

// ---------------------------------------------------------------------------
// V3 zero-hash cascade (mirror mobile lines 2603-2607)
// ---------------------------------------------------------------------------

let _zeroHashesV3: bigint[] | null = null;

/** Mirrors mobile computeZeroHashesV3 lines 2603-2607. */
export function computeZeroHashesV3(): bigint[] {
  if (_zeroHashesV3) return _zeroHashesV3;
  _zeroHashesV3 = computeGoldilocksZeroCascade(MERKLE_DEPTH);
  return _zeroHashesV3;
}

// ---------------------------------------------------------------------------
// Goldilocks byte serialization (mirror mobile lines 2622-2625, 701-709)
// ---------------------------------------------------------------------------

/**
 * Little-endian 32-byte serialization of a Goldilocks u64.
 * Mirrors mobile goldilocksToLeBytes32 lines 2622-2625.
 */
export function goldilocksToLeBytes32(value: bigint): number[] {
  return bigintToLeBytes32(value & U64_MASK_V3);
}

/**
 * Little-endian 32-byte array from any bigint.
 * Mirrors mobile bigintToLeBytes32 lines 701-709.
 */
export function bigintToLeBytes32(n: bigint): number[] {
  const bytes: number[] = new Array(32);
  let tmp = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(tmp & 0xFFn);
    tmp >>= 8n;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// V3 Merkle helpers (mirror mobile lines 2675-2709)
// ---------------------------------------------------------------------------

/**
 * Incremental insert: given on-chain filledSubtrees and leafIndex,
 * compute newRoot + updated subtrees + path for C6 proof.
 * Mirrors mobile computeNewRootFromSubtreesV3 lines 2675-2709.
 */
export function computeNewRootFromSubtreesV3(
  leaf: bigint,
  leafIndex: number,
  filledSubtrees: bigint[],
): {
  newRoot: bigint;
  updatedSubtrees: bigint[];
  pathElements: bigint[];
  pathIndices: number[];
} {
  const zeros = computeZeroHashesV3();
  // Normalize to EXACTLY MERKLE_DEPTH entries. The on-chain filled_subtrees Vec
  // is depth+1 (16) but shield_denominated_v3 requires new_subtrees.len() ==
  // tree_depth (15) — passing 16 fails with InvalidMerkleRoot (merkle_tree_v3.rs
  // :164). Pad short arrays with the canonical zero for that level.
  const subtrees = Array.from({ length: MERKLE_DEPTH }, (_, i) => filledSubtrees[i] ?? zeros[i]);
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];

  let current = leaf;
  let idx = leafIndex;

  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const isRight = idx & 1;
    pathIndices.push(isRight);

    if (isRight === 0) {
      pathElements.push(zeros[level]);
      subtrees[level] = current;
      current = poseidonHash2(current, zeros[level]);
    } else {
      pathElements.push(subtrees[level]);
      current = poseidonHash2(subtrees[level], current);
    }
    idx >>= 1;
  }

  return { newRoot: current, updatedSubtrees: subtrees, pathElements, pathIndices };
}

// ---------------------------------------------------------------------------
// parseFilledSubtrees (mirror mobile lines 1293-1310)
// ---------------------------------------------------------------------------

/**
 * Parse on-chain MerkleTreeStateV3 account to extract leafCount and
 * filledSubtrees.
 *
 * Layout after discriminator (8):
 *   pool: Pubkey (32)
 *   authority: Pubkey (32)
 *   leaf_count: u64 (8)
 *   depth: u8 (1)
 *   filled_subtrees: Vec<[u8;32]> (4-byte len prefix + entries)
 *
 * Mirrors mobile parseFilledSubtrees lines 1293-1310.
 */
export function parseFilledSubtrees(
  treeData: Buffer,
): { leafCount: number; subtrees: bigint[] } {
  const leafCount = Number(treeData.readBigUInt64LE(8 + 32 + 32));
  const vecLen = treeData.readUInt32LE(8 + 32 + 32 + 8 + 1);

  const subtrees: bigint[] = [];
  let offset = 8 + 32 + 32 + 8 + 1 + 4;
  for (let i = 0; i < vecLen; i++) {
    let val = 0n;
    for (let b = 31; b >= 0; b--) {
      val = (val << 8n) | BigInt(treeData[offset + b]);
    }
    subtrees.push(val);
    offset += 32;
  }

  return { leafCount, subtrees };
}

// ---------------------------------------------------------------------------
// Anchor discriminator (mirror mobile getDiscriminator lines 1316-1319)
// ---------------------------------------------------------------------------

function getDiscriminator(name: string): Buffer {
  const hash = sha256(utf8ToBytes(`global:${name}`));
  return Buffer.from(hash.slice(0, 8));
}

/**
 * The first eight bytes of a circuit-7 withdrawal's instruction data.
 *
 * Exported because `/api/claim-for-payment` classifies a transaction that
 * credited the till: a plain transfer pays the full price, while a withdrawal
 * routed straight to the till pays the denomination minus `UNSHIELD_FEE_BPS`
 * and is recognised by exactly these bytes under `ZK_SHIELDED_PROGRAM_ID`. The
 * relayed variant is exported so it can be REFUSED: its fee payer is the
 * relayer, so no buyer-controlled key exists to sign a claim.
 */
export const UNSHIELD_V4_DISCRIMINATOR: Buffer = getDiscriminator('unshield_denominated_stark_v4');
export const UNSHIELD_V4_RELAYED_DISCRIMINATOR: Buffer = getDiscriminator(
  'unshield_denominated_stark_v4_relayed',
);

// ---------------------------------------------------------------------------
// Nullifier PDA (mirror mobile lines 1396-1401)
// ---------------------------------------------------------------------------

/**
 * Derive the nullifier PDA for a pool.
 * Seeds: [b"nullifier", pool.key(), nullifier_bytes].
 * Mirrors mobile deriveNullifierPDA lines 1396-1401.
 */
export function deriveNullifierPDA(
  poolKey: PublicKey,
  nullifierBytes: Uint8Array | number[],
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('nullifier'), poolKey.toBuffer(), Buffer.from(nullifierBytes)],
    ZK_SHIELDED_PROGRAM_ID,
  );
}

/**
 * `NullifierRecord` = 8 discriminator + 32 pool + 1 bump.
 * `programs/zk_shielded/src/state/nullifier_set.rs:146-155`.
 *
 * Note what the account does NOT hold: the nullifier itself. That value lives
 * only in the PDA seeds, which is exactly why the spent-set can be fetched
 * without naming a single note — see `fetchSpentNullifierSet`.
 */
const NULLIFIER_RECORD_LEN = 41;
const NULLIFIER_RECORD_POOL_OFFSET = 8;

/**
 * Every spent nullifier in one pool, as a set of PDA addresses.
 *
 * 🚨 THIS EXISTS TO CLOSE A DEANONYMISATION CHANNEL. Read before replacing it
 * with a per-note lookup, which is what it replaced.
 *
 * A note's nullifier is secret until the spend publishes it. The previous
 * implementation asked the RPC `getAccountInfo(nullifierPDA)` once per unspent
 * note, on every scan, from the user's browser — so an ordinary page load handed
 * the provider a list of PDAs that do not exist yet. Days later one of them is
 * created by a withdrawal. The provider joins on the PDA and recovers the IP that
 * pre-queried it. That is a full deanonymisation which needs no relayer
 * participation and survives a perfectly honest one.
 *
 * This asks a different question: "which nullifier records exist for this pool",
 * whose answer is identical for every user and reveals nothing about the caller.
 * Membership is then decided locally. The pool key is the memcmp filter, so the
 * response is bounded by the pool's spent count, not by the whole program.
 *
 * Returns base58 PDA addresses; pair it with `isNullifierSpentInSet`.
 */
export async function fetchSpentNullifierSet(
  connection: Connection,
  poolPDA: PublicKey,
): Promise<Set<string>> {
  const accounts = await connection.getProgramAccounts(ZK_SHIELDED_PROGRAM_ID, {
    // `dataSlice: 0` — we need the addresses, never the bodies. The body is only
    // the pool key we already filtered on plus a bump.
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { dataSize: NULLIFIER_RECORD_LEN },
      { memcmp: { offset: NULLIFIER_RECORD_POOL_OFFSET, bytes: poolPDA.toBase58() } },
    ],
  });
  return new Set(accounts.map((a) => a.pubkey.toBase58()));
}

/**
 * The pool's UNSPENT note count, read from `DenominatedPoolV3.note_count`.
 *
 * This is the anonymity set. The tree's leaf count is not: it counts every note
 * ever inserted, including every one already withdrawn, and those cannot hide
 * anybody. Measured on devnet 2026-08-12 — the 0.1 SOL pool held 34 leaves and
 * 8 unspent notes, the 1 SOL pool 25 and 6. Quoting the leaf count would have
 * overstated the set by more than 4x.
 *
 * Layout (`programs/zk_shielded/src/state/pool_v3.rs:53-98`), Anchor 8-byte
 * discriminator first: authority 8..40, token_mint 40..72, denomination 72..80,
 * epoch_delay 80..88, merkle_root 88..120, tree_depth 120, next_leaf_index
 * 121..129, vk_hash 129..161, total_shielded 161..169, note_count 169..177.
 */
const POOL_V3_NOTE_COUNT_OFFSET = 169;

export async function readPoolUnspentCount(
  connection: Connection,
  poolPDA: PublicKey,
): Promise<number> {
  const info = await connection.getAccountInfo(poolPDA);
  if (!info) throw new Error(`Pool account not found: ${poolPDA.toBase58()}`);
  const data = Buffer.from(info.data);
  return Number(data.readBigUInt64LE(POOL_V3_NOTE_COUNT_OFFSET));
}

/**
 * Decide spent-ness locally against a set from `fetchSpentNullifierSet`.
 *
 * Pure computation, no network. The nullifier is recomputed with
 * `createNullifierV3` — identical to the C1 public input — so no proof is needed.
 */
export function isNullifierSpentInSet(
  spentSet: ReadonlySet<string>,
  poolPDA: PublicKey,
  nullifierPreimage: bigint,
  secret: bigint,
): boolean {
  const nullifier = createNullifierV3(nullifierPreimage, secret);
  const [nullifierPDA] = deriveNullifierPDA(poolPDA, goldilocksU64To32(nullifier));
  return spentSet.has(nullifierPDA.toBase58());
}

// The single-note `isNullifierSpent` (a `getAccountInfo` on the note's own
// nullifier PDA) is gone: every web caller asks the pool-wide set instead
// (`noPointedNullifierRead.test.ts`, "the web app source has none").

// ---------------------------------------------------------------------------
// goldilocksU64To32 (mirrors mobile/subscriptionVault line 44 + extension)
// ---------------------------------------------------------------------------

/**
 * Encode a Goldilocks u64 commitment into 32-byte subscriber_commitment.
 * Bytes 0..8 = u64 LE, bytes 8..32 = 0.
 */
export function goldilocksU64To32(commitment: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = commitment & U64_MASK_V3;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xFFn);
    v >>= 8n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// sign + send helper
// ---------------------------------------------------------------------------

async function signSendConfirmTx(
  connection: Connection,
  tx: Transaction,
  signer: WalletSigner,
): Promise<string> {
  const { signature: sig, blockhash, lastValidBlockHeight } = await sendWithFreshBlockhash(
    connection,
    tx,
    (t) => signer.signTransaction(t),
    signer.publicKey,
  );
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}

/**
 * V3 submit that routes through the p01_relayer when the `relayerEnabled`
 * setting is on (hides the user's submission IP + the outer fee-payer), and
 * falls back to direct submission on ANY relayer error — mirrors mobile's
 * `signAndSendV3`. NOTE: the inner tx is still signed by the user, so the
 * inner unshield signer remains visible on-chain; relaying closes the IP (L19)
 * + outer-fee-payer (L17) leaks only. Full inner-signer anonymity is a separate
 * phase (A.5/B/D), unbuilt on mobile too.
 */
async function signSendV3(
  connection: Connection,
  tx: Transaction,
  signer: WalletSigner,
  onProgress?: (step: string) => void,
): Promise<string> {
  // Step 1 (web /pay): no relayer yet — submit directly. The relayer path
  // (sender-IP + outer-fee-payer anonymity) is Step 2; when it lands here it
  // wraps this call exactly as the extension does (settings gate -> relayer ->
  // direct fallback). Submitting directly changes only the transport, never the
  // proof/commitment math, so the pool math stays byte-identical to the proven
  // extension flow.
  void onProgress;
  return signSendConfirmTx(connection, tx, signer);
}

// ---------------------------------------------------------------------------
// shield_denominated_v3 instruction builder
// Mirrors mobile buildShieldDenominatedV3Ix lines 2866-2908
// ---------------------------------------------------------------------------

/**
 * Build `shield_denominated_v3` instruction.
 *
 * Args: commitment[32] | old_subtree_root[32] | new_subtree_root[32] |
 *       Vec<[u8;32]> new_subtrees.
 *
 * ⛔ `new_root` IS NO LONGER AN ARGUMENT. Since the C6 depth cut the program
 * COMPUTES the pool root by folding the top 3 levels against the pool account's
 * own `filled_subtrees`; a caller-supplied pool root is exactly what that fold
 * exists to refuse. Adding it back here would not be rejected by the layout --
 * it would shift every following byte and the instruction would fail to
 * deserialize, which is the good case. The bad case is adding it back on BOTH
 * sides.
 *
 * Account order mirrors shield_denominated_v3.rs.
 */
function buildShieldDenominatedV3Ix(
  depositor: PublicKey,
  poolPDA: PublicKey,
  treePDA: PublicKey,
  c6ProofBuffer: PublicKey,
  commitment: number[],
  oldSubtreeRoot: number[],
  newSubtreeRoot: number[],
  newSubtrees: number[][],
  tokenProgram?: PublicKey,
  userTokenAccount?: PublicKey,
  poolVault?: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('shield_denominated_v3');
  const subtreesBytesLen = 4 + newSubtrees.length * 32;
  const data = Buffer.alloc(8 + 32 + 32 + 32 + subtreesBytesLen);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(commitment).copy(data, offset); offset += 32;
  Buffer.from(oldSubtreeRoot).copy(data, offset); offset += 32;
  Buffer.from(newSubtreeRoot).copy(data, offset); offset += 32;
  data.writeUInt32LE(newSubtrees.length, offset); offset += 4;
  for (const st of newSubtrees) {
    Buffer.from(st).copy(data, offset);
    offset += 32;
  }

  const [feeEscrowPDA] = deriveFeeEscrowPDA(poolPDA);

  const keys = [
    { pubkey: depositor, isSigner: true, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: treePDA, isSigner: false, isWritable: true },
    { pubkey: c6ProofBuffer, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: tokenProgram || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: userTokenAccount || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!userTokenAccount },
    { pubkey: poolVault || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!poolVault },
    { pubkey: feeEscrowPDA, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

// ---------------------------------------------------------------------------
// shieldV3 — high-level shield using C6 proof
// Adapted from mobile shieldV3 lines 3053-3188.
// KEY ADAPTATION: uses submitAndVerifyStarkProof (legacy, non-uniform)
// instead of submitAndVerifyStarkProofUniform — required for the extension.
// ---------------------------------------------------------------------------

/**
 * V3 shield: generate C6 proof and call shield_denominated_v3.
 *
 * Adaptation from mobile: uses extension's legacy submitAndVerifyStarkProof
 * instead of submitAndVerifyStarkProofUniform (the uniform 145KB pipeline is
 * mobile-only). The on-chain shield_denominated_v3 handler reads the verified
 * buffer PDA regardless of which upload path was used.
 */
export async function shieldV3(
  poolConfig: PoolConfig,
  c6ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number; circuitId: number },
  insertParams: {
    commitment: bigint;
    /** Client-side tree bookkeeping only; NOT sent to the program any more. */
    newRoot: bigint;
    /** C6 public input 2. Must fold back to the pool's current root on chain. */
    oldSubtreeRoot: bigint;
    /** C6 public input 3. */
    newSubtreeRoot: bigint;
    newSubtrees: bigint[];
    secret: bigint;
    nullifierPreimage: bigint;
    noteBlinding: bigint;
    leafIndex: number;
  },
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
  /** [CLOSE-SWEEP 2026-09-13] sweep the signer's whole balance here in the SAME transaction as the buffer close. */
  options?: { sweepTo?: PublicKey },
): Promise<{ txSig: string; receipt: ShieldReceipt; c6ProofBuffer: PublicKey }> {
  let c6ProofBuffer!: PublicKey;
  try {
    // 1. Submit + verify C6 proof on-chain (legacy non-uniform pipeline).
    onProgress?.('Submitting C6 (merkle_update) proof on-chain...');
    const proof: GenericStarkProof = {
      proofBytes: c6ProofResult.proofBytes,
      circuitId: CIRCUIT_MERKLE_UPDATE,
      publicInputs: c6ProofResult.publicInputs,
      proofSize: c6ProofResult.proofSize,
    };
    const c6Result = await submitAndVerifyStarkProof(proof, signer, connection, onProgress);
    c6ProofBuffer = c6Result.proofBuffer;

    // 2. Build shield_denominated_v3.
    onProgress?.('Building V3 shield transaction...');
    const isNativeSOL = poolConfig.tokenMint.equals(NATIVE_SOL_MINT);
    let tokenProgram: PublicKey | undefined;
    let userTokenAccount: PublicKey | undefined;
    let poolVault: PublicKey | undefined;

    if (!isNativeSOL) {
      tokenProgram = TOKEN_PROGRAM_ID;
      userTokenAccount = await getAssociatedTokenAddress(
        poolConfig.tokenMint,
        signer.publicKey,
      );
      // Derive vaultATA lazily if not in config.
      poolVault = poolConfig.vaultATA
        ?? await getAssociatedTokenAddress(poolConfig.tokenMint, poolConfig.poolPDA, true);
    }

    const commitmentBytes = goldilocksToLeBytes32(insertParams.commitment);
    const oldSubtreeRootBytes = goldilocksToLeBytes32(insertParams.oldSubtreeRoot);
    const newSubtreeRootBytes = goldilocksToLeBytes32(insertParams.newSubtreeRoot);
    const newSubtreesBytes = insertParams.newSubtrees.map(goldilocksToLeBytes32);

    const ix = buildShieldDenominatedV3Ix(
      signer.publicKey,
      poolConfig.poolPDA,
      poolConfig.treePDA,
      c6ProofBuffer,
      commitmentBytes,
      oldSubtreeRootBytes,
      newSubtreeRootBytes,
      newSubtreesBytes,
      tokenProgram,
      userTokenAccount,
      poolVault,
    );

    const tx = new Transaction();
    // [C6-D12] 300,000 -> 600,000.
    //
    // MEASURED 2026-08-29 (`subscribe_v4_adversarial::the_walk_is_what_the_new_
    // instruction_pays_for`, litesvm SBF VM): one on-chain Poseidon-GL `hash2`
    // costs ~34,469 CU. The fold does SIX -- three levels, old root and new root
    // -- so it adds ~206,814 CU by itself, before any of the deposit's existing
    // work. 300,000 was not enough and the deposit would have failed with
    // `exceeded CUs`, at the END of the whole proof-upload sequence.
    //
    // ⚠️ 600,000 IS A HEADROOM CHOICE, NOT A MEASUREMENT OF THIS PATH. The
    // number that is measured is the fold's; the shield handler's own total has
    // not been measured on the SBF VM since the fold landed. It is well under
    // the 1,400,000 cap and requesting more than needed costs only a marginally
    // higher priority fee, so erring high is the cheap direction here.
    // [ZK-DEPTH-11 2026-08-30] 600,000 -> 700,000. The fold walks FOUR levels
    // now, so it does EIGHT `hash2` calls (four levels x old root and new root)
    // instead of six: ~275,752 CU at the ~34,469 measured per hash, up from
    // ~206,814. ⚠️ Still headroom rather than a measurement of this handler's
    // total, which has not been run on the SBF VM since the cut.
    tx.add(...buildComputeBudgetIxs(700_000));
    if (!isNativeSOL && userTokenAccount) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey,
          userTokenAccount,
          signer.publicKey,
          poolConfig.tokenMint,
        ),
      );
    }
    tx.add(ix);

    onProgress?.('Sending V3 shield transaction...');
    const txSig = await signSendConfirmTx(connection, tx, signer);
    onProgress?.('V3 shield confirmed!');

    const receipt: ShieldReceipt = {
      secret: insertParams.secret,
      nullifierPreimage: insertParams.nullifierPreimage,
      noteBlinding: insertParams.noteBlinding,
      tokenMint: pubkeyToField(poolConfig.tokenMint),
      commitment: insertParams.commitment,
      leafIndex: insertParams.leafIndex,
      denomination: poolConfig.denominationAtomic,
      pool: poolConfig.poolPDA.toBase58(),
      token: poolConfig.token,
      denominationHuman: poolConfig.denomination,
      shieldedAt: Date.now(),
      merkleRoot: insertParams.newRoot,
    };

    return { txSig, receipt, c6ProofBuffer };
  } finally {
    if (c6ProofBuffer) {
      try {
        onProgress?.('Closing C6 proof buffer...');
        await closeStarkProofBuffer(c6ProofBuffer, signer, connection, { sweepTo: options?.sweepTo });
      } catch (e: unknown) {
        console.warn('[DenomPool/V3] closeStarkProofBuffer failed:', e instanceof Error ? e.message : String(e));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// prepareShieldInsert — orchestration helper
// ---------------------------------------------------------------------------

/**
 * Prepare all material for a V3 shield insert:
 *   1. Read tree account and parse filledSubtrees
 *   2. Derive note material (deterministic from walletSeed + counter)
 *   3. Compute commitment, newRoot, merkle path (Goldilocks)
 *   4. Generate C6 STARK proof via WASM prover
 *
 * Returns everything shieldV3 needs. Caller passes to shieldV3 then stores
 * the receipt in the denominated pool store.
 */
export async function prepareShieldInsert(
  poolConfig: PoolConfig,
  connection: Connection,
  walletSeed: Uint8Array,
  counter: number,
  onProgress?: (step: string) => void,
  /**
   * Value to occupy the commitment's third slot (historically `deposit_epoch`).
   * Defaults to the real epoch (legacy behaviour). Callers pass a secret
   * blinding instead so the commitment cannot be recomputed from the published
   * nullifier — nothing on-chain reads this value, see noteBlinding.ts.
   */
  noteBlindingOverride?: bigint,
  /**
   * A commitment somebody ELSE derived, to be inserted as this leaf.
   *
   * \U0001f3af THE CONTRIBUTION FLOW. The depositor funds a leaf whose opening
   * they do not know: the commitment comes from the TREASURY's seed, so the
   * treasury owns the note the moment it lands and the depositor has nothing to
   * spend. They are paid in a DIFFERENT, older note instead, and the maturity
   * gate guarantees it is a different one. That ordering is what removes the
   * double-spend a swap otherwise carries -- there is no second copy of the
   * opening, because the depositor never had the first.
   *
   * The program takes the commitment as a raw instruction argument
   * (`shield_denominated_v3.rs:255-257`) and proves nothing about its preimage,
   * so this needs no program change. The C6 proof is about tree INSERTION and
   * uses only the leaf VALUE, so it is unaffected.
   *
   * \u26d4 Do not call this directly for that flow -- use
   * `prepareInsertForCommitment`, whose return type cannot carry note material.
   * When this is set, `secret`, `nullifierPreimage` and `noteBlinding` come back
   * as 0n and are MEANINGLESS: building a receipt from them would hand someone a
   * note they cannot spend.
   */
  commitmentOverride?: bigint,
): Promise<{
  c6ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number; circuitId: number };
  insertParams: {
    commitment: bigint;
    /** Client-side tree bookkeeping only; NOT sent to the program any more. */
    newRoot: bigint;
    /** C6 public input 2. Must fold back to the pool's current root on chain. */
    oldSubtreeRoot: bigint;
    /** C6 public input 3. */
    newSubtreeRoot: bigint;
    newSubtrees: bigint[];
    secret: bigint;
    nullifierPreimage: bigint;
    noteBlinding: bigint;
    leafIndex: number;
  };
  newLeaf: bigint;
  merklePath: { pathElements: bigint[]; pathIndices: number[]; root: bigint };
}> {
  // 1. Read tree account.
  onProgress?.('Reading on-chain tree state...');
  const treeInfo = await connection.getAccountInfo(poolConfig.treePDA);
  if (!treeInfo) throw new Error(`Tree account not found: ${poolConfig.treePDA.toBase58()}`);
  const treeBuf = Buffer.from(treeInfo.data);
  // [close-v1, audit v1 F28] Before anything else: a pool the program can no
  // longer insert into is refused here, not after the proof and the payment.
  assertTreeValuesCanonical(treeBuf);
  const { leafCount, subtrees } = parseFilledSubtrees(treeBuf);

  // On-chain current root (low 8 bytes LE of MerkleTreeStateV3.root @ offset 8+32).
  let onChainRoot = 0n;
  for (let b = 7; b >= 0; b--) onChainRoot = (onChainRoot << 8n) | BigInt(treeBuf[8 + 32 + b]);

  // 2-4. The commitment, either derived here or supplied by whoever owns the
  // note. See `commitmentOverride`: in the contribution flow the depositor is
  // NOT the owner, so there is no material to derive and none is returned.
  let secret = 0n;
  let nullifierPreimage = 0n;
  let noteBlinding = 0n;
  let commitment: bigint;
  if (commitmentOverride !== undefined) {
    if (commitmentOverride <= 0n) {
      // A zero leaf is the EMPTY slot the C6 proof folds as `old_leaf`, so
      // inserting it would prove a no-op and the deposit would pay for nothing.
      throw new Error('A supplied commitment must be a non-zero field element.');
    }
    commitment = commitmentOverride;
  } else {
    onProgress?.('Deriving note material...');
    ({ secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, poolConfig.poolPDA, counter));
    // Third commitment slot (historically deposit_epoch): a caller-supplied
    // secret blinding when given, otherwise the real epoch (legacy notes).
    noteBlinding = noteBlindingOverride ?? slotToEpoch(await connection.getSlot('confirmed'));
    commitment = createCommitmentV3(
      nullifierPreimage,
      secret,
      noteBlinding,
      pubkeyToField(poolConfig.tokenMint),
    );
  }

  // The commitment IS the leaf in V3. Stored as u64 LE (low 8 bytes of the
  // 32-byte field element).
  const newLeaf = commitment;

  // 5. Compute new root + path from filledSubtrees.
  //
  // The C6 proof's old_root public input MUST equal the live on-chain
  // merkle_tree.root (shield_denominated_v3.rs:104-105 binds it). old_root is
  // the WASM folding an EMPTY leaf (0) up through `pathElements`, and
  // pathElements are derived from the per-level sibling array. The on-chain
  // `filled_subtrees` Vec stores the last leaf at index 0 and the level-i
  // sibling at index i+1 (merkle_tree_v3.rs:176-184), BUT past extension
  // shields wrote that array shifted, so the canonical convention can't be
  // assumed. Rather than trust one layout, reconstruct old_root BOTH ways and
  // use whichever reproduces the on-chain root — then we only generate the
  // (~2-minute) proof when it will actually verify.
  onProgress?.('Computing Merkle path...');
  const direct = computeNewRootFromSubtreesV3(newLeaf, leafCount, subtrees);
  const sliced = computeNewRootFromSubtreesV3(newLeaf, leafCount, subtrees.slice(1));
  const oldRootDirect = computeNewRootFromSubtreesV3(ZERO_VALUE_V3, leafCount, subtrees).newRoot;
  const oldRootSliced = computeNewRootFromSubtreesV3(ZERO_VALUE_V3, leafCount, subtrees.slice(1)).newRoot;

  let chosen: typeof direct | null = null;
  if (oldRootDirect === onChainRoot) {
    chosen = direct;
  } else if (oldRootSliced === onChainRoot) {
    chosen = sliced;
  } else {
    // [AUDIT v1 r2, fix lane 1, F1] NEITHER LAYOUT MATCHING IS NOT A DIVERGED
    // TREE: IT IS WHAT ANY DEPOSITOR CAN LEAVE BEHIND.
    //
    // `filled_subtrees[1..10]` are the previous depositor's `new_subtrees`,
    // stored unverified (merkle_tree_v3.rs:223-232; "bound by nothing",
    // shield_denominated_v3.rs:184-187). An honest C6 proof with garbage there
    // lands, the pool root stays honest, and this pre-flight used to refuse
    // every later web deposit until some other client repaired the hints. The
    // program's own note says what to do instead: rebuild from `LeafInserted`
    // events. The rebuilt frontier is used ONLY if it folds to the on-chain
    // root, so a wrong or short history still ends in the refusal below,
    // before any proof is generated (`denominatedPoolLeafIntegrity.test.ts`,
    // "[R2-F1]").
    onProgress?.('Rebuilding the Merkle path from the pool history...');
    const fromLeaves = await frontierFromPoolHistory(connection, poolConfig.poolPDA, leafCount);
    if (
      fromLeaves !== null &&
      computeNewRootFromSubtreesV3(ZERO_VALUE_V3, leafCount, fromLeaves).newRoot === onChainRoot
    ) {
      chosen = computeNewRootFromSubtreesV3(newLeaf, leafCount, fromLeaves);
    } else if (fromLeaves !== null) {
      // [close-v1, audit v1 F01/F06, web mitigation of a founder item] THE
      // HISTORY IS WHOLE AND STILL DOES NOT FOLD TO THE ROOT: NOT LAG.
      //
      // `frontierFromPoolHistory` answers only when the history accounts for
      // exactly `leafCount` leaves, none missing. A root those leaves cannot
      // rebuild is a tree whose leaves are not where their events say: the
      // C6 insert position is bound to nothing on chain, so a depositor can
      // fill another empty slot while the event announces `leaf_count`. Every
      // later rebuild is wrong for ever, so "retry shortly" was a lie; the
      // stable code lets the page say what it is (close-v1 contract C2).
      // No root and no position in the message, as below.
      throw new Error(
        `${POOL_TREE_DIVERGED}: Shield pre-flight failed: the pool's complete leaf history does not ` +
          `rebuild the on-chain Merkle root, so a leaf on chain is not where its event says. ` +
          `Nothing was proved, funded or sent. Deposits into this pool stay refused until the ` +
          `pool is repaired; retrying will not help.`,
      );
    }
  }
  if (chosen === null) {
    throw new Error(
      // No root and no position in the message: it is rendered, and the leaf
      // is the one this deposit was about to take (`noteIdentifierTripwire.test.ts`).
      `Shield pre-flight failed: cannot reconstruct the on-chain Merkle root ` +
      `from the pool's filled_subtrees; neither layout matched. ` +
      `The tree state has diverged from this client — refusing to burn proof rent ` +
      `on a guaranteed InvalidProof. Retry shortly; if it persists the pool tree ` +
      `was advanced by an incompatible client.`,
    );
  }
  const { newRoot, updatedSubtrees, pathElements, pathIndices } = chosen;
  // [AUDIT v1 r2, fix lane 1, F1] THE HINTS GO WHERE THE PROGRAM PUTS THEM.
  //
  // `updatedSubtrees[l]` is the frontier at level l. The program stores
  // `new_subtrees[i]` at level i + 1 (merkle_tree_v3.rs:228, "i+1 because index
  // 0 is the leaf itself") and only below INSERT_SUBTREE_DEPTH. Sending the
  // array unshifted stored level i at i + 1 and dropped level 10 entirely, so
  // an honest web-only history stopped matching either layout at leaf 1,024.
  // Level l + 1 at index l, padded to `tree_depth` entries with the new root
  // (level 15, which the program ignores); `new_subtrees.len() == tree_depth`
  // is required (merkle_tree_v3.rs:198-201).
  const hintsForProgram = [...updatedSubtrees.slice(1, MERKLE_DEPTH), newRoot];

  // 6. Generate C6 STARK proof.
  //
  // Heartbeat, for the same reason as the pool history walk: the main thread
  // re-arms its request timeout on every progress message, so a silent stretch
  // longer than that timeout kills a job that is working fine. Loading the
  // prover and proving say nothing between them, and the '30-60s' in the label
  // was measured against the PRE-COSET blob: the coset one is 229,640 bytes
  // against 213,254, so it takes longer to fetch, compile and run. Measured in
  // production 2026-08-05: a shield died on 'The private-payment worker timed
  // out' during exactly this stretch.
  //
  // Elapsed seconds, not a percentage. Nothing here can measure its own
  // progress, and a bar that moved on a dead prover would be worse than none.
  onProgress?.('Generating the deposit proof, this takes a minute...');
  const proofStartedAt = Date.now();
  const proofHeartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - proofStartedAt) / 1000);
    onProgress?.(`Generating the deposit proof (${seconds}s)...`);
  }, 10_000);
  let c6Result;
  try {
    await starkProver.start();
    // [C6-D12] Only the bottom 12 levels go into the circuit. The top 3 are
    // the program's job now, and it does NOT accept them from us -- see
    // `state::insert_root` for why a caller-supplied top level is the whole
    // vulnerability.
    c6Result = await starkProver.generateMerkleUpdateProof(
      '0',                          // oldLeaf = 0 (empty slot)
      newLeaf.toString(),           // newLeaf = commitment u64
      pathElements.slice(0, C6_SUBTREE_DEPTH).map(e => e.toString()),
      pathIndices.slice(0, C6_SUBTREE_DEPTH),
    );
  } finally {
    clearInterval(proofHeartbeat);
  }

  const proofBytes = hexToBytes(c6Result.proofHex);
  const c6PublicInputs = c6Result.publicInputs.map(s => BigInt(s));

  // [C6-D12] The two SUBTREE roots the instruction now takes, read back from
  // the proof's own public inputs rather than recomputed here.
  //
  // The layout is [old_leaf, new_leaf, old_root, new_root, depth]. Reading them
  // from the proof is deliberate: the circuit derived them from the same 12 path
  // elements it proved over, so there is no second implementation of the walk to
  // disagree with the first. A client-side recomputation would be one more place
  // for the deposit to fail with `InvalidProof` and no explanation.
  if (c6PublicInputs.length !== 5) {
    throw new Error(
      `C6 returned ${c6PublicInputs.length} public inputs, expected 5 ` +
      `[old_leaf, new_leaf, old_root, new_root, depth]. The prover wire changed.`,
    );
  }
  if (c6PublicInputs[4] !== BigInt(C6_SUBTREE_DEPTH)) {
    throw new Error(
      `C6 proved depth ${c6PublicInputs[4]}, expected ${C6_SUBTREE_DEPTH}. ` +
      `The shipped wasm prover is stale — it predates the depth cut, and the ` +
      `on-chain verifier rejects every proof it makes. Reship the blob.`,
    );
  }

  return {
    c6ProofResult: {
      proofBytes,
      publicInputs: c6PublicInputs,
      proofSize: c6Result.proofSize,
      circuitId: CIRCUIT_MERKLE_UPDATE,
    },
    insertParams: {
      commitment,
      // Kept for the CLIENT's own tree bookkeeping. ⛔ It is no longer sent to
      // the program, which computes the pool root itself.
      newRoot,
      oldSubtreeRoot: c6PublicInputs[2],
      newSubtreeRoot: c6PublicInputs[3],
      newSubtrees: hintsForProgram,
      secret,
      nullifierPreimage,
      noteBlinding,
      leafIndex: leafCount,
    },
    newLeaf,
    // The siblings that fold THIS leaf up to `newRoot` — i.e. exactly the C3
    // merkle_path witness a later unshield needs. Surfaced (additively, no math
    // touched) so a withdrawal can reuse it instead of rebuilding every leaf
    // from transaction history, which an RPC may no longer serve. Valid while
    // `newRoot` remains in the pool's 100-entry historical root ring.
    merklePath: { pathElements, pathIndices, root: newRoot },
  };
}

/**
 * Prepare an insert for a commitment THIS CALLER DOES NOT OWN.
 *
 * \U0001f3af THE MECHANISM THAT MAKES THE TREASURY A MIXER RATHER THAN A SHOP.
 * The depositor pays, and what lands on the tree is a note derived from the
 * TREASURY's seed. They never learn its opening, so they cannot spend it and
 * there is nothing to double-spend. They are paid in a DIFFERENT note out of
 * stock -- necessarily an older one, because the maturity gate refuses to issue
 * a leaf deposited moments ago. The gate is not a workaround here: it IS the
 * mixing, and it is why the note that leaves carries somebody else's history.
 *
 * The count is unchanged: one leaf in, one leaf out. The treasury never pays a
 * denomination, only fees, which is what lets a fixed float serve indefinitely.
 *
 * \u26d4 THE RETURN TYPE OMITS `secret`, `nullifierPreimage` and `noteBlinding`
 * AND THAT IS THE POINT. It is not a documentation choice: a contributor who
 * could read those fields could build a receipt for a note that is not theirs,
 * store it, and later discover it unspendable -- or worse, race the treasury for
 * it. Making them unreachable is a type-level guarantee rather than a rule
 * somebody has to remember.
 *
 * \u26a0 The caller must still verify, AFTER the deposit confirms, that this
 * commitment landed at the leaf the treasury expects, before recording it as
 * inventory. Nothing here proves the transaction was sent, let alone accepted.
 */
export async function prepareInsertForCommitment(
  poolConfig: PoolConfig,
  connection: Connection,
  commitment: bigint,
  onProgress?: (step: string) => void,
): Promise<{
  c6ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number; circuitId: number };
  insertParams: {
    commitment: bigint;
    newRoot: bigint;
    oldSubtreeRoot: bigint;
    newSubtreeRoot: bigint;
    newSubtrees: bigint[];
    leafIndex: number;
  };
  newLeaf: bigint;
  merklePath: { pathElements: bigint[]; pathIndices: number[]; root: bigint };
}> {
  const prepared = await prepareShieldInsert(
    poolConfig,
    connection,
    // Unused on this path: no derivation happens when a commitment is supplied.
    // Passed empty rather than as a fake seed so a future edit that started
    // deriving from it would fail loudly instead of minting a wrong note.
    new Uint8Array(0),
    0,
    onProgress,
    undefined,
    commitment,
  );
  const { secret, nullifierPreimage, noteBlinding, ...insertParams } = prepared.insertParams;
  // Read once so a linter cannot drop the destructuring that strips them, and
  // so the intent survives a refactor: these are 0n and must not escape.
  void secret;
  void nullifierPreimage;
  void noteBlinding;
  return { ...prepared, insertParams };
}

// ---------------------------------------------------------------------------
// Hex helper
// ---------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ===========================================================================
// UNSHIELD — V3 Goldilocks denominated pool
//
// Ported from:
//   apps/mobile/services/denominatedPool/index.ts
//   - fetchPoolCommitments    (line 619)
//   - fetchPoolLeavesByIndex  (line 897)
//   - replayMerkleProofFromEvents (line 787) — the CORRECT rebuild for stale-subtrees on-chain
//   - unshieldDenominatedStarkV3 (line 3206)
//   - buildUnshieldDenominatedStarkV3Ix (line 2926)
//
// Extension adaptation: browser context, no Hermes/RN. DataView/Uint8Array
// for byte decoding. No `Buffer.readBigUInt64LE` on plain Uint8Array — use
// helper below. submitAndVerifyStarkProof (legacy) instead of Uniform pipeline.
// ===========================================================================

// ---------------------------------------------------------------------------
// ZERO_VALUE — canonical empty leaf for Goldilocks Poseidon tree.
// V3 pools use Goldilocks Poseidon, so the zero hash cascade starts from 0.
// Mobile line 84 uses BN254 ZERO_VALUE. For V3 with Goldilocks, the empty
// slot is 0n (computeZeroHashesV3 starts at 0n).
// ---------------------------------------------------------------------------
const ZERO_VALUE_V3 = 0n;

// ---------------------------------------------------------------------------
// LEAF_INSERTION_EVENTS — mirror mobile lines 456-527
// Same discriminators / offsets, ported byte-for-byte.
// ---------------------------------------------------------------------------
/** `Program <id> invoke [n]`, written by the runtime when a frame opens. */
const LOG_INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/;
/** `Program <id> success` / `Program <id> failed: ...`, written when it closes. */
const LOG_EXIT_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed)/;

const LEAF_INSERTION_EVENTS: ReadonlyArray<{
  name: string;
  disc: Uint8Array;
  commitmentOffset: number;
  leafIndexOffset: number;
  minLength: number;
  /** Where the event names its pool, when it does. [AUDIT v1 r2, F3] It must be the walked pool. */
  poolOffset?: number;
}> = [
  // V3 universal LeafInserted event (merkle_tree_v3.rs:209)
  // Layout after 8-byte disc:
  //   pool:      Pubkey (32) @ 8
  //   leaf_index: u64   (8)  @ 40
  //   leaf:      [u8;32](32) @ 48
  //   new_root:  [u8;32](32) @ 80
  //   old_root:  [u8;32](32) @ 112
  // Total: 144 bytes.
  {
    name: 'LeafInserted',
    disc: anchorEventDiscriminator('LeafInserted'),
    commitmentOffset: 48,
    leafIndexOffset: 40,
    minLength: 144,
    poolOffset: 8,
  },
  // V2: MerkleRootChanged — post-hardening universal event
  {
    name: 'MerkleRootChanged',
    disc: anchorEventDiscriminator('MerkleRootChanged'),
    commitmentOffset: 112, // `leaf: [u8; 32]`
    leafIndexOffset: 104,
    minLength: 144,
  },
  // ShieldDenominatedEvent V2 (with protocol_fee)
  {
    name: 'ShieldDenominatedEvent/V2',
    disc: anchorEventDiscriminator('ShieldDenominatedEvent'),
    commitmentOffset: 88,
    leafIndexOffset: 120,
    minLength: 128,
  },
  // ShieldDenominatedEvent V1 (pre-protocol_fee)
  {
    name: 'ShieldDenominatedEvent/V1',
    disc: anchorEventDiscriminator('ShieldDenominatedEvent'),
    commitmentOffset: 80,
    leafIndexOffset: 112,
    minLength: 120,
  },
  // ShieldStarkEvent — same shape as ShieldDenominated V1
  {
    name: 'ShieldStarkEvent',
    disc: anchorEventDiscriminator('ShieldStarkEvent'),
    commitmentOffset: 80,
    leafIndexOffset: 112,
    minLength: 120,
  },
  // TransferDenominatedStarkEvent
  {
    name: 'TransferDenominatedStarkEvent',
    disc: anchorEventDiscriminator('TransferDenominatedStarkEvent'),
    commitmentOffset: 72,
    leafIndexOffset: 104,
    minLength: 112,
  },
  // EscrowReleaseEvent
  {
    name: 'EscrowReleaseEvent',
    disc: anchorEventDiscriminator('EscrowReleaseEvent'),
    commitmentOffset: 105,
    leafIndexOffset: 137,
    minLength: 145,
  },
];

// ---------------------------------------------------------------------------
// Byte helpers (browser-safe — no Buffer.readBigUInt64LE on Uint8Array)
// ---------------------------------------------------------------------------

/** Read u64 little-endian from a Uint8Array at a given byte offset. */
function readU64LE(buf: Uint8Array, offset: number): bigint {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(buf[offset + i]);
  return n;
}

/** Read a 32-byte little-endian bigint from a Uint8Array at a given offset. */
function leBytes32ToBigint(buf: Uint8Array, offset: number): bigint {
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(buf[offset + i]);
  return n;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// parsePoolV3Account — inline port of mobile parsePool.ts::parsePoolV3Account
// (mobile line 117-135). Same byte layout as V2 DenominatedPool. We inline
// it here to avoid a separate file.
// ---------------------------------------------------------------------------

interface ParsedPoolV3 {
  currentRoot: Uint8Array;
  historicalRoots: Uint8Array[];
  nextLeafIndex: bigint;
  noteCount: bigint;
  isActive: boolean;
}

export function parsePoolV3Account(data: Uint8Array): ParsedPoolV3 | null {
  // Offsets from mobile parsePool.ts lines 50-63 (identical for V3):
  // 0:8   disc | 8:40 authority | 40:72 tokenMint | 72:80 denomination
  // 80:88 epochDelay | 88:120 merkle_root | 120 treeDepth | 121:129 nextLeafIdx
  // 129:161 vkHash | 161:169 totalShielded | 169:177 noteCount | 177 isActive
  // 178:182 histLen(u32) | 182: histData (N*32)
  const MIN = 182;
  if (data.length < MIN) return null;

  const currentRoot = data.slice(88, 120);
  const treeDepth = data[120]; void treeDepth;
  const nextLeafIndex = readU64LE(data, 121);
  const noteCount = readU64LE(data, 169);
  const isActive = data[177] === 1;
  const histLen = (data[178]) | (data[179] << 8) | (data[180] << 16) | (data[181] << 24);
  // 255 is `DenominatedPoolV3::MAX_HISTORICAL_ROOTS` (pool_v3.rs); a migrated
  // pool holds more than 100, and a parser that gave up there saw no ring at
  // all, which is the state that used to select a note's saved root
  // (`spendRootIsCurrent.test.ts`, "255-root ring parses").
  if (histLen > 255) return null;
  const histEnd = 182 + histLen * 32;
  if (data.length < histEnd) return null;

  const historicalRoots: Uint8Array[] = [];
  for (let i = 0; i < histLen; i++) {
    historicalRoots.push(data.slice(182 + i * 32, 182 + i * 32 + 32));
  }

  return { currentRoot, historicalRoots, nextLeafIndex, noteCount, isActive };
}

// ---------------------------------------------------------------------------
// fetchPoolCommitments — port of mobile lines 619-699
//
// Walks pool transaction history, decodes every LeafInserted / flavored event,
// and returns a Map commitment_str -> { commitment, leafIndex }.
// Extension adaptation: uses DataView/Uint8Array (not Buffer.readBigUInt64LE).
// ---------------------------------------------------------------------------

/**
 * `next_leaf_index` from the pool account, or null when the account cannot be
 * read or parsed. It never rejects: the walk starts it beside its first
 * signature page and awaits it at the end, so it must not be able to fail the
 * walk. A caller whose connection has no `getAccountInfo` (every fake in the
 * pool tests except `poolHistoryBackfill.test.ts`) simply learns nothing.
 */
/** How many of leaves 0..count-1 are absent, counting only those below `below`. */
function countMissingLeaves(have: ReadonlySet<number>, count: number, below = count): number {
  let missing = 0;
  for (let i = 0; i < Math.min(count, below); i += 1) if (!have.has(i)) missing += 1;
  return missing;
}

async function readNextLeafIndex(connection: Connection, poolPDA: PublicKey): Promise<number | null> {
  const conn = connection as Partial<Pick<Connection, 'getAccountInfo'>>;
  if (typeof conn.getAccountInfo !== 'function') return null;
  try {
    const info = await conn.getAccountInfo(poolPDA, 'confirmed');
    if (!info?.data) return null;
    const parsed = parsePoolV3Account(new Uint8Array(info.data));
    if (!parsed) return null;
    const n = Number(parsed.nextLeafIndex);
    return Number.isSafeInteger(n) && n >= 0 && n <= (1 << MERKLE_DEPTH) ? n : null;
  } catch {
    return null;
  }
}

/**
 * What one history walk could not read, reported through
 * `fetchPoolCommitments`' `onWalked` once the walk ends.
 *
 * `unread` counts signatures the RPC listed as successful whose transactions
 * this client holds no read of: the ones still waiting to be re-read, plus,
 * while the map holds fewer leaves than the pool account's `next_leaf_index`,
 * every signature a walk has given up on. It is 0 when the map holds every leaf
 * the account reports, or when nothing listed was left unread and nothing was
 * ever given up on. A map with unread signatures can end where this client
 * last read, often right after its own deposit or purchase, so its root would
 * date a note: `prepareUnshieldV4` never proves such a root unless it is the
 * current one (`spendRootIsCurrent.test.ts`, "a history cache left short by
 * its last walk, with newer inserts listed but not served, is never proved";
 * "signatures the walk gave up on keep a short map from being proved").
 */
export interface PoolWalkReport {
  unread: number;
}

/**
 * [SWEEP4 round 1, storage lane] Signatures this RUN read and found to carry no
 * leaf — a withdrawal, a subscribe, a griefer's padding. IN MEMORY ONLY: it
 * dies with the worker and is never persisted, because a stored list of
 * leafless signatures would name the user's own withdrawal, which is the row
 * field this same change removed (`poolHistoryCache.test.ts`, "[SWEEP4-STORAGE]
 * … names no transaction of this device").
 *
 * Why it exists: the saved resume point is now the newest signature that
 * INSERTED A LEAF, so every pool transaction above it is listed again on every
 * warm walk. Reading one twice is wasted work — a confirmed transaction's logs
 * do not change — so each is read once per session and skipped afterwards
 * ("costs no re-read: a leafless transaction above the newest deposit is
 * fetched once, not once per walk"). Only a transaction that was actually READ,
 * succeeded on chain and carried no leaf event enters the set: a null or
 * rejected read is a read that did not happen and stays in the re-read list.
 */
const leaflessSignatures = new Set<string>();
/** A long session must not grow this without bound; the cost of forgetting is one re-read. */
const MAX_LEAFLESS_REMEMBERED = 4096;

function rememberLeafless(signature: string): void {
  if (leaflessSignatures.size >= MAX_LEAFLESS_REMEMBERED) leaflessSignatures.clear();
  leaflessSignatures.add(signature);
}



/**
 * [SWEEP round 1 of run logs8, network lens] How many leaves one anchor window
 * holds. A device's walk lists from, and reads everything above, the leaf whose
 * index is the largest multiple of this number that lies one WHOLE window
 * behind the pool's newest leaf.
 *
 * What it buys: every browser that came at least once since that leaf was
 * inserted (between 16 and 31 deposits ago) sends the RPC the same listing
 * and the same reads. One that stayed away longer shows the window of its last
 * visit and nothing finer. What it costs: the first walk of a page load reads
 * 16 to 31 deposits again, plus the spends between them, in batches of 25.
 * Raising it widens the crowd and the re-read together. FOUNDER: the number is
 * a trade, not a measurement; `poolWalkPublicAnchor.test.ts` pins it so it
 * cannot move quietly.
 */
export const PUBLIC_ANCHOR_LEAVES = 16;

/**
 * The signature a DEVICE's walk lists `until`, or null when the row holds no
 * leaf that can serve.
 *
 * WHY NOT THE ROW'S OWN NEWEST SIGNATURE. It is the newest pool transaction at
 * the end of this browser's previous visit, and the provider's log holds the
 * same value as the newest signature it served that visit. `until == served
 * newest` joined session N+1 to session N whatever the IP, so a user who
 * deposited at home and came back through a VPN to withdraw was tied to the
 * home session by the first request of the page. The transactions READ named
 * the same cursor, which is why the walk also re-reads held leaves above the
 * anchor (`take`). Measured: `poolWalkPublicAnchor.test.ts`.
 *
 * The anchor is computed from `next_leaf_index`, which every client reads from
 * the same account, NOT from what this row holds: a client whose row ends at
 * leaf 70 and one whose row ends at leaf 95 both resume at the same leaf. Only
 * when the row does not hold that leaf (a longer absence) does it fall back to
 * the largest multiple it does hold, and when the account cannot be read, to
 * the same rule applied to the row's own top leaf. A row holding no multiple at
 * all (a history still being backfilled) keeps the old cursor: finishing the
 * walk comes first, and that state ends with the backfill.
 *
 * NOT CLOSED HERE, and rare: the `gaps` a budget-stopped delta leaves, the
 * backfill's `before`, and the re-read list are still this device's own
 * parameters. They exist only while a history longer than `maxSignatures` is
 * being completed, under a griefer's padding, or while the RPC is failing.
 */
function publicAnchorSignature(entries: CachedCommitmentEntry[], nextLeafIndex: number | null): string | null {
  let top = -1;
  for (const e of entries) if (e.leafIndex > top) top = e.leafIndex;
  const newestLeaf = nextLeafIndex !== null && nextLeafIndex > 0 ? nextLeafIndex - 1 : top;
  if (newestLeaf < 0) return null;
  const N = PUBLIC_ANCHOR_LEAVES;
  const ceiling = Math.max(0, Math.floor(newestLeaf / N) * N - N);
  let anchor: CachedCommitmentEntry | null = null;
  for (const e of entries) {
    if (e.leafIndex % N !== 0 || e.leafIndex > ceiling) continue;
    if (!anchor || e.leafIndex > anchor.leafIndex) anchor = e;
  }
  return anchor?.signature ?? null;
}

export interface FetchPoolCommitmentsOptions {
  maxSignatures?: number;
  batchSize?: number;
  onProgress?: (scanned: number, total: number) => void;
  /** [HISTORY-CACHE] Reuse the cached walk and fetch only newer signatures. Default true. */
  incremental?: boolean;
  /** Told what the walk could not read, once it ends; see `PoolWalkReport`. */
  onWalked?: (report: PoolWalkReport) => void;
  /**
   * [flow-speed X1 2026-09-23] Opt-in, for the BROWSER WORKER's callers only
   * (the page-load scan, `locateOwnedNote`, the import check). While a walk of
   * the same pool, on the same host, with the same `maxSignatures` and
   * `batchSize`, is in flight in this worker, wait for it ONCE, then run this
   * call's own full walk. See `fetchPoolCommitments`. The server routes never
   * set it: one user's request must not wait for another user's walk inside a
   * function's time limit.
   */
  joinInFlight?: boolean;
  /** While waiting on a joined walk: called every 10 s with the seconds waited. */
  onJoinWait?: (seconds: number) => void;
}

/**
 * The pool's leaves, from the history cache plus a walk of what is newer.
 *
 * [flow-speed X1 2026-09-23] SINGLE FLIGHT, BY OPT-IN. The worker awaits each
 * message concurrently, so a click on Withdraw or Subscribe while the page-load
 * scan is walking the same pool used to start a SECOND walk beside it on the one
 * paced connection, and on a first visit both were cold (the row is saved only
 * when a walk ends). With `joinInFlight`, the later call waits for the running
 * walk once, then runs its OWN full call, which starts from the row that walk
 * just saved:
 *   - its requests are exactly those of a click made after the scan finished
 *     (the same public-anchor listing, the same re-read rule); none is added and
 *     none is reshaped (`poolWalkJoin.test.ts`, "T1+T2");
 *   - its map is never older than the click, and its `onWalked` report is its
 *     own, so SPEND-1 reads a truthful `unread` ("T3");
 *   - the leader's result and error are ignored ("T4"); the entry is removed
 *     only by the walk that set it ("T5");
 *   - only the same `incremental` / `maxSignatures` / `batchSize` joins: the
 *     3000-signature refetch never joins a 1000 walk ("T6");
 *   - a store change forgets every walk in flight ("T7"); a waiting joiner
 *     reports every 10 s ("T8"); without the opt-in nothing joins ("T9").
 * No pause point is placed inside the walk itself (a joiner waits on it).
 */
export async function fetchPoolCommitments(
  connection: Connection,
  poolPDA: PublicKey,
  options: FetchPoolCommitmentsOptions = {},
): Promise<Map<string, OnChainCommitment>> {
  if (options.joinInFlight !== true || (options.incremental ?? true) !== true) {
    return walkPoolCommitments(connection, poolPDA, options);
  }
  const walks = inFlightPoolWalks();
  const key =
    `${poolHistoryKey(String(connection.rpcEndpoint ?? ''), poolPDA.toBase58())}` +
    `|${options.maxSignatures ?? 1000}|${options.batchSize ?? 25}`;
  const leader = walks.get(key);
  if (leader) {
    const waitStartedAt = Date.now();
    const heartbeat = options.onJoinWait
      ? setInterval(() => options.onJoinWait?.(Math.round((Date.now() - waitStartedAt) / 1000)), 10_000)
      : null;
    try {
      // Once, and whatever it ends in: the result below is this call's own.
      await leader.then(
        () => undefined,
        () => undefined,
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
  const own = walkPoolCommitments(connection, poolPDA, options);
  walks.set(key, own);
  try {
    return await own;
  } finally {
    if (walks.get(key) === own) walks.delete(key);
  }
}

async function walkPoolCommitments(
  connection: Connection,
  poolPDA: PublicKey,
  options: FetchPoolCommitmentsOptions,
): Promise<Map<string, OnChainCommitment>> {
  const maxSignatures = options.maxSignatures ?? 1000;
  const batchSize = options.batchSize ?? 25;
  const PAGE = 1000;
  const MAX_LEAVES = 1 << MERKLE_DEPTH;

  // [HISTORY-CACHE 2026-09-13] Start from what an earlier walk decoded and ask
  // the RPC only for signatures newer than the newest one it saw. See
  // `poolHistoryCache.ts` for the measurement that motivates this.
  //
  // [HIST-1 2026-09-16] The walk is now COMPLETED rather than frozen. Each
  // part is pinned by a case in `poolHistoryBackfill.test.ts`:
  //   - a walk stopped by `maxSignatures` resumes at `oldestSignature` ("a
  //     truncated walk is backfilled"). It used to ask only for signatures
  //     newer than the point where it stopped, so the tail was never read
  //     again;
  //   - a transaction the RPC did not serve is re-read, then dropped and
  //     counted after MAX_HISTORY_READ_ATTEMPTS ("a rejected or null
  //     getTransaction is retried"; "a signature that never reads is dropped
  //     after 5 attempts, and counted"). It used to be skipped for ever;
  //   - the pool account is read beside the page below rather than after it,
  //     so knowing whether the history is whole costs no round trip ("the
  //     upgrade path: a snapshot saved by the old walk is completed, then goes
  //     quiet").
  //   - [fix round 1] a DELTA stopped by the budget leaves a gap in the
  //     middle of the history; it is saved and paged on the next call ("growth
  //     past maxSignatures between two warm calls is completed, in a bounded
  //     number of pages"; "a griefer's failing padding above a real deposit
  //     does not hide the deposit"; "a truncated cold walk and a later delta
  //     past the budget are both completed");
  //   - [fix round 1] a hole nothing accounts for schedules one re-walk, and
  //     then waits until the pool has doubled ("a hole nothing accounts for is
  //     re-walked once, then goes quiet"; "a hole no walk can fill is re-walked
  //     once, not on every call").
  // The key is host + pool, so no stored row spells the RPC credential
  // (`poolHistoryCache.test.ts`, "[HIST-1] the snapshot key is a function of
  // host and pool only").
  const incremental = options.incremental ?? true;
  const store = getPoolHistoryStore();
  const { key: cacheKey, snapshot } = incremental
    ? await loadPoolHistory(store, connection.rpcEndpoint, poolPDA.toBase58())
    : { key: poolHistoryKey(connection.rpcEndpoint, poolPDA.toBase58()), snapshot: null };
  // Started here and awaited only after the delta page (before paging older
  // history, or before the save), so the pool read overlaps that page instead
  // of adding a round trip after it.
  const nextLeafIndexPromise = incremental ? readNextLeafIndex(connection, poolPDA) : Promise.resolve(null);

  // A v1 row left no resume point. When no deposit slot in it yields one, the
  // walk pays for a single cold pass instead of keeping the hole for ever.
  const resumable = !snapshot || snapshot.complete || snapshot.oldestSignature !== null;
  // [SWEEP round 1 of run logs8, network lens] A DEVICE's walk resumes at a
  // PUBLIC anchor, not at its own newest signature; see `publicAnchorSignature`.
  // The pool read is awaited first on that path only: the anchor is a function
  // of `next_leaf_index`, and one round trip is the price of every returning
  // browser asking the same question.
  const perDevice = incremental && store.perDevice === true;
  let until = resumable ? snapshot?.newestSignature ?? undefined : undefined;
  if (perDevice && snapshot && until !== undefined) {
    until = publicAnchorSignature(snapshot.entries, await nextLeafIndexPromise) ?? until;
  }
  const coldWalk = until === undefined;
  /** What the device's row held when the walk began: read again above the anchor, once a session. */
  const heldSignatures = new Set<string>();
  if (perDevice) for (const e of snapshot?.entries ?? []) heldSignatures.add(e.signature);
  /** Held signatures this walk reads again. A read of one that fails costs nothing: the leaf is in hand. */
  const rereads = new Set<string>();

  /** Signatures the RPC listed as successful: only these are worth re-reading. */
  const succeeded = new Set<string>();
  /** signature -> attempts so far, carried between calls by the snapshot. */
  const retry = new Map<string, number>();
  for (const r of snapshot?.retry ?? []) retry.set(r.signature, r.attempts);
  let dropped = snapshot?.dropped ?? 0;
  /**
   * [SWEEP4 repair r1, gate RED 6] Signatures this walk listed as SUCCESSFUL
   * and did not get back: a null, a 429, a log-less answer. A read that did not
   * happen, so nothing is known about what the transaction holds — including
   * whether it holds a leaf.
   *
   * ⛔ WHY IT IS KEPT SEPARATELY FROM `retry`. Two different questions are asked
   * of it below and only this set answers both: `retry` loses a signature the
   * moment the walk gives up on it (`dropped`), and a given-up signature is
   * still one the walk never read. The resume point must skip both.
   *
   * ⚠️ NOT "rejected". A transaction the CHAIN rejected is listed and never
   * fetched (`take`), so it never enters here and stays eligible as the resume
   * point — the griefer rule `poolHistoryBackfill.test.ts` holds
   * ("a griefer's failing padding above a real deposit does not hide the
   * deposit").
   */
  const unreadThisWalk = new Set<string>();
  const noteUnread = (signature: string): void => {
    unreadThisWalk.add(signature);
    const attempts = (retry.get(signature) ?? 0) + 1;
    if (attempts >= MAX_HISTORY_READ_ATTEMPTS) {
      retry.delete(signature);
      rememberGivenUpSignature(signature);
      dropped += 1;
      return;
    }
    retry.set(signature, attempts);
  };

  const sigs: Array<{ signature: string }> = [];
  /** Queued or already decoded: a signature listed twice (a merged gap, a re-walk) is fetched once. */
  const seen = new Set<string>();
  for (const e of snapshot?.entries ?? []) seen.add(e.signature);
  // The unread signatures go in ahead of the new pages, so a leaf that a
  // failed read hid comes back on the very next call.
  for (const signature of retry.keys()) {
    sigs.push({ signature });
    succeeded.add(signature);
    seen.add(signature);
  }

  const take = (page: Array<{ signature: string; err?: unknown }>, abovePublicAnchor = false): void => {
    for (const s of page) {
      // A transaction the chain rejected rolled its insert back, so it holds
      // no leaf even when its logs still carry a LeafInserted event. It is
      // listed and never fetched, and so never enters the re-read list: a
      // griefer's padding costs signature pages, not transaction reads
      // (`poolHistoryBackfill.test.ts`, "a griefer's failing padding above a
      // real deposit does not hide the deposit"; "a transaction the chain
      // rejected is not retried, an identical one that succeeded is").
      if (s.err !== null && s.err !== undefined) continue;
      if (seen.has(s.signature)) {
        // [SWEEP round 1 of run logs8, network lens] On a device, a leaf the
        // row already held is read AGAIN when it sits above the public anchor,
        // once per page load. Skipping it made the set of reads exactly "what
        // is new since this device last came", which names the last visit as
        // surely as `until` did (`poolWalkPublicAnchor.test.ts`, "two profiles
        // that last came at different moments send the SAME requests").
        if (
          abovePublicAnchor &&
          heldSignatures.has(s.signature) &&
          !rereads.has(s.signature) &&
          !wasReadThisSession(s.signature)
        ) {
          rereads.add(s.signature);
          sigs.push({ signature: s.signature });
        }
        continue;
      }
      // Read once this session, carried no leaf, and never will: listing it
      // again costs nothing, reading it again costs a round trip. See
      // `leaflessSignatures`.
      // Given up on this session: counted once into `dropped` and never asked
      // for again. See `gaveUpSignatures` — the resume point no longer moves
      // past a signature the RPC will not serve, so this is what keeps it from
      // being re-read on every walk.
      if (hasGivenUpOnSignature(s.signature)) {
        seen.add(s.signature);
        continue;
      }
      if (leaflessSignatures.has(s.signature)) {
        seen.add(s.signature);
        continue;
      }
      seen.add(s.signature);
      sigs.push({ signature: s.signature });
      succeeded.add(s.signature);
    }
  };

  let listed = 0;
  let deltaNewest: string | null = null;
  /**
   * [SWEEP4 round 1, storage lane] Every signature the DELTA pages listed,
   * newest first — including the ones the chain rejected, which are listed and
   * never fetched. The saved resume point is chosen from this list below.
   */
  const deltaSignatures: string[] = [];
  let walkedOldest: string | null = null;
  let deltaFinished = false;
  let reachedOldest = snapshot?.reachedOldest ?? false;
  let before: string | undefined;
  while (listed < maxSignatures) {
    const limit = Math.min(PAGE, maxSignatures - listed);
    const page = await connection.getSignaturesForAddress(poolPDA, { limit, before, until });
    if (page.length === 0) {
      if (coldWalk) reachedOldest = true;
      deltaFinished = true;
      break;
    }
    take(page, perDevice);
    for (const s of page) deltaSignatures.push(s.signature);
    listed += page.length;
    if (deltaNewest === null) deltaNewest = page[0].signature;
    walkedOldest = page[page.length - 1].signature;
    // Fewer signatures than asked for: on a cold walk that is the start of
    // the pool's history, and there is nothing older to come back for.
    if (page.length < limit) {
      if (coldWalk) reachedOldest = true;
      deltaFinished = true;
      break;
    }
    before = page[page.length - 1].signature;
  }

  // [HIST-1 fix round 1] A warm delta the budget stopped before it reached
  // `until` leaves a stretch in the MIDDLE of the history unlisted. The saved
  // newest signature moves past it all the same, so it is recorded here and
  // paged on the next call; without this, more than `maxSignatures` new
  // signatures between two calls (a griefer's padding is enough) hid every
  // leaf in that stretch for good (`poolHistoryBackfill.test.ts`, "growth past
  // maxSignatures between two warm calls is completed, in a bounded number of
  // pages"). Newest first.
  const gaps: PoolHistoryGap[] = (snapshot?.gaps ?? []).map((g) => ({ ...g }));
  if (!coldWalk && !deltaFinished && walkedOldest !== null && until !== undefined) {
    gaps.unshift({ before: walkedOldest, until });
  }

  // The tail a capped walk could not reach. Only a warm walk has one, and
  // only until the walk has seen the start of history.
  let backfillFrom = coldWalk ? null : snapshot?.oldestSignature ?? null;
  let wantsBackfill = backfillFrom !== null && !reachedOldest && !snapshot?.complete;
  // Only when there is older history to page is the pool read awaited here; it
  // started beside the delta page, so this adds no round trip of its own. If
  // the cached leaves already cover 0..next_leaf_index-1, nothing older can
  // hold a leaf and no page is spent ("a contiguous legacy row costs one
  // signature page and no transaction on the upgrade call").
  if (gaps.length > 0 || wantsBackfill) {
    const leafCount = await nextLeafIndexPromise;
    if (leafCount !== null && retry.size === 0) {
      const cached = new Set<number>();
      for (const e of snapshot?.entries ?? []) cached.add(e.leafIndex);
      if (countMissingLeaves(cached, leafCount) === 0) {
        gaps.length = 0;
        wantsBackfill = false;
      }
    }
  }
  const openGaps: PoolHistoryGap[] = [];
  for (const gap of gaps) {
    let closed = false;
    while (!closed && listed < maxSignatures) {
      const limit = Math.min(PAGE, maxSignatures - listed);
      const page = await connection.getSignaturesForAddress(poolPDA, { limit, before: gap.before, until: gap.until });
      take(page);
      listed += page.length;
      if (page.length > 0) gap.before = page[page.length - 1].signature;
      closed = page.length < limit;
    }
    if (!closed) openGaps.push(gap);
  }
  // Past the cap, merge the two oldest stretches into one that also spans the
  // signatures between them: those are re-listed (and skipped by `seen`), never lost.
  while (openGaps.length > MAX_HISTORY_GAPS) {
    const older = openGaps.pop()!;
    const newer = openGaps.pop()!;
    openGaps.push({ before: newer.before, until: older.until });
  }
  if (wantsBackfill && backfillFrom) {
    while (listed < maxSignatures) {
      const limit = Math.min(PAGE, maxSignatures - listed);
      const page = await connection.getSignaturesForAddress(poolPDA, { limit, before: backfillFrom });
      if (page.length === 0) {
        reachedOldest = true;
        break;
      }
      take(page);
      listed += page.length;
      backfillFrom = page[page.length - 1].signature;
      if (page.length < limit) {
        reachedOldest = true;
        break;
      }
    }
  }
  const oldestSignature = backfillFrom ?? (coldWalk ? walkedOldest : snapshot?.oldestSignature ?? null);

  // [AUDIT v1 r2, fix lane 1, F2] FILED BY LEAF INDEX, NOT BY COMMITMENT.
  //
  // The program does not refuse a commitment that is already on the tree, and
  // commitments are public, so anybody can insert one twice. Keyed by
  // commitment, the second insert overwrote the first: a hole in every rebuilt
  // tree (a root the pool never had), and on a warm walk the owner's note moved
  // to the later index, where `recoverNotes` (leafIndex === counter) no longer
  // finds it. The leaf index is what the chain orders by, so it is the key; the
  // commitment map callers read is derived from it by `commitmentMapFromLeaves`.
  const byIndex = new Map<number, OnChainCommitment>();
  for (const e of snapshot?.entries ?? []) {
    if (byIndex.has(e.leafIndex)) continue;
    byIndex.set(e.leafIndex, {
      commitment: BigInt(e.commitment),
      leafIndex: e.leafIndex,
      depositPayer: e.depositPayer,
      depositSlot: e.depositSlot,
      signature: e.signature,
    });
  }
  const zkShieldedId = ZK_SHIELDED_PROGRAM_ID.toBase58();
  const poolBytes = poolPDA.toBytes();
  for (let i = 0; i < sigs.length; i += batchSize) {
    const batch = sigs.slice(i, i + batchSize);
    const txs = await Promise.all(
      batch.map((s) =>
        connection
          .getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' })
          .catch(() => null),
      ),
    );

    for (let t = 0; t < txs.length; t++) {
      const tx = txs[t];
      const signature = batch[t]!.signature;
      const logs = tx?.meta?.logMessages;
      if (!logs) {
        // [HIST-1] A rejected, null or log-less answer for a signature the RPC
        // listed as successful is a READ THAT DID NOT HAPPEN, not a
        // transaction without leaves. It is kept for the next call instead of
        // being skipped for ever, which is how a leaf used to be lost for good
        // (`poolHistoryBackfill.test.ts`, "a rejected or null getTransaction
        // is retried").
        // Not a re-read of a leaf the row already holds: that read was made
        // for the provider's eyes, and losing it loses nothing
        // (`poolWalkPublicAnchor.test.ts`, "a failed re-read of a leaf already
        // held costs nothing").
        if (succeeded.has(signature) && !rereads.has(signature)) noteUnread(signature);
        continue;
      }
      retry.delete(signature);
      if (perDevice) rememberReadThisSession(signature);
      // A rolled-back transaction inserted nothing, whatever its logs say
      // (`poolHistoryBackfill.test.ts`, "a failed transaction that emitted a
      // leaf event is not a leaf").
      if (tx?.meta?.err) continue;
      // Who paid for this insert. Read once per transaction, outside the log
      // loop, because one transaction can emit several leaves and they all
      // share a payer.
      const depositPayer = feePayerOf(tx);
      // The deposit's own clock. Carried for the issuer's maturity rule, which
      // is what stops a note being minted to a buyer's order — see
      // `OnChainCommitment.depositSlot`.
      const depositSlot = typeof tx?.slot === 'number' ? tx.slot : null;
      let leafHere = false;
      // [AUDIT v1 r2, fix lane 1, F3] WHICH PROGRAM LOGGED THE LINE.
      //
      // `getSignaturesForAddress(poolPDA)` lists every transaction that names
      // the pool, read-only included, and any program can `sol_log_data` bytes
      // that start with the LeafInserted discriminator. Only a line logged
      // while zk_shielded is the running frame is its event. Frames come from
      // the runtime's own `Program <id> invoke [n]` / `success` / `failed`
      // lines, which a program cannot write (its `msg!` is prefixed
      // `Program log:`, its data `Program data:`). A log with no frame line at
      // all is not something a validator produces, so it carries no frame
      // information to check and is read as before.
      const framed = logs.some((l) => LOG_INVOKE_RE.test(l));
      const frames: string[] = [];
      for (const log of logs) {
        const invoke = LOG_INVOKE_RE.exec(log);
        if (invoke) {
          frames.push(invoke[1]!);
          continue;
        }
        const exit = LOG_EXIT_RE.exec(log);
        if (exit) {
          if (frames.length > 0 && frames[frames.length - 1] === exit[1]) frames.pop();
          continue;
        }
        const m = log.match(/^Program data: (.+)$/);
        if (!m) continue;
        if (framed && frames[frames.length - 1] !== zkShieldedId) continue;
        let data: Uint8Array;
        try {
          const b64 = m[1];
          const binStr = atob(b64);
          data = new Uint8Array(binStr.length);
          for (let k = 0; k < binStr.length; k++) data[k] = binStr.charCodeAt(k);
        } catch { continue; }
        if (data.length < 8) continue;
        const disc = data.subarray(0, 8);

        let decoded: { commitment: bigint; leafIndex: number } | null = null;
        for (const layout of LEAF_INSERTION_EVENTS) {
          if (!bytesEqual(disc, layout.disc)) continue;
          if (data.length < layout.minLength) continue;
          // [F3] The event names its pool: it must be THIS pool.
          if (
            layout.poolOffset !== undefined &&
            !bytesEqual(data.subarray(layout.poolOffset, layout.poolOffset + 32), poolBytes)
          ) {
            continue;
          }
          const rawIdx = readU64LE(data, layout.leafIndexOffset);
          if (rawIdx > BigInt(Number.MAX_SAFE_INTEGER)) continue;
          const leafIndex = Number(rawIdx);
          if (leafIndex < 0 || leafIndex >= MAX_LEAVES) continue;
          const commitment = leBytes32ToBigint(data, layout.commitmentOffset);
          decoded = { commitment, leafIndex };
          break;
        }
        if (!decoded) continue;
        leafHere = true;
        // A fresh, frame-checked read of the chain wins over a cached row.
        byIndex.set(decoded.leafIndex, { ...decoded, depositPayer, depositSlot, signature });
      }
      // Read, succeeded, no leaf: never worth a second read this session.
      if (!leafHere) rememberLeafless(signature);
    }

    options.onProgress?.(Math.min(i + batchSize, sigs.length), sigs.length);
  }
  let walkComplete = false;
  if (incremental) {
    // The newest signature of the DELTA (pages are newest-first), else the
    // cached one — never the older signature a backfill page just returned.
    // The map is public on-chain data, safe to keep; the key is not, which is
    // why it names the RPC host and not its query (`poolHistoryCache.ts`).
    // [SWEEP4 round 1, storage lane] IN LEAF ORDER, never in the order the
    // walks happened to decode them. The insertion order drew this device's
    // walk boundaries — how many leaves the pool held at each scan and each
    // spend preparation it ran — in a row a storage dump reads in clear. Leaf
    // order is the chain's own order, so it says nothing about who walked
    // when. Same rule the KV twin already follows (`kvPoolHistory.ts`);
    // measured by `poolHistoryCache.test.ts`, "[SWEEP4-STORAGE] … files the
    // leaves in leaf order".
    const entries: CachedCommitmentEntry[] = [...byIndex.values()]
      .map((c) => ({
        commitment: c.commitment.toString(),
        leafIndex: c.leafIndex,
        depositPayer: c.depositPayer,
        depositSlot: c.depositSlot,
        signature: c.signature,
      }))
      .sort((a, b) => a.leafIndex - b.leafIndex || (a.commitment < b.commitment ? -1 : a.commitment > b.commitment ? 1 : 0));
    // Whole = every leaf the pool says exists is in hand, with nothing left
    // to re-read. `next_leaf_index` comes from the account read started at the
    // top of this function, so a snapshot that is already contiguous is never
    // re-walked ("the upgrade path…" in `poolHistoryBackfill.test.ts`).
    const nextLeafIndex = await nextLeafIndexPromise;
    const haveIndex = new Set<number>();
    let topIndex = -1;
    for (const c of byIndex.values()) {
      haveIndex.add(c.leafIndex);
      if (c.leafIndex > topIndex) topIndex = c.leafIndex;
    }
    const complete =
      nextLeafIndex !== null && retry.size === 0 && countMissingLeaves(haveIndex, nextLeafIndex) === 0;
    walkComplete = complete;
    // A long outage must not leave a re-read list that grows without bound.
    // What is given up here is counted, never silently forgotten.
    if (retry.size > MAX_HISTORY_RETRY_ENTRIES) {
      const extra = [...retry.keys()].slice(0, retry.size - MAX_HISTORY_RETRY_ENTRIES);
      for (const s of extra) retry.delete(s);
      dropped += extra.length;
    }

    // [HIST-1 fix round 1] `complete === false` must never be a resting state.
    // When nothing pending explains a hole (no re-read, no gap, start of
    // history seen) and more leaves are missing BELOW the highest one held
    // than signatures were ever dropped, the next call re-walks the whole
    // history from the newest signature, fetching only signatures it has not
    // decoded. A hole only at the top is left alone: an account read one slot
    // ahead of the signature list looks exactly like that. One re-walk, then
    // none until next_leaf_index has doubled, so a hole no walk can fill costs
    // O(history) pages in total, not per call (`poolHistoryBackfill.test.ts`,
    // "a hole nothing accounts for is re-walked once, then goes quiet"; "a hole
    // no walk can fill is re-walked once, not on every call").
    // [SWEEP4 round 1, storage lane] A TRANSACTION THIS WALK READ AND FOUND
    // LEAFLESS IS NEVER THE SAVED RESUME POINT.
    //
    // `PoolPanel` rescans the moment a withdrawal lands, so the newest listed
    // signature was routinely the user's OWN v4 withdrawal — the pool PDA is
    // writable in it, which is why `getSignaturesForAddress` returns it at all
    // — and a storage dump read the row as "this device withdrew, there". A
    // leafless transaction adds nothing to the walk either way: skipping it
    // here costs one re-listing per walk and nothing else, since the read
    // itself happens once a session (`leaflessSignatures`). Measured by
    // `poolHistoryCache.test.ts`, "[SWEEP4-STORAGE] … names no transaction of
    // this device" and "… costs no re-read".
    //
    // ⛔ NOT "the newest leaf's signature", which was the first shape of this
    // fix: a griefer's 1,000 failing transactions above a real deposit are
    // listed but never read, so an anchor that only ever moved to a leaf left
    // them to be re-listed on every walk until they ate the whole signature
    // budget, and the deposit underneath was never reached
    // (`poolHistoryBackfill.test.ts`, "a griefer's failing padding above a
    // real deposit does not hide the deposit"). A rejected transaction is not
    // one this device's own activity produced, so it stays eligible.
    //
    // Nothing eligible in the delta (every new signature read leafless) leaves
    // the resume point where it was: the walk re-lists those few signatures
    // next time and reads none of them.
    //
    // [SWEEP4 repair r1, gate RED 6] AND NEVER ONE THIS WALK COULD NOT READ.
    // `rememberLeafless` is reached only after a SUCCESSFUL read, so the rule
    // above said nothing about a null / 429 / log-less answer — and on the very
    // path the leak was measured on, the panel rescanning the moment a
    // withdrawal lands, the unreadable transaction IS the user's own
    // withdrawal. It went straight back into the row as the resume point.
    // `unreadThisWalk` closes it; a REJECTED transaction is never in that set,
    // so the griefer rule is untouched. Measured by `poolHistoryCache.test.ts`,
    // "names no transaction of this device when the read of it FAILED".
    const newestSignature =
      deltaSignatures.find((s) => !leaflessSignatures.has(s) && !unreadThisWalk.has(s)) ??
      snapshot?.newestSignature ??
      deltaNewest ??
      null;
    let savedOldest = oldestSignature;
    let savedReachedOldest = reachedOldest;
    let rewalkAt = snapshot?.rewalkAt ?? null;
    if (
      !complete &&
      nextLeafIndex !== null &&
      newestSignature !== null &&
      reachedOldest &&
      retry.size === 0 &&
      openGaps.length === 0 &&
      countMissingLeaves(haveIndex, nextLeafIndex, topIndex) > dropped &&
      (rewalkAt === null || nextLeafIndex >= 2 * rewalkAt)
    ) {
      savedOldest = newestSignature;
      savedReachedOldest = false;
      rewalkAt = nextLeafIndex;
    }

    await store.save({
      version: POOL_HISTORY_VERSION,
      key: cacheKey,
      newestSignature,
      oldestSignature: savedOldest,
      reachedOldest: savedReachedOldest,
      complete,
      // [SWEEP4 repair r1, gate RED 6] THE RE-READ LIST KEEPS ONLY WHAT
      // LISTING WILL NOT BRING BACK.
      //
      // A raw signature in this row is a signature in a storage dump, and the
      // ones that land here newest-first are exactly this device's own recent
      // pool activity — the withdrawal whose read just failed. Every signature
      // ABOVE the saved resume point is re-listed by the next walk (`until` is
      // the resume point) and re-read then, because nothing persists the
      // leafless set; so keeping it here buys one saved re-read and costs the
      // whole join. What listing will NOT return is a signature at or below the
      // resume point — a backfill page's — and those are old history, not this
      // session's activity, so they stay.
      //
      // The `attempts` count of a dropped signature is not lost with it: the
      // walk that re-lists it finds it unread again, and `dropped` — a count,
      // not a name — is persisted. Measured by `poolHistoryCache.test.ts`,
      // "names it in NO field of the row"; the re-read behaviour itself stays
      // pinned by `poolHistoryBackfill.test.ts`.
      // ⚠️ RAW SIGNATURES, AND A DISCLOSED RESIDUAL (gate r1, RED 6).
      //
      // These are transactions the RPC LISTED as successful and did not return.
      // On the path the resume-point leak was measured on — the panel rescanning
      // the moment a withdrawal lands — the unread transaction can be the user's
      // own withdrawal, and then this field names it in clear while the RPC keeps
      // failing on it. It leaves the row on the first successful read
      // (`poolHistoryCache.test.ts`, "clears it from the row as soon as the read
      // succeeds"), so the window is the outage, not the life of the store.
      //
      // ⛔ THE THREE CHEAP FIXES WERE TRIED AND EACH BREAKS SOMETHING MEASURED:
      //   - hashing buys nothing, because the pool's signature list is PUBLIC:
      //     a dump holder hashes every pool signature and matches
      //     (`wp-logs/PROTOCOL.md`);
      //   - leaving out the entries above the resume point stops the walk
      //     converging — their attempt count restarts on every walk, so nothing
      //     is ever given up on and a short map can never be proved
      //     (`spendRootIsCurrent.test.ts`, "signatures the walk gave up on keep
      //     a short map from being proved": `dropped` measured 0, expected 2);
      //   - moving the count into this session's memory loses the attempt cap
      //     across a reload, and a permanently unreadable signature is then read
      //     once per walk for ever.
      //
      // What closes it is sealing this row the way the other stores are sealed
      // (`lib/privacy/sealedStore.ts`), which this walk cannot do today: it has
      // no identity — `fetchPoolCommitments` takes a connection and a pool, no
      // `meta` — so it is a design change, not a patch. FOUNDER / next round.
      retry: [...retry.entries()].map(([signature, attempts]) => ({ signature, attempts })),
      dropped,
      gaps: openGaps,
      rewalkAt,
      entries,
      // [SWEEP4 round 1, storage lane] Not `Date.now()`: the clock of the last
      // walk dated every scan and every spend preparation this device ran, in
      // a row a storage dump reads in clear. Nothing reads the field — the KV
      // twin already writes 0 for the same reason (`kvPoolHistory.ts`) — and
      // it stays in the shape so an older build still parses the row.
      // `poolHistoryCache.test.ts`, "[SWEEP4-STORAGE] … carries no clock".
      savedAt: 0,
    });
  }
  // Read once the re-read list and the given-up count are final, so a
  // signature given up on during this walk counts too (`PoolWalkReport`).
  options.onWalked?.({ unread: walkComplete ? 0 : retry.size + dropped });
  return commitmentMapFromLeaves(byIndex.values());
}

/**
 * [AUDIT v1 r2, fix lane 1, F2] The commitment map every caller reads, built
 * from leaves filed by index.
 *
 * - `get(commitment)` returns the FIRST insertion of that commitment (lowest
 *   leaf index). A repeat can only come after the original is public, so the
 *   first one is the owner's, and seed recovery's `leafIndex === counter`
 *   check keeps finding it.
 * - Iteration yields EVERY leaf, repeats included: a later insertion of a
 *   commitment already filed is kept under `<commitment>@<leafIndex>`. Every
 *   caller that rebuilds the tree or counts what is on it iterates
 *   `.values()` (`fetchPoolLeavesByIndex`, `leavesByIndexFromCommitments`,
 *   the worker's `leavesFromCommitments`, the routes' `onTreeAt` /
 *   `maxLeafOnTree`), so none of them sees a hole. No caller parses a key.
 */
export function commitmentMapFromLeaves(leaves: Iterable<OnChainCommitment>): Map<string, OnChainCommitment> {
  const sorted = [...leaves].sort((a, b) => a.leafIndex - b.leafIndex);
  const out = new Map<string, OnChainCommitment>();
  for (const c of sorted) {
    const key = c.commitment.toString();
    out.set(out.has(key) ? `${key}@${c.leafIndex}` : key, c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// fetchPoolLeavesByIndex — port of mobile lines 897-937
//
// Calls fetchPoolCommitments then materializes a dense array indexed by
// leafIndex. Gaps are filled with ZERO_VALUE_V3 (0n).
// ---------------------------------------------------------------------------

export async function fetchPoolLeavesByIndex(
  connection: Connection,
  poolPDA: PublicKey,
  opts: {
    maxSignatures?: number;
    onProgress?: (scanned: number, total: number) => void;
  } = {},
): Promise<{
  leavesByIndex: bigint[];
  scannedLeafCount: number;
  missing: number[];
  /** The walk's `PoolWalkReport.unread`; undefined only if the walk made no report. */
  unread: number | undefined;
}> {
  const report: { unread?: number } = {};
  const onChain = await fetchPoolCommitments(connection, poolPDA, {
    maxSignatures: opts.maxSignatures ?? 1000,
    onProgress: opts.onProgress,
    onWalked: (w) => {
      report.unread = w.unread;
    },
  });
  const MAX_LEAVES = 1 << MERKLE_DEPTH;

  let skipped = 0;
  let maxIdx = -1;
  const valid: Array<{ commitment: bigint; leafIndex: number }> = [];
  for (const e of onChain.values()) {
    if (!Number.isInteger(e.leafIndex) || e.leafIndex < 0 || e.leafIndex >= MAX_LEAVES) {
      skipped += 1;
      continue;
    }
    valid.push(e);
    if (e.leafIndex > maxIdx) maxIdx = e.leafIndex;
  }
  if (skipped > 0) {
    console.warn(
      `[DenomPool/ext] fetchPoolLeavesByIndex: skipped ${skipped} event(s) with invalid leaf_index`,
    );
  }

  const leavesByIndex: bigint[] = maxIdx >= 0 ? new Array(maxIdx + 1).fill(ZERO_VALUE_V3) : [];
  for (const e of valid) leavesByIndex[e.leafIndex] = e.commitment;
  const missing: number[] = [];
  for (let i = 0; i <= maxIdx; i++) if (leavesByIndex[i] === ZERO_VALUE_V3) missing.push(i);
  return { leavesByIndex, scannedLeafCount: maxIdx + 1, missing, unread: report.unread };
}

/**
 * [AUDIT v1 r2, fix lane 1, F1] The insertion frontier of a tree holding
 * exactly `leafCount` leaves, rebuilt from the leaves themselves: entry l is
 * the completed left sibling at level l wherever the next insertion turns
 * right there (the only entries `computeNewRootFromSubtreesV3` reads), and the
 * canonical empty-subtree root elsewhere.
 *
 * Pure. Returns `null` when `leaves` does not hold exactly `leafCount` leaves,
 * because a short or long history cannot rebuild the tree the pool has.
 */
export function frontierFromLeavesV3(leaves: bigint[], leafCount: number): bigint[] | null {
  if (!Number.isSafeInteger(leafCount) || leafCount < 0 || leafCount > 1 << MERKLE_DEPTH) return null;
  if (leaves.length !== leafCount) return null;
  const zeros = computeZeroHashesV3();
  const frontier = zeros.slice(0, MERKLE_DEPTH);
  let nodes = leaves.slice();
  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const pos = leafCount >> level;
    if (pos & 1) frontier[level] = nodes[pos - 1]!;
    const next: bigint[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      next.push(poseidonHash2(nodes[i]!, i + 1 < nodes.length ? nodes[i + 1]! : zeros[level]!));
    }
    nodes = next;
  }
  return frontier;
}

/**
 * [close-v1, audit v1 F01/F06] True only when the history DECIDES that the tree
 * diverged: the tree account names this pool, every leaf below its
 * `leaf_count` is in `leavesByIndex` with none missing, and those leaves do not
 * fold to the root stored beside that count. A short history (the RPC behind),
 * an unreadable or foreign account, or any read error answers false: the
 * caller's own refusal ("retry") stands. One account read.
 */
export async function poolTreeDiverged(
  connection: Connection,
  poolConfig: PoolConfig,
  leavesByIndex: bigint[],
  missing: number[],
): Promise<boolean> {
  try {
    const info = await connection.getAccountInfo(poolConfig.treePDA, 'confirmed');
    if (!info) return false;
    const data = new Uint8Array(info.data);
    if (data.length < 85 || !bytesEqual(data.subarray(8, 40), poolConfig.poolPDA.toBytes())) return false;
    if (treeHoldsNonCanonicalValue(data)) return false;
    const leafCount = Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(72, true));
    if (!Number.isSafeInteger(leafCount) || leafCount < 1 || leavesByIndex.length < leafCount) return false;
    if (missing.some((i) => i < leafCount)) return false;
    const frontier = frontierFromLeavesV3(leavesByIndex.slice(0, leafCount), leafCount);
    if (!frontier) return false;
    let onChainRoot = 0n;
    for (let b = 7; b >= 0; b--) onChainRoot = (onChainRoot << 8n) | BigInt(data[40 + b]!);
    return computeNewRootFromSubtreesV3(ZERO_VALUE_V3, leafCount, frontier).newRoot !== onChainRoot;
  } catch {
    return false;
  }
}

/**
 * The frontier from the pool's leaf history, or `null` when the history read
 * does not account for every one of the `leafCount` leaves the tree says it
 * holds. The caller still checks the result against the on-chain root.
 */
async function frontierFromPoolHistory(
  connection: Connection,
  poolPDA: PublicKey,
  leafCount: number,
): Promise<bigint[] | null> {
  try {
    const { leavesByIndex, missing } = await fetchPoolLeavesByIndex(connection, poolPDA);
    if (missing.length > 0 || leavesByIndex.length !== leafCount) return null;
    return frontierFromLeavesV3(leavesByIndex, leafCount);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// buildMerkleProofFromLeavesV3 — port of mobile replayMerkleProofFromEvents (line 787)
//
// WHY replayMerkleProofFromEvents and NOT buildMerkleProofFromLeaves:
//   On-chain `insert_with_root` (merkle_tree.rs:125) ONLY persists
//   filled_subtrees[0] after each insertion — higher levels stay stale at
//   their initial zero hashes. Every past shield client used the stale-subtrees
//   path when computing its new_root. A "true" Merkle rebuild from all leaves
//   produces a root NEVER in the on-chain historical ring → unshield fails.
//   We must REPLAY each insertion using the same stale logic that was accepted
//   on-chain (verified live: pool HkzArVjU, 2026-05-02).
//
// Ported from mobile lines 787-850 BYTE-FOR-BYTE. Uses V3 Goldilocks Poseidon.
// ---------------------------------------------------------------------------

export function buildMerkleProofFromLeavesV3(params: {
  leavesByIndex: bigint[];
  targetLeafIndex: number;
}): {
  root: bigint;
  pathElements: bigint[];
  pathIndices: number[];
} {
  const { leavesByIndex, targetLeafIndex } = params;
  const zeros = computeZeroHashesV3();

  // Pure level-by-level rebuild of the CURRENT tree. V3 maintains ALL subtree
  // levels on-chain (insert_with_root_v3 writes filled_subtrees[1..] from the
  // proof's new_subtrees), so a full rebuild's root equals the pool's LATEST
  // known root — robust for a note of ANY age. (The v2 stale-subtrees replay
  // only reproduced each leaf's insert-time root, which rotates out of the
  // historical ring for older notes.) Mirrors mobile buildMerkleProofFromLeavesV3.
  if (
    leavesByIndex[targetLeafIndex] === undefined ||
    leavesByIndex[targetLeafIndex] === ZERO_VALUE_V3
  ) {
    // No leaf index and no leaf count: the v3 prepare, `prepareSubscribeV4` and
    // `prepareUnshieldV4` let this error through, and PoolPanel.tsx puts an
    // error's message on screen (`spendRootIsCurrent.test.ts`, "the refusal the
    // screen shows names no leaf: no index, no count").
    throw new Error(
      'buildMerkleProofFromLeavesV3: this note is not among the pool leaves read so far. ' +
      'The RPC may not have indexed its deposit yet. Nothing was proved; wait a few seconds, then retry.',
    );
  }

  let nodes: bigint[] = leavesByIndex.length > 0
    ? leavesByIndex.map((l) => (l === undefined || l === ZERO_VALUE_V3 ? zeros[0] : l))
    : [zeros[0]];
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let idx = targetLeafIndex;

  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const siblingIdx = idx ^ 1;
    const sibling = siblingIdx < nodes.length ? nodes[siblingIdx] : zeros[level];
    pathElements.push(sibling);
    pathIndices.push(idx & 1);

    const next: bigint[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i];
      const right = i + 1 < nodes.length ? nodes[i + 1] : zeros[level];
      next.push(poseidonHash2(left, right));
    }
    nodes = next.length > 0 ? next : [zeros[level + 1]];
    idx >>= 1;
  }

  return { root: nodes[0], pathElements, pathIndices };
}

// ---------------------------------------------------------------------------
// buildUnshieldDenominatedStarkV3Ix — port of mobile lines 2926-2977
//
// Account order MUST match UnshieldDenominatedStarkV3 struct in
// programs/zk_shielded/src/instructions/unshield_denominated_stark_v3.rs:
//
//   [0] payer (mut, signer)
//   [1] denominated_pool (mut)
//   [2] merkle_tree (readonly)
//   [3] nullifier_record (mut, init)
//   [4] c1_proof_buffer (readonly)
//   [5] c3_proof_buffer (readonly)
//   [6] system_program
//   [7] token_program (Option)
//   [8] pool_vault (Option, mut)
//   [9] recipient_token_account (Option, mut)
//  [10] fee_escrow (mut)
// remaining_accounts[0]: recipient (anonymous AccountInfo, mut)
//
// Args: nullifier[32] | merkle_root[32] | min_epoch u64 | stark_commitment u64 | recipient[32]
// ---------------------------------------------------------------------------

/**
 * The `min_epoch` value every V3 withdrawal publishes at instruction byte
 * offset 72. It is ALWAYS zero and there is deliberately no way for a caller to
 * change it.
 *
 * WHY THIS IS PINNED AND NOT A PARAMETER
 * ──────────────────────────────────────
 * The field used to carry `receipt.noteBlinding` (formerly `depositEpoch`).
 * Since the commitment gained a 63-bit PRF blinding in that slot
 * (`noteBlinding.ts`), passing it here would publish the note's blinding in the
 * clear on the withdrawal transaction and cancel the entire blinding change —
 * an observer would recompute `poseidon(nullifier, poseidon(blinding, mint))`
 * and land straight back on the deposit leaf.
 *
 * Publishing 0 is safe because the on-chain handler provably ignores the field:
 * `unshield_denominated_stark_v3.rs:387` is
 * `let _ = (amount, unshield_fee, min_epoch, current_epoch, dynamic_delay, nullifier);`
 * and `min_epoch` appears nowhere else in that file (only at :80 in the arg
 * list and :173 in the handler signature). Unlike
 * `transfer_denominated_stark_v3.rs:167-173`, which DOES enforce
 * `current_epoch >= min_epoch + dynamic_delay`, unshield has no maturity gate.
 *
 * Do not turn this back into a parameter. If a future instruction genuinely
 * needs a maturity floor, it must take a real epoch that is not the blinding.
 */
export const UNSHIELD_MIN_EPOCH = 0n;

export function buildUnshieldDenominatedStarkV3Ix(
  payer: PublicKey,
  recipient: PublicKey,
  poolPDA: PublicKey,
  treePDA: PublicKey,
  nullifierPDA: PublicKey,
  c1ProofBuffer: PublicKey,
  c3ProofBuffer: PublicKey,
  nullifierBytes: number[],
  merkleRootBytes: number[],
  starkCommitment: bigint,
  subtreeRoot: bigint,
  siblings: bigint[],
  directions: number[],
  tokenProgram?: PublicKey,
  poolVault?: PublicKey,
  recipientTokenAccount?: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('unshield_denominated_stark_v3');
  // Args layout: nullifier[32] + merkle_root[32] + min_epoch u64
  //            + stark_commitment u64 + recipient[32]
  //            + subtree_root u64 + Vec<u64> siblings + Vec<u8> directions
  //
  // ⛔ THE LAST THREE ARE NOT OPTIONAL. Since 2026-08-29 the C3 proof attests
  // membership in a depth-12 SUBTREE, so the handler walks the remaining levels
  // to reach a pool root. Without them a C3 proof means "this leaf is in SOME
  // tree", which anyone satisfies with a tree they built themselves.
  if (siblings.length !== directions.length) {
    throw new Error(
      `siblings (${siblings.length}) and directions (${directions.length}) must have ` +
      `equal length — the on-chain walk refuses a mismatch with WrongSiblingCount.`,
    );
  }
  if (directions.some((d) => d !== 0 && d !== 1)) {
    throw new Error('direction bits must be 0 or 1 — NonBinaryDirection on chain.');
  }
  const data = Buffer.alloc(
    8 + 32 + 32 + 8 + 8 + 32 + 8 + (4 + siblings.length * 8) + (4 + directions.length),
  );
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(nullifierBytes).copy(data, offset); offset += 32;
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;
  // min_epoch — pinned to 0 on every path. See UNSHIELD_MIN_EPOCH above.
  data.writeBigUInt64LE(UNSHIELD_MIN_EPOCH, offset); offset += 8;
  data.writeBigUInt64LE(starkCommitment, offset); offset += 8;
  // recipient as 32-byte arg (matches `recipient: [u8; 32]` in Rust)
  Buffer.from(recipient.toBytes()).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(subtreeRoot, offset); offset += 8;
  data.writeUInt32LE(siblings.length, offset); offset += 4;
  for (const sib of siblings) { data.writeBigUInt64LE(sib, offset); offset += 8; }
  data.writeUInt32LE(directions.length, offset); offset += 4;
  for (const dir of directions) { data.writeUInt8(dir, offset); offset += 1; }

  const [feeEscrowPDA] = deriveFeeEscrowPDA(poolPDA);

  const keys = [
    { pubkey: payer,                                    isSigner: true,  isWritable: true  },
    { pubkey: poolPDA,                                  isSigner: false, isWritable: true  },
    { pubkey: treePDA,                                  isSigner: false, isWritable: false },
    { pubkey: nullifierPDA,                             isSigner: false, isWritable: true  },
    { pubkey: c1ProofBuffer,                            isSigner: false, isWritable: false },
    { pubkey: c3ProofBuffer,                            isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,                  isSigner: false, isWritable: false },
    { pubkey: tokenProgram || ZK_SHIELDED_PROGRAM_ID,   isSigner: false, isWritable: false },
    { pubkey: poolVault || ZK_SHIELDED_PROGRAM_ID,      isSigner: false, isWritable: !!poolVault },
    { pubkey: recipientTokenAccount || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!recipientTokenAccount },
    { pubkey: feeEscrowPDA,                             isSigner: false, isWritable: true  },
    // remaining_accounts[0]: recipient — anonymous AccountInfo, NOT a named field.
    // The Rust handler resolves it from ctx.remaining_accounts[0] and verifies
    // it matches the `recipient: [u8; 32]` arg (unshield_denominated_stark_v3.rs:179-184).
    { pubkey: recipient,                                isSigner: false, isWritable: true  },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

// ---------------------------------------------------------------------------
// prepareUnshield — orchestration helper
//
// Fetches leaves, builds Merkle path (replay style), root-preflights against
// the pool's known-roots ring, generates C1 + C3 STARK proofs.
// Returns everything unshieldDenominatedStarkV3 needs.
//
// The root pre-flight (mobile lines 3288-3335): after building the path we
// check that the resulting root is in the pool's current/historical ring.
// If not → we retry with 2× maxSignatures. If still not → fail BEFORE
// submitting proof rent (~2 SOL + 7 min of upload).
// ---------------------------------------------------------------------------

export interface PrepareUnshieldResult {
  c1ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number };
  c3ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number };
  /** The POOL root, from the client's own tree walk. NOT `c3PublicInputs[1]`. */
  merkleRoot: bigint;
  /** C3 public input 1: the depth-12 subtree root the walk starts from. */
  subtreeRoot: bigint;
  /** Path elements above the circuit, bottom-up. Levels 12.. */
  siblings: bigint[];
  /** Direction bits above the circuit, same order. */
  directions: number[];
  nullifierGoldilocks: bigint;
  starkCommitment: bigint;
}

export async function prepareUnshield(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<PrepareUnshieldResult> {
  assertC1C3SpendAllowed('withdrawal'); // audit v1 F05, see the guard
  // Import starkProver lazily to avoid circular module issues.
  const { starkProver: prover } = await import('./starkProver');

  onProgress?.('Fetching pool leaves from on-chain events...');
  const { leavesByIndex, missing } = await fetchPoolLeavesByIndex(
    connection,
    poolConfig.poolPDA,
    { maxSignatures: 1000, onProgress: (s, t) => onProgress?.(`Scanning events ${s}/${t}...`) },
  );

  if (missing.length > 0) {
    // A count only, no leaf index (`spendRootIsCurrent.test.ts`, "the v3
    // prepare's missing-leaf warning prints a count, never which leaf").
    console.warn(`[DenomPool/ext] prepareUnshield: ${missing.length} missing leaf gap(s)`);
  }

  onProgress?.('Building Merkle proof from leaf history...');
  let merkleResult = buildMerkleProofFromLeavesV3({
    leavesByIndex,
    targetLeafIndex: receipt.leafIndex,
  });

  // --- Root pre-flight (mirrors mobile lines 3288-3335) ---
  onProgress?.('Pre-flight root verification...');
  const poolAcct = await connection.getAccountInfo(poolConfig.poolPDA, 'confirmed');
  if (poolAcct) {
    const parsed = parsePoolV3Account(new Uint8Array(poolAcct.data));
    if (parsed) {
      const rootBytes = new Uint8Array(goldilocksToLeBytes32(merkleResult.root));
      const inCurrent = bytesEqual(rootBytes, parsed.currentRoot);
      const inHist = parsed.historicalRoots.some((r) => bytesEqual(rootBytes, r));
      if (!inCurrent && !inHist) {
        // Retry with 3× maxSignatures — the first scan may have missed events
        // (Helius 429 or slow RPC indexing for a just-shielded note).
        onProgress?.('Root not in ring — retrying event scan with extended limit...');
        const retry = await fetchPoolLeavesByIndex(connection, poolConfig.poolPDA, {
          maxSignatures: 3000,
        });
        merkleResult = buildMerkleProofFromLeavesV3({
          leavesByIndex: retry.leavesByIndex,
          targetLeafIndex: receipt.leafIndex,
        });
        const retryRootBytes = new Uint8Array(goldilocksToLeBytes32(merkleResult.root));
        const retryInCurrent = bytesEqual(retryRootBytes, parsed.currentRoot);
        const retryInHist = parsed.historicalRoots.some((r) => bytesEqual(retryRootBytes, r));
        if (!retryInCurrent && !retryInHist) {
          // The `PRE-FLIGHT FAIL` needle stays (poolHandlers V4_REBUILD_FAILURES);
          // the rebuilt root does not: the message is rendered
          // (`noteIdentifierTripwire.test.ts`).
          throw new Error(
            `PRE-FLIGHT FAIL: the rebuilt Merkle root ` +
            `is not in pool's known roots (current + ${parsed.historicalRoots.length} historical). ` +
            `This would burn STARK proof rent (~2 SOL). Aborting. ` +
            `Wait ~10s for RPC to index recent transactions, then retry.`,
          );
        }
        console.log('[DenomPool/ext] PRE-FLIGHT OK (retry)');
      } else {
        console.log(`[DenomPool/ext] PRE-FLIGHT OK — root matches ${inCurrent ? 'currentRoot' : 'historicalRoots'}`);
      }
    } else {
      console.warn('[DenomPool/ext] PRE-FLIGHT skip — pool account parse returned null (layout drift?)');
    }
  } else {
    console.warn('[DenomPool/ext] PRE-FLIGHT skip — pool account not found');
  }

  // --- Generate C1 (pool_commitment) proof ---
  // publicInputs layout: [nullifier_u64, commitment_u64]
  // starkProver.generatePoolCommitmentProof(np, secret, blinding, mint) — the
  // third argument is the commitment's third slot, a PRIVATE witness. It is a
  // real epoch for legacy notes and a PRF blinding for new ones; C1 accepts any
  // field element, which is what keeps legacy notes provable.
  // Heartbeat across BOTH proofs, same reason as every other prover call: the
  // main thread re-arms its request timeout on each progress message, so a
  // silence longer than that timeout kills a job that is working. This is the
  // history-rebuild route, taken when the stored Merkle path is no longer
  // accepted, so it is the SLOWEST of the two and the likeliest to trip it.
  const proofStartedAt = Date.now();
  let stage = 'Proving you own the note';
  const proofHeartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - proofStartedAt) / 1000);
    onProgress?.(`${stage} (${seconds}s)...`);
  }, 10_000);
  let c1Raw, c3Raw;
  try {
    onProgress?.('Proving you own the note...');
    await prover.start();
    c1Raw = await prover.generatePoolCommitmentProof(
      receipt.nullifierPreimage.toString(),
      receipt.secret.toString(),
      receipt.noteBlinding.toString(),
      receipt.tokenMint.toString(),
    );

  // --- Generate C3 (merkle_path) proof ---
  //
  // publicInputs layout: [leaf_u64, subtree_root_u64, depth].
  //
  // 🚨 PUBLIC INPUT 1 IS A SUBTREE ROOT SINCE 2026-08-29, NOT THE POOL ROOT.
  // C3 was cut to depth 12 to free 128 trace rows for a blinding region, so it
  // proves membership in the bottom twelve levels only. The instruction walks
  // the remaining three on chain, against these siblings, and requires the
  // result to be a root the pool already published.
    stage = 'Proving the note is in the pool';
    onProgress?.('Proving the note is in the pool...');
    if (merkleResult.pathElements.length < C3_SUBTREE_DEPTH) {
      throw new Error(
        `Merkle path has ${merkleResult.pathElements.length} elements, need at least ` +
        `${C3_SUBTREE_DEPTH} for the C3 circuit.`,
      );
    }
    c3Raw = await prover.generateMerklePathProof(
      receipt.commitment.toString(),
      merkleResult.pathElements.slice(0, C3_SUBTREE_DEPTH).map((e) => e.toString()),
      merkleResult.pathIndices.slice(0, C3_SUBTREE_DEPTH),
    );
  } finally {
    clearInterval(proofHeartbeat);
  }

  const c1ProofBytes = hexToBytes(c1Raw.proofHex);
  const c1PublicInputs = c1Raw.publicInputs.map((s) => BigInt(s));
  const c3ProofBytes = hexToBytes(c3Raw.proofHex);
  const c3PublicInputs = c3Raw.publicInputs.map((s) => BigInt(s));

  // nullifier and commitment come from C1 public inputs.
  const nullifierGoldilocks = c1PublicInputs[0] ?? 0n;
  const starkCommitment = c1PublicInputs[1] ?? 0n;
  // ⛔ `merkleRoot` NO LONGER COMES FROM THE PROOF. `c3PublicInputs[1]` is the
  // depth-12 SUBTREE root, and using it as the pool root — which this line did
  // until 2026-08-29 — would name a root no pool has ever published, so the
  // instruction's ring check would refuse every withdrawal.
  //
  // The pool root comes from the client's own tree walk; the subtree root comes
  // from the proof; the on-chain walk is what ties one to the other.
  const subtreeRoot = c3PublicInputs[1] ?? 0n;
  const merkleRoot = merkleResult.root;
  if (c3PublicInputs[2] !== BigInt(C3_SUBTREE_DEPTH)) {
    throw new Error(
      `C3 proved depth ${c3PublicInputs[2]}, expected ${C3_SUBTREE_DEPTH}. The shipped ` +
      `wasm prover is stale — it predates the depth cut, and the on-chain verifier ` +
      `rejects every proof it makes. Reship the blob.`,
    );
  }

  // The three levels above the circuit. `pathIndices` is bottom-up, so the tail
  // is the top of the tree, which is the order `resolve_pool_root` walks in.
  const siblings = merkleResult.pathElements.slice(C3_SUBTREE_DEPTH);
  const directions = merkleResult.pathIndices.slice(C3_SUBTREE_DEPTH);

  return {
    c1ProofResult: { proofBytes: c1ProofBytes, publicInputs: c1PublicInputs, proofSize: c1Raw.proofSize },
    c3ProofResult: { proofBytes: c3ProofBytes, publicInputs: c3PublicInputs, proofSize: c3Raw.proofSize },
    merkleRoot,
    subtreeRoot,
    siblings,
    directions,
    nullifierGoldilocks,
    starkCommitment,
  };
}

// ---------------------------------------------------------------------------
// unshieldDenominatedStarkV3 — port of mobile lines 3206-3396
//
// Orchestration:
//   1. Submit + verify C1 (pool_commitment) proof   → c1ProofBuffer
//   2. Submit + verify C3 (merkle_path) proof       → c3ProofBuffer
//   3. Build + send unshield_denominated_stark_v3
//   4. Close both buffers in finally (rent recovery)
//
// EXTENSION ADAPTATION: uses legacy submitAndVerifyStarkProof (non-uniform)
// instead of submitAndVerifyStarkProofUniform. The on-chain handler reads the
// verified buffer PDA regardless of upload path.
//
// min_epoch IS NOT A CHOICE ANY MORE
// ──────────────────────────────────
// There used to be a regular path (`minEpoch = receipt.depositEpoch`) and an
// emergency path (`minEpoch = 0n`). The regular path published the note's
// secret blinding in the clear once the commitment gained one, so both paths
// now publish 0 and the `emergency` flag is gone. The on-chain handler ignores
// the field entirely (`unshield_denominated_stark_v3.rs:387`), so nothing
// on-chain observes the difference. See `UNSHIELD_MIN_EPOCH`.
// ---------------------------------------------------------------------------

export async function unshieldDenominatedStarkV3(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  recipient: PublicKey,
  preparedResult: PrepareUnshieldResult,
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<string> {
  assertC1C3SpendAllowed('withdrawal'); // audit v1 F05: before any upload
  const {
    c1ProofResult, c3ProofResult, merkleRoot, nullifierGoldilocks, starkCommitment,
    // [C3-D12] The three values the on-chain walk needs. See
    // `prepareUnshield` for why `merkleRoot` is NOT `c3PublicInputs[1]`.
    subtreeRoot, siblings, directions,
  } = preparedResult;

  const createdBuffers: PublicKey[] = [];
  let c1ProofBuffer: PublicKey | undefined;
  let c3ProofBuffer: PublicKey | undefined;

  try {
    // Steps 1 + 2: C1 (pool_commitment) and C3 (merkle_path), TOGETHER.
    // [L2-CLIENT 2026-09-12] The two proofs live in two buffers derived per
    // circuit id and share nothing but the signer, so their uploads run side
    // by side instead of one after the other. `allSettled` so that a buffer
    // the surviving upload created is still registered for the cleanup below
    // when the other one fails.
    onProgress?.('Submitting C1 (pool_commitment) and C3 (merkle_path) proofs on-chain...');
    const c1Proof: GenericStarkProof = {
      proofBytes: c1ProofResult.proofBytes,
      circuitId: CIRCUIT_POOL_COMMITMENT,
      publicInputs: c1ProofResult.publicInputs,
      proofSize: c1ProofResult.proofSize,
    };
    const c3Proof: GenericStarkProof = {
      proofBytes: c3ProofResult.proofBytes,
      circuitId: CIRCUIT_MERKLE_PATH,
      publicInputs: c3ProofResult.publicInputs,
      proofSize: c3ProofResult.proofSize,
    };
    const [c1Settled, c3Settled] = await Promise.allSettled([
      submitAndVerifyStarkProof(c1Proof, signer, connection, onProgress),
      submitAndVerifyStarkProof(c3Proof, signer, connection, onProgress),
    ]);
    if (c1Settled.status === 'fulfilled') createdBuffers.push(c1Settled.value.proofBuffer);
    if (c3Settled.status === 'fulfilled') createdBuffers.push(c3Settled.value.proofBuffer);
    if (c1Settled.status === 'rejected') throw c1Settled.reason;
    if (c3Settled.status === 'rejected') throw c3Settled.reason;
    c1ProofBuffer = c1Settled.value.proofBuffer;
    c3ProofBuffer = c3Settled.value.proofBuffer;

    // Step 3: Build + send unshield_denominated_stark_v3
    onProgress?.('Building V3 unshield transaction...');

    const nullifierBytes = goldilocksToLeBytes32(nullifierGoldilocks);
    const merkleRootBytes = goldilocksToLeBytes32(merkleRoot);

    const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);

    const isNativeSOL = poolConfig.tokenMint.equals(SystemProgram.programId);
    let tokenProgram: PublicKey | undefined;
    let recipientTokenAccount: PublicKey | undefined;
    let poolVault: PublicKey | undefined;

    if (!isNativeSOL) {
      tokenProgram = TOKEN_PROGRAM_ID;
      recipientTokenAccount = await getAssociatedTokenAddress(poolConfig.tokenMint, recipient);
      poolVault = poolConfig.vaultATA
        ?? await getAssociatedTokenAddress(poolConfig.tokenMint, poolConfig.poolPDA, true);
    }

    const ix = buildUnshieldDenominatedStarkV3Ix(
      signer.publicKey,
      recipient,
      poolConfig.poolPDA,
      poolConfig.treePDA,
      nullifierPDA,
      c1ProofBuffer,
      c3ProofBuffer,
      nullifierBytes,
      merkleRootBytes,
      starkCommitment,
      subtreeRoot,
      siblings,
      directions,
      tokenProgram,
      poolVault,
      recipientTokenAccount,
    );

    const tx = new Transaction();
    // [C3-D12] 300,000 -> 400,000.
    //
    // The handler now walks three Poseidon levels on top of the v3 work. One
    // on-chain `hash2` is ~34,469 CU (measured 2026-08-29 on the litesvm SBF VM
    // by `subscribe_v4_adversarial::the_walk_is_what_the_new_instruction_pays_for`),
    // so the walk adds ~103,400. 400,000 is what the v4 path already uses for
    // the identical walk, which is the closest thing to a measured precedent.
    // [ZK-DEPTH-11 2026-08-30] 400,000 -> 500,000. `resolve_pool_root` walks
    // FOUR levels now: ~137,876 CU at the ~34,469 measured per on-chain `hash2`,
    // up from ~103,407. ⚠️ Headroom, not an end-to-end measurement.
    tx.add(...buildComputeBudgetIxs(500_000));
    if (!isNativeSOL && recipientTokenAccount) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey, recipientTokenAccount, recipient, poolConfig.tokenMint,
        ),
      );
    }
    tx.add(ix);

    onProgress?.('Sending V3 unshield transaction...');
    const sig = await signSendV3(connection, tx, signer, onProgress);
    onProgress?.('V3 unshield confirmed!');
    return sig;
  } finally {
    // Close all created buffers — rent recovery regardless of success/failure.
    for (const buf of createdBuffers) {
      try {
        onProgress?.('Closing proof buffer (rent recovery)...');
        await closeStarkProofBuffer(buf, signer, connection);
      } catch (closeErr: unknown) {
        console.warn(
          '[DenomPool/ext] closeStarkProofBuffer (unshield) failed:',
          closeErr instanceof Error ? closeErr.message : String(closeErr),
        );
      }
    }
  }
}

// ===========================================================================
// V4 UNSHIELD — ONE CIRCUIT-7 PROOF, NO PUBLISHED COMMITMENT
// ===========================================================================
//
// 🚨 WHAT v3 LEAKS, AND WHY THIS EXISTS
// ─────────────────────────────────────
// v3 spends on a C1 + C3 pair. The two proofs are independent, so something has
// to tie them together, and that something is `stark_commitment` — the note
// commitment, PUBLISHED IN THE CLEAR as an instruction argument. A withdrawal
// therefore NAMES the leaf it spends. Anyone with the deposit events can match
// that value to a `LeafInserted` and walk straight back to the deposit that
// funded it. No cryptography is broken; the linkage is printed on the wire.
//
// C7 proves both halves in one trace. The commitment becomes an internal wire
// and never reaches the instruction at all.
//
// THREE THINGS THAT ARE NOT MECHANICAL
// ────────────────────────────────────
// 1. THE RECIPIENT MOVES TO PREPARE. C7 binds sha256(recipient) into the
//    transcript, so the PROOF CANNOT BE BUILT WITHOUT KNOWING WHO IS PAID.
//    In v3 the recipient only had to exist at execution. Getting this wrong
//    does not fail loudly — it produces a proof bound to the wrong payee, and
//    the on-chain public-inputs hash rejects it after the whole upload.
//
// 2. THE PATH IS SPLIT 12 / 3. C7's subtree depth is CANONICAL_DEPTH = 12; the
//    pool tree is 15. `buildMerkleProofFromLeavesV3` already returns depth 15,
//    so [0..12] goes to the circuit and [12..15] goes to the instruction as
//    `siblings` / `directions`, which the handler walks with Poseidon to derive
//    the pool root. Nothing new is computed here.
//    ⛔ Do NOT hardcode directions = [0,0,0] because everything is in bucket 0
//    today. It goes wrong at leaf 4,097 and not before.
//
// 3. ONE BUFFER, NOT TWO. Half the upload cost, and half the orphaned-rent
//    exposure.
//
// ⛔ v3 STAYS. Notes whose blinding is unknown — the unspent leaf 30 among them
// — can only be spent there, indefinitely.
// ---------------------------------------------------------------------------

/** C7's subtree depth. NOT the pool tree's 15. See `air/spend.rs`. */
/**
 * [ZK-DEPTH-11 2026-08-30] 12 -> 11.
 *
 * The circuit gave up one Merkle level so its blinding region could grow from
 * 128 rows to 160. That was not cosmetic: `full_wire_ledger.rs` MEASURED the
 * row mask short of what the constrained openings plus the quotient publish on
 * C3, and standing on a margin of 20 on C6 and C7.
 *
 * ⛔ THE WALK IS NOW FOUR LEVELS, NOT THREE. Slice 11 for the circuit and send
 * 15 - 11 = 4 siblings/directions to the instruction. Sending three is a root
 * the handler folds short, which fails the ring check after the whole upload.
 *
 * ⚠️ The pool tree is STILL MERKLE_DEPTH (15) deep and still holds 2^15 notes.
 * This constant moves the split between circuit and instruction, never the
 * capacity.
 */
export const C7_SUBTREE_DEPTH = 11;

/**
 * The depth circuit 3 proves, since 2026-08-29.
 *
 * Numerically equal to `C7_SUBTREE_DEPTH` and deliberately a SEPARATE constant:
 * nothing requires the two circuits to move together, and one shared constant is
 * what would make the next divergence invisible. The on-chain side keeps them
 * separate for the same reason (`spend_root::SPEND_SUBTREE_DEPTH` vs
 * `insert_root::INSERT_SUBTREE_DEPTH`).
 */
/**
 * [ZK-DEPTH-11 2026-08-30] 12 -> 11.
 *
 * The circuit gave up one Merkle level so its blinding region could grow from
 * 128 rows to 160. That was not cosmetic: `full_wire_ledger.rs` MEASURED the
 * row mask short of what the constrained openings plus the quotient publish on
 * C3, and standing on a margin of 20 on C6 and C7.
 *
 * ⛔ THE WALK IS NOW FOUR LEVELS, NOT THREE. Slice 11 for the circuit and send
 * 15 - 11 = 4 siblings/directions to the instruction. Sending three is a root
 * the handler folds short, which fails the ring check after the whole upload.
 *
 * ⚠️ The pool tree is STILL MERKLE_DEPTH (15) deep and still holds 2^15 notes.
 * This constant moves the split between circuit and instruction, never the
 * capacity.
 */
export const C3_SUBTREE_DEPTH = 11;

/**
 * sha256(recipient) as the four little-endian u64 limbs circuit 7 takes.
 *
 * ⛔ THE LIMBS ARE CARRIED RAW — NOT REDUCED MOD THE GOLDILOCKS PRIME. They
 * occupy no trace column and no constraint (the binding is transcript-only,
 * exactly as C3's `depth` is), so nothing reduces them and the concatenation of
 * the four IS the digest byte for byte. `unshield_denominated_stark_v4.rs`
 * relies on that identity to rebuild the 48 hashed bytes with a single copy.
 * A future change that publishes reduced felts would silently break it for any
 * digest limb >= the modulus.
 */
export function recipientHashLimbs(recipient: PublicKey): bigint[] {
  const digest = sha256(recipient.toBytes());
  const limbs: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    let v = 0n;
    for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(digest[i * 8 + b]);
    limbs.push(v);
  }
  return limbs;
}

/**
 * Args: nullifier[32] | merkle_root[32] | subtree_root u64 | siblings Vec<u64>
 *       | directions Vec<u8> | recipient[32]
 *
 * 🚨 THERE IS NO `stark_commitment` FIELD AND NO `min_epoch` FIELD. The first
 * is the linkage C7 removes. The second was pinned to 0 on every v3 path
 * because `ShieldReceipt.depositEpoch` became a 63-bit secret once commitments
 * gained a PRF blinding; v4 drops the field entirely, so it cannot be set wrong.
 */
export function buildUnshieldDenominatedStarkV4Ix(
  payer: PublicKey,
  recipient: PublicKey,
  poolPDA: PublicKey,
  treePDA: PublicKey,
  nullifierPDA: PublicKey,
  c7ProofBuffer: PublicKey,
  nullifierBytes: number[],
  merkleRootBytes: number[],
  subtreeRoot: bigint,
  siblings: bigint[],
  directions: number[],
  tokenProgram?: PublicKey,
  poolVault?: PublicKey,
  recipientTokenAccount?: PublicKey,
  /**
   * Route to `unshield_denominated_stark_v4_relayed`, which pays `payer` a
   * fixed reward out of the PROTOCOL FEE (fee.rs RELAYER_REWARD_LAMPORTS), so
   * discriminator differs — same accounts, same args, same order — because the
   * two are the same handler with one literal changed.
   *
   * Set this ONLY when somebody other than the beneficiary is paying, i.e.
   * from the relayer. Setting it on a self-submitted withdrawal just moves a
   * million lamports from the note into your own ephemeral payer.
   */
  relayed = false,
): TransactionInstruction {
  if (siblings.length !== directions.length) {
    throw new Error(
      `siblings (${siblings.length}) and directions (${directions.length}) must be the same length`,
    );
  }
  const disc = relayed ? UNSHIELD_V4_RELAYED_DISCRIMINATOR : UNSHIELD_V4_DISCRIMINATOR;
  const data = Buffer.alloc(
    8 + 32 + 32 + 8 + (4 + siblings.length * 8) + (4 + directions.length) + 32,
  );
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(nullifierBytes).copy(data, offset); offset += 32;
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(subtreeRoot, offset); offset += 8;
  // Borsh Vec<T>: u32 length prefix, then the elements.
  data.writeUInt32LE(siblings.length, offset); offset += 4;
  for (const sib of siblings) { data.writeBigUInt64LE(sib, offset); offset += 8; }
  data.writeUInt32LE(directions.length, offset); offset += 4;
  for (const dir of directions) { data.writeUInt8(dir, offset); offset += 1; }
  Buffer.from(recipient.toBytes()).copy(data, offset);

  const [feeEscrowPDA] = deriveFeeEscrowPDA(poolPDA);

  const keys = [
    { pubkey: payer,                                    isSigner: true,  isWritable: true  },
    { pubkey: poolPDA,                                  isSigner: false, isWritable: true  },
    { pubkey: treePDA,                                  isSigner: false, isWritable: false },
    { pubkey: nullifierPDA,                             isSigner: false, isWritable: true  },
    // ONE buffer. v3 named two here.
    { pubkey: c7ProofBuffer,                            isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,                  isSigner: false, isWritable: false },
    { pubkey: tokenProgram || ZK_SHIELDED_PROGRAM_ID,   isSigner: false, isWritable: false },
    { pubkey: poolVault || ZK_SHIELDED_PROGRAM_ID,      isSigner: false, isWritable: !!poolVault },
    { pubkey: recipientTokenAccount || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!recipientTokenAccount },
    { pubkey: feeEscrowPDA,                             isSigner: false, isWritable: true  },
    // remaining_accounts[0]: recipient — anonymous AccountInfo, NOT a named
    // field, so a naive IDL-driven indexer cannot resolve "recipient: ABC".
    // Unlike v3 the binding no longer rests on the payer signature alone:
    // sha256(recipient) is inside the proof transcript.
    { pubkey: recipient,                                isSigner: false, isWritable: true  },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

export interface PrepareUnshieldV4Result {
  c7ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number };
  /** The pool root the instruction NAMES. */
  merkleRoot: bigint;
  /** The depth-12 root the proof REACHES. The handler walks from here to the above. */
  subtreeRoot: bigint;
  nullifierGoldilocks: bigint;
  /** Levels 12..15 of the path — walked on chain, not in the circuit. */
  siblings: bigint[];
  directions: number[];
  /**
   * The payee this proof is bound to. Carried so `unshieldDenominatedStarkV4`
   * can refuse a prepared-for-A / executed-for-B mismatch BEFORE spending an
   * upload on a proof the chain will reject.
   *
   * 🚨 There is deliberately NO `starkCommitment` field. Its absence is the
   * property, and leaving it in the type would let a caller keep publishing it.
   */
  recipient: PublicKey;
}

/**
 * Raised by `prepareUnshieldV4` when the pool history this client can read does
 * not rebuild to a root the pool knows, and the note's saved path would name an
 * OLDER root than the current one; or when the only root it rebuilds to is an
 * older one tied to the note (a walk that left listed signatures unread, a map
 * that ends at the note's own leaf or where its saved root was taken); or when
 * no map it read places the note at all (its insert listed and not served, or
 * not listed yet: `spendRootIsCurrent.test.ts`, "a note that no leaf map read
 * places is refused with HistoryIncompleteError, never with a v3 needle").
 * Nothing has been proved or spent.
 *
 * The message carries neither needle of `V4_REBUILD_FAILURES` (poolHandlers.ts),
 * so the withdrawal handler rethrows it instead of falling back to the C1 + C3
 * pair, which would publish the commitment (`spendRootIsCurrent.test.ts`, "hole
 * plus older saved root: refuse, never name it, no v3";
 * `poolHandlersUnshieldV4.test.ts`, "does NOT fall back to the C1 + C3 pair when
 * the history is incomplete"). It names no note and no root.
 *
 * `prepareSubscribeV4` (subscribePrivateStarkV4.ts) raises it too, for the same
 * tie rule, with `spend` = 'subscription' so the screen names the right action;
 * `handlePoolSubscribePrepare` rethrows it the same way
 * (`spendRootIsCurrent.test.ts`, "the circuit-7 SUBSCRIPTION prepare never
 * proves a root tied to the note either"; `poolHandlersUnshieldV4.test.ts`, "a
 * circuit-7 subscription refused for an incomplete history does NOT fall back to
 * the C1 + C3 pair").
 */
export class HistoryIncompleteError extends Error {
  constructor(spend: 'withdrawal' | 'subscription' = 'withdrawal') {
    super(
      `The pool history this client can read is incomplete, so the ${spend} could not ` +
        'be built against the pool\'s current Merkle root. Nothing was spent. Wait a few ' +
        'seconds for the RPC to catch up, then retry.',
    );
    this.name = 'HistoryIncompleteError';
  }
}

export interface PrepareUnshieldV4Options {
  /**
   * The pool commitments the caller has ALREADY walked (`locateOwnedNote` in
   * poolHandlers.ts). Given, the prepare builds from them and does not walk the
   * history a second time (`spendRootIsCurrent.test.ts`, "one walk per prepare").
   */
  leaves?: Map<string, OnChainCommitment>;
  /**
   * What the walk that produced `leaves` could not read (`PoolWalkReport.unread`).
   * Absent, those leaves are not shown to be read in full, and a root they fold
   * to that the pool is not on now gets the refetch (`spendRootIsCurrent.test.ts`,
   * "a map handed down with no walk report is not shown clean: a lagging root
   * gets the refetch").
   */
  unread?: number;
  /**
   * The Merkle path saved with the note. Used ONLY when its root is the pool's
   * current root; see `prepareUnshieldV4`.
   */
  savedPath?: StoredMerklePath;
  /**
   * [flow-speed X4 2026-09-23] Called once, synchronously, right before the
   * prover starts: after every refusal the prepare can make before proving (the
   * pre-flight and its refetch, `HistoryIncompleteError`, the depth check). The
   * job uses it to quote rent beside the proof. Never called on a refused
   * attempt; a throw from it is ignored.
   */
  onProving?: () => void;
}

/**
 * A commitment map as the dense leaf array `buildMerkleProofFromLeavesV3` takes.
 * Exported for the circuit-7 SUBSCRIPTION prepare, which builds from the same
 * handed map the same way ([flow-speed S1]); one copy, not two.
 */
export function leavesByIndexFromCommitments(commitments: Map<string, OnChainCommitment>): bigint[] {
  const MAX_LEAVES = 1 << MERKLE_DEPTH;
  let maxIdx = -1;
  for (const e of commitments.values()) {
    if (Number.isInteger(e.leafIndex) && e.leafIndex >= 0 && e.leafIndex < MAX_LEAVES && e.leafIndex > maxIdx) {
      maxIdx = e.leafIndex;
    }
  }
  const leaves: bigint[] = maxIdx >= 0 ? new Array<bigint>(maxIdx + 1).fill(ZERO_VALUE_V3) : [];
  for (const e of commitments.values()) {
    if (Number.isInteger(e.leafIndex) && e.leafIndex >= 0 && e.leafIndex <= maxIdx) leaves[e.leafIndex] = e.commitment;
  }
  return leaves;
}

/**
 * Build the Merkle path from the pool leaves, pre-flight its root, and generate
 * ONE circuit-7 proof.
 *
 * ⛔ `recipient` is a parameter HERE, unlike `prepareUnshield`. C7 binds
 * sha256(recipient) into its transcript; the proof does not exist without it.
 *
 * 🚨 WHICH ROOT IS NAMED (SPEND-1, 2026-09-16). `merkle_root` travels in the
 * clear and the chain accepts any root still in the ring. A path saved when the
 * note was shielded or issued folds to the root right after that note's own
 * insertion, so naming it dates the deposit (devnet: 1 v4 spend of 34 named a
 * root 4 insertions old, `scratchpad/probe-stale-root-2026-09-15.log`). So the
 * root is a function of POOL STATE, never of the note:
 *   1. build from `opts.leaves` (or one walk when absent); the current root is
 *      accepted, and so is a ring root nothing ties to the note: the walk left
 *      nothing it listed unread, the map does not end at the note's own leaf,
 *      and the root is not the saved one (a map can end exactly where the
 *      saved root was taken, and its root is then the saved root);
 *   2. otherwise one incremental history fetch and a rebuild, same rule;
 *   3. otherwise `opts.savedPath`, ONLY if its root equals the current root;
 *   4. otherwise, if the saved root is in the ring, or a ring root was held
 *      back in 1 or 2, or neither map places the note, `HistoryIncompleteError`;
 *   5. otherwise (the refetched map places the note, at a root the pool does
 *      not know) PRE-FLIGHT FAIL, as before.
 * With no readable pool account there is no pre-flight and no refetch: the
 * rebuilt root is proved only when nothing ties it to the note.
 * Pinned by `spendRootIsCurrent.test.ts`.
 */
export async function prepareUnshieldV4(
  receipt: ShieldReceipt,
  recipient: PublicKey,
  poolConfig: PoolConfig,
  connection: Connection,
  onProgress?: (step: string) => void,
  opts: PrepareUnshieldV4Options = {},
): Promise<PrepareUnshieldV4Result> {
  const { starkProver: prover } = await import('./starkProver');

  type MerkleResult = ReturnType<typeof buildMerkleProofFromLeavesV3>;
  // A leaf map that does not hold this note yet (an RPC behind the deposit) is
  // a path that cannot be built: it is treated like a root the pool does not
  // know, and so gets the refetch below (`spendRootIsCurrent.test.ts`, "a walked
  // map that does not hold the note yet gets the refetch too"). The builder's
  // error names no leaf ("the refusal the screen shows names no leaf: no index,
  // no count") and is kept only to be rethrown when no pre-flight can run.
  let buildError: unknown = null;
  /** The newest leaf index of the map `build` last read. */
  let builtTop = -1;
  const build = (leavesByIndex: bigint[]): MerkleResult | null => {
    builtTop = leavesByIndex.length - 1;
    try {
      return buildMerkleProofFromLeavesV3({ leavesByIndex, targetLeafIndex: receipt.leafIndex });
    } catch (err) {
      buildError = err;
      return null;
    }
  };

  // What ties a root the pool is not on NOW to this note (SPEND-1, continued
  // run). A walk that left listed signatures unread may stop where this client
  // last read, often right after the note's own deposit or purchase; a map that
  // ends at the note's own leaf folds to its deposit root; and a map can end
  // exactly where the saved root was taken, so its root IS the saved one. Such
  // a root is never proved unless it is current (`spendRootIsCurrent.test.ts`,
  // "a map that ends where the note's saved root was taken is never proved
  // (m == k)"; "a history cache left short by its last walk, with newer inserts
  // listed but not served, is never proved").
  const savedRootValue = ((): bigint | null => {
    try {
      return opts.savedPath ? BigInt(opts.savedPath.root) : null;
    } catch {
      return null;
    }
  })();
  const tiedToNote = (root: bigint, top: number, unread: number | undefined): boolean =>
    unread !== 0 || top === receipt.leafIndex || root === savedRootValue;

  let merkleResult: MerkleResult | null;
  /** What the walk behind the first map could not read; undefined when nobody said. */
  let firstUnread: number | undefined;
  if (opts.leaves) {
    onProgress?.('Building Merkle proof from leaf history...');
    merkleResult = build(leavesByIndexFromCommitments(opts.leaves));
    firstUnread = opts.unread;
  } else {
    onProgress?.('Fetching pool leaves from on-chain events...');
    const { leavesByIndex, missing, unread } = await fetchPoolLeavesByIndex(
      connection,
      poolConfig.poolPDA,
      { maxSignatures: 1000, onProgress: (s, t) => onProgress?.(`Scanning events ${s}/${t}...`) },
    );
    if (missing.length > 0) {
      // A count only, no leaf index (`spendRootIsCurrent.test.ts`, "the
      // missing-leaf warning prints a count, never which leaf").
      console.warn(`[DenomPool/v4] prepareUnshieldV4: ${missing.length} missing leaf gap(s)`);
    }
    onProgress?.('Building Merkle proof from leaf history...');
    merkleResult = build(leavesByIndex);
    firstUnread = unread;
  }
  const firstTop = builtTop;

  // Root pre-flight. A root the pool has never published means the proof would
  // be refused at the END of the upload, so this check is worth its account read.
  onProgress?.('Pre-flight root verification...');
  const poolAcct = await connection.getAccountInfo(poolConfig.poolPDA, 'confirmed');
  const parsed = poolAcct ? parsePoolV3Account(new Uint8Array(poolAcct.data)) : null;
  if (parsed) {
    const isCurrent = (root: bigint): boolean =>
      bytesEqual(new Uint8Array(goldilocksToLeBytes32(root)), parsed.currentRoot);
    const known = (root: bigint): boolean => {
      const b = new Uint8Array(goldilocksToLeBytes32(root));
      return bytesEqual(b, parsed.currentRoot) || parsed.historicalRoots.some((r) => bytesEqual(b, r));
    };
    // A ring root that is not current and is tied to the note is held back
    // like an unknown root: it gets the refetch below, then a refusal if the
    // refetched one is held back too (`tiedToNote` above).
    let heldBack = false;
    const unlessTiedToNote = (
      result: MerkleResult | null,
      top: number,
      unread: number | undefined,
    ): MerkleResult | null => {
      if (!result || isCurrent(result.root) || !known(result.root) || !tiedToNote(result.root, top, unread)) {
        return result;
      }
      heldBack = true;
      return null;
    };
    merkleResult = unlessTiedToNote(merkleResult, firstTop, firstUnread);
    if (!merkleResult || !known(merkleResult.root)) {
      // Step 2: ONE refetch and rebuild before any saved path is looked at
      // (`spendRootIsCurrent.test.ts`, "a short walked map gets ONE refetch, and
      // the refetched root is proved (not refused, not v3)").
      // A refetched root the ring holds is proved as read, even when it lags:
      // the note's older saved root never replaces it (same file, "a lagging
      // map is proved as read on every route to it: the note's older saved
      // root is never named").
      onProgress?.('Root not in ring — refreshing the pool history...');
      const retry = await fetchPoolLeavesByIndex(connection, poolConfig.poolPDA, { maxSignatures: 3000 });
      merkleResult = build(retry.leavesByIndex);
      merkleResult = unlessTiedToNote(merkleResult, builtTop, retry.unread);
      if (!merkleResult || !known(merkleResult.root)) {
        const saved = opts.savedPath;
        const savedRoot = saved && saved.pathElements.length >= C7_SUBTREE_DEPTH ? BigInt(saved.root) : null;
        if (saved && savedRoot !== null && isCurrent(savedRoot)) {
          // The saved witness folds to the root the pool is on NOW, so it says
          // nothing about when the note was deposited (`spendRootIsCurrent.test.ts`,
          // "a saved root equal to the current root is used").
          onProgress?.('Using the note\'s own Merkle path...');
          merkleResult = {
            pathElements: saved.pathElements.map((e) => BigInt(e)),
            pathIndices: saved.pathIndices,
            root: savedRoot,
          };
        } else if (savedRoot !== null && known(savedRoot)) {
          throw new HistoryIncompleteError();
        } else {
          // A root the pool knows was held back above: the history this client
          // read is short, the note is not unplaceable, so this is no case for
          // the C1 + C3 pair (`spendRootIsCurrent.test.ts`, "a history cache
          // left short by its last walk, with newer inserts listed but not
          // served, is never proved").
          // Nor is a note that neither map places (its insert listed and not
          // served, or not listed yet): the history read is short and there is
          // no rebuilt root to refuse, so the refusal carries no needle (same
          // file, "a note that no leaf map read places is refused with
          // HistoryIncompleteError, never with a v3 needle"). HEAD rethrew the
          // builder's error here, which carries none either.
          if (heldBack || !merkleResult) throw new HistoryIncompleteError();
          // [close-v1, audit v1 F01/F06] Not lag when the history accounts for
          // every leaf of the tree and still misses its root: a stable code, no
          // `PRE-FLIGHT FAIL` needle, so no route to the C1 + C3 pair either.
          if (await poolTreeDiverged(connection, poolConfig, retry.leavesByIndex, retry.missing)) {
            throw poolTreeDivergedError('withdrawal');
          }
          throw new Error(
            `PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots ` +
            `(current + ${parsed.historicalRoots.length} historical). Aborting before proof rent is spent. ` +
            `Wait ~10s for the RPC to index recent transactions, then retry.`,
          );
        }
      }
    }
  }
  // No readable pool account: nothing to pre-flight against, and a saved path
  // cannot be shown to be current, so it is not used (`spendRootIsCurrent.test.ts`,
  // "an unreadable pool account never makes the saved path the answer").
  if (!merkleResult) throw buildError;
  // Nor can the rebuilt root be shown current, so it is proved only when
  // nothing ties it to the note, with no refetch (same file, "a history cache
  // left short by its last walk, with newer inserts listed but not served, is
  // never proved", its unreadable-account worlds).
  if (!parsed && tiedToNote(merkleResult.root, firstTop, firstUnread)) throw new HistoryIncompleteError();

  // 12 / 3 split. `buildMerkleProofFromLeavesV3` returns the full depth-15 path
  // and the two halves go to different verifiers: the first twelve levels are
  // proven in the circuit, the last three are walked on chain.
  if (merkleResult.pathElements.length < C7_SUBTREE_DEPTH) {
    throw new Error(
      `Merkle path is ${merkleResult.pathElements.length} deep; circuit 7 needs at least ${C7_SUBTREE_DEPTH}.`,
    );
  }
  const circuitElements = merkleResult.pathElements.slice(0, C7_SUBTREE_DEPTH);
  const circuitIndices = merkleResult.pathIndices.slice(0, C7_SUBTREE_DEPTH);
  const siblings = merkleResult.pathElements.slice(C7_SUBTREE_DEPTH);
  const directions = merkleResult.pathIndices.slice(C7_SUBTREE_DEPTH);

  const rhLimbs = recipientHashLimbs(recipient);

  const proofStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - proofStartedAt) / 1000);
    onProgress?.(`Proving ownership and membership in one trace (${seconds}s)...`);
  }, 10_000);
  let raw;
  try {
    onProgress?.('Proving ownership and membership in one trace...');
    // [flow-speed X4] Past every pre-proof refusal: the job may now quote its
    // rent beside the proof (`PrepareUnshieldV4Options.onProving`).
    try {
      opts.onProving?.();
    } catch {
      // A quote hook must never change the proof or its errors.
    }
    await prover.start();
    raw = await prover.generateSpendProof(
      receipt.nullifierPreimage.toString(),
      receipt.secret.toString(),
      receipt.noteBlinding.toString(),
      receipt.tokenMint.toString(),
      circuitElements.map((e) => e.toString()),
      circuitIndices,
      rhLimbs.map((l) => l.toString()),
    );
  } finally {
    clearInterval(heartbeat);
  }

  const publicInputs = raw.publicInputs.map((v) => BigInt(v));
  if (publicInputs.length !== 6) {
    throw new Error(`Circuit 7 must publish exactly 6 felts, got ${publicInputs.length}.`);
  }
  // Fail here rather than on chain: a transcript bound to a different payee is
  // otherwise only discovered by the public-inputs hash, after the upload.
  for (let i = 0; i < 4; i++) {
    if (publicInputs[2 + i] !== rhLimbs[i]) {
      throw new Error(
        `Circuit 7 published a recipient hash that does not match ${recipient.toBase58()} at limb ${i}.`,
      );
    }
  }

  return {
    c7ProofResult: { proofBytes: hexToBytes(raw.proofHex), publicInputs, proofSize: raw.proofSize },
    merkleRoot: merkleResult.root,
    subtreeRoot: publicInputs[1],
    nullifierGoldilocks: publicInputs[0],
    siblings,
    directions,
    recipient,
  };
}

/**
 * Submit the one proof, then spend.
 *
 * ⛔ `recipient` is passed again and CHECKED against the prepared one. It is not
 * redundant: the proof is bound to a payee, and executing for a different one
 * builds a transaction the chain refuses after the whole upload has been paid
 * for.
 */
export async function unshieldDenominatedStarkV4(
  poolConfig: PoolConfig,
  recipient: PublicKey,
  prepared: PrepareUnshieldV4Result,
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
  /** [CLOSE-SWEEP 2026-09-13] sweep the signer's whole balance here in the SAME transaction as the buffer close. */
  options?: { sweepTo?: PublicKey },
  /**
   * `relayed` routes to the sibling instruction that pays `signer` a reward
   * out of the note. It is what a RELAYER passes: the caller here is not the
   * beneficiary, it is a stranger who uploaded somebody else's proof and wants
   * its 78 chunk fees back.
   *
   * 🚨 Safe only because circuit 7 binds the recipient. `prepared` names the
   * payee inside `public_inputs_hash`, so a relayer that re-points the payout
   * invalidates the very proof it is relaying. That was NOT true in v3, which
   * is why v3 relaying needed a trusted operator and this does not.
   */
  relayed = false,
): Promise<string> {
  if (!prepared.recipient.equals(recipient)) {
    throw new Error(
      `This proof was prepared for ${prepared.recipient.toBase58()} and cannot pay ` +
      `${recipient.toBase58()}. Circuit 7 binds sha256(recipient) into its transcript; ` +
      `re-run prepareUnshieldV4 for the new payee.`,
    );
  }

  let c7ProofBuffer: PublicKey | undefined;
  try {
    onProgress?.('Submitting the circuit-7 spend proof on-chain...');
    const proof: GenericStarkProof = {
      proofBytes: prepared.c7ProofResult.proofBytes,
      circuitId: CIRCUIT_SPEND,
      publicInputs: prepared.c7ProofResult.publicInputs,
      proofSize: prepared.c7ProofResult.proofSize,
    };
    const result = await submitAndVerifyStarkProof(proof, signer, connection, onProgress);
    c7ProofBuffer = result.proofBuffer;

    onProgress?.('Building V4 unshield transaction...');
    const nullifierBytes = goldilocksToLeBytes32(prepared.nullifierGoldilocks);
    const merkleRootBytes = goldilocksToLeBytes32(prepared.merkleRoot);
    const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);

    const isNativeSOL = poolConfig.tokenMint.equals(SystemProgram.programId);
    let tokenProgram: PublicKey | undefined;
    let recipientTokenAccount: PublicKey | undefined;
    let poolVault: PublicKey | undefined;
    if (!isNativeSOL) {
      tokenProgram = TOKEN_PROGRAM_ID;
      recipientTokenAccount = await getAssociatedTokenAddress(poolConfig.tokenMint, recipient);
      poolVault = poolConfig.vaultATA
        ?? await getAssociatedTokenAddress(poolConfig.tokenMint, poolConfig.poolPDA, true);
    }

    const ix = buildUnshieldDenominatedStarkV4Ix(
      signer.publicKey,
      recipient,
      poolConfig.poolPDA,
      poolConfig.treePDA,
      nullifierPDA,
      c7ProofBuffer,
      nullifierBytes,
      merkleRootBytes,
      prepared.subtreeRoot,
      prepared.siblings,
      prepared.directions,
      tokenProgram,
      poolVault,
      recipientTokenAccount,
      relayed,
    );

    const tx = new Transaction();
    // The handler walks three Poseidon levels on top of the v3 work; measured
    // headroom, not a guess carried over.
    // [ZK-DEPTH-11 2026-08-30] 400,000 -> 500,000. `resolve_pool_root` walks
    // FOUR levels now: ~137,876 CU at the ~34,469 measured per on-chain `hash2`,
    // up from ~103,407. ⚠️ Headroom, not an end-to-end measurement.
    tx.add(...buildComputeBudgetIxs(500_000));
    if (!isNativeSOL && recipientTokenAccount) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey, recipientTokenAccount, recipient, poolConfig.tokenMint,
        ),
      );
    }
    tx.add(ix);

    onProgress?.('Sending V4 unshield transaction...');
    const sig = await signSendV3(connection, tx, signer, onProgress);
    onProgress?.('V4 unshield confirmed!');
    return sig;
  } finally {
    if (c7ProofBuffer) {
      try {
        onProgress?.('Closing proof buffer (rent recovery)...');
        await closeStarkProofBuffer(c7ProofBuffer, signer, connection, { sweepTo: options?.sweepTo });
      } catch (closeErr: unknown) {
        console.warn(
          '[DenomPool/v4] closeStarkProofBuffer failed:',
          closeErr instanceof Error ? closeErr.message : String(closeErr),
        );
      }
    }
  }
}

// ===========================================================================
// THE RELAYED WITHDRAWAL — the buyer signs nothing
//
// P11 is the last [open] probe in verify/p01-verify.mjs: the spend's fee payer
// can be traced to a funding wallet, and that payer is the buyer. C7 closed the
// commitment channel and left this one.
//
// The close is not cryptography, it is arithmetic. `unshield_denominated_stark_v4_relayed`
// pays its submitter a fixed reward OUT OF THE NOTE, so a stranger can afford
// to send the transaction and no lamport ever travels from the buyer to them.
// The v3 relayer was paid by a transfer FROM the buyer's wallet, which moved
// the payer one hop and left the edge exactly where it was.
//
// 🚨 SAFE ONLY BECAUSE CIRCUIT 7 BINDS THE RECIPIENT. `prepared` names the payee
// inside `public_inputs_hash`; a relayer that re-points the payout invalidates
// the proof it is relaying. Handing a v3 proof to a stranger was handing them
// the money.
//
// ⚠️ What this does NOT close: P6 stays FAIL forever (a fee payer always has a
// funding history — it is the relayer's now, not the buyer's), the deposit side
// (P8/P9) is untouched, and one buyer through one relayer is a crowd of one.
// ===========================================================================

/**
 * Mirrors `fee.rs`: UNSHIELD_FEE_BPS and RELAYER_REWARD_LAMPORTS. Duplicated
 * rather than imported because the program is Rust and this is the client; the
 * guard below exists to fail EARLY, and the program is still the authority.
 */
export const UNSHIELD_FEE_BPS = 50n;
/** How often to ask. Short enough to feel live, long enough not to hammer. */
const RELAY_POLL_INTERVAL_MS = 3_000;

/**
 * ⚠️ A CEILING, NOT A VERDICT. Hitting it means the client stopped waiting —
 * it never means the spend failed. MEASURED: a full relayed batch is ~190 s, so
 * 10 minutes is generous by design; a job still running at that point is a
 * question for the chain, and the error says so.
 */
const RELAY_POLL_DEADLINE_MS = 10 * 60 * 1000;

/** Consecutive unreachable polls before giving up on asking. */
const RELAY_POLL_MAX_NETWORK_ERRORS = 10;

export const RELAYER_REWARD_LAMPORTS = 2_500_000n;

/**
 * Can a note of this size pay a relayer at all?
 *
 * 🚨 THE SMALL POOL CANNOT, AND IT FAILS CLOSED ON CHAIN. The reward comes out
 * of the protocol fee, never the payee's share, and the fee on a 0.1 SOL note is
 * 500,000 lamports against a 2,500,000 reward. `fee_to_escrow` is a `checked_sub`,
 * so the program returns `RelayerRewardExceedsNote` rather than quietly shorting
 * the merchant.
 *
 * ⚠️ Offering the button anyway and letting the chain refuse would cost the user
 * a full proving run — minutes — before telling them. This is the same check,
 * asked before the work instead of after it.
 */
export function relayedWithdrawalAffordability(denominationSol: number): {
  affordable: boolean;
  feeLamports: bigint;
  rewardLamports: bigint;
} {
  const lamports = BigInt(Math.round(denominationSol * 1e9));
  const feeLamports = (lamports * UNSHIELD_FEE_BPS) / 10_000n;
  return {
    affordable: feeLamports >= RELAYER_REWARD_LAMPORTS,
    feeLamports,
    rewardLamports: RELAYER_REWARD_LAMPORTS,
  };
}

/**
 * Build every transaction a relayed spend needs, unsigned, in the relayer's
 * name. Nothing here touches a wallet: the buyer produces bytes.
 */
export async function buildRelayedUnshieldV4Batch(
  poolConfig: PoolConfig,
  recipient: PublicKey,
  prepared: PrepareUnshieldV4Result,
  relayer: PublicKey,
  connection: Connection,
): Promise<{ transactions: Transaction[]; proofBuffer: PublicKey }> {
  if (!prepared.recipient.equals(recipient)) {
    throw new Error(
      `This proof was prepared for ${prepared.recipient.toBase58()} and cannot pay ` +
      `${recipient.toBase58()}. Circuit 7 binds sha256(recipient) into its transcript.`,
    );
  }
  if (!poolConfig.tokenMint.equals(SystemProgram.programId)) {
    // The reward leaves in lamports and an SPL note is denominated in tokens.
    // The program fails closed on this; say so here rather than after 78 chunks.
    throw new Error(
      'The relayed path is native-SOL only: the relayer reward is paid in ' +
      'lamports out of a note this pool denominates in tokens.',
    );
  }

  // ⚠️ AND THE POOL HAS TO BE ABLE TO AFFORD IT. The reward is taken from the
  // protocol fee — never from the payee, so that the amount the recipient gets
  // cannot depend on which entry point was used — and a pool whose 0.5% is
  // smaller than the reward simply cannot pay a relayer. MEASURED: the 1 SOL
  // pool charges 5,000,000 lamports and covers it; the 0.1 SOL pool charges
  // 500,000 and does not. The program refuses this too; refusing here saves 78
  // chunk uploads and the buffer rent that pays for them.
  // 🚨 `denominationAtomic`, NEVER `denomination`. The latter is the HUMAN
  // number — 1, or 0.1 — so computing a fee from it gave `1 * 50 / 10000 = 0`
  // and this guard refused every relayed withdrawal on every pool. Found by
  // round-tripping a real batch before the first live run; the unit tests had
  // missed it because their fixture carried the same wrong unit as the code.
  const protocolFee = (poolConfig.denominationAtomic * UNSHIELD_FEE_BPS) / 10_000n;
  if (protocolFee < RELAYER_REWARD_LAMPORTS) {
    throw new Error(
      `This pool cannot pay a relayer: its protocol fee is ${protocolFee} lamports ` +
      `and the reward is ${RELAYER_REWARD_LAMPORTS}. Withdraw directly, or use a ` +
      `larger denomination.`,
    );
  }

  const proof: GenericStarkProof = {
    proofBytes: prepared.c7ProofResult.proofBytes,
    circuitId: CIRCUIT_SPEND,
    publicInputs: prepared.c7ProofResult.publicInputs,
    proofSize: prepared.c7ProofResult.proofSize,
  };

  // 🚨 THE CLIENT DOES NOT TOUCH THE RELAYER'S BUFFER. It used to prepend a
  // `close_proof_buffer` when it saw a stale one, which is a race with teeth:
  // the buffer PDA is seeded on `[b"stark_proof", relayer, circuit]`, so it is
  // ONE account shared by every buyer using that node. A second buyer checking
  // "is there a stale buffer?" while the first is 40 chunks in sees `not null`
  // and asks the node to destroy a live upload.
  //
  // The node runs one job at a time and closes its own leftovers. Buffer
  // lifecycle belongs to whoever owns the key.
  const [proofBuffer] = getProofBufferPDA(relayer, CIRCUIT_SPEND);
  void connection; // the stale check moved to the node

  const { transactions } = buildStarkProofUploadBatch(proof, relayer);

  const nullifierBytes = goldilocksToLeBytes32(prepared.nullifierGoldilocks);
  const merkleRootBytes = goldilocksToLeBytes32(prepared.merkleRoot);
  const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);

  const spend = new Transaction();
  spend.feePayer = relayer;
  spend.recentBlockhash = RELAY_PLACEHOLDER_BLOCKHASH;
  // [ZK-DEPTH-11 2026-08-30] 400,000 -> 500,000. `resolve_pool_root` walks
  // FOUR levels now: ~137,876 CU at the ~34,469 measured per on-chain `hash2`,
  // up from ~103,407. ⚠️ Headroom, not an end-to-end measurement.
  spend.add(...buildComputeBudgetIxs(500_000));
  spend.add(
    buildUnshieldDenominatedStarkV4Ix(
      relayer,
      recipient,
      poolConfig.poolPDA,
      poolConfig.treePDA,
      nullifierPDA,
      proofBuffer,
      nullifierBytes,
      merkleRootBytes,
      prepared.subtreeRoot,
      prepared.siblings,
      prepared.directions,
      undefined,
      undefined,
      undefined,
      true, // the sibling instruction — this is what pays the relayer
    ),
  );
  transactions.push(spend);

  // The relayer fronted 0.544105 SOL of rent for the buffer and gets it back
  // here. Leaving this off would make the reward a rounding error against the
  // capital it locks up, and the relayer would stop relaying.
  const close = new Transaction();
  close.feePayer = relayer;
  close.recentBlockhash = RELAY_PLACEHOLDER_BLOCKHASH;
  close.add(buildCloseProofBufferIx(proofBuffer, relayer));
  transactions.push(close);

  return { transactions, proofBuffer };
}

/** Serialise a built batch for POST /spend. Unsigned, by construction. */
export function serialiseRelayBatch(transactions: Transaction[]): string[] {
  return transactions.map((tx) =>
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
  );
}

/**
 * Hand the batch to a relayer and wait for the spend.
 *
 * ⚠️ NO FALLBACK TO DIRECT SUBMISSION. The v3 relayer fell back on any error,
 * which meant its privacy guarantee held only when the infrastructure felt
 * well — and the buyer was never told which of the two had happened. If this
 * throws, the withdrawal did not happen, and the caller decides whether to
 * spend publicly instead. Failing closed is the whole point.
 */
/**
 * Hand the batch over, then POLL. Never hold the answer in the request.
 *
 * 🚨 MEASURED 2026-08-28 against the hosted node: a single held-open POST died
 * with `ECONNRESET` after 193 s while the node finished the job and the
 * withdrawal LANDED (`43vWVvXGu6tvkNDKmcsu…`, payee +0.995 SOL). The buyer was
 * shown `fetch failed` for a spend that had succeeded. Retrying then fails on
 * the spent nullifier, which is safe and reads like a second failure — so the
 * note is gone and every screen says otherwise.
 *
 * A ~2 minute request has to survive the client, the platform edge, and every
 * hop between. Polling asks for nothing to stay open, so a dropped connection
 * costs one retry instead of the answer.
 */
export async function relayUnshieldV4(
  relayerUrl: string,
  transactions: Transaction[],
  onProgress?: (step: string) => void,
): Promise<{ spendSignature: string; signatures: string[] }> {
  const base = relayerUrl.replace(/\/$/, '');
  onProgress?.(`Handing ${transactions.length} transactions to the relayer...`);
  const res = await fetch(`${base}/spend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transactions: serialiseRelayBatch(transactions) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.ok) {
    throw new Error(`Relayer refused or failed: ${body?.error ?? `HTTP ${res.status}`}`);
  }

  // A node that already answered with the signature is the pre-polling build.
  // Kept so the client and the node can be deployed in either order.
  if (body.spendSignature) {
    onProgress?.('Relayed spend confirmed.');
    return { spendSignature: body.spendSignature, signatures: body.signatures ?? [] };
  }

  const jobId = body.jobId;
  if (typeof jobId !== 'string' || !jobId) {
    throw new Error('Relayer accepted the batch but returned no job id');
  }

  const startedAt = Date.now();
  let consecutiveNetworkErrors = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, RELAY_POLL_INTERVAL_MS));
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (Date.now() - startedAt > RELAY_POLL_DEADLINE_MS) {
      throw new Error(
        `Relayer job ${jobId} still running after ${elapsed}s. It may still land — ` +
          'check the chain before retrying, because a retry cannot spend a spent note.',
      );
    }
    onProgress?.(`Relayer is working... ${elapsed}s elapsed`);

    let poll: Response;
    try {
      poll = await fetch(`${base}/spend/${encodeURIComponent(jobId)}`);
    } catch {
      // ⚠️ A DROPPED POLL IS NOT A FAILED SPEND. This is the exact condition
      // that produced the false failure; treating it as terminal would rebuild
      // the bug one layer up. Keep asking until the deadline.
      consecutiveNetworkErrors += 1;
      if (consecutiveNetworkErrors >= RELAY_POLL_MAX_NETWORK_ERRORS) {
        throw new Error(
          `Lost contact with the relayer for ${consecutiveNetworkErrors} polls on job ${jobId}. ` +
            'The spend may still have landed — read the chain before retrying.',
        );
      }
      continue;
    }
    consecutiveNetworkErrors = 0;

    if (poll.status === 404) {
      // Unknown and forgotten are the same answer, and neither means "failed".
      throw new Error(
        `Relayer no longer knows job ${jobId}. Read the chain: the spend may have landed.`,
      );
    }
    const state = await poll.json().catch(() => ({}));
    if (state?.state === 'done') {
      onProgress?.('Relayed spend confirmed.');
      return { spendSignature: state.spendSignature, signatures: state.signatures ?? [] };
    }
    if (state?.state === 'failed') {
      throw new Error(`Relayer failed: ${state.error ?? 'no reason given'}`);
    }
  }
}

// ===========================================================================
// DENOMINATED NOTE-TO-NOTE TRANSFER (C1 + C3 + C6)
//
// Port of mobile transferDenominatedStarkV3. Spends a mature OLD note (C1
// ownership + C3 membership) and inserts a brand-new note (C6) owned only by
// fresh RANDOM secrets, which are handed to the recipient as an encoded
// "shareable note". Funds never leave the pool — no recipient/vault accounts,
// no fee_escrow. Mirrors transfer_denominated_stark_v3.rs exactly.
// ===========================================================================

/**
 * Cross-client shareable note. MUST round-trip with mobile
 * (apps/mobile/services/denominatedPool/index.ts ShareableNote): `version` is
 * the literal number 1; every bigint field is a DECIMAL string; `token_mint`
 * is the BN254-reduced field element (pubkeyToField), NOT base58; `pool` is the
 * pool PDA base58.
 */
export interface ShareableNote {
  version: 1;
  pool: string;
  secret: string;
  nullifier_preimage: string;
  /**
   * The commitment's third slot — `ShieldReceipt.noteBlinding` in TypeScript.
   * The KEY MUST STAY `deposit_epoch`: it is the serialized form shared with
   * mobile and written into the PQ-encrypted note blob, and `extractStoredPath`
   * (`worker/poolHandlers.ts`) matches previously stored blobs by parsing this
   * exact shape. Renaming it without a `version` bump silently drops the stored
   * Merkle path and forces an RPC-dependent history rebuild.
   */
  deposit_epoch: string;
  token_mint: string;
  commitment: string;
  leafIndex: number;
  token: 'SOL' | 'USDC';
  denominationHuman: number;
  shieldedAt?: number;
  merkle_root?: string;
  merkle_path_elements?: string[];
  merkle_path_indices?: number[];
}

/** btoa(JSON) — matches mobile encodeShareableNote. */
export function encodeShareableNote(note: ShareableNote): string {
  return btoa(JSON.stringify(note));
}

/** JSON(atob) — matches mobile decodeShareableNote. Throws on bad version. */
export function decodeShareableNote(encoded: string): ShareableNote {
  const note = JSON.parse(atob(encoded.trim()));
  if (note?.version !== 1) {
    throw new Error(`Unsupported note version: ${note?.version}`);
  }
  return note as ShareableNote;
}

/**
 * Cryptographically-random u64 (8 bytes, little-endian). Used for the FRESH
 * recipient-note secrets in a transfer. These are NOT seed-derived — if the
 * recipient loses the encoded note the funds are permanently unrecoverable
 * (surfaced in the transfer UI). Mirrors mobile denominated-transfer.tsx.
 */
export function secureRandomU64(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/**
 * Build `transfer_denominated_stark_v3` instruction.
 *
 * Matches transfer_denominated_stark_v3.rs exactly:
 *   Args : nullifier[32] | merkle_root[32] | min_epoch u64 | stark_commitment u64
 *          | new_commitment[32] | new_root[32] | Vec<[u8;32]> new_subtrees
 *   (data length = 8+32+32+8+8+32+32+4 + 32*N = 636 for N=15)
 *   Accounts (8, order critical): payer(signer,mut), denominated_pool(mut),
 *   merkle_tree(MUT — a leaf is inserted), nullifier_record(init,mut),
 *   c1_proof_buffer(ro), c3_proof_buffer(ro), c6_proof_buffer(ro), system_program.
 *   NO fee_escrow, NO token/vault/recipient — funds stay in the pool.
 *
 * ⚠ `minEpoch` IS ENFORCED ON-CHAIN for this instruction, unlike unshield:
 * `transfer_denominated_stark_v3.rs:167-173` requires
 * `current_epoch >= min_epoch + dynamic_delay`. NEVER pass a note's
 * `noteBlinding` here — it is a 63-bit secret, so it would both set an
 * unreachable maturity floor (EpochDelayNotMet forever) and publish the
 * blinding in the clear. Pass a real epoch, or 0. This builder has no
 * production caller today; it is kept because the parity suite locks its wire
 * format against the deployed handler.
 */
export function buildTransferDenominatedStarkV3Ix(
  payer: PublicKey,
  poolPDA: PublicKey,
  treePDA: PublicKey,
  nullifierPDA: PublicKey,
  c1ProofBuffer: PublicKey,
  c3ProofBuffer: PublicKey,
  c6ProofBuffer: PublicKey,
  nullifierBytes: number[],
  merkleRootBytes: number[],
  minEpoch: bigint,
  starkCommitment: bigint,
  newCommitmentBytes: number[],
  newRootBytes: number[],
  newSubtreesBytes: number[][],
): TransactionInstruction {
  const disc = getDiscriminator('transfer_denominated_stark_v3');
  const subtreesBytesLen = 4 + newSubtreesBytes.length * 32;
  const data = Buffer.alloc(8 + 32 + 32 + 8 + 8 + 32 + 32 + subtreesBytesLen);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(nullifierBytes).copy(data, offset); offset += 32;
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(minEpoch, offset); offset += 8;
  data.writeBigUInt64LE(starkCommitment, offset); offset += 8;
  Buffer.from(newCommitmentBytes).copy(data, offset); offset += 32;
  Buffer.from(newRootBytes).copy(data, offset); offset += 32;
  data.writeUInt32LE(newSubtreesBytes.length, offset); offset += 4;
  for (const st of newSubtreesBytes) {
    Buffer.from(st).copy(data, offset);
    offset += 32;
  }

  const keys = [
    { pubkey: payer,                   isSigner: true,  isWritable: true  },
    { pubkey: poolPDA,                 isSigner: false, isWritable: true  },
    { pubkey: treePDA,                 isSigner: false, isWritable: true  },
    { pubkey: nullifierPDA,            isSigner: false, isWritable: true  },
    { pubkey: c1ProofBuffer,           isSigner: false, isWritable: false },
    { pubkey: c3ProofBuffer,           isSigner: false, isWritable: false },
    { pubkey: c6ProofBuffer,           isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

// ---------------------------------------------------------------------------
// DELETED: prepareTransfer / transferDenominatedStarkV3 / PrepareTransferResult
//
// The note-to-note transfer orchestration is gone from the web client, and it
// must not come back in this shape.
//
// WHY
// ───
// It passed `receipt.depositEpoch` as `min_epoch`, and unlike unshield the
// transfer handler ENFORCES that field:
//   transfer_denominated_stark_v3.rs:166-173
//     let dynamic_delay = pool.get_dynamic_delay();
//     let effective_min_epoch = min_epoch.checked_add(dynamic_delay)...;
//     require!(current_epoch >= effective_min_epoch, ZkShieldedError::EpochDelayNotMet);
//
// Since the commitment gained a 63-bit PRF blinding in that slot
// (noteBlinding.ts), a current note carries a `noteBlinding` near 2^62. Feeding
// it in as `min_epoch` sets a maturity floor roughly 2^62 epochs in the future,
// so every blinded note would be PERMANENTLY un-transferable with
// EpochDelayNotMet — and the transaction would publish the blinding in the clear
// on its way to failing. It had no caller anywhere in apps/web, so it is deleted
// rather than patched: a future caller cannot trip a landmine that is not here.
//
// If note-to-note transfer is wanted again, it must pass a REAL epoch (or 0) as
// `min_epoch` and blind the NEW note's commitment slot separately.
// `buildTransferDenominatedStarkV3Ix` is deliberately kept: it is a pure byte
// encoder with no note input, and the parity suite locks its on-chain wire
// contract.
// ---------------------------------------------------------------------------

/**
 * Decode + validate a received shareable note into a ShieldReceipt the store
 * can persist + later unshield. Recomputes the commitment from the secrets and
 * asserts it matches — guards against a corrupted/mismatched note string.
 */
export function importNote(encoded: string): ShieldReceipt {
  return shareableNoteToReceipt(decodeShareableNote(encoded));
}

/**
 * Validate a decoded ShareableNote (recompute the commitment from its secrets
 * and assert it matches) and reconstruct a ShieldReceipt. Used by both the
 * plaintext importNote path and the decrypted-blob path.
 */
export function shareableNoteToReceipt(note: ShareableNote): ShieldReceipt {
  if (note?.version !== 1) throw new Error(`Unsupported note version: ${note?.version}`);
  const pool = ALL_POOLS_V3.find((p) => p.poolPDA.toBase58() === note.pool);
  if (!pool) throw new Error(`Unknown pool in note: ${note.pool}`);

  const secret = BigInt(note.secret);
  const nullifierPreimage = BigInt(note.nullifier_preimage);
  // Wire key stays `deposit_epoch` on purpose — see ShieldReceipt.noteBlinding.
  const noteBlinding = BigInt(note.deposit_epoch);
  const tokenMint = BigInt(note.token_mint);
  const commitment = BigInt(note.commitment);

  const recomputed = createCommitmentV3(nullifierPreimage, secret, noteBlinding, tokenMint);
  if (recomputed !== commitment) {
    throw new Error('Invalid note: commitment does not match its secrets.');
  }
  // [AUDIT v1 r2, fix lane 1, F4] The note must be spendable in the pool it
  // names: its commitment binds a token mint, and one minted for another token
  // is not money in this pool whatever its label says.
  if (tokenMint !== pubkeyToField(pool.tokenMint)) {
    throw new Error('Invalid note: its token mint is not the mint of the pool it names.');
  }
  // ⚠️ NOT CHECKED HERE: that the commitment sits at `leafIndex` on the tree.
  // That needs a chain read, which the caller (`handlePoolImportNote`) owns.

  return {
    secret,
    nullifierPreimage,
    noteBlinding,
    tokenMint,
    commitment,
    leafIndex: note.leafIndex,
    denomination: pool.denominationAtomic,
    pool: note.pool,
    // [F4] From the pool table, never from the sender's JSON: the label is
    // what the screen shows as the amount received.
    token: pool.token,
    denominationHuman: pool.denomination,
    shieldedAt: note.shieldedAt ?? Date.now(),
    merkleRoot: note.merkle_root !== undefined ? BigInt(note.merkle_root) : undefined,
  };
}
