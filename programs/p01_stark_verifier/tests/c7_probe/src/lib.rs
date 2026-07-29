//! C7 phase-2 DEEP-ALI **compute-unit shape probe**.
//!
//! `docs/C7_SPEND_CIRCUIT_PLAN.md` Step 0 is a blocking gate: the largest
//! unknown in the whole C7 design is what the phase-2 DEEP-ALI instruction
//! will cost in compute units, bracketed somewhere between C5's phase 2 and
//! C3's phase 2 depending entirely on which periodic-evaluation strategy the
//! AIR ends up admitting. This program answers that question **before** the
//! AIR is written, by executing the same *arithmetic shape* on dummy inputs.
//!
//! It is not a verifier. It proves nothing, checks nothing, and must never be
//! deployed. It exists so that `tests/cu_budget.rs` can put a real
//! `compute_units_consumed` number next to the gate.
//!
//! # How faithfulness is achieved
//!
//! The field arithmetic and the baked periodic tables are the **real ones**,
//! pulled straight out of the verifier crate with `#[path]` module includes —
//! not copies. If `goldilocks.rs` changes, this probe changes with it.
//!
//! The four helper routines the shape depends on (`eval_periodic_stride16_at_z`,
//! `eval_periodic_at_z`, `batch_inverse`, `eval_one_hot_lagrange`,
//! `boundary_fold_at_ood`) are private to `verify.rs`, so they are transcribed
//! here verbatim, including their `#[inline(never)]` / `#[inline(always)]`
//! attributes — those attributes are load-bearing for SBF frame layout and
//! therefore for the CU number. Every transcription carries a `verify.rs:NNN`
//! citation. See `docs` on `probe_c7_phase2` for the honest list of deviations.
//!
//! # Anti-optimisation measures
//!
//! Two things would silently turn this into a measurement of nothing:
//!   * constant folding — so every input is read from instruction data at run
//!     time, never from a literal;
//!   * dead-code elimination — so every variant's result is fed to the
//!     `sol_log_64_` syscall, which the compiler cannot see through.
//!
//! # Instruction data
//!
//! `[0]`      variant selector (see `VARIANT_*`)
//! `[1..9]`   `z` seed, u64 LE — everything else is derived from it
//!
//! Accounts: none. The probe touches no state.

#![allow(dead_code)]
#![allow(unexpected_cfgs)]
#![allow(clippy::needless_range_loop)]

// ---------------------------------------------------------------------------
// The real verifier sources, included directly. No copies, no drift.
// ---------------------------------------------------------------------------

#[path = "../../../src/goldilocks.rs"]
pub mod goldilocks;

#[path = "../../../src/periodic_consts.rs"]
mod periodic_consts;

use goldilocks::{Felt, MODULUS};

// ---------------------------------------------------------------------------
// Syscalls. Declared by hand so this crate has ZERO cargo dependencies and
// cannot drag a different `solana-program` into the picture.
// ---------------------------------------------------------------------------

extern "C" {
    /// `sol_log_64_` — 100 CU, constant. Used as an optimisation barrier and
    /// to print a checksum so a run is reproducible.
    fn sol_log_64_(a: u64, b: u64, c: u64, d: u64, e: u64);

    /// `sol_sha256` — the syscall behind `solana_sha256_hasher::hashv`
    /// (solana-sha256-hasher-2.3.0/src/lib.rs:29 + :44-50), ~85 CU + a
    /// per-byte term. Note there is **no** trailing underscore on this one,
    /// unlike `sol_log_64_`; getting it wrong links a symbol the loader
    /// cannot resolve and the program aborts with "unsupported BPF
    /// instruction" after a few hundred CU. `vals` points at an array of
    /// `(ptr, len)` pairs, i.e. the memory layout of `&[&[u8]]`.
    fn sol_sha256(vals: *const u8, val_len: u64, hash_result: *mut u8) -> u64;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/// Entry + instruction-data parse + one `sol_log_64_`. Subtract this from
/// every other variant to get the cost of the arithmetic alone.
pub const VARIANT_BASELINE: u8 = 0;
/// The full C7 phase-2 shape as specified in the plan.
pub const VARIANT_C7_FULL: u8 = 1;
/// 5 × `eval_periodic_stride16_at_z` and nothing else.
pub const VARIANT_STRIDE16_X5: u8 = 2;
/// 1 × dense `eval_periodic_at_z` (512-coefficient Horner). Prices the plan's
/// "if one column ends up dense, add ~110K CU" risk.
pub const VARIANT_DENSE_X1: u8 = 3;
/// `z^512`, `inv(512)`, 5 × `g^row`, one `batch_inverse` over 5, 5 × Lagrange.
pub const VARIANT_LAGRANGE_BLOCK: u8 = 4;
/// The 18 transition constraints + the α-power RLC, nothing else.
pub const VARIANT_CONSTRAINTS_18: u8 = 5;
/// One `boundary_fold_at_ood` over 6 assertions.
pub const VARIANT_BOUNDARY_FOLD_6: u8 = 6;
/// `Z_T(z)` and the final inverse.
pub const VARIANT_ZT_AND_INV: u8 = 7;
/// A single `Felt::inv()` — Fermat exponentiation, the unit everything else
/// is priced against.
pub const VARIANT_ONE_INV: u8 = 8;
/// `VARIANT_C7_FULL` plus the two Fiat-Shamir α derivations (`rlc-c7`,
/// `bnd-c7`) that the real `verify_deep_ali_circuit_7` will also have to do.
pub const VARIANT_C7_FULL_PLUS_TRANSCRIPT: u8 = 9;

// ---------------------------------------------------------------------------
// Verbatim transcriptions of the private helpers in
// `programs/p01_stark_verifier/src/verify.rs`.
// ---------------------------------------------------------------------------

/// `verify.rs:53-67` — the trace-domain generator for a 512-row trace. C7 is
/// pinned to 512 rows by `C7_SPEND_CIRCUIT_PLAN.md:22`.
const GENERATOR_512: u64 = 0x1905D02A5C411F4E;

/// `verify.rs:1247-1254`. Dense Horner over N coefficients: N muls.
#[inline(never)]
fn eval_periodic_at_z(coeffs: &[u64], z: Felt) -> Felt {
    let mut acc = Felt::ZERO;
    for &c in coeffs.iter().rev() {
        acc = acc.mul(z).add(Felt::new(c));
    }
    acc
}

/// `verify.rs:1282-1303`. 36 muls instead of 512.
///
/// The `#[cfg(debug_assertions)]` stride-violation check in the original is
/// compiled out of the release build the verifier actually ships, so omitting
/// it here is faithful, not a shortcut.
#[inline(never)]
fn eval_periodic_stride16_at_z(coeffs: &[u64; 512], z: Felt) -> Felt {
    let y = z.exp(16);
    let mut acc = Felt::ZERO;
    let mut k = 32;
    while k > 0 {
        k -= 1;
        acc = acc.mul(y).add(Felt::new(coeffs[k * 16]));
    }
    acc
}

/// `verify.rs:1314-1345`. Montgomery batch inversion: 1 `inv` + 2(N-1) muls.
#[inline(never)]
fn batch_inverse(inputs: &[Felt], out: &mut [Felt]) -> bool {
    let n = inputs.len();
    if n == 0 {
        return true;
    }
    out[0] = inputs[0];
    for i in 1..n {
        if inputs[i] == Felt::ZERO {
            return false;
        }
        out[i] = out[i - 1].mul(inputs[i]);
    }
    if out[0] == Felt::ZERO {
        return false;
    }
    let mut running_inv = out[n - 1].inv();
    for i in (1..n).rev() {
        let prev_inv = running_inv.mul(inputs[i]);
        out[i] = running_inv.mul(out[i - 1]);
        running_inv = prev_inv;
    }
    out[0] = running_inv;
    true
}

/// `verify.rs:1361-1369`. Exactly 3 muls.
#[inline(always)]
fn eval_one_hot_lagrange(
    g_k: Felt,
    z_n_minus_one: Felt,
    inv_z_minus_g_k: Felt,
    inv_n: Felt,
) -> Felt {
    g_k.mul(z_n_minus_one).mul(inv_z_minus_g_k).mul(inv_n)
}

/// `verify.rs:264-269`.
struct BoundaryAssertion {
    col: usize,
    row: usize,
    value: Felt,
}

/// `verify.rs:1406-1452`, including the `[Felt; 32]` denominator arrays whose
/// capacity `C7_SPEND_CIRCUIT_PLAN.md:170` asks to be asserted against.
fn boundary_fold_at_ood(
    ood_current: &[Felt],
    assertions: &[BoundaryAssertion],
    z: Felt,
    z_t: Felt,
    g: Felt,
    alpha_bnd: Felt,
) -> Option<Felt> {
    let k = assertions.len();
    if k == 0 {
        return Some(Felt::ZERO);
    }
    let mut denoms = [Felt::ZERO; 32];
    if k > denoms.len() {
        return None;
    }
    let neg = Felt::new(MODULUS - 1);
    for (j, a) in assertions.iter().enumerate() {
        let g_r = g.exp(a.row as u64);
        let d = z.add(g_r.mul(neg));
        if d == Felt::ZERO {
            return None;
        }
        denoms[j] = d;
    }
    let mut inv_denoms = [Felt::ZERO; 32];
    if !batch_inverse(&denoms[..k], &mut inv_denoms[..k]) {
        return None;
    }

    let mut acc = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for (j, a) in assertions.iter().enumerate() {
        if a.col >= ood_current.len() {
            return None;
        }
        let num = ood_current[a.col].add(a.value.mul(neg));
        let term = num.mul(inv_denoms[j]);
        acc = acc.add(alpha_pow.mul(term));
        alpha_pow = alpha_pow.mul(alpha_bnd);
    }
    Some(acc.mul(z_t))
}

/// `verify.rs:121-125`.
fn vanishing_poly(x: Felt, trace_length: usize) -> Felt {
    let x_n = x.exp(trace_length as u64);
    x_n.sub(Felt::ONE)
}

/// `verify.rs:1774-1788`. One `sol_sha256_` over `trace_root || pub || tag`.
#[inline(never)]
fn derive_rlc_alpha_with_tag(trace_root: &[u8; 32], pub_bytes: &[u8], tag: &[u8; 8]) -> Felt {
    // C7's pub_bytes is 6 u64s = 48 bytes (`C7_SPEND_CIRCUIT_PLAN.md:54`), so
    // the whole transcript preimage is 32 + 48 + 8 = 88 bytes and fits in a
    // fixed buffer. The real verifier uses a `Vec`; the difference is a heap
    // allocation, not field arithmetic, and is called out in the report.
    let mut buf = [0u8; 128];
    let n = 32 + pub_bytes.len() + 8;
    buf[..32].copy_from_slice(trace_root);
    buf[32..32 + pub_bytes.len()].copy_from_slice(pub_bytes);
    buf[32 + pub_bytes.len()..n].copy_from_slice(tag);

    let mut hash = [0u8; 32];
    // `&[&[u8]]` is laid out as an array of (ptr, len) pairs.
    let seg: [(*const u8, u64); 1] = [(buf.as_ptr(), n as u64)];
    unsafe {
        sol_sha256(seg.as_ptr() as *const u8, 1, hash.as_mut_ptr());
    }
    let mut a = u64::from_le_bytes([
        hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7],
    ]) % MODULUS;
    if a == 0 {
        a = 1;
    }
    Felt::new(a)
}

// ---------------------------------------------------------------------------
// The C7 phase-2 shape
// ---------------------------------------------------------------------------

/// The five flag rows the proposed C7 layout needs a one-hot Lagrange term
/// for. Derived from `C7_SPEND_CIRCUIT_PLAN.md:38-50`:
///   row 0   `row0_flag`         — pins the Merkle carry to the hold column
///   row 30  cycle-0 output      — nullifier
///   row 62  cycle-1 output      — blind_hash
///   row 94  `commit_out_flag`   — pins the hold column to the commitment
///   row 478 Merkle root output
///
/// The exact row indices do not change the cost (each is one `g.exp(row)`,
/// which is a fixed 64-iteration square-and-multiply); the *count* does.
const C7_FLAG_ROWS: [u64; 5] = [0, 30, 62, 94, 478];

/// The number of transition constraints in the proposed C7 AIR
/// (`C7_SPEND_CIRCUIT_PLAN.md:44-50` plus the Merkle/commitment pipelines).
const C7_NUM_CONSTRAINTS: usize = 18;

/// Boundary assertions, from `C7_SPEND_CIRCUIT_PLAN.md:113-118`. Six, none of
/// which carries the commitment.
const C7_NUM_BOUNDARY: usize = 6;

/// Evaluate the C7 periodic columns at `z`.
///
/// Modelled on `compute_c5_periodic_at_z` (`verify.rs:2736-2845`) — including
/// its `#[inline(never)]`, which exists to keep the SBF per-frame stack under
/// 4 KB (`verify.rs:2877-2883`) and which `C7_SPEND_CIRCUIT_PLAN.md:166`
/// predicts C7 will need for the same reason.
///
/// The five 512-long tables are stand-ins: C7's own tables do not exist yet.
/// They are real baked tables of the right length and are evaluated with the
/// evaluator C7 is *designed* to be able to use (`stride16`), which is the
/// property being priced. Coefficient VALUES do not move the CU count —
/// `Felt::mul` is branch-free and `Felt::add`'s single branch costs 1 CU
/// either way.
#[inline(never)]
fn compute_c7_periodic_at_z(z: Felt) -> Option<[Felt; 10]> {
    use periodic_consts::{
        C6_IS_BOUNDARY_COEFFS, C6_RC0_COEFFS, C6_RC1_COEFFS, C6_RC2_COEFFS,
        C6_ROUND_ACTIVE_COEFFS,
    };

    let g_512 = Felt::new(GENERATOR_512);
    let n_felt = Felt::new(512);
    let inv_n = n_felt.inv();
    let z_n = z.exp(512);
    let z_n_minus_one = z_n.add(Felt::new(MODULUS - 1));

    let mut g_pows = [Felt::ZERO; 5];
    let mut diffs = [Felt::ZERO; 5];
    for i in 0..5 {
        let g_k = g_512.exp(C7_FLAG_ROWS[i]);
        g_pows[i] = g_k;
        diffs[i] = z.add(Felt::new(MODULUS - g_k.as_u64()));
    }
    let mut inv_diffs = [Felt::ZERO; 5];
    if !batch_inverse(&diffs, &mut inv_diffs) {
        return None;
    }

    let l0 = eval_one_hot_lagrange(g_pows[0], z_n_minus_one, inv_diffs[0], inv_n);
    let l1 = eval_one_hot_lagrange(g_pows[1], z_n_minus_one, inv_diffs[1], inv_n);
    let l2 = eval_one_hot_lagrange(g_pows[2], z_n_minus_one, inv_diffs[2], inv_n);
    let l3 = eval_one_hot_lagrange(g_pows[3], z_n_minus_one, inv_diffs[3], inv_n);
    let l4 = eval_one_hot_lagrange(g_pows[4], z_n_minus_one, inv_diffs[4], inv_n);

    Some([
        // 3 × rc, shared by both pipelines thanks to the all-16-cycles trick.
        eval_periodic_stride16_at_z(&C6_RC0_COEFFS, z),
        eval_periodic_stride16_at_z(&C6_RC1_COEFFS, z),
        eval_periodic_stride16_at_z(&C6_RC2_COEFFS, z),
        // round_flag + is_boundary, also stride-16 under the same trick.
        eval_periodic_stride16_at_z(&C6_ROUND_ACTIVE_COEFFS, z),
        eval_periodic_stride16_at_z(&C6_IS_BOUNDARY_COEFFS, z),
        // 5 one-hot flags.
        l0, l1, l2, l3, l4,
    ])
}

/// The 18 transition constraints at the OOD point, RLC-combined with `α^i`.
///
/// Column semantics follow the recommended layout at
/// `C7_SPEND_CIRCUIT_PLAN.md:31-41`:
///   0-2 Merkle Poseidon state · 3 sibling · 4 direction · 5 carry
///   6-8 commitment Poseidon state · 9 `commit_hold`
///
/// Shaped after `evaluate_transition_at_ood_circuit_6` (`verify.rs:1805-1903`),
/// which is the deployed width-10 two-pipeline precedent C7 copies: 3 `pow7`
/// per pipeline, 2 pipelines, then the mux / continuity / hold constraints.
#[inline(never)]
fn evaluate_transition_at_ood_circuit_7(
    ood_current: &[Felt; 10],
    ood_next: &[Felt; 10],
    periodic_at_z: &[Felt; 10],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_flag = periodic_at_z[3];
    let is_boundary = periodic_at_z[4];
    let row0_flag = periodic_at_z[5];
    let cycle0_out_flag = periodic_at_z[6];
    let cycle1_out_flag = periodic_at_z[7];
    let commit_out_flag = periodic_at_z[8];
    let hash_start = periodic_at_z[9];

    let one = Felt::ONE;
    let three = Felt::new(3);
    let not_boundary = one.sub(is_boundary);

    // ── Merkle Poseidon round (cols 0-2), 3 × pow7 ──
    let m0 = ood_current[0].add(rc0);
    let m1 = ood_current[1].add(rc1);
    let m2 = ood_current[2].add(rc2);
    let m0_7 = m0.pow7();
    let m1_7 = m1.pow7();
    let m2_7 = m2.pow7();
    let mro0 = three.mul(m0_7).add(m1_7).add(m2_7);
    let mro1 = m0_7.add(three.mul(m1_7)).add(m2_7);
    let mro2 = m0_7.add(m1_7).add(three.mul(m2_7));

    let mut cs = [Felt::ZERO; C7_NUM_CONSTRAINTS];
    cs[0] = not_boundary
        .mul(ood_next[0].sub(ood_current[0]).sub(round_flag.mul(mro0.sub(ood_current[0]))));
    cs[1] = not_boundary
        .mul(ood_next[1].sub(ood_current[1]).sub(round_flag.mul(mro1.sub(ood_current[1]))));
    cs[2] = not_boundary
        .mul(ood_next[2].sub(ood_current[2]).sub(round_flag.mul(mro2.sub(ood_current[2]))));

    // ── Commitment Poseidon round (cols 6-8), 3 × pow7 ──
    let c0 = ood_current[6].add(rc0);
    let c1 = ood_current[7].add(rc1);
    let c2 = ood_current[8].add(rc2);
    let c0_7 = c0.pow7();
    let c1_7 = c1.pow7();
    let c2_7 = c2.pow7();
    let cro0 = three.mul(c0_7).add(c1_7).add(c2_7);
    let cro1 = c0_7.add(three.mul(c1_7)).add(c2_7);
    let cro2 = c0_7.add(c1_7).add(three.mul(c2_7));

    cs[3] = not_boundary
        .mul(ood_next[6].sub(ood_current[6]).sub(round_flag.mul(cro0.sub(ood_current[6]))));
    cs[4] = not_boundary
        .mul(ood_next[7].sub(ood_current[7]).sub(round_flag.mul(cro1.sub(ood_current[7]))));
    cs[5] = not_boundary
        .mul(ood_next[8].sub(ood_current[8]).sub(round_flag.mul(cro2.sub(ood_current[8]))));

    // ── Merkle hash-start mux: state = mux(direction, carry, sibling) ──
    let sib = ood_current[3];
    let dir = ood_current[4];
    let carry = ood_current[5];
    cs[6] = hash_start.mul(ood_current[0].sub(carry).sub(dir.mul(sib.sub(carry))));
    cs[7] = hash_start.mul(ood_current[1].sub(sib).sub(dir.mul(carry.sub(sib))));
    cs[8] = hash_start.mul(ood_current[2]);

    // ── Carry update at the cycle boundary + continuity elsewhere ──
    cs[9] = is_boundary.mul(ood_next[5].sub(ood_current[0]));
    cs[10] = not_boundary.mul(ood_next[5].sub(ood_current[5]));

    // ── Sibling / direction continuity inside a cycle ──
    cs[11] = not_boundary.mul(ood_next[3].sub(ood_current[3]));
    cs[12] = not_boundary.mul(ood_next[4].sub(ood_current[4]));

    // ── Direction bit is binary ──
    cs[13] = hash_start.mul(dir).mul(one.sub(dir));

    // ── Commitment-pipeline chain edges (cycle 0 → 1 → 2) ──
    cs[14] = cycle0_out_flag.mul(ood_next[6].sub(ood_current[6]));
    // [15] hold column is globally constant  (plan line 47)
    cs[15] = ood_next[9].sub(ood_current[9]);
    // [16] hold column pinned to the commitment output at row 94 (plan line 48)
    cs[16] = commit_out_flag.mul(ood_current[9].sub(ood_current[6]));
    // [17] Merkle leaf pinned to the hold column at row 0 (plan line 49)
    cs[17] = row0_flag.mul(ood_current[5].sub(ood_current[9]));
    let _ = cycle1_out_flag;

    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// The full shape, in the order `verify_deep_ali_circuit_5`
/// (`verify.rs:2870-2941`) runs it.
///
/// # Deviations from what the real `verify_deep_ali_circuit_7` will do
///
/// Under-counted here (the real thing will cost slightly MORE):
///   * no `GenericCompactProof::from_bytes` — parsing happens in the caller
///     for the real instruction too, but the `ood_current_iter().collect()`
///     into two `Vec`s (`verify.rs:2887-2888`) is a heap allocation this
///     probe does not make;
///   * `VARIANT_C7_FULL` omits the two `derive_rlc_alpha_with_tag` transcript
///     hashes; `VARIANT_C7_FULL_PLUS_TRANSCRIPT` adds them back;
///   * no Anchor instruction dispatch, account deserialisation, or the
///     `public_inputs_hash` re-hash + compare in `lib.rs:267-275`.
///
/// Over- or equally counted:
///   * five distinct one-hot rows, i.e. a full 5-element `batch_inverse`;
///     if C7's real flag set collapses to fewer unique rows this is pessimistic;
///   * 18 constraints, the plan's own count, all of them non-trivial.
///
/// Everything the plan actually names in its Step-0 list is present exactly
/// once, with the real helpers.
#[inline(never)]
fn probe_c7_phase2(seed: u64, with_transcript: bool) -> u64 {
    let z = Felt::new(seed | 1);

    // 10 OOD current + 10 OOD next, derived from the seed so nothing folds.
    let mut ood_current = [Felt::ZERO; 10];
    let mut ood_next = [Felt::ZERO; 10];
    for i in 0..10 {
        ood_current[i] = Felt::new(seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(i as u64 + 1));
        ood_next[i] = Felt::new(seed.wrapping_mul(0xBF58476D1CE4E5B9).wrapping_add(i as u64 + 101));
    }

    let public_inputs: [u64; 6] = [
        seed ^ 0x11,
        seed ^ 0x22,
        seed ^ 0x33,
        seed ^ 0x44,
        seed ^ 0x55,
        seed ^ 0x66,
    ];
    let mut pub_bytes = [0u8; 48];
    for i in 0..6 {
        pub_bytes[i * 8..i * 8 + 8].copy_from_slice(&public_inputs[i].to_le_bytes());
    }
    let mut trace_root = [0u8; 32];
    for i in 0..32 {
        trace_root[i] = (seed >> ((i % 8) * 8)) as u8 ^ (i as u8);
    }

    let (alpha, alpha_bnd) = if with_transcript {
        (
            derive_rlc_alpha_with_tag(&trace_root, &pub_bytes, b"rlc-c7\0\0"),
            derive_rlc_alpha_with_tag(&trace_root, &pub_bytes, b"bnd-c7\0\0"),
        )
    } else {
        (Felt::new(seed | 3), Felt::new(seed | 5))
    };

    // 1. Periodic columns at z: 5 × stride-16, 1 × batch_inverse(5),
    //    5 × Lagrange, 1 × inv(512), 1 × z^512, 5 × g^row.
    let periodic_at_z = match compute_c7_periodic_at_z(z) {
        Some(p) => p,
        None => return 0,
    };

    // 2. The 18 constraints, 6 × pow7 across the two pipelines, RLC by α.
    let c_at_z = evaluate_transition_at_ood_circuit_7(&ood_current, &ood_next, &periodic_at_z, alpha);

    // 3. Z_T(z) = (z^n - 1) / (z - g^(n-1)) — one vanishing poly, one inverse.
    const TRACE_LENGTH_C7: usize = 512;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C7);
    let g = Felt::new(GENERATOR_512);
    let last_row_x = g.exp((TRACE_LENGTH_C7 - 1) as u64);
    let z_minus_last = z.add(Felt::new(MODULUS - last_row_x.as_u64()));
    if z_minus_last == Felt::ZERO {
        return 0;
    }
    let z_t = z_d.mul(z_minus_last.inv());

    // 4. Boundary fold over the 6 assertions of the proposed layout.
    let assertions = c7_boundary_assertions(&public_inputs);
    let c_bnd = match boundary_fold_at_ood(&ood_current, &assertions, z, z_t, g, alpha_bnd) {
        Some(v) => v,
        None => return 0,
    };
    let c_total = c_at_z.add(c_bnd);

    // 5. The identity itself.
    let ood_quotient = Felt::new(seed ^ 0xABCD_EF01_2345_6789);
    let rhs = ood_quotient.mul(z_t);
    c_total.as_u64() ^ rhs.as_u64()
}

/// `C7_SPEND_CIRCUIT_PLAN.md:113-118`. Public inputs are
/// `[nullifier, root, rh0, rh1, rh2, rh3]`; only the first two ever reach a
/// boundary assertion — the four recipient-hash felts are transcript-only.
fn c7_boundary_assertions(public_inputs: &[u64; 6]) -> [BoundaryAssertion; C7_NUM_BOUNDARY] {
    [
        BoundaryAssertion { col: 6, row: 30, value: Felt::new(public_inputs[0]) },
        BoundaryAssertion { col: 6, row: 64, value: Felt::new(public_inputs[0]) },
        BoundaryAssertion { col: 8, row: 0, value: Felt::ZERO },
        BoundaryAssertion { col: 8, row: 32, value: Felt::ZERO },
        BoundaryAssertion { col: 8, row: 64, value: Felt::ZERO },
        BoundaryAssertion { col: 0, row: 478, value: Felt::new(public_inputs[1]) },
    ]
}

// ---------------------------------------------------------------------------
// Component sub-probes
// ---------------------------------------------------------------------------

#[inline(never)]
fn probe_stride16_x5(seed: u64) -> u64 {
    use periodic_consts::{
        C6_IS_BOUNDARY_COEFFS, C6_RC0_COEFFS, C6_RC1_COEFFS, C6_RC2_COEFFS,
        C6_ROUND_ACTIVE_COEFFS,
    };
    let z = Felt::new(seed | 1);
    let a = eval_periodic_stride16_at_z(&C6_RC0_COEFFS, z);
    let b = eval_periodic_stride16_at_z(&C6_RC1_COEFFS, z);
    let c = eval_periodic_stride16_at_z(&C6_RC2_COEFFS, z);
    let d = eval_periodic_stride16_at_z(&C6_ROUND_ACTIVE_COEFFS, z);
    let e = eval_periodic_stride16_at_z(&C6_IS_BOUNDARY_COEFFS, z);
    a.as_u64() ^ b.as_u64() ^ c.as_u64() ^ d.as_u64() ^ e.as_u64()
}

#[inline(never)]
fn probe_dense_x1(seed: u64) -> u64 {
    let z = Felt::new(seed | 1);
    eval_periodic_at_z(&periodic_consts::C5_IS_BOUNDARY_COEFFS, z).as_u64()
}

#[inline(never)]
fn probe_lagrange_block(seed: u64) -> u64 {
    let z = Felt::new(seed | 1);
    let g_512 = Felt::new(GENERATOR_512);
    let inv_n = Felt::new(512).inv();
    let z_n = z.exp(512);
    let z_n_minus_one = z_n.add(Felt::new(MODULUS - 1));
    let mut g_pows = [Felt::ZERO; 5];
    let mut diffs = [Felt::ZERO; 5];
    for i in 0..5 {
        let g_k = g_512.exp(C7_FLAG_ROWS[i]);
        g_pows[i] = g_k;
        diffs[i] = z.add(Felt::new(MODULUS - g_k.as_u64()));
    }
    let mut inv_diffs = [Felt::ZERO; 5];
    if !batch_inverse(&diffs, &mut inv_diffs) {
        return 0;
    }
    let mut acc = Felt::ZERO;
    for i in 0..5 {
        acc = acc.add(eval_one_hot_lagrange(g_pows[i], z_n_minus_one, inv_diffs[i], inv_n));
    }
    acc.as_u64()
}

#[inline(never)]
fn probe_constraints_18(seed: u64) -> u64 {
    let mut ood_current = [Felt::ZERO; 10];
    let mut ood_next = [Felt::ZERO; 10];
    let mut periodic = [Felt::ZERO; 10];
    for i in 0..10 {
        ood_current[i] = Felt::new(seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(i as u64 + 1));
        ood_next[i] = Felt::new(seed.wrapping_mul(0xBF58476D1CE4E5B9).wrapping_add(i as u64 + 101));
        periodic[i] = Felt::new(seed.wrapping_mul(0x94D049BB133111EB).wrapping_add(i as u64 + 7));
    }
    let alpha = Felt::new(seed | 3);
    evaluate_transition_at_ood_circuit_7(&ood_current, &ood_next, &periodic, alpha).as_u64()
}

#[inline(never)]
fn probe_boundary_fold_6(seed: u64) -> u64 {
    let z = Felt::new(seed | 1);
    let g = Felt::new(GENERATOR_512);
    let z_t = Felt::new(seed | 7);
    let alpha_bnd = Felt::new(seed | 5);
    let mut ood_current = [Felt::ZERO; 10];
    for i in 0..10 {
        ood_current[i] = Felt::new(seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(i as u64 + 1));
    }
    let public_inputs: [u64; 6] = [seed ^ 0x11, seed ^ 0x22, 0, 0, 0, 0];
    let assertions = c7_boundary_assertions(&public_inputs);
    match boundary_fold_at_ood(&ood_current, &assertions, z, z_t, g, alpha_bnd) {
        Some(v) => v.as_u64(),
        None => 0,
    }
}

#[inline(never)]
fn probe_zt_and_inv(seed: u64) -> u64 {
    let z = Felt::new(seed | 1);
    let z_d = vanishing_poly(z, 512);
    let g = Felt::new(GENERATOR_512);
    let last_row_x = g.exp(511);
    let z_minus_last = z.add(Felt::new(MODULUS - last_row_x.as_u64()));
    if z_minus_last == Felt::ZERO {
        return 0;
    }
    z_d.mul(z_minus_last.inv()).as_u64()
}

#[inline(never)]
fn probe_one_inv(seed: u64) -> u64 {
    Felt::new(seed | 1).inv().as_u64()
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/// Raw SBF entrypoint. `cargo-build-sbf` links with `--entry=entrypoint`.
///
/// The serialised input for an instruction with ZERO accounts is:
///   `[0..8]`   num_accounts = 0 (u64 LE)
///   `[8..16]`  instruction_data_len (u64 LE)
///   `[16..]`   instruction data
///
/// Every probe sends no accounts, so this parse is exact and costs a handful
/// of CU, all of it captured by `VARIANT_BASELINE`.
///
/// # Safety
/// `input` is the runtime-provided buffer; the reads below stay within the
/// 8-byte header plus the 9 bytes of instruction data every caller sends.
#[no_mangle]
pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
    let num_accounts = core::ptr::read_unaligned(input as *const u64);
    if num_accounts != 0 {
        // Refuse rather than mis-parse: a caller that passes accounts would
        // shift the data offset and silently measure the wrong thing.
        return 1;
    }
    let data_len = core::ptr::read_unaligned(input.add(8) as *const u64) as usize;
    if data_len < 9 {
        return 2;
    }
    let data = core::slice::from_raw_parts(input.add(16), data_len);

    let variant = data[0];
    let mut seed_bytes = [0u8; 8];
    seed_bytes.copy_from_slice(&data[1..9]);
    let seed = u64::from_le_bytes(seed_bytes);

    let out = match variant {
        VARIANT_BASELINE => seed,
        VARIANT_C7_FULL => probe_c7_phase2(seed, false),
        VARIANT_STRIDE16_X5 => probe_stride16_x5(seed),
        VARIANT_DENSE_X1 => probe_dense_x1(seed),
        VARIANT_LAGRANGE_BLOCK => probe_lagrange_block(seed),
        VARIANT_CONSTRAINTS_18 => probe_constraints_18(seed),
        VARIANT_BOUNDARY_FOLD_6 => probe_boundary_fold_6(seed),
        VARIANT_ZT_AND_INV => probe_zt_and_inv(seed),
        VARIANT_ONE_INV => probe_one_inv(seed),
        VARIANT_C7_FULL_PLUS_TRANSCRIPT => probe_c7_phase2(seed, true),
        _ => return 3,
    };

    // Optimisation barrier: the compiler cannot elide a syscall, so `out`
    // (and therefore everything it depends on) must actually be computed.
    sol_log_64_(variant as u64, seed, out, 0, 0);
    0
}
