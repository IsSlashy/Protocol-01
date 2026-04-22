use anchor_lang::prelude::*;

pub mod state;
use state::*;

declare_id!("QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB");

#[program]
pub mod p01_registry {
    use super::*;

    /// Register a v1 stealth meta-address (classical X25519 only).
    ///
    /// Creates a PDA keyed by the owner's wallet address, storing their
    /// spending and viewing public keys. Anyone can look this up to send
    /// the owner a stealth payment.
    pub fn register_v1(
        ctx: Context<Register>,
        spending_pub_key: [u8; 32],
        viewing_pub_key: [u8; 32],
        name: String,
    ) -> Result<()> {
        require!(spending_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(viewing_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(name.len() <= MAX_NAME_LEN, RegistryError::NameTooLong);

        let clock = Clock::get()?;
        let entry = &mut ctx.accounts.entry;
        entry.owner = ctx.accounts.owner.key();
        entry.spending_pub_key = spending_pub_key;
        entry.viewing_pub_key = viewing_pub_key;
        entry.version = 1;
        entry.has_kem_key = false;
        entry.kem_pub_key = [0u8; KEM_PUBKEY_LEN];
        entry.name = name;
        entry.created_at = clock.unix_timestamp;
        entry.updated_at = clock.unix_timestamp;
        entry.bump = ctx.bumps.entry;

        msg!("Registry: v1 meta-address registered for {}", entry.owner);
        Ok(())
    }

    /// Register a v2 stealth meta-address (hybrid X25519 + ML-KEM-768).
    ///
    /// Same as v1 but also stores the ML-KEM-768 public key for
    /// post-quantum-resistant stealth payments.
    pub fn register_v2(
        ctx: Context<Register>,
        spending_pub_key: [u8; 32],
        viewing_pub_key: [u8; 32],
        kem_pub_key: Vec<u8>,
        name: String,
    ) -> Result<()> {
        require!(spending_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(viewing_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(kem_pub_key.len() == KEM_PUBKEY_LEN, RegistryError::InvalidKemKey);
        require!(name.len() <= MAX_NAME_LEN, RegistryError::NameTooLong);

        let clock = Clock::get()?;
        let entry = &mut ctx.accounts.entry;
        entry.owner = ctx.accounts.owner.key();
        entry.spending_pub_key = spending_pub_key;
        entry.viewing_pub_key = viewing_pub_key;
        entry.version = 2;
        entry.has_kem_key = true;

        let mut kem_buf = [0u8; KEM_PUBKEY_LEN];
        kem_buf.copy_from_slice(&kem_pub_key);
        entry.kem_pub_key = kem_buf;

        entry.name = name;
        entry.created_at = clock.unix_timestamp;
        entry.updated_at = clock.unix_timestamp;
        entry.bump = ctx.bumps.entry;

        msg!("Registry: v2 hybrid meta-address registered for {}", entry.owner);
        Ok(())
    }

    /// Update the stealth meta-address keys (v1).
    /// Only the owner can update their own entry.
    pub fn update_keys_v1(
        ctx: Context<UpdateEntry>,
        spending_pub_key: [u8; 32],
        viewing_pub_key: [u8; 32],
    ) -> Result<()> {
        require!(spending_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(viewing_pub_key != [0u8; 32], RegistryError::InvalidKey);

        let entry = &mut ctx.accounts.entry;
        entry.spending_pub_key = spending_pub_key;
        entry.viewing_pub_key = viewing_pub_key;
        entry.version = 1;
        entry.has_kem_key = false;
        entry.kem_pub_key = [0u8; KEM_PUBKEY_LEN];
        entry.updated_at = Clock::get()?.unix_timestamp;

        msg!("Registry: keys updated (v1) for {}", entry.owner);
        Ok(())
    }

    /// Update the stealth meta-address keys (v2 hybrid).
    /// Only the owner can update their own entry.
    pub fn update_keys_v2(
        ctx: Context<UpdateEntry>,
        spending_pub_key: [u8; 32],
        viewing_pub_key: [u8; 32],
        kem_pub_key: Vec<u8>,
    ) -> Result<()> {
        require!(spending_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(viewing_pub_key != [0u8; 32], RegistryError::InvalidKey);
        require!(kem_pub_key.len() == KEM_PUBKEY_LEN, RegistryError::InvalidKemKey);

        let entry = &mut ctx.accounts.entry;
        entry.spending_pub_key = spending_pub_key;
        entry.viewing_pub_key = viewing_pub_key;
        entry.version = 2;
        entry.has_kem_key = true;

        let mut kem_buf = [0u8; KEM_PUBKEY_LEN];
        kem_buf.copy_from_slice(&kem_pub_key);
        entry.kem_pub_key = kem_buf;

        entry.updated_at = Clock::get()?.unix_timestamp;

        msg!("Registry: keys updated (v2) for {}", entry.owner);
        Ok(())
    }

    /// Update the display name.
    pub fn update_name(ctx: Context<UpdateEntry>, name: String) -> Result<()> {
        require!(name.len() <= MAX_NAME_LEN, RegistryError::NameTooLong);

        let entry = &mut ctx.accounts.entry;
        entry.name = name;
        entry.updated_at = Clock::get()?.unix_timestamp;

        msg!("Registry: name updated for {}", entry.owner);
        Ok(())
    }

    /// Close the registry entry and reclaim rent.
    /// Only the owner can delete their own entry.
    pub fn deregister(ctx: Context<Deregister>) -> Result<()> {
        msg!("Registry: entry closed for {}", ctx.accounts.entry.owner);
        Ok(())
    }

    // =========================================================================
    // Service Registry
    // =========================================================================

    /// Register a new service (merchant) in the on-chain service registry.
    ///
    /// Any wallet can register. The `verified` flag starts as `false` and can
    /// only be flipped by the protocol authority via `attest_service`.
    ///
    /// # Arguments
    /// * `slug` — URL-safe identifier, unique per owner (max 32 bytes).
    ///   Used in the PDA seed.
    /// * `name` — Display name (max 32 bytes).
    /// * `icon_key` — Icon identifier (max 32 bytes).
    /// * `category` — Category slug (max 24 bytes).
    /// * `metadata_uri` — Off-chain metadata URI (max 128 bytes, may be empty).
    /// * `retailer` — Pubkey that receives payments.
    /// * `token_mint` — Token mint (System Program ID for native SOL).
    /// * `price_atomic` — Price per period in smallest token unit.
    /// * `interval_slots` — Billing period in Solana slots.
    /// * `supports_oneshot` — Accept one-shot unshield payments.
    /// * `supports_vault` — Accept recurring subscription vaults.
    pub fn register_service(
        ctx: Context<RegisterService>,
        slug: String,
        name: String,
        icon_key: String,
        category: String,
        metadata_uri: String,
        retailer: Pubkey,
        token_mint: Pubkey,
        price_atomic: u64,
        interval_slots: u64,
        supports_oneshot: bool,
        supports_vault: bool,
    ) -> Result<()> {
        require!(!slug.is_empty() && slug.len() <= MAX_SLUG_LEN, RegistryError::InvalidSlug);
        require!(!name.is_empty() && name.len() <= MAX_SERVICE_NAME_LEN, RegistryError::NameTooLong);
        require!(icon_key.len() <= MAX_ICON_KEY_LEN, RegistryError::IconKeyTooLong);
        require!(category.len() <= MAX_CATEGORY_LEN, RegistryError::CategoryTooLong);
        require!(metadata_uri.len() <= MAX_METADATA_URI_LEN, RegistryError::MetadataUriTooLong);
        require!(price_atomic > 0, RegistryError::InvalidPrice);
        require!(interval_slots > 0, RegistryError::InvalidInterval);
        require!(
            supports_oneshot || supports_vault,
            RegistryError::NoPaymentModeSelected
        );

        let clock = Clock::get()?;
        let service = &mut ctx.accounts.service;

        service.owner = ctx.accounts.owner.key();
        service.retailer = retailer;
        service.token_mint = token_mint;
        service.price_atomic = price_atomic;
        service.interval_slots = interval_slots;
        service.subscriber_count = 0;
        service.supports_oneshot = supports_oneshot;
        service.supports_vault = supports_vault;
        service.verified = false;
        service.active = true;
        service.bump = ctx.bumps.service;
        service.created_at = clock.unix_timestamp;
        service.updated_at = clock.unix_timestamp;
        service.slug = slug;
        service.name = name;
        service.icon_key = icon_key;
        service.category = category;
        service.metadata_uri = metadata_uri;

        msg!(
            "ServiceRegistry: '{}' registered by {} (retailer {})",
            service.name,
            service.owner,
            service.retailer,
        );
        Ok(())
    }

    /// Update mutable fields on an existing service. Pass `None` for any
    /// field you do not want to change. `retailer` and `token_mint` are
    /// intentionally immutable — migrating either requires deregistering
    /// and re-registering so subscribers can audit the change.
    #[allow(clippy::too_many_arguments)]
    pub fn update_service(
        ctx: Context<UpdateService>,
        name: Option<String>,
        icon_key: Option<String>,
        category: Option<String>,
        metadata_uri: Option<String>,
        price_atomic: Option<u64>,
        interval_slots: Option<u64>,
        supports_oneshot: Option<bool>,
        supports_vault: Option<bool>,
        active: Option<bool>,
    ) -> Result<()> {
        let service = &mut ctx.accounts.service;

        if let Some(n) = name {
            require!(!n.is_empty() && n.len() <= MAX_SERVICE_NAME_LEN, RegistryError::NameTooLong);
            service.name = n;
        }
        if let Some(i) = icon_key {
            require!(i.len() <= MAX_ICON_KEY_LEN, RegistryError::IconKeyTooLong);
            service.icon_key = i;
        }
        if let Some(c) = category {
            require!(c.len() <= MAX_CATEGORY_LEN, RegistryError::CategoryTooLong);
            service.category = c;
        }
        if let Some(m) = metadata_uri {
            require!(m.len() <= MAX_METADATA_URI_LEN, RegistryError::MetadataUriTooLong);
            service.metadata_uri = m;
        }
        if let Some(p) = price_atomic {
            require!(p > 0, RegistryError::InvalidPrice);
            service.price_atomic = p;
        }
        if let Some(s) = interval_slots {
            require!(s > 0, RegistryError::InvalidInterval);
            service.interval_slots = s;
        }
        if supports_oneshot.is_some() || supports_vault.is_some() {
            let next_one = supports_oneshot.unwrap_or(service.supports_oneshot);
            let next_vault = supports_vault.unwrap_or(service.supports_vault);
            require!(next_one || next_vault, RegistryError::NoPaymentModeSelected);
            service.supports_oneshot = next_one;
            service.supports_vault = next_vault;
        }
        if let Some(a) = active {
            service.active = a;
        }

        service.updated_at = Clock::get()?.unix_timestamp;
        msg!("ServiceRegistry: '{}' updated", service.name);
        Ok(())
    }

    /// Protocol authority attests or revokes verification for a service.
    /// The signer must equal `PROTOCOL_VERIFIED_AUTHORITY`.
    pub fn attest_service(ctx: Context<AttestService>, verified: bool) -> Result<()> {
        let service = &mut ctx.accounts.service;
        service.verified = verified;
        service.updated_at = Clock::get()?.unix_timestamp;

        msg!(
            "ServiceRegistry: '{}' verified={} by protocol authority",
            service.name,
            verified,
        );
        Ok(())
    }

    /// Increment `subscriber_count` — trust-light bookkeeping callable by
    /// the service owner only. The merchant SDK bumps this after a new
    /// subscription is observed (via SubscribePrivateStark event or an
    /// incoming unshield TX with the service's invoice memo). Callers
    /// should not treat the counter as a security-relevant value.
    pub fn bump_subscriber_count(ctx: Context<UpdateService>) -> Result<()> {
        let service = &mut ctx.accounts.service;
        service.subscriber_count = service.subscriber_count.saturating_add(1);
        service.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Close the service PDA and return rent to the owner.
    pub fn deregister_service(ctx: Context<DeregisterService>) -> Result<()> {
        msg!(
            "ServiceRegistry: '{}' deregistered by owner",
            ctx.accounts.service.name,
        );
        Ok(())
    }
}

// ============================================================================
// Accounts
// ============================================================================

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = UserRegistry::SIZE,
        seeds = [UserRegistry::SEED_PREFIX, owner.key().as_ref()],
        bump,
    )]
    pub entry: Account<'info, UserRegistry>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateEntry<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [UserRegistry::SEED_PREFIX, owner.key().as_ref()],
        bump = entry.bump,
        has_one = owner,
    )]
    pub entry: Account<'info, UserRegistry>,
}

#[derive(Accounts)]
pub struct Deregister<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [UserRegistry::SEED_PREFIX, owner.key().as_ref()],
        bump = entry.bump,
        has_one = owner,
        close = owner,
    )]
    pub entry: Account<'info, UserRegistry>,
}

#[derive(Accounts)]
#[instruction(slug: String)]
pub struct RegisterService<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = ServiceRegistry::SIZE,
        seeds = [ServiceRegistry::SEED_PREFIX, owner.key().as_ref(), slug.as_bytes()],
        bump,
    )]
    pub service: Account<'info, ServiceRegistry>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateService<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ServiceRegistry::SEED_PREFIX, owner.key().as_ref(), service.slug.as_bytes()],
        bump = service.bump,
        has_one = owner,
    )]
    pub service: Account<'info, ServiceRegistry>,
}

#[derive(Accounts)]
pub struct AttestService<'info> {
    #[account(
        constraint = authority.key() == PROTOCOL_VERIFIED_AUTHORITY @ RegistryError::NotProtocolAuthority
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub service: Account<'info, ServiceRegistry>,
}

#[derive(Accounts)]
pub struct DeregisterService<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ServiceRegistry::SEED_PREFIX, owner.key().as_ref(), service.slug.as_bytes()],
        bump = service.bump,
        has_one = owner,
        close = owner,
    )]
    pub service: Account<'info, ServiceRegistry>,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum RegistryError {
    #[msg("Key must not be all zeros")]
    InvalidKey,
    #[msg("ML-KEM-768 public key must be exactly 1184 bytes")]
    InvalidKemKey,
    #[msg("Display name exceeds 32 bytes")]
    NameTooLong,
    #[msg("Slug must be 1..=32 bytes")]
    InvalidSlug,
    #[msg("Icon key exceeds 32 bytes")]
    IconKeyTooLong,
    #[msg("Category exceeds 24 bytes")]
    CategoryTooLong,
    #[msg("Metadata URI exceeds 128 bytes")]
    MetadataUriTooLong,
    #[msg("Price must be greater than zero")]
    InvalidPrice,
    #[msg("Interval must be greater than zero slots")]
    InvalidInterval,
    #[msg("Service must accept at least one payment mode")]
    NoPaymentModeSelected,
    #[msg("Signer is not the protocol verification authority")]
    NotProtocolAuthority,
}
