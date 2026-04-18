/**
 * WOTS+ 67-Chain Devnet Smoke Test (Buffered Flow)
 *
 * E2E happy-path that exercises the new buffered WOTS+ verification on
 * devnet. The 2144-byte signature is uploaded in chunks to a PDA buffer
 * before the withdrawal instruction consumes it — on-chain the program
 * reconstructs the pubkey by walking chains and streaming into SHA-256,
 * so no inline pubkey is needed.
 *
 * Flow:
 *   1. init_wots_sig_buffer (creates 2224-byte PDA buffer)
 *   2. write_wots_sig_chunk × 3 (~720 bytes each, total 2144 bytes)
 *   3. withdraw_winternitz (reads buffer, reconstructs pk, transfers SOL)
 *   4. close_wots_sig_buffer (rent refund)
 *
 * Run:
 *   ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=..." \
 *   npx tsx tests/wots-devnet-smoke.ts
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Constants ───────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey('9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv');
const WOTS_MSG_CHAINS = 64;
const WOTS_CHECKSUM_CHAINS = 3;
const WOTS_CHAINS = WOTS_MSG_CHAINS + WOTS_CHECKSUM_CHAINS; // 67
const WOTS_MAX_VAL = 15;
const HASH_SIZE = 32;
const WOTS_SIG_SIZE = WOTS_CHAINS * HASH_SIZE; // 2144
const SEED_WOTS_VAULT = Buffer.from('wots_vault');
const SEED_WOTS_SIG = Buffer.from('wots_sig');
const CHUNK_SIZE = 720; // keeps tx size under 1232 bytes after serialization

// ── Anchor discriminator: sha256("global:<name>")[0..8] ────────────────────
function instructionDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`))).subarray(0, 8);
}

// ── Byte helpers ────────────────────────────────────────────────────────────
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}

function u32Le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

// ── WOTS+ 67-chain keygen / sign (MUST match Rust program) ──────────────────
interface Keys {
  secretChains: Uint8Array[];
  publicChains: Uint8Array[];
  publicKey: Uint8Array;
  publicKeyHash: Uint8Array;
}

function generateWotsKeypair(seed: Uint8Array): Keys {
  const secretChains: Uint8Array[] = [];
  const publicChains: Uint8Array[] = [];

  for (let i = 0; i < WOTS_CHAINS; i++) {
    const idx = new Uint8Array(4);
    new DataView(idx.buffer).setUint32(0, i, true);
    const sk = new Uint8Array(sha256(concatBytes(seed, idx)));
    secretChains.push(sk);

    let cur = sk;
    for (let s = 0; s < WOTS_MAX_VAL; s++) cur = new Uint8Array(sha256(cur));
    publicChains.push(cur);
  }

  const publicKey = concatBytes(...publicChains);
  const publicKeyHash = new Uint8Array(sha256(publicKey));
  return { secretChains, publicChains, publicKey, publicKeyHash };
}

function wotsSign(msgHash: Uint8Array, keys: Keys): Uint8Array {
  const nibbles = new Array<number>(WOTS_CHAINS);
  for (let i = 0; i < WOTS_MSG_CHAINS; i++) {
    const b = msgHash[i >> 1]!;
    nibbles[i] = i % 2 === 0 ? (b >> 4) & 0x0f : b & 0x0f;
  }
  let c = 0;
  for (let i = 0; i < WOTS_MSG_CHAINS; i++) c += WOTS_MAX_VAL - nibbles[i]!;
  nibbles[WOTS_MSG_CHAINS] = (c >> 8) & 0x0f;
  nibbles[WOTS_MSG_CHAINS + 1] = (c >> 4) & 0x0f;
  nibbles[WOTS_MSG_CHAINS + 2] = c & 0x0f;

  const sig = new Uint8Array(WOTS_CHAINS * HASH_SIZE);
  for (let i = 0; i < WOTS_CHAINS; i++) {
    const steps = WOTS_MAX_VAL - nibbles[i]!;
    let cur = keys.secretChains[i]!;
    for (let s = 0; s < steps; s++) cur = new Uint8Array(sha256(cur));
    sig.set(cur, i * HASH_SIZE);
  }
  return sig;
}

function computeWithdrawMessage(
  amount: bigint,
  destination: Uint8Array,
  withdrawalCount: bigint,
): Uint8Array {
  const a = new Uint8Array(8);
  new DataView(a.buffer).setBigUint64(0, amount, true);
  const w = new Uint8Array(8);
  new DataView(w.buffer).setBigUint64(0, withdrawalCount, true);
  return new Uint8Array(sha256(concatBytes(a, destination, w)));
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const rpcUrl =
    process.env.ANCHOR_PROVIDER_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const walletPath =
    process.env.ANCHOR_WALLET ?? join(homedir(), '.config', 'solana', 'id.json');
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))),
  );

  console.log('RPC      :', rpcUrl);
  console.log('Payer    :', payer.publicKey.toBase58());
  console.log('Program  :', PROGRAM_ID.toBase58());

  const balance = await connection.getBalance(payer.publicKey);
  console.log('Balance  :', balance / LAMPORTS_PER_SOL, 'SOL');
  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    throw new Error('Insufficient SOL (< 0.05) to run smoke test');
  }

  const owner = Keypair.generate();
  console.log('Owner    :', owner.publicKey.toBase58());

  // Fund fresh owner with vault-init rent + deposit + buffer rent + gas
  const FUND_LAMPORTS = 0.04 * LAMPORTS_PER_SOL;
  const fund = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: owner.publicKey,
      lamports: FUND_LAMPORTS,
    }),
  );
  const fundSig = await sendAndConfirmTransaction(connection, fund, [payer]);
  console.log('Fund tx  :', fundSig);

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [SEED_WOTS_VAULT, owner.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const [bufferPda] = PublicKey.findProgramAddressSync(
    [SEED_WOTS_SIG, vaultPda.toBuffer(), owner.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  console.log('Vault    :', vaultPda.toBase58());
  console.log('Buffer   :', bufferPda.toBase58());

  const seed0 = new Uint8Array(
    sha256(new TextEncoder().encode(`smoke-${owner.publicKey.toBase58()}-0`)),
  );
  const seed1 = new Uint8Array(
    sha256(new TextEncoder().encode(`smoke-${owner.publicKey.toBase58()}-1`)),
  );
  const keys0 = generateWotsKeypair(seed0);
  const keys1 = generateWotsKeypair(seed1);

  if (keys0.publicKey.length !== WOTS_SIG_SIZE) {
    throw new Error(`pk size mismatch ${keys0.publicKey.length} vs ${WOTS_SIG_SIZE}`);
  }

  // ── 1. init_winternitz_vault ─────────────────────────────────────────────
  {
    const data = Buffer.concat([
      instructionDiscriminator('init_winternitz_vault'),
      Buffer.from(keys0.publicKeyHash),
    ]);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [owner],
    );
    console.log('Init V   :', sig);
  }

  // ── 2. deposit_winternitz ────────────────────────────────────────────────
  const depositAmount = BigInt(0.01 * LAMPORTS_PER_SOL);
  {
    const data = Buffer.concat([
      instructionDiscriminator('deposit_winternitz'),
      u64Le(depositAmount),
    ]);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [owner],
    );
    console.log('Deposit  :', sig);
  }

  // ── 3. init_wots_sig_buffer ──────────────────────────────────────────────
  {
    const data = Buffer.concat([
      instructionDiscriminator('init_wots_sig_buffer'),
      u32Le(WOTS_SIG_SIZE),
    ]);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: false },
        { pubkey: bufferPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [owner],
    );
    console.log('Init buf :', sig);
  }

  // ── 4. write_wots_sig_chunk × N ─────────────────────────────────────────
  const destination = Keypair.generate();
  const withdrawAmount = BigInt(0.002 * LAMPORTS_PER_SOL);
  const withdrawalCount = 0n;
  const msg = computeWithdrawMessage(
    withdrawAmount,
    destination.publicKey.toBuffer(),
    withdrawalCount,
  );
  const signature = wotsSign(msg, keys0);

  let chunkCount = 0;
  for (let offset = 0; offset < signature.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, signature.length);
    const chunk = signature.slice(offset, end);

    const chunkLenBuf = Buffer.alloc(4);
    chunkLenBuf.writeUInt32LE(chunk.length, 0);

    const data = Buffer.concat([
      instructionDiscriminator('write_wots_sig_chunk'),
      u32Le(offset),
      chunkLenBuf,
      Buffer.from(chunk),
    ]);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: bufferPda, isSigner: false, isWritable: true },
      ],
      programId: PROGRAM_ID,
      data,
    });
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [owner],
    );
    chunkCount++;
    console.log(`Chunk ${chunkCount} @${offset} (${chunk.length}B): ${sig}`);
  }

  // ── 5. withdraw_winternitz ───────────────────────────────────────────────
  const destBefore = await connection.getBalance(destination.publicKey);
  {
    const data = Buffer.concat([
      instructionDiscriminator('withdraw_winternitz'),
      u64Le(withdrawAmount),
      Buffer.from(keys1.publicKeyHash),
    ]);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: bufferPda, isSigner: false, isWritable: true },
        { pubkey: destination.publicKey, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false }, // authority
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });
    console.log(`  withdraw ix data size: ${data.length} bytes`);
    // 67-chain WOTS+ verification with SHA-256 syscall is ~50–100K CU in
    // practice, but we bump the limit to 400K for headroom: worst-case all-F
    // messages force 67 × 15 = 1005 syscalls (≈85 CU each → ~85K), plus
    // overhead, Vec allocations, and lamport transfers.
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(ix);
    const sig = await sendAndConfirmTransaction(
      connection,
      tx,
      [owner],
    );
    console.log('Withdraw :', sig);
  }

  const destAfter = await connection.getBalance(destination.publicKey);
  const delta = destAfter - destBefore;
  console.log(`  destination received: ${delta} lamports (expected ${withdrawAmount})`);
  if (BigInt(delta) !== withdrawAmount) {
    throw new Error(`withdraw amount mismatch: got ${delta}, expected ${withdrawAmount}`);
  }

  // ── 6. close_wots_sig_buffer ─────────────────────────────────────────────
  {
    const data = instructionDiscriminator('close_wots_sig_buffer');
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: bufferPda, isSigner: false, isWritable: true },
      ],
      programId: PROGRAM_ID,
      data,
    });
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [owner],
    );
    console.log('Close buf:', sig);
  }

  console.log('\n✓ WOTS+ 67-chain buffered verification passed on devnet');
}

main().catch((err) => {
  console.error('\n✗ SMOKE FAILED:', err);
  if (err.logs) {
    console.error('Program logs:');
    for (const log of err.logs) console.error('  ' + log);
  }
  process.exit(1);
});
