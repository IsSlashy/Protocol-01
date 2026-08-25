/// <reference lib="webworker" />
/**
 * STARK Prover Web Worker — browser-extension twin of mobile's StarkProver WebView.
 *
 * Runs the `p01-stark` WASM module in a separate thread so proof generation
 * (~100–500 ms) does not block the popup UI. Loads the WASM bytes from a
 * base64 constant embedded in the bundle — same pattern as mobile, no fetch
 * from disk so we sidestep MV3 web_accessible_resources entirely.
 *
 * Message protocol mirrors the mobile StarkProver postMessage contract so the
 * surrounding service (`starkProver.ts`) can be kept close to the mobile
 * `StarkProverProvider` shape.
 *
 * SECURITY: All proving happens on-device. Secrets never leave the browser
 *           worker context — no network, no storage, no console leaks of
 *           spending keys.
 */

import { STARK_WASM_BASE64 } from '../services/starkWasmData';
import { initStarkWasm, type StarkExports } from '@protocol-01/stark-prover/wasm-loader';

// ---------------------------------------------------------------------------
// Message types (shared with the service)
// ---------------------------------------------------------------------------

type WorkerInMessage =
  | { type: 'generateProof'; id: string; secret: string }
  | { type: 'computeCommitment'; id: string; secret: string }
  | { type: 'generatePoolProof'; id: string; args: [string, string, string, string] }
  | { type: 'generateBalanceProof'; id: string; args: [string, string, string, string] }
  | { type: 'generateMerklePathProof'; id: string; leaf: string; pathElements: string[]; pathIndices: number[] }
  | {
      type: 'generateConfidentialBalanceProof';
      id: string;
      spendingKey: string;
      oldBalance: string;
      oldSalt: string;
      newBalance: string;
      newSalt: string;
      amount: string;
      amountSalt: string;
      tokenMint: string;
    }
  | {
      type: 'generateTransferProof';
      id: string;
      spendingKey: string;
      tokenMint: string;
      inAmount1: string;
      inRand1: string;
      inAmount2: string;
      inRand2: string;
      outAmount1: string;
      outRand1: string;
      outRecipient1: string;
      outAmount2: string;
      outRand2: string;
      outRecipient2: string;
      publicAmount: string;
    }
  | {
      type: 'generateMerkleUpdateProof';
      id: string;
      oldLeaf: string;
      newLeaf: string;
      pathElements: string[];
      pathIndices: number[];
    };

export type StarkWorkerOutMessage =
  | { type: 'ready' }
  | { type: 'wasmLoaded' }
  | { type: 'wasmError'; error: string }
  | {
      type: 'proof';
      id: string;
      commitment?: string;
      nullifier?: string;
      circuitId?: number;
      publicInputs?: string[];
      proofHex?: string;
      proofSize?: number;
      durationMs?: number;
    }
  | { type: 'error'; id: string; error: string }
  | { type: 'log'; message: string };

// ---------------------------------------------------------------------------
// WASM — loaded through @protocol-01/stark-prover
//
// 🚨 THIS FILE USED TO CARRY ITS OWN COPY OF THE wasm-bindgen ABI: a
// `StarkExports` interface with (ptr,len) tuple returns, `passStringToWasm`,
// `readStringReturn`, `getUint8Memory`, and a hand-built import object with
// exactly ONE entry. It was one of FIVE such copies in this repository, and
// none of them imported the package that exists to own this.
//
// One entry was enough for the pre-C7 blob: pure computation, no randomness, no
// JS interop. MEASURED on the circuit-7 build, it needs TWENTY-FIVE — the spend
// prover draws a 1,280-element CSPRNG mask and that pulls getrandom -> crypto ->
// the whole wasm-bindgen shim surface. The copy could not load that blob:
//
//   LinkError: Import #0 "./p01_stark_bg.js"
//   "__wbg_crypto_38df2bab126b63dc": function import requires a callable
//
// ⛔ And the names are CONTENT-HASHED, so hand-writing them is work redone on
// every rebuild — five times over.
//
// `initStarkWasm` takes the same base64 constant this file already imported, so
// nothing about WHERE the bytes come from changes: no fetch, no
// web_accessible_resources, no URL. The package delegates instantiation to the
// generated glue, whose wrappers return real JS strings — which is why the
// handlers below dropped `readStringReturn` and pass CSV strings directly.
// ---------------------------------------------------------------------------

let wasmExports: StarkExports | null = null;

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function post(msg: StarkWorkerOutMessage) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

// ---------------------------------------------------------------------------
// WASM initialization
// ---------------------------------------------------------------------------

async function initWasm() {
  try {
    wasmExports = await initStarkWasm({ base64: STARK_WASM_BASE64 });
    post({ type: 'wasmLoaded' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'wasmError', error: `WASM init failed: ${message}` });
  }
}

// ---------------------------------------------------------------------------
// Proof handlers (one per WASM binding)
// ---------------------------------------------------------------------------

function assertReady(id: string): StarkExports | null {
  if (!wasmExports) {
    post({ type: 'error', id, error: 'WASM not initialized' });
    return null;
  }
  return wasmExports;
}

function generateProof(id: string, secretStr: string) {
  const exp = assertReady(id); if (!exp) return;
  try {
    const started = performance.now();
    const jsonStr = exp.generate_stark_proof(BigInt(secretStr));
    const elapsed = Math.round(performance.now() - started);
    const result = JSON.parse(jsonStr);
    post({
      type: 'proof', id,
      commitment: result.commitment,
      proofHex: result.proof_hex,
      proofSize: result.proof_size,
      durationMs: elapsed,
    });
  } catch (err) {
    post({ type: 'error', id, error: err instanceof Error ? err.message : 'Proof generation failed' });
  }
}

function computeCommitment(id: string, secretStr: string) {
  const exp = assertReady(id); if (!exp) return;
  try {
    const commitment = exp.compute_stark_commitment(BigInt(secretStr));
    post({ type: 'proof', id, commitment });
  } catch (err) {
    post({ type: 'error', id, error: err instanceof Error ? err.message : 'Commitment failed' });
  }
}

function generatePoolProof(id: string, args: [string, string, string, string]) {
  const exp = assertReady(id); if (!exp) return;
  try {
    const started = performance.now();
    const jsonStr = exp.generate_pool_commitment_stark_proof(
        BigInt(args[0]), BigInt(args[1]), BigInt(args[2]), BigInt(args[3]),
      );
    const elapsed = Math.round(performance.now() - started);
    const result = JSON.parse(jsonStr);
    post({
      type: 'proof', id,
      circuitId: result.circuit_id,
      nullifier: result.nullifier,
      commitment: result.commitment,
      publicInputs: [result.nullifier, result.commitment],
      proofHex: result.proof_hex,
      proofSize: result.proof_size,
      durationMs: elapsed,
    });
  } catch (err) {
    post({ type: 'error', id, error: err instanceof Error ? err.message : 'Pool proof failed' });
  }
}

function generateBalanceProof(id: string, args: [string, string, string, string]) {
  const exp = assertReady(id); if (!exp) return;
  try {
    const started = performance.now();
    const jsonStr = exp.generate_balance_stark_proof(
        BigInt(args[0]), BigInt(args[1]), BigInt(args[2]), BigInt(args[3]),
      );
    const elapsed = Math.round(performance.now() - started);
    const result = JSON.parse(jsonStr);
    post({
      type: 'proof', id,
      circuitId: result.circuit_id,
      commitment: result.commitment,
      publicInputs: [result.commitment, result.token_mint],
      proofHex: result.proof_hex,
      proofSize: result.proof_size,
      durationMs: elapsed,
    });
  } catch (err) {
    post({ type: 'error', id, error: err instanceof Error ? err.message : 'Balance proof failed' });
  }
}

function generateMerklePathProof(id: string, leaf: string, pathElements: string[], pathIndices: number[]) {
  const exp = assertReady(id); if (!exp) return;
  try {
    const started = performance.now();
        const ret = exp.generate_merkle_path_stark_proof(BigInt(leaf), pathElements.join(','), pathIndices.join(','));
    const jsonStr = ret;
    const elapsed = Math.round(performance.now() - started);
    const result = JSON.parse(jsonStr);
    // [C3 depth binding] depth is the 3rd public input, bound on-chain
    // (verifier rejects depth != 15). Fall back to the path length for older
    // WASM that does not emit `depth`.
    const depth = (typeof result.depth === 'number') ? result.depth : pathIndices.length;
    post({
      type: 'proof', id,
      circuitId: result.circuit_id,
      publicInputs: [result.leaf, result.root, String(depth)],
      proofHex: result.proof_hex,
      proofSize: result.proof_size,
      durationMs: elapsed,
    });
  } catch (err) {
    post({ type: 'error', id, error: err instanceof Error ? err.message : 'Merkle path proof failed' });
  }
}

function generateConfidentialBalanceProof(
  id: string,
  data: {
    spendingKey: string; oldBalance: string; oldSalt: string;
    newBalance: string; newSalt: string;
    amount: string; amountSalt: string; tokenMint: string;
  },
) {
  const exp = assertReady(id); if (!exp) return;
  try {
    const started = performance.now();
    const ret = exp.generate_confidential_balance_stark_proof(
      BigInt(data.spendingKey),
      BigInt(data.oldBalance),
      BigInt(data.oldSalt),
      BigInt(data.newBalance),
      BigInt(data.newSalt),
      BigInt(data.amount),
      BigInt(data.amountSalt),
      BigInt(data.tokenMint),
    );
    const jsonStr = ret;
    const elapsed = Math.round(performance.now() - started);
    const result = JSON.parse(jsonStr);
    post({
      type: 'proof', id,
      circuitId: 4,
      publicInputs: [result.old_commitment, result.new_commitment, result.amount_hash, result.token_mint],
      proofHex: result.proof_hex,
      proofSize: result.proof_size,
      durationMs: elapsed,
    });
  } catch (err) {
    post({ type: 'error', id, error: err instanceof Error ? err.message : 'Confidential balance proof failed' });
  }
}

function generateTransferProof(
  id: string,
  data: {
    spendingKey: string; tokenMint: string;
    inAmount1: string; inRand1: string; inAmount2: string; inRand2: string;
    outAmount1: string; outRand1: string; outRecipient1: string;
    outAmount2: string; outRand2: string; outRecipient2: string;
    publicAmount: string;
  },
) {
  const exp = assertReady(id); if (!exp) return;
  try {
    const started = performance.now();
    const ret = exp.generate_transfer_stark_proof(
      BigInt(data.spendingKey),
      BigInt(data.tokenMint),
      BigInt(data.inAmount1),
      BigInt(data.inRand1),
      BigInt(data.inAmount2),
      BigInt(data.inRand2),
      BigInt(data.outAmount1),
      BigInt(data.outRecipient1),
      BigInt(data.outRand1),
      BigInt(data.outAmount2),
      BigInt(data.outRecipient2),
      BigInt(data.outRand2),
      BigInt(data.publicAmount),
    );
    const jsonStr = ret;
    const elapsed = Math.round(performance.now() - started);
    const result = JSON.parse(jsonStr);
    post({
      type: 'proof', id,
      circuitId: 5,
      publicInputs: [
        result.nullifier_1, result.nullifier_2,
        result.output_commitment_1, result.output_commitment_2,
        result.public_amount, result.token_mint,
      ],
      proofHex: result.proof_hex,
      proofSize: result.proof_size,
      durationMs: elapsed,
    });
  } catch (err) {
    post({ type: 'error', id, error: err instanceof Error ? err.message : 'Transfer proof failed' });
  }
}

function generateMerkleUpdateProof(
  id: string,
  oldLeaf: string,
  newLeaf: string,
  pathElements: string[],
  pathIndices: number[],
) {
  const exp = assertReady(id); if (!exp) return;
  try {
    const started = performance.now();
        const ret = exp.generate_merkle_update_stark_proof(BigInt(oldLeaf), BigInt(newLeaf), pathElements.join(','), pathIndices.join(','));
    const jsonStr = ret;
    const elapsed = Math.round(performance.now() - started);
    const result = JSON.parse(jsonStr);
    post({
      type: 'proof', id,
      circuitId: result.circuit_id,
      publicInputs: [
        result.old_leaf, result.new_leaf,
        result.old_root, result.new_root,
        String(result.depth),
      ],
      proofHex: result.proof_hex,
      proofSize: result.proof_size,
      durationMs: elapsed,
    });
  } catch (err) {
    post({ type: 'error', id, error: err instanceof Error ? err.message : 'Merkle update proof failed' });
  }
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const data = event.data;
  switch (data.type) {
    case 'generateProof':
      generateProof(data.id, data.secret);
      break;
    case 'computeCommitment':
      computeCommitment(data.id, data.secret);
      break;
    case 'generatePoolProof':
      generatePoolProof(data.id, data.args);
      break;
    case 'generateBalanceProof':
      generateBalanceProof(data.id, data.args);
      break;
    case 'generateMerklePathProof':
      generateMerklePathProof(data.id, data.leaf, data.pathElements, data.pathIndices);
      break;
    case 'generateConfidentialBalanceProof':
      generateConfidentialBalanceProof(data.id, data);
      break;
    case 'generateTransferProof':
      generateTransferProof(data.id, data);
      break;
    case 'generateMerkleUpdateProof':
      generateMerkleUpdateProof(data.id, data.oldLeaf, data.newLeaf, data.pathElements, data.pathIndices);
      break;
  }
};

// Kick off WASM load immediately on worker spawn. The service listens for
// 'wasmLoaded' before accepting proof requests.
post({ type: 'ready' });
void initWasm();
