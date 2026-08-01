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

    /// Number of WHOLE periods the deposit funds.
    ///
    /// `total_deposited % rate` is a sub-period remainder that never buys a
    /// period. It is not a refund and never was reachable as one: it is swept
    /// to the retailer by the final `claim_period`, together with the rent.
    pub fn funded_periods(&self) -> u64 {
        if self.rate == 0 {
            0
        } else {
            self.total_deposited / self.rate
        }
    }

    /// Value the retailer has not been paid yet — the unclaimed periods plus
    /// the sub-period remainder. This is what the final `claim_period` moves.
    ///
    /// Only meaningful on a LIVE vault. `claimed_periods` counts whole periods
    /// and cannot express the remainder, so after the final claim has swept it
    /// this still reports the remainder as unpaid. That is harmless because the
    /// account is closed at that moment and never read again — but do not use
    /// this accessor as a settled-up check. `is_exhausted()` is that check.
    pub fn unpaid_amount(&self) -> u64 {
        self.total_deposited
            .saturating_sub(self.claimed_periods.saturating_mul(self.rate))
    }

    /// True once every funded period has been claimed, i.e. the vault has
    /// nothing left to deliver and must close.
    ///
    /// Note this is also true from slot zero for a vault funded with LESS than
    /// one period's `rate` (`funded_periods() == 0`). `claimable_periods` can
    /// never return a non-zero value for such a vault, so without this flag
    /// `claim_period` would refuse it forever and its deposit and rent would be
    /// stranded — which is exactly what happened to the cancel instructions'
    /// job when they were removed.
    pub fn is_exhausted(&self) -> bool {
        self.claimed_periods >= self.funded_periods()
    }

    /// The whole money decision of `claim_period`, as a pure function.
    ///
    /// `claim_period::handler` calls exactly this and then does nothing but
    /// account plumbing, so the tests at the bottom of this file cover the
    /// arithmetic the instruction actually runs rather than a copy of it.
    ///
    /// `None` means there is nothing to settle and the instruction must reject.
    /// `Some(s)` with `s.is_final` means the vault has delivered everything it
    /// ever will: `s.payout` is its ENTIRE residual, dust included, and the
    /// account must close to the retailer.
    ///
    /// Callers must still refuse a paused vault — `claim_period` does so at the
    /// account-constraint level, before this is ever reached.
    pub fn settle(&self, current_slot: i64) -> Option<VaultSettlement> {
        let periods = self.claimable_periods(current_slot);

        // Nothing accruing and funding still outstanding: a normal no-op claim.
        if periods == 0 && !self.is_exhausted() {
            return None;
        }

        let claimed_periods_after = self.claimed_periods.saturating_add(periods);
        let is_final = claimed_periods_after >= self.funded_periods();

        // `claimable_periods` is already clamped to the funded periods, so
        // `periods * rate` cannot exceed `unpaid_amount()` and the saturating
        // multiply never saturates. It is written saturating so that a future
        // change to the clamp degrades into an under-payment rather than a wrap.
        let payout = if is_final {
            self.unpaid_amount()
        } else {
            periods.saturating_mul(self.rate)
        };

        Some(VaultSettlement {
            periods,
            payout,
            claimed_periods_after,
            is_final,
        })
    }
}

/// Result of one `claim_period` settlement. Not an account — pure arithmetic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaultSettlement {
    /// Periods credited by this claim.
    pub periods: u64,
    /// Value moved to the retailer by this claim. Equals `periods * rate`
    /// except on the final claim, where it is the vault's entire residual.
    pub payout: u64,
    /// `claimed_periods` after this claim.
    pub claimed_periods_after: u64,
    /// True when this claim exhausts the vault, which must then close.
    pub is_final: bool,
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

    // -----------------------------------------------------------------------
    // Settlement invariant
    //
    // These drive `SubscriptionVault::settle`, which is the function
    // `claim_period::handler` calls — not a copy of its arithmetic. What they
    // do NOT cover is the account plumbing around it: that the lamports really
    // move, that the account really closes, that the rent really lands on the
    // retailer. There is no program-test harness in this crate, so the wiring
    // is asserted by reading `claim_period.rs`, not by execution.
    // -----------------------------------------------------------------------

    /// Settle repeatedly at the given slots exactly as `claim_period` does,
    /// stopping at the claim that closes the vault.
    /// Returns (total paid to the retailer, number of accepted claims, closed).
    fn run(v: &mut SubscriptionVault, slots: &[i64]) -> (u64, u32, bool) {
        let mut paid = 0u64;
        let mut claims = 0u32;
        for &slot in slots {
            let Some(s) = v.settle(slot) else { continue };
            paid += s.payout;
            v.claimed_periods = s.claimed_periods_after;
            claims += 1;
            if s.is_final {
                return (paid, claims, true);
            }
        }
        (paid, claims, false)
    }

    #[test]
    fn the_retailer_receives_exactly_total_deposited_over_the_life_of_the_vault() {
        let mut v = vault();
        let (paid, claims, closed) = run(&mut v, &[1_200, 1_400, 5_000]);
        assert_eq!(paid, 500_000, "paid out is the whole deposit, no more, no less");
        assert_eq!(claims, 3);
        assert!(closed, "the last claim closes the vault");
        assert!(v.is_exhausted(), "and it is settled up");
    }

    #[test]
    fn a_single_late_claim_settles_the_whole_deposit_in_one_shot() {
        let v = vault();
        let s = v.settle(5_000).expect("a matured vault always settles");
        assert_eq!(s.periods, 5);
        assert_eq!(s.payout, 500_000);
        assert!(s.is_final);
    }

    #[test]
    fn the_sub_period_remainder_goes_to_the_retailer_instead_of_being_refunded() {
        // 350,000 at 100,000 funds 3 whole periods and leaves 50,000 that never
        // buys one. `refundable_amount` used to hand that 50,000 back to the
        // subscriber on cancel. There is no cancel and no refund: the final
        // claim pays it to the retailer with the rest.
        let mut v = vault();
        v.total_deposited = 350_000;
        assert_eq!(v.funded_periods(), 3);

        let s = v.settle(5_000).expect("settles");
        assert_eq!(s.periods, 3);
        assert_eq!(s.payout, 350_000, "3 periods + the 50,000 remainder");
        assert!(s.is_final);
    }

    #[test]
    fn pause_moves_when_the_retailer_is_paid_never_how_much() {
        // Same vault, one of them paused for 300 slots and resumed (which is
        // what `resume` writes into total_paused_slots).
        let mut straight = vault();
        let mut paused = vault();
        paused.total_paused_slots = 300;

        // Timing differs: at slot 1,500 the paused vault has delivered fewer
        // periods, because 300 of those slots did not count.
        assert_eq!(straight.claimable_periods(1_500), 5);
        assert_eq!(paused.claimable_periods(1_500), 2);

        // The total does not.
        let (straight_paid, _, straight_closed) = run(&mut straight, &[1_500, 9_999]);
        let (paused_paid, _, paused_closed) = run(&mut paused, &[1_500, 9_999]);
        assert_eq!(straight_paid, 500_000);
        assert_eq!(paused_paid, 500_000);
        assert!(straight_closed && paused_closed);
    }

    #[test]
    fn claimable_stays_zero_while_paused_because_paused_slots_are_only_credited_on_resume() {
        // This is why the `|| self.is_paused` short-circuit in
        // `claimable_periods` is KEPT even though `claim_period` already
        // refuses a paused vault at the account-constraint level. Nothing
        // decrements the accrual during a pause — `total_paused_slots` is
        // written by `resume`, at the END of the pause. Drop the short-circuit
        // and the raw arithmetic keeps ticking through the pause, over-crediting
        // the retailer for time the subscriber did not receive.
        let mut v = vault();
        v.is_paused = true;
        v.pause_slot = Some(1_500);

        // What the guard returns.
        assert_eq!(v.claimable_periods(1_500), 0);
        assert_eq!(v.claimable_periods(1_900), 0);

        // What the arithmetic underneath it would return, still growing.
        let raw = |slot: i64| ((slot - v.start_slot - v.total_paused_slots) as u64) / v.interval_slots;
        assert_eq!(raw(1_500), 5);
        assert_eq!(raw(1_900), 9, "four periods of pause would have been billed");
    }

    #[test]
    fn a_vault_funded_below_one_period_can_still_be_closed_to_the_retailer() {
        // `subscribe_private_stark` sets total_deposited = pool.denomination and
        // takes `rate` from the caller with no `rate <= amount` check, so a
        // deposit smaller than one period's rate is reachable. Such a vault has
        // 0 funded periods, `claimable_periods` is 0 at every slot forever, and
        // cancellation used to be its only exit. It must settle and close.
        let mut v = vault();
        v.total_deposited = 50_000; // less than one 100,000 period
        assert_eq!(v.funded_periods(), 0);
        assert_eq!(v.claimable_periods(9_999_999), 0);
        assert!(v.is_exhausted());

        let s = v.settle(1_000).expect("must settle at any slot, or 50,000 is stranded");
        assert_eq!(s.periods, 0);
        assert_eq!(s.payout, 50_000);
        assert!(s.is_final);
    }

    #[test]
    fn a_vault_already_claimed_to_the_end_still_settles_so_its_rent_is_released() {
        // The shape of a devnet vault claimed to exhaustion before
        // `claim_period` learned how to close. Payout is 0 and the claim must
        // still be accepted, otherwise its rent is stranded permanently.
        let mut v = vault();
        v.claimed_periods = 5;
        let s = v.settle(9_999).expect("must settle");
        assert_eq!(s.periods, 0);
        assert_eq!(s.payout, 0);
        assert!(s.is_final, "closes and releases the rent to the retailer");
    }

    #[test]
    fn a_claim_with_nothing_accrued_and_funding_left_is_still_refused() {
        // 50 slots into a 100-slot period. `settle` returns None and
        // `claim_period` turns that into NoClaimablePeriods.
        let v = vault();
        assert!(v.settle(1_050).is_none());
        assert!(!v.is_exhausted());
    }

    #[test]
    fn no_shape_of_vault_ever_leaves_a_lamport_behind_for_the_subscriber() {
        // deposit, rate, interval — including a deposit below one period and a
        // deposit that does not divide by the rate.
        let shapes: [(u64, u64, u64); 5] = [
            (500_000, 100_000, 100),
            (350_000, 100_000, 100),
            (50_000, 100_000, 100),
            (1, 7, 3),
            (1_000_000, 1, 10),
        ];

        for (deposit, rate, interval) in shapes {
            let mut v = vault();
            v.total_deposited = deposit;
            v.rate = rate;
            v.interval_slots = interval;

            let (paid, _, closed) = run(&mut v, &[1_100, 1_500, 2_000, 1_000_000_000]);
            assert!(closed, "{deposit}/{rate}/{interval} never closed");
            assert_eq!(
                paid, deposit,
                "{deposit}/{rate}/{interval} paid the retailer {paid}, not the deposit",
            );
            assert!(
                v.is_exhausted(),
                "{deposit}/{rate}/{interval} closed without being settled up",
            );
        }
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
