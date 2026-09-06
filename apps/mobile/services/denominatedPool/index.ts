/**
 * Denominated Pool Service for React Native
 *
 * Client-side ZK proving for Tornado Cash-style fixed-denomination pools.
 * Adapted from apps/extension/src/shared/services/denominatedPool.ts
 *
 * RULE #1: NO private inputs are sent to the relayer. All proving is client-side.
 *
 * Proving strategy:
 *   - snarkjs WASM loaded from bundled assets (Expo Asset system)
 *   - Single-threaded (no Web Workers in React Native)
 *   - Proof time ~1-3s on modern devices (4,273 constraints)
 *   - If snarkjs WASM fails on RN, see PROVING_NOTES at bottom of file
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { poseidon2, poseidon4 } from 'poseidon-lite';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import { getConnection } from '../solana/connection';
import { getKeypair } from '../solana/wallet';
import * as SecureStore from 'expo-secure-store';
// [2026-08-25] The commitment's third input. Re-exported so callers reach it
// through the same barrel as `deriveNoteMaterial`, which it is always paired
// with — the two describe the same note and drifting apart makes it
// unrecoverable.
import { deriveNoteBlinding } from './noteBlinding';
export { deriveNoteBlinding } from './noteBlinding';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ZK_SHIELDED_PROGRAM_ID = new PublicKey(
  'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c'
);

const NATIVE_SOL_MINT = SystemProgram.programId;

export const USDC_DEVNET_MINT = new PublicKey(
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
);

/// Protocol fee wallet — hardcoded, must match on-chain constant
/** Legacy hardcoded fee wallet — V2 paths only. V3 paths route through
 * per-pool `fee_escrow` PDAs (see `deriveFeeEscrowPDA` below). Phase E v1
 * (deployed 2026-05-07) closes L16/partial-L17 by removing this constant
 * from V3 tx accounts. */
const PROTOCOL_FEE_WALLET = new PublicKey(
  'BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN'
);

/** Per-pool fee_escrow PDA (Phase E v1). Mirrors the on-chain Anchor
 * constraint `seeds = [b"fee_escrow", pool.key()]` in
 * `programs/zk_shielded/src/instructions/{shield,unshield}_denominated_v3.rs`.
 * The escrow accumulates fees from V3 ix; treasury drains via
 * `sweep_fee_escrow` (only `TREASURY_AUTHORITY` can sign).
 *
 * Privacy property: pool-keyed, depositor-independent. Indexer cannot link
 * an escrow address to a single user — only to a (pool, total revenue) pair. */
export function deriveFeeEscrowPDA(poolPDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_escrow'), poolPDA.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID,
  );
}

export const MERKLE_DEPTH = 15;

/**
 * The depth circuits 3 and 6 prove, since 2026-08-29.
 *
 * Both were cut from 15 to 12 to free 128 unconstrained trace rows for a
 * blinding region. The pool tree is still MERKLE_DEPTH (15) deep; the circuits
 * cover only its bottom 12 levels, and the instructions walk the remaining 3 on
 * chain — C3's read side against caller-supplied siblings, C6's write side
 * against the POOL ACCOUNT's own `filled_subtrees`.
 *
 * ⛔ SENDING 15 PATH ELEMENTS INTO EITHER PROVER PANICS INSIDE THE WASM. The
 * trace builder asserts the mask length for the depth it was handed, so the
 * failure lands mid-proof with no useful message. Slice first.
 *
 * Two constants, not one, and numerically equal to `C7_SUBTREE_DEPTH`:
 * nothing requires the circuits to move together, and one shared constant is
 * what would make the next divergence invisible.
 */
/**
 * \U0001f6a8 11, NOT 12 -- and it was 12 here while the circuit had moved.
 *
 * Rust owns this depth (`stark/src/air/merkle_update.rs` CANONICAL_DEPTH), the shipped
 * prover checks the path against it, and the deployed verifier agrees. A
 * client that slices to 12 builds a proof of a tree the chain does not use,
 * so it cannot be accepted however well the rest of the flow works. The web
 * client moved with the circuit; this stack did not.
 *
 * \u26d4 Mirrors Rust across a wire that carries no types: move it in the same
 * commit as CANONICAL_DEPTH, never on its own.
 */
export const C6_SUBTREE_DEPTH = 11;
/**
 * \U0001f6a8 11, NOT 12 -- and it was 12 here while the circuit had moved.
 *
 * Rust owns this depth (`stark/src/air/merkle_path.rs` CANONICAL_DEPTH), the shipped
 * prover checks the path against it, and the deployed verifier agrees. A
 * client that slices to 12 builds a proof of a tree the chain does not use,
 * so it cannot be accepted however well the rest of the flow works. The web
 * client moved with the circuit; this stack did not.
 *
 * \u26d4 Mirrors Rust across a wire that carries no types: move it in the same
 * commit as CANONICAL_DEPTH, never on its own.
 */
export const C3_SUBTREE_DEPTH = 11;

const SLOTS_PER_EPOCH = 7200;

const FIELD_ORDER = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

export const ZERO_VALUE = BigInt(
  '21663839004416932945382355908790599225266501822907911457504978515578255421292'
);

const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  'ComputeBudget111111111111111111111111111111'
);

/** Build compute budget instructions for Groth16 verification transactions */
function buildComputeBudgetIxs(cuLimit = 500_000, cuPriceMicroLamports = 1000) {
  // SetComputeUnitLimit (discriminator = 2)
  const limitData = Buffer.alloc(5);
  limitData.writeUInt8(2, 0);
  limitData.writeUInt32LE(cuLimit, 1);

  // SetComputeUnitPrice (discriminator = 3)
  const priceData = Buffer.alloc(9);
  priceData.writeUInt8(3, 0);
  priceData.writeBigUInt64LE(BigInt(cuPriceMicroLamports), 1);

  return [
    new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: limitData }),
    new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: priceData }),
  ];
}

// ---------------------------------------------------------------------------
// Pool configuration — matches docs/devnet-pools.md
// ---------------------------------------------------------------------------

export interface PoolConfig {
  token: 'SOL' | 'USDC';
  tokenMint: PublicKey;
  denomination: number; // human-readable (0.1, 1, 10, etc.)
  denominationAtomic: bigint; // lamports / atomic units
  decimals: number;
  poolPDA: PublicKey;
  treePDA: PublicKey;
  vaultATA?: PublicKey; // only for SPL tokens
  /**
   * V3 marker. Defaults to 'v2' (BN254 Poseidon, off-chain merkle hash).
   * 'v3' = full Goldilocks Poseidon end-to-end + on-chain C3/C6 STARK
   * verification. v2 + v3 pools coexist during the 30-day deprecation
   * window. See `v3-stark-migration-plan-2026-05-02.md`.
   */
  version?: 'v2' | 'v3';
}

// v2 pools — fresh PDAs after program seed bump to `denominated_pool_v2`
// on 2026-04-23 to escape the pre-hardening event-decoding gap. The
// previous pools (JDVr…, BoCT…, 2ZTW…, 4t5n…, 2Eza…, 5XaB…) are orphaned
// on-chain; any notes still inside them are unrecoverable via event scan.
export const SOL_POOLS: PoolConfig[] = [
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 0.1, decimals: 9,
    denominationAtomic: 100_000_000n,
    poolPDA: new PublicKey('HkzArVjUuZTRZPzCP7jAm5Fe6R9yrRAsmWZmDArY43FN'),
    treePDA: new PublicKey('2UPewB6NLM2QGxUJhC1XLVxDJdH7LGoqFFvKsBfYnmft'),
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 1, decimals: 9,
    denominationAtomic: 1_000_000_000n,
    poolPDA: new PublicKey('43mLkfHhwtNYxr3YFk51aoZRQXJj75Md3VuoLaPjx2kN'),
    treePDA: new PublicKey('BgJqg7aAHmWoCCXtkgqKwm1Xe6vaJHLZFHsD8kYJyAPx'),
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 10, decimals: 9,
    denominationAtomic: 10_000_000_000n,
    poolPDA: new PublicKey('AdAWCU2aVJH8cBrypj3Dh3bidcF67J7ueyLPobj6FiT5'),
    treePDA: new PublicKey('7j8pQ3ZXJxu36fzM2Rgruf9gBbjVcxJw4zZDHGimKKiD'),
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 100, decimals: 9,
    denominationAtomic: 100_000_000_000n,
    poolPDA: new PublicKey('EFbbkhqVqQx1J3CU4PmjC96QSWKZYwqGY7sAmZbe8VE9'),
    treePDA: new PublicKey('6r6odPZa7cgLF6rgrfXovkupb28KVgqvc3Cvkby8EcSC'),
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 500, decimals: 9,
    denominationAtomic: 500_000_000_000n,
    poolPDA: new PublicKey('G5N3cUe8LLu2Nz6dKP65jW6DU7myeqhoJHLU5m4wJzp8'),
    treePDA: new PublicKey('4NDX38XxyKv1BD5ePb92zbfkQ5qoBJXRK3Gu882YgZZS'),
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 1000, decimals: 9,
    denominationAtomic: 1_000_000_000_000n,
    poolPDA: new PublicKey('2skomH6yfy6yKDXzeCFVbfYBeK31BjjCsuAFEPbTZ78v'),
    treePDA: new PublicKey('3RvMwWX6BY6KdWUcXH2RwTWERuZsWTt7G3e35nHkjAgG'),
  },
];

export const USDC_POOLS: PoolConfig[] = [
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 1, decimals: 6,
    denominationAtomic: 1_000_000n,
    poolPDA: new PublicKey('AMvtg8yd4PstQn6gZv4bMqU2mtxH1qBsTWzqD5vyiAUw'),
    treePDA: new PublicKey('FNqC4MHarRmFZtdcBej8k9arVfyKDidk6hM4KzY1r6HW'),
    vaultATA: new PublicKey('2pPY438F6zmtVRh3aSzYB9vc7zDS9qXwG95bcDspPaDk'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 10, decimals: 6,
    denominationAtomic: 10_000_000n,
    poolPDA: new PublicKey('FAMYb1Zmhfk8iZ2KTmgybxfRSWYz9YLhqBA3BHPjmE6W'),
    treePDA: new PublicKey('5CvbSqSmcdwMF23iGHzwMwkr4YQxM2Fq5E65BaQut34k'),
    vaultATA: new PublicKey('76uWnHtZPWExcuaft5UFArghsTdK3qHYPNBbJ1Ws55JH'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 100, decimals: 6,
    denominationAtomic: 100_000_000n,
    poolPDA: new PublicKey('9vd5r2EtNdNzePWUrNjMukkPAgzUpMXU5PmX6vTFqC4c'),
    treePDA: new PublicKey('HMiNXiepnaaGeaqdt2n4uctXD7rr8oKt5c37y3yXZzmz'),
    vaultATA: new PublicKey('GsWUAxhGgDURT6aKeaEgWcpjTB8TxHu3FiPUTYPhvPoH'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 1000, decimals: 6,
    denominationAtomic: 1_000_000_000n,
    poolPDA: new PublicKey('Fy1AzmvXQDRtUZBPbxrDrhi81UasRf5AzXAEJqfy6afc'),
    treePDA: new PublicKey('FanL6QVGE1GmFNb55SuKXQqfwHRkzZ43ogg6Zrs39s6d'),
    vaultATA: new PublicKey('5XsJzjhqPuXnYBQYLTBbRENyH7PfpBgj85DEo17TuSC5'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 10_000, decimals: 6,
    denominationAtomic: 10_000_000_000n,
    poolPDA: new PublicKey('Hnmp8yGvHyjtxPwPLkpZ8LJq1sv8iQJMQ4ci7mo6B1eT'),
    treePDA: new PublicKey('5b9GSKpSi5nPvXqqAXw7DCiigTGFiJWtUf7xVNsV1n9U'),
    vaultATA: new PublicKey('GWWiNNBL1oMz7WJ1wjuZPcS2p9Ei8D3ZPpqZcbbFG5Mw'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 20_000, decimals: 6,
    denominationAtomic: 20_000_000_000n,
    poolPDA: new PublicKey('F1aK81X8TXTazehiWdGcTixxHJALvrsjnSqiZHEeXyer'),
    treePDA: new PublicKey('eV3G5WvLydNwCUR5Jx1At6ugBF8Ws36Am334gDrsrF5'),
    vaultATA: new PublicKey('HC2nXah3qWdWRuc9BtsCwfPjcf3otCRr9gphWZm89hDU'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 50_000, decimals: 6,
    denominationAtomic: 50_000_000_000n,
    poolPDA: new PublicKey('6jgvKWo7Fvm4XqDTRHJues55xm15RN55hoVs6ktpYihD'),
    treePDA: new PublicKey('9sGSk7o8cFgsBfHrzzbP2to2CUTzRijEeVY3pX5VKE7h'),
    vaultATA: new PublicKey('5VWgVf7Y2yUeFRSTdgfrnAPD87cH32ZmeWFucSBp6TV3'),
  },
];

export const ALL_POOLS: PoolConfig[] = [...SOL_POOLS, ...USDC_POOLS];

export function getPoolsForToken(token: 'SOL' | 'USDC'): PoolConfig[] {
  return token === 'SOL' ? SOL_POOLS : USDC_POOLS;
}

export function findPool(token: 'SOL' | 'USDC', denomination: number): PoolConfig | undefined {
  return ALL_POOLS.find(p => p.token === token && p.denomination === denomination);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShieldReceipt {
  secret: bigint;
  nullifierPreimage: bigint;
  depositEpoch: bigint;
  tokenMint: bigint;
  commitment: bigint;
  leafIndex: number;
  denomination: bigint;
  pool: string;
  token: 'SOL' | 'USDC';
  denominationHuman: number;
  shieldedAt: number; // unix timestamp ms
  merklePathElements?: bigint[];
  merklePathIndices?: number[];
  merkleRoot?: bigint;
}

export interface PoolOnChainInfo {
  isActive: boolean;
  noteCount: number;
  nextLeafIndex: number;
  totalShielded: bigint;
  epochDelay: bigint;
  matureNoteCount: number;
  dynamicDelay: number;
  currentRoot: Uint8Array;
}

/** Shareable note data for peer-to-peer transfers and backup */
export interface ShareableNote {
  version: 1;
  pool: string;
  secret: string;
  nullifier_preimage: string;
  deposit_epoch: string;
  token_mint: string;
  commitment: string;
  leafIndex: number;
  token: 'SOL' | 'USDC';
  denominationHuman: number;
  shieldedAt?: number; // original shield timestamp (ms)
  merkle_path_elements?: string[];
  merkle_path_indices?: number[];
  merkle_root?: string;
}

// ---------------------------------------------------------------------------
// Precomputed Merkle zeros
// ---------------------------------------------------------------------------

function computeZeroHashes(): bigint[] {
  const zeros = [ZERO_VALUE];
  for (let i = 1; i <= MERKLE_DEPTH; i++) {
    zeros.push(poseidon2([zeros[i - 1], zeros[i - 1]]));
  }
  return zeros;
}

let _zeroHashes: bigint[] | null = null;
function getZeroHashes(): bigint[] {
  if (!_zeroHashes) _zeroHashes = computeZeroHashes();
  return _zeroHashes;
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  // Use crypto.getRandomValues in React Native (via expo-crypto polyfill)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bytes[i]);
  return n % FIELD_ORDER;
}

/**
 * Derive (secret, nullifierPreimage) deterministically from the user's wallet
 * seed + (pool, counter). Makes shielded notes recoverable from seed alone:
 * the same seed on any device produces the same commitments, so a rescan of
 * the pool's leaves can reconstruct every receipt the user ever created.
 *
 * The nullifier derivation uses a distinct info tag to guarantee domain
 * separation from the secret (they must be independent field elements, or a
 * single compromised one would leak the other).
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

export interface RescannedReceipt {
  counter: number;
  depositEpoch: bigint;
  secret: bigint;
  nullifierPreimage: bigint;
  commitment: bigint;
}

/**
 * Reconstruct seed-derived receipts by matching candidate commitments against
 * a caller-supplied set of known on-chain commitments. Pure — no network or
 * wallet access. The caller fetches leaves however it wants (program logs,
 * transaction history, indexer) and passes the commitment set in.
 *
 * Counter range is inclusive. Epoch range is inclusive. The same (counter,
 * epoch) pair is tried against every token mint provided — usually the pool's
 * single mint, but takes a list so a future multi-mint pool still works.
 */
export function rescanPoolFromSeed(params: {
  walletSeed: Uint8Array;
  poolPDA: PublicKey;
  tokenMints: PublicKey[];
  epochs: bigint[];
  maxCounter: number;
  knownCommitments: Set<string>;
}): RescannedReceipt[] {
  const { walletSeed, poolPDA, tokenMints, epochs, maxCounter, knownCommitments } = params;
  const matches: RescannedReceipt[] = [];
  const mintFields = tokenMints.map(pubkeyToField);
  for (let counter = 0; counter <= maxCounter; counter++) {
    const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, poolPDA, counter);
    for (const epoch of epochs) {
      for (const mintField of mintFields) {
        const commitment = createCommitment(nullifierPreimage, secret, epoch, mintField);
        if (knownCommitments.has(commitment.toString())) {
          matches.push({ counter, depositEpoch: epoch, secret, nullifierPreimage, commitment });
        }
      }
    }
  }
  return matches;
}

/**
 * V3 — same as `rescanPoolFromSeed` but uses the Goldilocks Poseidon
 * `createCommitmentV3`. V3 commitments are u64 (low limb of the t=5 hash);
 * the on-chain leaf at the same position is exactly that u64 LE-padded to 32
 * bytes, so `commitment.toString()` matches the bigint we read from the
 * `LeafInserted.leaf` field via `leBytes32ToBigint`.
 */
export function rescanPoolFromSeedV3(params: {
  walletSeed: Uint8Array;
  poolPDA: PublicKey;
  tokenMints: PublicKey[];
  epochs: bigint[];
  maxCounter: number;
  knownCommitments: Set<string>;
}): RescannedReceipt[] {
  const { walletSeed, poolPDA, tokenMints, epochs, maxCounter, knownCommitments } = params;
  const matches: RescannedReceipt[] = [];
  const mintFields = tokenMints.map(pubkeyToField);
  for (let counter = 0; counter <= maxCounter; counter++) {
    const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, poolPDA, counter);

    // Current scheme: the commitment's third input is a seed-derived blinding,
    // so the note is identified with ONE hash per mint and no epoch search.
    const blinding = deriveNoteBlinding(walletSeed, poolPDA, counter);
    let blindedHit = false;
    for (const mintField of mintFields) {
      const commitment = createCommitmentV3(nullifierPreimage, secret, blinding, mintField);
      if (knownCommitments.has(commitment.toString())) {
        matches.push({ counter, depositEpoch: blinding, secret, nullifierPreimage, commitment });
        blindedHit = true;
      }
    }

    // ⛔ DO NOT REMOVE THIS FALLBACK. Notes shielded from this app before
    // 2026-08-25 put the REAL deposit epoch in that slot, so they are only
    // findable by the search. Dropping it does not fail loudly — the note simply
    // stops appearing, while its funds stay on chain and no client can name
    // them. apps/web carries the same fallback for the same reason, and names
    // an unspent legacy note at leaf 30 of the 0.1 SOL pool.
    if (blindedHit) continue;
    for (const epoch of epochs) {
      for (const mintField of mintFields) {
        const commitment = createCommitmentV3(nullifierPreimage, secret, epoch, mintField);
        if (knownCommitments.has(commitment.toString())) {
          matches.push({ counter, depositEpoch: epoch, secret, nullifierPreimage, commitment });
        }
      }
    }
  }
  return matches;
}

export function pubkeyToField(pubkey: PublicKey): bigint {
  const bytes = pubkey.toBytes();
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bytes[i]);
  return n % FIELD_ORDER;
}

// ---------------------------------------------------------------------------
// On-chain shield event fetcher (used by rescanPool)
// ---------------------------------------------------------------------------

/** Anchor event discriminator: first 8 bytes of sha256("event:<Name>"). */
function anchorEventDiscriminator(name: string): Uint8Array {
  return sha256(utf8ToBytes(`event:${name}`)).slice(0, 8);
}

const SHIELD_EVENT_DISC = anchorEventDiscriminator('ShieldDenominatedEvent');
const MERKLE_ROOT_CHANGED_DISC = anchorEventDiscriminator('MerkleRootChanged');

/**
 * Every zk_shielded event that can insert a leaf into the pool's Merkle
 * tree, with the byte offsets of the (commitment, leaf_index) pair inside
 * the event payload (including the 8-byte discriminator).
 *
 * Needed because until the security-hardening commit MerkleRootChanged
 * wasn't emitted, so the only record of those early insertions lives in
 * each instruction's flavored event. Any new event type that inserts a
 * leaf should be registered here too.
 */
const LEAF_INSERTION_EVENTS: Array<{
  name: string;
  disc: Uint8Array;
  commitmentOffset: number;
  leafIndexOffset: number;
  minLength: number;
}> = [
  // V3 universal LeafInserted event (programs/zk_shielded/src/state/merkle_tree_v3.rs:209)
  // Layout (after 8-byte disc):
  //   pool: Pubkey (32) @ 8
  //   leaf_index: u64 (8) @ 40
  //   leaf: [u8; 32] (32) @ 48
  //   new_root: [u8; 32] (32) @ 80
  //   old_root: [u8; 32] (32) @ 112
  // Total: 144 bytes. Listed first so it wins the disc match on V3 events.
  {
    name: 'LeafInserted',
    disc: anchorEventDiscriminator('LeafInserted'),
    commitmentOffset: 48,
    leafIndexOffset: 40,
    minLength: 144,
  },
  // V2: every leaf insertion emits this (post-hardening). Ordered after V3
  // so V3 events win first. Pre-hardening v2 pools fall through to flavored.
  {
    name: 'MerkleRootChanged',
    disc: MERKLE_ROOT_CHANGED_DISC,
    commitmentOffset: 112, // `leaf: [u8; 32]`
    leafIndexOffset: 104,
    minLength: 144,
  },
  // ShieldDenominatedEvent V2 (current): includes protocol_fee
  {
    name: 'ShieldDenominatedEvent/V2',
    disc: SHIELD_EVENT_DISC,
    commitmentOffset: 88,
    leafIndexOffset: 120,
    minLength: 128,
  },
  // ShieldDenominatedEvent V1 (pre-protocol_fee)
  {
    name: 'ShieldDenominatedEvent/V1',
    disc: SHIELD_EVENT_DISC,
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
    commitmentOffset: 72,  // new_commitment
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

/**
 * On-chain ShieldDenominatedEvent layouts. The struct grew by 8 bytes when
 * `protocol_fee: u64` was inserted after `denomination`, which shifted both
 * `commitment` and `leaf_index` downstream. Pools with a long history emit
 * both variants, so we try each and pick the one whose `leaf_index` falls
 * inside the tree's [0, 2^MERKLE_DEPTH) capacity.
 *
 *   V1 (original):  pool(32) | depositor(32) | denomination(8) |
 *                   commitment(32)@80 | leaf_index(u64)@112 | …
 *
 *   V2 (current):   pool(32) | depositor(32) | denomination(8) |
 *                   protocol_fee(8) | commitment(32)@88 | leaf_index(u64)@120 | …
 *
 * All offsets are relative to the start of the raw event data (including
 * the 8-byte discriminator).
 */
const EVENT_LAYOUTS: Array<{ commitmentOffset: number; leafIndexOffset: number }> = [
  { commitmentOffset: 88, leafIndexOffset: 120 }, // V2 — try first (most events)
  { commitmentOffset: 80, leafIndexOffset: 112 }, // V1 — pre-protocol_fee
];

export interface OnChainCommitment {
  commitment: bigint;
  leafIndex: number;
}

function tryDecodeShieldEvent(data: Buffer): { commitment: bigint; leafIndex: number } | null {
  const MAX_LEAVES = 1 << MERKLE_DEPTH;
  for (const layout of EVENT_LAYOUTS) {
    if (data.length < layout.leafIndexOffset + 8) continue;
    const rawIdx = data.readBigUInt64LE(layout.leafIndexOffset);
    // Guard against Number() overflow on u64 that exceeds 2^53.
    if (rawIdx > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const leafIndex = Number(rawIdx);
    if (leafIndex < 0 || leafIndex >= MAX_LEAVES) continue;
    const commitment = leBytes32ToBigint(data, layout.commitmentOffset);
    return { commitment, leafIndex };
  }
  return null;
}

/**
 * Decode a MerkleRootChanged event. This is the canonical source of leaf
 * insertions — it's emitted by `MerkleTree::insert_with_root` on every
 * leaf added to the tree, regardless of which instruction caused it
 * (shield, transfer_stark, split_note_stark, escrow_shield, etc.). Using
 * it as a universal fallback catches leaves that specific "flavored"
 * events (ShieldDenominatedEvent, TransferDenominatedEvent, …) would miss.
 *
 * Layout (Anchor + Borsh, after the 8-byte discriminator):
 *   pool: Pubkey         (32) @ 8
 *   old_root: [u8; 32]   (32) @ 40
 *   new_root: [u8; 32]   (32) @ 72
 *   leaf_index: u64      (8)  @ 104
 *   leaf: [u8; 32]       (32) @ 112
 * Total: 144 bytes.
 */
function tryDecodeMerkleRootChanged(data: Buffer): { commitment: bigint; leafIndex: number } | null {
  if (data.length < 144) return null;
  const rawIdx = data.readBigUInt64LE(104);
  if (rawIdx > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const leafIndex = Number(rawIdx);
  const MAX_LEAVES = 1 << MERKLE_DEPTH;
  if (leafIndex < 0 || leafIndex >= MAX_LEAVES) return null;
  const commitment = leBytes32ToBigint(data, 112);
  return { commitment, leafIndex };
}

function leBytes32ToBigint(buf: Uint8Array | Buffer, offset: number): bigint {
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(buf[offset + i]);
  return n;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Fetch every ShieldDenominatedEvent commitment for a given pool by walking
 * recent transactions and decoding Anchor event logs. Used as the
 * `knownCommitments` input to {@link rescanPoolFromSeed}.
 *
 * Bounded by `maxSignatures` (default 1000) so the scan stays linear in the
 * pool's recent activity rather than its full history. For a pool the user
 * has used personally, recent activity is more than enough — their notes
 * were created in their own session window.
 */
export async function fetchPoolCommitments(
  connection: Connection,
  poolPDA: PublicKey,
  options: { maxSignatures?: number; batchSize?: number; onProgress?: (scanned: number, total: number) => void } = {},
): Promise<Map<string, OnChainCommitment>> {
  const maxSignatures = options.maxSignatures ?? 1000;
  const batchSize = options.batchSize ?? 25;

  // Paginate — `getSignaturesForAddress` caps at 1000 per call on most RPCs.
  // We walk backwards in time using `before` until we reach `maxSignatures`
  // or the pool's full history. A long-lived pool can easily exceed 1000
  // signatures (pool init + every shield/unshield/transfer/settle emits
  // one), and without pagination the Merkle rebuild misses the earliest
  // leaves and produces a root that no historical root matches.
  const PAGE = 1000;
  const sigs: Array<{ signature: string }> = [];
  let before: string | undefined = undefined;
  while (sigs.length < maxSignatures) {
    const remaining = maxSignatures - sigs.length;
    const page = await connection.getSignaturesForAddress(poolPDA, {
      limit: Math.min(PAGE, remaining),
      before,
    });
    if (page.length === 0) break;
    sigs.push(...page);
    if (page.length < PAGE) break;
    before = page[page.length - 1].signature;
  }

  const out = new Map<string, OnChainCommitment>();

  for (let i = 0; i < sigs.length; i += batchSize) {
    const batch = sigs.slice(i, i + batchSize);
    const txs = await Promise.all(
      batch.map((s) =>
        connection
          .getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
          .catch(() => null),
      ),
    );

    for (const tx of txs) {
      const logs = tx?.meta?.logMessages;
      if (!logs) continue;
      for (const log of logs) {
        const m = log.match(/^Program data: (.+)$/);
        if (!m) continue;
        let data: Buffer;
        try { data = Buffer.from(m[1], 'base64'); } catch { continue; }
        if (data.length < 8) continue;
        const disc = data.subarray(0, 8);

        // Try every known leaf-inserting event shape. Pre-hardening pools
        // have insertions from shield/transfer/split/escrow that never
        // emitted MerkleRootChanged, so we need every flavored event
        // registered in LEAF_INSERTION_EVENTS.
        let decoded: { commitment: bigint; leafIndex: number } | null = null;
        const MAX_LEAVES = 1 << MERKLE_DEPTH;
        for (const layout of LEAF_INSERTION_EVENTS) {
          if (!bytesEqual(disc, layout.disc)) continue;
          if (data.length < layout.minLength) continue;
          const rawIdx = data.readBigUInt64LE(layout.leafIndexOffset);
          if (rawIdx > BigInt(Number.MAX_SAFE_INTEGER)) continue;
          const leafIndex = Number(rawIdx);
          if (leafIndex < 0 || leafIndex >= MAX_LEAVES) continue;
          const commitment = leBytes32ToBigint(data, layout.commitmentOffset);
          decoded = { commitment, leafIndex };
          break;
        }
        if (!decoded) continue;
        // Key by leafIndex so competing events for the same position
        // (shouldn't happen, but defensive) don't silently lose data.
        out.set(decoded.commitment.toString(), decoded);
      }
    }

    options.onProgress?.(Math.min(i + batchSize, sigs.length), sigs.length);
  }

  return out;
}

export function bigintToLeBytes32(n: bigint): number[] {
  const bytes: number[] = new Array(32);
  let tmp = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(tmp & 0xFFn);
    tmp >>= 8n;
  }
  return bytes;
}

function bigintToBeBytes32(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let tmp = n;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(tmp & 0xFFn);
    tmp >>= 8n;
  }
  return bytes;
}

export function slotToEpoch(slot: number): bigint {
  return BigInt(Math.floor(slot / SLOTS_PER_EPOCH));
}

// ---------------------------------------------------------------------------
// Commitment & nullifier (Poseidon)
// ---------------------------------------------------------------------------

export function createCommitment(
  nullifierPreimage: bigint,
  secret: bigint,
  depositEpoch: bigint,
  tokenMint: bigint
): bigint {
  return poseidon4([nullifierPreimage, secret, depositEpoch, tokenMint]);
}

export function createNullifier(
  nullifierPreimage: bigint,
  secret: bigint
): bigint {
  return poseidon2([nullifierPreimage, secret]);
}

// ---------------------------------------------------------------------------
// Merkle tree from filledSubtrees
// ---------------------------------------------------------------------------

/**
 * Build the Merkle proof for a historical leaf by rebuilding the full tree
 * from every commitment we can enumerate on-chain. Necessary whenever the
 * target leaf is NOT the rightmost — {@link computeNewRootFromSubtrees}
 * assumes the leaf is the next-to-be-inserted (so siblings come from
 * `filled_subtrees` / zero hashes) and silently returns garbage otherwise,
 * which is exactly how recovered notes broke unshield.
 *
 * Runtime is O(leafCount) hashes; at depth 15 with a fully-pruned chain of
 * ~100 leaves that's trivial. The returned root matches the pool's current
 * on-chain root iff the client's commitment view is up-to-date; callers
 * should still check against the pool's historical roots when there's a
 * race with a concurrent shield.
 */
/**
 * Replay the stale-subtrees insertion pattern from on-chain events to recover
 * the merkle proof for a leaf inserted in the past.
 *
 * Background (the bug):
 *   `insert_with_root` (programs/zk_shielded/src/state/merkle_tree.rs:125) only
 *   persists `filled_subtrees[0] = leaf` after each insertion. Levels 1+ stay at
 *   their initial values (per-level zero hashes set at pool init). So every
 *   shield client computes its `new_root` using stale subtrees at higher levels:
 *   the on-chain "tree" is NOT a real merkle tree of all leaves — it is a sequence
 *   of roots derived from (latest leaf, zero-hash siblings).
 *
 *   A pure rebuild via `buildMerkleProofFromLeaves` produces a "true" merkle root
 *   that is NEVER in the on-chain historical ring → unshield fails after a wipe
 *   when the receipt's stored path is lost.
 *
 * Fix: replay each shield in insertion order using the same stale-subtrees logic
 * that `computeNewRootFromSubtrees` uses (line 1012). For our target leaf, record
 * the path and root that the past inserter computed. This path matches what was
 * accepted on-chain and is a valid input for the STARK proof.
 *
 * Verified against pool HkzArVjU on devnet (2026-05-02): replays all 14 leaves'
 * `new_root` byte-for-byte against the event log. See `scripts/diagnose-merkle-rebuild.mjs`.
 */
export function replayMerkleProofFromEvents(params: {
  leavesByIndex: bigint[];
  targetLeafIndex: number;
}): {
  root: bigint;
  pathElements: bigint[];
  pathIndices: number[];
} {
  const { leavesByIndex, targetLeafIndex } = params;
  const zeros = getZeroHashes();

  // Persisted on-chain state: filled_subtrees[i] starts at zeros[i] (per-level
  // zero hash, matching merkle_tree.rs:65) and only [0] is updated after each
  // insertion (matching merkle_tree.rs:125).
  const onChainSubtrees: bigint[] = zeros.slice(0, MERKLE_DEPTH);

  let recordedPathElements: bigint[] | null = null;
  let recordedPathIndices: number[] | null = null;
  let recordedRoot: bigint | null = null;

  for (let leafIndex = 0; leafIndex < leavesByIndex.length; leafIndex++) {
    const leaf = leavesByIndex[leafIndex];
    if (leaf === ZERO_VALUE) continue; // gap (shouldn't happen on a fully-scanned pool)

    // Replay computeNewRootFromSubtrees logic with the current on-chain state.
    const localSubtrees = [...onChainSubtrees];
    const path: bigint[] = [];
    const indices: number[] = [];
    let current = leaf;
    let idx = leafIndex;

    for (let level = 0; level < MERKLE_DEPTH; level++) {
      const isRight = idx & 1;
      indices.push(isRight);
      if (isRight === 0) {
        path.push(zeros[level]);
        localSubtrees[level] = current;
        current = poseidon2([current, zeros[level]]);
      } else {
        path.push(localSubtrees[level]);
        current = poseidon2([localSubtrees[level], current]);
      }
      idx >>= 1;
    }

    if (leafIndex === targetLeafIndex) {
      recordedPathElements = path;
      recordedPathIndices = indices;
      recordedRoot = current;
    }

    // Mimic insert_with_root: only level 0 persists on-chain
    onChainSubtrees[0] = leaf;
  }

  if (recordedPathElements === null || recordedRoot === null) {
    throw new Error(
      `replayMerkleProofFromEvents: target leafIndex ${targetLeafIndex} not found ` +
      `among ${leavesByIndex.filter((l) => l !== ZERO_VALUE).length} non-empty leaves.`
    );
  }

  return { root: recordedRoot, pathElements: recordedPathElements, pathIndices: recordedPathIndices! };
}

export function buildMerkleProofFromLeaves(params: {
  leavesByIndex: bigint[]; // leavesByIndex[i] = commitment at leafIndex i; gaps filled with ZERO_VALUE
  targetLeafIndex: number;
}): {
  root: bigint;
  pathElements: bigint[];
  pathIndices: number[];
} {
  const { leavesByIndex, targetLeafIndex } = params;
  const zeros = getZeroHashes();

  // Start from leaves padded to an even count per level
  let nodes: bigint[] = leavesByIndex.length > 0 ? [...leavesByIndex] : [zeros[0]];
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let idx = targetLeafIndex;

  for (let level = 0; level < MERKLE_DEPTH; level++) {
    // Record sibling at this level for the target path
    const siblingIdx = idx ^ 1;
    const sibling = siblingIdx < nodes.length ? nodes[siblingIdx] : zeros[level];
    pathElements.push(sibling);
    pathIndices.push(idx & 1);

    // Hash up the whole level so we compute the true root too
    const next: bigint[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i];
      const right = i + 1 < nodes.length ? nodes[i + 1] : zeros[level];
      next.push(poseidon2([left, right]));
    }
    nodes = next.length > 0 ? next : [zeros[level + 1]];
    idx >>= 1;
  }

  return { root: nodes[0], pathElements, pathIndices };
}

/**
 * Fetch every commitment for a pool (bounded by `maxSignatures`) and
 * materialize a dense leaves-by-index array. Gaps (if the scan missed an
 * insertion) are filled with the Merkle zero value so the tree shape is
 * preserved; the returned root will diverge from on-chain in that case and
 * the caller can fall back to an indexer / bump `maxSignatures`.
 */
export async function fetchPoolLeavesByIndex(
  connection: Connection,
  poolPDA: PublicKey,
  opts: {
    maxSignatures?: number;
    onProgress?: (scanned: number, total: number) => void;
    /** Human-readable step line, so the caller can say WHICH path ran. */
    onStep?: (step: string) => void;
    /** The answer must hold at least this many leaves (`leafIndex + 1`). */
    minLeafCount?: number;
    /** Force the indexer to re-read the chain before answering (retry path). */
    fresh?: boolean;
    /** `false` disables the indexer; a string overrides its base URL. */
    indexer?: false | string;
  } = {},
): Promise<{ leavesByIndex: bigint[]; scannedLeafCount: number; missing: number[] }> {
  // ── FAST PATH: one HTTP call to the leaf indexer ────────────────────────
  // Mirrors the web twin (apps/web denominatedPool.ts, same function). The
  // RPC scan below is one `getTransaction` per pool signature, behind this
  // surface's per-call jitter; the indexer answers the same dense array in one
  // request. It is NOT trusted: every caller rebuilds the path and pre-flights
  // the root against the on-chain ring before any proof rent is spent, so a
  // lying indexer can only cause a refused spend.
  if (opts.indexer !== false) {
    const { fetchLeavesFromIndexer, resolvePoolLeavesBaseUrl } = await import('./poolLeavesClient');
    const baseUrl = typeof opts.indexer === 'string' ? opts.indexer : resolvePoolLeavesBaseUrl();
    if (baseUrl) {
      opts.onStep?.('Fetching pool leaves from the indexer...');
      const fast = await fetchLeavesFromIndexer(poolPDA.toBase58(), {
        baseUrl,
        fresh: opts.fresh,
        minLeafCount: opts.minLeafCount,
      });
      if (fast) {
        opts.onStep?.(`Fetched ${fast.scannedLeafCount} leaves from the indexer`);
        opts.onProgress?.(fast.scannedLeafCount, fast.scannedLeafCount);
        return { leavesByIndex: fast.leavesByIndex, scannedLeafCount: fast.scannedLeafCount, missing: fast.missing };
      }
      opts.onStep?.('Indexer unavailable — scanning pool events from RPC...');
    }
  }

  const onChain = await fetchPoolCommitments(connection, poolPDA, {
    maxSignatures: opts.maxSignatures ?? 1000,
    onProgress: opts.onProgress,
  });
  const MAX_LEAVES = 1 << MERKLE_DEPTH;

  // Filter out malformed events (wrong offset, discriminator collision,
  // old program version with a different layout). A bad single event used
  // to nuke the whole rebuild with a RangeError; we now just skip and
  // warn so one corrupt log doesn't block the user.
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
      `[DenomPool] fetchPoolLeavesByIndex: skipped ${skipped} event(s) with invalid leaf_index — ` +
      `likely a decoder drift or a log unrelated to shield events.`
    );
  }

  // `new Array(N)` throws RangeError if N > 2^32-1. MAX_LEAVES is far below
  // that, so the guard above protects callers from noisy data.
  const leavesByIndex: bigint[] = maxIdx >= 0 ? new Array(maxIdx + 1).fill(ZERO_VALUE) : [];
  for (const e of valid) leavesByIndex[e.leafIndex] = e.commitment;
  const missing: number[] = [];
  for (let i = 0; i <= maxIdx; i++) if (leavesByIndex[i] === ZERO_VALUE) missing.push(i);
  return { leavesByIndex, scannedLeafCount: maxIdx + 1, missing };
}

/**
 * Populate a receipt's Merkle path + root in-place if absent. Used by every
 * spend path (unshield / transfer / split / subscribe) — without this,
 * notes reconstructed via `rescanPoolFromSeed` have no path data and the
 * downstream `bigintToLeBytes32(receipt.merkleRoot!)` would serialize
 * `undefined`, producing a malformed instruction that the on-chain program
 * rejects with InvalidMerkleRoot.
 *
 * Rebuilds the proof from the full leaf set (see {@link buildMerkleProofFromLeaves})
 * so it works for any historical leaf, not just the rightmost one.
 */
export async function ensureMerkleProof(
  receipt: ShieldReceipt,
  connection: Connection,
  poolConfig: PoolConfig,
  currentOnChainRoot: Uint8Array,
  onProgress?: (step: string) => void,
): Promise<void> {
  // Happy path 1: the receipt already carries a path AND its stored root
  // matches the pool's CURRENT on-chain root. Skip rebuild.
  let onChainRootBig = 0n;
  for (let i = 31; i >= 0; i--) {
    onChainRootBig = (onChainRootBig << 8n) | BigInt(currentOnChainRoot[i]);
  }
  if (
    receipt.merklePathElements &&
    receipt.merklePathIndices &&
    receipt.merkleRoot === onChainRootBig
  ) return;

  // Happy path 2: the receipt carries a full path AND its stored root is
  // still in the on-chain historical ring (max 100 entries). The on-chain
  // `is_valid_root` check accepts any root in that ring, so the receipt's
  // path is just as valid as the current root's. This avoids the rebuild
  // entirely, which is critical when the RPC's signature index is incomplete
  // (devnet rate-limits, recent shields not yet indexed) — the rebuild path
  // would otherwise fail with "scanned 0 leaves" even though the on-chain
  // tree state is fine.
  const hasFullPath =
    Array.isArray(receipt.merklePathElements) &&
    receipt.merklePathElements.length > 0 &&
    Array.isArray(receipt.merklePathIndices) &&
    receipt.merklePathIndices.length > 0 &&
    receipt.merkleRoot !== undefined &&
    receipt.merkleRoot !== null;

  console.log(
    `[P01_DIAG:ensureMerkleProof] ${JSON.stringify({
      ts: new Date().toISOString(),
      hasFullPath,
      pathElementsLen: Array.isArray(receipt.merklePathElements) ? receipt.merklePathElements.length : null,
      pathIndicesLen: Array.isArray(receipt.merklePathIndices) ? receipt.merklePathIndices.length : null,
      merkleRootDefined: receipt.merkleRoot !== undefined && receipt.merkleRoot !== null,
      receiptRootHex: receipt.merkleRoot !== undefined ? receipt.merkleRoot.toString(16) : null,
      onChainRootHex: onChainRootBig.toString(16),
      rootMatchesCurrent: receipt.merkleRoot === onChainRootBig,
      leafIndex: receipt.leafIndex,
      commitment: receipt.commitment.toString(),
    })}`,
  );

  if (hasFullPath) {
    try {
      const { parsePoolAccount, rootInRing, bigintToLeBytes } = await import('./parsePool');
      const poolAcc = await connection.getAccountInfo(poolConfig.poolPDA);
      if (poolAcc) {
        const parsed = parsePoolAccount(poolAcc.data);
        if (parsed) {
          const receiptRootBytes = bigintToLeBytes(receipt.merkleRoot!);
          const ringPos = rootInRing(receiptRootBytes, parsed.historicalRoots);
          console.log(
            `[P01_DIAG:ringCheck] ${JSON.stringify({
              ts: new Date().toISOString(),
              ringSize: parsed.historicalRoots.length,
              ringPos,
              receiptRootHex: receipt.merkleRoot!.toString(16),
              poolCurrentRootHex: parsed.currentRoot.reduce((s, b) => s + b.toString(16).padStart(2, '0'), '0x'),
            })}`,
          );
          if (ringPos !== null) {
            console.log(
              `[DenomPool] Skipping rebuild — receipt root is at ring position ${ringPos} of ${parsed.historicalRoots.length} (still on-chain valid).`,
            );
            return;
          }
          // Receipt has full path data but root is NOT in ring. This is the
          // case after a long pause or when 100+ shields landed in between.
          // Fall back to rebuild — but if the rebuild also fails (RPC index
          // missing recent shields), we'll still attempt to submit using the
          // receipt's path as a last-resort. See the "trusted-receipt" path
          // below the rebuild.
          console.warn(
            `[DenomPool] receipt root not in ring (size ${parsed.historicalRoots.length}); will attempt rebuild.`,
          );
        } else {
          console.warn('[DenomPool] parsePoolAccount returned null — schema drift?');
        }
      } else {
        console.warn('[DenomPool] pool account fetch returned null in ring check.');
      }
    } catch (e: any) {
      console.warn(`[DenomPool] historical-ring check failed, falling back to rebuild: ${e?.message ?? String(e)}`);
    }
  }

  onProgress?.('Reconstructing Merkle proof from on-chain...');
  const MAX_LEAVES = 1 << MERKLE_DEPTH;

  if (
    !Number.isInteger(receipt.leafIndex) ||
    receipt.leafIndex < 0 ||
    receipt.leafIndex >= MAX_LEAVES
  ) {
    throw new Error(
      `Note leafIndex ${receipt.leafIndex} is out of bounds [0, ${MAX_LEAVES}). ` +
      `The stored note is likely corrupt or belongs to a different tree.`
    );
  }

  const treeAccount = await connection.getAccountInfo(poolConfig.treePDA);
  if (!treeAccount) throw new Error('Merkle tree account not found');
  const { leafCount } = parseFilledSubtrees(treeAccount.data);
  console.log(`[DenomPool] Merkle rebuild: pool tree leafCount=${leafCount}, target leafIndex=${receipt.leafIndex}`);

  if (receipt.leafIndex >= leafCount) {
    throw new Error(
      `Note leafIndex ${receipt.leafIndex} >= tree leafCount ${leafCount}. ` +
      `This note references a leaf that doesn't exist in the current pool — ` +
      `the pool was likely re-deployed (devnet reset) since the note was shielded.`
    );
  }

  // A pool with a long history (many shields + non-shield activity) can
  // overshoot the default 1000-signature window. Pull 10k so historical
  // leaves that would otherwise be treated as ZERO (yielding a bogus root)
  // are actually captured. Bounded by the pool's depth-15 tree capacity.
  const { leavesByIndex, missing } = await fetchPoolLeavesByIndex(connection, poolConfig.poolPDA, {
    maxSignatures: 10000,
    minLeafCount: receipt.leafIndex + 1,
  });
  console.log(`[DenomPool] Merkle rebuild: scanned ${leavesByIndex.length} leaves, ${missing.length} missing`);
  if (missing.length > 0) {
    console.warn(
      `[DenomPool] Merkle rebuild: ${missing.length} leaf(s) missing from scan ` +
      `(indices: ${missing.slice(0, 8).join(',')}${missing.length > 8 ? '…' : ''}). ` +
      `Raise maxSignatures if this persists.`
    );
  }
  while (leavesByIndex.length < leafCount) leavesByIndex.push(0n);

  if (leavesByIndex[receipt.leafIndex] !== receipt.commitment) {
    throw new Error(
      `Merkle rebuild mismatch at leafIndex ${receipt.leafIndex}: ` +
      `scanned commitment ≠ receipt commitment. Rescan the pool or bump maxSignatures.`
    );
  }

  // Use replay (not pure rebuild) — the on-chain tree is not a real merkle tree
  // due to insert_with_root only persisting level 0. See replayMerkleProofFromEvents
  // docstring for full background.
  const { root: computedRoot, pathElements, pathIndices } = replayMerkleProofFromEvents({
    leavesByIndex,
    targetLeafIndex: receipt.leafIndex,
  });

  if (computedRoot !== onChainRootBig) {
    // Divergence between our local rebuild and the on-chain CURRENT root.
    // Three possible causes:
    //   (a) a concurrent shield landed between our currentRoot fetch and the
    //       leaf scan -> tree state advanced
    //   (b) the scan missed a leaf or wrote it at the wrong index
    //   (c) the on-chain Poseidon ZERO_VALUE differs from ours
    //
    // The on-chain `is_valid_root` check accepts ANY root in the pool's
    // historical ring (max 100 entries). So if our computed root happens to
    // match a historical root, the tx will still pass. Verify before
    // submitting — if it's NOT in the ring, throw early so the caller does
    // not waste ~0.85 SOL of proof-buffer rent on a guaranteed-failed tx.
    console.warn(
      `[DenomPool] Merkle rebuild root ≠ on-chain current root. ` +
      `computed=${computedRoot.toString(16)} onChain=${onChainRootBig.toString(16)}. ` +
      `Checking historical ring before submitting.`
    );

    let computedInRing = false;
    let ringPos: number | null = null;
    let ringSize = 0;
    try {
      const { parsePoolAccount, rootInRing, bigintToLeBytes } = await import('./parsePool');
      const poolAcc = await connection.getAccountInfo(poolConfig.poolPDA);
      if (poolAcc) {
        const parsed = parsePoolAccount(poolAcc.data);
        if (parsed) {
          ringSize = parsed.historicalRoots.length;
          const computedBytes = bigintToLeBytes(computedRoot);
          ringPos = rootInRing(computedBytes, parsed.historicalRoots);
          computedInRing = ringPos !== null;
        }
      }
    } catch (e: any) {
      console.warn(`[DenomPool] ring lookup after rebuild failed: ${e?.message ?? String(e)}`);
    }

    console.log(
      `[P01_DIAG:rebuildDrift] ` +
      JSON.stringify({
        timestamp: new Date().toISOString(),
        poolPDA: poolConfig.poolPDA.toBase58(),
        leafIndex: receipt.leafIndex,
        leafCount,
        scannedLeaves: leavesByIndex.length,
        missingLeaves: missing.length,
        firstMissing: missing.slice(0, 8),
        computedRoot: '0x' + computedRoot.toString(16).padStart(64, '0'),
        onChainRoot: '0x' + onChainRootBig.toString(16).padStart(64, '0'),
        computedInRing,
        ringPos,
        ringSize,
      })
    );

    if (!computedInRing) {
      throw new Error(
        `Merkle rebuild produced a root that is not in the on-chain historical ` +
        `ring (size ${ringSize}). Submitting would waste ~0.85 SOL of proof-buffer ` +
        `rent on a guaranteed InvalidMerkleRoot rejection. Likely cause: ` +
        `concurrent shield landed during proof generation, or scan returned ` +
        `wrong leaf positions. Retry shortly — if it persists, the tree may have ` +
        `advanced past the recoverable historical window for this receipt.`
      );
    }
    console.log(
      `[DenomPool] Computed root is in historical ring at position ${ringPos}/${ringSize} — proceeding with submission.`,
    );
  }
  receipt.merkleRoot = computedRoot;
  receipt.merklePathElements = pathElements;
  receipt.merklePathIndices = pathIndices;
}

export function computeNewRootFromSubtrees(
  leaf: bigint,
  leafIndex: number,
  filledSubtrees: bigint[]
): {
  newRoot: bigint;
  updatedSubtrees: bigint[];
  pathElements: bigint[];
  pathIndices: number[];
} {
  const zeros = getZeroHashes();
  const subtrees = [...filledSubtrees];
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
      current = poseidon2([current, zeros[level]]);
    } else {
      pathElements.push(subtrees[level]);
      current = poseidon2([subtrees[level], current]);
    }

    idx >>= 1;
  }

  return { newRoot: current, updatedSubtrees: subtrees, pathElements, pathIndices };
}

// ---------------------------------------------------------------------------
// On-chain reads
// ---------------------------------------------------------------------------

export async function fetchPoolInfo(
  connection: Connection,
  poolConfig: PoolConfig
): Promise<PoolOnChainInfo | null> {
  const account = await connection.getAccountInfo(poolConfig.poolPDA);
  if (!account) return null;

  const data = account.data;
  // DenominatedPool account layout (Anchor / Borsh):
  //   8    discriminator
  //   32   authority
  //   32   token_mint
  //   8    denomination
  //   8    epoch_delay
  //   32   merkle_root
  //   1    tree_depth
  //   8    next_leaf_index
  //   32   vk_hash
  //   8    total_shielded
  //   8    note_count
  //   1    is_active
  //   4+N  historical_roots (Vec<[u8;32]>)
  //   1    max_historical_roots
  //   8    created_at
  //   8    last_tx_at
  //   1    bump
  //   8    mature_note_count
  //   8    last_maturity_update_epoch
  //   256  epoch_note_counts ([u64; 32])
  //   8    epoch_note_start
  let offset = 8; // skip discriminator
  offset += 32; // authority
  offset += 32; // token_mint
  offset += 8;  // denomination
  const epochDelay = data.readBigUInt64LE(offset); offset += 8;
  const currentRoot = data.slice(offset, offset + 32); offset += 32; // merkle_root
  offset += 1;  // tree_depth
  const nextLeafIndex = Number(data.readBigUInt64LE(offset)); offset += 8;
  offset += 32; // vk_hash
  const totalShielded = data.readBigUInt64LE(offset); offset += 8;
  const noteCount = Number(data.readBigUInt64LE(offset)); offset += 8;
  const isActive = data[offset] === 1; offset += 1;
  // Skip historical_roots Vec: 4 bytes length + N * 32 bytes
  const histRootsLen = data.readUInt32LE(offset); offset += 4;
  offset += histRootsLen * 32;
  offset += 1;  // max_historical_roots
  offset += 8;  // created_at
  offset += 8;  // last_tx_at
  offset += 1;  // bump
  // Dynamic delay fields
  const matureNoteCount = Number(data.readBigUInt64LE(offset)); offset += 8;
  offset += 8;  // last_maturity_update_epoch
  offset += 256; // epoch_note_counts ([u64; 32] = 8*32)
  // epoch_note_start (not needed for dynamic delay)

  // Compute dynamic delay from mature_note_count (same logic as on-chain)
  let dynamicDelay: number;
  if (matureNoteCount >= 1000) dynamicDelay = 0;
  else if (matureNoteCount >= 100) dynamicDelay = 1;
  else if (matureNoteCount >= 10) dynamicDelay = 1;
  else dynamicDelay = 2;

  return {
    isActive,
    noteCount,
    nextLeafIndex,
    totalShielded,
    epochDelay,
    matureNoteCount,
    dynamicDelay,
    currentRoot,
  };
}

export function parseFilledSubtrees(treeData: Buffer): { leafCount: number; subtrees: bigint[] } {
  const leafCount = Number(treeData.readBigUInt64LE(8 + 32 + 32));
  const depth = treeData[8 + 32 + 32 + 8];
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
// Anchor instruction builders
// ---------------------------------------------------------------------------

function getDiscriminator(name: string): Buffer {
  const hash = sha256(utf8ToBytes(`global:${name}`));
  return Buffer.from(hash.slice(0, 8));
}

function buildShieldDenominatedIx(
  depositor: PublicKey,
  poolPDA: PublicKey,
  treePDA: PublicKey,
  commitment: number[],
  newRoot: number[],
  tokenProgram?: PublicKey,
  userTokenAccount?: PublicKey,
  poolVault?: PublicKey
): TransactionInstruction {
  const disc = getDiscriminator('shield_denominated');
  const data = Buffer.alloc(8 + 32 + 32);
  disc.copy(data, 0);
  Buffer.from(commitment).copy(data, 8);
  Buffer.from(newRoot).copy(data, 40);

  const keys = [
    { pubkey: depositor, isSigner: true, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: treePDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // Optional accounts — program ID as "None" sentinel for Anchor 0.32
    { pubkey: tokenProgram || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: userTokenAccount || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!userTokenAccount },
    { pubkey: poolVault || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!poolVault },
    // Protocol fee wallet (0.3% shield fee)
    { pubkey: PROTOCOL_FEE_WALLET, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

// ---------------------------------------------------------------------------
// VK data PDA derivation
// ---------------------------------------------------------------------------

function deriveShieldedPoolPDA(tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('shielded_pool'), tokenMint.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
}

function deriveVkDataPDA(shieldedPoolKey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vk_data'), shieldedPoolKey.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
}

function deriveTransferVkDataPDA(shieldedPoolKey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vk_data_transfer'), shieldedPoolKey.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
}

/** Get the unshield VK data PDA for a given token mint (via ShieldedPool PDA) */
function getVkDataPDAForMint(tokenMint: PublicKey): PublicKey {
  const [shieldedPoolPDA] = deriveShieldedPoolPDA(tokenMint);
  const [vkDataPDA] = deriveVkDataPDA(shieldedPoolPDA);
  return vkDataPDA;
}

/** Get the transfer VK data PDA (uses SOL ShieldedPool — same VK for all pools) */
function getTransferVkDataPDA(): PublicKey {
  const [shieldedPoolPDA] = deriveShieldedPoolPDA(NATIVE_SOL_MINT);
  const [vkDataPDA] = deriveTransferVkDataPDA(shieldedPoolPDA);
  return vkDataPDA;
}

// ---------------------------------------------------------------------------
// Nullifier PDA
// ---------------------------------------------------------------------------

export function deriveNullifierPDA(poolKey: PublicKey, nullifierBytes: Uint8Array | number[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('nullifier'), poolKey.toBuffer(), Buffer.from(nullifierBytes)],
    ZK_SHIELDED_PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Wallet signer abstraction (local keypair only)
// ---------------------------------------------------------------------------

export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  // NOTE(Phase3-External): `signMessage?` was removed with the Privy
  // note-seed ceremony below. The external/software-wallet identity path
  // (which re-introduces off-chain message signing for HKDF derivation)
  // returns in Phase 3 via the SDK `deriveP01Identity`, not here.
}

// ───────────────────────────────────────────────────────────────────────────
// DATA-LOSS NOTICE — Privy removal (spec §3 Phase 1, R-09 / R-12)
// ───────────────────────────────────────────────────────────────────────────
// The Privy-wallet "note seed" derivation+persistence machinery that lived here
// (NOTE_SEED_DOMAIN, noteSeedCache, persistNoteSeed, getPersistedNoteSeed,
// deriveSeedFromSigner, getCachedNoteSeed, clearNoteSeedCache, and the
// `p01_note_seed_v1_*` SecureStore keys) HAS BEEN DELETED.
//
// This ORPHANS one of the four accepted seed classes from the spec:
//   (a) mobile `p01_note_seed_v1_*`   ← THIS ONE
//   (b) mobile `p01_zk_seed`          (see services/zkspl + services/stark)
//   (c) extension `p01_privy_zk_seed`
//   (d) extension `p01_zkspl_privy_seed_*`
//
// Any denominated-pool notes that were shielded by a former Privy wallet under a
// signMessage-derived seed are NO LONGER RECOVERABLE on this build (the local
// keypair gold path uses `secretKey.slice(0,32)`, a different seed). This is an
// ACCEPTED, surfaced data loss — NOT a silent drop. The user-facing one-time
// warning is wired via the shared data-loss flag in
// `services/privacy/privyDataLoss.ts` (hasAcknowledgedPrivyDataLoss / ack).
// TODO(Phase5-UI): surface a full in-app data-loss / re-onboard screen.

/**
 * Derive output-note secrets for a split, transitively recoverable from the
 * parent note. If a user recovers the parent note via {@link rescanPoolFromSeed},
 * they can also reconstruct every child split that was ever produced from it,
 * because each child secret is `poseidon2(parentSecret, index)`.
 *
 * Use this for any caller of `splitNoteStark` instead of `randomFieldElement()`.
 */
export function deriveSplitOutputSecrets(parentSecret: bigint, count: number): bigint[] {
  const secrets: bigint[] = new Array(count);
  for (let i = 0; i < count; i++) {
    secrets[i] = poseidon2([parentSecret, BigInt(i)]);
  }
  return secrets;
}

/**
 * Sign and send a transaction, handling both local keypair and Privy signer.
 */
async function signAndSend(
  connection: Connection,
  tx: Transaction,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
): Promise<string> {
  // [PERF 2026-09-06] One `confirmed` blockhash, preflight kept (a singleton
  // pool transaction is worth one simulation), and an HTTP status poll every
  // 400 ms instead of `confirmTransaction` / `sendAndConfirmTransaction`,
  // whose WebSocket path has a fixed 60 s timeout and was observed not to
  // fire on this surface (docs/MOBILE_PROVER_LATENCY.md §5).
  const { confirmSignatureFast } = await import('../stark');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  let signed: Transaction;
  if (keypair) {
    tx.feePayer = keypair.publicKey;
    tx.sign(keypair);
    signed = tx;
  } else if (walletSigner) {
    tx.feePayer = walletSigner.publicKey;
    signed = await walletSigner.signTransaction(tx);
  } else {
    throw new Error('No wallet available for signing');
  }
  const sig = await connection.sendRawTransaction(signed.serialize({ verifySignatures: false }));
  await confirmSignatureFast(connection, sig, { lastValidBlockHeight });
  return sig;
}

/**
 * V3 wrapper around `signAndSend` that routes through `p01_relayer` when
 * the `relayerV3Enabled` user setting is on.
 *
 * Privacy: hides the user's RPC submission IP (L19) and the outer fee_payer
 * of the relay-job tx. Inner shield/unshield/transfer ix signers are
 * untouched (closing those leaks needs Phase A.5 / Phase B / Phase D).
 *
 * Failure mode (Phase A revised): the relayer node infrastructure is still
 * young (one hosted node on Railway). Hard-failing the user's UX every time
 * the relayer hiccups is worse than a temporary privacy degradation, so any
 * relayer error → fall back to direct submission with a loud console warn.
 * The toggle stays effective (off skips the relayer entirely); when it's on
 * we *try* the relayer first, then degrade. Re-tighten this once we have N≥3
 * geo-distributed nodes and uptime metrics.
 */
export async function signAndSendV3(
  connection: Connection,
  tx: Transaction,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
): Promise<string> {
  // Lazy import to avoid pulling zustand into modules that don't need it.
  const { useSettingsStore } = await import('../../stores/settingsStore');
  const enabled = useSettingsStore.getState().relayerV3Enabled;
  console.log('[V3-Relay] signAndSendV3: relayerV3Enabled=' + enabled);
  if (!enabled) {
    console.log('[V3-Relay] → direct signAndSend (toggle OFF)');
    return await signAndSend(connection, tx, keypair, walletSigner);
  }
  console.log('[V3-Relay] → routing through p01_relayer wrapper');
  const { signAndSendViaRelayer, OversizedInnerTxError } =
    await import('../privacy/v3RelayerWrapper');
  try {
    return await signAndSendViaRelayer(connection, tx, keypair, walletSigner);
  } catch (e) {
    const isOversized = e instanceof OversizedInnerTxError;
    const reason = isOversized
      ? `oversized inner tx (${e.innerTxBytes}B > ${e.budgetBytes}B)`
      : `relayer error: ${(e as Error)?.message ?? String(e)}`;

    // OversizedInnerTxError is a STRUCTURAL limitation, not a privacy/availability
    // failure — the inner tx is bigger than the v1 envelope can carry, so we
    // MUST send direct (no relayer can encrypt this). strictMode does not apply
    // here; the user has no privacy choice. Document the leak transparently in
    // the warning. Phase A.3 (chunked submit_job + v2 hybrid envelope) will
    // remove this hard constraint.
    if (!isOversized) {
      const strict = useSettingsStore.getState().relayerStrictMode;
      if (strict) {
        console.warn(
          '[V3-Relay] ' + reason + ' — STRICT mode: failing closed (no IP leak fallback)',
        );
        const err = new Error(
          'Relay unavailable — strict privacy mode prevented direct fallback. ' +
            'Retry later or disable strict mode in Privacy settings to allow direct submission. ' +
            `Underlying: ${reason}`,
        );
        (err as Error & { code?: string }).code = 'RELAYER_STRICT_FAILCLOSED';
        throw err;
      }
    }

    console.warn(
      '[V3-Relay] ' + reason + ' — falling back to direct signAndSend (RPC IP exposed for this tx)',
    );
    // Re-build a fresh blockhash + reset signatures: the inner tx may have
    // been signed for the relayer envelope, but a direct submission needs
    // its own clean state. Easiest = reset and let signAndSend re-sign.
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.signatures = [];
    return await signAndSend(connection, tx, keypair, walletSigner);
  }
}

// ---------------------------------------------------------------------------
// Shield (deposit)
// ---------------------------------------------------------------------------

export async function shield(
  poolConfig: PoolConfig,
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
  overrideKeypair?: import('@solana/web3.js').Keypair,
  deterministic?: { walletSeed: Uint8Array; counter: number },
): Promise<ShieldReceipt> {
  onProgress?.('Reading wallet...');
  const keypair = overrideKeypair || (walletSigner ? null : await getKeypair());
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();
  onProgress?.('Reading pool state...');

  // Read on-chain Merkle tree
  const treeAccount = await connection.getAccountInfo(poolConfig.treePDA);
  if (!treeAccount) {
    throw new Error('Merkle tree account not found');
  }

  const { leafCount, subtrees } = parseFilledSubtrees(treeAccount.data);

  // Get current epoch
  const slot = await connection.getSlot('confirmed');
  const depositEpoch = slotToEpoch(slot);
  const tokenMintField = pubkeyToField(poolConfig.tokenMint);

  onProgress?.('Computing commitment...');
  const { secret, nullifierPreimage } = deterministic
    ? deriveNoteMaterial(deterministic.walletSeed, poolConfig.poolPDA, deterministic.counter)
    : { secret: randomFieldElement(), nullifierPreimage: randomFieldElement() };

  const commitment = createCommitment(nullifierPreimage, secret, depositEpoch, tokenMintField);

  const { newRoot, pathElements, pathIndices } = computeNewRootFromSubtrees(
    commitment, leafCount, subtrees
  );

  const commitmentBytes = bigintToLeBytes32(commitment);
  const newRootBytes = bigintToLeBytes32(newRoot);

  onProgress?.('Building transaction...');

  // For USDC: pass token program, user ATA, pool vault
  let tokenProgram: PublicKey | undefined;
  let userTokenAccount: PublicKey | undefined;
  let poolVault: PublicKey | undefined;

  const isNativeSOL = poolConfig.tokenMint.equals(NATIVE_SOL_MINT);
  if (!isNativeSOL) {
    tokenProgram = TOKEN_PROGRAM_ID;
    userTokenAccount = await getAssociatedTokenAddress(poolConfig.tokenMint, walletPubkey);
    poolVault = poolConfig.vaultATA;
  }

  const ix = buildShieldDenominatedIx(
    walletPubkey,
    poolConfig.poolPDA,
    poolConfig.treePDA,
    commitmentBytes,
    newRootBytes,
    tokenProgram,
    userTokenAccount,
    poolVault
  );

  onProgress?.('Sending transaction...');
  const tx = new Transaction();

  // For SPL pools, ensure user ATA exists (idempotent — no-op if present)
  if (!isNativeSOL && userTokenAccount) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        walletPubkey,       // payer
        userTokenAccount,   // ATA address
        walletPubkey,       // owner
        poolConfig.tokenMint
      )
    );
  }

  tx.add(ix);

  // The shield TX goes through direct submit — the wallet link is broken by
  // using stealth intermediaries in the Privacy Router flow.
  let sig: string;
  console.log('[DenomPool] Shield TX submitting...');
  sig = await signAndSend(connection, tx, keypair, walletSigner);
  console.log(`[DenomPool] Shield TX confirmed: ${sig.slice(0, 20)}...`);

  onProgress?.('Done!');

  const receipt: ShieldReceipt = {
    secret,
    nullifierPreimage,
    depositEpoch,
    tokenMint: tokenMintField,
    commitment,
    leafIndex: leafCount,
    denomination: poolConfig.denominationAtomic,
    pool: poolConfig.poolPDA.toBase58(),
    token: poolConfig.token,
    denominationHuman: poolConfig.denomination,
    shieldedAt: Date.now(),
    merklePathElements: pathElements,
    merklePathIndices: pathIndices,
    merkleRoot: newRoot,
  };

  return receipt;
}

// ---------------------------------------------------------------------------
// STARK Unshield (quantum-resistant)
// ---------------------------------------------------------------------------

/**
 * The ONLY value this client ever publishes in the `min_epoch` argument of an
 * unshield instruction — v2 (`unshield_denominated_stark`), v3
 * (`unshield_denominated_stark_v3`) and the p01_liquidity `prefund` record
 * alike. It lands at byte offset 72 of `ix.data` on every one of them, the
 * same offset the web client uses.
 *
 * Why a constant:
 *
 *  - It is dead on-chain on the unshield path. v3 consumes it as
 *    `let _ = (amount, unshield_fee, min_epoch, current_epoch, dynamic_delay,
 *    nullifier);` (unshield_denominated_stark_v3.rs:387) and v2 explicitly
 *    stopped enforcing it (unshield_denominated_stark.rs:212-220). p01_liquidity
 *    only stores it on the PrefundRecord (prefund.rs:197) and `settle` rebuilds
 *    the CPI with its own `current_epoch` (settle.rs:109-116), so nothing reads
 *    the stored value either.
 *  - Anything note-derived in this slot narrows the anonymity set. This client
 *    was writing the *current* epoch, which is already public from the block
 *    slot, so nothing leaked yet — but the extension was writing the note's
 *    DEPOSIT epoch, and any client that adopts the PRF commitment blinding
 *    shipped in apps/web (apps/web/lib/privacy/pool/noteBlinding.ts) would end
 *    up publishing a 63-bit SECRET here. Pinning to zero makes that class of
 *    regression impossible.
 *  - Uniformity across clients. web, extension and mobile now all write the
 *    same eight zero bytes, so the field cannot fingerprint the client.
 *
 * See docs/C7_SPEND_CIRCUIT_PLAN.md Step 1.
 *
 * NOT safe to reuse for transfer/split/subscribe/escrow: `min_epoch` IS
 * enforced on those handlers (e.g. `transfer_denominated_stark_v3.rs:167-173`
 * `require!(current_epoch >= min_epoch + dynamic_delay, EpochDelayNotMet)`).
 * This constant is for the unshield path only.
 *
 * Do not turn this back into a builder parameter. Both unshield builders write
 * it inline precisely so that no call site can reintroduce a note-derived
 * value.
 */
export const UNSHIELD_MIN_EPOCH = 0n;

/**
 * Build unshield_denominated_stark instruction.
 * No Groth16 proof — instead references a pre-verified STARK proof buffer.
 */
export function buildUnshieldDenominatedStarkIx(
  payer: PublicKey,
  recipient: PublicKey,
  poolPDA: PublicKey,
  treePDA: PublicKey,
  nullifierPDA: PublicKey,
  starkProofBuffer: PublicKey,
  nullifierBytes: number[],
  merkleRootBytes: number[],
  starkCommitment: bigint,
  tokenProgram?: PublicKey,
  poolVault?: PublicKey,
  recipientTokenAccount?: PublicKey
): TransactionInstruction {
  const disc = getDiscriminator('unshield_denominated_stark');

  // On-chain args: nullifier: [u8;32], merkle_root: [u8;32], min_epoch: u64, stark_commitment: u64
  const data = Buffer.alloc(8 + 32 + 32 + 8 + 8);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(nullifierBytes).copy(data, offset); offset += 32;
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;
  // min_epoch @ byte 72 — pinned to 0 on every path. See UNSHIELD_MIN_EPOCH.
  data.writeBigUInt64LE(UNSHIELD_MIN_EPOCH, offset); offset += 8;
  data.writeBigUInt64LE(starkCommitment, offset);

  // Account ordering must match on-chain UnshieldDenominatedStark struct:
  // payer, recipient, denominated_pool, merkle_tree, nullifier_record,
  // stark_proof_buffer, system_program, token_program?, pool_vault?,
  // recipient_token_account?, protocol_fee_wallet, prefund_record?
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: treePDA, isSigner: false, isWritable: false },
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },
    { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // Optional accounts (program ID as None sentinel for Anchor 0.32)
    { pubkey: tokenProgram || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: poolVault || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!poolVault },
    { pubkey: recipientTokenAccount || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!recipientTokenAccount },
    // Protocol fee wallet (0.5% unshield fee)
    { pubkey: PROTOCOL_FEE_WALLET, isSigner: false, isWritable: true },
    // Optional prefund_record — always None for user-driven unshield (prefund is used by p01_liquidity::settle only)
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Unshield from a denominated pool using STARK proof (quantum-resistant).
 *
 * Flow:
 * 1. Generate pool_commitment STARK proof (on-device via WASM WebView)
 * 2. Submit + verify STARK proof on-chain (init → upload → verify)
 * 3. Call unshield_denominated_stark instruction (reads verified proof buffer)
 * 4. Close proof buffer (recover rent)
 */
export async function unshieldStark(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  recipient: PublicKey,
  starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
  emergency?: boolean,
  overrideKeypair?: import('@solana/web3.js').Keypair,
  instant?: boolean,
): Promise<string> {
  const { submitAndVerifyStarkProof, closeStarkProofBuffer, CIRCUIT_POOL_COMMITMENT, getProofBufferPDA } = await import('../stark');

  onProgress?.('Reading wallet...');
  const keypair = overrideKeypair || (walletSigner ? null : await getKeypair());
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  onProgress?.(emergency ? 'Preparing emergency unshield...' : 'Checking note maturity...');
  const slot = await connection.getSlot('confirmed');
  const currentEpoch = slotToEpoch(slot);

  const poolInfo = await fetchPoolInfo(connection, poolConfig);
  if (!poolInfo) throw new Error('Pool not found');

  // Reconstruct Merkle proof if missing (see ensureMerkleProof).
  await ensureMerkleProof(receipt, connection, poolConfig, poolInfo.currentRoot, onProgress);

  // For STARK unshield: use the Goldilocks nullifier from the STARK proof (publicInputs[0]).
  // The on-chain hash check extracts u64 from nullifier[..8] and compares against the
  // STARK proof's stored public inputs hash (blake3 of Goldilocks public inputs).
  // We place the Goldilocks u64 nullifier in bytes 0-7 of the 32-byte nullifier arg.
  const goldilocksNullifier = starkProofData.publicInputs[0] ?? 0n;
  const nullifierBytes: number[] = new Array(32).fill(0);
  let _nv = goldilocksNullifier;
  for (let i = 0; i < 8; i++) {
    nullifierBytes[i] = Number(_nv & 0xFFn);
    _nv >>= 8n;
  }
  const merkleRootBytes = bigintToLeBytes32(receipt.merkleRoot!);
  // min_epoch is ALWAYS 0 on the unshield path — never the current epoch and
  // never the note's deposit epoch. See the UNSHIELD_MIN_EPOCH doc comment.
  // zk_shielded stopped enforcing it (unshield_denominated_stark.rs:212-220),
  // and p01_liquidity only records it (prefund.rs:197) — settle rebuilds the
  // CPI with its own current_epoch (settle.rs:109-116). Mature, emergency and
  // prefund paths therefore stay byte-identical to each other AND to the web
  // and extension clients.
  void emergency;
  void poolInfo;
  void currentEpoch;
  // The v2 unshield builder pins min_epoch itself; the p01_liquidity prefund
  // record below still takes it as an argument, so name it explicitly here.
  const minEpoch = UNSHIELD_MIN_EPOCH;

  // Step 1: Submit + verify STARK proof on-chain (buffer stays open)
  // Use stealth keypair if available (overrideKeypair), otherwise walletSigner
  onProgress?.('Submitting STARK proof on-chain...');
  // Build a WalletSigner wrapper from the stealth keypair so ALL downstream
  // functions (submitAndVerifyStarkProof, closeStarkProofBuffer, signAndSend)
  // can use it without needing their own keypair/getKeypair() logic.
  const starkSigner: WalletSigner = keypair
    ? { publicKey: keypair.publicKey, signTransaction: async (tx: Transaction) => { tx.sign(keypair); return tx; } }
    : walletSigner!;
  console.log(`[DenomPool] STARK signer: stealth=${!!keypair} pubkey=${starkSigner.publicKey.toBase58().slice(0,12)}...`);
  // Log balance of the signer before STARK operations
  try {
    const signerBal = await connection.getBalance(starkSigner.publicKey);
    console.log(`[DenomPool] Signer balance: ${signerBal / 1e9} SOL`);
  } catch {}

  // IMPORTANT: Also override walletSigner for the rest of this function
  // so signAndSend and closeProofBuffer use the stealth keypair too
  const effectiveWalletSigner = starkSigner;
  const effectiveKeypair = null; // Force walletSigner path in signAndSend

  // Derive proof buffer PDA upfront so finally block can close it even if submit throws mid-flight.
  const [proofBuffer] = getProofBufferPDA(starkSigner.publicKey, CIRCUIT_POOL_COMMITMENT);

  // Always close buffer on exit (success or failure) — stealth signer is lost after return.
  try {
    await submitAndVerifyStarkProof(
      {
        proofBytes: starkProofData.proofBytes,
        circuitId: CIRCUIT_POOL_COMMITMENT,
        publicInputs: starkProofData.publicInputs,
        proofSize: starkProofData.proofSize,
      },
      starkSigner,
      onProgress,
      connection,
    );

    // Step 2a: Instant path — route through p01_liquidity.prefund. The STARK
    // proof buffer remains open; settle() (keeper or later UI action) will
    // consume it via CPI into zk_shielded.unshield_denominated_stark.
    if (instant) {
      onProgress?.('Requesting instant liquidity prefund...');
      const { buildPrefundIx } = await import('../liquidity');
      const starkCommitmentForPrefund = starkProofData.publicInputs[1] ?? 0n;
      const prefundIx = buildPrefundIx({
        ephemeralSigner: starkSigner.publicKey,
        recipient,
        denominatedPool: poolConfig.poolPDA,
        starkProofBuffer: proofBuffer,
        nullifier: nullifierBytes,
        merkleRoot: merkleRootBytes,
        minEpoch,
        starkCommitment: starkCommitmentForPrefund,
        amount: poolConfig.denominationAtomic,
      });

      const prefundTx = new Transaction();
      prefundTx.add(...buildComputeBudgetIxs(200_000));
      prefundTx.add(prefundIx);

      onProgress?.('Sending prefund transaction...');
      const prefundSig = await signAndSend(connection, prefundTx, effectiveKeypair, effectiveWalletSigner);
      onProgress?.('Prefunded!');
      // Do NOT close the proof buffer — settle() needs it. Caller should
      // surface the ephemeral signer + buffer PDA if they want to reclaim
      // rent after settlement.
      return prefundSig;
    }

    // Step 2b: Classic unshield — direct CPI-free call into zk_shielded.
    onProgress?.('Building unshield transaction...');
    const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);

    const isNativeSOL = poolConfig.tokenMint.equals(NATIVE_SOL_MINT);
    let tokenProgram: PublicKey | undefined;
    let recipientTokenAccount: PublicKey | undefined;
    let poolVault: PublicKey | undefined;

    if (!isNativeSOL) {
      tokenProgram = TOKEN_PROGRAM_ID;
      recipientTokenAccount = await getAssociatedTokenAddress(poolConfig.tokenMint, recipient);
      poolVault = poolConfig.vaultATA;
    }

    // Extract STARK commitment (second public input from the proof)
    const starkCommitment = starkProofData.publicInputs[1] ?? 0n;

    const ix = buildUnshieldDenominatedStarkIx(
      walletPubkey,
      recipient,
      poolConfig.poolPDA,
      poolConfig.treePDA,
      nullifierPDA,
      proofBuffer,
      Array.from(nullifierBytes),
      merkleRootBytes,
      starkCommitment,
      tokenProgram,
      poolVault,
      recipientTokenAccount
    );

    onProgress?.('Sending unshield transaction...');
    const tx = new Transaction();
    tx.add(...buildComputeBudgetIxs(300_000));

    // For SPL pools, ensure recipient ATA exists (idempotent — no-op if present)
    if (!isNativeSOL && recipientTokenAccount) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          walletPubkey,            // payer (the STARK payer covers ATA rent)
          recipientTokenAccount,   // ATA address
          recipient,               // owner
          poolConfig.tokenMint
        )
      );
    }

    tx.add(ix);

    // Simulate first to catch errors with detailed logs
    try {
      const { blockhash: simBh } = await connection.getLatestBlockhash();
      const simTx = new Transaction();
      simTx.add(...buildComputeBudgetIxs(300_000));
      simTx.add(ix);
      simTx.recentBlockhash = simBh;
      simTx.feePayer = effectiveWalletSigner?.publicKey || walletPubkey;
      const simResult = await connection.simulateTransaction(simTx);
      if (simResult.value.err) {
        console.error(`[DenomPool] Simulation FAILED:`, JSON.stringify(simResult.value.err));
        console.error(`[DenomPool] Simulation logs:`, simResult.value.logs?.join('\n'));
        const signerBal = await connection.getBalance(effectiveWalletSigner?.publicKey || walletPubkey);
        console.error(`[DenomPool] Signer balance at failure: ${signerBal / 1e9} SOL`);
        // Auto-diagnose: read-only scan of every state dimension that could
        // explain the failure. Output is one JSON line tagged [P01_DIAG] so it
        // is grep-able via `adb logcat -s ReactNativeJS | grep P01_DIAG`.
        try {
          const { diagnoseSpend, logDiagnostic } = await import('./diagnoseSpend');
          const report = await diagnoseSpend(receipt, connection, poolConfig, simResult);
          logDiagnostic(report, 'unshieldStark');
        } catch (diagErr: any) {
          console.error('[P01_DIAG:unshieldStark] diagnostic itself failed:', diagErr?.message ?? String(diagErr));
        }
      } else {
        console.log(`[DenomPool] Simulation OK — CU used: ${simResult.value.unitsConsumed}`);
      }
    } catch (simErr: any) {
      console.warn(`[DenomPool] Simulation error (non-fatal):`, simErr.message?.slice(0, 100));
    }

    const sig = await signAndSend(connection, tx, effectiveKeypair, effectiveWalletSigner);
    onProgress?.('Done!');
    return sig;
  } finally {
    // Close proof buffer EXCEPT on the instant path, where settle() still
    // needs to read it via CPI. Classic/emergency paths always close —
    // refunds ~0.08-0.85 SOL rent to the signer.
    if (!instant) {
      try {
        onProgress?.('Closing proof buffer...');
        await closeStarkProofBuffer(proofBuffer, effectiveWalletSigner, connection);
      } catch (closeErr: any) {
        console.warn('[DenomPool] closeStarkProofBuffer failed (rent may be stranded):', closeErr.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// STARK Transfer Note (peer-to-peer, quantum-resistant)
// ---------------------------------------------------------------------------

/**
 * Build transfer_denominated_stark instruction.
 * Consumes a pre-verified STARK proof buffer (circuit 1: pool_commitment).
 * new_commitment is authenticated by the payer signature on instruction data.
 */
function buildTransferDenominatedStarkIx(
  payer: PublicKey,
  poolPDA: PublicKey,
  treePDA: PublicKey,
  nullifierPDA: PublicKey,
  starkProofBuffer: PublicKey,
  nullifierBytes: number[],
  merkleRootBytes: number[],
  minEpoch: bigint,
  starkCommitment: bigint,
  newCommitmentBytes: number[],
  newRootBytes: number[],
): TransactionInstruction {
  const disc = getDiscriminator('transfer_denominated_stark');

  // Args: nullifier[32] + merkle_root[32] + min_epoch(u64) + stark_commitment(u64)
  //       + new_commitment[32] + new_root[32]
  const data = Buffer.alloc(8 + 32 + 32 + 8 + 8 + 32 + 32);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(nullifierBytes).copy(data, offset); offset += 32;
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(minEpoch, offset); offset += 8;
  data.writeBigUInt64LE(starkCommitment, offset); offset += 8;
  Buffer.from(newCommitmentBytes).copy(data, offset); offset += 32;
  Buffer.from(newRootBytes).copy(data, offset);

  // Accounts match on-chain TransferDenominatedStark struct:
  // payer, denominated_pool, merkle_tree, nullifier_record, stark_proof_buffer, system_program
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: treePDA, isSigner: false, isWritable: true },
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },
    { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Transfer a note to a recipient using STARK proof (quantum-resistant).
 *
 * Nullifies the source note and inserts a fresh commitment in the same pool —
 * no funds move. The recipient can later unshield using the returned ShareableNote.
 *
 * Flow:
 * 1. Generate pool_commitment STARK proof (circuit 1) for the source note
 * 2. Submit + verify STARK proof on-chain
 * 3. Compute recipient's new commitment + new Merkle root
 * 4. Call transfer_denominated_stark (reads verified proof buffer)
 * 5. Close proof buffer (recover rent)
 */
export async function transferNoteStark(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
  stealthKeypair?: Keypair,
): Promise<{ txSig: string; recipientNote: ShareableNote }> {
  const { submitAndVerifyStarkProof, closeStarkProofBuffer, CIRCUIT_POOL_COMMITMENT, getProofBufferPDA } = await import('../stark');

  onProgress?.('Reading wallet...');
  const keypair = stealthKeypair ?? (walletSigner ? null : await getKeypair());
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const signerPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  onProgress?.('Reading pool state...');
  const slot = await connection.getSlot('confirmed');
  const currentEpoch = slotToEpoch(slot);

  const poolInfo = await fetchPoolInfo(connection, poolConfig);
  if (!poolInfo) throw new Error('Pool not found');

  // Populate source note's Merkle path/root if missing (e.g. recovered notes)
  await ensureMerkleProof(receipt, connection, poolConfig, poolInfo.currentRoot, onProgress);

  const totalDelay = poolInfo.epochDelay + BigInt(poolInfo.dynamicDelay);
  const minEpoch = currentEpoch - totalDelay;

  // Generate fresh note secrets for the recipient
  const newSecret = randomFieldElement();
  const newNullifierPreimage = randomFieldElement();
  const newDepositEpoch = currentEpoch;
  const newCommitment = createCommitment(
    newNullifierPreimage, newSecret, newDepositEpoch, receipt.tokenMint
  );

  onProgress?.('Computing new Merkle root...');
  const treeAccount = await connection.getAccountInfo(poolConfig.treePDA);
  if (!treeAccount) throw new Error('Merkle tree account not found');
  const { leafCount, subtrees } = parseFilledSubtrees(treeAccount.data);
  const { newRoot } = computeNewRootFromSubtrees(newCommitment, leafCount, subtrees);

  // Goldilocks nullifier from STARK public inputs
  const goldilocksNullifier = starkProofData.publicInputs[0] ?? 0n;
  const nullifierBytes: number[] = new Array(32).fill(0);
  let _nv = goldilocksNullifier;
  for (let i = 0; i < 8; i++) {
    nullifierBytes[i] = Number(_nv & 0xFFn);
    _nv >>= 8n;
  }
  const merkleRootBytes = bigintToLeBytes32(receipt.merkleRoot!);
  const newCommitmentBytes = bigintToLeBytes32(newCommitment);
  const newRootBytes = bigintToLeBytes32(newRoot);

  onProgress?.('Submitting STARK proof on-chain...');
  const starkSigner: WalletSigner = keypair
    ? { publicKey: keypair.publicKey, signTransaction: async (tx: Transaction) => { tx.sign(keypair); return tx; } }
    : walletSigner!;

  // Derive PDA upfront so finally can close even if submit throws mid-flight.
  const [proofBuffer] = getProofBufferPDA(starkSigner.publicKey, CIRCUIT_POOL_COMMITMENT);

  try {
    await submitAndVerifyStarkProof(
      {
        proofBytes: starkProofData.proofBytes,
        circuitId: CIRCUIT_POOL_COMMITMENT,
        publicInputs: starkProofData.publicInputs,
        proofSize: starkProofData.proofSize,
      },
      starkSigner,
      onProgress,
      connection,
    );

    onProgress?.('Building transfer transaction...');
    const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);
    const starkCommitment = starkProofData.publicInputs[1] ?? 0n;

    const ix = buildTransferDenominatedStarkIx(
      signerPubkey,
      poolConfig.poolPDA,
      poolConfig.treePDA,
      nullifierPDA,
      proofBuffer,
      nullifierBytes,
      merkleRootBytes,
      minEpoch,
      starkCommitment,
      Array.from(newCommitmentBytes),
      Array.from(newRootBytes),
    );

    onProgress?.('Sending transfer transaction...');
    const tx = new Transaction();
    tx.add(...buildComputeBudgetIxs(300_000));
    tx.add(ix);
    const txSig = stealthKeypair
      ? await signAndSend(connection, tx, stealthKeypair, undefined)
      : await signAndSend(connection, tx, keypair, walletSigner);

    onProgress?.('Done!');

    const recipientNote: ShareableNote = {
      version: 1,
      pool: poolConfig.poolPDA.toBase58(),
      secret: newSecret.toString(),
      nullifier_preimage: newNullifierPreimage.toString(),
      deposit_epoch: newDepositEpoch.toString(),
      token_mint: receipt.tokenMint.toString(),
      commitment: newCommitment.toString(),
      leafIndex: leafCount,
      token: poolConfig.token,
      denominationHuman: poolConfig.denomination,
    };

    return { txSig, recipientNote };
  } finally {
    try {
      onProgress?.('Closing proof buffer...');
      await closeStarkProofBuffer(proofBuffer, starkSigner, connection);
    } catch (closeErr: any) {
      console.warn('[DenomPool] closeStarkProofBuffer (transfer) failed (rent may be stranded):', closeErr.message);
    }
  }
}

// ---------------------------------------------------------------------------
// STARK Split Note (cross-pool denomination splitting, quantum-resistant)
// ---------------------------------------------------------------------------

/**
 * Build split_note_stark instruction.
 * Consumes TWO pre-verified STARK proof buffers:
 *   - C1 (circuit 1, pool_commitment): proves knowledge of the source note.
 *   - C3 (circuit 3, merkle_path): proves the C1 commitment is a leaf in the
 *     SOURCE pool tree at `merkle_root`. NEW on-chain hardening requirement —
 *     without it a forged C1 for a never-deposited commitment could split value
 *     out of nothing (mirrors unshield_denominated_stark_v3 / subscribe).
 * output_commitments authenticated by payer signature on instruction data.
 *
 * Account order MUST match SplitNoteStark in
 * programs/zk_shielded/src/instructions/split_note_stark.rs:
 *   1 payer, 2 source_pool, 3 source_merkle_tree, 4 target_pool,
 *   5 target_merkle_tree, 6 nullifier_record, 7 c1_proof_buffer,
 *   8 c3_proof_buffer (NEW), 9 protocol_fee_wallet, 10 system_program,
 *   11 token_program?, 12 source_pool_vault?, 13 target_pool_vault?.
 */
function buildSplitNoteStarkIx(
  payer: PublicKey,
  sourcePool: PoolConfig,
  targetPool: PoolConfig,
  nullifierPDA: PublicKey,
  c1ProofBuffer: PublicKey,
  c3ProofBuffer: PublicKey,
  nullifierBytes: number[],
  merkleRootBytes: number[],
  minEpoch: bigint,
  starkCommitment: bigint,
  numOutputs: number,
  outputCommitments: number[][],
  newRoots: number[][],
  // [C3-D12] Same walk as unshield and transfer. `split_note_stark` reads a note
  // through C3 exactly as they do, and it is the ONLY surface that builds this
  // instruction — no other client would have caught a drift here.
  subtreeRoot: bigint,
  siblings: bigint[],
  directions: number[],
): TransactionInstruction {
  const disc = getDiscriminator('split_note_stark');
  if (siblings.length !== directions.length) {
    throw new Error(
      `siblings (${siblings.length}) and directions (${directions.length}) must have ` +
      `equal length — the on-chain walk refuses a mismatch with WrongSiblingCount.`,
    );
  }
  if (directions.some((d) => d !== 0 && d !== 1)) {
    throw new Error('direction bits must be 0 or 1 — NonBinaryDirection on chain.');
  }

  // Data: disc(8) + nullifier(32) + merkle_root(32) + min_epoch(8) + stark_commitment(8)
  //       + num_outputs(1) + vec_len(4) + outputs(num*32) + vec_len(4) + new_roots(num*32)
  //       + subtree_root(8) + vec_len(4) + siblings(n*8) + vec_len(4) + directions(n)
  const vecOverhead = 4;
  const dataLen = 8 + 32 + 32 + 8 + 8 + 1
    + vecOverhead + numOutputs * 32
    + vecOverhead + numOutputs * 32
    + 8 + vecOverhead + siblings.length * 8 + vecOverhead + directions.length;

  const data = Buffer.alloc(dataLen);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(nullifierBytes).copy(data, offset); offset += 32;
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(minEpoch, offset); offset += 8;
  data.writeBigUInt64LE(starkCommitment, offset); offset += 8;
  data.writeUInt8(numOutputs, offset); offset += 1;

  data.writeUInt32LE(numOutputs, offset); offset += 4;
  for (let i = 0; i < numOutputs; i++) {
    Buffer.from(outputCommitments[i]).copy(data, offset); offset += 32;
  }

  data.writeUInt32LE(numOutputs, offset); offset += 4;
  for (let i = 0; i < numOutputs; i++) {
    Buffer.from(newRoots[i]).copy(data, offset); offset += 32;
  }

  data.writeBigUInt64LE(subtreeRoot, offset); offset += 8;
  data.writeUInt32LE(siblings.length, offset); offset += 4;
  for (const sib of siblings) { data.writeBigUInt64LE(sib, offset); offset += 8; }
  data.writeUInt32LE(directions.length, offset); offset += 4;
  for (const dir of directions) { data.writeUInt8(dir, offset); offset += 1; }

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: sourcePool.poolPDA, isSigner: false, isWritable: true },
    { pubkey: sourcePool.treePDA, isSigner: false, isWritable: false },
    { pubkey: targetPool.poolPDA, isSigner: false, isWritable: true },
    { pubkey: targetPool.treePDA, isSigner: false, isWritable: true },
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },
    { pubkey: c1ProofBuffer, isSigner: false, isWritable: false },
    { pubkey: c3ProofBuffer, isSigner: false, isWritable: false },
    { pubkey: PROTOCOL_FEE_WALLET, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: sourcePool.vaultATA ? TOKEN_PROGRAM_ID : ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: sourcePool.vaultATA || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!sourcePool.vaultATA },
    { pubkey: targetPool.vaultATA || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!targetPool.vaultATA },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Split a note from a high-denomination pool into multiple notes in a
 * lower-denomination pool using STARK proof (quantum-resistant).
 *
 * Denomination conservation is enforced on-chain:
 *   source.denomination == num_outputs * target.denomination
 *
 * Flow (mirrors subscribe_private_stark / unshield_denominated_stark_v3 — TWO buffers):
 * 1. Submit + verify C1 (pool_commitment, circuit 1) proof  → c1ProofBuffer
 * 2. Submit + verify C3 (merkle_path, circuit 3) proof       → c3ProofBuffer
 * 3. Compute output commitments (Poseidon) + new Merkle roots
 * 4. Call split_note_stark (reads BOTH verified proof buffers)
 * 5. Close BOTH proof buffers (recover rent)
 *
 * The C3 proof is a hardening requirement added on-chain: without it a
 * quantum/forging attacker could synthesize a valid C1 proof for a
 * never-deposited commitment and split value out of nothing into the target
 * pool. The on-chain handler reconstructs
 *   sha256(stark_commitment_u64_le || subtree_root_u64_le || 12_u64_le)
 * and compares it to the C3 buffer's stored public_inputs hash.
 *
 * 🚨 THAT HASH TOOK `merkle_root[..8]` AND `depth = 15` UNTIL 2026-08-29. Since
 * the C3 depth cut the proof binds a twelve-level SUBTREE root, and the depth is
 * the CONSTANT 12, not the pool's tree depth. `subtree_root` therefore comes
 * from `c3ProofData.publicInputs[1]`; `merkle_root` — still checked against the
 * pool's known-root ring — comes from the caller's own tree walk.
 */
export async function splitNoteStark(
  sourcePool: PoolConfig,
  targetPool: PoolConfig,
  receipt: ShieldReceipt,
  numOutputs: number,
  outputSecrets: bigint[],
  starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  c3ProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  // [C3-D12] The walk above the circuit. REQUIRED and positional, so an
  // un-updated caller fails to COMPILE. `merkleRoot` is the POOL root of the
  // note being split, from the caller's own tree walk.
  walk: { merkleRoot: bigint; siblings: bigint[]; directions: number[] },
  walletSigner?: WalletSigner,
  onProgress?: (step: string) => void,
  stealthKeypair?: Keypair,
): Promise<{ txSignature: string; outputCommitments: bigint[]; outputNullifierPreimages: bigint[] }> {
  const {
    submitAndVerifyStarkProof,
    closeStarkProofBuffer,
    CIRCUIT_POOL_COMMITMENT,
    CIRCUIT_MERKLE_PATH,
    getProofBufferPDA,
  } = await import('../stark');
  const connection = getConnection();

  onProgress?.('Validating split parameters...');
  const expectedOutputs = Number(sourcePool.denominationAtomic / targetPool.denominationAtomic);
  if (numOutputs !== expectedOutputs) {
    throw new Error(`Denomination mismatch: ${sourcePool.denomination} / ${targetPool.denomination} = ${expectedOutputs} outputs, got ${numOutputs}`);
  }
  if (numOutputs < 1 || numOutputs > 20) {
    throw new Error(`Invalid numOutputs: ${numOutputs} (must be 1-20)`);
  }
  if (!sourcePool.tokenMint.equals(targetPool.tokenMint)) {
    throw new Error('Source and target pools must use the same token mint');
  }

  const keypair = stealthKeypair ?? (walletSigner ? null : await getKeypair());
  if (!keypair && !walletSigner) throw new Error('Wallet not found');
  const signerPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;

  // Populate source note's Merkle path/root if missing (e.g. recovered notes)
  const sourcePoolInfo = await fetchPoolInfo(connection, sourcePool);
  if (!sourcePoolInfo) throw new Error('Source pool not found');
  await ensureMerkleProof(receipt, connection, sourcePool, sourcePoolInfo.currentRoot, onProgress);

  onProgress?.('Computing output commitments...');
  const outputCommitments: bigint[] = [];
  const outputNullifierPreimages: bigint[] = [];
  const currentEpochForOutputs = slotToEpoch(await connection.getSlot('confirmed'));

  for (let i = 0; i < numOutputs; i++) {
    const secret = outputSecrets[i];
    const nullifierPreimage = poseidon2([secret, BigInt(i)]);
    outputNullifierPreimages.push(nullifierPreimage);
    const commitment = createCommitment(
      nullifierPreimage, secret, currentEpochForOutputs, receipt.tokenMint
    );
    outputCommitments.push(commitment);
  }

  onProgress?.('Computing new Merkle roots...');
  const targetTreeAccount = await connection.getAccountInfo(targetPool.treePDA);
  if (!targetTreeAccount) throw new Error('Target Merkle tree account not found');
  let { leafCount: targetLeafCount, subtrees: targetSubtrees } = parseFilledSubtrees(targetTreeAccount.data);

  const newRoots: bigint[] = [];
  for (let i = 0; i < numOutputs; i++) {
    const { newRoot, updatedSubtrees } = computeNewRootFromSubtrees(
      outputCommitments[i], targetLeafCount, targetSubtrees
    );
    newRoots.push(newRoot);
    targetSubtrees = updatedSubtrees;
    targetLeafCount += 1;
  }

  // Goldilocks nullifier from STARK public inputs
  const goldilocksNullifier = starkProofData.publicInputs[0] ?? 0n;
  const nullifierBytes: number[] = new Array(32).fill(0);
  let _nv = goldilocksNullifier;
  for (let i = 0; i < 8; i++) {
    nullifierBytes[i] = Number(_nv & 0xFFn);
    _nv >>= 8n;
  }
  // 🚨 THIS DERIVED `merkle_root` FROM `c3ProofData.publicInputs[1]` UNTIL
  // 2026-08-29, and the comment that stood here called it "the root the C3 proof
  // targeted". Since the depth cut that public input is the root of the
  // twelve-level SUBTREE the note sits in, so it names a root no pool ever
  // published and `is_valid_root` would refuse every split.
  //
  // The pool root now comes from the caller's tree walk; the subtree root stays
  // the proof's, and travels as its own argument for the on-chain walk to fold.
  // `bigintToLeBytes32` on a u64-masked value puts the u64 LE into bytes[0..8]
  // with bytes[8..32]=0, exactly what `is_valid_root` and the C3 hash expect.
  const U64_MASK = (1n << 64n) - 1n;
  const subtreeRootGl = (c3ProofData.publicInputs[1] ?? 0n) & U64_MASK;
  if (c3ProofData.publicInputs[2] !== BigInt(C3_SUBTREE_DEPTH)) {
    throw new Error(
      `C3 proved depth ${c3ProofData.publicInputs[2]}, expected ${C3_SUBTREE_DEPTH}. ` +
      `The shipped wasm prover is stale — it predates the depth cut, and the ` +
      `on-chain verifier rejects every proof it makes. Reship the blob.`,
    );
  }
  const merkleRootBytes = bigintToLeBytes32(walk.merkleRoot & U64_MASK);
  const outputCommitmentBytes = outputCommitments.map(c => Array.from(bigintToLeBytes32(c)));
  const newRootBytes = newRoots.map(r => Array.from(bigintToLeBytes32(r)));

  const slot = await connection.getSlot('confirmed');
  const currentEpoch = slotToEpoch(slot);
  const totalDelay = sourcePoolInfo.epochDelay + BigInt(sourcePoolInfo.dynamicDelay);
  const minEpoch = currentEpoch - totalDelay;

  onProgress?.('Submitting STARK proofs on-chain...');
  const starkSigner: WalletSigner = keypair
    ? { publicKey: keypair.publicKey, signTransaction: async (tx: Transaction) => { tx.sign(keypair); return tx; } }
    : walletSigner!;

  // Derive PDAs upfront so finally can close both even if a submit throws
  // mid-flight. C1 (id=1) and C3 (id=3) get distinct legacy PDAs (the buffer
  // PDA seeds circuit_id, so they never collide).
  const [c1ProofBuffer] = getProofBufferPDA(starkSigner.publicKey, CIRCUIT_POOL_COMMITMENT);
  const [c3ProofBuffer] = getProofBufferPDA(starkSigner.publicKey, CIRCUIT_MERKLE_PATH);

  try {
    // Step 1: C1 (pool_commitment) — proves knowledge of secret + nullifier.
    onProgress?.('Submitting C1 (pool_commitment) proof on-chain...');
    await submitAndVerifyStarkProof(
      {
        proofBytes: starkProofData.proofBytes,
        circuitId: CIRCUIT_POOL_COMMITMENT,
        publicInputs: starkProofData.publicInputs,
        proofSize: starkProofData.proofSize,
      },
      starkSigner,
      onProgress,
      connection,
    );

    // Step 2: C3 (merkle_path) — NEW hardening requirement. Proves the C1
    // source-note commitment is a leaf in the SOURCE pool tree at `merkle_root`.
    onProgress?.('Submitting C3 (merkle_path) proof on-chain...');
    await submitAndVerifyStarkProof(
      {
        proofBytes: c3ProofData.proofBytes,
        circuitId: CIRCUIT_MERKLE_PATH,
        publicInputs: c3ProofData.publicInputs,
        proofSize: c3ProofData.proofSize,
      },
      starkSigner,
      onProgress,
      connection,
    );

    onProgress?.('Building split transaction...');
    const [nullifierPDA] = deriveNullifierPDA(sourcePool.poolPDA, nullifierBytes);
    const starkCommitment = starkProofData.publicInputs[1] ?? 0n;

    const ix = buildSplitNoteStarkIx(
      signerPubkey,
      sourcePool,
      targetPool,
      nullifierPDA,
      c1ProofBuffer,
      c3ProofBuffer,
      nullifierBytes,
      Array.from(merkleRootBytes),
      minEpoch,
      starkCommitment,
      numOutputs,
      outputCommitmentBytes,
      newRootBytes,
      subtreeRootGl,
      walk.siblings,
      walk.directions,
    );

    onProgress?.('Sending split transaction...');
    const tx = new Transaction();
    // [C3-D12] 500,000 -> 600,000. The three levels the handler now walks cost
    // ~103,400 CU at the ~34,469 CU per on-chain `hash2` measured 2026-08-29 on
    // the litesvm SBF VM. ⚠️ Headroom, not an end-to-end measurement.
    tx.add(...buildComputeBudgetIxs(600_000));
    tx.add(ix);
    const txSignature = stealthKeypair
      ? await signAndSend(connection, tx, stealthKeypair, undefined)
      : await signAndSend(connection, tx, keypair, walletSigner);

    onProgress?.('Split confirmed!');
    return { txSignature, outputCommitments, outputNullifierPreimages };
  } finally {
    // Close BOTH buffers (C1 + C3) regardless of whether the split tx
    // succeeded — the handler does not touch them, so rent is ours to recover.
    for (const buf of [c1ProofBuffer, c3ProofBuffer]) {
      try {
        onProgress?.('Closing proof buffer...');
        await closeStarkProofBuffer(buf, starkSigner, connection);
      } catch (closeErr: any) {
        console.warn('[DenomPool] closeStarkProofBuffer (split) failed (rent may be stranded):', closeErr.message);
      }
    }
  }
}

// ===========================================================================
// V3 — full-Goldilocks code paths (side-by-side with v2 above)
// ===========================================================================
//
// V3 swaps the BN254 `poseidon-lite` hash for the Goldilocks Poseidon used
// end-to-end by the STARK circuits and the on-chain verifier. Every export
// here is suffixed `V3` / `v3` so callers can pick — v2 paths above stay live
// for the 30-day deprecation window.
//
// Imports use the existing mobile-local Goldilocks port at
// `services/zk/goldilocks-poseidon`. The privacy-sdk `crypto/poseidonGl` is
// not in mobile's dependency graph (mobile only depends on specter-sdk +
// arcium-sdk + stark-prover); the local port is a bit-exact mirror — same
// parity vectors, same Rust source. If the privacy-sdk export becomes
// reachable here later (workspace re-export), swap the import below.
//
// Plan + progress: memory `v3-stark-migration-plan-2026-05-02.md` and
// `v3-progress-2026-05-03.md`.

import {
  goldilocksHash2to1 as poseidonHash2,
  goldilocksHash4to1 as poseidonHash4,
  computeGoldilocksZeroCascade,
  GOLDILOCKS_MODULUS,
} from '../zk/goldilocks-poseidon';

// Re-export so future callers can grab the field constant from this module
// instead of reaching into services/zk.
export { GOLDILOCKS_MODULUS, poseidonHash2 as poseidonHash2V3, poseidonHash4 as poseidonHash4V3 };

/** V3 zero leaf — Goldilocks 0n. Stored as 32-byte LE = all zeros. */
export const ZERO_VALUE_V3 = 0n;

const U64_MASK_V3 = (1n << 64n) - 1n;

/** Reduce an arbitrary bigint into a Goldilocks field element. */
function toGoldilocks(x: bigint): bigint {
  const r = x % GOLDILOCKS_MODULUS;
  return r < 0n ? r + GOLDILOCKS_MODULUS : r;
}

// ---------------------------------------------------------------------------
// V3 commitment + nullifier (Goldilocks Poseidon)
// ---------------------------------------------------------------------------

/**
 * V3 commitment — MUST match the on-chain AIR formula in
 * `stark/src/air/denominated_pool.rs` lines 349-351:
 *
 *   nullifier  = hash2(nullifier_preimage, secret)
 *   epoch_hash = hash2(deposit_epoch, token_mint)
 *   commitment = hash2(nullifier, epoch_hash)
 *
 * Three sequential t=3 (hash2) calls — NOT a single t=5 hash4. The C1
 * STARK proof's `commitment` public input is the result of this exact
 * formula; if the mobile uses anything else, the leaf in the on-chain
 * tree will not equal `c1.publicInputs[1]` and the unshield ix's
 * `c1.commitment == c3.leaf` tie-up will fail with InvalidProof.
 *
 * Inputs are reduced mod Goldilocks (each is a u64).
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
 * V3 nullifier = Poseidon(nullifier_preimage, secret) using width-3 t=3.
 * Matches `computeGoldilocksPoolNullifier` already in services/zk; re-exported
 * here for symmetry with the v2 `createNullifier`.
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
// V3 zero-hash cascade (Goldilocks)
// ---------------------------------------------------------------------------

let _zeroHashesV3: bigint[] | null = null;
/**
 * V3 zero hashes for the merkle tree, length = MERKLE_DEPTH + 1.
 * Cached on first call. Matches `MerkleTreeStateV3::ZEROS` on-chain (see
 * `programs/zk_shielded/src/state/merkle_tree_v3.rs`) and the table in
 * memory `v3-progress-2026-05-03.md`.
 */
export function computeZeroHashesV3(): bigint[] {
  if (_zeroHashesV3) return _zeroHashesV3;
  _zeroHashesV3 = computeGoldilocksZeroCascade(MERKLE_DEPTH);
  return _zeroHashesV3;
}

// ---------------------------------------------------------------------------
// V3 merkle proof helpers
// ---------------------------------------------------------------------------

/**
 * V3 byte serialization for a Goldilocks leaf/root: 32 bytes little-endian
 * with the u64 in bytes 0..8 and zeros in bytes 8..32. Matches the on-chain
 * convention used by `verify_c6_proof_buffer` (it reads
 * `u64::from_le_bytes(leaf[..8])`).
 *
 * Uses the existing `bigintToLeBytes32` (which already handles 64-bit values
 * — bytes past index 7 are zero because the value fits in 64 bits).
 */
export function goldilocksToLeBytes32(value: bigint): number[] {
  const v = value & U64_MASK_V3;
  return bigintToLeBytes32(v);
}

/**
 * V3 — pure rebuild from a leaves-by-index array, Goldilocks Poseidon.
 *
 * Note: V3 doesn't need the v2 `replayMerkleProofFromEvents` workaround
 * because `insert_with_root_v3` maintains the FULL filled_subtrees array
 * (verified by the C6 STARK proof on every insertion), so the on-chain
 * tree is a real merkle tree — a pure rebuild always agrees with on-chain.
 */
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

  let nodes: bigint[] = leavesByIndex.length > 0 ? [...leavesByIndex] : [zeros[0]];
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

/**
 * V3 — incremental insert helper (mirrors v2 `computeNewRootFromSubtrees`).
 * Used by shield: given the on-chain `filledSubtrees`, computes the new
 * root + updated subtrees + path that the C6 prover must witness.
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
  const subtrees = [...filledSubtrees];
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

/**
 * V3 — split-output secret derivation. Deterministic so split children are
 * recoverable from the parent secret via `rescanPoolFromSeed`-style scans.
 * Uses Goldilocks Poseidon t=3 (poseidonHash2) instead of v2's BN254 t=2.
 */
export function deriveSplitOutputSecretsV3(parentSecret: bigint, count: number): bigint[] {
  const parent = toGoldilocks(parentSecret & U64_MASK_V3);
  const secrets: bigint[] = new Array(count);
  for (let i = 0; i < count; i++) {
    secrets[i] = poseidonHash2(parent, toGoldilocks(BigInt(i)));
  }
  return secrets;
}

// ---------------------------------------------------------------------------
// V3/V4 pool config (live on devnet)
// ---------------------------------------------------------------------------

// V3 pools deployed on devnet 2026-05-03 via scripts/setup-v3-pools.mjs.
// Program GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c, init signatures
// captured in /tmp/init-v3.log.
export const SOL_POOLS_V3: PoolConfig[] = [
  // V4 pools (seed bumped 2026-05-07 to escape v3 pools with un-decodable
  // legacy LeafInserted events). Old v3 SOL 0.1/1 pools left as comments
  // for forensics.
  // OLD v3: 28Bvnsw…/596hfJZcR5… (pool 0.1) had 14 leaves, 1 unrecoverable.
  // OLD v3: 9Mx3Gv…/ELSe7TpQc…  (pool 1)
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 0.1, decimals: 9,
    denominationAtomic: 100_000_000n,
    poolPDA: new PublicKey('HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG'),
    treePDA: new PublicKey('43MRQ91VrrxkD2PqV4QXNJG3BUmu8JmbDUTtWt2dYBAU'),
    version: 'v3',
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 1, decimals: 9,
    denominationAtomic: 1_000_000_000n,
    poolPDA: new PublicKey('6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS'),
    treePDA: new PublicKey('GGJQwEigkoSk3pzg6eiLtt1cu2kYfCtV5JewNJsMkNdi'),
    version: 'v3',
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 10, decimals: 9,
    denominationAtomic: 10_000_000_000n,
    poolPDA: new PublicKey('H91CcAemoNktnW785XfnMjQqwThRNe127X5c2XuwtvwQ'),
    treePDA: new PublicKey('AFLnk8gEVY38zG6fopuNb2oHyPZyjVsvyN3wqNVVyWFs'),
    version: 'v3',
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 100, decimals: 9,
    denominationAtomic: 100_000_000_000n,
    poolPDA: new PublicKey('AWWQ2QpB6omxywWU5RQYD7D5QvC5kjqo71Vj8QJxCUKu'),
    treePDA: new PublicKey('2DNoAGmpBmq3uTgqVVgE8yKcnGtVk4gkL5n5QHgU97G1'),
    version: 'v3',
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 500, decimals: 9,
    denominationAtomic: 500_000_000_000n,
    poolPDA: new PublicKey('A6Dp4q8rVMmhM1F4bXL8VV6BER4xGgmiqoYXQhfhGGAh'),
    treePDA: new PublicKey('BvDHQeryXC1WBYyqdnDsw6QZEUxk3ht86adiwuGm1eme'),
    version: 'v3',
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 1000, decimals: 9,
    denominationAtomic: 1_000_000_000_000n,
    poolPDA: new PublicKey('ASMW2Gtg9q2J64jaLhVqHmXBFUmuFtRi9WQoKNdVed7X'),
    treePDA: new PublicKey('ANwpHYapKrw94pxcDfg7ggAad2MwmG5Gr4NYMvLC7Yb1'),
    version: 'v3',
  },
];

// USDC V3 pools — vaultATA needs to be derived (PoolPDA + USDC mint via
// the Associated Token Account program). For now we skip the field; the
// caller can compute it lazily when needed (matches behavior of v2 USDC
// init script which derives ATAs idempotently). Filling in after first
// USDC v3 shield validates the derivation.
export const USDC_POOLS_V3: PoolConfig[] = [
  // V4 pools (seed bumped 2026-05-07 — see SOL_POOLS_V3 above for context).
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 1, decimals: 6,
    denominationAtomic: 1_000_000n,
    poolPDA: new PublicKey('AnBmWYRKGmcPSVTSgYZJeFgqaHmyLTzT1VJbmejXVSib'),
    treePDA: new PublicKey('FwxkCXBSGjeNqjEpbBGAjuYB5fLV4iqddMbqPq9UDpcz'),
    version: 'v3',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 10, decimals: 6,
    denominationAtomic: 10_000_000n,
    poolPDA: new PublicKey('58xgMmQJQbh2H5QMvw7Sw9CmnEGww17i4YtESJU7pcm4'),
    treePDA: new PublicKey('H4syFMw5HovpQ8usEJiPsp69T8VUK6HbnNAcFAS8BewQ'),
    version: 'v3',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 100, decimals: 6,
    denominationAtomic: 100_000_000n,
    poolPDA: new PublicKey('Dm6XJCkrqEjd9iC6uMyeaJQ5ADNB4Dd3ap3cCjyUP2RA'),
    treePDA: new PublicKey('GkDqmFJYRx3FJYSbVAULde4WU8q31WSZmHkT1g5HuYKs'),
    version: 'v3',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 1000, decimals: 6,
    denominationAtomic: 1_000_000_000n,
    poolPDA: new PublicKey('BwVswgqjXayXBbwu3WXrbB2MxcJdoRr5KC1aUfwqmGxT'),
    treePDA: new PublicKey('FpmYv4NiAGYKZDvytGEzcmaajZ9voHRjLFpqU8rCunZb'),
    version: 'v3',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 10000, decimals: 6,
    denominationAtomic: 10_000_000_000n,
    poolPDA: new PublicKey('5tjCa8FS41pdAg7dzH6wVePVDPJvbiBSbQxYRwgtXC3w'),
    treePDA: new PublicKey('ABjs9guDCV1th3ixp4hmx2SkGdNBKXuDEptzcBnZjVj4'),
    version: 'v3',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 20000, decimals: 6,
    denominationAtomic: 20_000_000_000n,
    poolPDA: new PublicKey('A6nJv8ib2ek5WjUzknw7ijRRvfTH4Q2Ds63VNpq7FefM'),
    treePDA: new PublicKey('Fw7UvkiBwZyNrUo8WohZWagHLwwArrdKrW6t1PRvzVii'),
    version: 'v3',
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 50000, decimals: 6,
    denominationAtomic: 50_000_000_000n,
    poolPDA: new PublicKey('27evdDgKsXYa73dpBtULcZMyNMNhk9zhHsFFtNT92M3w'),
    treePDA: new PublicKey('BCoV7J3uaq57bsLGBTubnS1en31GxXnexoXBWJ4e8YpL'),
    version: 'v3',
  },
];

export const ALL_POOLS_V3: PoolConfig[] = [...SOL_POOLS_V3, ...USDC_POOLS_V3];

export function getPoolsForTokenV3(token: 'SOL' | 'USDC'): PoolConfig[] {
  return token === 'SOL' ? SOL_POOLS_V3 : USDC_POOLS_V3;
}

export function findPoolV3(token: 'SOL' | 'USDC', denomination: number): PoolConfig | undefined {
  return ALL_POOLS_V3.find(p => p.token === token && p.denomination === denomination);
}

/**
 * Lookup a pool config (v2 or v3) by its on-chain PDA. Returns the matching
 * `PoolConfig` so the caller can read `version` and route to the right STARK
 * flow. Returns `undefined` if the PDA isn't in either pool registry — in that
 * case the note belongs to an orphaned/legacy pool and is unspendable.
 */
export function findPoolByPDA(poolPDA: string): PoolConfig | undefined {
  return ALL_POOLS.find(p => p.poolPDA.toBase58() === poolPDA)
    || ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === poolPDA);
}

// ---------------------------------------------------------------------------
// V3 instruction builders
// ---------------------------------------------------------------------------

/**
 * Build `shield_denominated_v3`.
 *
 * Args: commitment[32], old_subtree_root[32], new_subtree_root[32],
 *       new_subtrees Vec<[u8;32]>.
 *
 * ⛔ `new_root` IS NO LONGER AN ARGUMENT. Since the C6 depth cut the program
 * COMPUTES the pool root by folding the top 3 levels against the pool account's
 * own `filled_subtrees`; a caller-supplied pool root is precisely what that fold
 * exists to refuse.
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
  const subtreesBytesLen = 4 + newSubtrees.length * 32; // borsh Vec<[u8;32]>
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

  // Phase E v1: fee_escrow is a per-pool PDA (deployed 2026-05-07), no
  // longer the hardcoded BRop3... constant.
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

/**
 * Build `unshield_denominated_stark_v3`.
 *
 * Args layout: nullifier[32], merkle_root[32], min_epoch u64, stark_commitment u64, recipient[32].
 *
 * Phase B.2 indexability change: `recipient` is no longer a named account in the
 * Anchor struct — it is passed as a 32-byte instruction arg AND placed as
 * remaining_accounts[0] (isWritable=true, isSigner=false). The on-chain handler
 * validates remaining_accounts[0].key() == Pubkey::from(recipient_arg), so a
 * malicious relayer cannot redirect funds. Naive Solscan-style indexers keying on
 * the named accounts list will no longer resolve "recipient: ABC" semantically.
 *
 * `recipientTokenAccount` stays as a named Option account (accounts[10]) because
 * Anchor's token constraints validate mint/owner — moving it to remaining_accounts
 * would require manual deserialization for marginal privacy gain.
 */
// ===========================================================================
// V4 SPEND — circuit 7, and everything that drives it on this surface
// ===========================================================================
//
// v3 spends on a C1 + C3 pair tied together by `stark_commitment`, PUBLISHED IN
// THE CLEAR. A withdrawal therefore names the leaf it spends, and anyone with
// the deposit events walks back to the deposit that funded it. C7 proves both
// halves in one trace and the commitment never reaches the instruction.
//
// ✅ MOBILE ROUTES v3-POOL WITHDRAWALS TO CIRCUIT 7 (cut over 2026-09-06). The
// pieces, and where each lives:
//
//   - `whyCircuit7Cannot` / `V4Unprovable` / `prepareUnshieldV4` /
//     `unshieldDenominatedStarkV4` — below, ported from the extension twin
//     (apps/extension/src/shared/services/denominatedPool.ts). One difference
//     is structural, not cosmetic: the prover on this surface is a WebView
//     bridge reached through a React context hook (`useStarkProver()`), not an
//     importable singleton, so `prepareUnshieldV4` takes the prove function as
//     a parameter (`SpendProver`) exactly the way the screens already pass C1
//     and C3 results down.
//   - `routeUnshieldSpend` — ./spendRouting.ts. The allow-list decision, pure
//     and Node-testable: whyCircuit7Cannot(receipt) synchronously FIRST; then
//     try prepare; the catch falls back to the C1 + C3 pair ONLY on
//     `err instanceof V4Unprovable` and rethrows everything else. NOTHING
//     after the prepare may fall back — once the proof is uploaded and the
//     nullifier PDA initialised, a v3 retry pays rent twice and dies on the
//     double-spend guard with the note already spent.
//   - `prepareUnshieldNoteV4` + `unshieldNoteStarkV4` — stores/denominatedPoolStore.ts.
//     Two actions, not one, because circuit 7 binds sha256(recipient) into the
//     transcript and the recipient on this surface is an ECDH stealth address
//     the STORE derives. The v3 flow proved first and derived the recipient
//     later; v4 must derive first, prove second, and the screen has to see a
//     V4Unprovable from the prepare step before any lamport moves. Stealth
//     signer, pre-fund, jitter, persisted sweep claim, mark-spent-immediately,
//     delayed sweep and crash-sweep are the v3 action's, byte for byte.
//   - Both callers route: denominated-unshield.tsx AND
//     denominated-unshield-batch.tsx. The pair path they used to run is kept
//     as the fallback, unchanged.
//
// 🚨 WHAT IS STILL UNMEASURED: how long circuit 7 takes ON A PHONE. The cutover
// shipped WITHOUT that number, by the owner's decision on 2026-09-06, and the
// number is still owed. Everything measured so far is Node on a desktop
// (2026-08-27: 1,881 / 3,708 / 10,359 ms on an identical witness — the PoW
// grind is geometrically distributed, so only a median with its spread means
// anything). The single device datapoint in this repository (C3 = 1,482 ms on
// 0019235AU004508, 2026-08-03) was taken on a circuit and a blob the verifier
// no longer accepts, so it is an anecdote and not a correction factor. The
// 180 s figure that used to circulate here was a WebView HANG, retracted the
// evening it was written (memory/measured-on-device-proving-exceeds-180s-2026-08-03.md).
//
// To take the number, with no RPC and no SOL:
//   Settings -> About -> tap the version seven times -> Privacy tech tests
//   -> "Circuit 7 spend proof". Five runs over a synthetic witness; the proof
//   is generated and discarded. Read the median off
//   'adb logcat -s ReactNativeJS' - every circuit emits
//   '[P01PERF] circuit=<n> prover=<n> ms bridge=<n> ms proofSize=<n>' from
//   StarkProverProvider's sendRequestRaw, in the same format as the 2026-08-03
//   capture, so a logcat line and a desktop line compare without translation.
//   Build with JDK 17, NOT 21 (memory/feedback_jdk21_temurin_jit_crash).
//
// A live withdrawal through this path has NOT been executed on a device or on
// devnet as of the cutover. What has: the WebView glue produces a real
// 77,965-byte circuit-7 proof in a vm (services/stark/webviewSpend.test.ts),
// the wire layout is pinned (unshieldV4.test.ts), and the routing decision is
// pinned against mocks (spendRouting.test.ts). None of those is a proof that a
// v4 spend lands end to end from this app.
//
// What does NOT need measuring, because it is deterministic: C7 uploads 78
// chunks against the pair's 148, one buffer instead of two.
// ---------------------------------------------------------------------------

/** C7's subtree depth. NOT the pool tree's 15. See `air/spend.rs`. */
/**
 * \U0001f6a8 11, NOT 12 -- and it was 12 here while the circuit had moved.
 *
 * Rust owns this depth (`stark/src/air/spend.rs` CANONICAL_DEPTH), the shipped
 * prover checks the path against it, and the deployed verifier agrees. A
 * client that slices to 12 builds a proof of a tree the chain does not use,
 * so it cannot be accepted however well the rest of the flow works. The web
 * client moved with the circuit; this stack did not.
 *
 * \u26d4 Mirrors Rust across a wire that carries no types: move it in the same
 * commit as CANONICAL_DEPTH, never on its own.
 */
export const C7_SUBTREE_DEPTH = 11;

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
): TransactionInstruction {
  if (siblings.length !== directions.length) {
    throw new Error(
      `siblings (${siblings.length}) and directions (${directions.length}) must be the same length`,
    );
  }
  const disc = getDiscriminator('unshield_denominated_stark_v4');
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

// ---------------------------------------------------------------------------
// V4 SPEND — the driver (ported from the extension twin, 2026-09-06)
// ---------------------------------------------------------------------------

/**
 * Every real deposit epoch is under 2**32 (slot/7200 = 67,838 on 2026-08-26,
 * five digits); every `deriveNoteBlinding` draw is 63 bits. The gap between
 * the two populations is where this line sits. See `whyCircuit7Cannot`.
 */
export const LEGACY_BLINDING_CEILING = 2n ** 32n;

/**
 * Why circuit 7 must NOT be used for this note — or `null` when it may.
 *
 * A note whose `depositEpoch` is a real epoch rather than a PRF blinding
 * predates commitment blinding. Proving it on circuit 7 hides the commitment
 * from the wire while leaving the leaf recoverable from the published nullifier
 * by trying a few thousand epochs — which is worse than the C1 + C3 pair only in
 * that it LOOKS private. The circuit cannot close this: `blinding` is a private
 * witness and `stark/src/air/spend.rs:908-913` forbids constraining it. So it is
 * a ROUTING decision, and it must not block the note: the caller falls back to
 * the pair, which publishes the commitment and is honest about it.
 *
 * Classifies by MAGNITUDE. On an imported note the magnitude is the sender's
 * choice, and a blinding just above the ceiling is admitted — accepted, with
 * the reasoning written on the extension twin (`apps/extension/src/shared/
 * store/denominatedPool.ts`): the outcome is never worse than the pair, and
 * the party who could exploit it already holds the nullifier.
 *
 * Wording kept aligned with the two other surfaces, `circuit 7 needs at least`
 * included. ⚠️ Nothing on this surface ROUTES on the wording — see
 * `V4Unprovable`.
 */
export function whyCircuit7Cannot(receipt: Pick<ShieldReceipt, 'depositEpoch'>): string | null {
  if (receipt.depositEpoch < LEGACY_BLINDING_CEILING) {
    return (
      'circuit 7 needs at least a randomised blinding, and this note carries its deposit ' +
      `epoch (${receipt.depositEpoch}) instead — it predates commitment blinding. Proving ` +
      'it on circuit 7 would hide the commitment while leaving the leaf recoverable from ' +
      'the published nullifier by trying a few thousand epochs, which is worse than the ' +
      'C1 + C3 pair only in that it looks private. Falling back to the pair.'
    );
  }
  return null;
}

/**
 * "This NOTE cannot go through circuit 7" — and nothing else.
 *
 * ⛔ AN ALLOW-LIST, AND THAT IS THE WHOLE SAFETY PROPERTY. `routeUnshieldSpend`
 * (./spendRouting.ts) falls back to the C1 + C3 pair on `instanceof V4Unprovable`
 * and rethrows everything else. A wrong felt count or a transcript bound to the
 * wrong payee is a broken PROVER, thrown as a plain `Error` below, and answering
 * that by republishing the commitment and reporting success is the exact
 * failure the pair exists to remove.
 *
 * Routed on the TYPE, not on a string: the prover result crosses the WebView
 * bridge as JSON, but the ERROR is thrown here, in the JS realm, after the
 * bridge — so `instanceof` survives and cannot be broken by rewording.
 */
export class V4Unprovable extends Error {
  constructor(message: string) {
    super(message);
    // Hermes honours the native prototype chain for `class extends Error`, but
    // `name` is set anyway: without it every log line says "Error", which is
    // the one thing a reader chasing this fallback needs to see.
    this.name = 'V4Unprovable';
  }
}

/**
 * The prove function `prepareUnshieldV4` is handed. On this surface it is
 * `generateSpendProof` from `useStarkProver()` — a React context hook — so it
 * cannot be imported here; the screen passes it down. The shape is the
 * provider's, verbatim.
 */
export type SpendProver = (
  nullifierPreimage: string,
  secret: string,
  blinding: string,
  tokenMint: string,
  pathElements: string[],
  pathIndices: number[],
  recipientHash: string[],
) => Promise<{ proofHex: string; publicInputs: string[]; proofSize: number }>;

export interface PrepareUnshieldV4Result {
  c7ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number };
  /** The pool root the instruction NAMES. */
  merkleRoot: bigint;
  /** The depth-11 root the proof REACHES. The handler walks from here to the above. */
  subtreeRoot: bigint;
  nullifierGoldilocks: bigint;
  /** Levels 11..15 of the path — walked on chain, not in the circuit. */
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
 * Fetch leaves, build the Merkle path, pre-flight the root, and generate ONE
 * circuit-7 proof.
 *
 * ⛔ `recipient` is a parameter HERE, unlike the C1 + C3 prepare. C7 binds
 * sha256(recipient) into its transcript; the proof does not exist without it.
 * On this surface that recipient is the ECDH stealth address the store derives,
 * which is why the store derives it BEFORE calling this.
 *
 * Throws `V4Unprovable` for exactly two note-shaped facts (root not in the
 * pool's ring; path too short for the circuit) and a plain `Error` for
 * everything a broken prover could produce. Nothing has been spent by the time
 * any of them fires.
 */
export async function prepareUnshieldV4(
  receipt: ShieldReceipt,
  recipient: PublicKey,
  poolConfig: PoolConfig,
  connection: Connection,
  prove: SpendProver,
  onProgress?: (step: string) => void,
): Promise<PrepareUnshieldV4Result> {
  onProgress?.('Fetching pool leaves from on-chain events...');
  // 5000, like the v3 pair path on this surface: devnet Helius 429s truncate
  // the signature list at low limits, and one missed LeafInserted gap-fills a
  // root no pool ever published.
  const SIG_SCAN_LIMIT = 5000;
  const { leavesByIndex, missing } = await fetchPoolLeavesByIndex(
    connection,
    poolConfig.poolPDA,
    {
      maxSignatures: SIG_SCAN_LIMIT,
      onProgress: (s, t) => onProgress?.(`Scanning events ${s}/${t}...`),
      onStep: onProgress,
      minLeafCount: receipt.leafIndex + 1,
    },
  );
  if (missing.length > 0) {
    console.warn(`[DenomPool/v4] prepareUnshieldV4: ${missing.length} missing leaf gap(s): ${missing.slice(0, 5).join(',')}...`);
  }

  onProgress?.('Building Merkle proof from leaf history...');
  let merkleResult = buildMerkleProofFromLeavesV3({
    leavesByIndex,
    targetLeafIndex: receipt.leafIndex,
  });

  // Root pre-flight. A rebuilt root the pool has never published means the
  // proof would be refused at the END of a ~78-chunk upload, so this check
  // is worth its two RPC calls.
  onProgress?.('Pre-flight root verification...');
  const { parsePoolAccount } = await import('./parsePool');
  const poolAcct = await connection.getAccountInfo(poolConfig.poolPDA, 'confirmed');
  if (poolAcct) {
    const parsed = parsePoolAccount(poolAcct.data);
    if (parsed) {
      const known = (root: bigint): boolean => {
        const b = new Uint8Array(goldilocksToLeBytes32(root));
        return bytesEqual(b, parsed.currentRoot) || parsed.historicalRoots.some((r) => bytesEqual(b, r));
      };
      if (!known(merkleResult.root)) {
        onProgress?.('Root not in ring — retrying event scan with extended limit...');
        const retry = await fetchPoolLeavesByIndex(connection, poolConfig.poolPDA, {
          maxSignatures: SIG_SCAN_LIMIT * 2,
          fresh: true,
          onStep: onProgress,
          minLeafCount: receipt.leafIndex + 1,
        });
        merkleResult = buildMerkleProofFromLeavesV3({
          leavesByIndex: retry.leavesByIndex,
          targetLeafIndex: receipt.leafIndex,
        });
        if (!known(merkleResult.root)) {
          // V4Unprovable, not Error: the note is fine and the prover is fine —
          // this rebuild could not place the note's root in the pool's ring, and
          // the C1 + C3 path pre-flights the root from the other side, so the
          // caller may retry there. Nothing has been spent at this point; the
          // message below says so itself.
          throw new V4Unprovable(
            `PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots ` +
            `(current + ${parsed.historicalRoots.length} historical). Aborting before proof rent is spent. ` +
            `Wait ~10s for the RPC to index recent transactions, then retry.`,
          );
        }
      }
    } else {
      console.warn('[DenomPool/v4] PRE-FLIGHT skip — pool parser returned null (layout drift?)');
    }
  } else {
    console.warn('[DenomPool/v4] PRE-FLIGHT skip — pool account fetch returned null');
  }

  // 11 / 4 split. `buildMerkleProofFromLeavesV3` returns the full depth-15 path
  // and the two halves go to different verifiers: the first eleven levels are
  // proven in the circuit, the last four are walked on chain.
  if (merkleResult.pathElements.length < C7_SUBTREE_DEPTH) {
    // V4Unprovable for the same reason as the root pre-flight above: a path this
    // circuit cannot consume is a fact about the note, and the pair can still
    // spend it. Defence in depth: the builder above pushes one element per
    // level for MERKLE_DEPTH = 15 levels unconditionally, so this cannot fire
    // against today's builder (spendRouting.test.ts measures that).
    throw new V4Unprovable(
      `Merkle path is ${merkleResult.pathElements.length} deep; circuit 7 needs at least ${C7_SUBTREE_DEPTH}.`,
    );
  }
  const U64 = U64_MASK_V3;
  const circuitElements = merkleResult.pathElements.slice(0, C7_SUBTREE_DEPTH).map((e) => e & U64);
  const circuitIndices = merkleResult.pathIndices.slice(0, C7_SUBTREE_DEPTH);
  const siblings = merkleResult.pathElements.slice(C7_SUBTREE_DEPTH).map((e) => e & U64);
  const directions = merkleResult.pathIndices.slice(C7_SUBTREE_DEPTH);

  const rhLimbs = recipientHashLimbs(recipient);

  const proofStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - proofStartedAt) / 1000);
    onProgress?.(`Proving ownership and membership in one trace (${seconds}s)...`);
  }, 10_000);
  let raw: { proofHex: string; publicInputs: string[]; proofSize: number };
  try {
    onProgress?.('Proving ownership and membership in one trace...');
    raw = await prove(
      receipt.nullifierPreimage.toString(),
      receipt.secret.toString(),
      // Named `depositEpoch` here and `noteBlinding` on the web twin: it is the
      // SAME field — the commitment's third input, which stopped being a real
      // epoch when blinding landed. `whyCircuit7Cannot` has already refused the
      // notes for which it is still an epoch.
      receipt.depositEpoch.toString(),
      receipt.tokenMint.toString(),
      circuitElements.map((e) => e.toString()),
      circuitIndices,
      rhLimbs.map((l) => l.toString()),
    );
  } finally {
    clearInterval(heartbeat);
  }

  const publicInputs = raw.publicInputs.map((v) => BigInt(v));
  // ⛔ THE THREE THROWS BELOW ARE PLAIN `Error` ON PURPOSE AND MUST STAY THAT WAY.
  // Everything above says "this note cannot go through this circuit"; these say
  // "the prover produced something circuit 7 does not produce" — a wrong felt
  // count, a transcript bound to a payee nobody asked for, or a nullifier the
  // chain refuses. Routing those to the C1 + C3 pair would answer a broken
  // prover by republishing the commitment and reporting a successful
  // withdrawal, which is the exact failure the pair exists to remove. They
  // fail closed.
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
  // The chain refuses any nullifier >= p (`unshield_denominated_stark_v4.rs`):
  // below 2**32 - 1 every value had a second encoding n + p that hashed to the
  // same felt but seeded a distinct nullifier PDA — a double-spend with no
  // forgery in it. A prover that emits a non-canonical felt is broken; say so
  // before the upload, not after.
  if (publicInputs[0] >= GOLDILOCKS_MODULUS) {
    throw new Error(
      `Circuit 7 published a non-canonical nullifier (${publicInputs[0]} >= Goldilocks p); the chain would refuse it.`,
    );
  }

  const proofBytes = new Uint8Array(Buffer.from(raw.proofHex, 'hex'));
  return {
    c7ProofResult: { proofBytes, publicInputs, proofSize: raw.proofSize },
    merkleRoot: merkleResult.root,
    subtreeRoot: publicInputs[1],
    nullifierGoldilocks: publicInputs[0],
    siblings,
    directions,
    recipient,
  };
}

/**
 * Submit the one proof, then spend. Mirrors `unshieldDenominatedStarkV3` on
 * this surface — same wallet / stealth-keypair fee-payer model, same close in
 * `finally` — with ONE buffer instead of two and no `stark_commitment` on the
 * wire.
 *
 * ⛔ `recipient` is passed again and CHECKED against the prepared one. It is not
 * redundant: the proof is bound to a payee, and executing for a different one
 * builds a transaction the chain refuses after the whole upload has been paid
 * for.
 *
 * ⛔ NON-UNIFORM upload on purpose. `submitAndVerifyStarkProofUniform` probes
 * circuits [1, 3, 5, 6] and cannot verify circuit 7; `submitAndVerifyStarkProof`
 * dispatches phase 1 + phase 2 (DEEP-ALI) for circuit ids 1..7, and phase 2 is
 * where ALL of C7's binding lives. The circuit id therefore travels in the init
 * instruction (the L13 leak the uniform pipeline closes for the pair). Known,
 * and the same trade the web and extension twins make.
 */
export async function unshieldDenominatedStarkV4(
  poolConfig: PoolConfig,
  recipient: PublicKey,
  prepared: PrepareUnshieldV4Result,
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
  overrideKeypair?: import('@solana/web3.js').Keypair,
): Promise<string> {
  if (!prepared.recipient.equals(recipient)) {
    throw new Error(
      `This proof was prepared for ${prepared.recipient.toBase58()} and cannot pay ` +
      `${recipient.toBase58()}. Circuit 7 binds sha256(recipient) into its transcript; ` +
      `re-run prepareUnshieldV4 for the new payee.`,
    );
  }

  const { submitAndConsumeStarkProof, closeStarkProofBuffer, getProofBufferPDA, MAX_TX_CU } = await import('../stark');
  const { CIRCUIT_SPEND } = await import('../stark/spendWitness');

  onProgress?.('Reading wallet...');
  const keypair = overrideKeypair || (walletSigner ? null : await getKeypair());
  if (!keypair && !walletSigner) throw new Error('Wallet not found');
  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  const starkSigner: WalletSigner = keypair
    ? {
        publicKey: keypair.publicKey,
        signTransaction: async (tx: Transaction) => { tx.sign(keypair); return tx; },
      }
    : walletSigner!;

  // Derived upfront so the `finally` can close it even if submit throws
  // mid-flight — the stealth signer is gone after this returns.
  const [c7ProofBuffer] = getProofBufferPDA(starkSigner.publicKey, CIRCUIT_SPEND);

  // [L3 2026-09-06] The spend instruction is built BEFORE the upload because
  // it rides in the SAME transaction as both verify phases and the close:
  // phase 1 878,756 + phase 2 192,715 + spend 176,404 = 1,247,875 CU, measured
  // on devnet 2026-09-02 (docs/BENCHMARK-2026-09-02.md), under the 1,400,000
  // per-transaction cap. A rejected proof reverts the whole transaction — no
  // nullifier, no rent lost — and an accepted one leaves no buffer behind.
  const nullifierBytes = goldilocksToLeBytes32(prepared.nullifierGoldilocks);
  const merkleRootBytes = goldilocksToLeBytes32(prepared.merkleRoot);
  const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);

  const isNativeSOL = poolConfig.tokenMint.equals(NATIVE_SOL_MINT);
  let tokenProgram: PublicKey | undefined;
  let recipientTokenAccount: PublicKey | undefined;
  let poolVault: PublicKey | undefined;
  if (!isNativeSOL) {
    tokenProgram = TOKEN_PROGRAM_ID;
    recipientTokenAccount = await getAssociatedTokenAddress(poolConfig.tokenMint, recipient);
    poolVault = poolConfig.vaultATA;
  }

  const ix = buildUnshieldDenominatedStarkV4Ix(
    walletPubkey,
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
  );
  const consumeIxs: TransactionInstruction[] = [];
  if (!isNativeSOL && recipientTokenAccount) {
    consumeIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        walletPubkey, recipientTokenAccount, recipient, poolConfig.tokenMint,
      ),
    );
  }
  consumeIxs.push(ix);

  let closed = false;
  try {
    onProgress?.('Submitting the circuit-7 spend proof on-chain...');
    const result = await submitAndConsumeStarkProof(
      {
        proofBytes: prepared.c7ProofResult.proofBytes,
        circuitId: CIRCUIT_SPEND,
        publicInputs: prepared.c7ProofResult.publicInputs,
        proofSize: prepared.c7ProofResult.proofSize,
      },
      {
        ixs: consumeIxs,
        cuLimit: MAX_TX_CU,
        cuPriceMicroLamports: 1000,
        // The relayer toggle keeps its meaning: the composed transaction goes
        // out through the same door the v3 spend used.
        send: (tx) => signAndSendV3(connection, tx, keypair, walletSigner),
      },
      starkSigner,
      onProgress,
      connection,
    );
    closed = result.closed;
    onProgress?.('V4 unshield confirmed!');
    return result.txSignature;
  } finally {
    // The composed transaction closes the buffer itself when it lands. Only a
    // failure between the upload and that landing leaves rent to recover.
    if (!closed) {
      try {
        onProgress?.('Closing proof buffer (rent recovery)...');
        await closeStarkProofBuffer(c7ProofBuffer, starkSigner, connection);
      } catch (closeErr: unknown) {
        console.warn(
          '[DenomPool/v4] closeStarkProofBuffer failed (rent may be stranded):',
          closeErr instanceof Error ? closeErr.message : String(closeErr),
        );
      }
    }
  }
}

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
  // Args: nullifier[32] + merkle_root[32] + min_epoch u64 + stark_commitment u64
  //     + recipient[32] + subtree_root u64 + Vec<u64> siblings + Vec<u8> directions
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
  // min_epoch @ byte 72 — pinned to 0 on every path. See UNSHIELD_MIN_EPOCH.
  data.writeBigUInt64LE(UNSHIELD_MIN_EPOCH, offset); offset += 8;
  data.writeBigUInt64LE(starkCommitment, offset); offset += 8;
  // recipient as 32-byte instruction arg (matches `recipient: [u8; 32]` in Rust)
  Buffer.from(recipient.toBytes()).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(subtreeRoot, offset); offset += 8;
  data.writeUInt32LE(siblings.length, offset); offset += 4;
  for (const sib of siblings) { data.writeBigUInt64LE(sib, offset); offset += 8; }
  data.writeUInt32LE(directions.length, offset); offset += 4;
  for (const dir of directions) { data.writeUInt8(dir, offset); offset += 1; }

  // Account ordering must match `UnshieldDenominatedStarkV3` struct.
  // `recipient` is NOT in the named accounts list — it goes in remaining_accounts[0].
  // Phase E v1: fee_escrow is a per-pool PDA (deployed 2026-05-07).
  const [feeEscrowPDA] = deriveFeeEscrowPDA(poolPDA);

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    // recipient removed from named accounts — moved to remaining_accounts[0] below
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: treePDA, isSigner: false, isWritable: false },
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },
    { pubkey: c1ProofBuffer, isSigner: false, isWritable: false },
    { pubkey: c3ProofBuffer, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: tokenProgram || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: poolVault || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!poolVault },
    { pubkey: recipientTokenAccount || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!recipientTokenAccount },
    { pubkey: feeEscrowPDA, isSigner: false, isWritable: true },
    // remaining_accounts[0]: recipient (no IDL label, indexers see anonymous AccountInfo)
    { pubkey: recipient, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/** Build `transfer_denominated_stark_v3`. Args:
 *  nullifier[32], merkle_root[32] (POOL root, must be in pool ring), min_epoch u64,
 *  stark_commitment u64 (old leaf), new_commitment[32],
 *  c6_old_subtree_root u64, c6_new_subtree_root u64,
 *  new_subtrees: Vec<[u8;32]> (depth entries — levels 1..=depth from C6),
 *  subtree_root u64, siblings Vec<u64>, directions Vec<u8>.
 *
 *  ⛔ `new_root[32]` LEFT THIS LAYOUT ON 2026-08-29 and TWO walks took its place.
 *  Transfer is the only path paying for both: it READS a note (C3 depth 12 →
 *  `spend_root::resolve_pool_root` over caller siblings, safe because the result
 *  must already be in the pool's history) and WRITES one (C6 depth 12 →
 *  `insert_root::fold_insertion` against the POOL ACCOUNT's `filled_subtrees`,
 *  which must NOT come from the caller — there is no history to check a freshly
 *  written root against).
 *  Account ordering must match `TransferDenominatedStarkV3` struct in
 *  programs/zk_shielded/src/instructions/transfer_denominated_stark_v3.rs.
 */
function buildTransferDenominatedStarkV3Ix(
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
  c6OldSubtreeRoot: bigint,
  c6NewSubtreeRoot: bigint,
  newSubtreesBytes: number[][],
  subtreeRoot: bigint,
  siblings: bigint[],
  directions: number[],
): TransactionInstruction {
  const disc = getDiscriminator('transfer_denominated_stark_v3');
  if (siblings.length !== directions.length) {
    throw new Error(
      `siblings (${siblings.length}) and directions (${directions.length}) must have ` +
      `equal length — the on-chain walk refuses a mismatch with WrongSiblingCount.`,
    );
  }
  if (directions.some((d) => d !== 0 && d !== 1)) {
    throw new Error('direction bits must be 0 or 1 — NonBinaryDirection on chain.');
  }
  const subtreesBytesLen = 4 + newSubtreesBytes.length * 32;
  const data = Buffer.alloc(
    8 + 32 + 32 + 8 + 8 + 32 + 8 + 8 + subtreesBytesLen
      + 8 + (4 + siblings.length * 8) + (4 + directions.length),
  );
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(nullifierBytes).copy(data, offset); offset += 32;
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(minEpoch, offset); offset += 8;
  data.writeBigUInt64LE(starkCommitment, offset); offset += 8;
  Buffer.from(newCommitmentBytes).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(c6OldSubtreeRoot, offset); offset += 8;
  data.writeBigUInt64LE(c6NewSubtreeRoot, offset); offset += 8;
  data.writeUInt32LE(newSubtreesBytes.length, offset); offset += 4;
  for (const st of newSubtreesBytes) {
    Buffer.from(st).copy(data, offset);
    offset += 32;
  }
  data.writeBigUInt64LE(subtreeRoot, offset); offset += 8;
  data.writeUInt32LE(siblings.length, offset); offset += 4;
  for (const sib of siblings) { data.writeBigUInt64LE(sib, offset); offset += 8; }
  data.writeUInt32LE(directions.length, offset); offset += 4;
  for (const dir of directions) { data.writeUInt8(dir, offset); offset += 1; }

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: treePDA, isSigner: false, isWritable: true },
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },
    { pubkey: c1ProofBuffer, isSigner: false, isWritable: false },
    { pubkey: c3ProofBuffer, isSigner: false, isWritable: false },
    { pubkey: c6ProofBuffer, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

// ---------------------------------------------------------------------------
// V3 high-level flow functions
// ---------------------------------------------------------------------------

/**
 * V3 shield — orchestrates (1) C6 proof submit + verify, (2) shield_denominated_v3.
 *
 * Caller must have already generated the C6 STARK proof via the StarkProver
 * provider (`generateMerkleUpdateProof` — already wired into ZkService).
 * `c6ProofResult` is the GenericStarkProofResult for circuit 6:
 *   publicInputs = [old_leaf=0, new_leaf=commitment_u64, old_root_u64,
 *                   new_root_u64, depth_u64]
 *
 * The C6 STARK proof verification happens in PRIOR transactions (init →
 * upload chunks → verify_stark_proof_v2 → verify_deep_ali_phase2). The
 * V3 shield tx then references the verified buffer PDA.
 *
 * Returns the shield tx signature + the buffer PDA so the caller can close
 * it later (rent recovery).
 */
export async function shieldV3(
  poolConfig: PoolConfig,
  // C6 proof from StarkProver.generateMerkleUpdateProof — circuitId must be 6.
  c6ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  // Plain pool insert state (the values witnessed by the C6 proof).
  insertParams: {
    commitment: bigint;
    newRoot: bigint;
    newSubtrees: bigint[];
    secret: bigint;
    nullifierPreimage: bigint;
    depositEpoch: bigint;
    leafIndex: number;
  },
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
  overrideKeypair?: import('@solana/web3.js').Keypair,
): Promise<{ txSig: string; receipt: ShieldReceipt; c6ProofBuffer: PublicKey }> {
  // [PERF 2026-09-06] NON-UNIFORM pipeline, like the web twin. The uniform
  // pipeline (Phase C v1, 2026-05-07) padded every proof to 145,000 bytes to
  // hide the circuit id and the proof size (L13 / L14): that is 145 chunks and
  // 14 resizes for an 82 KB proof, and this surface's circuit-7 spends already
  // put the circuit id in the init instruction. The deposit now uploads its
  // real 83 chunks, and the shield instruction rides in the SAME transaction
  // as phase 2 and the close (L3): phase 1 alone is 1,316,491 CU, so it keeps
  // its own transaction. 14 sequential confirmations become 5.
  const { submitAndConsumeStarkProof, closeStarkProofBuffer, getProofBufferPDA, CIRCUIT_MERKLE_UPDATE } =
    await import('../stark');

  onProgress?.('Reading wallet...');
  const keypair = overrideKeypair || (walletSigner ? null : await getKeypair());
  if (!keypair && !walletSigner) throw new Error('Wallet not found');
  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  const starkSigner: WalletSigner = keypair
    ? {
        publicKey: keypair.publicKey,
        signTransaction: async (tx: Transaction) => { tx.sign(keypair); return tx; },
      }
    : walletSigner!;

  // Known before the upload: the buffer authority is the depositor, and
  // `shield_denominated_v3` binds `proof_buffer.authority == depositor`.
  const [c6ProofBuffer] = getProofBufferPDA(starkSigner.publicKey, CIRCUIT_MERKLE_UPDATE);

  // 1. Build shield_denominated_v3 against the buffer the upload will fill.
  onProgress?.('Building V3 shield transaction...');
  const isNativeSOL = poolConfig.tokenMint.equals(NATIVE_SOL_MINT);
  let tokenProgram: PublicKey | undefined;
  let userTokenAccount: PublicKey | undefined;
  let poolVault: PublicKey | undefined;
  if (!isNativeSOL) {
    tokenProgram = TOKEN_PROGRAM_ID;
    userTokenAccount = await getAssociatedTokenAddress(poolConfig.tokenMint, walletPubkey);
    poolVault = poolConfig.vaultATA;
  }

  // [C6-D12] The two SUBTREE roots the instruction now takes, read straight
  // out of the proof's own public inputs
  // ([old_leaf, new_leaf, old_root, new_root, depth]) rather than recomputed.
  // The circuit derived them from the same 12 path elements it proved over, so
  // there is no second implementation of the walk to disagree with the first.
  //
  // ⛔ `insertParams.newRoot` IS NO LONGER SENT. It is the POOL root from the
  // client's own tree, and the program computes that itself now.
  if (c6ProofResult.publicInputs.length !== 5) {
    throw new Error(
      `C6 returned ${c6ProofResult.publicInputs.length} public inputs, expected 5 ` +
      `[old_leaf, new_leaf, old_root, new_root, depth]. The prover wire changed.`,
    );
  }
  if (c6ProofResult.publicInputs[4] !== BigInt(C6_SUBTREE_DEPTH)) {
    throw new Error(
      `C6 proved depth ${c6ProofResult.publicInputs[4]}, expected ${C6_SUBTREE_DEPTH}. ` +
      `The shipped wasm prover is stale — it predates the depth cut, and the ` +
      `on-chain verifier rejects every proof it makes. Reship the blob.`,
    );
  }
  const commitmentBytes = goldilocksToLeBytes32(insertParams.commitment);
  const oldSubtreeRootBytes = goldilocksToLeBytes32(c6ProofResult.publicInputs[2]);
  const newSubtreeRootBytes = goldilocksToLeBytes32(c6ProofResult.publicInputs[3]);
  const newSubtreesBytes = insertParams.newSubtrees.map(goldilocksToLeBytes32);

  const ix = buildShieldDenominatedV3Ix(
    walletPubkey,
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
  const consumeIxs: TransactionInstruction[] = [];
  if (!isNativeSOL && userTokenAccount) {
    consumeIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        walletPubkey, userTokenAccount, walletPubkey, poolConfig.tokenMint,
      ),
    );
  }
  consumeIxs.push(ix);

  // 2. Upload + verify phase 1, then [phase 2 + shield + close] in one tx.
  let closed = false;
  try {
    onProgress?.('Submitting C6 (merkle_update) proof on-chain...');
    const result = await submitAndConsumeStarkProof(
      {
        proofBytes: c6ProofResult.proofBytes,
        circuitId: CIRCUIT_MERKLE_UPDATE,
        publicInputs: c6ProofResult.publicInputs,
        proofSize: c6ProofResult.proofSize,
      },
      {
        ixs: consumeIxs,
        // Phase 2 (~190,000) + the shield: 302,672 measured at depth 15, and
        // the fold grows to ~552,000 at the depth-19 pools that are coming
        // (16 on-chain `hash2` at ~34,469 CU each). 1,000,000 is headroom for
        // both, not a measurement of this handler's total.
        cuLimit: 1_000_000,
        cuPriceMicroLamports: 1000,
        send: (tx) => signAndSendV3(connection, tx, keypair, walletSigner),
      },
      starkSigner,
      onProgress,
      connection,
    );
    closed = result.closed;
    const txSig = result.txSignature;
    onProgress?.('V3 shield confirmed!');

    const receipt: ShieldReceipt = {
      secret: insertParams.secret,
      nullifierPreimage: insertParams.nullifierPreimage,
      depositEpoch: insertParams.depositEpoch,
      tokenMint: pubkeyToField(poolConfig.tokenMint),
      commitment: insertParams.commitment,
      leafIndex: insertParams.leafIndex,
      denomination: poolConfig.denominationAtomic,
      pool: poolConfig.poolPDA.toBase58(),
      token: poolConfig.token,
      denominationHuman: poolConfig.denomination,
      shieldedAt: Date.now(),
      // Note: the path/root stored here are Goldilocks values. Downstream
      // unshieldV3 uses these directly without conversion.
      merkleRoot: insertParams.newRoot,
    };
    return { txSig, receipt, c6ProofBuffer };
  } finally {
    // The composed transaction closes the buffer when it lands; anything that
    // failed between the upload and that landing still has rent to recover.
    if (!closed) {
      try {
        onProgress?.('Closing proof buffer...');
        await closeStarkProofBuffer(c6ProofBuffer, starkSigner, connection);
      } catch (closeErr: any) {
        console.warn('[DenomPool/V3] closeStarkProofBuffer (shield) failed:', closeErr?.message ?? String(closeErr));
      }
    }
  }
}

/**
 * V3 unshield — orchestrates 3 STARK txs + the unshield ix:
 *   (1) submit + verify C1 (pool_commitment) proof   → c1ProofBuffer
 *   (2) submit + verify C3 (merkle_path) proof       → c3ProofBuffer
 *   (3) build + send `unshield_denominated_stark_v3` referencing both buffers
 *   (4) close both buffers (rent recovery)
 *
 * Both proofs are authored by the same `payer` (the on-chain handler enforces
 * `c1.authority == c3.authority == payer`). With overrideKeypair we use a
 * stealth keypair as the payer to break the link to the user's wallet.
 *
 * `c1ProofResult.publicInputs = [nullifier_u64, commitment_u64]`
 * `c3ProofResult.publicInputs = [leaf_u64, root_u64, ...]` — TODO(c3-public-inputs)
 *   confirm exact layout once the on-chain `verify_c3_proof_buffer` hash is
 *   finalized (see TODO in unshield_denominated_stark_v3.rs:239).
 */
export async function unshieldDenominatedStarkV3(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  recipient: PublicKey,
  c1ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  c3ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  // [C3-D12] The walk above the circuit. REQUIRED, and deliberately positional
  // rather than optional: every caller that has not been updated must fail to
  // COMPILE. An optional argument would let a screen keep sending a depth-12
  // proof with no walk, which the chain refuses only after the whole upload.
  //
  // `merkleRoot` is the POOL root, from the caller's own tree walk. ⛔ It is NOT
  // `c3ProofResult.publicInputs[1]` — that is the depth-12 SUBTREE root now, and
  // this function used to read it as the pool root.
  walk: { merkleRoot: bigint; siblings: bigint[]; directions: number[] },
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
  overrideKeypair?: import('@solana/web3.js').Keypair,
): Promise<string> {
  // Phase C v1 (deployed 2026-05-07): use uniform STARK pipeline for V3.
  const {
    submitAndVerifyStarkProofUniform,
    closeStarkProofBuffer,
    CIRCUIT_POOL_COMMITMENT,
    CIRCUIT_MERKLE_PATH,
  } = await import('../stark');

  onProgress?.('Reading wallet...');
  const keypair = overrideKeypair || (walletSigner ? null : await getKeypair());
  if (!keypair && !walletSigner) throw new Error('Wallet not found');
  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  const starkSigner: WalletSigner = keypair
    ? {
        publicKey: keypair.publicKey,
        signTransaction: async (tx: Transaction) => { tx.sign(keypair); return tx; },
      }
    : walletSigner!;

  // PDAs are randomized per call (16-byte nonce); we collect them as we go.
  const createdBuffers: PublicKey[] = [];
  let c1ProofBuffer: PublicKey;
  let c3ProofBuffer: PublicKey;

  try {
    // Step 1: C1 (pool_commitment) — same as v2 unshield.
    onProgress?.('Submitting C1 (pool_commitment) proof on-chain (uniform)...');
    const c1Result = await submitAndVerifyStarkProofUniform(
      {
        proofBytes: c1ProofResult.proofBytes,
        circuitId: CIRCUIT_POOL_COMMITMENT,
        publicInputs: c1ProofResult.publicInputs,
        proofSize: c1ProofResult.proofSize,
      },
      starkSigner,
      onProgress,
      connection,
    );
    c1ProofBuffer = c1Result.proofBuffer;
    createdBuffers.push(c1ProofBuffer);

    // Step 2: C3 (merkle_path) — NEW in V3.
    onProgress?.('Submitting C3 (merkle_path) proof on-chain (uniform)...');
    const c3Result = await submitAndVerifyStarkProofUniform(
      {
        proofBytes: c3ProofResult.proofBytes,
        circuitId: CIRCUIT_MERKLE_PATH,
        publicInputs: c3ProofResult.publicInputs,
        proofSize: c3ProofResult.proofSize,
      },
      starkSigner,
      onProgress,
      connection,
    );
    c3ProofBuffer = c3Result.proofBuffer;
    createdBuffers.push(c3ProofBuffer);

    // Step 3: Build + send unshield_denominated_stark_v3.
    onProgress?.('Building V3 unshield transaction...');
    const goldilocksNullifier = c1ProofResult.publicInputs[0] ?? 0n;
    const nullifierBytes = goldilocksToLeBytes32(goldilocksNullifier);
    // Extract the merkle root from the C3 proof's public inputs (layout
    // [leaf, root, depth] per stark/src/air/merkle_path.rs:67). This is the
    // canonical source — `receipt.merkleRoot` from a recovered note is
    // undefined and the screen's local mutation doesn't survive into the
    // store action's fresh receipt read.
    //
    // 🚨 THIS LINE READ `c3ProofResult.publicInputs[1]` UNTIL 2026-08-29. Since
    // the depth cut that value is the root of the twelve-level SUBTREE the note
    // sits in, so the pre-flight below would have failed it against the pool's
    // known-root ring — correctly, but for a reason naming nothing. The pool
    // root now comes from the caller's tree walk; the subtree root comes from
    // the proof; the on-chain walk is what ties one to the other.
    const subtreeRootGl = c3ProofResult.publicInputs[1] ?? 0n;
    if (c3ProofResult.publicInputs[2] !== BigInt(C3_SUBTREE_DEPTH)) {
      throw new Error(
        `C3 proved depth ${c3ProofResult.publicInputs[2]}, expected ${C3_SUBTREE_DEPTH}. ` +
        `The shipped wasm prover is stale — it predates the depth cut, and the ` +
        `on-chain verifier rejects every proof it makes. Reship the blob.`,
      );
    }
    const merkleRootGl = walk.merkleRoot;
    const merkleRootBytes = goldilocksToLeBytes32(merkleRootGl);
    const starkCommitment = c1ProofResult.publicInputs[1] ?? 0n;

    // Pre-flight root verification — without this the unshield can fail with
    // InvalidMerkleRoot on-chain after burning ~2 SOL of STARK proof rent + 7
    // minutes of upload, simply because `fetchPoolLeavesByIndex` missed an
    // event (Helius 429, slow indexing of just-shielded note). Verify the
    // c3Root is in the pool's known set BEFORE submitting; if not, retry the
    // leaf scan with a higher `maxSignatures` and rebuild the proof tree once.
    {
      const { parsePoolAccount } = await import('./parsePool');
      const poolAcct = await connection.getAccountInfo(poolConfig.poolPDA, 'confirmed');
      if (poolAcct) {
        const parsed = parsePoolAccount(poolAcct.data);
        if (parsed) {
          const eq = (a: Uint8Array, b: Uint8Array) => {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
            return true;
          };
          const target = new Uint8Array(merkleRootBytes);
          const inCurrent = eq(target, parsed.currentRoot);
          const inHist = parsed.historicalRoots.some(r => eq(target, r));
          const hex = (u: Uint8Array) => Array.from(u).map(b => b.toString(16).padStart(2, '0')).join('');
          if (!inCurrent && !inHist) {
            console.error(
              `[Unshield/V3] PRE-FLIGHT FAIL — c3Root not in pool known roots. ` +
              `c3Root=0x${hex(target).slice(0, 24)}…  ` +
              `current=0x${hex(parsed.currentRoot).slice(0, 24)}…  ` +
              `histLen=${parsed.historicalRoots.length}  ` +
              `nextLeafIdx=${parsed.nextLeafIndex}  ` +
              `noteCount=${parsed.noteCount}`,
            );
            console.error(`[Unshield/V3] historicalRoots dump:`);
            parsed.historicalRoots.forEach((r, i) => console.error(`  [${i}] 0x${hex(r).slice(0, 24)}…`));
            throw new Error(
              `c3Root not in pool known roots — likely an incomplete event scan ` +
              `(missed LeafInserted on devnet). Aborting before burning STARK rent. ` +
              `Try again in ~10s once Helius indexes catch up, or restart the app to bust the leaf cache.`,
            );
          }
          console.log(
            `[Unshield/V3] PRE-FLIGHT OK — c3Root matches ${inCurrent ? 'pool.currentRoot' : 'historicalRoots[' + parsed.historicalRoots.findIndex(r => eq(target, r)) + ']'}`,
          );
        } else {
          console.warn('[Unshield/V3] PRE-FLIGHT skip — pool parser returned null (layout drift?)');
        }
      } else {
        console.warn('[Unshield/V3] PRE-FLIGHT skip — pool account fetch returned null');
      }
    }

    // min_epoch is no longer passed in: the builder pins it to
    // UNSHIELD_MIN_EPOCH (0). The V3 handler ignores the argument
    // (unshield_denominated_stark_v3.rs:387), so the previous
    // `slotToEpoch(await connection.getSlot())` bought nothing and cost one
    // RPC round trip.

    const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);

    const isNativeSOL = poolConfig.tokenMint.equals(NATIVE_SOL_MINT);
    let tokenProgram: PublicKey | undefined;
    let recipientTokenAccount: PublicKey | undefined;
    let poolVault: PublicKey | undefined;
    if (!isNativeSOL) {
      tokenProgram = TOKEN_PROGRAM_ID;
      recipientTokenAccount = await getAssociatedTokenAddress(poolConfig.tokenMint, recipient);
      poolVault = poolConfig.vaultATA;
    }

    const ix = buildUnshieldDenominatedStarkV3Ix(
      walletPubkey,
      recipient,
      poolConfig.poolPDA,
      poolConfig.treePDA,
      nullifierPDA,
      c1ProofBuffer,
      c3ProofBuffer,
      nullifierBytes,
      merkleRootBytes,
      starkCommitment,
      subtreeRootGl,
      walk.siblings,
      walk.directions,
      tokenProgram,
      poolVault,
      recipientTokenAccount,
    );

    const tx = new Transaction();
    // [C3-D12] 300,000 -> 400,000. One on-chain `hash2` is ~34,469 CU (measured
    // 2026-08-29, litesvm SBF VM), so the three levels the handler now walks add
    // ~103,400. 400,000 is what the v4 path already requests for the same walk.
    tx.add(...buildComputeBudgetIxs(400_000));
    if (!isNativeSOL && recipientTokenAccount) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          walletPubkey, recipientTokenAccount, recipient, poolConfig.tokenMint,
        ),
      );
    }
    tx.add(ix);

    onProgress?.('Sending V3 unshield transaction...');
    const sig = await signAndSendV3(connection, tx, keypair, walletSigner);
    onProgress?.('V3 unshield confirmed!');
    return sig;
  } finally {
    // Close every buffer that was successfully created/verified, regardless
    // of whether the final unshield tx succeeded.
    for (const buf of createdBuffers) {
      try {
        onProgress?.('Closing proof buffer...');
        await closeStarkProofBuffer(buf, starkSigner, connection);
      } catch (closeErr: any) {
        console.warn('[DenomPool/V3] closeStarkProofBuffer (unshield) failed:', closeErr?.message ?? String(closeErr));
      }
    }
  }
}

/**
 * V3 transfer — orchestrates 4 STARK txs + the transfer ix:
 *   (1) submit + verify C1 (pool_commitment)  → c1ProofBuffer
 *   (2) submit + verify C3 (merkle_path)      → c3ProofBuffer
 *   (3) submit + verify C6 (merkle_update)    → c6ProofBuffer
 *   (4) build + send `transfer_denominated_stark_v3` referencing all three
 *   (5) close all three buffers (rent recovery)
 *
 * All proofs must share the same `payer` (the on-chain handler enforces
 * `c1.authority == c3.authority == c6.authority == payer`). The caller
 * supplies a stealth keypair via `overrideKeypair` to break wallet linkage.
 *
 * Public-input convention (matches on-chain hash reconstruction):
 *   `c1ProofResult.publicInputs = [old_nullifier_u64, old_commitment_u64]`
 *   `c3ProofResult.publicInputs = [old_commitment_u64, old_root_u64]`
 *   `c6ProofResult.publicInputs = [0, new_commitment_u64, current_root_u64,
 *                                  new_root_u64, depth_u64]`
 *
 * `merkleRoot` is the root the C3 proof targeted (must be in
 * `pool.historical_roots`). It can differ from C6's `current_root_u64` —
 * C3 reads any historical root, C6 must witness against the LATEST root the
 * tree had when this tx was built.
 */
export async function transferDenominatedStarkV3(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  c1ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  c3ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  c6ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  insertParams: {
    newCommitment: bigint;
    /** Client-side tree bookkeeping only; NOT sent to the program any more. */
    newRoot: bigint;
    newSubtrees: bigint[];   // depth entries — levels 1..=depth, NOT including the leaf
    newSecret: bigint;
    newNullifierPreimage: bigint;
    newDepositEpoch: bigint;
    newLeafIndex: number;
  },
  // [C3-D12] The READ side's walk, above the C3 circuit. REQUIRED and positional
  // so an un-updated caller fails to COMPILE rather than at the end of three
  // proof uploads. `merkleRoot` is the POOL root of the note being spent, from
  // the caller's own tree walk — ⛔ NOT `c3ProofResult.publicInputs[1]`.
  //
  // The WRITE side's roots are not here on purpose: they come from C6's own
  // public inputs below, and its top levels come from the pool account on chain.
  walk: { merkleRoot: bigint; siblings: bigint[]; directions: number[] },
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
  overrideKeypair?: import('@solana/web3.js').Keypair,
): Promise<{ txSig: string; recipientNote: ShareableNote }> {
  // Phase C v1 (deployed 2026-05-07): use uniform STARK pipeline for V3.
  const {
    submitAndVerifyStarkProofUniform,
    closeStarkProofBuffer,
    CIRCUIT_POOL_COMMITMENT,
    CIRCUIT_MERKLE_PATH,
    CIRCUIT_MERKLE_UPDATE,
  } = await import('../stark');

  onProgress?.('Reading wallet...');
  const keypair = overrideKeypair || (walletSigner ? null : await getKeypair());
  if (!keypair && !walletSigner) throw new Error('Wallet not found');
  const connection = getConnection();

  const starkSigner: WalletSigner = keypair
    ? {
        publicKey: keypair.publicKey,
        signTransaction: async (tx: Transaction) => { tx.sign(keypair); return tx; },
      }
    : walletSigner!;

  // PDAs are randomized per call (16-byte nonce); we collect them as we go.
  const createdBuffers: PublicKey[] = [];
  let c1ProofBuffer: PublicKey;
  let c3ProofBuffer: PublicKey;
  let c6ProofBuffer: PublicKey;

  try {
    // Maturity / epoch math (mirrors v2 transferNoteStark)
    onProgress?.('Reading pool state...');
    const slot = await connection.getSlot('confirmed');
    const currentEpoch = slotToEpoch(slot);
    const poolInfo = await fetchPoolInfo(connection, poolConfig);
    if (!poolInfo) throw new Error('Pool not found');
    const totalDelay = poolInfo.epochDelay + BigInt(poolInfo.dynamicDelay);
    const minEpoch = currentEpoch - totalDelay;

    // 1. C1 — proves ownership of OLD note.
    onProgress?.('Submitting C1 (pool_commitment) proof on-chain (uniform)...');
    const c1Result = await submitAndVerifyStarkProofUniform(
      {
        proofBytes: c1ProofResult.proofBytes,
        circuitId: CIRCUIT_POOL_COMMITMENT,
        publicInputs: c1ProofResult.publicInputs,
        proofSize: c1ProofResult.proofSize,
      },
      starkSigner,
      onProgress,
      connection,
    );
    c1ProofBuffer = c1Result.proofBuffer;
    createdBuffers.push(c1ProofBuffer);

    // 2. C3 — proves OLD commitment is at supplied merkle_root.
    onProgress?.('Submitting C3 (merkle_path) proof on-chain (uniform)...');
    const c3Result = await submitAndVerifyStarkProofUniform(
      {
        proofBytes: c3ProofResult.proofBytes,
        circuitId: CIRCUIT_MERKLE_PATH,
        publicInputs: c3ProofResult.publicInputs,
        proofSize: c3ProofResult.proofSize,
      },
      starkSigner,
      onProgress,
      connection,
    );
    c3ProofBuffer = c3Result.proofBuffer;
    createdBuffers.push(c3ProofBuffer);

    // 3. C6 — proves NEW commitment insertion against the current pool root.
    onProgress?.('Submitting C6 (merkle_update) proof on-chain (uniform)...');
    const c6Result = await submitAndVerifyStarkProofUniform(
      {
        proofBytes: c6ProofResult.proofBytes,
        circuitId: CIRCUIT_MERKLE_UPDATE,
        publicInputs: c6ProofResult.publicInputs,
        proofSize: c6ProofResult.proofSize,
      },
      starkSigner,
      onProgress,
      connection,
    );
    c6ProofBuffer = c6Result.proofBuffer;
    createdBuffers.push(c6ProofBuffer);

    // 4. Build + send transfer_denominated_stark_v3 referencing all three buffers.
    onProgress?.('Building V3 transfer transaction...');
    const goldilocksNullifier = c1ProofResult.publicInputs[0] ?? 0n;
    const nullifierBytes = goldilocksToLeBytes32(goldilocksNullifier);

    // 🚨 `c3ProofResult.publicInputs[1]` WAS READ AS THE POOL ROOT HERE UNTIL
    // 2026-08-29. Since the depth cut it is the root of the twelve-level SUBTREE
    // the spent note sits in, and passing it as `merkle_root` would name a root
    // no pool ever published — the handler's ring check would refuse every
    // transfer. The pool root comes from the caller's tree walk now.
    const subtreeRootGl = c3ProofResult.publicInputs[1] ?? 0n;
    if (c3ProofResult.publicInputs[2] !== BigInt(C3_SUBTREE_DEPTH)) {
      throw new Error(
        `C3 proved depth ${c3ProofResult.publicInputs[2]}, expected ${C3_SUBTREE_DEPTH}. ` +
        `The shipped wasm prover is stale — it predates the depth cut, and the ` +
        `on-chain verifier rejects every proof it makes. Reship the blob.`,
      );
    }
    const merkleRootBytes = goldilocksToLeBytes32(walk.merkleRoot);

    // [C6-D12] The WRITE side's two subtree roots, from C6's own public inputs
    // ([old_leaf, new_leaf, old_root, new_root, depth]).
    if (c6ProofResult.publicInputs.length !== 5) {
      throw new Error(
        `C6 returned ${c6ProofResult.publicInputs.length} public inputs, expected 5 ` +
        `[old_leaf, new_leaf, old_root, new_root, depth]. The prover wire changed.`,
      );
    }
    if (c6ProofResult.publicInputs[4] !== BigInt(C6_SUBTREE_DEPTH)) {
      throw new Error(
        `C6 proved depth ${c6ProofResult.publicInputs[4]}, expected ${C6_SUBTREE_DEPTH}. ` +
        `The shipped wasm prover is stale — it predates the depth cut, and the ` +
        `on-chain verifier rejects every proof it makes. Reship the blob.`,
      );
    }

    const starkCommitment = c1ProofResult.publicInputs[1] ?? 0n;
    const newCommitmentBytes = goldilocksToLeBytes32(insertParams.newCommitment);
    const newSubtreesBytes = insertParams.newSubtrees.map(goldilocksToLeBytes32);

    const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);

    const ix = buildTransferDenominatedStarkV3Ix(
      starkSigner.publicKey,
      poolConfig.poolPDA,
      poolConfig.treePDA,
      nullifierPDA,
      c1ProofBuffer,
      c3ProofBuffer,
      c6ProofBuffer,
      nullifierBytes,
      merkleRootBytes,
      minEpoch,
      starkCommitment,
      newCommitmentBytes,
      c6ProofResult.publicInputs[2],
      c6ProofResult.publicInputs[3],
      newSubtreesBytes,
      subtreeRootGl,
      walk.siblings,
      walk.directions,
    );

    onProgress?.('Sending V3 transfer transaction...');
    const tx = new Transaction();
    // [C3-D12 + C6-D12] 300,000 -> 800,000. Transfer is the ONLY path that pays
    // for both walks in one instruction: `resolve_pool_root` (3 hashes, ~103,400
    // CU) on the read side and `fold_insertion` (6 hashes, ~206,814 CU) on the
    // write side, at the ~34,469 CU per on-chain `hash2` measured 2026-08-29 on
    // the litesvm SBF VM. ⚠️ 800,000 is that sum plus the old budget, NOT an
    // end-to-end measurement of this handler.
    tx.add(...buildComputeBudgetIxs(800_000));
    tx.add(ix);
    const txSig = overrideKeypair
      ? await signAndSendV3(connection, tx, overrideKeypair, undefined)
      : await signAndSendV3(connection, tx, keypair, walletSigner);

    onProgress?.('V3 transfer confirmed!');

    const recipientNote: ShareableNote = {
      version: 1,
      pool: poolConfig.poolPDA.toBase58(),
      secret: insertParams.newSecret.toString(),
      nullifier_preimage: insertParams.newNullifierPreimage.toString(),
      deposit_epoch: insertParams.newDepositEpoch.toString(),
      token_mint: receipt.tokenMint.toString(),
      commitment: insertParams.newCommitment.toString(),
      leafIndex: insertParams.newLeafIndex,
      token: poolConfig.token,
      denominationHuman: poolConfig.denomination,
    };

    return { txSig, recipientNote };
  } finally {
    // Close every buffer that was successfully created/verified, regardless
    // of whether the final transfer tx succeeded.
    for (const buf of createdBuffers) {
      try {
        onProgress?.('Closing proof buffer...');
        await closeStarkProofBuffer(buf, starkSigner, connection);
      } catch (e: any) {
        console.warn('[DenomPool/V3] closeStarkProofBuffer (transfer) failed:', e?.message ?? String(e));
      }
    }
  }
}

// TODO(v3-split): port `splitNoteStark` to V3 once `split_note_stark_v3`
// ships. N output leaves require 1 C1 (source) + N C6 (one per output) proofs
// — orchestrate sequentially or chunk by tx-budget.
//
// TODO(v3-escrow-release): port `escrow_release_v3`.
// DROPPED, not a TODO: `cancel_private_stark_v3`. Cancellation and refunds
// were removed from the protocol; `cancel_private_stark` is deleted, so there
// is nothing to port to V3. A subscription is a one-way prepaid envelope and
// `claim_period` is its only exit.
// TODO(v3-prefund): port the p01_liquidity prefund path with the C1/C3 buffer
// pair (currently v2-only — see unshieldStark `instant` flag).

// ---------------------------------------------------------------------------
// Note import/export (backup & sharing)
// ---------------------------------------------------------------------------

export function exportNote(receipt: ShieldReceipt, poolConfig: PoolConfig): ShareableNote {
  return {
    version: 1,
    pool: receipt.pool,
    secret: receipt.secret.toString(),
    nullifier_preimage: receipt.nullifierPreimage.toString(),
    deposit_epoch: receipt.depositEpoch.toString(),
    token_mint: receipt.tokenMint.toString(),
    commitment: receipt.commitment.toString(),
    leafIndex: receipt.leafIndex,
    token: poolConfig.token,
    denominationHuman: poolConfig.denomination,
    shieldedAt: receipt.shieldedAt,
    merkle_path_elements: receipt.merklePathElements?.map(e => e.toString()),
    merkle_path_indices: receipt.merklePathIndices,
    merkle_root: receipt.merkleRoot?.toString(),
  };
}

export function importNote(noteData: ShareableNote): ShieldReceipt {
  if (noteData.version !== 1) {
    throw new Error(`Unsupported note version: ${noteData.version}`);
  }

  // V3 transfer outputs land in V3 pools; the receiver must be able to
  // import notes targeting either generation. ALL_POOLS_V3 is checked first
  // (V3 is the future default); falling back to ALL_POOLS preserves v2 import.
  const pool = ALL_POOLS_V3.find(p => p.poolPDA.toBase58() === noteData.pool)
    ?? ALL_POOLS.find(p => p.poolPDA.toBase58() === noteData.pool);
  if (!pool) {
    throw new Error(`Unknown pool: ${noteData.pool}`);
  }

  const secret = BigInt(noteData.secret);
  const nullifierPreimage = BigInt(noteData.nullifier_preimage);
  const depositEpoch = BigInt(noteData.deposit_epoch);
  const tokenMint = BigInt(noteData.token_mint);

  // Verify commitment with the hash function matching the pool generation.
  // V3 = Goldilocks Poseidon t=5 (`createCommitmentV3`); v2 = BN254 Poseidon
  // t=4 (`createCommitment`). Mixing them silently produces a "commitment
  // does not match secrets" error that masks the real cause.
  const expectedCommitment = pool.version === 'v3'
    ? createCommitmentV3(nullifierPreimage, secret, depositEpoch, tokenMint)
    : createCommitment(nullifierPreimage, secret, depositEpoch, tokenMint);
  const providedCommitment = BigInt(noteData.commitment);
  if (expectedCommitment !== providedCommitment) {
    throw new Error('Invalid note: commitment does not match secrets');
  }

  return {
    secret,
    nullifierPreimage,
    depositEpoch,
    tokenMint,
    commitment: providedCommitment,
    leafIndex: noteData.leafIndex,
    denomination: pool.denominationAtomic,
    pool: noteData.pool,
    token: noteData.token,
    denominationHuman: noteData.denominationHuman,
    shieldedAt: noteData.shieldedAt || Date.now(),
    merklePathElements: noteData.merkle_path_elements?.map(e => BigInt(e)),
    merklePathIndices: noteData.merkle_path_indices,
    merkleRoot: noteData.merkle_root ? BigInt(noteData.merkle_root) : undefined,
  };
}

export function encodeShareableNote(note: ShareableNote): string {
  return btoa(JSON.stringify(note));
}

export function decodeShareableNote(encoded: string): ShareableNote {
  return JSON.parse(atob(encoded));
}

// ---------------------------------------------------------------------------
// Receipt serialization (for persistent storage)
// ---------------------------------------------------------------------------

export function receiptToJSON(receipt: ShieldReceipt): string {
  return JSON.stringify({
    secret: receipt.secret.toString(),
    nullifierPreimage: receipt.nullifierPreimage.toString(),
    depositEpoch: receipt.depositEpoch.toString(),
    tokenMint: receipt.tokenMint.toString(),
    commitment: receipt.commitment.toString(),
    leafIndex: receipt.leafIndex,
    denomination: receipt.denomination.toString(),
    pool: receipt.pool,
    token: receipt.token,
    denominationHuman: receipt.denominationHuman,
    shieldedAt: receipt.shieldedAt,
    merklePathElements: receipt.merklePathElements?.map(e => e.toString()),
    merklePathIndices: receipt.merklePathIndices,
    merkleRoot: receipt.merkleRoot?.toString(),
  });
}

export function receiptFromJSON(json: string): ShieldReceipt {
  const obj = JSON.parse(json);
  return {
    secret: BigInt(obj.secret),
    nullifierPreimage: BigInt(obj.nullifierPreimage),
    depositEpoch: BigInt(obj.depositEpoch),
    tokenMint: BigInt(obj.tokenMint),
    commitment: BigInt(obj.commitment),
    leafIndex: obj.leafIndex,
    denomination: BigInt(obj.denomination),
    pool: obj.pool,
    token: obj.token || 'SOL',
    denominationHuman: obj.denominationHuman || 0,
    shieldedAt: obj.shieldedAt || 0,
    merklePathElements: obj.merklePathElements?.map((e: string) => BigInt(e)),
    merklePathIndices: obj.merklePathIndices,
    merkleRoot: obj.merkleRoot ? BigInt(obj.merkleRoot) : undefined,
  };
}

// ---------------------------------------------------------------------------
// PROVING ARCHITECTURE
// ---------------------------------------------------------------------------
// Proof generation uses a hidden WebView (DenominatedPoolProverProvider):
//   - snarkjs loaded from CDN inside the WebView (browser environment)
//   - Circuit files loaded from Expo assets → base64 → injected into WebView
//   - Proof inputs sent via postMessage, proof returned via onMessage
//   - ~1-3s proof time for 4,273 constraints on modern phones
//
// Why WebView, not direct snarkjs in React Native?
//   snarkjs depends on fastfile, circom_runtime, etc. which use Node.js APIs.
//   Metro shims these to empty modules. The WebView provides a proper browser
//   environment where snarkjs works out of the box.
//
// Future improvement (Plan B): Rust native prover via Expo Modules (JSI bridge)
//   - Build ark-circom as a native module → ~50ms proof time
//   - Eliminates snarkjs CDN dependency
//
// RULE #1: Private inputs NEVER leave the device.
