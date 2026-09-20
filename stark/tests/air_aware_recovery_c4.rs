//! AIR-AWARE RECOVERY ON C4: the carry column the 2026-09-03 audit measured.
//!
//! ⛔ THE COUNTERFACTUAL IN THIS FILE IS SUPPOSED TO SOLVE. The defence is
//! measured against it, and a `None` from the solver is only evidence because
//! the same solver, over the same bytes, under the PRE-MASK model, returns the
//! exact `owner_mint`.
//!
//! WHAT C4 LEAKED, AND WHY IT WAS WORSE THAN C1
//! ───────────────────────────────────────────
//! `docs/AUDIT-2026-09-03.md` recorded it on THIS circuit: col 3 is a
//! TWO-SEGMENT STEP -- zero on rows 0..63, `owner_mint` on rows 64..223 (and
//! on the dummy eighth cycle) -- so the whole column was ONE unknown once the
//! AIR's linear structure was written down, and the wire published
//! `4 * 27 + 2 = 110` evaluations of it. One field inversion returned `owner_mint =
//! Poseidon(Poseidon(spending_key, 0), token_mint)`, the owner half of the
//! zkspl commitment. C1 at least needed Gaussian elimination.
//!
//! WHAT THE MASK CHANGES
//! ─────────────────────
//! Since 2026-09-11 the trace is 512 rows, C4 ships 22 queries, and rows
//! 224..511 of col 3 are fresh CSPRNG draws: 1 + 288 unknowns against
//! `4 * 22 + 2 = 90` openings, under-determined by 199. That is what this file measures, with the
//! pre-mask model kept beside it as the positive control -- rebuilt EXACTLY
//! rather than argued: a proof whose masked carry cells are set to
//! `owner_mint` reproduces the old column, and the solve returns the secret.
//!
//! ⚠️ WHAT THIS DOES NOT SAY. A rank result is not a secret result: it says the
//! LINEAR attack fails. The quotient and FRI openings are degree 7 in the
//! unknowns and are covered by the lift and randomizer columns, measured in
//! `stark/src/compact/zk_hiding.rs` (`Circ::C4`) and counted in
//! `stark/tests/full_wire_ledger.rs`.
//!
//! Run: `cargo test -p p01-stark --release --test air_aware_recovery_c4 -- --nocapture`

use p01_stark::compact::generate_confidential_balance_compact_proof;
use p01_stark::air::confidential_balance as c4;

// ---------------------------------------------------------------------------
// Goldilocks, self-contained on purpose.
// ---------------------------------------------------------------------------

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

// C4 geometry, READ OFF THE AIR. Verifier twin: `CONFIG_CONFIDENTIAL_BALANCE`.
const TRACE_LEN: usize = c4::TRACE_LENGTH;
const TRACE_WIDTH: usize = c4::TRACE_WIDTH;
const CW: usize = c4::CONSTRAINED_TRACE_WIDTH;
const FIRST_FREE_ROW: usize = c4::FIRST_FREE_ROW;
const GEN_512: u64 = 0x1905_D02A_5C41_1F4E;
const GEN_8192: u64 = 0x1544_EF23_35D1_7997;
const COSET_SHIFT: u64 = 7; // [B7]
const LDE_SIZE: u64 = 8192;
const BLOWUP: u64 = 16;
const NUM_QUERIES: usize = 22;
const QUOTIENT_SEGMENTS: usize = 8;
const CARRY_COL: usize = 3;

fn self_check_field() {
    assert_eq!(TRACE_LEN, 512, "this harness is written for the 512-row C4");
    assert_eq!(fpow(GEN_512, TRACE_LEN as u64), 1, "GEN_512 is not a 512th root of unity");
    assert_ne!(fpow(GEN_512, TRACE_LEN as u64 / 2), 1, "GEN_512 is not primitive");
    assert_eq!(fpow(GEN_8192, LDE_SIZE), 1, "GEN_8192 is not an 8192nd root");
    assert_ne!(fpow(GEN_8192, LDE_SIZE / 2), 1, "GEN_8192 is not primitive");
    assert_eq!(fpow(GEN_8192, BLOWUP), GEN_512, "g_lde^blowup must be g_trace");
    assert_ne!(fpow(COSET_SHIFT, LDE_SIZE), 1, "the coset is not disjoint from the subgroup");
}

/// `L_i(x) = g^i * (x^n - 1) / (n * (x - g^i))`.
fn lagrange_basis_at(i: usize, x: u64, n: usize, g: u64) -> u64 {
    let gi = fpow(g, i as u64);
    let num = fmul(gi, fsub(fpow(x, n as u64), 1));
    let den = fmul(n as u64, fsub(x, gi));
    fmul(num, finv(den))
}

// ---------------------------------------------------------------------------
// The generic wire, parsed for the trace channel only.
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
    off += 8; // grinding nonce
    let num_queries = rd_u16(bytes, off) as usize;
    off += 2;
    let qstart = off;

    let tail = num_queries * QUOTIENT_SEGMENTS * 8;
    let region = bytes.len() - qstart - tail;
    assert_eq!(region % num_queries, 0, "query region {region} not divisible by {num_queries}");
    let per_query = region / num_queries;
    assert!(per_query >= 4 + 4 * tw * 8, "per-query block {per_query} B cannot carry four rows of {tw} columns");

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
// Linear algebra over Goldilocks. Rows are `[a_0 .. a_{n-1} | rhs]`.
// ---------------------------------------------------------------------------

/// Gaussian elimination. `Some(x)` when every unknown is pinned, `None` when
/// the rank is short -- which is the honest answer, not a failure.
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

/// The published openings, as linear equations in the 512 cells of one column.
fn opening_equations(nodes: &[(u64, u64)]) -> Vec<Vec<u64>> {
    nodes
        .iter()
        .map(|&(x, y)| {
            let mut row: Vec<u64> =
                (0..TRACE_LEN).map(|i| lagrange_basis_at(i, x, TRACE_LEN, GEN_512)).collect();
            row.push(y);
            row
        })
        .collect()
}

fn eq_cells(eqs: &mut Vec<Vec<u64>>, a: usize, b: usize) {
    let mut row = vec![0u64; TRACE_LEN + 1];
    row[a] = 1;
    row[b] = fsub(0, 1);
    eqs.push(row);
}
fn eq_zero(eqs: &mut Vec<Vec<u64>>, a: usize) {
    let mut row = vec![0u64; TRACE_LEN + 1];
    row[a] = 1;
    eqs.push(row);
}

/// The AIR's LINEAR structure on the carry column, AS IT STANDS TODAY.
///
/// Rows 0..63 are zero (the carry is captured at row 63), rows 64..223 are all
/// equal (carry continuity, gated by `active` up to row 222 -> 223). Rows
/// 224..511 are fresh randomness and contribute NO equality.
fn carry_structure_masked() -> Vec<Vec<u64>> {
    let mut eqs = Vec::new();
    for r in 0..(2 * c4::HASH_CYCLE_LEN) {
        eq_zero(&mut eqs, r);
    }
    for r in (2 * c4::HASH_CYCLE_LEN + 1)..FIRST_FREE_ROW {
        eq_cells(&mut eqs, r, 2 * c4::HASH_CYCLE_LEN);
    }
    eqs
}

/// The PRE-MASK model: the column was `owner_mint` on every row past 63, and
/// the trace ended at row 255 with a dummy cycle. Written over today's 512 rows it says every cell
/// from 64 on equals cell 64 -- one unknown for the whole column.
fn carry_structure_pre_mask() -> Vec<Vec<u64>> {
    let mut eqs = carry_structure_masked();
    for r in FIRST_FREE_ROW..TRACE_LEN {
        eq_cells(&mut eqs, r, 2 * c4::HASH_CYCLE_LEN);
    }
    eqs
}

/// A deterministic mask. Adequate for a RANK measurement and inadequate for a
/// secrecy claim, which is why the shipping path draws from getrandom.
fn test_mask_raw(seed: u64) -> Vec<u64> {
    let mut z = seed | 1;
    (0..c4::MASK_LEN)
        .map(|_| {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            z % (P as u64)
        })
        .collect()
}

/// [A8] The same bytes, carried by the type the prover now demands.
fn test_mask(seed: u64) -> p01_stark::BlindingMask {
    p01_stark::BlindingMask::from_raw_u64_for_tests(&test_mask_raw(seed))
}

const SPENDING_KEY: u64 = 0x1DEA_D0D0_CAFE_5678;
const OLD_BALANCE: u64 = 1_000_000;
const OLD_SALT: u64 = 0x0BAD_C0FF_EE00_1234;
const NEW_BALANCE: u64 = 999_800;
const NEW_SALT: u64 = 0x0BAD_C0FF_EE00_5678;
const AMOUNT: u64 = 200;
const AMOUNT_SALT: u64 = 0x1234;
const TOKEN_MINT: u64 = 999;

fn prove(mask: &p01_stark::BlindingMask) -> p01_stark::compact::GenericCompactProofData {
    generate_confidential_balance_compact_proof(
        SPENDING_KEY, OLD_BALANCE, OLD_SALT, NEW_BALANCE, NEW_SALT, AMOUNT, AMOUNT_SALT, TOKEN_MINT, mask,
    )
}

fn owner_mint() -> u64 {
    use p01_stark::poseidon::hash2;
    use p01_stark::{BaseElement, StarkField};
    let owner = hash2(BaseElement::new(SPENDING_KEY), BaseElement::new(0));
    hash2(owner, BaseElement::new(TOKEN_MINT)).as_int()
}

// ===========================================================================
// 1. THE POSITIVE CONTROL: the pre-mask column, rebuilt exactly, gives up
//    `owner_mint` -- not a rank, the value.
// ===========================================================================

#[test]
fn the_pre_mask_carry_column_hands_over_owner_mint() {
    self_check_field();

    // Rebuild the OLD trace shape inside the new geometry: every masked cell of
    // the carry column set to `owner_mint`. This is what C4 published before
    // 2026-09-11 (with the trace simply ending at row 127).
    let om = owner_mint();
    let mut mask = test_mask_raw(0xC4_5EED_0003);
    for row in FIRST_FREE_ROW..TRACE_LEN {
        mask[(row - FIRST_FREE_ROW) * CW + CARRY_COL] = om;
    }
    let proof = prove(&p01_stark::BlindingMask::from_raw_u64_for_tests(&mask));
    let op = parse_generic(&proof.proof_bytes);
    assert_eq!(op.num_queries, NUM_QUERIES);

    let nodes = published_nodes(&op, CARRY_COL);
    let mut rows = opening_equations(&nodes);
    rows.extend(carry_structure_pre_mask());
    let cells = solve(rows, TRACE_LEN).expect("the pre-mask carry column must be recoverable");

    println!("published openings on col 3 : {}", nodes.len());
    println!("recovered cell 64           : 0x{:016X}", cells[64]);
    println!("owner_mint                  : 0x{om:016X}");
    assert_eq!(cells[64], om, "the pre-mask model must return the real owner_mint, or this instrument is broken");
    assert_eq!(cells[0], 0);
    assert_eq!(cells[511], om);
}

// ===========================================================================
// 2. THE DEFENCE: the same solver, the same bytes, the masked AIR.
// ===========================================================================

#[test]
fn the_mask_closes_the_carry_column() {
    self_check_field();

    let proof = prove(&test_mask(0xC4_5EED_0003));
    let op = parse_generic(&proof.proof_bytes);
    let nodes = published_nodes(&op, CARRY_COL);

    let openings = opening_equations(&nodes);
    let structural = carry_structure_masked().len();
    println!("published equations : {}", openings.len());
    println!("unknowns            : {TRACE_LEN}");
    println!("surviving AIR rows  : {structural}");
    println!("effective unknowns  : {}", TRACE_LEN - structural);
    println!("under-determined by : {}", (TRACE_LEN - structural) as i64 - openings.len() as i64);

    assert!(openings.len() < TRACE_LEN - structural, "the naive count must say SAFE for the measurement below to mean anything");

    let mut with_air = openings.clone();
    with_air.extend(carry_structure_masked());
    assert!(solve(with_air, TRACE_LEN).is_none(), "the masked carry column is STILL recoverable from the published bytes");

    // ⚠️ ANTI-VACUITY. The same solver over the same bytes under the PRE-MASK
    // model must still pin every unknown (a rank statement: the system is
    // over-determined and the solver returns a vector), or the `None` above is
    // indistinguishable from a broken parser.
    let mut pre = openings;
    pre.extend(carry_structure_pre_mask());
    assert!(solve(pre, TRACE_LEN).is_some(), "the PRE-MASK model must still close");
    println!("with the MASKED AIR   : under-determined  <- today");
    println!("with the PRE-MASK AIR : closes           <- the counterfactual");
}

// ===========================================================================
// 3. Every constrained column is under-determined, not only the carry.
// ===========================================================================

#[test]
fn every_constrained_column_is_under_determined() {
    self_check_field();
    let proof = generate_confidential_balance_compact_proof(1, 500, 3, 300, 5, 200, 7, 999, &test_mask(0xC4_5EED_0005));
    let op = parse_generic(&proof.proof_bytes);
    for col in 0..CW {
        let nodes = published_nodes(&op, col);
        let mut rows = opening_equations(&nodes);
        // The only linear structure the AIR still hands an attacker on the
        // Poseidon columns is the padding copy inside each of the seven cycles; on the carry it is the model above; on the
        // lift column there is none at all.
        match col {
            0..=2 => {
                for cyc in 0..c4::NUM_HASH_CYCLES {
                    let last = cyc * c4::HASH_CYCLE_LEN + c4::HASH_CYCLE_LEN - 1;
                    eq_cells(&mut rows, last, last - 1);
                }
            }
            3 => rows.extend(carry_structure_masked()),
            _ => {}
        }
        let published = nodes.len();
        let verdict = solve(rows, TRACE_LEN);
        println!("col {col}: {published} openings, {}", if verdict.is_some() { "SOLVES" } else { "under-determined" });
        assert!(verdict.is_none(), "col {col} of C4 is recoverable from the published bytes");
    }
}
