/**
 * Configuration for a circuit that can be loaded into the prover.
 */
export interface CircuitConfig {
  /** URI to the .wasm file (e.g. 'file:///android_asset/circuit.wasm') */
  wasmUri: string;
  /** URI to the .zkey file (e.g. 'file:///android_asset/circuit_final.zkey') */
  zkeyUri: string;
}

/**
 * Result of a proof generation.
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
 */
export interface ProverOptions {
  /** Timeout in milliseconds (default: 180000 = 3 minutes) */
  timeout?: number;
  /** Callback for progress updates */
  onProgress?: (step: string) => void;
}

/**
 * Ref handle for the ZKProver component.
 */
export interface ZKProverRef {
  /** Load a circuit by name with the given config */
  loadCircuit(name: string, config: CircuitConfig): Promise<boolean>;
  /** Generate a Groth16 proof */
  prove(name: string, inputs: Record<string, string | string[]>, options?: ProverOptions): Promise<ProofResult>;
  /** Preload a previously configured circuit */
  preload(name: string): Promise<boolean>;
  /** Check if a circuit is loaded */
  isLoaded(name: string): boolean;
}

/**
 * Result of loading circuit assets.
 */
export interface CircuitLoadResult {
  wasmBase64: string;
  zkeyBase64: string;
}
