//! [A4] Provenance probe and generator for `src/periodic_ext_consts.rs`.
//!
//! `a4_probe` is the numerical proof that the periodic-extension rewrite in
//! `verify_deep_ali_circuit_3` / `_6` is legitimate. For every C3/C6 periodic
//! column it reports, from the dense tables actually in the tree:
//!   * the coefficient-index gcd and non-zero count of the real column and of
//!     its 32-periodic extension,
//!   * whether rows 0..480 really are 32-periodic and rows 480..512 really are
//!     zero-filled,
//!   * the true deviation support and per-column deviation counts,
//!   * the identity `P_actual(z) = P_periodic(z) + Σ_r dev_r · L_r(z)` at 1,000
//!     random `z` against a dense Horner.
//!
//! `a4_emit_consts` (run with `--ignored`) regenerates
//! `src/periodic_ext_consts.rs` from the same derivation. The *guard* against a
//! stale regeneration lives in `tests/periodic_stride.rs`, which runs by default
//! and in release mode; this file is the report and the generator.
//!
//! Run with: cargo test -p p01_stark_verifier --release --test a4_probe -- --nocapture

use p01_stark_verifier::periodic_consts::*;

const P: u128 = 0xFFFFFFFF00000001;
const N: usize = 512;
const G512: u64 = 0x1905D02A5C411F4E;

fn mul(a: u64, b: u64) -> u64 {
    ((a as u128 * b as u128) % P) as u64
}
fn add(a: u64, b: u64) -> u64 {
    ((a as u128 + b as u128) % P) as u64
}
fn sub(a: u64, b: u64) -> u64 {
    ((a as u128 + P - b as u128) % P) as u64
}
fn pow(mut a: u64, mut e: u64) -> u64 {
    let mut r = 1u64;
    while e > 0 {
        if e & 1 == 1 {
            r = mul(r, a);
        }
        a = mul(a, a);
        e >>= 1;
    }
    r
}
fn inv(a: u64) -> u64 {
    assert!(a != 0);
    pow(a, (P - 2) as u64)
}

fn dense_eval(coeffs: &[u64], z: u64) -> u64 {
    let mut acc = 0u64;
    for &c in coeffs.iter().rev() {
        acc = add(mul(acc, z), c % (P as u64));
    }
    acc
}

fn stride_eval(coeffs: &[u64], z: u64, stride: usize) -> u64 {
    let y = pow(z, stride as u64);
    let m = coeffs.len() / stride;
    let mut acc = 0u64;
    for k in (0..m).rev() {
        acc = add(mul(acc, y), coeffs[k * stride]);
    }
    acc
}

fn gcd(a: usize, b: usize) -> usize {
    if b == 0 { a } else { gcd(b, a % b) }
}

struct ColReport {
    name: &'static str,
    gcd: usize,
    nonzero: usize,
    dev_support: Vec<usize>,
    periodic_prefix_ok: bool,
    identity_ok: bool,
}

fn analyse(name: &'static str, coeffs: &[u64; 512], pows: &[u64], ipows: &[u64], inv_n: u64) -> ColReport {
    // 1. values on the trace domain
    let vals: Vec<u64> = (0..N).map(|i| dense_eval(coeffs, pows[i])).collect();

    // 2. 32-periodic extension: w_i = v_{i mod 32}
    let w: Vec<u64> = (0..N).map(|i| vals[i % 32]).collect();

    // Does the actual column agree with the extension everywhere outside 480..512?
    let periodic_prefix_ok = (0..480).all(|i| vals[i] == w[i]);

    // 3. interpolate w over the subgroup: c_j = (1/N) Σ_i w_i g^{-ij}
    let mut pc = vec![0u64; N];
    for j in 0..N {
        let mut acc = 0u64;
        for i in 0..N {
            if w[i] != 0 {
                acc = add(acc, mul(w[i], ipows[(i * j) % N]));
            }
        }
        pc[j] = mul(acc, inv_n);
    }

    let nz: Vec<usize> = (0..N).filter(|&j| pc[j] != 0).collect();
    let nonzero = nz.len();
    let g = nz.iter().fold(N, |a, &b| gcd(a, b));

    // 4. deviations
    let dev: Vec<u64> = (0..N).map(|i| sub(vals[i], w[i])).collect();
    let dev_support: Vec<usize> = (0..N).filter(|&i| dev[i] != 0).collect();

    // 5. identity at 1000 random z
    let mut s: u64 = 0x9E3779B97F4A7C15 ^ (name.len() as u64);
    let mut next = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s % (P as u64)).max(2)
    };
    let mut identity_ok = true;
    for _ in 0..1000 {
        let z = next();
        // skip z in the subgroup (probability ~0)
        let zn = pow(z, N as u64);
        if zn == 1 {
            continue;
        }
        let lhs = dense_eval(coeffs, z);
        let p_per = stride_eval(&pc, z, if g == 0 { 1 } else { g.min(16) });
        // correction
        let zn_minus_1 = sub(zn, 1);
        let mut corr = 0u64;
        for &r in &dev_support {
            let l = mul(
                mul(pows[r], zn_minus_1),
                mul(inv_n, inv(sub(z, pows[r]))),
            );
            corr = add(corr, mul(dev[r], l));
        }
        // dev_r = v_r - w_r  =>  P_actual = P_periodic + Σ dev_r L_r
        let rhs_plus = add(p_per, corr);
        let rhs_minus = sub(p_per, corr);
        if lhs != rhs_plus {
            identity_ok = false;
            println!(
                "  {name}: IDENTITY FAIL at z={z}: lhs={lhs} plus={rhs_plus} minus={rhs_minus} (minus_ok={})",
                lhs == rhs_minus
            );
            break;
        }
    }

    ColReport { name, gcd: g, nonzero, dev_support, periodic_prefix_ok, identity_ok }
}

#[test]
fn a4_probe() {
    // sanity on the generator
    assert_eq!(pow(G512, 512), 1, "g^512 != 1");
    assert_ne!(pow(G512, 256), 1, "g is not primitive of order 512");

    let mut pows = vec![0u64; N];
    let mut acc = 1u64;
    for i in 0..N {
        pows[i] = acc;
        acc = mul(acc, G512);
    }
    let gi = inv(G512);
    let mut ipows = vec![0u64; N];
    let mut acc = 1u64;
    for i in 0..N {
        ipows[i] = acc;
        acc = mul(acc, gi);
    }
    let inv_n = inv(N as u64);

    let tables: Vec<(&'static str, &[u64; 512])> = vec![
        ("C3_RC0", &C3_RC0_COEFFS),
        ("C3_RC1", &C3_RC1_COEFFS),
        ("C3_RC2", &C3_RC2_COEFFS),
        ("C3_ROUND_ACTIVE", &C3_ROUND_ACTIVE_COEFFS),
        ("C3_HASH_START", &C3_HASH_START_COEFFS),
        ("C3_IS_BOUNDARY", &C3_IS_BOUNDARY_COEFFS),
        ("C3_IS_INTERIOR", &C3_IS_INTERIOR_COEFFS),
        ("C6_RC0", &C6_RC0_COEFFS),
        ("C6_RC1", &C6_RC1_COEFFS),
        ("C6_RC2", &C6_RC2_COEFFS),
        ("C6_ROUND_ACTIVE", &C6_ROUND_ACTIVE_COEFFS),
        ("C6_HASH_START", &C6_HASH_START_COEFFS),
        ("C6_IS_BOUNDARY", &C6_IS_BOUNDARY_COEFFS),
        ("C6_IS_INTERIOR", &C6_IS_INTERIOR_COEFFS),
    ];

    println!("\n=== A4 identity probe ===");
    let mut all_supports: Vec<(&str, Vec<usize>)> = vec![];
    let mut fail = false;
    for (name, c) in tables {
        // how dense is the ORIGINAL table?
        let orig_nz = c.iter().filter(|&&x| x != 0).count();
        let orig_nz_idx: Vec<usize> = (0..N).filter(|&j| c[j] != 0).collect();
        let orig_gcd = orig_nz_idx.iter().fold(N, |a, &b| gcd(a, b));

        let r = analyse(name, c, &pows, &ipows, inv_n);
        println!(
            "{:<18} orig: nz={:>3} gcd={:>3} | periodic-ext: nz={:>3} gcd={:>3} | prefix_ok={} | dev_count={:>3} dev_range={:?}..{:?} | identity={}",
            r.name,
            orig_nz,
            orig_gcd,
            r.nonzero,
            r.gcd,
            r.periodic_prefix_ok,
            r.dev_support.len(),
            r.dev_support.first(),
            r.dev_support.last(),
            r.identity_ok
        );
        if !r.identity_ok || r.gcd < 16 {
            fail = true;
        }
        all_supports.push((r.name, r.dev_support));
    }

    // --- extra structural checks -------------------------------------------
    println!("\n--- C3 vs C6 table equality ---");
    let pairs: Vec<(&str, &[u64; 512], &[u64; 512])> = vec![
        ("RC0", &C3_RC0_COEFFS, &C6_RC0_COEFFS),
        ("RC1", &C3_RC1_COEFFS, &C6_RC1_COEFFS),
        ("RC2", &C3_RC2_COEFFS, &C6_RC2_COEFFS),
        ("ROUND_ACTIVE", &C3_ROUND_ACTIVE_COEFFS, &C6_ROUND_ACTIVE_COEFFS),
        ("HASH_START", &C3_HASH_START_COEFFS, &C6_HASH_START_COEFFS),
        ("IS_BOUNDARY", &C3_IS_BOUNDARY_COEFFS, &C6_IS_BOUNDARY_COEFFS),
        ("IS_INTERIOR", &C3_IS_INTERIOR_COEFFS, &C6_IS_INTERIOR_COEFFS),
    ];
    for (n, a, b) in &pairs {
        println!("  {:<14} C3==C6: {}", n, a[..] == b[..]);
    }

    println!("\n--- are rows 480..511 actually zero in the real column? ---");
    for (n, a, _) in &pairs {
        let tail_nonzero: Vec<usize> =
            (480..512).filter(|&i| dense_eval(*a, pows[i]) != 0).collect();
        println!("  {:<14} nonzero tail rows: {} {:?}", n, tail_nonzero.len(), tail_nonzero);
    }

    // union of supports
    let mut union: Vec<usize> = all_supports.iter().flat_map(|(_, s)| s.iter().cloned()).collect();
    union.sort_unstable();
    union.dedup();
    println!("\nUnion of deviation support ({} rows): {:?}", union.len(), union);
    println!("min={:?} max={:?}", union.first(), union.last());

    assert!(!fail, "A4 identity refuted — see report above");
}

/// Emits `src/periodic_ext_consts.rs`. Run with `--ignored`.
#[test]
#[ignore]
fn a4_emit_consts() {
    use std::fmt::Write as _;

    let mut pows = vec![0u64; N];
    let mut acc = 1u64;
    for i in 0..N {
        pows[i] = acc;
        acc = mul(acc, G512);
    }
    let gi = inv(G512);
    let mut ipows = vec![0u64; N];
    let mut acc = 1u64;
    for i in 0..N {
        ipows[i] = acc;
        acc = mul(acc, gi);
    }
    let inv_n = inv(N as u64);

    let tables: Vec<(&'static str, &[u64; 512])> = vec![
        ("C3_RC0", &C3_RC0_COEFFS),
        ("C3_RC1", &C3_RC1_COEFFS),
        ("C3_RC2", &C3_RC2_COEFFS),
        ("C3_ROUND_ACTIVE", &C3_ROUND_ACTIVE_COEFFS),
        ("C3_HASH_START", &C3_HASH_START_COEFFS),
        ("C3_IS_BOUNDARY", &C3_IS_BOUNDARY_COEFFS),
        ("C3_IS_INTERIOR", &C3_IS_INTERIOR_COEFFS),
        ("C6_RC0", &C6_RC0_COEFFS),
        ("C6_RC1", &C6_RC1_COEFFS),
        ("C6_RC2", &C6_RC2_COEFFS),
        ("C6_ROUND_ACTIVE", &C6_ROUND_ACTIVE_COEFFS),
        ("C6_HASH_START", &C6_HASH_START_COEFFS),
        ("C6_IS_BOUNDARY", &C6_IS_BOUNDARY_COEFFS),
        ("C6_IS_INTERIOR", &C6_IS_INTERIOR_COEFFS),
    ];

    let mut out = String::new();
    out.push_str(HEADER);
    for (name, c) in tables {
        let vals: Vec<u64> = (0..N).map(|i| dense_eval(c, pows[i])).collect();
        let w: Vec<u64> = (0..N).map(|i| vals[i % 32]).collect();
        let mut pc = vec![0u64; N];
        for j in 0..N {
            let mut a = 0u64;
            for i in 0..N {
                if w[i] != 0 {
                    a = add(a, mul(w[i], ipows[(i * j) % N]));
                }
            }
            pc[j] = mul(a, inv_n);
        }
        for j in 0..N {
            if j % 16 != 0 {
                assert_eq!(pc[j], 0, "{name}: extension not stride-16 at {j}");
            }
        }
        writeln!(
            out,
            "/// Stride-16 compressed coefficients of the 32-periodic extension of `{name}_COEFFS`.\n\
             /// `P_periodic(x) = Σ_k {name}_PERIODIC16[k] · x^(16k)`.\n\
             pub const {name}_PERIODIC16: [u64; 32] = ["
        )
        .unwrap();
        for k in 0..32 {
            writeln!(out, "    {},", pc[k * 16]).unwrap();
        }
        out.push_str("];\n\n");

        writeln!(
            out,
            "/// Values the 32-periodic extension takes on trace rows 480..=511, where the\n\
             /// real column is zero-filled (`active_rows = depth*32 = 480`). Index `j` is row\n\
             /// `480 + j`. These are subtracted back out via the Lagrange correction.\n\
             pub const {name}_TAIL: [u64; 32] = ["
        )
        .unwrap();
        for j in 0..32 {
            writeln!(out, "    {},", w[480 + j]).unwrap();
        }
        out.push_str("];\n\n");
    }

    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/periodic_ext_consts.rs");
    std::fs::write(path, out).unwrap();
    println!("wrote {path}");
}

const HEADER: &str = r#"//! [A4] Periodic-extension constants for circuits 3 (merkle_path) and 6
//! (merkle_update).
//!
//! # Why these exist
//! Both AIRs gate every periodic column on `active_rows = depth * 32 = 480`, so
//! trace cycle 15 (rows 480..=511) is zero-filled. That single truncation
//! destroys 32-periodicity: the interpolants in `periodic_consts` are 512/512
//! dense with coefficient-index gcd 1, and a dense Horner (512 muls per column,
//! 7 columns per circuit) is the dominant cost of DEEP-ALI phase 2.
//!
//! The 32-periodic *extension* — the column continued through cycle 15 instead
//! of truncated — is stride-16 sparse (32 non-zero coefficients, gcd 16), and
//! the two differ on exactly the 32 rows 480..=511. So
//!
//! ```text
//! P_actual(z) = P_periodic(z) − Σ_{j=0}^{31} TAIL[j] · L_{480+j}(z)
//! L_r(z)      = g^r · (z^N − 1) / (N · (z − g^r)),  N = 512, g = GENERATOR_512
//! ```
//!
//! This is an algebraic identity on the *same* polynomial: no AIR change, no
//! trace change, no wire-format change, zero soundness cost.
//!
//! # Provenance
//! Generated from the dense `C3_*_COEFFS` / `C6_*_COEFFS` tables in
//! `periodic_consts.rs` by `tests/a4_probe.rs::a4_emit_consts` (run with
//! `--ignored`). Regenerate whenever those tables are rebaked.
//!
//! # Pinning
//! `tests/periodic_stride.rs` re-derives every value here from the dense tables
//! and checks the identity at random `z` against a dense Horner, in **release**
//! mode. A rebake of `periodic_consts.rs` that is not mirrored here fails that
//! test rather than silently changing the polynomial the verifier evaluates.

"#;

