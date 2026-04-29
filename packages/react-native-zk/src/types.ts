/**
 * Public types for `@protocol-01/react-native-zk` v2.
 *
 * v2 swaps the Groth16 + snarkjs surface for a STARK-based one
 * (Goldilocks field, Blake3 Merkle, DEEP-ALI). Proofs are quantum-safe
 * and roughly 10x larger than the v1 Groth16 outputs (~9 KB vs ~256 B),
 * but proving is ~5x faster and requires no trusted setup.
 *
 * The public API exposes one TypeScript method per circuit (8 in total)
 * so each call has a strongly-typed input list — no more freeform
 * `inputs: Record<string, string>`.
 */

// ---------------------------------------------------------------------------
// Circuit IDs — match `STARK_CIRCUITS` in `@protocol-01/stark-prover`.
// ---------------------------------------------------------------------------

/**
 * Stable circuit identifier used in proof outputs and on-chain verification.
 *
 * | id | name                  | exported by current WASM build |
 * |----|-----------------------|--------------------------------|
 * | 0  | SUBSCRIBER_OWNERSHIP  | yes |
 * | 1  | POOL_COMMITMENT       | yes |
 * | 2  | BALANCE_PROOF         | yes |
 * | 3  | MERKLE_PATH           | yes |
 * | 4  | CONFIDENTIAL_BALANCE  | yes |
 * | 5  | TRANSFER              | yes |
 * | 6  | MERKLE_UPDATE         | NOT in current bundled WASM (rebuild required) |
 */
export type StarkCircuitId = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// ---------------------------------------------------------------------------
// ProofResult — common shape for all 8 circuit methods
// ---------------------------------------------------------------------------

/**
 * Result of a STARK proof generation.
 *
 * Mirrors the worker contract used by the production extension prover
 * (`apps/extension/src/shared/workers/starkProver.worker.ts`).
 *
 * Different circuits populate different optional fields. For example
 * `generatePoolCommitmentProof` returns `nullifier` + `commitment`,
 * while `generateBalanceProof` returns only `commitment`.
 *
 * @example
 * ```ts
 * const result: ProofResult = await prover.generatePoolCommitmentProof(
 *   id, nullifierPreimage, secret, epoch, mint
 * );
 * console.log(result.proofHex);     // hex-encoded ~9 KB STARK proof
 * console.log(result.proofSize);    // raw byte length
 * console.log(result.circuitId);    // 1
 * console.log(result.publicInputs); // [nullifier, commitment]
 * ```
 */
export interface ProofResult {
  /** Hex-encoded STARK proof (no `0x` prefix). Pass to the on-chain verifier. */
  proofHex: string;
  /** Raw byte length of the proof (decoded from `proofHex`). */
  proofSize: number;
  /** Stable circuit identifier (0-6). */
  circuitId: number;
  /** Decimal-string array of public inputs (circuit-specific). */
  publicInputs?: string[];
  /** Commitment (decimal string), populated by circuits that return one. */
  commitment?: string;
  /** Nullifier (decimal string), populated by circuits that return one. */
  nullifier?: string;
  /** Wall-clock proving time on the WebView side. */
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Provider / hook options
// ---------------------------------------------------------------------------

/**
 * Options for proof generation. Currently only `timeout` is honoured —
 * `onProgress` is reserved for a future hook into the WASM `onProgress`
 * callback (the current bundled WASM does not surface intermediate steps).
 *
 * @example
 * ```ts
 * await prover.generateTransferProof(id, ...args, { timeout: 60_000 });
 * ```
 */
export interface ProverOptions {
  /** Timeout in milliseconds (default: 30_000 = 30 s — STARK proving is fast). */
  timeout?: number;
  /** Reserved. The current STARK WASM does not emit progress events. */
  onProgress?: (step: string) => void;
}

// ---------------------------------------------------------------------------
// Loader result — only WASM, no zkey (STARKs have no proving key)
// ---------------------------------------------------------------------------

/**
 * Result of {@link loadFromExpoAsset}, {@link loadFromApkAssets} and
 * {@link loadCircuitAssets}. Returns the WASM bytes already encoded as
 * base64, ready to inject into the WebView via `postMessage`.
 *
 * Note: in v2 you generally do NOT need these helpers — the package ships
 * the WASM inlined as base64 (`STARK_WASM_BASE64`). The loaders are kept
 * for callers who want to ship a custom WASM build (e.g. one that exports
 * `generate_merkle_update_stark_proof`).
 */
export interface CircuitLoadResult {
  /** Base64-encoded WASM bytes. */
  wasmBase64: string;
}

// ---------------------------------------------------------------------------
// Ref handle — one method per circuit
// ---------------------------------------------------------------------------

/**
 * Ref handle for the {@link ZKProver} component (and the
 * `useZKProver()` hook return value). Each method maps to one of the
 * 8 STARK circuits exported by `p01_stark_bg.wasm`.
 *
 * All numeric inputs are passed as decimal strings so JavaScript code can
 * stay BigInt-free at the call site. The hidden WebView re-parses them
 * via `BigInt(...)` before handing them to the WASM bindings.
 *
 * @example
 * ```tsx
 * const proverRef = useRef<ZKProverRef>(null);
 *
 * await proverRef.current?.loadWasm();
 * const result = await proverRef.current?.generateProof(
 *   'req-1', '12345',
 * );
 * ```
 */
export interface ZKProverRef {
  /**
   * Initialise the inlined WASM in the WebView. Idempotent — subsequent
   * calls are no-ops once the WASM is loaded. Does not need to be called
   * explicitly: the prover auto-inits on first proof request.
   */
  loadWasm(): Promise<boolean>;

  /**
   * Quick check — is the WASM loaded and the WebView mounted?
   */
  isReady(): boolean;

  /**
   * Circuit 0 — Subscriber ownership.
   * Proves knowledge of `subscriberSecret` such that
   * `commitment == hash(subscriberSecret)`.
   *
   * @returns `ProofResult` with `commitment` populated.
   */
  generateProof(
    id: string,
    subscriberSecret: string,
    options?: ProverOptions,
  ): Promise<ProofResult>;

  /**
   * Compute the commitment for a subscriber secret without producing a
   * proof. Useful for off-chain bookkeeping.
   */
  computeCommitment(
    id: string,
    subscriberSecret: string,
    options?: ProverOptions,
  ): Promise<ProofResult>;

  /**
   * Circuit 1 — Pool commitment / nullifier.
   * Returns `publicInputs = [nullifier, commitment]`.
   */
  generatePoolCommitmentProof(
    id: string,
    nullifierPreimage: string,
    secret: string,
    depositEpoch: string,
    tokenMint: string,
    options?: ProverOptions,
  ): Promise<ProofResult>;

  /**
   * Circuit 2 — Balance proof.
   * Returns `publicInputs = [commitment, tokenMint]`.
   */
  generateBalanceProof(
    id: string,
    spendingKey: string,
    balance: string,
    salt: string,
    tokenMint: string,
    options?: ProverOptions,
  ): Promise<ProofResult>;

  /**
   * Circuit 3 — Merkle path inclusion.
   * Returns `publicInputs = [leaf, root]`.
   */
  generateMerklePathProof(
    id: string,
    leaf: string,
    pathElements: string[],
    pathIndices: number[],
    options?: ProverOptions,
  ): Promise<ProofResult>;

  /**
   * Circuit 4 — Confidential balance update.
   * Returns `publicInputs = [oldCommitment, newCommitment, amountHash, tokenMint]`.
   */
  generateConfidentialBalanceProof(
    id: string,
    spendingKey: string,
    oldBalance: string,
    oldSalt: string,
    newBalance: string,
    newSalt: string,
    amount: string,
    amountSalt: string,
    tokenMint: string,
    options?: ProverOptions,
  ): Promise<ProofResult>;

  /**
   * Circuit 5 — 2-in / 2-out confidential transfer.
   * Returns `publicInputs = [n1, n2, c1, c2, publicAmount, tokenMint]`.
   */
  generateTransferProof(
    id: string,
    args: {
      spendingKey: string;
      tokenMint: string;
      inAmount1: string; inRand1: string;
      inAmount2: string; inRand2: string;
      outAmount1: string; outRand1: string; outRecipient1: string;
      outAmount2: string; outRand2: string; outRecipient2: string;
      publicAmount: string;
    },
    options?: ProverOptions,
  ): Promise<ProofResult>;

  /**
   * Circuit 6 — Merkle update (variable-pool shield).
   *
   * **NOT available in the WASM bundled with this package.** Throws a
   * descriptive error with rebuild instructions when called against the
   * default WASM. Callers who want this circuit must ship their own WASM
   * build that exports `generate_merkle_update_stark_proof` and load it
   * via {@link loadFromExpoAsset} / {@link loadFromApkAssets}.
   */
  generateMerkleUpdateProof(
    id: string,
    oldLeaf: string,
    newLeaf: string,
    pathElements: string[],
    pathIndices: number[],
    options?: ProverOptions,
  ): Promise<ProofResult>;
}
