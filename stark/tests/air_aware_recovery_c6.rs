//! C6 `merkle_update` — the last measurement hole, and four of ten columns fall.
//!
//! ⛔ IT IS SUPPOSED TO PASS. Green means C6's authentication path, leaf index
//! and BOTH intermediate hash chains come out of the published proof bytes.
//!
//! C6 is C3's shape with two extra held columns. `build_merkle_update_trace`
//! (`air/merkle_update.rs:397-400, 445-448, 459-462`) writes the same value on
//! every one of the 32 rows of a cycle for four columns at once:
//!
//!     col 6  sibling      the authentication path        15 unknowns
//!     col 7  direction    the leaf index, in binary      15 unknowns
//!     col 8  old_carry    old_leaf -> ... -> old_root    16 segments, 2 public
//!     col 9  new_carry    new_leaf -> ... -> new_root    16 segments, 2 public
//!
//! against `R = 4*22 + 2 = 90` published evaluations per column. Depth is fixed
//! at 15 on chain (`verify.rs:3380`), so 15 cycles fill rows 0..480 and the tail
//! 480..512 is a literal `BaseElement::ZERO` for cols 6 and 7
//! (`merkle_update.rs:489-490`) — 32 cells that are not even unknowns.
//!
//! WHAT THE CARRY COLUMNS ADD OVER C3. Cols 8 and 9 are the full intermediate
//! hash chains, and their first and last segments are PUBLIC — `old_leaf` and
//! `old_root` are public inputs 0 and 2 (`compact.rs:9447`). That makes them the
//! control: solve all sixteen segments, then check that segment 0 is the public
//! leaf and segment 15 the public root. If those two land, the fourteen interior
//! values between them are real, and they let an observer VERIFY a recovered
//! path without ever touching the tree.
//!
//! ⚠️ THE SAME HONEST LIMIT AS C3, STATED AGAIN BECAUSE IT MATTERS. All four of
//! `old_leaf`, `new_leaf`, `old_root`, `new_root` are public. Someone holding
//! the tree could already walk it to the index and the siblings. This does not
//! create a linkage; it proves C6 is not zero-knowledge and sizes the mask.
//! C5 is the one with no such caveat — see `air_aware_recovery_c5.rs`.
//!
//! Run: `cargo test -p p01-stark --release --test air_aware_recovery_c6 -- --nocapture`

use p01_stark::compact::generate_merkle_update_compact_proof;

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

// C6 geometry. Verifier twin: `CONFIG_MERKLE_UPDATE`, compact_proof.rs:239-250.
const GEN_512: u64 = 0x1905_D02A_5C41_1F4E;
const GEN_8192: u64 = 0x1544_EF23_35D1_7997;
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
const TRACE_WIDTH: usize = p01_stark::air::merkle_update::TRACE_WIDTH;
const LDE_SIZE: u64 = 8192;
const BLOWUP: u64 = 16;
const NUM_QUERIES: usize = 22;
const QUOTIENT_SEGMENTS: usize = 8;
const HASH_CYCLE_LEN: usize = 32;
const DEPTH: usize = p01_stark::air::merkle_update::CANONICAL_DEPTH;

fn self_check_field() {
    assert_eq!(fpow(GEN_512, 512), 1, "GEN_512 is not a 512th root");
    assert_eq!(fpow(GEN_8192, BLOWUP), GEN_512, "g_lde^blowup must be g_trace");
    assert_ne!(fpow(COSET_SHIFT, 8192), 1, "the coset is not disjoint");
}

fn lagrange_basis_at(i: usize, x: u64, n: usize, g: u64) -> u64 {
    let gi = fpow(g, i as u64);
    let num = fmul(gi, fsub(fpow(x, n as u64), 1));
    let den = fmul(n as u64, fsub(x, gi));
    fmul(num, finv(den))
}

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

fn system(nodes: &[(u64, u64)], segs: &[Vec<usize>]) -> Vec<Vec<u64>> {
    nodes
        .iter()
        .map(|&(x, y)| {
            let mut row: Vec<u64> = segs
                .iter()
                .map(|s| {
                    s.iter().fold(0u64, |acc, &i| {
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

/// The 15 held cycles. `with_tail` adds rows 480..512, which is an unknown for
/// the carry columns (it holds the root) and a literal zero for sibling and
/// direction, where it must be omitted rather than modelled.
/// The attacker's best model. `_with_tail` is kept for signature compatibility
/// with the pre-mask version of this file and no longer changes anything: the
/// tail is not ONE segment any more.
///
/// 🚨 THAT IS THE WHOLE CHANGE. Before the depth-12 cut these rows were a frozen
/// copy of row 479, i.e. a single unknown that the held cycles already pinned.
/// They are now `MASK_ROWS` INDEPENDENT uniform values, so each is its own
/// unknown and the system stops closing.
fn cycles(_with_tail: bool) -> Vec<Vec<usize>> {
    let mut segs: Vec<Vec<usize>> = (0..DEPTH)
        .map(|c| (c * HASH_CYCLE_LEN..(c + 1) * HASH_CYCLE_LEN).collect())
        .collect();
    for row in (DEPTH * HASH_CYCLE_LEN)..TRACE_LEN {
        segs.push(vec![row]);
    }
    segs
}

/// `MASK_ROWS * TRACE_WIDTH`, the arity the prover now demands.
fn mask_len() -> usize {
    p01_stark::air::merkle_update::mask_len_for_depth(DEPTH)
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

const OLD_LEAF: u64 = 0x0A1D_1EAF_0000_0011;
const NEW_LEAF: u64 = 0x0E70_1EAF_0000_0022;
/// Deliberately irregular — an alternating pattern would be guessable without
/// reading a byte, and this file would prove nothing.
// [ZK-DEPTH 2026-08-31] Eleven, not twelve -- `DEPTH` follows
// `merkle_update::CANONICAL_DEPTH` and this literal did not. C3 carried the
// identical defect; both harnesses stopped compiling rather than stopped
// attacking, which is the one failure mode worth having.
const DIRECTIONS: [u8; DEPTH] = [0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1];

fn path_elements() -> Vec<u64> {
    (0..DEPTH as u64).map(|i| 0xC0DE_0000 + i * 6151).collect()
}

fn update_proof() -> p01_stark::compact::GenericCompactProofData {
    generate_merkle_update_compact_proof(
        OLD_LEAF,
        NEW_LEAF,
        &path_elements(),
        &DIRECTIONS.to_vec(),
        &test_mask(0xC6_5EED_0001),
    )
}

// ===========================================================================
// 1. THE ARTEFACT — path, index, and both hash chains.
// ===========================================================================

#[test]
fn the_mask_closes_the_four_columns_that_used_to_fall() {
    self_check_field();

    let proof = update_proof();
    let op = parse_generic(&proof.proof_bytes);
    assert_eq!(op.num_queries, NUM_QUERIES, "C6 ships {NUM_QUERIES} queries");

    let unknowns = cycles(false).len();
    let published = published_nodes(&op, 7).len();

    println!("C6 at depth {DEPTH}, masked");
    println!("  published equations per column : {published}");
    println!("  unknowns per column            : {unknowns}  ({DEPTH} held cycles + {} mask rows)", TRACE_LEN - DEPTH * HASH_CYCLE_LEN);
    println!("  short by                       : {}", unknowns as i64 - published as i64);
    println!();

    let mut solved = 0;
    for col in [6usize, 7, 8, 9] {
        let ok = solve(system(&published_nodes(&op, col), &cycles(false)), unknowns).is_some();
        println!("  col {col}: {}", if ok { "SOLVED" } else { "no solve" });
        if ok { solved += 1; }
    }

    println!();
    println!("  columns solved: {solved} of {TRACE_WIDTH}  (was 4 of 10 at depth 15, unmasked)");

    // The measurement this whole change exists to produce. It is asserted, not
    // merely printed, so a regression that re-arms the mask rows turns this red.
    assert_eq!(
        solved, 0,
        "the mask must close every held column; {solved} still solve",
    );
    assert!(
        unknowns > published,
        "under-determination is the argument: {unknowns} unknowns against {published} equations",
    );
}
#[test]
fn the_held_cycles_are_what_make_it_solvable() {
    self_check_field();

    let proof = update_proof();
    let op = parse_generic(&proof.proof_bytes);
    let nodes = published_nodes(&op, 7);

    let free_cells: Vec<Vec<usize>> = (0..TRACE_LEN).map(|i| vec![i]).collect();
    assert!(nodes.len() < TRACE_LEN, "the openings must be fewer than the cells");
    assert!(
        solve(system(&nodes, &free_cells), TRACE_LEN).is_none(),
        "512 free cells must NOT be pinned by ~90 openings",
    );
    assert!(
        solve(system(&nodes, &cycles(false)), DEPTH).is_some(),
        "fifteen held cycles must close",
    );

    println!("512 free cells  : under-determined");
    println!("{DEPTH} held cycles : solved");
}

// ===========================================================================
// 3. Four of ten columns, and the standing table.
// ===========================================================================
