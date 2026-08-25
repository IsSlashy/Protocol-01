/**
 * `@protocol-01/stark-prover` — public entry point.
 *
 * Drop-in WASM-backed STARK prover for `@protocol-01/privacy-sdk`. Builds
 * proofs locally (Goldilocks field, Blake3 Merkle, DEEP-ALI), uploads them
 * in chunks to `p01_stark_verifier` on Solana, runs the two-phase verify,
 * and returns the verified proof buffer PDA.
 *
 * Usage (host: privacy-sdk):
 *
 * ```ts
 * import { Privacy } from '@protocol-01/privacy-sdk';
 * import { createStarkProver } from '@protocol-01/stark-prover';
 *
 * const proverFactory = createStarkProver({
 *   connection,
 *   payer: keypair,
 *   onProgress: (step) => console.log('[STARK]', step),
 * });
 *
 * const sdk = new Privacy({ connection, wallet: keypair });
 * sdk.setProverConfig({ generateStarkProof: proverFactory.generateStarkProof });
 *
 * await sdk.shield({ amount: 1_000_000n, mint: USDC_MINT });
 * ```
 *
 * The package is runtime-agnostic: works in Node 22+, modern browsers
 * (Chrome / Firefox / Safari) and React Native (via the WebView fallback —
 * pass the WASM bytes via `WasmSource.base64`). The only hard runtime
 * dependency is `@solana/web3.js`, which is a peer dep so it dedupes with
 * the consuming SDKs.
 */

import { PublicKey } from '@solana/web3.js';

import {
  STARK_CIRCUITS,
  type StarkCircuitId,
  type StarkProofGenerator,
  type StarkProofOutcome,
  type StarkProverConfig,
  type CompactStarkProof,
  type GenericStarkProof,
  DEFAULT_STARK_VERIFIER_PROGRAM_ID,
} from './types';

import {
  initStarkWasm,
  type WasmSource,
  type StarkExports,
} from './wasm-loader';

import { uploadAndVerify } from './upload-protocol';

import {
  verifyLicenseKey,
  formatMissingLicenseWarning,
  formatInvalidLicenseWarning,
  LICENSE_PUBLIC_KEY_B64,
  type LicensePayload,
  type LicenseVerification,
} from './license';

// Re-export the public surface so consumers can `import { ... } from '@protocol-01/stark-prover'`.
export {
  STARK_CIRCUITS,
  DEFAULT_STARK_VERIFIER_PROGRAM_ID,
  type StarkCircuitId,
  type StarkProofGenerator,
  type StarkProofOutcome,
  type StarkProverConfig,
  type CompactStarkProof,
  type GenericStarkProof,
} from './types';

export {
  verifyLicenseKey,
  formatMissingLicenseWarning,
  formatInvalidLicenseWarning,
  LICENSE_PUBLIC_KEY_B64,
  type LicensePayload,
  type LicenseVerification,
} from './license';

export {
  initStarkWasm,
  resetStarkWasm,
  type StarkExports,
  type WasmSource,
} from './wasm-loader';

export {
  uploadAndVerify,
  closeProofBuffer,
  buildCloseProofBufferIx,
  getProofBufferPda,
  MAX_CHUNK_SIZE,
  PROOF_DATA_OFFSET,
  DISCRIMINATORS,
  type UploadAndVerifyResult,
  type UploadAndVerifyOptions,
} from './upload-protocol';

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${cleaned.length}`);
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`Invalid hex byte at offset ${i * 2}`);
    bytes[i] = byte;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Private-input shapes — one per circuit
// ---------------------------------------------------------------------------

/**
 * Coerce a `Record<string, string | string[] | number[]>` value into an array
 * of decimal strings. Accepts strings (CSV or already-array-stringified),
 * string[] arrays, and number[] arrays.
 */
function asStringArray(v: string | string[] | number[] | undefined): string[] {
  if (v === undefined) return [];
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.map(String);
  return [];
}

function asString(v: string | string[] | number[] | undefined, name: string): string {
  if (v === undefined) throw new Error(`Missing required private input: "${name}"`);
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0) return String(v[0]);
  throw new Error(`Private input "${name}" must be a string or non-empty array`);
}

// ---------------------------------------------------------------------------
// WASM dispatch — circuit_id → bindings call → JSON shape
// ---------------------------------------------------------------------------

interface CompactProofJson {
  commitment: string;
  proof_hex: string;
  proof_size: number;
}

interface PoolProofJson {
  circuit_id: 1;
  nullifier: string;
  commitment: string;
  proof_hex: string;
  proof_size: number;
}

interface BalanceProofJson {
  circuit_id: 2;
  commitment: string;
  token_mint: string;
  proof_hex: string;
  proof_size: number;
}

interface MerklePathProofJson {
  circuit_id: 3;
  leaf: string;
  root: string;
  /** Merkle tree depth — 3rd public input, bound on-chain (CANONICAL_DEPTH=15). */
  depth: number;
  proof_hex: string;
  proof_size: number;
}

interface ConfBalanceProofJson {
  circuit_id: 4;
  old_commitment: string;
  new_commitment: string;
  amount_hash: string;
  token_mint: string;
  proof_hex: string;
  proof_size: number;
}

interface TransferProofJson {
  circuit_id: 5;
  nullifier_1: string;
  nullifier_2: string;
  output_commitment_1: string;
  output_commitment_2: string;
  public_amount: string;
  token_mint: string;
  proof_hex: string;
  proof_size: number;
}

interface SpendProofJson {
  circuit_id: number;
  nullifier: string;
  root: string;
  recipient_hash: [string, string, string, string];
  proof_hex: string;
  proof_size: number;
  /** The Rust returns `{"error": ...}` instead of panicking on a bad witness. */
  error?: string;
}

interface MerkleUpdateProofJson {
  circuit_id: 6;
  old_leaf: string;
  new_leaf: string;
  old_root: string;
  new_root: string;
  depth: number;
  proof_hex: string;
  proof_size: number;
}

/**
 * Run the WASM bindings for `circuitId` against `privateInputs` and return
 * the (proofBytes, publicInputs) pair ready for the upload pipeline.
 *
 * The shape of `privateInputs` is circuit-specific — the keys we read are
 * documented inline. Callers using TypeScript can lean on `STARK_CIRCUITS`
 * for the circuit ID enum.
 */
export function generateProofBytes(
  exports: StarkExports,
  circuitId: number,
  privateInputs: Record<string, string | string[] | number[]>,
): { proofBytes: Uint8Array; publicInputs: bigint[]; commitment?: bigint } {
  switch (circuitId) {
    case STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP: {
      const secret = BigInt(asString(privateInputs.subscriberSecret ?? privateInputs.secret, 'subscriberSecret'));
      const json = JSON.parse(exports.generate_stark_proof(secret)) as CompactProofJson;
      const commitment = BigInt(json.commitment);
      return {
        proofBytes: hexToBytes(json.proof_hex),
        publicInputs: [commitment],
        commitment,
      };
    }
    case STARK_CIRCUITS.POOL_COMMITMENT: {
      const np = BigInt(asString(privateInputs.nullifierPreimage, 'nullifierPreimage'));
      const secret = BigInt(asString(privateInputs.secret, 'secret'));
      const epoch = BigInt(asString(privateInputs.depositEpoch ?? privateInputs.epoch, 'depositEpoch'));
      const mint = BigInt(asString(privateInputs.tokenMint, 'tokenMint'));
      const json = JSON.parse(
        exports.generate_pool_commitment_stark_proof(np, secret, epoch, mint),
      ) as PoolProofJson;
      return {
        proofBytes: hexToBytes(json.proof_hex),
        publicInputs: [BigInt(json.nullifier), BigInt(json.commitment)],
      };
    }
    case STARK_CIRCUITS.BALANCE_PROOF: {
      const sk = BigInt(asString(privateInputs.spendingKey, 'spendingKey'));
      const balance = BigInt(asString(privateInputs.balance, 'balance'));
      const salt = BigInt(asString(privateInputs.salt, 'salt'));
      const mint = BigInt(asString(privateInputs.tokenMint, 'tokenMint'));
      const json = JSON.parse(
        exports.generate_balance_stark_proof(sk, balance, salt, mint),
      ) as BalanceProofJson;
      return {
        proofBytes: hexToBytes(json.proof_hex),
        publicInputs: [BigInt(json.commitment), BigInt(json.token_mint)],
      };
    }
    case STARK_CIRCUITS.MERKLE_PATH: {
      const leaf = BigInt(asString(privateInputs.leaf, 'leaf'));
      const elements = asStringArray(privateInputs.pathElements);
      const indices = asStringArray(privateInputs.pathIndices);
      if (elements.length === 0) throw new Error('pathElements must be non-empty for MERKLE_PATH');
      const json = JSON.parse(
        exports.generate_merkle_path_stark_proof(leaf, elements.join(','), indices.join(',')),
      ) as MerklePathProofJson;
      // [C3 depth binding] depth is the 3rd public input. It is folded into the
      // prover's Fiat-Shamir transcript and bound on-chain (the verifier rejects
      // depth != 15). Older WASM that omits `depth` falls back to the path length.
      const depth = typeof json.depth === 'number' ? json.depth : indices.length;
      return {
        proofBytes: hexToBytes(json.proof_hex),
        publicInputs: [BigInt(json.leaf), BigInt(json.root), BigInt(depth)],
      };
    }
    case STARK_CIRCUITS.CONFIDENTIAL_BALANCE: {
      const sk = BigInt(asString(privateInputs.spendingKey, 'spendingKey'));
      const oldBal = BigInt(asString(privateInputs.oldBalance, 'oldBalance'));
      const oldSalt = BigInt(asString(privateInputs.oldSalt, 'oldSalt'));
      const newBal = BigInt(asString(privateInputs.newBalance, 'newBalance'));
      const newSalt = BigInt(asString(privateInputs.newSalt, 'newSalt'));
      const amount = BigInt(asString(privateInputs.amount, 'amount'));
      const amountSalt = BigInt(asString(privateInputs.amountSalt, 'amountSalt'));
      const mint = BigInt(asString(privateInputs.tokenMint, 'tokenMint'));
      const ret = exports.generate_confidential_balance_stark_proof(
        sk, oldBal, oldSalt, newBal, newSalt, amount, amountSalt, mint,
      );
      const json = JSON.parse(ret) as ConfBalanceProofJson;
      return {
        proofBytes: hexToBytes(json.proof_hex),
        publicInputs: [
          BigInt(json.old_commitment),
          BigInt(json.new_commitment),
          BigInt(json.amount_hash),
          BigInt(json.token_mint),
        ],
      };
    }
    case STARK_CIRCUITS.TRANSFER: {
      const sk         = BigInt(asString(privateInputs.spendingKey, 'spendingKey'));
      const tokenMint  = BigInt(asString(privateInputs.tokenMint, 'tokenMint'));
      const inAmt1     = BigInt(asString(privateInputs.inAmount1, 'inAmount1'));
      const inRand1    = BigInt(asString(privateInputs.inRand1, 'inRand1'));
      const inAmt2     = BigInt(asString(privateInputs.inAmount2, 'inAmount2'));
      const inRand2    = BigInt(asString(privateInputs.inRand2, 'inRand2'));
      const outAmt1    = BigInt(asString(privateInputs.outAmount1, 'outAmount1'));
      const outRecip1  = BigInt(asString(privateInputs.outRecipient1, 'outRecipient1'));
      const outRand1   = BigInt(asString(privateInputs.outRand1, 'outRand1'));
      const outAmt2    = BigInt(asString(privateInputs.outAmount2, 'outAmount2'));
      const outRecip2  = BigInt(asString(privateInputs.outRecipient2, 'outRecipient2'));
      const outRand2   = BigInt(asString(privateInputs.outRand2, 'outRand2'));
      const publicAmt  = BigInt(asString(privateInputs.publicAmount, 'publicAmount'));
      const ret = exports.generate_transfer_stark_proof(
        sk, tokenMint,
        inAmt1, inRand1, inAmt2, inRand2,
        outAmt1, outRecip1, outRand1,
        outAmt2, outRecip2, outRand2,
        publicAmt,
      );
      const json = JSON.parse(ret) as TransferProofJson;
      return {
        proofBytes: hexToBytes(json.proof_hex),
        publicInputs: [
          BigInt(json.nullifier_1),
          BigInt(json.nullifier_2),
          BigInt(json.output_commitment_1),
          BigInt(json.output_commitment_2),
          BigInt(json.public_amount),
          BigInt(json.token_mint),
        ],
      };
    }
    case STARK_CIRCUITS.MERKLE_UPDATE: {
      if (!exports.generate_merkle_update_stark_proof) {
        throw new Error(
          'Circuit 6 (MERKLE_UPDATE) is not exported by the bundled WASM. ' +
          'Rebuild `stark/wasm-out/p01_stark_bg.wasm` from `stark/src/lib.rs` to include it. ' +
          'See packages/stark-prover/README.md for the rebuild command.',
        );
      }
      const oldLeaf = BigInt(asString(privateInputs.oldLeaf, 'oldLeaf'));
      const newLeaf = BigInt(asString(privateInputs.newLeaf, 'newLeaf'));
      const elements = asStringArray(privateInputs.pathElements);
      const indices = asStringArray(privateInputs.pathIndices);
      const json = JSON.parse(
        exports.generate_merkle_update_stark_proof(
          oldLeaf, newLeaf, elements.join(','), indices.join(','),
        ),
      ) as MerkleUpdateProofJson;
      return {
        proofBytes: hexToBytes(json.proof_hex),
        publicInputs: [
          BigInt(json.old_leaf),
          BigInt(json.new_leaf),
          BigInt(json.old_root),
          BigInt(json.new_root),
          BigInt(json.depth),
        ],
      };
    }
    case STARK_CIRCUITS.SPEND: {
      if (!exports.generate_spend_stark_proof) {
        throw new Error(
          'Circuit 7 (SPEND) is not exported by the bundled WASM. The pre-C7 blob '
          + '(229,640 B / 51a947e3) has eight proof exports; the C7 build has nine. '
          + 'See packages/stark-prover/README.md for the rebuild command.',
        );
      }
      const nullifierPreimage = BigInt(asString(privateInputs.nullifierPreimage, 'nullifierPreimage'));
      const secret = BigInt(asString(privateInputs.secret, 'secret'));
      const blinding = BigInt(asString(privateInputs.blinding, 'blinding'));
      const tokenMint = BigInt(asString(privateInputs.tokenMint, 'tokenMint'));
      const elements = asStringArray(privateInputs.pathElements);
      const indices = asStringArray(privateInputs.pathIndices);
      const recipientHash = asStringArray(privateInputs.recipientHash);
      // The Rust side checks these arities too and returns a JSON `error`
      // rather than panicking, but it parses with `filter_map(.. .ok())`, which
      // SILENTLY DROPS anything unparseable -- so an 11-element path and a
      // 12-element path with one bad entry are indistinguishable by the time it
      // sees them. Say which one is wrong here, where the caller's array still
      // exists.
      if (elements.length !== 12 || indices.length !== 12) {
        throw new Error(
          `Circuit 7 (SPEND) needs exactly 12 path elements and 12 indices — its subtree `
          + `depth is 12, NOT the pool's 15. Got ${elements.length} and ${indices.length}.`,
        );
      }
      if (recipientHash.length !== 4) {
        throw new Error(
          `Circuit 7 (SPEND) needs a 4-limb recipientHash, got ${recipientHash.length}.`,
        );
      }
      const json = JSON.parse(
        exports.generate_spend_stark_proof(
          nullifierPreimage, secret, blinding, tokenMint,
          elements.join(','), indices.join(','), recipientHash.join(','),
        ),
      ) as SpendProofJson;
      if (json.error) throw new Error(`Circuit 7 (SPEND) prover refused: ${json.error}`);
      return {
        proofBytes: hexToBytes(json.proof_hex),
        // ⛔ VERBATIM ORDER. These six felts are serialised as-is and the
        // on-chain reconstruction in `unshield_denominated_stark_v4` hashes
        // them in this sequence. Sorting or reordering silently breaks the
        // public-inputs hash and the failure lands after the whole upload.
        //
        // 🚨 THE COMMITMENT IS ABSENT AND THAT IS THE PROPERTY. v3 published it
        // here; anyone reading the tree could match it to a deposit leaf.
        publicInputs: [
          BigInt(json.nullifier),
          BigInt(json.root),
          ...json.recipient_hash.map((h) => BigInt(h)),
        ],
      };
    }
    default:
      throw new Error(`Unsupported STARK circuit_id: ${circuitId}. Valid range is 0-7.`);
  }
}

// ---------------------------------------------------------------------------
// Top-level convenience: standalone `generateStarkProof`
// ---------------------------------------------------------------------------

/**
 * Generate a STARK proof and submit it on-chain in one call. Use this as a
 * one-shot when you already have a connection + payer in scope. For
 * production code prefer `createStarkProver(...)`, which caches the WASM
 * instance and the program ID across calls.
 */
export async function generateStarkProof(
  circuitId: number,
  privateInputs: Record<string, string | string[] | number[]>,
  config: StarkProverConfig,
): Promise<StarkProofOutcome> {
  const factory = createStarkProver(config);
  return factory.generateStarkProof(circuitId, privateInputs);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface StarkProverHandle {
  /** The bound generator — pass straight to `setProverConfig`. */
  generateStarkProof: StarkProofGenerator;
  /**
   * Eagerly initialize the WASM module. Optional — `generateStarkProof`
   * lazy-inits on first call. Useful in apps that want to defer the
   * ~10 ms cost to startup time.
   */
  ready(): Promise<void>;
  /**
   * Lower-level helper: generate the proof bytes locally without uploading.
   * Mostly for tests. Returns the raw bytes + public inputs.
   */
  generateLocal(
    circuitId: number,
    privateInputs: Record<string, string | string[] | number[]>,
  ): Promise<{ proofBytes: Uint8Array; publicInputs: bigint[] }>;
  /** Drop the cached WASM instance. Called automatically on process exit. */
  shutdown(): void;
}

/**
 * Create a STARK prover bound to a Solana connection + payer. The returned
 * handle's `generateStarkProof` matches the
 * `ProverConfig.generateStarkProof` signature from privacy-sdk and can be
 * passed to `setProverConfig` directly.
 */
export function createStarkProver(
  config: StarkProverConfig,
  /**
   * Optional override for where to find the WASM bytes. Pass this on
   * platforms where the bundled `wasm/p01_stark_bg.wasm` cannot be loaded
   * automatically (browser extensions, RN WebView, custom CDNs).
   */
  wasmSource?: WasmSource,
): StarkProverHandle {
  // Soft license gate — warn on missing/invalid, never throw. v0.x only.
  if (!config.licenseKey) {
    console.warn(formatMissingLicenseWarning());
  } else {
    const v = verifyLicenseKey(config.licenseKey);
    if (!v.valid) console.warn(formatInvalidLicenseWarning(v.reason ?? 'unknown'));
  }

  const programId = config.programId ?? new PublicKey(DEFAULT_STARK_VERIFIER_PROGRAM_ID);
  const retainBuffer = config.retainBuffer ?? true;

  let wasmPromise: Promise<StarkExports> | null = null;
  function loadWasm(): Promise<StarkExports> {
    if (!wasmPromise) wasmPromise = initStarkWasm(wasmSource);
    return wasmPromise;
  }

  const generator: StarkProofGenerator = async (circuitId, privateInputs) => {
    const exports = await loadWasm();
    const { proofBytes, publicInputs } = generateProofBytes(exports, circuitId, privateInputs);

    config.onProgress?.(`Generated ${proofBytes.length}-byte STARK proof for circuit ${circuitId}.`);

    const result = await uploadAndVerify(
      config.connection,
      config.payer,
      circuitId,
      proofBytes,
      publicInputs,
      {
        programId,
        retainBuffer,
        ...(config.onProgress ? { onProgress: config.onProgress } : {}),
      },
    );

    return {
      proofBuffer: result.proofBufferPda,
      circuitId,
      publicInputs,
    } satisfies StarkProofOutcome;
  };

  return {
    generateStarkProof: generator,
    ready: async () => { await loadWasm(); },
    generateLocal: async (circuitId, privateInputs) => {
      const exports = await loadWasm();
      const { proofBytes, publicInputs } = generateProofBytes(exports, circuitId, privateInputs);
      return { proofBytes, publicInputs };
    },
    shutdown: () => { wasmPromise = null; },
  };
}
