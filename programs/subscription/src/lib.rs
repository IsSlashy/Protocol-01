use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// P01 Subscription Program
///
/// Enables delegated recurring payments with on-chain validation.
/// The subscriber authorizes a merchant to charge their wallet within
/// defined limits (amount, interval, max payments).
///
/// Key features:
/// - No escrow: funds stay in subscriber's wallet until payment
/// - On-chain validation of payment limits
/// - Subscriber can pause/resume/cancel anytime
/// - Merchant (or crank) triggers payments
/// - Privacy options stored for client-side processing
#[program]
pub mod p01_subscription {
    use super::*;

    /// Create a new subscription authorization
    ///
    /// The subscriber authorizes the merchant to charge up to `amount_per_period`
    /// every `interval_seconds` for up to `max_payments` times.
    pub fn create_subscription(
        ctx: Context<CreateSubscription>,
        subscription_id: String,
        amount_per_period: u64,
        interval_seconds: i64,
        max_payments: u64,
        subscription_name: String,
        // Privacy options (stored for client-side processing)
        amount_noise: u8,
        timing_noise: u8,
        use_stealth_address: bool,
    ) -> Result<()> {
        require!(subscription_id.len() <= 64, SubscriptionError::IdTooLong);
        require!(amount_per_period > 0, SubscriptionError::InvalidAmount);
        require!(interval_seconds >= 60, SubscriptionError::InvalidInterval); // Min 1 minute
        require!(subscription_name.len() <= 32, SubscriptionError::NameTooLong);
        require!(amount_noise <= 20, SubscriptionError::InvalidAmountNoise);
        require!(timing_noise <= 24, SubscriptionError::InvalidTimingNoise);

        let subscription = &mut ctx.accounts.subscription;
        let clock = Clock::get()?;

        subscription.subscriber = ctx.accounts.subscriber.key();
        subscription.merchant = ctx.accounts.merchant.key();
        subscription.mint = ctx.accounts.mint.key();
        subscription.subscription_id = subscription_id;
        subscription.subscription_name = subscription_name;
        subscription.amount_per_period = amount_per_period;
        subscription.interval_seconds = interval_seconds;
        subscription.max_payments = max_payments;
        subscription.payments_made = 0;
        subscription.total_paid = 0;
        subscription.created_at = clock.unix_timestamp;
        subscription.last_payment_at = 0; // No payment yet
        subscription.next_payment_due = clock.unix_timestamp; // Can pay immediately
        subscription.status = SubscriptionStatus::Active;
        subscription.amount_noise = amount_noise;
        subscription.timing_noise = timing_noise;
        subscription.use_stealth_address = use_stealth_address;
        subscription.bump = ctx.bumps.subscription;

        emit!(SubscriptionCreated {
            subscription: subscription.key(),
            subscriber: subscription.subscriber,
            merchant: subscription.merchant,
            subscription_id: subscription.subscription_id.clone(),
            amount_per_period,
            interval_seconds,
            max_payments,
        });

        Ok(())
    }

    /// Process a payment for an active subscription
    ///
    /// Can be called by the merchant or an authorized crank.
    /// Validates that payment is within the subscription limits.
    pub fn process_payment(
        ctx: Context<ProcessPayment>,
        payment_amount: u64,
    ) -> Result<()> {
        let subscription = &mut ctx.accounts.subscription;
        let clock = Clock::get()?;

        // Validate subscription status
        require!(
            subscription.status == SubscriptionStatus::Active,
            SubscriptionError::SubscriptionNotActive
        );

        // Validate payment timing (must be at or after next_payment_due)
        require!(
            clock.unix_timestamp >= subscription.next_payment_due,
            SubscriptionError::PaymentTooEarly
        );

        // Validate payment amount (must not exceed authorized amount)
        require!(
            payment_amount <= subscription.amount_per_period,
            SubscriptionError::AmountExceedsLimit
        );

        // Validate max payments not reached (0 = unlimited)
        if subscription.max_payments > 0 {
            require!(
                subscription.payments_made < subscription.max_payments,
                SubscriptionError::MaxPaymentsReached
            );
        }

        // Execute the payment transfer
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.subscriber_token_account.to_account_info(),
                    to: ctx.accounts.merchant_token_account.to_account_info(),
                    authority: ctx.accounts.subscriber.to_account_info(),
                },
            ),
            payment_amount,
        )?;

        // Update subscription state
        subscription.payments_made = subscription
            .payments_made
            .checked_add(1)
            .ok_or(SubscriptionError::Overflow)?;
        subscription.total_paid = subscription
            .total_paid
            .checked_add(payment_amount)
            .ok_or(SubscriptionError::Overflow)?;
        subscription.last_payment_at = clock.unix_timestamp;
        subscription.next_payment_due = clock
            .unix_timestamp
            .checked_add(subscription.interval_seconds)
            .ok_or(SubscriptionError::Overflow)?;

        // Auto-complete if max payments reached
        if subscription.max_payments > 0 && subscription.payments_made >= subscription.max_payments {
            subscription.status = SubscriptionStatus::Completed;
        }

        emit!(PaymentProcessed {
            subscription: subscription.key(),
            subscriber: subscription.subscriber,
            merchant: subscription.merchant,
            amount: payment_amount,
            payment_number: subscription.payments_made,
            total_paid: subscription.total_paid,
        });

        Ok(())
    }

    /// Pause subscription (subscriber only)
    ///
    /// Prevents any further payments until resumed.
    pub fn pause_subscription(ctx: Context<SubscriberAction>) -> Result<()> {
        let subscription = &mut ctx.accounts.subscription;

        require!(
            subscription.status == SubscriptionStatus::Active,
            SubscriptionError::SubscriptionNotActive
        );

        subscription.status = SubscriptionStatus::Paused;

        emit!(SubscriptionPaused {
            subscription: subscription.key(),
            subscriber: subscription.subscriber,
        });

        Ok(())
    }

    /// Resume a paused subscription (subscriber only)
    ///
    /// Re-enables payments. Next payment is due immediately or at the
    /// previously scheduled time, whichever is later.
    pub fn resume_subscription(ctx: Context<SubscriberAction>) -> Result<()> {
        let subscription = &mut ctx.accounts.subscription;
        let clock = Clock::get()?;

        require!(
            subscription.status == SubscriptionStatus::Paused,
            SubscriptionError::SubscriptionNotPaused
        );

        subscription.status = SubscriptionStatus::Active;

        // If next_payment_due is in the past, set it to now
        if subscription.next_payment_due < clock.unix_timestamp {
            subscription.next_payment_due = clock.unix_timestamp;
        }

        emit!(SubscriptionResumed {
            subscription: subscription.key(),
            subscriber: subscription.subscriber,
        });

        Ok(())
    }

    /// Cancel subscription permanently (subscriber only)
    ///
    /// No further payments can be processed. This action is irreversible.
    pub fn cancel_subscription(ctx: Context<SubscriberAction>) -> Result<()> {
        let subscription = &mut ctx.accounts.subscription;

        require!(
            subscription.status != SubscriptionStatus::Cancelled,
            SubscriptionError::AlreadyCancelled
        );

        subscription.status = SubscriptionStatus::Cancelled;

        emit!(SubscriptionCancelled {
            subscription: subscription.key(),
            subscriber: subscription.subscriber,
            merchant: subscription.merchant,
            payments_made: subscription.payments_made,
            total_paid: subscription.total_paid,
        });

        Ok(())
    }

    /// Update privacy settings (subscriber only)
    pub fn update_privacy_settings(
        ctx: Context<SubscriberAction>,
        amount_noise: u8,
        timing_noise: u8,
        use_stealth_address: bool,
    ) -> Result<()> {
        require!(amount_noise <= 20, SubscriptionError::InvalidAmountNoise);
        require!(timing_noise <= 24, SubscriptionError::InvalidTimingNoise);

        let subscription = &mut ctx.accounts.subscription;

        subscription.amount_noise = amount_noise;
        subscription.timing_noise = timing_noise;
        subscription.use_stealth_address = use_stealth_address;

        emit!(PrivacySettingsUpdated {
            subscription: subscription.key(),
            amount_noise,
            timing_noise,
            use_stealth_address,
        });

        Ok(())
    }

    /// Close subscription account and reclaim rent (subscriber only)
    ///
    /// Only possible for cancelled or completed subscriptions.
    pub fn close_subscription(ctx: Context<CloseSubscription>) -> Result<()> {
        let subscription = &ctx.accounts.subscription;

        require!(
            subscription.status == SubscriptionStatus::Cancelled
                || subscription.status == SubscriptionStatus::Completed,
            SubscriptionError::CannotCloseActiveSubscription
        );

        emit!(SubscriptionClosed {
            subscription: subscription.key(),
            subscriber: subscription.subscriber,
        });

        Ok(())
    }
}

// ============ Account Contexts ============

#[derive(Accounts)]
#[instruction(subscription_id: String)]
pub struct CreateSubscription<'info> {
    #[account(mut)]
    pub subscriber: Signer<'info>,

    /// CHECK: Merchant can be any account
    pub merchant: AccountInfo<'info>,

    /// CHECK: Token mint
    pub mint: AccountInfo<'info>,

    #[account(
        init,
        payer = subscriber,
        space = 8 + Subscription::INIT_SPACE,
        seeds = [
            b"subscription",
            subscriber.key().as_ref(),
            merchant.key().as_ref(),
            subscription_id.as_bytes()
        ],
        bump
    )]
    pub subscription: Account<'info, Subscription>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProcessPayment<'info> {
    /// The subscriber must sign to authorize the transfer
    pub subscriber: Signer<'info>,

    /// Merchant or authorized crank can trigger the payment
    pub payment_authority: Signer<'info>,

    #[account(
        mut,
        constraint = subscription.merchant == payment_authority.key() @ SubscriptionError::UnauthorizedPaymentAuthority,
        seeds = [
            b"subscription",
            subscription.subscriber.as_ref(),
            subscription.merchant.as_ref(),
            subscription.subscription_id.as_bytes()
        ],
        bump = subscription.bump
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(
        mut,
        constraint = subscriber_token_account.owner == subscriber.key() @ SubscriptionError::InvalidTokenAccount,
        constraint = subscriber_token_account.mint == subscription.mint @ SubscriptionError::InvalidMint
    )]
    pub subscriber_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = merchant_token_account.owner == subscription.merchant @ SubscriptionError::InvalidTokenAccount,
        constraint = merchant_token_account.mint == subscription.mint @ SubscriptionError::InvalidMint
    )]
    pub merchant_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SubscriberAction<'info> {
    pub subscriber: Signer<'info>,

    #[account(
        mut,
        constraint = subscription.subscriber == subscriber.key() @ SubscriptionError::UnauthorizedSubscriber,
        seeds = [
            b"subscription",
            subscription.subscriber.as_ref(),
            subscription.merchant.as_ref(),
            subscription.subscription_id.as_bytes()
        ],
        bump = subscription.bump
    )]
    pub subscription: Account<'info, Subscription>,
}

#[derive(Accounts)]
pub struct CloseSubscription<'info> {
    #[account(mut)]
    pub subscriber: Signer<'info>,

    #[account(
        mut,
        close = subscriber,
        constraint = subscription.subscriber == subscriber.key() @ SubscriptionError::UnauthorizedSubscriber,
        seeds = [
            b"subscription",
            subscription.subscriber.as_ref(),
            subscription.merchant.as_ref(),
            subscription.subscription_id.as_bytes()
        ],
        bump = subscription.bump
    )]
    pub subscription: Account<'info, Subscription>,
}

// ============ State ============

#[account]
#[derive(InitSpace)]
pub struct Subscription {
    /// The subscriber (payer) who authorized this subscription
    pub subscriber: Pubkey,

    /// The merchant (recipient) who receives payments
    pub merchant: Pubkey,

    /// Token mint (SOL represented as system program)
    pub mint: Pubkey,

    /// Unique subscription ID (from dApp)
    #[max_len(64)]
    pub subscription_id: String,

    /// Human-readable name
    #[max_len(32)]
    pub subscription_name: String,

    /// Maximum amount per payment period (in token smallest units)
    pub amount_per_period: u64,

    /// Minimum seconds between payments
    pub interval_seconds: i64,

    /// Maximum number of payments (0 = unlimited)
    pub max_payments: u64,

    /// Number of payments already processed
    pub payments_made: u64,

    /// Total amount paid so far
    pub total_paid: u64,

    /// Timestamp when subscription was created
    pub created_at: i64,

    /// Timestamp of last payment
    pub last_payment_at: i64,

    /// Timestamp when next payment is allowed
    pub next_payment_due: i64,

    /// Current status
    pub status: SubscriptionStatus,

    /// Privacy: amount variation percentage (0-20)
    pub amount_noise: u8,

    /// Privacy: timing variation hours (0-24)
    pub timing_noise: u8,

    /// Privacy: use stealth addresses
    pub use_stealth_address: bool,

    /// PDA bump
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum SubscriptionStatus {
    Active,
    Paused,
    Cancelled,
    Completed,
}

// ============ Errors ============

#[error_code]
pub enum SubscriptionError {
    #[msg("Subscription ID too long - max 64 characters")]
    IdTooLong,

    #[msg("Invalid amount - must be greater than 0")]
    InvalidAmount,

    #[msg("Invalid interval - must be at least 60 seconds")]
    InvalidInterval,

    #[msg("Subscription name too long - max 32 characters")]
    NameTooLong,

    #[msg("Amount noise must be 0-20%")]
    InvalidAmountNoise,

    #[msg("Timing noise must be 0-24 hours")]
    InvalidTimingNoise,

    #[msg("Subscription is not active")]
    SubscriptionNotActive,

    #[msg("Subscription is not paused")]
    SubscriptionNotPaused,

    #[msg("Subscription is already cancelled")]
    AlreadyCancelled,

    #[msg("Payment requested too early - interval not elapsed")]
    PaymentTooEarly,

    #[msg("Payment amount exceeds authorized limit")]
    AmountExceedsLimit,

    #[msg("Maximum number of payments reached")]
    MaxPaymentsReached,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("Unauthorized - only subscriber can perform this action")]
    UnauthorizedSubscriber,

    #[msg("Unauthorized - only merchant can trigger payments")]
    UnauthorizedPaymentAuthority,

    #[msg("Invalid token account")]
    InvalidTokenAccount,

    #[msg("Invalid token mint")]
    InvalidMint,

    #[msg("Cannot close an active subscription")]
    CannotCloseActiveSubscription,
}

// ============ Events ============

#[event]
pub struct SubscriptionCreated {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
    pub merchant: Pubkey,
    pub subscription_id: String,
    pub amount_per_period: u64,
    pub interval_seconds: i64,
    pub max_payments: u64,
}

#[event]
pub struct PaymentProcessed {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub payment_number: u64,
    pub total_paid: u64,
}

#[event]
pub struct SubscriptionPaused {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
}

#[event]
pub struct SubscriptionResumed {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
}

#[event]
pub struct SubscriptionCancelled {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
    pub merchant: Pubkey,
    pub payments_made: u64,
    pub total_paid: u64,
}

#[event]
pub struct PrivacySettingsUpdated {
    pub subscription: Pubkey,
    pub amount_noise: u8,
    pub timing_noise: u8,
    pub use_stealth_address: bool,
}

#[event]
pub struct SubscriptionClosed {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
}
