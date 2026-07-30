/**
 * WIRE-FORMAT PIN for the checked-in WASM prover.
 *
 * # Why this file exists
 *
 * `wasm/p01_stark_bg.wasm` is a git-tracked, npm-published, PREBUILT binary. It
 * is the prover every client actually runs: the extension worker (via an inlined
 * base64 copy), mobile (via `@protocol-01/react-native-zk`'s inlined copy), and
 * the privacy-SDK loader. Nothing in the repo rebuilds it — there is no
 * `wasm-pack` step in any `package.json` or workflow — so it drifts silently from
 * `stark/` while every Rust-side test stays green.
 *
 * It HAD drifted. MEASURED before the Route C reship, driving the then-checked-in
 * 192,732-byte blob under Node 22:
 *
 *   circuit 0 proof bytes: 79,993   (Rust prover at the same commit: 45,001)
 *   circuit 5 proof bytes: 138,293  (Rust prover at the same commit: 76,357)
 *
 * — i.e. the shipped prover predated B4's pair-leaf FRI commitment, the Merkle
 * domain-separation tags, AND Route C. Every client-generated proof was
 * old-format against the on-chain verifier. It fails closed (wrong trace root,
 * wrong per-query block size), so this was a functional break of the shipped
 * proving path rather than a soundness hole — but nothing detected it, because
 * the only assertion on WASM output anywhere was
 * `expect(proofBytes.length).toBeGreaterThan(1024)`, which a stale prover passes
 * trivially.
 *
 * # What this pins
 *
 * The exact serialized proof length of all seven shipping circuits, two ways:
 *
 *   1. Against the absolute literals `route_c_trace_pair.rs:1002` pins for the
 *      Rust prover. If the WASM and the Rust prover disagree by one byte, this
 *      is red.
 *   2. Against the Route C closed form `nq * (16*trace_width - 64)` applied to
 *      the pre-Route-C measured baseline. The closed form alone would stay green
 *      if BOTH the baseline and the actual drifted by the same amount, so both
 *      checks run.
 *
 * Proof size is witness-independent here — every field is fixed-width and every
 * Merkle path is fixed-depth — but the witnesses below deliberately match
 * `programs/p01_stark_verifier/tests/route_c_trace_pair.rs` and `tests/cu_budget.rs`
 * so a reader can diff the three files directly.
 *
 * # Reading a failure
 *
 * If this test goes red, the checked-in WASM and `stark/` have diverged. The fix
 * is to reship, not to move the pin:
 *
 *   wasm-pack build stark --target web --out-dir wasm-out -- --features wasm
 *   cp stark/wasm-out/p01_stark_bg.wasm packages/stark-prover/wasm/
 *   cp stark/wasm-out/p01_stark.js      packages/stark-prover/wasm/
 *   node scripts/reship-stark-wasm.mjs        # re-base64 the four inlined twins
 *
 * Move the pin ONLY when the wire format changed on purpose, and then only in
 * lockstep with `route_c_trace_pair.rs:1002` and the on-chain verifier.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import {
  generateProofBytes,
  initStarkWasm,
  resetStarkWasm,
  STARK_CIRCUITS,
  type StarkExports,
} from './index';

// ---------------------------------------------------------------------------
// MEASURED circuit geometry — mirrors `compact_proof.rs`'s CONFIG_* constants.
// Only the two fields the Route C closed form needs.
// ---------------------------------------------------------------------------

interface Pin {
  label: string;
  circuitId: number;
  /** `CircuitConfig::trace_width` */
  traceWidth: number;
  /** `CircuitConfig::num_queries` */
  numQueries: number;
  /** MEASURED pre-Route-C proof bytes (binary sha256 b5c7e01d…, 637,968 B). */
  preRouteC: number;
  /** MEASURED post-Route-C proof bytes — `route_c_trace_pair.rs:1002`. */
  absolute: number;
  inputs: Record<string, string | string[]>;
}

const csv = (xs: bigint[] | number[]): string[] => xs.map((x) => x.toString());

const PINS: Pin[] = [
  {
    label: 'C0 subscriber_ownership',
    circuitId: STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP,
    traceWidth: 3,
    numQueries: 27,
    preRouteC: 45_433,
    absolute: 45_001,
    inputs: { subscriberSecret: '42' },
  },
  {
    label: 'C1 pool_commitment',
    circuitId: STARK_CIRCUITS.POOL_COMMITMENT,
    traceWidth: 3,
    numQueries: 27,
    preRouteC: 66_233,
    absolute: 65_801,
    inputs: { nullifierPreimage: '42', secret: '17', depositEpoch: '7', tokenMint: '11' },
  },
  {
    label: 'C2 balance_proof',
    circuitId: STARK_CIRCUITS.BALANCE_PROOF,
    traceWidth: 4,
    numQueries: 27,
    preRouteC: 66_681,
    absolute: 66_681,
    inputs: { spendingKey: '42', balance: '1000', salt: '777', tokenMint: '999' },
  },
  {
    label: 'C3 merkle_path',
    circuitId: STARK_CIRCUITS.MERKLE_PATH,
    traceWidth: 6,
    numQueries: 22,
    preRouteC: 74_933,
    absolute: 75_637,
    inputs: {
      leaf: '777',
      pathElements: csv(Array.from({ length: 15 }, (_, i) => 1000 + i)),
      pathIndices: csv(Array.from({ length: 15 }, (_, i) => i % 2)),
    },
  },
  {
    label: 'C4 confidential_balance',
    circuitId: STARK_CIRCUITS.CONFIDENTIAL_BALANCE,
    traceWidth: 4,
    numQueries: 27,
    preRouteC: 78_377,
    absolute: 78_377,
    inputs: {
      spendingKey: '42',
      oldBalance: '1000',
      oldSalt: '111',
      newBalance: '800',
      newSalt: '222',
      amount: '200',
      amountSalt: '333',
      tokenMint: '999',
    },
  },
  {
    label: 'C5 transfer',
    circuitId: STARK_CIRCUITS.TRANSFER,
    traceWidth: 7,
    numQueries: 22,
    preRouteC: 75_301,
    absolute: 76_357,
    inputs: {
      spendingKey: '13',
      tokenMint: '500',
      inAmount1: '77',
      inRand1: '400',
      inAmount2: '88',
      inRand2: '100',
      outAmount1: '150',
      outRecipient1: '1234',
      outRand1: '555',
      outAmount2: '65',
      outRecipient2: '2222',
      outRand2: '333',
      publicAmount: '50',
    },
  },
  {
    label: 'C6 merkle_update',
    circuitId: STARK_CIRCUITS.MERKLE_UPDATE,
    traceWidth: 10,
    numQueries: 22,
    preRouteC: 76_405,
    absolute: 78_517,
    inputs: {
      oldLeaf: '111',
      newLeaf: '222',
      pathElements: csv(Array.from({ length: 15 }, (_, i) => 100 + i * 13)),
      pathIndices: csv(Array.from({ length: 15 }, (_, i) => i % 2)),
    },
  },
];

describe('checked-in WASM prover — Route C wire format', () => {
  let exports: StarkExports;

  beforeAll(async () => {
    resetStarkWasm();
    exports = await initStarkWasm();
  }, 60_000);

  // The single most load-bearing assertion in this file, called out separately
  // so a failure names the artifact rather than a table row. 45_001 is the same
  // literal `route_c_trace_pair.rs:1002` pins against the Rust prover.
  it('circuit 0 serializes to exactly 45,001 bytes — the Rust prover’s size', () => {
    const { proofBytes } = generateProofBytes(exports, STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP, {
      subscriberSecret: '42',
    });
    expect(proofBytes.length).toBe(45_001);
  }, 60_000);

  it('every shipping circuit exists in the bundled WASM', () => {
    // C6 was absent from an older build; `generateProofBytes` throws a specific
    // error for that case. A missing export is prover skew too, so name it.
    expect(typeof exports.generate_merkle_update_stark_proof).toBe('function');
  });

  for (const pin of PINS) {
    it(`${pin.label} matches the Rust prover and the Route C closed form`, () => {
      const { proofBytes } = generateProofBytes(exports, pin.circuitId, pin.inputs);

      // (1) absolute pin — WASM output must equal the Rust prover byte for byte
      expect(proofBytes.length).toBe(pin.absolute);

      // (2) closed-form pin — the delta from the pre-Route-C baseline must be
      //     exactly nq * (16*trace_width - 64)
      const expectedDelta = pin.numQueries * (16 * pin.traceWidth - 64);
      expect(proofBytes.length - pin.preRouteC).toBe(expectedDelta);
    }, 60_000);
  }
});
