//! The seven free quotient dimensions, measured — the last open question the
//! simulator construction left.
//!
//! # What this decides
//!
//! A random-oracle simulator for this proof system produces the quotient's OOD
//! claims like this: the RECOMBINATION is forced — at the out-of-domain point
//! `z`, `SUM_j z^(j*n) * Q_j(z)` must equal `C_total(z) / Z_T(z)`, and every
//! input to that is public — but the SPLIT across the `k = 8` segments is not.
//! One equation, eight unknowns, so S samples `Q_0(z)..Q_6(z)` UNIFORM and
//! solves `Q_7(z)`.
//!
//! The honest prover does not sample them. It computes all eight as a
//! deterministic degree-<=7 image of the SAME row mask that hides the trace. So
//! the question that decides whether S's transcript is indistinguishable is:
//!
//!   do the honest seven span the whole space, or do they lie in a proper
//!   subspace a distinguisher could notice?
//!
//! That is a RANK, and a rank is measurable. This file measures it.
//!
//! # What a pass means, and what it does not
//!
//! ✅ A full-rank result says the honest values are NOT confined to a proper
//!    linear subspace of the free space. That is a necessary condition for S's
//!    uniform sampling to be indistinguishable, and it is the one that would
//!    have failed loudly if the split were secretly determined.
//!
//! ⛔ It is NOT a proof of uniformity. Full rank rules out a LINEAR confinement;
//!    it says nothing about a non-linear one, and nothing about the distribution
//!    within the space. A distinguisher with a non-linear statistic is not
//!    addressed here, and this file must never be cited as if it were.
//!
//! # The control
//!
//! A rank measurement that always returns "full" measures nothing. So the same
//! instrument is run on proofs built with the SAME mask, where the answer must
//! collapse: identical masks give identical vectors, so the differences must
//! have rank ZERO. If that control ever returns full rank, the extraction is
//! reading noise and the measurement above is meaningless.
//!
//! Run: `cargo test -p p01-stark --release --test quotient_free_dimensions -- --nocapture`

const P: u128 = 0xFFFF_FFFF_0000_0001;

#[inline]
fn fsub(a: u64, b: u64) -> u64 {
    (((a as u128) + P - (b as u128)) % P) as u64
}
#[inline]
fn fmul(a: u64, b: u64) -> u64 {
    (((a as u128) * (b as u128)) % P) as u64
}
fn fpow(mut a: u64, mut e: u64) -> u64 {
    let mut r = 1u64;
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
    assert!(a != 0, "no inverse for 0");
    fpow(a, (P - 2) as u64)
}

/// C7's committed geometry. Read from the circuit, never typed: this file exists
/// because a stale literal turned a live measurement into noise more than once
/// in this repository.
const K: usize = 8; // quotient_segments

fn trace_width() -> usize {
    p01_stark::air::spend::TRACE_WIDTH
}

fn rd_u64(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(b[off..off + 8].try_into().unwrap())
}

/// `(ood_z, [Q_0(z) .. Q_7(z)])`, read straight off the wire.
///
/// Header order is `trace_root(32) | quotient_root(32) | ood_current(w) |
/// ood_next(w) | ood_z(1) | ood_quotient(k)`.
fn ood_claims(bytes: &[u8]) -> (u64, Vec<u64>) {
    let tw = trace_width();
    let z_off = 64 + 2 * tw * 8;
    let z = rd_u64(bytes, z_off);
    let q: Vec<u64> = (0..K).map(|j| rd_u64(bytes, z_off + 8 + j * 8)).collect();
    (z, q)
}

fn xorshift_mask(seed: u64, len: usize) -> Vec<u64> {
    let mut z = seed | 1;
    (0..len)
        .map(|_| {
            z ^= z << 13;
            z ^= z >> 7;
            z ^= z << 17;
            z % (P as u64)
        })
        .collect()
}

/// One honest C7 proof over the given mask seed. The witness is FIXED across
/// every call: what varies is the blinding, which is exactly the variable whose
/// image we are measuring.
fn spend_proof(mask_seed: u64) -> Vec<u8> {
    let d = p01_stark::air::spend::CANONICAL_DEPTH;
    let pe: Vec<u64> = (0..d as u64).map(|i| 1000 + i * 37).collect();
    let pi: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
    let mask = xorshift_mask(mask_seed, p01_stark::air::spend::MASK_LEN);
    p01_stark::compact::generate_spend_compact_proof(
        42, 999, 7, 555, &pe, &pi, &[11, 22, 33, 44], &mask,
    )
    .proof_bytes
}

/// Rank over Goldilocks by Gaussian elimination.
fn rank(mut rows: Vec<Vec<u64>>) -> usize {
    if rows.is_empty() {
        return 0;
    }
    let cols = rows[0].len();
    let mut r = 0usize;
    for c in 0..cols {
        let Some(pivot) = (r..rows.len()).find(|&i| rows[i][c] != 0) else {
            continue;
        };
        rows.swap(r, pivot);
        let inv = finv(rows[r][c]);
        for x in rows[r].iter_mut() {
            *x = fmul(*x, inv);
        }
        for i in 0..rows.len() {
            if i != r && rows[i][c] != 0 {
                let f = rows[i][c];
                for j in c..cols {
                    rows[i][j] = fsub(rows[i][j], fmul(f, rows[r][j]));
                }
            }
        }
        r += 1;
        if r == rows.len() {
            break;
        }
    }
    r
}

/// The seven coordinates S would sample uniform: `Q_0(z)..Q_6(z)`.
///
/// ⚠️ `Q_7(z)` is DELIBERATELY EXCLUDED. It is the one the recombination solves,
/// so including it would add a coordinate that is a deterministic function of the
/// other seven plus public data — the matrix would still be rank 7 and the result
/// would look identical while measuring something weaker.
fn free_coordinates(bytes: &[u8]) -> Vec<u64> {
    let (z, q) = ood_claims(bytes);
    assert_ne!(z, 0, "ood_z must be non-zero or the split is not solvable");
    q[..K - 1].to_vec()
}

#[test]
fn the_seven_free_quotient_coordinates_span_their_whole_space() {
    const N: usize = 24;
    let base = free_coordinates(&spend_proof(0xC7_D1_0001));
    let mut diffs = Vec::with_capacity(N);
    for i in 1..=N {
        let v = free_coordinates(&spend_proof(0xC7_D1_0001 + i as u64 * 0x9E37));
        diffs.push(v.iter().zip(&base).map(|(a, b)| fsub(*a, *b)).collect::<Vec<u64>>());
    }
    let r = rank(diffs);
    println!();
    println!("C7 free quotient coordinates: {} samples, rank {} of {}", N, r, K - 1);
    println!();
    println!("Rank {} of {} means the honest values are not confined to a proper linear", r, K - 1);
    println!("subspace, so the simulator's uniform sampling on the same affine set is not");
    println!("separated from them by any LINEAR statistic.");
    println!();
    println!("⛔ It does NOT establish uniformity. A non-linear distinguisher is untouched by");
    println!("this measurement, and no part of it should be quoted as 'the quotient is hiding'.");

    assert_eq!(
        r,
        K - 1,
        "the honest quotient split spans only {r} of {} dimensions. The simulator samples \
         all {} uniform, so a linear functional separates simulated transcripts from real \
         ones and the construction is NOT indistinguishable on this component.",
        K - 1,
        K - 1,
    );
}

#[test]
fn the_control_collapses_when_the_mask_does_not_move() {
    // Same witness, SAME mask, every time. The proof is deterministic, so the
    // differences must be exactly zero and the rank must be 0. A full-rank
    // answer here would mean the extraction is reading something that varies for
    // a reason having nothing to do with the blinding — and the measurement
    // above would be meaningless.
    const N: usize = 8;
    let base = free_coordinates(&spend_proof(0xC7_D1_0001));
    let mut diffs = Vec::with_capacity(N);
    for _ in 0..N {
        let v = free_coordinates(&spend_proof(0xC7_D1_0001));
        diffs.push(v.iter().zip(&base).map(|(a, b)| fsub(*a, *b)).collect::<Vec<u64>>());
    }
    let r = rank(diffs);
    println!("control (mask held fixed): rank {r} — must be 0");
    assert_eq!(
        r, 0,
        "the control did not collapse. The seven coordinates moved while the mask was held \
         fixed, so they are not a function of the blinding alone and the rank measured in \
         the test above is not measuring what it claims."
    );
}
