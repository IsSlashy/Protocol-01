/**
 * ZK Prover Web Worker
 * Generates Groth16 proofs entirely client-side using snarkjs
 *
 * This runs in a separate thread to avoid blocking the UI
 */

// Import snarkjs (will be bundled with the worker)
import * as snarkjs from 'snarkjs';

// Message types
interface ProveRequest {
  type: 'prove';
  id: string;
  circuitWasm: ArrayBuffer;
  circuitZkey: ArrayBuffer;
  inputs: Record<string, string | string[]>;
}

interface ProveResponse {
  type: 'proof';
  id: string;
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
  };
  publicSignals: string[];
}

interface ErrorResponse {
  type: 'error';
  id: string;
  error: string;
}

// Handle messages from main thread
self.onmessage = async (event: MessageEvent<ProveRequest>) => {
  const { type, id, circuitWasm, circuitZkey, inputs } = event.data;

  if (type !== 'prove') {
    self.postMessage({
      type: 'error',
      id,
      error: `Unknown message type: ${type}`,
    } as ErrorResponse);
    return;
  }

  try {
    console.log('[ZK Worker] Starting proof generation...');
    console.log('[ZK Worker] Input keys:', Object.keys(inputs));
    console.log('[ZK Worker] WASM size:', circuitWasm.byteLength, 'ZKEY size:', circuitZkey.byteLength);
    const startTime = performance.now();

    // Generate the proof using snarkjs
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      inputs,
      new Uint8Array(circuitWasm),
      new Uint8Array(circuitZkey)
    );

    const duration = ((performance.now() - startTime) / 1000).toFixed(2);
    console.log(`[ZK Worker] Proof generated in ${duration}s`);

    // Send proof back to main thread
    self.postMessage({
      type: 'proof',
      id,
      proof,
      publicSignals,
    } as ProveResponse);

  } catch (error) {
    console.error('[ZK Worker] Proof generation failed:', error);
    self.postMessage({
      type: 'error',
      id,
      error: error instanceof Error ? error.message : 'Unknown error',
    } as ErrorResponse);
  }
};

// Signal that worker is ready
self.postMessage({ type: 'ready' });
