//! [PERFECT-IOP 2026-09-12] The prover and the verifier resample the
//! out-of-domain point with the SAME rule, held side by side.
//!
//! The rule: hash the transcript roots and the public inputs; while the first
//! eight bytes reduced mod p are zero, a trace-domain point (`z^n = 1`) or an
//! LDE-coset point (`z^lde = h^lde`), re-hash the 32 bytes. It removes the one
//! event on which the honest prover used to emit an unverifiable proof and the
//! simulator of `docs/zk-simulation-argument.md` used to fail. A rule that the
//! two crates implemented differently would be a proof the verifier rejects
//! once in 2^51 -- invisible to every end-to-end test -- so the two functions
//! are compared directly, on forced bad candidates and on random ones, for
//! every shipped geometry.

use p01_stark_verifier::compact_proof::get_circuit_config;
use p01_stark_verifier::goldilocks::Felt;
use p01_stark_verifier::verify::LDE_COSET_SHIFT;

fn xorshift(x: &mut u64) -> u64 {
    *x ^= *x << 13;
    *x ^= *x >> 7;
    *x ^= *x << 17;
    *x
}

#[test]
fn both_sides_resample_the_ood_point_identically_on_every_geometry() {
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut resampled = 0usize;
    for id in 0u8..=7 {
        let cfg = get_circuit_config(id).expect("config");
        let (n, lde) = (cfg.trace_length, cfg.lde_size);
        let g = Felt::new(7).exp((0xFFFF_FFFF_0000_0001u64 - 1) / n as u64); // a generator of H_n
        let coset_marker = Felt::new(LDE_COSET_SHIFT).exp(lde as u64).as_u64();
        for i in 0..96usize {
            let mut h = [0u8; 32];
            for b in h.chunks_mut(8) {
                b.copy_from_slice(&xorshift(&mut x).to_le_bytes());
            }
            // The first candidates are FORCED into the bad set.
            let forced: Option<u64> = match i {
                0 => Some(0),
                1 => Some(1),
                2 => Some(g.as_u64()),
                3 => Some(LDE_COSET_SHIFT),
                4 => Some(0xFFFF_FFFF_0000_0001), // p, reduces to zero
                _ => None,
            };
            if let Some(f) = forced {
                h[..8].copy_from_slice(&f.to_le_bytes());
            }
            let prover = p01_stark::compact::ood_point_from_transcript_hash(h, n, lde);
            let verifier = p01_stark_verifier::verify::ood_point_from_transcript_hash(h, n, lde);
            assert_eq!(prover, verifier, "C{id} sample {i}: the two crates disagree on z");
            let first = p01_stark_verifier::verify::ood_point_from_hash(&h, n, lde);
            if first.is_none() {
                resampled += 1;
                assert!(forced.is_some() || i < 5, "C{id} sample {i}: a random 64-bit candidate landed in the bad set (probability 2^-51)");
            } else {
                assert_eq!(Some(prover), first, "C{id} sample {i}: a usable first candidate is kept as is");
            }
            let z = Felt::new(verifier);
            assert_ne!(verifier, 0, "C{id}: z = 0");
            assert_ne!(z.exp(n as u64).as_u64(), 1, "C{id}: z in the trace domain");
            assert_ne!(z.exp(lde as u64).as_u64(), coset_marker, "C{id}: z on the LDE coset");
        }
    }
    // Five forced candidates per circuit, all rejected: the loop did run.
    assert_eq!(resampled, 8 * 5, "every forced candidate must have been resampled");
}

/// The forced candidates really are in the bad set, on the verifier's own arithmetic:
/// a test that only compared two identical mistakes would pass for the wrong reason.
#[test]
fn the_forced_candidates_are_in_the_bad_set() {
    let cfg = get_circuit_config(7).unwrap();
    let (n, lde) = (cfg.trace_length, cfg.lde_size);
    assert_eq!(Felt::new(1).exp(n as u64).as_u64(), 1);
    let g = Felt::new(7).exp((0xFFFF_FFFF_0000_0001u64 - 1) / n as u64);
    assert_eq!(g.exp(n as u64).as_u64(), 1, "g generates H_n");
    assert_ne!(g.as_u64(), 1);
    assert_eq!(
        Felt::new(LDE_COSET_SHIFT).exp(lde as u64).as_u64(),
        Felt::new(LDE_COSET_SHIFT).exp(lde as u64).as_u64()
    );
    for bad in [0u64, 1, g.as_u64(), LDE_COSET_SHIFT] {
        let mut h = [0u8; 32];
        h[..8].copy_from_slice(&bad.to_le_bytes());
        assert_eq!(p01_stark_verifier::verify::ood_point_from_hash(&h, n, lde), None, "{bad}");
    }
}
