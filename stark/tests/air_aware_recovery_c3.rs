//! C3 `merkle_path` — the third measurement hole, and the widest margin so far.
//!
//! ⛔ IT IS SUPPOSED TO PASS. A green run means C3's held columns come straight
//! out of the published bytes. It must go RED when C3 is masked.
//!
//! WHY C3 IS EASIER THAN C1, NOT HARDER
//! ────────────────────────────────────
//! C1 needed 35 linear equalities to close an 18-point gap. C3 hands over far
//! more, because three of its six columns are HELD CONSTANT for an entire
//! 32-row hash cycle — `build_merkle_trace` (air/merkle_path.rs:325-372) writes
//! the same value on every row of the cycle:
//!
//!     trace[3][row] = sibling;    // col 3, all 32 rows
//!     trace[4][row] = dir_felt;   // col 4, all 32 rows
//!     trace[5][row] = carry;      // col 5, all 32 rows
//!
//! At depth 15 that is 15 cycles, so each of those columns has FIFTEEN unknowns
//! over 480 rows. And the tail is not even unknown: rows 480..511 write literal
//! `BaseElement::ZERO` into cols 3 and 4 (`:389-390`), so 32 of the 512 cells
//! are publicly known constants rather than variables.
//!
//!     15 unknowns against R = 4*22 + 2 = 90 published evaluations.
//!     Over-determined by 75. C1's margin was 17.
//!
//! WHAT THE RECOVERED VALUES ARE — AND THE HONEST LIMIT
//! ───────────────────────────────────────────────────
//! col 4 is the DIRECTION BIT of each Merkle level, i.e. the leaf's index in
//! binary. col 3 is the AUTHENTICATION PATH. Neither is a public input: C3
//! publishes `[leaf, root, depth]` only (`verify.rs:848`).
//!
//! ⚠️ BUT DO NOT OVERSTATE IT, AND THIS IS THE PART THAT MATTERS. The leaf IS
//! public, and anyone holding the leaf can find its index and its siblings by
//! walking the published tree. So recovering them creates no linkage that public
//! data did not already offer. What this file proves is narrower and still
//! decisive: **C3 is not zero-knowledge** — its proof determines witness values
//! the statement does not — and it says by how much, which is what sizes the
//! mask that would fix it.
//!
//! 🚨 The same shape sits in C6 (`merkle_update`: cols 6-9 are sibling,
//! direction, old_carry, new_carry) and in C5's carry column. C3 is measured
//! first because it is on the live v3 spend path, paired with C1.
//!
//! Run: `cargo test -p p01-stark --release --test air_aware_recovery_c3 -- --nocapture`

use p01_stark::compact::generate_merkle_path_compact_proof;

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

// C3 geometry. Verifier twin: `CONFIG_MERKLE_PATH`, compact_proof.rs:136-145.
const GEN_512: u64 = 0x1905_D02A_5C41_1F4E; // trace generator, 512 rows
const GEN_8192: u64 = 0x1544_EF23_35D1_7997; // LDE generator, 8192 points
const COSET_SHIFT: u64 = 7;

// [ZK-RANDOMIZER + ZK-DEPTH-11 2026-08-30] ⛔ THESE ARE DERIVED NOW, NOT TYPED.
// Every one of them was a literal, and every one of them was wrong within a day:
// the depth cut moved DEPTH, the randomizer column moved TRACE_WIDTH, and the
// mask arity moved with both. The harness then PANICKED before building a proof,
// which took the repository's only executable evidence offline without anyone
// noticing -- the tests simply stopped running.
//
// A harness that re-derives the circuit's geometry is a second source of truth
// for a number that has exactly one. Read the circuit.
const TRACE_LEN: usize = 512;
const TRACE_WIDTH: usize = p01_stark::air::merkle_path::TRACE_WIDTH;
const LDE_SIZE: u64 = 8192;
const BLOWUP: u64 = 16;
const NUM_QUERIES: usize = 22;
const QUOTIENT_SEGMENTS: usize = 8;
const HASH_CYCLE_LEN: usize = 32;
const DEPTH: usize = p01_stark::air::merkle_path::CANONICAL_DEPTH;

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
// Wire (generic path)
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
// The AIR model. One unknown per HELD cycle; the padding tail is not an unknown
// at all for cols 3 and 4, because the builder writes a literal zero there.
// ---------------------------------------------------------------------------

/// The attacker's best model of the trace, as a partition into cells that must
/// hold the same value.
///
/// 🚨 THE `held_tail` FLAG IS NOW THE WHOLE EXPERIMENT, and its meaning has
/// inverted. It used to mean "col 5's padding block carries the final carry, so
/// model it as ONE unknown". Since 2026-08-29 no column has a held tail: rows
/// 384..511 are the blinding region and every row there is an INDEPENDENT
/// uniform value.
///
///   `held_tail = false` -> the honest model. 12 held cycles plus 128 free rows
///                          = 140 unknowns against ~90 equations. Cannot close.
///   `held_tail = true`  -> the PRE-MASK model, kept only as the counterfactual
///                          below. 13 unknowns against ~90. Closes immediately.
///
/// Keeping both is what makes the failure meaningful. A solver that returns
/// `None` proves nothing on its own -- it could be a broken parser, a wrong
/// generator, an off-by-one in the abscissae. The counterfactual runs the SAME
/// solver over the SAME published bytes and closes, so the only difference left
/// is the mask.
fn segments(held_tail: bool) -> Vec<Vec<usize>> {
    let mut segs: Vec<Vec<usize>> = (0..DEPTH)
        .map(|c| (c * HASH_CYCLE_LEN..(c + 1) * HASH_CYCLE_LEN).collect())
        .collect();
    if held_tail {
        // The pinned tail as it stood before the depth cut: one value repeated.
        segs.push((DEPTH * HASH_CYCLE_LEN..TRACE_LEN).collect());
    } else {
        for row in (DEPTH * HASH_CYCLE_LEN)..TRACE_LEN {
            segs.push(vec![row]);
        }
    }
    segs
}

/// `MASK_ROWS * TRACE_WIDTH`, the arity the prover now demands.
fn mask_len() -> usize {
    p01_stark::air::merkle_path::mask_len_for_depth(DEPTH)
}

/// A deterministic mask. Adequate for a RANK measurement -- the rank does not
/// care how the values were drawn, only that the rows are independent unknowns
/// -- and inadequate for a secrecy claim, which is why the shipping path draws
/// from getrandom and refuses to build without it.
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

/// One honest C3 proof, masked, at the canonical depth.
fn masked_proof() -> p01_stark::compact::GenericCompactProofData {
    generate_merkle_path_compact_proof(
        LEAF,
        &path_elements(),
        &DIRECTIONS.to_vec(),
        &test_mask(0xC3_5EED_0001),
    )
}

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

const LEAF: u64 = 0x0DEC_0DED_0000_0777;
/// Deliberately not alternating: a pattern would be guessable without any
/// recovery at all, and this file would prove nothing about the proof bytes.
// [ZK-DEPTH 2026-08-31] Eleven, not twelve. `DEPTH` follows
// `merkle_path::CANONICAL_DEPTH` and this literal did not, so the attack
// harness stopped compiling rather than stopped attacking -- the loud
// failure mode, for once.
const DIRECTIONS: [u8; DEPTH] = [1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1];

fn path_elements() -> Vec<u64> {
    (0..DEPTH as u64).map(|i| 0xBEEF_0000 + i * 7919).collect()
}

// ===========================================================================
// 1. THE ARTEFACT — the Merkle path and the leaf index, from the bytes.
// ===========================================================================

/// INVERTED 2026-08-29. This test used to be named
/// `c3_held_columns_are_recovered_from_published_bytes` and it PASSED: it read
/// the authentication path and the leaf index straight out of one honest
/// proof's published bytes.
///
/// It could, because C3's tail was a pinned copy of the last state. Each held
/// column contributed DEPTH + 1 unknowns across the whole 512-row trace, and the
/// wire publishes `R = 4 * 22 + 2 = 90` openings per column. 16 against 90 is
/// wildly over-determined, and Gaussian elimination did the rest -- no Poseidon
/// inversion required, because the AIR itself supplies the linear equalities.
///
/// The depth cut replaced that tail with 128 rows of fresh CSPRNG output. Each
/// is now its own unknown, so the count runs the other way: 12 + 128 = 140
/// against 90. The system is under-determined and there is nothing to solve.
///
/// ⛔ WHAT THIS DOES NOT SAY. It does not say C3 is zero-knowledge. It says the
/// held columns are no longer recoverable from the published TRACE openings.
/// The FRI salt, the vector commitment and the quotient decomposition are
/// untouched and carry no simulation argument -- see `stark/src/air/spend.rs`.
#[test]
fn the_mask_closes_the_two_columns_that_used_to_fall() {
    self_check_field();

    let op = parse_generic(&masked_proof().proof_bytes);
    assert_eq!(op.num_queries, NUM_QUERIES, "C3 ships {NUM_QUERIES} queries");

    let unknowns = segments(false).len();
    let dir_nodes = published_nodes(&op, 4);
    let sib_nodes = published_nodes(&op, 3);

    println!("published equations per column : {}", dir_nodes.len());
    println!("unknowns per column, masked    : {unknowns}  ({DEPTH} held cycles + {} free rows)",
             TRACE_LEN - DEPTH * HASH_CYCLE_LEN);
    println!("under-determined by            : {}", unknowns as i64 - dir_nodes.len() as i64);

    // The two columns that used to fall: col 4 is the leaf index in binary, col
    // 3 is the authentication path.
    let mut solved = 0;
    for (name, nodes) in [("direction bits (col 4)", &dir_nodes), ("siblings (col 3)", &sib_nodes)] {
        if solve(system(nodes, &segments(false)), unknowns).is_some() {
            println!("  {name}: STILL SOLVES");
            solved += 1;
        } else {
            println!("  {name}: under-determined, no solution");
        }
    }
    assert_eq!(
        solved, 0,
        "{solved} of C3's held columns are still recoverable from the published bytes",
    );

    // ⚠️ ANTI-VACUITY. A `None` from the solver is only evidence if the SAME
    // solver over the SAME bytes closes under the pre-mask model. Otherwise this
    // test would pass just as well with a broken parser or a wrong generator.
    assert!(
        solve(system(&dir_nodes, &segments(true)), DEPTH + 1).is_some(),
        "the PRE-MASK model must still close, or this test is measuring a broken \
         solver rather than the mask",
    );
    println!("\ncounterfactual (pinned tail, the pre-cut model): SOLVES");
    println!("so the difference is the mask, not the arithmetic");
}

// ===========================================================================
// 2. The calibration — the AIR is the cause, again.
// ===========================================================================

#[test]
fn the_held_columns_are_what_make_it_solvable() {
    self_check_field();

    let op = parse_generic(&masked_proof().proof_bytes);
    let nodes = published_nodes(&op, 4);

    // Without the AIR: 512 free cells against ~90 equations. Must not close.
    let free_cells: Vec<Vec<usize>> = (0..TRACE_LEN).map(|i| vec![i]).collect();
    assert!(
        nodes.len() < TRACE_LEN,
        "this test needs FEWER openings than cells, or the point is lost",
    );
    assert!(
        solve(system(&nodes, &free_cells), TRACE_LEN).is_none(),
        "the openings alone must not pin 512 free cells",
    );

    // With the AIR but WITHOUT the mask -- the pre-cut model: 13 unknowns,
    // pinned. This is the line that says the AIR was the cause.
    assert!(
        solve(system(&nodes, &segments(true)), DEPTH + 1).is_some(),
        "the pre-mask held-cycle model must close",
    );

    // With the AIR AND the mask: 140 unknowns, not pinned. The mask is the only
    // thing that changed between the two lines above and below.
    assert!(
        solve(system(&nodes, &segments(false)), segments(false).len()).is_none(),
        "the masked model must NOT close",
    );

    println!("512 free cells        : under-determined");
    println!("{DEPTH} held cycles + pinned tail : SOLVED   (the pre-cut state)");
    println!("{DEPTH} held cycles + 128 free    : under-determined (today)");
}

// ===========================================================================
// 3. The margin, side by side with the other two measured circuits.
// ===========================================================================

#[test]
fn c3_now_sits_with_c6_and_c7_on_the_under_determined_side() {
    self_check_field();

    let op = parse_generic(&masked_proof().proof_bytes);
    let published = published_nodes(&op, 4).len();
    let unknowns = segments(false).len();

    println!("             unknowns  equations  verdict");
    println!("  C0 (32)          32        110  SOLVES — no model, geometry must change");
    println!("  C1 (128)         93        110  SOLVES — n must go 128 -> 256");
    println!("  C3 masked     {unknowns:>4}   {published:>8}  under by {:<3} -> no solve",
             unknowns as i64 - published as i64);
    println!("  C6 masked        140         90  under by 50  -> no solve");
    println!("  C7 (512)         138         90  under by 48  -> no solve");

    // The margin, stated as the thing it actually is: the number of unknowns the
    // mask adds beyond what the wire can pin.
    assert!(
        unknowns as i64 - published as i64 > 40,
        "C3's masked margin is only {}; the cut left too little room",
        unknowns as i64 - published as i64,
    );

    // ⚠️ AND THE CAVEAT THAT WAS ALREADY TRUE STAYS TRUE. The leaf is a PUBLIC
    // input of C3, so its index and siblings follow from public data anyway for
    // anyone holding the tree. What the mask removes is the ability to read them
    // out of the PROOF alone, by someone who holds no tree at all.
}
