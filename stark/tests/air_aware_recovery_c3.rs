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

const TRACE_LEN: usize = 512;
const TRACE_WIDTH: usize = 6;
const LDE_SIZE: u64 = 8192;
const BLOWUP: u64 = 16;
const NUM_QUERIES: usize = 22;
const QUOTIENT_SEGMENTS: usize = 8;
const HASH_CYCLE_LEN: usize = 32;
const DEPTH: usize = 15;

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

/// `held_tail` = true for col 5, whose padding block carries the final carry
/// (an unknown), false for cols 3 and 4, whose padding is a known zero.
fn segments(held_tail: bool) -> Vec<Vec<usize>> {
    let mut segs: Vec<Vec<usize>> = (0..DEPTH)
        .map(|c| (c * HASH_CYCLE_LEN..(c + 1) * HASH_CYCLE_LEN).collect())
        .collect();
    if held_tail {
        segs.push((DEPTH * HASH_CYCLE_LEN..TRACE_LEN).collect());
    }
    segs
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
const DIRECTIONS: [u8; DEPTH] = [1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 0, 0];

fn path_elements() -> Vec<u64> {
    (0..DEPTH as u64).map(|i| 0xBEEF_0000 + i * 7919).collect()
}

// ===========================================================================
// 1. THE ARTEFACT — the Merkle path and the leaf index, from the bytes.
// ===========================================================================

#[test]
fn c3_held_columns_are_recovered_from_published_bytes() {
    self_check_field();

    let pe = path_elements();
    let pi: Vec<u8> = DIRECTIONS.to_vec();
    let proof = generate_merkle_path_compact_proof(LEAF, &pe, &pi);
    let op = parse_generic(&proof.proof_bytes);
    assert_eq!(op.num_queries, NUM_QUERIES, "C3 ships {NUM_QUERIES} queries");

    // col 4 — the direction bit of each level, i.e. the leaf index in binary.
    let dir_nodes = published_nodes(&op, 4);
    let dirs = solve(system(&dir_nodes, &segments(false)), DEPTH)
        .expect("col 4 must solve: 15 unknowns against ~90 equations");

    // col 3 — the authentication path.
    let sib_nodes = published_nodes(&op, 3);
    let sibs = solve(system(&sib_nodes, &segments(false)), DEPTH)
        .expect("col 3 must solve");

    println!("published equations per column : {}", dir_nodes.len());
    println!("unknowns per held column       : {DEPTH}");
    println!("over-determined by             : {}", dir_nodes.len() as i64 - DEPTH as i64);
    println!();
    println!("direction bits expected : {:?}", DIRECTIONS);
    println!("direction bits recovered: {:?}", dirs);
    println!("sibling[0]  expected  {:#018x}", pe[0]);
    println!("sibling[0]  recovered {:#018x}", sibs[0]);
    println!("sibling[14] expected  {:#018x}", pe[14]);
    println!("sibling[14] recovered {:#018x}", sibs[14]);

    for (level, &want) in DIRECTIONS.iter().enumerate() {
        assert_eq!(
            dirs[level], want as u64,
            "direction bit of level {level} not recovered",
        );
    }
    for (level, &want) in pe.iter().enumerate() {
        assert_eq!(sibs[level], want, "sibling of level {level} not recovered");
    }

    // The leaf index, spelled out. It is the witness the statement never names.
    let index: u64 = DIRECTIONS.iter().enumerate().fold(0u64, |acc, (i, &b)| acc | ((b as u64) << i));
    let recovered_index: u64 = dirs.iter().enumerate().fold(0u64, |acc, (i, &b)| acc | (b << i));
    println!("\nleaf index expected  {index}");
    println!("leaf index recovered {recovered_index}");
    assert_eq!(recovered_index, index, "the leaf index is the direction bits read as binary");
}

// ===========================================================================
// 2. The calibration — the AIR is the cause, again.
// ===========================================================================

#[test]
fn the_held_columns_are_what_make_it_solvable() {
    self_check_field();

    let proof = generate_merkle_path_compact_proof(LEAF, &path_elements(), &DIRECTIONS.to_vec());
    let op = parse_generic(&proof.proof_bytes);
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

    // With it: 15 unknowns, pinned.
    assert!(
        solve(system(&nodes, &segments(false)), DEPTH).is_some(),
        "the held-cycle model must close",
    );

    println!("512 free cells : under-determined");
    println!("{DEPTH} held cycles : solved");
}

// ===========================================================================
// 3. The margin, side by side with the other two measured circuits.
// ===========================================================================

#[test]
fn c3_has_the_widest_margin_measured_so_far() {
    self_check_field();

    let proof = generate_merkle_path_compact_proof(LEAF, &path_elements(), &DIRECTIONS.to_vec());
    let op = parse_generic(&proof.proof_bytes);
    let published = published_nodes(&op, 4).len();

    println!("             unknowns  equations  over-determined by");
    println!("  C0 (32)          32        110                  72");
    println!("  C1 (128)         93        110                  11");
    println!("  C3 held cols     {DEPTH:>2}   {published:>8}   {:>17}", published as i64 - DEPTH as i64);
    println!("  C7 (512)        138         90     under by 48 -> no solve");

    assert!(
        published > DEPTH,
        "C3's held columns must be over-determined, measured {published} vs {DEPTH}",
    );
    // ⚠️ Not "C3 leaks more than C1 does harm". The leaf is a PUBLIC input of
    // C3, so its index and siblings follow from public data anyway. What the
    // margin sizes is the MASK C3 would need, not a new linkage.
    assert!(
        published as i64 - DEPTH as i64 > 60,
        "the margin is what sizes the mask; measured {}",
        published as i64 - DEPTH as i64,
    );
}
