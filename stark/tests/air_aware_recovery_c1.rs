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
const GEN_128: u64 = 0xF800_07FF_0800_0001; // trace generator  (verify.rs:136)
const GEN_2048: u64 = 0x0653_B480_1DA1_C8CF; // LDE generator   (verify.rs:143)
const COSET_SHIFT: u64 = 7; // [B7] compact.rs:5940

const TRACE_LEN: usize = 128;
const TRACE_WIDTH: usize = 3;
const LDE_SIZE: u64 = 2048;
const BLOWUP: u64 = 16;
const NUM_QUERIES: usize = 27;
const QUOTIENT_SEGMENTS: usize = 8; // [B2] compact_proof.rs:128

fn self_check_field() {
    assert_eq!(fpow(GEN_128, 128), 1, "GEN_128 is not a 128th root of unity");
    assert_ne!(fpow(GEN_128, 64), 1, "GEN_128 is not primitive");
    assert_eq!(fpow(GEN_2048, 2048), 1, "GEN_2048 is not a 2048th root");
    assert_ne!(fpow(GEN_2048, 1024), 1, "GEN_2048 is not primitive");
    assert_eq!(fpow(GEN_2048, BLOWUP), GEN_128, "g_lde^blowup must be g_trace");
    assert_ne!(fpow(COSET_SHIFT, 2048), 1, "the coset is not disjoint from the subgroup");
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
    let at = |pos: u64| fmul(COSET_SHIFT, fpow(GEN_2048, pos));
    let half = LDE_SIZE / 2;

    push(op.ood_z, op.ood_cur[col], &mut nodes);
    push(fmul(op.ood_z, GEN_128), op.ood_next[col], &mut nodes);

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
                .map(|i| lagrange_basis_at(i, x, TRACE_LEN, GEN_128))
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
    // The padding row of each hash cycle repeats the last round's state.
    eq(31, 30);
    eq(63, 62);
    eq(95, 94);
    // Rows 96..=127 all repeat row 95.
    for r in 96..TRACE_LEN {
        eq(r, 95);
    }
    eqs
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
fn the_air_is_what_makes_it_solvable() {
    self_check_field();

    let proof = generate_pool_commitment_proof(0x1111_2222_3333_4444, 0x5555_6666_7777_8888, 42, 7);
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

    // With it: pinned.
    let mut full = openings;
    full.extend(air_structure_equations());
    assert!(
        solve(full, TRACE_LEN).is_some(),
        "the AIR's 35 equalities must close the 18-point gap",
    );

    println!("without the AIR : under-determined");
    println!("with the AIR    : solved");
}

// ===========================================================================
// 2. THE ARTEFACT — all four private witnesses, from the published bytes.
// ===========================================================================

#[test]
fn c1_private_witnesses_are_recovered_from_published_bytes() {
    self_check_field();

    const NULLIFIER_PREIMAGE: u64 = 0x0BAD_C0FF_EE00_1234;
    const SECRET: u64 = 0x1DEA_D0D0_CAFE_5678;
    const DEPOSIT_EPOCH: u64 = 0x0000_0000_0001_E240;
    const TOKEN_MINT: u64 = 0x0000_0000_0000_002A;

    let proof =
        generate_pool_commitment_proof(NULLIFIER_PREIMAGE, SECRET, DEPOSIT_EPOCH, TOKEN_MINT);
    let op = parse_generic(&proof.proof_bytes);

    let mut solved = Vec::new();
    for col in 0..2 {
        let nodes = published_nodes(&op, col);
        let mut rows = opening_equations(&nodes);
        rows.extend(air_structure_equations());
        let cells = solve(rows, TRACE_LEN)
            .unwrap_or_else(|| panic!("column {col} did not solve — see the calibration test"));
        solved.push((nodes.len(), cells));
    }

    // Row 0 of cycle 0 is the pair (nullifier_preimage, secret); row 32 opens
    // cycle 1 with (deposit_epoch, token_mint). All four are PRIVATE — only the
    // Poseidon images are public.
    let rec_preimage = solved[0].1[0];
    let rec_secret = solved[1].1[0];
    let rec_epoch = solved[0].1[32];
    let rec_mint = solved[1].1[32];

    // Cross-check on PUBLIC values first: the nullifier ends cycle 0 at row 30
    // and the commitment ends cycle 2 at row 94. If these are wrong, the parser
    // or the basis is wrong and nothing below means anything.
    let rec_nullifier = solved[0].1[30];
    let rec_commitment = solved[0].1[94];

    println!("published openings per column : {}", solved[0].0);
    println!("nullifier   public  {:#018x}", proof.public_inputs[0]);
    println!("nullifier   solved  {rec_nullifier:#018x}");
    println!("commitment  public  {:#018x}", proof.public_inputs[1]);
    println!("commitment  solved  {rec_commitment:#018x}");
    println!("preimage    secret  {NULLIFIER_PREIMAGE:#018x} -> {rec_preimage:#018x}");
    println!("secret      secret  {SECRET:#018x} -> {rec_secret:#018x}");
    println!("epoch       secret  {DEPOSIT_EPOCH:#018x} -> {rec_epoch:#018x}");
    println!("mint        secret  {TOKEN_MINT:#018x} -> {rec_mint:#018x}");

    assert_eq!(
        rec_nullifier, proof.public_inputs[0],
        "the solve failed on a PUBLIC value — parser or Lagrange basis is wrong",
    );
    assert_eq!(rec_commitment, proof.public_inputs[1], "commitment cross-check failed");

    assert_eq!(rec_preimage, NULLIFIER_PREIMAGE, "nullifier_preimage not recovered");
    assert_eq!(rec_secret, SECRET, "⛔ the SPEND SECRET is recoverable from the proof bytes");
    assert_eq!(rec_epoch, DEPOSIT_EPOCH, "deposit_epoch not recovered");
    assert_eq!(rec_mint, TOKEN_MINT, "token_mint not recovered");
}

// ===========================================================================
// 3. The sentence this file exists to refute, pinned as a number.
// ===========================================================================

#[test]
fn more_unknowns_than_equations_is_not_a_defence() {
    self_check_field();

    let proof = generate_pool_commitment_proof(1, 2, 3, 4);
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
    println!("    real verdict      : SOLVED, over-determined by {}", published as i64 - (TRACE_LEN - structural) as i64);

    assert!(
        published < TRACE_LEN,
        "the naive counting argument must say SAFE, or this file proves nothing",
    );
    assert!(
        published > TRACE_LEN - structural,
        "and the AIR-aware count must say SOLVED",
    );
}
