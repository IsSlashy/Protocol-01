//! Finding F69 (audit v1, round 4): the next-row openings are on the wire.
//!
//! `docs/zk-simulation-argument.md` (until 2026-09-23) conditioned its
//! simulator on "next-row evaluations `T_c(g·x)` at the opened rows", values it
//! said nobody publishes, and its simulator `S` deliberately ignored the
//! per-row quotient identity
//!
//! ```text
//!   Q(x) = C(x) · (x − g^(n−1)) / (x^n − 1)  +  Σ_j a_bnd^j (T_col_j(x) − v_j) / (x − g^(r_j))
//! ```
//!
//! because, it argued, a distinguisher could not evaluate it. Every C7 proof
//! carries, per query, the next-row pair `T(g·x)`, `T(−g·x)` and its
//! authentication path, and the on-chain verifier Merkle-checks that pair
//! against the trace root (`programs/p01_stark_verifier/src/verify.rs`, the
//! next-row pair check). So the identity IS evaluable from public data, and a
//! transcript that does not satisfy it is told apart from an honest one.
//!
//! This file measures the corrected statement on real proofs, from the proof
//! bytes and the public inputs only (plus the AIR and its public constants):
//!
//! 1. the parse below consumes the C7 wire exactly (a miscount panics);
//! 2. every next-row pair authenticates against the published trace root;
//! 3. the per-row quotient identity holds on EVERY opened row, both halves of
//!    each pair, computed from wire values alone;
//! 4. moving one next-row value by one breaks it on every row: the identity is
//!    a real check, not an identity that anything satisfies.
//!
//! What it does NOT show, and nothing here claims: a witness leak. The
//! identity is a consistency relation that every honest proof satisfies; it
//! distinguishes the simulator of §2 as written, and says nothing about
//! whether a corrected simulator (one that also samples next-row openings and
//! satisfies the identity) exists. The recovery harnesses
//! (`air_aware_recovery_c7.rs`) are unchanged by this file.
//!
//! Ported from the audit's probe (`audit-v1-opus/r4-verifier/next_row_probe`),
//! which measured 176 of 176 rows on four proofs, and 0 of 176 once bumped.

use p01_stark::air::spend::{
    build_spend_periodic_columns, evaluate_spend_transition, CANONICAL_DEPTH, MASK_LEN, SPEND_BOUNDARY_SPEC,
    SPEND_NUM_CONSTRAINTS, SPEND_NUM_PERIODIC, TRACE_LENGTH, TRACE_WIDTH,
};
use p01_stark::compact::generate_spend_compact_proof;
use p01_stark::BlindingMask;
use sha2::{Digest, Sha256};
use winterfell::math::{fields::f64::BaseElement as F, FieldElement};

const P: u64 = 0xFFFF_FFFF_0000_0001;
/// C7 wire geometry (`compact_proof.rs`, the spend `CircuitConfig`).
const LDE: usize = 8192;
const HALF: usize = LDE / 2;
const BLOWUP: usize = 16;
const MERKLE_DEPTH: usize = 13;
const SEGMENTS: usize = 8;
const QUERIES: usize = 22;

fn generator(size: usize) -> F {
    let k = size.trailing_zeros();
    let mut g = F::new(7).exp((P - 1) >> 32);
    for _ in 0..(32 - k) {
        g = g * g;
    }
    g
}

struct Cursor<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> &'a [u8] {
        let s = &self.b[self.at..self.at + n];
        self.at += n;
        s
    }
    fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }
    fn u16(&mut self) -> u16 {
        let s = self.take(2);
        u16::from_le_bytes([s[0], s[1]])
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take(4).try_into().unwrap())
    }
}

fn felts(b: &[u8]) -> Vec<F> {
    b.chunks_exact(8).map(|c| F::new(u64::from_le_bytes(c.try_into().unwrap()))).collect()
}

fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// The verifier's RLC / boundary challenges for C7, from the trace root and
/// the public inputs only.
fn challenge(trace_root: &[u8], pub_bytes: &[u8], tag: &[u8; 8]) -> F {
    let h = sha(&[trace_root, pub_bytes, tag]);
    let mut a = u64::from_le_bytes(h[0..8].try_into().unwrap()) % P;
    if a == 0 {
        a = 1;
    }
    F::new(a)
}

/// Barycentric evaluation at `x` of the degree < n interpolant of `vals` over <g>.
fn interpolate_at(vals: &[F], g: F, x: F) -> F {
    let n = vals.len();
    let xn = x.exp(n as u64);
    let mut acc = F::ZERO;
    let mut gi = F::ONE;
    for v in vals {
        acc += *v * gi / (x - gi);
        gi *= g;
    }
    acc * (xn - F::ONE) / F::new(n as u64)
}

fn merkle_ok(root: &[u8], lo: &[u8], hi: &[u8], idx: usize, path: &[u8]) -> bool {
    let mut cur = sha(&[&[0u8], lo, hi]);
    let mut i = idx;
    for sib in path.chunks_exact(32) {
        cur = if i & 1 == 0 { sha(&[&[1u8], &cur, sib]) } else { sha(&[&[1u8], sib, &cur]) };
        i >>= 1;
    }
    cur.as_slice() == root
}

struct Query<'a> {
    pos: usize,
    cur: &'a [u8],
    cur_mirror: &'a [u8],
    next: &'a [u8],
    next_mirror: &'a [u8],
    next_path: &'a [u8],
    quotient_mirror: &'a [u8],
}

#[derive(Default, Debug)]
struct Tally {
    rows: usize,
    next_pairs_authenticated: usize,
    identity_holds: usize,
    identity_holds_bumped: usize,
}

fn measure(proofs: usize) -> Tally {
    let tw = TRACE_WIDTH;
    let n = TRACE_LENGTH;
    assert_eq!((tw, n), (12, 512), "C7 geometry changed; re-read compact_proof.rs and update the wire parse");
    let omega = generator(LDE);
    let g = generator(n);
    let shift = F::new(7);
    let periodic: Vec<Vec<F>> =
        build_spend_periodic_columns().iter().map(|c| (0..n).map(|i| c[i % c.len()]).collect()).collect();
    assert_eq!(periodic.len(), SPEND_NUM_PERIODIC);

    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % P
    };
    let mut t = Tally::default();
    for _ in 0..proofs {
        let path_elements: Vec<u64> = (0..CANONICAL_DEPTH).map(|_| rnd()).collect();
        let path_indices: Vec<u8> = (0..CANONICAL_DEPTH).map(|_| (rnd() & 1) as u8).collect();
        let recipient = [rnd(), rnd(), rnd(), rnd()];
        let mask = BlindingMask::draw(MASK_LEN).expect("OS CSPRNG");
        let pd = generate_spend_compact_proof(rnd(), rnd(), rnd(), rnd(), &path_elements, &path_indices, &recipient, &mask);
        let b = &pd.proof_bytes;
        let pub_bytes: Vec<u8> = pd.public_inputs.iter().flat_map(|v| v.to_le_bytes()).collect();

        // The C7 wire, in the order compact_proof.rs parses it.
        let mut c = Cursor { b, at: 0 };
        let trace_root = c.take(32);
        let _quotient_root = c.take(32);
        c.take(tw * 8); // OOD frame at z
        c.take(tw * 8); // OOD frame at z·g
        c.take(8);
        c.take(SEGMENTS * 8); // OOD quotient claims
        let layers = c.u8() as usize;
        c.take(layers * 32);
        let final_size = c.u16() as usize;
        c.take(final_size * 8);
        c.take(8); // grinding nonce
        let nq = c.u16() as usize;
        assert_eq!(nq, QUERIES);
        let mut qs = Vec::new();
        for _ in 0..nq {
            let pos = c.u32() as usize;
            let cur = c.take(tw * 8);
            let cur_mirror = c.take(tw * 8);
            let next = c.take(tw * 8);
            let next_mirror = c.take(tw * 8);
            c.take((MERKLE_DEPTH - 1) * 32); // path of the current pair
            let next_path = c.take((MERKLE_DEPTH - 1) * 32);
            let quotient_mirror = c.take(SEGMENTS * 8);
            c.take((MERKLE_DEPTH - 1) * 32);
            for i in 0..layers {
                c.take(16 + (MERKLE_DEPTH - i - 2) * 32);
            }
            qs.push(Query { pos, cur, cur_mirror, next, next_mirror, next_path, quotient_mirror });
        }
        let quotient_values = c.take(nq * SEGMENTS * 8);
        assert_eq!(c.at, b.len(), "the parse must consume the proof exactly");

        let alpha = challenge(trace_root, &pub_bytes, b"rlc-c7\0\0");
        let alpha_bnd = challenge(trace_root, &pub_bytes, b"bnd-c7\0\0");
        let boundary: Vec<(usize, usize, F)> = SPEND_BOUNDARY_SPEC
            .iter()
            .map(|&(col, row, pi)| (col, row, pi.map(|i| F::new(pd.public_inputs[i])).unwrap_or(F::ZERO)))
            .collect();
        let g_last = g.exp((n - 1) as u64);

        for (qi, q) in qs.iter().enumerate() {
            let next_pos = (q.pos + BLOWUP) % LDE;
            let (lo, hi) = if next_pos < HALF { (q.next, q.next_mirror) } else { (q.next_mirror, q.next) };
            if merkle_ok(trace_root, lo, hi, next_pos & (HALF - 1), q.next_path) {
                t.next_pairs_authenticated += 1;
            }
            for mirror in [false, true] {
                let p = if mirror { q.pos ^ HALF } else { q.pos };
                let x = shift * omega.exp(p as u64);
                let cur = felts(if mirror { q.cur_mirror } else { q.cur });
                let nxt = felts(if mirror { q.next_mirror } else { q.next });
                let seg = felts(if mirror {
                    q.quotient_mirror
                } else {
                    &quotient_values[qi * SEGMENTS * 8..(qi + 1) * SEGMENTS * 8]
                });
                let per: Vec<F> = periodic.iter().map(|col| interpolate_at(col, g, x)).collect();
                let xn = x.exp(n as u64);
                let q_x = seg.iter().rev().fold(F::ZERO, |acc, v| acc * xn + *v);
                let rhs = |nxt: &[F]| -> F {
                    let mut cs = vec![F::ZERO; SPEND_NUM_CONSTRAINTS];
                    evaluate_spend_transition(&cur, nxt, &per, &mut cs);
                    let (mut cc, mut ap) = (F::ZERO, F::ONE);
                    for v in &cs {
                        cc += ap * *v;
                        ap *= alpha;
                    }
                    let (mut qb, mut bp) = (F::ZERO, F::ONE);
                    for &(col, row, v) in &boundary {
                        qb += bp * (cur[col] - v) / (x - g.exp(row as u64));
                        bp *= alpha_bnd;
                    }
                    cc * (x - g_last) / (xn - F::ONE) + qb
                };
                t.rows += 1;
                if rhs(&nxt) == q_x {
                    t.identity_holds += 1;
                }
                let mut bumped = nxt.clone();
                bumped[0] += F::ONE;
                if rhs(&bumped) == q_x {
                    t.identity_holds_bumped += 1;
                }
            }
        }
    }
    t
}

#[test]
fn every_opened_row_satisfies_the_quotient_identity_from_published_next_row_values() {
    let t = measure(2);
    println!("{t:?}");
    assert_eq!(t.rows, 2 * QUERIES * 2);
    assert_eq!(t.next_pairs_authenticated, t.rows / 2, "every next-row pair authenticates against the trace root");
    assert_eq!(t.identity_holds, t.rows, "the per-row quotient identity holds on every opened row, from wire data alone");
    assert_eq!(t.identity_holds_bumped, 0, "moving one next-row value breaks the identity on every row");
}
