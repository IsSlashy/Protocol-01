/**
 * v1-chunks.ts — upload proof chunks in TRANSACTION V1 (SIMD-0385, 4,096 bytes
 * per transaction instead of 1,232), for the live timing harness.
 *
 * The feature gate `txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL` is active on
 * devnet since slot 492,480,000 (read off the Feature account on 2026-09-13;
 * mainnet at epoch 1035, ~2026-09-15). `@solana/web3.js` 1.x cannot build a v1
 * transaction, so this file uses `@solana/kit` 8 and is deliberately confined
 * to the harness: the SDK's `uploadAndVerify` takes it as an `uploadChunks`
 * override and everything else (allocation, verify, close) stays on the
 * measured web3.js path, so the only variable is the chunk size.
 *
 * A v1 transaction carries its own resource config (compute limit, loaded
 * accounts data size, priority fee in LAMPORTS) and runs with ZERO of each if
 * they are omitted. The chunk write loads the ~83 KB buffer AND the verifier
 * program itself (~780 KB of bytecode): MEASURED 2026-09-13, 128 KiB landed on
 * chain and failed with `MaxLoadedAccountsDataSizeExceeded`, so the limit is
 * 4 MiB; the compute limit generously 50,000 CU.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
} from '@solana/kit';
import type { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DISCRIMINATORS, MAX_CHUNK_SIZE } from '../src/upload-protocol';

/** Bytes of proof per v1 transaction. 4,096 minus ~230 bytes of envelope, rounded down. */
export const V1_CHUNK_SIZE = 3_840;
/** The v1 wire ceiling, asserted on every transaction built here. */
const V1_MAX_WIRE_BYTES = 4_096;

export interface V1UploaderOptions {
  rpcUrl: string;
  /** Transactions sent per wave and the pause between waves (the endpoint's limit is per method). */
  waveSize?: number;
  waveDelayMs?: number;
  /** Chunk bytes per transaction; default V1_CHUNK_SIZE, `MAX_CHUNK_SIZE` (1,000) reproduces the legacy split in v1 envelopes. */
  chunkSize?: number;
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

/**
 * Returns an `uploadChunks` override for `uploadAndVerify`: splits the proof
 * into `chunkSize` pieces, sends each as one v1 transaction, confirms them by
 * polling `getSignatureStatuses` on the web3.js connection, and resends what
 * did not land within the window (offset-addressed writes are idempotent).
 */
export function makeV1ChunkUploader(opts: V1UploaderOptions) {
  const chunkSize = opts.chunkSize ?? V1_CHUNK_SIZE;
  const waveSize = opts.waveSize ?? 8;
  const waveDelayMs = opts.waveDelayMs ?? 100;
  const rpc = createSolanaRpc(opts.rpcUrl);
  const stats = { txCount: 0, maxWireBytes: 0, resends: 0, sendMs: 0, confirmMs: 0 };

  const upload = async (
    conn: Connection,
    proofBytes: Uint8Array,
    proofBuffer: PublicKey,
    authority: PublicKey,
    payer: Keypair,
    programId: PublicKey,
    onProgress?: (step: string) => void,
  ): Promise<void> => {
    const signer = await createKeyPairSignerFromBytes(payer.secretKey);
    const programAddress = address(programId.toBase58());
    const bufferAddress = address(proofBuffer.toBase58());
    const authorityAddress = address(authority.toBase58());
    if (authorityAddress !== signer.address) throw new Error('v1 uploader: payer is not the authority');

    interface Chunk { offset: number; data: Uint8Array }
    const chunks: Chunk[] = [];
    for (let off = 0; off < proofBytes.length; off += chunkSize) {
      chunks.push({ offset: off, data: proofBytes.slice(off, Math.min(off + chunkSize, proofBytes.length)) });
    }
    stats.txCount = chunks.length;

    const buildAndSend = async (c: Chunk, blockhash: Awaited<ReturnType<typeof rpc.getLatestBlockhash>['send']>['value']): Promise<string> => {
      const data = new Uint8Array(8 + 4 + 4 + c.data.length);
      data.set(DISCRIMINATORS.writeProofChunk, 0);
      data.set(u32le(c.offset), 8);
      data.set(u32le(c.data.length), 12);
      data.set(c.data, 16);
      const ix: Instruction = {
        programAddress,
        accounts: [
          { address: bufferAddress, role: AccountRole.WRITABLE },
          { address: authorityAddress, role: AccountRole.READONLY_SIGNER },
        ],
        data,
      };
      const message = pipe(
        createTransactionMessage({ version: 1 }),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstruction(ix, m),
        (m) => setTransactionMessageConfig(
          { computeUnitLimit: 50_000, loadedAccountsDataSizeLimit: 4 * 1024 * 1024, priorityFeeLamports: 1_000n },
          m,
        ),
      );
      const tx = await signTransactionMessageWithSigners(message);
      const wire = getBase64EncodedWireTransaction(tx);
      const wireBytes = Math.floor((wire.length * 3) / 4) - (wire.endsWith('==') ? 2 : wire.endsWith('=') ? 1 : 0);
      stats.maxWireBytes = Math.max(stats.maxWireBytes, wireBytes);
      if (wireBytes > V1_MAX_WIRE_BYTES) {
        throw new Error(`v1 chunk at offset ${c.offset} serialises to ${wireBytes} bytes > ${V1_MAX_WIRE_BYTES}; lower chunkSize`);
      }
      let lastErr: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send();
          return getSignatureFromTransaction(tx);
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          if (!/429|Too many requests/i.test(msg)) throw e;
          await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    };

    let remaining = chunks;
    for (let round = 0; round < 4 && remaining.length > 0; round++) {
      onProgress?.(round === 0
        ? `Uploading proof batch 1/1 (${remaining.length} v1 transactions of up to ${chunkSize} bytes)...`
        : `Retrying ${remaining.length} v1 chunk(s) (round ${round + 1}/4)...`);
      const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const t0 = performance.now();
      const sigs: string[] = new Array(remaining.length);
      for (let w = 0; w < remaining.length; w += waveSize) {
        const wave = remaining.slice(w, w + waveSize);
        const results = await Promise.all(wave.map((c) => buildAndSend(c, blockhash)));
        results.forEach((s, i) => { sigs[w + i] = s; });
        if (w + waveSize < remaining.length) await new Promise((r) => setTimeout(r, waveDelayMs));
      }
      stats.sendMs += Math.round(performance.now() - t0);
      // Confirm by polling the web3.js connection, the same instrument the rest of the harness uses.
      const t1 = performance.now();
      const pending = new Map<string, number>();
      sigs.forEach((s, i) => pending.set(s, i));
      // MEASURED 2026-09-13 (5 runs): one lost chunk cost a 90 s wait before its
      // resend. Offset-addressed writes are idempotent, so resend after 20 s.
      const deadline = Date.now() + 20_000;
      while (pending.size > 0 && Date.now() < deadline) {
        const arr = [...pending.keys()];
        for (let i = 0; i < arr.length; i += 256) {
          const slice = arr.slice(i, i + 256);
          const { value } = await conn.getSignatureStatuses(slice, { searchTransactionHistory: false });
          slice.forEach((sig, k) => {
            const st = value[k];
            if (st) {
              if (st.err) throw new Error(`v1 chunk write failed on chain: ${JSON.stringify(st.err)}`);
              if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') pending.delete(sig);
            }
          });
        }
        if (pending.size === 0) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      stats.confirmMs += Math.round(performance.now() - t1);
      const unconfirmedIdx = [...pending.values()].sort((a, b) => a - b);
      stats.resends += unconfirmedIdx.length;
      remaining = unconfirmedIdx.map((i) => remaining[i]!);
    }
    if (remaining.length > 0) throw new Error(`${remaining.length} v1 chunk(s) never confirmed`);
  };

  return { upload, stats, chunkSize };
}
