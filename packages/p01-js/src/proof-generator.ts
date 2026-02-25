/**
 * ZK Proof Generator Module for Protocol 01
 *
 * Provides an interface for generating and verifying Groth16 zero-knowledge proofs
 * for the denominated pool circuit (denominated_pool.circom).
 *
 * Circuit details:
 * - Type: Groth16 over BN254
 * - Constraints: 4273
 * - Merkle depth: 15
 * - Public inputs: [merkle_root, nullifier, min_epoch, token_mint]
 * - Private inputs: [secret, nullifier_preimage, deposit_epoch, path_elements[15], path_indices[15]]
 *
 * IMPORTANT: This module requires snarkjs as a runtime dependency for proof generation.
 * snarkjs is NOT bundled with this SDK to keep the package lightweight.
 * Install it separately: `npm install snarkjs`
 *
 * @module proof-generator
 */

// ============ Types ============

/**
 * A Groth16 proof with its public signals.
 */
export interface ProofResult {
  /** Groth16 proof components */
  proof: {
    /** pi_a: first proof element (2 coordinates as decimal strings) */
    pi_a: string[];
    /** pi_b: second proof element (2x2 matrix as decimal strings) */
    pi_b: string[][];
    /** pi_c: third proof element (2 coordinates as decimal strings) */
    pi_c: string[];
  };
  /** Public signals (decimal strings) in the order: [merkle_root, nullifier, min_epoch, token_mint] */
  publicSignals: string[];
}

/**
 * Configuration for the proof generator.
 */
export interface ProofGeneratorConfig {
  /**
   * Path or URL to the circuit WASM file (denominated_pool.wasm).
   * Can be a local file path, HTTP URL, or data URI.
   */
  wasmPath?: string;
  /**
   * Path or URL to the proving key (denominated_pool.zkey).
   * Can be a local file path, HTTP URL, or data URI.
   */
  zkeyPath?: string;
  /**
   * Whether to run proof generation in a Web Worker (browser only).
   * Prevents blocking the main thread during the ~3-5 second proof computation.
   * Defaults to false.
   */
  useWebWorker?: boolean;
}

/**
 * Input signals for the denominated pool circuit.
 */
export interface DenominatedPoolInputs {
  /** The current Merkle tree root (field element as decimal string) */
  root: string;
  /** The nullifier preimage (field element as decimal string) */
  nullifierPreimage: string;
  /** The secret (field element as decimal string) */
  secret: string;
  /** The deposit epoch (slot number as decimal string) */
  depositEpoch: string;
  /** The token mint as a field element (decimal string) */
  tokenMint: string;
  /** Merkle path elements (array of 15 field element strings) */
  pathElements: string[];
  /** Merkle path indices (array of 15 binary strings, '0' or '1') */
  pathIndices: string[];
  /** Minimum epoch for withdrawal (decimal string) */
  minEpoch: string;
}

// ============ snarkjs Detection ============

/**
 * Attempt to load snarkjs dynamically.
 *
 * @returns The snarkjs module, or null if not available
 */
async function loadSnarkjs(): Promise<any | null> {
  try {
    // Dynamic import to avoid bundling snarkjs with the SDK
    const snarkjs = await import('snarkjs' as string);
    return snarkjs;
  } catch {
    return null;
  }
}

// ============ Proof Generation ============

/**
 * Generate a Groth16 proof for the denominated pool circuit.
 *
 * This function computes a zero-knowledge proof that demonstrates:
 * 1. The prover knows a (secret, nullifier_preimage) pair that hashes to a commitment
 *    present in the Merkle tree at the given root.
 * 2. The nullifier is correctly derived from the nullifier_preimage.
 * 3. The deposit_epoch is at least min_epoch (enforcing withdrawal delay).
 * 4. The token_mint matches the pool's token.
 *
 * REQUIRES: snarkjs must be installed (`npm install snarkjs`).
 * REQUIRES: Circuit artifacts (WASM + zkey) must be provided via config.
 *
 * @param inputs - Circuit input signals
 * @param config - Proof generator configuration with paths to circuit artifacts
 * @returns ProofResult containing the Groth16 proof and public signals
 * @throws Error if snarkjs is not available or circuit artifacts are missing
 *
 * @example
 * ```typescript
 * const result = await generateDenominatedPoolProof(
 *   {
 *     root: '12345...',
 *     nullifierPreimage: '67890...',
 *     secret: 'abcdef...',
 *     depositEpoch: '1000000',
 *     tokenMint: '99999...',
 *     pathElements: ['...', '...', ...], // 15 elements
 *     pathIndices: ['0', '1', '0', ...], // 15 indices
 *     minEpoch: '999000',
 *   },
 *   {
 *     wasmPath: '/circuits/denominated_pool.wasm',
 *     zkeyPath: '/circuits/denominated_pool.zkey',
 *   }
 * );
 * ```
 */
export async function generateDenominatedPoolProof(
  inputs: Record<string, string | string[]>,
  config?: ProofGeneratorConfig
): Promise<ProofResult> {
  // Validate config first (fast, no async)
  if (!config?.wasmPath) {
    throw new Error(
      'wasmPath is required in ProofGeneratorConfig. ' +
      'Provide the path to denominated_pool.wasm.'
    );
  }

  if (!config?.zkeyPath) {
    throw new Error(
      'zkeyPath is required in ProofGeneratorConfig. ' +
      'Provide the path to denominated_pool.zkey.'
    );
  }

  // Validate inputs
  if (!inputs.pathElements || !Array.isArray(inputs.pathElements)) {
    throw new Error('inputs.pathElements must be an array of 15 field element strings.');
  }

  if (!inputs.pathIndices || !Array.isArray(inputs.pathIndices)) {
    throw new Error('inputs.pathIndices must be an array of 15 binary strings.');
  }

  // Try to load snarkjs
  const snarkjs = await loadSnarkjs();

  if (!snarkjs) {
    throw new Error(
      'snarkjs is not available. Install it to enable client-side proving:\n' +
      '  npm install snarkjs\n\n' +
      'Alternatively, use the relayer service for server-side proving, ' +
      'or the Rust prover at services/prover/ for native performance.'
    );
  }

  try {
    // Generate the proof using snarkjs
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      inputs,
      config.wasmPath,
      config.zkeyPath
    );

    return {
      proof: {
        pi_a: proof.pi_a,
        pi_b: proof.pi_b,
        pi_c: proof.pi_c,
      },
      publicSignals,
    };
  } catch (error: any) {
    throw new Error(
      `Proof generation failed: ${error?.message || 'Unknown error'}. ` +
      'Ensure the circuit inputs are valid and the WASM/zkey files are correct.'
    );
  }
}

// ============ Proof Verification ============

/**
 * Verify a Groth16 proof against public signals.
 *
 * This is useful for client-side verification before submitting to the chain
 * or relayer. On-chain verification is handled by the Solana program.
 *
 * REQUIRES: snarkjs must be installed (`npm install snarkjs`).
 *
 * @param proof - The Groth16 proof to verify
 * @param publicSignals - The public signals
 * @param vkPath - Path or URL to the verification key JSON file
 * @returns true if the proof is valid, false otherwise
 * @throws Error if snarkjs is not available or verification key is missing
 *
 * @example
 * ```typescript
 * const isValid = await verifyProof(
 *   result.proof,
 *   result.publicSignals,
 *   '/circuits/denominated_pool_vk.json'
 * );
 * if (!isValid) {
 *   throw new Error('Invalid proof!');
 * }
 * ```
 */
export async function verifyProof(
  proof: ProofResult['proof'],
  publicSignals: string[],
  vkPath?: string
): Promise<boolean> {
  // Validate config first (fast, no async)
  if (!vkPath) {
    throw new Error(
      'vkPath is required for proof verification. ' +
      'Provide the path to the verification key JSON file (denominated_pool_vk.json).'
    );
  }

  // Try to load snarkjs
  const snarkjs = await loadSnarkjs();

  if (!snarkjs) {
    throw new Error(
      'snarkjs is not available. Install it to enable client-side proof verification:\n' +
      '  npm install snarkjs\n\n' +
      'On-chain verification is performed by the Solana program and does not require snarkjs.'
    );
  }

  try {
    // Load verification key
    let vk: any;
    if (typeof vkPath === 'string' && (vkPath.startsWith('http://') || vkPath.startsWith('https://'))) {
      const response = await fetch(vkPath);
      vk = await response.json();
    } else if (typeof vkPath === 'string' && vkPath.startsWith('{')) {
      // JSON string passed directly
      vk = JSON.parse(vkPath);
    } else {
      // Assume it's a file path - try dynamic import for Node.js
      try {
        const fs = await import('fs' as string);
        const content = fs.readFileSync(vkPath, 'utf-8');
        vk = JSON.parse(content);
      } catch {
        throw new Error(
          `Cannot load verification key from path: ${vkPath}. ` +
          'In browser environments, provide an HTTP URL or the JSON content directly.'
        );
      }
    }

    // Verify the proof
    const fullProof = {
      pi_a: proof.pi_a,
      pi_b: proof.pi_b,
      pi_c: proof.pi_c,
      protocol: 'groth16',
      curve: 'bn128',
    };

    return await snarkjs.groth16.verify(vk, publicSignals, fullProof);
  } catch (error: any) {
    if (error.message?.includes('snarkjs')) throw error;
    if (error.message?.includes('Cannot load')) throw error;

    throw new Error(
      `Proof verification failed: ${error?.message || 'Unknown error'}.`
    );
  }
}
