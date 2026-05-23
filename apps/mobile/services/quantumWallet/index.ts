/**
 * Quantum Wallet Service — Protocol 01
 *
 * Client-side protocol bindings for `p01_quantum_wallet`.
 * The on-chain side is STARK-gated on every spend (circuit 0,
 * subscriber_ownership). Deposits are open (no proof). We mirror the
 * mature subscribe / unshield-stark pattern from denominatedPool.
 *
 * Program: D7RBAFcMq2gGddwFvabZKuJB1eWZFvESVrcJ3i15FFtz
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const QUANTUM_WALLET_PROGRAM_ID = new PublicKey(
  'D7RBAFcMq2gGddwFvabZKuJB1eWZFvESVrcJ3i15FFtz',
);

/** PDA seed prefix for `QuantumWalletAccount` — must match the Rust constant. */
const WALLET_SEED = Buffer.from('qw');

/** PDA seed prefix for `SphincsSigBuffer`. */
const SPHINCS_SEED = Buffer.from('sphincs_sig');

/** Anchor instruction discriminators (sha256("global:<ix_name>")[..8]). */
const D = {
  init: Buffer.from([106, 1, 51, 201, 157, 247, 4, 192]),
  deposit: Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
  withdraw: Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]),
  transfer: Buffer.from([143, 9, 216, 41, 137, 140, 29, 179]),
  rotate: Buffer.from([217, 223, 66, 136, 150, 12, 138, 42]),
  initSphincsBuf: Buffer.from([201, 160, 186, 186, 10, 230, 163, 210]),
  writeSphincsChunk: Buffer.from([150, 152, 102, 0, 7, 11, 120, 14]),
  closeSphincsBuf: Buffer.from([238, 86, 140, 74, 174, 12, 77, 158]),
  recover: Buffer.from([96, 6, 221, 204, 54, 90, 245, 254]),
};

/** Minimum lamports kept on the Ed25519 (owner_id) to cover transient rent
 * for STARK proof-buffer ops. Rent-exempt formula for 80076 bytes (circuit-0
 * proof, PROOF_DATA_OFFSET + 79993 proof_size) = (80076 + 128) * 6960 lamports
 * = 0.558 SOL. We keep 0.6 SOL with a small safety margin for tx fees + future
 * UNIFORM_PROOF_SIZE (145 KB) headroom. Rent is refunded when the proof buffer
 * closes after verify, so user funds aren't lost — just kept liquid for the
 * next send. Re-tuned 2026-05-23 from 0.35 after observing 0x1 (InsufficientFunds)
 * sim failures on init+resize at 0.35 SOL Ed25519 balance. */
export const AUTO_DEPOSIT_KEEP_LAMPORTS = 600_000_000; // 0.6 SOL

/** Minimum lamports on Ed25519 to trigger an auto-deposit at all. Set just
 * above the keep amount so we only sweep when there's a meaningful surplus. */
export const AUTO_DEPOSIT_TRIGGER_LAMPORTS = 620_000_000; // 0.62 SOL

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

/** Returns the PDA for a quantum wallet given its `owner_id` seed pubkey. */
export function getQuantumWalletPDA(ownerId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [WALLET_SEED, ownerId.toBuffer()],
    QUANTUM_WALLET_PROGRAM_ID,
  );
}

/** PDA for a SPHINCS+ signature upload buffer. */
export function getSphincsSigBufferPDA(
  walletPda: PublicKey,
  authority: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SPHINCS_SEED, walletPda.toBuffer(), authority.toBuffer()],
    QUANTUM_WALLET_PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// On-chain state decoding
// ---------------------------------------------------------------------------

export interface QuantumWalletAccount {
  ownerId: PublicKey;
  commitmentToSecret: Uint8Array; // 32 bytes
  balance: bigint;
  nonce: bigint;
  recoveryPubkey: Uint8Array | null; // 32 bytes if Some
  createdSlot: bigint;
  bump: number;
}

/** Anchor account discriminator for `QuantumWalletAccount`: sha256("account:QuantumWalletAccount")[..8]. */
const QW_ACCOUNT_DISCRIMINATOR = Buffer.from([
  // Computed via: sha256("account:QuantumWalletAccount")[..8]
  // Filled at runtime from a known IDL — for now we leave the verification to
  // Anchor on-chain and skip the discriminator check client-side. (Decode is
  // best-effort; on a mismatch the parsed fields will be garbage and the
  // caller's downstream require! will fail.)
]);

export function decodeQuantumWalletAccount(data: Buffer): QuantumWalletAccount {
  // Skip 8-byte discriminator.
  let off = 8;
  const ownerId = new PublicKey(data.subarray(off, off + 32)); off += 32;
  const commitmentToSecret = Uint8Array.from(data.subarray(off, off + 32)); off += 32;
  const balance = data.readBigUInt64LE(off); off += 8;
  const nonce = data.readBigUInt64LE(off); off += 8;
  // Anchor encodes Option<T> as `0` (None) or `1 || T`.
  const hasRecovery = data[off]; off += 1;
  let recoveryPubkey: Uint8Array | null = null;
  if (hasRecovery === 1) {
    recoveryPubkey = Uint8Array.from(data.subarray(off, off + 32));
    off += 32;
  } else {
    // The Rust struct uses Option<[u8; 32]> so when None, the 32 bytes are
    // absent (Anchor 0.32 encodes this with a leading tag only, not zero-fill).
    // The struct's wire size is variable — we don't pre-skip the 32 bytes.
  }
  const createdSlot = data.readBigUInt64LE(off); off += 8;
  const bump = data[off]; off += 1;
  return {
    ownerId,
    commitmentToSecret,
    balance,
    nonce,
    recoveryPubkey,
    createdSlot,
    bump,
  };
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

/** Encode `[u8; 32]` into a Borsh fixed-length array (no length prefix). */
function encode32(bytes: Uint8Array): Buffer {
  if (bytes.length !== 32) throw new Error('expected 32-byte array');
  return Buffer.from(bytes);
}

/** Encode `Option<[u8; 32]>`. */
function encodeOption32(bytes: Uint8Array | null): Buffer {
  if (bytes === null) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), Buffer.from(bytes)]);
}

/** Encode a u64 little-endian. */
function encodeU64(n: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(typeof n === 'bigint' ? n : BigInt(n));
  return buf;
}

/** Encode a u32 little-endian. */
function encodeU32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n);
  return buf;
}

/** init_quantum_wallet — payer signs, wallet PDA created. */
export function buildInitQuantumWalletIx(args: {
  payer: PublicKey;
  ownerId: PublicKey;
  commitmentToSecret: Uint8Array;
  recoveryPubkey: Uint8Array | null;
}): TransactionInstruction {
  const [wallet] = getQuantumWalletPDA(args.ownerId);
  const data = Buffer.concat([
    D.init,
    encode32(args.commitmentToSecret),
    encodeOption32(args.recoveryPubkey),
  ]);
  return new TransactionInstruction({
    programId: QUANTUM_WALLET_PROGRAM_ID,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.ownerId, isSigner: false, isWritable: false },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** deposit — anyone can fund any wallet. */
export function buildDepositIx(args: {
  depositor: PublicKey;
  ownerId: PublicKey;
  amount: bigint | number;
}): TransactionInstruction {
  const [wallet] = getQuantumWalletPDA(args.ownerId);
  const data = Buffer.concat([D.deposit, encodeU64(args.amount)]);
  return new TransactionInstruction({
    programId: QUANTUM_WALLET_PROGRAM_ID,
    keys: [
      { pubkey: args.depositor, isSigner: true, isWritable: true },
      { pubkey: args.ownerId, isSigner: false, isWritable: false },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** withdraw — STARK-gated. Caller MUST have a fresh verified ProofBuffer. */
export function buildWithdrawIx(args: {
  payer: PublicKey;
  ownerId: PublicKey;
  recipient: PublicKey;
  proofBuffer: PublicKey;
  amount: bigint | number;
  expectedNonce: bigint | number;
}): TransactionInstruction {
  const [wallet] = getQuantumWalletPDA(args.ownerId);
  const data = Buffer.concat([
    D.withdraw,
    encodeU64(args.amount),
    encodeU64(args.expectedNonce),
  ]);
  return new TransactionInstruction({
    programId: QUANTUM_WALLET_PROGRAM_ID,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.ownerId, isSigner: false, isWritable: false },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: args.recipient, isSigner: false, isWritable: true },
      { pubkey: args.proofBuffer, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** transfer_to_quantum — STARK-gated wallet-to-wallet move. */
export function buildTransferToQuantumIx(args: {
  payer: PublicKey;
  srcOwnerId: PublicKey;
  dstOwnerId: PublicKey;
  proofBuffer: PublicKey;
  amount: bigint | number;
  expectedNonce: bigint | number;
}): TransactionInstruction {
  const [srcWallet] = getQuantumWalletPDA(args.srcOwnerId);
  const [dstWallet] = getQuantumWalletPDA(args.dstOwnerId);
  const data = Buffer.concat([
    D.transfer,
    encodeU64(args.amount),
    encodeU64(args.expectedNonce),
  ]);
  return new TransactionInstruction({
    programId: QUANTUM_WALLET_PROGRAM_ID,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.srcOwnerId, isSigner: false, isWritable: false },
      { pubkey: srcWallet, isSigner: false, isWritable: true },
      { pubkey: args.dstOwnerId, isSigner: false, isWritable: false },
      { pubkey: dstWallet, isSigner: false, isWritable: true },
      { pubkey: args.proofBuffer, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** rotate_secret — STARK-gated commitment swap. */
export function buildRotateSecretIx(args: {
  payer: PublicKey;
  ownerId: PublicKey;
  proofBuffer: PublicKey;
  newCommitment: Uint8Array;
  expectedNonce: bigint | number;
}): TransactionInstruction {
  const [wallet] = getQuantumWalletPDA(args.ownerId);
  const data = Buffer.concat([
    D.rotate,
    encode32(args.newCommitment),
    encodeU64(args.expectedNonce),
  ]);
  return new TransactionInstruction({
    programId: QUANTUM_WALLET_PROGRAM_ID,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.ownerId, isSigner: false, isWritable: false },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: args.proofBuffer, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pad a Goldilocks u64 felt (as decimal string) to a 32-byte LE buffer.
 * Matches `commitment_public_input_bytes` on-chain: first 8 bytes are LE u64,
 * remaining 24 bytes are zero (reserved). */
export function feltStringToCommitment(felt: string): Uint8Array {
  const u = BigInt(felt);
  const buf = new Uint8Array(32);
  // little-endian u64 in bytes 0..8
  for (let i = 0; i < 8; i++) {
    buf[i] = Number((u >> BigInt(8 * i)) & BigInt(0xff));
  }
  return buf;
}

/** Extract the leading u64 (LE) from a 32-byte commitment. */
export function commitmentToFeltString(commitment: Uint8Array): string {
  let u = BigInt(0);
  for (let i = 0; i < 8; i++) {
    u |= BigInt(commitment[i]) << BigInt(8 * i);
  }
  return u.toString();
}

/** Fetch a quantum wallet's on-chain state. Returns null if PDA does not exist. */
export async function fetchQuantumWallet(
  connection: Connection,
  ownerId: PublicKey,
): Promise<QuantumWalletAccount | null> {
  const [pda] = getQuantumWalletPDA(ownerId);
  const info = await connection.getAccountInfo(pda, 'confirmed');
  if (!info) return null;
  return decodeQuantumWalletAccount(info.data);
}
