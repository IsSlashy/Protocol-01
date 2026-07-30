/**
 * p01_zkspl — STARK end-to-end test (quantum-resistant path)
 *
 * Exercises the full zkSPL lifecycle using STARK proofs. Groth16 is gone:
 * every mutation reads a pre-verified STARK proof buffer from
 * `p01_stark_verifier`. The on-chain handler checks the buffer's
 * `public_inputs_hash` against `sha256(u64_le || ...)` where each u64 is
 * projected from the first 8 bytes of the corresponding 32-byte commitment.
 *
 * Flow:
 *   1. initialize_mint (native SOL)
 *   2. create_account (initial commitment is Goldilocks u64 → LE bytes + pad)
 *   3. STARK circuit 4 (confidential_balance):
 *      init_proof_buffer → write_proof_chunk(s) → [resize if >10KB] → verify_v2
 *   4. deposit(amount, new_commitment) reads the verified buffer
 *   5. STARK circuit 2 (balance_proof): verify → prove_balance
 *   6. confidential_transfer: sender-side STARK → transfer → pending credit
 *   7. apply_pending: recipient-side STARK → apply_pending
 *   8. withdraw: STARK → withdraw
 *   9. Error paths: double-spend pending credit, mismatched authority
 *
 * Programs:
 *   p01_zkspl:          AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT
 *   p01_stark_verifier: DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
 *
 * NOTE: This test deliberately builds every p01_zkspl instruction by hand,
 * bypassing the auto-generated `target/types/p01_zkspl.ts` types. That file
 * is stale (it still references the removed `Groth16Proof` arg) and Anchor's
 * `idl build` currently fails because of an unrelated workspace crate. We
 * compute Anchor discriminators as `sha256("global:<method>")[..8]` and
 * serialize arg structs manually. This keeps the test runnable even while
 * the IDL regeneration tooling is broken.
 *
 * Run (devnet):
 *   ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=..." \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx ts-mocha -p tsconfig.test.json tests/zkspl.ts --timeout 900000
 *
 * Requires ~0.05 SOL devnet balance (rent for mint config, two accounts, proof buffers).
 */

import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, BN } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { expect } from 'chai';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ZKSPL_ID = new PublicKey('AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT');
const STARK_VERIFIER_ID = new PublicKey('DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs');
const NATIVE_SOL_MINT = SystemProgram.programId;

const SEEDS = {
  ZKSPL_MINT: Buffer.from('zkspl_mint'),
  ZKSPL_ACCOUNT: Buffer.from('zkspl_account'),
  ZKSPL_VAULT: Buffer.from('zkspl_vault'),
  STARK_PROOF: Buffer.from('stark_proof'),
};

// Anchor discriminators — sha256("global:<method>")[..8]
const DISC = {
  initialize_mint: Buffer.from([209, 42, 195, 4, 129, 85, 209, 44]),
  create_account: Buffer.from([99, 20, 130, 119, 196, 235, 131, 149]),
  deposit: Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
  withdraw: Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]),
  confidential_transfer: Buffer.from([97, 79, 128, 58, 134, 222, 73, 143]),
  apply_pending: Buffer.from([88, 86, 232, 48, 42, 150, 180, 196]),
  prove_balance: Buffer.from([168, 126, 148, 46, 16, 58, 26, 202]),
};

const MAX_CHUNK_SIZE = 900;
const PROOF_DATA_OFFSET = 82;

// Account offsets for ConfidentialAccount:
// 8 disc | 32 owner | 32 mint | 32 balance_commitment | 8 nonce
//   | 4 + vec<PendingCredit> | ...
const ACC_OFFSET_BALANCE_COMMIT = 8 + 32 + 32;
const ACC_OFFSET_NONCE = 8 + 32 + 32 + 32;
const ACC_OFFSET_PENDING_LEN = 8 + 32 + 32 + 32 + 8;

// PendingCredit: 32 amount_hash | 32 sender | 8 timestamp = 72 bytes
const PENDING_CREDIT_LEN = 72;

// ---------------------------------------------------------------------------
// Byte / field helpers
// ---------------------------------------------------------------------------
/**
 * Project a Goldilocks u64 onto a 32-byte commitment (LE padded).
 * Matches what the on-chain handler reconstructs via
 *   `u64::from_le_bytes(bytes[..8].try_into().unwrap())`.
 */
function u64To32LE(v: bigint): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeBigUInt64LE(v, 0);
  return buf;
}

function pubkeyLowU64(pk: PublicKey): bigint {
  const bytes = pk.toBytes();
  return Buffer.from(bytes).readBigUInt64LE(0);
}

function u64LeToBuffer(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function u64BN(v: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------
function deriveMintConfigPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.ZKSPL_MINT, mint.toBuffer()],
    ZKSPL_ID,
  );
}

function deriveConfidentialAccountPDA(owner: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.ZKSPL_ACCOUNT, owner.toBuffer(), mint.toBuffer()],
    ZKSPL_ID,
  );
}

function deriveVaultPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.ZKSPL_VAULT, mint.toBuffer()],
    ZKSPL_ID,
  );
}

function deriveProofBufferPDA(authority: PublicKey, circuitId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.STARK_PROOF, authority.toBuffer(), Buffer.from([circuitId])],
    STARK_VERIFIER_ID,
  );
}

// ---------------------------------------------------------------------------
// Retry helper (devnet blockhash flakiness)
// ---------------------------------------------------------------------------
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 2000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err.toString();
      if (
        attempt < maxRetries &&
        (msg.includes('Blockhash not found') || msg.includes('block height exceeded'))
      ) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`      Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

// ---------------------------------------------------------------------------
// STARK proof generation — driven via the `gen_proof` cargo binary.
// ---------------------------------------------------------------------------
interface GeneratedProof {
  circuitId: number;
  publicInputs: bigint[];
  proofBytes: Buffer;
}

function generateBalanceProof(
  sk: bigint,
  balance: bigint,
  salt: bigint,
  mintU64: bigint,
): GeneratedProof {
  const projectRoot = path.resolve(__dirname, '..');
  const cmd = `cargo run --bin gen_proof -p p01-stark -- balance ${sk} ${balance} ${salt} ${mintU64}`;
  const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 240000 });
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  const inputsMatch = output.match(/"public_inputs":\s*\[(\d+),\s*(\d+)\]/);
  if (!inputsMatch) throw new Error('Could not parse public_inputs from gen_proof (balance)');
  return {
    circuitId: json.circuit_id,
    publicInputs: [BigInt(inputsMatch[1]), BigInt(inputsMatch[2])],
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

function generateConfidentialBalanceProof(
  sk: bigint,
  oldBal: bigint,
  oldSalt: bigint,
  newBal: bigint,
  newSalt: bigint,
  amount: bigint,
  amtSalt: bigint,
  mintU64: bigint,
): GeneratedProof {
  const projectRoot = path.resolve(__dirname, '..');
  const cmd = `cargo run --bin gen_proof -p p01-stark -- confidential ${sk} ${oldBal} ${oldSalt} ${newBal} ${newSalt} ${amount} ${amtSalt} ${mintU64}`;
  const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 240000 });
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  const inputsMatch = output.match(
    /"public_inputs":\s*\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]/,
  );
  if (!inputsMatch) {
    throw new Error('Could not parse public_inputs from gen_proof (confidential)');
  }
  return {
    circuitId: json.circuit_id,
    publicInputs: [
      BigInt(inputsMatch[1]),
      BigInt(inputsMatch[2]),
      BigInt(inputsMatch[3]),
      BigInt(inputsMatch[4]),
    ],
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

// ---------------------------------------------------------------------------
// p01_stark_verifier instruction builders (IDL inlined)
// ---------------------------------------------------------------------------
function buildInitProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
  proofSize: number,
  circuitId: number,
): TransactionInstruction {
  const disc = Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]);
  const sz = Buffer.alloc(4);
  sz.writeUInt32LE(proofSize, 0);
  const cid = Buffer.from([circuitId]);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc, sz, cid]),
  });
}

function buildWriteProofChunkIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
  offset: number,
  chunk: Buffer,
): TransactionInstruction {
  const disc = Buffer.from([183, 3, 171, 138, 153, 138, 133, 147]);
  const off = Buffer.alloc(4);
  off.writeUInt32LE(offset, 0);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(chunk.length, 0);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc, off, len, chunk]),
  });
}

function buildVerifyStarkProofV2Ix(
  proofBuffer: PublicKey,
  authority: PublicKey,
  publicInputs: bigint[],
): TransactionInstruction {
  const disc = Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]);
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map(u64LeToBuffer);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc, vecLen, ...inputBufs]),
  });
}

/**
 * Phase 2 — `verify_deep_ali_phase2`. Mandatory for circuits 1-6; it is what
 * sets `ProofBuffer.deep_ali_verified` (byte 82).
 *
 * p01_zkspl requires that byte (`stark_proof.rs`), so a phase-1-only buffer is
 * rejected. Phase 1 is not an AIR check on its own — `verify_quotient_at_query`
 * enforces nothing, so a `verified`-only buffer does not bind the declared
 * public inputs to the committed trace.
 *
 * Discriminator matches every shipped client, e.g.
 * `apps/mobile/services/stark/index.ts:49`.
 */
function buildVerifyDeepAliPhase2Ix(
  proofBuffer: PublicKey,
  authority: PublicKey,
  publicInputs: bigint[],
): TransactionInstruction {
  const disc = Buffer.from([217, 239, 203, 65, 109, 182, 70, 115]);
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map(u64LeToBuffer);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc, vecLen, ...inputBufs]),
  });
}

function buildResizeProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const disc = Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc,
  });
}

function buildCloseProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const disc = Buffer.from([130, 150, 6, 35, 193, 34, 243, 87]);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
    ],
    data: disc,
  });
}

// ---------------------------------------------------------------------------
// p01_zkspl instruction builders
// ---------------------------------------------------------------------------
function buildInitializeMintIx(
  authority: PublicKey,
  tokenMint: PublicKey,
  balanceVkHash: Buffer,
  proofVkHash: Buffer,
): TransactionInstruction {
  const [mintConfigPDA] = deriveMintConfigPDA(tokenMint);
  return new TransactionInstruction({
    programId: ZKSPL_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: mintConfigPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISC.initialize_mint, balanceVkHash, proofVkHash]),
  });
}

function buildCreateAccountIx(
  owner: PublicKey,
  tokenMint: PublicKey,
  initialCommitment: Buffer,
): TransactionInstruction {
  const [mintConfigPDA] = deriveMintConfigPDA(tokenMint);
  const [confAccountPDA] = deriveConfidentialAccountPDA(owner, tokenMint);
  return new TransactionInstruction({
    programId: ZKSPL_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mintConfigPDA, isSigner: false, isWritable: false },
      { pubkey: confAccountPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISC.create_account, initialCommitment]),
  });
}

function buildDepositIx(
  depositor: PublicKey,
  tokenMint: PublicKey,
  starkProofBuffer: PublicKey,
  amountLamports: bigint,
  newCommitment: Buffer,
): TransactionInstruction {
  const [mintConfigPDA] = deriveMintConfigPDA(tokenMint);
  const [confAccountPDA] = deriveConfidentialAccountPDA(depositor, tokenMint);
  const [vaultPDA] = deriveVaultPDA(tokenMint);
  return new TransactionInstruction({
    programId: ZKSPL_ID,
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: mintConfigPDA, isSigner: false, isWritable: false },
      { pubkey: confAccountPDA, isSigner: false, isWritable: true },
      { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
      { pubkey: vaultPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // Optional: token_program, user_token_account, pool_vault
      // Anchor serializes None as a single 0 byte trailing tag — no account keys needed.
    ],
    data: Buffer.concat([
      DISC.deposit,
      u64BN(amountLamports),
      newCommitment,
    ]),
  });
}

function buildWithdrawIx(
  withdrawer: PublicKey,
  tokenMint: PublicKey,
  starkProofBuffer: PublicKey,
  amountLamports: bigint,
  newCommitment: Buffer,
): TransactionInstruction {
  const [mintConfigPDA] = deriveMintConfigPDA(tokenMint);
  const [confAccountPDA] = deriveConfidentialAccountPDA(withdrawer, tokenMint);
  const [vaultPDA] = deriveVaultPDA(tokenMint);
  return new TransactionInstruction({
    programId: ZKSPL_ID,
    keys: [
      { pubkey: withdrawer, isSigner: true, isWritable: true },
      { pubkey: mintConfigPDA, isSigner: false, isWritable: false },
      { pubkey: confAccountPDA, isSigner: false, isWritable: true },
      { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
      { pubkey: vaultPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      DISC.withdraw,
      u64BN(amountLamports),
      newCommitment,
    ]),
  });
}

function buildConfidentialTransferIx(
  sender: PublicKey,
  recipient: PublicKey,
  tokenMint: PublicKey,
  starkProofBuffer: PublicKey,
  newCommitment: Buffer,
  amountHash: Buffer,
): TransactionInstruction {
  const [mintConfigPDA] = deriveMintConfigPDA(tokenMint);
  const [senderAccountPDA] = deriveConfidentialAccountPDA(sender, tokenMint);
  const [recipientAccountPDA] = deriveConfidentialAccountPDA(recipient, tokenMint);
  return new TransactionInstruction({
    programId: ZKSPL_ID,
    keys: [
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: mintConfigPDA, isSigner: false, isWritable: false },
      { pubkey: senderAccountPDA, isSigner: false, isWritable: true },
      { pubkey: recipientAccountPDA, isSigner: false, isWritable: true },
      { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISC.confidential_transfer, newCommitment, amountHash]),
  });
}

function buildApplyPendingIx(
  recipient: PublicKey,
  tokenMint: PublicKey,
  starkProofBuffer: PublicKey,
  newCommitment: Buffer,
  amountHash: Buffer,
): TransactionInstruction {
  const [mintConfigPDA] = deriveMintConfigPDA(tokenMint);
  const [confAccountPDA] = deriveConfidentialAccountPDA(recipient, tokenMint);
  return new TransactionInstruction({
    programId: ZKSPL_ID,
    keys: [
      { pubkey: recipient, isSigner: true, isWritable: false },
      { pubkey: mintConfigPDA, isSigner: false, isWritable: false },
      { pubkey: confAccountPDA, isSigner: false, isWritable: true },
      { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISC.apply_pending, newCommitment, amountHash]),
  });
}

function buildProveBalanceIx(
  prover: PublicKey,
  tokenMint: PublicKey,
  starkProofBuffer: PublicKey,
  threshold: bigint,
): TransactionInstruction {
  const [mintConfigPDA] = deriveMintConfigPDA(tokenMint);
  const [confAccountPDA] = deriveConfidentialAccountPDA(prover, tokenMint);
  return new TransactionInstruction({
    programId: ZKSPL_ID,
    keys: [
      { pubkey: prover, isSigner: true, isWritable: false },
      { pubkey: mintConfigPDA, isSigner: false, isWritable: false },
      { pubkey: confAccountPDA, isSigner: false, isWritable: false },
      { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISC.prove_balance, u64BN(threshold)]),
  });
}

// ---------------------------------------------------------------------------
// Proof buffer helpers
// ---------------------------------------------------------------------------
async function uploadProofChunks(
  connection: Connection,
  authority: Keypair,
  proofBuffer: PublicKey,
  proofBytes: Buffer,
): Promise<void> {
  for (let offset = 0; offset < proofBytes.length; offset += MAX_CHUNK_SIZE) {
    const slice = proofBytes.subarray(
      offset,
      Math.min(offset + MAX_CHUNK_SIZE, proofBytes.length),
    );
    const ix = buildWriteProofChunkIx(proofBuffer, authority.publicKey, offset, slice);
    await withRetry(async () => {
      const sig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(ix),
        [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      await connection.confirmTransaction(sig, 'confirmed');
    });
  }
}

async function cleanupStaleProofBuffer(
  connection: Connection,
  authority: Keypair,
  proofBuffer: PublicKey,
): Promise<void> {
  const existing = await connection.getAccountInfo(proofBuffer);
  if (!existing) return;
  try {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildCloseProofBufferIx(proofBuffer, authority.publicKey)),
      [authority],
      { commitment: 'confirmed', skipPreflight: true },
    );
  } catch {
    /* ignore */
  }
}

/**
 * Upload + verify a STARK proof on p01_stark_verifier.
 * Returns the proof-buffer PDA (kept open for the cross-program read).
 */
async function uploadAndVerifyProof(
  connection: Connection,
  authority: Keypair,
  proof: GeneratedProof,
): Promise<PublicKey> {
  const [proofBufferPDA] = deriveProofBufferPDA(authority.publicKey, proof.circuitId);
  await cleanupStaleProofBuffer(connection, authority, proofBufferPDA);

  // Init
  await withRetry(async () => {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        buildInitProofBufferIx(
          proofBufferPDA,
          authority.publicKey,
          proof.proofBytes.length,
          proof.circuitId,
        ),
      ),
      [authority],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });

  // Resize if the buffer needs >10KB
  if (proof.proofBytes.length + PROOF_DATA_OFFSET > 10_240) {
    await withRetry(async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(buildResizeProofBufferIx(proofBufferPDA, authority.publicKey)),
        [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });
  }

  // Upload chunks
  await uploadProofChunks(connection, authority, proofBufferPDA, proof.proofBytes);

  // Verify
  await withRetry(async () => {
    await sendAndConfirmTransaction(
      connection,
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(
          buildVerifyStarkProofV2Ix(
            proofBufferPDA,
            authority.publicKey,
            proof.publicInputs,
          ),
        ),
      [authority],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });

  // Phase 2 — DEEP-ALI at OOD. Every zkSPL circuit that reaches this helper is
  // 2 or 4, both inside the 1-6 range `verify_deep_ali_phase2` accepts, and
  // p01_zkspl now requires the flag it sets. Combined phase 1+2 exceeds the
  // 1.4M CU per-instruction budget, so it is a separate transaction — same
  // split every shipped client uses (e.g. apps/mobile/services/stark/index.ts).
  await withRetry(async () => {
    await sendAndConfirmTransaction(
      connection,
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(
          buildVerifyDeepAliPhase2Ix(
            proofBufferPDA,
            authority.publicKey,
            proof.publicInputs,
          ),
        ),
      [authority],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });

  const info = await connection.getAccountInfo(proofBufferPDA);
  if (!info) throw new Error('Proof buffer missing after verify');
  if (info.data[49] !== 1) throw new Error('Proof buffer not marked verified');
  if (info.data[82] !== 1) throw new Error('Proof buffer not marked deep_ali_verified');

  return proofBufferPDA;
}

// ---------------------------------------------------------------------------
// Funding helper
// ---------------------------------------------------------------------------
async function fundWallet(
  provider: AnchorProvider,
  dest: PublicKey,
  lamports: number,
): Promise<void> {
  const authority = (provider.wallet as anchor.Wallet).payer;
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: dest,
        lamports,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Account readers (raw binary — stale IDL means no fetch() helpers)
// ---------------------------------------------------------------------------
interface ConfidentialAccountSnapshot {
  balanceCommitment: Buffer;
  nonce: bigint;
  pendingCreditCount: number;
}

async function readConfidentialAccount(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<ConfidentialAccountSnapshot> {
  const [pda] = deriveConfidentialAccountPDA(owner, mint);
  const info = await connection.getAccountInfo(pda);
  if (!info) throw new Error(`ConfidentialAccount not found for ${owner.toBase58()}`);
  const balanceCommitment = info.data.subarray(
    ACC_OFFSET_BALANCE_COMMIT,
    ACC_OFFSET_BALANCE_COMMIT + 32,
  );
  const nonce = info.data.readBigUInt64LE(ACC_OFFSET_NONCE);
  const pendingCreditCount = info.data.readUInt32LE(ACC_OFFSET_PENDING_LEN);
  return {
    balanceCommitment: Buffer.from(balanceCommitment),
    nonce,
    pendingCreditCount,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('p01_zkspl — STARK lifecycle (native SOL)', () => {
  const provider = new AnchorProvider(
    AnchorProvider.env().connection,
    AnchorProvider.env().wallet,
    { commitment: 'confirmed', preflightCommitment: 'confirmed' },
  );
  anchor.setProvider(provider);

  const connection = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer;

  // Two users (sender + recipient). New keypairs per run — no PDA collisions.
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  // ---------------------------------------------------------------------
  // STARK witness seeds (kept inside u32 range for Goldilocks safety)
  // ---------------------------------------------------------------------
  const aliceSK = BigInt(Math.floor(Math.random() * 0xffffffff));
  const bobSK = BigInt(Math.floor(Math.random() * 0xffffffff));

  const mintU64 = pubkeyLowU64(NATIVE_SOL_MINT);

  // Alice's balance witnesses
  const aliceInitSalt = BigInt(1111);
  const aliceDepositAmount = BigInt(42);
  const aliceDepositSalt = BigInt(2222);

  // Alice → Bob transfer witnesses
  const transferAmount = BigInt(10);
  const transferAmtSalt = BigInt(3333);
  const alicePostTransferBalance = aliceDepositAmount - transferAmount; // 32
  const alicePostTransferSalt = BigInt(4444);

  // Bob's witnesses
  const bobInitSalt = BigInt(5555);
  const bobPostApplySalt = BigInt(6666);

  // Alice withdrawal witnesses (after transfer: 32 → 20)
  const aliceWithdrawAmount = BigInt(12);
  const aliceWithdrawSalt = BigInt(7777);
  const alicePostWithdrawBalance = alicePostTransferBalance - aliceWithdrawAmount; // 20

  // ---------------------------------------------------------------------
  // PDA + byte handles
  // ---------------------------------------------------------------------
  let mintConfigPDA: PublicKey;
  let vaultPDA: PublicKey;

  // Commitments (32-byte Goldilocks-u64 LE projection — the exact shape the
  // on-chain handler reconstructs via `bytes[..8].try_into()`).
  let aliceInitCommit32: Buffer;
  let aliceDepositCommit32: Buffer;
  let alicePostTransferCommit32: Buffer;
  let alicePostWithdrawCommit32: Buffer;

  let bobInitCommit32: Buffer;
  let bobPostApplyCommit32: Buffer;

  // Amount hash bytes for hidden-amount operations.
  let transferAmtHash32: Buffer;

  // Stashed proofs (generated in `before`)
  let proofs: {
    aliceDeposit: GeneratedProof;
    aliceBalance: GeneratedProof;
    aliceTransfer: GeneratedProof;
    bobApply: GeneratedProof;
    aliceWithdraw: GeneratedProof;
  };

  before(async function () {
    this.timeout(600_000);

    // Fund test users
    const fundAmount = 0.01 * LAMPORTS_PER_SOL;
    await fundWallet(provider, alice.publicKey, fundAmount);
    await fundWallet(provider, bob.publicKey, fundAmount);

    // PDAs
    [mintConfigPDA] = deriveMintConfigPDA(NATIVE_SOL_MINT);
    [vaultPDA] = deriveVaultPDA(NATIVE_SOL_MINT);

    // Generate every STARK proof up-front (each run takes ~30-60s).
    console.log('    generating circuit-4 STARK proof (alice deposit)...');
    const aliceDepositProof = generateConfidentialBalanceProof(
      aliceSK,
      0n, aliceInitSalt,
      aliceDepositAmount, aliceDepositSalt,
      0n, 0n, // amount/salt both zero → amount_hash = Poseidon(0,0)
      mintU64,
    );
    aliceInitCommit32 = u64To32LE(aliceDepositProof.publicInputs[0]);
    aliceDepositCommit32 = u64To32LE(aliceDepositProof.publicInputs[1]);

    console.log('    generating circuit-2 STARK proof (alice balance proof)...');
    const aliceBalanceProof = generateBalanceProof(
      aliceSK, aliceDepositAmount, aliceDepositSalt, mintU64,
    );
    expect(aliceBalanceProof.publicInputs[0].toString())
      .to.equal(aliceDepositProof.publicInputs[1].toString());

    console.log('    generating circuit-4 STARK proof (alice transfer sender)...');
    const aliceTransferProof = generateConfidentialBalanceProof(
      aliceSK,
      aliceDepositAmount, aliceDepositSalt,
      alicePostTransferBalance, alicePostTransferSalt,
      transferAmount, transferAmtSalt,
      mintU64,
    );
    alicePostTransferCommit32 = u64To32LE(aliceTransferProof.publicInputs[1]);
    transferAmtHash32 = u64To32LE(aliceTransferProof.publicInputs[2]);

    console.log('    generating circuit-4 STARK proof (bob init → apply_pending)...');
    const bobApplyProof = generateConfidentialBalanceProof(
      bobSK,
      0n, bobInitSalt,
      transferAmount, bobPostApplySalt,
      transferAmount, transferAmtSalt,
      mintU64,
    );
    bobInitCommit32 = u64To32LE(bobApplyProof.publicInputs[0]);
    bobPostApplyCommit32 = u64To32LE(bobApplyProof.publicInputs[1]);
    const bobAmtHashFromProof = u64To32LE(bobApplyProof.publicInputs[2]);
    expect(bobAmtHashFromProof.equals(transferAmtHash32)).to.equal(
      true,
      'sender and recipient must agree on amount_hash (same amount + salt)',
    );

    console.log('    generating circuit-4 STARK proof (alice withdraw)...');
    const aliceWithdrawProof = generateConfidentialBalanceProof(
      aliceSK,
      alicePostTransferBalance, alicePostTransferSalt,
      alicePostWithdrawBalance, aliceWithdrawSalt,
      0n, 0n,
      mintU64,
    );
    alicePostWithdrawCommit32 = u64To32LE(aliceWithdrawProof.publicInputs[1]);

    proofs = {
      aliceDeposit: aliceDepositProof,
      aliceBalance: aliceBalanceProof,
      aliceTransfer: aliceTransferProof,
      bobApply: bobApplyProof,
      aliceWithdraw: aliceWithdrawProof,
    };
  });

  // ---------------------------------------------------------------------
  // 1. initialize_mint (idempotent — skips if already registered)
  // ---------------------------------------------------------------------
  it('initialize_mint (native SOL)', async function () {
    this.timeout(60_000);
    const existing = await connection.getAccountInfo(mintConfigPDA);
    if (existing) {
      console.log('    mint already initialized, skipping');
      return;
    }

    const vkBalance = crypto.randomBytes(32);
    const vkProof = crypto.randomBytes(32);

    await withRetry(async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          buildInitializeMintIx(authority.publicKey, NATIVE_SOL_MINT, vkBalance, vkProof),
        ),
        [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });

    const cfg = await connection.getAccountInfo(mintConfigPDA);
    expect(cfg).to.not.equal(null);
    // is_active flag sits after disc (8) + authority (32) + token_mint (32) + balance_vk_hash (32) + proof_vk_hash (32) = 136
    expect(cfg!.data[136]).to.equal(1);
  });

  // ---------------------------------------------------------------------
  // 2. create_account (alice + bob)
  // ---------------------------------------------------------------------
  it('create_account: alice', async function () {
    this.timeout(60_000);
    await withRetry(async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          buildCreateAccountIx(alice.publicKey, NATIVE_SOL_MINT, aliceInitCommit32),
        ),
        [alice],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });

    const acc = await readConfidentialAccount(connection, alice.publicKey, NATIVE_SOL_MINT);
    expect(acc.balanceCommitment.equals(aliceInitCommit32)).to.equal(true);
    expect(acc.nonce.toString()).to.equal('0');
  });

  it('create_account: bob', async function () {
    this.timeout(60_000);
    await withRetry(async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          buildCreateAccountIx(bob.publicKey, NATIVE_SOL_MINT, bobInitCommit32),
        ),
        [bob],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });

    const acc = await readConfidentialAccount(connection, bob.publicKey, NATIVE_SOL_MINT);
    expect(acc.balanceCommitment.equals(bobInitCommit32)).to.equal(true);
  });

  // ---------------------------------------------------------------------
  // 3. deposit: upload+verify circuit 4 → call deposit
  // ---------------------------------------------------------------------
  it('deposit: alice deposits via verified STARK buffer', async function () {
    this.timeout(300_000);
    const proofBuffer = await uploadAndVerifyProof(connection, alice, proofs.aliceDeposit);

    // Small lamport deposit — the u64 amount arg is independent of the STARK
    // AIR's private balance witnesses; the handler just uses it for the SPL
    // transfer and lets the STARK bind commitment integrity.
    const depositLamports = 1_000_000n;
    await withRetry(async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          buildDepositIx(
            alice.publicKey,
            NATIVE_SOL_MINT,
            proofBuffer,
            depositLamports,
            aliceDepositCommit32,
          ),
        ),
        [alice],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });

    const acc = await readConfidentialAccount(connection, alice.publicKey, NATIVE_SOL_MINT);
    expect(acc.nonce.toString()).to.equal('1');
    expect(acc.balanceCommitment.equals(aliceDepositCommit32)).to.equal(true);

    const vaultInfo = await connection.getAccountInfo(vaultPDA);
    expect(vaultInfo).to.not.equal(null);
    expect(vaultInfo!.lamports).to.be.gte(Number(depositLamports));

    // Recover rent
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildCloseProofBufferIx(proofBuffer, alice.publicKey)),
      [alice],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });

  // ---------------------------------------------------------------------
  // 4. prove_balance: upload+verify circuit 2 → call prove_balance
  // ---------------------------------------------------------------------
  it('prove_balance: alice proves balance (STARK circuit 2)', async function () {
    this.timeout(300_000);
    const proofBuffer = await uploadAndVerifyProof(connection, alice, proofs.aliceBalance);

    await withRetry(async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          buildProveBalanceIx(alice.publicKey, NATIVE_SOL_MINT, proofBuffer, 1n),
        ),
        [alice],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildCloseProofBufferIx(proofBuffer, alice.publicKey)),
      [alice],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });

  // ---------------------------------------------------------------------
  // 5. confidential_transfer: alice → bob
  // ---------------------------------------------------------------------
  it('confidential_transfer: alice → bob (hidden amount)', async function () {
    this.timeout(300_000);
    const proofBuffer = await uploadAndVerifyProof(connection, alice, proofs.aliceTransfer);

    await withRetry(async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          buildConfidentialTransferIx(
            alice.publicKey,
            bob.publicKey,
            NATIVE_SOL_MINT,
            proofBuffer,
            alicePostTransferCommit32,
            transferAmtHash32,
          ),
        ),
        [alice],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });

    // Alice's commitment advanced to post-transfer
    const aliceAcc = await readConfidentialAccount(connection, alice.publicKey, NATIVE_SOL_MINT);
    expect(aliceAcc.nonce.toString()).to.equal('2');
    expect(aliceAcc.balanceCommitment.equals(alicePostTransferCommit32)).to.equal(true);

    // Bob picked up a pending credit
    const bobAcc = await readConfidentialAccount(connection, bob.publicKey, NATIVE_SOL_MINT);
    expect(bobAcc.pendingCreditCount).to.equal(1);

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildCloseProofBufferIx(proofBuffer, alice.publicKey)),
      [alice],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });

  // ---------------------------------------------------------------------
  // 6. apply_pending: bob integrates the credit
  // ---------------------------------------------------------------------
  it('apply_pending: bob applies credit from alice', async function () {
    this.timeout(300_000);
    const proofBuffer = await uploadAndVerifyProof(connection, bob, proofs.bobApply);

    await withRetry(async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          buildApplyPendingIx(
            bob.publicKey,
            NATIVE_SOL_MINT,
            proofBuffer,
            bobPostApplyCommit32,
            transferAmtHash32,
          ),
        ),
        [bob],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });

    const bobAcc = await readConfidentialAccount(connection, bob.publicKey, NATIVE_SOL_MINT);
    expect(bobAcc.nonce.toString()).to.equal('1');
    expect(bobAcc.balanceCommitment.equals(bobPostApplyCommit32)).to.equal(true);
    expect(bobAcc.pendingCreditCount).to.equal(0);

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildCloseProofBufferIx(proofBuffer, bob.publicKey)),
      [bob],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });

  // ---------------------------------------------------------------------
  // 7. apply_pending double-spend is rejected (pending credit was consumed)
  // ---------------------------------------------------------------------
  it('apply_pending: double-apply is rejected', async function () {
    this.timeout(300_000);
    const proofBuffer = await uploadAndVerifyProof(connection, bob, proofs.bobApply);

    let rejected = false;
    try {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          buildApplyPendingIx(
            bob.publicKey,
            NATIVE_SOL_MINT,
            proofBuffer,
            bobPostApplyCommit32,
            transferAmtHash32,
          ),
        ),
        [bob],
        { commitment: 'confirmed', skipPreflight: true },
      );
    } catch (err: any) {
      rejected = true;
      expect(err.toString()).to.match(/PendingCreditNotFound|0x|custom program error/);
    }
    expect(rejected).to.equal(true);

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildCloseProofBufferIx(proofBuffer, bob.publicKey)),
      [bob],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });

  // ---------------------------------------------------------------------
  // 8. withdraw: alice takes funds back out
  // ---------------------------------------------------------------------
  it('withdraw: alice withdraws via verified STARK buffer', async function () {
    this.timeout(300_000);
    const proofBuffer = await uploadAndVerifyProof(connection, alice, proofs.aliceWithdraw);

    const balBefore = await connection.getBalance(alice.publicKey);
    const withdrawLamports = 300_000n; // strictly < current vault balance

    await withRetry(async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          buildWithdrawIx(
            alice.publicKey,
            NATIVE_SOL_MINT,
            proofBuffer,
            withdrawLamports,
            alicePostWithdrawCommit32,
          ),
        ),
        [alice],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });

    const balAfter = await connection.getBalance(alice.publicKey);
    expect(balAfter).to.be.gte(balBefore);

    const acc = await readConfidentialAccount(connection, alice.publicKey, NATIVE_SOL_MINT);
    expect(acc.nonce.toString()).to.equal('3');
    expect(acc.balanceCommitment.equals(alicePostWithdrawCommit32)).to.equal(true);

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildCloseProofBufferIx(proofBuffer, alice.publicKey)),
      [alice],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });

  // ---------------------------------------------------------------------
  // 9. error path: mismatched proof authority is rejected.
  //    Bob uploads his own circuit-4 proof, then Alice tries to reuse Bob's
  //    verified buffer to drive her own deposit. The on-chain check
  //    `authority(buffer) == payer` must reject.
  // ---------------------------------------------------------------------
  it('deposit: mismatched proof authority is rejected', async function () {
    this.timeout(300_000);
    const bobsBuffer = await uploadAndVerifyProof(connection, bob, proofs.bobApply);

    let rejected = false;
    try {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          buildDepositIx(
            alice.publicKey,
            NATIVE_SOL_MINT,
            bobsBuffer,
            100_000n,
            aliceDepositCommit32,
          ),
        ),
        [alice],
        { commitment: 'confirmed', skipPreflight: true },
      );
    } catch (err: any) {
      rejected = true;
      expect(err.toString()).to.match(/InvalidProof|0x|custom program error/);
    }
    expect(rejected).to.equal(true, 'Alice must not be able to use Bobs proof');

    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildCloseProofBufferIx(bobsBuffer, bob.publicKey)),
      [bob],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });
});

// Keep BN reachable for @coral-xyz/anchor peer check (tsc doesn't otherwise).
export const _bnMarker: BN | null = null;
