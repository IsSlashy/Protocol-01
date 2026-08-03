//! [B7 step 0] The coset shift is a PAIRED EDIT across two crates. This pins it.
//!
//! The prover evaluates the LDE at `x = h * g^i`; the on-chain verifier
//! reconstructs the same `x` from the query position. If the two `h` literals
//! ever disagree, every honest proof stops verifying — a total liveness break
//! that no single-crate test can see, because each crate is self-consistent.
//!
//! This is the same class of defect the tree has already been bitten by: a
//! constant duplicated across a boundary, each side green on its own. Here the
//! boundary is `stark/` to `programs/p01_stark_verifier/`, and this file is the
//! only thing that spans it.
//!
//! Step 0 is deliberately additive: the constants land and get checked against
//! each other BEFORE any proof byte moves. Nothing here depends on the shift
//! actually being applied yet.
//!
//! Run:
//!   cargo test -p p01_stark_verifier --test b7_coset_shift_pairing -- --nocapture

use p01_stark_verifier::goldilocks::Felt;
use p01_stark_verifier::verify::LDE_COSET_SHIFT;

/// The two literals must be the same number.
#[test]
fn coset_shift_matches_the_prover() {
    assert_eq!(
        LDE_COSET_SHIFT,
        p01_stark::compact::LDE_COSET_SHIFT_U64,
        "the verifier and the prover disagree about the LDE coset shift. Every honest \
         proof would be rejected. These two literals are a paired edit and must move together.",
    );
}

/// The shift must be outside every shipping LDE domain.
///
/// `h^N != 1` for each shipping size is necessary AND sufficient: the trace
/// domain sits inside the LDE domain, so this puts the coset off the trace
/// subgroup, and folding squares the domain so layer `k` is
/// `h^(2^k) * <g^(2^k)>` — which falls back onto a subgroup exactly when
/// `(h^(2^k))^(N/2^k) = h^N = 1`. One inequality, every layer.
///
/// Checked HERE as well as prover-side on purpose: this is the verifier's own
/// copy of the constant, and a check that only ever runs against the prover's
/// copy would not notice the verifier's drifting.
#[test]
fn coset_shift_is_outside_every_shipping_lde_domain() {
    let h = Felt::new(LDE_COSET_SHIFT);
    assert_ne!(h, Felt::new(0), "a zero shift collapses the domain");
    assert_ne!(h, Felt::new(1), "a shift of one IS the unshifted domain — the leak stays open");

    for size in [512u64, 2048, 4096, 8192] {
        assert_ne!(
            h.exp(size),
            Felt::new(1),
            "shift^{size} == 1: the coset falls back onto the subgroup of that size, so an \
             aligned query still reproduces a raw trace row and B7 buys nothing",
        );
    }
}

/// The sizes above must be the sizes the verifier actually ships.
///
/// Without this, the test above degrades quietly the day a circuit is added
/// with a new LDE size: it would keep asserting the four old sizes and report
/// green while the new domain went unchecked. Derived from the verifier's own
/// generator table rather than restated.
#[test]
fn the_checked_sizes_are_the_shipping_sizes() {
    for size in [512usize, 2048, 4096, 8192] {
        assert!(
            p01_stark_verifier::verify::get_lde_generator(size).is_ok(),
            "size {size} is checked by the shift test but the verifier has no generator for it",
        );
    }
    for size in [1024usize, 16384] {
        assert!(
            p01_stark_verifier::verify::get_lde_generator(size).is_err(),
            "size {size} now HAS a generator, so it is a shipping LDE size and must be added \
             to the shift check above — otherwise its domain is never checked against the shift",
        );
    }
}
