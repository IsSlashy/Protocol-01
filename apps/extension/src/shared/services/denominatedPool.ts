/**
 * Denominated Pool Service — Extension (Phase 1, C3-free)
 *
 * Goldilocks V3 denominated pool support for the extension. Implements
 * shield (circuit 6) and the note material needed for private subscribe
 * (circuit 1). Does NOT implement unshield or transfer (circuit 3 is
 * broken on-chain).
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
  type GenericStarkProof,
  type WalletSigner,
} from './stark';

// STARK WASM prover singleton.
import { starkProver } from './starkProver';

// ---------------------------------------------------------------------------
// Re-export CIRCUIT_POOL_COMMITMENT so consumers can import from here.
// ---------------------------------------------------------------------------
export { CIRCUIT_POOL_COMMITMENT, CIRCUIT_MERKLE_UPDATE, type WalletSigner };

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
    depositEpoch: bigint;
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
): Promise<{
  c6ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number; circuitId: number };
  insertParams: {
    commitment: bigint;
    newRoot: bigint;
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
  const { leafCount, subtrees } = parseFilledSubtrees(Buffer.from(treeInfo.data));

  // 2. Derive note material.
  onProgress?.('Deriving note material...');
  const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, poolConfig.poolPDA, counter);

  // 3. Get current epoch for depositEpoch.
  const slot = await connection.getSlot('confirmed');
  const depositEpoch = slotToEpoch(slot);

  // 4. Compute Goldilocks commitment.
  const tokenMintField = pubkeyToField(poolConfig.tokenMint);
  const commitment = createCommitmentV3(nullifierPreimage, secret, depositEpoch, tokenMintField);

  // The commitment IS the leaf in V3. Stored as u64 LE (low 8 bytes of the
  // 32-byte field element).
  const newLeaf = commitment;

  // 5. Compute new root + path from filledSubtrees.
  onProgress?.('Computing Merkle path...');
  const { newRoot, updatedSubtrees, pathElements, pathIndices } =
    computeNewRootFromSubtreesV3(newLeaf, leafCount, subtrees);

  // 6. Generate C6 STARK proof.
  onProgress?.('Generating C6 (merkle_update) STARK proof (30-60s)...');
  await starkProver.start();
  const c6Result = await starkProver.generateMerkleUpdateProof(
    '0',                          // oldLeaf = 0 (empty slot)
    newLeaf.toString(),           // newLeaf = commitment u64
    pathElements.map(e => e.toString()),
    pathIndices,
  );

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
      depositEpoch,
      leafIndex: leafCount,
    },
    newLeaf,
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
