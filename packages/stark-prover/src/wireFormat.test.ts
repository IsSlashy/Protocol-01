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
 *   node packages/stark-prover/scripts/stark-wasm-twins.mjs --write
 *
 * `--features wasm` is MANDATORY: `stark/src/lib.rs` puts `mod wasm_api` behind
 * `#[cfg(feature = "wasm")]`, so without it the blob exports zero proof
 * functions. Do NOT pass `--features test-probes`; that compiles the
 * fails-closed attack knobs into the shipping prover, and
 * `wasmProbeScan.test.ts` will reject the result.
 *
 * Move the pin ONLY when the wire format changed on purpose, and then only in
 * lockstep with `route_c_trace_pair.rs:1002` and the on-chain verifier.
 */

import { createHash } from 'node:crypto';

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
  /**
   * [B2] MEASURED quotient segments, `ceil((deg(Q)+1)/trace_length)`. The Rust
   * twin is `CircuitConfig.quotient_segments`. It appears here because the
   * closed-form delta below is a function of it.
   */
  quotientSegments: number;
  /** MEASURED post-B2 proof bytes — `route_c_trace_pair.rs`. */
  absolute: number;
  /**
   * MEASURED sha256 of the serialized proof for `inputs`, taken from the RUST
   * prover in `stark/` — never copied out of a passing WASM run, which would
   * make the check circular.
   *
   * C0 and C1 are the same two digests pinned Rust-side in
   * `programs/p01_stark_verifier/tests/b1_deep_binding.rs`
   * (`FIXTURE_C0_SHA256` / `FIXTURE_C1_SHA256`). C2..C6 extend the check to the
   * five circuits that used to be pinned by LENGTH ONLY — the exact gap
   * B1-class skew slips through, because changing WHAT FRI folds does not move
   * a single byte.
   */
  sha256: string;
  inputs: Record<string, string | string[]>;
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex');

const csv = (xs: bigint[] | number[]): string[] => xs.map((x) => x.toString());

const PINS: Pin[] = [
  {
    label: 'C0 subscriber_ownership',
    circuitId: STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP,
    traceWidth: 3,
    numQueries: 27,
    preRouteC: 45_433,
    quotientSegments: 7,
    absolute: 47_641,
    sha256: '157f45be56f966afeaa0bbb43255e17e16e0de07a2817429c7d554923b30930e',
    inputs: { subscriberSecret: '42' },
  },
  {
    label: 'C1 pool_commitment',
    circuitId: STARK_CIRCUITS.POOL_COMMITMENT,
    traceWidth: 3,
    numQueries: 27,
    preRouteC: 66_233,
    quotientSegments: 8,
    absolute: 68_881,
    sha256: 'b41897fa3cb7b1f091e33fa89961d94124f56b3f944454e0a3f6b139487302ed',
    inputs: { nullifierPreimage: '42', secret: '17', depositEpoch: '7', tokenMint: '11' },
  },
  {
    label: 'C2 balance_proof',
    circuitId: STARK_CIRCUITS.BALANCE_PROOF,
    traceWidth: 4,
    numQueries: 27,
    preRouteC: 66_681,
    quotientSegments: 8,
    absolute: 69_761,
    // [BIND-C2C4 2026-08-03] MOVED by the C2 boundary fold. Copied from the RUST
    // pin (b1_deep_binding.rs FIXTURE_C2_SHA256), not out of the WASM run this
    // file drives — the reshipped blob then reproduced it independently, which is
    // the cross-language agreement this pin exists to assert.
    sha256: 'c3961423c1573f04e4c62ea4b0cf7e15c6146507fa2b015cc7a5f473cfbb8a7c',
    inputs: { spendingKey: '42', balance: '1000', salt: '777', tokenMint: '999' },
  },
  {
    label: 'C3 merkle_path',
    circuitId: STARK_CIRCUITS.MERKLE_PATH,
    traceWidth: 6,
    numQueries: 22,
    preRouteC: 74_933,
    quotientSegments: 8,
    absolute: 78_157,
    sha256: '86a572a2dbe86446ac46457de930001d0aa620db8b70a42b2fdd6f8afb1f4aca',
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
    quotientSegments: 8,
    absolute: 81_457,
    // [BIND-C2C4 2026-08-03] MOVED by the C4 boundary fold, same cause and same
    // provenance as C2 above: from FIXTURE_C4_SHA256, reproduced by the new blob.
    sha256: '6a7f55050d85af39f05a81a3d8bc715d90f63ee62c7bba9d72fb57462f8bc5c0',
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
    quotientSegments: 8,
    absolute: 78_877,
    sha256: 'a9e3805e504ac0468632739d615ac7d90e34843f27442685f8b30efb7723b5ed',
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
    quotientSegments: 8,
    absolute: 81_037,
    sha256: '65497bd9d2b35feefb285101353d5b3485e27e00c2985bfbd3d20cb80196e47a',
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
  // so a failure names the artifact rather than a table row. 47_641 is the same
  // literal `route_c_trace_pair.rs` pins against the Rust prover.
  it('circuit 0 serializes to exactly 47,641 bytes — the Rust prover’s size', () => {
    const { proofBytes } = generateProofBytes(exports, STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP, {
      subscriberSecret: '42',
    });
    expect(proofBytes.length).toBe(47_641);
  }, 60_000);

  it('every shipping circuit exists in the bundled WASM', () => {
    // C6 was absent from an older build; `generateProofBytes` throws a specific
    // error for that case. A missing export is prover skew too, so name it.
    expect(typeof exports.generate_merkle_update_stark_proof).toBe('function');
    // C7 joined the shipped blob on 2026-08-25. Its absence would not fail
    // loudly -- spends would fall back to the v3 path, which publishes the
    // note commitment -- so it is named here rather than left implicit.
    expect(typeof exports.generate_spend_stark_proof).toBe('function');
  });

  for (const pin of PINS) {
    it(`${pin.label} matches the Rust prover and the Route C closed form`, () => {
      const { proofBytes } = generateProofBytes(exports, pin.circuitId, pin.inputs);

      // (1) absolute pin — WASM output must equal the Rust prover byte for byte
      expect(proofBytes.length).toBe(pin.absolute);

      // (2) closed-form pin — the delta from the pre-Route-C baseline is TWO
      //     terms, kept apart because they came from different changes and a
      //     lumped delta would let a regression in one hide inside a gain in
      //     the other:
      //       Route C : nq * (16*trace_width - 64)
      //       [B2]    : 8 * (k - 1) * (2*nq + 1)
      //     The old single term was Route-C-only and became wrong the moment
      //     `ood_quotient`, the per-query quotient mirror block and the tail
      //     entry each widened from 8 to 8k bytes.
      const routeCDelta = pin.numQueries * (16 * pin.traceWidth - 64);
      const b2Delta = 8 * (pin.quotientSegments - 1) * (2 * pin.numQueries + 1);
      expect(proofBytes.length - pin.preRouteC).toBe(routeCDelta + b2Delta);

      // (3) CONTENT pin — the only one of the three that catches B1-class
      //     semantic skew. See `Pin.sha256`. Both length checks stay green
      //     against a stale prover; this one does not.
      expect(sha256Hex(proofBytes)).toBe(pin.sha256);
    }, 60_000);
  }

  // -------------------------------------------------------------------------
  // [B1] CROSS-LANGUAGE FIXTURE DIGEST.
  //
  // The length pins above cannot catch B1-class skew. B1 changed WHAT FRI folds
  // (a DEEP composition instead of the raw quotient LDE) without adding or
  // removing a single byte, so a stale WASM prover keeps every length pin green
  // while every proof it produces is rejected on chain with FriFoldCheckFailed —
  // not a parse error, not a length mismatch. The layout is byte-identical; the
  // content is semantically incompatible, because post-B1 layer roots and the
  // final polynomial commit folds of D rather than of Q.
  //
  // `stark-wasm-twins.mjs --check` cannot catch it either: it only proves the
  // five copies agree with each other, and they do, because they were all
  // reshipped from the same stale blob.
  //
  // A content digest is the only cross-language check that catches prover /
  // verifier semantic skew at constant length. EVERY circuit now carries one:
  // `Pin.sha256` in the table above covers C0..C6 and is asserted in the loop.
  // The two constants below are the C0 and C1 digests called out by name
  // because they are the SAME two pinned on the Rust side in
  // `programs/p01_stark_verifier/tests/b1_deep_binding.rs`
  // (`FIXTURE_C0_SHA256` / `FIXTURE_C1_SHA256`), computed over the SAME two
  // witnesses. If the two languages disagree, one of them is stale — reship, do
  // not move the pin.
  //
  // Before this file pinned C2..C6, those five were pinned by LENGTH ONLY and a
  // stale prover for any of them passed every gate in the repo.
  //
  // Legitimate because proof generation is fully deterministic: `grind_nonce`
  // starts at nonce 0 and increments, and there is no rand / thread_rng /
  // SystemTime anywhere in `stark/src/compact.rs`.
  //
  // These live INSIDE this describe on purpose. A second `beforeAll` calling
  // `resetStarkWasm()` desynchronises wasm-bindgen's shared return-pointer slot;
  // MEASURED as `SyntaxError: Unexpected token 'd', "d7e295b754"... is not valid
  // JSON`, i.e. the JSON read started partway into a proof_hex value.
  // -------------------------------------------------------------------------

  const FIXTURE_C0_SHA256 =
    '157f45be56f966afeaa0bbb43255e17e16e0de07a2817429c7d554923b30930e';
  const FIXTURE_C1_SHA256 =
    'b41897fa3cb7b1f091e33fa89961d94124f56b3f944454e0a3f6b139487302ed';

  it('C0 proof bytes hash to the digest the Rust prover produces', () => {
    const { proofBytes } = generateProofBytes(exports, STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP, {
      subscriberSecret: '42',
    });
    expect(proofBytes.length).toBe(47_641);
    expect(sha256Hex(proofBytes)).toBe(FIXTURE_C0_SHA256);
  }, 60_000);

  it('C1 proof bytes hash to the digest the Rust prover produces', () => {
    const { proofBytes } = generateProofBytes(exports, STARK_CIRCUITS.POOL_COMMITMENT, {
      nullifierPreimage: '42',
      secret: '17',
      depositEpoch: '7',
      tokenMint: '11',
    });
    expect(proofBytes.length).toBe(68_881);
    expect(sha256Hex(proofBytes)).toBe(FIXTURE_C1_SHA256);
  }, 60_000);

  // -------------------------------------------------------------------------
  // C7 spend — the one circuit that CANNOT carry a digest pin
  // -------------------------------------------------------------------------
  //
  // Every row in PINS above is pinned by sha256, and the file says why: a
  // content digest is the only cross-language check that catches prover /
  // verifier semantic skew at constant length.
  //
  // 🚨 C7 CANNOT HAVE ONE, AND THE REASON IS THE POINT OF THE CIRCUIT. Its
  // prover draws a 1,280-element mask from a real CSPRNG
  // (`stark/src/lib.rs` draw_spend_mask, MASK_ROWS * TRACE_WIDTH = 128 * 10)
  // and REFUSES to build a proof without one. Two proofs of the same witness
  // are different bytes by construction. A digest pin here could only be made
  // to pass by removing the masking — which is the underdetermination the
  // privacy argument rests on.
  //
  // So C7 is pinned by the two things that ARE invariant, plus the one thing
  // the mask must keep doing.
  describe('C7 spend', () => {
    const witness = {
      nullifierPreimage: 11n,
      secret: 22n,
      blinding: 33n,
      tokenMint: 44n,
      // ⛔ TWELVE, not fifteen. C7's subtree depth is CANONICAL_DEPTH = 12; the
      // pool tree is 15 and the top three levels are walked ON CHAIN by
      // `resolve_pool_root`. Feeding it a 15-element path is the single easiest
      // way to prove membership of the wrong tree.
      pathElements: Array.from({ length: 12 }, (_, i) => String(1000 + i * 7)).join(','),
      pathIndices: Array.from({ length: 12 }, (_, i) => String(i % 2)).join(','),
      recipientHash: ['111111111', '222222222', '333333333', '444444444'].join(','),
    };

    const prove = (): Record<string, unknown> => {
      const spend = exports.generate_spend_stark_proof;
      if (!spend) throw new Error('the shipped blob does not export generate_spend_stark_proof');
      return JSON.parse(spend(
        witness.nullifierPreimage, witness.secret, witness.blinding, witness.tokenMint,
        witness.pathElements, witness.pathIndices, witness.recipientHash,
      )) as Record<string, unknown>;
    };

    it('serializes to exactly 77,965 bytes — the Rust prover’s size', () => {
      // The same literal `cross_circuit_confusion.rs` pins Rust-side, in the
      // per-circuit length table. Masking changes the CONTENT of a proof, never
      // its length, so this stays a real cross-language check.
      const json = prove();
      expect(json.error ?? null, 'the prover refused the witness').toBeNull();
      expect(json.circuit_id).toBe(7);
      expect(json.proof_size).toBe(77_965);
      expect((json.proof_hex as string).length).toBe(77_965 * 2);
    }, 120_000);

    it('draws a fresh mask — the same witness twice gives DIFFERENT bytes', () => {
      // The inverse of the determinism assertion below, and load-bearing for a
      // different reason. If this ever passes as "equal", the CSPRNG stopped
      // being consulted and every spend proof leaks the same masked columns.
      const a = prove().proof_hex as string;
      const b = prove().proof_hex as string;
      expect(a.length).toBe(b.length);
      expect(a, 'C7 produced identical bytes twice — the mask is not being drawn').not.toBe(b);
    }, 180_000);

    it('publishes six felts and NOT the note commitment', () => {
      // 🚨 THE WHOLE REASON THE CIRCUIT EXISTS. v3 spent on a C1 + C3 pair tied
      // together by the note commitment, published in the clear — so a spend
      // named the leaf it spent, and anyone reading the tree walked back to the
      // deposit that funded it. C7 proves both halves in one trace and the
      // commitment never reaches the wire.
      //
      // Checked on the prover's OWN output rather than on an instruction we
      // build later: if the commitment reappears here, every downstream check
      // is inspecting a value that should not exist.
      const json = prove();
      expect(json).not.toHaveProperty('commitment');
      expect(json).toHaveProperty('nullifier');
      expect(json).toHaveProperty('root');
      expect((json.recipient_hash as string[]).length).toBe(4);
      // 1 + 1 + 4 = 6, the arity `expected_public_input_count(7)` enforces.
      const publicInputs = [json.nullifier, json.root, ...(json.recipient_hash as string[])];
      expect(publicInputs.length).toBe(6);
      for (const felt of publicInputs) expect(String(felt)).toMatch(/^\d+$/);
    }, 120_000);

    it('refuses a path of the wrong depth instead of proving the wrong tree', () => {
      // `filter_map(.. .ok())` on the Rust side SILENTLY DROPS unparseable
      // entries, so a truncated path arrives as a shorter one. The arity check
      // exists because a proof of an 11-deep subtree is a valid proof of a tree
      // nobody uses.
      const spend = exports.generate_spend_stark_proof!;
      const short = Array.from({ length: 11 }, (_, i) => String(1000 + i)).join(',');
      const json = JSON.parse(spend(
        11n, 22n, 33n, 44n, short, short, witness.recipientHash,
      )) as { error?: string };
      expect(json.error ?? '').toContain('path elements');
    }, 60_000);
  });

  it('is deterministic — the same witness twice gives the same bytes', () => {
    const a = generateProofBytes(exports, STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP, {
      subscriberSecret: '42',
    }).proofBytes;
    const b = generateProofBytes(exports, STARK_CIRCUITS.SUBSCRIBER_OWNERSHIP, {
      subscriberSecret: '42',
    }).proofBytes;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  }, 60_000);
});
