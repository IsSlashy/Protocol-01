/**
 * LiquidityModule — thin wrapper around the on-chain `p01_liquidity` program.
 *
 * Mirrors apps/mobile/services/liquidity. Builds Anchor instructions for:
 *   - init_pool / update_params (admin)
 *   - deposit / withdraw         (LPs)
 *   - prefund / settle           (instant-unshield path)
 *
 * Does NOT submit transactions — returns `TransactionInstruction`s the caller
 * can bundle into their own signing flow. This keeps the module usable from
 * both mobile (WalletSigner) and server/keeper (Keypair) environments.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

// ─── Program IDs (same on devnet + mainnet once deployed) ────────────────────

export const P01_LIQUIDITY_PROGRAM_ID = new PublicKey(
  '6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg',
);

const POOL_SEED = Buffer.from('liquidity_pool');
const PREFUND_SEED = Buffer.from('prefund');
const LP_SHARE_SEED = Buffer.from('lp_share');

function disc(name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`))).subarray(0, 8);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LiquidityPoolState {
  admin: PublicKey;
  totalShares: bigint;
  reserveLamports: bigint;
  prefundFeeBps: number;
  settlerRewardBps: number;
  isActive: boolean;
  bump: number;
}

export interface PrefundRecordState {
  pool: PublicKey;
  denominatedPool: PublicKey;
  nullifier: Uint8Array;
  merkleRoot: Uint8Array;
  publicInputsHash: Uint8Array;
  starkCommitment: bigint;
  amount: bigint;
  minEpoch: bigint;
  proofBuffer: PublicKey;
  ephemeralSigner: PublicKey;
  settlerReward: bigint;
  openedAtSlot: bigint;
  bump: number;
}

export interface PrefundIxArgs {
  ephemeralSigner: PublicKey;
  recipient: PublicKey;
  denominatedPool: PublicKey;
  starkProofBuffer: PublicKey;
  nullifier: Uint8Array | number[];
  merkleRoot: Uint8Array | number[];
  minEpoch: bigint;
  starkCommitment: bigint;
  amount: bigint;
}

export interface SettleIxArgs {
  settler: PublicKey;
  denominatedPool: PublicKey;
  merkleTree: PublicKey;
  nullifierRecord: PublicKey;
  starkProofBuffer: PublicKey;
  nullifier: Uint8Array | number[];
  /** The zk_shielded program ID to invoke via CPI. */
  zkShieldedProgram: PublicKey;
  /** The hardcoded protocol fee wallet zk_shielded credits on unshield. */
  protocolFeeWallet: PublicKey;
}

export interface PrefundFeeBreakdown {
  prefundFee: bigint;
  settlerReward: bigint;
  recipientAmount: bigint;
}

// ─── Module ──────────────────────────────────────────────────────────────────

export class LiquidityModule {
  constructor(
    public readonly connection: Connection,
    public readonly programId: PublicKey = P01_LIQUIDITY_PROGRAM_ID,
  ) {}

  // ── PDAs ──────────────────────────────────────────────────────────────────

  getPoolPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([POOL_SEED], this.programId);
  }

  /**
   * PrefundRecord PDA — seeds `[b"prefund", denominated_pool, nullifier[..8]]`.
   *
   * The seed is the FIRST 8 BYTES of the nullifier, not all 32: that is exactly
   * what the circuit-1 public-inputs hash commits to, and `init` on this PDA is
   * the only anti-replay constraint `prefund` has. See
   * `programs/p01_liquidity/src/instructions/prefund.rs`.
   */
  getPrefundRecordPDA(
    denominatedPool: PublicKey,
    nullifier: Uint8Array | number[],
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [PREFUND_SEED, denominatedPool.toBuffer(), Buffer.from(nullifier).subarray(0, 8)],
      this.programId,
    );
  }

  getLpSharePDA(owner: PublicKey, pool: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [LP_SHARE_SEED, owner.toBuffer(), pool.toBuffer()],
      this.programId,
    );
  }

  // ── State readers ─────────────────────────────────────────────────────────

  async fetchPoolState(): Promise<LiquidityPoolState | null> {
    const [poolPDA] = this.getPoolPDA();
    const acc = await this.connection.getAccountInfo(poolPDA);
    if (!acc) return null;
    return LiquidityModule.parsePoolState(acc.data);
  }

  static parsePoolState(data: Buffer): LiquidityPoolState {
    // 8 disc + 32 admin + 16 total_shares + 8 reserve + 2 fee + 2 reward + 1 active + 1 bump
    const admin = new PublicKey(data.subarray(8, 40));
    const lo = data.readBigUInt64LE(40);
    const hi = data.readBigUInt64LE(48);
    const totalShares = lo | (hi << 64n);
    return {
      admin,
      totalShares,
      reserveLamports: data.readBigUInt64LE(56),
      prefundFeeBps: data.readUInt16LE(64),
      settlerRewardBps: data.readUInt16LE(66),
      isActive: data[68] === 1,
      bump: data[69]!,
    };
  }

  static parsePrefundRecord(data: Buffer): PrefundRecordState {
    // 8 disc + 32 pool + 32 denom_pool + 32 nullifier + 32 root
    //   + 32 inputs_hash + 8 commitment + 8 amount + 8 min_epoch
    //   + 32 proof_buffer + 32 ephemeral + 8 reward + 8 slot + 1 bump
    return {
      pool:             new PublicKey(data.subarray(8, 40)),
      denominatedPool:  new PublicKey(data.subarray(40, 72)),
      nullifier:        Uint8Array.from(data.subarray(72, 104)),
      merkleRoot:       Uint8Array.from(data.subarray(104, 136)),
      publicInputsHash: Uint8Array.from(data.subarray(136, 168)),
      starkCommitment:  data.readBigUInt64LE(168),
      amount:           data.readBigUInt64LE(176),
      minEpoch:         data.readBigUInt64LE(184),
      proofBuffer:      new PublicKey(data.subarray(192, 224)),
      ephemeralSigner:  new PublicKey(data.subarray(224, 256)),
      settlerReward:    data.readBigUInt64LE(256),
      openedAtSlot:     data.readBigUInt64LE(264),
      bump:             data[272]!,
    };
  }

  // ── Instruction builders ─────────────────────────────────────────────────

  buildInitPoolIx(
    admin: PublicKey,
    prefundFeeBps: number,
    settlerRewardBps: number,
  ): TransactionInstruction {
    const [poolPDA] = this.getPoolPDA();
    const data = Buffer.alloc(8 + 2 + 2);
    disc('init_pool').copy(data, 0);
    data.writeUInt16LE(prefundFeeBps, 8);
    data.writeUInt16LE(settlerRewardBps, 10);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  buildDepositIx(depositor: PublicKey, amount: bigint): TransactionInstruction {
    const [poolPDA] = this.getPoolPDA();
    const [sharePDA] = this.getLpSharePDA(depositor, poolPDA);
    const data = Buffer.alloc(8 + 8);
    disc('deposit').copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: depositor, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: sharePDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  buildWithdrawIx(depositor: PublicKey, shares: bigint): TransactionInstruction {
    const [poolPDA] = this.getPoolPDA();
    const [sharePDA] = this.getLpSharePDA(depositor, poolPDA);
    const data = Buffer.alloc(8 + 16);
    disc('withdraw').copy(data, 0);
    const lo = shares & 0xFFFFFFFFFFFFFFFFn;
    const hi = shares >> 64n;
    data.writeBigUInt64LE(lo, 8);
    data.writeBigUInt64LE(hi, 16);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: depositor, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: sharePDA, isSigner: false, isWritable: true },
        { pubkey: depositor, isSigner: false, isWritable: false }, // owner (has_one = owner)
      ],
      data,
    });
  }

  buildPrefundIx(args: PrefundIxArgs): TransactionInstruction {
    const [poolPDA] = this.getPoolPDA();
    const [prefundRecord] = this.getPrefundRecordPDA(args.denominatedPool, args.nullifier);

    const data = Buffer.alloc(8 + 32 + 32 + 8 + 8 + 8);
    let off = 0;
    disc('prefund').copy(data, off); off += 8;
    Buffer.from(args.nullifier).copy(data, off); off += 32;
    Buffer.from(args.merkleRoot).copy(data, off); off += 32;
    data.writeBigUInt64LE(args.minEpoch, off); off += 8;
    data.writeBigUInt64LE(args.starkCommitment, off); off += 8;
    data.writeBigUInt64LE(args.amount, off);

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: args.ephemeralSigner,  isSigner: true,  isWritable: true  },
        { pubkey: args.recipient,        isSigner: false, isWritable: true  },
        { pubkey: poolPDA,               isSigner: false, isWritable: true  },
        { pubkey: args.starkProofBuffer, isSigner: false, isWritable: false },
        { pubkey: args.denominatedPool,  isSigner: false, isWritable: false },
        { pubkey: prefundRecord,         isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  buildSettleIx(args: SettleIxArgs): TransactionInstruction {
    const [poolPDA] = this.getPoolPDA();
    const [prefundRecord] = this.getPrefundRecordPDA(args.denominatedPool, args.nullifier);

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: args.settler,           isSigner: true,  isWritable: true  },
        { pubkey: poolPDA,                isSigner: false, isWritable: true  },
        { pubkey: prefundRecord,          isSigner: false, isWritable: true  },
        { pubkey: args.denominatedPool,   isSigner: false, isWritable: true  },
        { pubkey: args.merkleTree,        isSigner: false, isWritable: false },
        { pubkey: args.nullifierRecord,   isSigner: false, isWritable: true  },
        { pubkey: args.starkProofBuffer,  isSigner: false, isWritable: false },
        { pubkey: args.protocolFeeWallet, isSigner: false, isWritable: true  },
        { pubkey: args.zkShieldedProgram, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: disc('settle'),
    });
  }

  // ── Fee math (mirror of on-chain) ─────────────────────────────────────────

  static computePrefundFees(
    amount: bigint,
    prefundFeeBps: number,
    settlerRewardBps: number,
  ): PrefundFeeBreakdown {
    const prefundFee = (amount * BigInt(prefundFeeBps)) / 10_000n;
    const settlerReward = (amount * BigInt(settlerRewardBps)) / 10_000n;
    return {
      prefundFee,
      settlerReward,
      recipientAmount: amount - prefundFee - settlerReward,
    };
  }
}
