# Uniform masking on all eight circuits — 2026-09-11

Branch `zk/uniform-masking-2026-09-11`. Devnet only. Nothing here is deployed:
the verifier `DGY37k3J…` and the shipped wasm blob still carry the 2026-09-06
geometry, and every proof shape changed below is a hard wire break with it.

Every number in this file comes from a command run on 2026-09-11/12 on this
machine (32 cores, rustc 1.98.1, release builds), and the test that produced it
is named. Where a number is not yet measured it is marked **pending**, not
estimated.

## 1. What changed, in one table

Before this day four circuits carried the three-part mask and four did not.
`docs/zk-simulation-argument.md` §5 said so: "Not claimed for C0, C2 or C4.
They have no blinding region at all. Not claimed for C5." Now every circuit
carries the same structure, and the same instruments measure it.

| circuit | role | before | after | free rows vs `R = 4q+2` | randomizer rows vs channel B |
|---|---|---|---|---|---|
| C0 subscriber_ownership | pause/resume, quantum wallet | w3, n32, 27q, legacy pipeline, **no mask**, secret recovered by Lagrange | w5 (3 + lift + rnd), n512, 22q, ffps 32, generic pipeline | 480 vs 90 | 512 vs ~250 |
| C1 pool_commitment | v3 spend, part 1 | masked 2026-08-31 | unchanged | 416 vs 110 | 512 vs 328 |
| C2 balance_proof | zkspl | w4, n128, **no mask**, `owner_mint` one inversion away | w6 (4 + lift + rnd), n512, 27q, ffps 16 | 384 vs 110 | 512 vs 328 |
| C3 merkle_path | v3 spend, part 2 | masked 2026-08-31 | unchanged | 128 vs 90 | 512 vs 268 |
| C4 confidential_balance | zkspl | w4, n256, **no mask**, the leak `docs/AUDIT-2026-09-03.md` measured | w6 (4 + lift + rnd), n512, 22q, ffps 32 | 288 vs 90 | 512 vs ~250 |
| C5 transfer | disabled on chain | row mask only, channel B `200 pub / 0 rnd SHORT` | w9 (7 + lift + rnd), n1024, 22q | 576 vs 90 | 1024 vs 290 (measured) |
| C6 merkle_update | shield | masked 2026-08-31 | unchanged | 160 vs 90 | 512 vs 268 |
| C7 spend | v4 withdraw, subscribe | masked 2026-08-31 | unchanged | 160 vs 90 | 512 vs 247 |

The channel-B figures for C1/C3/C6/C7 are read from
`full_wire_ledger::the_split_that_decides_per_channel` on 2026-09-11; the ones
for the new shapes are printed by the same test in `prover_full_all8.log`
(measured 2026-09-13, §4: C0m 247, C2 328, C4 247, C5 290 published on channel B against 512 / 512 / 512 / 1024 randomizer coefficients).

The structure is the one C7 defined and C1/C3/C6 copied, applied without
variation:

- a **row mask**: every constrained column is fresh CSPRNG output from
  `FIRST_FREE_ROW` to the end of the trace; every transition constraint that
  could reach those rows is gated off by `not_boundary_active` (Poseidon rows)
  or `active` (carry continuities), with the gate bound at `FIRST_FREE_ROW - 1`
  because a transition at row `i` reads row `i + 1`;
- a **lift column**, the last constrained column, read by exactly one
  constraint `one_hot(x) * nba(x) * v(x) * state0(x)^6` whose gate vanishes on
  the whole trace domain (the one-hot sits on a cycle-boundary row where
  `nba = 0`), so the column is free everywhere and degree 7 with two period-n
  factors, which keeps `quotient_segments = 8` and the FRI rate unchanged;
- a **randomizer column**, uniform on every row, read by no constraint, which
  is what covers the DEEP composition and the FRI layers;
- the draw is `draw_blinding_mask` (rejection sampling from the OS CSPRNG) on
  every wasm entry, and every entry refuses to build a proof without one.

## 2. Why these geometries and not others

- **n ≥ 512 everywhere.** `full_wire_ledger` measured the FRI/DEEP channel at
  328 published functionals for a 27-query proof and 268 for a 22-query one
  (247 with ffps 32). A 256-row randomizer column is short of all three, which
  is the state C1 was in on 2026-08-30 and the reason it doubled. C2 (128 rows
  of witness) and C4 (224) therefore both move to 512.
- **The parser tuple `(trace_width, merkle_depth, k, num_queries,
  num_fri_layers, fri_final_poly_size)` must stay distinct.**
  `cross_circuit_confusion` sweeps every ordered pair with genuine proofs,
  under exact length and under the 145,000-byte padded envelope. C2 and C4
  share width 6 and length 512; with the same terminal size their only
  wire-visible difference would have been `num_queries`, and
  `surplus_query_splices_do_not_parse_as_another_circuit` **measured** that a
  C4 proof spliced with five surplus queries then parsed as C2. C4 therefore
  takes C7's terminal shape (ffps 32, degree bound 2), which changes
  `num_fri_layers`, a field a re-count cannot forge. The masked C0 takes the
  same shape for the same reason against C1 (shared width 5 and length 512).
- **Query counts.** C0 and C4 move to 22 queries, the count C3/C5/C6/C7 ship
  at. Soundness is floor-bound by the 64-bit field on every circuit
  (`b2_bits_measured.rs`), so the query term is not what binds; 22 buys CU
  headroom, which matters for C0 because its phase 1 and phase 2 run in one
  instruction.
- **What `trace_width` alone separates.** Five config pairs are now told apart
  by a field that never travels on the wire: C3/C6 (as before), C1/C2,
  C4/C7, C0/C4, C0/C7. `no_two_configs_share_the_tuple_the_parser_can_observe`
  pins the count at 5 and names them. The invariant that carries
  `verify_uniform`'s correctness is narrower and is pinned separately by
  `probe_order_members_are_separated_by_a_wire_field`: only the members of
  `PROBE_ORDER` (1, 6, 3, 5, 7) are ever probed, and among them the one
  width-only pair is still C6/C3. None of C0, C2, C4 is probed.

## 3. C0: what moved and what did not

The legacy 32-row circuit 0 is retired from the shipping path and kept
compiled as the **positive control**: `air_aware_recovery_c0::the_legacy_c0_hands_over_the_secret`
recovers the exact secret `0x1DEAD0D0CAFE5678` from its published bytes (100
distinct openings against 32 unknowns), and
`the_mask_closes_every_constrained_column_of_c0` shows the masked shape
under-determined on all four constrained columns (86 openings + 1 AIR equality
against 512 unknowns). Same solver, same abscissa construction.

The masked C0 runs on the generic pipeline (`QuotientSpec::Circuit0`,
`rlc-c0` / `bnd-c0`) and `verify_stark_proof` runs **phase 1 and phase 2 in
the same instruction** for circuit 0, setting both `verified` and
`deep_ali_verified`. The public input is the same single commitment, hashed the
same way, so `pause_private_stark`, `resume_private_stark` and
`p01_quantum_wallet` are untouched and **no pool-program redeploy is needed
for C0**. The wasm entry `generate_stark_proof(secret)` keeps its JSON shape.
The CU of the single-instruction path is **989,644** (`cu_budget_real_circuits`,
litesvm, `cargo-build-sbf 3.1.9` / platform-tools v1.52, `.so` sha256
`ce2bba7e…`, `cu_budget_all8.log`), 410,356 under the 1,400,000 cap. The legacy
shape's phase 1 alone was 633,531.

## 4. Measured on 2026-09-11/12

| what | result | test |
|---|---|---|
| C2 AIR + compact + lock-step pin | 11 passed | `air::balance_proof`, `balance_proof_satisfies_deep_ali_end_to_end`, `circuit_2_periodic_coeffs_match_verifier_constants` |
| C4 AIR + compact | 15 passed | `air::confidential_balance`, `confidential_balance_proof_satisfies_deep_ali_end_to_end` |
| C5 AIR + compact + pin | 13 passed | `air::transfer`, `transfer_proof_satisfies_deep_ali_end_to_end`, `circuit_5_periodic_coeffs_match_verifier_constants` |
| C0 masked AIR + pin | 8 passed | `air::subscriber_ownership`, `circuit_0_masked_periodic_coeffs_match_verifier_constants` |
| verifier twins C2/C4/C5 (lib) | 18 passed | `cargo test -p p01_stark_verifier --release --lib -- confidential_balance balance_proof transfer` |
| verifier twin C0 masked (lib) | 1 passed | `masked_c0_verifies_generically_and_the_legacy_shape_no_longer_parses` |
| uniformity, 6 circuits (C1 C2 C3 C4 C6 C7) | 4 passed, 48.0 s | `the_lift_column_reaches_every_free_claim_on_every_circuit`, `the_free_claims_are_jointly_uniform_on_every_circuit`, `quotient_leaves_are_exactly_uniform_on_every_circuit`, `the_lde_domain_never_meets_the_trace_domain_on_any_circuit` |
| uniformity, 8 circuits | 4 passed, in a 191-test `--lib` run of 127.3 s, 0 failed | same four tests, `prover_full_all8.log` |
| recovery harnesses C0 C2 C4 | 3 + 3 + 3 passed | `air_aware_recovery_c{0,2,4}` |
| cross-circuit confusion, 8×8, exact + padded | 22 passed | `cross_circuit_confusion` |
| wire parity, 8 generic circuits | 6 passed | `wire_parity` |
| wire sizes (bytes) | C0m 74,365 · C1 94,897 · C2 95,777 · C3 79,597 · C4 75,085 · C5 91,261 · C6 82,477 · C7 79,405 | `recorded_proof_sizes_hold`, `cross_language_fixture_digests` |
| honest liveness, 160 witnesses × 9 arms | see `suite_rest.log` line in §4b | `honest_liveness` |
| CU phase 1 / phase 2, all circuits | table below | `cu_budget_real_circuits`, `cu_budget_all8.log` |
| CU pins (`CuCeiling`, prose, CI names) | 28 passed after re-pin | `cu_budget` |
| deep-binding soundness pins | 28 passed after re-derivation | `b1_deep_binding` |
| B1→B2 bits subtraction, masked C0 forgery arm | 7 passed after re-pin | `b2_bits_measured` |
| wasm entries compile (`--features wasm`) | `Finished`, exit 0 | `wasm_check.log` |
| X5: unopened trace values uniform GIVEN every published value, all 8 circuits | 0 of 8,084 unopened positions inside the span (16,276 on C5), published functionals rank 110/110, constrained AND lift/randomizer runs | `unopened_leaves_stay_uniform_given_every_opening_on_every_circuit`, 32.4 s, 2026-09-12 |
| OOD resampling rule, prover side (bad set rejected, chain steps past, shipped proof carries it) | 3 passed | `compact::ood_resampling_tests` |
| OOD resampling rule, prover == verifier on all 8 geometries | 2 passed | `ood_resampling_parity` |
| six re-pinned verifier suites, 2026-09-13 (after the masks + resampling) | `b2_segment_binding` 8/8 · `b4_pair_leaf` 9/9 · `periodic_stride` 7/7 · `route_c_trace_pair` 22/22 · `liveness_generator_semantics` 3/3 (1,275 s) · `honest_liveness` 1/1 (160 witnesses × 9 arms, masked C0 included, 1,340 s) | `day3_suites_round2.log` |
| byte and bit pins after the resampling | `wire_parity` 6/6 · `cross_circuit_confusion` 22/22 · `b1_deep_binding` 28/28 | same log |
| channel B (randomizer vs FRI/DEEP functionals), all 8, MEASURED | C0m 247 pub / 512 rnd · C1 328/512 · C2 328/512 · C3 268/512 · C4 247/512 · C5 290/1024 · C6 268/512 · C7 247/512, all OK; channel A C0m 720/1920 · C2 990/1920 · C4 810/1440 · C5 1080/4608 | `full_wire_ledger::the_split_that_decides_per_channel`, 5/5 |

### 4a. Compute units, litesvm, 2026-09-12

`cargo test -p p01_stark_verifier --release --test cu_budget cu_budget_real_circuits -- --nocapture`,
SBF built by `solana-cargo-build-sbf 3.1.9` (platform-tools v1.52), artifact
sha256 `ce2bba7e34c2bb7e5014de46f8d83adc1861a781fd9a81dc148fec13eedf1e6c`.
Phase 1 is `verify_stark_proof` / `verify_stark_proof_phase1_generic`
(parse, Merkle, FRI); phase 2 is the DEEP-ALI instruction. Cap is 1,400,000
per instruction.

| circuit | proof B | phase 1 CU | phase 2 CU | phase 1 + 2 | one instruction? | before the mask (ph1 / ph2) |
|---|---|---|---|---|---|---|
| C0 subscriber_ownership | 74,365 | 992,562 (both phases) | in phase 1 | 992,562 | yes, today | 633,531 / — (phase 1 only, no DEEP-ALI) |
| C1 pool_commitment | 94,897 | 1,041,028 | 391,252 | 1,432,280 | no | unchanged |
| C2 balance_proof | 95,777 | 1,048,005 | 312,179 | 1,360,184 | fits | 815,771 / 112,043 |
| C3 merkle_path | 79,597 | 878,738 | 169,036 | 1,047,774 | fits | unchanged |
| C4 confidential_balance | 75,085 | 856,703 | 365,696 | 1,222,399 | fits | 921,430 / 207,606 |
| C5 transfer | 91,261 | 981,739 | 437,960 | 1,419,699 | no | 968,025 / 439,663 |
| C6 merkle_update | 82,477 | 902,314 | 175,616 | 1,077,930 | fits | unchanged |
| C7 spend | 79,405 | 890,572 | 193,042 | 1,083,614 | fits | unchanged |

Re-measured 2026-09-13 with the `[PERFECT-IOP]` out-of-domain resampling in
phase 1 (`cu_budget_319_resampled.log`, same compiler): +2,630 to +2,994 CU on
every phase 1 (two exponentiations per candidate), phase 2 unchanged. The
2026-09-12 rows before it: C0 989,644 · C1 1,038,398 · C2 1,045,369 · C3 875,925
· C4 853,785 · C5 978,745 · C6 899,486 · C7 887,641.

"Fits" means the sum is under one instruction's cap and a single-transaction
L3 (`phase1 + phase2` in one tx) is available to that circuit without any
verifier change; it is not yet what the clients do.

### 4b. Soundness after the masks (`b1_deep_binding`, `b2_bits_measured`)

Derived from `CircuitConfig` + `GRINDING_BITS` (22) by two independent
derivations that are asserted equal; C0..C6:

| | C0 | C1 | C2 | C3 | C4 | C5 | C6 |
|---|---|---|---|---|---|---|---|
| conjectured (list-decoding, floor-bound) | 47 | 47 | 47 | 47 | 47 | 46 | 47 |
| unconditional (unique-decoding) | 42 | 46 | 46 | 42 | 42 | 42 | 42 |
| before the masks | 52 / 46 | 47 / 46 | 50 / 46 | 47 / 42 | 48 / 46 | 46 / 42 | 47 / 42 |

C0 lost five conjectured bits and four unconditional (n 32 → 512, 27 → 22
queries), C2 three conjectured, C4 one conjectured and four unconditional. The
conjectured column is bound by the 64-bit base field on every circuit, so the
figures are the same 47.x floor everywhere; the unconditional column follows
the query count (22 → 42, 27 → 46). This is the price of a hidden trace and it
is recorded, not absorbed; the one change that moves it is the extension field.

### 4c. Prove / host-verify timings, 2026-09-12, WITH the OOD resampling

`cargo test -p p01_stark_verifier --release --test bench_all_circuits -- --include-ignored --nocapture`,
this machine, release build, N = 5 per circuit, a fresh OS-CSPRNG mask per
sample, verify = `verify_generic` + the circuit's phase 2 on the host (the same
code the program runs; not a CU figure). Every sample went through the
`[PERFECT-IOP]` resampled derivation of `z` on both sides, so this run is also
the first end-to-end execution of that change on all eight circuits; the
cross-crate parity test (`ood_resampling_parity`, 2 tests) passed in the same run.

| circuit | prove ms min / median / max | verify ms min / median / max | bytes |
|---|---|---|---|
| C0 subscriber_ownership (masked) | 239 / 342 / 475 | 0.2 / 0.3 / 0.5 | 74,365 |
| C1 pool_commitment | 421 / 654 / 900 | 0.3 / 0.3 / 0.3 | 94,897 |
| C2 balance_proof | 292 / 621 / 2,063 | 0.3 / 0.3 / 0.3 | 95,777 |
| C3 merkle_path | 310 / 377 / 452 | 0.2 / 0.2 / 0.2 | 79,597 |
| C4 confidential_balance | 320 / 430 / 992 | 0.2 / 0.2 / 0.6 | 75,085 |
| C5 transfer | 2,130 / 2,275 / 2,459 | 0.3 / 0.3 / 0.3 | 91,261 |
| C6 merkle_update | 416 / 537 / 734 | 0.2 / 0.2 / 0.2 | 82,477 |
| C7 spend | 456 / 538 / 575 | 0.2 / 0.2 / 0.2 | 79,405 |

Native Rust, not the wasm blob: the shipped blob was 2-4x slower on
2026-09-02 (`docs/BENCHMARK-2026-09-02.md` §2). Proving is therefore well
under a second of the < 60 s budget for shield (C6), unshield (C1 + C3, or C7)
and subscription (C7); the budget is spent on chain round trips, which is
what `[L2-CLIENT]` attacks and what has **not** been timed live yet.

## 5. What this does and does not claim

Every sentence `docs/zk-simulation-argument.md` attaches to C1/C3/C6/C7 now
has the same instrument pointed at C0, C2, C4 and C5: degree 1 in one mask
element at every committed quotient position, rank `k-1` of `k-1` on the free
OOD claims, a disjoint LDE coset, a channel ledger with a positive margin on
both channels, and a recovery harness with a positive control. The simulator
run (S1) and the shipping-query-count accounting (§3.2 there) were executed on
C7 only and remain so; extending them is the next measurement, not a claim.

The two qualifiers stay attached wherever the argument is cited:
**statistical**, and **in the random-oracle model**. The repository's standing
rule also stays: the word itself is not used in public material until the
founder lifts it, and nothing here is a statement about what a transaction
reveals on chain (payer, accounts, timing), which is a separate ledger
(`docs/LEAK-LEDGER.md`).

## 6. Not done, and in what order

1. ~~Read the pending logs, re-pin `CuCeiling` for C0/C2/C4/C5, record CU here.~~ Done 2026-09-12 (§4a, §4b).
1b. **2026-09-12**: the `[PERFECT-IOP]` out-of-domain resampling (prover + verifier +
   parity test) and the X5 conditional-uniformity test RAN GREEN (§4, three new rows).
   Written and type-checked, NOT yet run (see `HANDOFF-2026-09-12.md` §2): the round-2 re-pins of
   `b2_segment_binding`, `b4_pair_leaf`, `periodic_stride`, `route_c_trace_pair`,
   `liveness_generator_semantics`, `honest_liveness`. After they run, re-measure CU
   (phase 1 moves by two exponentiations) and update §4a.
1c. Channel-B counts for the new shapes (`full_wire_ledger -- --nocapture`): still pending.
   Prove / verify timings: done, §4c. Live shield / unshield / subscription wall clock
   against the < 60 s target: NOT measured yet (needs devnet + a funded throwaway key).
2. DONE 2026-09-12: blob rebuilt (265,324 B, `0ad6d7f1…`), prove times for all eight measured in Node, every proof verified by this verifier on the host and through the staged .so on litesvm (`wasm_blob_parity` 8/8), then SHIPPED after the redeploy (HANDOFF-2026-09-13 §6).
3. DONE 2026-09-12: verifier redeployed on the founder's go-ahead (slot 497235406, `3gt9vfoQ…`), blob shipped, TS twins re-pinned; all eight circuits accepted live on devnet (BENCHMARK-2026-09-13 §6).
4. Extend S1 and the 22-query affine accounting to the new shapes.
5. Retire the legacy C0 code once every probe that drives it has a masked twin.
