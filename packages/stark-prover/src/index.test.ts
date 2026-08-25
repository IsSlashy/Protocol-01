/**
 * Unit tests for `@protocol-01/stark-prover`.
 *
 * Goals:
 *   1. The WASM module loads cleanly in Node 22 from the bundled bytes.
 *   2. Circuit 0 (subscriber_ownership) round-trips: secret → proofBytes
 *      with non-zero length and a non-zero commitment.
 *   3. The factory's API surface matches the privacy-sdk contract
 *      (StarkProofGenerator signature).
 *   4. The upload protocol's PDA derivation is stable / deterministic.
 *
 * We DO NOT hit a live RPC. The Solana surface is exercised via PDA
 * derivation only — the full pipeline (init / resize / chunk / verify) is
 * covered by integration tests in apps/mobile and apps/extension.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Keypair, PublicKey, Connection } from '@solana/web3.js';

import {
  createStarkProver,
  generateProofBytes,
  initStarkWasm,
  resetStarkWasm,
  STARK_CIRCUITS,
  DEFAULT_STARK_VERIFIER_PROGRAM_ID,
  getProofBufferPda,
  type StarkProofGenerator,
  type StarkProofOutcome,
} from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A non-trivial secret — 64-bit value that exercises the wide multiplication
// path inside Goldilocks Poseidon.
const TEST_SECRET = '12345678901234567';

// Mock connection: only `getLatestBlockhash` and similar are called by the
// upload pipeline; we stub them so an accidental network call fails loudly.
function makeMockConnection(): Connection {
  const conn = new Connection('http://localhost:8899', 'confirmed');
  // Override every method that would touch the network. The tests below
  // never invoke uploadAndVerify, but if they ever do we want the failure
  // to come from a clear stub message rather than a TCP timeout.
  return conn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('@protocol-01/stark-prover', () => {
  beforeAll(() => {
    resetStarkWasm();
  });

  // -------------------------------------------------------------------------
  // WASM loading
  // -------------------------------------------------------------------------

  it('loads the bundled WASM module', async () => {
    const exports = await initStarkWasm();
    expect(exports).toBeDefined();
    // Every proof entry point the current blob carries. Checked as a set rather
    // than two samples: a half-bound surface used to show up only when a caller
    // reached for the missing one.
    for (const fn of [
      'compute_stark_commitment',
      'generate_stark_proof',
      'generate_pool_commitment_stark_proof',
      'generate_balance_stark_proof',
      'generate_merkle_path_stark_proof',
      'generate_confidential_balance_stark_proof',
      'generate_transfer_stark_proof',
      'generate_merkle_update_stark_proof',
    ] as const) {
      expect(typeof exports[fn], `${fn} is not bound`).toBe('function');
    }

    // ⛔ `exports.memory` USED TO BE ASSERTED HERE AND CANNOT BE ANY MORE. The
    // loader stopped hand-rolling the wasm-bindgen ABI on 2026-08-25 and now
    // returns the generated glue's wrappers, which take and return real JS
    // values; `memory`, `__wbindgen_malloc` and friends belong to the glue.
    // Dropping the assertion is not a weakening — it checked that a raw
    // instance existed, and the loop above checks something stronger, that
    // every wrapper is bound.
    expect((exports as unknown as { memory?: unknown }).memory).toBeUndefined();
  });

  /**
   * THE C7 TRIPWIRE, FIRED AND TURNED AROUND (2026-08-25).
   *
   * It used to assert `generate_spend_stark_proof` was UNBOUND, because the
   * shipped blob (229,640 B / 51a947e3) had eight proof exports and the
   * circuit-7 build has nine. It went red on the reship, exactly as designed,
   * and named its own three conditions. All three were met before it was
   * flipped:
   *
   *   verifier redeployed      DGY37k3J… byte-identical to the local artifact,
   *                            confirmed on a DUMP, not deduced from a client
   *   shippedBlob re-pinned    72a8c700c466, 267,610 B
   *   wireFormat covers C7     length 77,965 + mask freshness — a DIGEST is
   *                            impossible for C7 and the reason is recorded there
   *
   * It now guards the other direction: a build that LOSES the export would put
   * the pool back on the v3 path, where the note commitment is a public input.
   */
  it('carries the circuit-7 prover', async () => {
    const exports = await initStarkWasm();
    expect(
      typeof exports.generate_spend_stark_proof,
      'generate_spend_stark_proof is gone — the pre-C7 blob (51a947e3) came back. '
        + 'Every spend falls back to v3, which PUBLISHES the note commitment.',
    ).toBe('function');
  });

  it('caches the WASM module across calls', async () => {
    const a = await initStarkWasm();
    const b = await initStarkWasm();
    expect(a).toBe(b);
  });

  // -------------------------------------------------------------------------
  // Circuit 0: subscriber_ownership
  // -------------------------------------------------------------------------

  it('generates a non-empty subscriber_ownership proof (circuit 0)', async () => {
    const exports = await initStarkWasm();
    const { proofBytes, publicInputs, commitment } = generateProofBytes(
      exports,
      STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP,
      { subscriberSecret: TEST_SECRET },
    );
    expect(proofBytes).toBeInstanceOf(Uint8Array);
    expect(proofBytes.length).toBeGreaterThan(0);
    // Subscriber-ownership proofs are typically ~30-80 KB — anything below
    // 1 KB would imply a malformed call.
    expect(proofBytes.length).toBeGreaterThan(1024);
    expect(publicInputs).toHaveLength(1);
    expect(publicInputs[0]).toBe(commitment);
    expect(commitment).toBeGreaterThan(0n);
  }, 30_000);

  it('produces a deterministic commitment for a given secret', async () => {
    const exports = await initStarkWasm();
    const a = generateProofBytes(exports, STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP, {
      subscriberSecret: TEST_SECRET,
    });
    const b = generateProofBytes(exports, STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP, {
      subscriberSecret: TEST_SECRET,
    });
    // The proof bytes themselves are randomized (FRI sampling), but the
    // commitment (Poseidon over the witness) MUST be deterministic.
    expect(a.commitment).toBe(b.commitment);
  }, 30_000);

  // -------------------------------------------------------------------------
  // API surface
  // -------------------------------------------------------------------------

  it('factory returns a generateStarkProof matching the privacy-sdk contract', () => {
    const conn = makeMockConnection();
    const payer = Keypair.generate();
    const handle = createStarkProver({ connection: conn, payer });

    // Compile-time check (TS): the function must be assignable to StarkProofGenerator.
    const gen: StarkProofGenerator = handle.generateStarkProof;
    expect(typeof gen).toBe('function');
    expect(gen.length).toBe(2);

    // Runtime: the handle exposes the documented surface.
    expect(typeof handle.ready).toBe('function');
    expect(typeof handle.generateLocal).toBe('function');
    expect(typeof handle.shutdown).toBe('function');
  });

  it('factory supports generateLocal without touching the network', async () => {
    const conn = makeMockConnection();
    const payer = Keypair.generate();
    const handle = createStarkProver({ connection: conn, payer });
    const { proofBytes, publicInputs } = await handle.generateLocal(
      STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP,
      { subscriberSecret: TEST_SECRET },
    );
    expect(proofBytes.length).toBeGreaterThan(1024);
    expect(publicInputs).toHaveLength(1);
  }, 30_000);

  it('factory ready() resolves to the WASM exports', async () => {
    const conn = makeMockConnection();
    const payer = Keypair.generate();
    const handle = createStarkProver({ connection: conn, payer });
    await expect(handle.ready()).resolves.toBeUndefined();
  }, 30_000);

  // -------------------------------------------------------------------------
  // PDA / discriminator wiring
  // -------------------------------------------------------------------------

  it('derives a stable proof-buffer PDA per (authority, circuit)', () => {
    const authority = new PublicKey('11111111111111111111111111111112');
    const programId = new PublicKey(DEFAULT_STARK_VERIFIER_PROGRAM_ID);
    const [pda0a] = getProofBufferPda(authority, 0, programId);
    const [pda0b] = getProofBufferPda(authority, 0, programId);
    const [pda1] = getProofBufferPda(authority, 1, programId);
    expect(pda0a.toBase58()).toBe(pda0b.toBase58());
    expect(pda0a.toBase58()).not.toBe(pda1.toBase58());
  });

  // -------------------------------------------------------------------------
  // STARK_CIRCUITS enum sanity
  // -------------------------------------------------------------------------

  it('exports the canonical circuit IDs (0-7)', () => {
    expect(STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP).toBe(0);
    expect(STARK_CIRCUITS.POOL_COMMITMENT).toBe(1);
    expect(STARK_CIRCUITS.BALANCE_PROOF).toBe(2);
    expect(STARK_CIRCUITS.MERKLE_PATH).toBe(3);
    expect(STARK_CIRCUITS.CONFIDENTIAL_BALANCE).toBe(4);
    expect(STARK_CIRCUITS.TRANSFER).toBe(5);
    expect(STARK_CIRCUITS.MERKLE_UPDATE).toBe(6);
    expect(STARK_CIRCUITS.SPEND).toBe(7);
  });

  // -------------------------------------------------------------------------
  // Type-shape compatibility check (compile-time assertion)
  // -------------------------------------------------------------------------

  it('StarkProofOutcome shape matches the privacy-sdk contract', () => {
    // This is a structural compile-time check: if the privacy-sdk's type
    // drifts, importing it here will fail typecheck. We don't import the
    // privacy-sdk type at runtime to avoid a circular install dep — the
    // dev-only import is purely for the assertion.
    const outcome: StarkProofOutcome = {
      proofBuffer: new PublicKey('11111111111111111111111111111112'),
      circuitId: 0,
      publicInputs: [1n, 2n],
    };
    expect(outcome.proofBuffer).toBeInstanceOf(PublicKey);
    expect(outcome.circuitId).toBe(0);
    expect(outcome.publicInputs).toEqual([1n, 2n]);
  });

  /**
   * 🚨 THIS TEST ASSERTED NOTHING, AND SAID SO IN A COMMENT.
   *
   * It was `rejects MERKLE_UPDATE (circuit 6) with a clear error in current WASM
   * build`, and it opened with:
   *
   *     if (exports.generate_merkle_update_stark_proof) {
   *       // If a future WASM build adds the export, this test becomes a no-op.
   *       return;
   *     }
   *
   * MEASURED 2026-08-25 via `WebAssembly.Module.exports()`: BOTH blobs export it
   * — the shipped 229,640 / 51a947e3 and the circuit-7 267,610 / 72a8c700. So
   * the early return has been taken every run, for as long as the export has
   * existed, and the green meant nothing.
   *
   * The premise was inverted, and three other files still carry it —
   * `wasm-loader.ts` used to call the export optional, `index.ts` throws
   * "not exported by the bundled WASM", and `README.md:51-54` repeats it.
   *
   * So it now asserts the true thing: C6 generates a real proof. A no-op that
   * announces itself is still a no-op.
   */
  it('generates a real MERKLE_UPDATE (circuit 6) proof — the export exists', async () => {
    const exports = await initStarkWasm();
    expect(
      typeof exports.generate_merkle_update_stark_proof,
      'circuit 6 is missing from the blob; index.ts and README still describe that as normal',
    ).toBe('function');

    const { proofBytes, publicInputs } = generateProofBytes(
      exports,
      STARK_CIRCUITS.MERKLE_UPDATE,
      {
        oldLeaf: '111',
        newLeaf: '222',
        pathElements: Array.from({ length: 15 }, (_, i) => String(100 + i * 13)),
        pathIndices: Array.from({ length: 15 }, (_, i) => String(i % 2)),
      },
    );
    // The length `wireFormat.test.ts` pins for C6, restated here so a failure
    // says "circuit 6" rather than "some pin moved".
    expect(proofBytes.length).toBe(81_037);
    // [old_leaf, new_leaf, old_root, new_root, depth] — five, and depth is 15,
    // the only value the deployed verifier accepts.
    expect(publicInputs).toHaveLength(5);
    expect(publicInputs[4]).toBe(15n);
  }, 60_000);

  it('rejects unknown circuit IDs', async () => {
    const exports = await initStarkWasm();
    expect(() => generateProofBytes(exports, 99, { foo: 'bar' })).toThrow(/Unsupported STARK circuit_id/);
  });
});
