//! SECURITY PROBE. Replicates `air::spend::tests::
//! measured_the_public_system_is_now_underdetermined` parameterised by
//! CANONICAL_DEPTH, to test whether depth 13 clears R = 90.
//!
//! Model copied from spend.rs:1270-1290 (segments) and spend.rs:1113-1146
//! (domain_generator / eval_column_at).

use winterfell::math::{fields::f64::BaseElement, FieldElement, StarkField};

const TRACE_LENGTH: usize = 512;
const HASH_CYCLE_LEN: usize = 32;
const HOLD_CONSTANT_LAST: usize = 95;
const R: usize = 4 * 22 + 2; // 90, the deployed wire

fn domain_generator(domain_size: usize) -> BaseElement {
    let k = domain_size.trailing_zeros();
    let p_minus_1 = 0xFFFF_FFFF_0000_0000_u64;
    let g_2_32 = BaseElement::new(7).exp_vartime((p_minus_1 / (1u64 << 32)).into());
    let mut g = g_2_32;
    for _ in 0..(32 - k) {
        g = g * g;
    }
    g
}

fn eval_column_at(values: &[BaseElement], z: BaseElement) -> BaseElement {
    let n = values.len();
    let g = domain_generator(n);
    let n_inv = BaseElement::new(n as u64).inv();
    let z_n_minus_1 = z.exp_vartime((n as u64).into()) - BaseElement::ONE;
    let mut acc = BaseElement::ZERO;
    let mut g_i = BaseElement::ONE;
    for &v in values.iter() {
        acc += v * g_i * (z - g_i).inv();
        g_i *= g;
    }
    acc * z_n_minus_1 * n_inv
}

/// Returns (unknowns, mask_rows, rank, commitment_coordinate_moves,
///          rank_of_mask_block_alone)
fn analyse(first_free_cycle: usize, r: usize) -> (usize, usize, usize, bool, usize) {
    let first_free_row = first_free_cycle * HASH_CYCLE_LEN;
    let mask_rows = TRACE_LENGTH - first_free_row;

    // col 9's segments, exactly the shape spend.rs:1270-1276 builds.
    let mut segments: Vec<Vec<usize>> = vec![(0..=HOLD_CONSTANT_LAST).collect()];
    for cycle in 3..first_free_cycle {
        segments.push((cycle * HASH_CYCLE_LEN..(cycle + 1) * HASH_CYCLE_LEN).collect());
    }
    let n_witness_segments = segments.len();
    for row in first_free_row..TRACE_LENGTH {
        segments.push(vec![row]);
    }
    let unknowns = segments.len();

    let points: Vec<BaseElement> =
        (0..r).map(|i| BaseElement::new(0x2000_0000 + i as u64 * 7919)).collect();

    let build = |cols: &[usize]| -> Vec<Vec<BaseElement>> {
        let mut m = Vec::with_capacity(r);
        for &z in &points {
            let mut row = Vec::with_capacity(cols.len());
            for &c in cols {
                let mut indicator = vec![BaseElement::ZERO; TRACE_LENGTH];
                for &i in &segments[c] {
                    indicator[i] = BaseElement::ONE;
                }
                row.push(eval_column_at(&indicator, z));
            }
            m.push(row);
        }
        m
    };

    let rref = |m: &mut Vec<Vec<BaseElement>>, ncols: usize| -> Vec<usize> {
        let mut pivots = Vec::new();
        let mut rr = 0usize;
        for c in 0..ncols {
            if rr >= r {
                break;
            }
            let Some(pr) = (rr..r).find(|&i| m[i][c] != BaseElement::ZERO) else { continue };
            m.swap(rr, pr);
            let inv = m[rr][c].inv();
            for cc in c..ncols {
                m[rr][cc] = m[rr][cc] * inv;
            }
            for i in 0..r {
                if i == rr {
                    continue;
                }
                let f = m[i][c];
                if f != BaseElement::ZERO {
                    for cc in c..ncols {
                        m[i][cc] = m[i][cc] - f * m[rr][cc];
                    }
                }
            }
            pivots.push(c);
            rr += 1;
        }
        pivots
    };

    // Full system.
    let all: Vec<usize> = (0..unknowns).collect();
    let mut m = build(&all);
    let pivots = rref(&mut m, unknowns);
    let rank = pivots.len();
    // The commitment coordinate (column 0) moves iff column 0 is NOT the only
    // member of its pivot-free class — i.e. iff there is a null vector with a
    // nonzero first coordinate. Column 0 is pinned exactly when it is a pivot
    // AND its row has no free columns... simplest exact test: the commitment is
    // determined iff rank(A) == rank(A without column 0) + 1 is false; use the
    // standard test: e_0 is recoverable iff column 0 is not in the span of the
    // others.  col0 in span(others) <=> rank(others) == rank(all).
    let others: Vec<usize> = (1..unknowns).collect();
    let mut m2 = build(&others);
    let rank_others = rref(&mut m2, others.len()).len();
    let moves = rank_others == rank;

    // The simulation criterion: the mask block ALONE must have rank r.
    let mask_cols: Vec<usize> = (n_witness_segments..unknowns).collect();
    let mut m3 = build(&mask_cols);
    let rank_mask = rref(&mut m3, mask_cols.len()).len();

    (unknowns, mask_rows, rank, moves, rank_mask)
}

#[test]
fn depth_sweep_against_r90() {
    for depth in [12usize, 13, 14] {
        let (u, mask, rank, moves, rank_mask) = analyse(depth, R);
        println!(
            "depth {depth}: unknowns={u} mask_rows={mask} rank={rank} \
             commitment_moves={moves} rank(mask block)={rank_mask} (need {R})"
        );
    }
}

#[test]
#[ignore = "runs ~5s; documents why depth 13 is rejected. Run with --ignored"]
fn depth_sweep_at_27_queries() {
    let r27 = 4 * 27 + 2; // 110 — the num_queries every other circuit ships
    for depth in [12usize, 13] {
        let (u, mask, rank, moves, rank_mask) = analyse(depth, r27);
        println!(
            "R=110 depth {depth}: unknowns={u} mask_rows={mask} rank={rank} \
             commitment_moves={moves} rank(mask block)={rank_mask} (need {r27})"
        );
    }
}
