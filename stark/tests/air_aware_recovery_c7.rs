//! The same attack, pointed at C7 — where it must FAIL, and why that matters.
//!
//! `air_aware_recovery_c1.rs` recovered all four private inputs of C1 from the
//! published bytes, by adding the AIR's 35 linear equalities to 110 openings.
//! It refutes "more unknowns than equations" as a security claim. Since the
//! mask landed on C1 (2026-08-31) that file reads under-determined too, and
//! keeps the pre-mask model beside it as the positive control, still solving.
//!
//! C7's design rests on exactly that sentence: 138 unknowns against 90
//! equations (`air/spend.rs:1425-1449`). So the honest question is not whether
//! the counting is right — it is whether the SAME instrument that broke C1
//! breaks C7. This file runs it and measures.
//!
//! ⛔ THIS FILE IS SUPPOSED TO PASS BY NOT RECOVERING. That is the one shape of
//! test this repository has paid for four times: a green that means "the attack
//! failed" is worthless unless the same code is shown recovering something. So
//! two calibrations sit beside the measurement, and neither is optional:
//!
//!   * `air_aware_recovery_c1.rs` — the same solver, recovering on the
//!     pre-mask model of C1 (its `counterfactual (pinned tail)` line), today.
//!   * `collapsing_the_mask_makes_c7_solvable` below — the same solver on the
//!     same C7 proof, closing the instant the mask rows are (wrongly) modelled
//!     as copies of one another. That isolates the MASK as the cause, rather
//!     than leaving "it did not solve" to stand on its own.
//!
//! WHAT A PASS HERE DOES NOT MEAN. It does not mean C7 is zero-knowledge.
//! This file measures ONE channel: whether the published trace-column
//! evaluations determine the witness. They did on C1 before its mask; they do
//! not on C7. The other channels — the quotient decomposition, the DEEP
//! composition, every FRI layer, the transcript jointly and the mask draw —
//! carry measurements of their own in `compact::zk_hiding` since 2026-09-01,
//! and a measurement on one witness and one query set is still not a
//! simulation argument.
//!
//! ⚠️ AND THE MASK USED HERE IS NOT A CSPRNG MASK. It is a deterministic
//! xorshift, the same shortcut `wire_parity.rs:82-105` takes, and it is
//! adequate here for a reason worth stating: the RANK of the public system does
//! not care how the mask was drawn, only that its rows are independent
//! unknowns. Secrecy does care — that is why `draw_spend_mask`
//! (`stark/src/lib.rs:357-369`) rejection-samples from `getrandom` and refuses
//! to build a proof without one. A rank result is not a secrecy result.
//!
//! Run: `cargo test -p p01-stark --release --test air_aware_recovery_c7 -- --nocapture`

use p01_stark::compact::generate_spend_compact_proof;

const P: u128 = 0xFFFF_FFFF_0000_0001;

#[inline]
fn fadd(a: u64, b: u64) -> u64 {
    ((a as u128 + b as u128) % P) as u64
}
#[inline]
fn fsub(a: u64, b: u64) -> u64 {
    ((a as u128 + P - b as u128) % P) as u64
}
#[inline]
fn fmul(a: u64, b: u64) -> u64 {
    ((a as u128 * b as u128) % P) as u64
}
fn fpow(mut a: u64, mut e: u64) -> u64 {
    let mut r: u64 = 1;
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
    fpow(a, 0xFFFF_FFFE_FFFF_FFFF)
}

// C7 geometry. Verifier twin: `CONFIG_SPEND`, compact_proof.rs:277-288.
const GEN_512: u64 = 0x1905_D02A_5C41_1F4E; // trace generator, 512 rows
const GEN_8192: u64 = 0x1544_EF23_35D1_7997; // LDE generator, 8192 points
const COSET_SHIFT: u64 = 7;

// ⛔ IMPORTED, NOT RESTATED -- and that is the whole repair.
//
// 🚨 Every constant below the import was a LOCAL COPY until 2026-09-01, and the
// copies drifted: CANONICAL_DEPTH sat at 12 against the AIR's 11, TRACE_WIDTH at
// 10 against the AIR's 12, and the mask this file built was 1280 elements long
// where the prover demanded MASK_LEN = 2272 (2623 since [ZK-LIFT-FULL]). So the ONLY harness that has ever
// attacked C7 could not build a proof at all. It panicked before measuring
// anything, while the repository went on citing its result.
//
// It is the same failure that broke every v4 spend in the browser six days
// earlier, and the same one the shape pin in `air/spend.rs` was carrying at the
// same moment: a constant written on both sides of a wire and moved on one side.
// A corrected copy would only reset the clock. The cure is no copy.
use p01_stark::air::spend::{
    CANONICAL_DEPTH, FIRST_FREE_CYCLE, FIRST_FREE_ROW, HASH_CYCLE_LEN, MASK_LEN, MASK_ROWS,
    TRACE_LENGTH as TRACE_LEN, TRACE_WIDTH,
};

const LDE_SIZE: u64 = 8192;
const BLOWUP: u64 = 16;
const NUM_QUERIES: usize = 22;
const QUOTIENT_SEGMENTS: usize = 8;
const FRI_FINAL_POLY_SIZE: usize = 32; // [C7] not 16

const HOLD_CONSTANT_LAST: usize = 3 * HASH_CYCLE_LEN - 1; // 95
/// The hold column: rows 0..=95 carry the commitment. Column 9 is pinned in the
/// AIR itself (`spend.rs:2102` refuses any boundary assertion targeting it), so
/// this one is a genuine constant of the layout rather than a duplicated width.
const HOLD_COL: usize = 9;

/// Filler segments: one per hash cycle between the commitment hold and the first
/// free row. Derived, because it moves whenever the Merkle depth does.
const FILLER_SEGMENTS: usize = FIRST_FREE_CYCLE - 3;

fn self_check_field() {
    assert_eq!(fpow(GEN_512, 512), 1, "GEN_512 is not a 512th root");
    assert_ne!(fpow(GEN_512, 256), 1, "GEN_512 is not primitive");
    assert_eq!(fpow(GEN_8192, 8192), 1, "GEN_8192 is not an 8192nd root");
    assert_eq!(fpow(GEN_8192, BLOWUP), GEN_512, "g_lde^blowup must be g_trace");
    assert_ne!(fpow(COSET_SHIFT, 8192), 1, "the coset is not disjoint");
}

fn lagrange_basis_at(i: usize, x: u64, n: usize, g: u64) -> u64 {
    let gi = fpow(g, i as u64);
    let num = fmul(gi, fsub(fpow(x, n as u64), 1));
    let den = fmul(n as u64, fsub(x, gi));
    fmul(num, finv(den))
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

struct Openings {
    num_queries: usize,
    ood_z: u64,
    ood_cur: Vec<u64>,
    ood_next: Vec<u64>,
    queries: Vec<(u64, Vec<u64>, Vec<u64>, Vec<u64>, Vec<u64>)>,
}

fn rd_u64(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(b[off..off + 8].try_into().unwrap())
}
fn rd_u32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(b[off..off + 4].try_into().unwrap())
}
fn rd_u16(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(b[off..off + 2].try_into().unwrap())
}

fn parse_generic(bytes: &[u8]) -> Openings {
    let tw = TRACE_WIDTH;
    let ood_cur: Vec<u64> = (0..tw).map(|c| rd_u64(bytes, 64 + c * 8)).collect();
    let ood_next: Vec<u64> = (0..tw).map(|c| rd_u64(bytes, 64 + tw * 8 + c * 8)).collect();
    let z_off = 64 + 2 * tw * 8;
    let ood_z = rd_u64(bytes, z_off);

    let hdr = z_off + 8 + QUOTIENT_SEGMENTS * 8;
    let num_fri_layers = bytes[hdr] as usize;
    let mut off = hdr + 1 + 32 * num_fri_layers;
    let ffps = rd_u16(bytes, off) as usize;
    assert_eq!(ffps, FRI_FINAL_POLY_SIZE, "C7 ships fri_final_poly_size 32, not 16");
    off += 2 + 8 * ffps;
    off += 8;
    let num_queries = rd_u16(bytes, off) as usize;
    off += 2;
    let qstart = off;

    let tail = num_queries * QUOTIENT_SEGMENTS * 8;
    let region = bytes.len() - qstart - tail;
    assert_eq!(region % num_queries, 0, "query region {region} not divisible by {num_queries}");
    let per_query = region / num_queries;
    assert!(per_query >= 4 + 4 * tw * 8, "per-query block {per_query} B is too small");

    let row =
        |b: &[u8], base: usize| -> Vec<u64> { (0..tw).map(|c| rd_u64(b, base + c * 8)).collect() };

    let mut queries = Vec::with_capacity(num_queries);
    for k in 0..num_queries {
        let q = qstart + k * per_query;
        let s = tw * 8;
        queries.push((
            rd_u32(bytes, q) as u64,
            row(bytes, q + 4),
            row(bytes, q + 4 + s),
            row(bytes, q + 4 + 2 * s),
            row(bytes, q + 4 + 3 * s),
        ));
    }
    Openings { num_queries, ood_z, ood_cur, ood_next, queries }
}

fn published_nodes(op: &Openings, col: usize) -> Vec<(u64, u64)> {
    let mut nodes: Vec<(u64, u64)> = Vec::new();
    let push = |x: u64, y: u64, nodes: &mut Vec<(u64, u64)>| {
        if !nodes.iter().any(|&(nx, _)| nx == x) {
            nodes.push((x, y));
        }
    };
    let at = |pos: u64| fmul(COSET_SHIFT, fpow(GEN_8192, pos));
    let half = LDE_SIZE / 2;

    push(op.ood_z, op.ood_cur[col], &mut nodes);
    push(fmul(op.ood_z, GEN_512), op.ood_next[col], &mut nodes);

    for (pos, cur, mir, next, next_mir) in &op.queries {
        let next_pos = (pos + BLOWUP) % LDE_SIZE;
        push(at(*pos), cur[col], &mut nodes);
        push(at(pos ^ half), mir[col], &mut nodes);
        push(at(next_pos), next[col], &mut nodes);
        push(at(next_pos ^ half), next_mir[col], &mut nodes);
    }
    nodes
}

// ---------------------------------------------------------------------------
// The attacker's model, in the SEGMENT basis — the same one the repo's own
// counting argument uses (air/spend.rs:1436-1449), so the two are comparable.
// ---------------------------------------------------------------------------

/// One segment per group of rows the constraints force equal, one per free row.
fn segments(collapse_mask: bool) -> Vec<Vec<usize>> {
    let mut segs: Vec<Vec<usize>> = vec![(0..=HOLD_CONSTANT_LAST).collect()];
    for cycle in 3..FIRST_FREE_CYCLE {
        segs.push((cycle * HASH_CYCLE_LEN..(cycle + 1) * HASH_CYCLE_LEN).collect());
    }
    if collapse_mask {
        // The counterfactual: pretend the mask rows repeat one another, exactly
        // the way C1's padding rows really do.
        segs.push((FIRST_FREE_ROW..TRACE_LEN).collect());
    } else {
        for row in FIRST_FREE_ROW..TRACE_LEN {
            segs.push(vec![row]);
        }
    }
    segs
}

/// Row of the public system: each entry is the segment indicator evaluated at x.
fn system(nodes: &[(u64, u64)], segs: &[Vec<usize>]) -> Vec<Vec<u64>> {
    nodes
        .iter()
        .map(|&(x, y)| {
            let mut row: Vec<u64> = segs
                .iter()
                .map(|seg| {
                    seg.iter().fold(0u64, |acc, &i| {
                        fadd(acc, lagrange_basis_at(i, x, TRACE_LEN, GEN_512))
                    })
                })
                .collect();
            row.push(y);
            row
        })
        .collect()
}

fn solve(mut rows: Vec<Vec<u64>>, n: usize) -> Option<Vec<u64>> {
    let mut pivot_row = 0usize;
    let mut where_pivot = vec![usize::MAX; n];
    for col in 0..n {
        let Some(sel) = (pivot_row..rows.len()).find(|&r| rows[r][col] != 0) else {
            continue;
        };
        rows.swap(pivot_row, sel);
        let inv = finv(rows[pivot_row][col]);
        for c in col..=n {
            rows[pivot_row][c] = fmul(rows[pivot_row][c], inv);
        }
        for r in 0..rows.len() {
            if r != pivot_row && rows[r][col] != 0 {
                let f = rows[r][col];
                for c in col..=n {
                    rows[r][c] = fsub(rows[r][c], fmul(f, rows[pivot_row][c]));
                }
            }
        }
        where_pivot[col] = pivot_row;
        pivot_row += 1;
        if pivot_row == rows.len() {
            break;
        }
    }
    if where_pivot.iter().any(|&p| p == usize::MAX) {
        return None;
    }
    Some((0..n).map(|c| rows[where_pivot[c]][n]).collect())
}

/// A C7 proof over a deterministic mask. See the file header on why a xorshift
/// is adequate for a RANK measurement and inadequate for a secrecy one.
fn spend_proof(mask_seed: u64) -> p01_stark::compact::GenericCompactProofData {
    let mut z = mask_seed;
    let mut next = || {
        z ^= z << 13;
        z ^= z >> 7;
        z ^= z << 17;
        z % (P as u64)
    };
    // MASK_LEN, not MASK_ROWS * TRACE_WIDTH: the flat slice is the row mask
    // (MASK_ROWS x CONSTRAINED_TRACE_WIDTH) FOLLOWED BY the randomizer column,
    // then the lift column's rows 1..FIRST_FREE_ROW ([ZK-LIFT-FULL 2026-09-02])
    // (TRACE_LENGTH). Computing it here from a width was what made this file
    // unable to prove once the randomizer column landed.
    let mask: Vec<u64> = (0..MASK_LEN).map(|_| next()).collect();
    let path_elements: Vec<u64> = (0..CANONICAL_DEPTH as u64).map(|i| 0x51A7 + i * 7919).collect();
    let path_indices: Vec<u8> = (0..CANONICAL_DEPTH).map(|i| (i % 2) as u8).collect();
    let recipient_hash = [0x1111_1111u64, 0x2222_2222, 0x3333_3333, 0x4444_4444];

    generate_spend_compact_proof(
        0x0BAD_C0FF_EE00_1234,
        0x1DEA_D0D0_CAFE_5678,
        0x0000_0000_0001_E240,
        0x0000_0000_0000_002A,
        &path_elements,
        &path_indices,
        &recipient_hash,
        &mask,
    )
}

// ===========================================================================
// 1. THE MEASUREMENT — the instrument that broke C1 does not close on C7.
// ===========================================================================

#[test]
fn the_c1_attack_does_not_close_on_c7() {
    self_check_field();

    let proof = spend_proof(0xC7_5EED_0001);
    let op = parse_generic(&proof.proof_bytes);
    assert_eq!(op.num_queries, NUM_QUERIES, "C7 ships {NUM_QUERIES} queries");

    let nodes = published_nodes(&op, HOLD_COL);
    let segs = segments(false);

    println!("C7 hold column {HOLD_COL}");
    println!("  published equations : {}", nodes.len());
    println!(
        "  unknowns            : {} (1 hold + {FILLER_SEGMENTS} filler + {MASK_ROWS} mask)",
        segs.len()
    );
    println!("  short by            : {}", segs.len() as i64 - nodes.len() as i64);

    assert_eq!(
        segs.len(),
        1 + FILLER_SEGMENTS + MASK_ROWS,
        "the model must match the AIR's own geometry"
    );

    assert!(
        solve(system(&nodes, &segs), segs.len()).is_none(),
        "⛔ C7's hold column SOLVED. The mask does not do what air/spend.rs:1425 \
         claims, and the withdrawal is in C1's situation.",
    );
    println!("  verdict             : under-determined, no solve");
}

// ===========================================================================
// 2. THE CALIBRATION THAT MAKES TEST 1 MEAN SOMETHING.
//
// Same proof, same solver, same openings — the ONLY change is modelling the 128
// mask rows as repeats of one another, which is exactly what C1's padding rows
// really are. If the system closes then, the mask's independence is the thing
// standing in the way, and test 1 is not measuring a broken solver.
// ===========================================================================

#[test]
fn collapsing_the_mask_makes_c7_solvable() {
    self_check_field();

    let proof = spend_proof(0xC7_5EED_0002);
    let op = parse_generic(&proof.proof_bytes);
    let nodes = published_nodes(&op, HOLD_COL);

    let collapsed = segments(true);
    println!("counterfactual: mask modelled as ONE repeated value");
    println!("  unknowns : {} (was {})", collapsed.len(), segments(false).len());
    println!("  equations: {}", nodes.len());

    assert_eq!(
        collapsed.len(),
        1 + FILLER_SEGMENTS + 1,
        "1 hold + the filler cycles + 1 collapsed mask"
    );
    assert!(
        nodes.len() > collapsed.len(),
        "the counterfactual must be over-determined or it proves nothing",
    );

    let solved = solve(system(&nodes, &collapsed), collapsed.len()).expect(
        "the collapsed model must close — if it does not, the solver or the \
         basis is broken and test 1's red is not evidence of anything",
    );

    // Segment 0 is rows 0..=95 of the hold column, which carry the commitment.
    println!("  hold-segment value recovered: {:#018x}", solved[0]);
    println!("  verdict  : solved — so the MASK is what blocks the real model");
}

// ===========================================================================
// 3. The three circuits side by side, as one sentence with numbers in it.
// ===========================================================================

#[test]
fn the_counting_argument_is_only_as_good_as_the_independence() {
    self_check_field();

    let proof = spend_proof(0xC7_5EED_0003);
    let op = parse_generic(&proof.proof_bytes);
    let published = published_nodes(&op, HOLD_COL).len();

    println!("            unknowns  equations  independent?  verdict");
    println!("  C0 (32)         32        110  n/a           SOLVED by plain Lagrange");
    println!("  C1 (128)        93        110  no, 35 copies SOLVED by the AIR-aware solve");
    let c7_unknowns = segments(false).len();
    println!("  C7 (512)  {c7_unknowns:>9}  {published:>9}  yes, CSPRNG   not solved by that instrument");

    // C7's margin is the mask's, and nothing else: strip the mask and the hold
    // column has a handful of unknowns against ~90 equations, which is C1's
    // situation twice over.
    let without_mask = c7_unknowns - MASK_ROWS;
    assert_eq!(without_mask, 1 + FILLER_SEGMENTS, "1 hold + the filler cycles");
    assert!(
        published > without_mask,
        "without the mask the hold column is over-determined by {}",
        published as i64 - without_mask as i64,
    );
    println!();
    println!("  C7 without its mask: {without_mask} unknowns against {published} equations");
    println!("  — the entire margin is the mask, and its independence is the claim.");
}
