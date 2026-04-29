/**
 * Public types for `@protocol-01/stark-prover`.
 *
 * The package is a thin runtime adapter: it owns the WASM prover, the chunked
 * upload protocol, and the two-phase DEEP-ALI verify against
 * `p01_stark_verifier`. The host (privacy-sdk) supplies the higher-level
 * subscription/transfer logic.
 *
 * `StarkProofOutcome` is duplicated locally rather than imported from the
 * privacy-sdk to avoid a circular runtime dependency at install time — the
 * shape is contractually frozen by the privacy-sdk's `ProverConfig.generateStarkProof`
 * type and is asserted by an interface compatibility test in `src/index.test.ts`.
 *
 * Match must be byte-for-byte. If privacy-sdk rev's the type, bump this
 * package and re-publish.
 */

import type { PublicKey } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Mirror of `@protocol-01/privacy-sdk` ProverConfig contract
// ---------------------------------------------------------------------------

/**
 * STARK proof outcome returned by a host-supplied generator.
 *
 * Mirror of the type defined in `@protocol-01/privacy-sdk` —
 * `packages/privacy-sdk/src/types.ts` :: `StarkProofOutcome`. Keep these in
 * sync: the privacy-sdk consumes the return value structurally.
 */
export interface StarkProofOutcome {
  /** PDA of the verified STARK proof buffer held by p01_stark_verifier. */
  proofBuffer: PublicKey;
  /** Circuit identifier (0–6). Informational — callers may log / assert. */
  circuitId: number;
  /** Public inputs bound into the STARK transcript, for downstream checks. */
  publicInputs?: bigint[];
}

/**
 * Host-supplied STARK prover + verifier submitter signature. Mirror of
 * `StarkProofGenerator` in privacy-sdk. The factory `createStarkProver`
 * returns a function matching this signature so callers can plug it directly
 * into `setProverConfig({ generateStarkProof })`.
 */
export type StarkProofGenerator = (
  circuitId: number,
  privateInputs: Record<string, string | string[] | number[]>,
) => Promise<StarkProofOutcome>;

// ---------------------------------------------------------------------------
// Local proof shapes (returned by the WASM bindings before upload)
// ---------------------------------------------------------------------------

/**
 * Compact subscriber-ownership proof (circuit 0). Returned by
 * `generate_stark_proof` in the WASM module.
 */
export interface CompactStarkProof {
  proofBytes: Uint8Array;
  /** Goldilocks-field commitment as a u64 (decimal string in JSON form). */
  commitment: bigint;
  proofSize: number;
}

/**
 * Generic STARK proof for circuits 1-6. The WASM module returns one JSON
 * blob per circuit with circuit-specific fields; this struct flattens the
 * shape down to (proof bytes, public inputs) for the on-chain verifier.
 */
export interface GenericStarkProof {
  proofBytes: Uint8Array;
  circuitId: number;
  /** Public inputs in the order expected by the on-chain phase 1 verifier. */
  publicInputs: bigint[];
  proofSize: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Wallet signer abstraction matching the mobile/extension shape. Either pass
 * a Keypair (Node / scripts) or a WalletSigner adapter (Privy, browser
 * wallets, Web3Auth, etc.).
 */
export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction: <T extends { partialSign?: unknown }>(tx: T) => Promise<T>;
}

export interface StarkProverConfig {
  /** Solana connection used for the chunked upload + verify roundtrip. */
  connection: import('@solana/web3.js').Connection;
  /**
   * Either a Keypair (signs every TX with its secret key) or a WalletSigner
   * (delegates signing to an external wallet). Exactly one must be provided.
   */
  payer:
    | import('@solana/web3.js').Keypair
    | WalletSigner;
  /**
   * Optional progress callback fired for each phase of the upload + verify
   * flow ("Initializing proof buffer...", "Uploading proof batch 3/12...",
   * "Verifying STARK proof phase 2 (DEEP-ALI)...", etc).
   */
  onProgress?: (step: string) => void;
  /**
   * Override the on-chain `p01_stark_verifier` program ID. Defaults to the
   * mainnet/devnet deployment `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs`.
   */
  programId?: PublicKey;
  /**
   * If true, leave the proof buffer PDA intact after verification so the
   * consuming program (e.g. `zk_shielded`) can read it cross-program. The
   * caller is then responsible for closing it (see `closeProofBuffer`).
   *
   * Defaults to `true` — privacy-sdk relies on the buffer surviving to the
   * shield/unshield/transfer instruction.
   */
  retainBuffer?: boolean;
  /**
   * Optional commercial license JWT. When omitted, the SDK runs in non-
   * production mode and emits a one-time console warning. Required for
   * production deployments — see https://protocol01.com/license.
   *
   * Format: `<base64url-payload>.<base64url-signature>` signed with the
   * Protocol 01 license signing key. Verified locally against
   * `LICENSE_PUBLIC_KEY_B64` (no network call).
   */
  licenseKey?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Circuit identifiers — must match `programs/p01_stark_verifier/src/lib.rs`.
 *
 * 0 = subscriber_ownership (compact proof)
 * 1 = pool_commitment      (denominated shield deposit)
 * 2 = balance_proof        (legacy confidential balance)
 * 3 = merkle_path          (inclusion in the shielded set tree)
 * 4 = confidential_balance (delta + bound to spending key)
 * 5 = transfer             (2-in-2-out shielded transfer, width 6, trace 512)
 * 6 = merkle_update        (depth-15 root rotation for variable-pool shield)
 */
export const STARK_CIRCUITS = {
  SUBSCRIBER_OWNERSHIP: 0,
  POOL_COMMITMENT: 1,
  BALANCE_PROOF: 2,
  MERKLE_PATH: 3,
  CONFIDENTIAL_BALANCE: 4,
  TRANSFER: 5,
  MERKLE_UPDATE: 6,
} as const;

export type StarkCircuitId = (typeof STARK_CIRCUITS)[keyof typeof STARK_CIRCUITS];

/** Default `p01_stark_verifier` program ID (devnet + mainnet share the same key). */
export const DEFAULT_STARK_VERIFIER_PROGRAM_ID = 'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs';
