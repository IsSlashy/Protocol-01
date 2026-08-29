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

const TRACE_LEN: usize = 512;
const TRACE_WIDTH: usize = 10;
const LDE_SIZE: u64 = 8192;
const BLOWUP: u64 = 16;
const NUM_QUERIES: usize = 22;
const QUOTIENT_SEGMENTS: usize = 8;
const HASH_CYCLE_LEN: usize = 32;
const DEPTH: usize = 15;

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
fn cycles(with_tail: bool) -> Vec<Vec<usize>> {
    let mut segs: Vec<Vec<usize>> = (0..DEPTH)
        .map(|c| (c * HASH_CYCLE_LEN..(c + 1) * HASH_CYCLE_LEN).collect())
        .collect();
    if with_tail {
        segs.push((DEPTH * HASH_CYCLE_LEN..TRACE_LEN).collect());
    }
    segs
}

const OLD_LEAF: u64 = 0x0A1D_1EAF_0000_0011;
const NEW_LEAF: u64 = 0x0E70_1EAF_0000_0022;
/// Deliberately irregular — an alternating pattern would be guessable without
/// reading a byte, and this file would prove nothing.
const DIRECTIONS: [u8; DEPTH] = [0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1];

fn path_elements() -> Vec<u64> {
    (0..DEPTH as u64).map(|i| 0xC0DE_0000 + i * 6151).collect()
}

fn update_proof() -> p01_stark::compact::GenericCompactProofData {
    generate_merkle_update_compact_proof(OLD_LEAF, NEW_LEAF, &path_elements(), &DIRECTIONS.to_vec())
}

// ===========================================================================
// 1. THE ARTEFACT — path, index, and both hash chains.
// ===========================================================================

#[test]
fn c6_held_columns_and_both_carry_chains_are_recovered() {
    self_check_field();

    let proof = update_proof();
    let op = parse_generic(&proof.proof_bytes);
    assert_eq!(op.num_queries, NUM_QUERIES, "C6 ships {NUM_QUERIES} queries");

    let pe = path_elements();

    // col 6 / col 7 — sibling and direction, tail is a literal zero.
    let sibs = solve(system(&published_nodes(&op, 6), &cycles(false)), DEPTH)
        .expect("col 6 must solve");
    let dirs = solve(system(&published_nodes(&op, 7), &cycles(false)), DEPTH)
        .expect("col 7 must solve");

    // col 8 / col 9 — the carry chains. Sixteen segments, of which the first and
    // last are PUBLIC. Solve all sixteen and use those two as the control.
    let old_nodes = published_nodes(&op, 8);
    let old_chain = solve(system(&old_nodes, &cycles(true)), DEPTH + 1)
        .expect("col 8 must solve");
    let new_chain = solve(system(&published_nodes(&op, 9), &cycles(true)), DEPTH + 1)
        .expect("col 9 must solve");

    println!("published equations per column : {}", old_nodes.len());
    println!("unknowns: sibling {DEPTH}, direction {DEPTH}, each carry {}", DEPTH + 1);
    println!();
    println!("direction expected  {DIRECTIONS:?}");
    println!("direction recovered {dirs:?}");
    println!("sibling[7]  {:#018x} -> {:#018x}", pe[7], sibs[7]);
    println!();
    println!("old_leaf (public input 0) {:#018x} -> chain[0]  {:#018x}", proof.public_inputs[0], old_chain[0]);
    println!("old_root (public input 2) {:#018x} -> chain[15] {:#018x}", proof.public_inputs[2], old_chain[DEPTH]);
    println!("new_leaf (public input 1) {:#018x} -> chain[0]  {:#018x}", proof.public_inputs[1], new_chain[0]);
    println!("new_root (public input 3) {:#018x} -> chain[15] {:#018x}", proof.public_inputs[3], new_chain[DEPTH]);

    // The control first: if the public endpoints of the chains do not land, the
    // parser or the basis is wrong and nothing else here means anything.
    assert_eq!(old_chain[0], proof.public_inputs[0], "old chain must start at the public old_leaf");
    assert_eq!(old_chain[DEPTH], proof.public_inputs[2], "and end at the public old_root");
    assert_eq!(new_chain[0], proof.public_inputs[1], "new chain must start at the public new_leaf");
    assert_eq!(new_chain[DEPTH], proof.public_inputs[3], "and end at the public new_root");

    for (level, &want) in DIRECTIONS.iter().enumerate() {
        assert_eq!(dirs[level], want as u64, "direction of level {level}");
    }
    for (level, &want) in pe.iter().enumerate() {
        assert_eq!(sibs[level], want, "sibling of level {level}");
    }

    let index: u64 = DIRECTIONS.iter().enumerate().fold(0, |a, (i, &b)| a | ((b as u64) << i));
    let rec: u64 = dirs.iter().enumerate().fold(0, |a, (i, &b)| a | (b << i));
    println!("\nleaf index {index} -> {rec}");
    assert_eq!(rec, index, "the leaf index is the direction bits read as binary");

    // The fourteen interior carries are the intermediate hashes. They are what
    // lets an observer CHECK the recovered path without touching the tree.
    println!("interior old-chain hashes recovered: {}", DEPTH - 1);
    assert_ne!(old_chain[1], 0, "an interior carry of zero would mean a mis-modelled segment");
}

// ===========================================================================
// 2. The calibration — the held cycles are the cause.
// ===========================================================================

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

#[test]
fn four_of_ten_columns_are_determined_by_the_published_bytes() {
    self_check_field();

    let proof = update_proof();
    let op = parse_generic(&proof.proof_bytes);
    let published = published_nodes(&op, 7).len();

    let mut solved = 0;
    for (col, n) in [(6usize, DEPTH), (7, DEPTH), (8, DEPTH + 1), (9, DEPTH + 1)] {
        let segs = cycles(n > DEPTH);
        if solve(system(&published_nodes(&op, col), &segs), n).is_some() {
            solved += 1;
        }
    }
    println!("columns solved: {solved} of {TRACE_WIDTH}");
    assert_eq!(solved, 4, "cols 6,7,8,9 must all solve");

    println!();
    println!("             unknowns  equations  over-determined by");
    println!("  C0 (32)          32        110                  72");
    println!("  C1 (128)         93        110                  11");
    println!("  C3 held cols     15         90                  75");
    println!("  C5 accumulator    5         90                  85");
    println!("  C6 held cols     15   {published:>8}   {:>17}", published as i64 - DEPTH as i64);
    println!("  C7 (512)        138         90     under by 48 -> no solve");
    println!();
    println!("C7 is the only live circuit the instrument does not open.");
}
