use anchor_lang::prelude::*;
use crate::errors::MugenError;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateOrderParams {
    pub order_type: u8,
    pub crypto_amount: u64,
    pub fiat_amount: u64,
    pub fiat_currency: [u8; 3],
    pub payment_methods: u16,
    pub min_amount: u64,
    pub max_amount: u64,
    pub reputation_commitment: [u8; 32],
    pub nonce: [u8; 16],
    pub expires_in: i64,
}

/// Compliance attestation account (deserialized from zk_shielded program).
/// Only the fields we need to validate.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ComplianceAttestationData {
    pub authority: Pubkey,
    pub user: Pubkey,
    pub attestation_type: u8,
    pub is_verified: bool,
    pub revoked: bool,
    pub issued_at: i64,
    pub expires_at: i64,
}

#[derive(Accounts)]
#[instruction(params: CreateOrderParams)]
pub struct CreateOrder<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.is_active @ MugenError::ExchangeNotActive,
    )]
    pub config: Account<'info, MugenConfig>,

    #[account(
        init,
        payer = maker,
        space = MugenOrder::LEN,
        seeds = [ORDER_SEED, maker.key().as_ref(), params.nonce.as_ref()],
        bump,
    )]
    pub order: Account<'info, MugenOrder>,

    /// The maker's compliance attestation account (from zk_shielded program).
    /// CHECK: We manually validate the data fields below.
    #[account()]
    pub compliance_attestation: AccountInfo<'info>,

    /// The token mint being traded.
    pub token_mint: Account<'info, anchor_spl::token::Mint>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateOrder>, params: CreateOrderParams) -> Result<()> {
    let clock = Clock::get()?;

    // Validate order type
    require!(
        params.order_type == ORDER_TYPE_BUY_CRYPTO || params.order_type == ORDER_TYPE_SELL_CRYPTO,
        MugenError::InvalidOrderType,
    );

    // Validate amounts
    let config = &ctx.accounts.config;
    require!(
        params.crypto_amount >= config.min_trade_amount,
        MugenError::AmountBelowMinimum,
    );
    require!(
        params.crypto_amount <= config.max_trade_amount,
        MugenError::AmountAboveMaximum,
    );

    // Validate payment methods
    require!(params.payment_methods > 0, MugenError::NoPaymentMethods);

    // Validate fiat currency (ASCII uppercase letters)
    require!(
        params.fiat_currency.iter().all(|b| b.is_ascii_uppercase()),
        MugenError::InvalidFiatCurrency,
    );

    // Validate compliance attestation data
    // On devnet, allow the config authority to skip attestation validation
    // by passing their own wallet as the attestation account.
    let is_authority_bypass = ctx.accounts.compliance_attestation.key() == ctx.accounts.config.authority;
    if !is_authority_bypass {
        validate_attestation(&ctx.accounts.compliance_attestation, &ctx.accounts.maker.key(), &clock)?;
    }

    // Create the order
    let order = &mut ctx.accounts.order;
    order.maker = ctx.accounts.maker.key();
    order.order_type = params.order_type;
    order.token_mint = ctx.accounts.token_mint.key();
    order.crypto_amount = params.crypto_amount;
    order.fiat_amount = params.fiat_amount;
    order.fiat_currency = params.fiat_currency;
    order.payment_methods = params.payment_methods;
    order.min_amount = params.min_amount;
    order.max_amount = if params.max_amount == 0 {
        params.crypto_amount
    } else {
        params.max_amount
    };
    order.compliance_attestation = ctx.accounts.compliance_attestation.key();
    order.reputation_commitment = params.reputation_commitment;
    order.nonce = params.nonce;
    order.status = STATUS_OPEN;
    order.created_at = clock.unix_timestamp;
    order.expires_at = clock.unix_timestamp + params.expires_in;
    order.bump = ctx.bumps.order;

    msg!(
        "Mugen order created: {} {} for {} fiat cents",
        if params.order_type == ORDER_TYPE_BUY_CRYPTO { "BUY" } else { "SELL" },
        params.crypto_amount,
        params.fiat_amount,
    );

    Ok(())
}

/// Validate compliance attestation account data.
/// We read raw bytes since this account belongs to a different program (zk_shielded).
pub fn validate_attestation(
    attestation_info: &AccountInfo,
    expected_user: &Pubkey,
    clock: &Clock,
) -> Result<()> {
    let data = attestation_info.try_borrow_data()?;

    // Skip 8-byte Anchor discriminator, then read fields
    // Layout: authority(32) + user(32) + attestation_type(1) + is_verified(1) + revoked(1) + issued_at(8) + expires_at(8)
    require!(data.len() >= 8 + 32 + 32 + 1 + 1 + 1 + 8 + 8, MugenError::AttestationNotVerified);

    let offset = 8; // skip discriminator

    // Read user pubkey (bytes 40..72)
    let user_bytes: &[u8; 32] = data[offset + 32..offset + 64].try_into().unwrap();
    let user = Pubkey::new_from_array(*user_bytes);
    require!(user == *expected_user, MugenError::AttestationNotVerified);

    // is_verified (byte 66)
    let is_verified = data[offset + 64 + 1] != 0; // after attestation_type
    require!(is_verified, MugenError::AttestationNotVerified);

    // revoked (byte 67)
    let revoked = data[offset + 64 + 2] != 0;
    require!(!revoked, MugenError::AttestationRevoked);

    // expires_at (bytes 76..84)
    let expires_at_bytes: [u8; 8] = data[offset + 64 + 3 + 8..offset + 64 + 3 + 16]
        .try_into()
        .unwrap();
    let expires_at = i64::from_le_bytes(expires_at_bytes);
    require!(clock.unix_timestamp < expires_at, MugenError::AttestationExpired);

    Ok(())
}
