/**
 * P01 Liquidity Pool client (mobile).
 *
 * Thin wrapper around the on-chain `p01_liquidity` program (declare_id =
 * 6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg). Exposes PDA derivation,
 * Anchor instruction builders, and a `buildPrefund*` helper that composes
 * with the already-uploaded STARK proof buffer from services/stark.
 *
 * Intentionally dependency-free on services/denominatedPool to keep the
 * module graph acyclic — callers thread the pool config / nullifier / root
 * through the `PrefundArgs` struct.
 */
import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------
// Program ID + constants
// ---------------------------------------------------------------------------

export const P01_LIQUIDITY_PROGRAM_ID = new PublicKey(
  '6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg',
);

export const ZK_SHIELDED_PROGRAM_ID = new PublicKey(
  'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c',
);

export const PROTOCOL_FEE_WALLET = new PublicKey(
  'BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN',
);

const POOL_SEED = Buffer.from('liquidity_pool');
const PREFUND_SEED = Buffer.from('prefund');
const LP_SHARE_SEED = Buffer.from('lp_share');

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

export function getLiquidityPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], P01_LIQUIDITY_PROGRAM_ID);
}

export function getPrefundRecordPDA(
  denominatedPool: PublicKey,
  nullifier: Uint8Array | number[],
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PREFUND_SEED, denominatedPool.toBuffer(), Buffer.from(nullifier)],
    P01_LIQUIDITY_PROGRAM_ID,
  );
}

export function getLpSharePDA(owner: PublicKey, pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [LP_SHARE_SEED, owner.toBuffer(), pool.toBuffer()],
    P01_LIQUIDITY_PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Anchor ix discriminators
// ---------------------------------------------------------------------------

function disc(name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`))).subarray(0, 8);
}

// ---------------------------------------------------------------------------
// On-chain pool state
// ---------------------------------------------------------------------------

export interface LiquidityPoolState {
  admin: PublicKey;
  totalShares: bigint;
  reserveLamports: bigint;
  prefundFeeBps: number;
  settlerRewardBps: number;
  isActive: boolean;
  bump: number;
}

export function parseLiquidityPoolState(data: Buffer): LiquidityPoolState {
  // Layout: 8 disc + 32 admin + 16 total_shares + 8 reserve + 2 fee + 2 reward + 1 active + 1 bump
  const admin = new PublicKey(data.subarray(8, 40));
  const sharesLo = data.readBigUInt64LE(40);
  const sharesHi = data.readBigUInt64LE(48);
  const totalShares = sharesLo | (sharesHi << 64n);
  const reserveLamports = data.readBigUInt64LE(56);
  const prefundFeeBps = data.readUInt16LE(64);
  const settlerRewardBps = data.readUInt16LE(66);
  const isActive = data[68] === 1;
  const bump = data[69];
  return { admin, totalShares, reserveLamports, prefundFeeBps, settlerRewardBps, isActive, bump };
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

export interface PrefundArgs {
  /** Ephemeral signer — must match the STARK proof buffer's authority. */
  ephemeralSigner: PublicKey;
  /** Who receives the prefunded lamports. */
  recipient: PublicKey;
  /** The denominated_pool PDA the note belongs to (zk_shielded). */
  denominatedPool: PublicKey;
  /** The STARK proof buffer PDA (already uploaded + verified). */
  starkProofBuffer: PublicKey;
  /** 32-byte nullifier (as used in zk_shielded). */
  nullifier: Uint8Array | number[];
  /** 32-byte merkle root the proof was generated against. */
  merkleRoot: Uint8Array | number[];
  /** Matching the zk_shielded unshield min_epoch arg (0 for emergency). */
  minEpoch: bigint;
  /** Goldilocks commitment u64 from the STARK proof's public inputs. */
  starkCommitment: bigint;
  /** Denomination lamports of the note being prefunded. */
  amount: bigint;
}

export function buildPrefundIx(args: PrefundArgs): TransactionInstruction {
  const [poolPDA] = getLiquidityPoolPDA();
  const [prefundRecord] = getPrefundRecordPDA(args.denominatedPool, args.nullifier);

  const data = Buffer.alloc(8 + 32 + 32 + 8 + 8 + 8);
  let off = 0;
  disc('prefund').copy(data, off); off += 8;
  Buffer.from(args.nullifier).copy(data, off); off += 32;
  Buffer.from(args.merkleRoot).copy(data, off); off += 32;
  data.writeBigUInt64LE(args.minEpoch, off); off += 8;
  data.writeBigUInt64LE(args.starkCommitment, off); off += 8;
  data.writeBigUInt64LE(args.amount, off);

  const keys = [
    { pubkey: args.ephemeralSigner, isSigner: true, isWritable: true },
    { pubkey: args.recipient, isSigner: false, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: args.starkProofBuffer, isSigner: false, isWritable: false },
    { pubkey: args.denominatedPool, isSigner: false, isWritable: false },
    { pubkey: prefundRecord, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: P01_LIQUIDITY_PROGRAM_ID,
    keys,
    data,
  });
}

export interface SettleArgs {
  settler: PublicKey;
  denominatedPool: PublicKey;
  merkleTree: PublicKey;
  /** zk_shielded nullifier PDA (seeds = ["nullifier", denominated_pool, nullifier]). */
  nullifierRecord: PublicKey;
  /** Same STARK proof buffer passed to prefund. Must still be open + verified. */
  starkProofBuffer: PublicKey;
  /** 32-byte nullifier used when the prefund was opened. */
  nullifier: Uint8Array | number[];
}

export function buildSettleIx(args: SettleArgs): TransactionInstruction {
  const [poolPDA] = getLiquidityPoolPDA();
  const [prefundRecord] = getPrefundRecordPDA(args.denominatedPool, args.nullifier);

  const data = disc('settle'); // no args

  const keys = [
    { pubkey: args.settler, isSigner: true, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: prefundRecord, isSigner: false, isWritable: true },
    { pubkey: args.denominatedPool, isSigner: false, isWritable: true },
    { pubkey: args.merkleTree, isSigner: false, isWritable: false },
    { pubkey: args.nullifierRecord, isSigner: false, isWritable: true },
    { pubkey: args.starkProofBuffer, isSigner: false, isWritable: false },
    { pubkey: PROTOCOL_FEE_WALLET, isSigner: false, isWritable: true },
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: P01_LIQUIDITY_PROGRAM_ID,
    keys,
    data,
  });
}

export interface DepositArgs {
  depositor: PublicKey;
  amount: bigint;
}

export function buildDepositIx(args: DepositArgs): TransactionInstruction {
  const [poolPDA] = getLiquidityPoolPDA();
  const [sharePDA] = getLpSharePDA(args.depositor, poolPDA);

  const data = Buffer.alloc(8 + 8);
  disc('deposit').copy(data, 0);
  data.writeBigUInt64LE(args.amount, 8);

  return new TransactionInstruction({
    programId: P01_LIQUIDITY_PROGRAM_ID,
    keys: [
      { pubkey: args.depositor, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: sharePDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface WithdrawArgs {
  depositor: PublicKey;
  shares: bigint;
}

export function buildWithdrawIx(args: WithdrawArgs): TransactionInstruction {
  const [poolPDA] = getLiquidityPoolPDA();
  const [sharePDA] = getLpSharePDA(args.depositor, poolPDA);

  // u128 LE
  const data = Buffer.alloc(8 + 16);
  disc('withdraw').copy(data, 0);
  const lo = args.shares & 0xFFFFFFFFFFFFFFFFn;
  const hi = args.shares >> 64n;
  data.writeBigUInt64LE(lo, 8);
  data.writeBigUInt64LE(hi, 16);

  return new TransactionInstruction({
    programId: P01_LIQUIDITY_PROGRAM_ID,
    keys: [
      { pubkey: args.depositor, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: sharePDA, isSigner: false, isWritable: true },
      { pubkey: args.depositor, isSigner: false, isWritable: false }, // owner (has_one = owner)
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Fee math (mirror of on-chain)
// ---------------------------------------------------------------------------

export interface PrefundFeeBreakdown {
  prefundFee: bigint;
  settlerReward: bigint;
  recipientAmount: bigint;
}

export function computePrefundFees(
  amount: bigint,
  prefundFeeBps: number,
  settlerRewardBps: number,
): PrefundFeeBreakdown {
  const prefundFee = (amount * BigInt(prefundFeeBps)) / 10_000n;
  const settlerReward = (amount * BigInt(settlerRewardBps)) / 10_000n;
  const recipientAmount = amount - prefundFee - settlerReward;
  return { prefundFee, settlerReward, recipientAmount };
}
