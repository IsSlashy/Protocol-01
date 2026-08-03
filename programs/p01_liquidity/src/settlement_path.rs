//! Whether p01_liquidity's prefund/settle cycle can complete at all.
//!
//! # Why this module exists
//!
//! `settle` is the ONLY instruction that returns money to the LP reserve. It
//! does so by CPI-ing `zk_shielded::unshield_denominated_stark` — and that
//! instruction **no longer exists**.
//!
//! It was retired deliberately, not lost. Commit `f5bb7514`
//! ("refactor(zk): remove SNARKs + insecure v2 paths from production flow",
//! 2026-06-05) commented it out of `zk_shielded`'s `#[program]` and out of
//! `instructions/mod.rs`, with the reason recorded in both places:
//!
//! > v2 denominated: unshield_denominated_stark + transfer_denominated_stark
//! > (circuit-1 only, no C3 membership = unshield-undeposited risk).
//!
//! Its replacement is `unshield_denominated_stark_v3`, which additionally
//! requires a C3 (merkle_path) proof binding the commitment to the tree.
//!
//! ## Measured, not assumed
//!
//! Byte-probe of the deployed devnet `zk_shielded`
//! (`GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`, programdata
//! `E78GSWzQMh7g4Zqmug8yaJe5CkH6pDLADZSFKvgP2MQE`, 1_354_072-byte ELF,
//! last deployed slot 469197600), searching for each Anchor instruction
//! discriminator as an SBF `lddw` split immediate — see
//! `scripts/probe-liquidity-exposure.mjs`, which reproduces this read-only:
//!
//! ```text
//!   unshield_denominated_stark     5e5f4f30c3b729a0  ABSENT   <- settle CPIs this
//!   unshield_denominated_stark_v3  77f2115d4b9e4e25  PRESENT
//!   transfer_denominated_stark_v3  c4960b8d5bd03c16  PRESENT  (control)
//!   shield_denominated_v3          cfd7a52db27dccd3  PRESENT  (control)
//!   claim_period                   487ea465bed24252  PRESENT  (control)
//!   subscribe_private_stark        bba5f2d3d1131aa2  PRESENT  (control)
//!   deposit                        f223c68952e1f2b6  absent   (negative control)
//! ```
//!
//! Four positive controls hit and the negative control stayed clean, so the
//! probe discriminates. `settle` therefore fails on chain today, with an
//! opaque `InstructionFallbackNotFound` from a program the caller never named.
//!
//! # Why `prefund` is closed too, and not only `settle`
//!
//! `prefund` pays `amount − prefund_fee − settler_reward` out of the LP
//! reserve immediately, on the promise that `settle` will later pull the
//! note's lamports back in. With `settle` unable to complete, that promise
//! cannot be kept: **every `prefund` call is an unrecoverable outflow.** The
//! note itself is untouched — its nullifier is never consumed — so whoever
//! holds the note secret keeps it *and* keeps the prefunded lamports.
//!
//! Leaving `prefund` open while `settle` is dead is a one-way drain, so both
//! legs fail closed together. Nothing that could previously complete stops
//! working: the cycle has been incompletable since `f5bb7514`.
//!
//! # What must be true before flipping this back on
//!
//! In order. None of these is optional, and none can be waived by editing
//! this constant alone.
//!
//! 1. **`zk_shielded` must expose a prefund-capable unshield.** v3 does not.
//!    `unshield_denominated_stark_v3.rs` says so itself:
//!
//!    > NOTE: For brevity in this scaffold the optional `prefund_record` path
//!    > from v2 is NOT included. The next agent should port it once the C3
//!    > public-inputs hash format is finalized — the prefund record stores the
//!    > hash of the C1 proof's public inputs, and we'd want to extend it to
//!    > store the C3 hash too (or store both proof_buffer pubkeys in the
//!    > record).
//!
//! 2. **`PrefundRecord` must carry the C3 leg.** It has one `proof_buffer`
//!    and one `public_inputs_hash` field; v3 needs two of each. That is an
//!    account-layout change, and there is a live `PrefundRecord` on devnet
//!    (`EAFRWmVSi4mPPDWhgrYBhmoVQHdsPhjX3ZZFxUU6rT4Q`), so it is a migration,
//!    not an edit.
//!
//! 3. **`prefund` must bind `amount` to a real denomination.**
//!    `LiquidityError::AmountMismatch` ("Prefund amount does not match pool
//!    denomination") is declared and enforced NOWHERE. `amount` is
//!    caller-supplied and `denominated_pool` is an unvalidated `AccountInfo`
//!    used only as a PDA seed, so a caller can name any account and any
//!    amount up to the whole reserve.
//!
//! 4. **`prefund` must require the membership proof.** It accepts a C1
//!    (`pool_commitment`) buffer only — which is exactly the
//!    "circuit-1 only, no C3 membership" property that got the v2 unshield
//!    retired in the first place. A C1 proof can be produced for a commitment
//!    that was never deposited.
//!
//! 5. **`settle` must enforce maturity.** `LiquidityError::NotMature` is also
//!    declared and enforced nowhere, while `lib.rs` claims "Once the note
//!    matures (dynamic_delay + min_epoch elapsed), ANY wallet can call
//!    `settle`".
//!
//! Points 3, 4 and 5 are pre-existing holes that were masked by the cycle
//! being dead. They are listed here because re-enabling without them turns a
//! dead feature into a live drain.
//!
//! # Deployed state is NOT fixed by this file
//!
//! `6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg` is live on devnet with
//! `is_active = 1` and a 0.5697 SOL reserve. Source cannot close that; only a
//! redeploy can, and the cheaper mitigation needs no redeploy at all:
//! **the admin (`7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU`) can call
//! `update_params(is_active: Some(false))`**, which the existing
//! `constraint = pool.is_active` on `Prefund` already honours.

use anchor_lang::prelude::*;

use crate::errors::LiquidityError;

/// `false` while `zk_shielded` has no prefund-capable unshield instruction.
///
/// Flipping this to `true` is necessary but far from sufficient — see the
/// five-point checklist in this module's documentation. `settlement_tests`
/// fails if this is flipped without the CPI target being restored.
pub const SETTLEMENT_PATH_AVAILABLE: bool = false;

/// The instruction `settle` CPIs, and the discriminator it sends.
///
/// Kept as data (rather than only as a comment) so the tests can check the
/// name and the bytes against `zk_shielded` itself.
pub const RETIRED_CPI_IX_NAME: &str = "unshield_denominated_stark";

/// `sha256("global:unshield_denominated_stark")[..8]`.
pub const RETIRED_CPI_DISCRIMINATOR: [u8; 8] =
    [0x5e, 0x5f, 0x4f, 0x30, 0xc3, 0xb7, 0x29, 0xa0];

/// The instruction that replaced it.
pub const REPLACEMENT_CPI_IX_NAME: &str = "unshield_denominated_stark_v3";

/// Fail closed unless the prefund/settle cycle can actually complete.
///
/// Called first by both `prefund` and `settle`, so the failure names the real
/// problem instead of surfacing as an opaque CPI error from a program the
/// caller did not invoke.
pub fn require_settlement_path_available() -> Result<()> {
    if !SETTLEMENT_PATH_AVAILABLE {
        msg!(
            "p01_liquidity: prefund/settle is closed. settle CPIs zk_shielded::{}, \
             which was retired in f5bb7514 (circuit-1 only, no C3 membership) and \
             replaced by {}. The v3 replacement does not carry the prefund path, so \
             a prefund could never be settled and would be an unrecoverable outflow \
             from the LP reserve. See p01_liquidity/src/settlement_path.rs.",
            RETIRED_CPI_IX_NAME,
            REPLACEMENT_CPI_IX_NAME,
        );
        return Err(LiquidityError::SettlementPathRetired.into());
    }
    Ok(())
}

#[cfg(test)]
mod settlement_tests {
    use super::*;
    use anchor_lang::Discriminator;

    /// `sha256("global:<name>")[..8]` — Anchor's instruction-discriminator rule.
    fn anchor_ix_discriminator(name: &str) -> [u8; 8] {
        let full = solana_sha256_hasher::hashv(&[format!("global:{name}").as_bytes()]).to_bytes();
        full[..8].try_into().unwrap()
    }

    /// The discriminator `settle` sends is the one Anchor would derive for
    /// `unshield_denominated_stark`.
    ///
    /// On its own this is a constant checked against a restatement of itself,
    /// which proves very little — it is here only so that the *next* test's
    /// inequality has a meaning. The load-bearing checks are below.
    #[test]
    fn retired_discriminator_is_the_anchor_derivation() {
        assert_eq!(
            anchor_ix_discriminator(RETIRED_CPI_IX_NAME),
            RETIRED_CPI_DISCRIMINATOR
        );
    }

    /// The replacement instruction really is registered in `zk_shielded`.
    ///
    /// This is a COMPILE-TIME assertion as much as a runtime one: Anchor only
    /// generates `zk_shielded::instruction::UnshieldDenominatedStarkV3` for
    /// instructions listed in `#[program]`. If v3 is ever retired the way v2
    /// was, this test stops compiling — which is the outcome we want, because
    /// the restore recipe in this module would then be pointing at nothing.
    #[test]
    fn replacement_instruction_is_registered_in_zk_shielded() {
        let replacement = zk_shielded::instruction::UnshieldDenominatedStarkV3::DISCRIMINATOR;
        assert_eq!(
            replacement,
            anchor_ix_discriminator(REPLACEMENT_CPI_IX_NAME),
            "REPLACEMENT_CPI_IX_NAME does not name the instruction it claims to"
        );
        assert_ne!(
            replacement, RETIRED_CPI_DISCRIMINATOR,
            "the replacement cannot be the instruction that was retired"
        );
    }

    /// The instruction `settle` CPIs is NOT registered in `zk_shielded`.
    ///
    /// Absence cannot be asserted by naming the type — naming it would fail to
    /// compile, which is exactly the signal, but a non-compiling test is not a
    /// test. So instead this walks every `zk_shielded` instruction whose
    /// discriminator we can obtain and requires none of them to be the retired
    /// one. If somebody re-registers `unshield_denominated_stark`, add it to
    /// this list and this test turns red, telling you `settle` can be revived.
    #[test]
    fn retired_instruction_is_not_registered_in_zk_shielded() {
        use zk_shielded::instruction as ix;
        let registered: &[(&str, &[u8])] = &[
            ("unshield_denominated_stark_v3", ix::UnshieldDenominatedStarkV3::DISCRIMINATOR),
            ("transfer_denominated_stark_v3", ix::TransferDenominatedStarkV3::DISCRIMINATOR),
            ("shield_denominated_v3", ix::ShieldDenominatedV3::DISCRIMINATOR),
            ("init_denominated_pool_v3", ix::InitDenominatedPoolV3::DISCRIMINATOR),
            ("split_note_stark", ix::SplitNoteStark::DISCRIMINATOR),
            ("claim_period", ix::ClaimPeriod::DISCRIMINATOR),
            ("subscribe_private_stark", ix::SubscribePrivateStark::DISCRIMINATOR),
        ];
        for (name, d) in registered {
            assert_ne!(
                *d,
                &RETIRED_CPI_DISCRIMINATOR[..],
                "zk_shielded::{name} collides with the retired discriminator"
            );
            // Each entry really is the instruction it is labelled as, so the
            // list cannot be padded with lookalikes to make the loop vacuous.
            assert_eq!(
                *d,
                &anchor_ix_discriminator(name)[..],
                "the list entry labelled {name} is not that instruction"
            );
        }
        // Read the flag through the guard rather than directly: asserting on a
        // `const` is both a clippy error (`assertions_on_constants`) and a
        // weaker statement, since what matters is that the handlers refuse,
        // not that a constant holds a particular value.
        assert!(
            require_settlement_path_available().is_err(),
            "SETTLEMENT_PATH_AVAILABLE was flipped to true, but zk_shielded still \
             exposes no prefund-capable unshield instruction. Work the five-point \
             checklist in settlement_path.rs before re-opening prefund/settle."
        );
    }

    /// Both legs are actually closed — a rejection test, not a liveness test.
    #[test]
    fn both_legs_fail_closed() {
        let e = require_settlement_path_available().expect_err(
            "prefund/settle must fail closed while the CPI target is retired",
        );
        assert_eq!(
            e.to_string(),
            anchor_lang::error::Error::from(LiquidityError::SettlementPathRetired).to_string(),
            "the failure must name the settlement path, not some generic error"
        );
    }
}
