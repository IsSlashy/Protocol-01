/// On-chain STARK verification for multiple circuits.
///
/// Verifies:
/// 1. OOD constraint consistency (field range)
/// 2. Merkle path validity for all query positions
/// 3. Transition constraint satisfaction at trace-aligned query positions
/// 4. Quotient polynomial verification at ALL query positions (C4)
/// 5. Boundary constraint verification (C6)
/// 6. Fiat-Shamir binding (query positions derived from public inputs)

use crate::compact_proof::*;
use crate::goldilocks::Felt;
use crate::merkle;
use crate::poseidon_consts;
use solana_sha256_hasher::hashv;

/// [B1] `PartialEq` so tests can assert the EXACT variant. Accepting "any error"
/// is how a test stays green against a verifier that rejects for the wrong
/// reason, or that has no binding at all (see `tests/b1_deep_binding.rs`).
/// Adding variants and derives changes nothing observable on chain: every call
/// site maps this with `.map_err(|_| StarkVerifierError::InvalidProof)`.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
#[allow(dead_code)]
pub enum VerifyError {
    OodConstraintFailed,
    OodBoundaryFailed,
    InvalidQueryPosition,
    MerkleProofFailed,
    TransitionConstraintFailed,
    QuotientCheckFailed,
    BoundaryConstraintFailed,
    InsufficientQueries,
    UnsupportedCircuit,
    /// [P1.1 PR 3] FRI fold inconsistency — f_{i+1}(y²) does not match
    /// `(f_i(y)+f_i(-y))/2 + α_i·(f_i(y)-f_i(-y))/(2y)`, or the final-fold
    /// evaluation disagrees with `final_poly`. Means the prover submitted
    /// layer values that are not an honest fold of the prior layer.
    FriFoldCheckFailed,
    /// [P1.1 PR 4 DEEP-ALI] Transition constraint evaluated at OOD point does
    /// not equal `ood_quotient · Z_D(z)`. The prover's Q(z) claim is
    /// inconsistent with the opened OOD trace evaluations and the AIR.
    DeepAliFailed,
    /// A domain-size lookup (`get_lde_generator` / `get_trace_generator`) was
    /// asked for a size with no precomputed root-of-unity constant.
    ///
    /// Before this variant existed both lookups fell through to `Felt::ONE`,
    /// i.e. a degenerate domain where every position maps to 1 — the whole LDE
    /// collapses to a single point and FRI/quotient checks become vacuous.
    /// That is not reachable from proof bytes today (`CircuitConfig` is a
    /// program constant, see `compact_proof::get_circuit_config`), but it made
    /// "add a circuit with a new domain size" a silently-unsound edit. Now it
    /// fails closed.
    UnsupportedDomainSize,
    /// Circuit 0 (`subscriber_ownership`) was handed to the GENERIC verifier.
    ///
    /// C0 has one verifier — the legacy `verify_subscriber_ownership` path — and
    /// the generic path cannot substitute for it:
    ///
    /// * `verify_deep_ali_generic` divides by the wrong vanishing polynomial for
    ///   C0. C0's constraint is divisible by `Z_T(x) = (x^n - 1)/(x - g^(n-1))`,
    ///   not by `Z_D(x) = x^n - 1`, because the wrap-around transition at row
    ///   `n-1` does not vanish. The legacy path knows this; the generic one does
    ///   not.
    /// * C0's committed quotient carries a folded boundary term
    ///   (`fold_boundary_quotient` with the `bnd-c0` tag). The generic path has no
    ///   matching recomputation for circuit 0, so the OOD identity cannot close.
    ///
    /// The generic path therefore REJECTS honest C0 proofs. Before this variant
    /// it rejected them as `DeepAliFailed` — indistinguishable from a forgery, and
    /// one refactor away from being "fixed" into a silent mis-verification. Four
    /// shipped instructions hard-require `circuit_id == 0`
    /// (`zk_shielded::{pause,resume,cancel_private_stark}` and
    /// `p01_quantum_wallet/src/stark.rs:42`), so the legacy path is load-bearing
    /// and stays. This error says so out loud instead.
    CircuitZeroIsLegacyOnly,
    /// [B1] The published FRI final polynomial has a non-zero coefficient at or
    /// above `CircuitConfig.fri_final_poly_degree_bound`.
    ///
    /// Without this check the terminal FRI test is VACUOUS: `fri_final_poly_size`
    /// is 16 on every circuit over a 16-point final domain, so the 16 published
    /// coefficients span the full interpolation space of the 16 folded
    /// evaluations and the terminal comparison at the end of `verify_fri_*` can
    /// always be satisfied. The MEASURED honest bound is 8 coefficients for
    /// C1..C6 and 7 for C0 (`emit_deep_degree_table` in stark/src/compact.rs), so
    /// half the space is illegal and each query becomes worth 1.000 bit.
    FriFinalPolyDegreeTooHigh,
    /// [B1] The LAST fold disagreed with the published final polynomial,
    /// specifically. Split out of `FriFoldCheckFailed` so the coordinated-forgery
    /// test can name WHICH mechanism rejected rather than accepting any error.
    FriTerminalCheckFailed,
    /// [B1] The DEEP denominator `(y - z)(y + z)...` vanished at a queried
    /// position, i.e. `z` or `z*g` landed in the LDE domain. LIVENESS, not
    /// soundness: `z` is deterministic from the two roots plus the public inputs,
    /// so this is a ~2^-50 accident and the honest prover asserts against it at
    /// proof time rather than emitting an unprovable proof.
    DeepDenominatorZero,
    /// [SEAM] `public_inputs.len()` does not equal the count the circuit's
    /// boundary assertions consume, or a length-carrying public input (C3/C6
    /// `depth`) is out of range.
    ///
    /// `get_boundary_assertions` used to DEFAULT every missing public input to
    /// `Felt::ZERO`, and for C3/C6 it went further: `depth` is a
    /// caller-supplied public input, and `depth == 0 || depth > 16` selected a
    /// SHORTER assertion list that dropped the root bindings entirely (C6:
    /// 4 assertions → 2, losing `old_root` and `new_root`; C3: 2 → 1, losing
    /// `root`). Phase 1 never pinned `depth` — only `verify_deep_ali_circuit_3`
    /// and `_6` do — so `verify_stark_proof_v2` would mark a C6 buffer
    /// `verified = true` with NO root binding at all whenever the caller passed
    /// `depth = 99`.
    ///
    /// The same defaulting made `verify_stark_proof` (the legacy single-`u64`
    /// entry point, which has no gate against circuits 1..=6) able to set
    /// `verified = true` on a generic buffer with 1 real public input and the
    /// rest silently asserted against zero.
    ///
    /// Fails closed now: the count is exact and `depth` must be in `1..=16`.
    PublicInputCountMismatch,
}

// ============================================================================
// LDE domain generator constants (precomputed)
// ============================================================================
// Generator g_N = 7^((p-1)/N) mod p where p = 2^64 - 2^32 + 1
// These are primitive N-th roots of unity in the Goldilocks field.

/// Goldilocks prime: p = 2^64 - 2^32 + 1
const GOLDILOCKS_PRIME: u64 = 0xFFFFFFFF00000001;

// Precomputed N-th roots of unity: g_N = 7^((p-1)/N) mod p
// Used for LDE domain element computation and boundary checks.
/// 32nd root of unity (trace domain for circuit 0).
/// [B1] Live: `verify_fri_legacy` uses it for `zg = z * g`.
const GENERATOR_32: u64 = 0x00003FFFFFFFC000;
#[allow(dead_code)]
/// 128th root of unity (trace domain for circuits 1,2)
const GENERATOR_128: u64 = 0xF80007FF08000001;
#[allow(dead_code)]
/// 256th root of unity (trace domain for circuit 4)
const GENERATOR_256: u64 = 0xBF79143CE60CA966;
/// 512th root of unity (LDE domain for circuit 0, trace for circuits 3,5)
const GENERATOR_512: u64 = 0x1905D02A5C411F4E;
/// 2048th root of unity (LDE domain for circuits 1,2)
/// [C5-N1024] Trace generator for 1024 rows.
///
/// DERIVED, not copied: `g_n = w^(2^32 / n)` where `w = 0x185629DCDA58878C` is
/// the standard Goldilocks 2^32-th root of unity. The derivation was validated
/// by reproducing ALL SEVEN generators already in this file — 32, 128, 256,
/// 512, 2048, 4096 and 8192 — exactly, before either new value was used.
const GENERATOR_1024: u64 = 0x9D8F2AD78BFED972;
const GENERATOR_2048: u64 = 0x0653B4801DA1C8CF;
/// 4096th root of unity (LDE domain for circuit 4)
const GENERATOR_4096: u64 = 0xF2C35199959DFCB6;
/// 8192nd root of unity (LDE domain for circuits 3,5)
const GENERATOR_8192: u64 = 0x1544EF2335D17997;
/// [C5-N1024] LDE generator for 16384 points. Same derivation as
/// `GENERATOR_1024`, and the relation the domain self-check asserts holds:
/// `GENERATOR_16384^16 == GENERATOR_1024`, verified before use.
const GENERATOR_16384: u64 = 0xE0EE099310BBA1E2;

/// [B7] The multiplicative shift `h` of the LDE evaluation coset.
///
/// PAIRED EDIT: `stark/src/compact.rs`'s `LDE_COSET_SHIFT_U64`. The prover
/// evaluates at `x = h * g^i`; every domain-point reconstruction on this side
/// must apply the same `h` or honest proofs stop verifying. The two literals
/// must stay equal and `coset_shift_matches_the_prover` pins that.
///
/// ONE global constant, deliberately NOT a per-size table like the generators
/// above. The safety condition is a single inequality, `h^N != 1` for the
/// largest LDE size, and it covers every shipping size and every FRI layer at
/// once — a table would only create a slot someone can fill with `1`, which is
/// the exact collapse `get_lde_generator` below was hardened against.
///
/// `#[allow(dead_code)]` until the domain-point sites actually consume it; the
/// constant lands first so the two crates can be checked against each other
/// before any proof bytes move.
pub const LDE_COSET_SHIFT: u64 = 7;
/// [B7] `h^(-1)`, precomputed. NOT `Felt::new(LDE_COSET_SHIFT_INV)`.
///
/// MEASURED, and this is why it is a constant: `inv()` is a Fermat
/// exponentiation, roughly a hundred multiplications. Calling it inside the
/// per-query, per-layer FRI loop cost ~500,000 CU and pushed ALL SEVEN circuits
/// over the 1,400,000 cap — `consumed 1399850 of 1399850, exceeded CUs meter`.
/// The value depends on neither the query nor the layer, so it has no business
/// being computed there, and since `h` is a compile-time constant it has no
/// business being computed at runtime at all.
///
/// 7 * 2635249152773512046 == 1 mod (2^64 - 2^32 + 1). Cross-checked against
/// the prover, which printed exactly this as its layer-0 `inv_shift` during the
/// B7 differential debugging — two paths that do not talk to each other.
/// `coset_shift_inverse_is_exact` pins it rather than trusting this comment.
pub const LDE_COSET_SHIFT_INV: u64 = 2635249152773512046;

/// Get the LDE domain generator for a given LDE size.
///
/// **Fails closed.** An unlisted size is a build-time error in this crate, not
/// something a proof can trigger — but returning `Felt::ONE` for it (as this
/// did before) would make the whole LDE domain collapse to `{1}`, so FRI folds
/// and quotient/vanishing evaluations would be checked against garbage while
/// still reporting success. Any new circuit must add its generator constant
/// here or it will be rejected outright.
/// `pub` so the B7 shift test can assert its size list against the sizes this
/// table actually ships, instead of restating them and rotting silently the day
/// a circuit is added.
pub fn get_lde_generator(lde_size: usize) -> Result<Felt, VerifyError> {
    match lde_size {
        512 => Ok(Felt::new(GENERATOR_512)),
        2048 => Ok(Felt::new(GENERATOR_2048)),
        4096 => Ok(Felt::new(GENERATOR_4096)),
        8192 => Ok(Felt::new(GENERATOR_8192)),
        16384 => Ok(Felt::new(GENERATOR_16384)),
        _ => Err(VerifyError::UnsupportedDomainSize),
    }
}

/// Get the trace domain generator for a given trace length.
///
/// Fails closed for the same reason as [`get_lde_generator`].
///
/// [B1] This had no live caller until B1; the DEEP-ALI routines inline their
/// per-circuit constant. `verify_fri_generic` now calls it for `zg = z * g`,
/// which is the row shift the two-point linearisation is built around.
fn get_trace_generator(trace_length: usize) -> Result<Felt, VerifyError> {
    match trace_length {
        32 => Ok(Felt::new(GENERATOR_32)),
        128 => Ok(Felt::new(GENERATOR_128)),
        256 => Ok(Felt::new(GENERATOR_256)),
        512 => Ok(Felt::new(GENERATOR_512)),
        1024 => Ok(Felt::new(GENERATOR_1024)),
        _ => Err(VerifyError::UnsupportedDomainSize),
    }
}

/// Compute the LDE domain element at a given position: `h * lde_gen^pos`.
///
/// [B7] The `h` is the coset shift. The prover evaluates at `h * g^i`, so this —
/// the ONE place on this side that turns a query position back into a field
/// element — has to apply the same factor or every honest proof is rejected.
///
/// It is `h`, NOT `h^(-1)`: this reconstructs the point, it does not divide by
/// it. The inverse belongs to the FRI fold and the coset interpolation, both of
/// which live prover-side. Getting that backwards is the failure that still
/// produces a proof — one that verifies against the wrong polynomial.
///
/// Downstream layers need no change: the fold squares the point, and
/// `(h * g^p)^2 = h^2 * g^(2p)` carries the shift along for free. The final-poly
/// check needs none either, because the prover's terminal interpolation stays on
/// the raw subgroup, so its coefficients are those of `f'(y) = f(h' * y)` and
/// evaluating them at `gen_final^j` yields exactly `f` at the true coset point.
fn get_lde_domain_element(pos: usize, config: &CircuitConfig) -> Result<Felt, VerifyError> {
    let g = get_lde_generator(config.lde_size)?;
    Ok(Felt::new(LDE_COSET_SHIFT).mul(g.exp(pos as u64)))
}

/// Compute the vanishing polynomial Z_D(x) = x^trace_length - 1
fn vanishing_poly(x: Felt, trace_length: usize) -> Felt {
    let x_n = x.exp(trace_length as u64);
    x_n.sub(Felt::ONE)
}

/// Regression tests for the domain-generator lookups.
///
/// These pin two things at once:
///  1. every size reachable today still returns the *exact* constant it
///     returned before the fail-closed change (this program is deployed and
///     verifies live C1/C3/C5/C6 proofs — any drift here invalidates them);
///  2. an unlisted size now errors instead of silently returning `Felt::ONE`.
#[cfg(test)]
mod domain_generator_tests {
    use super::*;
    use crate::compact_proof::{get_circuit_config, LDE_SIZE};

    /// Sizes reachable via `CircuitConfig.lde_size` for circuits 0..=6 plus the
    /// legacy circuit-0 path, mapped to the constant each must keep returning.
    const LISTED_LDE: [(usize, u64); 5] = [
        (512, GENERATOR_512),
        (2048, GENERATOR_2048),
        (4096, GENERATOR_4096),
        (8192, GENERATOR_8192),
        // [C5-N1024] C5's LDE doubled with its trace.
        (16384, GENERATOR_16384),
    ];

    const LISTED_TRACE: [(usize, u64); 5] = [
        (32, GENERATOR_32),
        (128, GENERATOR_128),
        (256, GENERATOR_256),
        (512, GENERATOR_512),
        // [C5-N1024] C5 is the only circuit at this length.
        (1024, GENERATOR_1024),
    ];

    #[test]
    fn lde_generator_listed_sizes_return_prior_constants() {
        for (size, expected) in LISTED_LDE {
            let g = get_lde_generator(size).expect("listed LDE size must resolve");
            assert_eq!(g.as_u64(), expected, "generator drift for LDE size {size}");
        }
    }

    #[test]
    fn trace_generator_listed_sizes_return_prior_constants() {
        for (size, expected) in LISTED_TRACE {
            let g = get_trace_generator(size).expect("listed trace size must resolve");
            assert_eq!(g.as_u64(), expected, "generator drift for trace length {size}");
        }
    }

    /// The behaviour guarantee that matters for the deployed program: every
    /// circuit config the on-chain dispatcher can select still resolves, and
    /// resolves to the same constant as before.
    #[test]
    fn every_live_circuit_config_resolves_its_lde_generator() {
        for circuit_id in 0u8..=6 {
            let config = get_circuit_config(circuit_id).expect("circuit id 0..=6 has a config");
            let g = get_lde_generator(config.lde_size)
                .unwrap_or_else(|e| panic!("circuit {circuit_id} lde_size {} rejected: {e:?}", config.lde_size));
            let expected = LISTED_LDE
                .iter()
                .find(|(s, _)| *s == config.lde_size)
                .map(|(_, v)| *v)
                .unwrap_or_else(|| panic!("circuit {circuit_id} uses unlisted lde_size {}", config.lde_size));
            assert_eq!(g.as_u64(), expected);
            assert_ne!(g.as_u64(), Felt::ONE.as_u64(), "a live generator must never be 1");
        }
        // Legacy circuit-0 path uses the bare constant, not a CircuitConfig.
        assert_eq!(LDE_SIZE, 512);
        assert_eq!(get_lde_generator(LDE_SIZE).unwrap().as_u64(), GENERATOR_512);
    }

    /// The footgun itself: previously each of these returned `Felt::ONE`.
    ///
    /// ⚠️ 16384 LEFT THIS LIST ON 2026-08-29 and is not a hole: it is C5's real
    /// LDE size since `n` went 512 -> 1024, so it is covered POSITIVELY by
    /// `domain_generators_match_config`, which walks every live `CircuitConfig`
    /// and requires the resolved generator to equal the listed constant. A size
    /// belongs here only while NO circuit uses it; the day one does, it moves to
    /// the positive test rather than being deleted from both.
    ///
    /// 1024 stays: it is a trace length, never an LDE size.
    #[test]
    fn lde_generator_rejects_unlisted_sizes() {
        for size in [0usize, 1, 2, 16, 32, 64, 128, 256, 1024, 65536, usize::MAX] {
            match get_lde_generator(size) {
                Err(VerifyError::UnsupportedDomainSize) => {}
                Err(other) => panic!("LDE size {size}: wrong error {other:?}"),
                Ok(g) => panic!("LDE size {size} silently resolved to {}", g.as_u64()),
            }
        }
    }

    /// ⚠️ 1024 LEFT THIS LIST ON 2026-08-29: it is C5's trace length since the
    /// mask forced `n` 512 -> 1024, and `domain_generators_match_config` covers
    /// it positively. Same rule as the LDE twin above.
    #[test]
    fn trace_generator_rejects_unlisted_sizes() {
        for size in [0usize, 1, 2, 16, 64, 100, 2048, 8192, usize::MAX] {
            match get_trace_generator(size) {
                Err(VerifyError::UnsupportedDomainSize) => {}
                Err(other) => panic!("trace length {size}: wrong error {other:?}"),
                Ok(g) => panic!("trace length {size} silently resolved to {}", g.as_u64()),
            }
        }
    }

    /// Same failure class, second lookup: an unknown circuit id used to yield an
    /// empty assertion list, which `verify_boundary_constraints` accepts as
    /// "nothing to check".

    // ========================================================================
    // [C7] DRIFT PINS -- the prover and the verifier must not diverge
    // ========================================================================
    //
    // C7's shape is six measured quantities that now exist in two crates: the
    // boundary table, the eighteen constraints, the thirteen periodic columns
    // and their classification, the row 382, and the two FRI constants. The
    // verifier crate dev-depends on `p01-stark`, so these tests DRIVE BOTH
    // SIDES from one source instead of restating either.
    //
    // That is the whole point. The C3/C6 depth window was maintained as two
    // independent restatements of one rule, and the prover went on building
    // proofs the deployed verifier had already stopped accepting -- silently,
    // for weeks, because nothing compared the two.

    /// Deterministic pseudo-random Goldilocks elements. Not security-relevant;
    /// reproducibility is what a drift pin needs.
    fn c7_stream(seed: u64, n: usize) -> Vec<u64> {
        const GOLDILOCKS: u64 = 0xFFFF_FFFF_0000_0001;
        let mut st = 0x9E37_79B9_7F4A_7C15u64 ^ seed.wrapping_mul(0x1000_0000_0000_0001);
        if st == 0 {
            st = 0xD1B5_4A32_D192_ED03;
        }
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            st ^= st >> 12;
            st ^= st << 25;
            st ^= st >> 27;
            out.push(st.wrapping_mul(0x2545_F491_4F6C_DD1D) % GOLDILOCKS);
        }
        out
    }

    /// [W16] The boundary arm mirrors the prover's table, IN ORDER.
    ///
    /// The index `j` IS the `alpha_bnd^j` exponent, so order is not cosmetic:
    /// two swapped lines produce a different polynomial and every honest proof
    /// fails with `DeepAliFailed` pointing nowhere.
    #[test]
    fn c7_boundary_arm_mirrors_the_prover_spec_in_order() {
        use p01_stark::air::spend::{
            CANONICAL_DEPTH, ROW_MERKLE_ROOT_OUT, SPEND_BOUNDARY_SPEC,
            SPEND_NUM_PUBLIC_INPUTS,
        };

        let pi: Vec<u64> = (1..=SPEND_NUM_PUBLIC_INPUTS as u64).map(|i| i * 1_000).collect();
        let got = get_boundary_assertions(7, &pi).expect("C7 arm must exist");

        assert_eq!(got.len(), SPEND_BOUNDARY_SPEC.len(), "assertion COUNT drifted");
        for (j, (col, row, source)) in SPEND_BOUNDARY_SPEC.iter().enumerate() {
            assert_eq!(got[j].col, *col, "col drift at alpha_bnd^{j}");
            assert_eq!(got[j].row, *row, "row drift at alpha_bnd^{j}");
            let want = match source {
                Some(i) => Felt::new(pi[*i]),
                None => Felt::ZERO,
            };
            assert_eq!(got[j].value, want, "value drift at alpha_bnd^{j}");
        }

        // The row that the CANONICAL_DEPTH name collision gets wrong. 12, not
        // 15; 382, not 478. 478 is inside the blinding region.
        assert_eq!(CANONICAL_DEPTH, 11, "C7 is depth 11 since 2026-08-30");
        assert_eq!(ROW_MERKLE_ROOT_OUT, 350, "(11-1)*32+30");
        assert_eq!(got[5].row, ROW_MERKLE_ROOT_OUT, "root row drifted");
        assert_ne!(got[5].value, Felt::ZERO, "the root was bound to ZERO");

        assert_eq!(expected_public_input_count(7), Ok(SPEND_NUM_PUBLIC_INPUTS));
    }

    /// [W17] The OOD evaluator agrees with the AIR on random frames.
    ///
    /// A differential test, not a restatement: it feeds the SAME random frame
    /// to `evaluate_spend_transition` (prover) and
    /// `evaluate_transition_at_ood_circuit_7` (verifier) and compares the
    /// RLC-combined result.
    ///
    /// 🚨 This is what catches the copy that would otherwise pass review:
    /// gating C7's Poseidon rows with `1 - is_boundary` instead of with
    /// `not_boundary_active`. The two agree everywhere except the blinding
    /// region -- so an honest proof would still verify, and only the privacy
    /// property would be gone. A random frame with a nonzero `is_boundary` and
    /// a zero `nba` separates them.
    ///
    /// ⚠️ "as C6 does" REMOVED 2026-08-29: C6 took the same depth-12 cut and now
    /// gates with its own `nba`. The unmasked circuits -- C2, C3, C4 and
    /// `denominated_pool` -- still use `1 - is_boundary`, correctly, because
    /// they have no blinding region for it to be wrong about. C3 is the one to
    /// watch: it is next in line for the cut, and on the day it takes one this
    /// sentence has to move again.
    #[test]
    fn c7_ood_evaluator_matches_the_air_on_random_frames() {
        use p01_stark::air::spend::{
            evaluate_spend_transition, SPEND_NUM_CONSTRAINTS, SPEND_NUM_PERIODIC,
            TRACE_WIDTH,
        };
        use p01_stark::{BaseElement, FieldElement, StarkField};

        assert_eq!(SPEND_NUM_CONSTRAINTS, 18);
        assert_eq!(SPEND_NUM_PERIODIC, 13);
        // [ZK-RANDOMIZER 2026-08-30] The COMMITTED width: the AIR constrains one
        // fewer, and the extra column is the randomizer. Both numbers matter.
        assert_eq!(TRACE_WIDTH, 11);

        // [ZK-RANDOMIZER 2026-08-30] The frame is 11 wide now. Slot 10 is fed
        // NON-ZERO random values on purpose: the whole property under test is
        // that neither side reads it, and a zero there would let a reader that
        // DOES touch it pass by accident.
        const W: usize = 11;
        for seed in 0..64u64 {
            let raw = c7_stream(seed, W + W + 13 + 1);
            let cur_air: Vec<BaseElement> =
                raw[0..W].iter().map(|&v| BaseElement::new(v)).collect();
            let nxt_air: Vec<BaseElement> =
                raw[W..2 * W].iter().map(|&v| BaseElement::new(v)).collect();
            let per_air: Vec<BaseElement> =
                raw[2 * W..2 * W + 13].iter().map(|&v| BaseElement::new(v)).collect();
            let alpha_air = BaseElement::new(raw[2 * W + 13]);

            let mut air_out = vec![BaseElement::ZERO; SPEND_NUM_CONSTRAINTS];
            evaluate_spend_transition(&cur_air, &nxt_air, &per_air, &mut air_out);
            let mut want = BaseElement::ZERO;
            let mut p = BaseElement::ONE;
            for v in air_out.iter() {
                want += p * *v;
                p *= alpha_air;
            }

            let mut cur_v = [Felt::ZERO; W];
            let mut nxt_v = [Felt::ZERO; W];
            let mut per_v = [Felt::ZERO; 13];
            for i in 0..W {
                cur_v[i] = Felt::new(raw[i]);
                nxt_v[i] = Felt::new(raw[W + i]);
            }
            for i in 0..13 {
                per_v[i] = Felt::new(raw[2 * W + i]);
            }
            let got = evaluate_transition_at_ood_circuit_7(
                &cur_v, &nxt_v, &per_v, Felt::new(raw[2 * W + 13]),
            );

            assert_eq!(
                got.as_u64(),
                want.as_int(),
                "C7 transition drift at seed {seed}: the verifier and the AIR disagree",
            );
        }
    }

    /// [W18a] `compute_c7_periodic_at_z` agrees with the prover's columns.
    ///
    /// Also pins the API contract the AIR states: columns 0-6 come back at
    /// their NATURAL length 32 and 7-12 at 512. A length-32 emission and a
    /// hand-tiled 512 one are byte-identical downstream, so the short form is
    /// free safety -- but only while the verifier's evaluator expects it.
    #[test]
    fn c7_periodic_at_z_matches_the_prover_columns() {
        use p01_stark::air::spend::build_spend_periodic_columns;
        use p01_stark::{BaseElement, FieldElement, StarkField};

        let cols = build_spend_periodic_columns();
        assert_eq!(cols.len(), 13, "thirteen periodic columns");
        for (i, col) in cols.iter().enumerate() {
            let want = if i < 7 { 32 } else { 512 };
            assert_eq!(col.len(), want, "periodic column {i} changed length");
        }

        // Materialise every column onto 512 points so one polynomial suffices,
        // exactly as `compute_quotient_lde_circuit_7` does.
        let full: Vec<Vec<BaseElement>> = cols
            .iter()
            .map(|col| (0..512).map(|i| col[i % col.len()]).collect())
            .collect();

        for z_seed in 0..8u64 {
            let z_u = c7_stream(0xC7 ^ z_seed, 1)[0];
            let z = Felt::new(z_u);
            let z_air = BaseElement::new(z_u);

            let got = match compute_c7_periodic_at_z(z) {
                Ok(v) => v,
                // z landed on one of the four one-hot rows: fails closed, and
                // that IS the contract. Skip rather than assert on it.
                Err(_) => continue,
            };

            for i in 0..13 {
                let poly = p01_stark::compact::inverse_ntt_probe(
                    &full[i],
                    p01_stark::compact::domain_generator_probe(512),
                );
                let want = p01_stark::compact::evaluate_poly_probe(&poly, z_air);
                assert_eq!(
                    got[i].as_u64(),
                    want.as_int(),
                    "periodic slot {i} disagrees with the prover at z_seed {z_seed}",
                );
            }
        }
    }

    /// [C3-D12] The nine values the verifier evaluates at `z` are the nine
    /// columns the prover committed to.
    ///
    /// The differential below proves both sides COMBINE their inputs the same
    /// way; it says nothing about whether they are handed the same inputs. A
    /// rebaked table, a column in the wrong slot, or a compressed evaluator
    /// pointed at a dense column all pass it. This is the other half.
    ///
    /// ✅ IT ALSO MEASURES THE SHARING. C3, C6 and C7 now have identical
    /// geometry -- 512 rows, 384 constrained, 128 free -- so all three evaluate
    /// ONE set of tables and C3's depth cut added zero rodata. That is asserted
    /// here by evaluating C3's prover columns against the tables the verifier
    /// actually reads, which are C3's stride tables and C7's two dense gates.
    #[test]
    fn c3_periodic_at_z_matches_the_prover_columns() {
        use p01_stark::air::merkle_path::{
            build_merkle_path_periodic_columns, CANONICAL_DEPTH, TRACE_LENGTH,
        };
        use p01_stark::{BaseElement, StarkField};
        use crate::periodic_consts::{C7_ACTIVE_COEFFS, C7_NOT_BOUNDARY_ACTIVE_COEFFS};
        use crate::periodic_ext_consts::{
            C3_HASH_START_PERIODIC16, C3_IS_BOUNDARY_PERIODIC16, C3_IS_INTERIOR_PERIODIC16,
            C3_RC0_PERIODIC16, C3_RC1_PERIODIC16, C3_RC2_PERIODIC16,
            C3_ROUND_ACTIVE_PERIODIC16,
        };

        let cols = build_merkle_path_periodic_columns(CANONICAL_DEPTH, TRACE_LENGTH);
        assert_eq!(cols.len(), 9, "nine periodic columns");
        for (i, col) in cols.iter().enumerate() {
            assert_eq!(
                col.len(), TRACE_LENGTH,
                "C3 periodic column {i} changed length; C3 emits all nine pre-tiled",
            );
        }

        for z_seed in 0..8u64 {
            let z_u = c7_stream(0xC3_D12 ^ z_seed, 1)[0];
            let z = Felt::new(z_u);
            let z_air = BaseElement::new(z_u);
            let y16 = z.exp(16);

            // Exactly what `verify_deep_ali_circuit_3` builds.
            let got: [Felt; 9] = [
                eval_periodic_compressed32_at_z(&C3_RC0_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C3_RC1_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C3_RC2_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C3_ROUND_ACTIVE_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C3_HASH_START_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C3_IS_BOUNDARY_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C3_IS_INTERIOR_PERIODIC16, y16),
                eval_periodic_at_z(&C7_ACTIVE_COEFFS, z),
                eval_periodic_at_z(&C7_NOT_BOUNDARY_ACTIVE_COEFFS, z),
            ];

            for i in 0..9 {
                let poly = p01_stark::compact::inverse_ntt_probe(
                    &cols[i],
                    p01_stark::compact::domain_generator_probe(TRACE_LENGTH),
                );
                let want = p01_stark::compact::evaluate_poly_probe(&poly, z_air);
                assert_eq!(
                    got[i].as_u64(),
                    want.as_int(),
                    "C3 periodic slot {i} disagrees with the prover at z_seed {z_seed}",
                );
            }
        }
    }

    /// [C3-D12] The C3 OOD evaluator agrees with the C3 AIR on random frames.
    ///
    /// The third of these differentials, and the reason there is one per masked
    /// circuit rather than one shared: each AIR has its own constraint list and
    /// its own gating, so a shared test would only prove the shared parts.
    ///
    /// 🚨 WHAT IT CATCHES IS A SUBSTITUTION THAT REJECTS NOTHING. Gating C3's
    /// Poseidon rows with `1 - is_boundary` instead of `nba` leaves every honest
    /// proof verifying and every other test green, while re-imposing the rounds
    /// across rows 384..511. The 128 masked rows become 128 constrained ones and
    /// `air_aware_recovery_c3.rs` reads the authentication path and the leaf
    /// index back out of the published bytes. A random frame with a nonzero
    /// `is_boundary` and a zero `nba` separates the two gates; no honest-proof
    /// test can.
    #[test]
    fn c3_ood_evaluator_matches_the_air_on_random_frames() {
        use p01_stark::air::merkle_path::{
            evaluate_merkle_path_transition, MERKLE_PATH_NUM_CONSTRAINTS,
            MERKLE_PATH_NUM_PERIODIC, TRACE_WIDTH,
        };
        use p01_stark::{BaseElement, FieldElement, StarkField};

        assert_eq!(MERKLE_PATH_NUM_CONSTRAINTS, 11);
        assert_eq!(MERKLE_PATH_NUM_PERIODIC, 9, "seven columns plus the two gates");
        // [ZK-RANDOMIZER 2026-08-30] The COMMITTED width: the AIR constrains one
        // fewer, and the extra column is the randomizer. Both numbers matter.
        assert_eq!(TRACE_WIDTH, 7);

        let w = TRACE_WIDTH;
        let np = MERKLE_PATH_NUM_PERIODIC;
        for seed in 0..64u64 {
            let raw = c7_stream(0xC3_0000 ^ seed, w + w + np + 1);
            let cur_air: Vec<BaseElement> =
                raw[0..w].iter().map(|&v| BaseElement::new(v)).collect();
            let nxt_air: Vec<BaseElement> =
                raw[w..2 * w].iter().map(|&v| BaseElement::new(v)).collect();
            let per_air: Vec<BaseElement> = raw[2 * w..2 * w + np]
                .iter()
                .map(|&v| BaseElement::new(v))
                .collect();
            let alpha_air = BaseElement::new(raw[2 * w + np]);

            let mut air_out = vec![BaseElement::ZERO; MERKLE_PATH_NUM_CONSTRAINTS];
            evaluate_merkle_path_transition(&cur_air, &nxt_air, &per_air, &mut air_out);
            let mut want = BaseElement::ZERO;
            let mut pw = BaseElement::ONE;
            for v in air_out.iter() {
                want += pw * *v;
                pw *= alpha_air;
            }

            // [ZK-RANDOMIZER] 6 -> 7. The frame carries the randomizer column and
            // it is fed NON-ZERO random values on purpose: the property under
            // test is that neither side reads it.
            let mut cur_v = [Felt::ZERO; 7];
            let mut nxt_v = [Felt::ZERO; 7];
            let mut per_v = [Felt::ZERO; 9];
            for i in 0..w {
                cur_v[i] = Felt::new(raw[i]);
                nxt_v[i] = Felt::new(raw[w + i]);
            }
            for i in 0..np {
                per_v[i] = Felt::new(raw[2 * w + i]);
            }
            let got = evaluate_transition_at_ood_circuit_3(
                &cur_v, &nxt_v, &per_v, Felt::new(raw[2 * w + np]),
            );

            assert_eq!(
                got.as_u64(),
                want.as_int(),
                "C3 transition drift at seed {seed}: the verifier and the AIR disagree",
            );
        }
    }

    /// [C6-D12] The C6 OOD evaluator agrees with the C6 AIR on random frames.
    ///
    /// The twin of `c7_ood_evaluator_matches_the_air_on_random_frames`, and C6
    /// needs it more than C7 did. C6 is the circuit `verify.rs:4713` names as
    /// "THE ONE PLACE C6 MUST NOT BE COPIED" -- it used to gate its Poseidon
    /// rows with `1 - is_boundary`, and the depth cut required moving it to
    /// `not_boundary_active`.
    ///
    /// 🚨 THOSE TWO GATES AGREE EVERYWHERE EXCEPT THE BLINDING REGION. Leave the
    /// old one in and every honest proof still verifies, every existing test
    /// still passes, and the 128 masked rows are constrained again -- which is
    /// to say the mask does nothing and `air_aware_recovery_c6.rs` solves four
    /// of the ten columns from the published bytes. There is no honest-proof
    /// test that can catch that. A random frame with a nonzero `is_boundary` and
    /// a zero `nba` separates them, and this is that frame, sixty-four times.
    #[test]
    fn c6_ood_evaluator_matches_the_air_on_random_frames() {
        use p01_stark::air::merkle_update::{
            evaluate_merkle_update_transition, MERKLE_UPDATE_NUM_CONSTRAINTS,
            MERKLE_UPDATE_NUM_PERIODIC, TRACE_WIDTH,
        };
        use p01_stark::{BaseElement, FieldElement, StarkField};

        assert_eq!(MERKLE_UPDATE_NUM_CONSTRAINTS, 19);
        assert_eq!(MERKLE_UPDATE_NUM_PERIODIC, 9, "seven columns plus the two gates");
        // [ZK-RANDOMIZER 2026-08-30] The COMMITTED width: the AIR constrains one
        // fewer, and the extra column is the randomizer. Both numbers matter.
        assert_eq!(TRACE_WIDTH, 11);

        let w = TRACE_WIDTH;
        let np = MERKLE_UPDATE_NUM_PERIODIC;
        for seed in 0..64u64 {
            let raw = c7_stream(0xC6_0000 ^ seed, w + w + np + 1);
            let cur_air: Vec<BaseElement> =
                raw[0..w].iter().map(|&v| BaseElement::new(v)).collect();
            let nxt_air: Vec<BaseElement> =
                raw[w..2 * w].iter().map(|&v| BaseElement::new(v)).collect();
            let per_air: Vec<BaseElement> = raw[2 * w..2 * w + np]
                .iter()
                .map(|&v| BaseElement::new(v))
                .collect();
            let alpha_air = BaseElement::new(raw[2 * w + np]);

            let mut air_out = vec![BaseElement::ZERO; MERKLE_UPDATE_NUM_CONSTRAINTS];
            evaluate_merkle_update_transition(&cur_air, &nxt_air, &per_air, &mut air_out);
            let mut want = BaseElement::ZERO;
            let mut pw = BaseElement::ONE;
            for v in air_out.iter() {
                want += pw * *v;
                pw *= alpha_air;
            }

            let cur_v: Vec<Felt> = raw[0..w].iter().map(|&v| Felt::new(v)).collect();
            let nxt_v: Vec<Felt> = raw[w..2 * w].iter().map(|&v| Felt::new(v)).collect();
            let mut per_v = [Felt::ZERO; 9];
            for i in 0..np {
                per_v[i] = Felt::new(raw[2 * w + i]);
            }
            let got = evaluate_transition_at_ood_circuit_6(
                &cur_v, &nxt_v, &per_v, Felt::new(raw[2 * w + np]),
            );

            assert_eq!(
                got.as_u64(),
                want.as_int(),
                "C6 transition drift at seed {seed}: the verifier and the AIR disagree",
            );
        }
    }

    /// [C5-N1024] The C5 OOD evaluator agrees with the C5 AIR on random frames.
    ///
    /// 🚨 THIS TEST EXISTS BECAUSE ITS ABSENCE COST A DAY. C5 was masked on
    /// 2026-08-29 with the C3/C6/C7 differentials already in the file and no C5
    /// twin. `transfer.rs::evaluate_transfer_transition` moved `result[0..3]` to
    /// `nba`; `evaluate_transition_at_ood_circuit_5` kept `1 - is_boundary`, and
    /// the only symptom was `transfer_verify_deep_ali_accepts_honest_proof`
    /// failing with a blanket `DeepAliFailed` that named neither the constraint
    /// nor the gate. Every other C5 test stayed green, `verify_generic` still
    /// accepted the proof, and the wire was byte-identical.
    ///
    /// ⚠️ AND THE OPPOSITE SLIP IS THE SILENT ONE. Here the wrong gate happened
    /// to break acceptance, which is luck: `nba` and `1 - is_boundary` differ
    /// only across rows 448..1023, so on any circuit where the prover kept the
    /// old gate too, the substitution rejects NOTHING and simply re-imposes the
    /// Poseidon rounds on all 576 blinding rows. A random frame with a nonzero
    /// `is_boundary` and a zero `nba` separates the two; no honest-proof test
    /// can, in either direction.
    #[test]
    fn c5_ood_evaluator_matches_the_air_on_random_frames() {
        use p01_stark::air::transfer::{
            evaluate_transfer_transition, TRACE_WIDTH, TRANSFER_NUM_CONSTRAINTS,
            TRANSFER_NUM_PERIODIC,
        };
        use p01_stark::{BaseElement, FieldElement, StarkField};

        assert_eq!(TRANSFER_NUM_CONSTRAINTS, 28);
        assert_eq!(TRANSFER_NUM_PERIODIC, 30, "28 columns plus the two gates");
        assert_eq!(TRACE_WIDTH, 7);

        let w = TRACE_WIDTH;
        let np = TRANSFER_NUM_PERIODIC;
        for seed in 0..64u64 {
            let raw = c7_stream(0xC5_0000 ^ seed, w + w + np + 1);
            let cur_air: Vec<BaseElement> =
                raw[0..w].iter().map(|&v| BaseElement::new(v)).collect();
            let nxt_air: Vec<BaseElement> =
                raw[w..2 * w].iter().map(|&v| BaseElement::new(v)).collect();
            let per_air: Vec<BaseElement> = raw[2 * w..2 * w + np]
                .iter()
                .map(|&v| BaseElement::new(v))
                .collect();
            let alpha_air = BaseElement::new(raw[2 * w + np]);

            let mut air_out = vec![BaseElement::ZERO; TRANSFER_NUM_CONSTRAINTS];
            evaluate_transfer_transition(&cur_air, &nxt_air, &per_air, &mut air_out);
            let mut want = BaseElement::ZERO;
            let mut pw = BaseElement::ONE;
            for v in air_out.iter() {
                want += pw * *v;
                pw *= alpha_air;
            }

            let mut cur_v = [Felt::ZERO; 7];
            let mut nxt_v = [Felt::ZERO; 7];
            let mut per_v = [Felt::ZERO; 30];
            for i in 0..w {
                cur_v[i] = Felt::new(raw[i]);
                nxt_v[i] = Felt::new(raw[w + i]);
            }
            for i in 0..np {
                per_v[i] = Felt::new(raw[2 * w + i]);
            }
            let got = evaluate_transition_at_ood_circuit_5(
                &cur_v, &nxt_v, &per_v, Felt::new(raw[2 * w + np]),
            );

            assert_eq!(
                got.as_u64(),
                want.as_int(),
                "C5 transition drift at seed {seed}: the verifier and the AIR disagree",
            );
        }
    }

    /// [C1-N256] The C1 OOD evaluator agrees with the C1 AIR on random frames.
    ///
    /// The fifth and last of these, closing the set over every live circuit.
    /// C1 was the other circuit masked without a differential, and it is the odd
    /// one: it gained ONE periodic column, not two, because its only gated
    /// constraints are the Poseidon rows and those already spent both permitted
    /// factors on `not_boundary` and `round_flag` — so the substitution is
    /// pre-multiplied rather than added. That is a subtler edit than C3/C6/C7's
    /// and there was nothing pinning it.
    #[test]
    fn c1_ood_evaluator_matches_the_air_on_random_frames() {
        use p01_stark::air::denominated_pool::{
            evaluate_pool_commitment_transition, POOL_COMMITMENT_NUM_CONSTRAINTS,
            POOL_COMMITMENT_NUM_PERIODIC, TRACE_WIDTH,
        };
        use p01_stark::{BaseElement, FieldElement, StarkField};

        assert_eq!(POOL_COMMITMENT_NUM_CONSTRAINTS, 4);
        assert_eq!(POOL_COMMITMENT_NUM_PERIODIC, 7, "six columns plus the one gate");
        // [ZK-RANDOMIZER 2026-08-30] The COMMITTED width: the AIR constrains one
        // fewer, and the extra column is the randomizer. Both numbers matter.
        assert_eq!(TRACE_WIDTH, 4);

        let w = TRACE_WIDTH;
        let np = POOL_COMMITMENT_NUM_PERIODIC;
        for seed in 0..64u64 {
            let raw = c7_stream(0xC1_0000 ^ seed, w + w + np + 1);
            let cur_air: Vec<BaseElement> =
                raw[0..w].iter().map(|&v| BaseElement::new(v)).collect();
            let nxt_air: Vec<BaseElement> =
                raw[w..2 * w].iter().map(|&v| BaseElement::new(v)).collect();
            let per_air: Vec<BaseElement> = raw[2 * w..2 * w + np]
                .iter()
                .map(|&v| BaseElement::new(v))
                .collect();
            let alpha_air = BaseElement::new(raw[2 * w + np]);

            let mut air_out = vec![BaseElement::ZERO; POOL_COMMITMENT_NUM_CONSTRAINTS];
            evaluate_pool_commitment_transition(&cur_air, &nxt_air, &per_air, &mut air_out);
            let mut want = BaseElement::ZERO;
            let mut pw = BaseElement::ONE;
            for v in air_out.iter() {
                want += pw * *v;
                pw *= alpha_air;
            }

            // [ZK-RANDOMIZER] 3 -> 4, same reason as the C3 twin above.
            let mut cur_v = [Felt::ZERO; 4];
            let mut nxt_v = [Felt::ZERO; 4];
            let mut per_v = [Felt::ZERO; 7];
            for i in 0..w {
                cur_v[i] = Felt::new(raw[i]);
                nxt_v[i] = Felt::new(raw[w + i]);
            }
            for i in 0..np {
                per_v[i] = Felt::new(raw[2 * w + i]);
            }
            let got = evaluate_transition_at_ood_circuit_1(
                &cur_v, &nxt_v, &per_v, Felt::new(raw[2 * w + np]),
            );

            assert_eq!(
                got.as_u64(),
                want.as_int(),
                "C1 transition drift at seed {seed}: the verifier and the AIR disagree",
            );
        }
    }

    /// [C6-D12] The nine values the verifier evaluates at `z` are the nine
    /// columns the prover committed to.
    ///
    /// The evaluator test above proves the two sides combine their inputs the
    /// same way. It says nothing about whether they are being handed the same
    /// inputs -- a rebaked table, a column emitted in the wrong slot, or a
    /// stride-16 evaluator pointed at a dense column would all pass it. This is
    /// the other half.
    ///
    /// ⚠️ ALL NINE COME BACK AT FULL TRACE LENGTH, WHICH IS NOT WHAT C7 DOES.
    /// C7 emits its seven stride columns at their natural period 32 and lets the
    /// caller tile them; C6 tiles them itself. Both are correct and they are
    /// byte-identical downstream -- but the verifier's compressed evaluator
    /// reads a 32-entry table either way, so what actually has to hold is that
    /// the first seven are stride-16 IN COEFFICIENT SPACE. That is asserted
    /// per-coefficient in `circuit_6_periodic_coeffs_match_verifier_constants_depth12`;
    /// what is pinned here is the emission length, so the difference from C7
    /// stays deliberate rather than becoming a surprise.
    #[test]
    fn c6_periodic_at_z_matches_the_prover_columns() {
        use p01_stark::air::merkle_update::{
            build_merkle_update_periodic_columns, CANONICAL_DEPTH, CANONICAL_TRACE_LENGTH,
        };
        use p01_stark::{BaseElement, StarkField};
        use crate::periodic_consts::{C7_ACTIVE_COEFFS, C7_NOT_BOUNDARY_ACTIVE_COEFFS};
        use crate::periodic_ext_consts::{
            C6_HASH_START_PERIODIC16, C6_IS_BOUNDARY_PERIODIC16, C6_IS_INTERIOR_PERIODIC16,
            C6_RC0_PERIODIC16, C6_RC1_PERIODIC16, C6_RC2_PERIODIC16,
            C6_ROUND_ACTIVE_PERIODIC16,
        };

        let cols = build_merkle_update_periodic_columns(CANONICAL_DEPTH, CANONICAL_TRACE_LENGTH);
        assert_eq!(cols.len(), 9, "nine periodic columns");
        for (i, col) in cols.iter().enumerate() {
            assert_eq!(
                col.len(),
                CANONICAL_TRACE_LENGTH,
                "C6 periodic column {i} changed length; C6 emits all nine pre-tiled",
            );
        }

        let full: Vec<Vec<BaseElement>> = cols
            .iter()
            .map(|col| (0..CANONICAL_TRACE_LENGTH).map(|i| col[i % col.len()]).collect())
            .collect();

        for z_seed in 0..8u64 {
            let z_u = c7_stream(0xC6_D12 ^ z_seed, 1)[0];
            let z = Felt::new(z_u);
            let z_air = BaseElement::new(z_u);
            let y16 = z.exp(16);

            // Exactly what `verify_deep_ali_circuit_6` builds.
            let got: [Felt; 9] = [
                eval_periodic_compressed32_at_z(&C6_RC0_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C6_RC1_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C6_RC2_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C6_ROUND_ACTIVE_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C6_HASH_START_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C6_IS_BOUNDARY_PERIODIC16, y16),
                eval_periodic_compressed32_at_z(&C6_IS_INTERIOR_PERIODIC16, y16),
                eval_periodic_at_z(&C7_ACTIVE_COEFFS, z),
                eval_periodic_at_z(&C7_NOT_BOUNDARY_ACTIVE_COEFFS, z),
            ];

            for i in 0..9 {
                let poly = p01_stark::compact::inverse_ntt_probe(
                    &full[i],
                    p01_stark::compact::domain_generator_probe(CANONICAL_TRACE_LENGTH),
                );
                let want = p01_stark::compact::evaluate_poly_probe(&poly, z_air);
                assert_eq!(
                    got[i].as_u64(),
                    want.as_int(),
                    "C6 periodic slot {i} disagrees with the prover at z_seed {z_seed}",
                );
            }
        }
    }

    /// [C6-D12] C6 and C7 share ONE pair of dense row-gate tables, and this is
    /// what makes that sharing a signal instead of a coincidence.
    ///
    /// Both gates are functions of `FIRST_FREE_ROW` and `HASH_CYCLE_LEN` alone.
    /// Depth-12 C6 and C7 have identical geometry -- 512 rows, 384 constrained,
    /// 128 free -- so the tables are bit-identical and C6 evaluates C7's,
    /// costing zero added rodata.
    ///
    /// ⛔ THE DAY THAT STOPS BEING TRUE, C6 SILENTLY EVALUATES C7's GEOMETRY.
    /// Move either circuit's `FIRST_FREE_ROW` and the sharing becomes wrong
    /// without becoming a compile error: C6 would gate its constraints off at
    /// C7's boundary rather than its own, and the rows between the two
    /// boundaries would be either unconstrained (a soundness hole) or
    /// constrained-but-masked (an honest proof that no longer verifies). This
    /// test is the tripwire; the fix is to emit C6's own pair, not to relax it.
    #[test]
    fn c6_and_c7_row_gates_are_the_same_two_columns() {
        use p01_stark::air::merkle_path as c3;
        use p01_stark::air::merkle_update as c6;
        use p01_stark::air::spend as c7;

        // [C3-D12] C3 joined the sharing later the same day. It has no tables of
        // its own at all — it evaluates C3's stride set plus C7's two dense
        // gates — so the only thing standing between it and the wrong geometry
        // is this equality.
        assert_eq!(
            c3::FIRST_FREE_ROW, c7::FIRST_FREE_ROW,
            "C3 and C7 stopped agreeing on where the blinding region starts, and C3              evaluates C7's gate tables",
        );
        assert_eq!(c3::TRACE_LENGTH, 512);
        // [ZK-DEPTH-11 2026-08-30] 128 -> 160. The cut bought exactly these 32
        // rows, and channel A on C3 was SHORT by 132 without them.
        assert_eq!(c3::MASK_ROWS, 160, "160 free rows against R = 4*22 + 2 = 90");
        use crate::periodic_consts::{
            C6_ACTIVE_COEFFS, C6_NOT_BOUNDARY_ACTIVE_COEFFS, C7_ACTIVE_COEFFS,
            C7_NOT_BOUNDARY_ACTIVE_COEFFS,
        };

        assert_eq!(
            c6::FIRST_FREE_ROW, c7::FIRST_FREE_ROW,
            "the two circuits stopped agreeing on where the blinding region starts",
        );
        assert_eq!(c6::CANONICAL_TRACE_LENGTH, 512);
        assert_eq!(c6::MASK_ROWS, 160, "160 free rows against R = 4*22 + 2 = 90");

        assert_eq!(
            C6_ACTIVE_COEFFS, C7_ACTIVE_COEFFS,
            "C6 and C7 `active` diverged — C6 must stop borrowing C7's table",
        );
        assert_eq!(
            C6_NOT_BOUNDARY_ACTIVE_COEFFS, C7_NOT_BOUNDARY_ACTIVE_COEFFS,
            "C6 and C7 `not_boundary_active` diverged — C6 must emit its own",
        );
    }

    /// [W18b] C7's seven compressed tables ARE the extension tables C3 and C6
    /// already ship. MEASURED 2026-08-24, all 32 values, all seven.
    ///
    /// They are emitted separately rather than aliased, so C7 does not silently
    /// move when C3 is rebaked -- and this test is what turns that independence
    /// into a signal instead of a coincidence.
    #[test]
    fn c7_stride_tables_equal_the_c3_and_c6_periodic_extensions() {
        use crate::periodic_consts::{
            C7_HASH_START_COEFFS, C7_IS_BOUNDARY_COEFFS, C7_IS_INTERIOR_COEFFS,
            C7_RC0_COEFFS, C7_RC1_COEFFS, C7_RC2_COEFFS, C7_ROUND_FLAG_COEFFS,
        };
        use crate::periodic_ext_consts::{
            C3_HASH_START_PERIODIC16, C3_IS_BOUNDARY_PERIODIC16,
            C3_IS_INTERIOR_PERIODIC16, C3_RC0_PERIODIC16, C3_RC1_PERIODIC16,
            C3_RC2_PERIODIC16, C3_ROUND_ACTIVE_PERIODIC16, C6_HASH_START_PERIODIC16,
            C6_IS_BOUNDARY_PERIODIC16, C6_IS_INTERIOR_PERIODIC16, C6_RC0_PERIODIC16,
            C6_RC1_PERIODIC16, C6_RC2_PERIODIC16, C6_ROUND_ACTIVE_PERIODIC16,
        };

        let pairs: [(&str, &[u64; 32], &[u64; 32], &[u64; 32]); 7] = [
            ("rc0", &C7_RC0_COEFFS, &C3_RC0_PERIODIC16, &C6_RC0_PERIODIC16),
            ("rc1", &C7_RC1_COEFFS, &C3_RC1_PERIODIC16, &C6_RC1_PERIODIC16),
            ("rc2", &C7_RC2_COEFFS, &C3_RC2_PERIODIC16, &C6_RC2_PERIODIC16),
            ("round_flag", &C7_ROUND_FLAG_COEFFS, &C3_ROUND_ACTIVE_PERIODIC16, &C6_ROUND_ACTIVE_PERIODIC16),
            ("is_boundary", &C7_IS_BOUNDARY_COEFFS, &C3_IS_BOUNDARY_PERIODIC16, &C6_IS_BOUNDARY_PERIODIC16),
            ("hash_start", &C7_HASH_START_COEFFS, &C3_HASH_START_PERIODIC16, &C6_HASH_START_PERIODIC16),
            ("is_interior", &C7_IS_INTERIOR_COEFFS, &C3_IS_INTERIOR_PERIODIC16, &C6_IS_INTERIOR_PERIODIC16),
        ];
        for (name, c7, c3, c6) in pairs.iter() {
            assert_eq!(c7, c3, "C7 {name} diverged from C3's periodic extension");
            assert_eq!(c3, c6, "C3 and C6 {name} diverged from each other");
        }
    }

    #[test]
    fn boundary_assertions_reject_unknown_circuit() {
        // [C7 2026-08-24] 7 dropped: it is a real circuit now. 8, 100 and 255
        // must still answer UnsupportedCircuit, and the assertions below are
        // unchanged -- this list is the tripwire, not the assertion.
        for circuit_id in [8u8, 100, 255] {
            match get_boundary_assertions(circuit_id, &[1, 2, 3, 4, 5, 15]) {
                Err(VerifyError::UnsupportedCircuit) => {}
                Err(other) => panic!("circuit {circuit_id}: wrong error {other:?}"),
                Ok(a) => panic!("circuit {circuit_id} silently produced {} assertions", a.len()),
            }
        }
    }

    /// Assertion counts for the live circuits are unchanged, and none of them is
    /// empty — so the `assertions.is_empty()` early-out in
    /// `verify_boundary_constraints` was only ever reachable through the old
    /// `_ => Vec::new()` arm.
    #[test]
    fn boundary_assertions_listed_circuits_unchanged() {
        // (circuit_id, public_inputs, expected assertion count)
        let cases: [(u8, &[u64], usize); 7] = [
            (0, &[42], 3),
            (1, &[1, 2], 6),
            (2, &[1, 2], 7),
            (3, &[1, 2, 15], 2),
            (4, &[1, 2, 3, 4], 12),
            // [C5-N1024 2026-08-29] 26 -> 24. The capacity assertions for cycles
            // 14 and 15 (rows 448, 480) left the list: those two cycles were
            // padding on a public constant, and their rows are now inside the
            // blinding region. See `get_boundary_assertions`, arm 5.
            (5, &[1, 2, 3, 4, 5, 6], 24),
            (6, &[1, 2, 3, 4, 15], 4),
        ];
        for (circuit_id, pub_inputs, expected) in cases {
            let a = get_boundary_assertions(circuit_id, pub_inputs)
                .unwrap_or_else(|e| panic!("circuit {circuit_id} must resolve: {e:?}"));
            assert_eq!(a.len(), expected, "assertion-count drift for circuit {circuit_id}");
            assert!(!a.is_empty());
        }
    }

    /// [SEAM] The degradation this test used to PIN AS CORRECT.
    ///
    /// It read:
    /// ```ignore
    /// // Circuit 3 / 6 out-of-range depth still degrades to the leaf-only form
    /// // (unchanged behaviour, deliberately not touched by this fix).
    /// assert_eq!(get_boundary_assertions(3, &[1, 2, 99]).unwrap().len(), 1);
    /// assert_eq!(get_boundary_assertions(6, &[1, 2, 3, 4, 99]).unwrap().len(), 2);
    /// ```
    ///
    /// `depth` is a CALLER-SUPPLIED public input. Dropping assertions on an
    /// out-of-range value means the caller chose which bindings to enforce: at
    /// `depth = 99` a C6 proof was checked against nothing but its two leaves,
    /// and a C3 proof against nothing but its leaf. Phase 1 has no other pin on
    /// `depth` — `verify_deep_ali_circuit_3/_6` do, but they are a SEPARATE
    /// instruction, and `verified = true` is what four of the shipped consumer
    /// paths read first.
    ///
    /// This is a tightening, not a weakening: the old assertion said "returns a
    /// SHORTER list", the new one says "returns Err".
    #[test]
    fn out_of_range_depth_can_no_longer_switch_off_the_root_binding() {
        for bad_depth in [0u64, 17, 32, 99, u32::MAX as u64, u64::MAX] {
            assert!(
                matches!(
                    get_boundary_assertions(3, &[1, 2, bad_depth]),
                    Err(VerifyError::PublicInputCountMismatch)
                ),
                "C3 depth {bad_depth} must be refused, not degraded"
            );
            assert!(
                matches!(
                    get_boundary_assertions(6, &[1, 2, 3, 4, bad_depth]),
                    Err(VerifyError::PublicInputCountMismatch)
                ),
                "C6 depth {bad_depth} must be refused, not degraded"
            );
        }
        // Every in-range depth keeps the FULL assertion set, and the root row it
        // names is inside the trace (512 rows) — otherwise the assertion would
        // be vacuous, since `verify_boundary_constraints` reduces every query
        // position mod `trace_length`.
        for depth in MIN_MERKLE_DEPTH..=MAX_MERKLE_DEPTH {
            let d = depth as u64;
            assert_eq!(get_boundary_assertions(3, &[1, 2, d]).unwrap().len(), 2);
            let a6 = get_boundary_assertions(6, &[1, 2, 3, 4, d]).unwrap();
            assert_eq!(a6.len(), 4);
            for a in &a6 {
                assert!(a.row < 512, "depth {depth} names unreachable row {}", a.row);
            }
        }
    }

    /// [BIND-DEPTH 2026-08-03] The half of `61903e76` that was left behind.
    ///
    /// That commit closed the fail-open `depth` window in THIS file. The prover's
    /// mirror of the same table, `boundary_assertions_for_circuit` in
    /// `stark/src/compact.rs`, kept its own windows — `depth > 0 && depth <= 32`
    /// for C3, `<= 16` for C6 — each with an `else` arm that dropped the root
    /// assertions and folded a Q_bnd binding only the leaves. Nothing was
    /// unsound, because the chain had become the stricter of the two, but a
    /// prover would build a proof that no verifier on earth accepts and only find
    /// out on chain.
    ///
    /// Two restatements of one window in two crates is the shape that let this
    /// survive, so this test does not restate it a third time: it DRIVES both
    /// sides and requires them to agree — same acceptance window, same assertion
    /// count, same (col, row, value) triples in the same order, because the
    /// `alpha_bnd^j` powers are positional.
    ///
    /// Mutation it goes red under: restore either `else` arm in
    /// `boundary_assertions_for_circuit`, or widen its C3 window back to `<= 32`.
    #[test]
    fn prover_depth_window_matches_the_verifier() {
        use p01_stark::compact::boundary_assertions_probe;

        assert_eq!(p01_stark::compact::MIN_MERKLE_DEPTH, MIN_MERKLE_DEPTH);
        assert_eq!(p01_stark::compact::MAX_MERKLE_DEPTH, MAX_MERKLE_DEPTH);

        // Silence the panic spew from the refusal half; restored at the end.
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));

        let cases: [(u8, &[u64], usize); 2] = [(3, &[1, 2, 0], 2), (6, &[1, 2, 3, 4, 0], 4)];
        for (circuit_id, template, depth_idx) in cases {
            for depth in [0u64, 1, 2, 15, 16, 17, 32, 33, 99, u32::MAX as u64, u64::MAX] {
                let mut pi = template.to_vec();
                pi[depth_idx] = depth;
                let in_window = depth >= MIN_MERKLE_DEPTH as u64
                    && depth <= MAX_MERKLE_DEPTH as u64;

                let chain = get_boundary_assertions(circuit_id, &pi);
                let prover = std::panic::catch_unwind(|| boundary_assertions_probe(circuit_id, &pi));

                assert_eq!(
                    chain.is_ok(),
                    prover.is_ok(),
                    "C{circuit_id} depth {depth}: chain accepts={} but prover accepts={} — the \
                     two windows have diverged",
                    chain.is_ok(),
                    prover.is_ok(),
                );
                assert_eq!(
                    chain.is_ok(),
                    in_window,
                    "C{circuit_id} depth {depth}: expected accept={in_window}",
                );

                if let (Ok(c), Ok(p)) = (chain, prover) {
                    let c_triples: Vec<(usize, usize, u64)> =
                        c.iter().map(|a| (a.col, a.row, a.value.as_u64())).collect();
                    assert_eq!(
                        c_triples, p,
                        "C{circuit_id} depth {depth}: assertion tables differ. Order is \
                         load-bearing — alpha_bnd^j is indexed by position.",
                    );
                }
            }
        }

        // The same triple-for-triple parity on every circuit, not just the two
        // that carry a depth: a value or ordering drift anywhere here silently
        // changes which public input binds which trace cell.
        let full: [(u8, &[u64]); 7] = [
            (0, &[42]),
            (1, &[11, 22]),
            (2, &[33, 44]),
            (3, &[55, 66, 15]),
            (4, &[77, 88, 99, 111]),
            (5, &[1, 2, 3, 4, 5, 6]),
            (6, &[7, 8, 9, 10, 15]),
        ];
        for (circuit_id, pi) in full {
            let c = get_boundary_assertions(circuit_id, pi)
                .unwrap_or_else(|e| panic!("C{circuit_id} must resolve on chain: {e:?}"));
            let p = boundary_assertions_probe(circuit_id, pi);
            let c_triples: Vec<(usize, usize, u64)> =
                c.iter().map(|a| (a.col, a.row, a.value.as_u64())).collect();
            assert_eq!(
                c_triples, p,
                "C{circuit_id}: prover and verifier boundary tables differ",
            );
        }

        std::panic::set_hook(hook);
    }

    /// [SEAM] Short public inputs used to be DEFAULTED to `Felt::ZERO`, one
    /// `else` arm per missing element. That made `verify_stark_proof` — the
    /// legacy single-`u64` entry point, which has NO gate against circuits
    /// 1..=6, unlike `verify_stark_proof_v2`'s `[C0 GATE]` — able to set
    /// `verified = true` on a generic buffer with one real public input and the
    /// rest asserted against zero.
    #[test]
    fn short_or_long_public_inputs_are_refused_not_defaulted() {
        let full: [(u8, &[u64]); 7] = [
            (0, &[42]),
            (1, &[1, 2]),
            (2, &[1, 2]),
            (3, &[1, 2, 15]),
            (4, &[1, 2, 3, 4]),
            (5, &[1, 2, 3, 4, 5, 6]),
            (6, &[1, 2, 3, 4, 15]),
        ];
        for (circuit_id, inputs) in full {
            assert_eq!(
                expected_public_input_count(circuit_id).unwrap(),
                inputs.len(),
                "arity table disagrees with the honest input list for C{circuit_id}"
            );
            get_boundary_assertions(circuit_id, inputs)
                .unwrap_or_else(|e| panic!("C{circuit_id} honest arity must resolve: {e:?}"));

            // Every strict prefix — including the empty one — must be refused.
            for short in 0..inputs.len() {
                assert!(
                    matches!(
                        get_boundary_assertions(circuit_id, &inputs[..short]),
                        Err(VerifyError::PublicInputCountMismatch)
                    ),
                    "C{circuit_id} accepted {short} of {} public inputs",
                    inputs.len()
                );
            }
            // And so must a surplus: the buffer's `public_inputs_hash` covers
            // every element supplied, so an element the assertions never read
            // is a value the caller can move freely under a fixed hash.
            let mut long = inputs.to_vec();
            long.push(0xDEAD_BEEF);
            assert!(
                matches!(
                    get_boundary_assertions(circuit_id, &long),
                    Err(VerifyError::PublicInputCountMismatch)
                ),
                "C{circuit_id} accepted a surplus public input"
            );
        }
    }

    /// An unknown circuit id must still be diagnosed as `UnsupportedCircuit`,
    /// not as an arity error — the arity check runs after the id lookup.
    #[test]
    fn arity_check_does_not_mask_an_unknown_circuit() {
        // [C7 2026-08-24] 7 dropped: it is a real circuit now. 8, 100 and 255
        // must still answer UnsupportedCircuit, and the assertions below are
        // unchanged -- this list is the tripwire, not the assertion.
        for circuit_id in [8u8, 100, 255] {
            for n in 0..8usize {
                let inputs: Vec<u64> = (0..n as u64).collect();
                assert!(
                    matches!(
                        get_boundary_assertions(circuit_id, &inputs),
                        Err(VerifyError::UnsupportedCircuit)
                    ),
                    "circuit {circuit_id} with {n} inputs got the wrong diagnosis"
                );
            }
        }
    }
}

// ============================================================================
// Boundary constraint definitions per circuit
// ============================================================================

/// A boundary constraint: trace[col] at row `row` must equal `value`.
struct BoundaryAssertion {
    col: usize,
    row: usize,
    value: Felt,
}

/// [SEAM] How many `u64` public inputs each circuit's boundary assertions
/// consume. This is the ONLY arity declaration in the verifier — every other
/// site derives from it.
///
/// The counts match the prover (`stark/src/compact.rs`, which asserts
/// `proof.public_inputs.len()` per circuit) and the consumers, all of which
/// rebuild `sha256` over exactly this many little-endian `u64`s.
///
/// Unknown ids return `UnsupportedCircuit`, deliberately: an arity error for an
/// id that does not exist would be the wrong diagnosis, and
/// `boundary_assertions_reject_unknown_circuit` pins that ordering.
pub fn expected_public_input_count(circuit_id: u8) -> Result<usize, VerifyError> {
    match circuit_id {
        0 => Ok(1), // [commitment]
        1 => Ok(2), // [nullifier, commitment]
        2 => Ok(2), // [commitment, token_mint]
        3 => Ok(3), // [leaf, root, depth]
        4 => Ok(4), // [old_commitment, new_commitment, amount_hash, token_mint]
        5 => Ok(6), // [null_1, null_2, out_c1, out_c2, public_amount, token_mint]
        6 => Ok(5), // [old_leaf, new_leaf, old_root, new_root, depth]
        // [C7] Six, and NO `depth` slot -- unlike C3 (3) and C6 (5). C7's depth
        // is fixed at 12 by the trace layout, so there is no caller-chosen
        // number here and `MIN/MAX_MERKLE_DEPTH` do not apply. That window is
        // the C3/C6 seam that had to be patched twice; C7 does not have it.
        7 => Ok(6), // [nullifier, root, rh0, rh1, rh2, rh3]
        _ => Err(VerifyError::UnsupportedCircuit),
    }
}

/// [SEAM] Legal range for the C3/C6 `depth` public input.
///
/// `depth` selects which trace row carries the root assertions
/// (`output_row = (depth - 1) * 32 + 30`). Out of this range there IS no such
/// row, and the old code responded by silently emitting a shorter assertion
/// list — i.e. a caller-chosen public input could switch the root binding OFF.
const MIN_MERKLE_DEPTH: usize = 1;
const MAX_MERKLE_DEPTH: usize = 16;

/// Get boundary assertions for a circuit given its public inputs.
///
/// These bind the proof to public inputs by requiring specific trace values
/// at specific rows.
///
/// **Fails closed on an unknown `circuit_id`.** This used to return an empty
/// `Vec`, and `verify_boundary_constraints` treats an empty assertion list as
/// "nothing to check" — so a circuit added to the step-4 dispatch but forgotten
/// here would have verified with *zero* public-input binding. Same failure
/// class as the generator lookups above. Unreachable today (`verify_generic`
/// rejects unknown ids at step 4 before step 5 runs, and every DEEP-ALI caller
/// passes a hardcoded id in 0..=6), but it is a trap for the next circuit.
fn get_boundary_assertions(
    circuit_id: u8,
    public_inputs: &[u64],
) -> Result<Vec<BoundaryAssertion>, VerifyError> {
    const HASH_CYCLE_LEN: usize = 32;
    const NUM_ROUNDS: usize = 30;
    // [SEAM] Exact arity, checked BEFORE the arms so no arm can reach its
    // `else { Felt::ZERO }` fallback. Unknown ids still fail as
    // `UnsupportedCircuit`, not as an arity error — the ordering matters for
    // `boundary_assertions_reject_unknown_circuit`.
    let expected_len = expected_public_input_count(circuit_id)?;
    if public_inputs.len() != expected_len {
        return Err(VerifyError::PublicInputCountMismatch);
    }
    // [#2 voie A] Circuit-5 row where the conservation accumulator (col 6)
    // holds its final value and is asserted == public_amount. Matches the
    // prover's `ROW_ACC_FINAL` = ROW_OUT_AMOUNT_2 + 1 = 12*32 + 1 = 385.
    const ROW_ACC_FINAL_C5: usize = 12 * HASH_CYCLE_LEN + 1;

    let assertions = match circuit_id {
        // Circuit 0: subscriber_ownership
        // Public inputs: [commitment]
        // Assertions: state[1] at row 0 = 0, state[2] at row 0 = 0,
        //             state[0] at row 30 = commitment
        0 => {
            let commitment = Felt::new(public_inputs[0]);
            vec![
                BoundaryAssertion { col: 1, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 0, row: NUM_ROUNDS, value: commitment },
            ]
        }
        // Circuit 1: pool_commitment
        // Public inputs: [nullifier, commitment]
        // Assertions: nullifier at row 30 (col 0), commitment at row 94 (col 0),
        //             capacity=0 at row 0,32,64, chaining at row 64 (col 0) = nullifier
        1 => {
            let nullifier = Felt::new(public_inputs[0]);
            let commitment = Felt::new(public_inputs[1]);
            vec![
                BoundaryAssertion { col: 0, row: NUM_ROUNDS, value: nullifier },
                BoundaryAssertion { col: 0, row: 2 * HASH_CYCLE_LEN + NUM_ROUNDS, value: commitment },
                BoundaryAssertion { col: 2, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: HASH_CYCLE_LEN, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 2 * HASH_CYCLE_LEN, value: Felt::ZERO },
                BoundaryAssertion { col: 0, row: 2 * HASH_CYCLE_LEN, value: nullifier },
            ]
        }
        // Circuit 2: balance_proof
        // Public inputs: [commitment, token_mint]
        // Assertions: col1=0,col2=0 at row 0, col1=token_mint at row 32,
        //             capacity=0 at rows 32,64,96, commitment at row 126 (3*32+30)
        2 => {
            let commitment = Felt::new(public_inputs[0]);
            let token_mint = Felt::new(public_inputs[1]);
            vec![
                BoundaryAssertion { col: 1, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 1, row: 32, value: token_mint },
                BoundaryAssertion { col: 2, row: 32, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 64, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 96, value: Felt::ZERO },
                BoundaryAssertion { col: 0, row: 3 * HASH_CYCLE_LEN + NUM_ROUNDS, value: commitment },
            ]
        }
        // Circuit 3: merkle_path
        // Public inputs: [leaf, root, depth]
        // Assertions: col5 at row 0 = leaf (carry), col0 at output_row = root
        // output_row = (depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS
        3 => {
            let leaf = Felt::new(public_inputs[0]);
            let root = Felt::new(public_inputs[1]);
            let depth = public_inputs[2] as usize;
            // [SEAM] Was `depth > 0 && depth <= 32`, with an `else` arm that
            // dropped the root assertion. Two ways that lost the root binding:
            // out-of-range `depth` took the else arm outright, and `depth` in
            // 17..=32 produced `output_row >= 512 == trace_length`, a row
            // `verify_boundary_constraints` can never match because it reduces
            // every query mod `trace_length`. Both are now refused.
            if !(MIN_MERKLE_DEPTH..=MAX_MERKLE_DEPTH).contains(&depth) {
                return Err(VerifyError::PublicInputCountMismatch);
            }
            let output_row = (depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS;
            vec![
                BoundaryAssertion { col: 5, row: 0, value: leaf },
                BoundaryAssertion { col: 0, row: output_row, value: root },
            ]
        }
        // Circuit 4: confidential_balance
        // Public inputs: [old_commitment, new_commitment, amount_hash, token_mint]
        // Assertions: col1=0,col2=0 at row 0, col1=token_mint at row 32,
        //             capacity=0 at cycle starts, output assertions for commitments
        4 => {
            let old_commitment = Felt::new(public_inputs[0]);
            let new_commitment = Felt::new(public_inputs[1]);
            let amount_hash = Felt::new(public_inputs[2]);
            let token_mint = Felt::new(public_inputs[3]);
            vec![
                BoundaryAssertion { col: 1, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 1, row: 32, value: token_mint },
                BoundaryAssertion { col: 2, row: 32, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 64, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 96, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 128, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 160, value: Felt::ZERO },
                BoundaryAssertion { col: 2, row: 192, value: Felt::ZERO },
                BoundaryAssertion { col: 0, row: 2 * HASH_CYCLE_LEN + NUM_ROUNDS, value: amount_hash },
                BoundaryAssertion { col: 0, row: 4 * HASH_CYCLE_LEN + NUM_ROUNDS, value: old_commitment },
                BoundaryAssertion { col: 0, row: 6 * HASH_CYCLE_LEN + NUM_ROUNDS, value: new_commitment },
            ]
        }
        // Circuit 5: transfer
        // Public inputs: [nullifier_1, nullifier_2, output_commitment_1, output_commitment_2, public_amount, token_mint]
        5 => {
            let nullifier_1 = Felt::new(public_inputs[0]);
            let nullifier_2 = Felt::new(public_inputs[1]);
            let output_commitment_1 = Felt::new(public_inputs[2]);
            let output_commitment_2 = Felt::new(public_inputs[3]);
            let public_amount = Felt::new(public_inputs[4]);
            let token_mint = Felt::new(public_inputs[5]);
            let mut assertions = Vec::new();
            // Capacity = 0 at start of each of the 14 REAL cycles.
            //
            // 🚨 16 -> 14 on 2026-08-29, AND THE ORDER OF THIS LIST IS THE WIRE.
            // `alpha_bnd^j` is indexed by POSITION, so dropping the two entries
            // for cycles 14 and 15 renumbers every assertion after them: what
            // was j=16..25 becomes j=14..23.
            //
            // ⛔ THIS LIST, `transfer.rs::get_assertions` AND
            // `compact.rs::boundary_assertions_for_circuit` ARE ONE OBJECT IN
            // THREE FILES. An honest proof built against any older copy fails
            // DEEP-ALI against a newer one, silently and completely, so the
            // three move in the same commit or none of them moves.
            //
            // The two that left were the capacity assertions at rows 448 and
            // 480 — the starts of the padding cycles, which are now inside the
            // blinding region. Demanding a masked cell equal zero is
            // unsatisfiable with fresh randomness, and satisfying it would
            // publish a known cell.
            for cycle in 0..14usize {
                assertions.push(BoundaryAssertion {
                    col: 2,
                    row: cycle * HASH_CYCLE_LEN,
                    value: Felt::ZERO,
                });
            }
            // col 1 at row 0 = 0
            assertions.push(BoundaryAssertion { col: 1, row: 0, value: Felt::ZERO });
            // Token mint as right input at cycles 1, 8, 11
            assertions.push(BoundaryAssertion { col: 1, row: HASH_CYCLE_LEN, value: token_mint });
            assertions.push(BoundaryAssertion { col: 1, row: 8 * HASH_CYCLE_LEN, value: token_mint });
            assertions.push(BoundaryAssertion { col: 1, row: 11 * HASH_CYCLE_LEN, value: token_mint });
            // Output assertions (public inputs)
            assertions.push(BoundaryAssertion {
                col: 0, row: 4 * HASH_CYCLE_LEN + NUM_ROUNDS, value: nullifier_1,
            });
            assertions.push(BoundaryAssertion {
                col: 0, row: 7 * HASH_CYCLE_LEN + NUM_ROUNDS, value: nullifier_2,
            });
            assertions.push(BoundaryAssertion {
                col: 0, row: 10 * HASH_CYCLE_LEN + NUM_ROUNDS, value: output_commitment_1,
            });
            assertions.push(BoundaryAssertion {
                col: 0, row: 13 * HASH_CYCLE_LEN + NUM_ROUNDS, value: output_commitment_2,
            });
            // [#2 voie A] Value-conservation accumulator boundary (col 6).
            // MUST be appended in the SAME order as the prover's `get_assertions`
            // (acc@row0 = 0, then acc@row385 = public_amount) so the per-term
            // `alpha_bnd^j` powers in `boundary_fold_at_ood` line up. This takes
            // the assertion count from 22 → 24 (it read 24 → 26 while the two
            // padding cycles still carried capacity assertions).
            assertions.push(BoundaryAssertion { col: 6, row: 0, value: Felt::ZERO });
            assertions.push(BoundaryAssertion {
                col: 6, row: ROW_ACC_FINAL_C5, value: public_amount,
            });
            assertions
        }
        // Circuit 6: merkle_update
        // Public inputs: [old_leaf, new_leaf, old_root, new_root, depth]
        // Assertions: col8 at row 0 = old_leaf, col9 at row 0 = new_leaf,
        //             col0 at output_row = old_root, col3 at output_row = new_root
        // output_row = (depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS
        6 => {
            let old_leaf = Felt::new(public_inputs[0]);
            let new_leaf = Felt::new(public_inputs[1]);
            let old_root = Felt::new(public_inputs[2]);
            let new_root = Felt::new(public_inputs[3]);
            let depth = public_inputs[4] as usize;
            // [SEAM] Was an `else` arm that dropped `old_root` and `new_root`
            // whenever the CALLER supplied an out-of-range depth. Phase 1 never
            // pinned depth (only `verify_deep_ali_circuit_6` does), so
            // `verify_stark_proof_v2` would mark a C6 buffer `verified = true`
            // on a proof bound to nothing but its two leaves.
            if !(MIN_MERKLE_DEPTH..=MAX_MERKLE_DEPTH).contains(&depth) {
                return Err(VerifyError::PublicInputCountMismatch);
            }
            let output_row = (depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS;
            vec![
                BoundaryAssertion { col: 8, row: 0, value: old_leaf },
                BoundaryAssertion { col: 9, row: 0, value: new_leaf },
                BoundaryAssertion { col: 0, row: output_row, value: old_root },
                BoundaryAssertion { col: 3, row: output_row, value: new_root },
            ]
        }
        // Circuit 7: spend. Public inputs
        // [nullifier, root, rh0, rh1, rh2, rh3].
        //
        // ORDER IS LOAD-BEARING. It is the `alpha_bnd^j` exponent order in
        // `boundary_fold_at_ood`, and it mirrors the prover's
        // `SPEND_BOUNDARY_SPEC` (stark/src/air/spend.rs) element for element.
        // Reordering these six lines silently produces a different polynomial
        // and every honest proof fails with `DeepAliFailed`.
        //
        // `rh0..rh3` take NO column and NO assertion. Their binding is
        // Fiat-Shamir-transcript-only, exactly as C3's `depth` is: they enter
        // `pub_bytes`, which moves the OOD point, the query positions and both
        // alphas, so changing one invalidates the proof without ever being
        // constrained inside the circuit.
        7 => {
            // 🚨 DO NOT WRITE `CANONICAL_DEPTH` HERE. That name exists three
            // times in this file and means 15 every time; C7's is 11, and the
            // difference is (15-1)*32+30 = 478 versus (11-1)*32+30 = 350. Row
            // 478 is inside C7's blinding region, where nothing is constrained
            // at all. That exact slip is what `tests/c7_probe` is built on.
            //
            // ⛔ [ZK-DEPTH-11 2026-08-30] 382 -> 350, AND THIS LINE IS A SECOND
            // COPY OF THE CIRCUIT'S GEOMETRY. `air/spend.rs::ROW_MERKLE_ROOT_OUT`
            // moved with the depth cut; this one did not, and the whole C7 suite
            // went red with `DeepAliFailed` on every honest proof — the boundary
            // fold was binding the root at a row the trace no longer puts it on.
            // The warning above says not to write `CANONICAL_DEPTH`; it does not
            // say the number is fixed.
            const ROW_MERKLE_ROOT_OUT_C7: usize = 10 * HASH_CYCLE_LEN + NUM_ROUNDS; // 350
            //
            // ⛔ AND THIS ROOT IS A DEPTH-12 SUBTREE ROOT, NOT THE POOL ROOT.
            // Binding it here proves membership of a subtree. Anyone holding a
            // leaf in ANY subtree satisfies this assertion. The spending
            // instruction MUST hash the three remaining levels itself against
            // caller-supplied siblings and bind the result with `is_valid_root`
            // before it trusts a C7 proof. Without that leg C7 is a fund-loss
            // circuit, in the class `unshield` C5 was in before 2026-08-18.
            let nullifier = Felt::new(public_inputs[0]);
            let root = Felt::new(public_inputs[1]);
            vec![
                // cycle-0 Poseidon output: the published nullifier.
                BoundaryAssertion { col: 6, row: NUM_ROUNDS, value: nullifier },
                // cycle-2 LEFT input is the SAME nullifier. Without this, one
                // published nullifier could be paired with any commitment.
                BoundaryAssertion { col: 6, row: 2 * HASH_CYCLE_LEN, value: nullifier },
                // Poseidon capacity zeroed at the start of cycles 0, 1, 2.
                BoundaryAssertion { col: 8, row: 0, value: Felt::ZERO },
                BoundaryAssertion { col: 8, row: HASH_CYCLE_LEN, value: Felt::ZERO },
                BoundaryAssertion { col: 8, row: 2 * HASH_CYCLE_LEN, value: Felt::ZERO },
                // the depth-12 subtree root -- see the ⛔ above.
                BoundaryAssertion { col: 0, row: ROW_MERKLE_ROOT_OUT_C7, value: root },
            ]
        }
        _ => return Err(VerifyError::UnsupportedCircuit),
    };
    Ok(assertions)
}

// ============================================================================
// Unified verification entry point
// ============================================================================

/// Verify a generic compact proof for any supported circuit **1..=6**.
///
/// # Circuit 0 is refused here, explicitly
///
/// `circuit_id == 0` returns [`VerifyError::CircuitZeroIsLegacyOnly`] before any
/// work is done. C0 proofs are verified by [`verify_subscriber_ownership`], and
/// only by it: the generic DEEP-ALI check uses the wrong vanishing polynomial for
/// C0 and has no recomputation for C0's folded boundary term, so it cannot verify
/// an honest C0 proof. A silent "it just fails" is the wrong shape for that — it
/// reads as a forgery, and a future refactor could plausibly "fix" the failure
/// into an acceptance. The refusal is the contract.
pub fn verify_generic(
    proof: &GenericCompactProof,
    circuit_id: u8,
    public_inputs: &[u64],
    config: &CircuitConfig,
) -> Result<(), VerifyError> {
    // Step 0: C0 hard gate. Must come before everything — the point is that the
    // generic path never touches a C0 proof, not that it fails late.
    if circuit_id == crate::CIRCUIT_SUBSCRIBER_OWNERSHIP {
        anchor_lang::prelude::msg!(
            "[verify] circuit 0 is legacy-only; use verify_stark_proof, not the generic path"
        );
        return Err(VerifyError::CircuitZeroIsLegacyOnly);
    }

    // Step 1: Field range check on OOD values
    verify_ood_range(proof)?;
    anchor_lang::prelude::msg!("[verify] step1 ok");

    // Step 1b: [H10] Verify OOD point was correctly derived from transcript.
    // [P1.1] quotient_root is folded into the transcript before OOD so the
    // prover cannot choose quotient values after seeing the OOD challenge.
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let expected_ood_z = derive_ood_point(&proof.trace_root, &proof.quotient_root, &pub_bytes);
    if proof.ood_z.as_u64() != expected_ood_z {
        anchor_lang::prelude::msg!("[verify] OOD z mismatch: got {} want {}", proof.ood_z.as_u64(), expected_ood_z);
        return Err(VerifyError::OodConstraintFailed);
    }
    anchor_lang::prelude::msg!("[verify] step1b ok");

    // Step 2: [H9 + P1.1 PR 2] Derive + verify Fiat-Shamir query positions.
    // Transcript binds trace + quotient commitments, OOD evals, all FRI layer
    // roots, and the final FRI polynomial — so grinding seals the entire
    // commit phase before query positions are revealed.
    let ood_current_u64: Vec<u64> = proof.ood_current_iter().map(|f| f.as_u64()).collect();
    let ood_next_u64: Vec<u64> = proof.ood_next_iter().map(|f| f.as_u64()).collect();
    let expected = derive_query_positions_generic(
        &proof.trace_root, &proof.quotient_root, &pub_bytes,
        &ood_current_u64, &ood_next_u64, proof.ood_quotient_bytes(),
        proof.fri_layer_roots_bytes(), proof.fri_final_poly_bytes(),
        proof.grinding_nonce,
        config.lde_size, config.num_queries,
    )?;
    // [L13 2026-08-03] This line used to print `(expected={} proof={})`.
    // `expected.len()` is `config.num_queries`, a per-circuit constant, so the
    // log read `expected=27` for C1 and `expected=22` for C3/C5/C6 — MEASURED
    // in transaction metadata by
    // `cu_budget.rs::l13_uniform_path_program_logs_are_identical_across_circuits`,
    // which was red on exactly this line plus `verify_uniform`'s trailer. A
    // program log is public metadata that every RPC serves and every indexer
    // keeps, so printing a circuit-derived number here partitioned the anonymity
    // set that `init_proof_buffer_v2` and the 145,000-byte padding exist to
    // create. The step marker stays; the number does not. Nothing is lost for
    // debugging: `verify_query_positions_generic` on the next line is what
    // rejects a count mismatch, and it returns a named error.
    anchor_lang::prelude::msg!("[verify] step2a ok");
    verify_query_positions_generic(proof, &expected)?;
    anchor_lang::prelude::msg!("[verify] step2 ok");

    // Step 3: Verify Merkle proofs (trace + quotient leaves)
    verify_merkle_proofs_generic(proof, config)?;
    anchor_lang::prelude::msg!("[verify] step3 ok");

    // Step 3.5: [P1.1 PR 3] FRI fold consistency + final_poly check.
    // Ties every committed layer to an honest fold of the prior layer, with
    // the last fold verified by evaluating the final polynomial in the clear.
    verify_fri_generic(proof, config, &pub_bytes)?;
    anchor_lang::prelude::msg!("[verify] step3.5 ok");

    // Step 4: Circuit-specific transition constraint + quotient verification
    match circuit_id {
        // 0 is unreachable — the step-0 gate above returned already. Left as an
        // explicit arm so the refusal is visible at the dispatch too, and so a
        // future edit that deletes the gate does not silently re-enable a path
        // that cannot verify honest C0 proofs.
        0 => Err(VerifyError::CircuitZeroIsLegacyOnly),
        1 => verify_constraints_pool_commitment(proof, config, public_inputs),
        2 => verify_constraints_balance_proof(proof, config, public_inputs),
        3 => verify_constraints_merkle_path(proof, config, public_inputs),
        4 => verify_constraints_confidential_balance(proof, config, public_inputs),
        5 => verify_constraints_transfer(proof, config, public_inputs),
        6 => verify_constraints_merkle_update(proof, config, public_inputs),
        7 => verify_constraints_spend(proof, config, public_inputs),
        _ => Err(VerifyError::UnsupportedCircuit),
    }?;
    anchor_lang::prelude::msg!("[verify] step4 ok");

    // Step 5: [C6] Verify boundary constraints at trace-aligned query positions
    verify_boundary_constraints(proof, circuit_id, config, public_inputs)?;
    anchor_lang::prelude::msg!("[verify] step5 ok");

    Ok(())
}

// ============================================================================
// Legacy entry point (backward compat)
// ============================================================================

/// Verify a compact STARK proof for subscriber_ownership (legacy format).
pub fn verify_subscriber_ownership(
    proof: &CompactStarkProof,
    commitment: Felt,
) -> Result<(), VerifyError> {
    // Field range check
    for v in proof.ood_current.iter().chain(proof.ood_next.iter()) {
        if v.as_u64() >= crate::goldilocks::MODULUS {
            return Err(VerifyError::OodConstraintFailed);
        }
    }
    // [B2] Every segment claim, not just one. (The parser already refuses
    // non-canonical encodings; this is the same hole from the other side.)
    for v in proof.ood_quotient_iter() {
        if v.as_u64() >= crate::goldilocks::MODULUS {
            return Err(VerifyError::OodConstraintFailed);
        }
    }

    // [H10] Verify OOD point was correctly derived (binds quotient_root, P1.1)
    let commitment_bytes = commitment.to_le_bytes();
    let expected_ood_z = derive_ood_point(&proof.trace_root, &proof.quotient_root, &commitment_bytes);
    if proof.ood_z.as_u64() != expected_ood_z {
        return Err(VerifyError::OodConstraintFailed);
    }

    // [H9] Fiat-Shamir with OOD in transcript
    let ood_current_u64: Vec<u64> = proof.ood_current.iter().map(|f| f.as_u64()).collect();
    let ood_next_u64: Vec<u64> = proof.ood_next.iter().map(|f| f.as_u64()).collect();
    let expected = derive_query_positions_legacy(
        &proof.trace_root, &proof.quotient_root, commitment, &ood_current_u64, &ood_next_u64,
        proof.ood_quotient_bytes(),
        proof.fri_layer_roots_bytes(), proof.fri_final_poly_bytes(),
        proof.grinding_nonce,
    )?;
    verify_query_positions_legacy(proof, &expected)?;

    // Merkle proofs
    verify_merkle_proofs_legacy(proof)?;

    // [P1.1 PR 4 DEEP-ALI] Quotient check at OOD: ties prover's Q(z) to
    // the AIR evaluation on opened OOD trace values. FRI (below) enforces
    // the low-degree bound on the committed quotient LDE.
    verify_deep_ali_legacy(proof, commitment)?;

    // [P1.1 PR 3] FRI fold consistency + final_poly check (legacy path)
    verify_fri_legacy(proof, commitment)?;

    // Transition constraints + quotient verification
    verify_transition_legacy(proof)?;

    // [C6] Boundary constraints for legacy (circuit 0)
    verify_boundary_constraints_legacy(proof, commitment)?;

    Ok(())
}

// ============================================================================
// Generic helpers
// ============================================================================

fn verify_ood_range(proof: &GenericCompactProof) -> Result<(), VerifyError> {
    for v in proof.ood_current_iter().chain(proof.ood_next_iter()) {
        if v.as_u64() >= crate::goldilocks::MODULUS {
            return Err(VerifyError::OodConstraintFailed);
        }
    }
    // [B2] Every segment claim, not just one.
    for v in proof.ood_quotient_iter() {
        if v.as_u64() >= crate::goldilocks::MODULUS {
            return Err(VerifyError::OodConstraintFailed);
        }
    }
    Ok(())
}

fn public_inputs_to_bytes(inputs: &[u64]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(inputs.len() * 8);
    for &v in inputs {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

/// [H10] Derive OOD evaluation point from Fiat-Shamir transcript.
/// Post-P1.1: binds `quotient_root` alongside `trace_root` so the OOD challenge
/// depends on the quotient commitment — the prover cannot pick quotient values
/// after seeing the OOD point.
fn derive_ood_point(
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    pub_bytes: &[u8],
) -> u64 {
    // Syscall hashv accepts sliced inputs — no `data` Vec needed.
    let hash = hashv(&[trace_root, quotient_root, pub_bytes]);
    let hash_bytes = hash.to_bytes();
    let mut ood_z = u64::from_le_bytes(hash_bytes[0..8].try_into().unwrap()) % GOLDILOCKS_PRIME;
    if ood_z == 0 { ood_z = 1; }
    ood_z
}

/// Build the Fiat-Shamir base seed from trace_root + quotient_root + public
/// inputs + OOD evaluations. `quotient_root` must precede OOD/position
/// derivation so the prover commits the quotient before receiving challenges.
/// Post-PR 4: absorbs `ood_quotient` alongside `ood_current`/`ood_next` so
/// the OOD Q(z) claim is bound before FRI challenges.
fn build_base_seed(
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    pub_bytes: &[u8],
    ood_current: &[u64],
    ood_next: &[u64],
    // [B2] RAW wire bytes of all `quotient_segments` Q_j(z) claims. Absorbing
    // only the recombined Q(z) would let a prover pick the SPLIT after seeing
    // gamma, and the split is precisely what the DEEP composition binds.
    ood_quotient_bytes: &[u8],
) -> [u8; 32] {
    // Serialize OOD felts once into one small scratch buffer, then feed the
    // syscall a sliced &[&[u8]] — avoids a big concatenated transcript Vec.
    // The quotient claims are already contiguous wire bytes, so they go in as
    // their own segment rather than through the scratch buffer.
    let ood_total = ood_current.len() + ood_next.len();
    let mut ood_buf: Vec<u8> = Vec::with_capacity(ood_total * 8);
    for val in ood_current {
        ood_buf.extend_from_slice(&val.to_le_bytes());
    }
    for val in ood_next {
        ood_buf.extend_from_slice(&val.to_le_bytes());
    }
    hashv(&[trace_root, quotient_root, pub_bytes, &ood_buf, ood_quotient_bytes]).to_bytes()
}

fn leading_zero_bits(bytes: &[u8; 32]) -> u32 {
    let mut count = 0u32;
    for &b in bytes.iter() {
        if b == 0 {
            count += 8;
        } else {
            count += b.leading_zeros();
            break;
        }
    }
    count
}

/// Verify the prover's PoW grinding nonce and return the post-grinding query seed.
pub(crate) fn verify_grinding(
    base_seed: &[u8; 32],
    nonce: u64,
    grinding_bits: u32,
) -> Result<[u8; 32], VerifyError> {
    let nonce_bytes = nonce.to_le_bytes();
    let h = hashv(&[base_seed, &nonce_bytes]).to_bytes();
    if leading_zero_bits(&h) < grinding_bits {
        return Err(VerifyError::InsufficientQueries);
    }
    Ok(h)
}

fn derive_positions_from_seed(
    query_seed: &[u8; 32],
    lde_size: usize,
    num_queries: usize,
) -> Vec<u32> {
    let mut positions = Vec::with_capacity(num_queries);
    let mut counter = 0u32;

    while positions.len() < num_queries {
        let counter_bytes = counter.to_le_bytes();
        let hash = hashv(&[query_seed, &counter_bytes]);
        let bytes = hash.to_bytes();

        for chunk in bytes.chunks(4) {
            if positions.len() >= num_queries {
                break;
            }
            let val = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            let pos = val % (lde_size as u32);
            if !positions.contains(&pos) {
                positions.push(pos);
            }
        }
        counter += 1;
    }

    // [P2.2] `slice::sort*` pulls in driftsort_main whose ~4160-byte stack
    // frame blows the 4KB BPF stack ("Stack offset of 4104 exceeded max
    // offset of 4096"). Positions are at most 27 distinct u32s, so in-place
    // insertion sort is both small and O(n·max)=O(27²) — negligible CU.
    for i in 1..positions.len() {
        let v = positions[i];
        let mut j = i;
        while j > 0 && positions[j - 1] > v {
            positions[j] = positions[j - 1];
            j -= 1;
        }
        positions[j] = v;
    }
    positions
}

/// Extend a transcript state by absorbing one additional 32-byte blob.
fn extend_transcript(state: &[u8; 32], blob: &[u8]) -> [u8; 32] {
    hashv(&[state, blob]).to_bytes()
}

/// Extend transcript with the raw bytes of a field-element coefficient vector.
#[allow(dead_code)]
fn extend_transcript_with_felts(state: &[u8; 32], felts: &[Felt]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(felts.len() * 8);
    for f in felts {
        buf.extend_from_slice(&f.to_le_bytes());
    }
    hashv(&[state, &buf]).to_bytes()
}

/// [H9 + P1.1 PR 2] Derive query positions. Grinding seed now binds:
///   trace_root || quotient_root || pub_bytes || ood_current || ood_next
///   then extended with each FRI layer root and the final FRI polynomial.
///
/// **[P1.6]** FRI roots + final poly arrive as flat byte slices (borrowed from
/// the proof buffer) to avoid materializing `Vec<[u8;32]>` / `Vec<Felt>` on the
/// 32KB BPF heap. Roots are absorbed in 32-byte chunks; the final-poly bytes
/// are already LE-encoded felts so we absorb them directly.
fn derive_query_positions_generic(
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    pub_bytes: &[u8],
    ood_current: &[u64],
    ood_next: &[u64],
    ood_quotient_bytes: &[u8],
    fri_layer_roots_bytes: &[u8],
    fri_final_poly_bytes: &[u8],
    grinding_nonce: u64,
    lde_size: usize,
    num_queries: usize,
) -> Result<Vec<u32>, VerifyError> {
    let mut state = build_base_seed(trace_root, quotient_root, pub_bytes, ood_current, ood_next, ood_quotient_bytes);
    for layer_root in fri_layer_roots_bytes.chunks_exact(32) {
        state = extend_transcript(&state, layer_root);
    }
    state = extend_transcript(&state, fri_final_poly_bytes);
    let query_seed = verify_grinding(&state, grinding_nonce, crate::compact_proof::GRINDING_BITS)?;
    Ok(derive_positions_from_seed(&query_seed, lde_size, num_queries))
}

fn verify_query_positions_generic(
    proof: &GenericCompactProof,
    expected: &[u32],
) -> Result<(), VerifyError> {
    // [B1] Was `<`. Free to tighten: an honest proof always emits exactly
    // `config.num_queries`. `<` let a prover ship EXTRA queries, an
    // attacker-chosen CU multiplier (the parser caps num_queries at 256) that the
    // new per-query DEEP arithmetic amplifies. The legacy path already gates on
    // the constant.
    if proof.queries.len() != expected.len() {
        return Err(VerifyError::InsufficientQueries);
    }
    for (i, query) in proof.queries.iter().enumerate() {
        if i < expected.len() && query.position != expected[i] {
            return Err(VerifyError::InvalidQueryPosition);
        }
    }
    Ok(())
}

/// [B1] Domain tag for the DEEP linearisation coefficient. Exact twin of the
/// prover's `DEEP_COEFF_TAG` (stark/src/compact.rs).
const DEEP_COEFF_TAG: &[u8; 8] = b"deep-v1\0";

/// [B1] Derive the DEEP linearisation coefficient gamma. Exact twin of the
/// prover's `derive_deep_coeff`; both callees already existed on both sides, so
/// this is zero new hash code.
///
/// gamma is sampled strictly AFTER all three OOD arrays are absorbed
/// (`build_base_seed` takes them) and off the FRI alpha chain (its own domain
/// tag), so `alpha_0 = derive_fri_alpha(base_seed)` is unchanged and no existing
/// transcript order is disturbed.
fn derive_deep_coeff(base_seed: &[u8; 32]) -> Felt {
    derive_fri_alpha(&extend_transcript(base_seed, DEEP_COEFF_TAG))
}

/// [P1.1 PR 3] Derive a single FRI fold challenge α_i from the transcript.
/// Must match the prover: sha256(state)[0..8] as u64 mod p, mapping 0 → 1.
fn derive_fri_alpha(state: &[u8; 32]) -> Felt {
    let hash_bytes = hashv(&[state]).to_bytes();
    let mut alpha = u64::from_le_bytes(
        hash_bytes[0..8].try_into().unwrap(),
    ) % GOLDILOCKS_PRIME;
    if alpha == 0 {
        alpha = 1;
    }
    Felt::new(alpha)
}

/// [P1.1 PR 3] Evaluate a polynomial (coefficient form) at a point using
/// Horner's method. Coefficients are in ascending order (c[0] is the
/// constant term). Used for the last FRI fold check where the destination
/// value is not Merkle-committed but sent as `final_poly`.
#[allow(dead_code)]
fn evaluate_poly_horner(coeffs: &[Felt], x: Felt) -> Felt {
    let mut result = Felt::ZERO;
    for coeff in coeffs.iter().rev() {
        result = result.mul(x).add(*coeff);
    }
    result
}

/// [P1.6] Horner evaluation directly on a flat LE-byte buffer of felts.
/// Avoids materializing a `Vec<Felt>` when the final poly is borrowed from
/// the proof buffer via `GenericCompactProof::fri_final_poly_bytes()`.
fn evaluate_poly_horner_bytes(coeffs_bytes: &[u8], x: Felt) -> Felt {
    let mut result = Felt::ZERO;
    for chunk in coeffs_bytes.chunks_exact(8).rev() {
        let arr: [u8; 8] = chunk.try_into().unwrap();
        let coeff = Felt::from_le_bytes(arr);
        result = result.mul(x).add(coeff);
    }
    result
}

/// [B1] Reject a final polynomial whose degree exceeds the circuit's MEASURED
/// bound.
///
/// Compares the REDUCED felt, not the raw bytes: `MODULUS` is a legal `u64` that
/// reduces to zero, so the two checks are not the same check. (The parser also
/// refuses non-canonical encodings, so this is belt and braces on the same hole
/// from the other side.)
fn check_final_poly_degree_bound(
    final_poly_bytes: &[u8],
    degree_bound: usize,
) -> Result<(), VerifyError> {
    // [C7 2026-08-24] FAIL CLOSED WHEN THE BOUND SWALLOWS THE WHOLE POLYNOMIAL.
    //
    // The loop below skips coefficients `0..degree_bound` and checks the rest
    // are zero. With `degree_bound >= n_coeffs` it skips EVERY coefficient and
    // returns Ok(()) unconditionally: no error, no log, no test. The FRI rate
    // rho is `bound / fri_final_poly_size`, so that state is rho = 1 and this
    // terminal test is worth exactly zero bits.
    //
    // Nothing else covers it. `GenericCompactProof::from_bytes` validates
    // `fri_final_poly_size` and never reads this field, so the parser cannot
    // catch a bad value. The observable tuple in
    // `no_two_configs_share_the_tuple_the_parser_can_observe` does not include
    // it either, so no existing test goes red.
    //
    // Unreachable while every config is sane; it exists because C7 is the first
    // circuit in this crate's history to set the bound above 1, and the
    // realistic drift path is an honest rebake that fails with
    // `FriFinalPolyDegreeTooHigh` on every proof and whose obvious-looking fix
    // is to raise this literal until it stops complaining.
    let n_coeffs = final_poly_bytes.len() / 8;
    if degree_bound >= n_coeffs {
        return Err(VerifyError::FriFinalPolyDegreeTooHigh);
    }

    for (i, chunk) in final_poly_bytes.chunks_exact(8).enumerate() {
        if i < degree_bound {
            continue;
        }
        let arr: [u8; 8] = chunk.try_into().unwrap();
        if Felt::from_le_bytes(arr) != Felt::ZERO {
            // [L13 2026-08-03, CORRECTED 2026-08-25] CONSIDERED AND DELIBERATELY
            // LEFT — but for one of the three reasons the original note gave,
            // not all three. `degree_bound` is `config`-derived, so this is
            // structurally the same class as the `step2a` line.
            //
            // 🚨 THE ORIGINAL NOTE SAID "the bound is 1 on all seven circuits,
            // so the number is constant across the anonymity set". THAT IS NO
            // LONGER TRUE, AND IT WAS ALREADY UNTRUE WHEN IT WAS LAST READ:
            // `CONFIG_SPEND` sets the bound to 2, and the C7 paragraph THIRTY
            // LINES ABOVE THIS ONE says C7 "is the first circuit in this crate's
            // history to set the bound above 1". Two statements in one function
            // contradicting each other, and the stale one was being quoted as
            // the reason C7 could not join `PROBE_ORDER` (lib.rs).
            //
            // 🚨 The note also cited `ELF_B1_MARKERS` in
            // `packages/stark-prover/scripts/deployed-verifier-check.mjs` as the
            // cost of deleting this line, and a 2026-08-25 measurement recorded
            // here that the file did not exist on this branch, on master, or
            // anywhere in this repository. THAT MEASUREMENT IS NOW STALE:
            // commit `ce45f47d` recovered the script from
            // `b7-drop-aligned-checks`, and it is present in this tree today.
            // `ELF_B1_MARKERS` is defined in it (~line 353) as exactly two
            // literals — `"[verify] final poly coeff "` and
            // `" non-zero, bound is "` — which are the two halves of the `msg!`
            // at the bottom of this block. The script scans the DEPLOYED
            // verifier's ELF for them, and finding both is the only signal it
            // has that the deployment is `b1+` rather than `pre-b1`. So this
            // half of the justification is live again, not describing an absent
            // gate: deleting this `msg!` blinds that cross-language interlock,
            // and the script's own header says not to widen the marker list to
            // clear a red there.
            //
            // WHAT ACTUALLY JUSTIFIES LEAVING IT, and it is sufficient on its
            // own: this is an ERROR path. It runs only on the
            // `FriFinalPolyDegreeTooHigh` return, and every write and every
            // verify on a `ProofBuffer` is `has_one = authority` plus a
            // `Signer`, so no third party can make another user's proof fail
            // here. An honest proof never emits it, and the only observer who
            // can trigger it is the one who already knows which circuit they
            // were proving.
            anchor_lang::prelude::msg!(
                "[verify] final poly coeff {} non-zero, bound is {}",
                i,
                degree_bound
            );
            return Err(VerifyError::FriFinalPolyDegreeTooHigh);
        }
    }
    Ok(())
}

/// [B4] Verify one **pair-leaf** Merkle opening.
///
/// The quotient LDE and every committed FRI layer are committed as
/// `leaf[j] = SHA256(v[j].to_le_bytes() ‖ v[j + N/2].to_le_bytes())` over `N/2`
/// leaves. A FRI fold at position `p` consumes exactly `v[j]` and `v[j + N/2]`
/// with `j = p mod (N/2)` — both halves of one leaf — so a single depth-
/// `(log2(N) - 1)` path authenticates both values. Pre-B4 this cost two
/// depth-`log2(N)` paths plus two leaf hashes.
///
/// `lo` MUST be the low-half value and `hi` the high-half value: the leaf hash
/// cannot depend on which side of the mirror the query landed on, or the tree
/// would not be well defined. Any disagreement with the prover about the
/// ordering or about `j` changes the leaf hash / the walked path and the root
/// check fails — this function has no way to accept a mismatched indexing.
#[inline]
fn verify_pair_leaf(
    root: &[u8; 32],
    lo: Felt,
    hi: Felt,
    pair_index: usize,
    path: &[u8],
) -> bool {
    let mut leaf = [0u8; 16];
    leaf[..8].copy_from_slice(&lo.as_u64().to_le_bytes());
    leaf[8..].copy_from_slice(&hi.as_u64().to_le_bytes());
    merkle::verify_merkle_path(root, &leaf, pair_index, path)
}

/// [P1.1 PR 3] FRI query phase verification.
///
/// For every query, walks the fold chain from the quotient LDE (f_0) through
/// each committed layer (f_1..f_{L-1}) to the final polynomial (f_L):
///
/// 1. **Merkle openings** — verifies paths for the quotient mirror opening
///    and each FRI layer's (value, mirror) pair against the corresponding
///    committed root.
/// 2. **Fold consistency** — at each fold i, recomputes
///    `f_{i+1}(y²) = (f_i(y)+f_i(-y))/2 + α_i · (f_i(y)-f_i(-y))/(2y)`
///    using the opened values and the transcript-derived α_i, and checks it
///    against the actual f_{i+1} value:
///      - layers `0..L-1`: Merkle-opened in fri_layer_roots[i]
///      - layer `L-1 → L` (final): polynomial evaluation of `fri_final_poly`
///        at `gen_L^pos_low`
///
/// This ties every committed layer to the one before, forcing the prover's
/// quotient LDE to be close to a low-degree polynomial.
fn verify_fri_generic(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    pub_bytes: &[u8],
) -> Result<(), VerifyError> {
    // [P2.2] `fri_final_poly_size` is per-circuit (see CircuitConfig). It is 16 on
    // ALL SEVEN circuits today — do not repeat the old comment here that said
    // "circuit 6 uses 64", nor the one in compact_proof.rs that said 256. Both
    // were wrong against the constant.
    let num_folds = (config.lde_size / config.fri_final_poly_size).trailing_zeros() as usize;
    let num_fri_layers = num_folds - 1;
    if proof.num_fri_layers() != num_fri_layers {
        return Err(VerifyError::FriFoldCheckFailed);
    }

    // [B1] TERMINAL DEGREE BOUND, once per proof, before the query loop.
    //
    // Without this the terminal FRI test is worth ZERO bits: the 16 published
    // coefficients span the full interpolation space of the 16 folded evaluations
    // the query loop compares against, so a prover who folds his own function
    // honestly and publishes its true interpolant always passes. Costs <= 8 u64
    // comparisons. The parser pins `fri_final_poly_size` to the config value and
    // range-checks every coefficient, so the field cannot be widened and a
    // non-canonical `MODULUS` cannot masquerade as a zero here.
    check_final_poly_degree_bound(
        proof.fri_final_poly_bytes(),
        config.fri_final_poly_degree_bound,
    )?;

    // Re-derive α_0..α_{L-1} from the transcript. The initial state matches
    // the prover's `build_base_seed` output; each committed layer root is
    // absorbed in commit-phase order (layer i absorbed BEFORE α_{i+1} derived).
    let ood_current_u64: Vec<u64> = proof.ood_current_iter().map(|f| f.as_u64()).collect();
    let ood_next_u64: Vec<u64> = proof.ood_next_iter().map(|f| f.as_u64()).collect();
    let base_seed = build_base_seed(
        &proof.trace_root,
        &proof.quotient_root,
        pub_bytes,
        &ood_current_u64,
        &ood_next_u64,
        proof.ood_quotient_bytes(),
    );
    // [B1] gamma from the PRE-layer-root seed, before the alpha loop mutates it.
    let gamma = derive_deep_coeff(&base_seed);
    let mut state = base_seed;
    let mut alphas = Vec::with_capacity(num_folds);
    for i in 0..num_folds {
        alphas.push(derive_fri_alpha(&state));
        if i < num_fri_layers {
            state = extend_transcript(&state, proof.fri_layer_root(i));
        }
    }

    // [P2.2 profiling fix] Two-level inv_gen lookup: base table × step table.
    //
    // Prior design: single `inv_gen_0^k` table of min(half_lde, 2048) entries.
    // For circuit 6 (half_lde=4096) this required 2047 Goldilocks muls at init,
    // which on BPF costs ~442K CU (~216 CU/mul) — 32% of the 1.4M budget,
    // enough to push verification past the cap on its own.
    //
    // New design: a small base table (INV_GEN_BASE_SIZE=256 entries) and a
    // stepper table holding inv_gen_0^(256·j) for j=0..INV_GEN_STEP_SIZE-1.
    // STEP_SIZE is chosen so that BASE_SIZE × STEP_SIZE ≥ half_lde, covering
    // every possible k. Lookup for arbitrary k < half_lde:
    //   y_inv = base_table[k & 0xFF] · step_table[k >> 8]
    // Setup cost: 255 + (STEP_SIZE - 1) muls — for circuit 6 that's 255+15=270
    // muls (~58K CU), a ~384K-CU saving versus the old design.
    // Per-query cost: +1 mul per fold (since every k≥256 needs the step lookup,
    // which is ~93.75% of lookups for circuit 6). 22 × 9 × ~216 CU ≈ 42K CU.
    // Net saving: ~342K CU. Circuits 0-5 (half_lde ≤ 2048) still pay the same
    // extra mul but their setup shrinks too — small net win or neutral.
    const INV_GEN_BASE_SIZE: usize = 256;
    let gen_0 = get_lde_generator(config.lde_size)?;
    let inv_gen_0 = gen_0.inv();
    let half_lde = config.lde_size / 2;
    let base_size = half_lde.min(INV_GEN_BASE_SIZE);
    let inv_gen_0_powers: Vec<Felt> = {
        let mut v = Vec::with_capacity(base_size);
        v.push(Felt::ONE);
        for _ in 1..base_size {
            let prev = v[v.len() - 1];
            v.push(prev.mul(inv_gen_0));
        }
        v
    };
    // step_base = inv_gen_0^BASE_SIZE = last_entry · inv_gen_0. Used to build
    // the stepper table step_table[j] = step_base^j for j=0..step_count-1,
    // where step_count = ceil(half_lde / base_size). Covers all k < half_lde.
    let step_base = if half_lde > base_size {
        inv_gen_0_powers[base_size - 1].mul(inv_gen_0)
    } else {
        Felt::ONE // unused; step table will have length 1
    };
    let step_count = if base_size == 0 { 1 } else { half_lde.div_ceil(base_size) };
    let inv_gen_step_table: Vec<Felt> = {
        let mut v = Vec::with_capacity(step_count);
        v.push(Felt::ONE);
        for _ in 1..step_count {
            let prev = v[v.len() - 1];
            v.push(prev.mul(step_base));
        }
        v
    };
    // Final-layer generator for Horner evaluation. gen_final = gen_0^(2^num_folds).
    // Only used in the final (non-committed) layer, ≤ NUM_QUERIES times total.
    let mut gen_final = gen_0;
    for _ in 0..num_folds {
        gen_final = gen_final.mul(gen_final);
    }

    let two_inv = Felt::new(2).inv();

    // ========================================================================
    // [B1] DEEP composition setup, once per proof (~3w + 3 muls).
    //
    // FRI folds D, not Q. See `deep_composition_lde` in stark/src/compact.rs for
    // the full construction and the binding argument; this is its verifier twin
    // and the two are written in the same shape so they can be diffed by eye.
    //
    //   S(x)   = SUM_c gamma^(c+1) * T_c(x)
    //   A0     = SUM_c gamma^(c+1) * a_c ,  B0 = SUM_c gamma^(c+1) * b_c
    //   num(x) = ( S(x) - A0 - x*B0 ) + ( Q(x) - q_z ) * (x - zg)
    //   den(x) = (x - z)(x - zg)
    //   D(x)   = num(x) / den(x)
    //
    // with `A0 = SV - z*B0` and `B0 = (SV' - SV)/(zg - z)`, so the per-column
    // interpolants never have to be materialised.
    // ========================================================================
    let trace_g = get_trace_generator(config.trace_length)?;
    let z = proof.ood_z;
    let zg = z.mul(trace_g);
    let deep_s = z.add(zg);
    let deep_pz = z.mul(zg);
    // [B2] gamma^1 ..= gamma^(width + k). Powers width+1 ..= width+k are the
    // SEGMENT coefficients: one per segment, never shared and never collapsed
    // into a single batched value, or the segments stop being independently
    // bound and deg(D) reverts to deg(Q). Exact twin of `deep_composition_lde`.
    let width = config.trace_width;
    let ksegs = config.quotient_segments;
    if proof.ood_quotient_len() != ksegs {
        return Err(VerifyError::OodConstraintFailed);
    }
    let mut gamma_pows: Vec<Felt> = Vec::with_capacity(width + ksegs);
    {
        let mut g_pow = gamma;
        for _ in 0..width + ksegs {
            gamma_pows.push(g_pow);
            g_pow = g_pow.mul(gamma);
        }
    }
    let mut sv = Felt::ZERO;
    let mut svp = Felt::ZERO;
    for (c, gp) in gamma_pows.iter().take(width).enumerate() {
        sv = sv.add(gp.mul(proof.ood_current(c)));
        svp = svp.add(gp.mul(proof.ood_next(c)));
    }

    // PASS 1: per-query domain point and the two denominators, then ONE batched
    // inversion for the whole proof.
    //
    // The batching is LOAD-BEARING, not an optimisation. Four independent Fermat
    // inversions per query would be 4 * 127 = 508 muls/query — on C6 that is
    // 11,176 muls, ~2.4M CU, over the 1.4M cap on the DEEP arithmetic alone.
    let nq = proof.queries.len();
    let mut deep_scratch: Vec<(Felt, Felt, Felt)> = Vec::with_capacity(nq); // (y, d_lo, d_hi)
    let mut batch_in: Vec<Felt> = Vec::with_capacity(nq + 1);
    for query in proof.queries.iter() {
        let pos = query.position as usize;
        let j = pos & (half_lde - 1);
        // y = G^j, obtained WITHOUT a forward power table: G has order
        // N = 2*half, so G^half = -1 and therefore G^j = -inv_G^(half - j). For
        // j in [1, half-1] the index half-j lies in [1, half-1], inside the
        // two-level table's coverage. j == 0 would need index `half`, which is
        // OUT OF RANGE, hence the explicit special case — a BPF panic is not a
        // clean VerifyError.
        let y = if j == 0 {
            // [B7] y at position 0 is h, not 1. On the raw subgroup it was g^0
            // = 1; on the coset the domain starts at h. The else-branch below
            // already carries the shift, so leaving this arm at ONE breaks
            // exactly and only the queries that land on position 0 or its
            // mirror — which is what `legacy_c0_honest_proofs_cover_the_j_zero
            // _and_high_half_query_positions` exists to catch, and did.
            Felt::new(LDE_COSET_SHIFT)
        } else {
            let k = half_lde - j;
            let r = k & (INV_GEN_BASE_SIZE - 1);
            let qi = k >> INV_GEN_BASE_SIZE.trailing_zeros();
            // [B7] `t` is 1/x at this position. The table is a DECOMPOSED powers
            // table -- inv_gen^k as inv_gen_0_powers[r] * inv_gen_step_table[qi]
            // -- so the coset factor goes on the RESULT, never inside the table:
            // 1/(h*g^k) = h^(-1) * g^(-k). Folding it into entry 0 would corrupt
            // r = 0 and leave every other r unshifted, which is a subtler wrong
            // than omitting it.
            //
            // h^(-1) and not h^(-2^k): this is the LAYER-0 inverse, and `y2 =
            // y.mul(y)` below squares it for each subsequent layer, which is the
            // same per-layer squaring `fri_commit_phase` does prover-side.
            let t = (if qi == 0 {
                inv_gen_0_powers[r]
            } else {
                inv_gen_0_powers[r].mul(inv_gen_step_table[qi])
            })
            .mul(Felt::new(LDE_COSET_SHIFT));
            Felt::ZERO.sub(t)
        };
        let y2 = y.mul(y);
        let sy = deep_s.mul(y);
        // den(y) = y^2 - s*y + pz ; den(-y) = y^2 + s*y + pz — shares y^2 and s*y.
        let d_lo = y2.sub(sy).add(deep_pz);
        let d_hi = y2.add(sy).add(deep_pz);
        batch_in.push(d_lo.mul(d_hi));
        deep_scratch.push((y, d_lo, d_hi));
    }
    batch_in.push(zg.sub(z));
    let mut batch_out = vec![Felt::ZERO; batch_in.len()];
    if !batch_inverse(&batch_in, &mut batch_out) {
        // LIVENESS, not soundness: z or z*g landed in the LDE domain, so D has a
        // pole at a queried point. ~2^-50; the honest prover asserts against it.
        return Err(VerifyError::DeepDenominatorZero);
    }
    let b0 = svp.sub(sv).mul(batch_out[nq]);
    let a0 = sv.sub(z.mul(b0));

    // PASS 2.
    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;

        // [B4] Layer 0 (the quotient LDE) pair, in canonical (lo, hi) order.
        // The pair leaf itself was Merkle-checked in `verify_merkle_proofs_generic`
        // — one opening there now binds both halves, so there is no separate
        // mirror path to check here any more.
        let half0 = config.lde_size / 2;

        // [B1] Route C's payoff. The wire ships (row_at_pos, row_at_mirror); the
        // fold wants (low-half, high-half). Getting this backwards verifies for
        // pos < half and fails for pos >= half — a ~50% flake that looks like a
        // prover bug. Same rule as `verify_merkle_proofs_generic` uses for the
        // pair leaf, and the same rule the quotient swap above uses.
        let (y, d_lo, d_hi) = deep_scratch[query_idx];
        let inv_p = batch_out[query_idx];
        let inv_lo = inv_p.mul(d_hi);
        let inv_hi = inv_p.mul(d_lo);

        let mut s_lo = Felt::ZERO;
        let mut s_hi = Felt::ZERO;
        for (c, gp) in gamma_pows.iter().take(width).enumerate() {
            let (t_lo, t_hi) = if pos < half0 {
                (query.trace_value(c), query.trace_mirror_value(c))
            } else {
                (query.trace_mirror_value(c), query.trace_value(c))
            };
            s_lo = s_lo.add(gp.mul(t_lo));
            s_hi = s_hi.add(gp.mul(t_hi));
        }

        // [B2] SUM_j gamma^(width+1+j) * (Q_j(x) - Q_j(z)), accumulated for both
        // halves of the coset before the shared (x - zg) factor.
        let mut sq_lo = Felt::ZERO;
        let mut sq_hi = Felt::ZERO;
        for (j, gp) in gamma_pows.iter().skip(width).enumerate() {
            let q_at_pos = proof.quotient_value(query_idx, j, ksegs);
            let q_mirror = query.quotient_mirror_value(j);
            let (q_lo, q_hi) = if pos < half0 {
                (q_at_pos, q_mirror)
            } else {
                (q_mirror, q_at_pos)
            };
            let q_z_j = proof.ood_quotient(j);
            sq_lo = sq_lo.add(gp.mul(q_lo.sub(q_z_j)));
            sq_hi = sq_hi.add(gp.mul(q_hi.sub(q_z_j)));
        }

        let y_b0 = y.mul(b0);
        // At x = y the linear term is -y*B0; at x = -y it is +y*B0.
        let brk_lo = s_lo.sub(a0).sub(y_b0);
        let brk_hi = s_hi.sub(a0).add(y_b0);
        let qt_lo = sq_lo.mul(y.sub(zg));
        let qt_hi = sq_hi.mul(Felt::ZERO.sub(y).sub(zg));
        let mut f_lo = brk_lo.add(qt_lo).mul(inv_lo);
        let mut f_hi = brk_hi.add(qt_hi).mul(inv_hi);

        // **[P1.6 CU fix]** Single-pass Merkle + fold verification.
        // The old two-loop form called `query.fri_value(i)`/etc inside each loop;
        // each accessor re-walked the interleaved block prefix O(i) — O(L²) total
        // per query. With ~12 layers × 27 queries that blew past the 1.4M CU cap.
        // Here `fri_block_iter()` hops one layer at a time via a cursor (O(1) per
        // step), and we merge the two loops so layer data is consumed exactly once.
        let mut fri_iter = query.fri_block_iter();

        for i in 0..num_folds {
            // Fold consistency at layer i. `j` is simultaneously the pair index
            // of this query in layer i AND the exponent of y in the fold
            // identity: `pos mod size_i` and its mirror both reduce to it.
            let half_i = config.lde_size >> (i + 1);
            let j = pos & (half_i - 1);

            // [P2.2] Two-level inv_gen^k lookup. k = j << i, guaranteed
            // < half_lde. Decompose as k = base_size·q + r, then
            //   inv_gen_0^k = inv_gen_0^r · (inv_gen_0^base_size)^q
            //             = base_table[r] · step_table[q]
            // For circuit 6 (base_size=256), ~94% of folds take the step path.
            let k = j << i;
            let r = k & (INV_GEN_BASE_SIZE - 1);
            let q = k >> INV_GEN_BASE_SIZE.trailing_zeros();
            // [B7] Coset factor, and it is NOT h^(-1) here.
            //
            // This path indexes the LAYER-0 table with `k = j << i`, i.e. it maps
            // the layer-`i` position straight back to a layer-0 exponent instead
            // of squaring a running value. So the table already supplies
            // g^(-j*2^i), and what is missing is the shift raised to the SAME
            // power: layer `i` lives on h^(2^i) * <g^(2^i)>, so the inverse point
            // carries h^(-2^i).
            //
            // The generic path above needs only h^(-1) because it squares `y`
            // per layer. Copying h^(-1) into here would be correct at layer 0 and
            // silently wrong at every layer after it — the exact shape of bug
            // that still yields a proof, just one that verifies against the wrong
            // polynomial.
            let mut shift_inv_layer = Felt::new(LDE_COSET_SHIFT_INV);
            for _ in 0..i {
                shift_inv_layer = shift_inv_layer.mul(shift_inv_layer);
            }
            let y_inv = (if q == 0 {
                inv_gen_0_powers[r]
            } else {
                inv_gen_0_powers[r].mul(inv_gen_step_table[q])
            })
            .mul(shift_inv_layer);
            // f_lo = f_i(y), f_hi = f_i(-y) — canonical pair ordering means no
            // swap is needed here.
            let sum = f_lo.add(f_hi);
            let diff = f_lo.sub(f_hi);
            let even = sum.mul(two_inv);
            let odd = diff.mul(two_inv).mul(y_inv);
            let expected_next = even.add(alphas[i].mul(odd));

            let actual_next = if i < num_fri_layers {
                // [B4] ONE pair opening per committed layer yields both halves
                // of the next layer's coset.
                let (lo, hi, path) = fri_iter.next().ok_or(VerifyError::FriFoldCheckFailed)?;
                let half_next = half_i / 2;
                if !verify_pair_leaf(
                    proof.fri_layer_root(i),
                    lo,
                    hi,
                    pos & (half_next - 1),
                    path,
                ) {
                    return Err(VerifyError::MerkleProofFailed);
                }
                // f_{i+1} at index `pos mod size_{i+1}` — and size_{i+1} = half_i,
                // so that index is exactly `j`. It sits in the low half of the
                // next layer iff j < half_next.
                let v = if j < half_next { lo } else { hi };
                f_lo = lo;
                f_hi = hi;
                v
            } else {
                // Final layer only (i == num_folds - 1), j < fri_final_poly_size.
                let x = gen_final.exp(j as u64);
                evaluate_poly_horner_bytes(proof.fri_final_poly_bytes(), x)
            };

            if expected_next.as_u64() != actual_next.as_u64() {
                // [B1] Name WHICH mechanism rejected. Against an adversary who
                // folds his own composition honestly, every intermediate check
                // passes with probability 1 and ALL soundness lives in the
                // terminal comparison — so a test that accepts "any error" would
                // not distinguish a working binding from a broken one.
                return Err(if i == num_fri_layers {
                    VerifyError::FriTerminalCheckFailed
                } else {
                    VerifyError::FriFoldCheckFailed
                });
            }
        }
    }

    Ok(())
}

/// [P1.1 PR 3] FRI verification for the legacy `CompactStarkProof` (circuit 0).
fn verify_fri_legacy(
    proof: &CompactStarkProof,
    commitment: Felt,
) -> Result<(), VerifyError> {
    const LEGACY_LDE: usize = LDE_SIZE;
    let num_folds = (LEGACY_LDE / FRI_FINAL_POLY_SIZE).trailing_zeros() as usize;
    let num_fri_layers = num_folds - 1;
    if proof.num_fri_layers() != num_fri_layers {
        return Err(VerifyError::FriFoldCheckFailed);
    }

    // [B1] TERMINAL DEGREE BOUND — see verify_fri_generic. C0's bound is 7, not
    // 8: its AIR carries ONE periodic factor where C1..C6 carry two.
    check_final_poly_degree_bound(
        proof.fri_final_poly_bytes(),
        crate::compact_proof::LEGACY_FRI_FINAL_POLY_DEGREE_BOUND,
    )?;

    let commitment_bytes = commitment.to_le_bytes();
    let ood_current_u64: Vec<u64> = proof.ood_current.iter().map(|f| f.as_u64()).collect();
    let ood_next_u64: Vec<u64> = proof.ood_next.iter().map(|f| f.as_u64()).collect();
    let base_seed = build_base_seed(
        &proof.trace_root,
        &proof.quotient_root,
        &commitment_bytes,
        &ood_current_u64,
        &ood_next_u64,
        proof.ood_quotient_bytes(),
    );
    // [B1] gamma from the PRE-layer-root seed. Same derivation as the generic
    // path; this is the SOLE verifier for four shipped instructions
    // (zk_shielded::{pause,resume,cancel_private_stark} and
    // p01_quantum_wallet), so a generic-only B1 would leave them exactly as
    // forgeable as before.
    let gamma = derive_deep_coeff(&base_seed);
    let mut state = base_seed;
    let mut alphas = Vec::with_capacity(num_folds);
    for i in 0..num_folds {
        alphas.push(derive_fri_alpha(&state));
        if i < num_fri_layers {
            state = extend_transcript(&state, proof.fri_layer_root(i));
        }
    }

    // [P1.6] inv_gen_0 powers table — see generic version for derivation.
    let gen_0 = get_lde_generator(LEGACY_LDE)?;
    let inv_gen_0 = gen_0.inv();
    let half_lde = LEGACY_LDE / 2;
    let mut inv_gen_0_powers: Vec<Felt> = Vec::with_capacity(half_lde);
    // [B7] Entry 0 is 1/y at position 0. On the raw subgroup y_0 = g^0 = 1; on
    // the coset y_0 = h, so this table starts at h^(-1). Same shape as the
    // prover's `inv_y` in `fri_fold_layer` — the two must agree or the fold
    // check disagrees on every query, which is exactly the FriFoldCheckFailed
    // this replaces.
    inv_gen_0_powers.push(Felt::ONE);
    for _ in 1..half_lde {
        let prev = inv_gen_0_powers[inv_gen_0_powers.len() - 1];
        inv_gen_0_powers.push(prev.mul(inv_gen_0));
    }
    let mut gen_final = gen_0;
    for _ in 0..num_folds {
        gen_final = gen_final.mul(gen_final);
    }

    let two_inv = Felt::new(2).inv();

    // ========================================================================
    // [B1] DEEP composition setup, legacy shape. Term for term identical to
    // `verify_fri_generic`; the differences are all shape, not algebra:
    //   * the inverse table is a FLAT 256-entry array over k < half = 256, so
    //     `-inv_table[256 - j]` works with no two-level split (G has order 512,
    //     so G^256 = -1);
    //   * ood_current / ood_next are [Felt; 3];
    //   * the trace generator is the GENERATOR_32 constant, so zg is one mul.
    // ========================================================================
    let trace_g = Felt::new(GENERATOR_32);
    let z = proof.ood_z;
    let zg = z.mul(trace_g);
    let deep_s = z.add(zg);
    let deep_pz = z.mul(zg);
    // [B2] gamma^1 ..= gamma^(TRACE_WIDTH + LEGACY_QUOTIENT_SEGMENTS). Twin of
    // the generic path: one power per trace column, then one per quotient
    // segment, never shared.
    const KSEGS: usize = crate::compact_proof::LEGACY_QUOTIENT_SEGMENTS;
    let mut gamma_pows = [Felt::ZERO; TRACE_WIDTH + KSEGS];
    {
        let mut g_pow = gamma;
        for slot in gamma_pows.iter_mut() {
            *slot = g_pow;
            g_pow = g_pow.mul(gamma);
        }
    }
    let mut sv = Felt::ZERO;
    let mut svp = Felt::ZERO;
    for (c, gp) in gamma_pows.iter().take(TRACE_WIDTH).enumerate() {
        sv = sv.add(gp.mul(proof.ood_current[c]));
        svp = svp.add(gp.mul(proof.ood_next[c]));
    }

    // PASS 1 — see the generic twin for why the batching is load-bearing.
    let nq = proof.queries.len();
    let mut deep_scratch: Vec<(Felt, Felt, Felt)> = Vec::with_capacity(nq);
    let mut batch_in: Vec<Felt> = Vec::with_capacity(nq + 1);
    for query in proof.queries.iter() {
        let pos = query.position as usize;
        let j = pos & (half_lde - 1);
        let y = if j == 0 {
            // [B7] y at position 0 is h, not 1. On the raw subgroup it was g^0
            // = 1; on the coset the domain starts at h. The else-branch below
            // already carries the shift, so leaving this arm at ONE breaks
            // exactly and only the queries that land on position 0 or its
            // mirror — which is what `legacy_c0_honest_proofs_cover_the_j_zero
            // _and_high_half_query_positions` exists to catch, and did.
            Felt::new(LDE_COSET_SHIFT)
        } else {
            // [B7] h^(-1) on the RESULT. Layer 0; `y2 = y.mul(y)` squares it
            // for later layers, matching the prover.
            Felt::ZERO.sub(inv_gen_0_powers[half_lde - j].mul(Felt::new(LDE_COSET_SHIFT)))
        };
        let y2 = y.mul(y);
        let sy = deep_s.mul(y);
        let d_lo = y2.sub(sy).add(deep_pz);
        let d_hi = y2.add(sy).add(deep_pz);
        batch_in.push(d_lo.mul(d_hi));
        deep_scratch.push((y, d_lo, d_hi));
    }
    batch_in.push(zg.sub(z));
    let mut batch_out = vec![Felt::ZERO; batch_in.len()];
    if !batch_inverse(&batch_in, &mut batch_out) {
        return Err(VerifyError::DeepDenominatorZero);
    }
    let b0 = svp.sub(sv).mul(batch_out[nq]);
    let a0 = sv.sub(z.mul(b0));

    // PASS 2.
    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;

        // [B4] Layer-0 pair in canonical (lo, hi) order. The quotient pair leaf
        // is Merkle-checked in `verify_merkle_proofs_legacy`.
        let half0 = LEGACY_LDE / 2;

        // [B1] Route C's legacy mirror accessors had ZERO consumers before this.
        // Same (lo, hi) rule as `verify_merkle_proofs_legacy` uses for the pair
        // leaf — see the generic twin for why getting it backwards is the single
        // most likely implementation bug here.
        let (y, d_lo, d_hi) = deep_scratch[query_idx];
        let inv_p = batch_out[query_idx];
        let inv_lo = inv_p.mul(d_hi);
        let inv_hi = inv_p.mul(d_lo);

        let mut s_lo = Felt::ZERO;
        let mut s_hi = Felt::ZERO;
        for (c, gp) in gamma_pows.iter().take(TRACE_WIDTH).enumerate() {
            let (t_lo, t_hi) = if pos < half0 {
                (query.trace_value(c), query.trace_mirror_value(c))
            } else {
                (query.trace_mirror_value(c), query.trace_value(c))
            };
            s_lo = s_lo.add(gp.mul(t_lo));
            s_hi = s_hi.add(gp.mul(t_hi));
        }

        // [B2] SUM_j gamma^(TRACE_WIDTH+1+j) * (Q_j(x) - Q_j(z)).
        let mut sq_lo = Felt::ZERO;
        let mut sq_hi = Felt::ZERO;
        for (j, gp) in gamma_pows.iter().skip(TRACE_WIDTH).enumerate() {
            let q_at_pos = proof.quotient_value(query_idx, j);
            let q_mirror = query.quotient_mirror_value(j);
            let (q_lo, q_hi) = if pos < half0 {
                (q_at_pos, q_mirror)
            } else {
                (q_mirror, q_at_pos)
            };
            let q_z_j = proof.ood_quotient(j);
            sq_lo = sq_lo.add(gp.mul(q_lo.sub(q_z_j)));
            sq_hi = sq_hi.add(gp.mul(q_hi.sub(q_z_j)));
        }

        let y_b0 = y.mul(b0);
        let brk_lo = s_lo.sub(a0).sub(y_b0);
        let brk_hi = s_hi.sub(a0).add(y_b0);
        let qt_lo = sq_lo.mul(y.sub(zg));
        let qt_hi = sq_hi.mul(Felt::ZERO.sub(y).sub(zg));
        let mut f_lo = brk_lo.add(qt_lo).mul(inv_lo);
        let mut f_hi = brk_hi.add(qt_hi).mul(inv_hi);

        // **[P1.6 CU fix]** Same single-pass pattern as `verify_fri_generic`.
        let mut fri_iter = query.fri_block_iter();

        for i in 0..num_folds {
            let half_i = LEGACY_LDE >> (i + 1);
            let j = pos & (half_i - 1);

            // [P1.6] O(1) table lookup replaces inv_gen_per_layer[i].exp(j).
            // [B7] Indexed by `j << i`, i.e. the layer-`i` position mapped back
            // to a layer-0 exponent, so the table already gives g^(-j*2^i) and
            // what is missing is the shift at the SAME power: layer `i` lives
            // on h^(2^i) * <g^(2^i)>. Using h^(-1) here would be right at
            // layer 0 and silently wrong at every layer after it.
            let mut shift_inv_layer = Felt::new(LDE_COSET_SHIFT_INV);
            for _ in 0..i {
                shift_inv_layer = shift_inv_layer.mul(shift_inv_layer);
            }
            let y_inv = inv_gen_0_powers[j << i].mul(shift_inv_layer);
            let sum = f_lo.add(f_hi);
            let diff = f_lo.sub(f_hi);
            let even = sum.mul(two_inv);
            let odd = diff.mul(two_inv).mul(y_inv);
            let expected_next = even.add(alphas[i].mul(odd));

            let actual_next = if i < num_fri_layers {
                let (lo, hi, path) = fri_iter.next().ok_or(VerifyError::FriFoldCheckFailed)?;
                let half_next = half_i / 2;
                if !verify_pair_leaf(
                    proof.fri_layer_root(i),
                    lo,
                    hi,
                    pos & (half_next - 1),
                    path,
                ) {
                    return Err(VerifyError::MerkleProofFailed);
                }
                let v = if j < half_next { lo } else { hi };
                f_lo = lo;
                f_hi = hi;
                v
            } else {
                let x = gen_final.exp(j as u64);
                evaluate_poly_horner_bytes(proof.fri_final_poly_bytes(), x)
            };

            if expected_next.as_u64() != actual_next.as_u64() {
                // [B1] See verify_fri_generic: the terminal comparison is the one
                // that carries the soundness, so it gets its own variant.
                return Err(if i == num_fri_layers {
                    VerifyError::FriTerminalCheckFailed
                } else {
                    VerifyError::FriFoldCheckFailed
                });
            }
        }
    }

    Ok(())
}

fn verify_merkle_proofs_generic(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
) -> Result<(), VerifyError> {
    let half = config.lde_size / 2;
    for (query_idx, query) in proof.queries.iter().enumerate() {
        // [ROUTE C] The trace tree is committed as PAIR leaves, exactly as B4 did
        // for the quotient tree and every FRI layer:
        //
        //     leaf[j] = H(0x00 ‖ row[j] ‖ row[j + lde_size/2])   over lde_size/2 leaves
        //
        // ONE depth-(merkle_depth - 1) opening therefore authenticates the row at
        // `position` AND the row at `position ^ (lde_size/2)`. Pre-Route-C this was
        // a depth-merkle_depth opening that bound the row at `position` only.
        //
        // This changes NO soundness property: the mirror row is authenticated and
        // then not read. It is the coset partner a later DEEP-composition
        // recomputation needs, made available without a second opening.
        //
        // WARNING, two parts, and the second is the one that gets forgotten:
        // Route C is format-breaking (old proofs do not verify here, new proofs do
        // not verify on an old verifier — both fail closed, see
        // `tests/route_c_trace_pair.rs`), AND it DOUBLES raw witness exposure on a
        // trace-aligned query. `blowup` divides `lde/2`, so an aligned position has
        // an aligned mirror: an unlucky query now puts FOUR genuine trace rows on
        // the wire instead of two, and the extra two are different trace rows
        // (`r + trace_length/2`), not copies. COMPUTED: ~82% of C0/C1/C2/C4 proofs
        // and ~76% of C3/C5/C6 proofs contain at least one aligned query. The LDE
        // has no coset offset yet, so that is a 2x amplification of a LIVE leak —
        // the coset fix is a hard predecessor for Route C reaching a deployed
        // verifier. See `build_trace_pair_merkle_tree` in stark/src/compact.rs.
        //
        // [P1.6] The rows are hashed straight out of the proof buffer — no copy
        // into a Vec. `hash_leaf_2seg` concatenates the two segments inside the
        // syscall, so the digest is bit-identical to the prover's contiguous
        // `sha256_leaf(row_lo ‖ row_hi)`.
        //
        // `lo` MUST be the low-half row and `hi` the high-half row: the leaf hash
        // cannot depend on which side of the mirror the query landed on. The wire
        // always ships (row_at_pos, row_at_mirror) in that order, so the verifier
        // swaps when `pos >= half`. `position` is transcript-bound, so a prover
        // cannot choose which side it lands on.
        let pos = query.position as usize;
        let (lo, hi) = if pos < half {
            (query.trace_values_bytes(), query.trace_mirror_values_bytes())
        } else {
            (query.trace_mirror_values_bytes(), query.trace_values_bytes())
        };
        if !merkle::verify_merkle_path_2seg(
            &proof.trace_root,
            lo,
            hi,
            pos & (half - 1),
            query.merkle_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        // [ROUTE C] Same for the next row. `next_pos = pos + blowup` is never the
        // mirror of `pos` (the mirror is `pos + lde_size/2`, and
        // `lde_size/2 >= 16 * blowup` on every shipping config), so this is a
        // genuinely different pair leaf and both openings are needed. It is,
        // however, the SAME leaf that holds `next(mirror(pos))`, because
        // `mirror(next_pos) = pos + blowup + lde/2 = next(mirror(pos))`.
        let next_pos = (pos + config.blowup) % config.lde_size;
        let (nlo, nhi) = if next_pos < half {
            (query.next_trace_values_bytes(), query.next_trace_mirror_values_bytes())
        } else {
            (query.next_trace_mirror_values_bytes(), query.next_trace_values_bytes())
        };
        if !merkle::verify_merkle_path_2seg(
            &proof.trace_root,
            nlo,
            nhi,
            next_pos & (half - 1),
            query.next_merkle_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        // [B2] `quotient_segments` felts per side instead of one. The leaf
        // preimage widens from 16 bytes to 16k; the tree keeps `merkle_depth - 1`
        // levels, which is why segmentation costs 8k bytes per query and not k
        // Merkle paths. Both halves are already contiguous, wire-ordered blocks,
        // so they hash in place with no copy.
        let ksegs = config.quotient_segments;
        if (query_idx + 1) * ksegs > proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let q_block = proof.quotient_values_block(query_idx, ksegs);
        let q_mirror_block = query.quotient_mirror_bytes();
        let (qlo, qhi) = if pos < half {
            (q_block, q_mirror_block)
        } else {
            (q_mirror_block, q_block)
        };
        if !merkle::verify_merkle_path_2seg(
            &proof.quotient_root,
            qlo,
            qhi,
            pos & (half - 1),
            query.quotient_pair_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }
    }
    Ok(())
}

/// Apply one Poseidon round: state' = MDS * sbox(state + RC)
fn poseidon_round(state: &[Felt; 3], rc: &[Felt; 3]) -> [Felt; 3] {
    let s0 = state[0].add(rc[0]);
    let s1 = state[1].add(rc[1]);
    let s2 = state[2].add(rc[2]);

    let sb0 = s0.pow7();
    let sb1 = s1.pow7();
    let sb2 = s2.pow7();

    let three = Felt::new(3);
    [
        three.mul(sb0).add(sb1).add(sb2),
        sb0.add(three.mul(sb1)).add(sb2),
        sb0.add(sb1).add(three.mul(sb2)),
    ]
}

/// [C6] Verify boundary constraints at trace-aligned query positions.
///
/// For each query that lands on a trace-aligned position corresponding to
/// a boundary assertion row, verify the trace value matches the expected
/// public input value.
/// ⚠️ THE WHOLE BODY IS DEAD, AND THE ALLOWS BELONG ON THE FUNCTION.
///
/// The `#[allow(unreachable_code)]` inside the body scopes to the inner block
/// only, so rustc still warned about the statement AND about every parameter
/// the disabled body stopped reading. `cargo clippy -p p01_stark_verifier --
/// -D warnings` is a CI gate (.github/workflows/ci.yml), and MEASURED
/// 2026-08-26 it failed with exit 101 on six errors from exactly these two
/// functions -- two `unreachable statement`, four `unused variable`.
///
/// The parameters are kept rather than underscored on purpose: this arm is
/// disabled, not deleted, and re-enabling it means restoring the body, not
/// rediscovering what it took.
#[allow(unreachable_code, unused_variables)]
fn verify_boundary_constraints(
    proof: &GenericCompactProof,
    circuit_id: u8,
    config: &CircuitConfig,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    let assertions = get_boundary_assertions(circuit_id, public_inputs)?;
    if assertions.is_empty() {
        return Ok(());
    }

    for query in &proof.queries {
        // [B7] DISABLED. Same shape as the transition arms: it reads the
        // opened value AS A RAW TRACE ROW at an aligned position, which only
        // holds while the LDE sits on the raw subgroup. With x = h * g^i an
        // aligned position is not a trace row, so the comparison is
        // meaningless rather than merely useless.
        //
        // Nothing is lost: the boundary is enforced at the OOD point on
        // EVERY proof by the boundary fold -- `fold_boundary_quotient`
        // prover-side and `boundary_fold_at_ood` here -- which is exactly
        // what the C2/C4 binding work wired and what was deployed to devnet
        // on 2026-08-03. This per-query arm was the redundant half.
        #[allow(unreachable_code)]
        {
            continue;
        }

        let trace_row = (query.position as usize / config.blowup) % config.trace_length;

        for assertion in &assertions {
            if trace_row == assertion.row && assertion.col < query.trace_width() {
                if query.trace_value(assertion.col) != assertion.value {
                    return Err(VerifyError::BoundaryConstraintFailed);
                }
            }
        }
    }

    Ok(())
}

/// [C6] Legacy boundary constraint verification for circuit 0.
/// ⚠️ THE WHOLE BODY IS DEAD, AND THE ALLOWS BELONG ON THE FUNCTION.
///
/// The `#[allow(unreachable_code)]` inside the body scopes to the inner block
/// only, so rustc still warned about the statement AND about every parameter
/// the disabled body stopped reading. `cargo clippy -p p01_stark_verifier --
/// -D warnings` is a CI gate (.github/workflows/ci.yml), and MEASURED
/// 2026-08-26 it failed with exit 101 on six errors from exactly these two
/// functions -- two `unreachable statement`, four `unused variable`.
///
/// The parameters are kept rather than underscored on purpose: this arm is
/// disabled, not deleted, and re-enabling it means restoring the body, not
/// rediscovering what it took.
#[allow(unreachable_code, unused_variables)]
fn verify_boundary_constraints_legacy(
    proof: &CompactStarkProof,
    commitment: Felt,
) -> Result<(), VerifyError> {
    for query in &proof.queries {
        // [B7] DISABLED, legacy twin of the generic boundary arm. It reads
        // the opened value as a RAW TRACE ROW at an aligned position, which
        // only holds while the LDE sits on the raw subgroup.
        //
        // The boundary is enforced at the OOD point on EVERY proof by the
        // boundary fold (`fold_boundary_quotient` prover-side, the `bnd-c0`
        // tag here), which is what the C2/C4 binding work wired and what was
        // deployed to devnet on 2026-08-03. This arm was the redundant half.
        #[allow(unreachable_code)]
        {
            continue;
        }

        let trace_row = (query.position as usize / BLOWUP) % TRACE_LENGTH;

        // state[1] at row 0 = 0
        if trace_row == 0 {
            if query.trace_value(1) != Felt::ZERO {
                return Err(VerifyError::BoundaryConstraintFailed);
            }
            if query.trace_value(2) != Felt::ZERO {
                return Err(VerifyError::BoundaryConstraintFailed);
            }
        }

        // state[0] at row 30 = commitment
        if trace_row == NUM_ROUNDS {
            if query.trace_value(0) != commitment {
                return Err(VerifyError::BoundaryConstraintFailed);
            }
        }
    }

    Ok(())
}

// ============================================================================
// [P1.1 PR 4] DEEP-ALI quotient check at OOD
// ============================================================================

/// Evaluate a pre-baked periodic column polynomial at a point using Horner's
/// method. Coefficients are in ascending order (`c[0]` is the constant term);
/// values stored as `u64` and lifted to `Felt` at evaluation time.
///
/// `#[inline(never)]` — kept out of line because several callers pass long
/// slices; a dedicated frame avoids inlining a copy per call site. Circuits 3
/// and 6 no longer use it (see `eval_periodic_ext_at_z`); C0/C1/C2/C4/C5 still
/// do, for the columns that are neither stride-sparse nor cheaply Lagrangeable.
#[inline(never)]
fn eval_periodic_at_z(coeffs: &[u64], z: Felt) -> Felt {
    let mut acc = Felt::ZERO;
    for &c in coeffs.iter().rev() {
        acc = acc.mul(z).add(Felt::new(c));
    }
    acc
}

/// [P2.2g] Evaluate a stride-16 periodic column polynomial at `z`.
///
/// # Why a dedicated routine
/// The periodic polynomials for circuits over the 512-row trace domain with
/// 32-row cycles have a special structure: the only non-zero monomial
/// coefficients sit at indices that are multiples of 16 (= trace_length /
/// cycle_length). Proof: such a polynomial P is invariant under x → x·g^32
/// (because f(g^i) depends only on i mod 32). Forcing P(x) = P(x·g^32) on
/// every monomial gives `c_j · (1 − g^{32j}) = 0` for all j. Since g has
/// order 512, `g^{32j} = 1` iff `j ≡ 0 (mod 16)`, which makes every other
/// coefficient vanish. Empirically confirmed against the baked periodic
/// tables (`C3_*_COEFFS`, `C5_*_COEFFS`, `C6_*_COEFFS`).
///
/// # Cost model
/// Standard Horner on 512 coefficients costs 512 muls. Collapsing to
/// `P(z) = Σ_{k=0}^{31} c_{16k} · y^k` with `y = z^{16}` costs:
///   - 4 muls (repeated-squaring to compute `z^16`)
///   - 32 muls for Horner on the compressed coefficient view.
/// Net: 36 muls vs 512 — ~14× speedup on the dominant component of
/// `verify_deep_ali_circuit_5` (23 periodic columns ≈ ~1.4M CU at naive
/// Horner but ~160k CU here).
///
/// # Safety
/// Callers must pass a polynomial that is genuinely stride-16 sparse. The
/// `debug_assert` below catches accidental use against dense arrays in
/// tests; production builds skip the check.
///
/// (Its `#[inline(never)]` sits directly above its own `fn` below. Do not park
/// an attribute here: A3 inserted `eval_periodic_stride_at_z` between this doc
/// comment and its function, which silently re-attached the attribute to the
/// wrong item and left this one with none. rustc reports that as an unused
/// attribute that will become a hard error.)
/// Evaluate a stride-`s` periodic column at `z`, for any power-of-two stride.
///
/// Same idea as `eval_periodic_stride16_at_z`, generalised: when only indices
/// divisible by `s` are non-zero, the polynomial is `Σ c[k·s]·x^(k·s)`, i.e. a
/// polynomial in `y = z^s` with `len/s` coefficients. One `exp` plus `len/s - 1`
/// Horner steps replaces `len - 1` steps.
///
/// # Safety of the sparsity assumption
/// This does NOT check sparsity at runtime — a scan would cost exactly what the
/// routine saves. The tables are compile-time constants, so the assumption is
/// pinned by `periodic_stride_parity` in `tests/periodic_stride.rs`, which runs
/// in **release** mode and compares against the dense evaluator.
///
/// That test exists because of a real hazard: `eval_periodic_stride16_at_z`
/// guards its sparsity with `#[cfg(debug_assertions)]` only, so a release build
/// handed a dense array silently evaluates a *different polynomial* with no
/// error. Never wire a new table here without extending that test.
#[inline]
fn eval_periodic_stride_at_z(coeffs: &[u64], z: Felt, stride: usize) -> Felt {
    debug_assert!(stride > 0 && coeffs.len() % stride == 0);
    #[cfg(debug_assertions)]
    {
        for (i, &c) in coeffs.iter().enumerate() {
            if i % stride != 0 {
                debug_assert_eq!(c, 0, "stride-{} violation at index {}", stride, i);
            }
        }
    }

    let y = z.exp(stride as u64);
    let compressed = coeffs.len() / stride;
    let mut acc = Felt::ZERO;
    let mut k = compressed;
    while k > 0 {
        k -= 1;
        acc = acc.mul(y).add(Felt::new(coeffs[k * stride]));
    }
    acc
}

#[inline(never)]
/// [C5-N1024] The stride-32 twin, for a circuit whose trace is 1024 rows.
///
/// A 32-periodic column interpolated over a domain of size `n` is sparse at
/// stride `n / 32`. At n = 512 that is 16 and at n = 1024 it is 32, so the two
/// functions differ ONLY in the stride and in the exponent of `z` — both still
/// read exactly 32 compressed coefficients and both still cost 32 Horner steps.
///
/// ⛔ WRITTEN AS A SEPARATE FUNCTION RATHER THAN A GENERIC, ON PURPOSE. The
/// stride is `n / 32`, so a generic over the array length would let a caller
/// pass a 512-long table and get a silently wrong evaluation if the constant
/// were ever mis-derived. Two functions, two array types, and the type checker
/// refuses the mix.
fn eval_periodic_stride32_at_z(coeffs: &[u64; 1024], z: Felt) -> Felt {
    // Paranoia in tests: non-stride positions must be zero.
    #[cfg(debug_assertions)]
    {
        for (i, &c) in coeffs.iter().enumerate() {
            if i % 32 != 0 {
                debug_assert_eq!(c, 0, "stride-32 violation at index {}", i);
            }
        }
    }

    let y = z.exp(32);
    let mut acc = Felt::ZERO;
    // Horner over the 32 compressed coefficients c[0], c[32], ..., c[992].
    let mut k = 32;
    while k > 0 {
        k -= 1;
        acc = acc.mul(y).add(Felt::new(coeffs[k * 32]));
    }
    acc
}

fn eval_periodic_stride16_at_z(coeffs: &[u64; 512], z: Felt) -> Felt {
    // Paranoia in tests: non-stride positions must be zero.
    #[cfg(debug_assertions)]
    {
        for (i, &c) in coeffs.iter().enumerate() {
            if i % 16 != 0 {
                debug_assert_eq!(c, 0, "stride-16 violation at index {}", i);
            }
        }
    }

    let y = z.exp(16);
    let mut acc = Felt::ZERO;
    // Horner over the 32 compressed coefficients c[0], c[16], c[32], ..., c[496].
    let mut k = 32;
    while k > 0 {
        k -= 1;
        acc = acc.mul(y).add(Felt::new(coeffs[k * 16]));
    }
    acc
}

/// [P2.2g] Montgomery's batch inversion: invert N elements with one real
/// inversion + 2(N-1) multiplications, instead of N × ~63 muls for Fermat.
///
/// Given inputs `a_0, ..., a_{N-1}` (none zero), the routine writes
/// `a_i^{-1}` into `out`. The trick walks forward accumulating the running
/// product `p_i = a_0 · ... · a_i`, inverts the final `p_{N-1}`, and walks
/// backward peeling off factors.
///
/// Returns `false` if any input is zero (caller should reject the proof).
#[inline(never)]
fn batch_inverse(inputs: &[Felt], out: &mut [Felt]) -> bool {
    debug_assert_eq!(inputs.len(), out.len());
    let n = inputs.len();
    if n == 0 {
        return true;
    }

    // Forward scan: out[i] = a_0 · a_1 · ... · a_i.
    out[0] = inputs[0];
    for i in 1..n {
        if inputs[i] == Felt::ZERO {
            return false;
        }
        out[i] = out[i - 1].mul(inputs[i]);
    }
    if out[0] == Felt::ZERO {
        return false;
    }

    // One real inversion on the total product.
    let mut running_inv = out[n - 1].inv();

    // Backward scan: peel factors.
    for i in (1..n).rev() {
        let prev_inv = running_inv.mul(inputs[i]);
        out[i] = running_inv.mul(out[i - 1]);
        running_inv = prev_inv;
    }
    out[0] = running_inv;
    true
}

/// [P2.2g] Evaluate a one-hot periodic at `z` using the Lagrange closed form.
///
/// For a polynomial `P` of degree < N that is 1 on `g^k` and 0 on every
/// other element of the size-N multiplicative subgroup `<g>`:
///
/// ```text
/// P(x) = g^k · (x^N − 1) / (N · (x − g^k))
/// ```
///
/// With shared inputs `z_n_minus_one = z^N − 1` and `inv_n = 1/N` precomputed
/// once, and `(z − g^k)^{-1}` obtained via `batch_inverse` over all hot
/// positions, each call costs exactly 3 muls (no per-column Horner of 512
/// coefficients, no per-column Fermat inversion). Dominant speedup:
/// ~500× vs dense Horner for the 17 single-hot flag columns in circuit 5.
#[inline(always)]
fn eval_one_hot_lagrange(
    g_k: Felt,
    z_n_minus_one: Felt,
    inv_z_minus_g_k: Felt,
    inv_n: Felt,
) -> Felt {
    g_k.mul(z_n_minus_one).mul(inv_z_minus_g_k).mul(inv_n)
}

// ============================================================================
// [A4] Periodic-extension evaluation for circuits 3 and 6
// ============================================================================
//
// Both merkle AIRs gate every periodic column on `active_rows = depth * 32 =
// 480`, zero-filling trace cycle 15 (rows 480..=511). That truncation destroys
// 32-periodicity, so the baked interpolants are 512/512 dense (coefficient-index
// gcd 1) and neither stride evaluator applies: 7 columns × 512 muls per circuit
// dominates DEEP-ALI phase 2.
//
// The 32-periodic *extension* of each column IS stride-16 sparse (32 non-zero
// coefficients, gcd 16 — verified against every table in
// `tests/periodic_stride.rs`), and differs from the real column on exactly the
// 32 rows 480..=511, which are shared by all seven columns. Hence
//
//     P_actual(z) = P_periodic(z) − Σ_{j=0}^{31} TAIL[j] · L_{480+j}(z)
//     L_r(z)      = g^r · (z^N − 1) / (N · (z − g^r)),  N = 512
//
// an algebraic identity on the same polynomial: no AIR change, no trace change,
// no wire-format change, zero soundness cost. One `batch_inverse(32)` produces
// the Lagrange weights for the whole circuit; each column then costs a 32-step
// Horner in `z^16` plus one mul-add per non-zero tail entry.

/// `1/512` in Goldilocks. Baked rather than computed: `Felt::inv` is a
/// Fermat exponentiation (~96 muls) and this value is constant. Pinned by
/// `a4_inv_512_is_correct` in `tests/periodic_stride.rs`.
const INV_512: u64 = 18_410_715_272_404_008_961;

/// First row of the truncated cycle. `depth * 32` for the canonical depth 15,
/// which both circuits reject any other value of before reaching here.
const CYCLE15_START: u64 = 480;

/// [A4] Lagrange weights `L_{480+j}(z)` for the 32 truncated rows, shared by
/// all seven periodic columns of a merkle circuit.
///
/// `y16` must be `z^16`; `z^512` is recovered from it with 5 squarings rather
/// than a second `exp`.
///
/// Returns `None` if `z` coincides with one of those 32 trace rows. The caller
/// rejects, matching the existing degenerate-OOD policy in
/// `boundary_fold_at_ood` and `compute_c5_periodic_at_z`: it can only reject
/// proofs (never accept a bad one), and a random OOD hits the set with
/// probability 32/2^64.
#[inline(never)]
fn cycle15_lagrange_weights(z: Felt, y16: Felt) -> Option<[Felt; 32]> {
    let g = Felt::new(GENERATOR_512);

    // z^512 = (z^16)^32
    let mut z_n = y16;
    for _ in 0..5 {
        z_n = z_n.mul(z_n);
    }
    // k = (z^512 − 1) / 512, the factor common to every L_r.
    let k = z_n
        .sub(Felt::ONE)
        .mul(Felt::new(INV_512));

    let mut g_pows = [Felt::ZERO; 32];
    let mut diffs = [Felt::ZERO; 32];
    let mut g_r = g.exp(CYCLE15_START);
    for j in 0..32 {
        g_pows[j] = g_r;
        let d = z.sub(g_r);
        if d == Felt::ZERO {
            return None;
        }
        diffs[j] = d;
        g_r = g_r.mul(g);
    }

    let mut inv_diffs = [Felt::ZERO; 32];
    if !batch_inverse(&diffs, &mut inv_diffs) {
        return None;
    }

    let mut out = [Felt::ZERO; 32];
    for j in 0..32 {
        out[j] = k.mul(g_pows[j]).mul(inv_diffs[j]);
    }
    Some(out)
}

/// [A4] Evaluate one truncated periodic column at `z` from its periodic
/// extension plus the shared Lagrange correction.
///
/// `periodic16` holds the 32 stride-16 compressed coefficients of the
/// extension; `tail` holds the extension's values on rows 480..=511, which the
/// real column zeroes. Zero tail entries are skipped — `HASH_START` and
/// `IS_BOUNDARY` deviate on a single row each, so the branch pays for itself.
///
/// Like `eval_periodic_stride_at_z`, this performs no runtime validation of the
/// constants: both arrays are re-derived from the dense tables and the identity
/// re-checked at random `z` by `tests/periodic_stride.rs`, in release mode.
#[inline(always)]
fn eval_periodic_ext_at_z(
    periodic16: &[u64; 32],
    tail: &[u64; 32],
    y16: Felt,
    lagrange: &[Felt; 32],
) -> Felt {
    // P_periodic(z) = Σ_k periodic16[k] · (z^16)^k, Horner in y16.
    let mut acc = Felt::ZERO;
    let mut k = 32;
    while k > 0 {
        k -= 1;
        acc = acc.mul(y16).add(Felt::new(periodic16[k]));
    }

    // − Σ_j TAIL[j] · L_{480+j}(z)
    let mut corr = Felt::ZERO;
    for j in 0..32 {
        let t = tail[j];
        if t != 0 {
            corr = corr.add(lagrange[j].mul(Felt::new(t)));
        }
    }

    acc.sub(corr)
}

/// [C7] The thirteen periodic columns at the OOD point `z`.
///
/// THREE EVALUATOR CLASSES, MEASURED not assumed -- the split is pinned by
/// `spend_periodic_classification_is_pinned_not_merely_emitted` in the prover
/// crate, which asserts the counts AND the one-hot rows.
///
///   0-6   stride-16, COMPRESSED `[u64; 32]`. `y16 = z^16` is computed once
///         here and shared by all seven, so the four squarings are paid once.
///   7-10  one-hot. No table at all: `eval_one_hot_lagrange` needs `g^k` and
///         three multiplications.
///   11-12 genuinely dense `[u64; 512]`. These two are 8,192 of C7's 9,984
///         bytes of rodata and the only columns on the expensive path. They
///         are the gates that switch every constraint off on rows 384..511.
///
/// ⛔ RETURNING FEWER THAN THIRTEEN IS THE FAILURE THAT HAS ALREADY HAPPENED
/// ONCE. `tests/c7_probe/src/lib.rs` models this as `[Felt; 10]` -- five
/// stride, five one-hot, ZERO dense -- because two doc blocks in the AIR
/// announced `periodic[0..13]` and then listed ten names. Dropping columns 11
/// and 12 removes the row gates, and every honest proof is rejected with the
/// failure pointing nowhere near the cause.
#[inline(never)]
fn compute_c7_periodic_at_z(z: Felt) -> Result<[Felt; 13], VerifyError> {
    use crate::periodic_consts::{
        C7_ACTIVE_COEFFS, C7_HASH_START_COEFFS, C7_IS_BOUNDARY_COEFFS,
        C7_IS_INTERIOR_COEFFS, C7_NOT_BOUNDARY_ACTIVE_COEFFS, C7_RC0_COEFFS,
        C7_RC1_COEFFS, C7_RC2_COEFFS, C7_ROUND_FLAG_COEFFS,
    };

    let g_512 = Felt::new(GENERATOR_512);
    // Baked, not `Felt::new(512).inv()`. C5 pays a Fermat exponentiation for a
    // value this file already holds as a constant.
    let inv_n = Felt::new(INV_512);

    // y16 = z^16, hoisted once for all seven compressed columns.
    let y16 = z.exp(16);
    // z^512 = (z^16)^32, five squarings.
    let mut z_n = y16;
    for _ in 0..5 {
        z_n = z_n.mul(z_n);
    }
    let z_n_minus_one = z_n.add(Felt::new(crate::goldilocks::MODULUS - 1));

    // One-hot rows in PERIODIC-INDEX order 7, 8, 9, 10 -- chain_flag,
    // commit_out_flag, row0_flag, hold_link_31. NOT the depth-15 set
    // [0, 30, 62, 94, 478] the CU probe carries.
    const FLAG_ROWS: [u64; 4] = [63, 94, 0, 31];
    let mut g_pows = [Felt::ZERO; 4];
    let mut diffs = [Felt::ZERO; 4];
    for i in 0..4 {
        let g_k = g_512.exp(FLAG_ROWS[i]);
        g_pows[i] = g_k;
        diffs[i] = z.add(Felt::new(crate::goldilocks::MODULUS - g_k.as_u64()));
    }
    let mut inv_diffs = [Felt::ZERO; 4];
    if !batch_inverse(&diffs, &mut inv_diffs) {
        // z landed on one of the four flag rows. Fails closed.
        return Err(VerifyError::DeepAliFailed);
    }

    Ok([
        eval_periodic_compressed32_at_z(&C7_RC0_COEFFS, y16),         //  0 rc0
        eval_periodic_compressed32_at_z(&C7_RC1_COEFFS, y16),         //  1 rc1
        eval_periodic_compressed32_at_z(&C7_RC2_COEFFS, y16),         //  2 rc2
        eval_periodic_compressed32_at_z(&C7_ROUND_FLAG_COEFFS, y16),  //  3 round_flag
        eval_periodic_compressed32_at_z(&C7_IS_BOUNDARY_COEFFS, y16), //  4 is_boundary
        eval_periodic_compressed32_at_z(&C7_HASH_START_COEFFS, y16),  //  5 hash_start
        eval_periodic_compressed32_at_z(&C7_IS_INTERIOR_COEFFS, y16), //  6 is_interior
        eval_one_hot_lagrange(g_pows[0], z_n_minus_one, inv_diffs[0], inv_n), //  7 chain_flag @63
        eval_one_hot_lagrange(g_pows[1], z_n_minus_one, inv_diffs[1], inv_n), //  8 commit_out @94
        eval_one_hot_lagrange(g_pows[2], z_n_minus_one, inv_diffs[2], inv_n), //  9 row0 @0
        eval_one_hot_lagrange(g_pows[3], z_n_minus_one, inv_diffs[3], inv_n), // 10 hold_link @31
        eval_periodic_at_z(&C7_ACTIVE_COEFFS, z),                     // 11 active (DENSE)
        eval_periodic_at_z(&C7_NOT_BOUNDARY_ACTIVE_COEFFS, z),        // 12 nba    (DENSE)
    ])
}

/// [C7] Stride-16 periodic evaluation from COMPRESSED coefficients.
///
/// `eval_periodic_stride16_at_z` takes `&[u64; 512]` and reads exactly 32 of
/// its entries -- indices 0, 16, 32, ..., 496. The other 480 are provably zero
/// and still occupy 3,840 bytes of rodata per column. C7 has seven such
/// columns, so the dense form would cost 26,880 bytes to say nothing.
///
/// Same arithmetic as the 512 form: a 32-step Horner in `y16 = z^16`. `y16` is
/// taken as an argument rather than computed, so a caller evaluating seven
/// columns pays the four squarings once instead of seven times.
///
/// ⛔ ADDITIVE ONLY. Do not "simplify" `eval_periodic_stride16_at_z` into this
/// one: its four C5 call sites are baked against shipped `[u64; 512]` tables,
/// and rebaking those is a redeploy.
#[inline(always)]
fn eval_periodic_compressed32_at_z(coeffs: &[u64; 32], y16: Felt) -> Felt {
    let mut acc = Felt::ZERO;
    let mut k = 32;
    while k > 0 {
        k -= 1;
        acc = acc.mul(y16).add(Felt::new(coeffs[k]));
    }
    acc
}

/// Vanishing polynomial `Z_D(z) = z^trace_length - 1` for the trace domain.
fn vanishing_poly_trace_length(z: Felt, trace_length: usize) -> Felt {
    let zn = z.exp(trace_length as u64);
    zn.add(Felt::new(crate::goldilocks::MODULUS - 1)) // zn + (-1) = zn - 1
}

// ============================================================================
// [C2] Boundary public-input binding at the OOD point z
// ============================================================================
//
// The prover folds, into the committed quotient Q, a boundary contribution
//   Q_bnd(x) = Σ_j alpha_bnd^j · (T_col_j(x) − v_j) / (x − g^{r_j})
// (a true polynomial, since `T_col_j(g^{r_j}) = v_j` for an honest trace).
// The DEEP-ALI identity the verifier checks is `C(z) == Q(z) · Z_T(z)`, so the
// matching boundary term that must be ADDED to the transition C(z) is
//   C_bnd(z) = Z_T(z) · Σ_j alpha_bnd^j · (ood_current[col_j] − v_j) · inv(z − g^{r_j}).
//
// This makes the public-input binding (commitment / nullifier / root → trace)
// fail at the random OOD point z on EVERY tampered proof, instead of only when
// a query happens to land on a trace-aligned row (~1/blowup of the time). The
// per-query `verify_boundary_constraints` stays as cheap defense-in-depth, but
// the OOD fold is the real security boundary.
//
// CU: one `batch_inverse` over the assertions (1 inv + 2(k-1) muls) plus a few
// muls per assertion. Worst case is circuit 5 with 24 assertions ≈ ~20-30K CU.

/// [C2] Compute `C_bnd(z) = z_t · Σ_j alpha_bnd^j · (ood_current[col_j] − v_j)
/// · inv(z − g^{r_j})`, the boundary contribution to the DEEP-ALI numerator at
/// the OOD point `z`. `z_t` is the transition-vanishing value `Z_T(z)`, `g` is
/// the per-circuit trace-domain generator. Returns `None` (caller must reject)
/// if `z` coincides with any boundary row `g^{r_j}` — a degenerate OOD that is
/// vanishingly rare over a random `z`.
///
/// The assertion list MUST be byte-identical (same order) to the prover's
/// `boundary_assertions_for_circuit`, so the `alpha_bnd^j` powers line up.
fn boundary_fold_at_ood(
    ood_current: &[Felt],
    assertions: &[BoundaryAssertion],
    z: Felt,
    z_t: Felt,
    g: Felt,
    alpha_bnd: Felt,
) -> Option<Felt> {
    let k = assertions.len();
    // [C7 2026-08-24] Was `Some(Felt::ZERO)`. An empty assertion list is not a
    // neutral element, it is a missing binding, and the caller cannot tell the
    // two apart through an `Option`.
    //
    // It matters more for C7 than for anything before it: the per-query
    // transition layer is dead on this lineage (`is_trace_aligned` is hardcoded
    // false at eight sites) and step 5 is gone, so for circuit 7 THIS FOLD
    // CARRIES THE ENTIRE PUBLIC-INPUT-TO-TRACE BINDING. Returning zero here
    // degenerates the DEEP-ALI identity to transition-only, and a proof whose
    // col 6 row 30 is not the declared nullifier and whose col 0 row 382 is not
    // the declared root would verify -- nullifier forgery plus fake subtree
    // membership, returning Ok with nothing logged.
    //
    // Behaviour-preserving today: every live arm builds a non-empty list.
    if k == 0 {
        return None;
    }
    // denoms[j] = z − g^{r_j}
    let mut denoms = [Felt::ZERO; 32]; // max assertions across circuits ≤ 24
    if k > denoms.len() {
        return None;
    }
    let neg = Felt::new(crate::goldilocks::MODULUS - 1);
    for (j, a) in assertions.iter().enumerate() {
        let g_r = g.exp(a.row as u64);
        let d = z.add(g_r.mul(neg)); // z − g^{r_j}
        if d == Felt::ZERO {
            return None; // OOD landed on a boundary row: reject.
        }
        denoms[j] = d;
    }
    let mut inv_denoms = [Felt::ZERO; 32];
    if !batch_inverse(&denoms[..k], &mut inv_denoms[..k]) {
        return None;
    }

    let mut acc = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for (j, a) in assertions.iter().enumerate() {
        if a.col >= ood_current.len() {
            return None;
        }
        // (T_col(z) − v) · inv(z − g^{r})
        let num = ood_current[a.col].add(a.value.mul(neg));
        let term = num.mul(inv_denoms[j]);
        acc = acc.add(alpha_pow.mul(term));
        alpha_pow = alpha_pow.mul(alpha_bnd);
    }
    // Multiply the whole boundary sum by Z_T(z) so it joins the transition
    // numerator C(z) on the LHS of `C(z) == Q(z) · Z_T(z)`.
    Some(acc.mul(z_t))
}

/// [P1.1 PR 4] Evaluate circuit 0 (subscriber_ownership) transition constraint
/// at the OOD point z. Matches prover's `evaluate_transition_constraint` in
/// `stark/src/compact.rs`: for each column i,
///   `c_i = next[i] - current[i] - flag(z) * (round_out[i] - current[i])`
/// where `round_out = MDS * sbox(current + RC(z))`. The combined constraint is
/// `c0 + c1 + c2`.
fn evaluate_transition_at_ood_circuit_0(
    ood_current: &[Felt],
    ood_next: &[Felt],
    z: Felt,
) -> Felt {
    let rc0_z = eval_periodic_at_z(&crate::periodic_consts::C0_RC0_COEFFS, z);
    let rc1_z = eval_periodic_at_z(&crate::periodic_consts::C0_RC1_COEFFS, z);
    let rc2_z = eval_periodic_at_z(&crate::periodic_consts::C0_RC2_COEFFS, z);
    let flag_z = eval_periodic_at_z(&crate::periodic_consts::C0_FLAG_COEFFS, z);

    let current = [ood_current[0], ood_current[1], ood_current[2]];
    let rc = [rc0_z, rc1_z, rc2_z];
    let round_out = poseidon_round(&current, &rc);

    // c_i = next[i] - current[i] - flag * (round_out[i] - current[i])
    let neg_one = Felt::new(crate::goldilocks::MODULUS - 1);
    let mut combined = Felt::ZERO;
    for i in 0..3 {
        let diff = ood_next[i].add(current[i].mul(neg_one));           // next - current
        let round_minus_curr = round_out[i].add(current[i].mul(neg_one)); // round_out - current
        let flag_term = flag_z.mul(round_minus_curr);
        let c_i = diff.add(flag_term.mul(neg_one));                    // diff - flag*(...)
        combined = combined.add(c_i);
    }
    combined
}

/// [P1.1 PR 4] Check the DEEP-ALI identity at the OOD point for circuit 0.
///
/// Enforces `C(T(z), T(g·z), z) == ood_quotient · Z_T(z)` where
/// `Z_T(z) = (z^n - 1) / (z - g^(n-1))` is the *transition* vanishing
/// polynomial (omitting the last row, so the wrap `trace[0]-trace[n-1]`
/// is not required to vanish). This matches the prover's quotient
/// computation in `stark/src/compact.rs`, which computes
/// `Q = C / Z_T` via polynomial division.
///
/// Tied with FRI's low-degree guarantee on the committed quotient LDE,
/// DEEP-ALI binds quotient correctness to the AIR evaluated on the
/// opened OOD trace (Schwartz–Zippel over a random z).
fn verify_deep_ali_legacy(proof: &CompactStarkProof, commitment: Felt) -> Result<(), VerifyError> {
    let z = proof.ood_z;
    let c_at_z = evaluate_transition_at_ood_circuit_0(&proof.ood_current, &proof.ood_next, z);
    // Z_T(z) = (z^n - 1) / (z - g^(n-1))
    let z_d = vanishing_poly_trace_length(z, TRACE_LENGTH);
    // Trace domain generator for circuit 0 (trace_length = 32) is the 32nd
    // root of unity, matching the prover's `get_trace_domain_generator`.
    let g = Felt::new(GENERATOR_32);
    let last_row_x = g.exp((TRACE_LENGTH - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    // If z happens to equal g^(n-1), the prover chose a degenerate OOD — treat
    // as a verification failure (vanishingly rare over a random OOD).
    if z_minus_last == Felt::ZERO {
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    // [C2] Add the boundary public-input binding to the numerator at z. This is
    // what forces a tampered commitment (or capacity zeros) to be rejected at
    // the OOD point on every proof — the live exploit for circuit 0. The prover
    // (`generate_compact_proof`) folds the matching boundary quotient into Q.
    let assertions = get_boundary_assertions(0, &[commitment.as_u64()])?;
    let alpha_bnd =
        derive_rlc_alpha_with_tag(&proof.trace_root, &commitment.to_le_bytes(), b"bnd-c0\0\0");
    let ood_current: [Felt; 3] = [proof.ood_current[0], proof.ood_current[1], proof.ood_current[2]];
    let c_bnd = boundary_fold_at_ood(&ood_current, &assertions, z, z_t, g, alpha_bnd)
        .ok_or(VerifyError::DeepAliFailed)?;
    let c_total = c_at_z.add(c_bnd);

    // [B2] Phase 2 constrains the RECOMBINED Q(z) = SUM_j z^(jn) Q_j(z), so
    // the segment claims are reassembled before the AIR identity is applied.
    let rhs = proof.ood_quotient_recombined().mul(z_t);
    if c_total != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

// ============================================================================
// [P2.2d] DEEP-ALI quotient check at OOD for circuit 0 (subscriber_ownership)
// ============================================================================
//
// Circuit 0 has a single combined transition constraint `c0 + c1 + c2` over
// the width-3 Poseidon-t3 state. The v2 generic prover computes
//     Q(x) = C(x) / Z_D(x)      where Z_D(x) = x^n - 1, n = 32
// so the verifier checks `C(z) == Q(z) · Z_D(z)` at the OOD point z.
//
// This closes the v2 soundness gap where `verify_quotient_at_query` at non-
// trace-aligned positions only range-checks Q(x) against the field modulus;
// FRI guarantees Q is low-degree but does NOT bind Q to the AIR. DEEP-ALI at
// a verifier-chosen random z binds Q to C via Schwartz–Zippel.
//
// CU budget: ~40K (4 periodic polys × 32 coeffs + 1 Poseidon round + Z_D),
// well within circuit 0's ~800K per-proof headroom.
#[inline(never)]
pub fn verify_deep_ali_circuit_0(proof: &GenericCompactProof) -> Result<(), VerifyError> {
    use crate::periodic_consts::{C0_RC0_COEFFS, C0_RC1_COEFFS, C0_RC2_COEFFS, C0_FLAG_COEFFS};

    // OOD trace values. Circuit 0 is width-3.
    let ood_current: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next: Vec<Felt> = proof.ood_next_iter().collect();
    if ood_current.len() != 3 || ood_next.len() != 3 {
        return Err(VerifyError::DeepAliFailed);
    }

    let z = proof.ood_z;

    // Evaluate the 4 periodic columns at z via Horner (~32 muls each).
    // Inlined inside `evaluate_transition_at_ood_circuit_0` — reuse it directly.
    let c_at_z = evaluate_transition_at_ood_circuit_0(&ood_current, &ood_next, z);
    // Silence unused-import warning: the coeff arrays are referenced transitively.
    let _ = (&C0_RC0_COEFFS, &C0_RC1_COEFFS, &C0_RC2_COEFFS, &C0_FLAG_COEFFS);

    // Z_D(z) = z^n - 1 with n = 32 (matches prover's `Q = C / (x^n - 1)`).
    const TRACE_LENGTH_C0: usize = 32;
    let z_d = vanishing_poly_trace_length(z, TRACE_LENGTH_C0);
    if z_d == Felt::ZERO {
        // OOD lands on a trace-domain root of unity: degenerate sampling.
        return Err(VerifyError::DeepAliFailed);
    }

    // [B2] Phase 2 constrains the RECOMBINED Q(z) = SUM_j z^(jn) Q_j(z), so
    // the segment claims are reassembled before the AIR identity is applied.
    let rhs = proof.ood_quotient_recombined(TRACE_LENGTH_C0).mul(z_d);
    if c_at_z != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

// ============================================================================
// [P2.2a] DEEP-ALI quotient check at OOD for circuit 6 (merkle_update)
// ============================================================================
//
// Circuit 6 enforces 19 independent transition constraints across a width-10
// trace (OLD Poseidon chain, NEW Poseidon chain, sibling + direction, and
// old/new carry columns). To check `Q(z) · Z_T(z) == C(z)` in a single field
// product, the verifier RLC-combines the 19 constraint evaluations at OOD with
// an α derived from `sha256(trace_root || pub_inputs || "rlc-v1\0\0")`.
//
// Mirrors the prover's `derive_rlc_alpha` and `compute_quotient_lde_circuit_6`
// in `stark/src/compact.rs`.

/// [P2.2a/P2.2f] Derive the RLC challenge α for circuit 6 from a Fiat-Shamir
/// transcript bound to the trace commitment and the public inputs.
///
/// Domain-separated from OOD (`""` prefix + trace+quotient roots) and FRI fold
/// challenges (`"fri-alpha-v1"`) so a malicious prover cannot alias one into
/// another. The `"rlc-v1\0\0"` suffix is padded to 8 bytes so the sha256 input
/// ends on an 8-byte boundary — matching the prover byte-for-byte.
#[inline(never)]
fn derive_rlc_alpha_with_tag(
    trace_root: &[u8; 32],
    pub_input_bytes: &[u8],
    tag: &[u8; 8],
) -> Felt {
    let mut buf = Vec::with_capacity(32 + pub_input_bytes.len() + 8);
    buf.extend_from_slice(trace_root);
    buf.extend_from_slice(pub_input_bytes);
    buf.extend_from_slice(tag);
    let h = hashv(&[&buf]).to_bytes();
    let mut a = u64::from_le_bytes(h[0..8].try_into().unwrap()) % GOLDILOCKS_PRIME;
    if a == 0 { a = 1; }
    Felt::new(a)
}

/// Circuit-6 RLC challenge (legacy tag `rlc-v1`, retained for byte-for-byte
/// parity with `stark::compact::derive_rlc_alpha`).
#[inline(never)]
fn derive_rlc_alpha(trace_root: &[u8; 32], pub_input_bytes: &[u8]) -> Felt {
    derive_rlc_alpha_with_tag(trace_root, pub_input_bytes, b"rlc-v1\0\0")
}

/// [P2.2a] Evaluate circuit 6's 19 transition constraints at the OOD point z
/// and RLC-combine them with α powers: `C(z) = Σ α^i · c_i(z)`.
///
/// Mirrors `evaluate_merkle_update_transition` in
/// `stark/src/air/merkle_update.rs`. Periodic layout matches the prover:
/// `[rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior]`.
/// `#[inline(never)]` — keep this large-stack helper in its own SBF frame so
/// `verify_deep_ali_circuit_6` stays under the 4KB per-frame cap.
#[inline(never)]
fn evaluate_transition_at_ood_circuit_6(
    ood_current: &[Felt],
    ood_next: &[Felt],
    periodic_at_z: &[Felt; 9],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_active = periodic_at_z[3];
    let hash_start = periodic_at_z[4];
    let is_boundary = periodic_at_z[5];
    let is_interior = periodic_at_z[6];
    let active = periodic_at_z[7];
    let nba = periodic_at_z[8]; // not_boundary_active

    let one = Felt::ONE;
    let three = Felt::new(3);
    // [C6-D12]  REPLACES ; it is not multiplied by it. As
    // functions on the trace domain the two agree everywhere except rows
    // 383..511; as POLYNOMIALS a product would add a THIRD periodic factor to
    // the degree-7 Poseidon constraints and take ce_blowup 8 -> 16.
    let hash_start_a = hash_start.mul(active);
    let is_boundary_a = is_boundary.mul(active);
    let is_interior_a = is_interior.mul(active);

    // ── OLD Poseidon round (cols 0-2) ──
    let o0 = ood_current[0].add(rc0);
    let o1 = ood_current[1].add(rc1);
    let o2 = ood_current[2].add(rc2);
    let o0_7 = o0.pow7();
    let o1_7 = o1.pow7();
    let o2_7 = o2.pow7();
    let oro0 = three.mul(o0_7).add(o1_7).add(o2_7);
    let oro1 = o0_7.add(three.mul(o1_7)).add(o2_7);
    let oro2 = o0_7.add(o1_7).add(three.mul(o2_7));

    let mut cs = [Felt::ZERO; 19];
    cs[0] = nba.mul(
        ood_next[0].sub(ood_current[0]).sub(round_active.mul(oro0.sub(ood_current[0])))
    );
    cs[1] = nba.mul(
        ood_next[1].sub(ood_current[1]).sub(round_active.mul(oro1.sub(ood_current[1])))
    );
    cs[2] = nba.mul(
        ood_next[2].sub(ood_current[2]).sub(round_active.mul(oro2.sub(ood_current[2])))
    );

    // ── NEW Poseidon round (cols 3-5) ──
    let n0 = ood_current[3].add(rc0);
    let n1 = ood_current[4].add(rc1);
    let n2 = ood_current[5].add(rc2);
    let n0_7 = n0.pow7();
    let n1_7 = n1.pow7();
    let n2_7 = n2.pow7();
    let nro0 = three.mul(n0_7).add(n1_7).add(n2_7);
    let nro1 = n0_7.add(three.mul(n1_7)).add(n2_7);
    let nro2 = n0_7.add(n1_7).add(three.mul(n2_7));
    cs[3] = nba.mul(
        ood_next[3].sub(ood_current[3]).sub(round_active.mul(nro0.sub(ood_current[3])))
    );
    cs[4] = nba.mul(
        ood_next[4].sub(ood_current[4]).sub(round_active.mul(nro1.sub(ood_current[4])))
    );
    cs[5] = nba.mul(
        ood_next[5].sub(ood_current[5]).sub(round_active.mul(nro2.sub(ood_current[5])))
    );

    // ── Hash start mux: state = mux(direction, carry, sibling) ──
    let dir = ood_current[7];
    let sib = ood_current[6];
    let old_carry = ood_current[8];
    let new_carry = ood_current[9];

    cs[6]  = hash_start_a.mul(ood_current[0].sub(old_carry).sub(dir.mul(sib.sub(old_carry))));
    cs[7]  = hash_start_a.mul(ood_current[1].sub(sib).sub(dir.mul(old_carry.sub(sib))));
    cs[8]  = hash_start_a.mul(ood_current[3].sub(new_carry).sub(dir.mul(sib.sub(new_carry))));
    cs[9]  = hash_start_a.mul(ood_current[4].sub(sib).sub(dir.mul(new_carry.sub(sib))));
    cs[10] = hash_start_a.mul(ood_current[2]);
    cs[11] = hash_start_a.mul(ood_current[5]);

    // ── Carry update at boundary ──
    cs[12] = is_boundary_a.mul(ood_next[8].sub(ood_current[0]));
    cs[13] = is_boundary_a.mul(ood_next[9].sub(ood_current[3]));

    // ── Carry continuity ──
    cs[14] = nba.mul(ood_next[8].sub(ood_current[8]));
    cs[15] = nba.mul(ood_next[9].sub(ood_current[9]));

    // ── Sibling / direction continuity within cycle ──
    cs[16] = is_interior_a.mul(ood_next[6].sub(ood_current[6]));
    cs[17] = is_interior_a.mul(ood_next[7].sub(ood_current[7]));

    // ── Direction binary ──
    cs[18] = hash_start_a.mul(dir).mul(one.sub(dir));

    // RLC: Σ α^i · cs[i]. Accumulated as a Horner-style walk keeps α_pow to a
    // single running multiplication per constraint (no array allocation).
    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// [P2.2a] Check the DEEP-ALI identity at the OOD point for circuit 6.
///
/// Computes:
///   1. α from the Fiat-Shamir transcript (`trace_root || pub_inputs`).
///   2. The 9 periodic polynomials evaluated at z: seven from their 32-entry
///      stride tables, two dense row gates shared with C7.
///   3. The 19 transition constraints evaluated on the opened OOD trace and
///      RLC-combined with α to produce `C(z)`.
///   4. `Z_T(z) = (z^n - 1) / (z - g^(n-1))` with `n = trace_length = 512`.
///   5. The identity `C(z) == Q(z) · Z_T(z)`.
///
/// Tied to FRI's low-degree guarantee on the committed quotient LDE (verified
/// in phase 1), this binds the full 19-constraint AIR to the opened OOD trace
/// via Schwartz–Zippel over a random z — closing the soundness gap left by
/// the trace-aligned-only per-query checks (24% of blowup-16 queries land on
/// trace-aligned rows, so per-query coverage alone is too weak).
pub fn verify_deep_ali_circuit_6(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    use crate::periodic_consts::{C7_ACTIVE_COEFFS, C7_NOT_BOUNDARY_ACTIVE_COEFFS};
    use crate::periodic_ext_consts::{
        C6_HASH_START_PERIODIC16, C6_IS_BOUNDARY_PERIODIC16, C6_IS_INTERIOR_PERIODIC16,
        C6_RC0_PERIODIC16, C6_RC1_PERIODIC16, C6_RC2_PERIODIC16,
        C6_ROUND_ACTIVE_PERIODIC16,
    };

    // [C6-D12] The periodic columns are baked for the DEPTH-12 MASKED geometry:
    // cycles 0..11 carry the walk, rows 384..511 are the blinding region and
    // take no check of any kind. `active` and `not_boundary_active` are what
    // switch the constraints off there. A proof claiming any other depth is
    // checked against gates that do not describe it, so reject up-front.
    //
    // 🚨 CHANGED 15 -> 12, AND THIS IS A HARD FORK OF THE C6 WIRE. Every
    // depth-15 C6 proof is rejected the moment this lands, and every depth-12
    // proof is rejected by the currently deployed verifier. Prover, verifier and
    // the `zk_shielded` deposit leg move in ONE deploy or the deposit path is
    // down.
    //
    // ⛔ AND THE CIRCUIT IS NOT SOUND ON ITS OWN UNTIL THE ON-CHAIN TOP-LEVEL
    // WALK EXISTS. A depth-12 C6 proves an insertion into a depth-12 SUBTREE,
    // not into the pool. The three remaining levels must be folded on chain
    // against the POOL ACCOUNT's own `filled_subtrees` — NEVER the
    // caller-supplied `new_subtrees`, which `verify_c6_proof_buffer` does not
    // hash and which any depositor can fill with arbitrary bytes.
    //
    // ⚠️ `get_boundary_assertions(6, ..)` needs no change: it derives
    // `output_row = (depth - 1) * 32 + 30` from `public_inputs[4]`, so the two
    // root rows move 478 -> 382 on their own, and 382 < 384 keeps them clear of
    // the blinding region by two rows.
    const CANONICAL_DEPTH: u64 = 11;
    if public_inputs.len() != 5 || public_inputs[4] != CANONICAL_DEPTH {
        return Err(VerifyError::DeepAliFailed);
    }

    let z = proof.ood_z;

    // [C6-D12] NINE columns, TWO evaluator classes, and NO Lagrange arm.
    //
    //   0-6  stride-16. Under the depth-12 layout these are 32-periodic on ALL
    //        512 rows — the walk no longer truncates them — so the tail that
    //        `eval_periodic_ext_at_z` corrected for is identically zero and the
    //        seven `C6_*_TAIL` tables are dead. `y16 = z^16` is paid once.
    //   7-8  genuinely dense. These are the row gates, and they are the entire
    //        reason C6 can carry a mask at all.
    //
    // ⛔ RETURNING SEVEN INSTEAD OF NINE WOULD BE A SILENT PRIVACY REGRESSION.
    // It is not a compile error waiting to happen and it rejects no honest
    // proof: drop 7 and 8 and the verifier re-imposes the Poseidon rounds across
    // rows 384..511, the 128 masked rows become 128 constrained ones, and
    // `air_aware_recovery_c6.rs` recovers four of the ten columns again.
    //
    // ✅ THE TWO DENSE TABLES ARE C7's, NOT COPIES. Both gates are functions of
    // `FIRST_FREE_ROW` and `HASH_CYCLE_LEN` alone, and depth-12 C6 has exactly
    // C7's geometry, so the tables are bit-identical. Sharing them costs ZERO
    // added rodata; `c6_and_c7_row_gates_are_the_same_two_columns` is what turns
    // that identity into a signal rather than a coincidence.
    //
    // ⛔ NO `Result` HERE ANY MORE, AND THE ABSENCE IS THE POINT. The old path
    // rejected any `z` landing on rows 480..=511 because the Lagrange correction
    // divides by `(z - g^r)`. There is no division now, so there is nothing to
    // guard: such a `z` is evaluated correctly instead of refused. That is a
    // liveness gain with no soundness component.
    let y16 = z.exp(16);
    let periodic_at_z: [Felt; 9] = [
        eval_periodic_compressed32_at_z(&C6_RC0_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C6_RC1_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C6_RC2_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C6_ROUND_ACTIVE_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C6_HASH_START_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C6_IS_BOUNDARY_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C6_IS_INTERIOR_PERIODIC16, y16),
        eval_periodic_at_z(&C7_ACTIVE_COEFFS, z),
        eval_periodic_at_z(&C7_NOT_BOUNDARY_ACTIVE_COEFFS, z),
    ];

    // Collect OOD trace values. Circuit 6 is width-10.
    let ood_current: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next: Vec<Felt> = proof.ood_next_iter().collect();
    // [ZK-RANDOMIZER 2026-08-30] 10 -> 11, AND THIS LINE COST AN HOUR. Every
    // component of C6's DEEP-ALI agreed — the nine periodic values matched the
    // prover's columns exactly at the proof's own z, the evaluator matched the
    // AIR on random frames, the boundary rows and alpha tags matched, and a
    // hand-run of the identity gave lhs == rhs. The function still returned
    // `DeepAliFailed`, because it never reached the identity: it bailed here.
    //
    // ⛔ IT HID FROM A GREP. C1, C3 and C7 name this vector `ood_current_vec`;
    // C6 names it `ood_current`, so a sweep for `ood_current_vec.len() != ` — the
    // one that found the other three — walked straight past it. The arity guard
    // must move with `CONFIG_MERKLE_UPDATE.trace_width`, and there is nothing in
    // the type system that says so.
    if ood_current.len() != 11 || ood_next.len() != 11 {
        return Err(VerifyError::DeepAliFailed);
    }

    // Derive α exactly like the prover.
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha(&proof.trace_root, &pub_bytes);

    let c_at_z = evaluate_transition_at_ood_circuit_6(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)) with n = 512.
    const TRACE_LENGTH_C6: usize = 512;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C6);
    let g = Felt::new(GENERATOR_512);
    let last_row_x = g.exp((TRACE_LENGTH_C6 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        // OOD equals g^(n-1): degenerate sampling. Vanishingly rare over a
        // random OOD — treat as failure rather than rescuing the prover.
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    // [C2] Boundary public-input binding at z (old/new leaf carries @row0,
    // old/new root @output_row). Uses a fresh `bnd-c6` tag so its α is
    // independent of the transition RLC α (`rlc-v1`).
    let assertions = get_boundary_assertions(6, public_inputs)?;
    let alpha_bnd = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"bnd-c6\0\0");
    let c_bnd = boundary_fold_at_ood(&ood_current, &assertions, z, z_t, g, alpha_bnd)
        .ok_or(VerifyError::DeepAliFailed)?;
    let c_total = c_at_z.add(c_bnd);

    // [B2] Phase 2 constrains the RECOMBINED Q(z) = SUM_j z^(jn) Q_j(z), so
    // the segment claims are reassembled before the AIR identity is applied.
    let rhs = proof.ood_quotient_recombined(TRACE_LENGTH_C6).mul(z_t);
    if c_total != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

// ============================================================================
// [P2.2d-C1] DEEP-ALI quotient check at OOD for circuit 1 (pool_commitment)
// ============================================================================
//
// Circuit 1 has a width-3 trace of length 128 with three Poseidon-t3 hash
// cycles (rows 0-30, 32-62, 64-94) producing the pool commitment
//   C = Poseidon(nullifier, Poseidon(deposit_epoch, token_mint)).
//
// The v2 generic quotient path (`compute_quotient_at_position_generic` +
// `evaluate_transition_constraint` in `stark/src/compact.rs`) had two real
// soundness gaps:
//
//   (1) **Single-cycle flag.** Its periodic flag polynomial was 1 only on
//       rows `[0, num_rounds)` of cycle 0. Cycles 1 and 2 carried no
//       Poseidon constraint in the generic path, so a malicious prover could
//       freely rewrite rows 32-62 and 64-94 provided the FRI low-degree check
//       still passed. Trace-aligned per-query checks covered ~1/blowup of rows,
//       which is too weak on its own.
//
//   (2) **Chain constraint missing.** The AIR's fourth transition constraint
//       `next[1]@row64 = current[0]@row63` — which binds cycle 2's right input
//       to cycle 1's output (epoch_hash) — was never enforced on-chain. A
//       malicious prover could pick any epoch_hash' and solve a 1-variable
//       Poseidon preimage to forge `Poseidon(nullifier', epoch_hash')` = target,
//       at a cost of ~2^64 Goldilocks operations for the preimage search.
//       [B2-M2] This line used to say "reducing soundness to ~2^64", which reads
//       as a security level and is not one: the construction's own ceiling is
//       2^42-2^52 (see `B2_CONJECTURED_FORGERY_BITS`), so 2^64 is the cost of
//       THIS forgery route, and it is the expensive one.
//
// This function closes both gaps by RLC-combining the AIR's four transition
// constraints — evaluated on the OOD trace with the *real* multi-cycle
// `round_flag` and the `chain_flag[63] = 1` — against the committed quotient's
// OOD value via `C(z) == Q(z) · Z_T(z)`. The prover matches byte-for-byte:
// `compute_quotient_lde_circuit_1` in `stark/src/compact.rs`.
//
// CU budget: ~110K (6 periodic polys × 128 coeffs + 1 Poseidon round + Z_T +
// 4-term RLC). Well within circuit 1's ~700K per-proof headroom in phase 1.

/// [P2.2d-C1] Evaluate circuit 1's 4 transition constraints at the OOD point z
/// and RLC-combine with α powers.
///
/// Mirrors `evaluate_pool_commitment_transition` in
/// `stark/src/air/denominated_pool.rs`. Periodic layout matches
/// `build_pool_commitment_periodic_columns`:
/// `[rc0, rc1, rc2, round_flag, chain_flag, is_boundary]`.
#[inline(never)]
fn evaluate_transition_at_ood_circuit_1(
    // [ZK-RANDOMIZER 2026-08-30] 3 -> 4. Index 3 is the randomizer column and
    // nothing below reads it; it is carried because the DEEP recombination sums
    // a gamma power over every committed column.
    ood_current: &[Felt; 4],
    ood_next: &[Felt; 4],
    periodic_at_z: &[Felt; 7],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_flag = periodic_at_z[3];
    let chain_flag = periodic_at_z[4];
    let _is_boundary = periodic_at_z[5];
    let nba = periodic_at_z[6];

    let one = Felt::ONE;
    let three = Felt::new(3);

    // ── Poseidon round on cols 0-2 (MDS = circulant [[3,1,1],[1,3,1],[1,1,3]]) ──
    let s0 = ood_current[0].add(rc0);
    let s1 = ood_current[1].add(rc1);
    let s2 = ood_current[2].add(rc2);
    let s0_7 = s0.pow7();
    let s1_7 = s1.pow7();
    let s2_7 = s2.pow7();
    let ro0 = three.mul(s0_7).add(s1_7).add(s2_7);
    let ro1 = s0_7.add(three.mul(s1_7)).add(s2_7);
    let ro2 = s0_7.add(s1_7).add(three.mul(s2_7));

    // c_i = nba · (next[i] − current[i] − round_flag · (ro_i − current[i]))
    //
    // 🚨 `nba`, NOT `one.sub(is_boundary)`. The two agree on every row of the
    // three hash cycles and differ only across rows 96..255, so the
    // substitution rejects NO honest proof and passes every existing test —
    // while re-imposing `next[i] - current[i] = 0` on the 160 blinding rows,
    // which is the degenerate form that pins each column to a single unknown.
    //
    // ⚠️ TWO PERIODIC FACTORS PER LINE, `nba` and `round_flag`, over a degree-7
    // body. A third takes ce_blowup_factor from 8 to 16.
    let mut cs = [Felt::ZERO; 4];
    cs[0] = nba.mul(
        ood_next[0].sub(ood_current[0]).sub(round_flag.mul(ro0.sub(ood_current[0])))
    );
    cs[1] = nba.mul(
        ood_next[1].sub(ood_current[1]).sub(round_flag.mul(ro1.sub(ood_current[1])))
    );
    cs[2] = nba.mul(
        ood_next[2].sub(ood_current[2]).sub(round_flag.mul(ro2.sub(ood_current[2])))
    );

    // Chain: at row 63, next[1]@row64 must equal current[0]@row63 (epoch_hash).
    cs[3] = chain_flag.mul(ood_next[1].sub(ood_current[0]));

    // Horner-style RLC: Σ α^i · cs[i].
    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// [P2.2d-C1] Check the DEEP-ALI identity at the OOD point for circuit 1.
///
/// Computes:
///   1. α from the Fiat-Shamir transcript (`trace_root || pub_inputs ||
///      "rlc-c1\0\0"`).
///   2. The 6 periodic polynomials evaluated at z via Horner.
///   3. The 4 transition constraints on the opened OOD trace, RLC-combined
///      with α to produce `C(z)`.
///   4. `Z_T(z) = (z^n - 1) / (z - g^(n-1))` with `n = 128`.
///   5. The identity `C(z) == Q(z) · Z_T(z)`.
///
/// Tied to FRI's low-degree guarantee on the committed quotient LDE, this
/// binds the full 4-constraint AIR (including the chain row 63 and
/// multi-cycle Poseidon) to the opened OOD trace via Schwartz–Zippel over a
/// random z — closing both P2.2d-C1 soundness gaps documented above.
#[inline(never)]
pub fn verify_deep_ali_circuit_1(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    use crate::periodic_consts::{
        C1_NOT_BOUNDARY_ACTIVE_COEFFS, C1_RC0_COEFFS, C1_RC1_COEFFS, C1_RC2_COEFFS,
        C1_ROUND_FLAG_COEFFS, C1_CHAIN_FLAG_COEFFS, C1_IS_BOUNDARY_COEFFS,
    };

    let z = proof.ood_z;

    // Evaluate the periodic columns at z via Horner (~256 muls each at n=256).
    // [C1-N256] SEVEN columns. The appended one is `not_boundary_active`, the
    // gate that switches every transition off across rows 96..255.
    //
    // ⛔ RETURNING SIX WOULD BE A SILENT PRIVACY REGRESSION. It rejects no
    // honest proof: drop slot 6 and the verifier re-imposes
    // `next[i] - current[i] = 0` on the 160 blinding rows, each column collapses
    // to one unknown again, and `air_aware_recovery_c1.rs` recovers all four
    // private inputs.
    let periodic_at_z: [Felt; 7] = [
        eval_periodic_at_z(&C1_RC0_COEFFS, z),
        eval_periodic_at_z(&C1_RC1_COEFFS, z),
        eval_periodic_at_z(&C1_RC2_COEFFS, z),
        eval_periodic_at_z(&C1_ROUND_FLAG_COEFFS, z),
        eval_periodic_at_z(&C1_CHAIN_FLAG_COEFFS, z),
        eval_periodic_at_z(&C1_IS_BOUNDARY_COEFFS, z),
        eval_periodic_at_z(&C1_NOT_BOUNDARY_ACTIVE_COEFFS, z),
    ];

    // Collect OOD trace values. Circuit 1 is width-3.
    let ood_current_vec: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next_vec: Vec<Felt> = proof.ood_next_iter().collect();
    // [ZK-RANDOMIZER 2026-08-30] 3 -> 4. This guard sits BEFORE the frame is
    // built, so left behind it rejects every honest proof with `DeepAliFailed`
    // -- the same trap C7's guard sprang in this change.
    if ood_current_vec.len() != 4 || ood_next_vec.len() != 4 {
        return Err(VerifyError::DeepAliFailed);
    }
    // [ZK-RANDOMIZER] Slot 3 carried, read by nothing.
    let ood_current =
        [ood_current_vec[0], ood_current_vec[1], ood_current_vec[2], ood_current_vec[3]];
    let ood_next = [ood_next_vec[0], ood_next_vec[1], ood_next_vec[2], ood_next_vec[3]];

    // Derive α exactly like the prover (C1-specific domain tag).
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"rlc-c1\0\0");

    let c_at_z = evaluate_transition_at_ood_circuit_1(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)) with n = 128.
    // [C1-N256] 128 -> 256. `quotient_segments` stays 8 and rho stays 1/16;
    // both are scale-invariant in n. See CONFIG_POOL_COMMITMENT.
    // [ZK-RANDOMIZER 2026-08-30] 256 -> 512.
    const TRACE_LENGTH_C1: usize = 512;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C1);
    // GENERATOR_256 already existed, carried as dead code. No new constant.
    // ⛔ THE GENERATOR MOVES WITH `n`, AND NOTHING TYPE-CHECKS THAT IT DID. This
    // is the exact defect that made every honest C5 proof fail DEEP-ALI on
    // 2026-08-29: `g^(n-1)` must generate the TRACE subgroup.
    let g = Felt::new(GENERATOR_512);
    let last_row_x = g.exp((TRACE_LENGTH_C1 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        // OOD lands on g^(n-1): degenerate sampling — vanishingly rare.
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    // [C2] Boundary public-input binding at z (nullifier@row30, commitment@row94,
    // chain nullifier@row64, capacity zeros). Same domain generator as the AIR.
    let assertions = get_boundary_assertions(1, public_inputs)?;
    let alpha_bnd = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"bnd-c1\0\0");
    let c_bnd = boundary_fold_at_ood(&ood_current_vec, &assertions, z, z_t, g, alpha_bnd)
        .ok_or(VerifyError::DeepAliFailed)?;
    let c_total = c_at_z.add(c_bnd);

    // [B2] Phase 2 constrains the RECOMBINED Q(z) = SUM_j z^(jn) Q_j(z), so
    // the segment claims are reassembled before the AIR identity is applied.
    let rhs = proof.ood_quotient_recombined(TRACE_LENGTH_C1).mul(z_t);
    if c_total != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

/// [P2.2d-C2] Evaluate circuit 2's 7 transition constraints at the OOD point z
/// and RLC-combine with α powers.
///
/// Mirrors `evaluate_balance_proof_transition` in
/// `stark/src/air/balance_proof.rs`. Periodic layout matches
/// `build_balance_proof_periodic_columns`:
/// `[rc0, rc1, rc2, round_flag, chain_01, carry_capture, chain_carry, is_boundary]`.
///
/// Trace width is 4: cols 0-2 are Poseidon state (left, right, capacity),
/// col 3 is the carry column holding an intermediate hash output between
/// cycle 1 (row 63) and cycle 3 (row 95).
#[inline(never)]
fn evaluate_transition_at_ood_circuit_2(
    ood_current: &[Felt; 4],
    ood_next: &[Felt; 4],
    periodic_at_z: &[Felt; 8],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_flag = periodic_at_z[3];
    let chain_01 = periodic_at_z[4];
    let carry_capture = periodic_at_z[5];
    let chain_carry = periodic_at_z[6];
    let is_boundary = periodic_at_z[7];

    let one = Felt::ONE;
    let three = Felt::new(3);
    let not_boundary = one.sub(is_boundary);
    let not_capture = one.sub(carry_capture);

    // ── Poseidon round on cols 0-2 (MDS = circulant [[3,1,1],[1,3,1],[1,1,3]]) ──
    let s0 = ood_current[0].add(rc0);
    let s1 = ood_current[1].add(rc1);
    let s2 = ood_current[2].add(rc2);
    let s0_7 = s0.pow7();
    let s1_7 = s1.pow7();
    let s2_7 = s2.pow7();
    let ro0 = three.mul(s0_7).add(s1_7).add(s2_7);
    let ro1 = s0_7.add(three.mul(s1_7)).add(s2_7);
    let ro2 = s0_7.add(s1_7).add(three.mul(s2_7));

    // c_i = not_boundary · (next[i] − current[i] − round_flag · (ro_i − current[i]))
    //     for i ∈ {0,1,2}. Matches evaluate_balance_proof_transition exactly:
    //     when round_flag=1 → next=ro (active round), when round_flag=0 →
    //     next=current (padding), when is_boundary=1 → free transition.
    let mut cs = [Felt::ZERO; 7];
    cs[0] = not_boundary.mul(
        ood_next[0].sub(ood_current[0]).sub(round_flag.mul(ro0.sub(ood_current[0])))
    );
    cs[1] = not_boundary.mul(
        ood_next[1].sub(ood_current[1]).sub(round_flag.mul(ro1.sub(ood_current[1])))
    );
    cs[2] = not_boundary.mul(
        ood_next[2].sub(ood_current[2]).sub(round_flag.mul(ro2.sub(ood_current[2])))
    );

    // [c3] chain_01 @ row 31: cycle 0 output (current[0]) → cycle 1 left input (next[0]).
    cs[3] = chain_01.mul(ood_next[0].sub(ood_current[0]));

    // [c4] carry_capture @ row 63: cycle 1 output (current[0]) → carry col (next[3]).
    cs[4] = carry_capture.mul(ood_next[3].sub(ood_current[0]));

    // [c5] carry_continuity: at non-capture rows, carry col holds its value.
    cs[5] = not_capture.mul(ood_next[3].sub(ood_current[3]));

    // [c6] chain_carry @ row 95: carry value (current[3]) → cycle 3 right input (next[1]).
    cs[6] = chain_carry.mul(ood_next[1].sub(ood_current[3]));

    // Horner-style RLC: Σ α^i · cs[i].
    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// [P2.2d-C2] Check the DEEP-ALI identity at the OOD point for circuit 2.
///
/// Computes:
///   1. α from the Fiat-Shamir transcript (`trace_root || pub_inputs ||
///      "rlc-c2\0\0"`).
///   2. The 8 periodic polynomials evaluated at z via Horner.
///   3. The 7 transition constraints on the opened OOD trace (width 4),
///      RLC-combined with α to produce `C(z)`.
///   4. `Z_T(z) = (z^n - 1) / (z - g^(n-1))` with `n = 128`.
///   5. The identity `C(z) == Q(z) · Z_T(z)`.
///
/// Circuit 2 proves a stealth commitment derived from Poseidon(sk, balance,
/// salt, mint). Without DEEP-ALI on the chain/carry constraints, a malicious
/// prover could freely alter cycles 1-3 and forge commitments — soundness
/// drops to ~2^64. This check binds all 4 Poseidon cycles and all 3 chain
/// edges (row 31 / 63 / 95) to the opened OOD trace via Schwartz–Zippel.
#[inline(never)]
pub fn verify_deep_ali_circuit_2(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    use crate::periodic_consts::{
        C2_RC0_COEFFS, C2_RC1_COEFFS, C2_RC2_COEFFS, C2_ROUND_FLAG_COEFFS,
        C2_CHAIN_01_COEFFS, C2_CARRY_CAPTURE_COEFFS, C2_CHAIN_CARRY_COEFFS,
        C2_IS_BOUNDARY_COEFFS,
    };

    let z = proof.ood_z;

    // Evaluate the 8 periodic columns at z.
    let mut periodic_at_z: [Felt; 8] = [
        // A3: RC0/RC1/RC2/ROUND_FLAG are stride-4 sparse (measured: 32 of 128
        // coefficients non-zero). 128 Horner steps -> 32, four times over.
        eval_periodic_stride_at_z(&C2_RC0_COEFFS, z, 4),
        eval_periodic_stride_at_z(&C2_RC1_COEFFS, z, 4),
        eval_periodic_stride_at_z(&C2_RC2_COEFFS, z, 4),
        eval_periodic_stride_at_z(&C2_ROUND_FLAG_COEFFS, z, 4),
        eval_periodic_at_z(&C2_CHAIN_01_COEFFS, z),
        eval_periodic_at_z(&C2_CARRY_CAPTURE_COEFFS, z),
        eval_periodic_at_z(&C2_CHAIN_CARRY_COEFFS, z),
        // A3: IS_BOUNDARY is coefficient-wise exactly CHAIN_01 + CARRY_CAPTURE
        // + CHAIN_CARRY (verified over all 128 coefficients), so evaluating it
        // is two field adds instead of 128 Horner steps. Filled in below, once
        // the three summands exist.
        Felt::ZERO,
    ];
    periodic_at_z[7] = periodic_at_z[4].add(periodic_at_z[5]).add(periodic_at_z[6]);

    // Collect OOD trace values. Circuit 2 is width-4.
    let ood_current_vec: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next_vec: Vec<Felt> = proof.ood_next_iter().collect();
    if ood_current_vec.len() != 4 || ood_next_vec.len() != 4 {
        return Err(VerifyError::DeepAliFailed);
    }
    let ood_current = [
        ood_current_vec[0], ood_current_vec[1],
        ood_current_vec[2], ood_current_vec[3],
    ];
    let ood_next = [
        ood_next_vec[0], ood_next_vec[1],
        ood_next_vec[2], ood_next_vec[3],
    ];

    // Derive α exactly like the prover (C2-specific domain tag).
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"rlc-c2\0\0");

    let c_at_z = evaluate_transition_at_ood_circuit_2(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)) with n = 128.
    const TRACE_LENGTH_C2: usize = 128;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C2);
    let g = Felt::new(GENERATOR_128);
    let last_row_x = g.exp((TRACE_LENGTH_C2 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        // OOD lands on g^(n-1): degenerate sampling — vanishingly rare.
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    // [BIND-C2C4 2026-08-03] Boundary public-input binding at z.
    //
    // This block did not exist. C2 was one of two circuits (with C4) whose
    // phase-2 entry point never called `boundary_fold_at_ood`, so the ONLY thing
    // in the whole verifier binding a C2 trace to `[commitment, token_mint]` was
    // the trace-aligned per-query step-5 check — measured PRE-FIX by
    // `c2_step5_public_input_binding_fires` to be able to fire on 7 of 300
    // honest witnesses (2.33%). On the other ~97% the public inputs were bound
    // by nothing: they feed the Fiat-Shamir RLC alpha, which binds the CLAIMED
    // inputs to the transcript, not the trace to the inputs, and a prover who
    // re-runs the pipeline under a different claim satisfies that trivially.
    //
    // POST-FIX, re-measured at `bd8be2b4`: C2's step-5 rate is UNCHANGED at
    // 7/300 (2.33%). C4's fell to 4/300 (1.33%) from 3.00% — folding Q_bnd
    // re-randomises the Fiat-Shamir draw that the query positions come from, so
    // the per-query rate is redrawn for exactly the two circuits this fix
    // touched. That is luck of the draw, not a step-5 regression, and it only
    // does not matter because the fold below is unconditional on every proof.
    //
    // [B7 2026-08-04] Both rates are ZERO now: the coset LDE leaves no
    // trace-aligned query positions and the step-5 arm is retired outright
    // (see `step5_is_vacuous_post_b7`). This fold is the WHOLE public-input
    // binding, measured at 100% by `c2_lying_public_input_is_rejected`.
    //
    // `boundary_spec_for_quotient` in `stark/src/compact.rs` folds the matching
    // Q_bnd into the committed quotient with the SAME `bnd-c2` tag and the SAME
    // assertion order, so this is not additive belt-and-braces: an honest proof
    // built by that prover does NOT satisfy `c_at_z == rhs` any more. The two
    // halves can only be reverted together. What pins THAT — naming tests that
    // exist, checked with grep, because an earlier draft of this comment named
    // one that never did:
    //   * `c2_lying_public_input_is_rejected` (this file) goes red under the
    //     coordinated revert — an honest trace published under a false
    //     `commitment` or `token_mint` is accepted again.
    //   * `balance_proof_satisfies_deep_ali_end_to_end` (stark/src/compact.rs)
    //     goes red under the PROVER half alone: it asserts `c_bnd != 0` and that
    //     `c_at_z != q_at_z * z_t`, so a prover that stops folding Q_bnd fails it
    //     rather than quietly agreeing with a verifier that stopped too.
    let assertions = get_boundary_assertions(2, public_inputs)?;
    let alpha_bnd = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"bnd-c2\0\0");
    let c_bnd = boundary_fold_at_ood(&ood_current_vec, &assertions, z, z_t, g, alpha_bnd)
        .ok_or(VerifyError::DeepAliFailed)?;
    let c_total = c_at_z.add(c_bnd);

    // [B2] Phase 2 constrains the RECOMBINED Q(z) = SUM_j z^(jn) Q_j(z), so
    // the segment claims are reassembled before the AIR identity is applied.
    let rhs = proof.ood_quotient_recombined(TRACE_LENGTH_C2).mul(z_t);
    if c_total != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

/// [P2.2d-C3] Evaluate circuit 3's 11 transition constraints at the OOD point z
/// and RLC-combine with α powers.
///
/// Mirrors `evaluate_merkle_path_transition` in
/// `stark/src/air/merkle_path.rs`. Periodic layout matches
/// `build_merkle_path_periodic_columns`:
/// `[rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior]`.
///
/// Trace width is 6:
///   col 0-2: Poseidon state (s0, s1, s2)
///   col 3:   sibling (path element at this Merkle level)
///   col 4:   direction (0 = leaf on left, 1 = leaf on right)
///   col 5:   carry (previous hash output; leaf for first cycle)
#[inline(never)]
fn evaluate_transition_at_ood_circuit_3(
    // [ZK-RANDOMIZER 2026-08-30] 6 -> 7. Index 6 is the randomizer column and
    // nothing below reads it. It is carried because the DEEP recombination sums
    // a gamma power over every committed column.
    ood_current: &[Felt; 7],
    ood_next: &[Felt; 7],
    periodic_at_z: &[Felt; 9],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_active = periodic_at_z[3];
    let hash_start = periodic_at_z[4];
    let is_boundary = periodic_at_z[5];
    let is_interior = periodic_at_z[6];
    let active = periodic_at_z[7];
    let nba = periodic_at_z[8];

    let one = Felt::ONE;
    let three = Felt::new(3);

    // [C3-D12] Every gate is pre-multiplied by `active` exactly once, and the
    // Poseidon rows use `nba` instead of `1 - is_boundary`.
    //
    // 🚨 `let not_boundary = one.sub(is_boundary)` USED TO STAND HERE AND MUST
    // NOT COME BACK. It and `nba` agree on every row of the walk and differ only
    // across rows 384..511, so the substitution rejects NO honest proof, passes
    // every existing test, and quietly re-imposes the Poseidon rounds on the 128
    // blinding rows. `c3_ood_evaluator_matches_the_air_on_random_frames` is what
    // catches it -- a frame with a nonzero `is_boundary` and a zero `nba`
    // separates the two, and no honest-proof test can.
    //
    // ⚠️ AT MOST TWO PERIODIC FACTORS PER LINE. `cs[0..3]` spend theirs on `nba`
    // and `round_active` over a degree-7 body; a third takes ce_blowup_factor
    // from 8 to 16 and changes the proof structure.
    let hash_start_a = hash_start.mul(active);
    let is_boundary_a = is_boundary.mul(active);
    let is_interior_a = is_interior.mul(active);

    // ── Poseidon round on cols 0-2 (MDS = circulant [[3,1,1],[1,3,1],[1,1,3]]) ──
    let s0 = ood_current[0].add(rc0);
    let s1 = ood_current[1].add(rc1);
    let s2 = ood_current[2].add(rc2);
    let s0_7 = s0.pow7();
    let s1_7 = s1.pow7();
    let s2_7 = s2.pow7();
    let ro0 = three.mul(s0_7).add(s1_7).add(s2_7);
    let ro1 = s0_7.add(three.mul(s1_7)).add(s2_7);
    let ro2 = s0_7.add(s1_7).add(three.mul(s2_7));

    // [c0-c2] Poseidon state: not_boundary · (next[i] − current[i] − round_active · (ro_i − current[i])).
    // When round_active=1 → next=ro_i (active round); when round_active=0 → next=current (padding);
    // when is_boundary=1 → unconstrained (hash_start mux + carry update take over).
    let mut cs = [Felt::ZERO; 11];
    cs[0] = nba.mul(
        ood_next[0].sub(ood_current[0]).sub(round_active.mul(ro0.sub(ood_current[0])))
    );
    cs[1] = nba.mul(
        ood_next[1].sub(ood_current[1]).sub(round_active.mul(ro1.sub(ood_current[1])))
    );
    cs[2] = nba.mul(
        ood_next[2].sub(ood_current[2]).sub(round_active.mul(ro2.sub(ood_current[2])))
    );

    // [c3-c4] Hash-start mux: at the start of every Poseidon cycle, the state
    // absorbs (carry, sibling) routed by direction:
    //   s0 = carry + dir · (sib − carry)
    //   s1 = sib   − dir · (sib − carry)
    // Rewritten so both evaluate to 0 on an honest trace:
    //   hash_start · (current[0] − carry − dir · (sib − carry)) = 0
    //   hash_start · (current[1] − sib   + dir · (sib − carry)) = 0
    let sib = ood_current[3];
    let dir = ood_current[4];
    let carry = ood_current[5];
    let sib_minus_carry = sib.sub(carry);
    cs[3] = hash_start_a.mul(
        ood_current[0].sub(carry).sub(dir.mul(sib_minus_carry))
    );
    cs[4] = hash_start_a.mul(
        ood_current[1].sub(sib).add(dir.mul(sib_minus_carry))
    );

    // [c5] Hash-start capacity: state[2] (capacity) = 0 at every cycle start.
    cs[5] = hash_start_a.mul(ood_current[2]);

    // [c6] Carry update at cycle boundary (row 31, 63, ...): next[5] = current[0]
    // (propagate hash output into next level's carry).
    cs[6] = is_boundary_a.mul(ood_next[5].sub(ood_current[0]));

    // [c7] Carry continuity between boundaries: next[5] = current[5]
    // (carry doesn't change mid-cycle).
    cs[7] = nba.mul(ood_next[5].sub(ood_current[5]));

    // [c8-c9] Sibling/direction continuity inside a cycle (is_interior=1):
    // both must be constant within a cycle; can only change at a boundary.
    cs[8] = is_interior_a.mul(ood_next[3].sub(ood_current[3]));
    cs[9] = is_interior_a.mul(ood_next[4].sub(ood_current[4]));

    // [c10] Direction binary at every hash start: dir · (1 − dir) = 0.
    cs[10] = hash_start_a.mul(dir.mul(one.sub(dir)));

    // Horner-style RLC: Σ α^i · cs[i].
    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// [P2.2d-C3] Check the DEEP-ALI identity at the OOD point for circuit 3.
///
/// Computes:
///   1. α from the Fiat-Shamir transcript (`trace_root || pub_inputs ||
///      "rlc-c3\0\0"`).
///   2. The 7 periodic polynomials evaluated at z via Horner.
///   3. The 11 transition constraints on the opened OOD trace (width 6),
///      RLC-combined with α to produce `C(z)`.
///   4. `Z_T(z) = (z^n - 1) / (z - g^(n-1))` with `n = 512` (canonical depth=12;
///      `next_pow2(12*32) == next_pow2(15*32) == 512`, so `n` did not move).
///   5. The identity `C(z) == Q(z) · Z_T(z)`.
///
/// Circuit 3 proves a Merkle path from leaf to root. Without DEEP-ALI on the
/// hash-start mux, capacity, carry update, carry continuity, sibling/direction
/// continuity, and direction-binary constraints, a malicious prover could
/// inject arbitrary state into cycles 1-14 and forge paths — soundness drops
/// to ~2^64. This check binds all 15 Poseidon cycles and all 14 level-chaining
/// edges to the opened OOD trace via Schwartz–Zippel.
#[inline(never)]
pub fn verify_deep_ali_circuit_3(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    use crate::periodic_consts::{C7_ACTIVE_COEFFS, C7_NOT_BOUNDARY_ACTIVE_COEFFS};
    use crate::periodic_ext_consts::{
        C3_HASH_START_PERIODIC16, C3_IS_BOUNDARY_PERIODIC16, C3_IS_INTERIOR_PERIODIC16,
        C3_RC0_PERIODIC16, C3_RC1_PERIODIC16, C3_RC2_PERIODIC16,
        C3_ROUND_ACTIVE_PERIODIC16,
    };

    // [C3-D12] The periodic columns are baked for the DEPTH-12 MASKED geometry:
    // cycles 0..11 carry the walk, rows 384..511 are the blinding region and
    // take no check of any kind. `active` and `not_boundary_active` are what
    // switch the constraints off there. A proof claiming any other depth is
    // checked against gates that do not describe it, so reject up-front.
    //
    // 🚨 CHANGED 15 -> 12, AND THIS IS A HARD FORK OF THE C3 WIRE, in both
    // directions: the deployed verifier rejects every depth-12 proof, and this
    // one rejects every depth-15 proof. C3 has FIVE on-chain consumers
    // (`split_note_stark`, `subscribe_private_stark`,
    // `transfer_denominated_stark_v3`, `unshield_denominated_stark_v3`) so the
    // blast radius is wider than C6's, and prover, verifier and every one of
    // those instructions move in ONE deploy.
    //
    // ⛔ AND THE CIRCUIT IS NOT SOUND ON ITS OWN UNTIL EACH CONSUMER WALKS THE
    // TOP LEVELS. A depth-12 C3 proves membership in a 12-level SUBTREE, which
    // anyone satisfies with a subtree they built themselves.
    //
    // ✅ THE WALK ALREADY EXISTS AND IS THE RIGHT ONE.
    // `zk_shielded::state::spend_root::resolve_pool_root` was written for C7 and
    // has exactly this shape: caller-supplied siblings, result required to be a
    // root the pool ALREADY KNOWS. That is safe because C3 READS -- a forged
    // sibling produces a root in no history and the spend fails.
    //
    // ⛔ DO NOT REACH FOR `state::insert_root::fold_insertion`. That is the
    // write-side twin, built for C6's insertion, and it reads the pool's own
    // `filled_subtrees` because an insertion produces a root no history can
    // check. Swapping the two is wrong in both directions.
    const CANONICAL_DEPTH: u64 = 11;
    if public_inputs.len() != 3 || public_inputs[2] != CANONICAL_DEPTH {
        return Err(VerifyError::DeepAliFailed);
    }

    let z = proof.ood_z;

    // [C3-D12] NINE columns, TWO evaluator classes, and NO Lagrange arm.
    //
    //   0-6  stride-16. Under the depth-12 layout these are 32-periodic on ALL
    //        512 rows -- the walk no longer truncates them -- so the tail that
    //        `eval_periodic_ext_at_z` corrected for is identically zero and the
    //        seven `C3_*_TAIL` tables are dead. `y16 = z^16` is paid once.
    //   7-8  genuinely dense. These are the row gates, and they are the entire
    //        reason C3 can carry a mask at all.
    //
    // ⛔ RETURNING SEVEN INSTEAD OF NINE WOULD BE A SILENT PRIVACY REGRESSION.
    // It rejects no honest proof: drop 7 and 8 and the verifier re-imposes the
    // Poseidon rounds across rows 384..511, the 128 masked rows become 128
    // constrained ones, and `air_aware_recovery_c3.rs` recovers the path and the
    // leaf index again.
    //
    // ✅ THE TABLES ARE SHARED, NOT COPIED, AND C3 ADDS ZERO RODATA. The seven
    // stride tables were already byte-identical across C3, C6 and C7 --
    // `c7_stride_tables_equal_the_c3_and_c6_periodic_extensions` measured all 32
    // values of all seven on 2026-08-24. The two dense gates are functions of
    // `FIRST_FREE_ROW` and `HASH_CYCLE_LEN` alone, and depth-12 C3 has C7's
    // geometry exactly, so they are C7's tables too.
    //
    // ⛔ NO `Result` HERE ANY MORE, AND THE ABSENCE IS THE POINT. The old path
    // rejected any `z` landing on rows 480..=511 because the Lagrange correction
    // divides by `(z - g^r)`. There is no division now, so there is nothing to
    // guard: such a `z` is evaluated correctly instead of refused. A liveness
    // gain with no soundness component.
    let y16 = z.exp(16);
    let periodic_at_z: [Felt; 9] = [
        eval_periodic_compressed32_at_z(&C3_RC0_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C3_RC1_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C3_RC2_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C3_ROUND_ACTIVE_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C3_HASH_START_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C3_IS_BOUNDARY_PERIODIC16, y16),
        eval_periodic_compressed32_at_z(&C3_IS_INTERIOR_PERIODIC16, y16),
        eval_periodic_at_z(&C7_ACTIVE_COEFFS, z),
        eval_periodic_at_z(&C7_NOT_BOUNDARY_ACTIVE_COEFFS, z),
    ];

    // Collect OOD trace values. Circuit 3 is width-6.
    let ood_current_vec: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next_vec: Vec<Felt> = proof.ood_next_iter().collect();
    // [ZK-RANDOMIZER 2026-08-30] 6 -> 7. This arity check is what refuses a
    // pre-randomizer proof, and it must move with the config or the frame is
    // built from a short vector.
    if ood_current_vec.len() != 7 || ood_next_vec.len() != 7 {
        return Err(VerifyError::DeepAliFailed);
    }
    let ood_current = [
        ood_current_vec[0], ood_current_vec[1], ood_current_vec[2],
        ood_current_vec[3], ood_current_vec[4], ood_current_vec[5],
        ood_current_vec[6],
    ];
    let ood_next = [
        ood_next_vec[0], ood_next_vec[1], ood_next_vec[2],
        ood_next_vec[3], ood_next_vec[4], ood_next_vec[5],
        ood_next_vec[6],
    ];

    // Derive α exactly like the prover (C3-specific domain tag).
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"rlc-c3\0\0");

    let c_at_z = evaluate_transition_at_ood_circuit_3(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)) with n = 512 (canonical depth=15).
    const TRACE_LENGTH_C3: usize = 512;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C3);
    let g = Felt::new(GENERATOR_512);
    let last_row_x = g.exp((TRACE_LENGTH_C3 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        // OOD lands on g^(n-1): degenerate sampling — vanishingly rare.
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    // [C2] Boundary public-input binding at z (leaf@row0 col5, root@output_row col0).
    let assertions = get_boundary_assertions(3, public_inputs)?;
    let alpha_bnd = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"bnd-c3\0\0");
    let c_bnd = boundary_fold_at_ood(&ood_current_vec, &assertions, z, z_t, g, alpha_bnd)
        .ok_or(VerifyError::DeepAliFailed)?;
    let c_total = c_at_z.add(c_bnd);

    // [B2] Phase 2 constrains the RECOMBINED Q(z) = SUM_j z^(jn) Q_j(z), so
    // the segment claims are reassembled before the AIR identity is applied.
    let rhs = proof.ood_quotient_recombined(TRACE_LENGTH_C3).mul(z_t);
    if c_total != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

/// [P2.2d-C4] Evaluate the 10-constraint circuit-4 (confidential_balance)
/// transition RLC at the OOD point `z`.
///
/// Mirrors `evaluate_confidential_balance_transition` in the prover's AIR.
/// Width 4: cols 0-2 are Poseidon state, col 3 is the chain carry. The 7
/// chained hashes (owner, owner_mint, amount_hash, old_bal_salt, old_commit,
/// new_bal_salt, new_commit) sit in 7 consecutive 32-row cycles followed by
/// one identity-padding cycle — chain-edge periodic flags are non-zero only
/// at the exact row where one hash feeds the next.
///
/// Constraints:
///   [c0-c2] Poseidon state: not_boundary · (next[i] − current[i]
///           − round_flag · (ro_i − current[i]))
///   [c3]    chain_01 · (next[0] − current[0])  — cycle 0→1 (owner in)
///   [c4]    chain_34 · (next[0] − current[0])  — cycle 3→4 (old_bal_salt in)
///   [c5]    chain_56 · (next[0] − current[0])  — cycle 5→6 (new_bal_salt in)
///   [c6]    carry_capture · (next[3] − current[0])  — capture owner_mint
///   [c7]    (1 − carry_capture) · (next[3] − current[3])  — carry continuity
///   [c8]    chain_carry_4 · (next[1] − current[3])  — carry → cycle 4 right input
///   [c9]    chain_carry_6 · (next[1] − current[3])  — carry → cycle 6 right input
#[inline(never)]
fn evaluate_transition_at_ood_circuit_4(
    ood_current: &[Felt; 4],
    ood_next: &[Felt; 4],
    periodic_at_z: &[Felt; 11],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_flag = periodic_at_z[3];
    let is_boundary = periodic_at_z[4];
    let chain_01 = periodic_at_z[5];
    let chain_34 = periodic_at_z[6];
    let chain_56 = periodic_at_z[7];
    let carry_capture = periodic_at_z[8];
    let chain_carry_4 = periodic_at_z[9];
    let chain_carry_6 = periodic_at_z[10];

    let one = Felt::ONE;
    let three = Felt::new(3);
    let not_boundary = one.sub(is_boundary);

    // ── Poseidon round on cols 0-2 (MDS = circulant [[3,1,1],[1,3,1],[1,1,3]]) ──
    let s0 = ood_current[0].add(rc0);
    let s1 = ood_current[1].add(rc1);
    let s2 = ood_current[2].add(rc2);
    let s0_7 = s0.pow7();
    let s1_7 = s1.pow7();
    let s2_7 = s2.pow7();
    let ro0 = three.mul(s0_7).add(s1_7).add(s2_7);
    let ro1 = s0_7.add(three.mul(s1_7)).add(s2_7);
    let ro2 = s0_7.add(s1_7).add(three.mul(s2_7));

    let mut cs = [Felt::ZERO; 10];

    // [c0-c2] Poseidon state transition (active round when round_flag=1,
    // identity when round_flag=0, unconstrained at cycle boundary).
    cs[0] = not_boundary.mul(
        ood_next[0].sub(ood_current[0]).sub(round_flag.mul(ro0.sub(ood_current[0])))
    );
    cs[1] = not_boundary.mul(
        ood_next[1].sub(ood_current[1]).sub(round_flag.mul(ro1.sub(ood_current[1])))
    );
    cs[2] = not_boundary.mul(
        ood_next[2].sub(ood_current[2]).sub(round_flag.mul(ro2.sub(ood_current[2])))
    );

    // [c3-c5] Chain edges: when the flag is 1 the next cycle's state[0] must
    // equal the current cycle's output (state[0] at end-of-cycle).
    cs[3] = chain_01.mul(ood_next[0].sub(ood_current[0]));
    cs[4] = chain_34.mul(ood_next[0].sub(ood_current[0]));
    cs[5] = chain_56.mul(ood_next[0].sub(ood_current[0]));

    // [c6] Capture owner_mint into carry column at cycle-1 boundary.
    cs[6] = carry_capture.mul(ood_next[3].sub(ood_current[0]));
    // [c7] Carry continuity everywhere else.
    cs[7] = one.sub(carry_capture).mul(ood_next[3].sub(ood_current[3]));
    // [c8-c9] Chain carry → right input of cycle 4 / cycle 6.
    cs[8] = chain_carry_4.mul(ood_next[1].sub(ood_current[3]));
    cs[9] = chain_carry_6.mul(ood_next[1].sub(ood_current[3]));

    // Horner RLC: Σ α^i · cs[i].
    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// [P2.2d-C4] Check the DEEP-ALI identity at the OOD point for circuit 4.
///
/// Computes:
///   1. α from the Fiat-Shamir transcript (`trace_root || pub_inputs ||
///      "rlc-c4\0\0"`).
///   2. The 11 periodic polynomials evaluated at z via Horner.
///   3. The 10 transition constraints on the opened OOD trace (width 4),
///      RLC-combined with α to produce `C(z)`.
///   4. `Z_T(z) = (z^n - 1) / (z - g^(n-1))` with `n = 256`.
///   5. The identity `C(z) == Q(z) · Z_T(z)`.
///
/// Circuit 4 proves a confidential balance update: new and old Poseidon
/// commitments are correctly formed from private (spending_key, balance,
/// salt, amount) with `Poseidon(amount, amount_salt)` folded into a public
/// amount hash. Without DEEP-ALI on the chain edges, an attacker could swap
/// cycles, inject rogue balances, or forge commitments that don't correspond
/// to any real spending path, at a cost of ~2^64 field operations. [B2-M2] That
/// is the cost of that particular forgery route, NOT a soundness level: the
/// construction's own ceiling is 2^42-2^52 per circuit. This check binds
/// every chain edge and carry update to the opened OOD trace via
/// Schwartz–Zippel.
#[inline(never)]
pub fn verify_deep_ali_circuit_4(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    use crate::periodic_consts::{
        C4_CARRY_CAPTURE_COEFFS, C4_CHAIN_01_COEFFS, C4_CHAIN_34_COEFFS,
        C4_CHAIN_56_COEFFS, C4_CHAIN_CARRY_4_COEFFS, C4_CHAIN_CARRY_6_COEFFS,
        C4_IS_BOUNDARY_COEFFS, C4_RC0_COEFFS, C4_RC1_COEFFS, C4_RC2_COEFFS,
        C4_ROUND_FLAG_COEFFS,
    };

    let z = proof.ood_z;

    // Evaluate the 11 periodic columns at z via Horner (~256 muls each).
    // A3: CHAIN_34 and CHAIN_CARRY_4 are the SAME table, as are CHAIN_56 and
    // CHAIN_CARRY_6 (verified coefficient-wise). Evaluate each once and reuse —
    // 512 duplicate Horner steps removed for free.
    let chain_34_z = eval_periodic_at_z(&C4_CHAIN_34_COEFFS, z);
    let chain_56_z = eval_periodic_at_z(&C4_CHAIN_56_COEFFS, z);
    debug_assert_eq!(C4_CHAIN_34_COEFFS[..], C4_CHAIN_CARRY_4_COEFFS[..]);
    debug_assert_eq!(C4_CHAIN_56_COEFFS[..], C4_CHAIN_CARRY_6_COEFFS[..]);

    let periodic_at_z: [Felt; 11] = [
        // A3: stride-8 sparse (measured: 32 of 256 coefficients non-zero).
        // 256 Horner steps -> 32, four times over.
        eval_periodic_stride_at_z(&C4_RC0_COEFFS, z, 8),
        eval_periodic_stride_at_z(&C4_RC1_COEFFS, z, 8),
        eval_periodic_stride_at_z(&C4_RC2_COEFFS, z, 8),
        eval_periodic_stride_at_z(&C4_ROUND_FLAG_COEFFS, z, 8),
        eval_periodic_at_z(&C4_IS_BOUNDARY_COEFFS, z),
        eval_periodic_at_z(&C4_CHAIN_01_COEFFS, z),
        chain_34_z,
        chain_56_z,
        eval_periodic_at_z(&C4_CARRY_CAPTURE_COEFFS, z),
        chain_34_z,
        chain_56_z,
    ];

    // Collect OOD trace values. Circuit 4 is width-4.
    let ood_current_vec: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next_vec: Vec<Felt> = proof.ood_next_iter().collect();
    if ood_current_vec.len() != 4 || ood_next_vec.len() != 4 {
        return Err(VerifyError::DeepAliFailed);
    }
    let ood_current = [
        ood_current_vec[0], ood_current_vec[1], ood_current_vec[2], ood_current_vec[3],
    ];
    let ood_next = [
        ood_next_vec[0], ood_next_vec[1], ood_next_vec[2], ood_next_vec[3],
    ];

    // Derive α exactly like the prover (C4-specific domain tag).
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"rlc-c4\0\0");

    let c_at_z = evaluate_transition_at_ood_circuit_4(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)) with n = 256.
    const TRACE_LENGTH_C4: usize = 256;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C4);
    let g = Felt::new(GENERATOR_256);
    let last_row_x = g.exp((TRACE_LENGTH_C4 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    // [BIND-C2C4 2026-08-03] Boundary public-input binding at z. Same wound as
    // C2, same fix. Before this block the only binding of a C4 trace to
    // `[old_commitment, new_commitment, amount_hash, token_mint]` was the
    // trace-aligned step-5 check, measured PRE-FIX by
    // `c4_step5_public_input_binding_fires`
    // to be able to fire on 9 of 300 honest witnesses (3.00%). C4 carries twelve
    // assertions — three of them the two commitments and the amount hash — so
    // this is the circuit with the most public state and it had the least
    // binding. The prover folds the matching Q_bnd under the `bnd-c4` tag.
    //
    // POST-FIX, re-measured at `bd8be2b4`: that same probe now fires on
    // 4 of 300 (1.33%), DOWN from the 3.00% above. 3.00% is the PRE-fix figure
    // and must not be quoted as current. Cause: the query positions are drawn
    // from the Fiat-Shamir transcript and folding Q_bnd changes the committed
    // quotient, so the draw is re-randomised. Step 5 itself was not touched.
    // The per-query layer on C4 is therefore weaker than it was, which is only
    // acceptable because the fold below runs on every proof unconditionally.
    // [B7 2026-08-04] Weaker became GONE: the coset leaves no trace-aligned
    // positions and the step-5 arm is retired (`step5_is_vacuous_post_b7`).
    // 1.33% must not be quoted at all any more; the binding is this fold,
    // measured at 100% by `c4_lying_public_input_is_rejected`.
    let assertions = get_boundary_assertions(4, public_inputs)?;
    let alpha_bnd = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"bnd-c4\0\0");
    let c_bnd = boundary_fold_at_ood(&ood_current_vec, &assertions, z, z_t, g, alpha_bnd)
        .ok_or(VerifyError::DeepAliFailed)?;
    let c_total = c_at_z.add(c_bnd);

    // [B2] Phase 2 constrains the RECOMBINED Q(z) = SUM_j z^(jn) Q_j(z), so
    // the segment claims are reassembled before the AIR identity is applied.
    let rhs = proof.ood_quotient_recombined(TRACE_LENGTH_C4).mul(z_t);
    if c_total != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

// ============================================================================
// [P2.2d-C5] DEEP-ALI for circuit 5 (transfer, width=6, trace=512)
// ============================================================================

/// [P2.2d-C5] Evaluate the 23 transfer transition constraints at OOD
/// and RLC-combine with α. Mirrors `evaluate_transfer_transition` in
/// `stark/src/air/transfer.rs`. Any drift here breaks honest-prover
/// acceptance.
///
/// Constraint order (must exactly match the prover):
///   [0-2]  Poseidon state transition (active when round_flag=1,
///          identity when round_flag=0, unconstrained at cycle boundary
///          via is_boundary gate).
///   [3-9]  Direct col-0 chaining — 7 edges gated by period-512
///          chain_*_* columns (0→1, 2→3, 3→4, 5→6, 6→7, 9→10, 12→13).
///   [10]   carry_owner capture: next[3] == current[0] when
///          capture_owner=1 (end of cycle 2).
///   [11]   carry_owner continuity: next[3] == current[3] elsewhere.
///   [12]   carry_owner_mint capture: next[4] == current[0] when
///          capture_om=1 (end of cycle 1).
///   [13]   carry_owner_mint continuity: next[4] == current[4]
///          elsewhere.
///   [14]   om_to_3: next[1] == current[4] at cycle-3 start.
///   [15]   om_to_6: next[1] == current[4] at cycle-6 start.
///   [16]   owner_to_4: next[1] == current[3] at cycle-4 start.
///   [17]   owner_to_7: next[1] == current[3] at cycle-7 start.
///   [18]   capture_out1_rm: next[5] == current[0] at end of cycle 9.
///   [19]   out1_rm_to_10: next[1] == current[5] at cycle-10 start.
///   [20]   capture_out2_rm: next[5] == current[0] at end of cycle 12.
///   [21]   out2_rm_to_13: next[1] == current[5] at cycle-13 start.
///   [22]   carry_out_rm continuity: next[5] == current[5] except at
///          capture points (out_rm_capture_any gate).
///
/// [P2.2g] `#[inline(never)]` is load-bearing: without it the compiler fuses
/// this routine's 23-slot `cs` array and Poseidon-round locals into
/// `verify_deep_ali_circuit_5`'s already-busy frame (periodic_at_z + 11-row
/// Lagrange scratch), blowing the 4KB SBF frame cap. Devnet signature
/// `5zgoLt1nY2X5BZjpRmzz5tWskup73vhAXtwpUC2CaYRJZCwv977UhWF4wX9mdNnoNZ6gZqs2WCEp8YRD3MpbeonU`
/// failed with "Access violation in stack frame 7 at address 0x200007a58"
/// when this attribute was missing. All other circuit evaluators (1–4, 6)
/// already carry it; C5 is the heaviest AIR so the margin vanishes fastest.
#[inline(never)]
fn evaluate_transition_at_ood_circuit_5(
    ood_current: &[Felt; 7],
    ood_next: &[Felt; 7],
    periodic_at_z: &[Felt; 30],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_flag = periodic_at_z[3];
    // Slot 4 stays bound so this block remains a COMPLETE map of the 30
    // periodic columns, but nothing in C5 gates on `is_boundary` any more --
    // `nba` (slot 29) and `active` (slot 28) do. Deleting the line would make
    // the index map lie by omission.
    let _is_boundary = periodic_at_z[4];
    let chain_0_1 = periodic_at_z[5];
    let chain_2_3 = periodic_at_z[6];
    let chain_3_4 = periodic_at_z[7];
    let chain_5_6 = periodic_at_z[8];
    let chain_6_7 = periodic_at_z[9];
    let chain_9_10 = periodic_at_z[10];
    let chain_12_13 = periodic_at_z[11];
    let capture_owner = periodic_at_z[12];
    let capture_om = periodic_at_z[13];
    let capture_out1_rm = periodic_at_z[14];
    let capture_out2_rm = periodic_at_z[15];
    let om_to_3 = periodic_at_z[16];
    let om_to_6 = periodic_at_z[17];
    let owner_to_4 = periodic_at_z[18];
    let owner_to_7 = periodic_at_z[19];
    let out1_rm_to_10 = periodic_at_z[20];
    let out2_rm_to_13 = periodic_at_z[21];
    let out_rm_capture_any = periodic_at_z[22];
    // [#2 voie A] value-conservation periodic columns (indices 23-27).
    let add_in1 = periodic_at_z[23];
    let add_in2 = periodic_at_z[24];
    let sub_out1 = periodic_at_z[25];
    let sub_out2 = periodic_at_z[26];
    let acc_continuity = periodic_at_z[27];
    let active = periodic_at_z[28];
    let nba = periodic_at_z[29];

    // [C5-N1024] Every continuity constraint is pre-multiplied by `active`, and
    // the Poseidon rows use `nba`.
    //
    // 🚨 `one.sub(is_boundary)` MUST NOT COME BACK ON cs[0..3]. It and `nba`
    // agree on every row of the fourteen real cycles and differ only across
    // rows 448..1023, so the substitution rejects NO honest proof while
    // re-imposing the Poseidon rounds on the 576 blinding rows.
    //
    // ⚠️ AND THE FOUR CONTINUITY ROWS ARE THE BIGGER HALF HERE. cs[11], [13],
    // [22] and [27] each say "this carry column does not change". Ungated they
    // pin cols 3, 4, 5 and 6 constant across the whole mask -- one unknown per
    // column instead of 576 -- which is the shape `air_aware_recovery_c5.rs`
    // solves for all four note amounts and for `owner`.
    //
    // ⛔ EACH LINE CARRIES AT MOST TWO PERIODIC FACTORS. cs[0..3] spend theirs
    // on `nba` and `round_flag`; the four continuity rows spend one on `active`
    // and one on their own flag. A third takes ce_blowup_factor from 8 to 16.

    let one = Felt::ONE;
    let three = Felt::new(3);
    // 🚨 `let not_boundary = one.sub(is_boundary)` STOOD HERE UNTIL 2026-08-30
    // AND MUST NOT COME BACK. `transfer.rs::evaluate_transition` had already
    // moved cs[0..3] to `nba`; this side had not, and the two disagree on rows
    // 448..1023 — so `C(z)` and `Q(z)·Z_T(z)` disagreed and EVERY honest C5
    // proof failed DEEP-ALI, under one blanket `DeepAliFailed` that names
    // neither the constraint nor the circuit.
    //
    // The privacy half is the reason the AIR moved: `not_boundary` is 1 across
    // the 576 blinding rows, so it re-imposes the Poseidon rounds on all of
    // them. Here the two halves point the same way — the same substitution that
    // breaks acceptance is the one that would leak — which is luck, not design:
    // C3 carries the identical hazard and there it rejects NOTHING.
    // `c5_ood_evaluator_matches_the_air_on_random_frames` is what pins it.

    // ── Poseidon round on cols 0-2 (MDS = circulant [[3,1,1],[1,3,1],[1,1,3]]) ──
    let s0 = ood_current[0].add(rc0);
    let s1 = ood_current[1].add(rc1);
    let s2 = ood_current[2].add(rc2);
    let s0_7 = s0.pow7();
    let s1_7 = s1.pow7();
    let s2_7 = s2.pow7();
    let ro0 = three.mul(s0_7).add(s1_7).add(s2_7);
    let ro1 = s0_7.add(three.mul(s1_7)).add(s2_7);
    let ro2 = s0_7.add(s1_7).add(three.mul(s2_7));

    let mut cs = [Felt::ZERO; 28];

    // [0-2] Poseidon state transition.
    cs[0] = nba.mul(
        ood_next[0].sub(ood_current[0]).sub(round_flag.mul(ro0.sub(ood_current[0])))
    );
    cs[1] = nba.mul(
        ood_next[1].sub(ood_current[1]).sub(round_flag.mul(ro1.sub(ood_current[1])))
    );
    cs[2] = nba.mul(
        ood_next[2].sub(ood_current[2]).sub(round_flag.mul(ro2.sub(ood_current[2])))
    );

    // [3-9] Direct col-0 chaining (7 edges).
    cs[3] = chain_0_1.mul(ood_next[0].sub(ood_current[0]));
    cs[4] = chain_2_3.mul(ood_next[0].sub(ood_current[0]));
    cs[5] = chain_3_4.mul(ood_next[0].sub(ood_current[0]));
    cs[6] = chain_5_6.mul(ood_next[0].sub(ood_current[0]));
    cs[7] = chain_6_7.mul(ood_next[0].sub(ood_current[0]));
    cs[8] = chain_9_10.mul(ood_next[0].sub(ood_current[0]));
    cs[9] = chain_12_13.mul(ood_next[0].sub(ood_current[0]));

    // [10-11] carry_owner (col 3).
    cs[10] = capture_owner.mul(ood_next[3].sub(ood_current[0]));
    cs[11] = active.mul(one.sub(capture_owner).mul(ood_next[3].sub(ood_current[3])));

    // [12-13] carry_owner_mint (col 4).
    cs[12] = capture_om.mul(ood_next[4].sub(ood_current[0]));
    cs[13] = active.mul(one.sub(capture_om).mul(ood_next[4].sub(ood_current[4])));

    // [14-15] carry_owner_mint → right input.
    cs[14] = om_to_3.mul(ood_next[1].sub(ood_current[4]));
    cs[15] = om_to_6.mul(ood_next[1].sub(ood_current[4]));

    // [16-17] carry_owner → right input.
    cs[16] = owner_to_4.mul(ood_next[1].sub(ood_current[3]));
    cs[17] = owner_to_7.mul(ood_next[1].sub(ood_current[3]));

    // [18-21] carry_out_rm (col 5).
    cs[18] = capture_out1_rm.mul(ood_next[5].sub(ood_current[0]));
    cs[19] = out1_rm_to_10.mul(ood_next[1].sub(ood_current[5]));
    cs[20] = capture_out2_rm.mul(ood_next[5].sub(ood_current[0]));
    cs[21] = out2_rm_to_13.mul(ood_next[1].sub(ood_current[5]));

    // [22] carry_out_rm continuity (except at capture points).
    cs[22] = active.mul(one.sub(out_rm_capture_any).mul(ood_next[5].sub(ood_current[5])));

    // [#2 voie A] [23-27] Value conservation (col 6 = acc). EXACT same order
    // and sign as the prover's `evaluate_transfer_transition`
    // (stark/src/air/transfer.rs):
    //   add_in*  fire at the input-amount rows → acc(next) = acc(cur) − amount
    //            i.e. (next[6] − current[6] + current[0]) == 0.
    //   sub_out* fire at the output-amount rows → acc(next) = acc(cur) + amount
    //            i.e. (next[6] − current[6] − current[0]) == 0.
    //   acc_continuity fires everywhere else → next[6] == current[6].
    cs[23] = add_in1.mul(ood_next[6].sub(ood_current[6]).add(ood_current[0]));
    cs[24] = add_in2.mul(ood_next[6].sub(ood_current[6]).add(ood_current[0]));
    cs[25] = sub_out1.mul(ood_next[6].sub(ood_current[6]).sub(ood_current[0]));
    cs[26] = sub_out2.mul(ood_next[6].sub(ood_current[6]).sub(ood_current[0]));
    cs[27] = active.mul(acc_continuity.mul(ood_next[6].sub(ood_current[6])));

    // Horner RLC: Σ α^i · cs[i].
    let mut combined = Felt::ZERO;
    let mut alpha_pow = Felt::ONE;
    for c in cs.iter() {
        combined = combined.add(c.mul(alpha_pow));
        alpha_pow = alpha_pow.mul(alpha);
    }
    combined
}

/// [#2 voie A] Evaluate circuit 5's 28 periodic columns at the OOD point `z`.
///
/// Split out of `verify_deep_ali_circuit_5` with `#[inline(never)]` so its
/// heavy scratch (`[Felt;15]` ×3 + the `[Felt;28]` result) lives in its own SBF
/// frame, keeping both functions under the 4KB per-frame cap after the width-7
/// rebake. Returns `None` (caller rejects) only if `z` coincides with one of the
/// 15 hot rows — vanishingly rare over a random OOD `z`.
///
/// Evaluation strategy (per [P2.2g], extended for the 4 amount rows):
///   - Cols 0–3 (rc0/1/2, round_flag): stride-16 Horner (36 muls each).
///   - 21 single-hot flag columns (the routing flags + the 4 new amount
///     captures at rows 64/160/288/384): Lagrange closed form — 15 unique rows
///     batch-inverted once, then 3 muls per column.
///   - Col 22 (out_rm_capture_any, 2-hot): sum of two precomputed Lagrange
///     terms.
///   - Col 27 (acc_continuity, 508-hot): `1 − (add_in1+add_in2+sub_out1+
///     sub_out2)`, the exact polynomial the prover built — a 3-sub identity
///     rather than a 512-coeff dense Horner.
///   - Col 4 (is_boundary, 15-hot): dense Horner (cheaper than 15 Lagrange).
#[inline(never)]
fn compute_c5_periodic_at_z(z: Felt) -> Result<[Felt; 30], VerifyError> {
    use crate::periodic_consts::{
        C5_ACTIVE_COEFFS, C5_IS_BOUNDARY_COEFFS, C5_NOT_BOUNDARY_ACTIVE_COEFFS,
        C5_RC0_COEFFS, C5_RC1_COEFFS, C5_RC2_COEFFS, C5_ROUND_FLAG_COEFFS,
    };

    // [C5-N1024] The one-hot Lagrange basis lives on the TRACE subgroup, so all
    // four of these move with n. The flag ROWS below do not — they are absolute
    // positions inside the walk, which did not move.
    let g_1024 = Felt::new(GENERATOR_1024);
    let n_felt = Felt::new(1024);
    let inv_n = n_felt.inv();
    let z_n = z.exp(1024);
    let z_n_minus_one = z_n.add(Felt::new(crate::goldilocks::MODULUS - 1));

    // 15 unique trace-row positions hit by the 21 single-hot flag columns and
    // the 2-hot `out_rm_capture_any` column. Keep aligned with `FLAG_ROW_*`.
    const FLAG_ROW_CAPTURE_OWNER: usize = 0;   // row 30
    const FLAG_ROW_CHAIN_0_1: usize = 1;       // row 31
    const FLAG_ROW_CAPTURE_OM: usize = 2;      // row 62
    const FLAG_ROW_95: usize = 3;              // chain_2_3, om_to_3
    const FLAG_ROW_127: usize = 4;             // chain_3_4, owner_to_4
    const FLAG_ROW_191: usize = 5;             // chain_5_6, om_to_6
    const FLAG_ROW_223: usize = 6;             // chain_6_7, owner_to_7
    const FLAG_ROW_CAPTURE_OUT1_RM: usize = 7; // row 286
    const FLAG_ROW_319: usize = 8;             // chain_9_10, out1_rm_to_10
    const FLAG_ROW_CAPTURE_OUT2_RM: usize = 9; // row 382
    const FLAG_ROW_415: usize = 10;            // chain_12_13, out2_rm_to_13
    // [#2 voie A] Four new amount-capture rows (one-hot) for value conservation.
    const FLAG_ROW_ADD_IN1: usize = 11;        // row 64  (in_amount_1)
    const FLAG_ROW_ADD_IN2: usize = 12;        // row 160 (in_amount_2)
    const FLAG_ROW_SUB_OUT1: usize = 13;       // row 288 (out_amount_1)
    const FLAG_ROW_SUB_OUT2: usize = 14;       // row 384 (out_amount_2)
    const FLAG_ROWS: [u64; 15] = [
        30, 31, 62, 95, 127, 191, 223, 286, 319, 382, 415,
        64, 160, 288, 384,
    ];

    let mut g_pows = [Felt::ZERO; 15];
    let mut diffs = [Felt::ZERO; 15];
    for i in 0..15 {
        let g_k = g_1024.exp(FLAG_ROWS[i]);
        g_pows[i] = g_k;
        // z − g^k = z + (p − g^k)
        diffs[i] = z.add(Felt::new(crate::goldilocks::MODULUS - g_k.as_u64()));
    }

    let mut inv_diffs = [Felt::ZERO; 15];
    if !batch_inverse(&diffs, &mut inv_diffs) {
        // z coincides with a hot row — prover cheated or astronomically
        // unlucky; reject.
        return Err(VerifyError::DeepAliFailed);
    }

    let lagrange = |i: usize| -> Felt {
        eval_one_hot_lagrange(g_pows[i], z_n_minus_one, inv_diffs[i], inv_n)
    };

    let l_capture_owner = lagrange(FLAG_ROW_CAPTURE_OWNER);
    let l_chain_0_1 = lagrange(FLAG_ROW_CHAIN_0_1);
    let l_capture_om = lagrange(FLAG_ROW_CAPTURE_OM);
    let l_row_95 = lagrange(FLAG_ROW_95);
    let l_row_127 = lagrange(FLAG_ROW_127);
    let l_row_191 = lagrange(FLAG_ROW_191);
    let l_row_223 = lagrange(FLAG_ROW_223);
    let l_capture_out1_rm = lagrange(FLAG_ROW_CAPTURE_OUT1_RM);
    let l_row_319 = lagrange(FLAG_ROW_319);
    let l_capture_out2_rm = lagrange(FLAG_ROW_CAPTURE_OUT2_RM);
    let l_row_415 = lagrange(FLAG_ROW_415);
    // [#2 voie A] Value-conservation one-hots + the 508-hot continuity column.
    let l_add_in1 = lagrange(FLAG_ROW_ADD_IN1);
    let l_add_in2 = lagrange(FLAG_ROW_ADD_IN2);
    let l_sub_out1 = lagrange(FLAG_ROW_SUB_OUT1);
    let l_sub_out2 = lagrange(FLAG_ROW_SUB_OUT2);
    let l_acc_continuity = Felt::ONE
        .sub(l_add_in1)
        .sub(l_add_in2)
        .sub(l_sub_out1)
        .sub(l_sub_out2);

    Ok([
        eval_periodic_stride32_at_z(&C5_RC0_COEFFS, z),
        eval_periodic_stride32_at_z(&C5_RC1_COEFFS, z),
        eval_periodic_stride32_at_z(&C5_RC2_COEFFS, z),
        eval_periodic_stride32_at_z(&C5_ROUND_FLAG_COEFFS, z),
        eval_periodic_at_z(&C5_IS_BOUNDARY_COEFFS, z), // 15-hot → dense Horner
        l_chain_0_1,                                    // chain_0_1 (row 31)
        l_row_95,                                       // chain_2_3
        l_row_127,                                      // chain_3_4
        l_row_191,                                      // chain_5_6
        l_row_223,                                      // chain_6_7
        l_row_319,                                      // chain_9_10
        l_row_415,                                      // chain_12_13
        l_capture_owner,                                // capture_owner
        l_capture_om,                                   // capture_om
        l_capture_out1_rm,                              // capture_out1_rm
        l_capture_out2_rm,                              // capture_out2_rm
        l_row_95,                                       // om_to_3
        l_row_191,                                      // om_to_6
        l_row_127,                                      // owner_to_4
        l_row_223,                                      // owner_to_7
        l_row_319,                                      // out1_rm_to_10
        l_row_415,                                      // out2_rm_to_13
        l_capture_out1_rm.add(l_capture_out2_rm),       // out_rm_capture_any
        // [#2 voie A] indices 23-27 (must match prover periodic order).
        l_add_in1,                                      // add_in1  (row 64)
        l_add_in2,                                      // add_in2  (row 160)
        l_sub_out1,                                     // sub_out1 (row 288)
        l_sub_out2,                                     // sub_out2 (row 384)
        l_acc_continuity,                               // acc_continuity
        // [C5-N1024] The two row gates, APPENDED. Genuinely dense: they are 1
        // on rows 0..=446 and 0 from 447 on, which has no period, so unlike the
        // four stride tables above they cost a full-length Horner each.
        //
        // ⛔ RETURNING 28 INSTEAD OF 30 WOULD BE A SILENT PRIVACY REGRESSION.
        // It rejects no honest proof: drop slots 28 and 29 and the verifier
        // re-imposes the Poseidon rounds AND the four carry-continuity rows
        // across rows 448..1023. The continuity rows are the worse half — they
        // pin cols 3, 4, 5 and 6 constant, which is what
        // `air_aware_recovery_c5.rs` solves for all four note amounts.
        eval_periodic_at_z(&C5_ACTIVE_COEFFS, z),
        eval_periodic_at_z(&C5_NOT_BOUNDARY_ACTIVE_COEFFS, z),
    ])
}

/// [P2.2d-C5] Check the DEEP-ALI identity at the OOD point for circuit 5.
///
/// Computes:
///   1. α from the Fiat-Shamir transcript (`trace_root || pub_inputs ||
///      "rlc-c5\0\0"`).
///   2. The 30 periodic polynomials evaluated at z (via
///      `compute_c5_periodic_at_z`).
///   3. The 28 transition constraints on the opened OOD trace (width 7),
///      RLC-combined with α to produce `C(z)`.
///   4. `Z_T(z) = (z^n - 1) / (z - g^(n-1))` with `n = 1024` and `g` the
///      generator OF THAT subgroup — 512 and GENERATOR_512 until the C5 mask
///      forced the trace to double. Leaving either behind rejects every honest
///      proof, which is how it was found.
///   5. The 24-assertion boundary fold (incl. the acc conservation boundary).
///      26 until the two padding cycles' capacity assertions left the list.
///   6. The identity `C(z) == Q(z) · Z_T(z)`.
///
/// Circuit 5 proves a UTXO-style transfer: two input notes get nullified,
/// two output notes get committed, the amounts balance against a public
/// (unshield) amount, and both input commitments derive from the same
/// `spending_key × token_mint` pair via chained Poseidon hashes. Without
/// DEEP-ALI on all 28 constraints an attacker could forge a mismatched
/// routing of carry columns (owner / owner_mint / out_rm), or mint value from
/// nothing (the 5 conservation constraints), and produce a valid wire format
/// that nullifies someone else's notes or unbalances outputs — soundness
/// collapses. This check binds every chain edge, capture point, continuity, and
/// conservation constraint to the opened OOD trace via Schwartz–Zippel.
#[inline(never)]
pub fn verify_deep_ali_circuit_5(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    let z = proof.ood_z;

    // [#2 voie A] The width-7 / 28-column rebake grew the Lagrange scratch
    // (`[Felt;15]` ×3 + the `[Felt;28]` periodic array) past the point where it
    // fit in this function's SBF frame alongside the OOD arrays + boundary fold.
    // Computing `periodic_at_z` in its own `#[inline(never)]` frame keeps both
    // frames under the 4KB SBF cap. (Same frame-isolation tactic already used by
    // `evaluate_transition_at_ood_circuit_5` and `batch_inverse`.)
    let periodic_at_z = compute_c5_periodic_at_z(z)?;

    // Collect OOD trace values. Circuit 5 is width-7 after the value-
    // conservation rebake (col 6 = signed amount accumulator).
    let ood_current_vec: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next_vec: Vec<Felt> = proof.ood_next_iter().collect();
    if ood_current_vec.len() != 7 || ood_next_vec.len() != 7 {
        return Err(VerifyError::DeepAliFailed);
    }
    let ood_current = [
        ood_current_vec[0], ood_current_vec[1], ood_current_vec[2],
        ood_current_vec[3], ood_current_vec[4], ood_current_vec[5],
        ood_current_vec[6],
    ];
    let ood_next = [
        ood_next_vec[0], ood_next_vec[1], ood_next_vec[2],
        ood_next_vec[3], ood_next_vec[4], ood_next_vec[5],
        ood_next_vec[6],
    ];

    // Derive α exactly like the prover (C5-specific domain tag).
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"rlc-c5\0\0");

    let c_at_z = evaluate_transition_at_ood_circuit_5(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)) with n = 512.
    // [C5-N1024] 512 -> 1024. `quotient_segments` stays 8 and rho stays
    // 1/16; both are scale-invariant in n.
    const TRACE_LENGTH_C5: usize = 1024;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C5);
    // ⛔ THE GENERATOR MOVES WITH `n`, AND NOTHING TYPE-CHECKS THAT IT DID.
    // `g^(n-1)` is the last row of the TRACE subgroup, so it must be the
    // generator OF THAT SUBGROUP. Left at GENERATOR_512 with n = 1024 -- which
    // is how this line stood on 2026-08-29 -- `g_512^1023 = g_512^511 * g_512^512
    // = g_512^511` lands on a point of the WRONG group, Z_T is divided by the
    // wrong factor, and EVERY honest proof fails DEEP-ALI. Nothing rejects a
    // bad proof for a different reason first, so the only symptom is a blanket
    // `DeepAliFailed` that reads exactly like a broken prover.
    let g = Felt::new(GENERATOR_1024);
    let last_row_x = g.exp((TRACE_LENGTH_C5 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    // [C2] Boundary public-input binding at z. Circuit 5 has 24 assertions
    // after the value-conservation rebake and the C5-N1024 mask: 14 capacity
    // zeros (rows 0,32,…,416 — 16 before the mask; rows 448 and 480 belonged to
    // the two padding cycles and are now blinding rows),
    // col1@row0=0, token_mint at rows 32/256/352, the 4 output public inputs
    // (nullifiers + commitments) at the cycle-output rows, and the 2
    // accumulator boundaries (acc@row0=0, acc@row385=public_amount). This binds
    // nullifier_1/2, output_commitment_1/2, token_mint, AND the conserved value
    // (public_amount) to the trace at the OOD point.
    let assertions = get_boundary_assertions(5, public_inputs)?;
    let alpha_bnd = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"bnd-c5\0\0");
    let c_bnd = boundary_fold_at_ood(&ood_current_vec, &assertions, z, z_t, g, alpha_bnd)
        .ok_or(VerifyError::DeepAliFailed)?;
    let c_total = c_at_z.add(c_bnd);

    // [B2] Phase 2 constrains the RECOMBINED Q(z) = SUM_j z^(jn) Q_j(z), so
    // the segment claims are reassembled before the AIR identity is applied.
    let rhs = proof.ood_quotient_recombined(TRACE_LENGTH_C5).mul(z_t);
    if c_total != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}


// ============================================================================
// [C7] Spend circuit -- the unlinkable denominated withdrawal
// ============================================================================

/// [C7] The eighteen transition constraints at the OOD point, RLC-combined
/// with `alpha^i`.
///
/// Mirrors `evaluate_spend_transition` (stark/src/air/spend.rs) constraint for
/// constraint. The ORDER is load-bearing: the RLC weights are `alpha^i` over
/// this exact sequence, so swapping two lines produces a different polynomial
/// and every honest proof fails.
///
/// 🚨 THE GATE IS `nba`, NEVER `1 - is_boundary`, AND THE TWO ARE NOT
/// INTERCHANGEABLE.
///
/// C7 gates its Poseidon rounds with `nba` = `periodic[12]` =
/// `not_boundary_active`, which is zero on rows 383..511 as well as on the
/// boundary rows. `1 - is_boundary` is zero only on the boundary rows. Swap them
/// and the Poseidon constraints switch back ON across the blinding region: 128
/// rows per column that must carry free randomness become constrained, the
/// counting argument in `air/spend.rs` collapses, and the note commitment is
/// solvable from the published evaluations again.
///
/// ⚠️ NOTE CORRECTED 2026-08-29. This paragraph used to read "THE ONE PLACE C6
/// MUST NOT BE COPIED" and said C6 gated with `1 - is_boundary`. That WAS true
/// and is not any more: C6 took the same depth-12 cut, grew the same two gate
/// columns, and now gates with its own `nba` (`periodic_at_z[8]`). The hazard
/// is unchanged; the example of it is gone. Left as it stood, the warning would
/// send a reader to `evaluate_transition_at_ood_circuit_6` to see the mistake
/// and they would find the correct code, which is how a stale warning teaches
/// people to stop reading warnings.
///
/// ✅ WHAT CATCHES IT NOW IS A TEST, NOT THIS COMMENT.
/// `c7_ood_evaluator_matches_the_air_on_random_frames` and its C6 twin feed the
/// same random frame to the AIR and to the evaluator and compare. A frame with a
/// nonzero `is_boundary` and a zero `nba` separates the two gates; no
/// honest-proof test can, because the substitution rejects nothing and only
/// removes the privacy property.
///
/// `periodic_at_z` indices, all thirteen:
///   0 rc0 · 1 rc1 · 2 rc2 · 3 round_flag · 4 is_boundary · 5 hash_start
///   6 is_interior · 7 chain_flag · 8 commit_out_flag · 9 row0_flag
///   10 hold_link_31 · 11 active · 12 not_boundary_active
#[inline(never)]
fn evaluate_transition_at_ood_circuit_7(
    // [ZK-RANDOMIZER 2026-08-30] 10 -> 11. Index 10 is the randomizer column and
    // NOTHING below reads it -- that is the point. It is present here only
    // because the OOD frame carries it, and it must be carried: the DEEP
    // recombination sums a gamma power over every committed column, and dropping
    // it there would make `C(z)` and `Q(z)*Z_T(z)` disagree on every proof.
    ood_current: &[Felt; 11],
    ood_next: &[Felt; 11],
    periodic_at_z: &[Felt; 13],
    alpha: Felt,
) -> Felt {
    let rc0 = periodic_at_z[0];
    let rc1 = periodic_at_z[1];
    let rc2 = periodic_at_z[2];
    let round_flag = periodic_at_z[3];
    let is_boundary = periodic_at_z[4];
    let hash_start = periodic_at_z[5];
    let is_interior = periodic_at_z[6];
    let chain_flag = periodic_at_z[7];
    let commit_out_flag = periodic_at_z[8];
    let row0_flag = periodic_at_z[9];
    let hold_link_31 = periodic_at_z[10];
    let active = periodic_at_z[11];
    let nba = periodic_at_z[12];

    let one = Felt::ONE;
    let three = Felt::new(3);
    let not_boundary = one.sub(is_boundary);

    let mut cs = [Felt::ZERO; 18];

    // ── [0]-[2] Merkle Poseidon round (cols 0-2), gated by `nba` ──
    let s0 = ood_current[0].add(rc0);
    let s1 = ood_current[1].add(rc1);
    let s2 = ood_current[2].add(rc2);
    let s0_7 = s0.pow7();
    let s1_7 = s1.pow7();
    let s2_7 = s2.pow7();
    let ro0 = three.mul(s0_7).add(s1_7).add(s2_7);
    let ro1 = s0_7.add(three.mul(s1_7)).add(s2_7);
    let ro2 = s0_7.add(s1_7).add(three.mul(s2_7));
    cs[0] = nba.mul(
        ood_next[0].sub(ood_current[0]).sub(round_flag.mul(ro0.sub(ood_current[0])))
    );
    cs[1] = nba.mul(
        ood_next[1].sub(ood_current[1]).sub(round_flag.mul(ro1.sub(ood_current[1])))
    );
    cs[2] = nba.mul(
        ood_next[2].sub(ood_current[2]).sub(round_flag.mul(ro2.sub(ood_current[2])))
    );

    // ── [3]-[5] Hash start mux: state = mux(direction, carry, sibling) ──
    let dir = ood_current[4];
    let sib = ood_current[3];
    let carry = ood_current[5];
    let hash_start_a = hash_start.mul(active);
    cs[3] = hash_start_a.mul(ood_current[0].sub(carry).sub(dir.mul(sib.sub(carry))));
    cs[4] = hash_start_a.mul(ood_current[1].sub(sib).sub(dir.mul(carry.sub(sib))));
    cs[5] = hash_start_a.mul(ood_current[2]);

    // ── [6]-[7] Carry update at boundary, continuity off it ──
    cs[6] = is_boundary.mul(active).mul(ood_next[5].sub(ood_current[0]));
    cs[7] = nba.mul(ood_next[5].sub(ood_current[5]));

    // ── [8]-[10] Sibling / direction continuity, direction binary ──
    let is_interior_a = is_interior.mul(active);
    cs[8] = is_interior_a.mul(ood_next[3].sub(ood_current[3]));
    cs[9] = is_interior_a.mul(ood_next[4].sub(ood_current[4]));
    cs[10] = hash_start_a.mul(dir).mul(one.sub(dir));

    // ── [11]-[13] Commitment Poseidon round (cols 6-8), gated by `nba` ──
    let t0 = ood_current[6].add(rc0);
    let t1 = ood_current[7].add(rc1);
    let t2 = ood_current[8].add(rc2);
    let t0_7 = t0.pow7();
    let t1_7 = t1.pow7();
    let t2_7 = t2.pow7();
    let co0 = three.mul(t0_7).add(t1_7).add(t2_7);
    let co1 = t0_7.add(three.mul(t1_7)).add(t2_7);
    let co2 = t0_7.add(t1_7).add(three.mul(t2_7));
    cs[11] = nba.mul(
        ood_next[6].sub(ood_current[6]).sub(round_flag.mul(co0.sub(ood_current[6])))
    );
    cs[12] = nba.mul(
        ood_next[7].sub(ood_current[7]).sub(round_flag.mul(co1.sub(ood_current[7])))
    );
    cs[13] = nba.mul(
        ood_next[8].sub(ood_current[8]).sub(round_flag.mul(co2.sub(ood_current[8])))
    );

    // ── [14] Chain: blind_hash (col 6 @ row 63) -> cycle 2's RIGHT input ──
    // Without it, blind_hash is a free prover choice and the commitment at row
    // 94 is whatever the prover wants -- [16]/[17] would bind a value the
    // prover controls end to end.
    cs[14] = chain_flag.mul(ood_next[7].sub(ood_current[6]));

    // ── [15]-[17] Hold column (col 9) ──
    // [15] is GATED. Ungated it forces col 9 constant on all 512 rows, making
    // it a degree-0 polynomial whose value IS the commitment at every published
    // evaluation. The three gate terms are mutually exclusive, so the sum is
    // 0 or 1 and never 2.
    cs[15] = active
        .mul(not_boundary.add(hold_link_31).add(chain_flag))
        .mul(ood_next[9].sub(ood_current[9]));
    cs[16] = commit_out_flag.mul(ood_current[9].sub(ood_current[6]));
    cs[17] = row0_flag.mul(ood_current[5].sub(ood_current[9]));

    let mut acc = Felt::ZERO;
    let mut alpha_power = Felt::ONE;
    for c in cs.iter() {
        acc = acc.add(alpha_power.mul(*c));
        alpha_power = alpha_power.mul(alpha);
    }
    acc
}

/// [C7] Phase-2 DEEP-ALI for the spend circuit.
///
/// Skeleton is `verify_deep_ali_circuit_5`'s, with width 10 and C7's tags.
///
/// ⛔ NO DEPTH PREAMBLE, deliberately. C6 pins `public_inputs[4] ==
/// CANONICAL_DEPTH` before anything else because its periodic columns are
/// depth-dependent. C7 has no depth public input at all: the depth is baked
/// into the AIR and into the row-382 boundary assertion, so there is no
/// caller-chosen number to pin and no window to get wrong.
///
/// 🚨 FOR C7 THIS FUNCTION IS THE WHOLE BINDING. The per-query transition layer
/// is dead on this lineage (`is_trace_aligned` hardcoded false at every site)
/// and step 5 is gone, so nothing else ties the published public inputs to the
/// trace. If this returns Ok on a proof it should have rejected, there is no
/// second line of defence.
#[inline(never)]
pub fn verify_deep_ali_circuit_7(
    proof: &GenericCompactProof,
    public_inputs: &[u64],
) -> Result<(), VerifyError> {
    let z = proof.ood_z;

    // Own `#[inline(never)]` frame: thirteen periodic values plus the Lagrange
    // scratch would not fit alongside the OOD arrays in one 4KB SBF frame.
    let periodic_at_z = compute_c7_periodic_at_z(z)?;

    let ood_current_vec: Vec<Felt> = proof.ood_current_iter().collect();
    let ood_next_vec: Vec<Felt> = proof.ood_next_iter().collect();
    // [ZK-RANDOMIZER 2026-08-30] 10 -> 11, AND THIS LINE IS THE ONE THAT BITES.
    // It sits BEFORE the frame construction below, so left at 10 it rejects
    // every honest proof with `DeepAliFailed` — and had it passed at 10, the
    // `[10]` index below would have panicked instead. Two failure modes, one
    // number, and the arity guard must move with `CONFIG_SPEND.trace_width`.
    if ood_current_vec.len() != 11 || ood_next_vec.len() != 11 {
        return Err(VerifyError::DeepAliFailed);
    }
    let ood_current = [
        ood_current_vec[0], ood_current_vec[1], ood_current_vec[2],
        ood_current_vec[3], ood_current_vec[4], ood_current_vec[5],
        ood_current_vec[6], ood_current_vec[7], ood_current_vec[8],
        ood_current_vec[9],
        // [ZK-RANDOMIZER] Slot 10. No constraint reads it; it is carried so the
        // frame the evaluator sees is the frame the prover committed to.
        ood_current_vec[10],
    ];
    let ood_next = [
        ood_next_vec[0], ood_next_vec[1], ood_next_vec[2],
        ood_next_vec[3], ood_next_vec[4], ood_next_vec[5],
        ood_next_vec[6], ood_next_vec[7], ood_next_vec[8],
        ood_next_vec[9],
        ood_next_vec[10],
    ];

    // A FRESH tag. `derive_rlc_alpha` (untagged) is hardwired to `rlc-v1`,
    // which C6 uses; reusing any existing tag would let two different folds
    // derive the same challenge.
    let pub_bytes = public_inputs_to_bytes(public_inputs);
    let alpha = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"rlc-c7\0\0");

    let c_at_z = evaluate_transition_at_ood_circuit_7(
        &ood_current, &ood_next, &periodic_at_z, alpha,
    );

    // Z_T(z) = (z^n - 1) / (z - g^(n-1)), n = 512.
    const TRACE_LENGTH_C7: usize = 512;
    let z_d = vanishing_poly(z, TRACE_LENGTH_C7);
    let g = Felt::new(GENERATOR_512);
    let last_row_x = g.exp((TRACE_LENGTH_C7 - 1) as u64);
    let neg_last = Felt::new(crate::goldilocks::MODULUS - last_row_x.as_u64());
    let z_minus_last = z.add(neg_last);
    if z_minus_last == Felt::ZERO {
        return Err(VerifyError::DeepAliFailed);
    }
    let z_t = z_d.mul(z_minus_last.inv());

    // [C2] Boundary public-input binding at z. Six assertions, in
    // `SPEND_BOUNDARY_SPEC` order.
    let assertions = get_boundary_assertions(7, public_inputs)?;
    // Explicit count check. `boundary_fold_at_ood` used to return
    // `Some(Felt::ZERO)` for an empty list, so `.ok_or(..)` could not tell
    // "rejected" from "nothing to fold". That path now returns `None`, and this
    // is the belt to its braces: for C7 an unbound public input means a forged
    // nullifier and a chosen subtree root both verify.
    if assertions.len() != 6 {
        return Err(VerifyError::DeepAliFailed);
    }
    let alpha_bnd = derive_rlc_alpha_with_tag(&proof.trace_root, &pub_bytes, b"bnd-c7\0\0");
    let c_bnd = boundary_fold_at_ood(&ood_current_vec, &assertions, z, z_t, g, alpha_bnd)
        .ok_or(VerifyError::DeepAliFailed)?;
    let c_total = c_at_z.add(c_bnd);

    // [B2] The recombined Q(z) = SUM_j z^(jn) Q_j(z).
    let rhs = proof.ood_quotient_recombined(TRACE_LENGTH_C7).mul(z_t);
    if c_total != rhs {
        return Err(VerifyError::DeepAliFailed);
    }
    Ok(())
}

/// [C7] Phase-1 per-query arm.
///
/// Vacuous, exactly like its eight siblings, and that is not an oversight: the
/// coset LDE (`LDE_COSET_SHIFT = 7`) means `x = h * g^i`, so an "aligned"
/// position is not a trace row and the comparison it used to make is
/// meaningless. Every circuit's arm has been dead since B7.
///
/// ⛔ AND C7 MUST NEVER GROW ONE. C3's padding branch and C6's both demand
/// `next == current` on all columns past their active range. Applied to C7 that
/// fires on rows 384..=510 and collapses 128 independent mask values per column
/// to a single repeated one -- which is precisely the underdetermination the
/// depth-12 layout was adopted to buy. A per-query check here does not weaken
/// C7's privacy, it deletes it.
fn verify_constraints_spend(
    proof: &GenericCompactProof,
    _config: &CircuitConfig,
    _public_inputs: &[u64],
) -> Result<(), VerifyError> {
    for (query_idx, _query) in proof.queries.iter().enumerate() {
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
    }
    Ok(())
}

// ============================================================================
// [C4] + [C5] Quotient verification helper
// ============================================================================


// ============================================================================
// Circuit 0: subscriber_ownership
// ============================================================================

/// [C0 GATE] Unreachable from `verify_generic` — both the step-0 gate and the
/// step-4 dispatch arm refuse `circuit_id == 0` before this can run.
///
/// It is kept, and kept compiling, for one reason: it is the evidence for the
/// refusal. `c0_generic_path_cannot_verify_an_honest_c0_proof` calls it directly
/// on an honest C0 proof and records the failure, so the claim "the generic path
/// rejects honest C0 proofs" is a measurement in the test suite rather than a
/// comment. Delete it and the gate becomes an unargued assertion.
#[allow(dead_code)]
pub(crate) fn verify_constraints_subscriber_ownership(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    _public_inputs: &[u64],
) -> Result<(), VerifyError> {
    // [P2.2d] DEEP-ALI: bind Q to the AIR via `C(z) == Q(z) · Z_D(z)` at OOD.
    // Without this, a malicious prover could supply any low-degree Q (FRI
    // passes) and only the trace-aligned queries (1/blowup of total) would
    // catch it — 27 queries × 1/16 ≈ 1.7 transition checks per proof.
    verify_deep_ali_circuit_0(proof)?;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        // [B7] DISABLED, not deleted, and this is the whole point of the change.
        //
        // This arm read the opened value AS A RAW TRACE ROW, which only ever
        // worked because the LDE was evaluated on the raw subgroup. It was a
        // CONSUMER of the witness leak B7 removes: once x = h * g^i, an aligned
        // position is no longer a trace row and the comparison is meaningless.
        //
        // It could not simply be dropped either. Its job -- an INDEPENDENT
        // re-derivation, AIR against trace, which the OOD check cannot do
        // because the prover computes C from the same AIR -- caught the C3
        // (2026-05-29) and C6 (2026-08-01) padding-row defects. That job now
        // lives prover-side in `assert_air_agrees_with_trace_c0` and its generic
        // twin, over EVERY constrained row instead of whichever a query hit,
        // at zero on-chain CU, and each of the seven is proven non-vacuous by
        // the row-(n-1) mutation.
        //
        // Left as `false` rather than deleted so the arms stay readable next to
        // the constraint they used to check, and so this comment sits where
        // someone would look for them.
        let is_trace_aligned = false;
        let trace_row = (pos / config.blowup) % config.trace_length;

        // [C5] Check transition constraints at trace-aligned positions.
        //
        // The transition polynomial is enforced on rows 0..n-2 via the
        // transition vanishing polynomial Z_T(x) = (x^n-1)/(x-g^(n-1)).
        // Row n-1 wraps back to row 0 and is NOT constrained — this matches
        // the prover's `Q = C / Z_T` quotient (see stark/src/compact.rs).
        if is_trace_aligned && trace_row != config.trace_length - 1 {
            if trace_row < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(trace_row);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Verify quotient polynomial at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
    }
    Ok(())
}

// ============================================================================
// Circuit 1: pool_commitment
// ============================================================================

fn verify_constraints_pool_commitment(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    _public_inputs: &[u64],
) -> Result<(), VerifyError> {
    // [P2.2g] DEEP-ALI moved to phase 2 (`verify_deep_ali_phase2`). After the
    // P2.2f RLC-α-in-transcript change added weight to the FRI layer, phase 1
    // + DEEP-ALI combined tipped past Solana's 1.4M CU per-instruction cap for
    // C1 (devnet sig `2BCijpTaTTyrryLu3CZRff53d8T54LcV9gEFfEbybPMxD7CxWRp3RVignRP3H4mgcUNChjgcVhmHnL4PPX12w9Nf`
    // consumed the full 1.4M budget at step 4). Phase 2 validates the same
    // public-inputs hash stored here so the two phases remain transcript-
    // consistent.
    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        // [B7] DISABLED, not deleted, and this is the whole point of the change.
        //
        // This arm read the opened value AS A RAW TRACE ROW, which only ever
        // worked because the LDE was evaluated on the raw subgroup. It was a
        // CONSUMER of the witness leak B7 removes: once x = h * g^i, an aligned
        // position is no longer a trace row and the comparison is meaningless.
        //
        // It could not simply be dropped either. Its job -- an INDEPENDENT
        // re-derivation, AIR against trace, which the OOD check cannot do
        // because the prover computes C from the same AIR -- caught the C3
        // (2026-05-29) and C6 (2026-08-01) padding-row defects. That job now
        // lives prover-side in `assert_air_agrees_with_trace_c0` and its generic
        // twin, over EVERY constrained row instead of whichever a query hit,
        // at zero on-chain CU, and each of the seven is proven non-vacuous by
        // the row-(n-1) mutation.
        //
        // Left as `false` rather than deleted so the arms stay readable next to
        // the constraint they used to check, and so this comment sits where
        // someone would look for them.
        let is_trace_aligned = false;

        // [C5] Transition constraint check at trace-aligned positions
        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let cycle = trace_row / hash_cycle_len;
            let pos_in_cycle = trace_row % hash_cycle_len;

            if cycle < 3 && pos_in_cycle < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(pos_in_cycle);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            } else if pos_in_cycle == hash_cycle_len - 1 {
                // Boundary row: free transition
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
    }
    Ok(())
}

// ============================================================================
// Circuit 2: balance_proof
// ============================================================================

fn verify_constraints_balance_proof(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    _public_inputs: &[u64],
) -> Result<(), VerifyError> {
    // [P2.2g] DEEP-ALI moved to phase 2 (`verify_deep_ali_phase2`). Same
    // reason as C1: phase 1 + DEEP-ALI combined overshoots 1.4M CU after the
    // P2.2f RLC-α-in-transcript bump. Devnet sig
    // `3WdCRYKZ1LYDgaMcjaCvexhkKcQoyuGiFBWT4rJjgM6dicFrbBKq2cQEuYRaM1izofM6bDLdBEDPBgRYGkGBGMH1`
    // consumed the full 1.4M at step 4.
    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        // [B7] DISABLED, not deleted, and this is the whole point of the change.
        //
        // This arm read the opened value AS A RAW TRACE ROW, which only ever
        // worked because the LDE was evaluated on the raw subgroup. It was a
        // CONSUMER of the witness leak B7 removes: once x = h * g^i, an aligned
        // position is no longer a trace row and the comparison is meaningless.
        //
        // It could not simply be dropped either. Its job -- an INDEPENDENT
        // re-derivation, AIR against trace, which the OOD check cannot do
        // because the prover computes C from the same AIR -- caught the C3
        // (2026-05-29) and C6 (2026-08-01) padding-row defects. That job now
        // lives prover-side in `assert_air_agrees_with_trace_c0` and its generic
        // twin, over EVERY constrained row instead of whichever a query hit,
        // at zero on-chain CU, and each of the seven is proven non-vacuous by
        // the row-(n-1) mutation.
        //
        // Left as `false` rather than deleted so the arms stay readable next to
        // the constraint they used to check, and so this comment sits where
        // someone would look for them.
        let is_trace_aligned = false;

        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let pos_in_cycle = trace_row % hash_cycle_len;
            let is_cycle_boundary = pos_in_cycle == hash_cycle_len - 1;

            if pos_in_cycle < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(pos_in_cycle);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // [H5] Carry column identity: col 3 should not change during active hash rows
                if !is_cycle_boundary && config.trace_width > 3 {
                    if query.next_trace_value(3) != query.trace_value(3) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            } else if is_cycle_boundary {
                // Boundary: free transition for cols 0-2, carry may change
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
                // [H5] Carry column identity in padding rows
                if config.trace_width > 3 {
                    if query.next_trace_value(3) != query.trace_value(3) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
    }
    Ok(())
}

// ============================================================================
// Circuit 3: merkle_path
// ============================================================================

fn verify_constraints_merkle_path(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    _public_inputs: &[u64],
) -> Result<(), VerifyError> {
    // [P2.2g] DEEP-ALI moved to phase 2 (`verify_deep_ali_phase2`) because
    // phase-1 (FRI + trace-aligned transitions + boundary) + DEEP-ALI combined
    // exceeds Solana's 1.4M CU per-instruction cap for width=6 trace=512
    // circuits. Phase 2 validates against the same public-inputs hash stored
    // here so the two phases remain transcript-consistent.

    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        // [B7] DISABLED, not deleted, and this is the whole point of the change.
        //
        // This arm read the opened value AS A RAW TRACE ROW, which only ever
        // worked because the LDE was evaluated on the raw subgroup. It was a
        // CONSUMER of the witness leak B7 removes: once x = h * g^i, an aligned
        // position is no longer a trace row and the comparison is meaningless.
        //
        // It could not simply be dropped either. Its job -- an INDEPENDENT
        // re-derivation, AIR against trace, which the OOD check cannot do
        // because the prover computes C from the same AIR -- caught the C3
        // (2026-05-29) and C6 (2026-08-01) padding-row defects. That job now
        // lives prover-side in `assert_air_agrees_with_trace_c0` and its generic
        // twin, over EVERY constrained row instead of whichever a query hit,
        // at zero on-chain CU, and each of the seven is proven non-vacuous by
        // the row-(n-1) mutation.
        //
        // Left as `false` rather than deleted so the arms stay readable next to
        // the constraint they used to check, and so this comment sits where
        // someone would look for them.
        let is_trace_aligned = false;

        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let pos_in_cycle = trace_row % hash_cycle_len;
            let is_cycle_boundary = pos_in_cycle == hash_cycle_len - 1;
            // [FIX 2026-05-29] C3 trace is 512 rows, but only the first
            // CANONICAL_DEPTH(15) * 32 = 480 rows are active Poseidon rounds;
            // rows 480-511 are frozen padding (round_active=0 in the AIR, and
            // build_merkle_trace fills them with identity). Using
            // config.trace_length (512) here treated those 32 padding rows as
            // active hash rounds, so any trace-aligned FRI query landing in
            // 480-511 demanded next==poseidon_round(current) while the prover
            // had next==current → TransitionConstraintFailed → InvalidProof,
            // deterministically per note (query positions derive from the
            // trace via Fiat-Shamir). Mirrors C1's `cycle < 3` bound.
            // [C3-D12] 12, not 15. This arm is RETIRED and never runs; the
            // constant is corrected anyway so the file does not carry two
            // different depths for one circuit.
            //
            // ⛔ DO NOT REVIVE THIS ARM. Rows 384..511 are now the BLINDING
            // REGION, not "frozen padding" as the comment above still describes
            // them. Any per-query check reaching them turns 128 free rows into
            // 128 constrained ones and undoes the whole depth cut -- and the
            // `trace_row < active_rows` bound below would no longer save it,
            // because the rows between 384 and 480 are inside the old bound.
            let active_rows = 12 * hash_cycle_len; // CANONICAL_DEPTH * HASH_CYCLE_LEN = 384

            if trace_row < active_rows && pos_in_cycle < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(pos_in_cycle);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // [H5] Carry columns (3-5) identity during active hash rows (non-boundary)
                if !is_cycle_boundary {
                    for col in 3..config.trace_width {
                        if query.next_trace_value(col) != query.trace_value(col) {
                            return Err(VerifyError::TransitionConstraintFailed);
                        }
                    }
                }
            } else if is_cycle_boundary {
                // Boundary: free transition
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
                // [H5] Carry columns identity in padding rows
                for col in 3..config.trace_width {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
    }
    Ok(())
}

// ============================================================================
// Circuit 4: confidential_balance
// ============================================================================

fn verify_constraints_confidential_balance(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    _public_inputs: &[u64],
) -> Result<(), VerifyError> {
    // [P2.2g] DEEP-ALI moved to phase 2 — even width=4 trace=256 exceeds 1.4M
    // CU when combined with FRI + per-query checks. See comment on
    // `verify_constraints_merkle_path`.

    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        // [B7] DISABLED, not deleted, and this is the whole point of the change.
        //
        // This arm read the opened value AS A RAW TRACE ROW, which only ever
        // worked because the LDE was evaluated on the raw subgroup. It was a
        // CONSUMER of the witness leak B7 removes: once x = h * g^i, an aligned
        // position is no longer a trace row and the comparison is meaningless.
        //
        // It could not simply be dropped either. Its job -- an INDEPENDENT
        // re-derivation, AIR against trace, which the OOD check cannot do
        // because the prover computes C from the same AIR -- caught the C3
        // (2026-05-29) and C6 (2026-08-01) padding-row defects. That job now
        // lives prover-side in `assert_air_agrees_with_trace_c0` and its generic
        // twin, over EVERY constrained row instead of whichever a query hit,
        // at zero on-chain CU, and each of the seven is proven non-vacuous by
        // the row-(n-1) mutation.
        //
        // Left as `false` rather than deleted so the arms stay readable next to
        // the constraint they used to check, and so this comment sits where
        // someone would look for them.
        let is_trace_aligned = false;

        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let pos_in_cycle = trace_row % hash_cycle_len;
            let is_cycle_boundary = pos_in_cycle == hash_cycle_len - 1;

            if pos_in_cycle < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(pos_in_cycle);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // [H5] Carry column (col 3) identity during active hash rows
                if !is_cycle_boundary && config.trace_width > 3 {
                    if query.next_trace_value(3) != query.trace_value(3) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            } else if is_cycle_boundary {
                // Boundary: free transition (new hash cycle starts next)
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
                // [H5] Carry column identity in padding rows
                if config.trace_width > 3 {
                    if query.next_trace_value(3) != query.trace_value(3) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
    }
    Ok(())
}

// ============================================================================
// Circuit 5: transfer
// ============================================================================

fn verify_constraints_transfer(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    _public_inputs: &[u64],
) -> Result<(), VerifyError> {
    // [P2.2g] DEEP-ALI moved to phase 2 — C5 is the heaviest generic AIR
    // (width=6, trace=512, 23 constraints). See comment on
    // `verify_constraints_merkle_path`.

    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        // [B7] DISABLED, not deleted, and this is the whole point of the change.
        //
        // This arm read the opened value AS A RAW TRACE ROW, which only ever
        // worked because the LDE was evaluated on the raw subgroup. It was a
        // CONSUMER of the witness leak B7 removes: once x = h * g^i, an aligned
        // position is no longer a trace row and the comparison is meaningless.
        //
        // It could not simply be dropped either. Its job -- an INDEPENDENT
        // re-derivation, AIR against trace, which the OOD check cannot do
        // because the prover computes C from the same AIR -- caught the C3
        // (2026-05-29) and C6 (2026-08-01) padding-row defects. That job now
        // lives prover-side in `assert_air_agrees_with_trace_c0` and its generic
        // twin, over EVERY constrained row instead of whichever a query hit,
        // at zero on-chain CU, and each of the seven is proven non-vacuous by
        // the row-(n-1) mutation.
        //
        // Left as `false` rather than deleted so the arms stay readable next to
        // the constraint they used to check, and so this comment sits where
        // someone would look for them.
        let is_trace_aligned = false;

        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let pos_in_cycle = trace_row % hash_cycle_len;
            let is_cycle_boundary = pos_in_cycle == hash_cycle_len - 1;

            if pos_in_cycle < config.num_rounds {
                let current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let rc = poseidon_consts::round_constants(pos_in_cycle);
                let expected = poseidon_round(&current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // [H5] Carry columns (3-5) identity during active hash rows.
                //
                // [#2 voie A] Col 6 (acc) is EXEMPT: it is NOT a carry column.
                // It legitimately changes at the four amount rows (64/160/288/
                // 384), which are cycle-START rows inside the active hash range
                // (pos_in_cycle == 0 < num_rounds, NOT a cycle boundary), so a
                // naive `3..trace_width` identity here would FALSELY reject every
                // honest conserving proof. Col 6 is fully bound by the phase-2
                // DEEP-ALI conservation constraints (add_in*/sub_out*/acc_
                // continuity at cs[23..27]) + the acc boundary assertions, exactly
                // like the carry-routing edges that the phase-1 check also leaves
                // to phase-2.
                if !is_cycle_boundary {
                    for col in (3..config.trace_width).filter(|&c| c != 6) {
                        if query.next_trace_value(col) != query.trace_value(col) {
                            return Err(VerifyError::TransitionConstraintFailed);
                        }
                    }
                }
            } else if is_cycle_boundary {
                // Boundary: free transition
            } else {
                for col in 0..3 {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
                // [LIVENESS 2026-08-01] Carry columns in the `pos_in_cycle == 30`
                // row.
                //
                // This branch used to demand identity on cols 3-5 at EVERY such
                // row. That is false on an honest trace: `build_transfer_trace`
                // fills the carry columns as
                //
                //   col 3 (carry_owner)   = 0 for row <= 30,  owner    after
                //   col 4 (carry_o_mint)  = 0 for row <= 62,  owner_mint after
                //   col 5 (carry_out_rm)  = 0 for row <= 286, out1_rm until 382,
                //                                             out2_rm after
                //
                // so the carry CHANGES on exactly the edges 30→31, 62→63,
                // 286→287 and 382→383 — the four capture points the AIR encodes
                // as constraints [10], [12], [18] and [20]. All four sit at
                // `pos_in_cycle == 30`, i.e. in this branch, so an honest C5
                // proof was rejected with `TransitionConstraintFailed` whenever a
                // trace-aligned query landed on row 30, 62, 286 or 382.
                //
                // The fix does NOT exempt those columns — exempting is the
                // soundness hole. Row `c*32 + 30` holds the cycle's Poseidon
                // OUTPUT in col 0 (`run_hash` writes rounds 0..29 to rows
                // start+1..start+30), and the captured value IS that output, so
                // phase 1 can check the capture edge directly:
                //
                //   next[3] == current[0]  at row 30   (owner)
                //   next[4] == current[0]  at row 62   (owner_mint)
                //   next[5] == current[0]  at rows 286, 382 (out1_rm, out2_rm)
                //
                // That is STRICTER than the pre-fix code on an honest trace (the
                // pre-fix code demanded something false) and strictly stronger
                // than an exemption on a forged one. The capture rows are AIR
                // constants, not prover-chosen: no input to this branch is under
                // the prover's control.
                //
                // Col 6 (acc) stays exempt for the reason documented above.
                const CAPTURE_ROW_OWNER: usize = 30;
                const CAPTURE_ROW_OWNER_MINT: usize = 62;
                const CAPTURE_ROW_OUT1_RM: usize = 286;
                const CAPTURE_ROW_OUT2_RM: usize = 382;
                let capture_col = match trace_row {
                    CAPTURE_ROW_OWNER => Some(3usize),
                    CAPTURE_ROW_OWNER_MINT => Some(4usize),
                    CAPTURE_ROW_OUT1_RM | CAPTURE_ROW_OUT2_RM => Some(5usize),
                    _ => None,
                };
                for col in (3..config.trace_width).filter(|&c| c != 6) {
                    if Some(col) == capture_col {
                        // Capture edge: the carry takes this cycle's hash output.
                        if query.next_trace_value(col) != query.trace_value(0) {
                            return Err(VerifyError::TransitionConstraintFailed);
                        }
                    } else if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
    }
    Ok(())
}

// ============================================================================
// Circuit 6: merkle_update
// ============================================================================
//
// Width-10 trace: OLD Poseidon state (cols 0-2), NEW Poseidon state (cols 3-5),
// shared sibling (col 6), shared direction (col 7), old_carry (col 8),
// new_carry (col 9). Both chains run the same round constants in parallel, so
// the same poseidon_round evaluation applies to each triple. Cols 6-9 are
// held constant across non-boundary rows of an active cycle; the cycle
// boundary (row 31) is a free transition where carries get refreshed for the
// next level by the prover (bound by STARK constraints over the whole LDE).

fn verify_constraints_merkle_update(
    proof: &GenericCompactProof,
    config: &CircuitConfig,
    _public_inputs: &[u64],
) -> Result<(), VerifyError> {
    let hash_cycle_len = 32usize;

    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        // [B7] DISABLED, not deleted, and this is the whole point of the change.
        //
        // This arm read the opened value AS A RAW TRACE ROW, which only ever
        // worked because the LDE was evaluated on the raw subgroup. It was a
        // CONSUMER of the witness leak B7 removes: once x = h * g^i, an aligned
        // position is no longer a trace row and the comparison is meaningless.
        //
        // It could not simply be dropped either. Its job -- an INDEPENDENT
        // re-derivation, AIR against trace, which the OOD check cannot do
        // because the prover computes C from the same AIR -- caught the C3
        // (2026-05-29) and C6 (2026-08-01) padding-row defects. That job now
        // lives prover-side in `assert_air_agrees_with_trace_c0` and its generic
        // twin, over EVERY constrained row instead of whichever a query hit,
        // at zero on-chain CU, and each of the seven is proven non-vacuous by
        // the row-(n-1) mutation.
        //
        // Left as `false` rather than deleted so the arms stay readable next to
        // the constraint they used to check, and so this comment sits where
        // someone would look for them.
        let is_trace_aligned = false;

        if is_trace_aligned {
            let trace_row = (pos / config.blowup) % config.trace_length;
            let pos_in_cycle = trace_row % hash_cycle_len;
            let is_cycle_boundary = pos_in_cycle == hash_cycle_len - 1;

            // [LIVENESS 2026-08-01] C6 twin of the 2026-05-29 C3 fix in
            // `verify_constraints_merkle_path`, which was never applied here.
            //
            // A C6 trace is 512 rows but only `depth * 32` of them are active
            // Poseidon rounds; `build_merkle_update_trace` fills the tail with
            // identity rows and the AIR disables the round constraint over them
            // via the periodic `round_active` column. This branch knew only
            // `pos_in_cycle` and had no notion of an inactive CYCLE, so it
            // demanded a Poseidon round of a row the honest prover deliberately
            // did not hash — any trace-aligned query landing in 480..=509
            // rejected an honest proof with `TransitionConstraintFailed`.
            //
            // `CANONICAL_DEPTH` is a CONSTANT, not a public input, so the prover
            // has no lever over which rows are treated as inactive. It cannot be
            // anything else: `verify_deep_ali_circuit_6` (phase 2, mandatory)
            // already hard-rejects any proof whose `public_inputs[4] != 15`,
            // because the baked periodic polynomials are depth-15. Reading the
            // depth off the public inputs here would widen the prover's surface
            // for no gain; hardcoding it matches both phase 2 and the C3
            // precedent.
            //
            // Rows >= `active_rows` now fall through to the padding arm, which
            // demands identity on all 10 columns — a real constraint, not a
            // free pass.
            // [C6-D12] 12, not 15. This arm is RETIRED post-B7 and never runs; the
            // constant is corrected anyway so the file does not carry two
            // different depths for one circuit.
            //
            // ⛔ DO NOT REVIVE THIS ARM. Its `else` branch demands identity on
            // all ten columns for rows at or past `active_rows` — right at
            // depth 15, and now the single most destructive line that could be
            // re-enabled. Rows 384..511 are the blinding region: any per-query
            // check reaching them turns 128 free rows into 128 constrained ones
            // and undoes this entire change.
            const CANONICAL_DEPTH: usize = 11;
            // [ZK-DEPTH-11 2026-08-30] 384 -> 352, and the stale `// 480` this
            // comment carried was already two cuts out of date.
            let active_rows = CANONICAL_DEPTH * hash_cycle_len; // 352

            if trace_row < active_rows && pos_in_cycle < config.num_rounds {
                let rc = poseidon_consts::round_constants(pos_in_cycle);

                // OLD chain Poseidon round (cols 0-2)
                let old_current = [query.trace_value(0), query.trace_value(1), query.trace_value(2)];
                let old_expected = poseidon_round(&old_current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(col) != old_expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // NEW chain Poseidon round (cols 3-5) — same round constants
                let new_current = [query.trace_value(3), query.trace_value(4), query.trace_value(5)];
                let new_expected = poseidon_round(&new_current, &rc);
                for col in 0..3 {
                    if query.next_trace_value(3 + col) != new_expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }

                // [H5] Witness cols (6=sibling, 7=dir, 8=old_carry, 9=new_carry)
                // identity during active hash rows (non-boundary)
                if !is_cycle_boundary {
                    for col in 6..config.trace_width {
                        if query.next_trace_value(col) != query.trace_value(col) {
                            return Err(VerifyError::TransitionConstraintFailed);
                        }
                    }
                }
            } else if is_cycle_boundary {
                // Boundary: free transition (next cycle starts, carries refresh)
            } else {
                // Padding: all cols identity
                for col in 0..config.trace_width {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
    }
    Ok(())
}

// ============================================================================
// Legacy helpers (backward compat for circuit 0)
// ============================================================================

/// [H9 + P1.1 PR 2] Legacy Fiat-Shamir. Grinding seed absorbs FRI commitments
/// after the base seed (matching the generic path) so layer roots + final poly
/// are bound before the grinding challenge is solved.
fn derive_query_positions_legacy(
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    commitment: Felt,
    ood_current: &[u64],
    ood_next: &[u64],
    ood_quotient_bytes: &[u8],
    fri_layer_roots_bytes: &[u8],
    fri_final_poly_bytes: &[u8],
    grinding_nonce: u64,
) -> Result<Vec<u32>, VerifyError> {
    let mut state = build_base_seed(
        trace_root,
        quotient_root,
        &commitment.to_le_bytes(),
        ood_current,
        ood_next,
        ood_quotient_bytes,
    );
    for layer_root in fri_layer_roots_bytes.chunks_exact(32) {
        state = extend_transcript(&state, layer_root);
    }
    state = extend_transcript(&state, fri_final_poly_bytes);
    let query_seed = verify_grinding(&state, grinding_nonce, crate::compact_proof::GRINDING_BITS)?;
    Ok(derive_positions_from_seed(&query_seed, LDE_SIZE, NUM_QUERIES))
}

fn verify_query_positions_legacy(
    proof: &CompactStarkProof,
    expected: &[u32],
) -> Result<(), VerifyError> {
    // [SEAM] Was `<`. The generic twin was tightened to `!=` by B1 with the note
    // "the legacy path already gates on the constant" — it gated on the constant
    // with `<`, which is the same hole from the same side. Up to 256 queries
    // (the parser's old cap) were accepted where 27 are expected, and the `i <
    // expected.len()` guard below meant every surplus position went UNCOMPARED
    // to the derived list, then straight into the per-query Merkle, FRI and
    // constraint loops. On C0 that matters more than anywhere else: C0 is the
    // sole verifier for `zk_shielded::{pause,resume,cancel}_private_stark` and
    // `p01_quantum_wallet`.
    //
    // The parser now refuses a wire count other than `NUM_QUERIES`
    // (`CompactStarkProof::from_bytes`), so this is belt and braces — kept
    // because the two ends were allowed to drift once already.
    if proof.queries.len() != NUM_QUERIES {
        return Err(VerifyError::InsufficientQueries);
    }
    for (i, query) in proof.queries.iter().enumerate() {
        if i < expected.len() && query.position != expected[i] {
            return Err(VerifyError::InvalidQueryPosition);
        }
    }
    Ok(())
}

fn verify_merkle_proofs_legacy(proof: &CompactStarkProof) -> Result<(), VerifyError> {
    let half = LDE_SIZE / 2;
    for (query_idx, query) in proof.queries.iter().enumerate() {
        // [ROUTE C] Pair-leaf trace tree, identical rule to
        // `verify_merkle_proofs_generic` — see the commentary there. The legacy C0
        // path keeps its own parser and its own verifier entry point, but the
        // trace COMMITMENT is now the same shape on both paths, so a drift between
        // them cannot hide.
        let pos = query.position as usize;
        let (lo, hi) = if pos < half {
            (query.trace_values_bytes(), query.trace_mirror_values_bytes())
        } else {
            (query.trace_mirror_values_bytes(), query.trace_values_bytes())
        };
        if !merkle::verify_merkle_path_2seg(
            &proof.trace_root,
            lo,
            hi,
            pos & (half - 1),
            query.merkle_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        let next_pos = (pos + BLOWUP) % LDE_SIZE;
        let (nlo, nhi) = if next_pos < half {
            (query.next_trace_values_bytes(), query.next_trace_mirror_values_bytes())
        } else {
            (query.next_trace_mirror_values_bytes(), query.next_trace_values_bytes())
        };
        if !merkle::verify_merkle_path_2seg(
            &proof.trace_root,
            nlo,
            nhi,
            next_pos & (half - 1),
            query.next_merkle_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }

        // [B4] One pair-leaf opening binds both the quotient values at
        // `position` and the mirror values at `position ^ LDE_SIZE/2`.
        // [B2] Both sides are now `LEGACY_QUOTIENT_SEGMENTS` felts, contiguous
        // and wire-ordered, so they hash in place — the leaf preimage widens and
        // the tree depth does not move.
        const KSEGS: usize = crate::compact_proof::LEGACY_QUOTIENT_SEGMENTS;
        if (query_idx + 1) * KSEGS > proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
        let q_block = proof.quotient_values_block(query_idx);
        let q_mirror_block = query.quotient_mirror_bytes();
        let (qlo, qhi) = if pos < half {
            (q_block, q_mirror_block)
        } else {
            (q_mirror_block, q_block)
        };
        if !merkle::verify_merkle_path_2seg(
            &proof.quotient_root,
            qlo,
            qhi,
            pos & (half - 1),
            query.quotient_pair_path(),
        ) {
            return Err(VerifyError::MerkleProofFailed);
        }
    }
    Ok(())
}

fn verify_transition_legacy(proof: &CompactStarkProof) -> Result<(), VerifyError> {
    for (query_idx, query) in proof.queries.iter().enumerate() {
        let pos = query.position as usize;
        let trace_row = (pos / BLOWUP) % TRACE_LENGTH;
        // [B7] DISABLED, not deleted, and this is the whole point of the change.
        //
        // This arm read the opened value AS A RAW TRACE ROW, which only ever
        // worked because the LDE was evaluated on the raw subgroup. It was a
        // CONSUMER of the witness leak B7 removes: once x = h * g^i, an aligned
        // position is no longer a trace row and the comparison is meaningless.
        //
        // It could not simply be dropped either. Its job -- an INDEPENDENT
        // re-derivation, AIR against trace, which the OOD check cannot do
        // because the prover computes C from the same AIR -- caught the C3
        // (2026-05-29) and C6 (2026-08-01) padding-row defects. That job now
        // lives prover-side in `assert_air_agrees_with_trace_c0` and its generic
        // twin, over EVERY constrained row instead of whichever a query hit,
        // at zero on-chain CU, and each of the seven is proven non-vacuous by
        // the row-(n-1) mutation.
        //
        // Left as `false` rather than deleted so the arms stay readable next to
        // the constraint they used to check, and so this comment sits where
        // someone would look for them.
        let is_trace_aligned = false;

        // [C5] Transition constraints at trace-aligned positions.
        //
        // Skip the last trace row (wraps to row 0) — the prover divides by
        // Z_T = (x^n-1)/(x-g^(n-1)) which does not force that transition to
        // vanish. See `verify_deep_ali_legacy` and prover `compact.rs`.
        if is_trace_aligned && trace_row != TRACE_LENGTH - 1 {
            if trace_row < NUM_ROUNDS {
                let current = [
                    query.trace_value(0),
                    query.trace_value(1),
                    query.trace_value(2),
                ];
                let rc = poseidon_consts::round_constants(trace_row);
                let expected = poseidon_round(&current, &rc);
                for col in 0..TRACE_WIDTH {
                    if query.next_trace_value(col) != expected[col] {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            } else {
                for col in 0..TRACE_WIDTH {
                    if query.next_trace_value(col) != query.trace_value(col) {
                        return Err(VerifyError::TransitionConstraintFailed);
                    }
                }
            }
        }

        // [C4] Quotient verification at ALL positions
        if query_idx >= proof.quotient_values_len() {
            return Err(VerifyError::QuotientCheckFailed);
        }
    }
    Ok(())
}

// ============================================================================
// [P1.5] Cross-lib parity tests
// ============================================================================
//
// These tests apply `poseidon_round` 30 times to known input states and
// assert bit-identical output with the off-chain prover's
// `stark::poseidon::hash2` / `hash4`. If either side changes (constants, MDS,
// S-box exponent, round count), both the off-chain parity test and these
// on-chain parity tests will drift — giving a loud break of the prover↔
// verifier protocol before any proof actually fails in production.
//
// Off-chain reference values live in
// `stark/src/poseidon/mod.rs::parity`. If you change one side, change the
// other.

#[cfg(test)]
mod parity_tests {
    use super::*;

    /// Reference: `stark::poseidon::mod::parity::POSEIDON_T3_ZERO_ZERO`.
    const POSEIDON_T3_ZERO_ZERO: u64 = 18051734659105196655;
    /// Reference: `stark::poseidon::mod::parity::POSEIDON_T3_ONE_TWO`.
    const POSEIDON_T3_ONE_TWO: u64 = 18184238532291717445;

    fn permutation_t3(initial: [Felt; 3]) -> [Felt; 3] {
        let mut state = initial;
        for round in 0..30 {
            let rc = crate::poseidon_consts::round_constants(round);
            state = poseidon_round(&state, &rc);
        }
        state
    }

    #[test]
    fn poseidon_t3_parity_zero_zero() {
        let out = permutation_t3([Felt::ZERO, Felt::ZERO, Felt::ZERO]);
        assert_eq!(out[0].as_u64(), POSEIDON_T3_ZERO_ZERO);
    }

    #[test]
    fn poseidon_t3_parity_one_two() {
        let out = permutation_t3([Felt::new(1), Felt::new(2), Felt::ZERO]);
        assert_eq!(out[0].as_u64(), POSEIDON_T3_ONE_TWO);
    }
}

/// [P2.2] Host-side end-to-end verification of the merkle_update circuit.
///
/// Generates a compact proof for a realistic update trace (depth 15, the same
/// shape used on mobile) and calls `verify_generic` exactly as the on-chain
/// instruction would. Any failure here means the bug lives in the verifier
/// code path itself (shared by host and BPF) — not a BPF-specific quirk like
/// compute budget or heap pressure.
#[cfg(test)]
mod merkle_update_e2e {
    use super::*;
    use crate::compact_proof::get_circuit_config;

    #[test]
    fn merkle_update_depth12_masked_verify_generic() {
        let old_leaf = 111u64;
        let new_leaf = 222u64;
        let path_elements: Vec<u64> = (0..12).map(|i| 100u64 + i * 13).collect();
        let path_indices: Vec<u8> = (0..12).map(|i| (i % 2) as u8).collect();

        let proof_data = p01_stark::compact::generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices, &p01_stark::compact::c6_deterministic_probe_mask(path_elements.len()));

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("verify_generic must succeed on an honest depth-12 MASKED proof");
    }

    /// [P2.2a] Host-side DEEP-ALI check on a real circuit-6 proof. Runs the
    /// same `verify_deep_ali_circuit_6` that phase 2 calls on-chain — proves
    /// the Fiat-Shamir α derivation, periodic polynomial evaluation, 19-
    /// constraint RLC, and Z_T division are bit-identical to the prover.
    #[test]
    #[test]
    fn merkle_update_deep_ali_fails_on_tampered_ood_current() {
        use crate::compact_proof::get_circuit_config;

        let old_leaf = 111u64;
        let new_leaf = 222u64;
        // depth=15 is the canonical depth baked into periodic_consts.
        let path_elements: Vec<u64> = (0..12).map(|i| 100u64 + i * 13).collect();
        let path_indices: Vec<u8> = (0..12).map(|i| (i % 2) as u8).collect();

        let proof_data = p01_stark::compact::generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices, &p01_stark::compact::c6_deterministic_probe_mask(path_elements.len()));

        // Tamper with the first ood_current byte directly in the proof buffer.
        // ood_current lives at offset 32 (trace_root) + 32 (quotient_root) = 64.
        // Flip the low byte of current[0] so the OOD trace evaluation diverges
        // from what the quotient was computed for.
        let mut tampered = proof_data.proof_bytes.clone();
        tampered[64] ^= 0x01;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_6(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "phase 2 DEEP-ALI must reject tampered ood_current: got {:?}", res
        );
    }

    /// [P2.2b] Negative: tampering the claimed ood_quotient Q(z) (keeps the
    /// rest honest) must fail DEEP-ALI because `Q(z) · Z_T(z)` no longer
    /// matches the RLC evaluation.
    #[test]
    fn merkle_update_deep_ali_fails_on_tampered_ood_quotient() {
        use crate::compact_proof::get_circuit_config;

        let old_leaf = 333u64;
        let new_leaf = 444u64;
        // depth=15 canonical.
        let path_elements: Vec<u64> = (0..12).map(|i| 500u64 + i * 7).collect();
        let path_indices: Vec<u8> = (0..12).map(|i| (i % 2) as u8).collect();

        let proof_data = p01_stark::compact::generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices, &p01_stark::compact::c6_deterministic_probe_mask(path_elements.len()));

        // ood_quotient lives after trace_root(32) + quotient_root(32) +
        // ood_current(10*8) + ood_next(10*8) + ood_z(8) = 64 + 160 + 8 = 232.
        let mut tampered = proof_data.proof_bytes.clone();
        tampered[232] ^= 0x02;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_6(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "phase 2 DEEP-ALI must reject tampered ood_quotient: got {:?}", res
        );
    }

    /// [P2.2b] Negative: swapping in wrong public inputs (right shape, wrong
    /// values) must fail — α depends on the pub bytes, so the RLC evaluation
    /// and the prover's quotient disagree.
    #[test]
    fn merkle_update_deep_ali_fails_on_wrong_public_inputs() {
        use crate::compact_proof::get_circuit_config;

        let old_leaf = 999u64;
        let new_leaf = 1000u64;
        // depth=15 canonical.
        let path_elements: Vec<u64> = (0..12).map(|i| 42u64 + i).collect();
        let path_indices: Vec<u8> = (0..12).map(|i| ((i * 7 + 3) % 2) as u8).collect();

        let proof_data = p01_stark::compact::generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices, &p01_stark::compact::c6_deterministic_probe_mask(path_elements.len()));

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        // Flip the first public input (old_leaf) to a different value.
        let mut wrong_inputs = proof_data.public_inputs.clone();
        wrong_inputs[0] ^= 0x1234;

        let res = verify_deep_ali_circuit_6(&parsed, &wrong_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "phase 2 DEEP-ALI must reject wrong public inputs: got {:?}", res
        );
    }

    /// [ROUTE C] **The trace-commitment tripwire, inside `--lib`.**
    ///
    /// Route C's whole authentication surface — both `verify_merkle_path_2seg`
    /// blocks in `verify_merkle_proofs_generic` and both in
    /// `verify_merkle_proofs_legacy` — lived behind exactly ONE test file
    /// (`tests/route_c_trace_pair.rs`). MEASURED during review: deleting all four
    /// blocks and their now-unused locals left `cargo test -p p01_stark_verifier
    /// --lib` at "54 passed; 0 failed", `--test periodic_stride`, `--test
    /// fri_end_to_end`, `--test b4_pair_leaf` and `--test merkle_domain_sep` all
    /// green, and `cargo clippy -- -D warnings` clean. A verifier that does not
    /// check its trace commitment at all was invisible to every gate that existed
    /// before Route C.
    ///
    /// This test closes that. It lives in `--lib`, which is the FIRST verifier
    /// command CI runs and pre-dates Route C, so a partial or aborted edit that
    /// removes the trace opening cannot reach a green build. It is a tamper test,
    /// not a soundness test: it proves the mirror row is bound to `trace_root`,
    /// and proves nothing whatsoever about DEEP binding.
    #[test]
    fn route_c_trace_commitment_is_checked_c6() {
        let old_leaf = 111u64;
        let new_leaf = 222u64;
        let path_elements: Vec<u64> = (0..12).map(|i| 100u64 + i * 13).collect();
        let path_indices: Vec<u8> = (0..12).map(|i| (i % 2) as u8).collect();

        let proof_data = p01_stark::compact::generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices, &p01_stark::compact::c6_deterministic_probe_mask(path_elements.len()));
        let config = get_circuit_config(proof_data.circuit_id).expect("config");

        // Positive control first: without it, "the tampered proof was rejected"
        // could just mean the honest proof does not verify either.
        let honest = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");
        verify_generic(&honest, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("honest C6 proof must verify — otherwise the negative half is vacuous");

        let (base, row_len) = route_c_trace_block(config, &proof_data.proof_bytes, 0);

        // Slot 1 is `trace_mirror_values` (the row at `pos ^ lde/2`), slot 3 is
        // `next_trace_mirror_values`. Both exist ONLY because Route C pair-leafed
        // the trace tree, and both are authenticated-and-then-unread, so nothing
        // except the Merkle check can notice them changing.
        for (label, slot) in [("mirror", 1usize), ("next-mirror", 3usize)] {
            let mut tampered = proof_data.proof_bytes.clone();
            tampered[base + slot * row_len] ^= 0x01;

            let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
                &tampered, config,
            ).expect("still parses — one value byte changed, no length change");

            let res =
                verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config);
            assert!(
                matches!(res, Err(VerifyError::MerkleProofFailed)),
                "a corrupted trace {label} row must be rejected at the Merkle check. \
                 Got {res:?}. If this is Ok(()), the trace commitment is not being \
                 verified at all and the verifier accepts unauthenticated trace rows.",
            );
        }
    }

    /// [ROUTE C] The same tripwire for the LEGACY C0 path, which has its own
    /// parser (`CompactStarkProof`), its own entry point
    /// (`verify_subscriber_ownership`) and its own copy of the trace-opening code
    /// in `verify_merkle_proofs_legacy`. The C6 test above exercises the GENERIC
    /// path only, so without this one a deletion confined to the legacy path stays
    /// invisible to `--lib` — and the legacy path is the sole verifier for four
    /// SHIPPED instructions (`zk_shielded::{pause,resume,cancel_private_stark}`
    /// and `p01_quantum_wallet/src/stark.rs:42` all hard-require `circuit_id == 0`).
    #[test]
    fn route_c_trace_commitment_is_checked_c0_legacy() {
        use crate::compact_proof::{CompactStarkProof, CONFIG_SUBSCRIBER_OWNERSHIP};

        let pd = p01_stark::compact::generate_compact_proof(42);
        let commitment = crate::goldilocks::Felt::new(pd.commitment);

        // Positive control.
        let honest = CompactStarkProof::from_bytes(&pd.proof_bytes).expect("parse C0");
        verify_subscriber_ownership(&honest, commitment)
            .expect("honest C0 proof must verify — otherwise the negative half is vacuous");

        let (base, row_len) =
            route_c_trace_block(&CONFIG_SUBSCRIBER_OWNERSHIP, &pd.proof_bytes, 0);

        for (label, slot) in [("mirror", 1usize), ("next-mirror", 3usize)] {
            let mut tampered = pd.proof_bytes.clone();
            tampered[base + slot * row_len] ^= 0x01;

            let parsed = CompactStarkProof::from_bytes(&tampered)
                .expect("still parses — one value byte changed");
            let res = verify_subscriber_ownership(&parsed, commitment);
            assert!(
                matches!(res, Err(VerifyError::MerkleProofFailed)),
                "a corrupted legacy-C0 trace {label} row must be rejected at the Merkle \
                 check. Got {res:?}. If this is Ok(()), the C0 trace commitment is not \
                 being verified and pause/resume/cancel_private_stark accept \
                 unauthenticated trace rows.",
            );
        }
    }

    /// Byte offset of query `q`'s trace block plus the per-row stride, derived
    /// from the config and cross-checked against the buffer length.
    ///
    /// The length assertion is the point: if the serializer layout drifts, this
    /// panics instead of poking a stale offset and passing for the wrong reason.
    fn route_c_trace_block(
        cfg: &crate::compact_proof::CircuitConfig,
        bytes: &[u8],
        q: usize,
    ) -> (usize, usize) {
        let tw = cfg.trace_width;
        let md = cfg.merkle_depth;
        let num_commits = (cfg.lde_size / cfg.fri_final_poly_size).trailing_zeros() as usize - 1;

        // [B2] `ood_quotient`, each query's quotient mirror block and each tail
        // entry are `quotient_segments` felts wide.
        let k = cfg.quotient_segments;
        let mut off = 32 + 32 + tw * 8 + tw * 8 + 8 + k * 8;
        assert_eq!(bytes[off] as usize, num_commits, "num_fri_layers byte drift");
        off += 1 + num_commits * 32;
        off += 2 + cfg.fri_final_poly_size * 8;
        off += 8 + 2;

        let fri_per_query: usize = (0..num_commits).map(|i| 16 + (md - i - 2) * 32).sum();
        // [ROUTE C] four rows + two depth-(md - 1) pair paths.
        let per_query =
            4 + 4 * (tw * 8) + 2 * ((md - 1) * 32) + k * 8 + (md - 1) * 32 + fri_per_query;

        assert_eq!(
            off + per_query * cfg.num_queries + cfg.num_queries * k * 8,
            bytes.len(),
            "Route C serializer layout drift — this offset arithmetic is stale",
        );

        (off + q * per_query + 4, tw * 8)
    }

    // ------------------------------------------------------------------
    // [P2.2d-C1] DEEP-ALI positive + negative tests for circuit 1.
    // ------------------------------------------------------------------

    /// [P2.2d-C1] Full-path positive: `verify_generic` (which is what the
    /// on-chain instruction calls) accepts an honest circuit-1 proof,
    /// including the new DEEP-ALI check at the head of
    /// `verify_constraints_pool_commitment`.
    #[test]
    fn pool_commitment_verify_generic_accepts_honest_proof() {
        let proof_data = p01_stark::compact::generate_pool_commitment_proof(
            42u64, 17u64, 7u64, 11u64, &p01_stark::compact::c1_deterministic_probe_mask());

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("verify_generic should accept honest circuit-1 proof");
    }

    /// [P2.2d-C1] Positive: `verify_deep_ali_circuit_1` accepts an honest
    /// pool-commitment proof. Exercises the same α derivation, 6-column
    /// periodic evaluation, 4-constraint RLC, and Z_T division that run
    /// on-chain inside `verify_constraints_pool_commitment`.
    #[test]
    fn pool_commitment_verify_deep_ali_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_pool_commitment_proof(
            42u64, 17u64, 7u64, 11u64, &p01_stark::compact::c1_deterministic_probe_mask());

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_deep_ali_circuit_1(&parsed, &proof_data.public_inputs)
            .expect("DEEP-ALI must accept honest circuit-1 proof");
    }

    /// [P2.2d-C1] Negative: tamper one byte of `ood_current[0]` — the 4-
    /// constraint RLC at z changes, so `C(z) != Q(z)·Z_T(z)` and DEEP-ALI
    /// must fail. Layout: trace_root(32) + quotient_root(32) + ood_current(3*8)
    /// + ood_next(3*8) + ood_z(8) + ood_quotient(8). Flip byte 64.
    #[test]
    fn pool_commitment_deep_ali_fails_on_tampered_ood_current() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_pool_commitment_proof(
            1u64, 2u64, 3u64, 4u64, &p01_stark::compact::c1_deterministic_probe_mask());

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[64] ^= 0x01;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_1(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_current: got {:?}", res
        );
    }

    /// [P2.2d-C1] Negative: tamper `ood_quotient` at byte 120 (= 64 trace/root
    /// + 24 ood_current + 24 ood_next + 8 ood_z).
    #[test]
    fn pool_commitment_deep_ali_fails_on_tampered_ood_quotient() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_pool_commitment_proof(
            5u64, 6u64, 7u64, 8u64, &p01_stark::compact::c1_deterministic_probe_mask());

        let mut tampered = proof_data.proof_bytes.clone();
        // [ZK-RANDOMIZER 2026-08-30] 120 -> 136. `ood_quotient` starts at
        // `64 + trace_width*16 + 8`, and C1's committed width went 3 -> 4. Left
        // at 120 this flipped a bit of `ood_next` instead, which the identity
        // tolerates -- so the test PASSED THE TAMPER and reported `got Ok(())`.
        // A hardcoded byte offset in a tampering test fails in the dangerous
        // direction: it stops testing anything, and says so only in a message
        // nobody reads until the day it matters.
        let ood_quotient_offset =
            64 + crate::compact_proof::CONFIG_POOL_COMMITMENT.trace_width * 16 + 8;
        assert_eq!(ood_quotient_offset, 136);
        tampered[ood_quotient_offset] ^= 0x02;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_1(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_quotient: got {:?}", res
        );
    }

    /// [P2.2d-C1] Negative: swapping in wrong public inputs changes α and
    /// breaks the RLC/quotient relation.
    #[test]
    fn pool_commitment_deep_ali_fails_on_wrong_public_inputs() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_pool_commitment_proof(
            9u64, 10u64, 11u64, 12u64, &p01_stark::compact::c1_deterministic_probe_mask());

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        let mut wrong_inputs = proof_data.public_inputs.clone();
        wrong_inputs[0] ^= 0xDEAD;

        let res = verify_deep_ali_circuit_1(&parsed, &wrong_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject wrong public inputs: got {:?}", res
        );
    }

    // ========================================================================
    // [P2.2d-C2] Circuit 2 (balance_proof) DEEP-ALI tests
    //
    // Wire layout (width=4):
    //   trace_root(32) + quotient_root(32) + ood_current(4*8=32)
    //   + ood_next(4*8=32) + ood_z(8) + ood_quotient(8)  = 144 bytes header
    //
    // Byte offsets:
    //   ood_current starts at 64, ood_next at 96,
    //   ood_z at 128, ood_quotient at 136.
    // ========================================================================

    /// [P2.2d-C2] Positive: `verify_generic` accepts an honest balance-proof
    /// compact proof and therefore transitively the new DEEP-ALI check in
    /// `verify_constraints_balance_proof`.
    #[test]
    fn balance_proof_verify_generic_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_balance_compact_proof(
            42u64, 1000u64, 777u64, 999u64,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("verify_generic should accept honest circuit-2 proof");
    }

    /// [P2.2d-C2] Positive: `verify_deep_ali_circuit_2` accepts an honest
    /// balance-proof. Exercises the same α derivation, 8-column periodic
    /// evaluation, 7-constraint RLC, and Z_T division that run on-chain
    /// inside `verify_constraints_balance_proof`.
    #[test]
    fn balance_proof_verify_deep_ali_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_balance_compact_proof(
            42u64, 17u64, 7u64, 11u64,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_deep_ali_circuit_2(&parsed, &proof_data.public_inputs)
            .expect("DEEP-ALI must accept honest circuit-2 proof");
    }

    /// [P2.2d-C2] Negative: tamper one byte of `ood_current[0]` (byte 64) —
    /// the 7-constraint RLC at z changes, so `C(z) != Q(z)·Z_T(z)` and
    /// DEEP-ALI must fail.
    #[test]
    fn balance_proof_deep_ali_fails_on_tampered_ood_current() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_balance_compact_proof(
            1u64, 2u64, 3u64, 4u64,
        );

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[64] ^= 0x01;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_2(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_current: got {:?}", res
        );
    }

    /// [P2.2d-C2] Negative: tamper `ood_quotient` at byte 136
    /// (32 trace_root + 32 quotient_root + 32 ood_current + 32 ood_next + 8 ood_z).
    #[test]
    fn balance_proof_deep_ali_fails_on_tampered_ood_quotient() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_balance_compact_proof(
            5u64, 6u64, 7u64, 8u64,
        );

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[136] ^= 0x02;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_2(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_quotient: got {:?}", res
        );
    }

    /// [P2.2d-C2] Negative: swapping in wrong public inputs changes α and
    /// breaks the RLC/quotient relation. This confirms the public inputs
    /// (commitment, token_mint) are genuinely bound into the soundness check.
    #[test]
    fn balance_proof_deep_ali_fails_on_wrong_public_inputs() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_balance_compact_proof(
            9u64, 10u64, 11u64, 12u64,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        let mut wrong_inputs = proof_data.public_inputs.clone();
        wrong_inputs[1] ^= 0xBEEF; // flip token_mint

        let res = verify_deep_ali_circuit_2(&parsed, &wrong_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject wrong public inputs: got {:?}", res
        );
    }

    // ========================================================================
    // [P2.2d-C3] Circuit-3 (merkle_path) positive + negative soundness tests.
    //
    // Proof byte layout for circuit 3 (width=6):
    //   trace_root      = bytes[0..32]
    //   quotient_root   = bytes[32..64]
    //   ood_current[6]  = bytes[64..112]   (6 * 8)
    //   ood_next[6]     = bytes[112..160]  (6 * 8)
    //   ood_z           = bytes[160..168]
    //   ood_quotient    = bytes[168..176]
    // ========================================================================

    /// Build a canonical depth-15 merkle_path proof fixture reused by the C3
    /// tests below. Uses leaf + 15 path elements + alternating indices so the
    /// path is fully covered and trace_length=512 matches CONFIG_MERKLE_PATH.
    fn c3_sample_proof(
        leaf: u64,
    ) -> p01_stark::compact::GenericCompactProofData {
        // [ZK-DEPTH-11 2026-08-30] Read the circuit's own depth instead of a
        // literal 12. A fixture at the wrong depth fails DEEP-ALI and reads
        // exactly like a broken circuit.
        let d = p01_stark::air::merkle_path::CANONICAL_DEPTH;
        let path_elements: Vec<u64> = (0..d as u64).map(|i| 1000 + i).collect();
        let path_indices: Vec<u8> = (0..d).map(|i| (i % 2) as u8).collect();
        p01_stark::compact::generate_merkle_path_compact_proof(
            leaf, &path_elements, &path_indices, &p01_stark::compact::c3_deterministic_probe_mask(path_elements.len()))
    }

    /// [P2.2d-C3] Positive: `verify_generic` accepts an honest merkle-path
    /// compact proof and therefore transitively the new DEEP-ALI check in
    /// `verify_constraints_merkle_path`.
    #[test]
    fn merkle_path_verify_generic_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c3_sample_proof(42u64);

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("verify_generic should accept honest circuit-3 proof");
    }

    /// [P2.2d-C3] Positive: `verify_deep_ali_circuit_3` accepts an honest
    /// merkle-path proof. Exercises the same α derivation, 7-column periodic
    /// evaluation, 11-constraint RLC, and Z_T division that run on-chain
    /// inside `verify_constraints_merkle_path`.
    #[test]
    fn merkle_path_verify_deep_ali_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c3_sample_proof(7u64);

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_deep_ali_circuit_3(&parsed, &proof_data.public_inputs)
            .expect("DEEP-ALI must accept honest circuit-3 proof");
    }

    /// [P2.2d-C3] Negative: tamper one byte of `ood_current[0]` (byte 64).
    /// The 11-constraint RLC at z changes, so `C(z) != Q(z)·Z_T(z)` and
    /// DEEP-ALI must fail.
    #[test]
    fn merkle_path_deep_ali_fails_on_tampered_ood_current() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c3_sample_proof(1u64);

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[64] ^= 0x01;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_3(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_current: got {:?}", res
        );
    }

    /// [P2.2d-C3] Negative: tamper `ood_quotient` at byte 168
    /// (32 trace_root + 32 quotient_root + 48 ood_current + 48 ood_next + 8 ood_z).
    #[test]
    fn merkle_path_deep_ali_fails_on_tampered_ood_quotient() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c3_sample_proof(5u64);

        let mut tampered = proof_data.proof_bytes.clone();
        // [ZK-RANDOMIZER 2026-08-30] 168 -> 184. `ood_quotient` starts at
        // `64 + trace_width*16 + 8`, and C3's committed width went 6 -> 7. The
        // C1 twin of this line was left behind and the test PASSED THE TAMPER,
        // reporting `got Ok(())` — a tampering test with a stale offset stops
        // testing anything and only says so in a message.
        let ood_quotient_offset =
            64 + crate::compact_proof::CONFIG_MERKLE_PATH.trace_width * 16 + 8;
        assert_eq!(ood_quotient_offset, 184);
        tampered[ood_quotient_offset] ^= 0x02;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_3(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_quotient: got {:?}", res
        );
    }

    /// [P2.2d-C3] Negative: swapping in wrong public inputs changes α and
    /// breaks the RLC/quotient relation. This confirms the public inputs
    /// (leaf, root) are genuinely bound into the soundness check.
    #[test]
    fn merkle_path_deep_ali_fails_on_wrong_public_inputs() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c3_sample_proof(9u64);

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        let mut wrong_inputs = proof_data.public_inputs.clone();
        wrong_inputs[1] ^= 0xBEEF; // flip root

        let res = verify_deep_ali_circuit_3(&parsed, &wrong_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject wrong public inputs: got {:?}", res
        );
    }

    /// [C3 depth binding] Negative: the depth guard must reject any depth !=
    /// CANONICAL_DEPTH (12) and any public-input vector that is not exactly 3
    /// elements, since the C3 periodic columns are baked for depth=12.
    ///
    /// ⚠️ 15 -> 12 on 2026-08-29. Rows 384..511 are the BLINDING REGION now, not
    /// padding, so a proof claiming 15 is not merely mis-shaped: it is a proof
    /// with no blinding region at all. Accepting one would let a prover opt out
    /// of the mask by using an older prover, which is why 15 is now the first
    /// value in the rejection sweep below.
    #[test]
    fn merkle_path_deep_ali_rejects_non_canonical_depth() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c3_sample_proof(11u64);
        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        // Honest proof is at CANONICAL_DEPTH with 3 public inputs.
        assert_eq!(proof_data.public_inputs.len(), 3);
        assert_eq!(
            proof_data.public_inputs[2],
            p01_stark::air::merkle_path::CANONICAL_DEPTH as u64,
        );

        // 🚨 15 AND 12 FIRST. 15 was canonical until 2026-08-29 and 12 until
        // 2026-08-30, so every C3 proof built before either cut claims one of
        // them, and every one of those proofs must now be refused. ⚠️ 11 LEFT
        // THIS LIST because it is the canonical depth now — leaving it in made
        // the test demand that the verifier reject its own honest proofs, and
        // the failure message still said "only 12 is canonical".
        for wrong in [15u64, 14, 13, 12, 10, 0, u64::MAX] {
            let mut pi = proof_data.public_inputs.clone();
            pi[2] = wrong;
            assert!(
                matches!(verify_deep_ali_circuit_3(&parsed, &pi), Err(VerifyError::DeepAliFailed)),
                "depth guard accepted depth {wrong}; only {} is canonical",
                p01_stark::air::merkle_path::CANONICAL_DEPTH,
            );
        }

        // Wrong length (legacy 2-element vector) must also be rejected up-front.
        let two_elem = vec![proof_data.public_inputs[0], proof_data.public_inputs[1]];
        assert!(
            matches!(verify_deep_ali_circuit_3(&parsed, &two_elem), Err(VerifyError::DeepAliFailed)),
            "depth guard must reject a 2-element public-input vector"
        );
    }

    // ========================================================================
    // [P2.2d-C4] Circuit-4 (confidential_balance) positive + negative tests.
    //
    // Proof byte layout for circuit 4 (width=4):
    //   trace_root      = bytes[0..32]
    //   quotient_root   = bytes[32..64]
    //   ood_current[4]  = bytes[64..96]   (4 * 8)
    //   ood_next[4]     = bytes[96..128]  (4 * 8)
    //   ood_z           = bytes[128..136]
    //   ood_quotient    = bytes[136..144]
    // ========================================================================

    fn c4_sample_proof() -> p01_stark::compact::GenericCompactProofData {
        p01_stark::compact::generate_confidential_balance_compact_proof(
            42, 1000, 111, 800, 222, 200, 333, 999,
        )
    }

    /// [P2.2d-C4] Positive: `verify_generic` accepts an honest confidential-
    /// balance compact proof and therefore transitively the new DEEP-ALI
    /// check in `verify_constraints_confidential_balance`.
    #[test]
    fn confidential_balance_verify_generic_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c4_sample_proof();

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("verify_generic should accept honest circuit-4 proof");
    }

    /// [P2.2d-C4] Positive: `verify_deep_ali_circuit_4` accepts an honest
    /// confidential-balance proof. Exercises the same α derivation, 11-column
    /// periodic evaluation, 10-constraint RLC, and Z_T division that run
    /// on-chain inside `verify_constraints_confidential_balance`.
    #[test]
    fn confidential_balance_verify_deep_ali_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_confidential_balance_compact_proof(
            13, 500, 77, 400, 88, 100, 99, 1234,
        );

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_deep_ali_circuit_4(&parsed, &proof_data.public_inputs)
            .expect("DEEP-ALI must accept honest circuit-4 proof");
    }

    /// [P2.2d-C4] Negative: tamper one byte of `ood_current[0]` (byte 64) —
    /// the 10-constraint RLC at z changes, so `C(z) != Q(z)·Z_T(z)` and
    /// DEEP-ALI must fail.
    #[test]
    fn confidential_balance_deep_ali_fails_on_tampered_ood_current() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c4_sample_proof();

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[64] ^= 0x01;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_4(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_current: got {:?}", res
        );
    }

    /// [P2.2d-C4] Negative: tamper `ood_quotient` at byte 136
    /// (32 trace_root + 32 quotient_root + 32 ood_current + 32 ood_next + 8 ood_z).
    #[test]
    fn confidential_balance_deep_ali_fails_on_tampered_ood_quotient() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_confidential_balance_compact_proof(
            1, 2, 3, 4, 5, 6, 7, 8,
        );

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[136] ^= 0x02;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_4(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_quotient: got {:?}", res
        );
    }

    /// [P2.2d-C4] Negative: swapping in wrong public inputs changes α and
    /// breaks the RLC/quotient relation. This confirms the public inputs
    /// (old_commit, new_commit, amount_hash, token_mint) are genuinely bound
    /// into the soundness check.
    #[test]
    fn confidential_balance_deep_ali_fails_on_wrong_public_inputs() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c4_sample_proof();

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        let mut wrong_inputs = proof_data.public_inputs.clone();
        wrong_inputs[3] ^= 0xBEEF; // flip token_mint

        let res = verify_deep_ali_circuit_4(&parsed, &wrong_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject wrong public inputs: got {:?}", res
        );
    }

    // ========================================================================
    // [P2.2d-C5] Circuit-5 (transfer) positive + negative tests.
    //
    // [#2 voie A] Proof byte layout for circuit 5 (width=7 after the value-
    // conservation rebake — col 6 = signed amount accumulator):
    //   trace_root      = bytes[0..32]
    //   quotient_root   = bytes[32..64]
    //   ood_current[7]  = bytes[64..120]   (7 * 8)
    //   ood_next[7]     = bytes[120..176]  (7 * 8)
    //   ood_z           = bytes[176..184]
    //   ood_quotient    = bytes[184..192]
    // ========================================================================

    /// Conserving sample: in1=100, in2=50, out1=80, out2=70 →
    /// out1+out2-in1-in2 = 150-150 = 0 = public_amount(0).
    fn c5_sample_proof() -> p01_stark::compact::GenericCompactProofData {
        p01_stark::compact::generate_transfer_compact_proof(
            42, 999, 100, 111, 50, 222, 80, 555, 333, 70, 666, 444, 0, &p01_stark::compact::c5_deterministic_probe_mask())
    }

    /// [P2.2d-C5] Positive: `verify_generic` accepts an honest transfer
    /// compact proof and therefore transitively the new DEEP-ALI check in
    /// `verify_constraints_transfer`.
    #[test]
    fn transfer_verify_generic_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c5_sample_proof();

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_generic(&parsed, proof_data.circuit_id, &proof_data.public_inputs, config)
            .expect("verify_generic should accept honest circuit-5 proof");
    }

    /// [P2.2d-C5] Positive: `verify_deep_ali_circuit_5` accepts an honest
    /// transfer proof. Exercises the same α derivation, 30-column periodic
    /// evaluation, 28-constraint RLC (incl. the 5 value-conservation
    /// constraints), 24-assertion boundary fold, and Z_T division that run
    /// on-chain inside the phase-2 DEEP-ALI for circuit 5.
    ///
    /// ⚠️ IT IS A WEAKER TEST THAN IT LOOKS. It caught the wrong Z_T generator
    /// and the wrong Poseidon gate — but only because both happened to break
    /// acceptance. A gate substitution the PROVER shares rejects nothing here;
    /// that is what `c5_ood_evaluator_matches_the_air_on_random_frames` is for.
    ///
    /// [#2 voie A] Params chosen so value conservation HOLDS with a non-zero
    /// public_amount: in1=77, in2=88, out1=150, out2=65 →
    /// out1+out2-in1-in2 = 215-165 = 50 = public_amount. (The previous
    /// params — out1=99,out2=66 — summed to 0 ≠ 50 and only "passed" under
    /// the old width-6 verifier that did not enforce conservation; the
    /// hardened verifier correctly rejects them.)
    #[test]
    fn transfer_verify_deep_ali_accepts_honest_proof() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_transfer_compact_proof(
            13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50, &p01_stark::compact::c5_deterministic_probe_mask());

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        verify_deep_ali_circuit_5(&parsed, &proof_data.public_inputs)
            .expect("DEEP-ALI must accept honest conserving circuit-5 proof");
    }

    /// [P2.2d-C5] Negative: tamper one byte of `ood_current[0]` (byte 64) —
    /// the 23-constraint RLC at z changes, so `C(z) != Q(z)·Z_T(z)` and
    /// DEEP-ALI must fail.
    #[test]
    fn transfer_deep_ali_fails_on_tampered_ood_current() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c5_sample_proof();

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[64] ^= 0x01;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_5(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_current: got {:?}", res
        );
    }

    /// [P2.2d-C5] Negative: tamper `ood_quotient` at byte 184. Width-7 layout:
    /// 32 trace_root + 32 quotient_root + 56 ood_current (7·8) + 56 ood_next
    /// (7·8) + 8 ood_z = 184, so ood_quotient starts at byte 184.
    ///
    /// [#2 voie A] Base proof is CONSERVING (in1=3,in2=5,out1=2,out2=6 →
    /// out-in = 8-8 = 0 = public_amount) so the rejection is attributable to
    /// the tampered ood_quotient, not to a conservation violation.
    #[test]
    fn transfer_deep_ali_fails_on_tampered_ood_quotient() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = p01_stark::compact::generate_transfer_compact_proof(
            1, 2, 3, 4, 5, 6, 2, 8, 9, 6, 11, 12, 0, &p01_stark::compact::c5_deterministic_probe_mask());

        let mut tampered = proof_data.proof_bytes.clone();
        tampered[184] ^= 0x02;

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_5(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject tampered ood_quotient: got {:?}", res
        );
    }

    /// [P2.2d-C5] Negative: swapping in wrong public inputs changes α and
    /// breaks the RLC/quotient relation. This confirms the public inputs
    /// (null_1, null_2, out_commit_1, out_commit_2, public_amount, token_mint)
    /// are genuinely bound into the soundness check.
    #[test]
    fn transfer_deep_ali_fails_on_wrong_public_inputs() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c5_sample_proof();

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        let mut wrong_inputs = proof_data.public_inputs.clone();
        wrong_inputs[5] ^= 0xBEEF; // flip token_mint

        let res = verify_deep_ali_circuit_5(&parsed, &wrong_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "DEEP-ALI must reject wrong public inputs: got {:?}", res
        );
    }

    /// [#2 voie A] (b) NON-CONSERVING reject. Outputs exceed inputs but the
    /// proof claims a balanced public_amount = 0. in1=100, in2=50, out1=150,
    /// out2=150 → honest acc = (out-in) = 300-150 = 150 ≠ claimed 0. The
    /// prover's boundary quotient for `acc@row385 == 0` is then NOT a real
    /// polynomial, so the committed Q is inconsistent and the DEEP-ALI identity
    /// `C(z) == Q(z)·Z_T(z)` fails at the random OOD point z. This is the
    /// "mint-from-nothing" attack the new conservation accumulator closes.
    ///
    /// Two-phase model (identical to circuits 3 and 6): phase-1
    /// `verify_generic`/`verify_constraints_transfer` only checks the per-query
    /// Poseidon/carry structure (col 6 is exempt there) and so STRUCTURALLY
    /// accepts this well-formed proof. Conservation is enforced in the MANDATORY
    /// phase-2 `verify_deep_ali_circuit_5` (on-chain: the `verify_deep_ali_phase2`
    /// instruction). The test asserts exactly that split: phase-1 passes,
    /// phase-2 rejects.
    #[test]
    fn transfer_deep_ali_rejects_non_conserving_proof() {
        use crate::compact_proof::get_circuit_config;

        // out1+out2-in1-in2 = 300-150 = 150, but public_amount claimed = 0.
        let proof_data = p01_stark::compact::generate_transfer_compact_proof(
            42, 999, 100, 111, 50, 222, 150, 555, 333, 150, 666, 444, 0, &p01_stark::compact::c5_deterministic_probe_mask());

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        // Phase 2 (the conservation gate) MUST reject.
        let res = verify_deep_ali_circuit_5(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "non-conserving proof must be rejected by phase-2 DEEP-ALI: got {:?}", res
        );

        // Phase 1 (structural only) accepts — documents that conservation is a
        // phase-2 property, so the on-chain path MUST run phase 2 for circuit 5.
        let res_p1 = verify_generic(
            &parsed, proof_data.circuit_id, &proof_data.public_inputs, config,
        );
        assert!(
            res_p1.is_ok(),
            "phase-1 verify_generic is structural-only and should accept the \
             well-formed (but non-conserving) proof; conservation is enforced \
             in mandatory phase-2: got {:?}", res_p1
        );
    }

    /// [#2 voie A] (c) OVERFLOW / field-wrap reject. An attacker supplies an
    /// `out` amount near the Goldilocks modulus (> 2^63) so that, mod p, a
    /// conservation relation might be coaxed, while over the integers it is a
    /// huge/"negative" value no honest u64 note could carry. With public_amount
    /// claimed 0 the honest accumulator computes out1+out2-in1-in2 =
    /// 80 + (p-near) - 150 ≠ 0, so the boundary `acc@row385 == 0` is violated
    /// and DEEP-ALI rejects. Documents why the out-of-circuit u64 bound is still
    /// required (see ConservationRangeNote in the prover AIR).
    #[test]
    fn transfer_deep_ali_rejects_overflow_proof() {
        use crate::compact_proof::get_circuit_config;

        // out2 near 2^64 (> 2^63); claims a balanced public_amount = 0.
        let huge: u64 = 0xFFFF_FFFF_0000_0000;
        let proof_data = p01_stark::compact::generate_transfer_compact_proof(
            42, 999, 100, 111, 50, 222, 80, 555, 333, huge, 666, 444, 0, &p01_stark::compact::c5_deterministic_probe_mask());

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &proof_data.proof_bytes, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_5(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "overflow/field-wrap proof must be rejected by DEEP-ALI: got {:?}", res
        );
    }

    /// [#2 voie A] TAMPERED reject: flip one byte of `ood_current[6]` (the new
    /// accumulator column) at byte 112 (64 + 6·8). This perturbs the
    /// conservation constraints cs[23..27] and the acc boundary fold, so
    /// `C(z) != Q(z)·Z_T(z)`. Confirms the new col-6 OOD opening is genuinely
    /// bound into the soundness check.
    #[test]
    fn transfer_deep_ali_fails_on_tampered_acc_ood() {
        use crate::compact_proof::get_circuit_config;

        let proof_data = c5_sample_proof();
        let mut tampered = proof_data.proof_bytes.clone();
        tampered[112] ^= 0x01; // ood_current[6], byte 0

        let config = get_circuit_config(proof_data.circuit_id).expect("config");
        let parsed = crate::compact_proof::GenericCompactProof::from_bytes(
            &tampered, config,
        ).expect("deserialize");

        let res = verify_deep_ali_circuit_5(&parsed, &proof_data.public_inputs);
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "tampered acc ood_current[6] must be rejected: got {:?}", res
        );
    }

    // ======================================================================
    // [MUTATION 2026-08-02] The six phase-1 per-query constraint arms.
    //
    // MEASURED, not argued: setting `is_trace_aligned = false` in ALL SIX of
    // `verify_constraints_{pool_commitment, balance_proof, merkle_path,
    // confidential_balance, transfer, merkle_update}` — i.e. deleting the whole
    // step-4 per-query transition layer for every live circuit at once — left
    // the entire suite GREEN: 13 test binaries, 169 tests, `cargo test` exit 0.
    //
    // Why the suite could not see it, structurally rather than by oversight:
    //
    //   * every phase-1 test here is a LIVENESS test (`*_verify_generic_accepts_
    //     honest_proof`, `honest_liveness`, `c6_padding_rows`, its C5 twin).
    //     Deleting a rejection can never turn an accept into a reject, so a
    //     loosening is invisible to all of them by construction;
    //   * the two sweeps that DO flip trace bytes
    //     (`c5_tampered_openings_are_all_rejected` / its C6 twin) go through
    //     `verify_generic`, where step 3 (Merkle) refuses a flipped opening
    //     before step 4 is reached. Their own `tamper_and_verify` comment says
    //     exactly that, and the assertion is still only `accepted.is_empty()`,
    //     which the Merkle step satisfies on its own.
    //
    // The C3 (2026-05-29) and C6 (2026-08-01) padding-row defects both lived in
    // this layer. These tests call the ARM DIRECTLY, so Merkle cannot answer for
    // it, and they cover BOTH branches of every arm — the Poseidon-round branch
    // and the identity/padding branch — because the twin defects were in the
    // second one.
    // ======================================================================

    /// A trace-aligned query whose row is genuinely constrained by the arm.
    ///
    /// `pos_in_cycle == 31` is the cycle boundary — a FREE transition in every
    /// one of the six arms — and `trace_length - 1` is outside the transition
    /// vanishing polynomial. Corrupting either is legitimately accepted, so a
    /// test that picked one would measure nothing and pass for the wrong reason.
    fn constrained_trace_aligned_rows(
        proof: &crate::compact_proof::GenericCompactProof,
        cfg: &crate::compact_proof::CircuitConfig,
    ) -> Vec<(usize, usize)> {
        (0..proof.queries.len())
            .filter_map(|i| {
                let pos = proof.queries[i].position as usize;
                if pos % cfg.blowup != 0 {
                    return None;
                }
                let row = (pos / cfg.blowup) % cfg.trace_length;
                if row % 32 == 31 || row == cfg.trace_length - 1 {
                    return None;
                }
                Some((i, row))
            })
            .collect()
    }

    /// Corrupt column 0 of ONE opened next-row and hand the proof to the arm.
    ///
    /// Column 0 of the next row is constrained at every row
    /// `constrained_trace_aligned_rows` returns, in all six arms: the
    /// Poseidon-round branch demands `next[0] == poseidon_round(current)[0]`,
    /// the identity/padding branch demands `next[0] == current[0]`. So one
    /// corruption exercises whichever branch the drawn row lands in and the
    /// expected error is the same either way — no arm gets a free pass because
    /// of which branch its witness happened to draw.
    fn corrupt_next_row_and_run(
        label: &str,
        cfg: &crate::compact_proof::CircuitConfig,
        pd: &p01_stark::compact::GenericCompactProofData,
        q: usize,
        arm: &impl Fn(
            &crate::compact_proof::GenericCompactProof,
            &crate::compact_proof::CircuitConfig,
            &[u64],
        ) -> Result<(), VerifyError>,
    ) -> Result<(), VerifyError> {
        let honest = crate::compact_proof::GenericCompactProof::from_bytes(&pd.proof_bytes, cfg)
            .unwrap_or_else(|| panic!("{label}: honest proof must parse"));
        let (trace_off, stride) = route_c_trace_block(cfg, &pd.proof_bytes, q);
        // Per-query wire order: position(4) | trace | trace_mirror | next_trace | …
        let next_off = trace_off + 2 * stride;
        let mut broken = pd.proof_bytes.clone();
        let v = u64::from_le_bytes(broken[next_off..next_off + 8].try_into().unwrap());
        let bumped = (v + 1) % crate::goldilocks::MODULUS;
        assert_ne!(v, bumped, "{label}: the corruption must actually change the felt");
        broken[next_off..next_off + 8].copy_from_slice(&bumped.to_le_bytes());

        let tampered = crate::compact_proof::GenericCompactProof::from_bytes(&broken, cfg)
            .unwrap_or_else(|| {
                panic!(
                    "{label}: the tampered proof must still PARSE — if it does not, this test \
                     measures the parser and not the constraint arm"
                )
            });
        // The corruption landed where this test claims it did. Without these two
        // the negative leg could be green because the edit missed.
        assert_eq!(
            tampered.queries[q].next_trace_value(0).as_u64(),
            bumped,
            "{label}: the byte edit did not land in query {q}'s next-row block"
        );
        assert_eq!(
            tampered.queries[q].trace_value(0).as_u64(),
            honest.queries[q].trace_value(0).as_u64(),
            "{label}: the byte edit spilled into the CURRENT row block"
        );
        arm(&tampered, cfg, &pd.public_inputs)
    }

    /// [B7 2026-08-04] Assert that the phase-1 trace-aligned arm is RETIRED —
    /// the inverse of what this helper's predecessor
    /// (`arm_rejects_broken_transitions_in_both_branches`, git history at
    /// e900b78c) asserted, deliberately. That harness swept up to 512 seeds
    /// until both branches of the arm had rejected a corrupted next-row
    /// opening; with the coset LDE no opened position IS a trace row, the arms
    /// are disabled (`let is_trace_aligned = false;` at every site), and the
    /// probe could only fail — MEASURED on this tree: all six went red on the
    /// first corruption, "the phase-1 arm ACCEPTED a broken transition".
    ///
    /// What this asserts instead, per witness:
    ///   * the arm still ACCEPTS the honest proof — the production call in
    ///     `verify_generic` must stay harmless;
    ///   * the arm ALSO accepts every corrupted next-row opening at the
    ///     positions the old arithmetic called trace-aligned — it is vacuous,
    ///     so no reader may count it as transition coverage. If this ever
    ///     rejects, the retired arm has come back to life: restore the
    ///     branch-coverage probes from git history instead of loosening this.
    ///
    /// Where the coverage went, so this is a relocation and not a loss: the
    /// arm's job — an INDEPENDENT re-derivation of the AIR against the trace,
    /// which caught the C3 (2026-05-29) and C6 (2026-08-01) padding-row
    /// defects — moved prover-side to `assert_air_agrees_with_trace_c0` and
    /// its generic twin in `stark/src/compact.rs`, which check EVERY
    /// constrained row (not whichever a query happened to hit) and are proven
    /// non-vacuous there by the row-(n-1) mutation. The `inactive_from`
    /// parameter is kept, unused, so the six call sites still document where
    /// each arm's inactive tail was for whoever revives the old probes.
    fn phase1_arm_is_retired_post_b7(
        label: &str,
        cfg: &crate::compact_proof::CircuitConfig,
        _inactive_from: Option<usize>,
        make: impl Fn(u64) -> p01_stark::compact::GenericCompactProofData,
        arm: impl Fn(
            &crate::compact_proof::GenericCompactProof,
            &crate::compact_proof::CircuitConfig,
            &[u64],
        ) -> Result<(), VerifyError>,
    ) {
        const SEEDS: u64 = 8;
        let mut checked = 0usize;

        for seed in 0..SEEDS {
            let pd = make(seed);
            let honest =
                crate::compact_proof::GenericCompactProof::from_bytes(&pd.proof_bytes, cfg)
                    .unwrap_or_else(|| panic!("{label}: honest proof (seed {seed}) must parse"));
            // Control: the arm accepts the honest proof.
            arm(&honest, cfg, &pd.public_inputs).unwrap_or_else(|e| {
                panic!("{label}: the arm must ACCEPT the honest proof (seed {seed}), got {e:?}")
            });

            for (q, row) in constrained_trace_aligned_rows(&honest, cfg) {
                let got = corrupt_next_row_and_run(label, cfg, &pd, q, &arm);
                assert_eq!(
                    got,
                    Ok(()),
                    "{label}: the RETIRED phase-1 arm rejected a corrupted next-row opening \
                     at trace row {row} (seed {seed}, query {q}). It has come back to life; \
                     if that is deliberate, restore the pre-B7 branch-coverage probes from \
                     git history (e900b78c) instead of loosening this assertion — and note \
                     that on the coset an aligned position is NOT a trace row, so a revived \
                     arm is not merely dead weight, it is wrong."
                );
                checked += 1;
            }
        }

        println!(
            "[PHASE1-B7] {label}: the retired arm accepted {checked} corrupted openings \
             across {SEEDS} witnesses — vacuous as designed; AIR-vs-trace re-derivation \
             lives prover-side over every constrained row (assert_air_agrees_with_trace_c0 \
             and generic twin, non-vacuity by the row-(n-1) mutation)."
        );
    }

    #[test]
    fn c1_phase1_arm_is_retired_post_b7() {
        phase1_arm_is_retired_post_b7(
            "C1 pool_commitment",
            &crate::compact_proof::CONFIG_POOL_COMMITMENT,
            // `cycle < 3`: rows 96..=127 are the inactive tail.
            Some(96),
            |s| p01_stark::compact::generate_pool_commitment_proof(42 + s, 17, 7, 11, &p01_stark::compact::c1_deterministic_probe_mask()),
            verify_constraints_pool_commitment,
        );
    }

    #[test]
    fn c2_phase1_arm_is_retired_post_b7() {
        phase1_arm_is_retired_post_b7(
            "C2 balance_proof",
            &crate::compact_proof::CONFIG_BALANCE_PROOF,
            None, // all four cycles hash
            |s| p01_stark::compact::generate_balance_compact_proof(42 + s, 1000, 777, 999),
            verify_constraints_balance_proof,
        );
    }

    #[test]
    fn c3_phase1_arm_is_retired_post_b7() {
        phase1_arm_is_retired_post_b7(
            "C3 merkle_path",
            &crate::compact_proof::CONFIG_MERKLE_PATH,
            // CANONICAL_DEPTH * 32 — the region of the 2026-05-29 fix.
            Some(480),
            |s| c3_sample_proof(777 + s),
            verify_constraints_merkle_path,
        );
    }

    #[test]
    fn c4_phase1_arm_is_retired_post_b7() {
        phase1_arm_is_retired_post_b7(
            "C4 confidential_balance",
            &crate::compact_proof::CONFIG_CONFIDENTIAL_BALANCE,
            // Cycle 7 is a real dummy Poseidon (`run_hash(trace, 7, 0, 0)`), so
            // C4 has no inactive tail and the arm is right not to bound one.
            None,
            |s| {
                p01_stark::compact::generate_confidential_balance_compact_proof(
                    42 + s, 1000, 111, 800, 222, 200, 333, 999,
                )
            },
            verify_constraints_confidential_balance,
        );
    }

    #[test]
    fn c5_phase1_arm_is_retired_post_b7() {
        phase1_arm_is_retired_post_b7(
            "C5 transfer",
            &crate::compact_proof::CONFIG_TRANSFER,
            None,
            // Conserving witness: in1+in2 == out1+out2, public_amount 0.
            |s| {
                p01_stark::compact::generate_transfer_compact_proof(
                    42 + s, 999, 100, 111, 50, 222, 80, 555, 333, 70, 666, 444, 0, &p01_stark::compact::c5_deterministic_probe_mask())
            },
            verify_constraints_transfer,
        );
    }


    /// [C7] The seventh retired-arm pin. Six existed; C7 had none.
    ///
    /// 🚨 AND C7 IS THE ONE CIRCUIT FOR WHICH REVIVING THIS ARM IS DESTRUCTIVE
    /// RATHER THAN MERELY USELESS. For C1..C6 a revived per-query check would
    /// be dead weight -- under the coset an "aligned" position is not a trace
    /// row, so the comparison means nothing. For C7 it is worse than nothing.
    ///
    /// Flip `is_trace_aligned` back to `pos % blowup == 0` and the prover is
    /// forced to write a CONSTANT across rows 384..510 of every column. Col 9's
    /// unknown count drops from 138 -- one commitment segment, nine filler
    /// cycles, 128 independent mask values -- to about twelve, against the
    /// R = 4*22 + 2 = 90 evaluations the wire publishes. More equations than
    /// unknowns is exactly the state depth 12 was adopted to escape: at depth 15
    /// an observer solved a 14x14 system and recovered the commitment exactly.
    ///
    /// So this pin is not hygiene. It is the test that stands between a
    /// plausible-looking "let's re-enable the per-query checks" and the return
    /// of a solvable commitment.
    #[test]
    fn c7_phase1_arm_is_retired_post_b7() {
        use p01_stark::air::spend::{CANONICAL_DEPTH, FIRST_FREE_ROW, MASK_LEN, TRACE_WIDTH};
        const GOLDILOCKS: u64 = 0xFFFF_FFFF_0000_0001;

        phase1_arm_is_retired_post_b7(
            "C7 spend",
            &crate::compact_proof::CONFIG_SPEND,
            // Documentary only: rows 384..511 take NO check of any kind. C7's
            // contract cannot be expressed as one `active_rows` number, which is
            // why the helper ignores this argument.
            Some(FIRST_FREE_ROW),
            |s| {
                let path_elements: Vec<u64> =
                    (0..CANONICAL_DEPTH as u64).map(|i| 1000 + i * 37 + s * 11).collect();
                let path_indices: Vec<u8> =
                    (0..CANONICAL_DEPTH).map(|i| (i % 2) as u8).collect();
                // Deterministic, and deliberately so: a pin needs the same proof
                // every run. ⛔ NOT the shape a real spend uses -- that one draws
                // MASK_LEN fresh CSPRNG elements per proof.
                let mut st = 0x9E37_79B9_7F4A_7C15u64 ^ s.wrapping_mul(0x1000_0000_0000_0001);
                if st == 0 {
                    st = 0xD1B5_4A32_D192_ED03;
                }
                let mut mask = Vec::with_capacity(MASK_LEN);
                for _ in 0..(MASK_LEN) {
                    st ^= st >> 12;
                    st ^= st << 25;
                    st ^= st >> 27;
                    mask.push(st.wrapping_mul(0x2545_F491_4F6C_DD1D) % GOLDILOCKS);
                }
                p01_stark::compact::generate_spend_compact_proof(
                    42 + s, 999, 7, 555, &path_elements, &path_indices, &[11, 22, 33, 44], &mask,
                )
            },
            verify_constraints_spend,
        );
    }

    #[test]
    fn c6_phase1_arm_is_retired_post_b7() {
        phase1_arm_is_retired_post_b7(
            "C6 merkle_update",
            &crate::compact_proof::CONFIG_MERKLE_UPDATE,
            // CANONICAL_DEPTH * 32 — the region of the 2026-08-01 twin fix.
            Some(480),
            |s| {
                let path_elements: Vec<u64> = (0..12).map(|i| 100u64 + i * 13).collect();
                let path_indices: Vec<u8> = (0..12).map(|i| (i % 2) as u8).collect();
                p01_stark::compact::generate_merkle_update_compact_proof(
                    111 + s, 222, &path_elements, &path_indices, &p01_stark::compact::c6_deterministic_probe_mask(path_elements.len()))
            },
            verify_constraints_merkle_update,
        );
    }

    // ======================================================================
    // [MUTATION 2026-08-02] Step 5, `verify_boundary_constraints`.
    //
    // MEASURED: short-circuiting it to `Ok(())` (verify.rs
    // `if assertions.is_empty() {` -> `if true {`) left the WHOLE suite green —
    // 70 lib tests including the six phase-1 arm tests above, plus all twelve
    // integration binaries, `cargo test` exit 0. Nothing in the repository
    // required the per-query public-input binding to fire even once.
    //
    // WHY IT USED TO MATTER MOST FOR C2 AND C4, in the past tense because
    // [BIND-C2C4 2026-08-03] changed it. Until that commit `verify_deep_ali_circuit_2`
    // and `verify_deep_ali_circuit_4` were the only two phase-2 entry points that
    // never called `boundary_fold_at_ood`, so this trace-aligned per-query check
    // was the ONLY thing anywhere binding their trace to their public inputs —
    // and the measurements below said it could fire on ~2-3% of honest witnesses.
    // Re-measured POST-FIX at `bd8be2b4` the [STEP5] rates are C1 4.67%,
    // C2 2.33%, C4 1.33%, C5 2.34% — so the honest range is now 1.3%-4.7%, and
    // C4 in particular is BELOW the old "~2-3%" because folding Q_bnd
    // re-randomised the draw the query positions come from.
    // Both now fold, so all seven circuits bind their public inputs at the OOD
    // point on EVERY proof, unconditionally, and this check is a second layer
    // rather than the only one.
    //
    // What has NOT changed, and is the reason these tests stay: this check is
    // still the only per-query public-input binding, and
    // `balance_proof_deep_ali_fails_on_wrong_public_inputs` and its C4 twin still
    // do not cover public-input binding at all. They pass because the public
    // inputs feed the Fiat-Shamir RLC alpha, which binds the CLAIMED inputs to
    // the transcript, not the trace to the inputs — measured, not argued: they
    // were green on the pre-fix tree, which had no C2/C4 fold whatsoever. A
    // prover who simply re-runs the pipeline under a different claim satisfies
    // them. `c2_lying_public_input_is_rejected` / `c4_..` are the tests that do
    // cover it.
    //
    // Scope, stated rather than implied: this guard covers C1, C2, C4 and C5.
    // C3 and C6 are left to phase 2, where `boundary_fold_at_ood` binds the SAME
    // assertion list at the OOD point on EVERY proof and is already covered by
    // `merkle_path_deep_ali_fails_on_wrong_public_inputs` and
    // `merkle_update_deep_ali_fails_on_wrong_public_inputs`. Reaching their step-5
    // rows here would need ~190 witnesses each (2 assertion rows in 512, ~1.375
    // trace-aligned queries per proof), which is not worth the wall clock for a
    // check phase 2 already makes unconditional.
    //
    // [B7 2026-08-04] STEP 5 IS RETIRED, and everything above is history now.
    // The coset LDE moved every committed position to x = h * g^i, so NO query
    // position is a trace row any more and the per-query arm was disabled
    // outright (`verify_boundary_constraints` skips every query — see the [B7]
    // comment in its body). MEASURED on this tree before the probes were
    // reworked: all four hit-rate probes panicked with 0/300 (C1, C2, C4) and
    // 0/128 (C5) witnesses able to draw a trace-aligned query — the 4.67% /
    // 2.33% / 1.33% / 2.34% rates quoted above did not survive the retirement,
    // exactly as retiring the mechanism predicts. The probes below therefore no
    // longer measure a hit rate; they assert the retirement itself (step 5
    // accepts EVERYTHING, so nobody re-reads it as a live binding) and the
    // binding claim lives where it is unconditional: the OOD boundary fold,
    // measured at 100% by the [BIND] lying-claim tests in this same run.
    // ======================================================================

    /// [B7 2026-08-04] Assert that step 5 is RETIRED — the opposite of what
    /// this helper's predecessor (`step5_binding_must_fire`) asserted, and on
    /// purpose. That probe swept witnesses for a trace-aligned query on a
    /// public-input assertion row and panicked if none of the budget hit; on
    /// the coset there is nothing to hit (0/300 and 0/128 MEASURED, see the
    /// block comment above), so keeping it meant a permanently red suite over
    /// a mechanism that was deliberately removed.
    ///
    /// What this asserts instead, per witness:
    ///   * step 5 still ACCEPTS the honest proof under its own inputs — the
    ///     production call at step 5 of `verify_generic` must stay harmless;
    ///   * step 5 ALSO accepts every single-input perturbation — it is
    ///     vacuous, so no reader may count it as a public-input binding. If
    ///     this ever rejects, the retired arm has come back to life: revive
    ///     the pre-B7 hit-rate probes (git history at e900b78c) instead of
    ///     weakening this assertion.
    ///
    /// The binding the old probe existed to measure is the OOD boundary fold,
    /// which is UNCONDITIONAL — see `lying_claim_must_be_rejected` right
    /// below, whose [BIND] lines report 100% rejection across every witness
    /// and every public input, and the `*_deep_ali_fails_on_wrong_public_inputs`
    /// family for the transcript half.
    fn step5_is_vacuous_post_b7(
        label: &str,
        circuit_id: u8,
        cfg: &crate::compact_proof::CircuitConfig,
        seeds: u64,
        make: impl Fn(u64) -> p01_stark::compact::GenericCompactProofData,
    ) {
        for seed in 0..seeds {
            let pd = make(seed);
            let p = crate::compact_proof::GenericCompactProof::from_bytes(&pd.proof_bytes, cfg)
                .unwrap_or_else(|| panic!("{label}: honest proof (seed {seed}) must parse"));
            // Control: step 5 accepts the honest proof under its own inputs.
            verify_boundary_constraints(&p, circuit_id, cfg, &pd.public_inputs)
                .unwrap_or_else(|e| {
                    panic!("{label}: step 5 must ACCEPT the honest proof (seed {seed}), got {e:?}")
                });

            for i in 0..pd.public_inputs.len() {
                let mut pi = pd.public_inputs.clone();
                pi[i] = pi[i].wrapping_add(1);
                assert_eq!(
                    verify_boundary_constraints(&p, circuit_id, cfg, &pi),
                    Ok(()),
                    "{label}: seed {seed} input {i} — step 5 REJECTED a perturbed public \
                     input. The retired per-query arm is alive again; if that is deliberate, \
                     restore the pre-B7 hit-rate probes from git history instead of loosening \
                     this assertion."
                );
            }
        }
        println!(
            "[STEP5-B7] {label}: step 5 accepted the honest proof AND every single-input \
             perturbation across {seeds} witnesses — retired as designed; the public-input \
             binding is the OOD boundary fold ([BIND] lines in this run, 100%)."
        );
    }

    // Seed budgets: the pre-B7 probes swept 300 witnesses (128 for C5) because
    // they were measuring a HIT RATE in the low percent. Vacuity needs no
    // statistics — any witness whose perturbations are all accepted proves the
    // arm is off — so 8 witnesses per circuit keeps the four tests cheap while
    // still sweeping every public input on every one of them.

    #[test]
    fn c1_step5_is_vacuous_post_b7() {
        step5_is_vacuous_post_b7(
            "C1 pool_commitment",
            1,
            &crate::compact_proof::CONFIG_POOL_COMMITMENT,
            8,
            |s| p01_stark::compact::generate_pool_commitment_proof(42 + s, 17, 7, 11, &p01_stark::compact::c1_deterministic_probe_mask()),
        );
    }

    #[test]
    fn c2_step5_is_vacuous_post_b7() {
        step5_is_vacuous_post_b7(
            "C2 balance_proof",
            2,
            &crate::compact_proof::CONFIG_BALANCE_PROOF,
            8,
            |s| p01_stark::compact::generate_balance_compact_proof(42 + s, 1000, 777, 999),
        );
    }

    #[test]
    fn c4_step5_is_vacuous_post_b7() {
        step5_is_vacuous_post_b7(
            "C4 confidential_balance",
            4,
            &crate::compact_proof::CONFIG_CONFIDENTIAL_BALANCE,
            8,
            |s| {
                p01_stark::compact::generate_confidential_balance_compact_proof(
                    42 + s, 1000, 111, 800, 222, 200, 333, 999,
                )
            },
        );
    }

    #[test]
    fn c5_step5_is_vacuous_post_b7() {
        step5_is_vacuous_post_b7(
            "C5 transfer",
            5,
            &crate::compact_proof::CONFIG_TRANSFER,
            8,
            |s| {
                p01_stark::compact::generate_transfer_compact_proof(
                    42 + s, 999, 100, 111, 50, 222, 80, 555, 333, 70, 666, 444, 0, &p01_stark::compact::c5_deterministic_probe_mask())
            },
        );
    }

    // ======================================================================
    // [BIND-C2C4 2026-08-03] The C2/C4 boundary fold, pinned by the forgery it
    // stops rather than by an honest proof still verifying.
    //
    // THE MUTATION THESE GO RED UNDER, stated exactly, because a guard is only
    // worth what it checks: revert BOTH halves of the fix together —
    //   * `stark/src/compact.rs` `boundary_spec_for_quotient`:
    //     `QuotientSpec::Circuit2 => None`, `QuotientSpec::Circuit4 => None`
    //     (the prover stops folding Q_bnd into the committed quotient), AND
    //   * this file: delete the `let c_bnd = boundary_fold_at_ood(..)` block from
    //     `verify_deep_ali_circuit_2` / `_4` and compare `c_at_z` to `rhs`.
    // That pair IS the pre-fix code. Reverting only one half breaks honest
    // proofs, so the honest-liveness suite catches that on its own; the
    // coordinated revert is the one that silently reopens the hole, and it is
    // what `c2_lying_public_input_is_rejected` / `c4_..` go red on. Under the
    // coordinated revert those proofs VERIFY: the public inputs would then feed
    // nothing but the Fiat-Shamir alpha, and the probe re-runs the whole
    // pipeline under its false claim, so alpha, the OOD point, the query
    // positions and every FRI layer are self-consistent with it.
    //
    // Why this is not `balance_proof_deep_ali_fails_on_wrong_public_inputs`
    // (verify.rs:5264) or its C4 twin: those hand the verifier a public-input
    // vector the proof was NOT built with, so alpha moves and the TRANSITION
    // identity fails. They pass identically with the boundary fold removed —
    // measured, not assumed: they were green on the pre-fix tree, which had no
    // C2/C4 fold at all. They are liveness-shaped guards on the transcript, not
    // on public-input binding.
    // ======================================================================

    /// Drive `seeds` honest witnesses, and for each one publish the SAME honest
    /// trace under a false value for every public input in turn. Require the
    /// phase-2 verifier to reject each, and report the rejection rate against
    /// the PRE-FIX 2.33% (C2) / 3.00% (C4) the trace-aligned step-5 check was
    /// measured at when it was the only binding there was.
    ///
    /// POST-FIX those same step-5 probes measured 2.33% (C2, unchanged) and
    /// 1.33% (C4, down from 3.00% because folding Q_bnd re-randomises the
    /// Fiat-Shamir draw the query positions come from). Neither is the number
    /// this harness reports: this one is 100%, unconditionally.
    ///
    /// [B7 2026-08-04] Those step-5 rates are all ZERO now — the coset LDE
    /// leaves no trace-aligned query positions and the per-query arm is
    /// disabled (MEASURED: 0/300, 0/300, 0/300, 0/128 before the probes were
    /// reworked into `step5_is_vacuous_post_b7`). This 100% figure is
    /// therefore the ONLY per-proof public-input binding measurement left,
    /// which is exactly why it is asserted and not merely printed.
    fn lying_claim_must_be_rejected(
        label: &str,
        cfg: &crate::compact_proof::CircuitConfig,
        n_inputs: usize,
        seeds: u64,
        // (seed, claim_index, claimed_value) -> proof carrying an honest trace
        // and a lying transcript.
        make_lie: impl Fn(u64, usize, u64) -> p01_stark::compact::GenericCompactProofData,
        make_honest: impl Fn(u64) -> p01_stark::compact::GenericCompactProofData,
        verify: impl Fn(
            &crate::compact_proof::GenericCompactProof,
            &[u64],
        ) -> Result<(), VerifyError>,
    ) {
        let mut attempts = 0usize;
        let mut rejected = 0usize;
        for seed in 0..seeds {
            // Control: the honest witness verifies, so a rejection below is the
            // lie being caught and not the harness being broken.
            let honest = make_honest(seed);
            let hp = crate::compact_proof::GenericCompactProof::from_bytes(&honest.proof_bytes, cfg)
                .unwrap_or_else(|| panic!("{label}: honest proof (seed {seed}) must parse"));
            verify(&hp, &honest.public_inputs).unwrap_or_else(|e| {
                panic!("{label}: honest proof (seed {seed}) must verify, got {e:?}")
            });
            // A HOLLOW GUARD USED TO SIT HERE. It was commented "the boundary
            // term has to actually contribute something at z — a fold that
            // evaluates to zero on every honest proof would bind nothing while
            // looking wired", and what it actually asserted was
            // `honest.public_inputs.len() != 0` — a constant property of the
            // generator two lines above, true whether or not anything folds.
            // Deleted rather than kept as decoration: a comment claiming a check
            // that is not in the code is the defect this whole run exists to
            // find, and leaving it would have let a reader believe
            // non-degeneracy was covered here.
            //
            // Non-degeneracy IS covered, twice, and neither place is this line:
            //   * the `for idx in 0..n_inputs` sweep immediately below lies about
            //     EVERY public input in turn and requires every one of them to be
            //     refused, so a fold whose assertion list bound only hardcoded
            //     `Felt::ZERO` capacity rows fails here on the first index.
            //   * `balance_proof_satisfies_deep_ali_end_to_end` and
            //     `confidential_balance_..` in stark/src/compact.rs assert
            //     `c_bnd != 0` on the prover side directly.

            for idx in 0..n_inputs {
                // A value the honest trace does not carry at that assertion row.
                let lie = honest.public_inputs[idx] ^ 0x5AA5_1234_DEAD_0001;
                let pd = make_lie(seed, idx, lie);
                assert_eq!(
                    pd.public_inputs[idx], lie,
                    "{label}: probe did not actually publish the lie at input {idx}"
                );
                let p = crate::compact_proof::GenericCompactProof::from_bytes(&pd.proof_bytes, cfg)
                    .unwrap_or_else(|| {
                        panic!("{label}: lying proof (seed {seed}, input {idx}) must still parse")
                    });
                attempts += 1;
                match verify(&p, &pd.public_inputs) {
                    Err(VerifyError::DeepAliFailed) => rejected += 1,
                    Err(other) => panic!(
                        "{label}: seed {seed} input {idx} rejected for the WRONG reason: {other:?}"
                    ),
                    Ok(()) => panic!(
                        "{label}: seed {seed} input {idx} — an honest trace published under a \
                         FALSE public input VERIFIED. The boundary fold is not binding."
                    ),
                }
            }
        }
        assert_eq!(
            rejected, attempts,
            "{label}: {rejected}/{attempts} lying claims rejected — must be all of them"
        );
        println!(
            "[BIND] {label}: {rejected}/{attempts} lying claims rejected (100.00%) across \
             {seeds} witnesses x {n_inputs} public inputs. Before [BIND-C2C4] the ONLY binding \
             was the trace-aligned step-5 check (2.33% C2 / 3.00% C4 pre-fix, 2.33% / 1.33% \
             post-fix); since [B7] that arm is retired outright and can fire on NOTHING — \
             see the [STEP5-B7] lines in this same run — so this fold is the whole binding."
        );
    }

    /// C2: an honest `balance_proof` trace published under a false `commitment`
    /// or a false `token_mint`. Must be refused on every seed.
    #[test]
    fn c2_lying_public_input_is_rejected() {
        lying_claim_must_be_rejected(
            "C2 balance_proof",
            &crate::compact_proof::CONFIG_BALANCE_PROOF,
            2,
            24,
            |s, idx, v| {
                p01_stark::compact::generate_balance_compact_proof_claiming(
                    42 + s, 1000, 777, 999, idx, v,
                )
            },
            |s| p01_stark::compact::generate_balance_compact_proof(42 + s, 1000, 777, 999),
            |p, pi| verify_deep_ali_circuit_2(p, pi),
        );
    }

    /// C4: an honest `confidential_balance` trace published under a false
    /// `old_commitment`, `new_commitment`, `amount_hash` or `token_mint`.
    #[test]
    fn c4_lying_public_input_is_rejected() {
        lying_claim_must_be_rejected(
            "C4 confidential_balance",
            &crate::compact_proof::CONFIG_CONFIDENTIAL_BALANCE,
            4,
            12,
            |s, idx, v| {
                p01_stark::compact::generate_confidential_balance_compact_proof_claiming(
                    42 + s, 1000, 111, 800, 222, 200, 333, 999, idx, v,
                )
            },
            |s| {
                p01_stark::compact::generate_confidential_balance_compact_proof(
                    42 + s, 1000, 111, 800, 222, 200, 333, 999,
                )
            },
            |p, pi| verify_deep_ali_circuit_4(p, pi),
        );
    }

    /// The same probe run against C1 — a circuit whose boundary fold was ALREADY
    /// wired before this fix. It is the CONTROL: it rules out the C2/C4 greens
    /// above coming from the probe being trivially rejected for some reason
    /// unrelated to binding, and it means that if the shared
    /// `boundary_fold_at_ood` ever stops binding, C1 goes red alongside them.
    ///
    /// SCOPE, stated exactly rather than implied. C3, C5 and C6 have NO probe of
    /// this shape, because a lying-claim probe has to re-run the entire prover
    /// pipeline under the false public input, and only three such generators
    /// exist: `generate_pool_commitment_proof_claiming` (C1),
    /// `generate_balance_compact_proof_claiming` (C2) and
    /// `generate_confidential_balance_compact_proof_claiming` (C4). Writing the
    /// other three was deliberately not done here — see `founder_decisions` —
    /// so C3/C5/C6 public-input binding rests on `boundary_fold_at_ood` being
    /// the SAME code path this test exercises, not on a probe of their own.
    /// Do not read this test as covering them.
    ///
    /// C0 is a separate path either way: legacy, verified by
    /// `verify_deep_ali_legacy`, with `c0_tampered_commitment_rejected_every_seed`
    /// in `boundary_c0_tests` as its equivalent.
    #[test]
    fn c1_lying_public_input_is_rejected() {
        lying_claim_must_be_rejected(
            "C1 pool_commitment",
            &crate::compact_proof::CONFIG_POOL_COMMITMENT,
            2,
            16,
            |s, idx, v| {
                p01_stark::compact::generate_pool_commitment_proof_claiming(42 + s, 17, 7, 11, &p01_stark::compact::c1_deterministic_probe_mask(), idx, v)
            },
            |s| p01_stark::compact::generate_pool_commitment_proof(42 + s, 17, 7, 11, &p01_stark::compact::c1_deterministic_probe_mask()),
            |p, pi| verify_deep_ali_circuit_1(p, pi),
        );
    }
}

/// [C2] Circuit-0 boundary-fold parity + auth-forgery rejection.
///
/// Circuit 0 (subscriber_ownership) is the live legacy path
/// (`verify_stark_proof` → `verify_subscriber_ownership` → `verify_deep_ali_legacy`,
/// prover `stark::compact::generate_compact_proof`). Before the boundary fold,
/// the only binding of the public `commitment` to the trace was the per-query
/// `verify_boundary_constraints_legacy` check, which fires only when a query
/// lands on a trace-aligned row (~1/blowup ≈ 6%). A subscriber could forge
/// ownership of an arbitrary commitment with ~95% success by reusing an honest
/// proof under a different claimed commitment.
///
/// With the OOD boundary fold the binding is enforced at the random OOD point z
/// on EVERY proof: tampering the commitment must fail 100% of the time.
#[cfg(test)]
mod boundary_c0_tests {
    use super::*;

    /// Positive: an honest legacy circuit-0 proof still verifies end-to-end
    /// (the boundary fold must not break honest proofs).
    #[test]
    fn c0_honest_proof_verifies_with_boundary_fold() {
        for secret in [42u64, 7, 1_000_003, 0xDEAD_BEEF] {
            let pd = p01_stark::compact::generate_compact_proof(secret);
            let parsed = crate::compact_proof::CompactStarkProof::from_bytes(&pd.proof_bytes)
                .expect("deserialize legacy proof");
            verify_deep_ali_legacy(&parsed, Felt::new(pd.commitment))
                .unwrap_or_else(|e| panic!("honest C0 DEEP-ALI must pass (secret={secret}): {e:?}"));
            // Full legacy verification path too.
            verify_subscriber_ownership(&parsed, Felt::new(pd.commitment))
                .unwrap_or_else(|e| panic!("honest C0 full verify must pass (secret={secret}): {e:?}"));
        }
    }

    /// Negative: take an honest proof, tamper the claimed public commitment
    /// (commitment += 1) WITHOUT touching the proof bytes, and assert DEEP-ALI
    /// rejects it for EVERY secret (i.e. every Fiat-Shamir seed / query layout).
    /// Pre-fix this passed ~95% of the time (only caught when a query landed on
    /// the trace-aligned commitment row); post-fix it must fail every time.
    #[test]
    fn c0_tampered_commitment_rejected_every_seed() {
        let mut tested = 0;
        for secret in 1u64..=40 {
            let pd = p01_stark::compact::generate_compact_proof(secret);
            let parsed = crate::compact_proof::CompactStarkProof::from_bytes(&pd.proof_bytes)
                .expect("deserialize legacy proof");
            // Sanity: honest commitment passes.
            verify_deep_ali_legacy(&parsed, Felt::new(pd.commitment))
                .expect("honest commitment must pass");
            // Forge: claim ownership of commitment+1 with the same proof bytes.
            let forged = Felt::new((pd.commitment).wrapping_add(1) % crate::goldilocks::MODULUS);
            let res = verify_deep_ali_legacy(&parsed, forged);
            assert!(
                matches!(res, Err(VerifyError::DeepAliFailed)),
                "forged commitment must be rejected at OOD (secret={secret}): got {res:?}"
            );
            tested += 1;
        }
        assert_eq!(tested, 40, "should have exercised 40 distinct FS seeds");
    }

    /// Negative: tamper an OOD trace value (the opened `current[0]`) without
    /// recomputing the quotient. The boundary + transition numerator at z
    /// diverges from `Q(z)·Z_T(z)` and DEEP-ALI must fail.
    #[test]
    fn c0_tampered_ood_current_rejected() {
        let pd = p01_stark::compact::generate_compact_proof(42);
        // ood_current[0] lives at offset 64 (trace_root 32 + quotient_root 32).
        let mut tampered = pd.proof_bytes.clone();
        tampered[64] ^= 0x01;
        let parsed = crate::compact_proof::CompactStarkProof::from_bytes(&tampered)
            .expect("deserialize");
        let res = verify_deep_ali_legacy(&parsed, Felt::new(pd.commitment));
        assert!(
            matches!(res, Err(VerifyError::DeepAliFailed)),
            "tampered ood_current must be rejected: got {res:?}"
        );
    }

    /// [C0 GATE] The generic dispatch REFUSES circuit 0, explicitly.
    ///
    /// An honest C0 proof parses cleanly as a `GenericCompactProof` (same header
    /// layout, tw=3, md=9, 4 committed FRI layers), so nothing about the bytes
    /// stops it reaching `verify_generic`. The gate is what stops it, and it must
    /// return the named error rather than something that reads like a bad proof.
    #[test]
    fn c0_generic_dispatch_refuses_circuit_zero() {
        let pd = p01_stark::compact::generate_compact_proof(42);
        let cfg = crate::compact_proof::get_circuit_config(0).expect("C0 has a config");
        let parsed = GenericCompactProof::from_bytes(&pd.proof_bytes, cfg)
            .expect("an honest C0 proof does parse under the generic parser");
        let res = verify_generic(&parsed, 0, &[pd.commitment], cfg);
        assert!(
            matches!(res, Err(VerifyError::CircuitZeroIsLegacyOnly)),
            "generic path must refuse circuit 0 by name, got {res:?}"
        );
    }

    /// [C0 GATE] …and the refusal is not merely tidy: the generic path CANNOT
    /// verify an honest C0 proof. This calls the C0 constraint body directly,
    /// bypassing the gate, and records the failure.
    ///
    /// Two independent reasons, both structural:
    ///   * `verify_deep_ali_circuit_0` is reached through generic machinery that
    ///     divides by `Z_D(x) = x^n - 1`; C0's constraint is only divisible by
    ///     `Z_T(x) = (x^n - 1)/(x - g^(n-1))` because the row-(n-1) wrap does not
    ///     vanish.
    ///   * C0's committed quotient carries a folded boundary term (`bnd-c0` tag)
    ///     that the generic path never recomputes.
    ///
    /// If this test ever goes green-accepting, the gate above stops being a
    /// safety property and becomes a policy choice — and this comment becomes a
    /// lie. That is the point of asserting it.
    #[test]
    fn c0_generic_path_cannot_verify_an_honest_c0_proof() {
        let pd = p01_stark::compact::generate_compact_proof(42);
        let cfg = crate::compact_proof::get_circuit_config(0).expect("C0 has a config");
        let parsed = GenericCompactProof::from_bytes(&pd.proof_bytes, cfg)
            .expect("parse honest C0 proof as generic");

        // Sanity: the legacy path DOES verify this proof, so any failure below is
        // about the generic path, not about the proof.
        let legacy = crate::compact_proof::CompactStarkProof::from_bytes(&pd.proof_bytes)
            .expect("parse honest C0 proof as legacy");
        verify_subscriber_ownership(&legacy, Felt::new(pd.commitment))
            .expect("honest C0 proof must verify on its own legacy path");

        let res = verify_constraints_subscriber_ownership(&parsed, cfg, &[pd.commitment]);
        assert!(
            res.is_err(),
            "the generic C0 constraint path accepted an honest C0 proof — the \
             CircuitZeroIsLegacyOnly gate is then a policy choice, not a \
             necessity, and its doc comment is wrong"
        );
        println!(
            "[C0 GATE] MEASURED: generic C0 constraint path on an HONEST C0 proof -> {:?}",
            res.unwrap_err()
        );
    }
}

/// [ATTACK] Independence of the FRI query positions, measured directly on
/// `derive_positions_from_seed`. Lives in its own file because it is long and
/// because it is the first test this function has ever had; it is a child of
/// this module so it can reach a private fn without widening its visibility.
#[cfg(test)]
#[path = "query_position_independence.rs"]
mod query_position_independence;

/// [B2-AUDIT] The grinding threshold is ENFORCED at both call sites, not merely
/// declared as a constant.
///
/// `GRINDING_BITS = 22` was pinned twice before this module, and neither pin
/// looked at the comparison the verifier actually performs:
///
///   * `compact_proof.rs` holds the verifier's copy of the number;
///   * `b1_deep_binding::prover_and_verifier_agree_on_the_segmentation_constants`
///     asserts the PROVER's SOURCE TEXT contains `const GRINDING_BITS: u32 = 22;`.
///
/// Both are satisfied by a tree in which the verifier compares against something
/// else entirely. MEASURED at `58e5c77a`: replacing
/// `verify_grinding(&state, grinding_nonce, crate::compact_proof::GRINDING_BITS)`
/// with `verify_grinding(&state, grinding_nonce, 16)` at BOTH call sites, leaving
/// the constant and the prover untouched, left the whole package at
/// 173 passed / 1 failed / 1 ignored — byte-identical to the unmutated run, the
/// one failure being the pre-existing `honest_liveness` red. Six bits is a factor
/// of 64 off the prover's proof-of-work, and grinding is the only search a forger
/// gets over the query positions, so it comes straight off the query term behind
/// every soundness figure in `compact_proof.rs`.
///
/// Honest proofs cannot see this: the prover grinds to 22, and 22 clears any
/// threshold at or below 22. The only witness is a nonce whose digest lands
/// strictly between the weakened threshold and the real one, which no honest
/// prover will ever emit — so it has to be constructed, which is what this does.
///
/// Both call sites are covered separately. They are different functions with
/// different signatures, and the legacy one is the sole verifier for four shipped
/// instructions (`zk_shielded::{pause,resume,cancel_private_stark}` and
/// `p01_quantum_wallet`).
#[cfg(test)]
mod grinding_enforcement {
    use super::*;

    /// For every leading-zero count `z` in `0..GRINDING_BITS`, the smallest nonce
    /// whose grinding digest has exactly `z` leading zero bits. One linear scan.
    ///
    /// A miss is a panic, not a skip: a test that silently tries fewer thresholds
    /// than it claims is the failure mode this module exists to prevent.
    fn nonces_by_leading_zeros(state: &[u8; 32]) -> Vec<(u32, u64)> {
        let mut found: Vec<Option<u64>> = vec![None; GRINDING_BITS as usize];
        let mut missing = GRINDING_BITS as usize;
        for n in 0u64..(1u64 << 27) {
            let h = hashv(&[state, &n.to_le_bytes()]).to_bytes();
            let z = leading_zero_bits(&h) as usize;
            if z < found.len() && found[z].is_none() {
                found[z] = Some(n);
                missing -= 1;
                if missing == 0 {
                    break;
                }
            }
        }
        let out: Vec<(u32, u64)> = found
            .iter()
            .enumerate()
            .filter_map(|(z, n)| n.map(|n| (z as u32, n)))
            .collect();
        assert_eq!(
            out.len(),
            GRINDING_BITS as usize,
            "could not find a nonce for every leading-zero count below {GRINDING_BITS} \
             within 2^27 tries — the search, not the verifier, is what failed here",
        );
        out
    }

    /// GENERIC path (`derive_query_positions_generic`, circuits 1..=6).
    #[test]
    fn the_generic_grinding_call_site_enforces_the_whole_constant() {
        let pd = p01_stark::compact::generate_pool_commitment_proof(1, 2, 3, 4, &p01_stark::compact::c1_deterministic_probe_mask());
        let cfg = get_circuit_config(pd.circuit_id).expect("C1 config");
        let proof =
            GenericCompactProof::from_bytes(&pd.proof_bytes, cfg).expect("honest proof parses");

        let pub_bytes = public_inputs_to_bytes(&pd.public_inputs);
        let oc: Vec<u64> = proof.ood_current_iter().map(|f| f.as_u64()).collect();
        let on: Vec<u64> = proof.ood_next_iter().map(|f| f.as_u64()).collect();

        let positions = |nonce: u64| {
            derive_query_positions_generic(
                &proof.trace_root,
                &proof.quotient_root,
                &pub_bytes,
                &oc,
                &on,
                proof.ood_quotient_bytes(),
                proof.fri_layer_roots_bytes(),
                proof.fri_final_poly_bytes(),
                nonce,
                cfg.lde_size,
                cfg.num_queries,
            )
        };

        // Positive control. Without it, "every forged nonce was rejected" could
        // just mean this call rejects everything.
        positions(proof.grinding_nonce)
            .expect("the honest nonce must be accepted — otherwise the negative half is vacuous");

        // Rebuild the exact state the call site grinds against, and check the
        // honest nonce really does clear the shipped constant. If it does not,
        // the reconstruction is wrong and everything below probes nothing.
        let mut state = build_base_seed(
            &proof.trace_root,
            &proof.quotient_root,
            &pub_bytes,
            &oc,
            &on,
            proof.ood_quotient_bytes(),
        );
        for root in proof.fri_layer_roots_bytes().chunks_exact(32) {
            state = extend_transcript(&state, root);
        }
        state = extend_transcript(&state, proof.fri_final_poly_bytes());
        let honest_z =
            leading_zero_bits(&hashv(&[&state, &proof.grinding_nonce.to_le_bytes()]).to_bytes());
        assert!(
            honest_z >= GRINDING_BITS,
            "the reconstructed transcript disagrees with the verifier's: the honest \
             nonce shows {honest_z} leading zero bits, below GRINDING_BITS={GRINDING_BITS}. \
             The rest of this test would be probing the wrong state.",
        );

        for (z, nonce) in nonces_by_leading_zeros(&state) {
            let res = positions(nonce);
            assert!(
                matches!(res, Err(VerifyError::InsufficientQueries)),
                "\n\n  >>> GRINDING UNDER-ENFORCED (generic) <<<\n  a nonce whose digest \
                 has {z} leading zero bits was NOT rejected by \
                 `derive_query_positions_generic`; got {res:?}.\n  GRINDING_BITS is \
                 {GRINDING_BITS}, so every count below it must fail with \
                 InsufficientQueries. The constant being right is not the same as the \
                 call site using it.\n",
            );
        }
    }

    /// LEGACY path (`derive_query_positions_legacy`, circuit 0). Separate
    /// function, separate signature, separate shipped instructions.
    #[test]
    fn the_legacy_grinding_call_site_enforces_the_whole_constant() {
        let pd = p01_stark::compact::generate_compact_proof(42);
        let commitment = Felt::new(pd.commitment);
        let proof = CompactStarkProof::from_bytes(&pd.proof_bytes).expect("honest C0 parses");

        let oc: Vec<u64> = proof.ood_current.iter().map(|f| f.as_u64()).collect();
        let on: Vec<u64> = proof.ood_next.iter().map(|f| f.as_u64()).collect();

        let positions = |nonce: u64| {
            derive_query_positions_legacy(
                &proof.trace_root,
                &proof.quotient_root,
                commitment,
                &oc,
                &on,
                proof.ood_quotient_bytes(),
                proof.fri_layer_roots_bytes(),
                proof.fri_final_poly_bytes(),
                nonce,
            )
        };

        positions(proof.grinding_nonce).expect(
            "the honest C0 nonce must be accepted — otherwise the negative half is vacuous",
        );

        let mut state = build_base_seed(
            &proof.trace_root,
            &proof.quotient_root,
            &commitment.to_le_bytes(),
            &oc,
            &on,
            proof.ood_quotient_bytes(),
        );
        for root in proof.fri_layer_roots_bytes().chunks_exact(32) {
            state = extend_transcript(&state, root);
        }
        state = extend_transcript(&state, proof.fri_final_poly_bytes());
        let honest_z =
            leading_zero_bits(&hashv(&[&state, &proof.grinding_nonce.to_le_bytes()]).to_bytes());
        assert!(
            honest_z >= GRINDING_BITS,
            "the reconstructed legacy transcript disagrees with the verifier's: the \
             honest nonce shows {honest_z} leading zero bits, below \
             GRINDING_BITS={GRINDING_BITS}.",
        );

        for (z, nonce) in nonces_by_leading_zeros(&state) {
            let res = positions(nonce);
            assert!(
                matches!(res, Err(VerifyError::InsufficientQueries)),
                "\n\n  >>> GRINDING UNDER-ENFORCED (legacy C0) <<<\n  a nonce whose \
                 digest has {z} leading zero bits was NOT rejected by \
                 `derive_query_positions_legacy`; got {res:?}.\n  This path is the sole \
                 verifier for pause / resume / cancel_private_stark.\n",
            );
        }
    }
}
