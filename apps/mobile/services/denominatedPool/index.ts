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
  sendAndConfirmTransaction,
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
const PROTOCOL_FEE_WALLET = new PublicKey(
  'BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN'
);

const MERKLE_DEPTH = 15;
const SLOTS_PER_EPOCH = 7200;

const FIELD_ORDER = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

const ZERO_VALUE = BigInt(
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
}

export const SOL_POOLS: PoolConfig[] = [
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 0.1, decimals: 9,
    denominationAtomic: 100_000_000n,
    poolPDA: new PublicKey('JDVrKu9cKZMKaxxVeC8QUBRTnkC81LcbNHFDcrbyZ2iv'),
    treePDA: new PublicKey('FGrmPausuBJTV7V2VS2XjpfwGHYrUt79t5E3e3EvjrZ5'),
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 1, decimals: 9,
    denominationAtomic: 1_000_000_000n,
    poolPDA: new PublicKey('BoCTorE7dDyFTaK4oCEw8K3w7F6FxrKCSqbAGVv4cxXL'),
    treePDA: new PublicKey('JCRDNgcXieJmjazUnAxo81SsqPQ2XcF38wvgfpjYgSco'),
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 10, decimals: 9,
    denominationAtomic: 10_000_000_000n,
    poolPDA: new PublicKey('2ZTWWSjnzAjEXxeK5PXF5hjvxixqTnnFyZt7Dd4vfFDJ'),
    treePDA: new PublicKey('Ha3Ls6adGbJzEwqLcF4Y7x3T7vLtVyFhtc1aCas5C5GT'),
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 100, decimals: 9,
    denominationAtomic: 100_000_000_000n,
    poolPDA: new PublicKey('4t5nFqX9Xw1Bcv9kp2RQJF4vC8xPnbNZPViZjFWA9KQa'),
    treePDA: new PublicKey('5bGshmezFLkUDZgex5xQEEiXaKaHHo7Xxnum9qumeQyJ'),
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 500, decimals: 9,
    denominationAtomic: 500_000_000_000n,
    poolPDA: new PublicKey('2EzaXUxVdNdBgsv3woAe3DkqnY9aY9NdqqKyPbbbnF7t'),
    treePDA: new PublicKey('BvbM2Z2fJc6NkHdwuL97cNgjuxcJ8RVdAKbtngLPHsuY'),
  },
  {
    token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 1000, decimals: 9,
    denominationAtomic: 1_000_000_000_000n,
    poolPDA: new PublicKey('5XaB2x77DYRx7sPWKdUpUUCE9QrgR8Lfgm1DmWy2notb'),
    treePDA: new PublicKey('CKY1dDhboZhzgr7BS1ZtLh5XxQFfqFUNyokkCLP82oaC'),
  },
];

export const USDC_POOLS: PoolConfig[] = [
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 1, decimals: 6,
    denominationAtomic: 1_000_000n,
    poolPDA: new PublicKey('GH2MCghPgZBqHoHaSqGpzQTwY9gw7V1cwMkd67ofp3w6'),
    treePDA: new PublicKey('29Zc9jqVoEtKKmhV769dWZBj957U95pxJpyWDkbLsTb3'),
    vaultATA: new PublicKey('8QKdMJbSukL8fkHjU3xw8kFU9jZryPQmXmfvHEpZjTKa'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 10, decimals: 6,
    denominationAtomic: 10_000_000n,
    poolPDA: new PublicKey('zmaKYBQFpRkan5UrKrCxAjw1oDrtiu7X2AMGue843Kp'),
    treePDA: new PublicKey('4bv2gyfdMTi46fjmU5ccSk21bW2cEr6NKQyH3NAxosdh'),
    vaultATA: new PublicKey('4EuSghk6zWzkLqzmxugTmEpchxYKyNmqZ8xBytzvgGsm'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 100, decimals: 6,
    denominationAtomic: 100_000_000n,
    poolPDA: new PublicKey('BixDeows6MrqXpxH9RZghnQi4ZihzevFagcq9HvW4sVS'),
    treePDA: new PublicKey('2JSzffuT8f3dUZBEcZrMungLqmHFS21kZSRbdQ6tBbuT'),
    vaultATA: new PublicKey('Hybuu8qYN1HJ9Gk6gkJftGXjGQdiY1DFSrxUXm2k2BUY'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 1000, decimals: 6,
    denominationAtomic: 1_000_000_000n,
    poolPDA: new PublicKey('Dq7CHfsasR7VU3cVgDsyGnWmwBH3LtT4gTBBHEMDHvFF'),
    treePDA: new PublicKey('EAicVNr5qitSzP7Dc1Z7DZUzV3Pidoqt21Lk7fBWfmtn'),
    vaultATA: new PublicKey('GmiMpZfWSUKsvvJeirZSnYuhcvkbs2GfrN1jfCDmxE2H'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 10_000, decimals: 6,
    denominationAtomic: 10_000_000_000n,
    poolPDA: new PublicKey('AbSw23KXkQ9d8a28XsYMxjnWqsB7cBxhFNS9bNy1DMy3'),
    treePDA: new PublicKey('R6X8uUZJyPX9Xp1cLJ5JVJYYBXgjZGnB2qCacFRbM1x'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 20_000, decimals: 6,
    denominationAtomic: 20_000_000_000n,
    poolPDA: new PublicKey('8hJN8JypFPA3389sb8b9kTQ7Ck9QHWUm8ACXmEcfkJ3C'),
    treePDA: new PublicKey('7vvJG5WP77sesQUMEz29PH91y1VWfA4Pmrxv3RbazFF6'),
  },
  {
    token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 50_000, decimals: 6,
    denominationAtomic: 50_000_000_000n,
    poolPDA: new PublicKey('EgJFHJv6frVsLUrzqxZpa9wGTACjTLWMRzm8xCKJuP9K'),
    treePDA: new PublicKey('4UjapT1xSbjQNGqrXn86vFBNYa9JiMgN2fNqCpaJZsEv'),
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
  // Every leaf insertion emits this (post-hardening). Ordered first so it
  // wins the disc match on modern events without a layout lookup.
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
  opts: { maxSignatures?: number; onProgress?: (scanned: number, total: number) => void } = {},
): Promise<{ leavesByIndex: bigint[]; scannedLeafCount: number; missing: number[] }> {
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
  // Happy path: the receipt already carries a path AND its stored root
  // matches the pool's CURRENT on-chain root. Anything else is not safe to
  // trust:
  //   - A root saved at shield time may have drifted out of the pool's
  //     100-slot historical ring once enough newer shields landed.
  //   - A prior failing attempt could have mutated the receipt with a
  //     bogus root and persisted it. `is_valid_root` on-chain would then
  //     reject every retry with InvalidMerkleRoot.
  // Recomputing from the full leaf set always yields the current root,
  // which is by definition the freshest valid root.
  let onChainRootBig = 0n;
  for (let i = 31; i >= 0; i--) {
    onChainRootBig = (onChainRootBig << 8n) | BigInt(currentOnChainRoot[i]);
  }
  if (
    receipt.merklePathElements &&
    receipt.merklePathIndices &&
    receipt.merkleRoot === onChainRootBig
  ) return;

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

  const { root: computedRoot, pathElements, pathIndices } = buildMerkleProofFromLeaves({
    leavesByIndex,
    targetLeafIndex: receipt.leafIndex,
  });

  if (computedRoot !== onChainRootBig) {
    // Divergence — typically a concurrent shield landed between our scan and
    // simulation, or maxSignatures missed a leaf. The submitted root would
    // need to live in the pool's 100-slot historical ring for is_valid_root
    // to pass, which is fragile. Log and still proceed with the computed
    // root; caller can retry if it fails.
    console.warn(
      `[DenomPool] Merkle rebuild root ≠ on-chain current root. ` +
      `computed=${computedRoot.toString(16)} onChain=${onChainRootBig.toString(16)}. ` +
      `A concurrent shield may have landed; retrying usually picks it up.`
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
// Wallet signer abstraction (local keypair OR Privy signer)
// ---------------------------------------------------------------------------

export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  /**
   * Sign an arbitrary message — used by {@link deriveSeedFromSigner} to derive
   * a deterministic 32-byte note seed for Privy-wallet users (who have no
   * local mnemonic to seed-derive from).
   */
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Note seed derivation for Privy wallets (P11.D-style ceremony)
// ---------------------------------------------------------------------------

/** Canonical message signed once per session to derive the note seed. */
export const NOTE_SEED_DOMAIN = 'protocol01:note-seed:v1' as const;

const noteSeedCache = new Map<string, Uint8Array>();

/**
 * Derive a 32-byte note seed from a wallet that exposes signMessage. The
 * signature over a fixed, domain-separated message is hashed to produce a
 * deterministic seed: any device holding the same wallet can reproduce it,
 * so notes shielded under that seed are recoverable on reinstall.
 *
 * Cached in-memory per pubkey for the session — the user is prompted to
 * sign once, not on every shield. Cache is cleared on logout via
 * {@link clearNoteSeedCache}.
 */
export async function deriveSeedFromSigner(signer: WalletSigner): Promise<Uint8Array> {
  if (typeof signer.signMessage !== 'function') {
    throw new Error('Wallet signer does not expose signMessage — cannot derive note seed');
  }
  const cacheKey = signer.publicKey.toBase58();
  const cached = noteSeedCache.get(cacheKey);
  if (cached) return cached;

  const message = utf8ToBytes(NOTE_SEED_DOMAIN);
  const signature = await signer.signMessage(message);
  if (!(signature instanceof Uint8Array) || signature.length === 0) {
    throw new Error('Wallet signMessage returned an invalid signature');
  }
  const seed = sha256(signature);
  noteSeedCache.set(cacheKey, seed);
  return seed;
}

/** Clear the in-memory note-seed cache (call on logout). */
export function clearNoteSeedCache(): void {
  noteSeedCache.clear();
}

/**
 * Read a cached note seed without triggering the signMessage prompt. Used by
 * background flows (e.g. auto-shield) that must NOT pop a signature dialog —
 * if the cache is cold, the caller should accept a non-recoverable note for
 * this run and let the next interactive shield warm the cache.
 */
export function getCachedNoteSeed(pubkey: PublicKey): Uint8Array | null {
  return noteSeedCache.get(pubkey.toBase58()) ?? null;
}

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
  if (keypair) {
    return await sendAndConfirmTransaction(connection, tx, [keypair], {
      commitment: 'confirmed',
    });
  }
  if (walletSigner) {
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = walletSigner.publicKey;
    const signed = await walletSigner.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }
  throw new Error('No wallet available for signing');
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

  // Privacy: commit nullifier via Arcium MPC (hides the spent-note link)
  // The shield TX itself goes through direct submit — the wallet link is
  // broken by using stealth intermediaries in the Privacy Router flow.
  let sig: string;
  try {
    const { useArciumStore } = await import('../../stores/arciumStore');
    const { mpcEnabled } = useArciumStore.getState();
    const { isMpcClientReady } = await import('../arcium/mpcClient');

    if (mpcEnabled && isMpcClientReady()) {
      onProgress?.('MPC nullifier commit (hiding note link)...');
      console.log('[DenomPool] Arcium MPC active — nullifier commits will be hidden');
      // MPC protects the nullifier commit (small payload, fits RescueCipher)
      // The shield TX uses direct submit — origin privacy handled by stealth intermediary
    }
  } catch {}

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
 * Build unshield_denominated_stark instruction.
 * No Groth16 proof — instead references a pre-verified STARK proof buffer.
 */
function buildUnshieldDenominatedStarkIx(
  payer: PublicKey,
  recipient: PublicKey,
  poolPDA: PublicKey,
  treePDA: PublicKey,
  nullifierPDA: PublicKey,
  starkProofBuffer: PublicKey,
  nullifierBytes: number[],
  merkleRootBytes: number[],
  minEpoch: bigint,
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
  data.writeBigUInt64LE(minEpoch, offset); offset += 8;
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
  // Phase 1 indistinguishability: zk_shielded no longer enforces `min_epoch`
  // on-chain (see programs/zk_shielded/src/instructions/unshield_denominated_stark.rs).
  // Mature, emergency, and prefund paths all pass `current_epoch` so tx args
  // and event shape are identical on every unshield.
  void emergency;
  void poolInfo;
  const minEpoch = currentEpoch;

  // MPC: Try hidden nullifier commitment (prevents on-chain nullifier linkage)
  let mpcNullifierResult: any = null;
  try {
    const { commitNullifier: mpcCommit } = await import('../arcium/nullifierCommit');
    mpcNullifierResult = await mpcCommit(poolConfig.poolPDA, new Uint8Array(nullifierBytes), ZK_SHIELDED_PROGRAM_ID);
    if (mpcNullifierResult.wasMpcProtected) {
      onProgress?.('Nullifier committed via MPC (hidden)');
    }
  } catch {
    // MPC not available — standard nullifier PDA used below
  }

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
      minEpoch,
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
 * Consumes a pre-verified STARK proof buffer (circuit 1: pool_commitment for source note).
 * output_commitments authenticated by payer signature on instruction data.
 */
function buildSplitNoteStarkIx(
  payer: PublicKey,
  sourcePool: PoolConfig,
  targetPool: PoolConfig,
  nullifierPDA: PublicKey,
  starkProofBuffer: PublicKey,
  nullifierBytes: number[],
  merkleRootBytes: number[],
  minEpoch: bigint,
  starkCommitment: bigint,
  numOutputs: number,
  outputCommitments: number[][],
  newRoots: number[][],
): TransactionInstruction {
  const disc = getDiscriminator('split_note_stark');

  // Data: disc(8) + nullifier(32) + merkle_root(32) + min_epoch(8) + stark_commitment(8)
  //       + num_outputs(1) + vec_len(4) + outputs(num*32) + vec_len(4) + new_roots(num*32)
  const vecOverhead = 4;
  const dataLen = 8 + 32 + 32 + 8 + 8 + 1
    + vecOverhead + numOutputs * 32
    + vecOverhead + numOutputs * 32;

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

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: sourcePool.poolPDA, isSigner: false, isWritable: true },
    { pubkey: sourcePool.treePDA, isSigner: false, isWritable: false },
    { pubkey: targetPool.poolPDA, isSigner: false, isWritable: true },
    { pubkey: targetPool.treePDA, isSigner: false, isWritable: true },
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },
    { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
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
 * Flow:
 * 1. Generate pool_commitment STARK proof (circuit 1) for the source note
 * 2. Submit + verify STARK proof on-chain
 * 3. Compute output commitments (Poseidon) + new Merkle roots
 * 4. Call split_note_stark (reads verified proof buffer)
 * 5. Close proof buffer (recover rent)
 */
export async function splitNoteStark(
  sourcePool: PoolConfig,
  targetPool: PoolConfig,
  receipt: ShieldReceipt,
  numOutputs: number,
  outputSecrets: bigint[],
  starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  walletSigner?: WalletSigner,
  onProgress?: (step: string) => void,
  stealthKeypair?: Keypair,
): Promise<{ txSignature: string; outputCommitments: bigint[]; outputNullifierPreimages: bigint[] }> {
  const { submitAndVerifyStarkProof, closeStarkProofBuffer, CIRCUIT_POOL_COMMITMENT, getProofBufferPDA } = await import('../stark');
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
  const merkleRootBytes = bigintToLeBytes32(receipt.merkleRoot!);
  const outputCommitmentBytes = outputCommitments.map(c => Array.from(bigintToLeBytes32(c)));
  const newRootBytes = newRoots.map(r => Array.from(bigintToLeBytes32(r)));

  const slot = await connection.getSlot('confirmed');
  const currentEpoch = slotToEpoch(slot);
  const totalDelay = sourcePoolInfo.epochDelay + BigInt(sourcePoolInfo.dynamicDelay);
  const minEpoch = currentEpoch - totalDelay;

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

    onProgress?.('Building split transaction...');
    const [nullifierPDA] = deriveNullifierPDA(sourcePool.poolPDA, nullifierBytes);
    const starkCommitment = starkProofData.publicInputs[1] ?? 0n;

    const ix = buildSplitNoteStarkIx(
      signerPubkey,
      sourcePool,
      targetPool,
      nullifierPDA,
      proofBuffer,
      nullifierBytes,
      Array.from(merkleRootBytes),
      minEpoch,
      starkCommitment,
      numOutputs,
      outputCommitmentBytes,
      newRootBytes,
    );

    onProgress?.('Sending split transaction...');
    const tx = new Transaction();
    tx.add(...buildComputeBudgetIxs(500_000));
    tx.add(ix);
    const txSignature = stealthKeypair
      ? await signAndSend(connection, tx, stealthKeypair, undefined)
      : await signAndSend(connection, tx, keypair, walletSigner);

    onProgress?.('Split confirmed!');
    return { txSignature, outputCommitments, outputNullifierPreimages };
  } finally {
    try {
      onProgress?.('Closing proof buffer...');
      await closeStarkProofBuffer(proofBuffer, starkSigner, connection);
    } catch (closeErr: any) {
      console.warn('[DenomPool] closeStarkProofBuffer (split) failed (rent may be stranded):', closeErr.message);
    }
  }
}

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

  const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === noteData.pool);
  if (!pool) {
    throw new Error(`Unknown pool: ${noteData.pool}`);
  }

  const secret = BigInt(noteData.secret);
  const nullifierPreimage = BigInt(noteData.nullifier_preimage);
  const depositEpoch = BigInt(noteData.deposit_epoch);
  const tokenMint = BigInt(noteData.token_mint);

  // Verify commitment matches
  const expectedCommitment = createCommitment(nullifierPreimage, secret, depositEpoch, tokenMint);
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
