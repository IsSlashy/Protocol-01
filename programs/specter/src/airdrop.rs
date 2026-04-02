use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

// =============================================================================
// Errors
// =============================================================================

#[error_code]
pub enum AirdropError {
    #[msg("Invalid Merkle proof")]
    InvalidMerkleProof,
    #[msg("Airdrop already claimed")]
    AlreadyClaimed,
    #[msg("Campaign expired")]
    CampaignExpired,
    #[msg("Campaign not expired yet")]
    CampaignNotExpired,
    #[msg("Campaign not active")]
    CampaignNotActive,
    #[msg("Invalid expiry window")]
    InvalidExpiryWindow,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Proof length mismatch")]
    ProofLengthMismatch,
    #[msg("Unauthorized")]
    Unauthorized,
}

// =============================================================================
// Constants
// =============================================================================

/// Minimum campaign duration: 1 hour
const MIN_EXPIRY_SECONDS: i64 = 3_600;

/// Maximum campaign duration: 365 days
const MAX_EXPIRY_SECONDS: i64 = 365 * 24 * 3_600;

/// Maximum Merkle proof depth (2^26 > 67M recipients)
const MAX_PROOF_DEPTH: usize = 26;

// =============================================================================
// State
// =============================================================================

/// An escrow-backed airdrop campaign with a committed Merkle root.
///
/// The recipient list is NEVER stored on-chain. The creator publishes the
/// Merkle root and escrows tokens; recipients prove inclusion via SHA-256
/// Merkle proofs at claim time.
///
/// Seeds: `["airdrop", creator, campaign_nonce]`
#[account]
pub struct AirdropCampaign {
    /// Creator who funded the airdrop
    pub creator: Pubkey,
    /// Token mint being airdropped
    pub token_mint: Pubkey,
    /// SHA-256 Merkle root of all recipient leaves
    pub merkle_root: [u8; 32],
    /// Total amount escrowed
    pub total_amount: u64,
    /// Number of recipients who have claimed
    pub claimed_count: u32,
    /// Total number of recipients
    pub total_recipients: u32,
    /// Escrow token account (PDA-owned)
    pub escrow: Pubkey,
    /// Campaign creation timestamp
    pub created_at: i64,
    /// Campaign expiry timestamp
    pub expires_at: i64,
    /// Campaign name (max 32 bytes, UTF-8 padded with zeroes)
    pub name: [u8; 32],
    /// Whether campaign is active
    pub is_active: bool,
    /// PDA bump
    pub bump: u8,
    /// Escrow bump
    pub escrow_bump: u8,
}

impl AirdropCampaign {
    /// 8 (discriminator) + 32 + 32 + 32 + 8 + 4 + 4 + 32 + 8 + 8 + 32 + 1 + 1 + 1 = 203
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 4 + 4 + 32 + 8 + 8 + 32 + 1 + 1 + 1;

    pub const SEED_PREFIX: &'static [u8] = b"airdrop";
    pub const ESCROW_SEED: &'static [u8] = b"airdrop_escrow";
    pub const ESCROW_AUTH_SEED: &'static [u8] = b"airdrop_escrow_auth";
}

/// Nullifier PDA that prevents double-claims.
///
/// One is created per (campaign, leaf) pair when a recipient claims.
///
/// Seeds: `["airdrop_nullifier", campaign, nullifier_bytes]`
#[account]
pub struct AirdropNullifier {
    /// Which campaign this nullifier belongs to
    pub campaign: Pubkey,
    /// The nullifier hash (SHA-256 of leaf || leaf_index)
    pub nullifier: [u8; 32],
    /// Who claimed
    pub claimer: Pubkey,
    /// When claimed
    pub claimed_at: i64,
    /// PDA bump
    pub bump: u8,
}

impl AirdropNullifier {
    /// 8 (discriminator) + 32 + 32 + 32 + 8 + 1 = 113
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 1;

    pub const SEED_PREFIX: &'static [u8] = b"airdrop_nullifier";
}

// =============================================================================
// Events
// =============================================================================

#[event]
pub struct AirdropCreated {
    pub campaign: Pubkey,
    pub creator: Pubkey,
    pub token_mint: Pubkey,
    pub merkle_root: [u8; 32],
    pub total_amount: u64,
    pub total_recipients: u32,
    pub expires_at: i64,
}

#[event]
pub struct AirdropClaimed {
    pub campaign: Pubkey,
    pub claimer: Pubkey,
    pub amount: u64,
    pub leaf_index: u32,
    pub claimed_count: u32,
}

#[event]
pub struct AirdropClosed {
    pub campaign: Pubkey,
    pub creator: Pubkey,
    pub unclaimed_amount: u64,
    pub claimed_count: u32,
}

// =============================================================================
// Merkle proof verification (SHA-256)
// =============================================================================

/// Verify a SHA-256 Merkle proof against an expected root.
///
/// `indices[i] == 0` means `current` is the LEFT child; the sibling is RIGHT.
/// `indices[i] == 1` means `current` is the RIGHT child; the sibling is LEFT.
fn verify_merkle_proof(
    leaf: [u8; 32],
    proof: &[[u8; 32]],
    indices: &[u8],
    root: [u8; 32],
) -> bool {
    let mut current = leaf;
    for (i, sibling) in proof.iter().enumerate() {
        current = if indices[i] == 0 {
            // current is left child
            hashv(&[&current, sibling]).to_bytes()
        } else {
            // current is right child
            hashv(&[sibling, &current]).to_bytes()
        };
    }
    current == root
}

/// Compute the leaf hash: SHA-256(recipient_pubkey || amount_le || salt)
fn compute_leaf(recipient: &Pubkey, amount: u64, salt: &[u8; 32]) -> [u8; 32] {
    hashv(&[
        recipient.as_ref(),
        &amount.to_le_bytes(),
        salt,
    ])
    .to_bytes()
}

/// Compute the nullifier: SHA-256(leaf || leaf_index_le)
fn compute_nullifier(leaf: &[u8; 32], leaf_index: u32) -> [u8; 32] {
    hashv(&[leaf, &leaf_index.to_le_bytes()]).to_bytes()
}

// =============================================================================
// Instruction: create_airdrop
// =============================================================================

/// Creates a new Merkle-based private airdrop campaign.
///
/// The creator commits a SHA-256 Merkle root and escrows SPL tokens into a
/// PDA-owned token account. No recipient data is stored on-chain.
#[derive(Accounts)]
#[instruction(
    merkle_root: [u8; 32],
    total_amount: u64,
    total_recipients: u32,
    name: [u8; 32],
    expires_in_seconds: i64,
    campaign_nonce: [u8; 16],
)]
pub struct CreateAirdrop<'info> {
    /// The creator funding the airdrop
    #[account(mut)]
    pub creator: Signer<'info>,

    /// The campaign PDA
    #[account(
        init,
        payer = creator,
        space = AirdropCampaign::LEN,
        seeds = [
            AirdropCampaign::SEED_PREFIX,
            creator.key().as_ref(),
            &campaign_nonce,
        ],
        bump,
    )]
    pub campaign: Account<'info, AirdropCampaign>,

    /// PDA-owned escrow token account
    #[account(
        init,
        payer = creator,
        token::mint = token_mint,
        token::authority = escrow_authority,
        seeds = [
            AirdropCampaign::ESCROW_SEED,
            campaign.key().as_ref(),
        ],
        bump,
    )]
    pub escrow: Account<'info, TokenAccount>,

    /// Escrow authority PDA (signs transfers out of escrow)
    /// CHECK: PDA used only as token authority; no data stored
    #[account(
        seeds = [
            AirdropCampaign::ESCROW_AUTH_SEED,
            campaign.key().as_ref(),
        ],
        bump,
    )]
    pub escrow_authority: AccountInfo<'info>,

    /// Token mint being airdropped
    /// CHECK: Validated by the token::mint constraint on escrow init
    pub token_mint: AccountInfo<'info>,

    /// Creator's source token account
    #[account(
        mut,
        constraint = creator_token_account.owner == creator.key() @ AirdropError::Unauthorized,
        constraint = creator_token_account.mint == token_mint.key() @ AirdropError::InvalidAmount,
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    /// Token program
    pub token_program: Program<'info, Token>,

    /// System program
    pub system_program: Program<'info, System>,

    /// Rent sysvar (required for init token account)
    pub rent: Sysvar<'info, Rent>,
}

/// Handler for create_airdrop instruction
pub fn handler_create_airdrop(
    ctx: Context<CreateAirdrop>,
    merkle_root: [u8; 32],
    total_amount: u64,
    total_recipients: u32,
    name: [u8; 32],
    expires_in_seconds: i64,
    _campaign_nonce: [u8; 16],
) -> Result<()> {
    // ── Validation ──────────────────────────────────────────────────────

    require!(total_amount > 0, AirdropError::InvalidAmount);
    require!(total_recipients > 0, AirdropError::InvalidAmount);
    require!(
        expires_in_seconds >= MIN_EXPIRY_SECONDS && expires_in_seconds <= MAX_EXPIRY_SECONDS,
        AirdropError::InvalidExpiryWindow
    );
    require!(
        ctx.accounts.creator_token_account.amount >= total_amount,
        AirdropError::InvalidAmount
    );

    // ── Transfer tokens to escrow ───────────────────────────────────────

    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.creator_token_account.to_account_info(),
            to: ctx.accounts.escrow.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, total_amount)?;

    // ── Initialize campaign ─────────────────────────────────────────────

    let clock = Clock::get()?;
    let created_at = clock.unix_timestamp;
    let expires_at = created_at
        .checked_add(expires_in_seconds)
        .ok_or(error!(AirdropError::InvalidExpiryWindow))?;

    let campaign = &mut ctx.accounts.campaign;
    campaign.creator = ctx.accounts.creator.key();
    campaign.token_mint = ctx.accounts.token_mint.key();
    campaign.merkle_root = merkle_root;
    campaign.total_amount = total_amount;
    campaign.claimed_count = 0;
    campaign.total_recipients = total_recipients;
    campaign.escrow = ctx.accounts.escrow.key();
    campaign.created_at = created_at;
    campaign.expires_at = expires_at;
    campaign.name = name;
    campaign.is_active = true;
    campaign.bump = ctx.bumps.campaign;
    campaign.escrow_bump = ctx.bumps.escrow_authority;

    // ── Emit event ──────────────────────────────────────────────────────

    emit!(AirdropCreated {
        campaign: campaign.key(),
        creator: campaign.creator,
        token_mint: campaign.token_mint,
        merkle_root,
        total_amount,
        total_recipients,
        expires_at,
    });

    msg!("Stealth airdrop created");
    msg!("Campaign: {}", campaign.key());
    msg!("Escrow: {}", ctx.accounts.escrow.key());
    msg!("Total amount: {}", total_amount);
    msg!("Recipients: {}", total_recipients);
    msg!("Expires at: {}", expires_at);

    Ok(())
}

// =============================================================================
// Instruction: claim_airdrop
// =============================================================================

/// Claim tokens from a Merkle-based private airdrop.
///
/// The claimer provides their allocation amount, a random salt, their leaf
/// index, and a SHA-256 Merkle proof. The program:
///
/// 1. Recomputes the leaf: `SHA-256(claimer || amount || salt)`
/// 2. Verifies the Merkle proof against the campaign's committed root
/// 3. Computes a nullifier: `SHA-256(leaf || leaf_index)` to prevent
///    double-claims (the nullifier PDA init will fail if it already exists)
/// 4. Transfers `amount` from the escrow to the claimer
#[derive(Accounts)]
#[instruction(
    amount: u64,
    salt: [u8; 32],
    leaf_index: u32,
    proof_elements: Vec<[u8; 32]>,
    proof_indices: Vec<u8>,
)]
pub struct ClaimAirdrop<'info> {
    /// The recipient claiming the airdrop
    #[account(mut)]
    pub claimer: Signer<'info>,

    /// The airdrop campaign
    #[account(
        mut,
        constraint = campaign.is_active @ AirdropError::CampaignNotActive,
    )]
    pub campaign: Account<'info, AirdropCampaign>,

    /// The nullifier PDA — init will fail if this leaf was already claimed
    #[account(
        init,
        payer = claimer,
        space = AirdropNullifier::LEN,
        seeds = [
            AirdropNullifier::SEED_PREFIX,
            campaign.key().as_ref(),
            &compute_nullifier(
                &compute_leaf(&claimer.key(), amount, &salt),
                leaf_index,
            ),
        ],
        bump,
    )]
    pub nullifier: Account<'info, AirdropNullifier>,

    /// PDA-owned escrow token account
    #[account(
        mut,
        constraint = escrow.key() == campaign.escrow @ AirdropError::Unauthorized,
    )]
    pub escrow: Account<'info, TokenAccount>,

    /// Escrow authority PDA (signs transfers out of escrow)
    /// CHECK: PDA authority validated by seeds
    #[account(
        seeds = [
            AirdropCampaign::ESCROW_AUTH_SEED,
            campaign.key().as_ref(),
        ],
        bump = campaign.escrow_bump,
    )]
    pub escrow_authority: AccountInfo<'info>,

    /// Claimer's destination token account
    #[account(
        mut,
        constraint = claimer_token_account.owner == claimer.key() @ AirdropError::Unauthorized,
        constraint = claimer_token_account.mint == campaign.token_mint @ AirdropError::InvalidAmount,
    )]
    pub claimer_token_account: Account<'info, TokenAccount>,

    /// Token program
    pub token_program: Program<'info, Token>,

    /// System program
    pub system_program: Program<'info, System>,
}

/// Handler for claim_airdrop instruction
pub fn handler_claim_airdrop(
    ctx: Context<ClaimAirdrop>,
    amount: u64,
    salt: [u8; 32],
    leaf_index: u32,
    proof_elements: Vec<[u8; 32]>,
    proof_indices: Vec<u8>,
) -> Result<()> {
    let campaign = &ctx.accounts.campaign;

    // ── Validation ──────────────────────────────────────────────────────

    require!(amount > 0, AirdropError::InvalidAmount);
    require!(
        proof_elements.len() == proof_indices.len(),
        AirdropError::ProofLengthMismatch
    );
    require!(
        proof_elements.len() <= MAX_PROOF_DEPTH,
        AirdropError::ProofLengthMismatch
    );

    // Check expiry
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < campaign.expires_at,
        AirdropError::CampaignExpired
    );

    // ── Compute leaf and verify Merkle proof ────────────────────────────

    let leaf = compute_leaf(&ctx.accounts.claimer.key(), amount, &salt);

    require!(
        verify_merkle_proof(leaf, &proof_elements, &proof_indices, campaign.merkle_root),
        AirdropError::InvalidMerkleProof
    );

    // ── Compute nullifier and initialize nullifier PDA ──────────────────
    // The PDA init in the account validation already prevents double-claims.

    let nullifier_hash = compute_nullifier(&leaf, leaf_index);

    let nullifier_account = &mut ctx.accounts.nullifier;
    nullifier_account.campaign = campaign.key();
    nullifier_account.nullifier = nullifier_hash;
    nullifier_account.claimer = ctx.accounts.claimer.key();
    nullifier_account.claimed_at = clock.unix_timestamp;
    nullifier_account.bump = ctx.bumps.nullifier;

    // ── Transfer tokens from escrow to claimer ──────────────────────────

    let campaign_key = ctx.accounts.campaign.key();
    let signer_seeds: &[&[&[u8]]] = &[&[
        AirdropCampaign::ESCROW_AUTH_SEED,
        campaign_key.as_ref(),
        &[campaign.escrow_bump],
    ]];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.escrow.to_account_info(),
            to: ctx.accounts.claimer_token_account.to_account_info(),
            authority: ctx.accounts.escrow_authority.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, amount)?;

    // ── Update campaign state ───────────────────────────────────────────

    let campaign = &mut ctx.accounts.campaign;
    campaign.claimed_count = campaign
        .claimed_count
        .checked_add(1)
        .ok_or(error!(AirdropError::InvalidAmount))?;

    // ── Emit event ──────────────────────────────────────────────────────

    emit!(AirdropClaimed {
        campaign: campaign.key(),
        claimer: ctx.accounts.claimer.key(),
        amount,
        leaf_index,
        claimed_count: campaign.claimed_count,
    });

    msg!("Airdrop claimed");
    msg!("Campaign: {}", campaign.key());
    msg!("Claimer: {}", ctx.accounts.claimer.key());
    msg!("Amount: {}", amount);
    msg!("Leaf index: {}", leaf_index);
    msg!("Claims: {}/{}", campaign.claimed_count, campaign.total_recipients);

    Ok(())
}

// =============================================================================
// Instruction: close_airdrop
// =============================================================================

/// Close an expired airdrop campaign.
///
/// Creator-only. Can only be called after the campaign's `expires_at`
/// timestamp. Transfers any remaining tokens from the escrow back to the
/// creator, closes the escrow token account, and marks the campaign as
/// inactive. The campaign account itself is closed and rent returned.
#[derive(Accounts)]
pub struct CloseAirdrop<'info> {
    /// The creator who funded the airdrop (receives rent + remaining tokens)
    #[account(mut)]
    pub creator: Signer<'info>,

    /// The airdrop campaign to close
    #[account(
        mut,
        close = creator,
        has_one = creator @ AirdropError::Unauthorized,
        has_one = escrow @ AirdropError::Unauthorized,
    )]
    pub campaign: Account<'info, AirdropCampaign>,

    /// PDA-owned escrow token account
    #[account(mut)]
    pub escrow: Account<'info, TokenAccount>,

    /// Escrow authority PDA
    /// CHECK: PDA authority validated by seeds
    #[account(
        seeds = [
            AirdropCampaign::ESCROW_AUTH_SEED,
            campaign.key().as_ref(),
        ],
        bump = campaign.escrow_bump,
    )]
    pub escrow_authority: AccountInfo<'info>,

    /// Creator's token account for reclaiming remaining tokens
    #[account(
        mut,
        constraint = creator_token_account.owner == creator.key() @ AirdropError::Unauthorized,
        constraint = creator_token_account.mint == campaign.token_mint @ AirdropError::InvalidAmount,
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    /// Token program
    pub token_program: Program<'info, Token>,

    /// System program (for closing accounts)
    pub system_program: Program<'info, System>,
}

/// Handler for close_airdrop instruction
pub fn handler_close_airdrop(ctx: Context<CloseAirdrop>) -> Result<()> {
    let campaign = &ctx.accounts.campaign;

    // ── Validation ──────────────────────────────────────────────────────

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= campaign.expires_at,
        AirdropError::CampaignNotExpired
    );

    // ── Transfer remaining tokens back to creator ───────────────────────

    let unclaimed_amount = ctx.accounts.escrow.amount;
    let campaign_key = ctx.accounts.campaign.key();
    let signer_seeds: &[&[&[u8]]] = &[&[
        AirdropCampaign::ESCROW_AUTH_SEED,
        campaign_key.as_ref(),
        &[campaign.escrow_bump],
    ]];

    if unclaimed_amount > 0 {
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.creator_token_account.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, unclaimed_amount)?;
    }

    // ── Close escrow token account (rent → creator) ─────────────────────

    let close_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.creator.to_account_info(),
            authority: ctx.accounts.escrow_authority.to_account_info(),
        },
        signer_seeds,
    );
    token::close_account(close_ctx)?;

    // ── Emit event ──────────────────────────────────────────────────────
    // Note: campaign account is closed by Anchor's `close = creator` after
    // this handler returns, so we emit the event while data is still valid.

    emit!(AirdropClosed {
        campaign: campaign.key(),
        creator: campaign.creator,
        unclaimed_amount,
        claimed_count: campaign.claimed_count,
    });

    msg!("Airdrop closed");
    msg!("Campaign: {}", campaign.key());
    msg!("Unclaimed tokens returned: {}", unclaimed_amount);
    msg!("Total claims: {}/{}", campaign.claimed_count, campaign.total_recipients);

    Ok(())
}
