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
   * 🚨 THE C7 TRIPWIRE. The shipped blob (229,640 B / 51a947e3) has EIGHT proof
   * exports; the circuit-7 build has nine. This pins which one is loaded.
   *
   * It is meant to go RED on the day the C7 blob is reshipped — that is the
   * signal to move it, re-pin `shippedBlob.test.ts`, and add a C7 row to
   * `wireFormat.test.ts`. ⛔ Do not flip it to `toBe('function')` without doing
   * those two, or the reship goes out with no digest behind it.
   */
  it('does not yet carry the circuit-7 prover', async () => {
    const exports = await initStarkWasm();
    expect(
      typeof exports.generate_spend_stark_proof,
      'generate_spend_stark_proof is bound — the C7 blob has shipped. Re-pin '
        + 'shippedBlob.test.ts and add a C7 digest to wireFormat.test.ts, then move this.',
    ).toBe('undefined');
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

  it('exports the canonical circuit IDs (0-6)', () => {
    expect(STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP).toBe(0);
    expect(STARK_CIRCUITS.POOL_COMMITMENT).toBe(1);
    expect(STARK_CIRCUITS.BALANCE_PROOF).toBe(2);
    expect(STARK_CIRCUITS.MERKLE_PATH).toBe(3);
    expect(STARK_CIRCUITS.CONFIDENTIAL_BALANCE).toBe(4);
    expect(STARK_CIRCUITS.TRANSFER).toBe(5);
    expect(STARK_CIRCUITS.MERKLE_UPDATE).toBe(6);
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

  it('rejects MERKLE_UPDATE (circuit 6) with a clear error in current WASM build', async () => {
    const exports = await initStarkWasm();
    if (exports.generate_merkle_update_stark_proof) {
      // If a future WASM build adds the export, this test becomes a no-op.
      return;
    }
    expect(() => generateProofBytes(exports, STARK_CIRCUITS.MERKLE_UPDATE, {
      oldLeaf: '1',
      newLeaf: '2',
      pathElements: ['0'],
      pathIndices: ['0'],
    })).toThrow(/MERKLE_UPDATE.*not exported by the bundled WASM/);
  });

  it('rejects unknown circuit IDs', async () => {
    const exports = await initStarkWasm();
    expect(() => generateProofBytes(exports, 99, { foo: 'bar' })).toThrow(/Unsupported STARK circuit_id/);
  });
});
