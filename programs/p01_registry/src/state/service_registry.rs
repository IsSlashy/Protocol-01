use anchor_lang::prelude::*;

/// Maximum slug length (UTF-8 bytes). Used as PDA seed, so capped at 32.
pub const MAX_SLUG_LEN: usize = 32;

/// Maximum service display name (e.g. "Netflix Premium").
pub const MAX_SERVICE_NAME_LEN: usize = 32;

/// Maximum icon key. Either a local asset identifier ("netflix", "spotify")
/// or a short URL fragment the app maps to an icon asset.
pub const MAX_ICON_KEY_LEN: usize = 32;

/// Maximum service category ("streaming", "music", "saas", "news", ...).
pub const MAX_CATEGORY_LEN: usize = 24;

/// Maximum off-chain metadata URI (IPFS, HTTPS, Arweave, etc.).
pub const MAX_METADATA_URI_LEN: usize = 128;

/// Protocol authority that can flip the `verified` flag on a service.
/// Hardcoded at the program level so merchants cannot self-attest.
///
/// Base58: `7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU` (Slashy dev key).
/// TODO: replace with governance-managed key once Protocol 01 DAO exists.
pub const PROTOCOL_VERIFIED_AUTHORITY: Pubkey = Pubkey::new_from_array([
    99, 69, 127, 195, 235, 164, 14, 105, 19, 156, 234, 160, 170, 25, 150, 164,
    157, 233, 174, 53, 55, 22, 62, 22, 176, 184, 66, 218, 216, 221, 98, 215,
]);

/// Service registry entry — an on-chain record describing a subscription-
/// accepting merchant (Netflix, Spotify, a self-hosted SaaS, etc.).
///
/// Any wallet can register as a merchant. The `verified` flag is set by
/// the protocol authority after off-chain review and signals trust to
/// end users; unverified services can still be shown in the app behind a
/// filter.
///
/// # PDA seeds
///   `["service", owner, slug]`
///
/// One wallet may register multiple services (distinct slugs), e.g. a
/// single merchant wallet shipping both "Netflix Standard" and
/// "Netflix Premium".
///
/// # Account size breakdown
///   discriminator              8
///   owner                     32
///   retailer                  32
///   token_mint                32
///   price_atomic               8
///   interval_slots             8
///   subscriber_count           8
///   supports_oneshot           1
///   supports_vault             1
///   verified                   1
///   active                     1
///   bump                       1
///   created_at                 8
///   updated_at                 8
///   slug_len                   4
///   slug                      32
///   name_len                   4
///   name                      32
///   icon_len                   4
///   icon_key                  32
///   category_len               4
///   category                  24
///   metadata_uri_len           4
///   metadata_uri             128
///   ───────────────────────────
///   total                    385 bytes
#[account]
pub struct ServiceRegistry {
    /// Wallet that registered the service. Controls updates/deactivation.
    pub owner: Pubkey,

    /// Pubkey that receives payments for this service. Can differ from
    /// `owner` (e.g. a cold wallet or multisig).
    pub retailer: Pubkey,

    /// Token mint used for pricing. `System Program` (`11111111...`)
    /// denotes native SOL.
    pub token_mint: Pubkey,

    /// Price per billing period in the smallest unit of `token_mint`
    /// (lamports for SOL, 1e6 units for USDC devnet).
    pub price_atomic: u64,

    /// Billing period expressed in Solana slots (~0.4s each).
    /// 7 200 ≈ 48 min, 216 000 ≈ 1 day, 1 500 000 ≈ 1 week.
    pub interval_slots: u64,

    /// Informational counter — bumped by the merchant SDK / UI after
    /// a successful subscription. Not enforced by the program.
    pub subscriber_count: u64,

    /// Whether the service accepts one-shot unshield payments.
    pub supports_oneshot: bool,

    /// Whether the service accepts subscription vault flow (recurring,
    /// retailer-pullable).
    pub supports_vault: bool,

    /// Whether the protocol authority has attested this service.
    /// Unverified services still appear but should be rendered with a
    /// "caveat emptor" badge client-side.
    pub verified: bool,

    /// Whether the service is currently accepting new subscriptions.
    /// Owner can flip this to pause listing without closing the PDA.
    pub active: bool,

    /// PDA bump seed.
    pub bump: u8,

    /// Unix timestamp (seconds) of registration.
    pub created_at: i64,

    /// Unix timestamp of last update.
    pub updated_at: i64,

    /// Short URL-safe identifier, unique per `owner`.
    /// Max 32 bytes (PDA seed limit).
    pub slug: String,

    /// Display name shown in the subscriber UI.
    pub name: String,

    /// Icon identifier (app-local asset name or short URL fragment).
    pub icon_key: String,

    /// High-level category for filtering/search.
    pub category: String,

    /// Off-chain metadata URI with extended description, T&Cs, etc.
    pub metadata_uri: String,
}

impl ServiceRegistry {
    /// Account space.
    /// 8 disc + 32*3 pubkeys + 8*3 u64 + 4 bools + 1 bump + 8*2 i64
    /// + (4+32)*3 short strings + (4+24) + (4+128)
    pub const SIZE: usize = 8
        + 32 * 3
        + 8 * 3
        + 4
        + 1
        + 8 * 2
        + (4 + MAX_SLUG_LEN)
        + (4 + MAX_SERVICE_NAME_LEN)
        + (4 + MAX_ICON_KEY_LEN)
        + (4 + MAX_CATEGORY_LEN)
        + (4 + MAX_METADATA_URI_LEN);

    pub const SEED_PREFIX: &'static [u8] = b"service";
}
