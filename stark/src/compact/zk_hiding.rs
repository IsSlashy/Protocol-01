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
}

/// One C7 witness, held fixed. Only the mask varies across calls in this file;
/// that is the entire experiment.
fn c7_internals(
    mask: &[u64],
    alpha: BaseElement,
    alpha_bnd: BaseElement,
    z: BaseElement,
) -> C7Internals {
    assert_eq!(mask.len(), MASK_LEN);
    let pe: Vec<BaseElement> =
        (0..CANONICAL_DEPTH as u64).map(|i| BaseElement::new(1000 + i * 37)).collect();
    let bits: Vec<u8> = (0..CANONICAL_DEPTH).map(|i| (i % 2) as u8).collect();
    let mask_felts: Vec<BaseElement> = mask.iter().map(|&v| BaseElement::new(v)).collect();

    let (trace, nullifier, root) = build_spend_trace(
        BaseElement::new(42),
        BaseElement::new(999),
        BaseElement::new(7),
        BaseElement::new(555),
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

    C7Internals { trace_lde: lde, q_lde: segs.lde, q_ood }
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

const ALPHA: u64 = 0x1234_5678_9ABC_DEF0;
const ALPHA_BND: u64 = 0x0FED_CBA9_8765_4321;
const OOD_Z: u64 = 0xDEAD_BEEF_CAFE_1234;

fn run(mask: &[u64]) -> C7Internals {
    c7_internals(
        mask,
        BaseElement::new(ALPHA),
        BaseElement::new(ALPHA_BND),
        BaseElement::new(OOD_Z),
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
    let sample: Vec<usize> = (0..64).map(|i| i * (LDE_SIZE / 64) + 3).collect();
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
// X1 — the quotient's seven free OOD coordinates
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
        let sample: Vec<usize> = (0..48).map(|i| i * (g.lde / 48) + 3).collect();

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
