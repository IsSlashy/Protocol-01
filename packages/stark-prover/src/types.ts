/**
 * Public types for `@protocol-01/stark-prover`.
 *
 * The package is a thin runtime adapter: it owns the WASM prover, the chunked
 * upload protocol, and the two-phase DEEP-ALI verify against
 * `p01_stark_verifier`. The host (the Styx web, extension and mobile clients)
 * supplies the higher-level subscription/transfer logic.
 *
 * `StarkProofOutcome` and `StarkProofGenerator` used to mirror privacy-sdk's
 * `ProverConfig` contract. privacy-sdk 2.0.0 removed that contract
 * (2026-09-23), so these types are canonical here; the shape test in
 * `src/index.test.ts` pins them.
 */

import type { PublicKey } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// The prover contract (canonical here since privacy-sdk 2.0.0)
// ---------------------------------------------------------------------------

/**
 * STARK proof outcome returned by a host-supplied generator.
 *
 * privacy-sdk 1.x carried a structural twin of this type; 2.0.0 removed it.
 */
export interface StarkProofOutcome {
  /** PDA of the verified STARK proof buffer held by p01_stark_verifier. */
  proofBuffer: PublicKey;
  /** Circuit identifier (0, 1, 3, 6 or 7). Informational — callers may log / assert. */
  circuitId: number;
  /** Public inputs bound into the STARK transcript, for downstream checks. */
  publicInputs?: bigint[];
}

/**
 * STARK prover + verifier submitter signature. The factory
 * `createStarkProver` returns a function matching it.
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
   * Defaults to `true`: the consuming instruction (shield, unshield, subscribe)
   * reads the buffer after verification.
   */
  retainBuffer?: boolean;
  /**
   * Optional commercial license JWT. When omitted, the SDK runs unlicensed
   * and emits a one-time console warning; proving is never blocked.
   * Noncommercial use needs no key (PolyForm Strict 1.0.0). Commercial use
   * (including production deployment by a business) needs a written license
   * from Volta Team —
   * see https://protocol-01.dev/licenses.
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
 * 3 = merkle_path          (inclusion in the shielded set tree)
 * 6 = merkle_update        (depth-15 root rotation for variable-pool shield)
 * 7 = spend                (see below)
 *
 * The deployed verifier also accepts ids 2, 4 and 5 (balance_proof,
 * confidential_balance, transfer). No client proves them and the shipped wasm
 * has no export for them, so they are not listed here.
 */
export const STARK_CIRCUITS = {
  SUBSCRIBER_OWNERSHIP: 0,
  POOL_COMMITMENT: 1,
  MERKLE_PATH: 3,
  MERKLE_UPDATE: 6,
  /**
   * [C7] The spend circuit: C1's pool commitment and C3's Merkle path proven in
   * ONE trace, so the note commitment is never a public input. That is the
   * entire point -- v3 published it, which named the leaf being spent and let
   * anyone reading the tree walk back to the deposit that funded it.
   */
  SPEND: 7,
} as const;

export type StarkCircuitId = (typeof STARK_CIRCUITS)[keyof typeof STARK_CIRCUITS];

/** Default `p01_stark_verifier` program ID (devnet + mainnet share the same key). */
export const DEFAULT_STARK_VERIFIER_PROGRAM_ID = 'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs';
