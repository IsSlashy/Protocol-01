use anchor_lang::prelude::*;

/// Subscription vault: holds funds deposited by a subscriber for periodic
/// claims by a retailer. Supports two modes:
///
/// A subscription is a ONE-WAY PREPAID ENVELOPE. Every lamport that enters a vault
/// leaves it toward the retailer and nothing returns to the subscriber. The
/// subscriber's controls are pause and resume; cancellation and refunds were removed.
/// The vault ends when `claim_period` spends its last funded period, which pays the
/// retailer the residual and closes the account. That is the ONLY way a vault can
/// close. The RENT released by that close is not part of the envelope and stopped
/// following it on 2026-08-20: it was charged to `subscribe_private_stark`'s
/// ephemeral payer, out of whoever funded the note, and now goes to the source
/// pool's `fee_escrow` PDA. See `claim_period`'s `rent_beneficiary`.
///
/// **Private mode** (the only mode that can still be created): `subscriber_commitment`
/// is set and the PDA is seeded on it instead of on a wallet, so the address does not
/// name the payer. Read the guarantee narrowly: `subscribe_private_stark` takes
/// `subscriber_commitment` as a plain `[u8; 32]` argument, uses it only as a PDA seed,
/// and binds it to NO proof — pass a wallet pubkey there and the program builds exactly
/// the address `subscribe_normal` used to build, membership oracle included. What keeps
/// a wallet out of this field is the client, not the program. Pause and resume are
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

    /// DEPRECATED AND UNUSED. Source denominated pool, read only by
    /// `cancel_private_stark` to know where to re-shield the refund. There is
    /// no cancellation and no refund, so nothing on chain reads this field.
    ///
    /// The bytes are KEPT. Sixteen vaults are live on devnet and removing 33
    /// bytes from the middle of the layout shifts every field after it and
    /// makes all of them undecodable. Reclaiming the space is a migration, not
    /// a cleanup. `subscribe_private_stark` still writes it; stopping that
    /// write is a separate, client-visible change.
    pub source_pool: Option<Pubkey>,

    /// PDA bump seed
    pub bump: u8,

    /// DEPRECATED AND UNUSED. Stealth meta address (v1),
    /// `[spending_pub(32) | viewing_pub(32)]`, which routed the cancellation
    /// refund to the subscriber through `p01_relayer::submit_refund_job`. The
    /// refund leg was the system's only INBOUND operation and the only place a
    /// subscriber had to receive money; deleting it is most of the point of
    /// removing cancellation, so this field has no reader left.
    ///
    /// The bytes are KEPT for the same layout reason as `source_pool`.
    /// `subscribe_private_stark` still accepts the argument and still writes
    /// it, which now publishes a subscriber-controlled stealth address on chain
    /// for a feature that cannot fire. Clients should pass `None`; removing the
    /// write and the parameter is a follow-up that has to move with the
    /// clients.
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
    ///
    /// The `|| self.is_paused` short-circuit is KEPT even though `claim_period`
    /// — now the only caller — already refuses a paused vault at the account
    /// constraint level, and even though it was the arithmetic that made the
    /// pause-then-cancel drain possible. It is load-bearing for a different
    /// reason: nothing decrements the accrual DURING a pause. `resume` credits
    /// `total_paused_slots` at the END of the pause, so between pause and
    /// resume `effective_elapsed_slots` keeps growing with the wall clock.
    /// Drop this line and the retailer is over-credited for exactly the time
    /// the subscriber was not receiving service.
    ///
    /// What made the drain possible was not this returning 0, it was the cancel
    /// instructions treating "0 claimable right now" as "0 owed, ever" and
    /// refunding the difference. Those instructions are gone.
    /// `claimable_stays_zero_while_paused_because_paused_slots_are_only_credited_on_resume`
    /// below pins both halves.
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

        // Cap at remaining funded periods so the retailer payout never exceeds
        // the residual vault balance on a vault whose elapsed window outran its
        // funding — which is every vault, eventually.
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

    // REMOVED with cancellation: `has_stealth_refund` and `refundable_amount`.
    // Nothing is refundable. What `refundable_amount` used to hand back to the
    // subscriber is now `unpaid_amount()` minus the claimed periods — the
    // sub-period remainder — and the final `claim_period` pays it to the
    // retailer.

    /// Number of WHOLE periods the deposit funds.
    ///
    /// `total_deposited % rate` is a sub-period remainder that never buys a
    /// period. It is not a refund and never was reachable as one: it is swept
    /// to the retailer by the final `claim_period`. The rent used to be swept
    /// with it and no longer is — the dust is the subscriber's deposit, the
    /// rent was the funder's, and only the first of the two is the merchant's.
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
// These pin the CURRENT behaviour of the vault's pure accessors and of
// `settle`, which is the function `claim_period::handler` calls to decide what
// to pay. They are not a claim that the behaviour is right — two of them still
// document a hole and say so in the test name.
//
// What they do NOT cover: the account plumbing. That the lamports move, that
// the account closes, that the rent lands where it is supposed to, that a
// paused vault is rejected — none of that is arithmetic. It was "asserted by
// reading `claim_period.rs`" when this comment was written; since the litesvm
// harness landed it is EXECUTED, by `programs/zk_shielded/tests/
// subscription_lifecycle.rs` against the real `target/deploy/zk_shielded.so`.
// Run that file after touching anything below.
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
        // `is_active = true` is written by subscribe_private_stark. No
        // instruction writes `false`; the one path that ends a vault
        // (`claim_period`'s final claim) closes the account instead. So a vault
        // that exists has `is_active == true`, and the flag answers no question.
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
    fn partial_funding_pays_whole_periods_and_carries_the_remainder() {
        // Was `partial_funding_pays_whole_periods_and_refunds_the_remainder`,
        // asserting `refundable_amount(1_500) == 50_000`. That accessor and the
        // refund it named are deleted. The 50,000 is still there, it is just no
        // longer the subscriber's — see
        // `the_sub_period_remainder_goes_to_the_retailer_instead_of_being_refunded`.
        let mut v = vault();
        v.total_deposited = 350_000; // 3 whole periods + 50,000 of dust
        assert_eq!(v.claimable_periods(1_500), 3);
        assert_eq!(v.funded_periods(), 3);
        assert_eq!(v.unpaid_amount(), 350_000);
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
    fn pausing_an_exhausted_vault_no_longer_blocks_the_claim_that_closes_it() {
        // Was `pausing_an_exhausted_vault_blocks_the_claim_that_would_close_it`,
        // which recorded the deadlock the removal of cancellation created:
        // `claim_period` became the only exit, its `!is_paused` account
        // constraint refused a paused vault, and a subscriber who paused and
        // never resumed held the account open forever — withholding the
        // retailer's last payout and the rent from everyone, themselves
        // included. Cancellation had no such constraint, so this hole did not
        // exist before the deletion.
        //
        // The constraint is now `!vault.is_paused || vault.is_exhausted()`.
        // This test pins the arithmetic half of why that is safe: an exhausted
        // vault has no period left to deliver, so the escape hatch cannot pay
        // for time the subscriber did not receive.
        let mut v = vault();
        v.claimed_periods = 5;
        assert!(v.is_exhausted());
        assert!(
            v.settle(9_999).is_some_and(|s| s.is_final),
            "a live exhausted vault settles and closes",
        );

        v.is_paused = true;
        v.pause_slot = Some(9_999);
        assert!(v.is_active, "still the only thing pause/resume check");
        assert!(
            v.is_exhausted(),
            "pausing does not un-exhaust a vault, so the account constraint \
             lets this one through",
        );
        let s = v.settle(9_999).expect("a paused exhausted vault still settles");
        assert!(s.is_final, "and the settlement closes it");
        assert_eq!(
            s.periods, 0,
            "no period is credited while paused — claimable_periods returns 0 \
             the moment is_paused is set, so the escape hatch cannot pay the \
             retailer for time the subscriber was not being served",
        );
        assert_eq!(
            s.payout, 0,
            "and there is nothing left to sweep: all five funded periods were \
             already claimed, so only the rent is released",
        );
    }

    #[test]
    fn a_paused_vault_with_funding_left_still_settles_nothing_and_stays_open() {
        // The other side of the escape hatch, and the reason it is written
        // `!is_paused || is_exhausted()` rather than dropped outright. A paused
        // vault that still owes periods is NOT exhausted, so the account
        // constraint refuses it and it cannot be closed out from under its
        // subscriber. If that constraint were ever widened to let any paused
        // vault through, `settle` would report `is_final == false` for this one
        // and `claim_period`'s `value_payout > 0 || is_final` require would
        // reject it — but on a vault that HAS accrued, a widened constraint
        // would pay the retailer for paused time. Both halves matter.
        let mut v = vault();
        v.claimed_periods = 2; // 3 funded periods still owed
        v.is_paused = true;
        v.pause_slot = Some(1_500);
        assert!(!v.is_exhausted(), "still owes three periods");
        assert_eq!(v.claimable_periods(9_999), 0, "paused accrues nothing");
        assert!(
            v.settle(9_999).is_none(),
            "nothing accrued and funding outstanding — a no-op claim, refused",
        );
    }

    #[test]
    fn pause_no_longer_zeroes_the_retailers_earned_revenue_because_cancel_is_gone() {
        // Replaces `pause_then_cancel_zeroes_the_retailers_earned_but_unclaimed_revenue`.
        //
        // THE OLD HOLE: `claimable_periods` returns 0 while `is_paused`, and
        // both cancel instructions paid the retailer exactly
        // `claimable_periods * rate` and refunded the rest, with no `!is_paused`
        // constraint. A subscriber who had consumed five periods could pause,
        // then cancel, and take the whole 500,000 back.
        //
        // The subject of that test — cancellation — is deleted, so this pins
        // the replacement: pausing still zeroes what is claimable RIGHT NOW,
        // and there is no longer any instruction that reads that zero as
        // "nothing is owed" and moves the difference anywhere.
        let mut v = vault();

        // Five periods delivered, retailer has not claimed them yet.
        assert_eq!(v.claimable_periods(1_500), 5);
        assert_eq!(v.unpaid_amount(), 500_000);

        // Subscriber pauses.
        v.is_paused = true;
        v.pause_slot = Some(1_500);

        // What is claimable right now collapses to zero, exactly as before...
        assert_eq!(v.claimable_periods(1_500), 0);
        // ...but the debt does not move, and no exit exists to move it.
        assert_eq!(v.unpaid_amount(), 500_000);

        // Resume credits the paused slots and the five periods are still there.
        v.is_paused = false;
        v.pause_slot = None;
        v.total_paused_slots = 400; // paused 1,500 -> 1,900
        let s = v.settle(1_900).expect("settles after resume");
        assert_eq!(s.periods, 5);
        assert_eq!(s.payout, 500_000);
        assert!(s.is_final);
    }

    #[test]
    fn the_closing_claim_always_clears_the_retailers_rent_exempt_floor() {
        // Replaces `the_rent_floor_is_why_the_drain_is_reachable_rather_than_theoretical`.
        //
        // A retailer whose payout wallet is empty cannot receive a small claim:
        // the program succeeds and the RUNTIME rejects the transaction for
        // leaving the retailer below rent exemption (MEASURED devnet
        // 2026-08-01, 890,880 lamports for a zero-data account). That still
        // blocks an intermediate claim.
        //
        // It can no longer block the LAST one, and the reason changed on
        // 2026-08-20 without the outcome changing. It used to be an accident:
        // the closing claim moved the vault's whole rent to the retailer along
        // with the payout, and a rent-exempt SubscriptionVault is worth several
        // times the floor. The rent now goes to the funder's escrow instead, so
        // `claim_period` tops the retailer up to its floor OUT of that rent
        // first and routes only the remainder. The arithmetic below is what
        // makes that top-up always affordable, which is why it is still the
        // thing this test pins.
        const RENT_EXEMPT_ZERO_DATA: u64 = 890_880;
        const LAMPORTS_PER_BYTE_YEAR: u64 = 3_480;
        const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;
        const EXEMPTION_YEARS: u64 = 2;
        let vault_rent = (ACCOUNT_STORAGE_OVERHEAD + SubscriptionVault::LEN as u64)
            * LAMPORTS_PER_BYTE_YEAR
            * EXEMPTION_YEARS;

        let v = vault();
        let first_claim = v.claimable_periods(1_500) * v.rate;
        assert!(
            first_claim < RENT_EXEMPT_ZERO_DATA,
            "an intermediate 5-period claim of {first_claim} still does not clear the \
             {RENT_EXEMPT_ZERO_DATA}-lamport floor on its own",
        );
        assert!(
            vault_rent > RENT_EXEMPT_ZERO_DATA,
            "the vault rent of {vault_rent} that rides along with the closing claim does",
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
        assert!(s.is_final, "closes and releases the rent to the funder's escrow");
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
        // `subscribe_private_stark` requires `interval_slots > 0`. If that
        // check were ever dropped, the vault would be permanently unclaimable
        // AND uncloseable — `claim_period` is the only exit left and it calls
        // `claimable_periods` through `settle` before it does anything else, so
        // the deposit and the rent would be stranded with no second path out.
        let mut v = vault();
        v.interval_slots = 0;
        let _ = v.claimable_periods(1_500);
    }
}
