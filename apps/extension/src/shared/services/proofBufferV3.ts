/**
 * [L2 2026-09-06] Pre-sized and reusable proof buffers — instruction builders.
 *
 * Why this file exists (`docs/PERF-AND-CAPACITY-PLAN-2026-09-06.md` §L2): a
 * PDA allocated through a CPI is capped at 10,240 bytes, so an 80 KB proof
 * used to cost `init_proof_buffer` + EIGHT `resize_proof_buffer` transactions,
 * each confirmed before the next. Two verifier instructions remove that chain:
 *
 *   `init_proof_buffer_v3(proof_size: u32, circuit_id: u8)`
 *     accounts: [proof_buffer (writable), authority (signer)]
 *     Initialises a buffer the CLIENT allocated at full size with a top-level
 *     `SystemProgram.createAccount` (signed by the buffer keypair, paid by the
 *     authority, owner = verifier) in the SAME transaction. One transaction
 *     instead of nine. Works for a fresh ephemeral signer too.
 *
 *   `reset_proof_buffer(proof_size: u32, circuit_id: u8)`
 *     accounts: [proof_buffer (writable), authority (signer)]
 *     Rearms a live buffer (any shape: `stark_proof` PDA, `stark_proof_v2`
 *     PDA, or a v3 keypair account) for the next proof: `bytes_written`,
 *     `verified`, `deep_ali_verified` and the public-inputs hash are cleared
 *     in one instruction. Zero init, zero resize per proof for a wallet or a
 *     relayer that keeps one buffer per circuit alive. Shrinking is allowed,
 *     growing is not (`BufferTooSmall`, error 6008).
 *
 * The buffer a v3 init produces is a plain `ProofBuffer`: same discriminator,
 * same layout, same `authority`. Every pool consumer checks the owner, the
 * authority, the circuit id, the two flags and the hash, and none re-derives
 * the PDA (verified 2026-09-06), so nothing changes on the pool side.
 *
 * Wire format and account order are pinned against
 * `programs/p01_stark_verifier/src/lib.rs` by `proofBufferV3.test.ts`, and the
 * same bytes are exercised through the SBF binary by
 * `programs/p01_stark_verifier/tests/l2_presized_buffers.rs`.
 *
 * ⚠️ Not yet deployed: the devnet verifier at `DGY37k3J…` does not carry these
 * two instructions until the L2 redeploy lands. The pipelines keep the v1
 * init + resize path as the fallback until then.
 */

import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** Frozen literal: the deployed verifier program id. */
export const STARK_VERIFIER_PROGRAM_ID = new PublicKey(
  'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs',
);

/** `ProofBuffer::PROOF_DATA_OFFSET` = 8 disc + 32 authority + 1 circuit_id +
 *  4 proof_size + 4 bytes_written + 1 verified + 32 hash + 1 deep_ali. */
export const PROOF_DATA_OFFSET = 83;

/** `reset_proof_buffer` accepts this as the `verify_uniform` sentinel. */
export const CIRCUIT_ID_UNKNOWN = 255;

/** `ProofBuffer::space(proof_size)`: the account length a proof needs. */
export function proofBufferSpace(proofSize: number): number {
  assertU32(proofSize, 'proofSize');
  return PROOF_DATA_OFFSET + proofSize;
}

/** Anchor instruction discriminator: `sha256("global:<name>")[..8]`. */
function anchorDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);
}

export const INIT_PROOF_BUFFER_V3_DISCRIMINATOR = anchorDiscriminator('init_proof_buffer_v3');
export const RESET_PROOF_BUFFER_DISCRIMINATOR = anchorDiscriminator('reset_proof_buffer');

function assertU32(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new Error(`${what} must be a u32, got ${n}`);
  }
}

function assertCircuitId(circuitId: number, allowSentinel: boolean): void {
  const ok =
    Number.isInteger(circuitId) &&
    ((circuitId >= 0 && circuitId <= 7) || (allowSentinel && circuitId === CIRCUIT_ID_UNKNOWN));
  if (!ok) {
    throw new Error(
      `circuitId must be 0..7${allowSentinel ? ' or 255 (verify_uniform sentinel)' : ''}, got ${circuitId}`,
    );
  }
}

/** `disc || proof_size u32 LE || circuit_id u8` — 13 bytes, both instructions. */
function sizeAndCircuitData(disc: Uint8Array, proofSize: number, circuitId: number): Buffer {
  const data = Buffer.alloc(8 + 4 + 1);
  data.set(disc, 0);
  data.writeUInt32LE(proofSize, 8);
  data.writeUInt8(circuitId, 12);
  return data;
}

/**
 * The `SystemProgram.createAccount` that allocates the buffer at full size.
 * Both `payer` and `bufferPubkey` sign the transaction. `lamports` is the
 * rent-exempt minimum for `proofBufferSpace(proofSize)`; fetch it with
 * `rentForProofBuffer` (it is a cluster parameter, not a constant).
 */
export function buildCreateProofBufferAccountIx(
  proofSize: number,
  bufferPubkey: PublicKey,
  payer: PublicKey,
  lamports: number,
): TransactionInstruction {
  if (!Number.isSafeInteger(lamports) || lamports < 0) {
    throw new Error(`lamports must be a non-negative safe integer, got ${lamports}`);
  }
  // `SystemInstruction::CreateAccount { lamports, space, owner }`: tag 0 (u32
  // LE) | lamports u64 LE | space u64 LE | owner (32). Hand-rolled rather than
  // `SystemProgram.createAccount` so the bytes are the same on every surface
  // (mobile's test double of web3.js carries `SystemProgram.programId` only)
  // and so the u64s are written without BigInt Buffer methods (Hermes).
  const data = Buffer.alloc(4 + 8 + 8 + 32);
  data.writeUInt32LE(0, 0);
  writeU64LE(data, 4, lamports);
  writeU64LE(data, 12, proofBufferSpace(proofSize));
  data.set(STARK_VERIFIER_PROGRAM_ID.toBytes(), 20);
  return new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: bufferPubkey, isSigner: true, isWritable: true },
    ],
    data,
  });
}

function writeU64LE(buf: Buffer, offset: number, value: number): void {
  const lo = value % 0x1_0000_0000;
  const hi = Math.floor(value / 0x1_0000_0000);
  buf.writeUInt32LE(lo, offset);
  buf.writeUInt32LE(hi, offset + 4);
}

/** `init_proof_buffer_v3` on an account the same transaction just created. */
export function buildInitProofBufferV3Ix(
  proofSize: number,
  circuitId: number,
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  assertU32(proofSize, 'proofSize');
  assertCircuitId(circuitId, false);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: sizeAndCircuitData(INIT_PROOF_BUFFER_V3_DISCRIMINATOR, proofSize, circuitId),
  });
}

/**
 * The pair that replaces init + resizes: `[createAccount, init_proof_buffer_v3]`,
 * to be placed in ONE transaction signed by `authority` (fee payer) and the
 * buffer keypair. The authority pays the rent and gets it back on
 * `close_proof_buffer`.
 */
export function buildCreateAndInitProofBufferV3Ixs(
  proofSize: number,
  circuitId: number,
  bufferKeypair: { publicKey: PublicKey },
  authority: PublicKey,
  lamports: number,
): [TransactionInstruction, TransactionInstruction] {
  return [
    buildCreateProofBufferAccountIx(proofSize, bufferKeypair.publicKey, authority, lamports),
    buildInitProofBufferV3Ix(proofSize, circuitId, bufferKeypair.publicKey, authority),
  ];
}

/** `reset_proof_buffer`: rearm a live buffer for its next proof. */
export function buildResetProofBufferIx(
  proofSize: number,
  circuitId: number,
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  assertU32(proofSize, 'proofSize');
  assertCircuitId(circuitId, true);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: sizeAndCircuitData(RESET_PROOF_BUFFER_DISCRIMINATOR, proofSize, circuitId),
  });
}

/** Rent-exempt lamports for a buffer of `proofSize` proof bytes. */
export async function rentForProofBuffer(
  connection: Pick<Connection, 'getMinimumBalanceForRentExemption'>,
  proofSize: number,
): Promise<number> {
  return connection.getMinimumBalanceForRentExemption(proofBufferSpace(proofSize));
}

/**
 * Can an existing `ProofBuffer` account be reused for `proofSize` bytes via
 * `reset_proof_buffer`? Reads the raw account data as `getAccountInfo`
 * returns it. `null` (no account) means "create one".
 */
export function bufferCanBeReset(
  accountData: Uint8Array | null,
  proofSize: number,
): boolean {
  if (!accountData) return false;
  return accountData.length >= proofBufferSpace(proofSize);
}

/**
 * A DETERMINISTIC buffer keypair for a signer whose secret the caller holds
 * (an ephemeral, a stealth signer, a local wallet). Same seed, same address:
 * a job that dies between the upload and the close leaves a buffer the next
 * run (or `recoverFloat`) can re-derive, reset or close. A random keypair
 * would leave the rent findable by nobody.
 *
 * Seed = sha256("p01-proof-buffer-v3" || secret32 || circuit_id). Distinct
 * from every other derivation in this codebase by its prefix.
 */
export function deriveProofBufferKeypair(secret32: Uint8Array, circuitId: number): Keypair {
  if (secret32.length < 32) {
    throw new Error(`deriveProofBufferKeypair: need 32 secret bytes, got ${secret32.length}`);
  }
  assertCircuitId(circuitId, false);
  const preimage = new Uint8Array(PROOF_BUFFER_KEYPAIR_DOMAIN.length + 32 + 1);
  preimage.set(PROOF_BUFFER_KEYPAIR_DOMAIN, 0);
  preimage.set(secret32.subarray(0, 32), PROOF_BUFFER_KEYPAIR_DOMAIN.length);
  preimage[preimage.length - 1] = circuitId;
  return Keypair.fromSeed(sha256(preimage));
}

const PROOF_BUFFER_KEYPAIR_DOMAIN = new TextEncoder().encode('p01-proof-buffer-v3');
