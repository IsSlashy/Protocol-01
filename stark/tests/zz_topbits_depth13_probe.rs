//! SECURITY PROBE: does depth 13 clear the counting
//! argument the spend.rs comment rejects it on, and at what query count does it
//! stop clearing it?
use winterfell::math::{fields::f64::BaseElement, FieldElement, StarkField};

const TRACE_LENGTH: usize = 512;
const HASH_CYCLE_LEN: usize = 32;

fn domain_generator(n: usize) -> BaseElement {
    BaseElement::get_root_of_unity(n.trailing_zeros())
}

fn eval_column_at(values: &[BaseElement], z: BaseElement) -> BaseElement {
    let n = values.len();
    let g = domain_generator(n);
    let n_inv = BaseElement::new(n as u64).inv();
    let z_n_minus_1 = z.exp((n as u64).into()) - BaseElement::ONE;
    let mut acc = BaseElement::ZERO;
    let mut g_i = BaseElement::ONE;
    for &v in values.iter() {
        acc += v * g_i * (z - g_i).inv();
        g_i *= g;
    }
    acc * z_n_minus_1 * n_inv
}

/// Returns (unknowns, rank, mask_only_rank, commitment_coord_is_free)
fn probe(depth: usize, r: usize) -> (usize, usize, usize) {
    let first_free_row = depth * HASH_CYCLE_LEN;
    let mut segments: Vec<Vec<usize>> = vec![(0..=95usize).collect()];
    for cycle in 3..depth {
        segments.push((cycle * HASH_CYCLE_LEN..(cycle + 1) * HASH_CYCLE_LEN).collect());
    }
    let n_witness_segs = segments.len();
    for row in first_free_row..TRACE_LENGTH {
        segments.push(vec![row]);
    }
    let unknowns = segments.len();
    let points: Vec<BaseElement> =
        (0..r).map(|i| BaseElement::new(0x2000_0000 + i as u64 * 7919)).collect();

    let build = |cols: std::ops::Range<usize>| -> Vec<Vec<BaseElement>> {
        points
            .iter()
            .map(|&z| {
                cols.clone()
                    .map(|c| {
                        let mut ind = vec![BaseElement::ZERO; TRACE_LENGTH];
                        for &i in &segments[c] {
                            ind[i] = BaseElement::ONE;
                        }
                        eval_column_at(&ind, z)
                    })
                    .collect()
            })
            .collect()
    };

    fn rank(mut m: Vec<Vec<BaseElement>>) -> usize {
        let rows = m.len();
        if rows == 0 { return 0; }
        let cols = m[0].len();
        let mut r = 0usize;
        for c in 0..cols {
            if r >= rows { break; }
            let Some(pr) = (r..rows).find(|&i| m[i][c] != BaseElement::ZERO) else { continue };
            m.swap(r, pr);
            let inv = m[r][c].inv();
            for cc in c..cols { m[r][cc] = m[r][cc] * inv; }
            for i in 0..rows {
                if i == r { continue; }
                let f = m[i][c];
                if f != BaseElement::ZERO {
                    for cc in c..cols { m[i][cc] = m[i][cc] - f * m[r][cc]; }
                }
            }
            r += 1;
        }
        r
    }

    let full = rank(build(0..unknowns));
    let mask_only = rank(build(n_witness_segs..unknowns));
    (unknowns, full, mask_only)
}

#[test]
#[ignore = "runs ~25s; documents the depth/query tradeoff. Run with --ignored"]
fn depth_13_vs_query_count() {
    for depth in [12usize, 13, 14] {
        for q in [22usize, 23, 24, 27, 31, 32] {
            let r = 4 * q + 2;
            let (unk, full, mask) = probe(depth, r);
            let mask_rows = TRACE_LENGTH - depth * HASH_CYCLE_LEN;
            println!(
                "depth={depth:2} q={q:2} R={r:3} mask_rows={mask_rows:3} unknowns={unk:3} \
                 full_rank={full:3} mask_only_rank={mask:3} \
                 underdetermined={} mask_absorbs_all={}",
                full < unk,
                mask == r
            );
        }
    }
}
