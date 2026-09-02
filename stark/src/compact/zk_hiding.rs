//! X1 and X2, measured — the two channels the simulator construction left open.
//!
//! # The two questions
//!
//! A random-oracle simulator `S` for this proof system was shown to produce a
//! transcript the verifier accepts with probability `~1 - 2^-54`, without a
//! witness. Two components of that transcript were left with their
//! indistinguishability UNPROVEN, and both reduce to the same underlying
//! question: how does the row mask reach the committed value?
//!
//! **X1 — the quotient's OOD split.** The verifier checks exactly one equation
//! on the `k = 8` claims `Q_0(z)..Q_7(z)`, so `S` samples seven uniform and
//! solves the eighth. The honest prover cannot: `segment_quotient_poly` slices
//! `Q`'s coefficients, and that decomposition is UNIQUE (if
//! `SUM_j x^(jn) r_j(x) = 0` with every `deg r_j < n`, then every `r_j = 0` by
//! induction on the blocks). So the honest seven are FORCED, and the question is
//! whether the forced values are distributed like uniform ones.
//!
//! **X2 — the leaves that are never opened.** Every Merkle tree here is
//! unsalted `SHA256(0x00 ‖ preimage)` over the WHOLE low-degree extension. A
//! trace tree has `LDE_SIZE / 2` pair leaves and a proof opens at most
//! `num_queries` of them — over 99% of every tree is hashed and never revealed.
//! In the random-oracle model a root hides its unopened preimages exactly as
//! well as those preimages are unguessable, so the security of the unsalted
//! commitment IS the min-entropy of a leaf, and that number was measured
//! nowhere.
//!
//! # Why one measurement answers both
//!
//! Both reduce to the DEGREE, in a single mask element, of the committed value:
//!
//!   * degree 0 — the mask does not reach it. Nothing is hidden.
//!   * degree 1 with a non-zero slope — the value is `a*m + b` with `a != 0` and
//!     `m` uniform, so the value is EXACTLY uniform on the field, whatever the
//!     rest of the mask and the whole witness are. That is a proof, not an
//!     estimate, and it is the strongest statement available here.
//!   * degree `d > 1` — the value moves with the mask, but its law is not pinned
//!     down by this argument. Non-constant, so not guessable outright; not
//!     uniform, so not proven indistinguishable either.
//!
//! So this file measures that degree, per committed value, per mask column, and
//! reports it. Where the answer is 1 the channel closes with a proof. Where it
//! is not, the file says so rather than rounding up.
//!
//! # Why `alpha` and `z` are supplied by the caller
//!
//! `Q` depends on the RLC challenge `alpha` and the OOD point `z`, and both are
//! Fiat-Shamir outputs of a transcript containing the trace root — so they move
//! when the mask moves, and the map `mask -> Q_j(z)` is not even well defined
//! along the production path. In the random-oracle model that dependence is
//! exactly what a simulator programs away: `alpha` and `z` are oracle outputs,
//! hence uniform and INDEPENDENT of their preimage, so the conditional law of
//! the mask given `alpha = a0, z = z0` is its unconditional law. Fixing them and
//! varying the mask is therefore the correct experiment, not a convenient one.
//!
//! This module is `#[cfg(test)]` in its entirety — no feature flag, so it cannot
//! reach a shipped blob and `wasmProbeScan` has nothing to find.
//!
//! Run: `cargo test -p p01-stark --release --lib zk_hiding -- --nocapture`
//!
//! # What followed X1 and X2
//!
//!   * X3 -- the DEEP composition, every committed FRI layer and the terminal,
//!     exhaustive over the committed domain.
//!   * X4 -- the published transcript's finite-difference rank. ⚠️ Read with S1:
//!     its additivity check never crossed rows inside a column, and the map is
//!     not affine there, so its rank is not the dimension of a subspace.
//!   * X5 -- the mask draw every other result is conditional on.
//!   * X6 -- the same degree result on eight distinct witnesses.
//!   * S1 -- the simulator, run: the verifier's seventeen equations written
//!     against the wire, the honest law shown uniform on exactly their solution
//!     set (61 blinding + 4 hidden-frame + 17 verifier = 82, on two witnesses),
//!     and witness-free transcripts passing every equation. It also names the
//!     four directions the verifier never checks: the quotient identity at each
//!     opened row, dead on chain since B7.

use super::*;
use crate::air::spend::{
    FIRST_FREE_ROW, LIFT_EXTRA_ROWS,
    build_spend_trace, CANONICAL_DEPTH, CONSTRAINED_TRACE_WIDTH, MASK_LEN, MASK_ROWS,
    RANDOMIZER_COL, TRACE_LENGTH, TRACE_WIDTH, ZK_LIFT_COL,
};

const LDE_SIZE: usize = TRACE_LENGTH * GENERIC_BLOWUP;
const K: usize = SPEND_QUOTIENT_SEGMENTS;

/// The number of coordinates the simulator samples uniform: `k - 1`. The last is
/// solved by the recombination the verifier actually checks.
const FREE: usize = K - 1;

// ---------------------------------------------------------------------------
// Field helpers. Goldilocks over u128 intermediates, independent of the
// winterfell implementation so a mistake here fails loudly instead of agreeing
// with the thing it is supposed to be checking.
// ---------------------------------------------------------------------------

const P: u128 = GOLDILOCKS_PRIME as u128;

#[inline]
fn fadd(a: u64, b: u64) -> u64 {
    (((a as u128) + (b as u128)) % P) as u64
}
#[inline]
fn fsub(a: u64, b: u64) -> u64 {
    (((a as u128) + P - (b as u128)) % P) as u64
}
#[inline]
fn fmul(a: u64, b: u64) -> u64 {
    (((a as u128) * (b as u128)) % P) as u64
}
fn fpow(mut a: u64, mut e: u64) -> u64 {
    let mut r = 1u64;
    while e > 0 {
        if e & 1 == 1 {
            r = fmul(r, a);
        }
        a = fmul(a, a);
        e >>= 1;
    }
    r
}
fn finv(a: u64) -> u64 {
    assert!(a != 0, "no inverse for 0");
    fpow(a, (P - 2) as u64)
}

/// Lagrange interpolation through `(xs, ys)`, returned as coefficients.
///
/// The DEGREE of the result is the measurement this whole file rests on, so this
/// returns the true coefficient vector rather than a fit truncated to an assumed
/// degree.
fn interpolate(xs: &[u64], ys: &[u64]) -> Vec<u64> {
    let n = xs.len();
    assert_eq!(n, ys.len());
    let mut coeffs = vec![0u64; n];
    for i in 0..n {
        let mut denom = 1u64;
        for j in 0..n {
            if j != i {
                denom = fmul(denom, fsub(xs[i], xs[j]));
            }
        }
        let scale = fmul(ys[i], finv(denom));

        // numerator = PROD_{j != i} (x - x_j), built one factor at a time.
        let mut poly = vec![0u64; n + 1];
        poly[0] = 1;
        let mut deg = 0usize;
        for j in 0..n {
            if j == i {
                continue;
            }
            let neg_xj = fsub(0, xs[j]);
            let mut next = vec![0u64; n + 1];
            for t in 0..=deg {
                next[t + 1] = fadd(next[t + 1], poly[t]);
                next[t] = fadd(next[t], fmul(poly[t], neg_xj));
            }
            poly = next;
            deg += 1;
        }
        for t in 0..n {
            coeffs[t] = fadd(coeffs[t], fmul(poly[t], scale));
        }
    }
    coeffs
}

/// Index of the top non-zero coefficient; `-1` for the zero polynomial, i.e. a
/// value the mask element does not move at all.
fn degree(coeffs: &[u64]) -> i32 {
    for i in (0..coeffs.len()).rev() {
        if coeffs[i] != 0 {
            return i as i32;
        }
    }
    -1
}

/// Rank over Goldilocks, by elimination.
fn rank(mut rows: Vec<Vec<u64>>) -> usize {
    if rows.is_empty() {
        return 0;
    }
    let cols = rows[0].len();
    let mut r = 0usize;
    for c in 0..cols {
        let Some(p) = (r..rows.len()).find(|&i| rows[i][c] != 0) else { continue };
        rows.swap(r, p);
        let inv = finv(rows[r][c]);
        for x in rows[r].iter_mut() {
            *x = fmul(*x, inv);
        }
        for i in 0..rows.len() {
            if i != r && rows[i][c] != 0 {
                let f = rows[i][c];
                for j in c..cols {
                    rows[i][j] = fsub(rows[i][j], fmul(f, rows[r][j]));
                }
            }
        }
        r += 1;
        if r == rows.len() {
            break;
        }
    }
    r
}

// ---------------------------------------------------------------------------
// The C7 pipeline, with the transcript challenges lifted out.
// ---------------------------------------------------------------------------

struct C7Internals {
    /// The committed trace LDE: `TRACE_WIDTH` columns of `LDE_SIZE`. These ARE
    /// the trace tree's leaf preimages, opened or not — which is what makes X2
    /// measurable here and nowhere else.
    trace_lde: Vec<Vec<BaseElement>>,
    /// The committed quotient LDE: `K` segments of `LDE_SIZE`.
    q_lde: Vec<Vec<u64>>,
    /// `Q_0(z) .. Q_{K-1}(z)` — the OOD claims X1 is about.
    q_ood: Vec<u64>,
    /// The DEEP composition over the LDE. These are FRI layer 0's values, and
    /// layer 0 is committed through the quotient root rather than a tree of its
    /// own — so every one of them is a preimage a verifier never sees.
    deep_lde: Vec<u64>,
    /// Committed FRI layers 1..=L-1, each one a tree of its own whose leaves are
    /// opened at `num_queries` positions and hashed at every other.
    fri_layers: Vec<Vec<u64>>,
    /// The terminal polynomial's coefficients. Unlike every layer above it these
    /// are sent IN THE CLEAR, all 32 of them, so a degree-0 answer here would not
    /// be a hiding weakness — it would be a published witness function.
    final_poly: Vec<u64>,
    /// `T_c(z)` and `T_c(z*g)` for every committed column. These go on the wire
    /// verbatim, so they belong to the published vector X4 takes the rank of.
    ood_trace: Vec<u64>,
    /// The public inputs the boundary fold binds. A function of the witness
    /// and not of the mask; S1 hands them to the simulator as public data.
    public_inputs: Vec<u64>,
}

/// One C7 witness, held fixed. Only the mask varies across calls in this file;
/// that is the entire experiment.
/// One C7 witness, addressed by seed.
///
/// ⛔ SEED 0 IS THE ORIGINAL, BYTE FOR BYTE. Every measurement written before
/// 2026-09-01 was validated on those exact inputs, so changing them to add a
/// second witness would have re-run the whole file against something it had
/// never been checked on and called the result the same measurement.
fn witness_for(
    seed: u64,
) -> (BaseElement, BaseElement, BaseElement, BaseElement, Vec<BaseElement>, Vec<u8>) {
    if seed == 0 {
        let pe: Vec<BaseElement> =
            (0..CANONICAL_DEPTH as u64).map(|i| BaseElement::new(1000 + i * 37)).collect();
        let bits: Vec<u8> = (0..CANONICAL_DEPTH).map(|i| (i % 2) as u8).collect();
        return (
            BaseElement::new(42),
            BaseElement::new(999),
            BaseElement::new(7),
            BaseElement::new(555),
            pe,
            bits,
        );
    }
    let mut z = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut next = || {
        z ^= z << 13;
        z ^= z >> 7;
        z ^= z << 17;
        z % GOLDILOCKS_PRIME
    };
    let a = BaseElement::new(next());
    let b = BaseElement::new(next());
    let c = BaseElement::new(next());
    let d = BaseElement::new(next());
    let pe: Vec<BaseElement> = (0..CANONICAL_DEPTH).map(|_| BaseElement::new(next())).collect();
    let bits: Vec<u8> = (0..CANONICAL_DEPTH).map(|_| (next() & 1) as u8).collect();
    (a, b, c, d, pe, bits)
}

fn c7_internals(
    mask: &[u64],
    alpha: BaseElement,
    alpha_bnd: BaseElement,
    z: BaseElement,
    witness: u64,
) -> C7Internals {
    assert_eq!(mask.len(), MASK_LEN);
    let (w0, w1, w2, w3, pe, bits) = witness_for(witness);
    let mask_felts: Vec<BaseElement> = mask.iter().map(|&v| BaseElement::new(v)).collect();

    let (trace, nullifier, root) = build_spend_trace(
        w0,
        w1,
        w2,
        w3,
        &pe,
        &bits,
        &mask_felts,
    );

    // The public inputs are a function of the WITNESS, not of the mask: the mask
    // lives in rows no constraint and no boundary assertion reads. If that ever
    // stopped holding, the boundary fold below would move for the wrong reason
    // and every degree in this file would be measuring the public inputs.
    let public_inputs: Vec<u64> = vec![nullifier.as_int(), root.as_int(), 11, 22, 33, 44];

    let lde = compute_lde_generic(&trace, GENERIC_BLOWUP);
    let lde_g = get_domain_generator_generic(LDE_SIZE);
    let trace_g = get_domain_generator_generic(TRACE_LENGTH);

    let mut q_poly = compute_quotient_lde_circuit_7(&lde, GENERIC_BLOWUP, TRACE_LENGTH, alpha);

    // [C2] The same boundary fold the production path applies, with the
    // challenge supplied rather than derived. Skipping it would measure a
    // quotient this prover never commits to.
    let assertions = boundary_assertions_for_circuit(7, &public_inputs);
    assert!(!assertions.is_empty(), "C7 must have boundary assertions to fold");
    let trace_polys: Vec<Vec<BaseElement>> =
        (0..TRACE_WIDTH).map(|c| inverse_ntt(&trace[c], trace_g)).collect();
    let mut qb_poly: Vec<BaseElement> = Vec::new();
    fold_boundary_quotient(&mut qb_poly, &trace_polys, &assertions, trace_g, alpha_bnd);
    if q_poly.len() < qb_poly.len() {
        q_poly.resize(qb_poly.len(), BaseElement::ZERO);
    }
    for (i, &c) in qb_poly.iter().enumerate() {
        q_poly[i] = q_poly[i] + c;
    }

    let segs = segment_quotient_poly(&q_poly, TRACE_LENGTH, LDE_SIZE, lde_g, K);
    let q_ood = segment_ood_values(&segs, z);

    // ── DEEP + FRI, with the fold challenges supplied for the same reason
    //    `alpha` and `z` are. Every alpha_i is a Fiat-Shamir output of a
    //    transcript containing the layer roots, so it moves when the mask moves
    //    and `mask -> layer_i` is not well defined along the production path. A
    //    simulator programs those oracle answers, which makes them uniform and
    //    independent of their preimage; fixing them and varying the mask is the
    //    correct experiment, exactly as the module header argues for `z`.
    let ood_current: Vec<u64> =
        (0..TRACE_WIDTH).map(|c| evaluate_poly(&trace_polys[c], z).as_int()).collect();
    let ood_next: Vec<u64> = (0..TRACE_WIDTH)
        .map(|c| evaluate_poly(&trace_polys[c], z * trace_g).as_int())
        .collect();

    let deep = deep_composition_lde(
        &lde,
        &segs.lde,
        &ood_current,
        &ood_next,
        &q_ood,
        z,
        trace_g,
        lde_g,
        BaseElement::new(GAMMA),
    );

    // The same loop `fri_commit_phase` runs, with `derive_fri_alpha` replaced by
    // the fixed table. The layer that reaches the terminal size is NOT committed
    // -- it ships as coefficients -- so it is excluded here for the same reason.
    let mut current = deep.clone();
    let mut cur_gen = lde_g;
    let mut cur_inv_shift = lde_coset_shift_inv();
    let mut fri_layers: Vec<Vec<u64>> = Vec::new();
    let mut i = 0usize;
    while current.len() > SPEND_FRI_FINAL_POLY_SIZE {
        let a = BaseElement::new(FRI_ALPHAS[i]);
        let folded = fri_fold_layer(&current, cur_gen, a, cur_inv_shift);
        cur_gen = cur_gen * cur_gen;
        cur_inv_shift = cur_inv_shift * cur_inv_shift;
        if folded.len() > SPEND_FRI_FINAL_POLY_SIZE {
            fri_layers.push(folded.iter().map(|f| f.as_int()).collect());
        }
        current = folded;
        i += 1;
    }
    let final_poly: Vec<u64> =
        inverse_ntt(&current, cur_gen).iter().map(|f| f.as_int()).collect();

    let mut ood_trace = ood_current.clone();
    ood_trace.extend_from_slice(&ood_next);

    C7Internals {
        trace_lde: lde,
        q_lde: segs.lde,
        q_ood,
        deep_lde: deep.iter().map(|f| f.as_int()).collect(),
        fri_layers,
        final_poly,
        ood_trace,
        public_inputs,
    }
}

/// A reproducible mask. Deliberately NOT a CSPRNG: the experiment needs the same
/// mask back on demand. The production draw is `draw_blinding_mask`, exercised
/// by `gen_proof` and the wasm path.
fn base_mask(seed: u64) -> Vec<u64> {
    let mut z = seed | 1;
    (0..MASK_LEN)
        .map(|_| {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            z % GOLDILOCKS_PRIME
        })
        .collect()
}

/// Flat index of the mask element at (blinding row `r`, constrained column `c`).
/// `[0 .. MASK_ROWS*CONSTRAINED_TRACE_WIDTH)` is row-major; the randomizer
/// column's own `TRACE_LENGTH` elements follow, then the lift column's extra
/// rows (`lift_extra_index`).
fn mask_index(row: usize, col: usize) -> usize {
    assert!(row < MASK_ROWS && col < CONSTRAINED_TRACE_WIDTH);
    row * CONSTRAINED_TRACE_WIDTH + col
}

/// Flat index of the `i`-th lift entry outside the row mask: trace row `i + 1`
/// of `ZK_LIFT_COL`, for `i < LIFT_EXTRA_ROWS` ([ZK-LIFT-FULL 2026-09-02]).
fn lift_extra_index(i: usize) -> usize {
    assert!(i < LIFT_EXTRA_ROWS);
    MASK_ROWS * CONSTRAINED_TRACE_WIDTH + TRACE_LENGTH + i
}

/// The DEEP batching coefficient, held fixed. See `c7_internals`.
const GAMMA: u64 = 0x0A5A_5A5A_1234_9E77;

/// Eight fold challenges: `log2(8192 / 32)`. Fixed for the same reason `GAMMA`
/// is, and distinct so a fold cannot accidentally be the identity.
const FRI_ALPHAS: [u64; 8] = [
    0x1111_1111_0000_0007,
    0x2222_2222_0000_0013,
    0x3333_3333_0000_001D,
    0x4444_4444_0000_0025,
    0x5555_5555_0000_0033,
    0x6666_6666_0000_003B,
    0x7777_7777_0000_0043,
    0x8888_8888_0000_0055,
];

const ALPHA: u64 = 0x1234_5678_9ABC_DEF0;
const ALPHA_BND: u64 = 0x0FED_CBA9_8765_4321;
const OOD_Z: u64 = 0xDEAD_BEEF_CAFE_1234;

fn run(mask: &[u64]) -> C7Internals {
    run_w(mask, 0)
}

/// The same pipeline on witness `w`. Seed 0 is what `run` uses.
fn run_w(mask: &[u64], w: u64) -> C7Internals {
    c7_internals(
        mask,
        BaseElement::new(ALPHA),
        BaseElement::new(ALPHA_BND),
        BaseElement::new(OOD_Z),
        w,
    )
}

/// Sweep ONE mask element over `points` distinct values and return, for each of
/// the `K` OOD claims, the polynomial it traces out.
fn sweep_ood(seed: u64, mask_slot: usize, points: usize) -> Vec<Vec<u64>> {
    let mut mask = base_mask(seed);
    let xs: Vec<u64> = (1..=points as u64).map(|i| i * 0x9E37_79B9 + 5).collect();
    let mut ys: Vec<Vec<u64>> = vec![Vec::with_capacity(points); K];
    for &x in xs.iter() {
        mask[mask_slot] = x;
        let out = run(&mask);
        for j in 0..K {
            ys[j].push(out.q_ood[j]);
        }
    }
    (0..K).map(|j| interpolate(&xs, &ys[j])).collect()
}

// ===========================================================================
// X2 — the leaves that are never opened
// ===========================================================================

/// The structural half of X2, and the one that is a PROOF rather than a sample.
///
/// Every trace-column value the prover commits is `S_c(x_p) = SUM_r T[c][r] *
/// L_r(x_p)`, an affine function of that column's trace entries whose
/// coefficient on row `r` is the Lagrange basis `L_r(x_p) = Z_T(x_p) / (Z_T'(g^r)
/// * (x_p - g^r))`. That coefficient is non-zero for EVERY committed position
/// `p` exactly when `Z_T(x_p) != 0`, i.e. when the LDE domain never meets the
/// trace domain.
///
/// That is what the coset shift buys, and it is the difference between "the
/// blinding rows hide the trace" and "the blinding rows hide the trace at most
/// positions". A subgroup LDE (`h = 1`) puts `blowup`-many committed positions
/// exactly on trace rows, where `Z_T = 0` kills every blinding coefficient at
/// once — the leak this repository already shipped once and fixed in B7.
#[test]
fn the_lde_domain_never_meets_the_trace_domain() {
    let h = lde_coset_shift().as_int();
    let lde_g = get_domain_generator_generic(LDE_SIZE).as_int();

    // x_p^n = h^n * (g^n)^p, and g^n has order LDE_SIZE / n = blowup, so the
    // whole question is settled by `blowup` values, not by LDE_SIZE of them.
    let hn = fpow(h, TRACE_LENGTH as u64);
    let gn = fpow(lde_g, TRACE_LENGTH as u64);
    assert_ne!(gn, 1, "g^n must have order blowup, not 1");

    let mut worst = u64::MAX;
    let mut v = hn;
    for p in 0..GENERIC_BLOWUP {
        let zt = fsub(v, 1); // Z_T(x_p) = x_p^n - 1
        assert_ne!(
            zt, 0,
            "LDE position class {p} lands ON the trace domain: Z_T(x_p) = 0, so every \
             blinding row's Lagrange coefficient vanishes there and the committed value at \
             those positions is a function of the WITNESS ALONE. That is the pre-B7 leak."
        );
        worst = worst.min(zt);
        v = fmul(v, gn);
    }

    println!();
    println!("X2 / structural — the LDE coset and the trace domain are disjoint.");
    println!("  coset shift h = {h}, blowup = {GENERIC_BLOWUP}, n = {TRACE_LENGTH}");
    println!("  min |Z_T(x_p)| over the {GENERIC_BLOWUP} position classes = {worst} (must be != 0)");
    println!("  => every trace-column leaf value is affine in that column's blinding rows");
    println!("     with ALL {MASK_ROWS} coefficients non-zero, at EVERY committed position.");
}

/// The empirical twin of the test above, on the values themselves.
///
/// For one blinding row of one constrained column, the committed trace value at
/// every one of the `LDE_SIZE` positions must be a degree-1 polynomial in that
/// mask element with a non-zero slope. Degree 1 and slope non-zero together mean
/// the value is EXACTLY uniform on the field, so an unopened trace leaf's
/// preimage carries `2 * TRACE_WIDTH * 64` bits of min-entropy and no adversary
/// can confirm a guess against the unsalted hash.
#[test]
fn every_committed_trace_value_is_exactly_uniform_in_one_blinding_element() {
    let slot = mask_index(0, 0);
    let mut mask = base_mask(0x5EED_0001);
    let xs: [u64; 3] = [11, 22, 33];
    let mut runs = Vec::new();
    for &x in xs.iter() {
        mask[slot] = x;
        runs.push(run(&mask));
    }

    let mut flat = 0usize;
    let mut nonlinear = 0usize;
    for p in 0..LDE_SIZE {
        let ys: Vec<u64> = runs.iter().map(|r| r.trace_lde[0][p].as_int()).collect();
        let c = interpolate(&xs, &ys);
        match degree(&c) {
            1 => {}
            -1 | 0 => flat += 1,
            _ => nonlinear += 1,
        }
    }

    println!();
    println!("X2 / trace tree — one blinding element vs all {LDE_SIZE} committed positions:");
    println!("  degree 1, slope != 0 : {}", LDE_SIZE - flat - nonlinear);
    println!("  constant (NO hiding) : {flat}");
    println!("  degree > 1           : {nonlinear}");

    assert_eq!(
        flat, 0,
        "{flat} committed positions of column 0 do not move when a blinding element moves. \
         At those positions the leaf preimage is a function of the witness alone, so an \
         adversary that guesses the witness confirms it against the unsalted leaf hash."
    );
    assert_eq!(
        nonlinear, 0,
        "{nonlinear} committed positions are NON-LINEAR in a single blinding element. The \
         trace LDE is an interpolation, which is affine by construction — a non-linear \
         answer here means this harness is not measuring the committed trace."
    );

    // The whole tree, and the fraction of it a proof ever reveals.
    let pair_leaves = LDE_SIZE / 2;
    let opened = SPEND_NUM_QUERIES;
    println!(
        "  the trace tree has {pair_leaves} pair leaves; a proof opens at most {opened} \
         ({:.2}% of the tree is hashed and never revealed)",
        100.0 * (pair_leaves - opened) as f64 / pair_leaves as f64,
    );
    println!(
        "  each unopened leaf preimage = 2 rows x {TRACE_WIDTH} columns, every element \
         exactly uniform"
    );
    println!("  => min-entropy per unopened trace leaf >= {} bits", 2 * TRACE_WIDTH * 63);
}

/// The randomizer column is a trace column too, so it must clear the same bar.
///
/// It enters no constraint, which is what keeps it free — but a column that is
/// free and also FLAT at some committed position would be publishing a constant
/// there, and the counting ledger would still read OK.
#[test]
fn the_randomizer_column_is_uniform_at_every_committed_position() {
    let slot = MASK_ROWS * CONSTRAINED_TRACE_WIDTH; // randomizer row 0
    let mut mask = base_mask(0x5EED_0002);
    let xs: [u64; 3] = [7, 19, 41];
    let mut runs = Vec::new();
    for &x in xs.iter() {
        mask[slot] = x;
        runs.push(run(&mask));
    }

    let mut bad = 0usize;
    for p in 0..LDE_SIZE {
        let ys: Vec<u64> = runs.iter().map(|r| r.trace_lde[RANDOMIZER_COL][p].as_int()).collect();
        if degree(&interpolate(&xs, &ys)) != 1 {
            bad += 1;
        }
    }
    println!();
    println!(
        "X2 / randomizer column {RANDOMIZER_COL} — {} of {LDE_SIZE} committed positions are \
         exactly uniform in one randomizer element",
        LDE_SIZE - bad,
    );
    assert_eq!(bad, 0, "{bad} committed randomizer positions are not degree-1 in the mask");
}

/// The quotient tree is the one X2 cannot close with the same argument.
///
/// `Q` is the constraint composition divided by the vanishing polynomial, and the
/// constraints reach degree 7 in the trace, so a quotient leaf is NOT affine in
/// the mask and the uniformity proof above does not transfer. What is measurable
/// is the degree, and whether the value moves at all.
#[test]
fn quotient_leaves_are_exactly_uniform_in_the_lift_column() {
    // Two sweeps, and the CONTRAST is the measurement. A Poseidon column
    // reaches every committed quotient value at degree 7 -- non-constant, so
    // not guessable, but not proven uniform either. The lift column reaches
    // the same values at degree 1, which IS a proof.
    // EXHAUSTIVE. This read 64 of 8192 until 2026-09-01, and the sampling was
    // never buying anything: `run` already computes every value, so the sample
    // only skipped interpolations of ten points. A claim about "every committed
    // quotient value" that checks 0.8% of them is a claim about the sample.
    let sample: Vec<usize> = (0..LDE_SIZE).collect();
    let xs: Vec<u64> = (1..=10u64).map(|i| i * 1_000_003 + 17).collect();

    let mut report: Vec<(usize, &str, std::collections::BTreeMap<i32, usize>)> = Vec::new();
    for (col, label) in [(0usize, "Poseidon state"), (ZK_LIFT_COL, "lift column")] {
        let slot = mask_index(0, col);
        let mut mask = base_mask(0x5EED_0003);
        let mut runs = Vec::new();
        for &x in xs.iter() {
            mask[slot] = x;
            runs.push(run(&mask));
        }
        let mut hist = std::collections::BTreeMap::<i32, usize>::new();
        for j in 0..K {
            for &p in sample.iter() {
                let ys: Vec<u64> = runs.iter().map(|r| r.q_lde[j][p]).collect();
                *hist.entry(degree(&interpolate(&xs, &ys))).or_insert(0) += 1;
            }
        }
        report.push((col, label, hist));
    }

    let total = K * sample.len();
    println!();
    println!("X2 / quotient tree - degree of a committed quotient value in ONE mask element:");
    for (col, label, hist) in report.iter() {
        println!("  mask column {col} ({label}):");
        for (d, n) in hist.iter() {
            let what = match d {
                -1 | 0 => "CONSTANT -- no hiding".to_string(),
                1 => "affine, EXACTLY uniform".to_string(),
                _ => format!("degree {d}, non-constant but law unproven"),
            };
            println!("    {n:5} of {total} samples : {what}");
        }
    }

    let lift = &report[1].2;
    assert_eq!(
        lift.get(&1).copied().unwrap_or(0),
        total,
        "the lift column does not reach every committed quotient value at degree 1: {lift:?}. Constraint [18] is what puts it there; without it the quotient tree has no uniformity proof at all, only 99.9% of it unopened and a degree-7 dependence on the row mask."
    );
    println!();
    println!("  => every committed quotient value is affine in a uniform mask element,");
    println!("     hence exactly uniform. The quotient tree closes on the same argument as");
    println!("     the trace tree, and X2 has no residue left on C7.");
}

// ===========================================================================
// X3 -- the DEEP composition, the FRI layers, and the terminal polynomial
// ===========================================================================

/// The channel `air/spend.rs` named and nothing measured, until now.
///
/// # What was actually open
///
/// X1 and X2 close the trace and quotient trees. Everything downstream of them
/// was carried by a COUNTING margin -- "247 published values against 512 random
/// ones" -- and the file that produced that number disclaimed it in the same
/// breath: it does not measure whether the available randomness has full RANK.
/// A count is not a distribution, and this repository has already been bitten
/// once by exactly that substitution (`air_aware_recovery_c1.rs`: 93 unknowns
/// against 110 equations was "more unknowns than equations", and the witness
/// came out anyway, because 35 of the rows were copies of others).
///
/// Three objects sit in that gap, and they are not equivalent:
///
///   * **The DEEP composition.** FRI layer 0. It is never given a tree of its
///     own -- the quotient root commits it -- so every one of its `LDE_SIZE`
///     values is a preimage no verifier ever sees.
///   * **The FRI layers.** Seven trees on C7, each unsalted
///     `SHA256(0x00 | preimage)` over its whole domain and opened at 22
///     positions. This is X2 again one abstraction lower, and it was the one
///     place where unsalted leaves met values with no uniformity measurement.
///   * **The terminal polynomial.** 32 coefficients sent IN THE CLEAR. A
///     degree-0 answer here would not be weak hiding, it would be a published
///     function of the witness.
///
/// # Why the answer is 1 everywhere, and why measuring it is still the point
///
/// The composition is affine in the trace and quotient values, whose degree X1
/// and X2 already pinned at 1; the fold `even + alpha*odd` is LINEAR in the
/// layer below it; and `inverse_ntt` is linear too. So degree 1 should survive
/// all the way down, and that argument is short enough to be suspicious of.
/// Short arguments about this prover have been wrong before -- the coset offset
/// was "obviously" applied and the Merkle depth was "obviously" 12 -- so the
/// chain is measured link by link rather than asserted end to end.
#[test]
fn deep_and_every_fri_layer_are_exactly_uniform_in_one_blinding_element() {
    let xs: Vec<u64> = (1..=10u64).map(|i| i * 1_000_003 + 17).collect();

    type Hist = std::collections::BTreeMap<i32, usize>;
    #[allow(clippy::type_complexity)]
    let mut report: Vec<(usize, &str, Hist, Vec<(usize, Hist)>, Hist, Hist)> = Vec::new();

    for (col, label) in [(0usize, "Poseidon state"), (ZK_LIFT_COL, "lift column")] {
        let slot = mask_index(0, col);
        let mut mask = base_mask(0x5EED_0007);
        let mut runs = Vec::new();
        for &x in xs.iter() {
            mask[slot] = x;
            runs.push(run(&mask));
        }

        // EXHAUSTIVE, for the same reason the quotient sweep above is: the
        // values are already in hand and the sample was only saving arithmetic.
        let mut deep_hist = Hist::new();
        for pos in 0..LDE_SIZE {
            let ys: Vec<u64> = runs.iter().map(|r| r.deep_lde[pos]).collect();
            *deep_hist.entry(degree(&interpolate(&xs, &ys))).or_insert(0) += 1;
        }

        let mut layer_hists: Vec<(usize, Hist)> = Vec::new();
        for l in 0..runs[0].fri_layers.len() {
            let n = runs[0].fri_layers[l].len();
            let mut h = Hist::new();
            for pos in 0..n {
                let ys: Vec<u64> = runs.iter().map(|r| r.fri_layers[l][pos]).collect();
                *h.entry(degree(&interpolate(&xs, &ys))).or_insert(0) += 1;
            }
            layer_hists.push((n, h));
        }

        // The terminal splits into two regions that mean OPPOSITE things, and
        // reporting them as one histogram is what made the first run of this
        // test look like a leak. Coefficients at or above
        // `SPEND_FRI_FINAL_POLY_DEGREE_BOUND` are identically zero BY
        // CONSTRUCTION -- that zero IS the degree bound FRI enforces, the
        // shipped prover asserts it (`compact.rs:5404`) and the verifier
        // re-checks it. A constant there carries no witness information because
        // it carries no information at all. Below the bound is the real
        // question.
        let mut term_live = Hist::new();
        let mut term_pad = Hist::new();
        for c in 0..runs[0].final_poly.len() {
            let ys: Vec<u64> = runs.iter().map(|r| r.final_poly[c]).collect();
            let d = degree(&interpolate(&xs, &ys));
            if c < SPEND_FRI_FINAL_POLY_DEGREE_BOUND {
                *term_live.entry(d).or_insert(0) += 1;
            } else {
                *term_pad.entry(d).or_insert(0) += 1;
                assert!(
                    runs.iter().all(|r| r.final_poly[c] == 0),
                    "terminal coefficient {c} is above the degree bound and NOT zero; FRI is \
                     not enforcing the bound this measurement assumes"
                );
            }
        }

        report.push((col, label, deep_hist, layer_hists, term_live, term_pad));
    }

    fn describe(d: &i32) -> String {
        match d {
            -1 | 0 => "CONSTANT -- no hiding".to_string(),
            1 => "affine, EXACTLY uniform".to_string(),
            _ => format!("degree {d}, non-constant but law unproven"),
        }
    }

    println!();
    println!("X3 / DEEP + FRI - degree of a committed value in ONE mask element:");
    for (col, label, deep, layers, term_live, term_pad) in report.iter() {
        println!("  mask column {col} ({label}):");
        for (d, n) in deep.iter() {
            println!("    DEEP (layer 0)  {n:6} of {LDE_SIZE} values : {}", describe(d));
        }
        for (i, (n, h)) in layers.iter().enumerate() {
            for (d, c) in h.iter() {
                println!(
                    "    FRI layer {}    {c:6} of {n:5} values : {}",
                    i + 1,
                    describe(d)
                );
            }
        }
        for (d, n) in term_live.iter() {
            println!(
                "    terminal, below the bound         {n:4} coeffs  : {}",
                describe(d)
            );
        }
        let pad: usize = term_pad.values().sum();
        println!("    terminal, above the bound         {pad:4} coeffs  : structurally zero");
    }

    fn all_one(h: &Hist) -> bool {
        h.len() == 1 && h.contains_key(&1)
    }

    let (_, _, deep, layers, term_live, term_pad) = &report[1];
    assert!(
        all_one(deep),
        "the DEEP composition is not affine in the lift column at every sampled position: {deep:?}"
    );
    for (i, (n, h)) in layers.iter().enumerate() {
        assert!(
            all_one(h),
            "FRI layer {} ({n} values) is not affine in the lift column: {h:?}",
            i + 1
        );
    }
    assert_eq!(
        term_live.values().sum::<usize>(),
        SPEND_FRI_FINAL_POLY_DEGREE_BOUND,
        "the live region of the terminal polynomial is not the degree bound"
    );
    assert!(
        all_one(term_live),
        "a terminal coefficient below the degree bound is not affine in the lift column: \
         {term_live:?}. All {SPEND_FRI_FINAL_POLY_DEGREE_BOUND} of them are transmitted in the \
         clear, so a constant among them is a published function of the witness."
    );
    // Measured, not assumed, and it is a check on the EXPERIMENT: the bound is
    // 2 and this sweep independently found exactly 2 moving coefficients out of
    // 32. Had the sweep been tracking something other than the shipped
    // pipeline, there is no reason it would have rediscovered the constant.
    assert_eq!(
        term_pad.keys().copied().collect::<Vec<i32>>(),
        vec![-1],
        "coefficients above the degree bound are not the zero polynomial: {term_pad:?}"
    );

    // THE CALIBRATION, AND IT IS NOT OPTIONAL. Every value in this pipeline is a
    // field element that moves when the mask moves, so "it changed" proves
    // nothing: an instrument that answered 1 unconditionally would pass all
    // three assertions above while measuring the mask's own arithmetic. The
    // Poseidon column reaches these same values too, and must NOT reach them at
    // degree 1 -- it enters through six multiplications. If this ever reads 1,
    // the sweep has stopped tracking the pipeline and the greens above are noise.
    let (_, _, ctrl_deep, ctrl_layers, ctrl_term, _) = &report[0];
    assert!(
        !all_one(ctrl_deep),
        "the control answered degree 1 through the Poseidon column: {ctrl_deep:?}. The \
         measurement is not distinguishing the lift column from an ordinary trace column, so \
         the assertions above are measuring nothing."
    );
    assert!(
        ctrl_layers.iter().any(|(_, h)| !all_one(h)) || !all_one(ctrl_term),
        "the control answered degree 1 on every FRI layer AND on the live terminal region"
    );

    println!();
    println!(
        "  => the DEEP composition, all {} committed FRI layers and all {} live terminal",
        layers.len(),
        term_live.values().sum::<usize>()
    );
    println!("     coefficients are affine in one uniform mask element, hence exactly uniform.");
    println!(
        "     The other {} terminal coefficients are the zero the degree bound forces.",
        term_pad.values().sum::<usize>()
    );
    println!("     X3 closes on the same argument as X1 and X2, and the counting margin is no");
    println!("     longer load-bearing anywhere in this proof.");
}

// ===========================================================================
// X6 -- the same answer on every witness
// ===========================================================================

/// How many distinct witnesses X6 repeats the measurement on. Seed 0 is the one
/// every other test in this file uses; 1.. are drawn from a reproducible stream.
const X6_WITNESSES: u64 = 8;

/// **Closing the "one witness" caveat, which is the one this file kept writing.**
///
/// Every result above is taken on a single witness, and that is a real limit
/// rather than a formality: a value could be affine in the mask for THIS secret
/// and not for another, and nothing measured so far would have seen it. Zero
/// knowledge is a statement about every witness, so a measurement on one is
/// evidence about one.
///
/// So this repeats the core degree measurement on `X6_WITNESSES` distinct
/// witnesses: different note secret, different nullifier preimage, different
/// amount, different blinding, different Merkle path elements and different
/// direction bits. If the answer is degree 1 on all of them, the property does
/// not depend on which secret is being hidden, which is what it has to mean.
///
/// ⚠️ THIS TEST CLOSES ONE AXIS AND ONLY ONE. It samples positions rather than
/// sweeping every committed value, because the exhaustive-over-positions result
/// is already established on witness 0 by X2 and X3 and repeating it eight times
/// would measure the same axis again at eight times the cost. Positions are
/// covered exhaustively there; witnesses are covered here. Neither test covers
/// both, and saying so is cheaper than implying it.
#[test]
fn every_witness_gives_the_same_answer() {
    let xs: Vec<u64> = (1..=10u64).map(|i| i * 1_000_003 + 17).collect();
    let slot = mask_index(0, ZK_LIFT_COL);
    let ctrl = mask_index(0, 0);

    // Spread across the trace tree, the quotient tree, DEEP and the FRI layers,
    // so a witness-dependent failure has nowhere in the pipeline to hide.
    let positions: Vec<usize> = (0..24).map(|i| i * (LDE_SIZE / 24) + 5).collect();

    let mut per_witness: Vec<(u64, std::collections::BTreeMap<i32, usize>)> = Vec::new();
    let mut control_seen: std::collections::BTreeSet<i32> = std::collections::BTreeSet::new();

    for w in 0..X6_WITNESSES {
        let mut hist = std::collections::BTreeMap::<i32, usize>::new();

        let mut runs = Vec::new();
        let mut base = base_mask(0x5EED_0006 ^ w);
        for &x in xs.iter() {
            base[slot] = x;
            runs.push(run_w(&base, w));
        }
        for &pos in positions.iter() {
            // ⛔ ONLY the lift column's own trace values. A mask element writes
            // into ONE column, so sweeping the lift element and then measuring
            // the other eleven columns reads them CONSTANT and calls it a
            // failure. The first run of this test did exactly that: 264 of 560
            // at degree 0, identical on every witness, which was the experiment
            // reaching for values it could not move. The other columns are
            // covered by their own element in the control sweep below.
            let ys: Vec<u64> =
                runs.iter().map(|r| r.trace_lde[ZK_LIFT_COL][pos].as_int()).collect();
            *hist.entry(degree(&interpolate(&xs, &ys))).or_insert(0) += 1;
            for j in 0..K {
                let ys: Vec<u64> = runs.iter().map(|r| r.q_lde[j][pos]).collect();
                *hist.entry(degree(&interpolate(&xs, &ys))).or_insert(0) += 1;
            }
            let ys: Vec<u64> = runs.iter().map(|r| r.deep_lde[pos]).collect();
            *hist.entry(degree(&interpolate(&xs, &ys))).or_insert(0) += 1;
        }
        for l in 0..runs[0].fri_layers.len() {
            let n = runs[0].fri_layers[l].len();
            for k in 0..8 {
                let pos = (k * (n / 8) + 3) % n;
                let ys: Vec<u64> = runs.iter().map(|r| r.fri_layers[l][pos]).collect();
                *hist.entry(degree(&interpolate(&xs, &ys))).or_insert(0) += 1;
            }
        }

        // The control, on the same witness: a Poseidon column must NOT read 1.
        let mut cbase = base_mask(0x5EED_0006 ^ w);
        let mut cruns = Vec::new();
        for &x in xs.iter() {
            cbase[ctrl] = x;
            cruns.push(run_w(&cbase, w));
        }
        // One sweep, two results. Column 0's own trace values must be degree 1
        // -- that is the per-column trace mechanism, checked here on every
        // witness rather than only on witness 0 -- while the QUOTIENT values it
        // reaches must not be, because a Poseidon column enters them through six
        // multiplications. A single element that satisfies both is the strongest
        // form the control can take.
        for &pos in positions.iter() {
            let ys: Vec<u64> = cruns.iter().map(|r| r.trace_lde[0][pos].as_int()).collect();
            *hist.entry(degree(&interpolate(&xs, &ys))).or_insert(0) += 1;
        }
        for &pos in positions.iter().take(4) {
            for j in 0..K {
                let ys: Vec<u64> = cruns.iter().map(|r| r.q_lde[j][pos]).collect();
                control_seen.insert(degree(&interpolate(&xs, &ys)));
            }
        }

        per_witness.push((w, hist));
    }

    println!();
    println!("X6 / witnesses - the same degree measurement on {X6_WITNESSES} distinct witnesses:");
    for (w, hist) in per_witness.iter() {
        let total: usize = hist.values().sum();
        let ones = hist.get(&1).copied().unwrap_or(0);
        let tag = if *w == 0 { " (the one every other test uses)" } else { "" };
        println!("  witness {w}{tag}: {ones} of {total} values at degree 1");
    }
    println!("  control degrees seen across all witnesses: {control_seen:?}");

    for (w, hist) in per_witness.iter() {
        let total: usize = hist.values().sum();
        assert_eq!(
            hist.get(&1).copied().unwrap_or(0),
            total,
            "witness {w} does not give degree 1 everywhere: {hist:?}. The hiding property \
             depends on WHICH secret is being hidden, which means it is not a property of the \
             construction and none of the other measurements in this file generalise."
        );
    }
    assert!(
        !control_seen.contains(&1),
        "the Poseidon control reached degree 1 on some witness: {control_seen:?}. The sweep is \
         not distinguishing the lift column from an ordinary trace column, so the assertions \
         above are measuring nothing."
    );

    println!();
    println!("  => the answer does not depend on the witness. The 'one witness' caveat is");
    println!("     closed for the degree result; the joint result in X4 and the exhaustive");
    println!("     position sweeps in X2 and X3 still run on witness 0 alone.");
}

// ===========================================================================
// X5 -- the mask itself
// ===========================================================================

/// Everything above assumes the mask is uniform. This is the one file that
/// checks it, and the assumption has been false in this crate before.
///
/// ⛔ X1 through X4 all measure the same shape: a committed value is `a*m + b`
/// with `a != 0`, therefore exactly uniform BECAUSE `m` is. Every one of those
/// results is conditional on the last three words. Until 2026-08-30 they were
/// false on the shipping path: `draw_blinding_mask` lived inside
/// `#[cfg(feature = "wasm")]`, so every non-wasm caller wrote its own mask and
/// each one wrote a DETERMINISTIC xorshift -- `bin/gen_proof.rs` seeded all four
/// of its arms with the same literal. A proof it emitted blinded nothing at all,
/// and no measurement in this file would have noticed, because they all take the
/// mask as given.
///
/// So this checks the three things that make the mask a mask:
///
///   1. **In-field by rejection, not by reduction.** `v % p` biases the low
///      2^32 of Goldilocks by a factor of two. The bias is statistically
///      invisible at any sample size a test can draw -- one input in 2^32 is
///      remapped -- so it is pinned at the SOURCE, where it is visible.
///   2. **Not deterministic.** Two draws must differ, and no value may repeat
///      inside one draw. A xorshift regression fails both.
///   3. **Balanced.** A grossly broken entropy source shows up in the bit
///      frequencies long before it shows up anywhere else.
///
/// And a structural scan, because the 08-30 defect was structural: every mask
/// the shipping binary binds must come from the CSPRNG, counted rather than
/// eyeballed.
#[test]
fn the_mask_every_other_measurement_assumes_is_uniform() {
    const GOLDILOCKS: u64 = 0xFFFF_FFFF_0000_0001;
    const N: usize = 4096;

    let a = crate::draw_blinding_mask(N).expect("the platform CSPRNG is unavailable");
    let b = crate::draw_blinding_mask(N).expect("the platform CSPRNG is unavailable");

    assert_eq!(a.len(), N);
    assert!(
        a.iter().chain(b.iter()).all(|&v| v < GOLDILOCKS),
        "a drawn value is outside Goldilocks; the rejection loop is not rejecting"
    );

    assert_ne!(
        a, b,
        "two consecutive draws are IDENTICAL. The mask is deterministic, and every uniformity \
         result in this file is conditional on it not being."
    );

    let uniq: std::collections::BTreeSet<u64> = a.iter().copied().collect();
    assert_eq!(
        uniq.len(),
        a.len(),
        "a value repeats inside one draw of {N}; on a 2^64 field the birthday probability of \
         that is about 2^-40, so it is a broken source, not luck"
    );

    // Bit frequencies. sigma of a proportion over 8192 samples is ~0.0055, so
    // 0.06 is an eleven-sigma gate: it cannot fire by chance and it catches a
    // stuck bit, a zero-filled buffer or a byte-order slip.
    let mut ones = [0usize; 64];
    for &v in a.iter().chain(b.iter()) {
        for (bit, slot) in ones.iter_mut().enumerate() {
            if (v >> bit) & 1 == 1 {
                *slot += 1;
            }
        }
    }
    let n = (a.len() + b.len()) as f64;
    let mut worst = (0usize, 0.5f64);
    for bit in 0..32 {
        let f = ones[bit] as f64 / n;
        if (f - 0.5).abs() > (worst.1 - 0.5).abs() {
            worst = (bit, f);
        }
        assert!(
            (f - 0.5).abs() < 0.06,
            "bit {bit} is 1 in {f:.4} of {n} draws; the entropy source is not balanced"
        );
    }

    // ── the structural half ────────────────────────────────────────────────
    const GEN: &str = include_str!("../bin/gen_proof.rs");
    let bindings = GEN.matches("let mask").count();
    let draws = GEN.matches("draw_blinding_mask").count();
    assert!(bindings > 0, "the scan found no mask binding at all in gen_proof.rs");
    assert_eq!(
        bindings, draws,
        "gen_proof.rs binds {bindings} masks but reaches the CSPRNG {draws} times. One of its \
         arms is building a mask some other way, which is exactly the 2026-08-30 defect: four \
         arms, four deterministic xorshifts, all seeded with the same literal."
    );

    println!();
    println!("X5 / the mask - the assumption every other result rests on:");
    println!("  drawn                  : {} values, all inside Goldilocks", 2 * N);
    println!("  distinct within a draw : {} of {N}", uniq.len());
    println!("  two draws differ       : yes");
    println!("  worst bit balance      : bit {} at {:.4}", worst.0, worst.1);
    println!("  gen_proof mask sources : {draws} CSPRNG draws for {bindings} bindings");
    println!();
    println!("  => the mask is drawn by rejection from the platform CSPRNG on every shipping");
    println!("     path, so X1..X4's 'because m is uniform' has something under it.");
    println!("     ⛔ This is a sanity floor, not a randomness certification: it would pass on");
    println!("     any decent PRNG, and the rejection-not-reduction property is pinned at the");
    println!("     source because no sample size can see a one-in-2^32 remap.");
}

// ===========================================================================
// X4 -- the published transcript, jointly
// ===========================================================================

/// How many query positions X4 folds into the published vector.
///
/// C7 ships 22. Each one contributes 54 field elements (12 trace columns and 8
/// quotient segments, each as a PAIR, plus a lo/hi pair on each of 7 FRI
/// layers), so the full transcript is 34 + 22*54 = 1222 values and needs at
/// least that many mask elements swept to have a chance at full rank. That run
/// exists -- raise this to 22 and the slot budget with it -- and it costs about
/// twelve minutes, which is why the default is two.
const X4_QUERIES: usize = 2;

/// Mask elements swept, spread across EVERY constrained column.
///
/// 🚨 The first run of this test swept 150 elements of the lift column alone and
/// read rank 55 of 142. That was the experiment failing, not the prover: the
/// published vector carries the opened pair values of all 12 trace columns, and
/// a mask element in column 10 moves column 10. The other 22 coordinates per
/// query were constant by construction, contributed zero rows, and capped the
/// rank at what one column can reach. A sweep must cover the columns whose
/// values it is taking the rank of.
const X4_SLOTS: usize = 150;

/// Extra elements drawn from the randomizer column, which lives past the row
/// mask in the flat slice and is committed without being constrained.
const X4_RANDOMIZER_SLOTS: usize = 20;

/// The mask element swept at step `i`: column-major over the constrained
/// columns so that every column is reached early, then the randomizer.
fn x4_slot(i: usize) -> usize {
    if i < X4_SLOTS {
        let col = i % CONSTRAINED_TRACE_WIDTH;
        let row = (i / CONSTRAINED_TRACE_WIDTH) % MASK_ROWS;
        mask_index(row, col)
    } else {
        MASK_ROWS * CONSTRAINED_TRACE_WIDTH + ((i - X4_SLOTS) * 7) % TRACE_LENGTH
    }
}

/// Assemble the field elements a verifier actually receives.
fn published_vector(r: &C7Internals, queries: &[usize]) -> Vec<u64> {
    let mut v: Vec<u64> = Vec::new();
    v.extend_from_slice(&r.ood_trace);
    v.extend_from_slice(&r.q_ood);
    v.extend_from_slice(&r.final_poly[..SPEND_FRI_FINAL_POLY_DEGREE_BOUND]);

    let half = LDE_SIZE / 2;
    for &pos in queries {
        let mirror = pos ^ half;
        for c in 0..TRACE_WIDTH {
            v.push(r.trace_lde[c][pos].as_int());
            v.push(r.trace_lde[c][mirror].as_int());
        }
        for j in 0..K {
            v.push(r.q_lde[j][pos]);
            v.push(r.q_lde[j][mirror]);
        }
        for layer in r.fri_layers.iter() {
            let n = layer.len();
            let j = pos % (n / 2);
            v.push(layer[j]);
            v.push(layer[j + n / 2]);
        }
    }
    v
}

/// **The step from "each value is uniform" to "the transcript is uniform".**
///
/// X1, X2 and X3 measure MARGINALS. Every committed value is exactly uniform in
/// one mask element, and every one of them could still be uniform while some
/// linear combination of them is CONSTANT -- in which case a distinguisher
/// computes that combination, gets the same answer from every honest proof, and
/// separates honest from simulated in one query. Marginal uniformity does not
/// exclude that. Rank does.
///
/// So this takes the published vector -- the OOD claims, the terminal
/// coefficients, and the opened pair values at each query position -- and
/// measures the rank of its slope matrix in the mask.
///
/// # The rank is NOT full, and what that does and does not mean
///
/// Measured, twice, and the two agree:
///
/// ```text
///   1 query :  88 published values, rank 80  -> deficiency  8
///   2 queries: 142 published values, rank 126 -> deficiency 16
/// ```
///
/// The deficiency is `queries * (committed FRI layers + 1)`, the count of fold
/// and terminal checks. That is a real regularity and this test pins it.
///
/// 🚨 IT IS NOT THE DIMENSION OF A SUBSPACE, AND UNTIL 2026-09-02 THIS COMMENT
/// SAID IT WAS. A slope matrix describes a map only where the map is affine.
/// The additivity check below pairs mask elements from DIFFERENT columns, and
/// the transition constraints raise a column's own values to the seventh power,
/// so two elements of the SAME column meet in a cross term the check never
/// saw: S1 measures that pair as non-additive on 70 of the 82 non-trace
/// coordinates. The rows below are finite differences on a curved set, their
/// rank is a secant rank, and "uniform on the 126-dimensional subspace the
/// verifier cuts out" did not follow from it. The verifier also has SEVENTEEN
/// equations on this vector, not sixteen -- the DEEP-ALI identity is the one
/// that is not linear -- and there are four more directions it never checks.
/// `a_simulator_with_no_witness_produces_the_verifier_s_own_law` is the
/// argument that holds; this test stays as the pin it always was.
///
/// ⛔ THE ADDITIVITY CHECK IS STILL NOT A FORMALITY -- it is what made the hole
/// visible once the right pair was tried. It stays here as it was, so the
/// history is readable next to the correction, and S1 carries the pairs that
/// matter: two lift rows, lift with randomizer, two randomizer rows, and two
/// rows of one constrained column.
#[test]
fn the_published_transcript_is_jointly_uniform() {
    let queries: Vec<usize> = (0..X4_QUERIES).map(|i| 137 + i * 1013).collect();

    let base = base_mask(0x5EED_00A4);
    let f0 = run(&base);
    let v0 = published_vector(&f0, &queries);
    let m = v0.len();

    let total_slots = X4_SLOTS + X4_RANDOMIZER_SLOTS;
    assert!(
        total_slots > m,
        "sweeping {total_slots} mask elements cannot establish rank {m}: the sweep, not the \
         pipeline, would be the binding constraint and a rank-deficient transcript would \
         still read as full rank"
    );

    // Slopes at a fixed baseline, one mask element at a time.
    let mut rows: Vec<Vec<u64>> = Vec::with_capacity(total_slots);
    for i in 0..total_slots {
        let slot = x4_slot(i);
        let mut mask = base.clone();
        mask[slot] = fadd(mask[slot], 1);
        let v = published_vector(&run(&mask), &queries);
        rows.push(v.iter().zip(v0.iter()).map(|(&a, &b)| fsub(a, b)).collect());
    }

    // ── additivity, before the rank means anything ──────────────────────────
    // One pair inside the row mask, one crossing columns, one reaching the
    // randomizer -- a cross term could hide in any of the three shapes.
    for (i, j) in [(0usize, 1usize), (3, 40), (17, X4_SLOTS + 5)] {
        let si = x4_slot(i);
        let sj = x4_slot(j);
        let mut both = base.clone();
        both[si] = fadd(both[si], 1);
        both[sj] = fadd(both[sj], 1);
        let vb = published_vector(&run(&both), &queries);
        for t in 0..m {
            let joint = fsub(vb[t], v0[t]);
            let apart = fadd(rows[i][t], rows[j][t]);
            assert_eq!(
                joint, apart,
                "the map is not additive at value {t} for mask elements ({i}, {j}): perturbing \
                 both differs from the sum of perturbing each. A cross term exists, the slope \
                 matrix does not describe the map, and the rank below would be measuring a \
                 linearization this prover does not implement."
            );
        }
    }

    let r = rank(rows);
    // Seven fold-consistency checks and one terminal check, per query. Derived
    // from the shape rather than pinned, so raising X4_QUERIES or changing the
    // fold schedule moves it without an edit here.
    let checks = X4_QUERIES * (f0.fri_layers.len() + 1);

    println!();
    println!("X4 / joint — the published transcript as a linear image of the mask:");
    println!("  query positions        : {queries:?}");
    println!("  published field values : {m}");
    println!("    OOD trace claims     : {}", f0.ood_trace.len());
    println!("    OOD quotient claims  : {}", f0.q_ood.len());
    println!("    terminal, live       : {SPEND_FRI_FINAL_POLY_DEGREE_BOUND}");
    println!(
        "    opened per query     : {} x {}",
        X4_QUERIES,
        (m - f0.ood_trace.len() - f0.q_ood.len() - SPEND_FRI_FINAL_POLY_DEGREE_BOUND)
            / X4_QUERIES.max(1)
    );
    println!("  mask elements swept    : {total_slots} across {CONSTRAINED_TRACE_WIDTH} columns + randomizer");
    println!("  additivity             : verified on 3 element pairs, all {m} values");
    println!("  verifier equations     : {checks} = {X4_QUERIES} x ({} folds + 1 terminal)", f0.fri_layers.len());
    println!("  rank                   : {r} of {m}, free dimension {}", m - checks);

    assert_eq!(
        r,
        m - checks,
        "the finite-difference rank of the published transcript is {r}, not {} = m - the fold and \
         terminal checks. This is a PIN on a measured regularity, not a uniformity claim -- see \
         the doc comment and S1. If it moved, either the fold schedule or the query count \
         changed, or the map changed shape; find out which before editing the number.",
        m - checks
    );

    println!();
    println!("  => finite-difference rank {r} = {m} - {checks} fold/terminal checks. A PIN, not a law:");
    println!("     the map is not affine across rows of one column (S1 measures the pair X4 never");
    println!("     tried), so this rank is a secant rank on a curved set. The argument that holds,");
    println!("     with the verifier's 17 equations and the 4 it never checks, is");
    println!("     a_simulator_with_no_witness_produces_the_verifier_s_own_law.");
}

// ===========================================================================
// S1 -- the simulator, run
// ===========================================================================
//
// Everything above MEASURES. This section ARGUES, and then executes the
// argument: it writes the verifier's equations against the wire, shows that
// the honest transcript is uniform on exactly their solution set, and then
// builds a transcript from public data alone -- no witness, no trace, no
// polynomial -- that passes every one of them through the same code path.
//
// The test's doc comment carries the argument, and the hole in X4 it closes.

/// Coordinates of the vector `published_vector` assembles, so the verifier's
/// equations can be written against the WIRE rather than against arrays only
/// the prover holds. A simulator has the wire and nothing else.
struct Wire {
    queries: Vec<usize>,
    layers: usize,
}

impl Wire {
    fn ood_cur(&self, c: usize) -> usize {
        c
    }
    fn ood_next(&self, c: usize) -> usize {
        TRACE_WIDTH + c
    }
    fn q_ood(&self, j: usize) -> usize {
        2 * TRACE_WIDTH + j
    }
    fn final_coeff(&self, i: usize) -> usize {
        2 * TRACE_WIDTH + K + i
    }
    fn per_query(&self) -> usize {
        2 * TRACE_WIDTH + 2 * K + 2 * self.layers
    }
    fn base(&self, q: usize) -> usize {
        2 * TRACE_WIDTH + K + SPEND_FRI_FINAL_POLY_DEGREE_BOUND + q * self.per_query()
    }
    fn trace_at(&self, q: usize, c: usize, mirror: bool) -> usize {
        self.base(q) + 2 * c + mirror as usize
    }
    fn quot_at(&self, q: usize, j: usize, mirror: bool) -> usize {
        self.base(q) + 2 * TRACE_WIDTH + 2 * j + mirror as usize
    }
    fn fri_at(&self, q: usize, l: usize, hi: bool) -> usize {
        self.base(q) + 2 * TRACE_WIDTH + 2 * K + 2 * l + hi as usize
    }
    fn len(&self) -> usize {
        self.base(self.queries.len())
    }
    /// The coordinates the constrained columns `0..ZK_LIFT_COL` own: their OOD
    /// claims and their opened pairs. Affine in the mask, and the block the
    /// argument conditions on.
    fn is_trace_block(&self, i: usize) -> bool {
        if i < 2 * TRACE_WIDTH {
            return (i % TRACE_WIDTH) < ZK_LIFT_COL;
        }
        for q in 0..self.queries.len() {
            let b = self.base(q);
            if i >= b && i < b + 2 * ZK_LIFT_COL {
                return true;
            }
        }
        false
    }
}

/// What the verifier has that the prover's secrets do not decide: the
/// challenges and the public inputs.
struct Public {
    alpha: BaseElement,
    alpha_bnd: BaseElement,
    z: BaseElement,
    gamma: BaseElement,
    fri_alphas: Vec<BaseElement>,
    public_inputs: Vec<u64>,
}

/// The DEEP composition at ONE opened point, from the wire. Mirrors
/// `deep_composition_lde` term for term and is checked against it below.
fn deep_at(v: &[u64], w: &Wire, p: &Public, q: usize, mirror: bool) -> BaseElement {
    let f = |i: usize| BaseElement::new(v[i]);
    let lde_g = get_domain_generator_generic(LDE_SIZE);
    let trace_g = get_domain_generator_generic(TRACE_LENGTH);
    let pos = w.queries[q] ^ if mirror { LDE_SIZE / 2 } else { 0 };
    let x = lde_coset_shift() * lde_g.exp(pos as u64);
    let z = p.z;
    let zg = z * trace_g;

    let mut gp: Vec<BaseElement> = Vec::with_capacity(TRACE_WIDTH + K);
    let mut g_pow = p.gamma;
    for _ in 0..TRACE_WIDTH + K {
        gp.push(g_pow);
        g_pow = g_pow * p.gamma;
    }
    let mut sv = BaseElement::ZERO;
    let mut svp = BaseElement::ZERO;
    let mut s_x = BaseElement::ZERO;
    for c in 0..TRACE_WIDTH {
        sv += gp[c] * f(w.ood_cur(c));
        svp += gp[c] * f(w.ood_next(c));
        s_x += gp[c] * f(w.trace_at(q, c, mirror));
    }
    let b0 = (svp - sv) * (zg - z).inv();
    let a0 = sv - z * b0;
    let mut q_acc = BaseElement::ZERO;
    for j in 0..K {
        q_acc += gp[TRACE_WIDTH + j] * (f(w.quot_at(q, j, mirror)) - f(w.q_ood(j)));
    }
    let den = x * x - (z + zg) * x + z * zg;
    (s_x - a0 - x * b0 + q_acc * (x - zg)) * den.inv()
}

/// The eight equations the verifier checks on ONE query -- seven folds and the
/// terminal -- each as `published value minus what the layer below implies`.
/// Written against the wire the way `verify_fri_generic` reads it, with the
/// fold arithmetic of `fri_fold_layer`.
fn fri_residuals(v: &[u64], w: &Wire, p: &Public, q: usize) -> Vec<BaseElement> {
    let lde_g = get_domain_generator_generic(LDE_SIZE);
    let pos = w.queries[q];
    let half = LDE_SIZE / 2;
    let two_inv = BaseElement::new(2).inv();

    // The smaller index of an opened pair sits at +y, the larger at -y.
    let (mut f_pos, mut f_neg) = if pos < half {
        (deep_at(v, w, p, q, false), deep_at(v, w, p, q, true))
    } else {
        (deep_at(v, w, p, q, true), deep_at(v, w, p, q, false))
    };
    let mut j = pos & (half - 1);
    let mut n = LDE_SIZE;
    let mut shift = lde_coset_shift();
    let mut gen = lde_g;
    let mut out = Vec::with_capacity(w.layers + 1);
    for l in 0..=w.layers {
        let y = shift * gen.exp(j as u64);
        let even = (f_pos + f_neg) * two_inv;
        let odd = (f_pos - f_neg) * two_inv * y.inv();
        let folded = even + p.fri_alphas[l] * odd;
        n /= 2;
        shift = shift * shift;
        gen = gen * gen;
        if l < w.layers {
            let lo = BaseElement::new(v[w.fri_at(q, l, false)]);
            let hi = BaseElement::new(v[w.fri_at(q, l, true)]);
            let published = if j < n / 2 { lo } else { hi };
            out.push(published - folded);
            f_pos = lo;
            f_neg = hi;
            j %= n / 2;
        } else {
            // The terminal layer is transmitted as coefficients over the
            // UNSHIFTED subgroup (`inverse_ntt(&current, cur_gen)` in
            // `c7_internals`), so it is evaluated at `gen^j`, not at the coset
            // point. Every coefficient past the degree bound is zero on the wire
            // by the verifier's `check_final_poly_degree_bound`.
            let mut coeffs = vec![BaseElement::ZERO; SPEND_FRI_FINAL_POLY_SIZE];
            for (i, c) in coeffs.iter_mut().enumerate().take(SPEND_FRI_FINAL_POLY_DEGREE_BOUND) {
                *c = BaseElement::new(v[w.final_coeff(i)]);
            }
            out.push(evaluate_poly(&coeffs, gen.exp(j as u64)) - folded);
        }
    }
    out
}

/// The unpublished evaluations the quotient identity at an opened row reads:
/// `T_c(g . x)` for each constrained column `c < ZK_LIFT_COL`, at every opened
/// position. A verifier never sees them; the argument conditions on them.
fn hidden_next_vector(r: &C7Internals, queries: &[usize]) -> Vec<u64> {
    let half = LDE_SIZE / 2;
    let mut v = Vec::new();
    for &pos in queries {
        for mirror in [false, true] {
            let p = pos ^ if mirror { half } else { 0 };
            let next = (p + GENERIC_BLOWUP) % LDE_SIZE;
            for c in 0..ZK_LIFT_COL {
                v.push(r.trace_lde[c][next].as_int());
            }
        }
    }
    v
}

/// C7's periodic columns at an arbitrary point, materialised exactly as
/// `compute_quotient_lde_circuit_7` materialises them.
fn c7_periodic_at(pt: BaseElement) -> Vec<BaseElement> {
    use crate::air::spend::build_spend_periodic_columns;
    let trace_g = get_domain_generator_generic(TRACE_LENGTH);
    build_spend_periodic_columns()
        .iter()
        .map(|col| {
            let full: Vec<BaseElement> = (0..TRACE_LENGTH).map(|i| col[i % col.len()]).collect();
            evaluate_poly(&inverse_ntt(&full, trace_g), pt)
        })
        .collect()
}

/// `C(x) / Z_T(x) + B(x) - SUM_j x^(jn) Q_j(x)` at one point `x`, from a
/// `current` frame, a `next` frame and the eight quotient values there. At `z`
/// this is the DEEP-ALI identity the verifier checks; at an opened LDE row it
/// is the same polynomial identity, which the verifier does NOT check.
fn quotient_identity_at(
    x: BaseElement,
    current: &[BaseElement],
    next: &[BaseElement],
    q_vals: &[BaseElement],
    p: &Public,
) -> BaseElement {
    use crate::air::spend::{evaluate_spend_transition, SPEND_NUM_CONSTRAINTS};
    let trace_g = get_domain_generator_generic(TRACE_LENGTH);
    let periodic = c7_periodic_at(x);
    let mut cs = vec![BaseElement::ZERO; SPEND_NUM_CONSTRAINTS];
    evaluate_spend_transition(current, next, &periodic, &mut cs);
    let c_x = rlc_combine(&cs, p.alpha);

    let g_last = trace_g.exp((TRACE_LENGTH - 1) as u64);
    let xn = x.exp(TRACE_LENGTH as u64);
    let z_t = (xn - BaseElement::ONE) * (x - g_last).inv();

    let mut b_x = BaseElement::ZERO;
    let mut a_pow = BaseElement::ONE;
    for &(col, row, val) in boundary_assertions_for_circuit(7, &p.public_inputs).iter() {
        b_x += a_pow * (current[col] - val) * (x - trace_g.exp(row as u64)).inv();
        a_pow = a_pow * p.alpha_bnd;
    }
    let mut q_x = BaseElement::ZERO;
    let mut xp = BaseElement::ONE;
    for &q in q_vals.iter() {
        q_x += xp * q;
        xp = xp * xn;
    }
    c_x * z_t.inv() + b_x - q_x
}

/// The DEEP-ALI identity at `z`, against the wire.
fn ood_identity(v: &[u64], w: &Wire, p: &Public) -> BaseElement {
    let f = |i: usize| BaseElement::new(v[i]);
    let cur: Vec<BaseElement> = (0..TRACE_WIDTH).map(|c| f(w.ood_cur(c))).collect();
    let nxt: Vec<BaseElement> = (0..TRACE_WIDTH).map(|c| f(w.ood_next(c))).collect();
    let qs: Vec<BaseElement> = (0..K).map(|j| f(w.q_ood(j))).collect();
    quotient_identity_at(p.z, &cur, &nxt, &qs, p)
}

/// The quotient identity at ONE opened row, from the wire plus the hidden
/// next-row frame at that position. Zero on every honest transcript; the
/// verifier never evaluates it.
fn local_identity(v: &[u64], hidden: &[u64], w: &Wire, p: &Public, q: usize, mirror: bool) -> BaseElement {
    let f = |i: usize| BaseElement::new(v[i]);
    let lde_g = get_domain_generator_generic(LDE_SIZE);
    let pos = w.queries[q] ^ if mirror { LDE_SIZE / 2 } else { 0 };
    let x = lde_coset_shift() * lde_g.exp(pos as u64);
    let cur: Vec<BaseElement> = (0..TRACE_WIDTH).map(|c| f(w.trace_at(q, c, mirror))).collect();
    let slot = (2 * q + mirror as usize) * ZK_LIFT_COL;
    let mut nxt: Vec<BaseElement> = vec![BaseElement::ZERO; TRACE_WIDTH];
    for c in 0..ZK_LIFT_COL {
        nxt[c] = BaseElement::new(hidden[slot + c]);
    }
    let qs: Vec<BaseElement> = (0..K).map(|j| f(w.quot_at(q, j, mirror))).collect();
    quotient_identity_at(x, &cur, &nxt, &qs, p)
}

/// Every equation the verifier holds the wire to, as one vector: the fold and
/// terminal checks of each query, then the DEEP-ALI identity.
fn verifier_residuals(v: &[u64], w: &Wire, p: &Public) -> Vec<u64> {
    let mut out: Vec<u64> = Vec::new();
    for q in 0..w.queries.len() {
        out.extend(fri_residuals(v, w, p, q).iter().map(|r| r.as_int()));
    }
    out.push(ood_identity(v, w, p).as_int());
    out
}

/// The verifier's equations restricted to `coords`, as a matrix `V` and a
/// right-hand side `rhs`, such that `V . t[coords] == rhs` is exactly
/// `verifier_residuals(t) == 0` for every `t` agreeing with `anchor` outside
/// `coords`. Built by unit perturbations, and only valid where the residuals
/// are affine in `coords` -- which the caller checks.
fn verifier_matrix(
    anchor: &[u64],
    coords: &[usize],
    w: &Wire,
    p: &Public,
) -> (Vec<Vec<u64>>, Vec<u64>) {
    let r0 = verifier_residuals(anchor, w, p);
    let m = r0.len();
    let mut cols: Vec<Vec<u64>> = Vec::with_capacity(coords.len());
    for &i in coords {
        let mut t = anchor.to_vec();
        t[i] = fadd(t[i], 1);
        let r = verifier_residuals(&t, w, p);
        cols.push((0..m).map(|k| fsub(r[k], r0[k])).collect());
    }
    let v: Vec<Vec<u64>> = (0..m).map(|k| cols.iter().map(|c| c[k]).collect()).collect();
    let rhs: Vec<u64> = (0..m).map(|k| fsub(0, r0[k])).collect();
    (v, rhs)
}

/// Reduced row echelon form over the field, with the pivot column of each
/// surviving row. Zero rows are dropped.
fn rref(rows: &[Vec<u64>], n: usize) -> (Vec<Vec<u64>>, Vec<usize>) {
    let mut a: Vec<Vec<u64>> = rows.to_vec();
    let m = a.len();
    let mut pivots: Vec<usize> = Vec::new();
    let mut r = 0usize;
    for c in 0..n {
        if r == m {
            break;
        }
        let Some(pr) = (r..m).find(|&k| a[k][c] != 0) else { continue };
        a.swap(r, pr);
        let inv = finv(a[r][c]);
        for x in a[r].iter_mut() {
            *x = fmul(*x, inv);
        }
        for k in 0..m {
            if k != r && a[k][c] != 0 {
                let f = a[k][c];
                for j in 0..n {
                    let t = fmul(f, a[r][j]);
                    a[k][j] = fsub(a[k][j], t);
                }
            }
        }
        pivots.push(c);
        r += 1;
    }
    a.truncate(r);
    (a, pivots)
}

/// A basis of `{ phi : row . phi == 0 for every row }`.
fn nullspace(rows: &[Vec<u64>], n: usize) -> Vec<Vec<u64>> {
    let (a, pivots) = rref(rows, n);
    let mut is_pivot = vec![false; n];
    for &c in pivots.iter() {
        is_pivot[c] = true;
    }
    let mut basis = Vec::new();
    for f in 0..n {
        if is_pivot[f] {
            continue;
        }
        let mut phi = vec![0u64; n];
        phi[f] = 1;
        for (k, &pc) in pivots.iter().enumerate() {
            phi[pc] = fsub(0, a[k][f]);
        }
        basis.push(phi);
    }
    basis
}

/// Reduce `phi` against an RREF: subtract each row times phi's entry at that
/// row's pivot, so the result is supported away from the pivots.
fn reduce_against(phi: &[u64], a: &[Vec<u64>], pivots: &[usize]) -> Vec<u64> {
    let mut out = phi.to_vec();
    for (k, &pc) in pivots.iter().enumerate() {
        if out[pc] != 0 {
            let f = out[pc];
            for j in 0..out.len() {
                let t = fmul(f, a[k][j]);
                out[j] = fsub(out[j], t);
            }
        }
    }
    out
}

/// Sample the affine solution set of `V x = rhs` uniformly: reduce to RREF,
/// draw every free coordinate from the field, solve the pivots. Panics if the
/// system is inconsistent, because a simulator that cannot satisfy the
/// verifier is not a simulator.
fn sample_solution(v: &[Vec<u64>], rhs: &[u64], rng: &mut u64) -> Vec<u64> {
    let n = v[0].len();
    let aug: Vec<Vec<u64>> = v
        .iter()
        .zip(rhs.iter())
        .map(|(row, &b)| {
            let mut r = row.clone();
            r.push(b);
            r
        })
        .collect();
    let (a, pivots) = rref(&aug, n + 1);
    assert!(
        !pivots.contains(&n),
        "the verifier's equations are inconsistent: no transcript satisfies them"
    );
    let mut is_pivot = vec![false; n];
    for &c in pivots.iter() {
        is_pivot[c] = true;
    }
    let mut x = vec![0u64; n];
    for c in 0..n {
        if !is_pivot[c] {
            *rng ^= *rng << 13;
            *rng ^= *rng >> 7;
            *rng ^= *rng << 17;
            x[c] = *rng % GOLDILOCKS_PRIME;
        }
    }
    for (k, &pc) in pivots.iter().enumerate() {
        let mut acc = a[k][n];
        for f in 0..n {
            if !is_pivot[f] && a[k][f] != 0 {
                acc = fsub(acc, fmul(a[k][f], x[f]));
            }
        }
        x[pc] = acc;
    }
    x
}

/// Human name of a wire coordinate.
fn coord_name(w: &Wire, i: usize) -> String {
    if i < TRACE_WIDTH {
        return format!("ood_cur[{i}]");
    }
    if i < 2 * TRACE_WIDTH {
        return format!("ood_next[{}]", i - TRACE_WIDTH);
    }
    if i < 2 * TRACE_WIDTH + K {
        return format!("q_ood[{}]", i - 2 * TRACE_WIDTH);
    }
    if i < 2 * TRACE_WIDTH + K + SPEND_FRI_FINAL_POLY_DEGREE_BOUND {
        return format!("final[{}]", i - 2 * TRACE_WIDTH - K);
    }
    for q in 0..w.queries.len() {
        let b = w.base(q);
        if i >= b && i < b + w.per_query() {
            let o = i - b;
            let side = if o % 2 == 0 { "pos" } else { "mir" };
            if o < 2 * TRACE_WIDTH {
                return format!("q{q}.trace[{}].{side}", o / 2);
            }
            let o = o - 2 * TRACE_WIDTH;
            if o < 2 * K {
                return format!("q{q}.quot[{}].{side}", o / 2);
            }
            let o = o - 2 * K;
            return format!("q{q}.fri[{}].{}", o / 2, if o % 2 == 0 { "lo" } else { "hi" });
        }
    }
    format!("?{i}")
}

/// One honest run at `mask`, as the published vector and the hidden next-row
/// frames side by side.
fn wire_and_hidden(mask: &[u64], queries: &[usize], witness: u64) -> (Vec<u64>, Vec<u64>) {
    let r = run_w(mask, witness);
    (published_vector(&r, queries), hidden_next_vector(&r, queries))
}

/// The slope, in one mask element, of the published vector and of the hidden
/// frames.
fn slope_pair(
    base: &[u64],
    slot: usize,
    v0: &[u64],
    h0: &[u64],
    queries: &[usize],
    witness: u64,
) -> (Vec<u64>, Vec<u64>) {
    let mut mask = base.to_vec();
    mask[slot] = fadd(mask[slot], 1);
    let (v, h) = wire_and_hidden(&mask, queries, witness);
    (
        v.iter().zip(v0.iter()).map(|(&a, &b)| fsub(a, b)).collect(),
        h.iter().zip(h0.iter()).map(|(&a, &b)| fsub(a, b)).collect(),
    )
}

/// How many independent baselines the conditional rank is measured at. A rank
/// is a generic property and one baseline would do for a generic point; two
/// is the cheapest way to show the first was not special. Baseline `b > 0`
/// runs on witness `3 * b` under a different mask, so the joint result is not
/// a statement about one witness.
const S1_BASELINES: u64 = 2;

/// The public side of one run: the fixed challenges plus that run's public
/// inputs, which the boundary fold binds and a simulator is handed.
fn public_for(public_inputs: &[u64]) -> Public {
    Public {
        alpha: BaseElement::new(ALPHA),
        alpha_bnd: BaseElement::new(ALPHA_BND),
        z: BaseElement::new(OOD_Z),
        gamma: BaseElement::new(GAMMA),
        fri_alphas: FRI_ALPHAS.iter().map(|&a| BaseElement::new(a)).collect(),
        public_inputs: public_inputs.to_vec(),
    }
}

/// Mask elements swept per constrained column in step 1. Each column
/// publishes six evaluations and hides four more at the opened rows; eleven
/// elements is one more than the ten that have to come out independent.
const S1_PER_COLUMN: usize = 11;

/// **The simulator, executed against the verifier's own equations.**
///
/// # The argument
///
/// Split the wire into the *trace block* -- the OOD claims and opened pairs of
/// the constrained columns `0..10` -- and the *rest*: the lift and randomizer
/// columns' claims and openings, the quotient claims and openings, every FRI
/// pair, and the terminal. Beside the wire sit forty values nobody publishes:
/// the constrained columns' *next-row* evaluations `T_c(g x)` at each opened
/// row, which the quotient identity at that row reads. Then:
///
/// 1. The trace block and the hidden next-row frames together are an affine,
///    full-rank image of the constrained columns' mask rows -- ten evaluations
///    per column, from 160 free rows -- so they are **jointly exactly
///    uniform**, and the hidden frames are independent of everything published.
/// 2. **Conditional on the block and the hidden frames**, the rest is affine
///    in the lift and randomizer elements. Its rank, plus the rank of the
///    verifier's equations, falls exactly **four** short of the rest -- and
///    the four missing directions are named: they are the quotient identity
///    `Q(x) = C(x)/Z_T(x) + B(x)` at each of the four opened rows, which the
///    on-chain verifier stopped evaluating when B7 killed the per-query arm.
///    The honest prover satisfies it anyway, and its right-hand side is affine
///    in the hidden frames with full rank four.
/// 3. So, given the block: the four unchecked directions are uniform because
///    the hidden frames are, and the remaining sixty-one are uniform because
///    the lift and randomizer are. The honest rest is uniform on **exactly the
///    verifier's solution set**. A simulator that samples that set needs the
///    equations and nothing else; it is built below and run through the same
///    residual functions the honest transcript is checked with.
///
/// # What is still not covered
///
/// The oracle is programmed: `z`, `gamma` and every fold challenge are held
/// fixed and the Merkle roots are not modelled, which is the random-oracle
/// model this whole file argues in. The grinding nonce and the derivation of
/// query positions are outside it. Two witnesses, one query set.
///
/// ⚠️ THE HOLE THIS CLOSES IN X4. X4 checked additivity on three mask-element
/// pairs, all in DIFFERENT columns. The transition constraints raise a column's
/// own values to the seventh power, so two mask elements in the SAME column
/// meet in a cross term, and the transcript is NOT affine in those directions
/// (measured below: non-additive on 70 rest coordinates). X4's rank of 126 is
/// a rank of finite differences, not of a linear map, and "uniform on a
/// 126-dimensional subspace" did not follow from it. This test reaches the
/// same conclusion by conditioning on the block first, where the map is
/// affine, and by naming what the verifier leaves unchecked.
#[test]
fn a_simulator_with_no_witness_produces_the_verifier_s_own_law() {
    let queries: Vec<usize> = (0..X4_QUERIES).map(|i| 137 + i * 1013).collect();
    let base = base_mask(0x5EED_0051);
    let f0 = run(&base);
    let v0 = published_vector(&f0, &queries);
    let h0 = hidden_next_vector(&f0, &queries);
    let w = Wire { queries: queries.clone(), layers: f0.fri_layers.len() };
    let p = public_for(&f0.public_inputs);
    let m = w.len();
    assert_eq!(m, v0.len(), "the wire layout and published_vector disagree");
    let n_pos = 2 * queries.len();
    assert_eq!(h0.len(), n_pos * ZK_LIFT_COL);

    // ── control A: the equations written here ARE the pipeline's ────────────
    for q in 0..queries.len() {
        for mirror in [false, true] {
            let pos = queries[q] ^ if mirror { LDE_SIZE / 2 } else { 0 };
            assert_eq!(
                deep_at(&v0, &w, &p, q, mirror).as_int(),
                f0.deep_lde[pos],
                "deep_at disagrees with deep_composition_lde at position {pos}: the equations \
                 below would be checking a verifier this prover does not face"
            );
            assert_eq!(
                local_identity(&v0, &h0, &w, &p, q, mirror),
                BaseElement::ZERO,
                "the quotient identity does not hold at opened position {pos}: the identity is \
                 transcribed wrongly, or the committed quotient is not C/Z_T + Q_b"
            );
        }
    }
    let r_honest = verifier_residuals(&v0, &w, &p);
    let n_eq = r_honest.len();
    assert!(
        r_honest.iter().all(|&r| r == 0),
        "the honest transcript fails the equations as written: {r_honest:?}. Either the fold, \
         the terminal or the DEEP-ALI identity is transcribed wrongly, and nothing below means \
         anything until it is not."
    );
    assert_eq!(n_eq, queries.len() * (w.layers + 1) + 1);

    // ── control B: none of the equations is vacuous ─────────────────────────
    {
        let mut t = v0.clone();
        t[w.fri_at(0, 3, false)] = fadd(t[w.fri_at(0, 3, false)], 1);
        assert!(verifier_residuals(&t, &w, &p).iter().any(|&r| r != 0), "a FRI opening moved and no fold noticed");
        let mut t = v0.clone();
        t[w.q_ood(0)] = fadd(t[w.q_ood(0)], 1);
        let r = verifier_residuals(&t, &w, &p);
        assert_ne!(r[n_eq - 1], 0, "Q_0(z) moved and the DEEP-ALI identity did not");
        let mut t = v0.clone();
        t[w.final_coeff(1)] = fadd(t[w.final_coeff(1)], 1);
        assert!(verifier_residuals(&t, &w, &p).iter().any(|&r| r != 0), "the terminal moved and no check noticed");
        let mut t = v0.clone();
        t[w.quot_at(1, 2, true)] = fadd(t[w.quot_at(1, 2, true)], 1);
        assert_ne!(local_identity(&t, &h0, &w, &p, 1, true), BaseElement::ZERO, "a quotient opening moved and the local identity did not");
    }

    let trace_block: Vec<usize> = (0..m).filter(|&i| w.is_trace_block(i)).collect();
    let rest: Vec<usize> = (0..m).filter(|&i| !w.is_trace_block(i)).collect();
    println!();
    println!("S1 / simulator -- the verifier's equations against the wire:");
    println!("  published values       : {m} = trace block {} + rest {}", trace_block.len(), rest.len());
    println!("  hidden next-row frames : {} = {n_pos} opened rows x {ZK_LIFT_COL} constrained columns", h0.len());
    println!("  verifier equations     : {n_eq} = {} x ({} folds + 1 terminal) + 1 DEEP-ALI identity", queries.len(), w.layers);

    // ── step 1: block + hidden frames are affine and full rank in the mask ──
    let mut joint_rows: Vec<Vec<u64>> = Vec::new();
    // Per column, the slopes on its own six published coordinates -- the
    // matrix whose kernel gives a mask move that changes only hidden values.
    let mut col_slots: Vec<Vec<usize>> = Vec::new();
    let mut col_block_slopes: Vec<Vec<Vec<u64>>> = Vec::new();
    for c in 0..ZK_LIFT_COL {
        let own: Vec<usize> = trace_block
            .iter()
            .copied()
            .filter(|&i| {
                if i < 2 * TRACE_WIDTH {
                    i % TRACE_WIDTH == c
                } else {
                    (0..queries.len()).any(|q| i == w.trace_at(q, c, false) || i == w.trace_at(q, c, true))
                }
            })
            .collect();
        assert_eq!(own.len(), 6);
        let slots: Vec<usize> = (0..S1_PER_COLUMN).map(|k| mask_index((k * 13 + c) % MASK_ROWS, c)).collect();
        let mut slopes6: Vec<Vec<u64>> = vec![vec![0u64; S1_PER_COLUMN]; 6];
        for (e, &sl) in slots.iter().enumerate() {
            let (rv, rh) = slope_pair(&base, sl, &v0, &h0, &queries, 0);
            let mut row: Vec<u64> = trace_block.iter().map(|&i| rv[i]).collect();
            row.extend_from_slice(&rh);
            joint_rows.push(row);
            for (k, &i) in own.iter().enumerate() {
                slopes6[k][e] = rv[i];
            }
        }
        col_slots.push(slots);
        col_block_slopes.push(slopes6);
    }
    let joint_dim = trace_block.len() + h0.len();
    let r_joint = rank(joint_rows);
    // Two elements in ONE column, different rows: the pair X4 never tested.
    let non_affine_rest = {
        let sa = col_slots[0][0];
        let sb = col_slots[0][1];
        let (ra, _) = slope_pair(&base, sa, &v0, &h0, &queries, 0);
        let (rb, _) = slope_pair(&base, sb, &v0, &h0, &queries, 0);
        let mut both = base.clone();
        both[sa] = fadd(both[sa], 1);
        both[sb] = fadd(both[sb], 1);
        let vb = published_vector(&run(&both), &queries);
        let mut bad_trace = 0usize;
        let mut bad_rest = 0usize;
        for i in 0..m {
            if fsub(vb[i], v0[i]) != fadd(ra[i], rb[i]) {
                if w.is_trace_block(i) { bad_trace += 1 } else { bad_rest += 1 }
            }
        }
        assert_eq!(bad_trace, 0, "the trace block is not affine in the mask, which Lagrange says is impossible");
        bad_rest
    };
    println!("  block + hidden frames  : rank {r_joint} of {joint_dim} from {} constrained-column elements", ZK_LIFT_COL * S1_PER_COLUMN);
    println!("    same column, two rows: additive on the block, non-additive on {non_affine_rest} rest coordinates");
    assert_eq!(
        r_joint, joint_dim,
        "the constrained columns' published evaluations and hidden next-row frames are not jointly \
         uniform: some linear combination of them is fixed by the witness, and the simulator \
         below has no way to sample it."
    );

    // ── step 2: conditional on block + frames ───────────────────────────────
    // Half from the row mask, half from the rows [ZK-LIFT-FULL] freed: the
    // lift's reach is a property of the whole column, and sampling one region
    // alone measured four dimensions short on 2026-09-02.
    let lift_slots: Vec<usize> = (0..35)
        .map(|k| mask_index((k * 4 + 1) % MASK_ROWS, ZK_LIFT_COL))
        .chain((0..35).map(|k| lift_extra_index((k * 10 + 3) % LIFT_EXTRA_ROWS)))
        .collect();
    let rand_slots: Vec<usize> = (0..12)
        .map(|k| MASK_ROWS * CONSTRAINED_TRACE_WIDTH + (k * 37 + 3) % TRACE_LENGTH)
        .collect();
    let mut rv_seen: Vec<usize> = Vec::new();
    for b in 0..S1_BASELINES {
        let wit_b = 3 * b;
        let base_b = if b == 0 { base.clone() } else { base_mask(0x5EED_0051 ^ (b * 0x9E37)) };
        let (fb, hb, pb) = if b == 0 {
            (v0.clone(), h0.clone(), public_for(&f0.public_inputs))
        } else {
            let rb = run_w(&base_b, wit_b);
            (published_vector(&rb, &queries), hidden_next_vector(&rb, &queries), public_for(&rb.public_inputs))
        };
        // The equations hold on this baseline too, before anything is built on it.
        assert!(
            verifier_residuals(&fb, &w, &pb).iter().all(|&r| r == 0),
            "baseline {b} fails the verifier as written"
        );

        let mut rows: Vec<Vec<u64>> = Vec::new();
        for &s in lift_slots.iter().chain(rand_slots.iter()) {
            let (row, rh) = slope_pair(&base_b, s, &fb, &hb, &queries, wit_b);
            for &i in trace_block.iter() {
                assert_eq!(row[i], 0, "a lift or randomizer element moved the trace block");
            }
            assert!(rh.iter().all(|&x| x == 0), "a lift or randomizer element moved a hidden frame");
            rows.push(rest.iter().map(|&i| row[i]).collect());
        }
        // Additivity INSIDE the conditional block, on every coordinate: two lift
        // rows, lift with randomizer, two randomizer rows.
        for (sa, sb) in [(lift_slots[0], lift_slots[1]), (lift_slots[2], rand_slots[0]), (rand_slots[1], rand_slots[2])] {
            let (ra, _) = slope_pair(&base_b, sa, &fb, &hb, &queries, wit_b);
            let (rb, _) = slope_pair(&base_b, sb, &fb, &hb, &queries, wit_b);
            let mut both = base_b.clone();
            both[sa] = fadd(both[sa], 1);
            both[sb] = fadd(both[sb], 1);
            let vb = published_vector(&run_w(&both, wit_b), &queries);
            for i in 0..m {
                assert_eq!(
                    fsub(vb[i], fb[i]),
                    fadd(ra[i], rb[i]),
                    "not additive in the lift/randomizer directions at coordinate {i}: the \
                     conditional map is not affine and the rank below describes nothing"
                );
            }
        }
        let r_cond = rank(rows.clone());

        let (vmat, rhs) = verifier_matrix(&fb, &rest, &w, &pb);
        {
            // Affine on the rest block: a pair crossing the identity's two live
            // inputs.
            let (ia, ib) = (rest[0], w.q_ood(K - 1));
            let mut t = fb.clone();
            t[ia] = fadd(t[ia], 1);
            t[ib] = fadd(t[ib], 1);
            let r = verifier_residuals(&t, &w, &pb);
            let ca = rest.iter().position(|&i| i == ia).unwrap();
            let cb = rest.iter().position(|&i| i == ib).unwrap();
            for k in 0..n_eq {
                assert_eq!(r[k], fadd(vmat[k][ca], vmat[k][cb]), "the verifier's equations are not affine on the rest block");
            }
        }
        assert!(rhs.iter().all(|&x| x == 0), "an honest anchor leaves a non-zero right-hand side");
        for (ri, row) in rows.iter().enumerate() {
            for k in 0..n_eq {
                let mut acc = 0u64;
                for (c, &x) in row.iter().enumerate() {
                    if x != 0 {
                        acc = fadd(acc, fmul(vmat[k][c], x));
                    }
                }
                assert_eq!(acc, 0, "honest slope {ri} violates verifier equation {k}");
            }
        }
        let r_v = rank(vmat.clone());
        rv_seen.push(r_v);

        // ── the directions neither the prover's blinding takes nor the verifier checks
        let (v_rref, v_piv) = rref(&vmat, rest.len());
        let mut fresh: Vec<Vec<u64>> = Vec::new();
        for phi in nullspace(&rows, rest.len()).iter() {
            let red = reduce_against(phi, &v_rref, &v_piv);
            if red.iter().any(|&x| x != 0) {
                fresh.push(red);
            }
        }
        let (unchecked, _) = rref(&fresh, rest.len());
        let n_unchecked = unchecked.len();
        assert_eq!(r_cond + r_v + n_unchecked, rest.len());

        // They are the quotient identity at the opened rows: its gradient on
        // the rest coordinates spans exactly the same space.
        let mut grads: Vec<Vec<u64>> = Vec::new();
        for q in 0..queries.len() {
            for mirror in [false, true] {
                let base_val = local_identity(&fb, &hb, &w, &pb, q, mirror).as_int();
                assert_eq!(base_val, 0, "the quotient identity fails at an opened row on baseline {b}");
                let mut g = vec![0u64; rest.len()];
                for (c, &i) in rest.iter().enumerate() {
                    let mut t = fb.clone();
                    t[i] = fadd(t[i], 1);
                    g[c] = fsub(local_identity(&t, &hb, &w, &pb, q, mirror).as_int(), base_val);
                }
                grads.push(g);
            }
        }
        let r_grads = rank(grads.clone());
        let mut span: Vec<Vec<u64>> = unchecked.clone();
        span.extend(grads.iter().cloned());
        let r_span = rank(span);
        if b == 0 {
            for (k, phi) in unchecked.iter().enumerate() {
                let names: Vec<String> = phi
                    .iter()
                    .enumerate()
                    .filter(|(_, &x)| x != 0)
                    .map(|(c, _)| coord_name(&w, rest[c]))
                    .collect();
                println!("    unchecked direction {k}: {}", names.join(" "));
            }
        }

        // The hidden frames move them, affinely, with full rank: one mask move
        // per constrained column that fixes that column's six published values.
        let mut shifts: Vec<Vec<u64>> = Vec::new();
        let mut kernel_moves: Vec<Vec<u64>> = Vec::new();
        let dot = |phi: &[u64], v: &[u64]| -> u64 {
            let mut acc = 0u64;
            for (c, &i) in rest.iter().enumerate() {
                if phi[c] != 0 {
                    acc = fadd(acc, fmul(phi[c], v[i]));
                }
            }
            acc
        };
        let phi_base: Vec<u64> = unchecked.iter().map(|phi| dot(phi, &fb)).collect();
        for c in 0..ZK_LIFT_COL {
            let kern = nullspace(&col_block_slopes[c], S1_PER_COLUMN);
            assert!(!kern.is_empty());
            let mut kmask = base_b.clone();
            for (e, &sl) in col_slots[c].iter().enumerate() {
                kmask[sl] = fadd(kmask[sl], kern[0][e]);
            }
            let (vk, hk) = wire_and_hidden(&kmask, &queries, wit_b);
            for &i in trace_block.iter() {
                assert_eq!(vk[i], fb[i], "the kernel move in column {c} changed {}", coord_name(&w, i));
            }
            assert!(hk != hb, "the kernel move in column {c} changed no hidden frame");
            shifts.push(unchecked.iter().enumerate().map(|(k, phi)| fsub(dot(phi, &vk), phi_base[k])).collect());
            kernel_moves.push(kmask);
        }
        // Affine in the frames: two kernel moves together equal their sum.
        {
            let mut both = base_b.clone();
            for c in [0usize, 1usize] {
                for &sl in col_slots[c].iter() {
                    both[sl] = fadd(both[sl], fsub(kernel_moves[c][sl], base_b[sl]));
                }
            }
            let (vb, _) = wire_and_hidden(&both, &queries, wit_b);
            for (k, phi) in unchecked.iter().enumerate() {
                assert_eq!(
                    fsub(dot(phi, &vb), phi_base[k]),
                    fadd(shifts[0][k], shifts[1][k]),
                    "unchecked direction {k} is not affine in the hidden frames"
                );
            }
        }
        let r_shift = rank(shifts);

        println!(
            "  baseline {b} (witness {wit_b}): conditional rank {r_cond} of {} from {} lift + {} randomizer elements; verifier rank {r_v}; unchecked {n_unchecked}",
            rest.len(), lift_slots.len(), rand_slots.len()
        );
        println!(
            "    unchecked = span of the quotient identity at the {n_pos} opened rows: rank {r_grads}, joint rank {r_span}; moved by the hidden frames with rank {r_shift}"
        );
        assert_eq!(
            r_span, n_unchecked,
            "the unchecked directions are not the quotient identity at the opened rows; something \
             else fixes them and it has not been named"
        );
        assert_eq!(r_grads, n_pos);
        assert_eq!(
            r_shift, n_unchecked,
            "the hidden next-row frames do not move every unchecked direction: {} of them are fixed \
             by the witness given the wire, and a distinguisher reads them in one query.",
            n_unchecked - r_shift
        );
        assert_eq!(
            r_cond + r_shift + r_v,
            rest.len(),
            "conditional on the block, the blinding spans {r_cond}, the hidden frames {r_shift} \
             more, the verifier cuts {r_v}: together {} short of the {} rest coordinates.",
            rest.len() - r_cond - r_shift - r_v,
            rest.len()
        );
    }

    // ── step 3: the simulator, with no witness ──────────────────────────────
    let mut rng = 0x51D0_0000_0000_0007u64;
    let draw = |rng: &mut u64| {
        *rng ^= *rng << 13;
        *rng ^= *rng >> 7;
        *rng ^= *rng << 17;
        *rng % GOLDILOCKS_PRIME
    };
    let mut simulated = 0usize;
    for _ in 0..3 {
        let mut t = vec![0u64; m];
        for &i in trace_block.iter() {
            t[i] = draw(&mut rng);
        }
        let (vmat, rhs) = verifier_matrix(&t, &rest, &w, &p);
        let r_v = rank(vmat.clone());
        assert_eq!(r_v, rv_seen[0], "the verifier's rank changed under a simulated trace block");
        let x = sample_solution(&vmat, &rhs, &mut rng);
        for (c, &i) in rest.iter().enumerate() {
            t[i] = x[c];
        }
        let r = verifier_residuals(&t, &w, &p);
        assert!(r.iter().all(|&x| x == 0), "the simulated transcript fails the verifier: {r:?}");
        let differs = (0..m).filter(|&i| t[i] != v0[i]).count();
        assert!(differs > m - 4, "the simulated transcript is the honest one");
        simulated += 1;
    }
    println!("  simulator              : {simulated} transcripts built from public data alone, each passing all {n_eq} equations");
    println!();
    println!("  => block and hidden frames jointly uniform (step 1); given them, the honest rest");
    println!("     is uniform on a coset whose only unchecked offsets are the quotient identity at");
    println!("     the opened rows, moved by the hidden frames with full rank (step 2); so the");
    println!("     honest rest is uniform on exactly the verifier's solution set, and the simulator");
    println!("     samples that law from the equations alone (step 3). Same law, no witness.");
    println!("     Programmed oracle, fixed challenges, {S1_BASELINES} witnesses, one query set: still");
    println!("     the random-oracle model, and still nothing about the grinding nonce or the");
    println!("     derivation of query positions.");
}

// ===========================================================================
// S2 -- the affine reach at the shipping query count
// ===========================================================================
//
// S1 closes at two queries. The shipping C7 proof opens twenty-two, and the
// quotient side of the wire grows with them: eight segment values per opened
// row. The only source of AFFINE randomness the quotient has is the lift column
// -- the randomizer never reaches it -- and the lift has `MASK_ROWS` free
// entries. So there is a query count past which the affine argument cannot
// close, and this measures where the shipping proof stands relative to it.
//
// Not in CI: it costs several minutes. Run it by hand:
//   cargo test -p p01-stark --release --lib affine_reach -- --ignored --nocapture

/// `q` opened positions, spread over the LDE domain, no two in one pair. Past
/// the eleventh they land in the upper half, which is the branch S1 never took.
fn spread_queries(q: usize) -> Vec<usize> {
    let half = LDE_SIZE / 2;
    let mut out: Vec<usize> = Vec::new();
    let mut i = 0usize;
    while out.len() < q {
        let pos = (137 + i * 367) % LDE_SIZE;
        if !out.iter().any(|&p| (p & (half - 1)) == (pos & (half - 1))) {
            out.push(pos);
        }
        i += 1;
    }
    out
}

/// The quotient side of the wire: the OOD claims and every opened segment value.
fn quotient_coords(w: &Wire) -> Vec<usize> {
    let mut v: Vec<usize> = (0..K).map(|j| w.q_ood(j)).collect();
    for q in 0..w.queries.len() {
        for j in 0..K {
            for mirror in [false, true] {
                v.push(w.quot_at(q, j, mirror));
            }
        }
    }
    v
}

/// `L_row(pt)`: the Lagrange basis polynomial of trace row `row` over the trace
/// domain, at an arbitrary point. `T_c(pt) = SUM_row T_c[row] . L_row(pt)`, so
/// this is the slope of every published evaluation of a column in that
/// column's mask entry at `row` -- analytically, with no prover run.
fn lagrange_at(row: usize, pt: BaseElement) -> BaseElement {
    let g = get_domain_generator_generic(TRACE_LENGTH);
    let gr = g.exp(row as u64);
    let n = BaseElement::new(TRACE_LENGTH as u64);
    (pt.exp(TRACE_LENGTH as u64) - BaseElement::ONE) * gr * (n * (pt - gr)).inv()
}

/// The points at which a trace column is published: `z`, `z.g`, and both
/// members of every opened pair.
fn block_points(w: &Wire, p: &Public) -> Vec<BaseElement> {
    let lde_g = get_domain_generator_generic(LDE_SIZE);
    let trace_g = get_domain_generator_generic(TRACE_LENGTH);
    let mut pts = vec![p.z, p.z * trace_g];
    for &pos in w.queries.iter() {
        for mirror in [false, true] {
            let q = pos ^ if mirror { LDE_SIZE / 2 } else { 0 };
            pts.push(lde_coset_shift() * lde_g.exp(q as u64));
        }
    }
    pts
}

/// Mask moves inside constrained column `c` that leave EVERY published
/// evaluation of that column unchanged: a basis of the kernel of the
/// `points x MASK_ROWS` Lagrange matrix, as flat mask deltas. These are the
/// hidden directions -- what moves a column's unpublished values, the next-row
/// frames among them, without touching the wire's trace block.
fn hidden_directions(c: usize, w: &Wire, p: &Public) -> Vec<Vec<(usize, u64)>> {
    let pts = block_points(w, p);
    let mat: Vec<Vec<u64>> = pts
        .iter()
        .map(|&pt| (0..MASK_ROWS).map(|r| lagrange_at(FIRST_FREE_ROW + r, pt).as_int()).collect())
        .collect();
    nullspace(&mat, MASK_ROWS)
        .into_iter()
        .map(|k| {
            k.iter()
                .enumerate()
                .filter(|(_, &x)| x != 0)
                .map(|(r, &x)| (mask_index(r, c), x))
                .collect()
        })
        .collect()
}

/// **FRI's own structure, which the verifier does not check and the honest
/// prover cannot escape.** `D` has degree at most `n - 2`, so layer `l` of FRI
/// is a polynomial of degree at most `(n - 2) / 2^l`, and once a layer is
/// opened at more points than that polynomial has coefficients, the opened
/// values satisfy linear relations that hold on EVERY honest transcript and
/// carry no information about the witness. The verifier checks folds and the
/// terminal, never the degree of an intermediate layer -- soundness comes from
/// the terminal bound -- so these relations are not among its equations. A
/// simulator that samples the verifier's solution set uniformly violates them
/// and is caught by anyone who interpolates layer 5; the correct simulator
/// builds its layers from a random low-degree `D`. This returns those
/// relations as functionals on the rest coordinates: the left null space of
/// each layer's evaluation matrix at the opened points.
///
/// At two queries every layer has more coefficients than opened points and
/// this is empty, which is why S1 never met it.
fn low_degree_relations(w: &Wire, rest: &[usize]) -> Vec<Vec<u64>> {
    let lde_g = get_domain_generator_generic(LDE_SIZE);
    let half = LDE_SIZE / 2;
    let max_deg = TRACE_LENGTH - 2;
    let mut out: Vec<Vec<u64>> = Vec::new();
    for l in 0..w.layers {
        // chain layer l+1: size n_l, coset shift h^(2^(l+1)), generator g^(2^(l+1))
        let n_l = LDE_SIZE >> (l + 1);
        let mut shift = lde_coset_shift();
        let mut gen = lde_g;
        for _ in 0..=l {
            shift = shift * shift;
            gen = gen * gen;
        }
        let dim = (max_deg >> (l + 1)) + 1;
        let pts_and_coords: Vec<(BaseElement, usize)> = w
            .queries
            .iter()
            .flat_map(|&pos| {
                let j = pos % (n_l / 2);
                let y = shift * gen.exp(j as u64);
                [(y, w.fri_at(w.queries.iter().position(|&q| q == pos).unwrap(), l, false)),
                 (-y, w.fri_at(w.queries.iter().position(|&q| q == pos).unwrap(), l, true))]
            })
            .collect();
        if pts_and_coords.len() <= dim {
            continue;
        }
        // E^T: dim x points. Its null space gives u with SUM_i u_i * val_i = 0.
        let et: Vec<Vec<u64>> = (0..dim)
            .map(|k| pts_and_coords.iter().map(|&(y, _)| y.exp(k as u64).as_int()).collect())
            .collect();
        for u in nullspace(&et, pts_and_coords.len()) {
            let mut row = vec![0u64; rest.len()];
            for (i, &(_, coord)) in pts_and_coords.iter().enumerate() {
                let c = rest.iter().position(|&r| r == coord).expect("FRI coordinate is in the rest block");
                row[c] = u[i];
            }
            out.push(row);
        }
    }
    out
}

/// How many affine dimensions the quotient side needs, given `q` opened
/// positions and `k` segments: every opened segment value and every OOD claim,
/// minus the one identity the verifier checks at `z` and the one it does not
/// check at each opened row. Plus the lift column's own published evaluations,
/// which the same entries have to supply.
fn affine_need(q: usize, k: usize) -> (usize, usize) {
    let positions = 2 * q;
    let quotient = k * positions + k - 1 - positions;
    let lift_trace = 2 + positions;
    (quotient, lift_trace)
}

#[test]
#[ignore = "several minutes; run by hand, see the section comment"]
fn affine_reach_at_the_shipping_query_count() {
    let queries = spread_queries(SPEND_NUM_QUERIES);
    let base = base_mask(0x5EED_0052);
    let f0 = run(&base);
    let v0 = published_vector(&f0, &queries);
    let h0 = hidden_next_vector(&f0, &queries);
    let w = Wire { queries: queries.clone(), layers: f0.fri_layers.len() };
    let p = public_for(&f0.public_inputs);
    let m = w.len();
    let n_pos = 2 * queries.len();

    // The equations, including the upper-half branch, on honest data first.
    let r_honest = verifier_residuals(&v0, &w, &p);
    let n_eq = r_honest.len();
    assert!(r_honest.iter().all(|&r| r == 0), "honest transcript fails the verifier as written at {} queries", queries.len());
    for q in 0..queries.len() {
        for mirror in [false, true] {
            assert_eq!(local_identity(&v0, &h0, &w, &p, q, mirror), BaseElement::ZERO);
        }
    }

    let trace_block: Vec<usize> = (0..m).filter(|&i| w.is_trace_block(i)).collect();
    let rest: Vec<usize> = (0..m).filter(|&i| !w.is_trace_block(i)).collect();
    let qc = quotient_coords(&w);
    let (need_q, need_lift_trace) = affine_need(queries.len(), K);

    println!();
    println!("S2 / affine reach -- C7 at its shipping query count:");
    println!("  queries                : {} (positions {:?}...)", queries.len(), &queries[..4]);
    println!("  published values       : {m} = trace block {} + rest {}", trace_block.len(), rest.len());
    println!("  quotient side          : {} coordinates, {need_q} of them must be affine-reached", qc.len());
    println!("  lift trace coordinates : {need_lift_trace}, from the same {MASK_ROWS} lift entries");
    println!("  verifier equations     : {n_eq}");

    // ── which constrained columns are affine directions at all? ────────────
    // Two rows of one column, together against apart, on every coordinate.
    let mut affine_cols: Vec<usize> = Vec::new();
    for c in 0..=ZK_LIFT_COL {
        let sa = mask_index(0, c);
        let sb = mask_index(19, c);
        let (ra, _) = slope_pair(&base, sa, &v0, &h0, &queries, 0);
        let (rb, _) = slope_pair(&base, sb, &v0, &h0, &queries, 0);
        let mut both = base.clone();
        both[sa] = fadd(both[sa], 1);
        both[sb] = fadd(both[sb], 1);
        let vb = published_vector(&run(&both), &queries);
        let bad = (0..m).filter(|&i| fsub(vb[i], v0[i]) != fadd(ra[i], rb[i])).count();
        let reach_q = qc.iter().filter(|&&i| ra[i] != 0).count();
        println!("  column {c:>2}: {} on {bad} coordinates; one entry reaches {reach_q} quotient coordinates", if bad == 0 { "additive" } else { "NON-additive" });
        if bad == 0 {
            affine_cols.push(c);
        }
    }

    // ── the affine reach on the quotient side ───────────────────────────────
    let mut lift_rows: Vec<Vec<u64>> = Vec::new();
    let mut all_rows: Vec<Vec<u64>> = Vec::new();
    let mut all_rest_rows: Vec<Vec<u64>> = Vec::new();
    for &c in affine_cols.iter() {
        // Every lift entry, row mask and extra rows alike; every other entry of
        // any other affine column, which is a lower bound on its reach and
        // enough to see whether it closes.
        let mut slots: Vec<usize> =
            (0..MASK_ROWS).step_by(if c == ZK_LIFT_COL { 1 } else { 2 }).map(|r| mask_index(r, c)).collect();
        if c == ZK_LIFT_COL {
            slots.extend((0..LIFT_EXTRA_ROWS).map(lift_extra_index));
        }
        for s in slots {
            let (row, _) = slope_pair(&base, s, &v0, &h0, &queries, 0);
            let on_q: Vec<u64> = qc.iter().map(|&i| row[i]).collect();
            if c == ZK_LIFT_COL {
                lift_rows.push(on_q.clone());
            }
            all_rows.push(on_q);
            // The rest accounting conditions on the trace block, as S1 does, so
            // it may only use directions that leave the block alone: the lift
            // and the randomizer. Columns 3, 5 and 9 are affine too, but every
            // entry of theirs moves their own published evaluations, and the
            // DEEP-ALI identity is not linear in those.
            if c == ZK_LIFT_COL {
                all_rest_rows.push(rest.iter().map(|&i| row[i]).collect());
            }
        }
    }
    let r_lift_q = rank(lift_rows);
    let r_all_q = rank(all_rows);
    println!("  affine columns         : {affine_cols:?}");
    println!("  lift alone on quotient : rank {r_lift_q} of {} needed", need_q);
    println!("  all affine on quotient : rank {r_all_q} of {} needed", need_q);

    // ── the full accounting on the rest, as S1 does it ─────────────────────
    let rand_slots: Vec<usize> = (0..240)
        .map(|k| MASK_ROWS * CONSTRAINED_TRACE_WIDTH + (k * 37 + 3) % TRACE_LENGTH)
        .collect();
    for &s in rand_slots.iter() {
        let (row, _) = slope_pair(&base, s, &v0, &h0, &queries, 0);
        all_rest_rows.push(rest.iter().map(|&i| row[i]).collect());
    }
    let r_cond = rank(all_rest_rows.clone());
    let (vmat, _rhs) = verifier_matrix(&v0, &rest, &w, &p);
    let r_v = rank(vmat.clone());
    let (v_rref, v_piv) = rref(&vmat, rest.len());
    let mut fresh: Vec<Vec<u64>> = Vec::new();
    for phi in nullspace(&all_rest_rows, rest.len()).iter() {
        let red = reduce_against(phi, &v_rref, &v_piv);
        if red.iter().any(|&x| x != 0) {
            fresh.push(red);
        }
    }
    let (unchecked, _) = rref(&fresh, rest.len());
    let mut grads: Vec<Vec<u64>> = Vec::new();
    for q in 0..queries.len() {
        for mirror in [false, true] {
            let mut g = vec![0u64; rest.len()];
            for (c, &i) in rest.iter().enumerate() {
                let mut t = v0.clone();
                t[i] = fadd(t[i], 1);
                g[c] = local_identity(&t, &h0, &w, &p, q, mirror).as_int();
            }
            grads.push(g);
        }
    }
    let r_grads = rank(grads.clone());
    let mut span = unchecked.clone();
    span.extend(grads.iter().cloned());
    let r_span = rank(span);
    let n_unchecked = unchecked.len();
    println!("  rest accounting        : affine {r_cond} + verifier {r_v} + unchecked {n_unchecked} = {} of {}", r_cond + r_v + n_unchecked, rest.len());
    println!("  local identities       : {n_pos}, gradient rank {r_grads}; joint rank with the unchecked {r_span}");

    // ── the hidden directions cover the unchecked ones, affinely and in full ──
    // Kernel moves inside each constrained column, analytic (Lagrange), so the
    // block is untouched by construction and the run only has to confirm it.
    let dot = |phi: &[u64], v: &[u64]| -> u64 {
        let mut acc = 0u64;
        for (c, &i) in rest.iter().enumerate() {
            if phi[c] != 0 {
                acc = fadd(acc, fmul(phi[c], v[i]));
            }
        }
        acc
    };
    let phi_base: Vec<u64> = unchecked.iter().map(|phi| dot(phi, &v0)).collect();
    let per_col = n_unchecked / ZK_LIFT_COL + 3;
    let mut shifts: Vec<Vec<u64>> = Vec::new();
    let mut first_moves: Vec<Vec<u64>> = Vec::new();
    for c in 0..ZK_LIFT_COL {
        let dirs = hidden_directions(c, &w, &p);
        assert!(dirs.len() >= per_col, "column {c} has only {} hidden directions", dirs.len());
        for (d, dir) in dirs.iter().enumerate().take(per_col) {
            let mut kmask = base.clone();
            for &(slot, x) in dir.iter() {
                kmask[slot] = fadd(kmask[slot], x);
            }
            let vk = published_vector(&run(&kmask), &queries);
            for &i in trace_block.iter() {
                assert_eq!(vk[i], v0[i], "an analytic kernel move in column {c} changed {}", coord_name(&w, i));
            }
            shifts.push(unchecked.iter().enumerate().map(|(k, phi)| fsub(dot(phi, &vk), phi_base[k])).collect());
            if d == 0 {
                first_moves.push(kmask);
            }
        }
    }
    let r_shift = rank(shifts.clone());
    // Affine in the hidden directions: two moves together equal their sum, and
    // a doubled move doubles.
    {
        let mut both = base.clone();
        for c in [0usize, 4usize] {
            for i in 0..both.len() {
                both[i] = fadd(both[i], fsub(first_moves[c][i], base[i]));
            }
        }
        let vb = published_vector(&run(&both), &queries);
        let mut twice = base.clone();
        for i in 0..twice.len() {
            twice[i] = fadd(twice[i], fmul(2, fsub(first_moves[0][i], base[i])));
        }
        let vt = published_vector(&run(&twice), &queries);
        let s0: Vec<u64> = shifts[0].clone();
        let s4: Vec<u64> = shifts[4 * per_col].clone();
        for (k, phi) in unchecked.iter().enumerate() {
            assert_eq!(fsub(dot(phi, &vb), phi_base[k]), fadd(s0[k], s4[k]), "unchecked direction {k} is not additive in the hidden directions");
            assert_eq!(fsub(dot(phi, &vt), phi_base[k]), fmul(2, s0[k]), "unchecked direction {k} does not scale with a hidden move");
        }
    }
    println!("  hidden directions      : {} analytic kernel moves ({per_col} per column) move the unchecked with rank {r_shift}", shifts.len());

    // ── FRI's low-degree structure ──────────────────────────────────────────
    let ld = low_degree_relations(&w, &rest);
    for (k, row) in ld.iter().enumerate() {
        assert_eq!(dot(row, &v0), 0, "honest transcript violates low-degree relation {k}");
    }
    {
        let mut t = v0.clone();
        let i = w.fri_at(3, w.layers - 1, true);
        t[i] = fadd(t[i], 1);
        assert!(ld.iter().any(|row| dot(row, &t) != 0), "a deep FRI sibling moved and no low-degree relation noticed");
    }
    let mut all_eq: Vec<Vec<u64>> = vmat.clone();
    all_eq.extend(ld.iter().cloned());
    let r_all = rank(all_eq.clone());
    let r_ld_new = r_all - r_v;
    println!("  low-degree relations   : {} rows over layers whose opened points exceed their coefficients; {r_ld_new} independent of the verifier", ld.len());
    println!("  => affine {r_cond} + hidden {r_shift} + verifier {r_v} + low-degree {r_ld_new} = {} of {}", r_cond + r_shift + r_all, rest.len());

    // ── the simulator at this query count: the verifier's equations AND the
    //    low-degree relations, from public data ──────────────────────────────
    {
        let mut rng = 0x51D0_0000_0000_0016u64;
        let mut t = vec![0u64; m];
        for &i in trace_block.iter() {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            t[i] = rng % GOLDILOCKS_PRIME;
        }
        let (vm, rhs_v) = verifier_matrix(&t, &rest, &w, &p);
        let mut sys_rows = vm;
        let mut sys_rhs = rhs_v;
        for row in ld.iter() {
            sys_rows.push(row.clone());
            sys_rhs.push(0);
        }
        let x = sample_solution(&sys_rows, &sys_rhs, &mut rng);
        for (c, &i) in rest.iter().enumerate() {
            t[i] = x[c];
        }
        let r = verifier_residuals(&t, &w, &p);
        assert!(r.iter().all(|&x| x == 0), "the simulated {}-query transcript fails the verifier: {r:?}", queries.len());
        for (k, row) in ld.iter().enumerate() {
            assert_eq!(dot(row, &t), 0, "the simulated transcript violates low-degree relation {k}");
        }
        println!("  simulator              : one {}-query transcript from public data, passing all {n_eq} verifier equations and every low-degree relation", queries.len());
    }
    println!();
    println!("  per circuit, the arithmetic (need = 2qk + k + 1 affine entries, have = lift rows):");
    for (name, q, k, rows) in [
        (
            "C1 pool_commitment",
            GENERIC_NUM_QUERIES,
            geom(Circ::C1).k,
            geom(Circ::C1).mask_rows + crate::air::denominated_pool::LIFT_EXTRA_ROWS,
        ),
        (
            "C3 merkle_path",
            HEAVY_GENERIC_NUM_QUERIES,
            geom(Circ::C3).k,
            geom(Circ::C3).mask_rows
                + crate::air::merkle_path::lift_extra_rows_for_depth(crate::air::merkle_path::CANONICAL_DEPTH),
        ),
        (
            "C6 merkle_update",
            MERKLE_UPDATE_NUM_QUERIES,
            geom(Circ::C6).k,
            geom(Circ::C6).mask_rows
                + crate::air::merkle_update::lift_extra_rows_for_depth(crate::air::merkle_update::CANONICAL_DEPTH),
        ),
        ("C7 spend", SPEND_NUM_QUERIES, K, MASK_ROWS + LIFT_EXTRA_ROWS),
    ] {
        let (nq, nt) = affine_need(q, k);
        println!("    {name:<20} q={q:>2} k={k} need {} have {rows}  {}", nq + nt, if rows >= nq + nt { "ok" } else { "SHORT" });
    }
    println!();
    println!("  => affine + hidden + verifier + low-degree == rest is S1's statement at the");
    println!("     shipping query count: the honest transcript is uniform on exactly the set the");
    println!("     verifier's equations and FRI's own degree structure cut out, and the simulator");
    println!("     samples that set. Anything short of it is a protocol quantity, not a test one.");
    assert_eq!(
        r_cond + r_shift + r_all,
        rest.len(),
        "at {} queries the blinding reaches {r_cond}, the hidden directions {r_shift} more, the \
         verifier cuts {r_v} and FRI's degree structure {r_ld_new}: {} of the {} rest coordinates \
         are fixed by the witness and checked by nobody. That is the gap a lift column too small \
         for this wire leaves, and a distinguisher reads it in one query.",
        queries.len(),
        rest.len() - r_cond - r_shift - r_all,
        rest.len()
    );
}

// ===========================================================================
// X1 -- the quotient's seven free OOD coordinates
// ===========================================================================

/// The degree of each OOD claim in one mask element, one constrained column at a
/// time. This is the table that decides X1: a column answering 1 gives an exact
/// uniformity proof, and anything else does not.
#[test]
fn the_degree_of_each_ood_claim_in_the_mask_is_measured_per_column() {
    println!();
    println!("X1 — degree of Q_j(z) in ONE blinding element, by constrained column");
    println!("(blinding row 0; degree 1 => that claim is EXACTLY uniform in that element)");
    println!();
    print!("{:>4}", "col");
    for j in 0..K {
        print!("{:>7}", format!("Q_{j}"));
    }
    println!("   verdict");
    println!("{}", "-".repeat(4 + 7 * K + 30));

    let mut affine_cols: Vec<usize> = Vec::new();
    for c in 0..CONSTRAINED_TRACE_WIDTH {
        let polys = sweep_ood(0x1111_0000 + c as u64, mask_index(0, c), 10);
        let degs: Vec<i32> = polys.iter().map(|p| degree(p)).collect();
        print!("{c:>4}");
        for d in degs.iter() {
            print!("{d:>7}");
        }
        // Only the FREE coordinates matter: Q_{K-1} is the one the verifier's
        // recombination solves, so its law follows from the other seven plus
        // public data and it must not be counted as evidence.
        let free_ok = degs[..FREE].iter().all(|&d| d == 1);
        let free_flat = degs[..FREE].iter().all(|&d| d <= 0);
        println!(
            "   {}",
            if free_ok {
                affine_cols.push(c);
                "AFFINE in all 7 free claims"
            } else if free_flat {
                "does not reach Q at all"
            } else {
                "non-linear"
            }
        );
    }

    // The randomizer column, for the record: it enters no constraint and no
    // boundary assertion, so it must be invisible to Q. If it ever stopped being
    // invisible it would be constrained, and its own channel would close.
    let r_polys = sweep_ood(0x2222_0000, MASK_ROWS * CONSTRAINED_TRACE_WIDTH, 4);
    let r_degs: Vec<i32> = r_polys.iter().map(|p| degree(p)).collect();
    print!("{:>4}", "rnd");
    for d in r_degs.iter() {
        print!("{d:>7}");
    }
    println!("   (expected: never reaches Q)");
    assert!(
        r_degs.iter().all(|&d| d <= 0),
        "the randomizer column reaches the quotient (degrees {r_degs:?}). It is supposed to \
         enter no constraint and no boundary assertion — if it now does, it is no longer free \
         and the channel-B ledger is measuring a column that is not what it says it is."
    );

    println!();
    if affine_cols.is_empty() {
        println!("VERDICT: no constrained column is affine in all seven free claims.");
        println!("X1 does NOT close by this argument. The seven are non-constant in the mask");
        println!("(so not guessable), but their law is not proven equal to the uniform one the");
        println!("simulator samples. Do not say 'zero-knowledge' on the strength of this file.");
    } else {
        println!("VERDICT: columns {affine_cols:?} are affine in all seven free claims.");
        println!("Conditioned on the rest of the mask, each Q_j(z) is a*m + b with a != 0 and m");
        println!("uniform, so the seven are EXACTLY uniform — provided the seven slopes are");
        println!("independent, which `the_seven_free_claims_are_jointly_uniform` decides.");
    }
}

/// Individual uniformity is not enough: the simulator samples the free claims
/// INDEPENDENTLY, so the honest ones must be jointly uniform too.
///
/// The degree table above says which claims each constrained column reaches
/// affinely. Pool every such column — they are DISTINCT mask elements, hence
/// independent — and measure the slope matrix onto the claims they cover. Rank
/// equal to the number of covered claims means the map from those uniform mask
/// elements onto that set of claims is onto, so the covered claims are EXACTLY
/// jointly uniform, conditioned on the rest of the mask and on the witness.
///
/// This test reports what it covers and what it does NOT. A claim no column
/// reaches affinely is left open, loudly: that is the residue of X1.
#[test]
fn the_affine_free_claims_are_jointly_uniform() {
    use std::collections::BTreeSet;

    let mut affine: Vec<(usize, Vec<usize>)> = Vec::new();
    for c in 0..CONSTRAINED_TRACE_WIDTH {
        let polys = sweep_ood(0x3333_0000 + c as u64, mask_index(0, c), 10);
        let js: Vec<usize> = (0..FREE).filter(|&j| degree(&polys[j]) == 1).collect();
        if !js.is_empty() {
            affine.push((c, js));
        }
    }

    let covered: BTreeSet<usize> =
        affine.iter().flat_map(|(_, js)| js.iter().copied()).collect();
    let open: Vec<usize> = (0..FREE).filter(|j| !covered.contains(j)).collect();

    println!();
    println!("X1 / joint — which free claims a column reaches AFFINELY");
    for (c, js) in affine.iter() {
        println!("  column {c:>2} -> claims {js:?}");
    }
    println!("  covered: {covered:?}");
    println!("  OPEN   : {open:?}");

    if covered.is_empty() {
        println!();
        println!("No free claim is affine in any single mask element. X1 is fully OPEN.");
        return;
    }

    // Slopes of the covered claims in several blinding rows of every affine
    // column. Two points suffice: affineness was established above.
    let cov: Vec<usize> = covered.iter().copied().collect();
    let mut m: Vec<Vec<u64>> = Vec::new();
    let mut slots: Vec<(usize, usize)> = Vec::new();
    for (c, _) in affine.iter() {
        for t in 0..cov.len().max(2) {
            let r = (t * (MASK_ROWS / cov.len().max(2))) % MASK_ROWS;
            slots.push((r, *c));
            let slot = mask_index(r, *c);
            let mut mask = base_mask(0x4444_0000);
            mask[slot] = 101;
            let a = run(&mask);
            mask[slot] = 102;
            let b = run(&mask);
            // f is affine, so f(102) - f(101) IS the slope.
            m.push(cov.iter().map(|&j| fsub(b.q_ood[j], a.q_ood[j])).collect());
        }
    }

    let r = rank(m);
    println!();
    println!("  slope matrix over {} mask elements x {} covered claims: rank {r}",
             slots.len(), cov.len());
    assert_eq!(
        r,
        cov.len(),
        "the slope matrix is rank-deficient ({r} of {}). The covered claims are each uniform \
         but not jointly so: some linear combination of them is constant in every affine mask \
         element, and that combination separates an honest transcript from a simulated one.",
        cov.len(),
    );

    println!();
    println!("  => claims {cov:?} are an onto affine image of uniform, independent mask");
    println!("     elements, hence EXACTLY jointly uniform — the law the simulator samples.");
    if open.is_empty() {
        println!("  => X1 CLOSES for C7.");
    } else {
        println!("  => claims {open:?} are NOT covered. They move with the mask at degree 7, so");
        println!("     they are not guessable, but their law is NOT proven equal to uniform.");
        println!("     X1 remains OPEN on {} of the {FREE} free coordinates.", open.len());
    }
}

// ===========================================================================
// The same measurement, on every circuit that carries a lift column
// ===========================================================================
//
// Everything above is C7. C1, C3 and C6 took the identical constraint, and
// "identical by construction" is exactly the claim this repository has been
// wrong about before -- a geometry constant written on both sides of a wire and
// moved on only one fails silently, and so would a lift column whose gate is off
// by a row or whose degree lands one block short. So the other three are
// measured too, on the one property that matters: is the lift column AFFINE in
// every free claim, and are those claims JOINTLY uniform.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Circ {
    C1,
    C3,
    C6,
    C7,
}

struct Geom {
    name: &'static str,
    id: u8,
    n: usize,
    lde: usize,
    k: usize,
    /// Columns the AIR constrains -- the lift column is the LAST of these.
    cw: usize,
    mask_rows: usize,
    mask_len: usize,
    lift: usize,
}

fn geom(c: Circ) -> Geom {
    use crate::air::{denominated_pool as c1, merkle_path as c3, merkle_update as c6, spend as c7};
    match c {
        Circ::C1 => Geom {
            name: "C1 pool_commitment",
            id: 1,
            n: c1::TRACE_LENGTH,
            lde: c1::TRACE_LENGTH * GENERIC_BLOWUP,
            k: GENERIC_QUOTIENT_SEGMENTS,
            cw: c1::CONSTRAINED_TRACE_WIDTH,
            mask_rows: c1::MASK_ROWS,
            mask_len: c1::MASK_LEN,
            lift: c1::ZK_LIFT_COL,
        },
        Circ::C3 => {
            let d = c3::CANONICAL_DEPTH;
            let n = c3::trace_length_for_depth(d);
            Geom {
                name: "C3 merkle_path",
                id: 3,
                n,
                lde: n * GENERIC_BLOWUP,
                k: GENERIC_QUOTIENT_SEGMENTS,
                cw: c3::CONSTRAINED_TRACE_WIDTH,
                mask_rows: n - d * c3::HASH_CYCLE_LEN,
                mask_len: c3::mask_len_for_depth(d),
                lift: c3::ZK_LIFT_COL,
            }
        }
        Circ::C6 => {
            let d = c6::CANONICAL_DEPTH;
            let n = c6::trace_length_for_depth(d);
            Geom {
                name: "C6 merkle_update",
                id: 6,
                n,
                lde: n * GENERIC_BLOWUP,
                k: GENERIC_QUOTIENT_SEGMENTS,
                cw: c6::CONSTRAINED_TRACE_WIDTH,
                mask_rows: n - d * c6::HASH_CYCLE_LEN,
                mask_len: c6::mask_len_for_depth(d),
                lift: c6::ZK_LIFT_COL,
            }
        }
        Circ::C7 => Geom {
            name: "C7 spend",
            id: 7,
            n: c7::TRACE_LENGTH,
            lde: LDE_SIZE,
            k: SPEND_QUOTIENT_SEGMENTS,
            cw: c7::CONSTRAINED_TRACE_WIDTH,
            mask_rows: c7::MASK_ROWS,
            mask_len: c7::MASK_LEN,
            lift: c7::ZK_LIFT_COL,
        },
    }
}

/// The witness is FIXED per circuit; only the mask moves. The public inputs are
/// harvested once from the shipping generator rather than re-derived here -- a
/// second derivation is a second thing that can disagree with the prover, and
/// the boundary fold reads them.
fn public_inputs_for(c: Circ) -> Vec<u64> {
    use crate::compact as cc;
    let g = geom(c);
    let m = base_mask_len(0x9001, g.mask_len);
    match c {
        Circ::C1 => cc::generate_pool_commitment_proof(111, 222, 333, 444, &m).public_inputs,
        Circ::C3 => {
            let d = crate::air::merkle_path::CANONICAL_DEPTH;
            let pe: Vec<u64> = (0..d as u64).map(|i| 1000 + i).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            cc::generate_merkle_path_compact_proof(777, &pe, &pi, &m).public_inputs
        }
        Circ::C6 => {
            let d = crate::air::merkle_update::CANONICAL_DEPTH;
            let pe: Vec<u64> = (0..d as u64).map(|i| 100 + i * 13).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            cc::generate_merkle_update_compact_proof(111, 222, &pe, &pi, &m).public_inputs
        }
        Circ::C7 => {
            let d = crate::air::spend::CANONICAL_DEPTH;
            let pe: Vec<u64> = (0..d as u64).map(|i| 1000 + i * 37).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            cc::generate_spend_compact_proof(42, 999, 7, 555, &pe, &pi, &[11, 22, 33, 44], &m)
                .public_inputs
        }
    }
}

fn base_mask_len(seed: u64, len: usize) -> Vec<u64> {
    let mut z = seed | 1;
    (0..len)
        .map(|_| {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            z % GOLDILOCKS_PRIME
        })
        .collect()
}

/// The trace for one circuit under one mask. The witness is FIXED per circuit;
/// only the mask moves, and that is the whole experiment.
fn trace_for(c: Circ, mask_f: &[BaseElement]) -> Vec<Vec<BaseElement>> {
    use crate::air::{merkle_path as c3, merkle_update as c6};
    match c {
        Circ::C1 => {
            crate::air::denominated_pool::build_pool_commitment_trace(
                BaseElement::new(111),
                BaseElement::new(222),
                BaseElement::new(333),
                BaseElement::new(444),
                &mask_f,
            )
            .0
        }
        Circ::C3 => {
            let d = c3::CANONICAL_DEPTH;
            let pe: Vec<BaseElement> = (0..d as u64).map(|i| BaseElement::new(1000 + i)).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            c3::build_merkle_trace(BaseElement::new(777), &pe, &pi, &mask_f)
        }
        Circ::C6 => {
            let d = c6::CANONICAL_DEPTH;
            let pe: Vec<BaseElement> =
                (0..d as u64).map(|i| BaseElement::new(100 + i * 13)).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            c6::build_merkle_update_trace(
                BaseElement::new(111),
                BaseElement::new(222),
                &pe,
                &pi,
                &mask_f,
            )
        }
        Circ::C7 => {
            let d = crate::air::spend::CANONICAL_DEPTH;
            let pe: Vec<BaseElement> =
                (0..d as u64).map(|i| BaseElement::new(1000 + i * 37)).collect();
            let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
            crate::air::spend::build_spend_trace(
                BaseElement::new(42),
                BaseElement::new(999),
                BaseElement::new(7),
                BaseElement::new(555),
                &pe,
                &pi,
                &mask_f,
            )
            .0
        }
    }
}

/// `Q_0(z) .. Q_{k-1}(z)` for any lift-carrying circuit, with `alpha`, the
/// boundary challenge and `z` supplied rather than derived. See the module doc
/// for why fixing them is the correct experiment and not a convenience.
fn ood_claims_for(c: Circ, mask: &[u64], pub_inputs: &[u64]) -> Vec<u64> {
    use crate::air::{merkle_path as c3, merkle_update as c6};
    let g = geom(c);
    let mask_f: Vec<BaseElement> = mask.iter().map(|&v| BaseElement::new(v)).collect();

    let trace = trace_for(c, &mask_f);

    let alpha = BaseElement::new(ALPHA);
    let alpha_bnd = BaseElement::new(ALPHA_BND);
    let z = BaseElement::new(OOD_Z);

    let lde = compute_lde_generic(&trace, GENERIC_BLOWUP);
    let lde_g = get_domain_generator_generic(g.lde);
    let trace_g = get_domain_generator_generic(g.n);

    let mut q_poly = match c {
        Circ::C1 => compute_quotient_lde_circuit_1(&lde, GENERIC_BLOWUP, g.n, alpha),
        Circ::C3 => compute_quotient_lde_circuit_3(
            &lde,
            GENERIC_BLOWUP,
            g.n,
            c3::CANONICAL_DEPTH,
            alpha,
        ),
        Circ::C6 => compute_quotient_lde_circuit_6(
            &lde,
            GENERIC_BLOWUP,
            g.n,
            c6::CANONICAL_DEPTH,
            alpha,
        ),
        Circ::C7 => compute_quotient_lde_circuit_7(&lde, GENERIC_BLOWUP, g.n, alpha),
    };

    let assertions = boundary_assertions_for_circuit(g.id, pub_inputs);
    if !assertions.is_empty() {
        let w = trace.len();
        let trace_polys: Vec<Vec<BaseElement>> =
            (0..w).map(|col| inverse_ntt(&trace[col], trace_g)).collect();
        let mut qb: Vec<BaseElement> = Vec::new();
        fold_boundary_quotient(&mut qb, &trace_polys, &assertions, trace_g, alpha_bnd);
        if q_poly.len() < qb.len() {
            q_poly.resize(qb.len(), BaseElement::ZERO);
        }
        for (i, &v) in qb.iter().enumerate() {
            q_poly[i] = q_poly[i] + v;
        }
    }

    let segs = segment_quotient_poly(&q_poly, g.n, g.lde, lde_g, g.k);
    segment_ood_values(&segs, z)
}

/// Degree of every claim in ONE element of the lift column, per circuit.
///
/// Degree 1 with a non-zero slope proves that claim is EXACTLY uniform. The last
/// claim is DELIBERATELY excluded from the assertion: `Q_{k-1}(z)` is the one the
/// verifier's recombination solves, so a simulator computes it rather than
/// sampling it, and it does not need to be uniform on its own.
#[test]
fn the_lift_column_reaches_every_free_claim_on_every_circuit() {
    println!();
    println!("X1 / all circuits — degree of Q_j(z) in ONE element of the LIFT column");
    println!("(degree 1 => that claim is exactly uniform in that element)");
    println!();

    let mut bad: Vec<String> = Vec::new();
    for c in [Circ::C1, Circ::C3, Circ::C6, Circ::C7] {
        let g = geom(c);
        let pubs = public_inputs_for(c);
        let slot = g.lift; // blinding row 0, lift column: row-major over `cw`
        let xs: Vec<u64> = (1..=10u64).map(|i| i * 0x9E37_79B9 + 5).collect();
        let mut ys: Vec<Vec<u64>> = vec![Vec::with_capacity(xs.len()); g.k];
        let mut mask = base_mask_len(0x7000 + g.id as u64, g.mask_len);
        for &x in xs.iter() {
            mask[slot] = x;
            let claims = ood_claims_for(c, &mask, &pubs);
            for j in 0..g.k {
                ys[j].push(claims[j]);
            }
        }
        let degs: Vec<i32> =
            (0..g.k).map(|j| degree(&interpolate(&xs, &ys[j]))).collect();

        print!("  {:<20} width {:>2}, mask rows {:>3} :", g.name, g.cw, g.mask_rows);
        for d in degs.iter() {
            print!("{d:>4}");
        }
        let free_ok = degs[..g.k - 1].iter().all(|&d| d == 1);
        println!("   {}", if free_ok { "AFFINE in all free claims" } else { "NOT AFFINE" });
        if !free_ok {
            bad.push(format!("{} -> {:?}", g.name, &degs[..g.k - 1]));
        }
    }

    println!();
    println!("  (the last column is Q_{{k-1}}, which the recombination solves -- not asserted)");
    assert!(
        bad.is_empty(),
        "the lift column does not reach every free claim at degree 1 on: {bad:?}. \
         Constraint [18]/[19]/[11]/[4] is what puts it there, and a degree other than 1 \
         means the gate or the degree budget is wrong on that circuit -- NOT that the \
         column is missing, which would show as degree 0."
    );
}

/// Individual uniformity is not enough: a simulator samples the free claims
/// INDEPENDENTLY, so the honest ones must be jointly uniform. Take one blinding
/// row per free claim, all in the lift column, and measure the slope matrix. Full
/// rank means the map from those uniform mask elements onto the claims is onto,
/// so the joint law is exactly uniform.
#[test]
fn the_free_claims_are_jointly_uniform_on_every_circuit() {
    println!();
    println!("X1 / all circuits — rank of the lift column's slope matrix");
    println!();

    let mut bad: Vec<String> = Vec::new();
    for c in [Circ::C1, Circ::C3, Circ::C6, Circ::C7] {
        let g = geom(c);
        let free = g.k - 1;
        assert!(
            g.mask_rows >= free,
            "{}: only {} blinding rows for {free} free claims",
            g.name,
            g.mask_rows,
        );
        let pubs = public_inputs_for(c);
        let rows: Vec<usize> = (0..free).map(|t| t * (g.mask_rows / free)).collect();

        let mut m: Vec<Vec<u64>> = Vec::with_capacity(free);
        for &r in rows.iter() {
            let slot = r * g.cw + g.lift;
            let mut mask = base_mask_len(0x8000 + g.id as u64, g.mask_len);
            mask[slot] = 101;
            let a = ood_claims_for(c, &mask, &pubs);
            mask[slot] = 102;
            let b = ood_claims_for(c, &mask, &pubs);
            // Affine, so f(102) - f(101) IS the slope.
            m.push((0..free).map(|j| fsub(b[j], a[j])).collect());
        }
        let r = rank(m);
        println!("  {:<20} rows {:?} -> rank {r} of {free}", g.name, rows);
        if r != free {
            bad.push(format!("{} -> rank {r} of {free}", g.name));
        }
    }

    println!();
    assert!(
        bad.is_empty(),
        "the slope matrix is rank-deficient on: {bad:?}. Those claims are each uniform but \
         not jointly so -- some linear combination of them is constant in every lift-column \
         element, and that combination separates an honest transcript from a simulated one."
    );
    println!("  => on every circuit the free claims are an onto affine image of uniform,");
    println!("     independent mask elements, hence EXACTLY jointly uniform. That is the law");
    println!("     the simulator samples, and X1 closes on all four production circuits.");
}

/// X2 on every circuit: the leaves a proof never opens.
///
/// The trace tree closes on the coset argument alone -- every trace-column value
/// is affine in that column's blinding rows with an all-non-zero Lagrange
/// coefficient, because the LDE domain never meets the trace domain. The
/// QUOTIENT tree does not: `Q` is the composition divided by the vanishing
/// polynomial and the constraints reach degree 7 in the trace, so a quotient
/// leaf is not affine in the row mask and that argument does not transfer.
///
/// The lift column is what transfers it. Measured here on all four circuits, at
/// a sample of positions spread across the whole committed domain: every
/// committed quotient value must be degree 1 in ONE lift-column element, which
/// makes it exactly uniform and the leaf preimage unguessable.
#[test]
fn quotient_leaves_are_exactly_uniform_on_every_circuit() {
    println!();
    println!("X2 / all circuits — degree of a committed quotient value in ONE mask element");
    println!();

    let xs: Vec<u64> = (1..=10u64).map(|i| i * 1_000_003 + 17).collect();
    let mut bad: Vec<String> = Vec::new();

    for c in [Circ::C1, Circ::C3, Circ::C6, Circ::C7] {
        let g = geom(c);
        let pubs = public_inputs_for(c);
        // EXHAUSTIVE across all four production circuits. The docs quoted this
        // as "384 of 384", which was 8 segments x 48 SAMPLED positions -- a true
        // sentence that read like a statement about the committed domain. On C7
        // the committed domain is 8 x 8192.
        let sample: Vec<usize> = (0..g.lde).collect();

        // Two sweeps, and the CONTRAST is the measurement: a Poseidon column
        // reaches every committed quotient value at degree 7 -- non-constant, so
        // not guessable, but not proven uniform either -- while the lift column
        // reaches the same values at degree 1, which IS a proof.
        for (col, label) in [(0usize, "Poseidon state"), (g.lift, "lift column")] {
            let mut runs: Vec<Vec<Vec<u64>>> = Vec::with_capacity(xs.len());
            for &x in xs.iter() {
                let mut mask = base_mask_len(0xA000 + g.id as u64, g.mask_len);
                mask[col] = x;
                runs.push(quotient_lde_for(c, &mask, &pubs, &sample));
            }
            let mut hist = std::collections::BTreeMap::<i32, usize>::new();
            for j in 0..g.k {
                for (s, _) in sample.iter().enumerate() {
                    let ys: Vec<u64> = runs.iter().map(|r| r[j][s]).collect();
                    *hist.entry(degree(&interpolate(&xs, &ys))).or_insert(0) += 1;
                }
            }
            let total = g.k * sample.len();
            let affine = hist.get(&1).copied().unwrap_or(0);
            let flat = hist.get(&-1).copied().unwrap_or(0) + hist.get(&0).copied().unwrap_or(0);
            println!(
                "  {:<20} {:<16} : {:>4}/{} affine, {:>4} constant, degrees {:?}",
                g.name,
                label,
                affine,
                total,
                flat,
                hist.keys().collect::<Vec<_>>(),
            );
            if col == g.lift && affine != total {
                bad.push(format!("{} -> {affine}/{total} affine", g.name));
            }
        }
    }

    println!();
    assert!(
        bad.is_empty(),
        "the lift column does not reach every committed quotient value at degree 1 on: \
         {bad:?}. Without that, the quotient tree has no uniformity proof at all -- only \
         99.9% of it unopened and a degree-7 dependence on the row mask, which is high \
         entropy but not a law."
    );
    println!("  => every committed quotient value is affine in a uniform mask element on all");
    println!("     four circuits, hence exactly uniform. The quotient tree closes on the same");
    println!("     argument the trace tree does, and X2 has no residue on the production path.");
}

/// The committed quotient LDE at a sample of positions, for any circuit.
///
/// Shares its whole body with `ood_claims_for` except the last step -- kept
/// separate rather than parameterised because the two return different shapes
/// and threading a flag through would make both harder to read than the
/// duplication is to maintain.
fn quotient_lde_for(
    c: Circ,
    mask: &[u64],
    pub_inputs: &[u64],
    sample: &[usize],
) -> Vec<Vec<u64>> {
    use crate::air::{merkle_path as c3, merkle_update as c6};
    let g = geom(c);
    let mask_f: Vec<BaseElement> = mask.iter().map(|&v| BaseElement::new(v)).collect();
    let trace = trace_for(c, &mask_f);

    let alpha = BaseElement::new(ALPHA);
    let alpha_bnd = BaseElement::new(ALPHA_BND);
    let lde = compute_lde_generic(&trace, GENERIC_BLOWUP);
    let lde_g = get_domain_generator_generic(g.lde);
    let trace_g = get_domain_generator_generic(g.n);

    let mut q_poly = match c {
        Circ::C1 => compute_quotient_lde_circuit_1(&lde, GENERIC_BLOWUP, g.n, alpha),
        Circ::C3 => {
            compute_quotient_lde_circuit_3(&lde, GENERIC_BLOWUP, g.n, c3::CANONICAL_DEPTH, alpha)
        }
        Circ::C6 => {
            compute_quotient_lde_circuit_6(&lde, GENERIC_BLOWUP, g.n, c6::CANONICAL_DEPTH, alpha)
        }
        Circ::C7 => compute_quotient_lde_circuit_7(&lde, GENERIC_BLOWUP, g.n, alpha),
    };

    let assertions = boundary_assertions_for_circuit(g.id, pub_inputs);
    if !assertions.is_empty() {
        let trace_polys: Vec<Vec<BaseElement>> =
            (0..trace.len()).map(|col| inverse_ntt(&trace[col], trace_g)).collect();
        let mut qb: Vec<BaseElement> = Vec::new();
        fold_boundary_quotient(&mut qb, &trace_polys, &assertions, trace_g, alpha_bnd);
        if q_poly.len() < qb.len() {
            q_poly.resize(qb.len(), BaseElement::ZERO);
        }
        for (i, &v) in qb.iter().enumerate() {
            q_poly[i] = q_poly[i] + v;
        }
    }

    let segs = segment_quotient_poly(&q_poly, g.n, g.lde, lde_g, g.k);
    (0..g.k).map(|j| sample.iter().map(|&p| segs.lde[j][p]).collect()).collect()
}

/// The structural half of X2, on every circuit, and the one that is a PROOF
/// rather than a sample.
///
/// Every trace-column value the prover commits is `S_c(x_p) = SUM_r T[c][r] *
/// L_r(x_p)`, affine in that column's trace entries with the Lagrange basis
/// `L_r(x_p)` as its coefficient on row `r`. That coefficient is non-zero at
/// EVERY committed position exactly when `Z_T(x_p) != 0`, i.e. when the LDE
/// domain never meets the trace domain.
///
/// That is what the coset shift buys, and it is the difference between "the
/// blinding rows hide the trace" and "the blinding rows hide the trace at most
/// positions". A subgroup LDE (`h = 1`) puts `blowup`-many committed positions
/// exactly on trace rows, where `Z_T = 0` kills every blinding coefficient at
/// once -- the leak this repository shipped once and fixed in B7. All four
/// production circuits share n = 512 today, so the four rows below carry the
/// same number -- and that is the point of printing `n` and `lde` per circuit
/// rather than asserting once: C5 runs at n = 1024, and any circuit that moves
/// its trace length gets its own check here for free instead of inheriting a
/// conclusion drawn about a domain it does not live in.
#[test]
fn the_lde_domain_never_meets_the_trace_domain_on_any_circuit() {
    let h = lde_coset_shift().as_int();
    println!();
    println!("X2 / structural — the LDE coset against each circuit's trace domain (h = {h})");
    println!();
    for c in [Circ::C1, Circ::C3, Circ::C6, Circ::C7] {
        let g = geom(c);
        let lde_g = get_domain_generator_generic(g.lde).as_int();
        let hn = fpow(h, g.n as u64);
        let gn = fpow(lde_g, g.n as u64);
        assert_ne!(gn, 1, "{}: g^n must have order blowup, not 1", g.name);

        let mut worst = u64::MAX;
        let mut v = hn;
        for p in 0..GENERIC_BLOWUP {
            let zt = fsub(v, 1); // Z_T(x_p) = x_p^n - 1
            assert_ne!(
                zt, 0,
                "{}: LDE position class {p} lands ON the trace domain, so Z_T(x_p) = 0 and \
                 every blinding row's Lagrange coefficient vanishes there. The committed \
                 value at those positions is a function of the WITNESS ALONE -- the pre-B7 \
                 leak, back on one circuit.",
                g.name,
            );
            worst = worst.min(zt);
            v = fmul(v, gn);
        }
        println!(
            "  {:<20} n = {:>4}, lde = {:>5} : disjoint, min |Z_T| = {worst}",
            g.name, g.n, g.lde,
        );
    }
    println!();
    println!("  => on every circuit each trace-column leaf value is affine in that column's");
    println!("     blinding rows with ALL coefficients non-zero, at EVERY committed position,");
    println!("     so an unopened trace leaf preimage is uniform and cannot be guessed.");
}
