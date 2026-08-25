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
      type: 'generateSpendProof';
      id: string;
      nullifierPreimage: string;
      secret: string;
      blinding: string;
      tokenMint: string;
      /** EXACTLY 12 — C7's subtree depth, not the pool tree's 15. */
      pathElements: string[];
      pathIndices: number[];
      /** EXACTLY 4 — sha256(recipient) as little-endian u64 limbs. */
      recipientHash: string[];
    }
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

/**
 * [C7] The spend proof: C1's pool commitment and C3's Merkle path in ONE trace.
 *
 * 🚨 THE COMMITMENT IS NOT AMONG THE PUBLIC INPUTS AND THAT IS THE POINT. v3
 * spent on a C1 + C3 pair tied together by `stark_commitment`, published in the
 * clear, so a withdrawal named the leaf it spent and anyone reading the tree
 * walked back to the deposit that funded it.
 *
 * ⛔ THE SIX PUBLIC INPUTS ARE ORDER-SENSITIVE: [nullifier, root, rh0..rh3].
 * They are serialised verbatim and `unshield_denominated_stark_v4` rebuilds the
 * same 48 bytes to compare against the buffer's `public_inputs_hash`. Sorting
 * or reordering them breaks that hash, and the failure lands after the whole
 * ~78-chunk upload rather than early.
 *
 * ⛔ The mask is drawn inside the wasm from a real CSPRNG and the Rust refuses
 * to build without one. There is deliberately no way to pass one in.
 */
function generateSpendProof(
  id: string,
  data: {
    nullifierPreimage: string; secret: string; blinding: string; tokenMint: string;
    pathElements: string[]; pathIndices: number[]; recipientHash: string[];
  },
) {
  const exp = assertReady(id); if (!exp) return;
  const spend = exp.generate_spend_stark_proof;
  if (!spend) {
    post({
      type: 'error', id,
      error: 'Circuit 7 (SPEND) is not exported by the bundled WASM. The pre-C7 blob '
        + '(229,640 B / 51a947e3) has eight proof exports; the C7 build has nine.',
    });
    return;
  }
  // Checked here rather than left to the Rust: it parses with
  // `filter_map(.. .ok())`, which SILENTLY DROPS unparseable entries, so a
  // truncated path and a malformed one are indistinguishable by the time it
  // sees them -- and an 11-deep proof is a valid proof of a tree nobody uses.
  if (data.pathElements.length !== 12 || data.pathIndices.length !== 12) {
    post({
      type: 'error', id,
      error: `Circuit 7 needs exactly 12 path elements and 12 indices (its subtree depth `
        + `is 12, NOT the pool's 15). Got ${data.pathElements.length} and ${data.pathIndices.length}.`,
    });
    return;
  }
  if (data.recipientHash.length !== 4) {
    post({ type: 'error', id, error: `Circuit 7 needs 4 recipientHash limbs, got ${data.recipientHash.length}.` });
    return;
  }
  try {
    const started = performance.now();
    const jsonStr = spend(
      BigInt(data.nullifierPreimage), BigInt(data.secret),
      BigInt(data.blinding), BigInt(data.tokenMint),
      data.pathElements.join(','), data.pathIndices.join(','), data.recipientHash.join(','),
    );
    const elapsed = Math.round(performance.now() - started);
    const result = JSON.parse(jsonStr);
    if (result.error) {
      post({ type: 'error', id, error: `Circuit 7 prover refused: ${result.error}` });
      return;
    }
    post({
      type: 'proof', id,
      circuitId: result.circuit_id,
      publicInputs: [result.nullifier, result.root, ...result.recipient_hash],
      proofHex: result.proof_hex,
      proofSize: result.proof_size,
      durationMs: elapsed,
    });
  } catch (err) {
    post({ type: 'error', id, error: err instanceof Error ? err.message : 'Spend proof failed' });
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
    case 'generateSpendProof':
      generateSpendProof(data.id, data);
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
