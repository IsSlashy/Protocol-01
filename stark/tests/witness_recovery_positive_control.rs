//! THE POSITIVE CONTROL: recover a private witness from published proof bytes.
//!
//! ⛔ THIS FILE IS SUPPOSED TO PASS TODAY. A green run means the leak is REAL
//! and reproducible. The day a genuinely zero-knowledge prover ships, this file
//! must go RED — that is its entire purpose, and it is the only thing that can
//! make a future "recovery failed" claim mean anything.
//!
//! WHY IT EXISTS AGAIN
//! ───────────────────
//! `stark/tests/zk_feasibility.rs` did this job and was deleted in `dc9dd515`
//! because two wire changes broke its PARSER — not its premise:
//!
//!   1. [ROUTE C] four trace rows travel per query, not two
//!      (`compact.rs:2536-2552`: `row(pos) | row(pos^half) | row(next) |
//!      row(next^half)`). The old parser read `next` at `q+28`, which is now
//!      the MIRROR row. Openings per column went from `2q+2` to `4q+2`.
//!   2. [B7] the LDE evaluates on a COSET, `LDE_COSET_SHIFT_U64 = 7`
//!      (`compact.rs:5940`, applied at `:279`, `:710`, `:1078`). The abscissa is
//!      `7·g^pos`, so the old `fpow(GEN_512, pos)` computed the wrong x.
//!
//! 🚨 BOTH CHANGES MAKE THE RECOVERY EASIER, NOT HARDER. The coset closed the
//! verbatim-read channel — a query no longer lands on a trace row — and it does
//! nothing at all against interpolation, because every published value is still
//! an exact evaluation of the true column polynomial. Route C then DOUBLED the
//! number of those evaluations. C0 now publishes `4·27 + 2 = 110` openings
//! against a degree-31 column that needs 32. Deleting the probe removed the only
//! executable proof of a leak that had got worse.
//!
//! WHAT IS AND IS NOT CLAIMED HERE
//! ───────────────────────────────
//! This file attacks C0 (`subscriber_ownership`) by plain Lagrange
//! interpolation, which works because `110 >= 32`. It says NOTHING about C1,
//! C3, C6 or C7, whose columns are longer than their opening budgets and which
//! need an AIR-AWARE solve — the constraints supplying the equations the
//! openings do not. That attack does not exist in this repository.
//!
//! ⛔ AND UNTIL IT DOES, DO NOT CITE "four C1 witnesses recovered in 5 ms".
//! Verified 2026-08-29: `git log --all -S"AIR-aware"` returns ONE commit,
//! `62905c0d`, and it adds only prose to `verify/p01-verify.mjs:1504-1535`. No
//! Rust, no test, on no branch. The probe text calls it a "MEASURED
//! counterexample in this repository" and it is not in this repository.
//!
//! Run: `cargo test -p p01-stark --release --test witness_recovery_positive_control -- --nocapture`

use p01_stark::compact::generate_compact_proof;

// ---------------------------------------------------------------------------
// Goldilocks, p = 2^64 - 2^32 + 1. Self-contained and self-validated, so this
// file cannot drift with a helper it does not own.
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

/// Fermat inverse: a^(p-2), p-2 = 0xFFFFFFFEFFFFFFFF.
fn finv(a: u64) -> u64 {
    fpow(a, 0xFFFF_FFFE_FFFF_FFFF)
}

// Deployed constants. Trace/LDE generators from `verify.rs:64-78`; the coset
// shift from `compact.rs:5940`.
const GEN_32: u64 = 0x0000_3FFF_FFFF_C000; // trace generator, 32 rows
const GEN_512: u64 = 0x1905_D02A_5C41_1F4E; // LDE generator, 512 points
const COSET_SHIFT: u64 = 7; // [B7] LDE_COSET_SHIFT_U64

const LDE_SIZE: u64 = 512;
const BLOWUP: u64 = 16;
const TRACE_LEN: usize = 32;
const TRACE_WIDTH: usize = 3;
const NUM_QUERIES: usize = 27;
/// [B2] C0 splits its quotient into 7 segments (`compact_proof.rs:114`). The
/// count is NOT on the wire — the verifier takes it from `CircuitConfig`, so a
/// parser has to know it. It widens exactly three fields: the header
/// `ood_quotient` (8 -> 8k), the per-query quotient mirror block, and the tail
/// `quotient_values` (8 -> 8k PER QUERY). Missing that is the third drift that
/// killed the old probe.
const QUOTIENT_SEGMENTS: usize = 7;

/// If any relation here fails, every number this file prints is worthless, so
/// it fails loudly rather than quietly recovering garbage.
fn self_check_field() {
    assert_eq!(fpow(GEN_512, 512), 1, "GEN_512 is not a 512th root of unity");
    assert_ne!(fpow(GEN_512, 256), 1, "GEN_512 is not primitive");
    assert_eq!(fpow(GEN_32, 32), 1, "GEN_32 is not a 32nd root of unity");
    assert_ne!(fpow(GEN_32, 16), 1, "GEN_32 is not primitive");
    assert_eq!(fpow(GEN_512, BLOWUP), GEN_32, "g_lde^blowup must equal g_trace");
    assert_eq!(fmul(3, finv(3)), 1, "inverse is broken");

    // 🚨 THE COSET MUST BE DISJOINT FROM THE TRACE DOMAIN. That is what B7 buys,
    // it is what makes a verbatim read impossible, and it is also why the target
    // abscissa below can never collide with a published node.
    assert_ne!(
        fpow(COSET_SHIFT, 512),
        1,
        "shift 7 is inside the subgroup: the coset is not disjoint",
    );
}

/// Lagrange-evaluate the unique polynomial through `nodes` at `x0`.
fn lagrange_eval(nodes: &[(u64, u64)], x0: u64) -> u64 {
    let mut acc = 0u64;
    for (i, &(xi, yi)) in nodes.iter().enumerate() {
        let mut num = 1u64;
        let mut den = 1u64;
        for (j, &(xj, _)) in nodes.iter().enumerate() {
            if i == j {
                continue;
            }
            num = fmul(num, fsub(x0, xj));
            den = fmul(den, fsub(xi, xj));
        }
        acc = fadd(acc, fmul(yi, fmul(num, finv(den))));
    }
    acc
}

// ---------------------------------------------------------------------------
// The C0 wire, [ROUTE C] aware.
//
// Header: trace_root(32) quotient_root(32) ood_current[3](24) ood_next[3](24)
//         ood_z(8) ood_quotient(8*k) num_fri_layers(1) roots(32*n)
//         ffps(2) final_poly(8*ffps) grinding_nonce(8) num_queries(2)
// Per query: position(4) | cur[3](24) | mirror[3](24) | next[3](24)
//            | next_mirror[3](24) | merkle paths...
// ---------------------------------------------------------------------------

struct Openings {
    num_queries: usize,
    ood_z: u64,
    ood_cur0: u64,
    ood_next0: u64,
    /// (position, P0(pos), P0(mirror), P0(next), P0(next_mirror))
    queries: Vec<(u64, u64, u64, u64, u64)>,
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

fn parse_c0(bytes: &[u8]) -> Openings {
    let ood_cur0 = rd_u64(bytes, 64);
    let ood_next0 = rd_u64(bytes, 88);
    let ood_z = rd_u64(bytes, 112);

    let hdr = 120 + QUOTIENT_SEGMENTS * 8; // ood_z ends at 120, then ood_quotient[k]
    let num_fri_layers = bytes[hdr] as usize;
    let mut off = hdr + 1 + 32 * num_fri_layers;
    let ffps = rd_u16(bytes, off) as usize;
    off += 2 + 8 * ffps;
    off += 8; // grinding nonce
    let num_queries = rd_u16(bytes, off) as usize;
    off += 2;
    let qstart = off;

    // The tail after the query blocks is quotient_values, one felt per query.
    // Deriving the stride rather than hardcoding it is exactly what let the OLD
    // parser survive Route C's byte growth while silently reading the wrong
    // FIELD. So the stride is derived AND the layout is asserted.
    let tail = num_queries * QUOTIENT_SEGMENTS * 8;
    let region = bytes.len() - qstart - tail;
    assert_eq!(
        region % num_queries,
        0,
        "query region {region} not divisible by {num_queries} queries",
    );
    let per_query = region / num_queries;
    assert!(
        per_query >= 4 + 4 * TRACE_WIDTH * 8,
        "per-query block is {per_query} B, too small to carry four rows of \
         {TRACE_WIDTH} columns — the wire is not [ROUTE C] and this parser \
         would misread it",
    );

    let mut queries = Vec::with_capacity(num_queries);
    for k in 0..num_queries {
        let q = qstart + k * per_query;
        let position = rd_u32(bytes, q) as u64;
        let stride = TRACE_WIDTH * 8; // 24
        queries.push((
            position,
            rd_u64(bytes, q + 4),                  // row(pos)
            rd_u64(bytes, q + 4 + stride),         // row(pos ^ half)
            rd_u64(bytes, q + 4 + 2 * stride),     // row(next_pos)
            rd_u64(bytes, q + 4 + 3 * stride),     // row(next_pos ^ half)
        ));
    }
    Openings { num_queries, ood_z, ood_cur0, ood_next0, queries }
}

/// Every published `(x, P_0(x))` node, deduplicated, excluding `exclude_x`.
///
/// 🚨 THE ABSCISSA IS `7 * g^pos`, NOT `g^pos`. Getting this wrong does not
/// raise an error — it produces a wrong answer that reads as "recovery failed",
/// which is precisely the false green this file exists to prevent.
fn column0_nodes(op: &Openings, exclude_x: u64) -> Vec<(u64, u64)> {
    let mut nodes: Vec<(u64, u64)> = Vec::new();
    let push = |x: u64, y: u64, nodes: &mut Vec<(u64, u64)>| {
        if x == exclude_x {
            return;
        }
        if !nodes.iter().any(|&(nx, _)| nx == x) {
            nodes.push((x, y));
        }
    };
    let at = |pos: u64| fmul(COSET_SHIFT, fpow(GEN_512, pos));
    let half = LDE_SIZE / 2;

    push(op.ood_z, op.ood_cur0, &mut nodes);
    push(fmul(op.ood_z, GEN_32), op.ood_next0, &mut nodes);

    for &(pos, cur, mir, next, next_mir) in &op.queries {
        let next_pos = (pos + BLOWUP) % LDE_SIZE;
        push(at(pos), cur, &mut nodes);
        push(at(pos ^ half), mir, &mut nodes);
        push(at(next_pos), next, &mut nodes);
        push(at(next_pos ^ half), next_mir, &mut nodes);
    }
    nodes
}

// ===========================================================================
// 1. The opening budget, read off the wire rather than quoted.
// ===========================================================================

#[test]
fn published_openings_per_column_are_four_q_plus_two() {
    self_check_field();
    let proof = generate_compact_proof(0x1234_5678_9ABC_DEF0);
    let op = parse_c0(&proof.proof_bytes);

    assert_eq!(op.num_queries, NUM_QUERIES, "C0 is documented at {NUM_QUERIES} queries");

    let per_col = 4 * op.num_queries + 2;
    assert_eq!(per_col, 110, "R must be 4q+2 on the Route C wire");

    // ⛔ The 46 that still survives in `masking_deep_degree_gate.rs:112` and in
    // several memory files is the TWO-row number. It is wrong on this wire, and
    // wrong in the direction that UNDER-states the leak.
    assert_ne!(per_col, 46, "46 is the pre-Route-C figure — do not re-quote it");

    let nodes = column0_nodes(&op, 0);
    println!("C0 openings per trace column : 4*{} + 2 = {}", op.num_queries, per_col);
    println!("distinct published abscissae : {}", nodes.len());
    println!("degree of the column         : < {TRACE_LEN}");
    println!("over-determined by           : {}", nodes.len() as i64 - TRACE_LEN as i64);

    assert!(
        nodes.len() >= TRACE_LEN,
        "only {} distinct nodes for a degree-<{TRACE_LEN} column — recovery would \
         be impossible for a COUNTING reason, and a red here is not a ZK result",
        nodes.len(),
    );
}

// ===========================================================================
// 2. The calibration standard.
//
// Without this, a "recovery failed" result is indistinguishable from broken
// arithmetic. It recovers a KNOWN polynomial with n points and shows the SAME
// machinery failing with n-1 — so a failure downstream is evidence, not a bug.
// ===========================================================================

#[test]
fn the_recovery_machinery_is_calibrated() {
    self_check_field();

    // A degree-31 polynomial with known coefficients, sampled on the real coset.
    let coeffs: Vec<u64> =
        (0..TRACE_LEN as u64).map(|i| fadd(fmul(i, 1_000_003), 7)).collect();
    let eval = |x: u64| {
        let mut acc = 0u64;
        for &c in coeffs.iter().rev() {
            acc = fadd(fmul(acc, x), c);
        }
        acc
    };
    let truth = eval(1);

    let sample = |n: usize| -> Vec<(u64, u64)> {
        (0..n as u64)
            .map(|i| {
                let x = fmul(COSET_SHIFT, fpow(GEN_512, i));
                (x, eval(x))
            })
            .collect()
    };

    let with_enough = lagrange_eval(&sample(TRACE_LEN), 1);
    assert_eq!(with_enough, truth, "the interpolator must recover with {TRACE_LEN} points");

    let with_one_short = lagrange_eval(&sample(TRACE_LEN - 1), 1);
    assert_ne!(
        with_one_short, truth,
        "with {} points the interpolant is a DIFFERENT polynomial and must not \
         reproduce the value — if it does, this file cannot tell a real defence \
         from an accident",
        TRACE_LEN - 1,
    );

    println!("calibration: {TRACE_LEN} points recover, {} do not", TRACE_LEN - 1);
}

// ===========================================================================
// 3. THE ARTEFACT — the private witness, out of the published bytes.
// ===========================================================================

#[test]
fn c0_private_witness_is_recovered_from_published_bytes() {
    self_check_field();

    const SECRET: u64 = 0x1234_5678_9ABC_DEF0;
    let proof = generate_compact_proof(SECRET);
    let op = parse_c0(&proof.proof_bytes);

    // C0's trace row 0 is `[secret, 0, 0]` (air/subscriber_ownership.rs:213),
    // and row 0 sits at trace-domain point g^0 = 1. So P_0(1) IS the secret.
    let target_x = 1u64;
    let nodes = column0_nodes(&op, target_x);

    // Non-vacuity: the target must not be among the published points, or this
    // would be a byte copy dressed up as an attack. The coset guarantees that;
    // assert it anyway, because the guarantee is one constant away from gone.
    assert!(
        !nodes.iter().any(|&(x, _)| x == target_x),
        "the target abscissa is published verbatim — this is not interpolation",
    );
    assert!(
        nodes.len() >= TRACE_LEN,
        "need >= {TRACE_LEN} distinct nodes, have {}",
        nodes.len(),
    );

    let used: Vec<(u64, u64)> = nodes.iter().copied().take(TRACE_LEN).collect();
    let recovered_secret = lagrange_eval(&used, target_x);

    // Cross-check on a PUBLIC value, so a pass cannot be a coincidence of the
    // Lagrange machinery: row 30 of column 0 is the commitment.
    let recovered_commitment = lagrange_eval(&used, fpow(GEN_32, 30));

    println!("secret     expected  {SECRET:#018x}");
    println!("secret     recovered {recovered_secret:#018x}");
    println!("commitment expected  {:#018x}", proof.commitment);
    println!("commitment recovered {recovered_commitment:#018x}");
    println!(
        "nodes used {} of {} published, from {} proof bytes",
        used.len(),
        nodes.len(),
        proof.proof_bytes.len(),
    );

    assert_eq!(
        recovered_commitment, proof.commitment,
        "the machinery failed on a PUBLIC value — the parser or the abscissa \
         rule is wrong, and any verdict about the secret would be meaningless",
    );
    assert_eq!(
        recovered_secret, SECRET,
        "⛔ THE LEAK CLOSED, OR THE HARNESS BROKE. If a masked prover shipped, \
         this file has done its job and must be RETIRED DELIBERATELY, never \
         patched to pass. If nothing shipped, the parser drifted — fix the parser.",
    );
}
