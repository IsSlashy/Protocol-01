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

use super::*;
use crate::air::spend::{
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
/// column's own `TRACE_LENGTH` elements follow.
fn mask_index(row: usize, col: usize) -> usize {
    assert!(row < MASK_ROWS && col < CONSTRAINED_TRACE_WIDTH);
    row * CONSTRAINED_TRACE_WIDTH + col
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
/// # The rank is NOT full, and that is the correct answer
///
/// A transcript the verifier accepts cannot be uniform on all of `F^m`: the
/// verifier checks equations ON the published values, and anything satisfying an
/// equation lives in a proper subspace. Measured, twice, and the two agree:
///
/// ```text
///   1 query :  88 published values, rank 80  -> deficiency  8
///   2 queries: 142 published values, rank 126 -> deficiency 16
/// ```
///
/// The deficiency is exactly `queries * (committed FRI layers + 1)`. Per query
/// that is the seven fold-consistency checks -- each layer's opened value is
/// determined by the pair opened one layer below it, which is the whole point of
/// FRI -- plus the terminal check, where the last layer's pair is folded and
/// compared against an evaluation of the transmitted polynomial.
///
/// So the transcript is exactly uniform ON THE SUBSPACE THE VERIFIER'S OWN
/// CHECKS CUT OUT, and nowhere less. That is the strongest true statement
/// available, and it is the structure a simulator needs: sample the free
/// coordinates uniformly, solve the checked ones. It generalises what X1 already
/// showed on the eight quotient claims, where `S` samples seven and solves the
/// eighth, to every field element on the wire.
///
/// ⚠️ The scaling is the evidence, not the single number. A deficiency of 16 on
/// its own could be any coincidence; a deficiency that moves 8 -> 16 when the
/// query count moves 1 -> 2 is the verifier's equation count and little else.
///
/// ⛔ THE ADDITIVITY CHECK IS NOT A FORMALITY. A slope matrix only describes the
/// map if the map is additive in the mask. Degree 1 in each element SEPARATELY
/// -- which is all X1..X3 establish -- still permits cross terms like
/// `m_i * m_j`, and under a cross term the single-element slopes do not compose
/// and the rank below would be measuring a linearization that the prover does
/// not implement. So perturbing two elements together is checked against
/// perturbing them apart, before the rank is believed.
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
        "the published transcript has rank {r}, and the verifier's own checks account for only \
         {checks} of the {} it is short. The remainder is a linear combination of published \
         values that is CONSTANT in the mask and that the verifier never constrains: it takes the \
         same value on every honest proof, so a distinguisher reads it in one query and separates \
         honest from simulated. Every value being individually uniform does not save this -- that \
         is exactly the gap between a marginal and a joint result.",
        m - r
    );

    println!();
    println!("  => the published vector is an ONTO affine image of the uniform mask MODULO the");
    println!("     verifier's own equations, so it is exactly uniform on the {}-dimensional", m - checks);
    println!("     subspace those equations cut out -- not merely coordinate by coordinate.");
    println!("     That is the law a simulator samples: draw the free coordinates uniformly,");
    println!("     solve the {checks} checked ones, exactly as X1 does for the eighth quotient claim.");
    println!("     ⛔ Still not a simulation argument: one witness, one query set, one baseline,");
    println!("     and it says nothing about the grinding nonce or how query positions are drawn.");
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
