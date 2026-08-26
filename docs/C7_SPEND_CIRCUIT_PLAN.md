# C7 spend circuit — build plan (unlinkable withdrawals)

Produced 2026-07-25 by a 5-way parallel mapping of the AIR, prover/WASM, verifier,
pool program and client, then synthesised. Every claim is file:line grounded; verify
before trusting. Phase 1 (commitment blinding) is ALREADY SHIPPED — see commit fc6591ee.

# Ordered build plan — C7 "spend" circuit + `unshield_denominated_stark_v4`

## The one design decision that makes this plan work

The five investigators split on C7's geometry. AREA-prover and AREA-verifier assumed a **concatenated** trace (3 commitment cycles + 15 Merkle cycles = 576 rows → `trace_length` 1024, LDE 16384). That variant is not viable and should be discarded before anyone writes code:

- `verify.rs:70-78` and `:82-90` have **no** arms for 1024 / 16384 and fall through to `_ => Felt::ONE`. I read them directly — the constants are `GENERATOR_{32,128,256,512,2048,4096,8192}` and nothing else. An unlisted domain size does not error; it verifies against a degenerate domain.
- `eval_periodic_stride16_at_z` is typed `&[u64; 512]` with stride hardcoded to 16 (`verify.rs:1283`).
- ~160 KB proof breaks `UNIFORM_PROOF_SIZE = 145_000` (`apps/mobile/services/stark/index.ts:73`).
- Estimated phase-1 ≈1.37M CU against a 1.4M cap.

AREA-air's **parallel** layout is the correct one, and I confirmed the precedent is stronger than that report claimed. `merkle_update.rs:40-51` computes `trace_length_for_depth(15) = (480+1).next_power_of_two() = 512`, and `CONFIG_MERKLE_UPDATE` (`compact_proof.rs:157-166`) is **trace_width 10, trace_length 512, lde 8192, merkle_depth 13, 22 queries, fri_final_poly_size 16** — a width-10, 512-row trace running **two** full 15-level Poseidon pipelines side by side. That circuit is deployed and measured at 1,316,491 CU in phase 1.

C7 runs one 15-level Merkle pipeline plus a **3-cycle** commitment pipeline — strictly lighter than C6's second pipeline. So:

> **Hard constraint on the design: C7 must fit the C6 envelope exactly — trace_width ≤ 10, trace_length 512, blowup 16, lde_size 8192, merkle_depth 13, num_queries 22.** If a proposed layout needs a 17th cycle or a 1024-row trace, the design is wrong, not the budget.

Set `fri_final_poly_size = 32` for C7 (not 16). Two reasons: it makes C7's config bytes distinguishable from C6's, which `GenericCompactProof::from_bytes` enforces at `compact_proof.rs:486-489` and which the `verify_uniform` `PROBE_ORDER` at `lib.rs:413` needs (that path takes the first config that parses and does **not** fall through on failure); and it drops one committed FRI layer, saving ~7 KB and some CU.

**Recommended trace layout** (to be validated in Step 3, not taken on faith):

```
width 10, length 512, blowup 16 → LDE 8192, merkle_depth 13, 22 queries, ffps 32

col 0-2  Merkle Poseidon state       15 levels, rows 0-479
col 3    sibling
col 4    direction bit
col 5    carry  (row 0 = leaf = the commitment)
col 6-8  Commitment Poseidon state   cycles 0-2 meaningful (rows 0-95)
col 9    commit_hold — globally constant column

cycle 0 rows  0-31   nullifier   = P(nullifier_preimage, secret)   out col6@row30
cycle 1 rows 32-63   blind_hash  = P(blinding, token_mint)          out col6@row62
cycle 2 rows 64-95   commitment  = P(nullifier, blind_hash)         out col6@row94
cycles 3-15          UNCONSTRAINED-INPUT dummy Poseidons (see below)
```

The `commit_hold` column is the whole trick and it is why the commitment can be private. Transition constraints are local (row i → row i+1), so you cannot relate row 94 to row 0 directly. A column forced constant on every transition row, pinned at row 94 to the commitment output and equated at row 0 to the Merkle carry, binds `leaf == commitment` with **no boundary assertion and no public input carrying the commitment**. Three degree-1 constraints:

```
[15] (next[9] - current[9]) = 0                        on every transition row
[16] commit_out_flag(row 94) * (current[9] - current[6])
[17] row0_flag(row 0)      * (current[5] - current[9])
```

**CU optimisation to bake in from the first line of code:** let the commitment pipeline run all 16 cycles, with cycles 3-15 hashing prover-chosen garbage that nothing reads. That makes `rc0/rc1/rc2/round_flag/is_boundary` genuinely 32-periodic and **shared** between both pipelines, so every periodic column is either stride-16 or one-hot and **zero dense Horner evaluations are needed**. This matters enormously: C3's phase 2 costs 766,988 CU for seven *dense* 512-coefficient columns, while C5's phase 2 costs 274,239 CU for *twenty-eight* columns using `eval_periodic_stride16_at_z` (36 muls) plus `eval_one_hot_lagrange` (3 muls) — `verify.rs:2737-2845`. C7 must be built on the C5 recipe from day one. Retrofitting it later is a rewrite.

Public inputs: **`[nullifier, root, rh0, rh1, rh2, rh3]`** — six felts. Use the **full 256-bit** recipient hash split into four u64s, not one. A single felt gives 64-bit binding, and the attack is grinding a keypair whose `sha256` truncates to the same 64 bits. That is ~2^64 hashes on a fund-moving path with no margin. Four felts cost 32 bytes inside one existing `sol_sha256` call (≈0 CU), zero AIR columns, and zero constraints — the binding is Fiat-Shamir-transcript-only. Precedent that a transcript-only public input is genuinely binding: C3's `depth` participates in no hash inside the circuit yet changing it invalidates every proof, because `pub_bytes` feeds the OOD point `z`, the FRI query positions, and both RLC challenges `alpha`/`alpha_bnd`. Depth is **not** a public input for C7 — it is fixed at 15 by the trace layout; hardcode it and assert `public_inputs.len() == 6`.

---

## Step 0 — Retire the CU risk before writing any circuit (4-6 h) — **BLOCKING**

**The single biggest technical risk is C7 phase-2 DEEP-ALI compute cost**, not phase 1. Phase 1 is already answered: C7's phase-1 geometry is byte-identical to C6's, which ships at 1,316,491 CU with ~83K headroom. Phase 1 depends on trace width only through the Merkle leaf size (48 → 80 bytes, one extra sha256 block on two leaves per query, ≈+2K CU total). Phase 2 is the unknown: ~18 constraints and ~12 periodic columns, bracketed by C5's 274K and C3's 767K depending entirely on the periodic strategy.

**Smallest experiment that answers it.** Do *not* build the AIR first. Add `litesvm` (or `solana-program-test`) as a dev-dependency of `p01_stark_verifier` — I confirmed neither is present today, and there is currently **no local CU-measurement harness at all**, which is why every CU number in this repo is a devnet log. Then write a throwaway `probe_c7_phase2` instruction whose body performs exactly the *arithmetic shape* of C7 phase 2 on dummy inputs:

- 3 × `eval_periodic_stride16_at_z` (rc0, rc1, rc2)
- 2 × `eval_periodic_stride16_at_z` (round_flag, is_boundary)
- ~5 × `eval_one_hot_lagrange` + one `batch_inverse` over the flag denominators
- 18 constraint evaluations at OOD including three degree-7 `pow7` terms per pipeline
- one `boundary_fold_at_ood` over 6 assertions
- one `Z_T(z)` and one final `inv`

Measure `compute_units_consumed`. **Gate:** ≤ 900K CU. Under 900K, proceed. Between 900K and 1.2M, proceed but freeze the constraint count. Over 1.2M, stop and redesign before spending 40 hours on an AIR.

While the harness exists, spend 30 extra minutes measuring **real** phase-1 and phase-2 CU for C1, C3, C5 and C6 on the current binary. Every phase-1 figure the investigators quoted for C1/C3/C5 is inferred from a three-point fit, not measured. This one artefact removes the largest unknown in the whole project and is reusable for every future circuit.

Deliverable: a committed `programs/p01_stark_verifier/tests/cu_budget.rs` with a table of measured CU per circuit per phase, plus the C7 probe number.

---

## Step 1 — `min_epoch = 0` on every path (1 h) — **URGENT, ships alone, no program change**

Runs fully in parallel with Step 0 and with everything else. This is the highest value-per-hour change in the plan and it is independent of C7.

`apps/web/lib/privacy/pool/denominatedPool.ts:1653` reads `const minEpoch = emergency ? 0n : receipt.depositEpoch`, and `buildUnshieldDenominatedStarkV3Ix:1418` writes it at **instruction byte offset 72**. I confirmed both lines. Today that publishes the deposit epoch in the clear — the brief's threat model assumes an observer must brute-force it, and in fact it is handed to them. Worse, once Part A puts a 63-bit secret blinding in `receipt.depositEpoch`, this line publishes **the blinding itself** and Part A buys exactly nothing.

Change: force `minEpoch = 0n` unconditionally in the v3 unshield builder and delete the `emergency` parameter's effect on it. Safe because `unshield_denominated_stark_v3.rs:387` consumes it with `let _ = (..., min_epoch, ...)` — provably ignored on-chain. Mirror in `apps/extension` and `apps/mobile`.

**Proves it:** a unit test asserting `ix.data.readBigUInt64LE(72) === 0n` for both the emergency and non-emergency call shapes; plus a scan of the full `ix.data` for any 8-byte window equal to the blinding. Then one real devnet withdrawal.

---

## Step 2 — Finish Part A: PRF blinding (3-4 h) — parallel with Steps 0, 3-8

~80% is already in the working tree from a concurrent agent: `apps/web/lib/privacy/pool/noteBlinding.ts` (untracked, HKDF-SHA256 over `(walletSeed, poolPDA, leafIndex)` masked to 63 bits), the `depositEpochOverride` parameter on `prepareShieldInsert`, the blinding wired through `shieldEphemeral.ts:207-218`, and a blinded single-hash match with a legacy epoch fallback in `poolNotes.ts:110-128`. 37/37 pool tests pass.

Remaining:

1. **The transfer landmine.** `denominatedPool.ts:2081` passes `receipt.depositEpoch` as `min_epoch` into `transfer_denominated_stark_v3`, whose handler **does** enforce `current_epoch >= min_epoch + dynamic_delay` (`transfer_denominated_stark_v3.rs:167-173`) — unlike unshield. A blinded note has `depositEpoch ≈ 2^62` and becomes permanently un-transferable with `EpochDelayNotMet`. Not fund loss (the note stays unshieldable), but a silent capability loss. The path has no caller in `apps/web`; either delete `prepareTransfer`/`transferDenominatedStarkV3` from the web client, or pass `0n` and blind `newDepositEpoch` at `:1889`. Deleting is cleaner and prevents a future caller from tripping it.
2. **Rename** `ShieldReceipt.depositEpoch` → `noteBlinding` through the client, but **keep the JSON wire key `deposit_epoch` unchanged**. Changing the key without a version bump makes `extractStoredPath` (`poolHandlers.ts:460-483`) stop matching old blobs, silently dropping the stored Merkle path and forcing an RPC-dependent history rebuild.
3. **Fix the false copy** at `i18n/en.ts:1173` (commitment formula) and `:1175` ("Epoch-based maturity: deposit_epoch <= min_epoch enforced in circuit and on-chain" — never true; `min_epoch` has always been ignored on unshield).

**Proves it:** the four existing note-blinding tests, plus one asserting a **legacy** note (blinding = a real small epoch) still produces a valid commitment and a valid C1 witness. Keep the epoch-enumeration fallback in `recoverNotes` until the unspent leaf-30 note is provably spent — removing it makes that note invisible to scan and unwithdrawable through the UI.

---

## Step 3 — C7 AIR in the `stark` crate (12-16 h) — sequential after Step 0's gate

New `stark/src/air/spend.rs`, modelled on `merkle_update.rs` (the two-pipeline precedent) and `transfer.rs` (the carry-capture/continuity/route triple, which is the direct analogue of the hold column). Register in `stark/src/air/mod.rs`.

Exports: `TRACE_WIDTH = 10`, `TRACE_LENGTH = 512`, `SPEND_NUM_CONSTRAINTS`, `SPEND_NUM_PERIODIC`, `build_spend_trace`, `build_spend_periodic_columns`, `evaluate_spend_transition`, and a `compute_spend_values` helper that must call the **same** commitment formula as `denominated_pool.rs:343-353` so legacy notes stay provable.

Constraint ordering is load-bearing (the RLC uses `alpha^i` and the boundary fold uses `alpha_bnd^j`) — **append new constraints at the highest index, never insert**. Six boundary assertions, none of which carries the commitment or the leaf:

```
(col 6, row 30,  nullifier)   public
(col 6, row 64,  nullifier)   cycle-2 left input — same trick C1 uses at its row 64
(col 8, row 0,  0) (col 8, row 32, 0) (col 8, row 64, 0)   capacities
(col 0, row 478, root)        public
```

**Proves it before moving on:** a winterfell-path `prove`/`verify` round trip on an honest trace; `test_wrong_nullifier_fails_prove` cloned from `denominated_pool.rs:451-483`; a determinism test that a legacy note (blinding = 42) produces the identical commitment through both `createCommitmentV3` and the C7 witness builder; and an explicit assertion that `evaluate_spend_transition` returns all-zero on an honest trace and non-zero on each of the forgeries in Step 5.

---

## Step 4 — Compact pipeline + periodic emitter (8-12 h) — sequential after Step 3

`stark/src/compact.rs`:
- `pub const CIRCUIT_SPEND: u8 = 7;` beside `:3375-3381`
- `QuotientSpec::Circuit7`
- `compute_quotient_lde_circuit_7`, cloned from `compute_quotient_lde_circuit_5` (`:992-1086`) because it already handles mixed period-32 / period-512 columns via `materialise`
- arm 7 in `boundary_assertions_for_circuit` (`:1218`). **Privacy-critical.** Note the `pi(i)` closure at `:1224` returns **zero** for out-of-range indices — an off-by-one here silently binds a trace cell to zero instead of erroring. This arm must never emit an assertion whose value is the commitment.
- `boundary_spec_for_quotient` → `Some((7, *b"bnd-c7\0\0"))`, RLC tag `b"rlc-c7\0\0"`. Never reuse another circuit's tag.
- `generate_spend_compact_proof` writing `pub_bytes = nullifier || root || rh0..rh3`
- `#[test] #[ignore] emit_circuit_7_periodic_coeffs`, following `:2458`

`stark/src/lib.rs`: `#[wasm_bindgen] generate_spend_stark_proof` inside the `#[cfg(feature = "wasm")] mod wasm_api`. Signature `(nullifier_preimage: u64, secret: u64, blinding: u64, token_mint: u64, path_elements_csv: &str, path_indices_csv: &str, recipient_hash_csv: &str) -> String`, returning the same hand-built JSON convention as the other seven exports.

**Proves it:** `expected_wire_size` pin test (`compact.rs:1574-1599`) — the target is ~132 KB at ffps 32, versus 258,958 B for C1+C3 today, i.e. **the merge roughly halves upload bytes and eliminates one whole proof-buffer rent**; ⚠️ BOTH FIGURES ARE SUPERSEDED — 258,958 predates B4, the C1+C3 pair MEASURES 147,038 B (`verify/p01-verify.mjs`, a real 148-chunk upload scan), and C7 shipped at **77,965 B**, so the real cut is **1.9x** and not the ~2x this sentence happens to land on by cancelling two errors; `circuit_7_periodic_coeffs_match_verifier_constants` comparing the **full** arrays, not the spot values the existing C1-C6 parity tests use; and `spend_proof_satisfies_deep_ali_end_to_end` cloned from `:3058`, which reconstructs the verifier's DEEP-ALI identity in-crate and so catches an alpha/periodic/quotient mismatch without needing the verifier crate at all.

---

## Step 5 — Prover-side negative tests (6 h) — sequential after Step 4, **do not skip**

These are the tests that decide whether the pool can be drained. Each builds an **honest-looking trace with a forged witness** and asserts rejection. The pattern to copy is `transfer_deep_ali_rejects_non_conserving_proof` (`verify.rs:4567-4599`), which asserts phase 1 **accepts** and phase 2 **rejects** — because the interesting C7 constraints all live in DEEP-ALI phase 2, per-query step-4 checks only cover ~24% of rows.

Mandatory forgeries:

1. **Untied hold column.** Both Poseidon pipelines honest, but `col9` pinned to a value ≠ the commitment output at row 94, and the Merkle leaf set to that value. This is the direct attack on the hold-column trick: prove membership of a leaf you did not compute. Phase 2 must reject via constraint [16].
2. **Leaf ≠ commitment.** `col9` correctly equals the commitment, but `col5@row0` is set to a different leaf that *is* in the tree. Constraint [17] must reject. This is "spend someone else's note with your own nullifier" — the pool-drain.
3. **Nullifier/commitment decoupling.** `col6@row64` (cycle-2 left input) set to something other than the nullifier output at row 30. The boundary assertion catches it, but test it explicitly: this is the forgery that lets one nullifier spend many commitments.
4. **Wrong blinding.** Commitment computed with `b' ≠ b`, so the resulting commitment is not in the tree; paired with a Merkle path to a genuinely-present but different leaf. Must fail.
5. **Direction-bit forgery.** A non-boolean or mid-cycle-mutated direction bit, and a sibling that changes inside a hash cycle. C3's seven historical under-constraints (enumerated in `compact.rs:756-780`) are exactly this class — C7 inherits every one of them and must inherit every fix.
6. **Recipient malleability.** Take a fully valid proof and change only `rh0..rh3` in the instruction args. Phase 1 must reject because `pub_bytes` moved `z`, the query positions and both alphas.
7. **Arity.** `public_inputs.len() != 6` must be rejected in `verify_deep_ali_circuit_7`. Phase 1 does **not** enforce arity — `get_boundary_assertions` silently zero-fills missing entries.
8. **Padding-row queries.** A query landing in rows 96-511 of the commitment pipeline must not be treated as an active round. This is the `active_rows` bug that bit C3 (`verify.rs:3210-3220`).
9. The standard quartet, per the existing per-circuit pattern: honest accepts; tampered `ood_current` byte; tampered `ood_quotient` byte; wrong public inputs.
10. **Legacy note positive control.** A note whose blinding is a real small epoch must still prove and verify. Any range check on the blinding slot bricks leaf 30.

---

## Step 6 — On-chain verifier: circuit 7 (14-20 h) — sequential after Step 4; parallel with Steps 9-11

`compact_proof.rs`: `CONFIG_SPEND` (tw 10, len 512, blowup 16, lde 8192, md 13, rounds 30, **ffps 32**, nq 22) + `7 => Some(&CONFIG_SPEND)` in `get_circuit_config` (`:168-179`). Without this arm, `init_proof_buffer` rejects circuit 7 outright.

`periodic_consts.rs`: paste the `C7_*` arrays from Step 4's emitter. Budget ~5 × `[u64;512]` = ~20 KB of rodata if the all-16-cycles trick works; more if any column ends up dense.

`verify.rs`: arm 7 in `get_boundary_assertions`; `verify_constraints_spend` for step 4 (model on `verify_constraints_merkle_path:3189`, mind the `active_rows` guard); `evaluate_transition_at_ood_circuit_7`; `compute_c7_periodic_at_z` **in its own `#[inline(never)]` frame** — C5 needed exactly this to stay under the 4 KB SBF per-frame stack cap (`verify.rs:2877-2883`), and a width-10 18-constraint circuit will hit the same wall; `verify_deep_ali_circuit_7` with the arity guard; dispatch at `:443-452`.

`lib.rs`: `CIRCUIT_SPEND = 7`; and **two** edits that are easy to miss — the dispatch match at `:290-298` **and** the `matches!(circuit_id, 1 | 2 | 3 | 4 | 5 | 6)` gate at `:259-262` which I read directly and which will otherwise reject every C7 phase-2 call with `UnsupportedCircuit`. Decide explicitly whether C7 joins `PROBE_ORDER` at `:413`; if yes, the ffps-32 discriminator is what keeps it from colliding with C6. While there, fix the stale comment at `:406-412` claiming C3 and C5 share config bytes — C5 became width 7 in the conservation rebake.

**Proves it:** `cargo test -p p01_stark_verifier` — the native prove→verify path works because `p01-stark` is already a dev-dependency. Port every Step-5 forgery to the verifier crate. Then re-run the Step-0 harness on the **real** `verify_deep_ali_circuit_7` and confirm the measured CU matches the probe. Also confirm `boundary_fold_at_ood`'s `[Felt; 32]` denominator array is not exceeded (6 assertions — fine, but assert it).

---

## Step 7 — Pool program: `unshield_denominated_stark_v4` (5 h) — parallel with Step 6, sequential before deploy

New `programs/zk_shielded/src/instructions/unshield_denominated_stark_v4.rs`, produced by **copying v3 and deleting**, never rewriting. Register in `instructions/mod.rs` and in `lib.rs` immediately after the v3 registration at `:226`. **Leave v3 registered** — the repo's precedent for retiring an instruction is to comment it out (`lib.rs:152-172`), which is exactly what must not happen here or legacy notes lose their only withdrawal route.

Args drop to `(nullifier: [u8;32], merkle_root: [u8;32], recipient: [u8;32])` — 104 bytes, no `min_epoch`, **no `stark_commitment`**. Accounts identical to v3 with `c1_proof_buffer` + `c3_proof_buffer` collapsed to one `c7_proof_buffer`.

Preserved **verbatim, and each one is load-bearing**:
- nullifier PDA seeds `[b"nullifier", pool, nullifier]` — this is the **only** thing preventing a v3/v4 double-spend. One byte different and every existing note becomes spendable twice.
- `require!(nullifier[8..] == [0u8;24])` (`v3:234`) — the proof binds only the low 8 bytes; without this one proof spends under 2^192 distinct PDAs.
- `require!(tree_depth == 15)`, the pool's `is_valid_root(&merkle_root)` constraint, `is_active`
- `authority == payer`, discriminator, owner `== DGY37k3J…`, `verified`, **and `deep_ali_verified`** — omitting that last one was the 2026-06-05 CRITICAL and it makes the entire circuit worthless
- fee split, both SOL and SPL transfer paths, pool bookkeeping, the unnamed `remaining_accounts[0]` recipient convention, no event emitted

New body: `circuit_id == 7`; derive `recipient_hash = sha256(remaining_accounts[0].key())` on-chain (`solana_sha256_hasher` is already a dependency; the syscall is ~85 CU) split into four LE u64s; `expected = sha256(nullifier_u64_le || merkle_root[..8] || rh0 || rh1 || rh2 || rh3)`; compare against the buffer's `public_inputs_hash`.

**Proves it:** `cargo check`; byte-level unit test of the discriminator `sha256("global:unshield_denominated_stark_v4")[..8]`, the 104-byte length, and every offset; a test asserting the commitment's low u64 appears **nowhere** in `ix.data`. New error variants must be **appended** to `ZkShieldedError` — inserting renumbers every code from 6000 up and breaks client error mapping.

---

## Step 8 — WASM rebuild + the three base64 twins (3 h) — sequential after Step 4

```
wasm-pack build stark --target web --out-dir wasm-out -- --features wasm
```

The `-- --features wasm` is **mandatory**; `mod wasm_api` is cfg-gated and without it the blob exports zero proof functions. Note that `packages/stark-prover/README.md:51-54` gives the command **without** it — fix that comment.

**UPDATED after the Route C reship (step 3, round 3).** Both halves of this step now exist and no longer need hand-work:

```
node packages/stark-prover/scripts/stark-wasm-twins.mjs --write   # regenerate every twin
node packages/stark-prover/scripts/stark-wasm-twins.mjs --check   # CI gate, exit 1 on drift
```

There are **four** twins, not three — the fourth is `packages/react-native-zk/src/wasmData.ts`, which had drifted to a THIRD generation of the blob (MEASURED 124,562 B against a 192,732 B sibling) because its own `inline-wasm.mjs` resolved `node_modules` before the workspace sibling. Canonical blob is now 194,540 B; `p01_stark_bg.wasm` sizes quoted anywhere else in this document predate the reship.

The bigger finding this step should have caught and did not: the checked-in blob was **pre-B4, pre-domain-sep and pre-Route-C**. MEASURED, driving it under Node 22: circuit 0 at 79,993 bytes against a Rust prover emitting 45,001, and that 79,993-byte proof is rejected by the current verifier with `InvalidQueryPosition`. Every client-generated proof was old-format. Reship in lockstep with any wire-format change, and treat `packages/stark-prover`'s npm version as part of the change — the published 0.1.1 tarball still carries the pre-reship blob.

**Proves it:** `packages/stark-prover/src/wireFormat.test.ts` pins all seven circuits' serialized proof length from the checked-in blob against the literals `programs/p01_stark_verifier/tests/route_c_trace_pair.rs:1002` pins for the Rust prover (catches a *stale* reship), and `--check` above compares every twin's base64 against the canonical blob (catches a *partial* reship). Both run as a BLOCKING CI step. For C7 specifically, still add `WebAssembly.Module.exports()` confirming `generate_spend_stark_proof` shipped, declare the new export **optional** in the TS interfaces, and guard it with an explicit throw following `wasm-loader.ts:51-58`.

---

## Step 9 — Client cutover to C7 / v4 (8 h) — sequential after Step 8

Twelve switch points. Two are silent killers:

- **`apps/web/lib/privacy/pool/stark.ts:544`** — `if (proof.circuitId >= 1 && proof.circuitId <= 6)`. I read this line. A circuit-7 proof silently **skips DEEP-ALI phase 2**, and the on-chain `require!(deep_ali_verified)` then fails only *after* the entire multi-hundred-KB chunk upload completes, burning ~1 SOL of buffer rent per attempt with a misleading `InvalidProof`. This is the highest-value one-line change in the whole plan.
- **`recipient` must move from the EXECUTE request into the PREPARE request.** C7 binds `recipient_hash` as a public input, so the proof cannot be generated without it. Today it only arrives at execute (`poolHandlers.ts:100-107`, `shieldClient.ts:159-167`). Miss this and the binding is either wrong or decorative. `executeUnshield` must then assert the execute-time recipient equals the prepared one, or stop accepting it.

The rest: add `CIRCUIT_SPEND = 7` to `stark.ts:35-41`; **raise the 60 s per-request timeout at `starkProver.ts:149-154`** (C1 and C3 each sit near it today and a merged trace is heavier); add `generateSpendProof` to the worker (`starkProver.worker.ts` message union, `StarkExports`, dispatch) and to the facade — the emitted `publicInputs` order must be exactly `[nullifier, root, rh0..rh3]` because `stark.ts` serialises it verbatim and the on-chain reconstruction is order-sensitive; `buildUnshieldDenominatedStarkV4Ix`; **delete `starkCommitment` from `PrepareUnshieldResult` (`denominatedPool.ts:1459-1465`)** so the compiler finds every remaining leak for you; one `submitAndVerifyStarkProof` call instead of two in both `prepareUnshield` and `unshieldFromPath.ts:106-133`; single-buffer float pricing in `unshieldEphemeral.ts:142-148` using the **measured** C7 proof size; mirror the extension worker, which differs from the web one by exactly one import line today.

**Keep circuits 1 and 3 in `recoverFloat.ts:89-92`** alongside 7, or ~1 SOL of rent in any pre-v4 orphaned buffer is permanently stranded.

Everything else is deliberately untouched — the entire shield path, C6, `computeNewRootFromSubtreesV3`, `buildMerkleProofFromLeavesV3`, `fetchPoolCommitments`, `deriveNoteMaterial`, and every pool PDA. **v4 spends the same leaves in the same trees: the anonymity set is preserved and there is no migration.**

---

## Step 10 — Client tests (4 h) — parallel with Step 9

`pnpm test:pool` runs `apps/web/lib/privacy/pool/**/*.test.ts` in a node environment against the **real** `@solana/web3.js` (the main jsdom suite mocks it). It is pure math and instruction bytes — no RPC, no WASM, no worker. **A green run says nothing about whether a C7 proof verifies.** Do not treat it as a C7 gate.

Add: locked v4 discriminator bytes and full offset/account-order/flag assertions; a public-input encoding vector (`sha256` of the six u64-LE) hard-copied from the Rust side; `recipient_hash` as a locked pure function of the pubkey; the **leak regression test** — scan every 8-byte window of `ix.data` and assert neither the commitment low u64 nor the blinding appears; a wrong-blinding test that fails locally before any rent is spent; a prepared-for-A-executed-for-B rejection; a legacy-note positive control. Update or delete the `buildTransferDenominatedStarkV3Ix` block at `test:349-419`, whose lines 389-390 currently lock `min_epoch@72` and `stark_commitment@80`.

---

## Step 11 — Deploy verifier, then pool (5 h) — strictly sequential, verifier first

Verifier first, always: the pool program's v4 handler is inert without circuit 7, but a deployed circuit 7 with no consumer is harmless.

```
solana program show DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs --url devnet
solana program extend DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs <bytes> --url devnet   # if needed
solana program deploy --program-id DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs target/deploy/p01_stark_verifier.so --url devnet
```

**Never pass a keypair path to `--program-id`.** The footgun is armed right now: `target/deploy/zk_shielded-keypair.json` derives to `2w4WRvujjrZYip1dUrp3X4nzoPVWeRZF9KnjtvSstGms`, a **closed** program, and `Anchor.toml:41` `[programs.devnet]` still names it. `scripts/rebuild-zk-shielded.sh:37` and `scripts/deploy-zk-v2.sh:23-27` both use the keypair form — do not run either, and do not run `anchor deploy --provider.cluster devnet`. The same class of mistake cost ~7.82 SOL on 2026-04-19.

Headroom is tight: the verifier's ProgramData is 840,168 bytes against a 817,632-byte local `.so` (~22.5 KB spare) and C7's periodic tables are ~20 KB. The pool's ProgramData is 1,354,117 bytes = 45-byte header + exactly the current program length, i.e. **zero spare**. Budget for `solana program extend` on both and fund the extra rent.

While deploying, fix the stale ids: `Anchor.toml:22` and `:41`, `packages/privacy-sdk/src/constants.ts:23`, and the regenerated IDL/types all still point at the dead `EXmAQqm…` verifier id.

---

## Step 12 — Devnet end-to-end + honest claims (6 h)

Shield a fresh throwaway note → close the browser → recover it by scan with **no stored state** → withdraw via v4. Then confirm the withdrawal transaction contains no value derivable from the deposit's `LeafInserted` event: no commitment, no blinding, no epoch.

Only after a real v4 withdrawal succeeds may the v3 path be de-emphasised in the UI — and it must **stay registered on-chain indefinitely** for notes whose blinding is unknown, including the unspent leaf-30 note.

Update `docs/` and the memory notes. The honest claim after this ships is: *"withdrawals are no longer linkable to their deposits by the commitment; sender identity, amount (within a denomination bucket) and graph position are separate, unshipped work."* Do not upgrade the privacy claim beyond what the diff delivers.

---

## Parallelism map

**Fully parallel from t=0:** Step 0 (Rust/verifier tests) ‖ Steps 1-2 (TypeScript client). Different crates, zero shared files, and the client work ships to production on its own without touching a program.

**Strictly sequential:** 0 → 3 → 4 → {6, 8} ; 4 → 5 ; 8 → 9 ; {6, 7, 9} → 11 → 12.

Step 4's periodic emitter feeds Step 6's constants; Step 4's WASM export signature feeds Step 8 and 9. Freeze the public-input tuple and the WASM signature at the **end of Step 4** and the three downstream tracks (verifier, pool program, client) run concurrently.

**Parallel once the tuple is frozen:** Step 6 (Rust verifier) ‖ Step 7 (Rust pool program — different crate) ‖ Steps 8-10 (TypeScript). Step 7 only needs `circuit_id = 7` and the public-input order; it does not need the circuit to exist.

**Never parallel:** the two deploys in Step 11. Verifier first, confirm on-chain, then pool.

## What cannot be known until it is built and measured

1. **C7 phase-2 CU.** Step 0's probe gives a good estimate; only the real `verify_deep_ali_circuit_7` on-chain gives the answer. Everything downstream of it is conditional.
2. **Whether the all-16-cycles trick makes every periodic column stride-16/one-hot eligible.** It is an algebraic argument I have not validated against a real trace. If one column ends up dense, add ~110K CU and ~4 KB of rodata.
3. **Whether the parallel layout is sound** — specifically that two Poseidon pipelines sharing `rc0/rc1/rc2` and `round_flag` on the same 32-row grid satisfy both gatings simultaneously. Both start at row 0 so they are phase-aligned, but no one has written the trace.
4. **The real proof size and therefore the pre-fund float.** ~132 KB is computed from `expected_wire_size`, not measured. Do not hardcode it.
5. **Browser prover wall-clock.** The only measurements are C1 = 207 ms and C6 = 1.6 s in a Next 16 worker. A width-10 512-row trace should land near C6, but a mid-range phone in the RN WebView is unproven.
6. **Whether the deployed `zk_shielded` bytecode matches this working tree.** The local `.so` is 1,134,280 bytes against an on-chain 1,354,072 — plausibly the raw-cargo-vs-anchor IDL delta, but unreconciled.
7. **Whether the ephemeral proof-authority is ever handed to a third party today.** It never leaves the browser in the current web flow, which is what makes the recipient-binding gap theoretical rather than live. The PFEA/relayer design would change that. The relayer service is gitignored and was not traced.

## Effort

| Step | Hours |
|---|---|
| 0 CU probe + real measurements | 4-6 |
| 1 min_epoch=0 | 1 |
| 2 finish blinding | 3-4 |
| 3 C7 AIR | 12-16 |
| 4 compact pipeline + emitter | 8-12 |
| 5 prover negative tests | 6 |
| 6 verifier circuit 7 | 14-20 |
| 7 pool v4 | 5 |
| 8 WASM + twins | 3 |
| 9 client cutover | 8 |
| 10 client tests | 4 |
| 11 deploys | 5 |
| 12 devnet e2e + docs | 6 |
| **Total** | **79-96 h serial; ~55-70 h wall-clock with the parallel tracks** |

Steps 1-2 alone (5 h) close the plaintext-epoch leak and are worth shipping this week regardless of whether C7 ever gets built.

## Risks

- BIGGEST RISK, and the reason Step 0 exists: C7 phase-2 DEEP-ALI CU is unmeasured and spans 274K (C5 recipe) to 1.2M (dense Horner) purely as a function of the periodic-evaluation strategy. Phase 1 is NOT the risk - it is byte-identical to C6's deployed geometry. Retire phase 2 with a litesvm probe of the arithmetic shape before writing a single line of AIR.
- A 1024-row / LDE-16384 C7 does not merely cost too much - it SILENTLY VERIFIES AGAINST A DEGENERATE DOMAIN. verify.rs:70-78 and :82-90 return Felt::ONE for any unlisted size with the comment 'Should never happen'. I read both. Any geometry decision that leaves 512/8192 must first convert those fallthroughs into hard errors.
- Forgetting EITHER of the two circuit-id edits in lib.rs breaks C7 silently in different ways: the dispatch match at :290-298 and the separate matches!(circuit_id, 1|2|3|4|5|6) gate at :259-262. The gate is the one people miss.
- stark.ts:544 gates DEEP-ALI on `circuitId >= 1 && <= 6`. A C7 proof skips phase 2, and the on-chain require!(deep_ali_verified) then fails only AFTER the full ~130 KB chunk upload, burning ~1 SOL of buffer rent per attempt with a misleading InvalidProof. Verified by direct read.
- Everything interesting in C7 - the hold-column pin, leaf==commitment, the chain edge - lives in DEEP-ALI phase 2 only. Per-query step-4 checks cover ~24% of rows and are structural. If the v4 handler omits require!(deep_ali_verified) the circuit is worth nothing; that exact omission was the 2026-06-05 CRITICAL for C1/C3.
- A single-felt recipient_hash gives 64-bit binding on a fund-moving path. Under the PFEA/relayer design the proof authority is handed to a third party who can then grind a keypair colliding on 64 bits and redirect the withdrawal. Use four felts; it is transcript-only and costs nothing.
- The nullifier PDA seeds [b"nullifier", pool, nullifier] are the ONLY thing preventing a v3/v4 double-spend. One byte different in v4 and every existing note becomes spendable twice. Same for require!(nullifier[8..] == [0;24]) - the proof binds only the low 8 bytes, so dropping it gives 2^192 PDAs per proof.
- Constraint ORDER and boundary-assertion ORDER are load-bearing (alpha^i and alpha_bnd^j respectively) and must stay byte-identical across four places: the prover AIR, compute_quotient_lde_circuit_7, the verifier's evaluate_transition_at_ood_circuit_7, and the baked periodic constants. Always append at the highest index.
- verify_uniform takes the FIRST config whose from_bytes succeeds and does NOT fall through on verification failure. C7 at tw10/len512/lde8192/md13/22q/ffps16 would be byte-indistinguishable from C6 and one of the two becomes permanently unverifiable through the mobile path. ffps=32 is the discriminator. Also, the comment justifying the current PROBE_ORDER is factually wrong about C5's width.
- Program-size headroom: the verifier's ProgramData is 840,168 bytes against an 817,632-byte .so (~22.5 KB spare) and C7's periodic tables are ~20 KB; the pool's ProgramData is EXACTLY its current program length (zero spare). Both need solana program extend. A deploy that hits the size wall mid-flight leaves a dangling buffer account holding SOL.
- The --program-id keypair footgun is armed right now: target/deploy/zk_shielded-keypair.json derives to 2w4WRvuj... (a CLOSED program) and Anchor.toml:41 still names it. Two repo scripts and `anchor deploy --provider.cluster devnet` all use that path. The same class of mistake cost ~7.82 SOL on 2026-04-19.
- The commitment pipeline is only active on rows 0-95 of a 512-row trace. A per-query check treating rows 96-511 as active rounds deterministically fails valid proofs - this is exactly the active_rows bug fixed for C3 at verify.rs:3210-3220.
- A width-10, 18-constraint phase-2 will hit the SBF 4 KB per-frame stack cap. verify_deep_ali_circuit_5 needed its periodic computation moved into a separate #[inline(never)] function purely for this.
- Old and new proofs are mutually incompatible: the WASM prover, the verifier program and the pool program must cut over together. A partial deploy bricks withdrawals. Three hand-maintained base64 twins with no generator script and no CI check make a partial cutover easy.
- C7 must accept ANY field element in the blinding slot. A range check would brick the unspent leaf-30 note, whose blinding is a real epoch. Likewise the legacy epoch-enumeration fallback at poolNotes.ts:118-128 must stay until that note is provably spent.
- Removing or deprecating the v3 C1+C3 path before v4 is proven on devnet leaves any note whose blinding is unknown with no withdrawal route.
- token_mint is an unbound private witness in C1 today (no assertion on col 1 at row 32); soundness is saved only by the commitment having to appear in that specific pool's tree. C7 inherits this. Binding it publicly is cheap and this is the natural moment, but it changes pub_bytes and therefore every client.
- pnpm test:pool is pure math and instruction bytes - no RPC, no WASM, no worker. A green run proves nothing about whether a C7 proof verifies. Do not treat it as a C7 gate.
- poolHandlers.ts:390 writes the SECRET blinding into the note blob under the key deposit_epoch. It is PQ-encrypted to the user's own address so it is safe at rest, but any future debug logging of that JSON leaks the blinding and undoes the entire change.
- Doc rot that will actively mislead an implementer: compact_proof.rs:143-156 claims CONFIG_MERKLE_UPDATE uses ffps 256 while the literal at :164 is 16; packages/stark-prover/README.md:51-54 gives the wasm build command WITHOUT --features wasm (would ship a blob with zero proof exports); wasm-loader.ts:51-58 claims merkle_update is not exported (it is); lib.rs:406-412 claims C3 and C5 share config bytes (C5 is width 7).

## Unknowns (cannot be settled without building/measuring)

- C7 phase-2 CU. Step 0's probe gives an estimate of the arithmetic shape; only the real verify_deep_ali_circuit_7 measured on-chain gives the answer. Everything downstream is conditional on it.
- Whether the all-16-cycles trick actually makes every C7 periodic column stride-16 or one-hot eligible. It is an algebraic argument nobody has validated against a real trace. If one column ends up dense, add ~110K CU and ~4 KB of rodata.
- Whether the parallel two-pipeline layout is sound - specifically that both pipelines sharing rc0/rc1/rc2 and round_flag on the same 32-row grid satisfy both round-flag gatings simultaneously. They are phase-aligned (both start at row 0), but no trace has been written and tested.
- Whether the max RLC-combined constraint degree stays under LDE 8192 in the worst case for a width-10, 18-constraint trace. The dominant term computes to ~4599 analytically, but that is a bound on one term, not an empirical maximum.
- AREA-air asserted that setting is_boundary[511]=1 is safe because the transition domain excludes the last row, and that this is what makes the column stride-16 eligible. C5 deliberately does the OPPOSITE (transfer.rs:331 skips row 511, which is why C5_IS_BOUNDARY_COEFFS falls back to dense Horner). Prototype before committing.
- The real C7 proof size, and therefore the pre-fund float. ~132 KB at ffps 32 is computed from expected_wire_size, not measured. Do not hardcode it in unshieldEphemeral.ts.
- Browser and mobile prover wall-clock for a width-10 512-row trace. The only measurements anywhere are C1 = 207 ms and C6 = 1.6 s in a Next 16 turbopack worker. A mid-range phone in the RN WebView is completely unproven, and the worker timeout is currently 60 s.
- Whether boundary_fold_at_ood's [Felt; 32] denominator array is sufficient for C7. Six assertions in the proposed layout, so yes - but if the layout grows capacity/routing assertions past 32 the function returns None and every proof fails with a confusing DeepAliFailed.
- Whether the deployed zk_shielded bytecode matches this working tree. The local .so is 1,134,280 bytes against an on-chain Data Length of 1,354,072; the 'raw-cargo build lacks the embedded IDL' explanation is plausible but unreconciled.
- Whether the ephemeral proof-authority is ever handed to a third party today. It never leaves the browser in the current web flow, which is what makes the recipient-binding gap theoretical rather than live. The PFEA/relayer design would change that; the relayer service is gitignored and was not traced.
- Whether Agave 2.2.14's solana program deploy auto-extends ProgramData or errors. Untested. Budget for a manual extend.
- Whether the mobile app and the extension consume these note blobs / ShareableNote payloads in practice. If they do, changing the meaning of deposit_epoch is a cross-client compatibility event, not an apps/web-only one.
- Whether transfer_denominated_stark_v3 and split_note_stark should get the same C7 treatment. Both publish stark_commitment and carry the identical leak; this plan scopes only the unshield path.
- Whether the on-chain V4 pools actually carry max_historical_roots = 100. That figure comes from a May measurement on a V2 pool, not from a live V4 pool account read. A stale root fails is_valid_root with InvalidMerkleRoot, which would look like a C7 bug.

## Commands

```
cargo test -p p01-stark --lib air::merkle_update   # the width-10/512-row two-pipeline precedent C7 copies
cargo test -p p01-stark --lib air::merkle_path && cargo test -p p01-stark --lib air::denominated_pool
cargo test -p p01-stark --lib merkle_path_proof_satisfies_deep_ali_end_to_end   # the in-crate DEEP-ALI identity check to clone for C7
cargo test -p p01-stark --lib emit_circuit_7_periodic_coeffs -- --ignored --nocapture   # emits the C7_* arrays to paste into periodic_consts.rs
cargo test -p p01-stark --lib   # 41 prover tests incl. wire-size drift pins and periodic parity pins
cargo test -p p01_stark_verifier   # native prove->verify; p01-stark is already a dev-dependency
cargo test -p p01_stark_verifier --lib transfer_deep_ali_rejects_non_conserving_proof   # THE negative-test pattern: phase 1 accepts, phase 2 rejects
cargo test -p p01_stark_verifier --release --test cu_budget -- --nocapture --test-threads=1   # litesvm CU + proof bytes; builds its own .so from a content fingerprint of src/, and CU_CEILINGS makes a regression red
wasm-pack build stark --target web --out-dir wasm-out -- --features wasm   # the `-- --features wasm` is MANDATORY
cp stark/wasm-out/p01_stark_bg.wasm stark/wasm-out/p01_stark.js packages/stark-prover/wasm/ && node packages/stark-prover/scripts/stark-wasm-twins.mjs --write   # reship the blob + all FOUR base64 twins
node packages/stark-prover/scripts/stark-wasm-twins.mjs --check && pnpm --filter @protocol-01/stark-prover test   # the two prover-artifact gates: partial reship, then stale reship
node -e "const fs=require('fs');for(const e of WebAssembly.Module.exports(new WebAssembly.Module(fs.readFileSync('stark/wasm-out/p01_stark_bg.wasm'))))console.log(e.kind,e.name);"   # confirm generate_spend_stark_proof shipped
cd apps/web && pnpm test:pool   # pure math + instruction bytes only; NOT a C7 gate
cargo check --workspace --all-targets --exclude p01-arcium --exclude encrypted-ixs   # what CI runs
solana program show DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs --url devnet   # verifier: authority + Data Length before building
solana program show GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c --url devnet   # pool: ProgramData has ZERO spare capacity today
solana program extend DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs 40000 --url devnet   # likely required before the C7 verifier deploy
solana program deploy --program-id DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs target/deploy/p01_stark_verifier.so --url devnet --with-compute-unit-price 100000
solana program deploy --program-id GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c target/deploy/zk_shielded.so --url devnet   # AFTER the verifier, never before
solana-keygen pubkey target/deploy/zk_shielded-keypair.json   # returns 2w4WRvuj... = CLOSED. NEVER pass this file to --program-id
# DO NOT RUN: scripts/rebuild-zk-shielded.sh, scripts/deploy-zk-v2.sh, anchor deploy --provider.cluster devnet - all three target dead program ids
```


## Key files

- `D:\Protocol-01\stark\src\air\merkle_update.rs` — THE structural template for C7. Width 10, 512 rows, TWO Poseidon pipelines sharing sibling/direction columns, 15 Merkle levels. Deployed and working, which is what makes the C7 parallel layout low-risk. (40 pub const TRACE_WIDTH: usize = 10; 44-51 trace_length_for_depth uses (active+1).next_power_of_two() -> 512 at depth 15, guaranteeing a padding row (merkle_path.rs:47-52 omits the +1); 8-26 column layout + the soundness note on shared witness columns; 114-134 the 19 degrees; 262-339 evaluate_merkle_update_transition; 669-701 test_winterfell_rejects_wrong_new_root)
- `D:\Protocol-01\stark\src\air\merkle_path.rs` — C3, the Merkle half of C7. 15 levels x 32 rows = 480 active + 32 padding. (34-45 TRACE_WIDTH=6, HASH_CYCLE_LEN=32, NUM_ROUNDS=30, CANONICAL_DEPTH=15, TRACE_LENGTH=512, 11 constraints, 7 periodic; 47-52 trace_length_for_depth WITHOUT the +1; 144-152 only two assertions (carry@row0=leaf, col0@row478=root); 228-284 evaluate_merkle_path_transition)
- `D:\Protocol-01\stark\src\air\denominated_pool.rs` — C1, the commitment half. 3 Poseidon cycles whose output must become a PRIVATE witness in C7. (37-41 TRACE_WIDTH=3, TRACE_LENGTH=128, HASH_CYCLE_LEN=32, NUM_HASH_CYCLES=3; 43-53 4 constraints / 6 periodic and the chain-constraint doc; 343-353 compute_pool_values = poseidon(nullifier, poseidon(epoch, mint)) - C7 must reuse this exact formula so legacy notes stay provable; 451-483 test_wrong_nullifier_fails_prove)
- `D:\Protocol-01\stark\src\compact.rs` — The production prover. Public inputs are NEVER serialized into proof bytes - they only feed the transcript and the boundary fold, which is why hiding the commitment costs nothing in wire format. (1218-1297 boundary_assertions_for_circuit (pi() closure at 1224 silently returns ZERO out of range); 1299-1337 fold_boundary_quotient; 1574-1599 expected_wire_size; 3375-3381 CIRCUIT_* ids 0..6; 3513/3520 FRI_FINAL_POLY_SIZE=16; 3561-3580 derive_rlc_alpha_with_tag; 3865-3905 QuotientSpec + boundary_spec_for_quotient; 3915-4019 generate_compact_proof_from_trace; 4046-4137 the serializer (pub_bytes appears nowhere); 992-1086 compute_quotient_lde_circuit_5 (clone this for C7 - handles mixed-period columns); 756-780 the 7 C3 under-constraints DEEP-ALI closed; 2458/2499 emit_circuit_N_periodic_coeffs; 3058 merkle_path_proof_satisfies_deep_ali_end_to_end)
- `D:\Protocol-01\programs\p01_stark_verifier\src\verify.rs` — On-chain verifier. Contains the generator tables that forbid a 1024-row C7, and the C5 periodic recipe that C7 must copy. (53-67 GENERATOR_{32,128,256,512,2048,4096,8192} - NO 1024, NO 16384; 70-78 get_lde_generator `_ => Felt::ONE` SILENT fallback; 82-90 get_trace_generator same; 119-387 get_boundary_assertions (zero-fills missing public inputs); 394-460 verify_generic 5 steps; 443-452 step-4 dispatch (add 7); 1248-1254 eval_periodic_at_z dense ~512 muls; 1283-1303 eval_periodic_stride16_at_z typed &[u64;512], 36 muls; 1315-1345 batch_inverse; 1362-1369 eval_one_hot_lagrange 3 muls; 1377-1452 boundary_fold_at_ood ([Felt;32] cap); 2292-2371 verify_deep_ali_circuit_3 (2305-2308 arity + depth guard); 2737-2845 compute_c5_periodic_at_z = THE recipe; 2877-2883 the #[inline(never)] SBF 4KB frame workaround; 3189-3265 verify_constraints_merkle_path (3220 active_rows fix); 4567-4599 transfer_deep_ali_rejects_non_conserving_proof = the negative-test pattern for C7)
- `D:\Protocol-01\programs\p01_stark_verifier\src\compact_proof.rs` — Per-circuit config table. C6's entry is the exact envelope C7 must fit. (28-47 CircuitConfig; 91-100 CONFIG_MERKLE_PATH (tw6/512/8192/md13/22q/ffps16) with the P2.2g note explaining the 27->22 query drop for the 1.4M CU cap; 157-166 CONFIG_MERKLE_UPDATE (tw10/512/8192/md13/22q/ffps16) - the C7 target shape; 143-156 its doc comment claiming ffps=256 is STALE (the literal is 16); 168-179 get_circuit_config, `_ => None` today; 486-489 from_bytes rejects an ffps mismatch = the cheapest C6/C7 discriminator)
- `D:\Protocol-01\programs\p01_stark_verifier\src\lib.rs` — Anchor surface. Two edits here are easy to miss and both silently break C7. (36 declare_id DGY37k3J...; 38-44 CIRCUIT_* consts (no 7); 51-56 init_proof_buffer requires get_circuit_config().is_some() so circuit 7 is rejected today; 101-107 doc: C1 public inputs = [nullifier, commitment] (epoch is a PRIVATE witness - confirms Part A is safe); 204-209 sha256 of the flat u64-LE public-input buffer; 259-262 matches!(circuit_id, 1|2|3|4|5|6) phase-2 GATE - must gain 7; 290-298 phase-2 dispatch - must gain 7; 384-449 verify_uniform; 406-413 PROBE_ORDER [1,6,3,5] + a stale comment claiming C3/C5 share config bytes; 536-556 ProofBuffer, PROOF_DATA_OFFSET=83)
- `D:\Protocol-01\programs\zk_shielded\src\instructions\unshield_denominated_stark_v3.rs` — The instruction v4 replaces. Copy and delete; do not rewrite. (12-29 ProofBuffer offsets (8/40/49/50/82, MIN_LEN 83); 15-20 hardcoded verifier id; 78-83 args incl. min_epoch and stark_commitment; 101-111 pool + is_valid_root constraint; 123-134 nullifier PDA seeds [b"nullifier", pool, nullifier]; 218-247 C1 checks + sha256(nullifier||commitment); 234 the nullifier[8..]==[0;24] canonicalization; 259-297 C3 checks + sha256(commitment||root||depth), 286 depth==15; 300-304 the comment admitting C1<->C3 are tied ONLY by the public commitment; 322-371 SOL and SPL transfer paths; 387 `let _ = (..., min_epoch, ...)` proving min_epoch is dead)
- `D:\Protocol-01\programs\zk_shielded\src\instructions\transfer_denominated_stark_v3.rs` — Proof that min_epoch IS enforced on transfer, unlike unshield. This is the blinding landmine. (167-173 effective_min_epoch = min_epoch + dynamic_delay; require!(current_epoch >= effective_min_epoch, EpochDelayNotMet))
- `D:\Protocol-01\apps\web\lib\privacy\pool\denominatedPool.ts` — All pool math + both instruction builders. Offset 72 and offset 80 are the two leaks. (393-415 createCommitmentV3; 873-915 depositEpochOverride hook (Part A already half-plumbed); 1394-1443 buildUnshieldDenominatedStarkV3Ix - 1418 writes min_epoch at offset 72, 1419 writes stark_commitment at offset 80, total 120 bytes; 1459-1465 PrepareUnshieldResult (delete starkCommitment to make the compiler find every leak); 1539-1556 the back-to-back C1 and C3 proof calls; 1653 `const minEpoch = emergency ? 0n : receipt.depositEpoch` - VERIFIED, publishes the epoch/blinding in the clear; 1889 + 2081 the transfer path still on real epochs)
- `D:\Protocol-01\apps\web\lib\privacy\pool\stark.ts` — Proof-buffer upload pipeline. Contains the single highest-value one-line fix in the plan. (35-41 circuit id constants (no 7); 41 MAX_CHUNK_SIZE=1000; 92-100 getProofBufferPDA seeds on the circuit-id byte; 466-554 submitAndVerifyStarkProof; 544 `if (proof.circuitId >= 1 && proof.circuitId <= 6)` - VERIFIED, a C7 proof silently skips DEEP-ALI and burns ~1 SOL of rent per attempt)
- `D:\Protocol-01\apps\web\lib\privacy\pool\starkProver.worker.ts` — Hand-written wasm-bindgen glue (NOT generated). Byte-identical to the extension twin apart from one import line. (19 imports STARK_WASM_BASE64; 25-67 WorkerInMessage union; 91-115 StarkExports interface; 124-171 the hand-rolled string marshalling; 188-216 initWasm (one import: __wbindgen_init_externref_table); 310-337 generateMerklePathProof = the CSV passStringToWasm pattern C7 needs; 465-493 dispatch switch)
- `D:\Protocol-01\apps\web\lib\privacy\pool\starkProver.ts` — Worker RPC facade. Its timeout will reject a valid C7 proof. (149-154 hard-coded 60_000 ms per proof request; 183-196 generatePoolCommitmentProof; 283-300 generateMerklePathProof)
- `D:\Protocol-01\apps\web\lib\privacy\worker\poolHandlers.ts` — Worker wire protocol. Where `recipient` must move from execute to prepare for C7's recipient binding to be real. (87-98 PoolUnshieldPrepareRequest (NO recipient today); 100-107 PoolUnshieldExecuteRequest.recipient; 382-402 the PQ-encrypted note blob (390 writes the blinding under the deposit_epoch key); 425-443 handlePoolUnshieldPrepare; 460-483 extractStoredPath reads only commitment + merklePath, which is why the JSON key must not be renamed)
- `D:\Protocol-01\apps\web\lib\privacy\pool\noteBlinding.ts` — Part A, already written but UNTRACKED. HKDF-SHA256 PRF blinding masked to 63 bits. (46-53 MASK_63 rationale (Goldilocks p = 2^64-2^32+1, stay under 2^63 for injectivity); 59-79 deriveNoteBlinding(walletSeed, poolPDA, leafIndex) with info 'p01:web:note-blinding:v1')
- `D:\Protocol-01\apps\web\lib\privacy\pool\poolNotes.ts` — Storage-free recovery. The legacy fallback here is what keeps the unspent leaf-30 note visible. (48 DEFAULT_EPOCH_WINDOW=6000; 95-98 candidate leaf indices from on-chain events; 110-115 blinded single-hash match; 118-128 legacy epoch enumeration fallback - DO NOT REMOVE; 139-148 the RPC-pruning caveat blinding does NOT fix)
- `D:\Protocol-01\programs\p01_stark_verifier\Cargo.toml` — Shows p01-stark is already a dev-dependency (native prove->verify works) and that NO CU-measurement harness exists - no litesvm, no solana-program-test. ([dev-dependencies] p01-stark = { path = "../../stark" }; solana-sha256-hasher 2.3.0 with the sha2 feature and the note that sol_sha256 is ~85 CU/call)
- `D:\Protocol-01\Anchor.toml` — LIVE DEPLOY FOOTGUN. Both devnet entries are stale/dead. (2-3 anchor 0.32.1 / solana 3.1.9; 22 p01_stark_verifier = EXmAQqm... (dead); 41 zk_shielded = 2w4WRvuj... (CLOSED program); 37/55 [programs.localnet] holds the ids that are actually live on devnet)

---

## Verified independently before committing this plan

- `verify.rs:70-78` and `:82-90` — **confirmed**. `get_lde_generator` and
  `get_trace_generator` both fall through to `Felt::ONE` for any unlisted domain
  size, with only a `// Should never happen` comment. No error, no assertion.
- **Not exploitable today**: `CircuitConfig` is the program's own constant, not
  read from the proof. Proof fields are validated *against* it
  (`compact_proof.rs:488`: `if fri_final_poly_size != config.fri_final_poly_size
  { return None; }`), so an attacker cannot inject an unlisted `lde_size`.
- **It is a live trap for this project.** Adding a circuit whose domain size is
  not in those two match arms produces a verifier that silently uses a
  degenerate domain instead of failing. A concatenated-trace C7 (576 rows →
  trace 1024, LDE 16384) would have hit exactly that. Before any new circuit
  ships, those `_ =>` arms should return an error rather than `Felt::ONE`.

## Status

- **Phase 1 — commitment blinding: SHIPPED and proven on devnet** (commit
  `fc6591ee`). The published nullifier no longer reveals the commitment.
  Blinded shield `5WSMqCcC…` (leaf 32) → recovered by seed-only scan →
  withdrawn `5eyKN3Lh…` with `min_epoch` published as 0. Legacy notes still
  withdraw (`nFLayV9h…`, leaf 30).
- **Phase 2 — C7 + `unshield_denominated_stark_v4`: SHIPPED, DEPLOYED, AND
  PROVEN ON DEVNET** (2026-08-25). The verifier and the pool were redeployed and
  checked by dump; a C7 proof was accepted (`4yKg4gGm…`, slot 487960436, phase 2
  192,462 CU); and a real withdrawal landed on one proof (`22psv1tF…`, 130,637
  CU, 0.995 SOL out of leaf 35). The v4 instruction is 147 bytes and carries no
  commitment argument at all. Frozen as evidence at `verify/fixtures/v4-live`.
- ⛔ **AND NO CLIENT ROUTES TO IT YET.** Every shipping withdrawal on web,
  extension and mobile still calls `unshieldDenominatedStarkV3`, which publishes
  the commitment. C7 is reachable from the service layer and from the live
  harness, not from any screen. Pinned at
  `apps/web/lib/privacy/pool/spendRouting.test.ts`, which is designed to fail
  the day that changes.
- Phase 1 alone does NOT deliver unlinkability, and neither does Phase 2 while
  the clients route around it. Beyond routing, two edges remain open on the
  spend that did land: the deposit was funded straight from the wallet, and the
  fee payer was the upgrade authority — an address printed in `README.md`. Do
  not describe the pool as unlinkable.
