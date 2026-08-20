use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::derive_fee_escrow;
use crate::state::SubscriptionVault;

/// Claim one or more accrued periods from a subscription vault, and close the
/// vault once its funding is spent.
///
/// PERMISSIONLESS. Anybody can send this instruction; the money still has
/// exactly one destination. `retailer` is checked against `vault.retailer`, an
/// immutable field written at subscribe time, and the vault PDA is the only
/// authority that can move the funds — so the CALLER never chooses where the
/// value lands, the account does. What the caller chooses is only WHEN, and
/// they pay the fee for the privilege. It used to be a `Signer`, which meant a
/// merchant that lost its key lost the revenue: devnet has 13 such vaults
/// holding ~5.52 SOL whose retailer keys were generated in a browser during
/// testing and no longer exist anywhere. Works for both normal and private
/// vaults.
///
/// Claimable periods = floor(effective_elapsed / interval_slots) - claimed_periods
/// where effective_elapsed = current_slot - start_slot - total_paused_slots
///
/// This is the ONLY instruction that can close a `SubscriptionVault`. The two
/// cancel instructions used to be, and they are gone: a subscription is a
/// one-way prepaid envelope, so every lamport of VALUE that entered the vault
/// leaves it toward the retailer and nothing returns to the subscriber.
/// Concretely, the final claim pays the retailer
///
///   * the periods claimed in this call,
///   * the sub-period remainder `total_deposited % rate`, which never bought a
///     period and used to be the "refund".
///
/// THE RENT IS NOT PART OF THAT ENVELOPE and, since 2026-08-20, no longer
/// follows it. It was never the merchant's money: `subscribe_private_stark`
/// charges 3,403,440 lamports of vault rent to its own `payer`, an ephemeral
/// key funded by whoever bought the note, and the merchant merely happened to
/// be the account Anchor's `close()` was pointed at. That is a transfer from
/// the funder to the merchant, per subscription, occurring as a side effect of
/// account cleanup — 3.4034% of a 0.1 SOL denomination, 0.3403% of 1 SOL,
/// 0.0340% of 10 SOL. It now goes to the source pool's `fee_escrow` PDA; read
/// `rent_beneficiary` below for exactly which account that is, and for the
/// honest limit on the word "back".
///
/// The one part of the rent the retailer may still receive is a top-up to its
/// own rent-exempt floor, and only when the payout alone would leave it above
/// zero but under that floor. That is not generosity, it is what keeps the
/// closing transaction executable at all — see the mitigation comment in the
/// handler.
///
/// Pause blocks the claim — pause moves WHEN the retailer is paid, never HOW
/// MUCH — with ONE exception: a vault that is already exhausted. Deleting
/// cancellation left `claim_period` as the only exit, and its `!is_paused`
/// constraint then meant a subscriber who paused and never resumed held the
/// account open forever, withholding the retailer's last payout and the rent
/// from everyone including themselves. `is_exhausted()` is true only once every
/// funded period has been claimed, so letting that case through takes nothing
/// the subscriber still owns: there is no period left to deliver, and the
/// residual it sweeps is the sub-period remainder that never bought one. A
/// paused vault with funding left is still refused, and still cannot be closed
/// out from under its subscriber.
#[derive(Accounts)]
pub struct ClaimPeriod<'info> {
    /// Retailer receiving the payment.
    ///
    /// This doc used to read "Also receives the vault's rent on the final claim
    /// — the subscriber has no refund path, so the rent cannot go back to
    /// them." Both halves of that sentence were true and the conclusion did not
    /// follow: "not the subscriber's" is not "the merchant's". The rent was
    /// paid by the account that funded the vault, and it goes there now. What
    /// this account still receives on the final claim is the payout, the
    /// sub-period dust, and — only if it would otherwise be left above zero and
    /// under its own rent-exempt floor — a top-up out of the rent, because a
    /// retailer under that floor makes the runtime unwind the whole
    /// transaction.
    ///
    /// NOT a signer: see the struct doc. The `==` constraint below is what
    /// makes that safe, and it is the only thing that does.
    /// CHECK: pinned to `vault.retailer` by that constraint, and used only as a lamport destination.
    #[account(
        mut,
        constraint = retailer.key() == vault.retailer @ ZkShieldedError::Unauthorized
    )]
    pub retailer: UncheckedAccount<'info>,

    /// Subscription vault. Closed by the handler on the final claim.
    #[account(
        mut,
        seeds = [
            SubscriptionVault::SEED_PREFIX,
            vault.retailer.as_ref(),
            vault.subscriber_id_bytes().as_ref(),
            vault.token_mint.as_ref()
        ],
        bump = vault.bump,
        constraint = vault.is_active @ ZkShieldedError::VaultNotActive,
        constraint = !vault.is_paused || vault.is_exhausted() @ ZkShieldedError::VaultAlreadyPaused
    )]
    pub vault: Account<'info, SubscriptionVault>,

    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL token transfers)
    pub token_program: Option<Program<'info, Token>>,

    /// Vault's token account (optional, only for SPL tokens). Closed on the
    /// final claim so its rent is not stranded either.
    ///
    /// Its rent follows the vault's rent to `rent_beneficiary`, not to the
    /// retailer. It was the same funder's lamports and there is no reason to
    /// treat it differently; splitting the two would also mean this file
    /// documented one rule and implemented two. There are no live SPL
    /// subscription vaults anywhere in this repository, so the change is
    /// measured only by the litesvm harness, which covers the native path.
    ///
    /// The authority check is written out rather than left to the token
    /// program. The transfer and the close both make the vault PDA sign, so the
    /// token program would refuse a foreign account anyway — but it would NOT
    /// refuse a second, empty account that the same PDA happens to own, and now
    /// that anyone can send this instruction anyone could create one. Passing
    /// that decoy on the final claim would close the decoy, hand its rent over,
    /// close the vault, and strand the real balance behind a PDA that can never
    /// sign again. The `vault_token.amount >= unpaid` require in the handler is
    /// the other half of that guard.
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key() @ ZkShieldedError::Unauthorized
    )]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,

    /// Retailer's token account (optional, only for SPL tokens).
    ///
    /// Either its OWNER is the retailer, or the retailer signed and therefore
    /// chose it. The handler only ever checked the MINT, and the retailer's
    /// signature was the only thing stopping the payout being aimed elsewhere —
    /// so a permissionless claim without this constraint would hand every SPL
    /// vault to whoever sent the transaction first. It is load-bearing for the
    /// permissionless change and must not be relaxed.
    ///
    /// The `|| retailer.is_signer` escape is not a weakening: it restores
    /// exactly the freedom the signature already conferred. Paying into a
    /// treasury account the retailer key does not own is a legitimate setup and
    /// used to work, so a retailer that signs may still name any correct-mint
    /// account. A caller who cannot sign gets one destination, the one the
    /// retailer provably controls.
    #[account(
        mut,
        constraint = retailer_token_account.owner == vault.retailer || retailer.is_signer
            @ ZkShieldedError::Unauthorized
    )]
    pub retailer_token_account: Option<Account<'info, TokenAccount>>,

    /// Where the vault's rent goes when the final claim closes it.
    ///
    /// PINNED IN THE HANDLER to the source pool's fee escrow —
    /// `find_program_address([FEE_ESCROW_SEED_PREFIX, vault.source_pool])` —
    /// and to nothing else. `claim_period` has NO signer of any kind (see the
    /// struct doc), so an unpinned writable destination here would hand
    /// 3,403,440 lamports per vault to whoever sent the transaction first:
    /// exactly the class the `retailer.key() == vault.retailer` constraint
    /// above exists to close. The pin is a key comparison in the handler rather
    /// than an Anchor `seeds =` constraint because the seed has to be read out
    /// of another account's data (`vault.source_pool`), which produces a
    /// temporary the generated seeds array cannot borrow.
    ///
    /// WHY THE ESCROW AND NOT LITERALLY "THE FUNDER". The vault does not record
    /// who paid for it and cannot be made to without changing the account
    /// layout under the vaults already live on devnet. The init payer is not a
    /// usable answer either: `apps/web/lib/privacy/pool/subscribeEphemeral.ts`
    /// sweeps that ephemeral key to exactly zero on every exit path and never
    /// looks at it again, so paying it back strands the rent, and sweeping it
    /// later would rebuild the vault -> ephemeral -> wallet edge the ephemeral
    /// exists to break. The pool's fee escrow is the only destination that is
    /// at once unforgeable by the caller, already the sink for that pool's
    /// shield and unshield fees, drained solely by TREASURY_AUTHORITY, and
    /// named by nobody new — every shield into the pool already writes to it,
    /// so the close adds no graph edge an indexer did not already have.
    ///
    /// THE HONEST LIMIT: this returns the rent to the OPERATOR, which is the
    /// funder in the operator-funded inventory model and only in that model. A
    /// third party who funds a note for someone else does not get their rent
    /// back — the operator does. Recording a real per-vault beneficiary is a
    /// layout change and a client-visible one; it is not what this does.
    ///
    /// Absent (Anchor encodes an absent optional as the program's own id) is
    /// accepted only for a vault whose `source_pool` is `None`, which no
    /// instruction that still exists can create — `subscribe_private_stark`
    /// always writes `Some(pool)`. Such a vault closes to the retailer exactly
    /// as it did before, so the two vaults already on chain are unaffected in
    /// the None case and route to their own pool's escrow in the Some case.
    /// CHECK: pinned to the derived fee_escrow in the handler and used only as
    /// a lamport destination.
    #[account(mut)]
    pub rent_beneficiary: Option<UncheckedAccount<'info>>,
}

pub fn handler(ctx: Context<ClaimPeriod>) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault;

    // All of the money arithmetic lives in `SubscriptionVault::settle`, which
    // the unit tests in `state/subscription_vault.rs` drive directly. `None`
    // means nothing accrued AND funding is still outstanding — a genuine no-op.
    //
    // A settled vault does NOT come back as `None`. Three of them reach this
    // point with nothing accruing and value still inside:
    //   * one whose funded periods were all claimed before this instruction
    //     learned how to close, leaving dust and rent behind;
    //   * one funded with less than one period's `rate`, for which
    //     `claimable_periods` is 0 from the first slot and always will be;
    //   * one of the two above that is ALSO paused, which the account
    //     constraint now lets through. `claimable_periods` returns 0 while
    //     paused, so `settle` credits no period and pays only the residual the
    //     subscriber could never have got back anyway.
    // All must be closable, or the deposit and the rent are stranded forever
    // now that no cancel instruction exists.
    let settlement = vault
        .settle(clock.slot as i64)
        .ok_or(ZkShieldedError::NoClaimablePeriods)?;

    let claimable = settlement.periods;
    let periods_after = settlement.claimed_periods_after;
    let is_final = settlement.is_final;
    let value_payout = settlement.payout;

    // Everything the retailer has not been paid yet, dust included. Re-derived
    // here so the payout is bounded by the account's own numbers rather than
    // trusted from the settlement.
    let unpaid = vault.unpaid_amount();
    require!(
        value_payout <= unpaid,
        ZkShieldedError::InsufficientVaultBalance
    );
    // A zero payout is only legitimate on the final claim of a vault that was
    // already paid out in full and just needs its rent released.
    require!(
        value_payout > 0 || is_final,
        ZkShieldedError::InsufficientVaultBalance
    );

    let is_native_sol = vault.token_mint == system_program::ID;

    // Build signer seeds for vault PDA
    let retailer_key = vault.retailer;
    let subscriber_id = vault.subscriber_id_bytes();
    let token_mint = vault.token_mint;
    let bump = vault.bump;
    let seeds = &[
        SubscriptionVault::SEED_PREFIX,
        retailer_key.as_ref(),
        subscriber_id.as_ref(),
        token_mint.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];

    let vault_ai = ctx.accounts.vault.to_account_info();
    let retailer_ai = ctx.accounts.retailer.to_account_info();

    // -----------------------------------------------------------------------
    // Resolve the closing destination BEFORE a single lamport moves.
    //
    // Two reasons it is done here and not at the close: the SPL branch needs
    // the same answer for its `CloseAccount` CPI, and the pin must run on a
    // path no early `?` can skip.
    //
    // `rent_is_routed` is false for a vault with no `source_pool` — there is no
    // pool to derive an escrow from, so it closes to the retailer exactly as it
    // did before this change. No instruction that still exists can create such
    // a vault (`subscribe_private_stark` always writes `Some(pool)`), so this
    // is a compatibility path for legacy accounts and for the litesvm fixtures,
    // not a policy.
    // -----------------------------------------------------------------------
    let source_pool = ctx.accounts.vault.source_pool;
    let (rent_dest_ai, rent_is_routed) = if is_final {
        match source_pool {
            Some(pool) => {
                // `Unauthorized` rather than a new error variant: `#[error_code]`
                // numbers by position, and every client catalogue would have to
                // move for a case that only a wrong or missing account produces.
                let beneficiary = ctx
                    .accounts
                    .rent_beneficiary
                    .as_ref()
                    .ok_or(ZkShieldedError::Unauthorized)?;
                let (expected_escrow, _escrow_bump) = derive_fee_escrow(&pool);
                require!(
                    beneficiary.key() == expected_escrow,
                    ZkShieldedError::Unauthorized
                );
                (beneficiary.to_account_info(), true)
            }
            None => (retailer_ai.clone(), false),
        }
    } else {
        (retailer_ai.clone(), false)
    };
    let rent_beneficiary_key = if is_final {
        rent_dest_ai.key()
    } else {
        Pubkey::default()
    };

    // Every lamport of rent the close releases, wherever it lands: the vault's
    // own rent, plus for SPL the vault token account's rent.
    let mut rent_released: u64 = 0;
    // The slice of that rent which had to stay with the retailer to keep the
    // transaction executable. See the mitigation below. Zero in every case
    // where the retailer's wallet already clears its own rent floor, which is
    // every merchant that has ever been paid once.
    let mut rent_top_up: u64 = 0;
    // What actually moved as value, which for SPL is the whole token balance
    // (a donated token can only ever leave toward the retailer).
    let mut amount_moved = value_payout;

    if is_native_sol {
        let vault_lamports = vault_ai.lamports();

        if is_final {
            require!(
                vault_lamports >= value_payout,
                ZkShieldedError::InsufficientVaultBalance
            );

            // The payout used to ride along inside `close()`, which moved
            // payout + dust + rent to the retailer in one step. It is moved
            // explicitly now, with the same borrow pair the non-final branch
            // uses, because `close()` has exactly one destination and the rent
            // no longer shares it with the value.
            if value_payout > 0 {
                **vault_ai.try_borrow_mut_lamports()? -= value_payout;
                **retailer_ai.try_borrow_mut_lamports()? += value_payout;
            }

            rent_released = vault_lamports - value_payout;

            // MANDATORY MITIGATION, not a nicety, and the reason this change is
            // more than a redirect.
            //
            // MEASURED on devnet 2026-08-01 and reproduced in
            // `tests/subscription_lifecycle.rs`: a claim that leaves the
            // retailer above zero but under the rent-exempt floor is unwound by
            // the RUNTIME after the program has already succeeded and emitted
            // its event. The same file measured that there is no way to *put* a
            // system account under that floor — an airdrop below it is refused
            // too — so a merchant is either at zero or above the floor, and a
            // fresh merchant is at zero.
            //
            // Until this change the closing claim always carried the vault's
            // 3,403,440 lamports of rent, which is 3.82x the 890,880 floor, so
            // the last claim always landed however small the payout was. Route
            // that rent away without topping the retailer up and any final
            // residual under the floor to a zero-lamport merchant becomes a
            // transaction that can never execute: the vault can never close and
            // the rent is stranded forever, which is strictly worse than the
            // merchant keeping it.
            //
            // The top-up is always affordable in the shape that matters:
            // 3,403,440 - 890,880 = 2,512,560 still reaches the beneficiary.
            // The `.min(rent_released)` is for the shape that does not — a
            // retailer account carrying data, whose floor can exceed the rent —
            // where the honest degradation is to give the retailer everything
            // rather than to make the close unexecutable.
            let floor = Rent::get()?.minimum_balance(retailer_ai.data_len());
            let retailer_after = retailer_ai.lamports();
            if retailer_after > 0 && retailer_after < floor {
                rent_top_up = (floor - retailer_after).min(rent_released);
                if rent_top_up > 0 {
                    **vault_ai.try_borrow_mut_lamports()? -= rent_top_up;
                    **retailer_ai.try_borrow_mut_lamports()? += rent_top_up;
                }
            }
        } else {
            let rent = Rent::get()?;
            let min_rent = rent.minimum_balance(vault_ai.data_len());
            require!(
                vault_lamports.saturating_sub(min_rent) >= value_payout,
                ZkShieldedError::InsufficientVaultBalance
            );

            **vault_ai.try_borrow_mut_lamports()? -= value_payout;
            **retailer_ai.try_borrow_mut_lamports()? += value_payout;
        }
    } else {
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let vault_token = ctx
            .accounts
            .vault_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;
        let retailer_token = ctx
            .accounts
            .retailer_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;

        require!(
            vault_token.mint == token_mint,
            ZkShieldedError::InvalidTokenMint
        );
        require!(
            retailer_token.mint == token_mint,
            ZkShieldedError::InvalidTokenMint
        );

        // The other half of the decoy guard on `vault_token_account` (see its
        // doc). Owning the right PDA is not enough: a caller who wants the
        // vault closed with its money still inside would pass an EMPTY account
        // that the PDA owns. The real one always holds at least `unpaid`, so
        // requiring that here is exactly the difference between the two.
        require!(
            vault_token.amount >= unpaid,
            ZkShieldedError::InsufficientVaultBalance
        );

        // On the final claim drain the token account outright: `close_account`
        // below requires a zero balance, and anything sitting above `unpaid`
        // has no other way out now that refunds are gone.
        if is_final {
            amount_moved = vault_token.amount;
        }

        if amount_moved > 0 {
            let transfer_ctx = CpiContext::new_with_signer(
                token_program.to_account_info(),
                TokenTransfer {
                    from: vault_token.to_account_info(),
                    to: retailer_token.to_account_info(),
                    authority: vault_ai.clone(),
                },
                signer_seeds,
            );
            token::transfer(transfer_ctx, amount_moved)?;
        }

        if is_final {
            // The vault token account's own rent would otherwise be stranded:
            // the vault PDA is its authority and nothing else can ever sign
            // for it again. Its destination is `rent_dest_ai` and not the
            // retailer since 2026-08-20, for the same reason the vault's own
            // rent moved: it was the funder's lamports, never the merchant's.
            rent_released =
                rent_released.saturating_add(vault_token.to_account_info().lamports());

            let close_ctx = CpiContext::new_with_signer(
                token_program.to_account_info(),
                CloseAccount {
                    account: vault_token.to_account_info(),
                    destination: rent_dest_ai.clone(),
                    authority: vault_ai.clone(),
                },
                signer_seeds,
            );
            token::close_account(close_ctx)?;

            rent_released = rent_released.saturating_add(vault_ai.lamports());
        }
    }

    // Split the released rent for the event. When nothing is routed the
    // retailer is still the close destination and receives all of it, so
    // `rent_to_retailer` keeps reporting a TRUE number for decoders built
    // against the old event rather than a stale one.
    let rent_to_retailer = if rent_is_routed {
        rent_top_up
    } else {
        rent_released
    };
    let rent_to_beneficiary = rent_released.saturating_sub(rent_to_retailer);

    // Update vault state. On the final claim this is bookkeeping for the event
    // only — the account is closed a few lines below and never serialized.
    let vault = &mut ctx.accounts.vault;
    vault.claimed_periods = periods_after;

    emit!(ClaimPeriodEvent {
        vault: vault.key(),
        retailer: ctx.accounts.retailer.key(),
        periods_claimed: claimable,
        amount_claimed: amount_moved,
        total_claimed_periods: vault.claimed_periods,
        slot: clock.slot as i64,
        vault_closed: is_final,
        rent_to_retailer,
        rent_to_beneficiary,
        rent_beneficiary: rent_beneficiary_key,
    });

    if is_final {
        // Anchor's `close` moves every remaining lamport to ONE destination,
        // assigns the account to the system program and truncates it. The
        // generated `exit` sees a closed account and skips serialization, so
        // the state written above is intentionally never persisted.
        //
        // The destination was `ctx.accounts.retailer` until 2026-08-20 and is
        // `rent_dest_ai` now, resolved and pinned at the top of this handler.
        // By the time this runs the retailer has already been paid its payout,
        // its dust and any rent-floor top-up explicitly, so what remains here
        // is rent and only rent.
        ctx.accounts.vault.close(rent_dest_ai)?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Structural guards on the account plumbing.
//
// THIS BLOCK USED TO SAY "NOTHING executes this handler: the crate has no
// `tests/` directory and no solana-program-test / litesvm dev-dependency, so no
// lamport ever moves in CI". That was measured and true when it was written —
// deleting the entire `if is_final { .close(retailer) }` block left
// `cargo test -p zk_shielded` at 18 passed / 0 failed, and deleting the
// `!vault.is_paused` account constraint did the same. It is FALSE now, and
// leaving it would be a false guarantee about coverage sitting in the exact
// place a reviewer looks for the coverage story.
//
// What actually exists as of 2026-08-20: `programs/zk_shielded/tests/` holds
// `subscription_lifecycle.rs`, which loads the built `target/deploy/
// zk_shielded.so` into litesvm (dev-dependency block, `Cargo.toml`) and
// executes real `claim_period` transactions with warped slots, and
// `landed_invariants.rs`, which re-asserts the properties below from OUTSIDE
// this file so that a merge resolving it to a pre-landing version goes red
// instead of silently green.
//
// The guards below are still worth their line count for the one class
// execution does not catch cheaply: a deletion that takes its own test with
// it. They cannot tell you where the lamports land — the litesvm file does
// that, and it is the thing to run after any edit here.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod plumbing_guards {
    /// This very file, read at compile time.
    const SRC: &str = include_str!("claim_period.rs");

    /// Everything before the guards themselves, WITH EVERY COMMENT STRIPPED.
    ///
    /// Excluding the guard module is not enough, and that was measured rather
    /// than argued: deleting `require!(vault_token.amount >= unpaid)` from the
    /// handler outright left `cargo test -p zk_shielded` at 25 passed / 0
    /// failed, because the doc comment on `vault_token_account` quotes the
    /// pattern verbatim and the assertion matched the prose. A guard that a
    /// comment can satisfy is worse than no guard: it reports a protection
    /// that is not there. Every one of these assertions now runs against code
    /// only.
    fn handler_src() -> String {
        let end = SRC
            .find("mod plumbing_guards")
            .expect("guard module marker");
        SRC[..end]
            .lines()
            .map(|line| match line.find("//") {
                Some(at) => &line[..at],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_comment_stripper_actually_strips() {
        // Self-check. If this ever regresses, every assertion below silently
        // degrades back into a prose match. The doc on `vault_token_account`
        // is the exact comment that made a real guard hollow.
        assert!(
            SRC.contains("// the other half of that guard"),
            "the comment this fixture is built on was reworded — pick another",
        );
        let stripped = handler_src();
        assert!(
            !stripped.contains("the other half of that guard"),
            "handler_src() is leaking comments again; every guard below is \
             now satisfiable by prose alone",
        );
        // And it must not have eaten the code around them.
        assert!(stripped.contains("pub fn handler(ctx: Context<ClaimPeriod>) -> Result<()> {"));
        assert!(stripped.contains("token::close_account("));
    }

    #[test]
    fn claim_period_actually_closes_the_vault_and_only_on_the_final_claim() {
        let src = handler_src();
        // Cancellation was the only instruction that could close a
        // SubscriptionVault. Without this call every subscription ever
        // created leaks its rent, permanently and unrecoverably.
        //
        // This assertion used to pin the LITERAL
        // `.close(ctx.accounts.retailer.to_account_info())`. The destination
        // moved on 2026-08-20, so the literal moved with it; the property being
        // guarded — that a close exists and fires only on the final claim — did
        // not change.
        assert!(
            src.contains(".close(rent_dest_ai)"),
            "claim_period no longer closes the vault — every vault's rent and \
             residual would be stranded forever"
        );
        let close_at = src.find(".close(rent_dest_ai)").unwrap();
        // The nearest `if is_final {` opening BEFORE the close, and no block
        // end between the two.
        let guard_at = src[..close_at]
            .rfind("if is_final {")
            .expect("the close must be guarded by is_final");
        assert!(
            !src[guard_at..close_at].contains("\n    }"),
            "the close is no longer inside the `if is_final` block — a vault \
             with funding left would be closed out from under its subscriber"
        );
    }

    #[test]
    fn the_close_destination_is_derived_and_not_chosen_by_the_caller() {
        // The whole safety of the C1 redirect. `claim_period` has no Signer of
        // any kind, so a writable destination the CALLER picks is 3,403,440
        // lamports per vault handed to whoever sends the transaction first —
        // the same class `retailer.key() == vault.retailer` exists to close.
        let src = handler_src();
        assert!(
            src.contains("derive_fee_escrow(&pool)"),
            "the rent destination is no longer derived from the vault's own \
             source_pool — if it is read straight off ctx.accounts, any caller \
             can name themselves and take every closing vault's rent"
        );
        assert!(
            src.contains("beneficiary.key() == expected_escrow"),
            "the derived escrow is no longer COMPARED to the supplied account — \
             deriving an address and then not checking it is the same as not \
             deriving it"
        );
        // And the comparison must be a rejection, not a log.
        let pin_at = src
            .find("beneficiary.key() == expected_escrow")
            .expect("pin present");
        let window_start = pin_at.saturating_sub(200);
        assert!(
            src[window_start..pin_at].contains("require!("),
            "the beneficiary key comparison is no longer inside a require! — \
             it must reject the transaction, not merely evaluate"
        );
        // The resolution must happen before anything moves, so no `?` can skip
        // it and so the SPL token-account close uses the same answer.
        let resolve_at = src.find("let (rent_dest_ai, rent_is_routed)").expect(
            "rent_dest_ai must be resolved in one place, before any lamport moves",
        );
        assert!(
            resolve_at < src.find("try_borrow_mut_lamports").unwrap_or(usize::MAX),
            "the rent destination is resolved AFTER lamports have already \
             started moving — the pin must run on a path no early return can skip"
        );
    }

    #[test]
    fn the_final_claim_still_tops_the_retailer_to_its_rent_floor() {
        // MEASURED devnet 2026-08-01, pinned by
        // `tests/subscription_lifecycle.rs`: a claim leaving the retailer above
        // zero and under the rent-exempt floor is unwound by the RUNTIME after
        // the program succeeded. The rent used to carry every closing claim
        // over that floor by accident. Routing it away without this top-up
        // turns a working close into a permanently unexecutable one and strands
        // the rent for good — worse than the merchant keeping it.
        let src = handler_src();
        assert!(
            src.contains("Rent::get()?.minimum_balance(retailer_ai.data_len())"),
            "the closing claim no longer computes the retailer's rent floor — a \
             final residual under 890,880 to a fresh merchant wallet becomes a \
             transaction that can never execute, and the vault can never close"
        );
        assert!(
            src.contains("rent_top_up = (floor - retailer_after).min(rent_released)"),
            "the rent-floor top-up changed shape — without the subtraction the \
             retailer is not brought TO the floor, and without the .min() a \
             retailer whose own floor exceeds the rent makes the close fail \
             instead of degrading to paying it everything"
        );
    }

    #[test]
    fn the_spl_final_claim_closes_the_vault_token_account_too() {
        // The vault PDA is that account's authority and nothing can ever sign
        // for it again once the vault closes, so its rent is a second silent
        // leak if this CPI goes.
        assert!(
            handler_src().contains("token::close_account("),
            "the SPL vault token account is no longer closed — its rent is \
             stranded with no signer left that could reclaim it"
        );
    }

    #[test]
    fn a_paused_vault_is_refused_unless_it_has_nothing_left_to_deliver() {
        // The whole constraint, not a prefix of it. `contains("constraint =
        // !vault.is_paused")` is satisfied by the exhaustion escape hatch too,
        // so it can no longer tell a correct constraint from a widened one.
        assert!(
            handler_src().contains("constraint = !vault.is_paused || vault.is_exhausted()"),
            "claim_period's pause constraint changed shape — dropping the \
             `!is_paused` half lets a claim take money for a period the \
             subscriber had no access to; dropping the `is_exhausted()` half \
             puts back the deadlock where a subscriber who pauses and never \
             resumes strands the retailer's last payout and the rent forever"
        );
    }

    #[test]
    fn the_claim_is_permissionless_but_the_destination_is_not() {
        let src = handler_src();
        // Dropping `Signer` is the entire point: a merchant that lost its key
        // must not lose the revenue. It is only safe while the destination
        // stays pinned to the account's own immutable field.
        assert!(
            !src.contains("pub retailer: Signer<'info>"),
            "retailer is a Signer again — a merchant whose key is gone can \
             never be paid, which is already true of 13 devnet vaults"
        );
        assert!(
            src.contains("constraint = retailer.key() == vault.retailer"),
            "the retailer is no longer pinned to vault.retailer — with no \
             signature required, ANY caller could now name themselves as the \
             payee and drain every vault on the program"
        );
    }

    #[test]
    fn the_spl_payout_cannot_be_redirected_by_whoever_sent_the_transaction() {
        let src = handler_src();
        // Before the claim went permissionless the retailer's signature was
        // what tied `retailer_token_account` to the retailer; the handler only
        // ever checked its MINT. Without this constraint the permissionless
        // change alone hands every SPL vault to the first caller.
        assert!(
            src.contains(
                "constraint = retailer_token_account.owner == vault.retailer || retailer.is_signer"
            ),
            "retailer_token_account's destination check changed shape — without \
             the owner half, any caller could name their own token account and \
             take the whole SPL payout; without the is_signer half, a retailer \
             paying into a treasury account it does not own can no longer claim \
             at all, which used to work"
        );
        // And the vault side: the token program refuses an account the vault
        // PDA does not own, but not a second EMPTY one that it does.
        assert!(
            src.contains("constraint = vault_token_account.owner == vault.key()"),
            "vault_token_account is no longer owner-checked"
        );
        assert!(
            src.contains("vault_token.amount >= unpaid"),
            "the vault token account's balance is no longer checked against \
             what is owed — a caller could pass an empty decoy the PDA owns, \
             close the vault, and strand the real balance behind a PDA that \
             can never sign again"
        );
    }

    #[test]
    fn no_lamport_can_reach_the_subscriber_because_the_instruction_cannot_name_one() {
        // The one-way invariant, enforced structurally rather than by review:
        // `ClaimPeriod` has no subscriber account of any kind, so there is no
        // key a payout or a close could be addressed to. Anchor rejects an
        // account the struct does not declare, so this holds regardless of
        // what the handler body does.
        let src = handler_src();
        let accounts_start = src
            .find("pub struct ClaimPeriod<'info> {")
            .expect("ClaimPeriod accounts struct");
        let accounts_end = src[accounts_start..]
            .find("\n}\n")
            .expect("end of accounts struct")
            + accounts_start;
        let accounts = &src[accounts_start..accounts_end];
        // Declared fields only. `vault.subscriber_id_bytes()` appears in the
        // PDA seeds and is a read of the vault, not an account.
        let declared: Vec<&str> = accounts
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("pub "))
            .collect();
        assert!(
            !declared.iter().any(|l| l.contains("subscriber")),
            "ClaimPeriod now declares a subscriber account ({declared:?}) — a \
             subscription is a one-way prepaid envelope and nothing may return \
             to the subscriber"
        );
        // `close = <account>` is how both deleted cancel instructions sent the
        // vault's lamports somewhere. The close here is explicit, in the
        // handler, and addressed to the retailer.
        assert!(
            !accounts.contains("close ="),
            "an Anchor `close =` constraint reappeared on ClaimPeriod — the \
             close destination must stay explicit and must stay pinned in the \
             handler"
        );
        // The 2026-08-20 rent redirect added a SEVENTH account, and it is a
        // writable lamport destination on an instruction with no signer. If it
        // is ever declared without the handler pin that ties it to the derived
        // fee escrow, every closing vault's rent goes to whoever sends the
        // transaction. Name-checked here as well as in
        // `the_close_destination_is_derived_and_not_chosen_by_the_caller`
        // because that test is satisfiable by a pin on a DIFFERENT account.
        if declared.iter().any(|l| l.contains("rent_beneficiary")) {
            assert!(
                src.contains("rent_beneficiary")
                    && src.contains("beneficiary.key() == expected_escrow"),
                "ClaimPeriod declares `rent_beneficiary` but the handler no \
                 longer pins it to the derived fee escrow — an unpinned \
                 writable destination on a signerless instruction hands \
                 3,403,440 lamports per vault to the first caller"
            );
        }
        // And whatever it is called, it must not be the subscriber's, which the
        // substring check above already covers for every declared field.
    }
}

#[event]
pub struct ClaimPeriodEvent {
    pub vault: Pubkey,
    pub retailer: Pubkey,
    pub periods_claimed: u64,
    pub amount_claimed: u64,
    pub total_claimed_periods: u64,
    pub slot: i64,
    // The four fields below are APPENDED, deliberately. Borsh decodes an event
    // sequentially, so inserting anything before `slot` would silently shift it
    // for every decoder built against the old layout. Appended, an old decoder
    // reads the first six fields correctly and ignores the tail.
    /// True when this claim exhausted the vault and closed it. No further
    /// claim is possible and the account no longer exists.
    pub vault_closed: bool,
    /// Lamports of RENT paid to the retailer on top of `amount_claimed` when
    /// the vault closed.
    ///
    /// This used to be the whole released rent and now usually reads 0, which
    /// is a true number and not a stale one: since 2026-08-20 the rent goes to
    /// `rent_beneficiary`. It is non-zero in exactly two cases — a vault with
    /// no `source_pool`, which closes to the retailer as before, and a
    /// rent-floor top-up, which is the slice of the rent that had to stay with
    /// the retailer for the transaction to execute at all.
    pub rent_to_retailer: u64,
    /// Lamports of rent routed to `rent_beneficiary` by the closing claim: the
    /// vault's rent, plus the vault token account's rent for SPL, minus
    /// whatever `rent_to_retailer` had to keep back.
    pub rent_to_beneficiary: u64,
    /// The account the vault was closed to. The source pool's `fee_escrow` PDA
    /// for every vault this program can create; the retailer for a legacy vault
    /// with no `source_pool`; `Pubkey::default()` on a claim that did not close
    /// the vault.
    pub rent_beneficiary: Pubkey,
}
