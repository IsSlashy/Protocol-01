use anchor_lang::prelude::*;

// ═══════════════════════════════════════════════════════════════════════════════
// PDA SEED PREFIXES
// ═══════════════════════════════════════════════════════════════════════════════

pub const CONFIG_SEED: &[u8] = b"mugen_config";
pub const ORDER_SEED: &[u8] = b"mugen_order";
pub const ESCROW_SEED: &[u8] = b"mugen_escrow";
pub const VAULT_SEED: &[u8] = b"mugen_vault";
pub const REPUTATION_SEED: &[u8] = b"mugen_rep";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/// Default escrow timeout: 1 hour
pub const DEFAULT_ESCROW_TIMEOUT: i64 = 3_600;

/// Default dispute timeout: 24 hours
pub const DEFAULT_DISPUTE_TIMEOUT: i64 = 86_400;

/// Maximum fee in basis points: 10%
pub const MAX_FEE_BPS: u16 = 1_000;

/// Order type: buyer wants to buy crypto with fiat
pub const ORDER_TYPE_BUY_CRYPTO: u8 = 0;

/// Order type: seller wants to sell crypto for fiat
pub const ORDER_TYPE_SELL_CRYPTO: u8 = 1;

/// Payment method bitfield values
pub const PAYMENT_BANK: u16 = 1;
pub const PAYMENT_REVOLUT: u16 = 2;
pub const PAYMENT_WISE: u16 = 4;
pub const PAYMENT_CASH: u16 = 8;
pub const PAYMENT_SEPA: u16 = 16;
pub const PAYMENT_ZELLE: u16 = 32;

/// Order status values
pub const STATUS_OPEN: u8 = 0;
pub const STATUS_IN_ESCROW: u8 = 1;
pub const STATUS_COMPLETED: u8 = 2;
pub const STATUS_CANCELLED: u8 = 3;
pub const STATUS_DISPUTED: u8 = 4;
pub const STATUS_EXPIRED: u8 = 5;

/// Escrow status values
pub const ESCROW_AWAITING_PAYMENT: u8 = 0;
pub const ESCROW_PAYMENT_CONFIRMED: u8 = 1;
pub const ESCROW_RELEASED: u8 = 2;
pub const ESCROW_DISPUTED: u8 = 3;
pub const ESCROW_REFUNDED: u8 = 4;
pub const ESCROW_EXPIRED: u8 = 5;

/// Dispute resolution outcomes
pub const DISPUTE_RELEASE_TO_BUYER: u8 = 0;
pub const DISPUTE_REFUND_TO_SELLER: u8 = 1;

/// Designated authority allowed to gate `init_reputation`. Only this signer
/// can mint a reputation PDA for a given Poseidon commitment, preventing
/// reputation squatting. Devnet: `7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU`.
pub const REPUTATION_AUTHORITY: Pubkey = Pubkey::new_from_array([
    0x63, 0x45, 0x7f, 0xc3, 0xeb, 0xa4, 0x0e, 0x69,
    0x13, 0x9c, 0xea, 0xa0, 0xaa, 0x19, 0x96, 0xa4,
    0x9d, 0xe9, 0xae, 0x35, 0x37, 0x16, 0x3e, 0x16,
    0xb0, 0xb8, 0x42, 0xda, 0xd8, 0xdd, 0x62, 0xd7,
]);

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNTS
// ═══════════════════════════════════════════════════════════════════════════════

/// Global exchange configuration (singleton PDA).
///
/// Seeds: `["mugen_config"]`
#[account]
pub struct MugenConfig {
    /// Admin authority who can update config and resolve disputes.
    pub authority: Pubkey,

    /// Total protocol fee in basis points (e.g. 150 = 1.5%).
    /// This is split across 3 wallets: P01 + Mugen + Treasury.
    pub fee_bps: u16,

    /// P01 Protocol fee wallet (app, extension, infra revenue).
    pub p01_fee_wallet: Pubkey,

    /// Mugen Exchange fee wallet (exchange operation revenue).
    pub mugen_fee_wallet: Pubkey,

    /// Treasury wallet (DAO / future governance).
    pub treasury_wallet: Pubkey,

    /// P01 share of fees in basis points out of 10000 (e.g. 2000 = 20%).
    pub p01_fee_share: u16,

    /// Mugen share of fees in basis points out of 10000 (e.g. 6500 = 65%).
    pub mugen_fee_share: u16,

    /// Treasury share = 10000 - p01_share - mugen_share - noise_share.
    /// Not stored — computed on-chain as remainder.

    /// Noise fund wallet (auto-feeds noise engine ephemeral wallets).
    pub noise_fund_wallet: Pubkey,

    /// Noise fund share of fees in bps out of 10000 (e.g. 1500 = 15%).
    pub noise_fee_share: u16,

    /// Minimum trade amount in base token units.
    pub min_trade_amount: u64,

    /// Maximum trade amount in base token units.
    pub max_trade_amount: u64,

    /// Escrow timeout in seconds (default: 3600 = 1 hour).
    pub escrow_timeout: i64,

    /// Dispute timeout in seconds (default: 86400 = 24 hours).
    pub dispute_timeout: i64,

    /// Total number of completed trades.
    pub total_trades: u64,

    /// Total volume traded (in lamports/base units).
    pub total_volume: u64,

    /// Total fees collected (in lamports/base units).
    pub total_fees_collected: u64,

    /// Whether the exchange is accepting new orders.
    pub is_active: bool,

    /// PDA bump.
    pub bump: u8,
}

impl MugenConfig {
    /// Account discriminator (8) + fields
    pub const LEN: usize = 8
        + 32        // authority
        + 2          // fee_bps
        + 32         // p01_fee_wallet
        + 32         // mugen_fee_wallet
        + 32         // treasury_wallet
        + 2          // p01_fee_share
        + 2          // mugen_fee_share
        + 32         // noise_fund_wallet
        + 2          // noise_fee_share
        + 8          // min_trade_amount
        + 8          // max_trade_amount
        + 8          // escrow_timeout
        + 8          // dispute_timeout
        + 8          // total_trades
        + 8          // total_volume
        + 8          // total_fees_collected
        + 1          // is_active
        + 1;         // bump
}

/// A P2P buy/sell order listing.
///
/// Seeds: `["mugen_order", maker, nonce]`
#[account]
pub struct MugenOrder {
    /// Order creator's wallet.
    pub maker: Pubkey,

    /// 0 = buy_crypto (fiat→crypto), 1 = sell_crypto (crypto→fiat).
    pub order_type: u8,

    /// Token mint being traded.
    pub token_mint: Pubkey,

    /// Amount of crypto in base units.
    pub crypto_amount: u64,

    /// Fiat price in cents (e.g. 15000 = $150.00).
    pub fiat_amount: u64,

    /// ISO 4217 currency code (e.g. b"USD", b"EUR").
    pub fiat_currency: [u8; 3],

    /// Bitfield of accepted payment methods.
    pub payment_methods: u16,

    /// Minimum partial fill amount (0 = no partial fills).
    pub min_amount: u64,

    /// Maximum fill amount per trade.
    pub max_amount: u64,

    /// Maker's compliance attestation PDA (from zk_shielded).
    pub compliance_attestation: Pubkey,

    /// Poseidon(maker_pubkey, salt) for anonymous reputation.
    pub reputation_commitment: [u8; 32],

    /// Unique 16-byte nonce for PDA derivation.
    pub nonce: [u8; 16],

    /// Order status.
    pub status: u8,

    /// Unix timestamp of creation.
    pub created_at: i64,

    /// Unix timestamp of expiry.
    pub expires_at: i64,

    /// PDA bump.
    pub bump: u8,
}

impl MugenOrder {
    /// Account discriminator (8) + fields
    pub const LEN: usize = 8 + 32 + 1 + 32 + 8 + 8 + 3 + 2 + 8 + 8 + 32 + 32 + 16 + 1 + 8 + 8 + 1;
}

/// Escrow holding crypto during an active trade.
///
/// Seeds: `["mugen_escrow", order, taker]`
#[account]
pub struct MugenEscrow {
    /// The parent order PDA.
    pub order: Pubkey,

    /// The order maker (crypto seller in sell_crypto, buyer in buy_crypto).
    pub maker: Pubkey,

    /// The counterparty who took the order.
    pub taker: Pubkey,

    /// Token mint.
    pub token_mint: Pubkey,

    /// Amount of crypto locked in escrow.
    pub crypto_amount: u64,

    /// Expected fiat amount in cents.
    pub fiat_amount: u64,

    /// PDA token account holding the escrowed crypto.
    pub escrow_vault: Pubkey,

    /// Maker's compliance attestation.
    pub maker_attestation: Pubkey,

    /// Taker's compliance attestation.
    pub taker_attestation: Pubkey,

    /// Optional stealth address for settlement (zero = direct transfer).
    pub stealth_recipient: [u8; 32],

    /// Selected payment method for this trade.
    pub payment_method: u16,

    /// Escrow status.
    pub status: u8,

    /// Unix timestamp of creation.
    pub created_at: i64,

    /// Unix timestamp of expiry.
    pub expires_at: i64,

    /// Unix timestamp when payment was confirmed (0 if not yet).
    pub payment_confirmed_at: i64,

    /// Who initiated the dispute (None if no dispute).
    pub dispute_initiator: Pubkey,

    /// Dispute reason code (0 = none).
    pub dispute_reason: u8,

    /// Buyer's token account bound at escrow creation. Used by `resolve_dispute`
    /// to prevent passing an arbitrary recipient token account.
    pub buyer_token_account: Pubkey,

    /// Seller's token account bound at escrow creation. Used by `resolve_dispute`
    /// and `expire_escrow` to prevent passing an arbitrary recipient token account.
    pub seller_token_account: Pubkey,

    /// Maker reputation snapshot at trade time — prevents race between
    /// reputation updates and escrow finalization.
    pub maker_reputation_snapshot: u64,

    /// Taker reputation snapshot at trade time.
    pub taker_reputation_snapshot: u64,

    /// PDA bump.
    pub bump: u8,

    /// Vault token account bump.
    pub vault_bump: u8,
}

impl MugenEscrow {
    /// Account discriminator (8) + fields
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 32 + 32 + 32 + 32 + 2 + 1 + 8 + 8 + 8 + 32 + 1 + 32 + 32 + 8 + 8 + 1 + 1;
}

/// Anonymous on-chain reputation tied to a Poseidon commitment.
///
/// Seeds: `["mugen_rep", commitment]`
#[account]
pub struct MugenReputation {
    /// Poseidon(pubkey_field, salt) — anonymous, unlinkable.
    pub commitment: [u8; 32],

    /// Number of successfully completed trades.
    pub trades_completed: u32,

    /// Number of disputed trades.
    pub trades_disputed: u32,

    /// Cumulative volume traded (base units).
    pub total_volume: u64,

    /// Average time to confirm payment in seconds.
    pub avg_payment_time: u32,

    /// Positive feedback count.
    pub positive_feedback: u32,

    /// Negative feedback count.
    pub negative_feedback: u32,

    /// Timestamp of first trade.
    pub first_trade_at: i64,

    /// Timestamp of most recent trade.
    pub last_trade_at: i64,

    /// PDA bump.
    pub bump: u8,
}

impl MugenReputation {
    /// Account discriminator (8) + fields
    pub const LEN: usize = 8 + 32 + 4 + 4 + 8 + 4 + 4 + 4 + 8 + 8 + 1;
}
