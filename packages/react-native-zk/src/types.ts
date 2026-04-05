/**
 * Configuration for a circuit that can be loaded into the prover.
 *
 * @example
 * ```ts
 * const config: CircuitConfig = {
 *   wasmUri: 'transfer.wasm',
 *   zkeyUri: 'transfer_final.zkey',
 * };
 * await loadCircuit('transfer', config);
 * ```
 */
export interface CircuitConfig {
  /** URI to the .wasm file (e.g. 'file:///android_asset/circuit.wasm' or just 'circuit.wasm' for APK assets) */
  wasmUri: string;
  /** URI to the .zkey file (e.g. 'file:///android_asset/circuit_final.zkey' or just 'circuit_final.zkey') */
  zkeyUri: string;
}

/**
 * Result of a Groth16 proof generation.
 *
 * Contains the proof (pi_a, pi_b, pi_c), public signals, and timing info.
 *
 * @example
 * ```ts
 * const result: ProofResult = await prove('transfer', inputs);
 * console.log(result.proof.pi_a);        // [string, string, string]
 * console.log(result.publicSignals);     // string[]
 * console.log(result.durationMs);        // e.g. 2500
 * ```
 */
export interface ProofResult {
  /** The Groth16 proof (snarkjs format: pi_a, pi_b, pi_c) */
  proof: {
    pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string];
    protocol: string;
    curve: string;
  };
  /** The public signals array */
  publicSignals: string[];
  /** Proof generation time in milliseconds */
  durationMs?: number;
}

/**
 * Options for proof generation.
 *
 * @example
 * ```ts
 * const options: ProverOptions = {
 *   timeout: 300000, // 5 minutes for large circuits
 *   onProgress: (step) => console.log('Prover step:', step),
 * };
 * const result = await prove('transfer', inputs, options);
 * ```
 */
export interface ProverOptions {
  /** Timeout in milliseconds (default: 180000 = 3 minutes). Increase for large circuits (>15k constraints). */
  timeout?: number;
  /** Callback for progress updates */
  onProgress?: (step: string) => void;
}

/**
 * Ref handle for the ZKProver component.
 *
 * Use this type when accessing the prover via `useRef<ZKProverRef>()`.
 *
 * @example
 * ```tsx
 * const proverRef = useRef<ZKProverRef>(null);
 * // ...
 * await proverRef.current?.loadCircuit('myCircuit', config);
 * const result = await proverRef.current?.prove('myCircuit', inputs);
 * ```
 */
export interface ZKProverRef {
  /**
   * Load a circuit by name with the given config.
   * @param name - Unique circuit identifier (used as cache key)
   * @param config - Circuit file URIs (wasm + zkey)
   * @returns true if loaded successfully, false otherwise
   */
  loadCircuit(name: string, config: CircuitConfig): Promise<boolean>;

  /**
   * Generate a Groth16 proof for a loaded circuit.
   * @param name - Circuit name (must be loaded first via loadCircuit)
   * @param inputs - Proof inputs as key-value pairs
   * @param options - Optional timeout and progress callback
   * @returns ProofResult with proof, public signals, and duration
   */
  prove(name: string, inputs: Record<string, string | string[]>, options?: ProverOptions): Promise<ProofResult>;

  /**
   * Preload a previously configured circuit.
   * @param name - Circuit name that was passed to loadCircuit before
   * @returns true if the circuit is loaded
   */
  preload(name: string): Promise<boolean>;

  /**
   * Check if a circuit is loaded and ready for proving.
   * @param name - Circuit name to check
   * @returns true if loaded
   */
  isLoaded(name: string): boolean;
}

/**
 * Result of loading circuit assets (base64-encoded wasm and zkey data).
 *
 * @example
 * ```ts
 * const assets: CircuitLoadResult = await loadFromExpoAsset(wasmModule, zkeyModule);
 * console.log(assets.wasmBase64.length); // base64 string length
 * ```
 */
export interface CircuitLoadResult {
  wasmBase64: string;
  zkeyBase64: string;
}
