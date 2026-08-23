//! C7 — "spend" STARK AIR (unlinkable denominated withdrawal)
//!
//! Merges C1 (`denominated_pool`, the commitment derivation) and C3
//! (`merkle_path`, the membership proof) into ONE width-10 / 512-row trace so
//! that the note commitment never has to leave the circuit as a public input.
//!
//! This module is **purely additive**. It copies constraint bodies out of
//! `merkle_path.rs`, `denominated_pool.rs` and `transfer.rs`; it must never
//! edit them. Circuits 0-6 are frozen: the deployed verifier
//! `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs` is byte-reproducible from
//! `836bc9cb` and the RLC uses `alpha^i` over the constraint order.
//!
//! ```text
//! width 10, length 512, blowup 16 -> LDE 8192, merkle_depth 13, 22 queries, ffps 32
//!
//! col 0-2  Merkle Poseidon state      16 cycles (15 real levels + 1 dummy)
//! col 3    sibling
//! col 4    direction bit
//! col 5    carry              (row 0 = leaf = the commitment)
//! col 6-8  Commitment Poseidon state  16 cycles (3 real + 13 dummy)
//! col 9    commit_hold        globally constant column
//!
//! cycle 0  rows  0- 31  nullifier  = P(nullifier_preimage, secret)  out col6@row30
//! cycle 1  rows 32- 63  blind_hash = P(blinding, token_mint)        out col6@row62
//! cycle 2  rows 64- 95  commitment = P(nullifier, blind_hash)       out col6@row94
//! cycles 3-15           dummy Poseidons, P(0, 0), nothing reads them
//!
//! merkle levels 0-11    rows 0-383, subtree root at col0@row382
//! rows 384-511          BLINDING REGION, no constraint of any kind
//! merkle cycle 15       rows 480-511, dummy P(root, 0), dir = 0, sib = 0
//! ```
//!
//! # Why all 16 cycles are genuine on BOTH pipelines
//!
//! This is the CU optimisation, and it has to be in the trace from the first
//! line rather than retrofitted. If either pipeline stops hashing at cycle 3
//! (commitment) or cycle 15 (Merkle), the shared periodic columns stop being
//! 32-periodic, their interpolants stop being stride-16 sparse, and the
//! on-chain verifier has to evaluate each of them with a dense 512-coefficient
//! Horner (a MEASURED 100,982 CU and 4,096 B of rodata *each*) instead of
//! `eval_periodic_stride16_at_z` (36 muls). C6 (`merkle_update.rs:206-259`)
//! bounds its periodic loops by `active_rows = depth * 32` and pays that price
//! on all seven of its columns; C7 must not copy that idiom.
//!
//! Consequences that the on-chain side MUST honour (see the handoff note):
//!   * 🚨 REVERSED BY DEPTH 12. This used to read "there are no padding rows,
//!     every row 0..511 is an active Poseidon round". That is now FALSE and a
//!     reader who follows it builds the wrong verifier. The truth: rows
//!     `0..=382` are transition-active; rows `384..511` are the blinding
//!     region and take NO CHECK OF ANY KIND — not a Poseidon round, not an
//!     identity check. No single `active_rows` number expresses that, so the
//!     verifier must gate on `FIRST_FREE_ROW`, and C3's
//!     `active_rows = 15 * hash_cycle_len` guard at `verify.rs:3220` is still
//!     wrong for C7, now for the opposite reason.
//!   * `is_boundary` is set at row 511 as well (unlike `transfer.rs:331`).
//!     That transition is the wrap row: winterfell exempts it
//!     (`num_transition_exemptions == 1`) and the compact prover multiplies by
//!     `(x - g^{n-1})` before dividing by the vanishing polynomial, so nothing
//!     reads the value. Including it is what keeps the column 32-periodic.
//!   * the per-query step-4 check cannot be cloned from C3 (`for col in
//!     3..trace_width { next == current }` would freeze the live commitment
//!     pipeline at cols 6-8) nor from C6 (`for col in 6..` would demand cols
//!     3-5 round-advance). It has to be written from this layout.
//!
//! # The hold column
//!
//! Transition constraints are local (row i -> row i+1), so row 94 cannot be
//! related to row 0 directly. Col 9 is forced constant on every transition,
//! pinned at row 94 to the commitment output and equated at row 0 to the
//! Merkle carry. That binds `leaf == commitment` with NO boundary assertion
//! and NO public input carrying the commitment:
//!
//! ```text
//! [15] (next[9] - current[9]) = 0                       every transition row
//! [16] commit_out_flag(row 94) * (current[9] - current[6])
//! [17] row0_flag(row 0)       * (current[5] - current[9])
//! ```
//!
//! # 🚨 PRIVACY: the hold column is published in the proof bytes
//!
//! Constraint [15] makes col 9 a DEGREE-0 polynomial. Its LDE evaluation is
//! the commitment at all 8192 positions, trace-aligned or not, and
//! `compact.rs:4046-4137` serialises `ood_current[col]`, `ood_next[col]` and
//! `lde[col][pos] / lde[col][next_pos]` for EVERY column of EVERY query with
//! no filter. In a C7 proof the commitment therefore appears verbatim as an
//! 8-byte LE u64 roughly 46 times, in a blob that is uploaded as public
//! instruction data. See `docs/C7_SPEND_CIRCUIT_PLAN.md:440-454`, and the
//! `hold_column_is_constant_which_publishes_the_commitment` test below, which
//! pins the property so it cannot be quietly forgotten.
//!
//! Taking the commitment out of the instruction puts it into the proof.
//!
//! ## ✅ TAKEN 2026-08-23 — the mitigation above is now implemented
//!
//! Constraint [15] was gated. The gate is built from periodics already in
//! scope plus a one-hot link appended at index 10 (`hold_link_31`); an earlier
//! attempt used a dense step column named `hold_active`, which no longer
//! exists — it cost a measured 100,982 CU and 4,096 B of rodata for a property
//! three muls buy. That changes
//! [15]'s BODY but not its INDEX, and appends to the periodic vector rather
//! than inserting into it, so the frozen order of 0-9 is untouched. It was
//! done before Step 4 baked any coefficient, which was the deadline.
//!
//! `build_spend_trace` now fills rows 95..511 of col 9 with a Poseidon chain
//! seeded from `secret`. NOT from `blinding`, which is the historical
//! `deposit_epoch` slot and is brute-forceable on pre-blinding notes. Gating
//! the constraint only PERMITS a non-constant
//! column; the trace has to actually be non-constant or nothing changes.
//!
//! ## ✅ 2026-08-23, SECOND PASS — DEPTH 12 CLOSES IT
//!
//! The gate alone was NOT enough, and measuring that is what produced the fix.
//! A gated col 9 is still piecewise constant over a PUBLIC segment structure,
//! so at depth 15 there were 14 unknowns against roughly 90 published
//! evaluations, and the commitment came straight back out of a 14 by 14 solve.
//! Removing it from the instruction had only moved it into the proof.
//!
//! What closes it is a counting change, not an encoding change. The circuit now
//! proves **twelve** Merkle levels instead of fifteen, which frees cycles 12-15,
//! which is 128 rows on ALL TEN columns. Every transition constraint is gated
//! off there by the `active` periodic column, so the prover writes independent
//! uniform field elements into them, redrawn per proof.
//!
//!   unknowns per column   = witness segments + 128 mask values
//!   published evaluations = 4 * 22 + 2 = 90 on the deployed wire
//!
//! 128 > 90, so the system is underdetermined.
//! `measured_the_public_system_is_now_underdetermined` does not assert that in
//! prose: it builds the attacker's best system, computes its rank, extracts a
//! null-space vector, and checks the vector MOVES the commitment coordinate.
//! For every published evaluation vector there is a whole line of commitments
//! consistent with it.
//!
//! **The three levels do not disappear, they move on chain.** Public input 1 is
//! a depth-12 subtree root and the spending instruction owes the remaining
//! walk, roughly 45K CU for three `poseidon_round` loops against
//! ⛔ NOT against `filled_subtrees` — that was the first design and it is
//! WRONG. `filled_subtrees` is an INSERTION FRONTIER: it holds one value per
//! level on the CURRENT insertion path, so it cannot supply the siblings of an
//! arbitrary historical leaf. A spender of leaf 100 at 9,000 leaves needs
//! `node(12, 1)`, completed at leaf 8,191 and overwritten since; it exists in
//! no on-chain field. It is also unattested: `verify_c6_proof_buffer` hashes
//! exactly 40 bytes, `[old_leaf, new_leaf, old_root, new_root, depth]`, and
//! `new_subtrees` is not among them, so any depositor can write arbitrary
//! bytes into it.
//!
//! ✅ The correct and cheaper design: the CALLER supplies the three top
//! siblings and three orientation bits as untrusted instruction data, the
//! program folds public input 1 up three levels, and binds the result with
//! `is_valid_root` — the same discipline v3 already applies to `merkle_root`.
//! `filled_subtrees` is never read.
//!
//! The pool's tree stays depth 15: no new PDA and no `tree_depth` migration.
//! ⚠️ The anonymity set is not RESET, but it is now PARTITIONED — see the
//! top-bit note below.
//! ⛔ `the_on_chain_top_levels_are_an_obligation_not_an_option` exists because
//! shipping without that leg makes C7 a fund-loss circuit.
//!
//! **Why the degree budget survived.** The `active` gate is folded INTO the
//! outer periodic factor of the degree-7 Poseidon constraints
//! (`not_boundary_active`, index 12) rather than added as a third factor. A
//! third factor makes `ce_blowup_factor` 16 instead of 8, which changes
//! `num_constraint_composition_columns` and the whole proof structure. Folded,
//! the max evaluation degree is 4584 — exactly C5's shipped number.
//!
//! ## ⚠️ THE PRICE OF DEPTH 12, QUANTIFIED, AND THE TRAP INSIDE IT
//!
//! Moving three levels on chain makes the subtree index public, so a spend
//! names one of 8 buckets of 4,096 leaves. The cost is NOT a flat 3 bits: it is
//! `log2(ceil(N / 4096))`, capped at 3.
//!
//! ```text
//!   N = 34..4096   1 bucket    0.000 bits    <- today, at ~47 leaves
//!   N = 4097       2 buckets   0.001 bits
//!   N = 10000      3 buckets   1.441 bits
//!   N = 16384      4 buckets   2.000 bits
//!   N = 32768      8 buckets   3.000 bits
//! ```
//!
//! 🚨 **THE AGGREGATE IS THE WRONG NUMBER AND IT LIES IN THE FAMILIAR
//! DIRECTION.** At N = 4,097 the newest bucket holds exactly ONE leaf, so that
//! depositor's anonymity set is **1** — fully deanonymized — while the
//! aggregate reports 0.001 bits because the other 4,096 people are fine. This
//! is the shape of the P11 false green from 2026-08-18: when an aggregate
//! contradicts an individual absence, the aggregate is what lies. There are 7
//! such boundaries over a full tree (leaves 4097, 8193, ... 28673), and the
//! exposed party is always the newest depositor, who is also the one most
//! likely to spend soon. `spend_bucket_trajectory_and_the_frontier_hazard`
//! pins this so it is not rediscovered.
//!
//! ⛔ No instruction-side trick buys any of it back. Checking against all 8
//! roots, hiding the index, hiding the siblings, or a Merkle-set proof over the
//! 8 roots all buy exactly zero, because the identifier is in the public inputs
//! and the tree is public: `LeafInserted` publishes `leaf_index` and `leaf` on
//! every insert, so any observer rebuilds the tree offline and reads the bucket
//! off the root by equality.
//!
//! Depth 13 would leak one bit less and was considered and rejected: it frees
//! 96 rows against R = 90, a margin of 6 against depth 12's 38, and one extra
//! published opening would break it. ⚠️ The decision is not urgent on anonymity
//! grounds — both leak nothing below 4,096 leaves — but it IS urgent on freeze
//! grounds, because `CANONICAL_DEPTH` sets `FIRST_FREE_ROW`, `MASK_ROWS`,
//! `ROW_MERKLE_ROOT_OUT` and the boundary spec, and a deployed C7 verifier pins
//! that shape byte for byte. Decide before the verifier deploy, not before leaf
//! 4,096.
//!
//! ## 🚨 THE COSET IS WHY THE COUNTING ARGUMENT IS THE WHOLE STORY
//!
//! Verified on the deployed branch, not inferred. `b7-drop-aligned-checks`
//! carries `LDE_COSET_SHIFT_U64 = 7` (`compact.rs:4779`) and its verifier
//! hardcodes `let is_trace_aligned = false;` at three sites
//! (`verify.rs:4280`, `:4355`, `:4428`) — which is what the branch is NAMED
//! after. The LDE domain is a coset disjoint from the trace domain, so **no
//! query position ever coincides with a trace row** and no opening ever
//! returns a raw witness value.
//!
//! That retires a whole family of worries on the deployed wire. Col 3 is the
//! sibling verbatim and col 4 is a leaf-index bit, and on a NON-coset LDE a
//! trace-aligned query would publish an internal tree node in the clear with
//! probability 1-(15/16)^22 = 76%. On the coset that read does not exist. The
//! same applies to the residual col 9 and col 5 channels an earlier pass of
//! this file measured at ~23% and ~8%: those numbers describe MASTER, whose
//! `compact.rs` has no coset shift and whose verifier still computes
//! `is_trace_aligned = pos % blowup == 0` (`verify.rs:3023`).
//!
//! So on the lineage that ships, every published value is an evaluation at a
//! point outside the trace domain, every one of them is a public linear
//! equation, and the only defence is having more unknowns than equations. That
//! is exactly what depth 12 buys.
//!
//! ⛔ **THEREFORE C7 MUST BE BUILT ON `b7-drop-aligned-checks`, NOT MASTER.**
//! Three independent reasons now agree: b7 publishes four trace rows per query
//! against master's two, its `CircuitConfig` has ten fields against eight, and
//! only b7 has the coset. A C7 built on master emits a proof the deployed
//! verifier cannot parse, and would reintroduce the direct-read channels on top.
//!
//! **What is still open, and it is not this column.** Masking the trace does
//! not touch the quotient decomposition, the DEEP composition polynomial, or
//! the vector commitment, and there is no FRI salt. Those are prover and
//! commitment-layer channels with no simulation argument here, they are
//! Winterfell PR #293's territory, and they change proof serialization.
//! ⛔ Until they are addressed, C7 is **not** perfect zero-knowledge and must
//! not be described as such. What is now true and measured is narrower and
//! worth having: the note commitment is not recoverable from the published
//! evaluations of the trace columns.
//!
//! Public inputs: `[nullifier, root, rh0, rh1, rh2, rh3]` — SIX felts. The
//! recipient hash is the full 256 bits split into four u64s; one felt would be
//! 64-bit binding. `depth` is NOT a public input — it is fixed at 12 by the
//! layout.

use winterfell::{
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
    math::{fields::f64::BaseElement, FieldElement, ToElements},
};

use crate::poseidon;

// ============================================================================
// Constants
// ============================================================================

pub const TRACE_WIDTH: usize = 10;
pub const TRACE_LENGTH: usize = 512;
pub const HASH_CYCLE_LEN: usize = 32;
pub const NUM_ROUNDS: usize = 30;
/// Number of 32-row hash cycles on the 512-row trace. BOTH pipelines run all
/// of them; see the module docs.
pub const NUM_HASH_CYCLES: usize = TRACE_LENGTH / HASH_CYCLE_LEN; // 16

/// Merkle levels proved INSIDE the circuit. Fixed by the layout, NOT a public
/// input.
///
/// 🚨 CHANGED 15 -> 12 ON 2026-08-23, AND THE POOL'S TREE IS STILL DEPTH 15.
/// The circuit proves membership of a leaf under a depth-12 SUBTREE root; the
/// remaining three levels are verified on chain by the spending instruction,
/// three `poseidon_round` loops ESTIMATED at roughly 45K CU (~1,350 field
/// multiplications; NOT measured, and not measurable today because
/// `zk_shielded` has no Goldilocks Poseidon at all), against
/// caller-supplied siblings bound by `is_valid_root`. ⛔ NOT `filled_subtrees`:
/// it is an insertion frontier and cannot supply an arbitrary leaf's siblings.
/// No new pool and no `tree_depth` change. ⚠️ The anonymity set is not reset,
/// but it is partitioned 8-way; see the top-bit note below.
///
/// ⛔ THE CIRCUIT IS NOT SOUND ON ITS OWN UNTIL THAT ON-CHAIN LEG EXISTS. A
/// depth-12 subtree root proves membership of a subtree, not of the pool. See
/// `the_on_chain_top_levels_are_an_obligation_not_an_option` below, which
/// exists so this cannot be forgotten between here and Step 7.
///
/// Why 12: it frees cycles 12-15, which is 128 rows on all ten columns,
/// against the R = 4*22+2 = 90 openings per column the deployed wire
/// publishes. 13 would free 96, 14 would free 64, and neither clears 90 with
/// margin. This is the only change that reaches zero-knowledge inside the C6
/// envelope.
pub const CANONICAL_DEPTH: usize = 12;

/// First cycle whose rows carry no witness and exist only to be blinded.
pub const FIRST_FREE_CYCLE: usize = CANONICAL_DEPTH; // 12

/// First trace row that is free on every column.
pub const FIRST_FREE_ROW: usize = FIRST_FREE_CYCLE * HASH_CYCLE_LEN; // 384

/// Blinding positions this layout offers per column, against R = 4*22+2 = 90.
pub const MASK_ROWS: usize = TRACE_LENGTH - FIRST_FREE_ROW; // 128

/// Number of transition constraints. Indices 0..=17.
///   [0]-[10]  Merkle pipeline   (verbatim from `merkle_path.rs:260-283`)
///   [11]-[13] Commitment Poseidon (from `denominated_pool.rs:241-243`, +6 cols)
///   [14]      Commitment chain edge (`denominated_pool.rs:247`, +6 cols)
///   [15]-[17] Hold column
pub const SPEND_NUM_CONSTRAINTS: usize = 18;

/// Number of periodic columns. Order is FROZEN — Step 4's emitter and Step 6's
/// `compute_c7_periodic_at_z` index it positionally.
///   0-6  stride-16 eligible, emitted at NATURAL LENGTH 32
///   7-9  one-hot, emitted at length 512
///   10   hold_link_31, one-hot @ row 31 — APPENDED 2026-08-23
///   11   active, dense step, 1 on rows 0..=382 — APPENDED 2026-08-23
///   12   not_boundary_active, dense, `active AND not_boundary` — APPENDED 2026-08-23
///
/// Index 10 was appended, never inserted, so indices 0-9 keep the order the
/// module docs froze. It is the third term of the gate on constraint [15],
/// which stops the hold column being a degree-0 polynomial; see the privacy
/// note in the module docs for what that buys and what it does not.
///
/// 🚨 It is ONE-HOT on purpose. The first version of this gate used a length-512
/// STEP column (1 on rows 0..=93), which is neither stride-16 nor one-hot and
/// therefore goes through the verifier's dense path. That was measured at
/// **100,982 CU** and 4,096 bytes of rodata, against roughly 6 KB of verifier
/// rodata headroom left. The construction below buys the identical privacy
/// property out of periodics that are already in scope, for 3 muls and zero
/// rodata. Do not reintroduce a dense column here.
pub const SPEND_NUM_PERIODIC: usize = 13;

/// Rows `0..=HOLD_CONSTANT_LAST` of col 9 all carry the commitment.
///
/// [16] pins row 94 and [17] reads row 0, so every row between them must be
/// equal. The gate below achieves that with cycle-local constancy plus two
/// one-hot links across the cycle 0-1 and 1-2 boundaries, which pins rows
/// `0..=95` — one row more than strictly needed, and free.
pub const HOLD_CONSTANT_LAST: usize = 3 * HASH_CYCLE_LEN - 1; // 95

pub const SPEND_NUM_PUBLIC_INPUTS: usize = 6;
pub const SPEND_NUM_BOUNDARY_ASSERTIONS: usize = 6;

/// Row on which the nullifier appears at col 6 (cycle 0 output).
pub const ROW_NULLIFIER_OUT: usize = NUM_ROUNDS; // 30
/// Row on which `blind_hash` appears at col 6 (cycle 1 output).
pub const ROW_BLIND_HASH_OUT: usize = HASH_CYCLE_LEN + NUM_ROUNDS; // 62
/// Row on which the chain edge fires: `next[7]@64 == current[6]@63`.
pub const ROW_CHAIN: usize = 2 * HASH_CYCLE_LEN - 1; // 63
/// Row on which cycle 2 starts (its left input is the public nullifier).
pub const ROW_COMMIT_IN: usize = 2 * HASH_CYCLE_LEN; // 64
/// Row on which the commitment appears at col 6 (cycle 2 output).
pub const ROW_COMMITMENT_OUT: usize = 2 * HASH_CYCLE_LEN + NUM_ROUNDS; // 94
/// Row on which the depth-12 SUBTREE root appears at col 0 (level 11 output).
/// ⛔ NOT the pool root. See the on-chain obligation below.
pub const ROW_MERKLE_ROOT_OUT: usize = (CANONICAL_DEPTH - 1) * HASH_CYCLE_LEN + NUM_ROUNDS; // 382

/// 🚨 STALE SINCE DEPTH 12. This used to say the Merkle pipeline runs genuine
/// Poseidon rounds on ALL rows. Cycles 12-15 are now the blinding region and
/// run nothing at all.
/// ⛔ DO NOT USE FOR THE VERIFIER'S ROW GUARD. Kept only so existing
/// call sites compile. The real contract cannot be expressed as one number:
/// transition-active rows are `0..=382`, and rows `384..511` take NO CHECK OF
/// ANY KIND — not a Poseidon round, not an identity check. Use
/// `FIRST_FREE_ROW` and `MASK_ROWS`.
pub const SPEND_MERKLE_ACTIVE_ROWS: usize = TRACE_LENGTH;
/// 🚨 Same for the COMMITMENT pipeline (cols 6-8): all 512 rows are active.
pub const SPEND_COMMIT_ACTIVE_ROWS: usize = TRACE_LENGTH;
/// Merkle cycles whose output anybody reads (levels 0..14). Cycle 15 is dummy.
pub const SPEND_MERKLE_MEANINGFUL_CYCLES: usize = CANONICAL_DEPTH; // 12
/// Commitment cycles whose output anybody reads. Cycles 3..15 are dummy.
pub const SPEND_COMMIT_MEANINGFUL_CYCLES: usize = 3;

/// The six boundary assertions, in the ONE order that is load-bearing.
///
/// `(column, row, source)` where `source == Some(i)` means `public_inputs[i]`
/// and `source == None` means `BaseElement::ZERO`.
///
/// This order is the exponent order of `alpha_bnd^j` in
/// `fold_boundary_quotient` and must be mirrored byte-identically into
/// `compact.rs::boundary_assertions_for_circuit` arm 7 and
/// `verify.rs::get_boundary_assertions` arm 7. Reading it from this one table
/// instead of hand-typing it three times is what keeps the `pi(i)` zero-fill
/// at `compact.rs:1224` from silently binding a trace cell to zero.
///
/// NONE of these carries the commitment or the leaf — see
/// `boundary_spec_carries_neither_commitment_nor_leaf`.
pub const SPEND_BOUNDARY_SPEC: [(usize, usize, Option<usize>); SPEND_NUM_BOUNDARY_ASSERTIONS] = [
    (6, ROW_NULLIFIER_OUT, Some(0)),   // nullifier output, public input 0
    (6, ROW_COMMIT_IN, Some(0)),       // cycle-2 LEFT input == the same nullifier
    (8, 0, None),                      // capacity, cycle 0
    (8, HASH_CYCLE_LEN, None),         // capacity, cycle 1
    (8, 2 * HASH_CYCLE_LEN, None),     // capacity, cycle 2
    (0, ROW_MERKLE_ROOT_OUT, Some(1)), // Merkle root, public input 1
];

// ============================================================================
// Public inputs
// ============================================================================

/// `[nullifier, root, rh0, rh1, rh2, rh3]`.
///
/// `recipient_hash` is `sha256(recipient_pubkey)` split into four LE u64s. It
/// occupies no trace column and no constraint: the binding is
/// Fiat-Shamir-transcript-only, exactly as C3's `depth` is.
#[derive(Clone, Debug)]
pub struct SpendPublicInputs {
    pub nullifier: BaseElement,
    pub root: BaseElement,
    pub recipient_hash: [BaseElement; 4],
}

impl SpendPublicInputs {
    /// Flatten in the frozen order. `pub_bytes` for Step 4 is this vector,
    /// each element as 8 LE bytes: 48 bytes total.
    pub fn to_vec(&self) -> Vec<BaseElement> {
        vec![
            self.nullifier,
            self.root,
            self.recipient_hash[0],
            self.recipient_hash[1],
            self.recipient_hash[2],
            self.recipient_hash[3],
        ]
    }
}

impl ToElements<BaseElement> for SpendPublicInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        self.to_vec()
    }
}

// ============================================================================
// AIR definition
// ============================================================================

pub struct SpendAir {
    context: AirContext<BaseElement>,
    public_inputs: Vec<BaseElement>,
}

impl Air for SpendAir {
    type BaseField = BaseElement;
    type PublicInputs = SpendPublicInputs;
    type GkrProof = ();
    type GkrVerifier = ();

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        assert_eq!(
            trace_info.length(),
            TRACE_LENGTH,
            "C7 trace length is fixed at {TRACE_LENGTH}"
        );
        assert_eq!(
            trace_info.main_trace_width(),
            TRACE_WIDTH,
            "C7 trace width is fixed at {TRACE_WIDTH}"
        );

        let degrees = spend_constraint_degrees();
        assert_eq!(degrees.len(), SPEND_NUM_CONSTRAINTS);

        let public_inputs = pub_inputs.to_vec();
        assert_eq!(
            public_inputs.len(),
            SPEND_NUM_PUBLIC_INPUTS,
            "C7 takes exactly {SPEND_NUM_PUBLIC_INPUTS} public inputs"
        );

        let context = AirContext::new(
            trace_info,
            degrees,
            SPEND_NUM_BOUNDARY_ASSERTIONS,
            options,
        );

        Self { context, public_inputs }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    fn get_periodic_column_values(&self) -> Vec<Vec<BaseElement>> {
        build_spend_periodic_columns()
    }

    fn evaluate_transition<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        evaluate_spend_transition(frame.current(), frame.next(), periodic_values, result);
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        spend_boundary_assertions(&self.public_inputs)
    }
}

/// The 18 constraint degrees, in the frozen constraint order.
///
/// The declared cycle lengths must match the ACTUAL periodic column lengths
/// emitted by `build_spend_periodic_columns`: 32 for the seven shared columns,
/// 512 for the three one-hot flags. This is *tighter* than C5's
/// `vec![HASH_CYCLE_LEN, TRACE_LENGTH]`. C7 now measures 4584 too, because the
/// `active` gate is folded into the outer factor of the degree-7 constraints
/// because C7's `is_boundary` is 32-periodic too.
///
/// Nothing here may multiply a `pow7` term by another trace column: base
/// degree 8 would push `ce_blowup_factor` from 8 to 16 and change the proof's
/// degree structure under every downstream assumption.
pub fn spend_constraint_degrees() -> Vec<TransitionConstraintDegree> {
    vec![
        // ── Merkle pipeline, cols 0-5 ──
        // [0-2] Poseidon round: gated by round_flag(32) and is_boundary(32)
        TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, HASH_CYCLE_LEN]), // 0
        TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, HASH_CYCLE_LEN]), // 1
        TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, HASH_CYCLE_LEN]), // 2
        TransitionConstraintDegree::with_cycles(2, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),   // 3 mux s0
        TransitionConstraintDegree::with_cycles(2, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),   // 4 mux s1
        TransitionConstraintDegree::with_cycles(1, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),   // 5 capacity
        TransitionConstraintDegree::with_cycles(1, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),   // 6 carry update
        TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),                   // 7 carry cont.
        TransitionConstraintDegree::with_cycles(1, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),   // 8 sib cont.
        TransitionConstraintDegree::with_cycles(1, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),   // 9 dir cont.
        TransitionConstraintDegree::with_cycles(2, vec![HASH_CYCLE_LEN, TRACE_LENGTH]),   // 10 dir binary
        // ── Commitment pipeline, cols 6-8 ──
        TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, HASH_CYCLE_LEN]), // 11
        TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, HASH_CYCLE_LEN]), // 12
        TransitionConstraintDegree::with_cycles(7, vec![TRACE_LENGTH, HASH_CYCLE_LEN]), // 13
        TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),                   // 14 chain
        // ── Hold column, col 9 ──
        // [15] is gated as of 2026-08-23 by (not_boundary + hold_link_31 +
        // chain_flag), whose combined period is 512. Ungated it was the only
        // degree-0 column in the crate, and a degree-0 column publishes its
        // value in every OOD opening and every query.
        TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH, TRACE_LENGTH]),     // 15
        TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),                   // 16
        TransitionConstraintDegree::with_cycles(1, vec![TRACE_LENGTH]),                   // 17
    ]
}

/// Build the six boundary assertions from `SPEND_BOUNDARY_SPEC`.
///
/// Panics on an arity slip rather than zero-filling — `compact.rs:1224`'s
/// `pi()` closure and `verify.rs`'s `if public_inputs.len() > n` ladders both
/// fail OPEN, which silently binds a trace cell to zero.
pub fn spend_boundary_assertions(public_inputs: &[BaseElement]) -> Vec<Assertion<BaseElement>> {
    assert_eq!(
        public_inputs.len(),
        SPEND_NUM_PUBLIC_INPUTS,
        "C7 boundary assertions need exactly {SPEND_NUM_PUBLIC_INPUTS} public inputs"
    );
    SPEND_BOUNDARY_SPEC
        .iter()
        .map(|&(col, row, source)| {
            let value = match source {
                Some(i) => public_inputs[i],
                None => BaseElement::ZERO,
            };
            Assertion::single(col, row, value)
        })
        .collect()
}

// ============================================================================
// Helper
// ============================================================================

#[inline(always)]
fn pow7<E: FieldElement>(x: E) -> E {
    let x2 = x * x;
    let x4 = x2 * x2;
    x4 * x2 * x
}

// ============================================================================
// Periodic columns
// ============================================================================

/// Build the 13 periodic columns for circuit 7.
///
/// Layout — FROZEN, indexed positionally by Step 4's emitter and Step 6's
/// `compute_c7_periodic_at_z`:
///
/// ```text
///  0 rc0             len  32   stride-16
///  1 rc1             len  32   stride-16
///  2 rc2             len  32   stride-16
///  3 round_flag      len  32   stride-16   1 on pos < 30
///  4 is_boundary     len  32   stride-16   1 on pos == 31 (INCLUDING row 511)
///  5 hash_start      len  32   stride-16   1 on pos == 0
///  6 is_interior     len  32   stride-16   1 on pos in 1..=30
///  7 chain_flag      len 512   one-hot @ row 63
///  8 commit_out_flag len 512   one-hot @ row 94
///  9 row0_flag       len 512   one-hot @ row 0
/// ```
///
/// THE API CONTRACT IS THE VECTOR LENGTH. Columns 0-6 are returned at their
/// natural period 32 so that 32-periodicity cannot be broken by editing one
/// row; winterfell and `compute_quotient_lde_circuit_*`'s `materialise`
/// closure (`compact.rs:1018-1030`) tile them back onto 512. A length-32
/// emission and a hand-tiled length-512 emission are byte-identical
/// downstream, so the length-32 form is free safety.
///
/// Takes NO arguments: depth is fixed at 12 and passing it invites the
/// degrade shape that `boundary_assertions_for_circuit` arms 3 and 6 have.
pub fn build_spend_periodic_columns() -> Vec<Vec<BaseElement>> {
    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;

    // ── period 32, shared by BOTH pipelines ──
    let mut rc0 = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    let mut rc1 = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    let mut rc2 = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    let mut round_flag = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    for pos in 0..NUM_ROUNDS {
        rc0[pos] = rc[pos * 3];
        rc1[pos] = rc[pos * 3 + 1];
        rc2[pos] = rc[pos * 3 + 2];
        round_flag[pos] = BaseElement::ONE;
    }

    // is_boundary at pos 31 => rows 31, 63, ..., 511. Row 511 IS included:
    // that transition is exempt (winterfell) and killed by the `(x - g^{n-1})`
    // factor (compact prover), and including it is what keeps this column
    // 32-periodic. `transfer.rs:331` skips it and pays ~48-101K CU for it.
    let mut is_boundary = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    is_boundary[HASH_CYCLE_LEN - 1] = BaseElement::ONE;

    let mut hash_start = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    hash_start[0] = BaseElement::ONE;

    let mut is_interior = vec![BaseElement::ZERO; HASH_CYCLE_LEN];
    for pos in 1..=NUM_ROUNDS {
        is_interior[pos] = BaseElement::ONE;
    }

    // ── period 512, one-hot ──
    let make_flag = |row: usize| -> Vec<BaseElement> {
        let mut f = vec![BaseElement::ZERO; TRACE_LENGTH];
        f[row] = BaseElement::ONE;
        f
    };

    let chain_flag = make_flag(ROW_CHAIN); // 63
    let commit_out_flag = make_flag(ROW_COMMITMENT_OUT); // 94
    let row0_flag = make_flag(0);

    // The third term of the [15] gate: one-hot at row 31, the cycle 0-1
    // boundary. Row 63, the cycle 1-2 boundary, reuses `chain_flag` rather
    // than costing a twelfth column.
    let hold_link_31 = make_flag(HASH_CYCLE_LEN - 1); // 31

    // ── period 512, dense ──
    // `active` is 1 exactly on the rows that carry witness. Cycles 12-15 are
    // the blinding region and every constraint is switched off there, so the
    // prover may write independent uniform field elements into all ten columns.
    // `not_boundary_active` is the same thing pre-multiplied with
    // `not_boundary`, and it is a SEPARATE column rather than a product in the
    // constraint body on purpose: the degree-7 Poseidon constraints may carry
    // exactly TWO periodic factors. A third pushes `ce_blowup_factor` from 8 to
    // 16, which changes `num_constraint_composition_columns` and therefore the
    // proof's whole degree structure.
    //
    // 🚨 THE BOUND IS `FIRST_FREE_ROW - 1`, NOT `FIRST_FREE_ROW`. These are
    // TRANSITION constraints: the one evaluated at row i reads row i+1. Left on
    // at row 383 the carry-update constraint [6] would demand
    // `mask[384] == state[383]`, which no honest prover can satisfy and which
    // showed up as "constraint 6 at row 383" the first time this was built.
    let mut active = vec![BaseElement::ZERO; TRACE_LENGTH];
    let mut not_boundary_active = vec![BaseElement::ZERO; TRACE_LENGTH];
    for row in 0..(FIRST_FREE_ROW - 1) {
        active[row] = BaseElement::ONE;
        if row % HASH_CYCLE_LEN != HASH_CYCLE_LEN - 1 {
            not_boundary_active[row] = BaseElement::ONE;
        }
    }

    vec![
        rc0,             // 0
        rc1,             // 1
        rc2,             // 2
        round_flag,      // 3
        is_boundary,     // 4
        hash_start,      // 5
        is_interior,     // 6
        chain_flag,      // 7
        commit_out_flag, // 8
        row0_flag,       // 9
        hold_link_31,    // 10
        active,          // 11
        not_boundary_active, // 12
    ]
}

// ============================================================================
// Transition constraints
// ============================================================================

/// Evaluate the 18 transition constraints for circuit 7.
///
/// Any change here MUST be mirrored in `compute_quotient_lde_circuit_7`
/// (`stark/src/compact.rs`) and `evaluate_transition_at_ood_circuit_7`
/// (`programs/p01_stark_verifier/src/verify.rs`). Constraint ORDER is
/// load-bearing (the RLC uses `alpha^i`): append at index 18, never insert.
///
/// `periodic[0..13]`:
///   `[rc0, rc1, rc2, round_flag, is_boundary, hash_start, is_interior,
///     chain_flag, commit_out_flag, row0_flag]`
///
/// `result[0..18]`:
///   `[m_pos_s0, m_pos_s1, m_pos_s2, m_mux_s0, m_mux_s1, m_capacity,
///     m_carry_update, m_carry_cont, m_sib_cont, m_dir_cont, m_dir_binary,
///     c_pos_s0, c_pos_s1, c_pos_s2, c_chain,
///     hold_const, hold_pin_commit, hold_pin_leaf]`
pub fn evaluate_spend_transition<E: FieldElement>(
    current: &[E],
    next: &[E],
    periodic: &[E],
    result: &mut [E],
) {
    debug_assert_eq!(current.len(), TRACE_WIDTH);
    debug_assert_eq!(next.len(), TRACE_WIDTH);
    debug_assert_eq!(periodic.len(), SPEND_NUM_PERIODIC);
    debug_assert_eq!(result.len(), SPEND_NUM_CONSTRAINTS);

    let rc0 = periodic[0];
    let rc1 = periodic[1];
    let rc2 = periodic[2];
    let round_flag = periodic[3];
    let is_boundary = periodic[4];
    let hash_start = periodic[5];
    let is_interior = periodic[6];
    let chain_flag = periodic[7];
    let commit_out_flag = periodic[8];
    let row0_flag = periodic[9];
    let hold_link_31 = periodic[10];
    let active = periodic[11];
    let nba = periodic[12];

    let three = E::from(3u32);
    let not_boundary = E::ONE - is_boundary;

    // ────────────────────────────────────────────────────────────────────
    // [0]-[10] Merkle pipeline (cols 0-5).
    // Copied VERBATIM from `merkle_path.rs:247-283`. C7's cols 0-5 are the
    // same columns C3 uses, so there is zero re-indexing. Do NOT copy from
    // `merkle_update.rs`, whose cols are 6 = sibling, 7 = direction,
    // 8/9 = carries.
    // ────────────────────────────────────────────────────────────────────
    let s0 = current[0] + rc0;
    let s1 = current[1] + rc1;
    let s2 = current[2] + rc2;
    let s0_7 = pow7(s0);
    let s1_7 = pow7(s1);
    let s2_7 = pow7(s2);
    let ro0 = three * s0_7 + s1_7 + s2_7;
    let ro1 = s0_7 + three * s1_7 + s2_7;
    let ro2 = s0_7 + s1_7 + three * s2_7;

    result[0] = nba * (next[0] - current[0] - round_flag * (ro0 - current[0]));
    result[1] = nba * (next[1] - current[1] - round_flag * (ro1 - current[1]));
    result[2] = nba * (next[2] - current[2] - round_flag * (ro2 - current[2]));

    // Hash start: state = mux(direction, carry, sibling)
    let dir = current[4];
    let sib = current[3];
    let carry = current[5];
    let hash_start_a = hash_start * active;
    result[3] = hash_start_a * (current[0] - carry - dir * (sib - carry));
    result[4] = hash_start_a * (current[1] - sib - dir * (carry - sib));
    result[5] = hash_start_a * current[2];

    // Carry update at boundary / carry continuity off-boundary
    result[6] = is_boundary * active * (next[5] - current[0]);
    result[7] = nba * (next[5] - current[5]);

    // Sibling/direction continuity within a cycle
    let is_interior_a = is_interior * active;
    result[8] = is_interior_a * (next[3] - current[3]);
    result[9] = is_interior_a * (next[4] - current[4]);

    // Direction binary
    result[10] = hash_start_a * dir * (E::ONE - dir);

    // ────────────────────────────────────────────────────────────────────
    // [11]-[14] Commitment pipeline (cols 6-8).
    // `denominated_pool.rs:226-247` with a uniform +6 column shift.
    // ────────────────────────────────────────────────────────────────────
    let t0 = current[6] + rc0;
    let t1 = current[7] + rc1;
    let t2 = current[8] + rc2;
    let t0_7 = pow7(t0);
    let t1_7 = pow7(t1);
    let t2_7 = pow7(t2);
    let co0 = three * t0_7 + t1_7 + t2_7;
    let co1 = t0_7 + three * t1_7 + t2_7;
    let co2 = t0_7 + t1_7 + three * t2_7;

    result[11] = nba * (next[6] - current[6] - round_flag * (co0 - current[6]));
    result[12] = nba * (next[7] - current[7] - round_flag * (co1 - current[7]));
    result[13] = nba * (next[8] - current[8] - round_flag * (co2 - current[8]));

    // Chain: blind_hash (col 6 @ row 63) -> cycle 2's RIGHT input (col 7 @ 64).
    // Without this, blind_hash is a free prover choice and the commitment at
    // row 94 is whatever the prover wants — [16]/[17] would then bind a value
    // the prover controls end to end.
    result[14] = chain_flag * (next[7] - current[6]);

    // ────────────────────────────────────────────────────────────────────
    // [15]-[17] Hold column (col 9). See the module-level privacy note.
    //
    // [15] is GATED as of 2026-08-23. Ungated it forced col 9 constant on all
    // 512 rows, making it a degree-0 polynomial whose value is the commitment
    // at every LDE position — published verbatim in ood_current[9],
    // ood_next[9] and every query.
    //
    // The gate is built from periodics already in scope. `not_boundary` is 0
    // exactly at pos 31 of each cycle, so on its own it makes col 9 constant
    // WITHIN a cycle and free to jump between cycles. The two one-hot links
    // then stitch cycles 0, 1 and 2 back together:
    //
    //   not_boundary   1 everywhere except rows 31, 63, 95, 127, ...
    //   hold_link_31   1 at row 31 only
    //   chain_flag     1 at row 63 only   (reused from [14])
    //
    // The three are mutually exclusive, so the sum is 0 or 1 and never 2. Net
    // effect: rows 0..=95 are forced equal, which covers [16] at row 94 and
    // [17] at row 0, and cycles 3-15 are free.
    // ────────────────────────────────────────────────────────────────────
    result[15] = active * (not_boundary + hold_link_31 + chain_flag) * (next[9] - current[9]);
    result[16] = commit_out_flag * (current[9] - current[6]);
    result[17] = row0_flag * (current[5] - current[9]);
}

// ============================================================================
// Witness values
// ============================================================================

/// Compute `(nullifier, blind_hash, commitment)` without building the trace.
///
/// DELEGATES to `denominated_pool::compute_pool_values` rather than
/// re-deriving the Poseidon chain. Any independent re-implementation is a
/// divergence risk that surfaces months later as an unspendable legacy note.
/// The client twin is `createCommitmentV3`
/// (`apps/web/lib/privacy/pool/denominatedPool.ts:808-822`).
///
/// 🔒 LEGACY CONTRACT: the `blinding` slot accepts ANY field element. It is
/// the historical `deposit_epoch` position — for notes shielded before
/// commitment blinding it holds a real small epoch (the unspent leaf-30 note
/// of the 0.1 SOL pool is one). Never add a boundary assertion at col 6 or
/// col 7 row 32, a range check, a bit decomposition, or promote it to a public
/// input: all four brick that note with no recovery path.
///
/// NOTE the returned `commitment` is witness/test-only. `build_spend_trace`
/// deliberately does NOT return it, so that `generate_spend_compact_proof`
/// cannot have it in a local variable one keystroke away from `pub_bytes`.
pub fn compute_spend_values(
    nullifier_preimage: BaseElement,
    secret: BaseElement,
    blinding: BaseElement,
    token_mint: BaseElement,
) -> (BaseElement, BaseElement, BaseElement) {
    let (nullifier, commitment) = crate::air::denominated_pool::compute_pool_values(
        nullifier_preimage,
        secret,
        blinding,
        token_mint,
    );
    let blind_hash = poseidon::hash2(blinding, token_mint);
    debug_assert_eq!(
        poseidon::hash2(nullifier, blind_hash),
        commitment,
        "C7 diverged from the C1 commitment formula"
    );
    (nullifier, blind_hash, commitment)
}

/// Compute the Merkle root from a leaf and a path (same as `merkle_path`).
pub fn compute_spend_root(
    leaf: BaseElement,
    path_elements: &[BaseElement],
    path_indices: &[u8],
) -> BaseElement {
    let mut current = leaf;
    for i in 0..path_elements.len() {
        let (left, right) = if path_indices[i] == 0 {
            (current, path_elements[i])
        } else {
            (path_elements[i], current)
        };
        current = poseidon::hash2(left, right);
    }
    current
}

// ============================================================================
// Trace generation
// ============================================================================

/// Build the C7 execution trace.
///
/// Returns `(trace, nullifier, root)` — the two PUBLIC values, and nothing
/// else. The commitment stays inside the trace on purpose.
///
/// `mask` is the blinding material for rows 384..511 of every column, laid out
/// row-major as `MASK_ROWS * TRACE_WIDTH` elements. It is a REQUIRED argument
/// and not an `Option` on purpose: a default would be a witness-derived or
/// zero-filled mask, which is the failure this design exists to prevent, and a
/// caller who has not thought about randomness should not compile.
///
/// ⛔ It MUST be fresh CSPRNG output, redrawn for every proof.
pub fn build_spend_trace(
    nullifier_preimage: BaseElement,
    secret: BaseElement,
    blinding: BaseElement,
    token_mint: BaseElement,
    path_elements: &[BaseElement],
    path_indices: &[u8],
    mask: &[BaseElement],
) -> (Vec<Vec<BaseElement>>, BaseElement, BaseElement) {
    assert_eq!(
        mask.len(),
        MASK_ROWS * TRACE_WIDTH,
        "C7 needs {} blinding elements ({MASK_ROWS} rows x {TRACE_WIDTH} columns)",
        MASK_ROWS * TRACE_WIDTH
    );
    assert_eq!(
        path_elements.len(),
        CANONICAL_DEPTH,
        "C7 depth is fixed at {CANONICAL_DEPTH}"
    );
    assert_eq!(path_indices.len(), CANONICAL_DEPTH);

    let mut trace = vec![vec![BaseElement::ZERO; TRACE_LENGTH]; TRACE_WIDTH];

    let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
    let mds = &poseidon::constants::MDS_MATRIX_T3;

    // One genuine 32-row Poseidon cycle into cols `base..base+2`.
    // Rows start..start+29 are the rounds, start+30 holds the output and
    // start+31 repeats it (the free-transition row). Modelled on
    // `transfer.rs:538-582`, which proves that 16 genuinely-hashed cycles on a
    // 512-row trace prove and verify — C5 ships exactly this shape.
    let run_hash = |trace: &mut Vec<Vec<BaseElement>>,
                    base: usize,
                    cycle: usize,
                    in0: BaseElement,
                    in1: BaseElement|
     -> BaseElement {
        let start = cycle * HASH_CYCLE_LEN;
        let mut state = [in0, in1, BaseElement::ZERO];

        trace[base][start] = state[0];
        trace[base + 1][start] = state[1];
        trace[base + 2][start] = state[2];

        for round in 0..NUM_ROUNDS {
            state[0] = state[0] + rc[round * 3];
            state[1] = state[1] + rc[round * 3 + 1];
            state[2] = state[2] + rc[round * 3 + 2];
            for s in &mut state {
                let x = *s;
                let x2 = x * x;
                let x4 = x2 * x2;
                *s = x4 * x2 * x;
            }
            let mut res = [BaseElement::ZERO; 3];
            for i in 0..3 {
                for j in 0..3 {
                    res[i] = res[i] + mds[i][j] * state[j];
                }
            }
            state = res;

            let row = start + round + 1;
            trace[base][row] = state[0];
            trace[base + 1][row] = state[1];
            trace[base + 2][row] = state[2];
        }

        // Free-transition row (pos 31), copy of the output row.
        let pad = start + NUM_ROUNDS + 1;
        trace[base][pad] = state[0];
        trace[base + 1][pad] = state[1];
        trace[base + 2][pad] = state[2];

        state[0]
    };

    // ── Commitment pipeline, cols 6-8 ──────────────────────────────────
    let nullifier = run_hash(&mut trace, 6, 0, nullifier_preimage, secret);
    let blind_hash = run_hash(&mut trace, 6, 1, blinding, token_mint);
    let commitment = run_hash(&mut trace, 6, 2, nullifier, blind_hash);
    // Cycles 3-11: dummy Poseidons on P(0, 0). Nothing reads them; they exist
    // solely so the shared periodic columns stay 32-periodic. Cycles 12-15 are
    // the blinding region and are written from `mask` below, not hashed.
    for cycle in SPEND_COMMIT_MEANINGFUL_CYCLES..FIRST_FREE_CYCLE {
        let _ = run_hash(&mut trace, 6, cycle, BaseElement::ZERO, BaseElement::ZERO);
    }

    debug_assert_eq!(
        compute_spend_values(nullifier_preimage, secret, blinding, token_mint),
        (nullifier, blind_hash, commitment)
    );

    // ── Merkle pipeline, cols 0-2 + witness cols 3-5 ───────────────────
    // The leaf is the commitment — it is NEVER a public input and NEVER a
    // boundary assertion. Constraint [17] is the only thing binding it.
    let mut carry = commitment;

    let write_witness = |trace: &mut Vec<Vec<BaseElement>>,
                             cycle: usize,
                             sibling: BaseElement,
                             dir_felt: BaseElement,
                             carry: BaseElement| {
        let start = cycle * HASH_CYCLE_LEN;
        for row in start..start + HASH_CYCLE_LEN {
            trace[3][row] = sibling;
            trace[4][row] = dir_felt;
            trace[5][row] = carry;
        }
    };

    for level in 0..CANONICAL_DEPTH {
        let sibling = path_elements[level];
        let dir = path_indices[level];
        assert!(dir <= 1, "C7 direction bits must be 0 or 1");
        let dir_felt = if dir == 0 { BaseElement::ZERO } else { BaseElement::ONE };

        write_witness(&mut trace, level, sibling, dir_felt, carry);

        let (left, right) = if dir == 0 { (carry, sibling) } else { (sibling, carry) };
        carry = run_hash(&mut trace, 0, level, left, right);
    }
    let root = carry;

    // ── Blinding region, rows 384-511, ALL TEN COLUMNS ────────────────
    //
    // 🚨 THIS IS THE ZERO-KNOWLEDGE ARGUMENT AND IT IS THE WHOLE POINT OF
    // DEPTH 12. Every transition constraint is gated off here by `active`, so
    // these 128 rows per column are unconstrained and the prover writes
    // INDEPENDENT UNIFORM field elements into them, redrawn for every proof.
    //
    // The counting: the deployed wire publishes four trace rows per query plus
    // two out-of-domain openings, so R = 4*22 + 2 = 90 evaluations per column.
    // 128 independent uniform values exceed 90, so the published evaluations no
    // longer determine the witness values. `measured_the_public_system_is_now_
    // underdetermined` runs the recovery attack that succeeds at depth 15 and
    // shows it failing here.
    //
    // ⛔ `mask` MUST be fresh CSPRNG output per proof. A chain, a counter or
    // anything derived from the witness collapses these 128 values to one
    // degree of freedom and the attack comes straight back — that is exactly
    // what the first version of this file did with a Poseidon chain.
    for (i, row) in (FIRST_FREE_ROW..TRACE_LENGTH).enumerate() {
        for col in 0..TRACE_WIDTH {
            trace[col][row] = mask[i * TRACE_WIDTH + col];
        }
    }

    // ── Hold column, col 9 ─────────────────────────────────────────────
    //
    // Rows 0..=95 carry the commitment, because [16] pins row 94 to the
    // commitment output and [17] reads row 0 as the Merkle leaf, and [15]
    // forces everything between them equal.
    //
    // Cycles 3-15 are FILLER, and filling them is the point. Left at the
    // commitment the column is a degree-0 polynomial: its value is the
    // commitment at all 8192 LDE positions, so `compact.rs` publishes it in
    // ood_current[9], ood_next[9] and every query's trace values. Filler makes
    // the interpolant a degree-<512 polynomial that equals the commitment only
    // on the 96 trace-aligned positions of rows 0..=95, which removes the OOD
    // leak entirely and leaves a per-query one.
    //
    // ⚠️ THIS IS NOT MASKING AND MUST NOT BE CALLED THAT. The gate leaves
    // NINE free scalars, one per filler cycle 3..=11, because [15] still forces
    // col 9 constant inside each cycle. Statistical zero-knowledge needs on the
    // order of 242 INDEPENDENT UNIFORM elements per column, redrawn every
    // proof. Thirteen values derived from one seed is one degree of freedom
    // against ~46 query equations. It closes the free byte-copy and nothing
    // more.
    //
    // 🚨 SEEDED FROM `secret`, NOT `blinding`. `blinding` is the historical
    // `deposit_epoch` slot and carries a SMALL REAL EPOCH on pre-blinding
    // notes, so it is brute-forceable — a filler derived from it would be
    // recomputable from a candidate commitment, and col 9 would be a
    // distinguisher again for exactly the oldest notes in the pool.
    for row in 0..=HOLD_CONSTANT_LAST {
        trace[9][row] = commitment;
    }
    for cycle in 3..FIRST_FREE_CYCLE {
        let filler = poseidon::hash2(secret, BaseElement::new(cycle as u64));
        for row in (cycle * HASH_CYCLE_LEN)..((cycle + 1) * HASH_CYCLE_LEN) {
            trace[9][row] = filler;
        }
    }

    debug_assert_eq!(trace[6][ROW_NULLIFIER_OUT], nullifier);
    debug_assert_eq!(trace[6][ROW_BLIND_HASH_OUT], blind_hash);
    debug_assert_eq!(trace[6][ROW_COMMITMENT_OUT], commitment);
    debug_assert_eq!(trace[0][ROW_MERKLE_ROOT_OUT], root);

    (trace, nullifier, root)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── fixtures ────────────────────────────────────────────────────────

    const NP: u64 = 111;
    const SECRET: u64 = 222;
    const MINT: u64 = 444;
    /// A LEGACY note: the third slot holds a real small epoch, not a 63-bit
    /// PRF blinding. Everything must stay provable for it.
    const LEGACY_BLINDING: u64 = 42;

    fn test_path() -> (Vec<BaseElement>, Vec<u8>) {
        let mut elems = Vec::new();
        let mut idx = Vec::new();
        for i in 0..CANONICAL_DEPTH {
            elems.push(BaseElement::new(1000 + i as u64));
            idx.push((i % 2) as u8);
        }
        (elems, idx)
    }

    /// Deterministic stand-in for the CSPRNG mask. Determinism is fine here:
    /// what the counting argument needs is 1280 INDEPENDENT unknowns, not
    /// unpredictable ones, and a test that cannot reproduce its own trace
    /// cannot pin anything.
    fn test_mask() -> Vec<BaseElement> {
        (0..MASK_ROWS * TRACE_WIDTH)
            .map(|i| BaseElement::new(1_000_003u64 * (i as u64 + 1) + 7))
            .collect()
    }

    fn honest() -> (Vec<Vec<BaseElement>>, BaseElement, BaseElement, BaseElement) {
        let (elems, idx) = test_path();
        let (trace, nullifier, root) = build_spend_trace(
            BaseElement::new(NP),
            BaseElement::new(SECRET),
            BaseElement::new(LEGACY_BLINDING),
            BaseElement::new(MINT),
            &elems,
            &idx,
            &test_mask(),
        );
        let (_, _, commitment) = compute_spend_values(
            BaseElement::new(NP),
            BaseElement::new(SECRET),
            BaseElement::new(LEGACY_BLINDING),
            BaseElement::new(MINT),
        );
        (trace, nullifier, root, commitment)
    }

    // ========================================================================
    // MEASURED: what an observer recovers from the PUBLISHED evaluations alone
    //
    // These tests exist because an analysis that says "it leaks" is worth
    // exactly what its instrument is worth until it has been run. On
    // 2026-08-18 probe P11 printed PASS on a spend whose buyer was two hops
    // away; the probe had been handed the address and had declined to open it.
    // So: no reasoning here, only arithmetic on the numbers the proof
    // actually publishes.
    //
    // What the serializer publishes, read at stark/src/compact.rs:4046-4120:
    // ood_current[col] and ood_next[col] for EVERY column, then per query
    // lde[col][pos] and lde[col][next_pos] for EVERY column. That blob is
    // uploaded as public instruction data. A column's OOD value is its
    // interpolant evaluated at z, so these tests evaluate exactly that and ask
    // what it gives away.
    // ========================================================================

    /// g_{2^k}, reproduced from `compact.rs:3394-3410` so this test depends on
    /// no private helper. 7 generates the Goldilocks multiplicative group;
    /// g_{2^32} = 7^((p-1)/2^32), then square down to the size wanted.
    fn domain_generator(domain_size: usize) -> BaseElement {
        assert!(domain_size.is_power_of_two());
        let k = domain_size.trailing_zeros();
        let p_minus_1 = 0xFFFF_FFFF_0000_0000_u64;
        let g_2_32 = BaseElement::new(7).exp_vartime((p_minus_1 / (1u64 << 32)).into());
        let mut g = g_2_32;
        for _ in 0..(32 - k) {
            g = g * g;
        }
        g
    }

    /// Evaluate a column's interpolant at `z` without computing coefficients.
    ///
    /// Barycentric form over the multiplicative subgroup H = {g^0..g^(n-1)}:
    ///   L_i(z) = g^i * (z^n - 1) / (n * (z - g^i))
    /// which follows from Z_H(x) = x^n - 1 and its derivative at g^i being
    /// n * g^(-i). This is the same value the prover writes into
    /// `ood_current[col]`.
    fn eval_column_at(values: &[BaseElement], z: BaseElement) -> BaseElement {
        let n = values.len();
        let g = domain_generator(n);
        let n_inv = BaseElement::new(n as u64).inv();
        let z_n_minus_1 = z.exp_vartime((n as u64).into()) - BaseElement::ONE;

        let mut acc = BaseElement::ZERO;
        let mut g_i = BaseElement::ONE;
        for &v in values.iter() {
            // z is chosen outside the domain, so (z - g^i) is never zero.
            acc += v * g_i * (z - g_i).inv();
            g_i *= g;
        }
        acc * z_n_minus_1 * n_inv
    }

    /// One note, Merkle path held fixed, so the only thing varying between
    /// candidates is the commitment itself.
    fn trace_for(secret: u64) -> (Vec<Vec<BaseElement>>, BaseElement) {
        let (elems, idx) = test_path();
        let (trace, _, _) = build_spend_trace(
            BaseElement::new(NP),
            BaseElement::new(secret),
            BaseElement::new(LEGACY_BLINDING),
            BaseElement::new(MINT),
            &elems,
            &idx,
            &test_mask(),
        );
        let (_, _, commitment) = compute_spend_values(
            BaseElement::new(NP),
            BaseElement::new(secret),
            BaseElement::new(LEGACY_BLINDING),
            BaseElement::new(MINT),
        );
        (trace, commitment)
    }

    /// MEASUREMENT 1 — the OOD channel, before and after the 2026-08-23 gate.
    ///
    /// BEFORE: constraint [15] was ungated, col 9 was constant, its interpolant
    /// WAS the constant polynomial, and its value at ANY point equalled the
    /// commitment. An observer read eight bytes at offset 136 of the blob and
    /// was done: no witness, no query, no candidate list, no work at all. This
    /// test asserted that equality, as a pin on a known defect.
    ///
    /// AFTER: [15] is gated by `hold_active`, rows 95..511 carry filler, and
    /// the interpolant is a degree-<512 polynomial that agrees with the
    /// commitment only on the trace-aligned positions of rows 0..=94. The OOD
    /// point `z` is outside the domain by construction, so this channel is
    /// CLOSED. Three unrelated points must all disagree with the commitment
    /// and with each other.
    #[test]
    fn measured_the_published_ood_of_col9_is_no_longer_the_commitment() {
        let (trace, commitment) = trace_for(SECRET);
        let mut seen = Vec::new();
        for z_raw in [0xDEAD_BEEFu64, 0x0123_4567_89AB_CDEF, 3] {
            let z = BaseElement::new(z_raw);
            let ood = eval_column_at(&trace[9], z);
            assert_ne!(
                ood, commitment,
                "ood_current[9] at z={z_raw} must NOT be the commitment"
            );
            seen.push(ood);
        }
        // A degree-0 column would give the same value at every point. These
        // must differ, which is what proves the column is no longer constant.
        assert_ne!(seen[0], seen[1]);
        assert_ne!(seen[1], seen[2]);
    }

    /// The top-bit leak, as arithmetic rather than prose.
    ///
    /// See the module docs. The point of this test is the FRONTIER HAZARD, not
    /// the aggregate: the first depositor into each new bucket stands alone.
    #[test]
    fn spend_bucket_trajectory_and_the_frontier_hazard() {
        const POOL_DEPTH: u32 = 15;
        let bucket_size: usize = 1 << (POOL_DEPTH - CANONICAL_DEPTH as u32); // 8 buckets
        assert_eq!(bucket_size, 8, "depth 12 under a depth-15 tree names 1 of 8");
        let leaves_per_bucket: usize = 1 << CANONICAL_DEPTH; // 4096

        // Today: one bucket occupied, so the index carries nothing.
        for n in [34usize, 47, 74, 4096] {
            let occupied = n.div_ceil(leaves_per_bucket);
            assert_eq!(occupied, 1, "at {n} leaves every note is in bucket 0");
        }

        // The hazard: the first leaf of a new bucket is alone in it.
        for boundary in 1..bucket_size {
            let n = boundary * leaves_per_bucket + 1;
            let newest_bucket_population = n - boundary * leaves_per_bucket;
            assert_eq!(
                newest_bucket_population, 1,
                "leaf {} is the only member of bucket {boundary}", n - 1
            );
        }

        // And the ceiling.
        assert_eq!((1usize << POOL_DEPTH).div_ceil(leaves_per_bucket), bucket_size);
    }

    /// ⛔ THE ON-CHAIN TOP LEVELS ARE AN OBLIGATION, NOT AN OPTION.
    ///
    /// This test asserts nothing about the AIR. It exists because the AIR is
    /// now UNSOUND ON ITS OWN and the failure is silent: public input 1 is a
    /// depth-12 SUBTREE root, and a subtree root proves membership of a
    /// subtree, not of the pool. Anyone holding a leaf in ANY subtree can
    /// produce a proof this circuit accepts.
    ///
    /// What the spending instruction MUST do before it trusts a C7 proof:
    ///   1. read `public_inputs[1]` as a depth-12 subtree root;
    ///   2. walk the remaining `pool.tree_depth - 12` levels itself, with
    ///      `poseidon_round`, against CALLER-SUPPLIED siblings and orientation
    ///      bits — ⛔ NOT `filled_subtrees`, which is an insertion frontier,
    ///      cannot supply an arbitrary leaf's siblings, and is not bound by any
    ///      proof — then bind the result with `is_valid_root`; the subtree
    ///      index — ESTIMATED at roughly 45K CU for three levels, about 1,350
    ///      field multiplications. ⛔ NOT MEASURED: there is no Goldilocks
    ///      Poseidon in `zk_shielded` to measure. Its only `hash_pair`
    ///      panics and its commented-out body is BN254, the wrong field;
    ///   3. require the resulting root to be one the pool has vouched for,
    ///      exactly as `unshield_denominated_stark_v3` does today with
    ///      `is_valid_root`.
    ///
    /// The pool's tree stays at depth 15. Nothing about the pool changes, no
    /// new PDA, no `tree_depth` migration, and the anonymity set is not reset.
    /// Only the split between circuit and instruction moves.
    ///
    /// 🚨 If Step 7 ships without leg 2, C7 is a fund-loss circuit, in the same
    /// class as `unshield` C5 before 2026-08-18. That is why this is a test and
    /// not a comment.
    #[test]
    fn the_on_chain_top_levels_are_an_obligation_not_an_option() {
        assert_eq!(CANONICAL_DEPTH, 12, "the circuit proves twelve levels");
        assert!(
            CANONICAL_DEPTH < 15,
            "public input 1 is a SUBTREE root; the instruction owns the rest"
        );
        // The boundary assertion binds public input 1 to the Merkle output row,
        // and nothing in this crate can check what that root belongs to.
        let (col, row, src) = SPEND_BOUNDARY_SPEC[5];
        assert_eq!((col, row, src), (0, ROW_MERKLE_ROOT_OUT, Some(1)));
        assert_eq!(15 - CANONICAL_DEPTH, 3, "three levels are owed on chain");
    }

    /// ✅ MEASUREMENT 1b — THE PUBLIC SYSTEM IS NOW UNDERDETERMINED.
    ///
    /// At depth 15 this test ran the other way and it PASSED: col 9 was
    /// piecewise constant over 14 publicly-known segments, so an observer wrote
    /// one linear equation per published evaluation, solved a 14 by 14 system,
    /// and recovered the commitment exactly. Removing it from the instruction
    /// had moved it into the proof, and the gate on [15] had only lowered the
    /// cost from "read eight bytes" to "solve a small system".
    ///
    /// Depth 12 changes the counting rather than the encoding. Cycles 12-15 are
    /// unconstrained on every column, so col 9's unknowns are
    ///
    ///     1  the value on rows 0..=95, which IS the commitment
    ///   + 9  one per filler cycle 3..=11
    ///   + 128 independent uniform mask values
    ///   = 138
    ///
    /// against R = 4*22 + 2 = 90 evaluations the deployed wire publishes. More
    /// unknowns than equations is not an argument, it is a rank statement, so
    /// this test computes the rank. It builds the attacker's best system, finds
    /// a null-space vector, and checks that the vector moves the COMMITMENT
    /// coordinate. That is what makes the commitment specifically unrecoverable
    /// rather than merely "some unknown is free": for every published
    /// evaluation vector there is a whole line of commitments consistent with
    /// it.
    #[test]
    fn measured_the_public_system_is_now_underdetermined() {
        // The attacker's model: one unknown per segment the constraints pin,
        // plus one per free mask row.
        let mut segments: Vec<Vec<usize>> = vec![(0..=HOLD_CONSTANT_LAST).collect()];
        for cycle in 3..FIRST_FREE_CYCLE {
            segments.push((cycle * HASH_CYCLE_LEN..(cycle + 1) * HASH_CYCLE_LEN).collect());
        }
        for row in FIRST_FREE_ROW..TRACE_LENGTH {
            segments.push(vec![row]);
        }
        let unknowns = segments.len();
        assert_eq!(unknowns, 1 + 9 + MASK_ROWS, "138 unknowns");

        // Every evaluation the deployed wire publishes for this column.
        const R: usize = 4 * 22 + 2;
        assert!(unknowns > R, "{unknowns} unknowns must exceed {R} equations");

        let points: Vec<BaseElement> =
            (0..R).map(|i| BaseElement::new(0x2000_0000 + i as u64 * 7919)).collect();

        // m is R x unknowns. Row r, column c is the public basis B_c(z_r).
        let mut m: Vec<Vec<BaseElement>> = Vec::with_capacity(R);
        for &z in &points {
            let mut row = Vec::with_capacity(unknowns);
            for seg in &segments {
                let mut indicator = vec![BaseElement::ZERO; TRACE_LENGTH];
                for &i in seg {
                    indicator[i] = BaseElement::ONE;
                }
                row.push(eval_column_at(&indicator, z));
            }
            m.push(row);
        }

        // Reduced row echelon form, tracking which columns are pivots.
        let mut pivot_of_row: Vec<usize> = Vec::new();
        let mut r = 0usize;
        for c in 0..unknowns {
            if r >= R {
                break;
            }
            let Some(pr) = (r..R).find(|&i| m[i][c] != BaseElement::ZERO) else {
                continue;
            };
            m.swap(r, pr);
            let inv = m[r][c].inv();
            for cc in c..unknowns {
                m[r][cc] = m[r][cc] * inv;
            }
            for i in 0..R {
                if i == r {
                    continue;
                }
                let f = m[i][c];
                if f != BaseElement::ZERO {
                    for cc in c..unknowns {
                        m[i][cc] = m[i][cc] - f * m[r][cc];
                    }
                }
            }
            pivot_of_row.push(c);
            r += 1;
        }
        let rank = pivot_of_row.len();
        assert!(rank <= R, "rank cannot exceed the equation count");
        assert!(
            rank < unknowns,
            "rank {rank} must be below {unknowns} unknowns, or the system would be solvable"
        );

        // Column 0 is the commitment. If it is a pivot we can still ask whether
        // it is DETERMINED: it is not, as long as some free column appears in
        // its row with a non-zero coefficient. Build that null-space vector.
        let pivot_cols: std::collections::BTreeSet<usize> = pivot_of_row.iter().copied().collect();
        let free_col = (0..unknowns)
            .find(|c| !pivot_cols.contains(c))
            .expect("an underdetermined system has a free column");

        let mut null = vec![BaseElement::ZERO; unknowns];
        null[free_col] = BaseElement::ONE;
        for (row_idx, &pc) in pivot_of_row.iter().enumerate() {
            null[pc] = BaseElement::ZERO - m[row_idx][free_col];
        }

        // It really is in the null space: the published evaluations do not move.
        for row in 0..R {
            // Recompute against the ORIGINAL basis, not the reduced one.
            let z = points[row];
            let mut acc = BaseElement::ZERO;
            for (c, seg) in segments.iter().enumerate() {
                if null[c] == BaseElement::ZERO {
                    continue;
                }
                let mut indicator = vec![BaseElement::ZERO; TRACE_LENGTH];
                for &i in seg {
                    indicator[i] = BaseElement::ONE;
                }
                acc += null[c] * eval_column_at(&indicator, z);
            }
            assert_eq!(acc, BaseElement::ZERO, "null vector must not change evaluation {row}");
        }

        assert_ne!(
            null[0],
            BaseElement::ZERO,
            "the null direction must move the COMMITMENT coordinate; if it did not,              the commitment would still be pinned by the published evaluations"
        );
    }

    /// The residue the gate does NOT remove, pinned so it cannot be forgotten.
    ///
    /// Col 9 still equals the commitment on rows 0..=94 and col 5 still equals
    /// it on rows 0..=31, because the leaf has to enter the Merkle pipeline to
    /// be hashed. A query landing on one of those TRACE-ALIGNED LDE positions
    /// still reads it verbatim. With blowup 16 those are 95 and 32 positions
    /// out of 8192, so with 22 queries a proof leaks with probability roughly
    /// 23% via col 9 and 8% via col 5.
    ///
    /// ⛔ Closing that needs masking, not a periodic column. C7 must not be
    /// described as zero-knowledge or unlinkable until it lands.
    #[test]
    fn measured_the_residual_query_channel_after_the_gate() {
        let (trace, commitment) = trace_for(SECRET);

        let col9_hits = (0..TRACE_LENGTH).filter(|r| trace[9][*r] == commitment).count();
        assert_eq!(
            col9_hits,
            HOLD_CONSTANT_LAST + 1,
            "col 9 must carry the commitment on exactly rows 0..={HOLD_CONSTANT_LAST}"
        );

        let col5_hits = (0..TRACE_LENGTH).filter(|r| trace[5][*r] == commitment).count();
        assert!(
            col5_hits >= HASH_CYCLE_LEN,
            "col 5 holds the leaf across its first hash cycle; measured {col5_hits}"
        );

        // The filler is NINE scalars, one per cycle 3-11, because [15]
        // still forces col 9 constant inside a cycle. Pinned as a number so
        // nobody reads "filler" as "masking": statistical zero-knowledge wants
        // on the order of 242 independent uniform elements per column.
        let mut cycle_values = Vec::new();
        for cycle in 3..FIRST_FREE_CYCLE {
            let v = trace[9][cycle * HASH_CYCLE_LEN];
            for row in (cycle * HASH_CYCLE_LEN)..((cycle + 1) * HASH_CYCLE_LEN) {
                assert_eq!(trace[9][row], v, "col 9 must be constant inside cycle {cycle}");
            }
            cycle_values.push(v);
        }
        assert_eq!(cycle_values.len(), 9, "cycles 3..11 are one scalar each");
        let masked: Vec<_> = (FIRST_FREE_ROW..TRACE_LENGTH).map(|r| trace[9][r]).collect();
        for i in 0..masked.len() {
            for j in (i + 1)..masked.len() {
                assert_ne!(masked[i], masked[j], "mask rows {i} and {j} must be independent");
            }
        }
        for i in 0..cycle_values.len() {
            for j in (i + 1)..cycle_values.len() {
                assert_ne!(cycle_values[i], cycle_values[j], "filler cycles {i} and {j} repeat");
            }
        }
    }

    /// MEASUREMENT 2 — the residual channel, and what it is actually worth.
    ///
    /// This is the question the "level -1" redesign turns on. Delete col 9 and
    /// col 5 and the commitment survives only as the Merkle pipeline's first
    /// hash input, in cols 0-2. Is THAT interpolant a low-dimensional public
    /// family — so that one published value solves for the commitment — or is
    /// it merely a distinguisher over a candidate set?
    ///
    /// Two separate things are measured, with different consequences:
    ///
    ///  (a) NOT AFFINE. Poseidon's S-box is x^7, so col 0 is not an affine
    ///      function of the commitment and no single linear equation recovers
    ///      it. That is the good half, and it is what makes "level -1"
    ///      qualitatively different from today's degree-0 column.
    ///
    ///  (b) STILL A PERFECT DISTINGUISHER. Distinct commitments give distinct
    ///      published values, so an observer holding the candidate set never
    ///      needs to invert anything: they recompute each candidate and
    ///      compare. And the candidate set is not secret — it is the pool's
    ///      leaves, all public, 34 of them on the 1 SOL pool on 2026-08-20.
    ///
    /// So the redesign moves an attack from "read 8 bytes" to "recompute N
    /// Poseidon pipelines", N being the anonymity set. That is a real change in
    /// kind. It is NOT hiding.
    #[test]
    fn measured_the_merkle_channel_is_a_distinguisher_not_a_solve() {
        let z = BaseElement::new(0x0BAD_C0FF_EEu64);
        let secrets: [u64; 8] = [SECRET, 11, 12, 13, 14, 15, 16, 17];

        let observed: Vec<(BaseElement, BaseElement)> = secrets
            .iter()
            .map(|&s| {
                let (trace, commitment) = trace_for(s);
                (commitment, eval_column_at(&trace[0], z))
            })
            .collect();

        // (b) distinctness — every candidate separable from every other.
        for i in 0..observed.len() {
            for j in (i + 1)..observed.len() {
                assert_ne!(
                    observed[i].1, observed[j].1,
                    "two candidates share a published value; the channel would not distinguish"
                );
            }
        }

        // The attack: take one proof's published value, discard the witness
        // entirely, and recover WHICH commitment produced it purely by
        // recomputing the candidates.
        let target = observed[0].1;
        let recovered: Vec<BaseElement> = observed
            .iter()
            .filter(|(_, v)| *v == target)
            .map(|(c, _)| *c)
            .collect();
        assert_eq!(recovered.len(), 1, "exactly one candidate must match");
        assert_eq!(
            recovered[0], observed[0].0,
            "the recovered commitment must be the real one"
        );

        // (a) not affine: were col 0 equal to a + commitment * b for public
        // vectors a and b, the published values would satisfy the collinearity
        // relation below, and one division would recover the commitment with
        // no candidate list at all.
        let (c1, v1) = observed[0];
        let (c2, v2) = observed[1];
        let (c3, v3) = observed[2];
        let predicted_if_affine = v1 + (v2 - v1) * (c3 - c1) * (c2 - c1).inv();
        assert_ne!(
            v3, predicted_if_affine,
            "col 0 is affine in the commitment: one division would solve it, no candidates needed"
        );
    }

    fn pub_inputs(nullifier: BaseElement, root: BaseElement) -> SpendPublicInputs {
        SpendPublicInputs {
            nullifier,
            root,
            recipient_hash: [
                BaseElement::new(0x0123_4567_89ab_cdef),
                BaseElement::new(0xfedc_ba98_7654_3210),
                BaseElement::new(1),
                BaseElement::new(2),
            ],
        }
    }

    /// Tile the mixed-length periodic columns onto the full trace domain.
    /// This is exactly what winterfell's `validate` and `compact.rs`'s
    /// `materialise` closure do at trace-aligned points.
    fn materialise(cols: &[Vec<BaseElement>]) -> Vec<Vec<BaseElement>> {
        cols.iter()
            .map(|c| (0..TRACE_LENGTH).map(|i| c[i % c.len()]).collect())
            .collect()
    }

    /// Evaluate all 18 constraints at every enforced transition row
    /// (0..=510 — row 511's transition is the exempt wrap row).
    fn eval_all(trace: &[Vec<BaseElement>]) -> Vec<[BaseElement; SPEND_NUM_CONSTRAINTS]> {
        let periodic = materialise(&build_spend_periodic_columns());
        let mut out = Vec::with_capacity(TRACE_LENGTH - 1);
        for row in 0..TRACE_LENGTH - 1 {
            let current: Vec<BaseElement> = (0..TRACE_WIDTH).map(|c| trace[c][row]).collect();
            let next: Vec<BaseElement> = (0..TRACE_WIDTH).map(|c| trace[c][row + 1]).collect();
            let p: Vec<BaseElement> =
                (0..SPEND_NUM_PERIODIC).map(|j| periodic[j][row]).collect();
            let mut result = [BaseElement::ZERO; SPEND_NUM_CONSTRAINTS];
            evaluate_spend_transition(&current, &next, &p, &mut result);
            out.push(result);
        }
        out
    }

    // ── shape pins ──────────────────────────────────────────────────────

    #[test]
    fn constraint_and_periodic_counts_are_frozen() {
        assert_eq!(TRACE_WIDTH, 10);
        assert_eq!(TRACE_LENGTH, 512);
        assert_eq!(SPEND_NUM_CONSTRAINTS, 18);
        assert_eq!(SPEND_NUM_PERIODIC, 13);
        assert_eq!(SPEND_NUM_PUBLIC_INPUTS, 6);
        assert_eq!(SPEND_NUM_BOUNDARY_ASSERTIONS, 6);
        assert_eq!(build_spend_periodic_columns().len(), SPEND_NUM_PERIODIC);
        assert_eq!(HOLD_CONSTANT_LAST, 95);
        assert!(HOLD_CONSTANT_LAST > ROW_COMMITMENT_OUT, "the gate must cover row 94");
        assert_eq!(ROW_COMMITMENT_OUT, 94);
        assert_eq!(ROW_MERKLE_ROOT_OUT, 382);
        assert_eq!(CANONICAL_DEPTH, 12, "depth 12 in-circuit; the top 3 levels are on chain");
        assert_eq!(FIRST_FREE_ROW, 384);
        assert_eq!(MASK_ROWS, 128);
        assert!(MASK_ROWS > 4 * 22 + 2, "the blinding region must exceed R");
        assert_eq!(ROW_CHAIN, 63);
    }

    #[test]
    fn constraint_degrees_stay_inside_the_blowup() {
        // Measured, not asserted: winterfell's own arithmetic is
        //   base*(n-1) + sum_i (n/c_i)*(c_i - 1)
        // and ce_blowup_factor = max_i next_pow2(base_i + |cycles_i| - 1).
        let degrees = spend_constraint_degrees();
        assert_eq!(degrees.len(), SPEND_NUM_CONSTRAINTS);

        let max_eval = degrees
            .iter()
            .map(|d| d.get_evaluation_degree(TRACE_LENGTH))
            .max()
            .unwrap();
        // 7*511 + 1*511 + 16*31 = 3577 + 511 + 496. Exactly C5's number: the
        // `active` gate is folded INTO the outer periodic factor rather than
        // added as a third, which keeps ce_blowup_factor at 8.
        assert_eq!(max_eval, 4584, "C7 max transition evaluation degree drifted");

        let min_blowup = degrees.iter().map(|d| d.min_blowup_factor()).max().unwrap();
        assert_eq!(min_blowup, 8, "ce_blowup_factor drifted; blowup 16 is the ceiling");

        // Composition polynomial degree after dividing by the transition
        // divisor (degree n - 1), against the constraint-evaluation domain.
        let composition_degree = max_eval - (TRACE_LENGTH - 1);
        let ce_domain = TRACE_LENGTH * min_blowup;
        assert_eq!(composition_degree, 4073);
        assert!(composition_degree < ce_domain, "composition degree exceeds the CE domain");

        // And the live AirContext agrees.
        let (trace, nullifier, root, _) = honest();
        let info = winterfell::TraceInfo::new(TRACE_WIDTH, TRACE_LENGTH);
        let options = winterfell::ProofOptions::new(
            32,
            16,
            0,
            winterfell::FieldExtension::None,
            8,
            31,
        );
        let air = SpendAir::new(info, pub_inputs(nullifier, root), options);
        assert_eq!(air.ce_blowup_factor(), 8);
        assert_eq!(air.context().num_constraint_composition_columns(), 8);
        assert_eq!(air.get_assertions().len(), SPEND_NUM_BOUNDARY_ASSERTIONS);
        assert_eq!(air.get_periodic_column_values().len(), SPEND_NUM_PERIODIC);
        let _ = trace;
    }

    #[test]
    fn periodic_column_lengths_are_the_api_contract() {
        let cols = build_spend_periodic_columns();
        // 0-6 at natural period 32 => stride-16 sparse on the 512 domain.
        for i in 0..7 {
            assert_eq!(cols[i].len(), HASH_CYCLE_LEN, "periodic column {i} must be length 32");
        }
        // 7-9 one-hot at length 512.
        for i in 7..10 {
            assert_eq!(cols[i].len(), TRACE_LENGTH, "periodic column {i} must be length 512");
            let ones = cols[i].iter().filter(|v| **v == BaseElement::ONE).count();
            let zeros = cols[i].iter().filter(|v| **v == BaseElement::ZERO).count();
            assert_eq!(ones, 1, "periodic column {i} must be one-hot");
            assert_eq!(ones + zeros, TRACE_LENGTH);
        }
        assert_eq!(cols[7][ROW_CHAIN], BaseElement::ONE);
        assert_eq!(cols[8][ROW_COMMITMENT_OUT], BaseElement::ONE);
        assert_eq!(cols[9][0], BaseElement::ONE);

        // 10 is ONE-HOT at row 31, the cycle 0-1 link. It must NOT be a dense
        // step: a length-512 step goes through the verifier's dense Horner path
        // at a measured 100,982 CU and 4,096 bytes of rodata, against roughly
        // 6 KB of headroom left. One-hot costs 3 muls and zero rodata.
        assert_eq!(cols[10].len(), TRACE_LENGTH, "hold_link_31 must be length 512");
        let ones = cols[10].iter().filter(|v| **v == BaseElement::ONE).count();
        assert_eq!(ones, 1, "hold_link_31 must be one-hot, never a dense step");
        assert_eq!(cols[10][HASH_CYCLE_LEN - 1], BaseElement::ONE, "hold_link_31 sits at row 31");

        // The gate's three terms must be mutually exclusive, or the sum would
        // reach 2 and [15] would change degree.
        let not_boundary = |row: usize| BaseElement::ONE - cols[4][row % HASH_CYCLE_LEN];
        for row in 0..TRACE_LENGTH {
            let sum = not_boundary(row) + cols[10][row] + cols[7][row];
            assert!(
                sum == BaseElement::ZERO || sum == BaseElement::ONE,
                "gate terms overlap at row {row}"
            );
        }
    }

    #[test]
    fn is_boundary_includes_row_511() {
        // The single `if row < TRACE_LENGTH - 1` at transfer.rs:331 is what
        // forced C5_IS_BOUNDARY_COEFFS onto dense Horner. C7 must not have it.
        let cols = build_spend_periodic_columns();
        let tiled = materialise(&cols);
        assert_eq!(tiled[4][511], BaseElement::ONE);
        for cycle in 0..NUM_HASH_CYCLES {
            assert_eq!(tiled[4][cycle * HASH_CYCLE_LEN + 31], BaseElement::ONE);
        }
    }

    #[test]
    fn shared_periodic_columns_are_stride16_sparse() {
        // `eval_periodic_stride16_at_z` (verify.rs:1256-1302) is only correct
        // for columns whose interpolant over the 512-point domain has non-zero
        // coefficients ONLY at indices divisible by 16 — and its stride check
        // is a `debug_assert`, skipped in release. A column that quietly stops
        // being 32-periodic passes every test here and then fails on chain as
        // an opaque DeepAliFailed. Pin it.
        use winterfell::math::fft;

        let cols = build_spend_periodic_columns();
        let inv_twiddles = fft::get_inv_twiddles::<BaseElement>(TRACE_LENGTH);
        for (i, col) in cols.iter().enumerate().take(7) {
            let mut values: Vec<BaseElement> =
                (0..TRACE_LENGTH).map(|r| col[r % col.len()]).collect();
            fft::interpolate_poly(&mut values, &inv_twiddles);
            for (k, c) in values.iter().enumerate() {
                if k % 16 != 0 {
                    assert_eq!(
                        *c,
                        BaseElement::ZERO,
                        "periodic column {i} has a non-stride-16 coefficient at index {k}"
                    );
                }
            }
        }
    }

    #[test]
    fn boundary_spec_carries_neither_commitment_nor_leaf() {
        let (_, nullifier, root, commitment) = honest();
        let pi = pub_inputs(nullifier, root).to_vec();
        let assertions = spend_boundary_assertions(&pi);
        assert_eq!(assertions.len(), SPEND_NUM_BOUNDARY_ASSERTIONS);

        for (idx, &(col, row, source)) in SPEND_BOUNDARY_SPEC.iter().enumerate() {
            // Never the hold column, never the Merkle carry at row 0.
            assert_ne!(col, 9, "assertion {idx} targets the hold column");
            assert!(!(col == 5 && row == 0), "assertion {idx} targets the leaf");
            if let Some(i) = source {
                assert_ne!(pi[i], commitment, "assertion {idx} carries the commitment");
            }
        }
        // And the frozen order itself.
        assert_eq!(
            SPEND_BOUNDARY_SPEC,
            [
                (6, 30, Some(0)),
                (6, 64, Some(0)),
                (8, 0, None),
                (8, 32, None),
                (8, 64, None),
                (0, 382, Some(1)),
            ]
        );
    }

    #[test]
    #[should_panic(expected = "exactly 6 public inputs")]
    fn boundary_assertions_reject_an_arity_slip() {
        // compact.rs:1224's `pi()` and verify.rs's ladders both zero-fill
        // instead of erroring. This is the only guard.
        let _ = spend_boundary_assertions(&[BaseElement::ONE; 5]);
    }

    // ── the commitment formula ──────────────────────────────────────────

    #[test]
    fn compute_spend_values_delegates_to_the_c1_formula() {
        let (np, s, b, m) = (
            BaseElement::new(NP),
            BaseElement::new(SECRET),
            BaseElement::new(LEGACY_BLINDING),
            BaseElement::new(MINT),
        );
        let (nullifier, blind_hash, commitment) = compute_spend_values(np, s, b, m);
        let (c1_nullifier, c1_commitment) =
            crate::air::denominated_pool::compute_pool_values(np, s, b, m);
        assert_eq!(nullifier, c1_nullifier);
        assert_eq!(commitment, c1_commitment);
        assert_eq!(blind_hash, poseidon::hash2(b, m));
        assert_eq!(commitment, poseidon::hash2(nullifier, blind_hash));
    }

    /// The client's `createCommitmentV3`, reproduced argument for argument:
    /// truncate each input to its low 64 bits, reduce mod Goldilocks, then
    /// three `hash2` calls in this exact order. The truncation happens on the
    /// Rust side at the wasm i64 FFI boundary, where JS `ToBigInt64` wraps
    /// mod 2^64; `BaseElement::new` then reduces mod p.
    fn create_commitment_v3(np: u128, secret: u128, deposit_epoch: u128, token_mint: u128) -> BaseElement {
        let g = |x: u128| BaseElement::new(x as u64); // `as u64` == `& U64_MASK_V3`
        let nullifier = poseidon::hash2(g(np), g(secret));
        let epoch_hash = poseidon::hash2(g(deposit_epoch), g(token_mint));
        poseidon::hash2(nullifier, epoch_hash)
    }

    #[test]
    fn legacy_note_commitment_matches_create_commitment_v3() {
        // blinding = 42, i.e. a real small epoch. This is the note class that
        // has no other withdrawal route (leaf 30 of the 0.1 SOL pool).
        let expected = create_commitment_v3(
            NP as u128,
            SECRET as u128,
            LEGACY_BLINDING as u128,
            MINT as u128,
        );

        let (_, _, commitment) = compute_spend_values(
            BaseElement::new(NP),
            BaseElement::new(SECRET),
            BaseElement::new(LEGACY_BLINDING),
            BaseElement::new(MINT),
        );
        assert_eq!(commitment, expected, "C7 witness diverged from createCommitmentV3");

        // ... and the trace carries the same value in all three places that
        // matter: the commitment output, the hold column, and the leaf.
        let (trace, _, _, trace_commitment) = honest();
        assert_eq!(trace_commitment, expected);
        assert_eq!(trace[6][ROW_COMMITMENT_OUT], expected);
        assert_eq!(trace[9][0], expected);
        assert_eq!(trace[5][0], expected, "leaf must be the commitment");
    }

    #[test]
    fn commitment_matches_create_commitment_v3_under_u64_truncation() {
        // The clients hand over BN254-reduced 254-bit values and rely on the
        // wasm boundary wrapping mod 2^64. Widening the export signature to
        // "fix" the truncation would compute a different commitment from the
        // one in the tree for essentially every note.
        let big_np: u128 = (1u128 << 100) + 111;
        let big_secret: u128 = (1u128 << 90) + 222;
        let expected = create_commitment_v3(big_np, big_secret, 42, MINT as u128);
        let (_, _, commitment) = compute_spend_values(
            BaseElement::new(big_np as u64),
            BaseElement::new(big_secret as u64),
            BaseElement::new(42),
            BaseElement::new(MINT),
        );
        assert_eq!(commitment, expected);
    }

    #[test]
    fn blinding_slot_accepts_any_field_element() {
        // No range check, anywhere, ever. A 63-bit PRF blinding and a small
        // legacy epoch must both build a valid trace.
        let (elems, idx) = test_path();
        for blinding in [1u64, 42, (1u64 << 63) - 1, u64::MAX - 1] {
            let (trace, _, _) = build_spend_trace(
                BaseElement::new(NP),
                BaseElement::new(SECRET),
                BaseElement::new(blinding),
                BaseElement::new(MINT),
                &elems,
                &idx,
                &test_mask(),
            );
            for (i, r) in eval_all(&trace).into_iter().enumerate() {
                for (c, v) in r.iter().enumerate() {
                    assert_eq!(*v, BaseElement::ZERO, "blinding {blinding}: constraint {c} at row {i}");
                }
            }
        }
    }

    // ── trace structure ─────────────────────────────────────────────────

    #[test]
    fn trace_shape_and_landmarks() {
        let (trace, nullifier, root, commitment) = honest();
        assert_eq!(trace.len(), TRACE_WIDTH);
        for col in &trace {
            assert_eq!(col.len(), TRACE_LENGTH);
        }
        assert_eq!(trace[6][ROW_NULLIFIER_OUT], nullifier);
        assert_eq!(trace[6][ROW_COMMIT_IN], nullifier, "cycle-2 left input");
        assert_eq!(trace[7][ROW_COMMIT_IN], trace[6][ROW_BLIND_HASH_OUT], "cycle-2 right input");
        assert_eq!(trace[8][0], BaseElement::ZERO);
        assert_eq!(trace[8][HASH_CYCLE_LEN], BaseElement::ZERO);
        assert_eq!(trace[8][2 * HASH_CYCLE_LEN], BaseElement::ZERO);
        assert_eq!(trace[6][ROW_COMMITMENT_OUT], commitment);
        assert_eq!(trace[0][ROW_MERKLE_ROOT_OUT], root);
        assert_eq!(trace[5][0], commitment, "leaf = commitment");

        // The independently computed root agrees.
        let (elems, idx) = test_path();
        assert_eq!(root, compute_spend_root(commitment, &elems, &idx));
    }

    #[test]
    fn both_pipelines_hash_every_constrained_cycle_and_stop_at_the_mask() {
        // Cycles 0..11 must be genuine on BOTH pipelines, or the shared
        // periodic columns stop being 32-periodic and every one of them goes
        // dense on chain. Cycles 12-15 must NOT be hashed: they are the
        // blinding region and hashing them would put a Poseidon relation back
        // between values that have to be independent.
        let (trace, _, _, _) = honest();

        for cycle in 0..FIRST_FREE_CYCLE {
            let start = cycle * HASH_CYCLE_LEN;
            assert_eq!(trace[8][start], BaseElement::ZERO, "commit cycle {cycle} capacity");
            let out = poseidon::hash2(trace[6][start], trace[7][start]);
            assert_eq!(trace[6][start + NUM_ROUNDS], out, "commit cycle {cycle}");

            assert_eq!(trace[2][start], BaseElement::ZERO, "merkle cycle {cycle} capacity");
            let out = poseidon::hash2(trace[0][start], trace[1][start]);
            assert_eq!(trace[0][start + NUM_ROUNDS], out, "merkle cycle {cycle}");
        }

        // And the mask region is genuinely unrelated. If any column there
        // happened to satisfy the Poseidon relation, the mask would not be
        // uniform and the counting argument would be worth less than it says.
        for cycle in FIRST_FREE_CYCLE..NUM_HASH_CYCLES {
            let start = cycle * HASH_CYCLE_LEN;
            let out = poseidon::hash2(trace[0][start], trace[1][start]);
            assert_ne!(trace[0][start + NUM_ROUNDS], out, "mask cycle {cycle} must not hash");
        }
    }

    #[test]
    fn honest_trace_evaluates_every_constraint_to_zero() {
        let (trace, _, _, _) = honest();
        for (row, result) in eval_all(&trace).into_iter().enumerate() {
            for (c, v) in result.iter().enumerate() {
                assert_eq!(
                    *v,
                    BaseElement::ZERO,
                    "constraint {c} did not evaluate to ZERO at transition row {row}"
                );
            }
        }
    }

    #[test]
    fn honest_trace_satisfies_every_boundary_assertion() {
        let (trace, nullifier, root, _) = honest();
        let pi = pub_inputs(nullifier, root).to_vec();
        for (idx, &(col, row, source)) in SPEND_BOUNDARY_SPEC.iter().enumerate() {
            let expected = match source {
                Some(i) => pi[i],
                None => BaseElement::ZERO,
            };
            assert_eq!(trace[col][row], expected, "boundary assertion {idx}");
        }
    }

    // ── the leak, pinned ────────────────────────────────────────────────

    #[test]
    fn hold_column_carries_the_commitment_only_up_to_the_gate() {
        // Was `hold_column_is_constant_which_publishes_the_commitment`, which
        // pinned the defect: [15] ungated made col 9 degree 0, so the
        // serializer emitted the commitment verbatim in ood_current[9],
        // ood_next[9] and every query — ~46 plaintext copies in a blob
        // uploaded as public instruction data.
        //
        // Now [15] is gated by `hold_active`. The commitment must still be
        // there up to the gate, because [16] and [17] read it, and must NOT be
        // there above it, because that is what stops the column being degree 0.
        let (trace, _, _, commitment) = honest();
        for row in 0..=HOLD_CONSTANT_LAST {
            assert_eq!(trace[9][row], commitment, "col 9 must hold at row {row}");
        }
        for row in (HOLD_CONSTANT_LAST + 1)..TRACE_LENGTH {
            assert_ne!(
                trace[9][row], commitment,
                "col 9 must NOT be the commitment at row {row}"
            );
        }
        // Col 5 (the Merkle carry) still holds it on rows 0-31 regardless: the
        // leaf has to enter the pipeline to be hashed. Only masking removes it.
        for row in 0..HASH_CYCLE_LEN {
            assert_eq!(trace[5][row], commitment);
        }
    }

    // ── negative tests ──────────────────────────────────────────────────

    #[test]
    fn untied_hold_column_violates_constraint_16() {
        // Forgery 1 of the plan's Step 5: both Poseidon pipelines honest, but
        // col 9 pinned to a value that is NOT the commitment output at row 94,
        // and the Merkle leaf set to that value. Prove membership of a leaf
        // you did not compute.
        let (mut trace, _, _, commitment) = honest();
        let forged = commitment + BaseElement::ONE;
        for row in 0..TRACE_LENGTH {
            trace[9][row] = forged;
        }
        let results = eval_all(&trace);
        // [15] still holds — the column is still constant.
        assert!(results.iter().all(|r| r[15] == BaseElement::ZERO));
        // [16] fires at row 94.
        assert_ne!(results[ROW_COMMITMENT_OUT][16], BaseElement::ZERO);
        // [17] fires at row 0 as well, because the leaf still is the real
        // commitment.
        assert_ne!(results[0][17], BaseElement::ZERO);
    }

    #[test]
    fn leaf_not_equal_commitment_violates_constraint_17() {
        // Forgery 2: col 9 correctly equals the commitment, but the Merkle
        // carry at row 0 is a different leaf. This is "spend someone else's
        // note with your own nullifier" — the pool drain. Constraint [17] is
        // the ONLY thing that catches it: C7 drops C3's (col5, row0, leaf)
        // boundary assertion on purpose.
        let (mut trace, _, _, _) = honest();
        trace[5][0] = trace[5][0] + BaseElement::new(7);
        let results = eval_all(&trace);
        assert_ne!(results[0][17], BaseElement::ZERO, "[17] must reject a foreign leaf");
    }

    #[test]
    fn a_non_constant_hold_column_violates_constraint_15_inside_the_gate() {
        let (mut trace, _, _, _) = honest();
        // Row 50 is inside `hold_active`, so [15] still binds there.
        trace[9][50] = trace[9][50] + BaseElement::ONE;
        let results = eval_all(&trace);
        assert_ne!(results[49][15], BaseElement::ZERO);
        assert_ne!(results[50][15], BaseElement::ZERO);
    }

    #[test]
    fn the_tail_above_the_gate_is_genuinely_free() {
        // The other half of the gate, and the reason it exists. Rows above
        // HOLD_CONSTANT_LAST may hold anything at all without violating a single
        // constraint. That is what lets the prover break the degree-0 shape
        // today, and it is the room masking will need tomorrow.
        let (mut trace, _, _, _) = honest();
        for cycle in 3..NUM_HASH_CYCLES {
            let v = BaseElement::new(cycle as u64 * 7 + 13);
            for row in (cycle * HASH_CYCLE_LEN)..((cycle + 1) * HASH_CYCLE_LEN) {
                trace[9][row] = v;
            }
        }
        let results = eval_all(&trace);
        for (row, r) in results.iter().enumerate() {
            for (i, v) in r.iter().enumerate() {
                assert_eq!(
                    *v,
                    BaseElement::ZERO,
                    "constraint [{i}] must stay satisfied at row {row} with an arbitrary tail"
                );
            }
        }
    }

    #[test]
    fn forged_blind_hash_violates_the_chain_constraint_14() {
        // Without [14], blind_hash is a free prover choice and the commitment
        // at row 94 is whatever the prover wants.
        let (mut trace, _, _, _) = honest();
        trace[7][ROW_COMMIT_IN] = trace[7][ROW_COMMIT_IN] + BaseElement::ONE;
        let results = eval_all(&trace);
        assert_ne!(results[ROW_CHAIN][14], BaseElement::ZERO);
    }

    #[test]
    fn non_binary_direction_bit_violates_constraint_10() {
        let (mut trace, _, _, _) = honest();
        for row in 0..HASH_CYCLE_LEN {
            trace[4][row] = BaseElement::new(2);
        }
        let results = eval_all(&trace);
        assert_ne!(results[0][10], BaseElement::ZERO);
    }

    #[test]
    fn sibling_mutated_mid_cycle_violates_constraint_8() {
        let (mut trace, _, _, _) = honest();
        trace[3][10] = trace[3][10] + BaseElement::ONE;
        let results = eval_all(&trace);
        // is_interior fires on the transitions into and out of row 10.
        assert_ne!(results[9][8], BaseElement::ZERO);
        assert_ne!(results[10][8], BaseElement::ZERO);
    }

    #[test]
    fn broken_carry_update_violates_constraint_6() {
        let (mut trace, _, _, _) = honest();
        // Rewrite the carry of Merkle level 1 so it is not level 0's output.
        for row in HASH_CYCLE_LEN..2 * HASH_CYCLE_LEN {
            trace[5][row] = trace[5][row] + BaseElement::ONE;
        }
        let results = eval_all(&trace);
        assert_ne!(results[HASH_CYCLE_LEN - 1][6], BaseElement::ZERO);
    }

    // ── winterfell round trip ───────────────────────────────────────────

    #[test]
    fn test_winterfell_proof() {
        // ⚠️ This exercises `default_proof_options()` — 32 queries, FRI max
        // remainder degree 31 — NOT the shipping compact geometry (22 queries,
        // ffps 32, merkle_depth 13). A green run proves the constraint system
        // is self-consistent and that the honest trace satisfies it. It proves
        // nothing about C7/C6 config distinguishability, the 22-query
        // soundness, or the on-chain CU.
        use crate::prover::{prove_generic, verify_generic};

        let (trace, nullifier, root, _) = honest();
        let pi = pub_inputs(nullifier, root);

        let (proof, _) = prove_generic::<SpendAir>(trace, pi.clone())
            .expect("C7 spend proof generation failed");
        verify_generic::<SpendAir>(proof, pi).expect("C7 spend proof verification failed");
    }

    #[test]
    fn test_wrong_nullifier_fails_prove() {
        // Cloned from denominated_pool.rs:451-483.
        use crate::prover::{prove_generic, verify_generic};

        let (trace, _, root, _) = honest();
        let wrong = pub_inputs(BaseElement::new(999), root);

        let result = std::panic::catch_unwind(|| {
            prove_generic::<SpendAir>(trace, wrong.clone())
        });

        match result {
            Err(_) => { /* prover panicked — acceptable */ }
            Ok(Err(_)) => { /* prover returned error — acceptable */ }
            Ok(Ok((proof, _))) => {
                let verify = verify_generic::<SpendAir>(proof, wrong);
                assert!(
                    verify.is_err(),
                    "Proof with wrong nullifier must fail either prove or verify"
                );
            }
        }
    }

    #[test]
    fn test_wrong_root_fails_prove() {
        use crate::prover::{prove_generic, verify_generic};

        let (trace, nullifier, _, _) = honest();
        let wrong = pub_inputs(nullifier, BaseElement::new(1234));

        let result = std::panic::catch_unwind(|| {
            prove_generic::<SpendAir>(trace, wrong.clone())
        });

        match result {
            Err(_) => {}
            Ok(Err(_)) => {}
            Ok(Ok((proof, _))) => {
                let verify = verify_generic::<SpendAir>(proof, wrong);
                assert!(verify.is_err(), "Proof with wrong root must fail");
            }
        }
    }

    #[test]
    fn test_forged_leaf_fails_prove() {
        // The pool drain, through the full winterfell path this time: the
        // trace is honest except that the Merkle pipeline proves membership of
        // a leaf that is not the commitment.
        use crate::prover::{prove_generic, verify_generic};

        let (elems, idx) = test_path();
        let (mut trace, nullifier, _, _) = honest();

        // Re-run the Merkle pipeline from a foreign leaf, leaving the
        // commitment pipeline and the hold column untouched.
        let foreign_leaf = BaseElement::new(0xdead_beef);
        let forged_root = compute_spend_root(foreign_leaf, &elems, &idx);

        // Swap the Merkle half for one rooted at the foreign leaf.
        let mut carry = foreign_leaf;
        for level in 0..CANONICAL_DEPTH {
            let sibling = elems[level];
            let dir = idx[level];
            let dir_felt = if dir == 0 { BaseElement::ZERO } else { BaseElement::ONE };
            let start = level * HASH_CYCLE_LEN;
            for row in start..start + HASH_CYCLE_LEN {
                trace[3][row] = sibling;
                trace[4][row] = dir_felt;
                trace[5][row] = carry;
            }
            let (l, r) = if dir == 0 { (carry, sibling) } else { (sibling, carry) };
            let mut state = [l, r, BaseElement::ZERO];
            trace[0][start] = state[0];
            trace[1][start] = state[1];
            trace[2][start] = state[2];
            let rc = &poseidon::constants::ROUND_CONSTANTS_T3;
            let mds = &poseidon::constants::MDS_MATRIX_T3;
            for round in 0..NUM_ROUNDS {
                for i in 0..3 {
                    state[i] = state[i] + rc[round * 3 + i];
                }
                for s in &mut state {
                    let x = *s;
                    let x2 = x * x;
                    let x4 = x2 * x2;
                    *s = x4 * x2 * x;
                }
                let mut res = [BaseElement::ZERO; 3];
                for i in 0..3 {
                    for j in 0..3 {
                        res[i] = res[i] + mds[i][j] * state[j];
                    }
                }
                state = res;
                let row = start + round + 1;
                trace[0][row] = state[0];
                trace[1][row] = state[1];
                trace[2][row] = state[2];
            }
            trace[0][start + 31] = state[0];
            trace[1][start + 31] = state[1];
            trace[2][start + 31] = state[2];
            carry = state[0];
        }
        // ⛔ NO 16th CYCLE. `CANONICAL_DEPTH * HASH_CYCLE_LEN` is now
        // FIRST_FREE_ROW, so hand-hashing one here would write a genuine
        // Poseidon relation into the BLINDING region and overwrite 192 of the
        // 1,280 mask cells — the exact relation
        // `both_pipelines_hash_every_constrained_cycle_and_stop_at_the_mask`
        // asserts must be absent. The forgery this test exercises is caught by
        // [17] at row 0, which is nowhere near the mask.

        // The AIR must reject: [17] ties col5@row0 to the hold column, which
        // still carries the real commitment.
        let results = eval_all(&trace);
        assert_ne!(results[0][17], BaseElement::ZERO);

        let pi = pub_inputs(nullifier, forged_root);
        let result = std::panic::catch_unwind(|| prove_generic::<SpendAir>(trace, pi.clone()));
        match result {
            Err(_) => {}
            Ok(Err(_)) => {}
            Ok(Ok((proof, _))) => {
                assert!(
                    verify_generic::<SpendAir>(proof, pi).is_err(),
                    "a forged leaf must not verify"
                );
            }
        }
    }
}
