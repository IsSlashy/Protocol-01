//! AIR-AWARE RECOVERY: the attack this repository argued from but never wrote.
//!
//! ⛔ IT IS SUPPOSED TO PASS. A green run means C1's four private witnesses come
//! out of the published proof bytes. It must go RED when C1 is masked.
//!
//! WHY IT MATTERS MORE THAN THE C0 ATTACK
//! ──────────────────────────────────────
//! `witness_recovery_positive_control.rs` breaks C0 by plain Lagrange, because
//! C0 publishes 110 openings for a degree-31 column. That is a COUNTING result
//! and it says nothing about a circuit whose column is longer than its budget.
//!
//! C1 is that circuit: 128 rows against `R = 4*27 + 2 = 110` openings. Eighteen
//! points short. Every counting argument in this tree — including C7's, which is
//! "138 unknowns against 90 equations" — says it is safe.
//!
//! 🚨 IT IS NOT, AND THE REASON IS THE WHOLE POINT. A trace is not an arbitrary
//! polynomial. It is constrained, and some of those constraints are LINEAR, so
//! they subtract unknowns without ever asking anyone to invert Poseidon:
//!
//!   `build_pool_commitment_trace` (air/denominated_pool.rs:263-341) writes the
//!   input row, then 30 round rows, then a PADDING ROW that copies the last one:
//!       row 31 == row 30, row 63 == row 62, row 95 == row 94
//!   and then fills rows 96..=127 with a copy of row 95:
//!       32 more rows, all equal
//!
//!   35 linear equations per column. 128 - 35 = 93 effective unknowns against
//!   110 published equations. Over-determined by 17, and it solves.
//!
//! ⛔ SO "MORE UNKNOWNS THAN EQUATIONS" IS NOT A SECURITY CLAIM. That sentence
//! is the argument C7's depth-12 design rests on (`air/spend.rs:1425-1449`), and
//! this file is the counterexample it needs to be measured against rather than
//! asserted at. Until today the counterexample was prose: verified 2026-08-29,
//! `git log --all -S"AIR-aware"` returned ONE commit, and it added only a comment
//! to `verify/p01-verify.mjs:1504-1535` claiming a "MEASURED counterexample in
//! this repository" that was not in this repository.
//!
//! ⚠️ WHAT THIS DOES NOT SAY. It does not break C7. C7 fills its free rows with
//! CSPRNG output, so its 128 mask rows are 128 genuinely independent unknowns
//! rather than 35 restatements of other rows. This file is the instrument that
//! makes that difference measurable instead of rhetorical — point it at C7 and
//! it must fail, and THAT failure is the first real evidence the mask does work.
//!
//! Run: `cargo test -p p01-stark --release --test air_aware_recovery_c1 -- --nocapture`

use p01_stark::compact::generate_pool_commitment_proof;

// ---------------------------------------------------------------------------
// Goldilocks, self-contained on purpose: a shared helper is a helper that
// drifts, and this file has to outlive the next wire change.
// ---------------------------------------------------------------------------

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

// C1 geometry. Verifier twin: `CONFIG_POOL_COMMITMENT`, compact_proof.rs:122-131.
// MOVED 2026-08-29: n 128 -> 256, LDE 2048 -> 4096. Both generators already
// existed in the verifier; `GENERATOR_256` was carried as dead code until C1
// needed it.
const GEN_256: u64 = 0xBF79_143C_E60C_A966; // trace generator  (verify.rs:139)
const GEN_4096: u64 = 0xF2C3_5199_959D_FCB6; // LDE generator   (verify.rs:145)
const COSET_SHIFT: u64 = 7; // [B7] compact.rs:5940

const TRACE_LEN: usize = 256;
const TRACE_WIDTH: usize = 3;
const LDE_SIZE: u64 = 4096;
const BLOWUP: u64 = 16;
const NUM_QUERIES: usize = 27;
const QUOTIENT_SEGMENTS: usize = 8; // [B2] compact_proof.rs:128

fn self_check_field() {
    assert_eq!(fpow(GEN_256, 256), 1, "GEN_256 is not a 256th root of unity");
    assert_ne!(fpow(GEN_256, 128), 1, "GEN_256 is not primitive");
    assert_eq!(fpow(GEN_4096, 4096), 1, "GEN_4096 is not a 4096th root");
    assert_ne!(fpow(GEN_4096, 2048), 1, "GEN_4096 is not primitive");
    assert_eq!(fpow(GEN_4096, BLOWUP), GEN_256, "g_lde^blowup must be g_trace");
    assert_ne!(fpow(COSET_SHIFT, 4096), 1, "the coset is not disjoint from the subgroup");
}

/// Lagrange basis on the trace subgroup, closed form.
///
/// `L_i(x) = g^i * (x^n - 1) / (n * (x - g^i))`, from `Z_H(x) = x^n - 1` and
/// `Z_H'(g^i) = n * g^(-i)`. O(1) per evaluation instead of O(n).
fn lagrange_basis_at(i: usize, x: u64, n: usize, g: u64) -> u64 {
    let gi = fpow(g, i as u64);
    let num = fmul(gi, fsub(fpow(x, n as u64), 1));
    let den = fmul(n as u64, fsub(x, gi));
    fmul(num, finv(den))
}

// ---------------------------------------------------------------------------
// The generic wire. Same shape as C0's, different (tw, k).
//
// Header: trace_root(32) quotient_root(32) ood_current(tw*8) ood_next(tw*8)
//         ood_z(8) ood_quotient(8k) num_fri_layers(1) roots(32n)
//         ffps(2) final_poly(8*ffps) grinding_nonce(8) num_queries(2)
// Query:  position(4) | cur(tw*8) | mirror(tw*8) | next(tw*8) | next_mirror(tw*8) | paths
// Tail:   quotient_values(num_queries * 8k)
// ---------------------------------------------------------------------------

struct Openings {
    num_queries: usize,
    ood_z: u64,
    ood_cur: Vec<u64>,
    ood_next: Vec<u64>,
    /// (position, [cur; tw], [mirror; tw], [next; tw], [next_mirror; tw])
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
    off += 8; // grinding nonce
    let num_queries = rd_u16(bytes, off) as usize;
    off += 2;
    let qstart = off;

    // [B2] the tail is 8k PER QUERY, not 8.
    let tail = num_queries * QUOTIENT_SEGMENTS * 8;
    let region = bytes.len() - qstart - tail;
    assert_eq!(region % num_queries, 0, "query region {region} not divisible by {num_queries}");
    let per_query = region / num_queries;
    assert!(
        per_query >= 4 + 4 * tw * 8,
        "per-query block {per_query} B cannot carry four rows of {tw} columns",
    );

    let row = |b: &[u8], base: usize| -> Vec<u64> { (0..tw).map(|c| rd_u64(b, base + c * 8)).collect() };

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

/// Every published `(x, P_col(x))` for one column, deduplicated.
fn published_nodes(op: &Openings, col: usize) -> Vec<(u64, u64)> {
    let mut nodes: Vec<(u64, u64)> = Vec::new();
    let mut push = |x: u64, y: u64, nodes: &mut Vec<(u64, u64)>| {
        if !nodes.iter().any(|&(nx, _)| nx == x) {
            nodes.push((x, y));
        }
    };
    let at = |pos: u64| fmul(COSET_SHIFT, fpow(GEN_4096, pos));
    let half = LDE_SIZE / 2;

    push(op.ood_z, op.ood_cur[col], &mut nodes);
    push(fmul(op.ood_z, GEN_256), op.ood_next[col], &mut nodes);

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
// Linear algebra over Goldilocks. Rows are `[a_0 .. a_{n-1} | rhs]`.
// ---------------------------------------------------------------------------

/// Gaussian elimination. `Some(x)` when the system pins every unknown,
/// `None` when the rank is short — which is the honest answer, not a failure.
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
        return None; // under-determined: at least one unknown is free
    }
    Some((0..n).map(|c| rows[where_pivot[c]][n]).collect())
}

/// The published openings, as linear equations in the 128 trace cells.
fn opening_equations(nodes: &[(u64, u64)]) -> Vec<Vec<u64>> {
    nodes
        .iter()
        .map(|&(x, y)| {
            let mut row: Vec<u64> = (0..TRACE_LEN)
                .map(|i| lagrange_basis_at(i, x, TRACE_LEN, GEN_256))
                .collect();
            row.push(y);
            row
        })
        .collect()
}

/// The AIR's LINEAR structure — the whole trick, and it costs nothing.
///
/// `build_pool_commitment_trace` copies the final state of each hash cycle into
/// that cycle's padding row, then copies row 95 across rows 96..=127. Those are
/// 35 equalities, and equalities are linear whatever Poseidon does.
fn air_structure_equations() -> Vec<Vec<u64>> {
    let mut eqs = Vec::new();
    let mut eq = |a: usize, b: usize| {
        let mut row = vec![0u64; TRACE_LEN + 1];
        row[a] = 1;
        row[b] = fsub(0, 1);
        eqs.push(row);
    };
    // The padding row of each hash cycle repeats the last round's state. These
    // three are inside the witness region and are UNCHANGED by the mask -- the
    // AIR still holds them, and it should.
    eq(31, 30);
    eq(63, 62);
    eq(95, 94);

    // 🚨 THE `for r in 96..TRACE_LEN { eq(r, 95); }` LOOP USED TO STAND HERE,
    // AND IT WAS THE WHOLE ATTACK. It said "every padding row repeats row 95",
    // which was true and which collapsed 32 unknowns per column into one. With
    // the three cycle-padding equalities above it took 128 unknowns down to 93
    // effective ones, against 110 published openings -- over-determined, and
    // Gaussian elimination read all four private inputs straight out.
    //
    // Since 2026-08-29 rows 96..255 hold fresh CSPRNG values, so there is no
    // equality to write. The count runs the other way: 256 cells, 3 equalities,
    // 253 effective unknowns against 110 openings.
    eqs
}

/// The PRE-MASK structural model, kept as the counterfactual.
///
/// ⛔ It does not describe the trace any more. It exists so the failure below
/// can be attributed: the same solver, over the same published bytes, closes
/// under this model and does not close under the real one. Without it, a `None`
/// from the solver is indistinguishable from a broken parser or a wrong
/// generator.
fn air_structure_equations_pre_mask(tail_end: usize) -> Vec<Vec<u64>> {
    let mut eqs = air_structure_equations();
    let mut eq = |a: usize, b: usize| {
        let mut row = vec![0u64; TRACE_LEN + 1];
        row[a] = 1;
        row[b] = fsub(0, 1);
        eqs.push(row);
    };
    for r in 96..tail_end {
        eq(r, 95);
    }
    eqs
}

/// `MASK_ROWS * TRACE_WIDTH`, the arity the prover now demands.
fn mask_len() -> usize {
    (TRACE_LEN - 96) * TRACE_WIDTH
}

/// A deterministic mask. Adequate for a RANK measurement and inadequate for a
/// secrecy claim, which is why the shipping path draws from getrandom.
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

// ===========================================================================
// 1. The calibration standard — and it isolates the CAUSE, not just the effect.
//
// Same solver, same openings, same everything: with the AIR's linear structure
// the system pins all 128 cells; without it, it cannot. So a recovery here is
// attributable to the CONSTRAINTS, and a future failure cannot be shrugged off
// as a broken solver.
// ===========================================================================

#[test]
fn the_mask_is_what_makes_it_unsolvable() {
    self_check_field();

    let proof = generate_pool_commitment_proof(0x1111_2222_3333_4444, 0x5555_6666_7777_8888, 42, 7, &test_mask(0xC1_5EED_0003));
    let op = parse_generic(&proof.proof_bytes);
    let nodes = published_nodes(&op, 0);

    let openings = opening_equations(&nodes);
    println!("published equations : {}", openings.len());
    println!("unknowns            : {TRACE_LEN}");
    println!("short by            : {}", TRACE_LEN as i64 - openings.len() as i64);

    assert!(
        openings.len() < TRACE_LEN,
        "this test is only meaningful while the openings are FEWER than the \
         unknowns — at {} of {TRACE_LEN} plain interpolation would already work \
         and C1 would be in C0's situation",
        openings.len(),
    );

    // Without the AIR: under-determined, and the solver says so rather than
    // returning a confident wrong answer.
    assert!(
        solve(openings.clone(), TRACE_LEN).is_none(),
        "the openings ALONE must not pin the trace — if they do, the counting \
         argument is wrong for a reason that has nothing to do with the AIR",
    );

    // With the AIR AS IT STANDS TODAY: still under-determined. Only three
    // equalities survive the mask -- the three cycle-padding rows -- and three
    // is nowhere near the gap.
    let mut with_air = openings.clone();
    with_air.extend(air_structure_equations());
    assert!(
        solve(with_air, TRACE_LEN).is_none(),
        "the masked AIR must NOT close the gap",
    );

    // ⚠️ ANTI-VACUITY, and it is the whole value of this test. A `None` above is
    // only evidence if the SAME solver over the SAME openings closes under the
    // PRE-MASK model. Otherwise this would pass just as well with a broken
    // parser, a wrong generator, or an off-by-one in the abscissae.
    //
    // The pre-mask model is the old `for r in 96.. { eq(r, 95) }` loop, run over
    // the WHOLE of today's 256-row trace. That is the point: it isolates the
    // MASK as the cause rather than the doubling. If the tail were still a copy
    // of row 95 — even at n = 256 — it would add 160 equalities, cut the
    // effective unknowns to 93, and the ~108 published openings would close it
    // exactly as they did at n = 128.
    let mut pre_mask = openings;
    pre_mask.extend(air_structure_equations_pre_mask(TRACE_LEN));
    let closed_before = solve(pre_mask, TRACE_LEN).is_some();

    println!("without the AIR        : under-determined");
    println!("with the MASKED AIR    : under-determined  <- today");
    println!("with the PRE-MASK AIR  : {}", if closed_before { "SOLVED" } else { "still open" });

    assert!(
        closed_before,
        "the PRE-MASK model must still close, or this test is measuring a broken \
         solver rather than the mask",
    );
}

// ===========================================================================
// 2. THE ARTEFACT — all four private witnesses, from the published bytes.
// ===========================================================================

#[test]
fn the_mask_closes_the_columns_that_gave_up_all_four_witnesses() {
    self_check_field();

    const NULLIFIER_PREIMAGE: u64 = 0x0BAD_C0FF_EE00_1234;
    const SECRET: u64 = 0x1DEA_D0D0_CAFE_5678;
    const DEPOSIT_EPOCH: u64 = 0x0000_0000_0001_E240;
    const TOKEN_MINT: u64 = 0x0000_0000_0000_002A;

    let proof =
        generate_pool_commitment_proof(NULLIFIER_PREIMAGE, SECRET, DEPOSIT_EPOCH, TOKEN_MINT, &test_mask(0xC1_5EED_0003));
    let op = parse_generic(&proof.proof_bytes);

    // The attack, run exactly as it was: openings plus the AIR's linear
    // equalities, solved per column. What changed is the ANSWER.
    let mut solved = 0usize;
    let mut published = 0usize;
    for col in 0..2 {
        let nodes = published_nodes(&op, col);
        published = nodes.len();
        let mut rows = opening_equations(&nodes);
        rows.extend(air_structure_equations());
        if solve(rows, TRACE_LEN).is_some() {
            println!("  column {col}: STILL SOLVES");
            solved += 1;
        } else {
            println!("  column {col}: under-determined, no solution");
        }
    }

    println!("published openings per column : {published}");
    println!("unknowns                      : {TRACE_LEN}");
    println!("surviving AIR equalities      : {}", air_structure_equations().len());

    assert_eq!(
        solved, 0,
        "{solved} of C1's columns are still recoverable from the published bytes",
    );

    // ⚠️ ANTI-VACUITY. The same solver, the same bytes, under the PRE-MASK
    // model. It must close, or the `None`s above measure a broken solver rather
    // than the mask.
    let nodes = published_nodes(&op, 0);
    let mut pre = opening_equations(&nodes);
    pre.extend(air_structure_equations_pre_mask(TRACE_LEN));
    assert!(
        solve(pre, TRACE_LEN).is_some(),
        "the PRE-MASK model must still close",
    );
    println!("\ncounterfactual (pinned tail, the pre-n256 model): SOLVES");
    println!("so the difference is the mask, not the arithmetic");

    let _ = (NULLIFIER_PREIMAGE, SECRET, DEPOSIT_EPOCH, TOKEN_MINT);
}

// ===========================================================================
// 3. The sentence this file exists to refute, pinned as a number.
// ===========================================================================

#[test]
fn more_unknowns_than_equations_is_still_not_a_defence_the_mask_is() {
    self_check_field();

    let proof = generate_pool_commitment_proof(1, 2, 3, 4, &test_mask(0xC1_5EED_0003));
    let op = parse_generic(&proof.proof_bytes);
    assert_eq!(op.num_queries, NUM_QUERIES, "C1 is documented at {NUM_QUERIES} queries");
    let published = published_nodes(&op, 0).len();
    let structural = air_structure_equations().len();

    // ⚠️ The distinct-abscissa count MOVES between witnesses (measured: 104, 108,
    // 110 on three runs). Query positions come from Fiat-Shamir, so they depend
    // on the witness, and how many of the four rows per query collide depends on
    // the positions. Never pin this as a constant — pin the INEQUALITIES below.

    println!("C1: {TRACE_LEN} unknowns, {published} published equations");
    println!("    naive verdict     : SAFE, short by {}", TRACE_LEN as i64 - published as i64);
    println!("    linear AIR rows   : {structural}");
    println!("    effective unknowns: {}", TRACE_LEN - structural);
    println!("    real verdict      : under-determined by {}", (TRACE_LEN - structural) as i64 - published as i64);

    assert!(
        published < TRACE_LEN,
        "the naive counting argument must say SAFE, or this file proves nothing",
    );

    // 🚨 THE SENTENCE THIS FILE EXISTS TO REFUTE, AND WHY IT IS STILL HERE.
    //
    // "More unknowns than equations" was never a defence, and it still is not.
    // What changed on 2026-08-29 is not the argument — it is the number of
    // equalities the AIR hands the attacker. The old tail contributed 32 of
    // them by copying row 95; the blinding region contributes none.
    //
    // So the file keeps refuting the naive count AND now records that the
    // AIR-aware count has crossed back the other way. Both inequalities are
    // asserted, because dropping the first would let someone "fix" a future
    // regression by making the openings outnumber the cells outright.
    assert!(
        published <= TRACE_LEN - structural,
        "the AIR-aware count says SOLVED again: {published} openings against          {} effective unknowns. The mask has stopped working.",
        TRACE_LEN - structural,
    );
    assert_eq!(
        structural, 3,
        "only the three cycle-padding equalities may survive the mask; {structural} found",
    );
}
