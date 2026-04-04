use anchor_lang::prelude::*;

#[error_code]
pub enum MugenError {
    // ── Config ──────────────────────────────────────────────────────────
    #[msg("Exchange is not active")]
    ExchangeNotActive,

    #[msg("Invalid fee basis points (max 1000 = 10%)")]
    InvalidFeeBps,

    #[msg("Invalid trade amount limits")]
    InvalidTradeLimits,

    // ── Orders ──────────────────────────────────────────────────────────
    #[msg("Order is not open")]
    OrderNotOpen,

    #[msg("Order has expired")]
    OrderExpired,

    #[msg("Order type invalid (0 = buy_crypto, 1 = sell_crypto)")]
    InvalidOrderType,

    #[msg("Trade amount below minimum")]
    AmountBelowMinimum,

    #[msg("Trade amount above maximum")]
    AmountAboveMaximum,

    #[msg("No payment methods specified")]
    NoPaymentMethods,

    #[msg("Invalid fiat currency code")]
    InvalidFiatCurrency,

    #[msg("Cannot take own order")]
    CannotTakeOwnOrder,

    // ── Escrow ──────────────────────────────────────────────────────────
    #[msg("Escrow is not in awaiting_payment status")]
    EscrowNotAwaitingPayment,

    #[msg("Escrow is not in payment_confirmed status")]
    EscrowNotPaymentConfirmed,

    #[msg("Escrow has expired")]
    EscrowExpired,

    #[msg("Escrow has not expired yet")]
    EscrowNotExpired,

    #[msg("Escrow is not disputable in current status")]
    EscrowNotDisputable,

    #[msg("Escrow is not in disputed status")]
    EscrowNotDisputed,

    #[msg("Invalid dispute resolution outcome")]
    InvalidDisputeOutcome,

    // ── Compliance ──────────────────────────────────────────────────────
    #[msg("Compliance attestation is not verified")]
    AttestationNotVerified,

    #[msg("Compliance attestation has expired")]
    AttestationExpired,

    #[msg("Compliance attestation has been revoked")]
    AttestationRevoked,

    // ── Authorization ───────────────────────────────────────────────────
    #[msg("Unauthorized — not the order maker")]
    UnauthorizedMaker,

    #[msg("Unauthorized — not the escrow buyer")]
    UnauthorizedBuyer,

    #[msg("Unauthorized — not the escrow seller")]
    UnauthorizedSeller,

    #[msg("Unauthorized — not a trade participant")]
    UnauthorizedParticipant,

    #[msg("Unauthorized — not the config authority")]
    UnauthorizedAuthority,

    // ── Math ────────────────────────────────────────────────────────────
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
