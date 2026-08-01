use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
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
/// one-way prepaid envelope, so every lamport that entered the vault leaves it
/// toward the retailer and nothing returns to the subscriber. Concretely, the
/// final claim pays out
///
///   * the periods claimed in this call,
///   * the sub-period remainder `total_deposited % rate`, which never bought a
///     period and used to be the "refund",
///   * the vault's rent, and for SPL the rent of the vault token account.
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
    /// Retailer receiving the payment. Also receives the vault's rent on the
    /// final claim — the subscriber has no refund path, so the rent cannot go
    /// back to them.
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

    /// Vault's token account (optional, only for SPL tokens). Closed to the
    /// retailer on the final claim so its rent is not stranded either.
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

    // Lamports the retailer receives on top of `value_payout` when the vault
    // closes: rent, plus for SPL the vault token account's rent.
    let mut rent_to_retailer: u64 = 0;
    // What actually moved as value, which for SPL is the whole token balance
    // (a donated token can only ever leave toward the retailer).
    let mut amount_moved = value_payout;

    if is_native_sol {
        let vault_lamports = vault_ai.lamports();

        if is_final {
            // `close` below moves EVERY lamport — final payout, dust and rent —
            // in one step, so there is no rent floor left to respect here.
            require!(
                vault_lamports >= value_payout,
                ZkShieldedError::InsufficientVaultBalance
            );
            rent_to_retailer = vault_lamports - value_payout;
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
            // for it again.
            rent_to_retailer = rent_to_retailer.saturating_add(vault_token.to_account_info().lamports());

            let close_ctx = CpiContext::new_with_signer(
                token_program.to_account_info(),
                CloseAccount {
                    account: vault_token.to_account_info(),
                    destination: retailer_ai.clone(),
                    authority: vault_ai.clone(),
                },
                signer_seeds,
            );
            token::close_account(close_ctx)?;

            rent_to_retailer = rent_to_retailer.saturating_add(vault_ai.lamports());
        }
    }

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
    });

    if is_final {
        // Anchor's `close` moves every remaining lamport to the retailer,
        // assigns the account to the system program and truncates it. The
        // generated `exit` sees a closed account and skips serialization, so
        // the state written above is intentionally never persisted.
        ctx.accounts
            .vault
            .close(ctx.accounts.retailer.to_account_info())?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Structural guards on the account plumbing.
//
// `settle()` is unit-tested in `state/subscription_vault.rs`, but NOTHING
// executes this handler: the crate has no `tests/` directory and no
// solana-program-test / litesvm dev-dependency, so no lamport ever moves in
// CI. That gap was measured, not assumed — deleting the entire
// `if is_final { .close(retailer) }` block below left `cargo test -p
// zk_shielded` at 18 passed / 0 failed and `cargo clippy` at zero warnings.
// Deleting the `!vault.is_paused` account constraint did the same.
//
// A source guard is a poor substitute for execution and is not offered as
// one. It catches exactly the class that went uncaught: a deletion. It cannot
// tell you the lamports actually land on the retailer, and only a
// program-test or a devnet run can. Both are still owed.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod plumbing_guards {
    /// This very file, read at compile time.
    const SRC: &str = include_str!("claim_period.rs");

    /// Everything before the guards themselves, so a pattern quoted in these
    /// comments cannot satisfy its own assertion.
    fn handler_src() -> &'static str {
        let end = SRC
            .find("mod plumbing_guards")
            .expect("guard module marker");
        &SRC[..end]
    }

    #[test]
    fn claim_period_actually_closes_the_vault_and_only_on_the_final_claim() {
        let src = handler_src();
        // Cancellation was the only instruction that could close a
        // SubscriptionVault. Without this call every subscription ever
        // created leaks its rent, permanently and unrecoverably.
        assert!(
            src.contains(".close(ctx.accounts.retailer.to_account_info())"),
            "claim_period no longer closes the vault to the retailer — every \
             vault's rent and residual would be stranded forever"
        );
        let close_at = src
            .find(".close(ctx.accounts.retailer.to_account_info())")
            .unwrap();
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
        let accounts_start = handler_src()
            .find("pub struct ClaimPeriod<'info> {")
            .expect("ClaimPeriod accounts struct");
        let accounts_end = handler_src()[accounts_start..]
            .find("\n}\n")
            .expect("end of accounts struct")
            + accounts_start;
        let accounts = &handler_src()[accounts_start..accounts_end];
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
             close destination must stay explicit and must stay the retailer"
        );
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
    // The two fields below are APPENDED, deliberately. Borsh decodes an event
    // sequentially, so inserting anything before `slot` would silently shift it
    // for every decoder built against the old layout. Appended, an old decoder
    // reads the first six fields correctly and ignores the tail.
    /// True when this claim exhausted the vault and closed it. No further
    /// claim is possible and the account no longer exists.
    pub vault_closed: bool,
    /// Lamports paid to the retailer on top of `amount_claimed` when the vault
    /// closed: the vault's rent, plus the vault token account's rent for SPL.
    pub rent_to_retailer: u64,
}
