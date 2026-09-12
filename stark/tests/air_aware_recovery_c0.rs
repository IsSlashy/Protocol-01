//! AIR-AWARE RECOVERY ON C0: the note secret, before and after the mask.
//!
//! ⛔ THE CONTROL IN THIS FILE IS SUPPOSED TO SOLVE. The LEGACY circuit 0
//! (32 rows, no mask) publishes `4 * 27 + 2 = 110` evaluations of a degree-31
//! column, so plain Lagrange interpolation returns the subscriber secret --
//! the same measurement `witness_recovery_positive_control.rs` has carried
//! since 2026-08-29, re-run here beside its cure so the two never drift apart.
//!
//! The MASKED circuit 0 (`generate_subscriber_ownership_proof`, 2026-09-11)
//! publishes `4 * 22 + 2 = 90` evaluations of a degree-511 column whose rows
//! 32..511 are fresh CSPRNG draws. Only ONE linear equality survives in the
//! AIR (row 31 is the padding copy of row 30), so the attacker's system has
//! 511 effective unknowns against 90 equations and the solver says so.
//!
//! What this file does NOT say: a rank result is not a secret result. The
//! quotient, DEEP and FRI channels are covered by the lift and randomizer
//! columns, measured in `stark/src/compact/zk_hiding.rs` (`Circ::C0`) and
//! counted in `stark/tests/full_wire_ledger.rs`.
//!
//! Run: `cargo test -p p01-stark --release --test air_aware_recovery_c0 -- --nocapture`

use p01_stark::air::subscriber_ownership as c0;
use p01_stark::compact::{generate_compact_proof, generate_subscriber_ownership_proof};

const P: u128 = 0xFFFF_FFFF_0000_0001;

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

const COSET_SHIFT: u64 = 7; // [B7]
const GEN_32: u64 = 0x0000_3FFF_FFFF_C000;
const GEN_512: u64 = 0x1905_D02A_5C41_1F4E;
const GEN_8192: u64 = 0x1544_EF23_35D1_7997;

/// One wire shape, two geometries. Header: roots(64) ood_cur(tw*8) ood_next(tw*8)
/// ood_z(8) ood_quotient(8k) num_fri_layers(1) roots(32n) ffps(2) final(8*ffps)
/// nonce(8) num_queries(2); per query: pos(4) | four rows of tw.
struct Geo {
    tw: usize,
    k: usize,
    n: usize,
    lde: u64,
    trace_g: u64,
    lde_g: u64,
}

const LEGACY: Geo = Geo { tw: 3, k: 7, n: 32, lde: 512, trace_g: GEN_32, lde_g: GEN_512 };
const MASKED: Geo = Geo {
    tw: c0::MASKED_TRACE_WIDTH,
    k: 8,
    n: c0::MASKED_TRACE_LENGTH,
    lde: 8192,
    trace_g: GEN_512,
    lde_g: GEN_8192,
};

fn self_check(g: &Geo) {
    assert_eq!(fpow(g.trace_g, g.n as u64), 1, "trace generator order");
    assert_ne!(fpow(g.trace_g, g.n as u64 / 2), 1, "trace generator primitive");
    assert_eq!(fpow(g.lde_g, g.lde), 1, "lde generator order");
    assert_eq!(fpow(g.lde_g, 16), g.trace_g, "g_lde^blowup must be g_trace");
    assert_ne!(fpow(COSET_SHIFT, g.lde), 1, "coset disjoint from the subgroup");
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

/// Every published `(x, P_col(x))` for one column, deduplicated.
fn published_nodes(bytes: &[u8], g: &Geo, col: usize) -> Vec<(u64, u64)> {
    let tw = g.tw;
    let ood_cur: Vec<u64> = (0..tw).map(|c| rd_u64(bytes, 64 + c * 8)).collect();
    let ood_next: Vec<u64> = (0..tw).map(|c| rd_u64(bytes, 64 + tw * 8 + c * 8)).collect();
    let z_off = 64 + 2 * tw * 8;
    let ood_z = rd_u64(bytes, z_off);
    let hdr = z_off + 8 + g.k * 8;
    let layers = bytes[hdr] as usize;
    let mut off = hdr + 1 + 32 * layers;
    let ffps = rd_u16(bytes, off) as usize;
    off += 2 + 8 * ffps + 8;
    let nq = rd_u16(bytes, off) as usize;
    off += 2;
    let tail = nq * g.k * 8;
    let per_query = (bytes.len() - off - tail) / nq;

    let mut nodes: Vec<(u64, u64)> = Vec::new();
    let mut push = |x: u64, y: u64, nodes: &mut Vec<(u64, u64)>| {
        if !nodes.iter().any(|&(nx, _)| nx == x) {
            nodes.push((x, y));
        }
    };
    let at = |pos: u64| fmul(COSET_SHIFT, fpow(g.lde_g, pos));
    let half = g.lde / 2;
    push(ood_z, ood_cur[col], &mut nodes);
    push(fmul(ood_z, g.trace_g), ood_next[col], &mut nodes);
    for q in 0..nq {
        let base = off + q * per_query;
        let pos = rd_u32(bytes, base) as u64;
        let s = tw * 8;
        let row = |r: usize| rd_u64(bytes, base + 4 + r * s + col * 8);
        let next_pos = (pos + 16) % g.lde;
        push(at(pos), row(0), &mut nodes);
        push(at(pos ^ half), row(1), &mut nodes);
        push(at(next_pos), row(2), &mut nodes);
        push(at(next_pos ^ half), row(3), &mut nodes);
    }
    nodes
}

fn lagrange_basis_at(i: usize, x: u64, n: usize, g: u64) -> u64 {
    let gi = fpow(g, i as u64);
    let num = fmul(gi, fsub(fpow(x, n as u64), 1));
    let den = fmul(n as u64, fsub(x, gi));
    fmul(num, finv(den))
}

fn solve(mut rows: Vec<Vec<u64>>, n: usize) -> Option<Vec<u64>> {
    let mut pivot_row = 0usize;
    let mut where_pivot = vec![usize::MAX; n];
    for col in 0..n {
        let Some(sel) = (pivot_row..rows.len()).find(|&r| rows[r][col] != 0) else { continue };
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

fn system(nodes: &[(u64, u64)], g: &Geo) -> Vec<Vec<u64>> {
    let mut rows: Vec<Vec<u64>> = nodes
        .iter()
        .map(|&(x, y)| {
            let mut row: Vec<u64> = (0..g.n).map(|i| lagrange_basis_at(i, x, g.n, g.trace_g)).collect();
            row.push(y);
            row
        })
        .collect();
    // The one linear structure both shapes share: row 31 copies row 30.
    let mut eq = vec![0u64; g.n + 1];
    eq[31] = 1;
    eq[30] = fsub(0, 1);
    rows.push(eq);
    rows
}

fn test_mask(seed: u64) -> Vec<u64> {
    let mut z = seed | 1;
    (0..c0::MASK_LEN)
        .map(|_| {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            z % (P as u64)
        })
        .collect()
}

const SECRET: u64 = 0x1DEA_D0D0_CAFE_5678;

// ===========================================================================
// 1. THE POSITIVE CONTROL: the legacy C0 gives up the secret, exactly.
// ===========================================================================

#[test]
fn the_legacy_c0_hands_over_the_secret() {
    self_check(&LEGACY);
    let proof = generate_compact_proof(SECRET);
    let nodes = published_nodes(&proof.proof_bytes, &LEGACY, 0);
    println!("legacy C0: {} published openings on col 0, {} unknowns", nodes.len(), LEGACY.n);
    assert!(nodes.len() >= LEGACY.n, "the legacy wire must publish at least n distinct points");
    let cells = solve(system(&nodes, &LEGACY), LEGACY.n).expect("the legacy column must interpolate");
    println!("recovered cell 0 : 0x{:016X}", cells[0]);
    println!("secret           : 0x{SECRET:016X}");
    assert_eq!(cells[0], SECRET, "the legacy C0 must return the exact secret, or this instrument is broken");
}

// ===========================================================================
// 2. THE DEFENCE: the masked C0, same solver, same abscissa construction.
// ===========================================================================

#[test]
fn the_mask_closes_every_constrained_column_of_c0() {
    self_check(&MASKED);
    let proof = generate_subscriber_ownership_proof(SECRET, &test_mask(0xC0_5EED_0003));
    assert_eq!(proof.public_inputs, vec![p01_stark::compact::generate_compact_proof(SECRET).commitment],
        "masked and legacy C0 must agree on the commitment for one secret");
    for col in 0..c0::MASKED_CONSTRAINED_TRACE_WIDTH {
        let nodes = published_nodes(&proof.proof_bytes, &MASKED, col);
        let rows = system(&nodes, &MASKED);
        println!(
            "masked C0 col {col}: {} openings + 1 AIR equality against {} unknowns -> {}",
            nodes.len(),
            MASKED.n,
            if solve(rows.clone(), MASKED.n).is_some() { "SOLVES" } else { "under-determined" },
        );
        assert!(nodes.len() + 1 < MASKED.n, "the count must say SAFE for the solve below to mean anything");
        assert!(solve(rows, MASKED.n).is_none(), "col {col} of the masked C0 is recoverable from the published bytes");
    }
}

// ===========================================================================
// 3. The witness rows are identical, so the ONLY difference is the mask.
// ===========================================================================

#[test]
fn the_difference_is_the_mask_not_the_arithmetic() {
    let legacy = c0::build_trace(p01_stark::BaseElement::new(SECRET));
    let mask: Vec<p01_stark::BaseElement> = test_mask(0xC0_5EED_0003).iter().map(|&v| p01_stark::BaseElement::new(v)).collect();
    let (masked, _) = c0::build_masked_trace(p01_stark::BaseElement::new(SECRET), &mask);
    for col in 0..3 {
        for row in 0..32 {
            assert_eq!(legacy[col][row], masked[col][row]);
        }
    }
    println!("rows 0..31 of columns 0..2 are identical across the two shapes; the masked shape adds {} blinding rows, a lift column and a randomizer column", c0::MASK_ROWS);
}
