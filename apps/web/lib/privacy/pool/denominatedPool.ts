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
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
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
  CIRCUIT_MERKLE_UPDATE,
  CIRCUIT_POOL_COMMITMENT,
  CIRCUIT_MERKLE_PATH,
  type GenericStarkProof,
  type WalletSigner,
} from './stark';

// STARK WASM prover singleton.
import { starkProver } from './starkProver';

// NOTE: `./noteCrypto` (post-quantum note encryption) and
// `./relayEphemeralRecovery` (deterministic ephemeral + crash breadcrumbs) used
// to be imported here for the note-to-note transfer path. That path is deleted
// (see the tombstone below `buildTransferDenominatedStarkV3Ix`); both modules
// are still live and imported by shieldEphemeral/unshieldEphemeral/poolHandlers.

// ---------------------------------------------------------------------------
// Re-export circuit IDs and signer type so consumers can import from here.
// ---------------------------------------------------------------------------
export { CIRCUIT_POOL_COMMITMENT, CIRCUIT_MERKLE_PATH, CIRCUIT_MERKLE_UPDATE, type WalletSigner };

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
function buildComputeBudgetIxs(
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

// USDC V3 — vaultATA derived lazily (getAssociatedTokenAddress).
export const USDC_POOLS_V3: PoolConfig[] = [
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

/** Mirror mobile getPoolsForTokenV3 line 2842. */
export function getPoolsForTokenV3(token: 'SOL' | 'USDC'): PoolConfig[] {
  return token === 'SOL' ? SOL_POOLS_V3 : USDC_POOLS_V3;
}

/** Mirror mobile findPoolV3 line 2846. */
export function findPoolV3(token: 'SOL' | 'USDC', denomination: number): PoolConfig | undefined {
  return ALL_POOLS_V3.find(p => p.token === token && p.denomination === denomination);
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

/**
 * Single-note spent check. ⚠️ LEAKS THE NULLIFIER PDA TO THE RPC.
 *
 * Kept for the one place the leak is already moot: the pre-flight immediately
 * before a spend, where the nullifier is about to be published on chain anyway
 * and a stale read costs a ~2-minute STARK proof plus buffer rent. Everywhere
 * else — and in particular anything that runs on page load or over a list of
 * unspent notes — use `fetchSpentNullifierSet` + `isNullifierSpentInSet`.
 */
export async function isNullifierSpent(
  connection: Connection,
  poolPDA: PublicKey,
  nullifierPreimage: bigint,
  secret: bigint,
): Promise<boolean> {
  const nullifier = createNullifierV3(nullifierPreimage, secret);
  const nullifierBytes = goldilocksU64To32(nullifier);
  const [nullifierPDA] = deriveNullifierPDA(poolPDA, nullifierBytes);
  const info = await connection.getAccountInfo(nullifierPDA);
  return info !== null;
}

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
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  const signed = await signer.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
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
 * Args: commitment[32] | new_root[32] | Vec<[u8;32]> new_subtrees.
 * Account order mirrors mobile lines 2895-2905 (and shield_denominated_v3.rs
 * account order).
 */
function buildShieldDenominatedV3Ix(
  depositor: PublicKey,
  poolPDA: PublicKey,
  treePDA: PublicKey,
  c6ProofBuffer: PublicKey,
  commitment: number[],
  newRoot: number[],
  newSubtrees: number[][],
  tokenProgram?: PublicKey,
  userTokenAccount?: PublicKey,
  poolVault?: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('shield_denominated_v3');
  const subtreesBytesLen = 4 + newSubtrees.length * 32;
  const data = Buffer.alloc(8 + 32 + 32 + subtreesBytesLen);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(commitment).copy(data, offset); offset += 32;
  Buffer.from(newRoot).copy(data, offset); offset += 32;
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
    newRoot: bigint;
    newSubtrees: bigint[];
    secret: bigint;
    nullifierPreimage: bigint;
    noteBlinding: bigint;
    leafIndex: number;
  },
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
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
    const newRootBytes = goldilocksToLeBytes32(insertParams.newRoot);
    const newSubtreesBytes = insertParams.newSubtrees.map(goldilocksToLeBytes32);

    const ix = buildShieldDenominatedV3Ix(
      signer.publicKey,
      poolConfig.poolPDA,
      poolConfig.treePDA,
      c6ProofBuffer,
      commitmentBytes,
      newRootBytes,
      newSubtreesBytes,
      tokenProgram,
      userTokenAccount,
      poolVault,
    );

    const tx = new Transaction();
    tx.add(...buildComputeBudgetIxs(300_000));
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
        await closeStarkProofBuffer(c6ProofBuffer, signer, connection);
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
): Promise<{
  c6ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number; circuitId: number };
  insertParams: {
    commitment: bigint;
    newRoot: bigint;
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
  const { leafCount, subtrees } = parseFilledSubtrees(treeBuf);

  // On-chain current root (low 8 bytes LE of MerkleTreeStateV3.root @ offset 8+32).
  let onChainRoot = 0n;
  for (let b = 7; b >= 0; b--) onChainRoot = (onChainRoot << 8n) | BigInt(treeBuf[8 + 32 + b]);

  // 2. Derive note material.
  onProgress?.('Deriving note material...');
  const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, poolConfig.poolPDA, counter);

  // 3. Third commitment slot (historically deposit_epoch): a caller-supplied
  // secret blinding when given, otherwise the real epoch (legacy notes).
  const noteBlinding =
    noteBlindingOverride ?? slotToEpoch(await connection.getSlot('confirmed'));

  // 4. Compute Goldilocks commitment.
  const tokenMintField = pubkeyToField(poolConfig.tokenMint);
  const commitment = createCommitmentV3(nullifierPreimage, secret, noteBlinding, tokenMintField);

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

  let chosen: typeof direct;
  if (oldRootDirect === onChainRoot) {
    chosen = direct;
  } else if (oldRootSliced === onChainRoot) {
    chosen = sliced;
  } else {
    throw new Error(
      `Shield pre-flight failed: cannot reconstruct the on-chain Merkle root ` +
      `(${onChainRoot}) from the pool's filled_subtrees for leaf #${leafCount}. ` +
      `Neither layout matched (direct=${oldRootDirect}, shifted=${oldRootSliced}). ` +
      `The tree state has diverged from this client — refusing to burn proof rent ` +
      `on a guaranteed InvalidProof. Retry shortly; if it persists the pool tree ` +
      `was advanced by an incompatible client.`,
    );
  }
  const { newRoot, updatedSubtrees, pathElements, pathIndices } = chosen;

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
    c6Result = await starkProver.generateMerkleUpdateProof(
      '0',                          // oldLeaf = 0 (empty slot)
      newLeaf.toString(),           // newLeaf = commitment u64
      pathElements.map(e => e.toString()),
      pathIndices,
    );
  } finally {
    clearInterval(proofHeartbeat);
  }

  const proofBytes = hexToBytes(c6Result.proofHex);

  return {
    c6ProofResult: {
      proofBytes,
      publicInputs: c6Result.publicInputs.map(s => BigInt(s)),
      proofSize: c6Result.proofSize,
      circuitId: CIRCUIT_MERKLE_UPDATE,
    },
    insertParams: {
      commitment,
      newRoot,
      newSubtrees: updatedSubtrees,
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

// ---------------------------------------------------------------------------
// Hex helper
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
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
const LEAF_INSERTION_EVENTS: ReadonlyArray<{
  name: string;
  disc: Uint8Array;
  commitmentOffset: number;
  leafIndexOffset: number;
  minLength: number;
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
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

function parsePoolV3Account(data: Uint8Array): ParsedPoolV3 | null {
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
  if (histLen > 100) return null;
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

export async function fetchPoolCommitments(
  connection: Connection,
  poolPDA: PublicKey,
  options: {
    maxSignatures?: number;
    batchSize?: number;
    onProgress?: (scanned: number, total: number) => void;
  } = {},
): Promise<Map<string, OnChainCommitment>> {
  const maxSignatures = options.maxSignatures ?? 1000;
  const batchSize = options.batchSize ?? 25;
  const PAGE = 1000;
  const MAX_LEAVES = 1 << MERKLE_DEPTH;

  const sigs: Array<{ signature: string }> = [];
  let before: string | undefined;
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
          const rawIdx = readU64LE(data, layout.leafIndexOffset);
          if (rawIdx > BigInt(Number.MAX_SAFE_INTEGER)) continue;
          const leafIndex = Number(rawIdx);
          if (leafIndex < 0 || leafIndex >= MAX_LEAVES) continue;
          const commitment = leBytes32ToBigint(data, layout.commitmentOffset);
          decoded = { commitment, leafIndex };
          break;
        }
        if (!decoded) continue;
        out.set(decoded.commitment.toString(), decoded);
      }
    }

    options.onProgress?.(Math.min(i + batchSize, sigs.length), sigs.length);
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
): Promise<{ leavesByIndex: bigint[]; scannedLeafCount: number; missing: number[] }> {
  const onChain = await fetchPoolCommitments(connection, poolPDA, {
    maxSignatures: opts.maxSignatures ?? 1000,
    onProgress: opts.onProgress,
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
  return { leavesByIndex, scannedLeafCount: maxIdx + 1, missing };
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
    throw new Error(
      `buildMerkleProofFromLeavesV3: target leafIndex ${targetLeafIndex} not found ` +
      `among ${leavesByIndex.filter((l) => l !== undefined && l !== ZERO_VALUE_V3).length} non-empty leaves. ` +
      `Try increasing maxSignatures or check that the note's leafIndex is correct.`,
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
  tokenProgram?: PublicKey,
  poolVault?: PublicKey,
  recipientTokenAccount?: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('unshield_denominated_stark_v3');
  // Args layout: nullifier[32] + merkle_root[32] + min_epoch u64 + stark_commitment u64 + recipient[32]
  const data = Buffer.alloc(8 + 32 + 32 + 8 + 8 + 32);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(nullifierBytes).copy(data, offset); offset += 32;
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;
  // min_epoch — pinned to 0 on every path. See UNSHIELD_MIN_EPOCH above.
  data.writeBigUInt64LE(UNSHIELD_MIN_EPOCH, offset); offset += 8;
  data.writeBigUInt64LE(starkCommitment, offset); offset += 8;
  // recipient as 32-byte arg (matches `recipient: [u8; 32]` in Rust)
  Buffer.from(recipient.toBytes()).copy(data, offset);

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
  merkleRoot: bigint;
  nullifierGoldilocks: bigint;
  starkCommitment: bigint;
}

export async function prepareUnshield(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<PrepareUnshieldResult> {
  // Import starkProver lazily to avoid circular module issues.
  const { starkProver: prover } = await import('./starkProver');

  onProgress?.('Fetching pool leaves from on-chain events...');
  const { leavesByIndex, missing } = await fetchPoolLeavesByIndex(
    connection,
    poolConfig.poolPDA,
    { maxSignatures: 1000, onProgress: (s, t) => onProgress?.(`Scanning events ${s}/${t}...`) },
  );

  if (missing.length > 0) {
    console.warn(`[DenomPool/ext] prepareUnshield: ${missing.length} missing leaf gap(s): ${missing.slice(0, 5).join(',')}...`);
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
          const hex = (u: Uint8Array) => Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');
          throw new Error(
            `PRE-FLIGHT FAIL: Rebuilt Merkle root 0x${hex(retryRootBytes).slice(0, 24)}… ` +
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
  // publicInputs layout: [leaf_u64, root_u64, depth] — depth bound on-chain.
  // starkProver.generateMerklePathProof(leaf, pathElements, pathIndices)
    stage = 'Proving the note is in the pool';
    onProgress?.('Proving the note is in the pool...');
    c3Raw = await prover.generateMerklePathProof(
      receipt.commitment.toString(),
      merkleResult.pathElements.map((e) => e.toString()),
      merkleResult.pathIndices,
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
  // root comes from C3 public inputs (layout [leaf, root]).
  const merkleRoot = c3PublicInputs[1] ?? merkleResult.root;

  return {
    c1ProofResult: { proofBytes: c1ProofBytes, publicInputs: c1PublicInputs, proofSize: c1Raw.proofSize },
    c3ProofResult: { proofBytes: c3ProofBytes, publicInputs: c3PublicInputs, proofSize: c3Raw.proofSize },
    merkleRoot,
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
  const { c1ProofResult, c3ProofResult, merkleRoot, nullifierGoldilocks, starkCommitment } = preparedResult;

  const createdBuffers: PublicKey[] = [];
  let c1ProofBuffer: PublicKey | undefined;
  let c3ProofBuffer: PublicKey | undefined;

  try {
    // Step 1: C1 (pool_commitment)
    onProgress?.('Submitting C1 (pool_commitment) proof on-chain...');
    const c1Proof: GenericStarkProof = {
      proofBytes: c1ProofResult.proofBytes,
      circuitId: CIRCUIT_POOL_COMMITMENT,
      publicInputs: c1ProofResult.publicInputs,
      proofSize: c1ProofResult.proofSize,
    };
    const c1Result = await submitAndVerifyStarkProof(c1Proof, signer, connection, onProgress);
    c1ProofBuffer = c1Result.proofBuffer;
    createdBuffers.push(c1ProofBuffer);

    // Step 2: C3 (merkle_path)
    onProgress?.('Submitting C3 (merkle_path) proof on-chain...');
    const c3Proof: GenericStarkProof = {
      proofBytes: c3ProofResult.proofBytes,
      circuitId: CIRCUIT_MERKLE_PATH,
      publicInputs: c3ProofResult.publicInputs,
      proofSize: c3ProofResult.proofSize,
    };
    const c3Result = await submitAndVerifyStarkProof(c3Proof, signer, connection, onProgress);
    c3ProofBuffer = c3Result.proofBuffer;
    createdBuffers.push(c3ProofBuffer);

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
      tokenProgram,
      poolVault,
      recipientTokenAccount,
    );

    const tx = new Transaction();
    tx.add(...buildComputeBudgetIxs(300_000));
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

  return {
    secret,
    nullifierPreimage,
    noteBlinding,
    tokenMint,
    commitment,
    leafIndex: note.leafIndex,
    denomination: pool.denominationAtomic,
    pool: note.pool,
    token: note.token,
    denominationHuman: note.denominationHuman,
    shieldedAt: note.shieldedAt ?? Date.now(),
    merkleRoot: note.merkle_root !== undefined ? BigInt(note.merkle_root) : undefined,
  };
}
