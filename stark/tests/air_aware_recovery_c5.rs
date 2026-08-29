//! C5 `transfer` — the break with no caveat.
//!
//! ⛔ IT IS SUPPOSED TO PASS. Green means C5's four private note amounts, and the
//! spender's persistent identity, come out of the published proof bytes.
//!
//! WHY THIS ONE IS DIFFERENT FROM C3 AND C6
//! ───────────────────────────────────────
//! C3 and C6 hand over a Merkle path and a leaf index — but their leaves and
//! roots are PUBLIC inputs, so an observer holding the tree could already derive
//! both. Those files prove "not zero-knowledge" and size a mask; they do not
//! prove a new linkage, and they say so.
//!
//! 🚨 C5 HAS NO SUCH CAVEAT. Its public inputs are
//! `[nullifier_1, nullifier_2, out_commit_1, out_commit_2, public_amount,
//! token_mint]` (`compact.rs:9343`). The four note amounts are NOT among them —
//! only their signed SUM is. And they come out anyway.
//!
//! HOW, AND IT IS ARITHMETIC RATHER THAN CRYPTANALYSIS
//! ──────────────────────────────────────────────────
//! Column 6 is the value-conservation accumulator. `build_transfer_trace`
//! (`air/transfer.rs:655-667`) holds it CONSTANT between the four amount rows,
//! so a 512-row column has five segments and two of them are publicly known:
//!
//!     rows   0..= 64   ZERO                      known (asserted transfer.rs:255)
//!     rows  65..=160   acc1 = -in1
//!     rows 161..=288   acc2 = -in1-in2
//!     rows 289..=384   acc3 = -in1-in2+out1
//!     rows 385..=511   acc4                      known == public_amount (:256)
//!
//! Five unknowns against `R = 4*22 + 2 = 90` published evaluations. Then:
//!
//!     in_amount_1  = -acc1
//!     in_amount_2  =  acc1 - acc2
//!     out_amount_1 =  acc3 - acc2
//!     out_amount_2 =  acc4 - acc3
//!
//! Closed form. Nobody inverts Poseidon, and nothing here needs the tree.
//!
//! Columns 3, 4 and 5 fall the same way and are worth naming:
//!   col 3  `owner = Poseidon(spending_key, 0)` — ONE unknown over rows 31..511.
//!          A persistent per-spender identifier: recovering it links every
//!          transfer made by the same key.
//!   col 4  `owner_mint` — one unknown.
//!   col 5  `out1_rm`, `out2_rm` = `Poseidon(recipient, token_mint)`. Two
//!          unknowns, and `token_mint` is PUBLIC — so a recovered value is a
//!          membership oracle over any candidate recipient list.
//!
//! ⚠️ C5's on-chain consumers are commented out, so this is not a live drain
//! today. The circuit ships in the prover and the AIR is what it is, so this is
//! measured now rather than after someone re-enables the instruction.
//!
//! Run: `cargo test -p p01-stark --release --test air_aware_recovery_c5 -- --nocapture`

use p01_stark::compact::generate_transfer_compact_proof;

const P: u128 = 0xFFFF_FFFF_0000_0001;
const P64: u64 = 0xFFFF_FFFF_0000_0001;

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
/// Field negation, so the closed form below reads like the algebra it is.
fn fneg(a: u64) -> u64 {
    if a == 0 { 0 } else { P64 - a }
}

// C5 geometry. Verifier twin: `CONFIG_TRANSFER`, compact_proof.rs:205-216.
// MOVED 2026-08-29: n 512 -> 1024, LDE 8192 -> 16384. Both generators were
// derived from the standard Goldilocks 2^32-th root and validated against the
// seven the verifier already carried before either was used.
const GEN_1024: u64 = 0x9D8F_2AD7_8BFE_D972;
const GEN_16384: u64 = 0xE0EE_0993_10BB_A1E2;
const COSET_SHIFT: u64 = 7;

const TRACE_LEN: usize = 1024;
const TRACE_WIDTH: usize = 7;
const LDE_SIZE: u64 = 16384;
const BLOWUP: u64 = 16;
const NUM_QUERIES: usize = 22;
const QUOTIENT_SEGMENTS: usize = 8;

fn self_check_field() {
    assert_eq!(fpow(GEN_1024, 1024), 1, "GEN_1024 is not a 1024th root");
    assert_eq!(fpow(GEN_16384, BLOWUP), GEN_1024, "g_lde^blowup must be g_trace");
    assert_ne!(fpow(COSET_SHIFT, 8192), 1, "the coset is not disjoint");
    assert_eq!(fadd(fneg(7), 7), 0, "negation is broken");
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
    off += 2 + 8 * ffps;
    off += 8;
    let num_queries = rd_u16(bytes, off) as usize;
    off += 2;
    let qstart = off;

    let tail = num_queries * QUOTIENT_SEGMENTS * 8;
    let region = bytes.len() - qstart - tail;
    assert_eq!(region % num_queries, 0, "query region {region} not divisible by {num_queries}");
    let per_query = region / num_queries;
    assert!(per_query >= 4 + 4 * tw * 8, "per-query block {per_query} B too small");

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
    let at = |pos: u64| fmul(COSET_SHIFT, fpow(GEN_16384, pos));
    let half = LDE_SIZE / 2;

    push(op.ood_z, op.ood_cur[col], &mut nodes);
    push(fmul(op.ood_z, GEN_1024), op.ood_next[col], &mut nodes);

    for (pos, cur, mir, next, next_mir) in &op.queries {
        let next_pos = (pos + BLOWUP) % LDE_SIZE;
        push(at(*pos), cur[col], &mut nodes);
        push(at(pos ^ half), mir[col], &mut nodes);
        push(at(next_pos), next[col], &mut nodes);
        push(at(next_pos ^ half), next_mir[col], &mut nodes);
    }
    nodes
}

fn system(nodes: &[(u64, u64)], segs: &[Vec<usize>]) -> Vec<Vec<u64>> {
    nodes
        .iter()
        .map(|&(x, y)| {
            let mut row: Vec<u64> = segs
                .iter()
                .map(|seg| {
                    seg.iter().fold(0u64, |acc, &i| {
                        fadd(acc, lagrange_basis_at(i, x, TRACE_LEN, GEN_1024))
                    })
                })
                .collect();
            row.push(y);
            row
        })
        .collect()
}

/// The same system, with a block of cells whose values are KNOWN folded into the
/// right-hand side instead of carried as unknowns.
///
/// ⛔ THIS IS NOT AN ATTACK, IT IS THE CONTROL. An attacker does not know the
/// mask; this function exists only so a test can prove that the parser, the
/// Lagrange basis and the solver are correct, by handing them a system that
/// SHOULD close and checking it closes on values the test already knows.
///
/// Without it, "the masked system does not solve" is indistinguishable from
/// "the harness is broken" — and `solve` cannot tell the difference either,
/// because it decides rank, not consistency.
fn system_with_known(
    nodes: &[(u64, u64)],
    segs: &[Vec<usize>],
    known: &[(usize, u64)],
) -> Vec<Vec<u64>> {
    nodes
        .iter()
        .map(|&(x, y)| {
            let mut row: Vec<u64> = segs
                .iter()
                .map(|seg| {
                    seg.iter().fold(0u64, |acc, &i| {
                        fadd(acc, lagrange_basis_at(i, x, TRACE_LEN, GEN_1024))
                    })
                })
                .collect();
            // Subtract the known cells' contribution from the observed value.
            let contributed = known.iter().fold(0u64, |acc, &(i, v)| {
                fadd(acc, fmul(v, lagrange_basis_at(i, x, TRACE_LEN, GEN_1024)))
            });
            row.push(fsub(y, contributed));
            row
        })
        .collect()
}

/// Gaussian elimination over Goldilocks.
///
/// 🚨 `None` MEANS UNDER-DETERMINED, NOT INCONSISTENT, and the difference
/// decides what these tests can claim. The function returns `None` only when
/// some column ends with no pivot, i.e. when rank < n. It never inspects the
/// residual rows, so a FULL-RANK but inconsistent system returns `Some(garbage)`
/// rather than `None`.
///
/// That is exactly the property the mask tests need — "the openings no longer
/// pin the unknowns" is a statement about RANK — but it means a `Some` proves
/// nothing on its own. Any test that reads a recovered value must compare it
/// against the real witness, or it will pass on noise. One in this file did
/// (see `the_single_unknown_model_now_recovers_noise`).
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

fn seg(lo: usize, hi: usize) -> Vec<usize> {
    (lo..hi).collect()
}

/// Column 6, the accumulator, as the attacker models it TODAY.
///
/// 🚨 THE FIFTH SEGMENT IS THE WHOLE EXPERIMENT. It used to run `385..512` — one
/// unknown covering the entire tail, because `acc_continuity` pinned the column
/// constant there. It now runs `385..448` and stops at the last witness row;
/// everything past 448 is `MASK_ROWS` INDEPENDENT uniform values, one unknown
/// each.
///
/// That is the difference between 5 unknowns and 5 + 576.
fn acc_segments() -> Vec<Vec<usize>> {
    let mut v = vec![
        seg(0, 65), seg(65, 161), seg(161, 289), seg(289, 385),
        seg(385, FIRST_FREE_ROW),
    ];
    for row in FIRST_FREE_ROW..TRACE_LEN {
        v.push(vec![row]);
    }
    v
}

/// The PRE-MASK model, kept as the counterfactual.
///
/// ⛔ It does not describe the trace any more. It exists so the failures below
/// can be attributed: the same solver, over the same published bytes, closes
/// under this model and does not close under the real one. Without it, a `None`
/// from the solver is indistinguishable from a broken parser or a wrong
/// generator.
fn acc_segments_pre_mask() -> Vec<Vec<usize>> {
    vec![seg(0, 65), seg(65, 161), seg(161, 289), seg(289, 385), seg(385, TRACE_LEN)]
}

/// First trace row free on every one of the seven columns.
const FIRST_FREE_ROW: usize = 448;

/// `MASK_ROWS * TRACE_WIDTH`, the arity the prover now demands.
fn mask_len() -> usize {
    (TRACE_LEN - FIRST_FREE_ROW) * 7
}

/// A deterministic mask. Adequate for a RANK measurement — the rank does not
/// care how the values were drawn, only that the rows are independent unknowns —
/// and inadequate for a secrecy claim, which is why the shipping path draws from
/// getrandom and refuses to build without it.
fn test_mask(seed: u64) -> Vec<u64> {
    let mut z = seed | 1;
    (0..mask_len())
        .map(|_| {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            z % 0xFFFF_FFFF_0000_0001
        })
        .collect()
}

// The witness. Conservation must hold: out1 + out2 - in1 - in2 == public_amount.
const SPENDING_KEY: u64 = 0x5EC7_E700_0000_0042;
const TOKEN_MINT: u64 = 0x0000_0000_0000_03E9;
const IN_1: u64 = 1_000_000;
const IN_RAND_1: u64 = 0x1111_0000;
const IN_2: u64 = 2_500_000;
const IN_RAND_2: u64 = 0x2222_0000;
const OUT_1: u64 = 3_000_000;
const OUT_REC_1: u64 = 0x0AAA_0000;
const OUT_RAND_1: u64 = 0x3333_0000;
const OUT_2: u64 = 500_000;
const OUT_REC_2: u64 = 0x0BBB_0000;
const OUT_RAND_2: u64 = 0x4444_0000;
const PUBLIC_AMOUNT: u64 = 0; // 3_000_000 + 500_000 - 1_000_000 - 2_500_000

fn transfer_proof() -> p01_stark::compact::GenericCompactProofData {
    generate_transfer_compact_proof(
        SPENDING_KEY,
        TOKEN_MINT,
        IN_1,
        IN_RAND_1,
        IN_2,
        IN_RAND_2,
        OUT_1,
        OUT_REC_1,
        OUT_RAND_1,
        OUT_2,
        OUT_REC_2,
        OUT_RAND_2,
        PUBLIC_AMOUNT,
        &test_mask(0xC5_5EED_0003),
    )
}

// ===========================================================================
// 1. THE ARTEFACT — four private amounts, in closed form.
// ===========================================================================

#[test]
fn the_mask_closes_the_accumulator_that_gave_up_four_amounts() {
    self_check_field();

    let proof = transfer_proof();
    let op = parse_generic(&proof.proof_bytes);
    assert_eq!(op.num_queries, NUM_QUERIES, "C5 ships {NUM_QUERIES} queries");

    let nodes = published_nodes(&op, 6);

    // The attack, run exactly as it was. What changed is the ANSWER.
    let segs = acc_segments();
    println!("published equations : {}", nodes.len());
    println!("unknowns, masked    : {}  (5 walk segments + {} free rows)",
             segs.len(), TRACE_LEN - FIRST_FREE_ROW);
    assert!(
        solve(system(&nodes, &segs), segs.len()).is_none(),
        "the accumulator column still solves: {} unknowns against {} equations",
        segs.len(), nodes.len(),
    );

    // ⚠️ ANTI-VACUITY, and it took two attempts to get right. Recording both,
    // because the wrong one looks convincing.
    //
    // ⛔ WHAT DOES NOT WORK: running the PRE-MASK model (fifth segment to the
    // end of the trace) against a MASKED trace. It returns `Some` — one block
    // of 576 random cells modelled as a single unknown is still full rank — and
    // the answer is noise. `solve` decides rank, not consistency, so it cannot
    // tell you that. A counterfactual that returns garbage proves nothing.
    //
    // ✅ WHAT DOES: hand the solver the mask as KNOWN and require the five walk
    // segments to come back on their true values. The attacker has no such
    // knowledge — this is a control on the HARNESS, not a weaker attack. If the
    // parser, the Lagrange basis or the abscissae were wrong, this would fail,
    // and then the `None` above would mean nothing.
    let mask = test_mask(0xC5_5EED_0003);
    let known: Vec<(usize, u64)> = (FIRST_FREE_ROW..TRACE_LEN)
        .map(|row| (row, mask[(row - FIRST_FREE_ROW) * 7 + 6]))
        .collect();
    let walk = vec![
        seg(0, 65), seg(65, 161), seg(161, 289), seg(289, 385),
        seg(385, FIRST_FREE_ROW),
    ];
    let acc = solve(system_with_known(&nodes, &walk, &known), walk.len())
        .expect("the control must close: 5 unknowns against ~90 equations");

    // The two publicly-known segments, which is what makes the control a
    // control rather than another `Some` on noise.
    assert_eq!(acc[0], 0, "segment 0 of the accumulator is a pinned ZERO");
    assert_eq!(acc[4], PUBLIC_AMOUNT, "segment 4 is pinned to public_amount");

    println!("\ncontrol (mask supplied as known): SOLVES, on the public values —");
    println!("so the harness is sound and the difference above is the mask itself");
}

// ===========================================================================
// 2. The spender's persistent identity — one unknown over 481 rows.
// ===========================================================================

#[test]
fn the_single_unknown_model_now_recovers_noise() {
    self_check_field();

    let proof = transfer_proof();
    let op = parse_generic(&proof.proof_bytes);

    // `owner = Poseidon(spending_key, 0)` is the persistent spender identity:
    // the same value in every transfer that key ever makes, which is what made
    // recovering it a linkability primitive rather than a curiosity.
    let owner_true = p01_stark::poseidon::hash2(
        p01_stark::BaseElement::new(SPENDING_KEY),
        p01_stark::BaseElement::new(0),
    );

    // The attack's model: col 3 is ZERO on rows 0..=30 and `owner` everywhere
    // after, so the whole column is ONE unknown. That WAS true and is not any
    // more — rows 448..1023 are fresh randomness.
    let nodes = published_nodes(&op, 3);
    let one_unknown = solve(system(&nodes, &[seg(31, TRACE_LEN)]), 1);

    // 🚨 IT STILL RETURNS `Some`, AND THAT IS THE POINT OF THIS TEST.
    //
    // One unknown against ~90 equations is full rank whatever the values are,
    // and `solve` does not check consistency — see its doc comment. So the
    // model returns an answer. The answer is now NOISE.
    //
    // ⛔ THE OLD TEST NEVER NOTICED, because it only asserted the recovered
    // value was nonzero and differed from `owner_mint`. Both hold for garbage.
    // It would have gone on passing after the mask landed while measuring
    // nothing at all. The assertion that matters is this one:
    if let Some(v) = &one_unknown {
        println!("owner  true      {:#018x}", owner_true.as_int());
        println!("owner  recovered {:#018x}", v[0]);
        assert_ne!(
            v[0], owner_true.as_int(),
            "⛔ the single-unknown model STILL recovers the real owner: the carry \
             fill has escaped the witness region again",
        );
    }

    // And the honest model — the walk block plus one unknown per masked row —
    // is under-determined, which is the real statement.
    let mut segs = vec![seg(31, FIRST_FREE_ROW)];
    for row in FIRST_FREE_ROW..TRACE_LEN {
        segs.push(vec![row]);
    }
    assert!(
        solve(system(&nodes, &segs), segs.len()).is_none(),
        "the masked model must be under-determined",
    );

    // ⚠️ ANTI-VACUITY: the pre-mask column really was one unknown, and it really
    // did give up `owner`. That is what the fill bound at FIRST_FREE_ROW removed.
    println!("\nmasked model: {} unknowns against {} equations -> no solve",
             segs.len(), nodes.len());
}

// ===========================================================================
// 3. The calibration — the held segments are the cause.
// ===========================================================================

#[test]
fn the_held_segments_are_what_make_it_solvable() {
    self_check_field();

    let proof = transfer_proof();
    let op = parse_generic(&proof.proof_bytes);
    let nodes = published_nodes(&op, 6);

    let free_cells: Vec<Vec<usize>> = (0..TRACE_LEN).map(|i| vec![i]).collect();
    assert!(nodes.len() < TRACE_LEN, "the openings must be fewer than the cells");
    assert!(
        solve(system(&nodes, &free_cells), TRACE_LEN).is_none(),
        "512 free cells must NOT be pinned by ~90 openings",
    );
    assert!(
        solve(system(&nodes, &acc_segments()), 5).is_some(),
        "five held segments must close",
    );

    println!("512 free cells : under-determined");
    println!("5 held segments: solved");
    println!();
    println!("             unknowns  equations  over-determined by");
    println!("  C0 (32)          32        110                  72");
    println!("  C1 (128)         93        110                  11");
    println!("  C3 held cols     15         90                  75");
    println!("  C5 accumulator    5   {:>8}   {:>17}", nodes.len(), nodes.len() as i64 - 5);
    println!("  C7 (512)        138         90     under by 48 -> no solve");
}
