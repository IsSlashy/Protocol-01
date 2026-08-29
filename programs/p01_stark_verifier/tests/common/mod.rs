//! THE SINGLE DEFINITION OF THE `honest_liveness` WITNESS FAMILY.
//!
//! # Why this file exists
//!
//! [2026-08-01] The C5 generator in `honest_liveness.rs` was not producing
//! honest witnesses. It moved `in_amount_1` and `in_amount_2` with the witness
//! index while holding `out_amount_1`, `out_amount_2` and `public_amount` fixed,
//! so the C5 value-conservation accumulator held `50 - 2s` against a claimed
//! `public_amount = 50`. Every witness with `s != 0` was a mint-from-nothing.
//! The verifier's CORRECT rejection of those proofs was counted as a liveness
//! defect for a full day, and the obvious "fix" — relaxing the row-385 boundary
//! check — would have deleted the phase-1 half of the value-conservation gate on
//! the fund-moving circuit.
//!
//! A generator that emits invalid witnesses makes its suite measure NOTHING, in
//! either direction: it can hide a real liveness defect exactly as easily as it
//! can invent a fake one. `160 of 160 verified` is a claim about the verifier
//! ONLY if the 160 inputs were honest to begin with.
//!
//! # What this file guarantees
//!
//! The witness family is defined here ONCE and consumed by both
//! `tests/honest_liveness.rs` (which proves and verifies them) and
//! `tests/liveness_generator_semantics.rs` (which proves they are honest). The
//! two suites cannot drift apart, because there is only one set of numbers.
//!
//! `check_semantics_*` re-derives every public input from the private witness
//! along an INDEPENDENT path — `p01_stark::poseidon::hash2`, the reference
//! permutation, never the inlined round loop inside the trace builder and never
//! the `compute_*` helper the generator itself calls — and additionally asserts
//! the relations that are NOT implied by construction:
//!
//!   * C5 `out1 + out2 - in1 - in2 == public_amount`. `public_amount` is the
//!     ONLY public input of the seven circuits that the generator does not
//!     derive from the witness, which is why C5 was structurally the only place
//!     this class of bug could live — and it is where it lived.
//!   * C4 `old_balance == new_balance + amount`. C4's conservation law is
//!     enforced on chain, not in the AIR (`air/confidential_balance.rs` header),
//!     so a non-conserving C4 witness would still verify. It would still not be
//!     an honest spend, and a liveness suite built on one would be measuring a
//!     state the program refuses to create.
//!   * C3 / C6 the Merkle root is the real fold of the leaf up the path, and
//!     `depth == 15`, the only depth the shipped verifier accepts
//!     (`CANONICAL_DEPTH` in verify.rs, enforced in phase 2).
//!
//! `sweep_transitions` then evaluates the AIR's own transition polynomial at
//! EVERY frame of the built trace and requires every constraint to vanish. That
//! is the AIR's own semantics, evaluated by the AIR's own exported evaluator,
//! on the trace the generator actually commits to.
//!
//! # Boundary rows
//!
//! `check_semantics_*` also pins the public inputs to the exact trace cells the
//! AIR asserts on (`get_assertions` in each `air/*.rs`). The C5 row-385
//! accumulator assertion is the one that was violated; it is checked here
//! explicitly, by the named `ROW_ACC_FINAL` constant.

#![allow(dead_code)]

use p01_stark::air::{
    balance_proof, confidential_balance, denominated_pool, merkle_path, merkle_update, transfer,
};
use p01_stark::poseidon;
use p01_stark::BaseElement;

/// Witnesses per circuit. Each one is a full prove + verify in
/// `honest_liveness.rs`, and a full trace sweep here.
///
/// [2026-08-01] Raised 32 → 160. At 32 witnesses × 22 queries × 1/16 aligned,
/// a per-row defect confined to a handful of the 512 trace rows is seen a few
/// times at best, which is how the C5 carry-capture rows (30/62/286/382) and
/// the C6 padding rows (480..=509) stayed invisible for as long as they did.
pub const WITNESSES: usize = 160;

/// C3's Merkle depth, sourced from the AIR rather than typed.
///
/// ⚠️ CORRECTED TWICE ON 2026-08-29, AND THE SECOND CORRECTION IS THE LESSON.
/// This was 15 and shared by C3 and C6. When C6 was cut to 12 I split it in two
/// and wrote "THIS IS C3's DEPTH ALONE" — which was true for about an hour,
/// until C3 took the same cut. A constant that names a circuit and carries a
/// literal will keep going stale; one that reads the AIR cannot.
///
/// Both are 12 today, and they are still two constants on purpose: nothing
/// requires the two circuits to move together, and a single shared constant is
/// what would make the next divergence invisible.
pub const CANONICAL_DEPTH: usize = p01_stark::air::merkle_path::CANONICAL_DEPTH;

/// C6's Merkle depth.
///
/// Sourced from the AIR rather than typed, so it cannot drift from the geometry
/// the prover actually builds. At 12 the walk occupies rows 0..383 and rows
/// 384..511 are the blinding region -- 128 free rows against `R = 4*22 + 2 = 90`
/// published openings per column, which is the whole reason the cut happened.
///
/// Equal to `CANONICAL_DEPTH` above today. Kept separate so that when one
/// circuit's geometry moves and the other's does not, the tests say which.
pub const C6_CANONICAL_DEPTH: usize = p01_stark::air::merkle_update::CANONICAL_DEPTH;

fn f(x: u64) -> BaseElement {
    BaseElement::new(x)
}

/// `winterfell` is not a dependency of this crate, so the `FieldElement` trait —
/// and with it the associated `BaseElement` zero — is not in scope. `p01_stark` re-exports the
/// concrete field element, whose inherent `new` is enough.
#[allow(non_snake_case)]
fn ZERO() -> BaseElement {
    BaseElement::new(0)
}

// ============================================================================
// The witness family — ONE definition, two consumers
// ============================================================================

pub struct W0 {
    pub subscriber_secret: u64,
}

pub struct W1 {
    pub nullifier_preimage: u64,
    pub secret: u64,
    pub deposit_epoch: u64,
    pub token_mint: u64,
}

pub struct W2 {
    pub spending_key: u64,
    pub balance: u64,
    pub salt: u64,
    pub token_mint: u64,
}

pub struct W3 {
    pub leaf: u64,
    pub path_elements: Vec<u64>,
    pub path_indices: Vec<u8>,
}

pub struct W4 {
    pub spending_key: u64,
    pub old_balance: u64,
    pub old_salt: u64,
    pub new_balance: u64,
    pub new_salt: u64,
    pub amount: u64,
    pub amount_salt: u64,
    pub token_mint: u64,
}

pub struct W5 {
    pub spending_key: u64,
    pub token_mint: u64,
    pub in_amount_1: u64,
    pub in_rand_1: u64,
    pub in_amount_2: u64,
    pub in_rand_2: u64,
    pub out_amount_1: u64,
    pub out_recipient_1: u64,
    pub out_rand_1: u64,
    pub out_amount_2: u64,
    pub out_recipient_2: u64,
    pub out_rand_2: u64,
    pub public_amount: u64,
}

pub struct W6 {
    pub old_leaf: u64,
    pub new_leaf: u64,
    pub path_elements: Vec<u64>,
    pub path_indices: Vec<u8>,
}

/// [C7] Spend witness. Twelve path elements, not fifteen -- C7's depth is fixed
/// at `CANONICAL_DEPTH = 12` by the trace layout and is not a public input.
///
/// ⛔ `mask` is a DETERMINISTIC test stream, never CSPRNG output. A test needs
/// reproducibility; a proof that moves money needs fresh randomness for every
/// proof, and reusing a mask across two proofs of one note gives an observer a
/// relation between traces that must be independent.
pub struct W7 {
    pub nullifier_preimage: u64,
    pub secret: u64,
    pub blinding: u64,
    pub token_mint: u64,
    pub path_elements: Vec<u64>,
    pub path_indices: Vec<u8>,
    pub recipient_hash: [u64; 4],
    pub mask: Vec<u64>,
}

pub fn w0(i: usize) -> W0 {
    W0 { subscriber_secret: 42 + i as u64 * 7919 }
}

pub fn w1(i: usize) -> W1 {
    let s = i as u64;
    W1 { nullifier_preimage: 111 + s, secret: 222 + s * 3, deposit_epoch: 333 + s * 5, token_mint: 444 + s * 7 }
}

pub fn w2(i: usize) -> W2 {
    let s = i as u64;
    W2 { spending_key: 42 + s, balance: 1000 + s * 11, salt: 777 + s, token_mint: 999 + s * 3 }
}

pub fn w3(i: usize) -> W3 {
    let s = i as u64;
    W3 {
        leaf: 777 + s,
        // [C3-D12] 12, not 15. Sourced from the AIR through `CANONICAL_DEPTH`
        // rather than a literal, because this pair went stale once already:
        // the depth moved and the two `(0..15)` here did not.
        path_elements: (0..CANONICAL_DEPTH as u64).map(|j| 1000 + j + s * 31).collect(),
        path_indices: (0..CANONICAL_DEPTH).map(|j| ((j + i) % 2) as u8).collect(),
    }
}

/// `old_balance - amount == new_balance`: `1000 + 13s - 200 == 800 + 13s`.
pub fn w4(i: usize) -> W4 {
    let s = i as u64;
    W4 {
        spending_key: 42 + s,
        old_balance: 1000 + s * 13,
        old_salt: 111 + s,
        new_balance: 800 + s * 13,
        new_salt: 222 + s,
        amount: 200,
        amount_salt: 333 + s,
        token_mint: 999 + s,
    }
}

/// `in1 + in2 = 165 + 2s`; `out1 + out2 = 215 + 2s`; difference == 50 for every
/// `s`. Both sides move with the witness index so the trace — and therefore the
/// query positions — still vary, without breaking conservation.
pub fn w5(i: usize) -> W5 {
    let s = i as u64;
    W5 {
        spending_key: 13 + s,
        token_mint: 500 + s * 17,
        in_amount_1: 77 + s,
        in_rand_1: 400 + s * 17,
        in_amount_2: 88 + s,
        in_rand_2: 100,
        out_amount_1: 150 + 2 * s,
        out_recipient_1: 1234 + s,
        out_rand_1: 555 + s,
        out_amount_2: 65,
        out_recipient_2: 2222 + s,
        out_rand_2: 333 + s,
        public_amount: 50,
    }
}

pub fn w7(i: usize) -> W7 {
    use p01_stark::air::spend::{CANONICAL_DEPTH, MASK_ROWS, TRACE_WIDTH};
    const GOLDILOCKS: u64 = 0xFFFF_FFFF_0000_0001;

    let s = i as u64;
    // xorshift64*, spread across the field. Small integers would satisfy every
    // constraint just as well -- there are none in the blinding region -- but
    // they would not look like the distribution the counting argument in
    // `air/spend.rs` assumes.
    let mut st = 0x9E37_79B9_7F4A_7C15u64 ^ (s.wrapping_mul(0x1000_0000_0000_0001));
    if st == 0 {
        st = 0x9E37_79B9_7F4A_7C15;
    }
    let mut mask = Vec::with_capacity(MASK_ROWS * TRACE_WIDTH);
    for _ in 0..(MASK_ROWS * TRACE_WIDTH) {
        st ^= st >> 12;
        st ^= st << 25;
        st ^= st >> 27;
        mask.push(st.wrapping_mul(0x2545_F491_4F6C_DD1D) % GOLDILOCKS);
    }

    W7 {
        nullifier_preimage: 42 + s,
        secret: 999 + s * 7,
        blinding: 7 + s,
        token_mint: 555,
        path_elements: (0..CANONICAL_DEPTH as u64).map(|j| 1000 + j * 37 + s * 11).collect(),
        path_indices: (0..CANONICAL_DEPTH).map(|j| ((j + i) % 2) as u8).collect(),
        recipient_hash: [11 + s, 22, 33, 44],
        mask,
    }
}

pub fn w6(i: usize) -> W6 {
    let s = i as u64;
    W6 {
        old_leaf: 111 + s,
        new_leaf: 222 + s * 3,
        // [C6-D12] 12, not 15. `w3` above is also 12 now — C3 took the same cut
        // later the same day.
        path_elements: (0..12u64).map(|j| 100 + j * 13 + s * 37).collect(),
        path_indices: (0..12u8).map(|j| ((j as usize + i) % 2) as u8).collect(),
    }
}

// ============================================================================
// Proving — the generator call, so the two suites cannot call it differently
// ============================================================================

pub fn prove0(w: &W0) -> p01_stark::compact::CompactProofData {
    p01_stark::compact::generate_compact_proof(w.subscriber_secret)
}

pub fn prove1(w: &W1) -> p01_stark::compact::GenericCompactProofData {
    p01_stark::compact::generate_pool_commitment_proof(
        w.nullifier_preimage, w.secret, w.deposit_epoch, w.token_mint, &p01_stark::compact::c1_deterministic_probe_mask())
}

pub fn prove2(w: &W2) -> p01_stark::compact::GenericCompactProofData {
    p01_stark::compact::generate_balance_compact_proof(
        w.spending_key, w.balance, w.salt, w.token_mint,
    )
}

pub fn prove3(w: &W3) -> p01_stark::compact::GenericCompactProofData {
    p01_stark::compact::generate_merkle_path_compact_proof(
        w.leaf, &w.path_elements, &w.path_indices, &p01_stark::compact::c3_deterministic_probe_mask(w.path_elements.len()))
}

pub fn prove4(w: &W4) -> p01_stark::compact::GenericCompactProofData {
    p01_stark::compact::generate_confidential_balance_compact_proof(
        w.spending_key, w.old_balance, w.old_salt, w.new_balance, w.new_salt, w.amount,
        w.amount_salt, w.token_mint,
    )
}

pub fn prove5(w: &W5) -> p01_stark::compact::GenericCompactProofData {
    p01_stark::compact::generate_transfer_compact_proof(
        w.spending_key, w.token_mint, w.in_amount_1, w.in_rand_1, w.in_amount_2, w.in_rand_2,
        w.out_amount_1, w.out_recipient_1, w.out_rand_1, w.out_amount_2, w.out_recipient_2,
        w.out_rand_2, w.public_amount, &p01_stark::compact::c5_deterministic_probe_mask())
}

pub fn prove6(w: &W6) -> p01_stark::compact::GenericCompactProofData {
    p01_stark::compact::generate_merkle_update_compact_proof(
        w.old_leaf, w.new_leaf, &w.path_elements, &w.path_indices, &p01_stark::compact::c6_deterministic_probe_mask(w.path_elements.len()))
}

pub fn prove7(w: &W7) -> p01_stark::compact::GenericCompactProofData {
    p01_stark::compact::generate_spend_compact_proof(
        w.nullifier_preimage, w.secret, w.blinding, w.token_mint,
        &w.path_elements, &w.path_indices, &w.recipient_hash, &w.mask,
    )
}

// ============================================================================
// The transition sweep
// ============================================================================

/// Evaluate an AIR's transition polynomial at every frame of `trace` and return
/// the first `(row, constraint_index)` where it does not vanish.
///
/// Frames are `(row, row + 1)` for `row in 0..n-1`. The wrap frame `(n-1, 0)` is
/// deliberately excluded: the transition constraints are enforced by
/// `Z_T(x) = (x^n - 1) / (x - g^(n-1))`, which does not vanish at the last row,
/// so the prover never divides by it there and the AIR is not required to hold.
///
/// Periodic columns come back at MIXED lengths on C5 (32 and 512), so each
/// column is indexed modulo its own length — exactly as the periodic polynomial
/// is evaluated on the LDE.
pub fn sweep_transitions<Eval>(
    label: &str,
    trace: &[Vec<BaseElement>],
    periodic: &[Vec<BaseElement>],
    num_constraints: usize,
    eval: Eval,
) where
    Eval: Fn(&[BaseElement], &[BaseElement], &[BaseElement], &mut [BaseElement]),
{
    let width = trace.len();
    let n = trace[0].len();
    let mut current = vec![ZERO(); width];
    let mut next = vec![ZERO(); width];
    let mut per = vec![ZERO(); periodic.len()];
    let mut result = vec![ZERO(); num_constraints];

    for row in 0..n - 1 {
        for col in 0..width {
            current[col] = trace[col][row];
            next[col] = trace[col][row + 1];
        }
        for (c, column) in periodic.iter().enumerate() {
            per[c] = column[row % column.len()];
        }
        for r in result.iter_mut() {
            *r = ZERO();
        }
        eval(&current, &next, &per, &mut result);
        for (ci, value) in result.iter().enumerate() {
            assert_eq!(
                *value,
                ZERO(),
                "\n\n  >>> {label}: THE GENERATOR EMITTED AN INVALID WITNESS <<<\n  \
                 transition constraint {ci} does not vanish at row {row} (frame {row} → {}).\n  \
                 The trace this witness commits to does not satisfy the AIR. Any liveness \
                 number measured on it is meaningless: a rejection would be CORRECT and would \
                 be read as a verifier defect, exactly as happened to C5 on 2026-08-01.\n",
                row + 1,
            );
        }
    }
}

// ============================================================================
// Independent re-derivation of every public input, plus the relations that are
// not implied by construction
// ============================================================================

/// Fold a leaf up a Merkle path with the reference `hash2`. Deliberately NOT
/// `merkle_path::compute_merkle_root` — that is the function the C3 generator
/// itself calls to produce the public root, so using it here would prove
/// nothing.
fn fold_path(leaf: BaseElement, elements: &[BaseElement], indices: &[u8]) -> BaseElement {
    let mut current = leaf;
    for (e, &d) in elements.iter().zip(indices.iter()) {
        assert!(d == 0 || d == 1, "path index must be binary, got {d}");
        current = if d == 0 { poseidon::hash2(current, *e) } else { poseidon::hash2(*e, current) };
    }
    current
}

pub fn check_semantics_0(w: &W0, data: &p01_stark::compact::CompactProofData) {
    let secret = f(w.subscriber_secret);
    let expected = poseidon::hash1(secret);
    assert_eq!(
        f(data.commitment), expected,
        "C0: the generator's commitment is not Poseidon(subscriber_secret)",
    );
    let trace = p01_stark::build_trace(secret);
    assert_eq!(trace[1][0], ZERO(), "C0: row 0 col 1 must be 0");
    assert_eq!(trace[2][0], ZERO(), "C0: capacity at row 0 must be 0");
    assert_eq!(trace[0][30], expected, "C0: trace row 30 col 0 must carry the commitment");
    assert_eq!(trace[0][31], trace[0][30], "C0: row 31 must be the padding copy of row 30");
}

pub fn check_semantics_1(w: &W1, data: &p01_stark::compact::GenericCompactProofData) {
    let nullifier = poseidon::hash2(f(w.nullifier_preimage), f(w.secret));
    let epoch_hash = poseidon::hash2(f(w.deposit_epoch), f(w.token_mint));
    let commitment = poseidon::hash2(nullifier, epoch_hash);

    assert_eq!(data.public_inputs.len(), 2, "C1: expected 2 public inputs");
    assert_eq!(f(data.public_inputs[0]), nullifier, "C1: nullifier != Poseidon(preimage, secret)");
    assert_eq!(
        f(data.public_inputs[1]), commitment,
        "C1: commitment != Poseidon(nullifier, Poseidon(epoch, mint))",
    );

    let (trace, _, _) = denominated_pool::build_pool_commitment_trace(
        f(w.nullifier_preimage), f(w.secret), f(w.deposit_epoch), f(w.token_mint), &p01_stark::compact::c1_deterministic_probe_mask().iter().map(|&v| BaseElement::new(v)).collect::<Vec<_>>());
    assert_eq!(trace[0][30], nullifier, "C1: boundary row 30 (nullifier)");
    assert_eq!(trace[0][94], commitment, "C1: boundary row 94 (commitment)");
    assert_eq!(trace[0][64], nullifier, "C1: cycle-2 left input must be the nullifier");
    for cycle in 0..3 {
        assert_eq!(trace[2][cycle * 32], ZERO(), "C1: capacity at cycle {cycle} start");
    }
    sweep_transitions(
        "C1",
        &trace,
        &denominated_pool::build_pool_commitment_periodic_columns(denominated_pool::TRACE_LENGTH),
        denominated_pool::POOL_COMMITMENT_NUM_CONSTRAINTS,
        denominated_pool::evaluate_pool_commitment_transition,
    );
}

pub fn check_semantics_2(w: &W2, data: &p01_stark::compact::GenericCompactProofData) {
    let owner = poseidon::hash2(f(w.spending_key), ZERO());
    let owner_mint = poseidon::hash2(owner, f(w.token_mint));
    let bal_salt = poseidon::hash2(f(w.balance), f(w.salt));
    let commitment = poseidon::hash2(bal_salt, owner_mint);

    assert_eq!(data.public_inputs.len(), 2, "C2: expected 2 public inputs");
    assert_eq!(f(data.public_inputs[0]), commitment, "C2: commitment != the reference Poseidon chain");
    assert_eq!(data.public_inputs[1], w.token_mint, "C2: token_mint public input");

    let (trace, _) = balance_proof::build_balance_proof_trace(
        f(w.spending_key), f(w.balance), f(w.salt), f(w.token_mint),
    );
    assert_eq!(trace[0][126], commitment, "C2: boundary row 126 (commitment)");
    assert_eq!(trace[1][32], f(w.token_mint), "C2: cycle-1 right input must be token_mint");
    assert_eq!(trace[1][0], ZERO(), "C2: row 0 col 1 must be 0");
    sweep_transitions(
        "C2",
        &trace,
        &balance_proof::build_balance_proof_periodic_columns(balance_proof::TRACE_LENGTH),
        balance_proof::BALANCE_PROOF_NUM_CONSTRAINTS,
        balance_proof::evaluate_balance_proof_transition,
    );
}

pub fn check_semantics_3(w: &W3, data: &p01_stark::compact::GenericCompactProofData) {
    assert_eq!(
        w.path_elements.len(), CANONICAL_DEPTH,
        "C3: depth must be the canonical 12 — 15 since 2026-08-29 is a pre-cut witness",
    );
    assert_eq!(w.path_indices.len(), CANONICAL_DEPTH, "C3: index count must match the path");

    let leaf = f(w.leaf);
    let elems: Vec<BaseElement> = w.path_elements.iter().map(|&v| f(v)).collect();
    let root = fold_path(leaf, &elems, &w.path_indices);

    assert_eq!(data.public_inputs.len(), 3, "C3: expected 3 public inputs");
    assert_eq!(data.public_inputs[0], w.leaf, "C3: leaf public input");
    assert_eq!(f(data.public_inputs[1]), root, "C3: root is not the real fold of the leaf up the path");
    assert_eq!(
        data.public_inputs[2], CANONICAL_DEPTH as u64,
        "C3: depth public input must be 12 — verify.rs rejects anything else in phase 2",
    );

    // Deterministic on purpose: this function re-derives the trace and compares
    // it against the proof's own public inputs, so prover and checker must draw
    // the same blinding region or every assertion below compares two different
    // traces. ⛔ It proves nothing about secrecy — only about SHAPE.
    let mask: Vec<BaseElement> =
        p01_stark::compact::c3_deterministic_probe_mask(w.path_elements.len())
            .into_iter()
            .map(f)
            .collect();
    let trace = merkle_path::build_merkle_trace(leaf, &elems, &w.path_indices, &mask);
    assert_eq!(trace[5][0], leaf, "C3: carry at row 0 must be the leaf");

    // 🚨 382, NOT 478. `(depth - 1) * 32 + 30` moved with the cut, and 478 now
    // sits INSIDE the blinding region — a masked row holding a fresh random
    // value. Left at 478 this would have compared the root against noise and
    // failed loudly, which is the good case; the bad case is the reader who
    // "fixes" it by deleting the assertion.
    const C3_ROW_ROOT: usize = (p01_stark::air::merkle_path::CANONICAL_DEPTH - 1) * 32 + 30;
    assert_eq!(C3_ROW_ROOT, 382);
    assert!(
        C3_ROW_ROOT < p01_stark::air::merkle_path::FIRST_FREE_ROW,
        "the root row must stay OUT of the blinding region",
    );
    assert_eq!(trace[0][C3_ROW_ROOT], root, "C3: boundary row 382 (root)");
    sweep_transitions(
        "C3",
        &trace,
        &merkle_path::build_merkle_path_periodic_columns(CANONICAL_DEPTH, trace[0].len()),
        merkle_path::MERKLE_PATH_NUM_CONSTRAINTS,
        merkle_path::evaluate_merkle_path_transition,
    );
}

pub fn check_semantics_4(w: &W4, data: &p01_stark::compact::GenericCompactProofData) {
    // C4's conservation law is enforced on chain, NOT in the AIR (see the
    // header of air/confidential_balance.rs). A non-conserving witness would
    // still produce a verifying proof — and would still not be an honest spend.
    assert_eq!(
        w.old_balance,
        w.new_balance + w.amount,
        "C4: the witness does not conserve value (old_balance != new_balance + amount). \
         The AIR does not check this, the on-chain program does — a liveness suite built \
         on a state the program refuses to create is measuring nothing.",
    );

    let owner = poseidon::hash2(f(w.spending_key), ZERO());
    let owner_mint = poseidon::hash2(owner, f(w.token_mint));
    let amount_hash = poseidon::hash2(f(w.amount), f(w.amount_salt));
    let old_bal_salt = poseidon::hash2(f(w.old_balance), f(w.old_salt));
    let old_commitment = poseidon::hash2(old_bal_salt, owner_mint);
    let new_bal_salt = poseidon::hash2(f(w.new_balance), f(w.new_salt));
    let new_commitment = poseidon::hash2(new_bal_salt, owner_mint);

    assert_eq!(data.public_inputs.len(), 4, "C4: expected 4 public inputs");
    assert_eq!(f(data.public_inputs[0]), old_commitment, "C4: old_commitment");
    assert_eq!(f(data.public_inputs[1]), new_commitment, "C4: new_commitment");
    assert_eq!(f(data.public_inputs[2]), amount_hash, "C4: amount_hash");
    assert_eq!(data.public_inputs[3], w.token_mint, "C4: token_mint");

    let (trace, _, _, _) = confidential_balance::build_confidential_balance_trace(
        f(w.spending_key), f(w.old_balance), f(w.old_salt), f(w.new_balance), f(w.new_salt),
        f(w.amount), f(w.amount_salt), f(w.token_mint),
    );
    assert_eq!(trace[0][94], amount_hash, "C4: boundary row 94 (amount_hash)");
    assert_eq!(trace[0][158], old_commitment, "C4: boundary row 158 (old_commitment)");
    assert_eq!(trace[0][222], new_commitment, "C4: boundary row 222 (new_commitment)");
    assert_eq!(trace[1][32], f(w.token_mint), "C4: cycle-1 right input must be token_mint");

    // [C4 INACTIVE-CYCLE CLASS] Cycle 7 (rows 224..=255) is documented as
    // "padding", and `verify_constraints_confidential_balance` has NO
    // `active_rows` bound — unlike C3 and C6, whose padding rows are frozen and
    // which therefore need one. The reason is that C4's cycle 7 is a REAL
    // Poseidon(0, 0), not a freeze: `build_confidential_balance_trace` calls
    // `run_hash(trace, 7, ZERO(), ZERO())`, and `round_flag` is 1 across all eight
    // cycles. So the rows ARE constrained and the honest trace satisfies them.
    // Pinned here so a future "optimisation" that freezes cycle 7 to save prover
    // time turns this red instead of turning honest C4 proofs into
    // `TransitionConstraintFailed` on chain.
    assert_eq!(
        trace[0][224], ZERO(),
        "C4: cycle 7 must START at Poseidon(0,0) — if this row is no longer zero the padding \
         cycle has been changed and verify_constraints_confidential_balance now needs the \
         active_rows bound that C3 and C6 carry",
    );
    assert_eq!(trace[1][224], ZERO(), "C4: cycle 7 right input must be 0");
    assert_ne!(
        trace[0][225], trace[0][224],
        "C4: cycle 7 must be a REAL hash, not a frozen copy — phase 1 demands \
         next == poseidon_round(current) on rows 224..=253 with no active_rows bound",
    );

    sweep_transitions(
        "C4",
        &trace,
        &confidential_balance::build_confidential_balance_periodic_columns(),
        confidential_balance::CONFIDENTIAL_BALANCE_NUM_CONSTRAINTS,
        confidential_balance::evaluate_confidential_balance_transition,
    );
}

pub fn check_semantics_5(w: &W5, data: &p01_stark::compact::GenericCompactProofData) {
    // >>> THE CHECK THAT WAS MISSING ON 2026-08-01 <<<
    //
    // `public_amount` is the only public input in the whole suite that the
    // generator does not derive from the witness, so it is the only one that can
    // disagree with the trace. The C5 AIR asserts
    //   acc(ROW_ACC_FINAL) == public_amount,  acc = out1 + out2 - in1 - in2
    // (constraints 23-26 in air/transfer.rs: `add_in*` subtracts an input,
    // `sub_out*` adds an output). Checked in u128 so the field cannot hide a
    // wrap.
    let ins = w.in_amount_1 as u128 + w.in_amount_2 as u128;
    let outs = w.out_amount_1 as u128 + w.out_amount_2 as u128;
    assert_eq!(
        outs,
        ins + w.public_amount as u128,
        "\n\n  >>> C5 WITNESS DOES NOT CONSERVE VALUE <<<\n  \
         out1 + out2 = {outs}, in1 + in2 = {ins}, public_amount = {}.\n  \
         The AIR asserts acc(row 385) == public_amount with acc = out - in, so the \
         conservation relation is off by {} units on this witness and the verifier is RIGHT \
         to reject it. This is the exact defect that was read as a liveness failure for a \
         full day.\n",
        w.public_amount,
        outs as i128 - ins as i128 - w.public_amount as i128,
    );

    let sk = f(w.spending_key);
    let mint = f(w.token_mint);
    let owner = poseidon::hash2(sk, ZERO());
    let owner_mint = poseidon::hash2(owner, mint);
    let in1_left = poseidon::hash2(f(w.in_amount_1), f(w.in_rand_1));
    let in_commitment_1 = poseidon::hash2(in1_left, owner_mint);
    let nullifier_1 = poseidon::hash2(in_commitment_1, owner);
    let in2_left = poseidon::hash2(f(w.in_amount_2), f(w.in_rand_2));
    let in_commitment_2 = poseidon::hash2(in2_left, owner_mint);
    let nullifier_2 = poseidon::hash2(in_commitment_2, owner);
    let out1_rm = poseidon::hash2(f(w.out_recipient_1), mint);
    let out1_left = poseidon::hash2(f(w.out_amount_1), f(w.out_rand_1));
    let out_commitment_1 = poseidon::hash2(out1_left, out1_rm);
    let out2_rm = poseidon::hash2(f(w.out_recipient_2), mint);
    let out2_left = poseidon::hash2(f(w.out_amount_2), f(w.out_rand_2));
    let out_commitment_2 = poseidon::hash2(out2_left, out2_rm);

    assert_eq!(data.public_inputs.len(), 6, "C5: expected 6 public inputs");
    assert_eq!(f(data.public_inputs[0]), nullifier_1, "C5: nullifier_1");
    assert_eq!(f(data.public_inputs[1]), nullifier_2, "C5: nullifier_2");
    assert_eq!(f(data.public_inputs[2]), out_commitment_1, "C5: output_commitment_1");
    assert_eq!(f(data.public_inputs[3]), out_commitment_2, "C5: output_commitment_2");
    assert_eq!(data.public_inputs[4], w.public_amount, "C5: public_amount");
    assert_eq!(data.public_inputs[5], w.token_mint, "C5: token_mint");

    let input_1 = transfer::TransferInput { amount: f(w.in_amount_1), randomness: f(w.in_rand_1) };
    let input_2 = transfer::TransferInput { amount: f(w.in_amount_2), randomness: f(w.in_rand_2) };
    let output_1 = transfer::TransferOutput {
        amount: f(w.out_amount_1), recipient: f(w.out_recipient_1), randomness: f(w.out_rand_1),
    };
    let output_2 = transfer::TransferOutput {
        amount: f(w.out_amount_2), recipient: f(w.out_recipient_2), randomness: f(w.out_rand_2),
    };
    let (trace, _, _, _, _, _, _) =
        transfer::build_transfer_trace(sk, mint, &input_1, &input_2, &output_1, &output_2, &p01_stark::compact::c5_deterministic_probe_mask().iter().map(|&v| BaseElement::new(v)).collect::<Vec<_>>());

    assert_eq!(trace[0][158], nullifier_1, "C5: boundary row 158 (nullifier_1)");
    assert_eq!(trace[0][254], nullifier_2, "C5: boundary row 254 (nullifier_2)");
    assert_eq!(trace[0][350], out_commitment_1, "C5: boundary row 350 (output_commitment_1)");
    assert_eq!(trace[0][446], out_commitment_2, "C5: boundary row 446 (output_commitment_2)");
    assert_eq!(trace[6][0], ZERO(), "C5: the accumulator must start at 0");
    // The literal AIR boundary assertion that the broken generator violated.
    assert_eq!(
        trace[6][transfer::ROW_ACC_FINAL], f(w.public_amount),
        "C5: acc(ROW_ACC_FINAL) != public_amount — the AIR's own value-conservation \
         boundary assertion does not hold on this witness",
    );

    sweep_transitions(
        "C5",
        &trace,
        &transfer::build_transfer_periodic_columns(),
        transfer::TRANSFER_NUM_CONSTRAINTS,
        transfer::evaluate_transfer_transition,
    );
}

pub fn check_semantics_6(w: &W6, data: &p01_stark::compact::GenericCompactProofData) {
    assert_eq!(
        w.path_elements.len(), C6_CANONICAL_DEPTH,
        "C6: depth must be the canonical 12 — C3 is still 15, they are different constants now",
    );
    assert_eq!(w.path_indices.len(), C6_CANONICAL_DEPTH, "C6: index count must match the path");

    let old_leaf = f(w.old_leaf);
    let new_leaf = f(w.new_leaf);
    let elems: Vec<BaseElement> = w.path_elements.iter().map(|&v| f(v)).collect();
    let old_root = fold_path(old_leaf, &elems, &w.path_indices);
    let new_root = fold_path(new_leaf, &elems, &w.path_indices);
    assert_ne!(
        old_root, new_root,
        "C6: old_leaf and new_leaf fold to the same root — the update is a no-op and the \
         suite would not exercise the NEW chain at all",
    );

    assert_eq!(data.public_inputs.len(), 5, "C6: expected 5 public inputs");
    assert_eq!(data.public_inputs[0], w.old_leaf, "C6: old_leaf");
    assert_eq!(data.public_inputs[1], w.new_leaf, "C6: new_leaf");
    assert_eq!(f(data.public_inputs[2]), old_root, "C6: old_root is not the real fold of old_leaf");
    assert_eq!(f(data.public_inputs[3]), new_root, "C6: new_root is not the real fold of new_leaf");
    assert_eq!(
        data.public_inputs[4], C6_CANONICAL_DEPTH as u64,
        "C6: depth public input must be 12 — verify.rs rejects anything else in phase 2",
    );

    // The mask is DETERMINISTIC here on purpose, and it has to be: this function
    // re-derives the trace and compares it against the proof's own public
    // inputs, so prover and checker must draw the same blinding region or every
    // assertion below is comparing two different traces.
    //
    // ⛔ That also means this call proves NOTHING about secrecy. What it proves
    // is the SHAPE: that the walk still lands where the boundary assertions say,
    // and that the transition sweep below still vanishes once 128 random rows
    // sit at the end of the trace.
    let mask: Vec<BaseElement> =
        p01_stark::compact::c6_deterministic_probe_mask(w.path_elements.len())
            .into_iter()
            .map(f)
            .collect();
    let trace = merkle_update::build_merkle_update_trace(
        old_leaf, new_leaf, &elems, &w.path_indices, &mask,
    );
    assert_eq!(trace[8][0], old_leaf, "C6: old carry at row 0 must be old_leaf");
    assert_eq!(trace[9][0], new_leaf, "C6: new carry at row 0 must be new_leaf");

    // 🚨 382, NOT 478. `(depth - 1) * 32 + 30` moved with the depth cut, and 478
    // is now INSIDE the blinding region -- a masked row carrying a fresh random
    // value. Left at 478 this pair of assertions would have compared the root
    // against noise and failed loudly, which is the good case; the bad case is
    // the reader who "fixes" it by deleting them.
    const ROW_ROOT: usize = (p01_stark::air::merkle_update::CANONICAL_DEPTH - 1) * 32 + 30;
    assert_eq!(ROW_ROOT, 382);
    assert!(ROW_ROOT < p01_stark::air::merkle_update::FIRST_FREE_ROW,
        "the root row must stay OUT of the blinding region");
    assert_eq!(trace[0][ROW_ROOT], old_root, "C6: boundary row 382 col 0 (old_root)");
    assert_eq!(trace[3][ROW_ROOT], new_root, "C6: boundary row 382 col 3 (new_root)");

    // ✅ AND THIS IS THE REAL MEASUREMENT IN THIS FUNCTION. The sweep evaluates
    // every one of the 19 constraints at every frame of the trace, including the
    // 128 masked rows, and demands they all vanish. The masked rows hold
    // unconstrained noise, so they vanish ONLY because `active` and
    // `not_boundary_active` switch the constraints off there. Break either gate
    // and this is what goes red -- on all 160 witnesses at once.
    sweep_transitions(
        "C6",
        &trace,
        &merkle_update::build_merkle_update_periodic_columns(C6_CANONICAL_DEPTH, trace[0].len()),
        merkle_update::MERKLE_UPDATE_NUM_CONSTRAINTS,
        merkle_update::evaluate_merkle_update_transition,
    );
}
