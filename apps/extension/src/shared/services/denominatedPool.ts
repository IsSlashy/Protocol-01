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
  submitAndConsumeStarkProof,
  closeStarkProofBuffer,
  getProofBufferPDA,
  CIRCUIT_MERKLE_UPDATE,
  CIRCUIT_POOL_COMMITMENT,
  CIRCUIT_SPEND,
  CIRCUIT_MERKLE_PATH,
  type GenericStarkProof,
  type WalletSigner,
} from './stark';

// STARK WASM prover singleton.
import { starkProver } from './starkProver';
// [2026-08-25] The commitment's third input. Paired with `deriveNoteMaterial`
// below — the two describe the same note and must take the same `counter`.
import { deriveNoteBlinding } from './noteBlinding';

// Post-quantum note encryption (hybrid X25519 + ML-KEM-768) for transfers.
import { encryptNote, isNoteEncryptionAddress } from './noteCrypto';

// Deterministic ephemeral derivation + crash-recovery breadcrumbs. Phase 1 of
// the sender-anonymity design: the transfer is authored by a per-transfer
// ephemeral so the user's wallet never signs the transfer itself.
import {
  deriveEphemeralForRelay,
  addPendingRelay,
  removePendingRelay,
  markPendingRelayErrored,
  jobIdToHex,
} from './relayEphemeralRecovery';

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
 * first — the same shape C7 already uses for its own depth-12 cut.
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
 * The depth circuit 3 proves, since 2026-08-29. Same cut, same reason.
 *
 * Numerically equal to `C6_SUBTREE_DEPTH` and `C7_SUBTREE_DEPTH`, and
 * deliberately a SEPARATE constant: nothing requires the three circuits to move
 * together, and one shared constant is exactly what would make the next
 * divergence invisible. The on-chain side keeps them separate for the same
 * reason (`spend_root::SPEND_SUBTREE_DEPTH` vs `insert_root::INSERT_SUBTREE_DEPTH`).
 */
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
 * Convert slot to epoch. Mirrors mobile slotToEpoch lines 721-723.
 */
export function slotToEpoch(slot: number): bigint {
  return BigInt(Math.floor(slot / SLOTS_PER_EPOCH));
}

// ---------------------------------------------------------------------------
// Pool configuration types (mirror mobile lines 114-130)
// ---------------------------------------------------------------------------

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
  depositEpoch: bigint;
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
 * Check whether a note has already been spent (subscribed or unshielded) by
 * looking up its on-chain NullifierRecord PDA at
 * [b"nullifier", pool, goldilocksU64To32(nullifier)].
 *
 * Cheap pre-flight: a single getAccountInfo, no proof. Lets callers fail fast
 * instead of burning a ~2-minute STARK proof + buffer rent on a note the
 * on-chain double-spend guard would reject anyway (subscribe_private_stark
 * inits the NullifierRecord, so a live record => "Allocate ... already in use").
 * The nullifier value is recomputed locally via `createNullifierV3` (identical
 * to the C1 public input), so no proof generation is needed.
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
export async function signSendV3(
  connection: Connection,
  tx: Transaction,
  signer: WalletSigner,
  onProgress?: (step: string) => void,
): Promise<string> {
  let enabled = true;
  try {
    const { useSettingsStore } = await import('../store/settings');
    enabled = useSettingsStore.getState().relayerEnabled;
  } catch { /* settings unavailable → default to relayer-on */ }

  if (!enabled) return signSendConfirmTx(connection, tx, signer);

  try {
    onProgress?.('Routing through privacy relayer…');
    const { signAndSendViaRelayer } = await import('./relayerWrapper');
    return await signAndSendViaRelayer(connection, tx, null, signer);
  } catch (e) {
    // Availability > privacy: a relayer hiccup must not break the withdrawal.
    console.warn(
      '[DenomPool/ext] relayer failed, falling back to direct submit (IP/fee-payer leak this time):',
      (e as Error)?.message ?? String(e),
    );
    onProgress?.('Relayer unavailable — submitting directly…');
    return signSendConfirmTx(connection, tx, signer);
  }
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
 * own `filled_subtrees`; a caller-supplied pool root is precisely what that fold
 * exists to refuse. Adding it back here would shift every following byte and the
 * instruction would fail to deserialize, which is the good case. The bad case is
 * adding it back on BOTH sides.
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
    depositEpoch: bigint;
    leafIndex: number;
  },
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<{ txSig: string; receipt: ShieldReceipt; c6ProofBuffer: PublicKey }> {
  {
    // 1. The C6 proof goes up, then [phase 2 + shield + close] land in ONE
    //    transaction (phase 1 keeps its own: 1,316,491 CU measured, and the cap
    //    is 1,400,000). Two confirmations instead of four, and the buffer's rent
    //    comes back in the shield transaction itself. Matches the web app.
    onProgress?.('Submitting C6 (merkle_update) proof on-chain...');
    const proof: GenericStarkProof = {
      proofBytes: c6ProofResult.proofBytes,
      circuitId: CIRCUIT_MERKLE_UPDATE,
      publicInputs: c6ProofResult.publicInputs,
      proofSize: c6ProofResult.proofSize,
    };
    const [c6ProofBuffer] = getProofBufferPDA(signer.publicKey, CIRCUIT_MERKLE_UPDATE);

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

    // [C6-D12] 300,000 -> 600,000.
    //
    // MEASURED 2026-08-29 on the litesvm SBF VM: one on-chain Poseidon-GL
    // `hash2` costs ~34,469 CU. The fold does SIX of them — three levels, old
    // root and new root — so it adds ~206,814 CU by itself, before any of the
    // deposit's existing work. 300,000 was not enough, and the failure would
    // land at the END of the whole proof-upload sequence.
    //
    // ⚠️ 600,000 IS A HEADROOM CHOICE, NOT A MEASUREMENT OF THIS PATH. What is
    // measured is the fold's cost; this handler's own total has not been
    // measured on the SBF VM since the fold landed. Erring high costs only a
    // marginally higher priority fee. Matches the web app.
    // [ONE-TX 2026-09-06] 600,000 -> 1,000,000, and it now covers phase 2 as
    // well: the shield instruction shares its transaction with
    // `verify_deep_ali_phase2` and the buffer close. The remaining headroom is
    // for the depth-19 pool (16 `hash2` in the fold, ~552,000 CU).
    const consume: TransactionInstruction[] = [];
    if (!isNativeSOL && userTokenAccount) {
      consume.push(
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey,
          userTokenAccount,
          signer.publicKey,
          poolConfig.tokenMint,
        ),
      );
    }
    consume.push(ix);

    onProgress?.('Sending V3 shield transaction...');
    const { txSignature: txSig } = await submitAndConsumeStarkProof(
      proof,
      signer,
      connection,
      { instructions: consume, computeUnits: 1_000_000, label: 'shielding the deposit' },
      onProgress,
    );
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
      merkleRoot: insertParams.newRoot,
    };

    // The buffer was closed inside the shield transaction; the address is
    // returned for callers that still key on it.
    return { txSig, receipt, c6ProofBuffer };
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
    depositEpoch: bigint;
    leafIndex: number;
  };
  newLeaf: bigint;
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

  // 3. The commitment's third input — a SECRET, not an epoch.
  //
  // 🚨 It used to be `slotToEpoch(await connection.getSlot('confirmed'))`. A
  // withdrawal must publish the nullifier, so with a real epoch there an
  // observer enumerates a few thousand candidates, recomputes
  // `createCommitmentV3(nullifierPreimage, secret, epoch, mint)` and matches the
  // exact deposit leaf. Anonymity set: one — no matter what circuit 7 does about
  // the commitment argument. See ./noteBlinding.ts.
  //
  // This is the adoption the two landmine comments further down this file
  // predicted in the future tense. From here `depositEpoch` is 63 bits of
  // secret, and `min_epoch` must stay pinned to `0n` on every spend path.
  const depositEpoch = deriveNoteBlinding(walletSeed, poolConfig.poolPDA, counter);

  // 4. Compute Goldilocks commitment.
  const tokenMintField = pubkeyToField(poolConfig.tokenMint);
  const commitment = createCommitmentV3(nullifierPreimage, secret, depositEpoch, tokenMintField);

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
  onProgress?.('Generating C6 (merkle_update) STARK proof (30-60s)...');
  await starkProver.start();
  // [C6-D12] Only the bottom 12 levels go into the circuit. The top 3 are the
  // program's job now, and it does NOT accept them from us — see
  // `state::insert_root` for why a caller-supplied top level is the whole
  // vulnerability.
  if (pathElements.length < C6_SUBTREE_DEPTH) {
    throw new Error(
      `Merkle insertion path has ${pathElements.length} elements, need at least ` +
      `${C6_SUBTREE_DEPTH} for the C6 circuit.`,
    );
  }
  const c6Result = await starkProver.generateMerkleUpdateProof(
    '0',                          // oldLeaf = 0 (empty slot)
    newLeaf.toString(),           // newLeaf = commitment u64
    pathElements.slice(0, C6_SUBTREE_DEPTH).map(e => e.toString()),
    pathIndices.slice(0, C6_SUBTREE_DEPTH),
  );

  const proofBytes = hexToBytes(c6Result.proofHex);
  const c6PublicInputs = c6Result.publicInputs.map(s => BigInt(s));

  // [C6-D12] The two SUBTREE roots the instruction now takes, read back from the
  // proof's own public inputs rather than recomputed here. The layout is
  // [old_leaf, new_leaf, old_root, new_root, depth]. Reading them from the proof
  // is deliberate: the circuit derived them from the same 12 path elements it
  // proved over, so there is no second implementation of the walk to disagree
  // with the first.
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
      // Kept for the CLIENT's own tree bookkeeping. ⛔ No longer sent to the
      // program, which computes the pool root itself.
      newRoot,
      oldSubtreeRoot: c6PublicInputs[2],
      newSubtreeRoot: c6PublicInputs[3],
      newSubtrees: updatedSubtrees,
      secret,
      nullifierPreimage,
      depositEpoch,
      leafIndex: leafCount,
    },
    newLeaf,
  };
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

export interface ParsedPoolV3 {
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
  // Mirrors the web twin (denominatedPool.ts, same function). The RPC scan
  // below is one `getTransaction` per pool signature; the indexer answers the
  // same dense array in one request. It is NOT trusted: every caller rebuilds
  // the path and pre-flights the root against the on-chain ring before any
  // proof rent is spent, so a lying indexer can only cause a refused spend.
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
 * The ONLY value this client ever publishes in the `min_epoch` argument of an
 * unshield instruction (byte offset 72 of `ix.data`, matching the web client).
 *
 * Why a constant and not the note's deposit epoch:
 *
 *  - It is dead on-chain. `unshield_denominated_stark_v3.rs:387` consumes it as
 *    `let _ = (amount, unshield_fee, min_epoch, current_epoch, dynamic_delay,
 *    nullifier);` — the handler provably never reads it. Passing the real
 *    deposit epoch bought nothing and cost privacy.
 *  - It narrows the anonymity set. The deposit epoch is a ~7200-slot bucket of
 *    the deposit; publishing it in the clear lets any observer intersect the
 *    withdrawal with the deposits made in that window, without even having to
 *    match the commitment.
 *  - It is a forward-compatibility landmine. Once this client adopts the PRF
 *    commitment blinding already shipped in apps/web
 *    (apps/web/lib/privacy/pool/noteBlinding.ts), the value stored in
 *    `ShieldReceipt.depositEpoch` becomes a 63-bit SECRET. Publishing it here
 *    would hand the blinding factor straight to the chain and make blinding
 *    worthless. Pinning it to zero now means that migration cannot regress.
 *  - Uniformity. A constant makes every unshield byte-identical in this field
 *    across emergency / non-emergency and across web, extension and mobile, so
 *    the field cannot be used to fingerprint which client produced the tx.
 *
 * See docs/C7_SPEND_CIRCUIT_PLAN.md Step 1.
 *
 * NOT safe to reuse for transfer/split/subscribe: `min_epoch` IS enforced on
 * those handlers (e.g. `transfer_denominated_stark_v3.rs:167-173`
 * `require!(current_epoch >= min_epoch + dynamic_delay, EpochDelayNotMet)`).
 * This constant is for the unshield path only.
 *
 * Do not turn this back into a builder parameter. It is written inline below
 * precisely so that no call site can reintroduce a note-derived value.
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
  // min_epoch @ byte 72 — pinned to 0 on every path. See UNSHIELD_MIN_EPOCH.
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
  /** C3 public input 1: the depth-12 subtree root the on-chain walk starts from. */
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
  // Import starkProver lazily to avoid circular module issues.
  const { starkProver: prover } = await import('./starkProver');

  onProgress?.('Fetching pool leaves...');
  const { leavesByIndex, missing } = await fetchPoolLeavesByIndex(
    connection,
    poolConfig.poolPDA,
    {
      maxSignatures: 1000,
      onProgress: (s, t) => onProgress?.(`Scanning events ${s}/${t}...`),
      onStep: onProgress,
      minLeafCount: receipt.leafIndex + 1,
    },
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
          fresh: true,
          onStep: onProgress,
          minLeafCount: receipt.leafIndex + 1,
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
  // starkProver.generatePoolCommitmentProof(np, secret, epoch, mint)
  onProgress?.('Generating C1 (pool_commitment) STARK proof (~60s)...');
  await prover.start();
  const c1Raw = await prover.generatePoolCommitmentProof(
    receipt.nullifierPreimage.toString(),
    receipt.secret.toString(),
    receipt.depositEpoch.toString(),
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
  onProgress?.('Generating C3 (merkle_path) STARK proof (~60s)...');
  if (merkleResult.pathElements.length < C3_SUBTREE_DEPTH) {
    throw new Error(
      `Merkle path has ${merkleResult.pathElements.length} elements, need at least ` +
      `${C3_SUBTREE_DEPTH} for the C3 circuit.`,
    );
  }
  const c3Raw = await prover.generateMerklePathProof(
    receipt.commitment.toString(),
    merkleResult.pathElements.slice(0, C3_SUBTREE_DEPTH).map((e) => e.toString()),
    merkleResult.pathIndices.slice(0, C3_SUBTREE_DEPTH),
  );

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
// REGULAR vs EMERGENCY — no longer distinguishable in the instruction bytes.
// Both paths publish `min_epoch = UNSHIELD_MIN_EPOCH = 0`. The V3 handler
// ignores the argument entirely (unshield_denominated_stark_v3.rs:387:
// `let _ = (amount, unshield_fee, min_epoch, current_epoch, dynamic_delay,
// nullifier);`), so this is purely a privacy change: it stops publishing the
// note's deposit epoch and removes the emergency/regular fingerprint.
// The `emergency` parameter is kept for call-site compatibility but no longer
// affects any byte of the transaction. Maturity remains a UX-only concern
// surfaced by `noteMaturity()` in the popup.
// ---------------------------------------------------------------------------

export async function unshieldDenominatedStarkV3(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  recipient: PublicKey,
  preparedResult: PrepareUnshieldResult,
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
  emergency = false,
): Promise<string> {
  const {
    c1ProofResult, c3ProofResult, merkleRoot, nullifierGoldilocks, starkCommitment,
    // [C3-D12] The three values the on-chain walk needs. See `prepareUnshield`
    // for why `merkleRoot` is NOT `c3PublicInputs[1]`.
    subtreeRoot, siblings, directions,
  } = preparedResult;

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

    // min_epoch is no longer a parameter: the builder pins it to
    // UNSHIELD_MIN_EPOCH (0). `emergency` is deliberately not consulted here —
    // making the two paths produce different bytes was itself the fingerprint.
    void emergency;

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
    // [C3-D12] 300,000 -> 400,000. One on-chain `hash2` is ~34,469 CU (measured
    // 2026-08-29 on the litesvm SBF VM), so the three levels the handler now
    // walks add ~103,400. 400,000 is what the v4 path already requests for the
    // identical walk.
    tx.add(...buildComputeBudgetIxs(400_000));
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
 * "Circuit 7 cannot prove THIS NOTE" — as a type, not as a string to match on.
 *
 * ⛔ IT IS AN ALLOW-LIST, AND THAT IS THE WHOLE SAFETY PROPERTY. Only a failure
 * thrown as this class routes to the C1 + C3 pair. Anything else fails CLOSED,
 * on circuit 7, loudly. A prover that cannot produce a C7 trace is a defect to
 * surface, not to route around: the pair republishes the note's commitment in
 * cleartext, so quietly falling back to it turns a visible bug into a silent
 * leak that reports success.
 *
 * WHY A CLASS HERE AND A STRING NEEDLE ON THE WEB TWIN. `poolHandlers.ts`
 * routes on `msg.includes('circuit 7 needs at least')` because its error
 * crosses a worker `postMessage` boundary, which keeps the message and throws
 * the prototype away — `instanceof` cannot survive it. THAT BOUNDARY DOES NOT
 * EXIST ON THIS SURFACE: `store/denominatedPool.ts` imports this module and
 * calls it in the same realm (the extension has no worker request/response
 * protocol for the pool at all), so the class arrives intact. The needle is
 * web's workaround, not its design, and web's own comment names the hazard —
 * "reword one and the fallback silently stops firing, and every behavioural
 * test would still pass".
 *
 * ⚠️ The MESSAGES below still carry web's wording, `circuit 7 needs at least`
 * included, so a reader diffing the two surfaces sees one design. Nothing here
 * ROUTES on that wording. Check `instanceof`, never the text.
 */
export class V4Unprovable extends Error {
  constructor(message: string) {
    super(message);
    // `target` is ES2020 in this package's tsconfig, so the prototype chain is
    // native and `instanceof` holds without the ES5 `setPrototypeOf` dance.
    // `name` is set anyway: without it every log line says "Error", which is
    // the one thing a reader chasing this fallback needs to see.
    this.name = 'V4Unprovable';
  }
}

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
 * Fetch leaves, build the Merkle path, pre-flight the root, and generate ONE
 * circuit-7 proof.
 *
 * ⛔ `recipient` is a parameter HERE, unlike `prepareUnshield`. C7 binds
 * sha256(recipient) into its transcript; the proof does not exist without it.
 */
export async function prepareUnshieldV4(
  receipt: ShieldReceipt,
  recipient: PublicKey,
  poolConfig: PoolConfig,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<PrepareUnshieldV4Result> {
  // Statically imported here, unlike the web twin: the circular module that
  // forces the lazy import over there does not exist in this bundle.
  const prover = starkProver;

  onProgress?.('Fetching pool leaves...');
  const { leavesByIndex, missing } = await fetchPoolLeavesByIndex(
    connection,
    poolConfig.poolPDA,
    {
      maxSignatures: 1000,
      onProgress: (s, t) => onProgress?.(`Scanning events ${s}/${t}...`),
      onStep: onProgress,
      minLeafCount: receipt.leafIndex + 1,
    },
  );
  if (missing.length > 0) {
    console.warn(`[DenomPool/ext-v4] prepareUnshieldV4: ${missing.length} missing leaf gap(s): ${missing.slice(0, 5).join(',')}...`);
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
  const poolAcct = await connection.getAccountInfo(poolConfig.poolPDA, 'confirmed');
  if (poolAcct) {
    const parsed = parsePoolV3Account(new Uint8Array(poolAcct.data));
    if (parsed) {
      const known = (root: bigint): boolean => {
        const b = new Uint8Array(goldilocksToLeBytes32(root));
        return bytesEqual(b, parsed.currentRoot) || parsed.historicalRoots.some((r) => bytesEqual(b, r));
      };
      if (!known(merkleResult.root)) {
        onProgress?.('Root not in ring — retrying event scan with extended limit...');
        const retry = await fetchPoolLeavesByIndex(connection, poolConfig.poolPDA, {
          maxSignatures: 3000,
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
          // the C1 + C3 prepare pre-flights the root from the other side, so the
          // caller may retry there. Nothing has been spent at this point; the
          // message below says so itself.
          throw new V4Unprovable(
            `PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots ` +
            `(current + ${parsed.historicalRoots.length} historical). Aborting before proof rent is spent. ` +
            `Wait ~10s for the RPC to index recent transactions, then retry.`,
          );
        }
      }
    }
  }

  // 12 / 3 split. `buildMerkleProofFromLeavesV3` returns the full depth-15 path
  // and the two halves go to different verifiers: the first twelve levels are
  // proven in the circuit, the last three are walked on chain.
  if (merkleResult.pathElements.length < C7_SUBTREE_DEPTH) {
    // V4Unprovable for the same reason as the root pre-flight above: a path this
    // circuit cannot consume is a fact about the note, and the depth-15 pair can
    // still spend it.
    //
    // 🚨 MEASURED 2026-08-26, AND THE READER MUST NOT MISTAKE THIS FOR THE LIVE
    // DOOR TO THE PAIR. `buildMerkleProofFromLeavesV3` (line 1363) pushes one
    // element per level inside `for (level = 0; level < MERKLE_DEPTH; level++)`
    // with no early exit and no conditional push, so `pathElements.length` is
    // ALWAYS `MERKLE_DEPTH` = 15, and 15 < 12 is unreachable. This branch cannot
    // fire against today's builder. It stays as defence in depth against a
    // future builder that returns a variable-depth path — and if that lands,
    // `unshieldRouting.test.ts` ("the depth throw is defence in depth") goes red
    // and says so, because it measures the builder rather than reading it.
    //
    // The door that DOES open in production is the root pre-flight above: a note
    // whose rebuilt root is not in the pool's ring — the aged-out case the v3
    // rebuild exists for. Anything reasoning about "how a PRF-blinded note still
    // reaches v3" must point at that throw, not this one.
    throw new V4Unprovable(
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
    await prover.start();
    raw = await prover.generateSpendProof(
      receipt.nullifierPreimage.toString(),
      receipt.secret.toString(),
      // Named `depositEpoch` here and `noteBlinding` on the web twin: it is the
      // SAME field -- the commitment's third input, which stopped being a real
      // epoch when blinding landed (see line 919). This surface kept the old
      // name; the value is `deriveNoteBlinding(...)` on both.
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
  // ⛔ THE TWO THROWS BELOW ARE PLAIN `Error` ON PURPOSE AND MUST STAY THAT WAY.
  // Everything above says "this note cannot go through this circuit"; these two
  // say "the prover produced something circuit 7 does not produce" — a wrong
  // felt count, or a transcript bound to a payee nobody asked for. Routing those
  // to the C1 + C3 pair would answer a broken prover by republishing the
  // commitment and reporting a successful withdrawal, which is the exact failure
  // the pair exists to remove. They fail closed.
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
): Promise<string> {
  if (!prepared.recipient.equals(recipient)) {
    throw new Error(
      `This proof was prepared for ${prepared.recipient.toBase58()} and cannot pay ` +
      `${recipient.toBase58()}. Circuit 7 binds sha256(recipient) into its transcript; ` +
      `re-run prepareUnshieldV4 for the new payee.`,
    );
  }

  {
    onProgress?.('Submitting the circuit-7 spend proof on-chain...');
    const proof: GenericStarkProof = {
      proofBytes: prepared.c7ProofResult.proofBytes,
      circuitId: CIRCUIT_SPEND,
      publicInputs: prepared.c7ProofResult.publicInputs,
      proofSize: prepared.c7ProofResult.proofSize,
    };
    // The buffer address is a PDA of (signer, circuit): known before the
    // upload, so the spend instruction can be built now and ride in the SAME
    // transaction as the two verify phases and the buffer close.
    const [c7ProofBuffer] = getProofBufferPDA(signer.publicKey, CIRCUIT_SPEND);

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
    );

    // [ONE-TX 2026-09-06] phase 1 + phase 2 + this instruction + close in ONE
    // transaction. MEASURED 2026-09-02: 878,756 + 192,715 + 176,404 =
    // 1,247,875 CU, under the 1,400,000 cap. The split-shape budget below
    // (500,000) is kept for the automatic fallback: `resolve_pool_root` walks
    // FOUR levels, ~137,876 CU at the ~34,469 measured per on-chain `hash2`.
    // ⚠️ Headroom, not an end-to-end measurement.
    const consume: TransactionInstruction[] = [];
    if (!isNativeSOL && recipientTokenAccount) {
      consume.push(
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey, recipientTokenAccount, recipient, poolConfig.tokenMint,
        ),
      );
    }
    consume.push(ix);

    onProgress?.('Sending V4 unshield transaction...');
    const { txSignature: sig } = await submitAndConsumeStarkProof(
      proof,
      signer,
      connection,
      {
        instructions: consume,
        computeUnits: 500_000,
        label: 'withdrawing',
        // The privacy relayer route (settings gate → relayer → direct
        // fallback) carries the whole composed transaction: it is complete and
        // user-signed either way, only the transport differs.
        send: (tx) => signSendV3(connection, tx, signer, onProgress),
      },
      onProgress,
    );
    onProgress?.('V4 unshield confirmed!');
    return sig;
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
//
// No recipient IDENTITY is written on-chain: the tx names the sender's
// ephemeral payer and two commitments, never the recipient. The commitments
// themselves are public, so the tx is still linkable to the sender's deposit
// and to the recipient's later withdrawal — see transferDenominatedStarkV3.
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
 * The ONLY value this client publishes in the `min_epoch` argument of a
 * transfer instruction (instruction-data byte 72).
 *
 * Unlike unshield, the transfer handler DOES read this argument:
 * `transfer_denominated_stark_v3.rs:165-173` computes
 * `effective_min_epoch = min_epoch + pool.get_dynamic_delay()` and
 * `require!(current_epoch >= effective_min_epoch, EpochDelayNotMet)`.
 * Three facts decide what to put there:
 *
 *  1. It is UNBOUND to the note. Nothing in the handler ties `min_epoch` to
 *     the spent note: the three proof buffers bind
 *     C1 = [nullifier, commitment] (transfer_denominated_stark_v3.rs:205-211),
 *     C3 = [commitment, root, depth] (…:245-251) and
 *     C6 = [0, new_leaf, old_root, new_root, depth] (…:279-290). The note's
 *     deposit epoch is not a public input of any of them. A caller may pass
 *     any u64, so the check is honesty-based, not enforced — see the DEFECT
 *     note at the bottom of this comment.
 *  2. Passing the real deposit epoch LEAKS. `current_epoch` is absolute
 *     (`slot / SLOTS_PER_EPOCH`, pool_v3.rs:214-216), so publishing the note's
 *     deposit epoch narrows the set of candidate deposits to the ~7200-slot
 *     window it names — exactly the leak already closed on the unshield leg
 *     (see UNSHIELD_MIN_EPOCH).
 *  3. It is the blinding landmine. Once this client adopts the PRF commitment
 *     blinding shipped in apps/web (apps/web/lib/privacy/pool/noteBlinding.ts),
 *     `ShieldReceipt.depositEpoch` stops being an epoch and becomes a ~2^62
 *     blinding value. `min_epoch = blinding` can never satisfy
 *     `current_epoch >= blinding + delay`, so EVERY blinded note would become
 *     permanently un-transferable — a silent capability loss, no funds at risk
 *     but no recovery either. Pinning to 0 now means that migration cannot
 *     regress.
 *
 * Zero is the only value that is simultaneously leak-free, blinding-safe and
 * always satisfiable: `current_epoch >= 0 + dynamic_delay` holds for any pool
 * on a live cluster (dynamic_delay is 0..2, pool_v3.rs:279-289, against an
 * absolute epoch in the tens of thousands).
 *
 * The maturity intent is NOT dropped — it moves to where it was already
 * enforced honestly, the client-side pre-flight in
 * shared/store/denominatedPool.ts (`noteMaturity(receipt.depositEpoch, …)`
 * before any proving), so an immature note is still refused by this client.
 *
 * DEFECT, reported not fixed: because `min_epoch` is unbound to the note, the
 * on-chain maturity delay is not enforceable against a hostile client, which
 * can always pass 0. Binding it needs a circuit change (deposit_epoch as a
 * public input of C1), which is a soundness change, not a copy change.
 *
 * Do not turn this back into a builder parameter — it is written inline below
 * precisely so no call site can reintroduce a note-derived value.
 */
export const TRANSFER_MIN_EPOCH = 0n;

/**
 * Build `transfer_denominated_stark_v3` instruction.
 *
 * Matches transfer_denominated_stark_v3.rs exactly:
 *   Args : nullifier[32] | merkle_root[32] | min_epoch u64 | stark_commitment u64
 *          | new_commitment[32] | c6_old_subtree_root u64 | c6_new_subtree_root u64
 *          | Vec<[u8;32]> new_subtrees
 *          | subtree_root u64 | Vec<u64> siblings | Vec<u8> directions
 *
 * ⛔ `new_root[32]` LEFT THIS LAYOUT ON 2026-08-29, and TWO walks took its place.
 * Transfer is the only path that pays for both: it READS a note (C3, depth 12 →
 * `spend_root::resolve_pool_root` over `siblings`) and WRITES one (C6, depth 12 →
 * `insert_root::fold_insertion` against the POOL ACCOUNT's `filled_subtrees`).
 * The read side takes caller-supplied siblings because its resolved root must
 * already be in the pool's history; the write side must not, because there is no
 * history to check a freshly written root against.
 *   Accounts (8, order critical): payer(signer,mut), denominated_pool(mut),
 *   merkle_tree(MUT — a leaf is inserted), nullifier_record(init,mut),
 *   c1_proof_buffer(ro), c3_proof_buffer(ro), c6_proof_buffer(ro), system_program.
 *   NO fee_escrow, NO token/vault/recipient — funds stay in the pool.
 *
 * Takes NO min_epoch parameter: it writes TRANSFER_MIN_EPOCH itself.
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
  // min_epoch @ byte 72 — pinned to 0. See TRANSFER_MIN_EPOCH.
  data.writeBigUInt64LE(TRANSFER_MIN_EPOCH, offset); offset += 8;
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

export interface PrepareTransferResult {
  c1ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number };
  c3ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number };
  c6ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number; circuitId: number };
  insertParams: {
    newCommitment: bigint;
    /** Client-side tree bookkeeping only; NOT sent to the program any more. */
    newRoot: bigint;
    /** C6 public input 2. Must fold back to the pool's current root on chain. */
    oldSubtreeRoot: bigint;
    /** C6 public input 3. */
    newSubtreeRoot: bigint;
    newSubtrees: bigint[];
    newSecret: bigint;
    newNullifierPreimage: bigint;
    newDepositEpoch: bigint;
    newLeafIndex: number;
  };
  /** The POOL root of the note being SPENT, from the client's own tree walk. */
  merkleRoot: bigint;
  /** C3 public input 1: the depth-12 subtree root the on-chain walk starts from. */
  subtreeRoot: bigint;
  /** Path elements above the C3 circuit, bottom-up. Levels 12.. */
  siblings: bigint[];
  /** Direction bits above the C3 circuit, same order. */
  directions: number[];
  nullifierGoldilocks: bigint;
  starkCommitment: bigint;
}

/**
 * Prepare a transfer: C1 + C3 over the OLD note (reuses prepareUnshield), then
 * a FRESH-secret C6 insertion proof for the recipient's new note.
 *
 * Sequencing matters: C1/C3 are generated first (via prepareUnshield), THEN the
 * tree is re-read for C6 so its old_root binds the LATEST on-chain root (C3 may
 * legitimately target an older historical root, but C6 must match
 * merkle_tree.root at execution).
 */
export async function prepareTransfer(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<PrepareTransferResult> {
  // 1. C1 + C3 over the OLD note (fetch leaves, build path, root pre-flight).
  const prep = await prepareUnshield(receipt, poolConfig, connection, onProgress);

  // 2. Fresh RANDOM secrets for the recipient note (no owner pubkey is baked
  //    into a V3 commitment, so a transfer = mint a brand-new note).
  const newSecret = secureRandomU64();
  const newNullifierPreimage = secureRandomU64();

  // 3. Re-read tree AFTER C1/C3 → latest leafCount + filled_subtrees + root.
  onProgress?.('Reading on-chain tree state for insertion...');
  const treeInfo = await connection.getAccountInfo(poolConfig.treePDA);
  if (!treeInfo) throw new Error(`Tree account not found: ${poolConfig.treePDA.toBase58()}`);
  const treeBuf = Buffer.from(treeInfo.data);
  const { leafCount, subtrees } = parseFilledSubtrees(treeBuf);

  let onChainRoot = 0n;
  for (let b = 7; b >= 0; b--) onChainRoot = (onChainRoot << 8n) | BigInt(treeBuf[8 + 32 + b]);

  const slot = await connection.getSlot('confirmed');
  const newDepositEpoch = slotToEpoch(slot);
  const tokenMintField = pubkeyToField(poolConfig.tokenMint);
  const newCommitment = createCommitmentV3(newNullifierPreimage, newSecret, newDepositEpoch, tokenMintField);
  const newLeaf = newCommitment;

  // 4. Direct-vs-sliced old_root pre-flight (identical to prepareShieldInsert):
  //    pick the filled_subtrees layout that reproduces the on-chain root before
  //    burning the ~2-min C6 proof.
  onProgress?.('Computing Merkle insertion path...');
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
      `Transfer pre-flight failed: cannot reconstruct the on-chain Merkle root ` +
      `(${onChainRoot}) from the pool's filled_subtrees for leaf #${leafCount} ` +
      `(direct=${oldRootDirect}, shifted=${oldRootSliced}). Refusing to burn C6 ` +
      `proof rent on a guaranteed InvalidProof — retry shortly.`,
    );
  }
  const { newRoot, updatedSubtrees, pathElements, pathIndices } = chosen;

  // 5. Generate C6 (merkle_update) proof for the new leaf.
  //
  // [C6-D12] Bottom 12 levels only; the top 3 are folded on chain against the
  // POOL ACCOUNT's `filled_subtrees`, never against anything sent from here.
  onProgress?.('Generating C6 (merkle_update) STARK proof (~60s)...');
  await starkProver.start();
  if (pathElements.length < C6_SUBTREE_DEPTH) {
    throw new Error(
      `Merkle insertion path has ${pathElements.length} elements, need at least ` +
      `${C6_SUBTREE_DEPTH} for the C6 circuit.`,
    );
  }
  const c6Raw = await starkProver.generateMerkleUpdateProof(
    '0',
    newLeaf.toString(),
    pathElements.slice(0, C6_SUBTREE_DEPTH).map((e) => e.toString()),
    pathIndices.slice(0, C6_SUBTREE_DEPTH),
  );
  const c6PublicInputs = c6Raw.publicInputs.map((s) => BigInt(s));
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
    c1ProofResult: prep.c1ProofResult,
    c3ProofResult: prep.c3ProofResult,
    c6ProofResult: {
      proofBytes: hexToBytes(c6Raw.proofHex),
      publicInputs: c6PublicInputs,
      proofSize: c6Raw.proofSize,
      circuitId: CIRCUIT_MERKLE_UPDATE,
    },
    insertParams: {
      newCommitment,
      // Kept for the CLIENT's own tree bookkeeping. ⛔ No longer sent.
      newRoot,
      oldSubtreeRoot: c6PublicInputs[2],
      newSubtreeRoot: c6PublicInputs[3],
      newSubtrees: updatedSubtrees,
      newSecret,
      newNullifierPreimage,
      newDepositEpoch,
      newLeafIndex: leafCount,
    },
    merkleRoot: prep.merkleRoot,
    subtreeRoot: prep.subtreeRoot,
    siblings: prep.siblings,
    directions: prep.directions,
    nullifierGoldilocks: prep.nullifierGoldilocks,
    starkCommitment: prep.starkCommitment,
  };
}

/**
 * Orchestrate a denominated note-to-note transfer:
 *   1. Submit + verify C1 (pool_commitment), C3 (merkle_path), C6 (merkle_update)
 *      — distinct buffer PDAs (keyed by circuit_id), all DEEP-ALI verified.
 *   2. Build + send transfer_denominated_stark_v3 (atomically spends old note
 *      via nullifier + inserts the new leaf).
 *   3. Close all 3 buffers in finally (rent recovery).
 *
 * Returns the tx signature + the recipient's shareable note.
 *
 * min_epoch is pinned to TRANSFER_MIN_EPOCH (0) — see that constant for why
 * the note's deposit epoch must never go there. The handler still evaluates
 * `current_epoch >= min_epoch + dynamic_delay`
 * (transfer_denominated_stark_v3.rs:165-173), which 0 always satisfies on a
 * live cluster. Maturity is refused by the store pre-flight instead, before
 * any proving, so an immature note never reaches this function.
 *
 * WHAT THIS TRANSFER PUBLISHES. `stark_commitment` (ix data byte 80) is the
 * OLD note's commitment — the same value the deposit wrote on-chain — and
 * `new_commitment` (bytes 88-120) is the note the recipient will later spend.
 * So the transfer is matchable to the sender's deposit, and the recipient's
 * eventual withdrawal (which republishes new_commitment) is matchable back to
 * this transfer. Passing a note through here does not break that chain; only
 * the C7 spend circuit does (docs/C7_SPEND_CIRCUIT_PLAN.md).
 */
export async function transferDenominatedStarkV3(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  prepared: PrepareTransferResult,
  signer: WalletSigner,
  connection: Connection,
  recipientAddress: string,
  onProgress?: (step: string) => void,
): Promise<{ txSig: string; encryptedNote: string }> {
  // Validate the recipient address up-front (before any proving/upload) so we
  // never spend rent on a transfer whose output we can't hand off securely.
  if (!isNoteEncryptionAddress(recipientAddress)) {
    throw new Error('Invalid recipient address. Expected a p01pq:… post-quantum note address.');
  }
  const {
    c1ProofResult, c3ProofResult, c6ProofResult,
    insertParams, merkleRoot, nullifierGoldilocks, starkCommitment,
    // [C3-D12] The read side's walk. `merkleRoot` is the POOL root from the
    // client's own tree; `subtreeRoot` is what C3 actually proved.
    subtreeRoot, siblings, directions,
  } = prepared;

  const createdBuffers: PublicKey[] = [];

  // Pre-flight balance: a transfer holds THREE STARK proof buffers (C1+C3+C6)
  // open simultaneously — the handler reads all three in one tx — so the peak
  // temporary rent is the sum of all three buffers (fully recovered when they
  // close). Compute it from the ACTUAL proof sizes (no hard-coded worst case).
  // The USER funds this float onto the ephemeral below; it is swept back after.
  onProgress?.('Checking wallet balance...');
  const [r1, r3, r6, balance] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(83 + c1ProofResult.proofSize),
    connection.getMinimumBalanceForRentExemption(83 + c3ProofResult.proofSize),
    connection.getMinimumBalanceForRentExemption(83 + c6ProofResult.proofSize),
    connection.getBalance(signer.publicKey),
  ]);
  const nullifierRent = 2_000_000; // NullifierRecord init (~0.0009 SOL) + margin
  const txFees = 8_000_000;        // ~390 buffer txs + inner + fund + sweep + priority headroom
  const required = r1 + r3 + r6 + nullifierRent + txFees;
  if (balance < required) {
    throw new Error(
      `Insufficient SOL for transfer. It needs ~${(required / 1e9).toFixed(2)} SOL of ` +
      `temporary proof-buffer rent (3 STARK proofs held open at once — fully recovered ` +
      `after the transaction confirms), but the wallet has ${(balance / 1e9).toFixed(3)} SOL. ` +
      `Fund the wallet (devnet: request an airdrop) and try again.`,
    );
  }

  // ── Phase 1 sender-anonymity ──────────────────────────────────────────────
  // A fresh, deterministic ephemeral E is the proof-buffer AUTHORITY and the
  // inner-tx PAYER, so the USER's wallet signs NOTHING on the transfer itself —
  // only the pre-fund tx below. E is re-derivable (deriveEphemeralForRelay) and
  // a recovery breadcrumb is recorded before funding, so the float is never
  // stranded. E's SOL is swept back to the user at the end.
  // (Phase 2 will source E's float from inside the pool + relay the buffer txs
  // to also break the user→E funding link and hide the originating IP.)
  const jobId = crypto.getRandomValues(new Uint8Array(16));
  const jobHex = jobIdToHex(jobId);
  const ephemeral = await deriveEphemeralForRelay(jobId);
  const eSigner: WalletSigner = {
    publicKey: ephemeral.publicKey,
    signTransaction: async (t: Transaction) => {
      if (!t.recentBlockhash) {
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        t.recentBlockhash = blockhash;
      }
      if (!t.feePayer) t.feePayer = ephemeral.publicKey;
      t.sign(ephemeral);
      return t;
    },
  };

  let result: { txSig: string; encryptedNote: string } | undefined;
  try {
    // Breadcrumb BEFORE funding (so a mid-flight crash is sweepable), then fund
    // E from the user wallet — the ONLY user signature in the whole transfer.
    await addPendingRelay({
      jobId: jobHex,
      ephemeralPubkey: ephemeral.publicKey.toBase58(),
      expectedLamports: required,
      createdAt: new Date().toISOString(),
      reason: 'transfer-ephemeral-authority',
    });
    onProgress?.('Funding the transfer signer...');
    const fundTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: ephemeral.publicKey, lamports: required }),
    );
    await signSendConfirmTx(connection, fundTx, signer);

    // Steps 1-3: upload + verify C1, C3, C6 — ALL signed by E (authority = E),
    // so the proof buffers + their PDAs are keyed on E, not the user.
    onProgress?.('Submitting C1 (pool_commitment) proof on-chain...');
    const c1Result = await submitAndVerifyStarkProof(
      { proofBytes: c1ProofResult.proofBytes, circuitId: CIRCUIT_POOL_COMMITMENT, publicInputs: c1ProofResult.publicInputs, proofSize: c1ProofResult.proofSize },
      eSigner, connection, onProgress,
    );
    createdBuffers.push(c1Result.proofBuffer);

    onProgress?.('Submitting C3 (merkle_path) proof on-chain...');
    const c3Result = await submitAndVerifyStarkProof(
      { proofBytes: c3ProofResult.proofBytes, circuitId: CIRCUIT_MERKLE_PATH, publicInputs: c3ProofResult.publicInputs, proofSize: c3ProofResult.proofSize },
      eSigner, connection, onProgress,
    );
    createdBuffers.push(c3Result.proofBuffer);

    onProgress?.('Submitting C6 (merkle_update) proof on-chain...');
    const c6Result = await submitAndVerifyStarkProof(
      { proofBytes: c6ProofResult.proofBytes, circuitId: CIRCUIT_MERKLE_UPDATE, publicInputs: c6ProofResult.publicInputs, proofSize: c6ProofResult.proofSize },
      eSigner, connection, onProgress,
    );
    createdBuffers.push(c6Result.proofBuffer);

    // Step 4: build + send transfer_denominated_stark_v3 — payer = E, signed by E.
    onProgress?.('Building V3 transfer transaction...');
    const nullifierBytes = goldilocksToLeBytes32(nullifierGoldilocks);
    const merkleRootBytes = goldilocksToLeBytes32(merkleRoot);
    const newCommitmentBytes = goldilocksToLeBytes32(insertParams.newCommitment);
    const newSubtreesBytes = insertParams.newSubtrees.map(goldilocksToLeBytes32);
    // min_epoch is no longer a parameter: the builder pins it to
    // TRANSFER_MIN_EPOCH (0). It used to be `receipt.depositEpoch`, which both
    // published the deposit's epoch window in the clear and would have made
    // every PRF-blinded note permanently un-transferable. Maturity is still
    // refused by this client, in the store pre-flight before any proving.
    const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);

    const ix = buildTransferDenominatedStarkV3Ix(
      ephemeral.publicKey,
      poolConfig.poolPDA,
      poolConfig.treePDA,
      nullifierPDA,
      c1Result.proofBuffer,
      c3Result.proofBuffer,
      c6Result.proofBuffer,
      nullifierBytes,
      merkleRootBytes,
      starkCommitment,
      newCommitmentBytes,
      insertParams.oldSubtreeRoot,
      insertParams.newSubtreeRoot,
      newSubtreesBytes,
      subtreeRoot,
      siblings,
      directions,
    );

    const tx = new Transaction();
    // [C3-D12 + C6-D12] 300,000 -> 800,000. Transfer is the ONLY path that pays
    // for both walks in one instruction:
    //
    //   `resolve_pool_root` (read side)  3 hashes  ~103,400 CU
    //   `fold_insertion`    (write side) 6 hashes  ~206,814 CU
    //
    // at the ~34,469 CU per on-chain `hash2` measured 2026-08-29 on the litesvm
    // SBF VM. That is ~310,000 CU of new work on top of a handler that already
    // used to want 300,000.
    //
    // ⚠️ 800,000 IS DERIVED FROM TWO MEASURED WALKS PLUS THE OLD BUDGET, NOT
    // MEASURED END TO END. This handler's total has not been run on the SBF VM
    // since the walks landed. It stays well under the 1,400,000 cap, and the
    // failure it guards against would land at the END of three proof uploads.
    tx.add(...buildComputeBudgetIxs(800_000));
    tx.add(ix);

    onProgress?.('Sending V3 transfer transaction...');
    // Phase 1: E signs + submits the transfer directly. (Phase 2b will route
    // E's buffer + inner txs through the relayer to also hide the user's IP.)
    const txSig = await signSendConfirmTx(connection, tx, eSigner);
    onProgress?.('V3 transfer confirmed!');

    const recipientNote: ShareableNote = {
      version: 1,
      pool: poolConfig.poolPDA.toBase58(),
      secret: insertParams.newSecret.toString(),
      nullifier_preimage: insertParams.newNullifierPreimage.toString(),
      deposit_epoch: insertParams.newDepositEpoch.toString(),
      token_mint: pubkeyToField(poolConfig.tokenMint).toString(),
      commitment: insertParams.newCommitment.toString(),
      leafIndex: insertParams.newLeafIndex,
      token: poolConfig.token,
      denominationHuman: poolConfig.denomination,
      shieldedAt: Date.now(),
    };

    // Encrypt the note TO the recipient's p01pq address (hybrid X25519 +
    // ML-KEM-768 → XSalsa20-Poly1305). The blob is safe to intercept: only the
    // recipient's wallet seed can decrypt it.
    const encryptedNote = encryptNote(recipientAddress, utf8ToBytes(JSON.stringify(recipientNote)));
    result = { txSig, encryptedNote };
  } finally {
    // Close E's proof buffers (rent → E), then sweep E's residual back to the
    // user — recovers the pre-funded float whether the transfer succeeded or
    // threw. If the sweep itself fails, the breadcrumb keeps the funds
    // recoverable from the Recover screen.
    for (const buf of createdBuffers) {
      try {
        onProgress?.('Closing proof buffer (rent recovery)...');
        await closeStarkProofBuffer(buf, eSigner, connection);
      } catch (closeErr: unknown) {
        console.warn(
          '[DenomPool/ext] closeStarkProofBuffer (transfer) failed:',
          closeErr instanceof Error ? closeErr.message : String(closeErr),
        );
      }
    }
    try {
      const eBal = await connection.getBalance(ephemeral.publicKey, 'confirmed');
      const sweepable = eBal - 5000; // leave the sweep tx fee
      if (sweepable > 0) {
        onProgress?.('Returning recovered rent to your wallet...');
        const sweepTx = new Transaction().add(
          SystemProgram.transfer({ fromPubkey: ephemeral.publicKey, toPubkey: signer.publicKey, lamports: sweepable }),
        );
        await signSendConfirmTx(connection, sweepTx, eSigner);
      }
      await removePendingRelay(jobHex);
    } catch (sweepErr: unknown) {
      const msg = sweepErr instanceof Error ? sweepErr.message : String(sweepErr);
      console.warn('[DenomPool/ext] ephemeral sweep failed; funds recoverable via breadcrumb:', msg);
      try { await markPendingRelayErrored(jobHex, 'sweep failed: ' + msg); } catch { /* ignore */ }
    }
  }
  return result!;
}

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
  const depositEpoch = BigInt(note.deposit_epoch);
  const tokenMint = BigInt(note.token_mint);
  const commitment = BigInt(note.commitment);

  const recomputed = createCommitmentV3(nullifierPreimage, secret, depositEpoch, tokenMint);
  if (recomputed !== commitment) {
    throw new Error('Invalid note: commitment does not match its secrets.');
  }

  return {
    secret,
    nullifierPreimage,
    depositEpoch,
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
