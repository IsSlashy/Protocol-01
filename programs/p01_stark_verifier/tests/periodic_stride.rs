//! Release-mode guard for the A3 periodic-column conversion.
//!
//! `eval_periodic_stride_at_z` deliberately does not check sparsity at runtime —
//! a scan would cost exactly what the routine saves. The tables are compile-time
//! constants, so the assumption is pinned here instead, and this file must run
//! in release mode: the older `eval_periodic_stride16_at_z` guards its own
//! sparsity behind `#[cfg(debug_assertions)]`, so a release build handed a dense
//! array silently evaluates a DIFFERENT polynomial with no error at all.
//!
//! Run with: `cargo test -p p01_stark_verifier --release --test periodic_stride`

use p01_stark_verifier::periodic_consts::*;

const MODULUS: u128 = 0xFFFFFFFF00000001;

/// Dense Horner over u128, independent of the crate's field code on purpose:
/// if `Felt` arithmetic ever regresses, this reference does not regress with it.
fn dense_eval(coeffs: &[u64], z: u64) -> u64 {
    let mut acc: u128 = 0;
    for &c in coeffs.iter().rev() {
        acc = (acc * (z as u128) + (c as u128)) % MODULUS;
    }
    acc as u64
}

fn stride_eval(coeffs: &[u64], z: u64, stride: usize) -> u64 {
    assert_eq!(coeffs.len() % stride, 0);
    let mut y: u128 = 1;
    for _ in 0..stride {
        y = (y * (z as u128)) % MODULUS;
    }
    let compressed = coeffs.len() / stride;
    let mut acc: u128 = 0;
    for k in (0..compressed).rev() {
        acc = (acc * y + (coeffs[k * stride] as u128)) % MODULUS;
    }
    acc as u64
}

/// Every table wired to `eval_periodic_stride_at_z` in `verify.rs`, with the
/// stride it was wired with. Extend this list whenever another table is wired.
fn converted_tables() -> Vec<(&'static str, &'static [u64], usize)> {
    vec![
        ("C2_RC0", &C2_RC0_COEFFS, 4),
        ("C2_RC1", &C2_RC1_COEFFS, 4),
        ("C2_RC2", &C2_RC2_COEFFS, 4),
        ("C2_ROUND_FLAG", &C2_ROUND_FLAG_COEFFS, 4),
        ("C4_RC0", &C4_RC0_COEFFS, 8),
        ("C4_RC1", &C4_RC1_COEFFS, 8),
        ("C4_RC2", &C4_RC2_COEFFS, 8),
        ("C4_ROUND_FLAG", &C4_ROUND_FLAG_COEFFS, 8),
    ]
}

#[test]
fn converted_tables_are_actually_sparse_at_their_stride() {
    for (name, coeffs, stride) in converted_tables() {
        for (i, &c) in coeffs.iter().enumerate() {
            assert!(
                i % stride == 0 || c == 0,
                "{name}: wired at stride {stride} but index {i} is non-zero. \
                 The stride evaluator would silently compute a different polynomial."
            );
        }
    }
}

#[test]
fn periodic_stride_parity() {
    // Deterministic sweep so any failure is reproducible.
    let mut s: u64 = 0x9E3779B97F4A7C15;
    let mut next = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s % MODULUS as u64).max(1)
    };

    for (name, coeffs, stride) in converted_tables() {
        for _ in 0..1_000 {
            let z = next();
            assert_eq!(
                stride_eval(coeffs, z, stride),
                dense_eval(coeffs, z),
                "{name} stride-{stride} disagrees with dense Horner at z={z}"
            );
        }
    }
}

/// The two reuse claims that let C4 evaluate two polynomials instead of four.
#[test]
fn c4_duplicate_tables_are_identical() {
    assert_eq!(
        C4_CHAIN_34_COEFFS[..],
        C4_CHAIN_CARRY_4_COEFFS[..],
        "C4_CHAIN_34 and C4_CHAIN_CARRY_4 are evaluated once and reused; they diverged"
    );
    assert_eq!(
        C4_CHAIN_56_COEFFS[..],
        C4_CHAIN_CARRY_6_COEFFS[..],
        "C4_CHAIN_56 and C4_CHAIN_CARRY_6 are evaluated once and reused; they diverged"
    );
}

// ============================================================================
// [A4] Periodic-extension constants for circuits 3 and 6
// ============================================================================
// `verify_deep_ali_circuit_3` / `_6` no longer Horner the dense
// `C3_*_COEFFS` / `C6_*_COEFFS`. They evaluate the 32-periodic *extension* of
// each column -- stride-16 sparse, 32 coefficients -- and that is the WHOLE
// evaluation:
//
//     P_actual(z) = P_periodic(z)
//
// [ZK-MASK 2026-08-30] There used to be a second term here, a Lagrange
// correction `- SUM_j TAIL[j] * L_{480+j}(z)` over the 32 rows the AIRs
// truncated at depth 15. Under the depth-11 layout the columns are 32-periodic
// on ALL 512 rows, so the extension IS the column, every TAIL is zero, and the
// correction -- 32 Lagrange terms with a field inversion each -- is gone from
// the verifier. What is left in its place is an assertion that the fourteen
// tables are still zero, because a value coming back means the AIR truncates
// again, which means the blinding rows are constrained again.
//
// `periodic_ext_consts` is a derived artifact of `periodic_consts`. Nothing at
// runtime re-derives it — a scan would cost what the rewrite saves — so the
// derivation is redone here, from the dense tables, in release mode. A rebake
// of `periodic_consts.rs` that is not mirrored into `periodic_ext_consts.rs`
// fails these tests instead of silently changing the polynomial the verifier
// evaluates.

use p01_stark_verifier::periodic_ext_consts::*;

const N: usize = 512;
/// Trace-domain generator of order 512 (`GENERATOR_512` in `verify.rs`).
const G512: u64 = 0x1905D02A5C411F4E;
/// `1/512` in Goldilocks, as baked into `verify.rs` as `INV_512`.
const INV_512: u64 = 18_410_715_272_404_008_961;

fn mmul(a: u64, b: u64) -> u64 {
    ((a as u128 * b as u128) % MODULUS) as u64
}
fn madd(a: u64, b: u64) -> u64 {
    ((a as u128 + b as u128) % MODULUS) as u64
}
fn msub(a: u64, b: u64) -> u64 {
    ((a as u128 + MODULUS - b as u128) % MODULUS) as u64
}
fn mpow(mut a: u64, mut e: u64) -> u64 {
    let mut r = 1u64;
    while e > 0 {
        if e & 1 == 1 {
            r = mmul(r, a);
        }
        a = mmul(a, a);
        e >>= 1;
    }
    r
}
fn minv(a: u64) -> u64 {
    assert_ne!(a, 0, "inverse of zero");
    mpow(a, (MODULUS - 2) as u64)
}

fn domain_powers() -> (Vec<u64>, Vec<u64>) {
    let mut pows = vec![0u64; N];
    let mut acc = 1u64;
    for p in pows.iter_mut() {
        *p = acc;
        acc = mmul(acc, G512);
    }
    let gi = minv(G512);
    let mut ipows = vec![0u64; N];
    let mut acc = 1u64;
    for p in ipows.iter_mut() {
        *p = acc;
        acc = mmul(acc, gi);
    }
    (pows, ipows)
}

/// Every column wired to `eval_periodic_ext_at_z`, paired with the dense table
/// it must be derivable from. Extend whenever another column is converted.
#[allow(clippy::type_complexity)]
fn extension_tables() -> Vec<(&'static str, &'static [u64; 512], &'static [u64; 32], &'static [u64; 32])>
{
    vec![
        ("C3_RC0", &C3_RC0_COEFFS, &C3_RC0_PERIODIC16, &C3_RC0_TAIL),
        ("C3_RC1", &C3_RC1_COEFFS, &C3_RC1_PERIODIC16, &C3_RC1_TAIL),
        ("C3_RC2", &C3_RC2_COEFFS, &C3_RC2_PERIODIC16, &C3_RC2_TAIL),
        ("C3_ROUND_ACTIVE", &C3_ROUND_ACTIVE_COEFFS, &C3_ROUND_ACTIVE_PERIODIC16, &C3_ROUND_ACTIVE_TAIL),
        ("C3_HASH_START", &C3_HASH_START_COEFFS, &C3_HASH_START_PERIODIC16, &C3_HASH_START_TAIL),
        ("C3_IS_BOUNDARY", &C3_IS_BOUNDARY_COEFFS, &C3_IS_BOUNDARY_PERIODIC16, &C3_IS_BOUNDARY_TAIL),
        ("C3_IS_INTERIOR", &C3_IS_INTERIOR_COEFFS, &C3_IS_INTERIOR_PERIODIC16, &C3_IS_INTERIOR_TAIL),
        ("C6_RC0", &C6_RC0_COEFFS, &C6_RC0_PERIODIC16, &C6_RC0_TAIL),
        ("C6_RC1", &C6_RC1_COEFFS, &C6_RC1_PERIODIC16, &C6_RC1_TAIL),
        ("C6_RC2", &C6_RC2_COEFFS, &C6_RC2_PERIODIC16, &C6_RC2_TAIL),
        ("C6_ROUND_ACTIVE", &C6_ROUND_ACTIVE_COEFFS, &C6_ROUND_ACTIVE_PERIODIC16, &C6_ROUND_ACTIVE_TAIL),
        ("C6_HASH_START", &C6_HASH_START_COEFFS, &C6_HASH_START_PERIODIC16, &C6_HASH_START_TAIL),
        ("C6_IS_BOUNDARY", &C6_IS_BOUNDARY_COEFFS, &C6_IS_BOUNDARY_PERIODIC16, &C6_IS_BOUNDARY_TAIL),
        ("C6_IS_INTERIOR", &C6_IS_INTERIOR_COEFFS, &C6_IS_INTERIOR_PERIODIC16, &C6_IS_INTERIOR_TAIL),
    ]
}

/// The generator and `1/512` the verifier bakes must be the real ones.
#[test]
fn a4_field_constants_are_correct() {
    assert_eq!(mpow(G512, 512), 1, "G512^512 != 1");
    assert_ne!(mpow(G512, 256), 1, "G512 does not have order exactly 512");
    assert_eq!(mmul(INV_512, 512), 1, "INV_512 is not the inverse of 512");
}

/// Re-derive `*_PERIODIC16` and `*_TAIL` from the dense tables and compare.
/// This is the guard against a silent rebake of `periodic_consts.rs`.
#[test]
fn a4_extension_constants_match_dense_tables() {
    let (pows, ipows) = domain_powers();
    let inv_n = INV_512;

    for (name, dense, periodic16, tail) in extension_tables() {
        // Values of the real column on the trace domain.
        let vals: Vec<u64> = (0..N).map(|i| dense_eval(dense, pows[i])).collect();

        // [ZK-MASK 2026-08-30] 32-PERIODIC ON ALL 512 ROWS, not on 0..480.
        //
        // The predecessor of this block asserted rows 480..511 were ZERO,
        // because the walk truncated there at depth 15 and the extension
        // deviated from the column over that tail. Under the depth-11 layout
        // C3 and C6 build these seven columns across every row -- which is
        // exactly why verify.rs could delete its Lagrange correction arm and
        // call the fourteen *_TAIL tables dead. So the check is the stronger
        // one now: periodicity everywhere, and no tail at all.
        for (i, v) in vals.iter().enumerate() {
            assert_eq!(
                *v,
                vals[i % 32],
                "{name}: row {i} breaks 32-periodicity. The stride-16 evaluator in verify.rs assumes it holds on ALL 512 rows and carries no correction term any more, so an honest proof would be rejected at the OOD point."
            );
        }

        // 32-periodic extension and its interpolant.
        let w: Vec<u64> = (0..N).map(|i| vals[i % 32]).collect();
        let mut pc = vec![0u64; N];
        for (j, out) in pc.iter_mut().enumerate() {
            let mut acc = 0u64;
            for i in 0..N {
                if w[i] != 0 {
                    acc = madd(acc, mmul(w[i], ipows[(i * j) % N]));
                }
            }
            *out = mmul(acc, inv_n);
        }

        // Claim 1: the extension is stride-16 sparse.
        for (j, c) in pc.iter().enumerate() {
            if j % 16 != 0 {
                assert_eq!(
                    *c, 0,
                    "{name}: periodic extension is NOT stride-16 sparse \
                     (coefficient {j} is non-zero); eval_periodic_ext_at_z \
                     would evaluate a different polynomial"
                );
            }
        }

        // The baked constants must be exactly that derivation.
        for k in 0..32 {
            assert_eq!(
                periodic16[k], pc[k * 16],
                "{name}_PERIODIC16[{k}] is stale vs periodic_consts.rs"
            );
            // A non-zero TAIL is not a stale constant, it is a PRIVACY
            // regression. The deviation is zero exactly while the periodic
            // columns run all 512 rows, and they run all 512 rows exactly
            // while the blinding rows take no Poseidon round. A value here
            // means the rounds came back and air_aware_recovery_c3 recovers
            // the path and the leaf index again.
            assert_eq!(
                tail[k], 0,
                "{name}_TAIL[{k}] is non-zero. The periodic columns are truncated again, so the blinding rows are constrained again -- that is the privacy regression verify.rs warns about, not a bookkeeping drift."
            );
        }
    }
}

/// Claim 2: the identity itself, at random `z`, against dense Horner.
#[test]
fn a4_periodic_extension_identity() {
    let (pows, _) = domain_powers();
    let inv_n = INV_512;

    let mut s: u64 = 0xD1B54A32D192ED03;
    let mut next = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s % MODULUS as u64).max(2)
    };

    for (name, dense, periodic16, tail) in extension_tables() {
        for _ in 0..1_000 {
            let z = next();
            let z_n = mpow(z, N as u64);
            if z_n == 1 {
                continue; // z in the trace domain: verifier rejects, skip.
            }
            let y16 = mpow(z, 16);

            // P_periodic(z) via the stride-16 compressed coefficients.
            let mut p_per = 0u64;
            for k in (0..32).rev() {
                p_per = madd(mmul(p_per, y16), periodic16[k]);
            }

            // No correction term. It used to be a 32-term Lagrange sum with
            // a division per term; it is gone from the verifier for the same
            // reason it is gone from here -- every TAIL is zero, so the sum
            // is zero. The assertion above is what keeps that true.
            assert_eq!(
                p_per,
                dense_eval(dense, z),
                "{name}: periodic-extension identity fails at z={z}"
            );
        }
    }
}

/// C2's IS_BOUNDARY is computed as CHAIN_01 + CARRY_CAPTURE + CHAIN_CARRY
/// instead of being evaluated. That is only valid if the identity holds on the
/// coefficients, which it does — pin it.
#[test]
fn c2_is_boundary_identity() {
    for i in 0..C2_IS_BOUNDARY_COEFFS.len() {
        let sum = ((C2_CHAIN_01_COEFFS[i] as u128)
            + (C2_CARRY_CAPTURE_COEFFS[i] as u128)
            + (C2_CHAIN_CARRY_COEFFS[i] as u128))
            % MODULUS;
        assert_eq!(
            sum, C2_IS_BOUNDARY_COEFFS[i] as u128,
            "C2 IS_BOUNDARY identity fails at coefficient {i}"
        );
    }
}
