use anchor_lang::prelude::*;

/// Subscription vault: holds funds deposited by a subscriber for periodic
/// claims by a retailer. Supports two modes:
///
/// **Private mode** (the only mode that can still be created): `subscriber_commitment`
/// is set and the PDA is seeded on it instead of on a wallet, so the address does not
/// name the payer. Read the guarantee narrowly: `subscribe_private_stark` takes
/// `subscriber_commitment` as a plain `[u8; 32]` argument, uses it only as a PDA seed,
/// and binds it to NO proof — pass a wallet pubkey there and the program builds exactly
/// the address `subscribe_normal` used to build, membership oracle included. What keeps
/// a wallet out of this field is the client, not the program. Pause/resume/cancel are
/// what require a ZK proof of knowledge of the secret behind the commitment.
///
/// **Normal mode** (LEGACY, read/close only): `subscriber_pubkey` is set and vault
/// actions require a wallet signature. `subscribe_normal` — the only instruction that
/// ever wrote this field — has been removed: seeding the PDA on the subscriber's wallet
/// made the vault address a deterministic membership oracle, so anyone could re-derive
/// it for a (wallet, merchant) pair and learn that the subscription exists. The field
/// itself is KEPT because it is the first field of the account layout; dropping it would
/// shift every byte after it and make the vaults already on chain undecodable.
///
/// PDA: [b"subscription_vault", retailer, subscriber_id_bytes, token_mint]
/// where subscriber_id_bytes = subscriber_commitment (private) or, for legacy vaults,
/// subscriber_pubkey (normal)
#[account]
#[derive(Default)]
pub struct SubscriptionVault {
    /// Subscriber wallet (LEGACY normal-mode vaults only — never written by any
    /// instruction that still exists; kept for layout compatibility).
    pub subscriber_pubkey: Option<Pubkey>,

    /// Subscriber commitment = Poseidon(secret) (private mode only)
    pub subscriber_commitment: Option<[u8; 32]>,

    /// Retailer who receives periodic payments
    pub retailer: Pubkey,

    /// Token mint (system program ID for native SOL)
    pub token_mint: Pubkey,

    /// Total amount deposited into the vault
    pub total_deposited: u64,

    /// Amount paid per period (in lamports / atomic units)
    pub rate: u64,

    /// Number of slots between each claimable period
    pub interval_slots: u64,

    /// Slot at which the subscription started
    pub start_slot: i64,

    /// Number of periods already claimed by the retailer
    pub claimed_periods: u64,

    /// Whether the vault is active (accepting claims)
    pub is_active: bool,

    /// Whether the vault is paused (no claims while paused)
    pub is_paused: bool,

    /// Slot at which the vault was paused (if paused)
    pub pause_slot: Option<i64>,

    /// Total slots spent in paused state (accumulated over pause/resume cycles)
    pub total_paused_slots: i64,

    /// VK hash for subscriber ownership circuit (private mode)
    pub vk_hash_subscriber: [u8; 32],

    /// Source denominated pool (for cancel_private re-shield)
    pub source_pool: Option<Pubkey>,

    /// PDA bump seed
    pub bump: u8,

    /// Stealth meta address (v1) for refund-via-relayer delivery on cancel.
    /// Layout: `[spending_pub(32) | viewing_pub(32)]`.
    /// `None` for legacy V4 vaults — those fall back to the legacy reshield
    /// path in `cancel_private_stark`. Appended at the end so existing
    /// vaults decode as `None` from trailing zero padding.
    pub client_stealth_meta: Option<[u8; 64]>,

    /// License commitment = **blake3**(licenseSecret), posted by the subscriber
    /// at subscribe time so a merchant can later verify a presented license key
    /// by checking blake3(decode(key)) == license_commitment OFF-CHAIN.
    ///
    /// This said Poseidon. Nothing on chain reads the field, so the wrong hash
    /// name cost nothing yet — but it is the only description of the value a
    /// future verifier would be written against, and every shipped client
    /// (apps/mobile, apps/extension, packages/merchant-sdk) uses blake3. The
    /// authoritative block is `LICENSE_SCHEME` in
    /// `packages/merchant-sdk/src/license.ts`, executed by
    /// `packages/merchant-sdk/src/license-parity.test.ts`.
    ///
    /// The chain only stores the 32 raw bytes — no hashing or verification runs
    /// on-chain. `None` for vaults created before this field existed; appended
    /// at the very end so existing vault accounts decode it as `None` from
    /// trailing zero padding (same backward-compat trick as `client_stealth_meta`).
    pub license_commitment: Option<[u8; 32]>,
}

impl SubscriptionVault {
    pub const SEED_PREFIX: &'static [u8] = b"subscription_vault";

    /// Account size: discriminator + all fields
    /// Option<Pubkey> = 1 + 32 = 33
    /// Option<[u8;32]> = 1 + 32 = 33
    /// Option<i64> = 1 + 8 = 9
    /// Option<Pubkey> = 1 + 32 = 33
    pub const LEN: usize = 8   // discriminator
        + 33   // subscriber_pubkey: Option<Pubkey>
        + 33   // subscriber_commitment: Option<[u8;32]>
        + 32   // retailer
        + 32   // token_mint
        + 8    // total_deposited
        + 8    // rate
        + 8    // interval_slots
        + 8    // start_slot (i64)
        + 8    // claimed_periods
        + 1    // is_active
        + 1    // is_paused
        + 9    // pause_slot: Option<i64>
        + 8    // total_paused_slots (i64)
        + 32   // vk_hash_subscriber
        + 33   // source_pool: Option<Pubkey>
        + 1    // bump
        + 65   // client_stealth_meta: Option<[u8; 64]> (1 tag + 64 value)
        + 33;  // license_commitment: Option<[u8; 32]> (1 tag + 32 value)

    /// Returns the subscriber ID bytes used in the PDA seed.
    /// Normal mode: subscriber pubkey bytes
    /// Private mode: subscriber commitment bytes
    pub fn subscriber_id_bytes(&self) -> [u8; 32] {
        if let Some(pubkey) = self.subscriber_pubkey {
            pubkey.to_bytes()
        } else if let Some(commitment) = self.subscriber_commitment {
            commitment
        } else {
            [0u8; 32]
        }
    }

    /// Returns whether this is a normal (wallet-based) vault
    pub fn is_normal_mode(&self) -> bool {
        self.subscriber_pubkey.is_some()
    }

    /// Returns whether this is a private (ZK-based) vault
    pub fn is_private_mode(&self) -> bool {
        self.subscriber_commitment.is_some()
    }

    /// Compute the number of claimable periods based on elapsed time.
    /// Accounts for paused time.
    pub fn claimable_periods(&self, current_slot: i64) -> u64 {
        if !self.is_active || self.is_paused {
            return 0;
        }

        let effective_elapsed = self.effective_elapsed_slots(current_slot);
        if effective_elapsed <= 0 {
            return 0;
        }

        let total_periods = (effective_elapsed as u64) / self.interval_slots;
        let unclaimed = total_periods.saturating_sub(self.claimed_periods);

        // Cap at remaining funded periods so retailer payout never exceeds
        // the residual vault balance (prevents u64 underflow when cancelling
        // a vault whose elapsed window outran its funding).
        let max_funded = if self.rate == 0 {
            0
        } else {
            (self.total_deposited / self.rate).saturating_sub(self.claimed_periods)
        };
        unclaimed.min(max_funded)
    }

    /// Compute effective elapsed slots (subtracting paused time)
    fn effective_elapsed_slots(&self, current_slot: i64) -> i64 {
        let elapsed = current_slot - self.start_slot;
        elapsed - self.total_paused_slots
    }

    /// Returns true when this vault has a stealth meta address registered
    /// for refund-via-relayer routing on cancel.
    pub fn has_stealth_refund(&self) -> bool {
        self.client_stealth_meta.is_some()
    }

    /// Amount available to refund on cancellation
    pub fn refundable_amount(&self, current_slot: i64) -> u64 {
        let claimable = self.claimable_periods(current_slot);
        let total_owed = (self.claimed_periods + claimable) * self.rate;
        self.total_deposited.saturating_sub(total_owed)
    }
}

// ---------------------------------------------------------------------------
// State-machine tests
//
// These pin the CURRENT behaviour of the vault's pure accessors. They are not
// a claim that the behaviour is right — two of them document a hole and say so
// in the test name. Changing program behaviour is an owner's decision; making
// the consequence measurable is not.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    /// 500,000 lamports at 100,000 per period buys 5 periods of 100 slots,
    /// starting at slot 1,000. Same shape as the devnet vault that was claimed
    /// for the first time on 2026-08-01.
    fn vault() -> SubscriptionVault {
        SubscriptionVault {
            subscriber_pubkey: None,
            subscriber_commitment: Some([7u8; 32]),
            retailer: Pubkey::new_from_array([1u8; 32]),
            token_mint: Pubkey::default(),
            total_deposited: 500_000,
            rate: 100_000,
            interval_slots: 100,
            start_slot: 1_000,
            claimed_periods: 0,
            is_active: true,
            is_paused: false,
            pause_slot: None,
            total_paused_slots: 0,
            vk_hash_subscriber: [0u8; 32],
            source_pool: None,
            bump: 255,
            client_stealth_meta: None,
            license_commitment: None,
        }
    }

    #[test]
    fn is_active_is_true_on_every_vault_the_program_can_produce() {
        // `is_active = true` is written at subscribe_normal.rs:120 and
        // subscribe_private_stark.rs:395. No instruction writes `false`; both
        // cancel paths `close` the account instead. So a vault that exists has
        // `is_active == true`, and the flag answers no question.
        let mut v = vault();
        v.claimed_periods = 5; // every funded period collected, balance spent
        assert!(v.is_active);
        assert_eq!(v.claimable_periods(9_999), 0);
    }

    #[test]
    fn claimable_periods_is_clamped_by_funding_not_by_elapsed_time() {
        let v = vault();
        // 40 periods of wall clock have gone by; only 5 were ever funded.
        assert_eq!(v.claimable_periods(5_000), 5);
        // ...and the payout that follows is exactly the deposit.
        assert_eq!(v.claimable_periods(5_000) * v.rate, v.total_deposited);
    }

    #[test]
    fn partial_funding_pays_whole_periods_and_refunds_the_remainder() {
        let mut v = vault();
        v.total_deposited = 350_000; // 3 whole periods + 50,000 of dust
        assert_eq!(v.claimable_periods(1_500), 3);
        assert_eq!(v.refundable_amount(1_500), 50_000);
    }

    #[test]
    fn pausing_cannot_rewind_an_exhausted_subscription() {
        // Pause credit only ever pushes the window later, so a subscriber
        // cannot pause their way back into a term they have already used up.
        let mut v = vault();
        v.total_paused_slots = 200;
        assert_eq!(v.claimable_periods(1_700), 5);
    }

    #[test]
    fn an_exhausted_vault_can_still_be_paused_and_resumed_forever() {
        // pause_normal.rs:26 / resume_normal.rs:24 gate on `vault.is_active`,
        // which is always true, and on nothing else. Neither instruction
        // consults the funding, so both stay callable on a vault that has paid
        // out everything it ever will. Costs a signature and a fee, does
        // nothing. Reported, not changed.
        let mut v = vault();
        v.claimed_periods = 5;
        assert!(v.is_active, "the only thing pause/resume check");
        assert_eq!(v.claimable_periods(9_999), 0, "nothing left to move");
    }

    #[test]
    fn pause_then_cancel_zeroes_the_retailers_earned_but_unclaimed_revenue() {
        // THE HOLE, measured as an arithmetic identity.
        //
        // `claimable_periods` returns 0 while `is_paused`, and BOTH cancel
        // instructions pay the retailer exactly `claimable_periods * rate`
        // (cancel_normal.rs:72, cancel_private_stark.rs:218) while carrying no
        // `!is_paused` constraint — cancel_normal.rs:40 checks `is_active`
        // only. So a subscriber who has consumed five periods of service can
        // pause and then cancel, and the retailer is paid nothing.
        let mut v = vault();

        // Five periods delivered, retailer has not claimed them yet.
        assert_eq!(v.claimable_periods(1_500), 5);
        assert_eq!(v.claimable_periods(1_500) * v.rate, 500_000);
        assert_eq!(v.refundable_amount(1_500), 0);

        // Subscriber pauses.
        v.is_paused = true;
        v.pause_slot = Some(1_500);

        // Retailer's payout on cancel collapses to zero...
        assert_eq!(v.claimable_periods(1_500), 0);
        // ...and the entire deposit goes back to the subscriber.
        assert_eq!(v.refundable_amount(1_500), 500_000);

        // 500,000 lamports of delivered service, paid for at 0. On the 16 live
        // devnet vaults (all at claimed_periods = 0) the exposure is the whole
        // balance of every one of them.
    }

    #[test]
    fn the_rent_floor_is_why_the_drain_is_reachable_rather_than_theoretical() {
        // A retailer whose payout wallet is empty cannot take the first claim
        // at all: the program succeeds and the RUNTIME rejects the transaction
        // for leaving the retailer below rent exemption (MEASURED devnet
        // 2026-08-01, 890,880 lamports). Until enough periods accrue for one
        // claim to clear that floor, the retailer is FORCED to leave revenue
        // unclaimed - which is exactly the state the pause-then-cancel drain
        // preys on.
        const RENT_EXEMPT_ZERO_DATA: u64 = 890_880;
        let v = vault();
        let first_claim = v.claimable_periods(1_500) * v.rate;
        assert!(
            first_claim < RENT_EXEMPT_ZERO_DATA,
            "a full 5-period claim of {first_claim} does not clear the {RENT_EXEMPT_ZERO_DATA}-lamport floor",
        );
    }

    #[test]
    #[should_panic]
    fn interval_slots_zero_panics_which_is_why_subscribe_forbids_it() {
        // subscribe_normal.rs:68 and subscribe_private_stark.rs:182 both
        // require `interval_slots > 0`. If either check were ever dropped, the
        // vault would be permanently unclaimable AND uncancellable, because
        // both handlers call `claimable_periods` first.
        let mut v = vault();
        v.interval_slots = 0;
        let _ = v.claimable_periods(1_500);
    }
}
