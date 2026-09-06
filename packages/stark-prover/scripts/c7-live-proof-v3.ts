/**
 * c7-live-proof-v3.ts — gate 8 for the 2026-09-06 verifier upgrade, against
 * the DEPLOYED program on devnet:
 *
 *   1. a circuit-7 proof from the SHIPPED blob through a KEYPAIR-OWNED buffer
 *      created and initialised in ONE transaction (`init_proof_buffer_v3`),
 *      uploaded in one concurrent round, then phase 1 + phase 2 in ONE
 *      transaction;
 *   2. `reset_proof_buffer` on that same buffer, a SECOND proof uploaded into
 *      it and verified the same way;
 *   3. `close_proof_buffer` on the keypair buffer, rent back to the authority.
 *
 *   npx tsx packages/stark-prover/scripts/c7-live-proof-v3.ts [--rpc URL] [--keypair PATH]
 *
 * Default RPC: the one in ~/.config/solana/cli/config.yml (Helius devnet on
 * this machine), else public devnet. Every transaction lands with
 * skipPreflight so a rejection is recorded on chain rather than simulated.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { initStarkWasm } from '../src/wasm-loader';
import { DISCRIMINATORS, buildCloseProofBufferIx, MAX_CHUNK_SIZE, PROOF_DATA_OFFSET } from '../src/upload-protocol';
import { DEFAULT_STARK_VERIFIER_PROGRAM_ID } from '../src/types';
import {
  buildCreateAndInitProofBufferV3Ixs,
  buildResetProofBufferIx,
  rentForProofBuffer,
} from '../../../apps/web/lib/privacy/pool/proofBufferV3';

const CIRCUIT_SPEND = 7;
const CANONICAL_DEPTH = 11;
const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function rpcFromCliConfig(): string {
  const p = join(homedir(), '.config', 'solana', 'cli', 'config.yml');
  if (existsSync(p)) {
    const m = readFileSync(p, 'utf8').match(/json_rpc_url:\s*(\S+)/);
    if (m) return m[1];
  }
  return 'https://api.devnet.solana.com';
}
function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
}
function u32LE(v: number): Uint8Array { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
function u64LE(v: bigint): Uint8Array { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; }
function concat(...parts: Uint8Array[]): Buffer { return Buffer.concat(parts.map((p) => Buffer.from(p))); }
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
interface SpendJson { error?: string; circuit_id: number; proof_hex: string; proof_size: number; nullifier: string; root: string; recipient_hash: string[] }

const PROGRAM = new PublicKey(DEFAULT_STARK_VERIFIER_PROGRAM_ID);

function ixWrite(offset: number, chunk: Uint8Array, buf: PublicKey, auth: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [{ pubkey: buf, isSigner: false, isWritable: true }, { pubkey: auth, isSigner: true, isWritable: false }],
    data: concat(DISCRIMINATORS.writeProofChunk, u32LE(offset), u32LE(chunk.length), chunk),
  });
}
function ixVerify(disc: Uint8Array, inputs: bigint[], buf: PublicKey, auth: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [{ pubkey: buf, isSigner: false, isWritable: true }, { pubkey: auth, isSigner: true, isWritable: false }],
    data: concat(disc, u32LE(inputs.length), ...inputs.map(u64LE)),
  });
}

async function sendConfirm(conn: Connection, tx: Transaction, signers: Keypair[], label: string): Promise<{ sig: string; slot: number; cu: string | null; err: unknown; logs: string[] }> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const t0 = Date.now();
  for (;;) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const st = value[0];
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break;
    if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error(`${label}: blockhash expired before confirmation (${sig})`);
    await new Promise((r) => setTimeout(r, 400));
  }
  const got = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const logs = got?.meta?.logMessages ?? [];
  const cu = logs.find((l) => l.includes('consumed') && l.includes(PROGRAM.toBase58())) ?? logs.find((l) => l.includes('consumed')) ?? null;
  console.log(`  ${label.padEnd(34)} ${sig}  slot ${got?.slot}  ${Date.now() - t0} ms${got?.meta?.err ? '  ERR ' + JSON.stringify(got.meta.err) : ''}`);
  return { sig, slot: got?.slot ?? 0, cu, err: got?.meta?.err ?? null, logs };
}

async function uploadChunks(conn: Connection, payer: Keypair, buf: PublicKey, proof: Uint8Array): Promise<{ count: number; ms: number; sigs: string[] }> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const txs: Transaction[] = [];
  for (let off = 0; off < proof.length; off += MAX_CHUNK_SIZE) {
    const chunk = proof.subarray(off, Math.min(off + MAX_CHUNK_SIZE, proof.length));
    const tx = new Transaction().add(ixWrite(off, chunk, buf, payer.publicKey));
    tx.recentBlockhash = blockhash; tx.feePayer = payer.publicKey; tx.sign(payer);
    txs.push(tx);
  }
  const t0 = Date.now();
  // Helius devnet answers 429 above ~40 concurrent sends (measured 2026-09-06:
  // 80 at once → retries, one run died on it). Waves of 16, each send retried.
  const sendOne = async (t: Transaction): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      try { return await conn.sendRawTransaction(t.serialize(), { skipPreflight: true }); }
      catch (e) { if (attempt >= 8) throw e; await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); }
    }
  };
  const sigs: string[] = [];
  for (let i = 0; i < txs.length; i += 16) {
    sigs.push(...(await Promise.all(txs.slice(i, i + 16).map(sendOne))));
  }
  const pending = new Set(sigs);
  while (pending.size) {
    const arr = [...pending];
    const { value } = await conn.getSignatureStatuses(arr);
    arr.forEach((s, i) => { const st = value[i]; if (st?.err) throw new Error(`chunk ${s} failed: ${JSON.stringify(st.err)}`); if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) pending.delete(s); });
    if (pending.size && (await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error(`${pending.size} chunks never confirmed`);
    if (pending.size) await new Promise((r) => setTimeout(r, 400));
  }
  const ms = Date.now() - t0;
  // readback gate
  const info = await conn.getAccountInfo(buf);
  if (!info) throw new Error('buffer vanished');
  const onchain = info.data.subarray(PROOF_DATA_OFFSET, PROOF_DATA_OFFSET + proof.length);
  if (Buffer.compare(Buffer.from(onchain), Buffer.from(proof)) !== 0) throw new Error('readback mismatch: buffer is torn');
  return { count: txs.length, ms, sigs };
}

function flags(data: Buffer): { circuit: number; proofSize: number; written: number; verified: number; deepAli: number } {
  // 8 disc | 32 authority | 1 circuit_id | 4 proof_size | 4 bytes_written | 1 verified | 32 public_inputs_hash | 1 deep_ali_verified  = 83 = PROOF_DATA_OFFSET
  return { circuit: data[40], proofSize: data.readUInt32LE(41), written: data.readUInt32LE(45), verified: data[49], deepAli: data[82] };
}

async function main(): Promise<void> {
  const rpc = flag('rpc') ?? rpcFromCliConfig();
  const payer = loadKeypair(flag('keypair') ?? join(homedir(), '.config', 'solana', 'id.json'));
  const conn = new Connection(rpc, 'confirmed');
  const toClose = flag('close');
  if (toClose) {
    // Recovery: close a keypair buffer left open by an aborted run (authority = payer).
    const c = await sendConfirm(conn, new Transaction().add(buildCloseProofBufferIx(new PublicKey(toClose), payer.publicKey, PROGRAM)), [payer], 'close_proof_buffer (recovery)');
    console.log(`  closed: ${(await conn.getAccountInfo(new PublicKey(toClose))) === null}${c.err ? ' (tx reverted)' : ''}`);
    return;
  }
  console.log(`=== C7 live proof through a keypair buffer (init_proof_buffer_v3 / reset_proof_buffer) ===`);
  console.log(`  rpc       ${rpc.replace(/api-key=.*/, 'api-key=…')}`);
  console.log(`  verifier  ${PROGRAM.toBase58()}`);
  console.log(`  authority ${payer.publicKey.toBase58()}`);
  const before = await conn.getBalance(payer.publicKey);

  const exports = await initStarkWasm();
  const spend = exports.generate_spend_stark_proof;
  if (!spend) throw new Error('blob has no generate_spend_stark_proof');
  const pathElements = Array.from({ length: CANONICAL_DEPTH }, (_, i) => String(1000 + i * 7)).join(',');
  const pathIndices = Array.from({ length: CANONICAL_DEPTH }, (_, i) => String(i % 2)).join(',');
  const rh = ['111111111', '222222222', '333333333', '444444444'].join(',');
  const prove = (): { proof: Uint8Array; inputs: bigint[]; ms: number } => {
    const t0 = Date.now();
    const j = JSON.parse(spend(11n, 22n, 33n, 44n, pathElements, pathIndices, rh)) as SpendJson;
    if (j.error) throw new Error(j.error);
    return { proof: hexToBytes(j.proof_hex), inputs: [BigInt(j.nullifier), BigInt(j.root), ...j.recipient_hash.map(BigInt)], ms: Date.now() - t0 };
  };
  const a = prove();
  const b = prove();
  console.log(`  proof A   ${a.proof.length} B in ${a.ms} ms; proof B ${b.proof.length} B in ${b.ms} ms; same bytes: ${Buffer.compare(Buffer.from(a.proof), Buffer.from(b.proof)) === 0}`);

  const wall0 = Date.now();
  const bufKp = Keypair.generate();
  const buf = bufKp.publicKey;
  const lamports = await rentForProofBuffer(conn, a.proof.length);
  console.log(`  buffer    ${buf.toBase58()} (keypair), rent ${lamports} lamports\n`);

  // 1. create + init in ONE transaction
  const [createIx, initIx] = buildCreateAndInitProofBufferV3Ixs(a.proof.length, CIRCUIT_SPEND, bufKp, payer.publicKey, lamports);
  const r1 = await sendConfirm(conn, new Transaction().add(createIx, initIx), [payer, bufKp], 'create+init_proof_buffer_v3');
  if (r1.err) throw new Error('init v3 failed');
  let f = flags((await conn.getAccountInfo(buf))!.data);
  console.log(`    flags after init: circuit ${f.circuit} size ${f.proofSize} written ${f.written} verified ${f.verified} deepAli ${f.deepAli}`);

  // 2. upload A, one round
  const up = await uploadChunks(conn, payer, buf, a.proof);
  console.log(`  upload A  ${up.count} chunks confirmed in ${up.ms} ms, readback OK`);

  // 3. phase 1 + phase 2 in ONE transaction
  const v = await sendConfirm(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(ixVerify(DISCRIMINATORS.verifyStarkProofV2, a.inputs, buf, payer.publicKey))
    .add(ixVerify(DISCRIMINATORS.verifyDeepAliPhase2, a.inputs, buf, payer.publicKey)), [payer], 'verify phase1+phase2 (one tx)');
  if (v.err) { for (const l of v.logs) console.log('    ' + l); throw new Error('composed verify failed'); }
  const cuLines = v.logs.filter((l) => l.includes('consumed'));
  for (const l of cuLines) console.log(`    ${l.trim()}`);
  f = flags((await conn.getAccountInfo(buf))!.data);
  console.log(`    flags after verify: verified ${f.verified} deepAli ${f.deepAli}`);
  if (f.verified !== 1 || f.deepAli !== 1) throw new Error('flags not set after the composed verify');
  const wallA = Date.now() - wall0;

  // 4. reset, upload B, verify again
  const r = await sendConfirm(conn, new Transaction().add(buildResetProofBufferIx(b.proof.length, CIRCUIT_SPEND, buf, payer.publicKey)), [payer], 'reset_proof_buffer');
  if (r.err) throw new Error('reset failed');
  f = flags((await conn.getAccountInfo(buf))!.data);
  console.log(`    flags after reset: size ${f.proofSize} written ${f.written} verified ${f.verified} deepAli ${f.deepAli}`);
  if (f.verified !== 0 || f.deepAli !== 0 || f.written !== 0) throw new Error('reset did not clear the flags');
  const wallB0 = Date.now();
  const up2 = await uploadChunks(conn, payer, buf, b.proof);
  console.log(`  upload B  ${up2.count} chunks confirmed in ${up2.ms} ms, readback OK`);
  const v2 = await sendConfirm(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(ixVerify(DISCRIMINATORS.verifyStarkProofV2, b.inputs, buf, payer.publicKey))
    .add(ixVerify(DISCRIMINATORS.verifyDeepAliPhase2, b.inputs, buf, payer.publicKey)), [payer], 'verify B phase1+phase2 (one tx)');
  if (v2.err) { for (const l of v2.logs) console.log('    ' + l); throw new Error('second composed verify failed'); }
  f = flags((await conn.getAccountInfo(buf))!.data);
  if (f.verified !== 1 || f.deepAli !== 1) throw new Error('flags not set after the second verify');
  const wallB = Date.now() - wallB0;

  // 5. close
  const c = await sendConfirm(conn, new Transaction().add(buildCloseProofBufferIx(buf, payer.publicKey, PROGRAM)), [payer], 'close_proof_buffer');
  if (c.err) throw new Error('close failed');
  const gone = (await conn.getAccountInfo(buf)) === null;
  const after = await conn.getBalance(payer.publicKey);
  console.log(`\n  buffer closed and absent: ${gone}`);
  console.log(`  wall clock  proof A (create+init → verified): ${wallA} ms; proof B after reset (upload → verified): ${wallB} ms`);
  console.log(`  cost        ${((before - after) / 1e9).toFixed(6)} SOL (fees only; rent recovered)`);
  console.log(`\n  VERDICT: the DEPLOYED verifier accepted two circuit-7 proofs through one keypair buffer (init v3, reset), each verified in ONE transaction.`);
}

main().catch((e) => { console.error(`FAIL — ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
