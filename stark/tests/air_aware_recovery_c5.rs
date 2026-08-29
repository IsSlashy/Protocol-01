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
const GEN_512: u64 = 0x1905_D02A_5C41_1F4E;
const GEN_8192: u64 = 0x1544_EF23_35D1_7997;
const COSET_SHIFT: u64 = 7;

const TRACE_LEN: usize = 512;
const TRACE_WIDTH: usize = 7;
const LDE_SIZE: u64 = 8192;
const BLOWUP: u64 = 16;
const NUM_QUERIES: usize = 22;
const QUOTIENT_SEGMENTS: usize = 8;

fn self_check_field() {
    assert_eq!(fpow(GEN_512, 512), 1, "GEN_512 is not a 512th root");
    assert_eq!(fpow(GEN_8192, BLOWUP), GEN_512, "g_lde^blowup must be g_trace");
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

fn seg(lo: usize, hi: usize) -> Vec<usize> {
    (lo..hi).collect()
}

/// Column 6, the accumulator. All FIVE segments are carried as unknowns even
/// though two are publicly known — the known pair is then used as a self-check
/// that the solve is real rather than folded into the right-hand side.
fn acc_segments() -> Vec<Vec<usize>> {
    vec![seg(0, 65), seg(65, 161), seg(161, 289), seg(289, 385), seg(385, TRACE_LEN)]
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
    )
}

// ===========================================================================
// 1. THE ARTEFACT — four private amounts, in closed form.
// ===========================================================================

#[test]
fn c5_private_note_amounts_are_recovered_from_published_bytes() {
    self_check_field();

    let proof = transfer_proof();
    let op = parse_generic(&proof.proof_bytes);
    assert_eq!(op.num_queries, NUM_QUERIES, "C5 ships {NUM_QUERIES} queries");

    let nodes = published_nodes(&op, 6);
    let segs = acc_segments();
    let acc = solve(system(&nodes, &segs), segs.len())
        .expect("the accumulator column must solve: 5 unknowns against ~90 equations");

    // The two publicly-known segments, used as the control on the solve. If
    // these are wrong the parser or the basis is wrong and the amounts below
    // would be meaningless.
    assert_eq!(acc[0], 0, "segment 0 of the accumulator is a pinned ZERO (transfer.rs:255)");
    assert_eq!(
        acc[4], PUBLIC_AMOUNT,
        "segment 4 is pinned to public_amount (transfer.rs:256)",
    );

    let in1 = fneg(acc[1]);
    let in2 = fsub(acc[1], acc[2]);
    let out1 = fsub(acc[3], acc[2]);
    let out2 = fsub(acc[4], acc[3]);

    println!("published equations : {}", nodes.len());
    println!("unknowns            : {}", segs.len());
    println!("over-determined by  : {}", nodes.len() as i64 - segs.len() as i64);
    println!();
    println!("in_amount_1   expected {IN_1:>10}   recovered {in1:>10}");
    println!("in_amount_2   expected {IN_2:>10}   recovered {in2:>10}");
    println!("out_amount_1  expected {OUT_1:>10}   recovered {out1:>10}");
    println!("out_amount_2  expected {OUT_2:>10}   recovered {out2:>10}");
    println!("\npublic inputs carry only the SUM: public_amount = {PUBLIC_AMOUNT}");

    assert_eq!(in1, IN_1, "in_amount_1 not recovered");
    assert_eq!(in2, IN_2, "in_amount_2 not recovered");
    assert_eq!(out1, OUT_1, "out_amount_1 not recovered");
    assert_eq!(out2, OUT_2, "out_amount_2 not recovered");
}

// ===========================================================================
// 2. The spender's persistent identity — one unknown over 481 rows.
// ===========================================================================

#[test]
fn c5_owner_identity_is_a_single_unknown() {
    self_check_field();

    let proof = transfer_proof();
    let op = parse_generic(&proof.proof_bytes);

    // col 3 is ZERO on rows 0..=30 and `owner` on 31..=511 (transfer.rs:618-620).
    // The zero block is not an unknown, so the whole column is ONE value.
    let nodes = published_nodes(&op, 3);
    let owner = solve(system(&nodes, &[seg(31, TRACE_LEN)]), 1)
        .expect("one unknown against ~90 equations must solve");

    // col 4 is the same shape, offset by one cycle.
    let mint_nodes = published_nodes(&op, 4);
    let owner_mint = solve(system(&mint_nodes, &[seg(63, TRACE_LEN)]), 1)
        .expect("col 4 must solve");

    println!("owner       = Poseidon(spending_key, 0) -> {:#018x}", owner[0]);
    println!("owner_mint  = Poseidon(owner, mint)     -> {:#018x}", owner_mint[0]);
    println!("unknowns per column: 1, against {} equations", nodes.len());

    assert_ne!(owner[0], 0, "a zero owner would mean the model picked the wrong block");
    assert_ne!(owner_mint[0], 0, "likewise for owner_mint");
    assert_ne!(owner[0], owner_mint[0], "the two carries must differ");

    // ⛔ These are not public inputs. `owner` is a function of the spending key
    // alone, so it is the same value in every transfer that key ever makes —
    // which is what turns a recovered `owner` into a linkability primitive.
    println!("\n⛔ neither is a public input; `owner` is constant across every");
    println!("   transfer made by the same spending key.");
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
