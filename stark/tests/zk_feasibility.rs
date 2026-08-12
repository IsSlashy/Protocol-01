//! ZK-feasibility measurement harness — the single blocking question:
//! *can the on-chain STARK prover be made zero-knowledge inside its envelope?*
//!
//! This file is a NEW, self-contained artefact. It touches no prover source:
//! it only calls the public `p01_stark::compact::generate_compact_proof`, reads
//! the bytes that prover actually serialises, and does its own Goldilocks
//! arithmetic (validated against the deployed generator constants). Nothing here
//! depends on `winterfell` traits, so it needs no new dependency.
//!
//! It delivers, as executable and self-checking facts:
//!
//!   1. `free_row_budget_from_the_wire` — counts the trace-polynomial openings
//!      the prover PUBLISHES per column, straight from the serialised proof, and
//!      derives the zero-knowledge free-coefficient requirement R. (Deliverable 1.)
//!
//!   2. `positive_control_secret_recovered_from_published_bytes` — THE artefact.
//!      Recovers circuit-0's PRIVATE pre-image `subscriber_secret` (never a public
//!      input; only its Poseidon image is) from the published openings by Lagrange
//!      interpolation, and cross-checks the machinery by also recovering the public
//!      commitment. Succeeds on today's unblinded prover; a future ZK prover must
//!      make this FAIL, and until this test exists a "recovery failed" result
//!      proves nothing. (Deliverable 6.)
//!
//!   3. `blinding_defeats_recovery` — prototypes additive trace blinding
//!      (P'(x) = P(x) + Z_H(x)·R(x)) over the real field/domain and shows the same
//!      recovery that succeeds unblinded now returns a wrong, seed-dependent value:
//!      the openings stop determining the witness once R ≥ (#openings) blinding
//!      coefficients are added. (Deliverable 4, the ZK-hiding half.)
//!
//!   4. `proof_size_vs_trace_length` — measures the real wire size at trace
//!      lengths 32 / 128 / 512, the cost appended-row blinding forces by pushing
//!      the trace to the next power of two. (Deliverable 4, the size half.)
//!
//! Run: `cargo test -p p01-stark --release --test zk_feasibility -- --nocapture`

use p01_stark::compact::generate_compact_proof;

// ---------------------------------------------------------------------------
// Goldilocks field, p = 2^64 - 2^32 + 1. Minimal, u128-backed, self-validated.
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
/// Fermat inverse: a^(p-2). p-2 = 0xFFFFFFFEFFFFFFFF.
fn finv(a: u64) -> u64 {
    fpow(a, 0xFFFF_FFFE_FFFF_FFFF)
}

// Deployed generator constants (verify.rs:64-78, plus the computed 1024th root).
const GEN_32: u64 = 0x0000_3FFF_FFFF_C000; // trace generator, circuit 0 (32 rows)
const GEN_512: u64 = 0x1905_D02A_5C41_1F4E; // LDE generator, circuit 0 (512)
const GEN_1024: u64 = 0x9D8F_2AD7_8BFE_D972; // computed: 7^((p-1)/1024)

/// Guard the arithmetic and the constants in one shot. If any relation below
/// fails, every number this file prints is suspect, so it must fail loudly.
fn self_check_field() {
    assert_eq!(fpow(GEN_512, 512), 1, "GEN_512 is not a 512th root of unity");
    assert_ne!(fpow(GEN_512, 256), 1, "GEN_512 order divides 256 — not primitive");
    assert_eq!(fpow(GEN_32, 32), 1, "GEN_32 is not a 32nd root");
    // The LDE-to-trace relation the prover relies on: g_trace = g_lde^blowup.
    assert_eq!(fpow(GEN_512, 16), GEN_32, "GEN_512^16 != GEN_32 (blowup relation broken)");
    // The candidate-geometry constant, primitive 1024th root, squares to GEN_512.
    assert_eq!(fpow(GEN_1024, 1024), 1, "GEN_1024 is not a 1024th root");
    assert_ne!(fpow(GEN_1024, 512), 1, "GEN_1024 order divides 512 — not primitive");
    assert_eq!(fmul(GEN_1024, GEN_1024), GEN_512, "GEN_1024^2 != GEN_512");
}

// ---------------------------------------------------------------------------
// Lagrange evaluation of the unique interpolant through (x_i, y_i) at `x0`.
// If the true polynomial has degree < (#distinct nodes), this is exact.
// ---------------------------------------------------------------------------
fn lagrange_eval(nodes: &[(u64, u64)], x0: u64) -> u64 {
    let mut acc: u64 = 0;
    for (i, &(xi, yi)) in nodes.iter().enumerate() {
        let mut num: u64 = 1;
        let mut den: u64 = 1;
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
// Parser for the circuit-0 legacy wire format (serialize_compact_proof,
// compact.rs:1489-1588). Reads only the header OOD values and, per query, the
// position + column-0 opening + next-row opening. Query stride is derived from
// the total length so the FRI section never has to be understood.
// ---------------------------------------------------------------------------

struct Openings {
    num_queries: usize,
    ood_z: u64,
    ood_cur0: u64, // P_0(z)
    ood_next0: u64, // P_0(z * g_trace)
    /// (position, P_0 at position, P_0 at next_pos)
    queries: Vec<(u32, u64, u64)>,
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
    // Header: trace_root(32) quotient_root(32) ood_current[3](24) ood_next[3](24)
    //         ood_z(8) ood_quotient(8)
    let ood_cur0 = rd_u64(bytes, 64); // first of ood_current
    let ood_next0 = rd_u64(bytes, 88); // first of ood_next
    let ood_z = rd_u64(bytes, 112);

    let num_fri_layers = bytes[128] as usize;
    let mut off = 129 + 32 * num_fri_layers;
    let ffps = rd_u16(bytes, off) as usize;
    off += 2 + 8 * ffps; // final poly
    off += 8; // grinding nonce
    let num_queries = rd_u16(bytes, off) as usize;
    off += 2; // now at first query
    let qstart = off;

    // Tail is quotient_values = num_queries * 8. Everything between is queries.
    let tail = num_queries * 8;
    let region = bytes.len() - qstart - tail;
    assert_eq!(
        region % num_queries,
        0,
        "query region {} not divisible by {} queries — wire model is wrong",
        region,
        num_queries
    );
    let per_query = region / num_queries;

    let mut queries = Vec::with_capacity(num_queries);
    for k in 0..num_queries {
        let q = qstart + k * per_query;
        let position = rd_u32(bytes, q);
        // trace_values[3] at q+4, next_trace_values[3] at q+4+24
        let cur0 = rd_u64(bytes, q + 4);
        let next0 = rd_u64(bytes, q + 4 + 24);
        queries.push((position, cur0, next0));
    }

    Openings { num_queries, ood_z, ood_cur0, ood_next0, queries }
}

/// Collect every published (x, P_0(x)) node from a parsed proof, deduplicated,
/// excluding `exclude_x` (the point we will evaluate at).
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
    // OOD current at z, OOD next at z*g_trace.
    push(op.ood_z, op.ood_cur0, &mut nodes);
    push(fmul(op.ood_z, GEN_32), op.ood_next0, &mut nodes);
    for &(pos, cur0, next0) in &op.queries {
        let x = fpow(GEN_512, pos as u64);
        let next_pos = (pos as u64 + 16) % 512;
        let xn = fpow(GEN_512, next_pos);
        push(x, cur0, &mut nodes);
        push(xn, next0, &mut nodes);
    }
    nodes
}

// ===========================================================================
// Deliverable 1 — the free-row budget, measured from the wire.
// ===========================================================================
#[test]
fn free_row_budget_from_the_wire() {
    self_check_field();
    let proof = generate_compact_proof(0xC0FFEE);
    let op = parse_c0(&proof.proof_bytes);

    // Openings of ONE trace-column polynomial that the proof publishes:
    //   OOD current  P(z)            : 1
    //   OOD next     P(z*g)          : 1
    //   per query    P(pos), P(pos+b): 2
    let per_col = 2 * op.num_queries + 2;

    println!("\n=== FREE-ROW BUDGET (measured from the serialised proof) ===");
    println!("circuit 0 num_queries (from wire)      : {}", op.num_queries);
    println!("published openings per trace column    : 2*{} + 2 = {}", op.num_queries, per_col);
    println!("  OOD current  P(z)                     : 1");
    println!("  OOD next     P(z*g_trace)             : 1");
    println!("  query current  P(g^pos)      x{:>2}      : {}", op.num_queries, op.num_queries);
    println!("  query next     P(g^(pos+b))  x{:>2}      : {}", op.num_queries, op.num_queries);
    println!();
    println!("A trace column is hidden iff its polynomial carries at least as");
    println!("many FREE (uniform, unconstrained) coefficients as it has published");
    println!("openings, so R = openings-per-column.");
    println!("  R for a 27-query circuit (0,1,2,4)    : {}", 2 * 27 + 2);
    println!("  R for a 22-query circuit (3,5,6, C7)  : {}", 2 * 22 + 2);
    println!();
    println!("=> C7 target (22 queries): R = 46 free coefficients per column.");
    println!("   (The common '2*queries + 1 = 45' undercounts by one: this wire");
    println!("    publishes BOTH an OOD-current and an OOD-next opening per column.)");

    // Pin the exact counts so a wire-format change is caught.
    assert_eq!(op.num_queries, 27, "circuit 0 is documented at 27 queries");
    assert_eq!(per_col, 56);
    assert_eq!(2 * 22 + 2, 46, "C7 (22-query) free-row requirement");
}

// ===========================================================================
// Deliverable 6 — the positive control. Recover the PRIVATE pre-image.
// ===========================================================================
#[test]
fn positive_control_secret_recovered_from_published_bytes() {
    self_check_field();

    // subscriber_secret is a PRIVATE witness. The only public input is its
    // Poseidon image (the commitment). Circuit-0 trace row 0 = [secret, 0, 0]
    // (subscriber_ownership.rs:10-11), so trace[0][0] == secret exactly, and it
    // sits at trace-domain point x = g_trace^0 = 1.
    let secret: u64 = 0x1234_5678_9ABC_DEF0 % (P as u64);
    let proof = generate_compact_proof(secret);
    let op = parse_c0(&proof.proof_bytes);

    // --- recover the PRIVATE pre-image at x = 1 (row 0, column 0) ---
    let nodes = column0_nodes(&op, 1);
    assert!(
        nodes.len() >= 32,
        "need >= 32 distinct published nodes to pin a degree-<32 column; got {}",
        nodes.len()
    );
    let recovered_secret = lagrange_eval(&nodes, 1);

    // --- cross-check the machinery: recover the PUBLIC commitment at row 30 ---
    // trace[0][30] == commitment, at x = g_trace^30.
    let x_row30 = fpow(GEN_32, 30);
    let nodes_c = column0_nodes(&op, x_row30);
    let recovered_commitment = lagrange_eval(&nodes_c, x_row30);

    println!("\n=== POSITIVE CONTROL (recovery from published proof bytes only) ===");
    println!("distinct published nodes for column 0  : {}", nodes.len());
    println!("secret (private witness, chosen)       : {}", secret);
    println!("secret recovered by Lagrange @ x=1     : {}", recovered_secret);
    println!("commitment (public, from proof)        : {}", proof.commitment);
    println!("commitment recovered @ x=g^30          : {}", recovered_commitment);
    println!();
    println!("Both recovered from the SAME 56 published openings of a single");
    println!("column, with no key and no secret. The unblinded prover leaks the");
    println!("full trace polynomial, hence the pre-image, not just the commitment.");

    assert_eq!(
        recovered_secret, secret,
        "FAILED to recover the private pre-image — the positive control is broken"
    );
    assert_eq!(
        recovered_commitment, proof.commitment,
        "commitment cross-check failed — the Lagrange machinery is wrong"
    );

    println!("\nWHEN THIS TEST STARTS FAILING, ZK IS WORKING: a prover that adds");
    println!(">= 46 free/blinding coefficients per column leaves these openings");
    println!("under-determined and this recovery must return the wrong value.");
}

// ===========================================================================
// Deliverable 4 (hiding half) — additive blinding defeats the same recovery.
// ===========================================================================
use rand::rngs::StdRng;
use rand::{RngCore, SeedableRng};

/// Evaluate a coefficient polynomial (ascending) at x.
fn poly_eval(coeffs: &[u64], x: u64) -> u64 {
    let mut acc = 0u64;
    for &c in coeffs.iter().rev() {
        acc = fadd(fmul(acc, x), c);
    }
    acc
}

#[test]
fn blinding_defeats_recovery() {
    self_check_field();

    // The real circuit-0 column is a degree-<32 polynomial over this exact
    // domain. We model one with a random degree-31 polynomial whose value at the
    // row-0 point x=1 is a chosen "secret", then reproduce the wire's 56 openings
    // (query + OOD points, all OFF the trace domain) and run the SAME Lagrange
    // recovery the positive control uses.
    let n: usize = 32;
    let openings = 2 * 27 + 2; // 56, matching circuit 0

    // 56 opening abscissae: 54 LDE query-style points + 2 OOD-style points,
    // none equal to the row-0 point x=1.
    let mut xs: Vec<u64> = Vec::new();
    let mut p = 3u64; // start off-domain-ish; we only need distinct, != 1
    while xs.len() < openings {
        let x = fpow(GEN_512, p) ; // spread across the LDE domain
        if x != 1 && !xs.contains(&x) {
            xs.push(x);
        }
        p += 1;
    }

    let recover_at_1 = |col: &[u64]| -> u64 {
        // sample the (possibly blinded) polynomial at the 56 opening points…
        let nodes: Vec<(u64, u64)> = xs.iter().map(|&x| (x, poly_eval(col, x))).collect();
        // …and run the naive attacker's Lagrange interpolation, eval at x=1.
        lagrange_eval(&nodes, 1)
    };

    // Build a random degree-31 base column with a known value at x=1.
    let mk_base = |seed: u64| -> (Vec<u64>, u64) {
        let mut rng = StdRng::seed_from_u64(seed);
        let mut c = vec![0u64; n];
        for v in c.iter_mut() {
            *v = rng.next_u64() % (P as u64);
        }
        let secret = poly_eval(&c, 1);
        (c, secret)
    };

    // Additive blinding: c'(x) = c(x) + Z_H(x)*r(x), Z_H(x) = x^n - 1 (vanishes
    // on the n-point trace domain, so c'(1) == c(1) == secret). r has `r_deg+1`
    // uniform coefficients — the free coefficients. Z_H is [-1, 0,…,0, 1].
    let blind = |c: &[u64], r_deg: usize, seed: u64| -> Vec<u64> {
        let mut rng = StdRng::seed_from_u64(seed);
        let mut r = vec![0u64; r_deg + 1];
        for v in r.iter_mut() {
            *v = rng.next_u64() % (P as u64);
        }
        // z_h * r
        let mut zr = vec![0u64; n + r.len()];
        for (i, &ri) in r.iter().enumerate() {
            zr[i] = fsub(zr[i], ri); // * (-1) constant term of Z_H
            zr[i + n] = fadd(zr[i + n], ri); // * x^n term of Z_H
        }
        let mut out = vec![0u64; zr.len().max(c.len())];
        for (i, &ci) in c.iter().enumerate() {
            out[i] = fadd(out[i], ci);
        }
        for (i, &zi) in zr.iter().enumerate() {
            out[i] = fadd(out[i], zi);
        }
        out
    };

    println!("\n=== BLINDING PROTOTYPE (additive Z_H·r masking, real field/domain) ===");

    // 1. Unblinded: recovery is exact (this is the positive control, in vitro).
    let (base, secret) = mk_base(1);
    let rec_unblinded = recover_at_1(&base);
    println!("unblinded   recovered @ x=1 == secret  : {}", rec_unblinded == secret);
    assert_eq!(rec_unblinded, secret, "unblinded recovery must succeed");

    // 2. Too little blinding (r_deg+1 = 24 < 56 openings): still recoverable,
    //    because the openings still over-determine the (now degree-<56) column.
    let weak = blind(&base, 23, 7);
    let rec_weak = recover_at_1(&weak);
    println!("blind r=24  recovered @ x=1 == secret  : {}  (insufficient: 24 < 56)", rec_weak == secret);
    assert_eq!(rec_weak, secret, "24 blinding coeffs < 56 openings: still leaks, as expected");

    // 3. Enough blinding (>= 56 free coefficients): the openings no longer pin
    //    the secret. Same recovery now returns a WRONG, seed-dependent value.
    let strong_a = blind(&base, openings - 1, 11); // 56 free coeffs
    let strong_b = blind(&base, openings - 1, 99); // same secret, different mask
    let rec_a = recover_at_1(&strong_a);
    let rec_b = recover_at_1(&strong_b);
    println!("blind r=56  recovered (mask A)         : {}", rec_a);
    println!("blind r=56  recovered (mask B)         : {}", rec_b);
    println!("blind r=56  secret                     : {}", secret);
    println!("  recovered==secret (A)                : {}", rec_a == secret);
    println!("  recovered depends on mask (A!=B)     : {}", rec_a != rec_b);
    println!();
    println!("With R = openings = 56 free coefficients the published openings are");
    println!("a one-time pad of the witness: recovery yields the wrong value and it");
    println!("moves with the mask while the secret is fixed. That is the ZK property.");

    assert_ne!(rec_a, secret, "R>=openings blinding must break recovery");
    assert_ne!(rec_a, rec_b, "recovered value must depend on the random mask, not the secret");
}

// ===========================================================================
// Deliverable 4 (size half) — measured wire cost of growing the trace.
// ===========================================================================
#[test]
fn proof_size_vs_trace_length() {
    use p01_stark::{
        generate_pool_commitment_proof, generate_merkle_path_compact_proof,
    };

    let c0 = generate_compact_proof(42).proof_bytes.len();
    let c1 = generate_pool_commitment_proof(42, 17, 7, 11).proof_bytes.len();
    let path_elements: Vec<u64> = (0..15u64).map(|i| 1000 + i).collect();
    let path_indices: Vec<u8> = (0..15u8).map(|i| i % 2).collect();
    let c3 = generate_merkle_path_compact_proof(777, &path_elements, &path_indices)
        .proof_bytes
        .len();

    println!("\n=== PROOF SIZE vs TRACE LENGTH (measured, real prover) ===");
    println!("circuit 0  trace 32,  LDE 512  , 27 q  : {:>7} bytes", c0);
    println!("circuit 1  trace 128, LDE 2048 , 27 q  : {:>7} bytes", c1);
    println!("circuit 3  trace 512, LDE 8192 , 22 q  : {:>7} bytes", c3);
    println!();
    println!("Appended-row blinding forces trace_length -> next_pow2(active + R).");
    println!("Blinding circuit 0 (32 rows, R=46) pushes it to 128 rows: the wire");
    println!("profile jumps from the circuit-0 row to the circuit-1 row above,");
    println!(
        "i.e. +{} bytes ({:.1}%) before any CU is counted.",
        c1 - c0,
        100.0 * (c1 as f64 - c0 as f64) / c0 as f64
    );
    println!();
    println!("Additive Z_H·r masking (no extra rows) keeps trace_length, LDE, and");
    println!("num_queries fixed, so it costs ~0 wire bytes — the trace-growth cost");
    println!("above is only paid by the appended-row technique.");

    assert!(c1 > c0 && c3 > c1, "proof size must grow with trace length");
}
