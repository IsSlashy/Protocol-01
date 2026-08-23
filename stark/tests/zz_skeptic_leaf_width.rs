//! SECURITY PROBE: is the pool leaf really one 64-bit felt, and is
//! a same-leaf / distinct-nullifier collision really ~2^32?
//!
//! Uses `compute_pool_values` — the POOL's own commitment derivation, which is
//! what the leaf actually stores (merkle_tree_v3.rs:66, low 8 bytes). The
//! earlier version used C7's `compute_spend_values`; C7 is now a cfg(test)
//! module with no crate-root export (it would change the shipped prover blob),
//! so this probes the pool path directly, which is where the fund-loss lives.
use p01_stark::poseidon;
use p01_stark::{compute_pool_values, BaseElement};
use winterfell::math::FieldElement;
use std::collections::HashMap;
use std::time::Instant;

/// Truncated birthday: collide the low `B` bits of the commitment with two
/// DISTINCT nullifiers. Expected work ~2^(B/2). Extrapolate to B=64.
#[test]
#[ignore = "runs ~25s; a security measurement, not a per-commit gate. Run with --ignored"]
fn measured_truncated_birthday_scales_as_sqrt() {
    for bits in [32u32, 40, 44] {
        let mask: u64 = if bits == 64 { u64::MAX } else { (1u64 << bits) - 1 };
        let mut seen: HashMap<u64, (u64, u64)> = HashMap::new();
        let t0 = Instant::now();
        let mut found = None;
        for i in 0..(1u64 << (bits / 2 + 4)) {
            // vary `deposit_epoch` (i) -> commitment moves; two families
            // (i even/odd change the nullifier_preimage) force DISTINCT
            // nullifiers on the colliding pair. compute_pool_values returns
            // (nullifier, commitment).
            let np = BaseElement::new(1 + (i & 1));
            let (n, c) = compute_pool_values(
                np,
                BaseElement::new(7),
                BaseElement::new(i),
                BaseElement::new(444),
            );
            let key = c.as_int() & mask;
            let nu = n.as_int();
            if let Some(&(prev_i, prev_n)) = seen.get(&key) {
                if prev_n != nu {
                    found = Some((prev_i, i, key, prev_n, nu, t0.elapsed()));
                    break;
                }
            } else {
                seen.insert(key, (i, nu));
            }
        }
        let (a, b, key, na, nb, dt) = found.expect("no truncated collision found");
        println!(
            "bits={bits}: collision after ~{b} evals in {dt:?}; i={a} vs i={b}; \
             low{bits}(commitment)={key:#x}; nullifiers {na:#x} != {nb:#x}"
        );
        assert_ne!(na, nb, "the two colliding notes must carry DISTINCT nullifiers");
    }
}

/// Raw Poseidon-t3 throughput, to price the 2^32 extrapolation.
#[test]
fn measured_hash2_throughput() {
    let n = 1_000_000u64;
    let t0 = Instant::now();
    let mut acc = BaseElement::ZERO;
    for i in 0..n {
        acc = poseidon::hash2(BaseElement::new(i), acc);
    }
    let dt = t0.elapsed();
    let per_sec = n as f64 / dt.as_secs_f64();
    println!(
        "hash2: {per_sec:.0}/s single-core -> 2^32 = {:.1} core-hours (acc={:?})",
        (4.294967296e9 / per_sec) / 3600.0,
        acc.as_int()
    );
}
