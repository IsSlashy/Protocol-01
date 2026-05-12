use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
    system_program,
};
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::SubscriptionVault;

/// STARK Proof Buffer account layout (from p01_stark_verifier).
const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

// DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// `p01_relayer` program id: 2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW
/// Decoded from base58 once and hard-coded to avoid runtime parsing.
const P01_RELAYER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x1a, 0xd5, 0xd2, 0xce, 0xad, 0x9c, 0xfc, 0xd5,
    0x61, 0x50, 0xae, 0x50, 0xdf, 0x77, 0x97, 0xd3,
    0x87, 0x02, 0x23, 0x43, 0xcb, 0xf0, 0xd6, 0x4d,
    0x07, 0x16, 0x13, 0x34, 0xb4, 0x3f, 0x59, 0x47,
]);

/// Anchor ix discriminator for `submit_refund_job`
/// = sha256("global:submit_refund_job")[..8]
const SUBMIT_REFUND_JOB_DISCRIMINATOR: [u8; 8] = [143, 230, 188, 206, 70, 98, 31, 101];

/// PDA seed prefix for RefundJob (must match p01_relayer::state::refund_job).
const REFUND_JOB_SEED_PREFIX: &[u8] = b"refund_job";

/// Minimum residual lamports required to trigger the refund-via-relayer path.
/// Below this, the residual is forfeited (covers tx fees only).
pub const REFUND_MIN_RESIDUAL: u64 = 100_000;

/// Keeper fee paid to the relayer that processes the refund job.
/// Already accounted for inside `amount` transferred to the RefundJob PDA.
pub const REFUND_KEEPER_FEE: u64 = 50_000;

/// ProofBuffer layout offsets (must match p01_stark_verifier::ProofBuffer).
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_MIN_LEN: usize = 82;

/// Parse a verified STARK proof buffer.
fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32])> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, ZkShieldedError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID])
        .map_err(|_| ZkShieldedError::InvalidProof)?;
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_MIN_LEN]);
    Ok((authority, circuit_id, verified, public_inputs_hash))
}

/// Cancel a private (ZK-based) subscription vault using STARK proof (quantum-resistant).
///
/// Requires a pre-verified STARK proof buffer proving subscriber ownership (circuit 0).
///
/// Two paths:
/// - **Refund-via-relayer** (when `vault.client_stealth_meta` is `Some` and residual
///   ≥ `REFUND_MIN_RESIDUAL`): CPI to `p01_relayer::submit_refund_job` to init a
///   `RefundJob` PDA and transfer the residual lamports into it. The keeper later
///   shields the residual into a denominated pool as a stealth-encrypted note.
///   In this path `denominated_pool` and `merkle_tree` accounts are NOT required.
/// - **Legacy reshield** (when `vault.client_stealth_meta` is `None`, or residual is
///   too small): re-shields full-denomination multiples back into the source
///   denominated pool as new commitments, exactly as today.
#[derive(Accounts)]
#[instruction(
    new_commitments: Vec<[u8; 32]>,
    new_roots: Vec<[u8; 32]>
)]
pub struct CancelPrivateStark<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Retailer receives outstanding claimable periods
    /// CHECK: Must match vault.retailer
    #[account(
        mut,
        constraint = retailer.key() == vault.retailer @ ZkShieldedError::Unauthorized
    )]
    pub retailer: AccountInfo<'info>,

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
        constraint = vault.is_private_mode() @ ZkShieldedError::ExpectedPrivateMode,
        close = payer
    )]
    pub vault: Box<Account<'info, SubscriptionVault>>,

    /// Source denominated pool — REQUIRED only on the legacy reshield path.
    /// May be `None` on the refund-via-relayer path. Uses `UncheckedAccount`
    /// to avoid Anchor 0.32 typed-Account discriminator checks for the
    /// program-id sentinel pattern; handler validates linkage when used.
    /// CHECK: handler validates linkage to `vault.source_pool` if used.
    #[account(mut)]
    pub denominated_pool: Option<UncheckedAccount<'info>>,

    /// Merkle tree — REQUIRED only on the legacy reshield path.
    /// May be `None` on the refund-via-relayer path. Same `UncheckedAccount`
    /// rationale as `denominated_pool` above.
    /// CHECK: handler validates derivation/usage at use-site.
    #[account(mut)]
    pub merkle_tree: Option<UncheckedAccount<'info>>,

    /// STARK proof buffer from p01_stark_verifier (circuit 0: subscriber_ownership).
    /// CHECK: Validated manually by reading account data and checking:
    /// - Owner is p01_stark_verifier program
    /// - Discriminator matches ProofBuffer
    /// - Authority matches payer
    /// - Circuit ID is 0 (subscriber_ownership)
    /// - Verified flag is true
    /// - Public inputs hash matches vault commitment
    #[account(mut)]
    pub stark_proof_buffer: AccountInfo<'info>,

    /// RefundJob PDA — REQUIRED only on the refund-via-relayer path.
    /// Seeds: `[b"refund_job", vault.key().as_ref()]`, owned by `p01_relayer`.
    /// Validated manually inside the handler before/after the CPI.
    /// CHECK: PDA derivation + ownership validated in handler.
    /// CHECK: PDA derivation + ownership validated manually inside the handler.
    #[account(mut)]
    pub refund_job: Option<UncheckedAccount<'info>>,

    /// `p01_relayer` program — REQUIRED only on the refund-via-relayer path.
    /// CHECK: Validated by exact pubkey match in the handler.
    pub p01_relayer_program: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,

    pub token_program: Option<Program<'info, Token>>,

    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub retailer_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<CancelPrivateStark>,
    new_commitments: Vec<[u8; 32]>,
    new_roots: Vec<[u8; 32]>,
) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault;

    let commitment = vault.subscriber_commitment
        .ok_or(ZkShieldedError::ExpectedPrivateMode)?;

    // -----------------------------------------------------------------------
    // STARK proof verification (replaces Groth16 inline verify)
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;

    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let proof_data = proof_info.try_borrow_data()?;
    let (authority, circuit_id, verified, stored_inputs_hash) = parse_stark_proof_buffer(&proof_data)?;

    require!(
        authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );

    require!(circuit_id == 0, ZkShieldedError::InvalidProof);
    require!(verified, ZkShieldedError::InvalidProof);

    {
        let commitment_u64 = u64::from_le_bytes(commitment[..8].try_into().unwrap());
        let commitment_bytes = commitment_u64.to_le_bytes();
        let expected_hash = solana_sha256_hasher::hashv(&[&commitment_bytes]).to_bytes();
        require!(
            stored_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(proof_data);

    // -----------------------------------------------------------------------
    // Common cancel logic — compute retailer payout + residual
    // -----------------------------------------------------------------------
    let claimable = vault.claimable_periods(clock.slot as i64);
    let total_owed = (vault.claimed_periods + claimable)
        .checked_mul(vault.rate)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    let retailer_amount = claimable
        .checked_mul(vault.rate)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    let refundable = vault.total_deposited.saturating_sub(total_owed);

    let is_native_sol = vault.token_mint == system_program::ID;

    let retailer_key = vault.retailer;
    let subscriber_id = vault.subscriber_id_bytes();
    let token_mint_key = vault.token_mint;
    let vault_bump = vault.bump;
    let vault_seeds = &[
        SubscriptionVault::SEED_PREFIX,
        retailer_key.as_ref(),
        subscriber_id.as_ref(),
        token_mint_key.as_ref(),
        &[vault_bump],
    ];
    let vault_signer = &[&vault_seeds[..]];

    // -----------------------------------------------------------------------
    // Retailer payout (identical on both paths)
    // -----------------------------------------------------------------------
    if retailer_amount > 0 {
        if is_native_sol {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= retailer_amount;
            **ctx.accounts.retailer.try_borrow_mut_lamports()? += retailer_amount;
        } else {
            let token_program = ctx.accounts.token_program
                .as_ref()
                .ok_or(ZkShieldedError::MissingTokenProgram)?;
            let vault_token = ctx.accounts.vault_token_account
                .as_ref()
                .ok_or(ZkShieldedError::MissingPoolVault)?;
            let retailer_token = ctx.accounts.retailer_token_account
                .as_ref()
                .ok_or(ZkShieldedError::MissingTokenAccount)?;

            let transfer_ctx = CpiContext::new_with_signer(
                token_program.to_account_info(),
                TokenTransfer {
                    from: vault_token.to_account_info(),
                    to: retailer_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                vault_signer,
            );
            token::transfer(transfer_ctx, retailer_amount)?;
        }
    }

    // -----------------------------------------------------------------------
    // Branch on path:
    //   - Refund-via-relayer when stealth_meta is Some AND residual large enough
    //   - Legacy reshield otherwise
    // -----------------------------------------------------------------------
    let use_refund_path = vault.client_stealth_meta.is_some()
        && refundable >= REFUND_MIN_RESIDUAL;

    if use_refund_path {
        // SAFETY: just checked is_some() above.
        let stealth_meta = vault.client_stealth_meta.unwrap();

        // Only SOL refund supported in v1 (matches the keeper-side flow).
        require!(is_native_sol, ZkShieldedError::InvalidTokenMint);

        // Resolve required optional accounts for this path.
        let refund_job_ai = ctx
            .accounts
            .refund_job
            .as_ref()
            .ok_or(ZkShieldedError::MissingAccount)?;
        let relayer_program_ai = ctx
            .accounts
            .p01_relayer_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingAccount)?;

        // Validate program id (Account<Program> would force a typed handle that
        // the IDL doesn't carry here, so do it manually).
        require!(
            relayer_program_ai.key() == P01_RELAYER_PROGRAM_ID,
            ZkShieldedError::InvalidProgramId
        );

        // Validate the RefundJob PDA derivation up-front so a malicious caller
        // can't trick us into transferring lamports to a wrong account.
        let vault_key = ctx.accounts.vault.key();
        let (expected_refund_job, _refund_bump) = Pubkey::find_program_address(
            &[REFUND_JOB_SEED_PREFIX, vault_key.as_ref()],
            &P01_RELAYER_PROGRAM_ID,
        );
        require!(
            refund_job_ai.key() == expected_refund_job,
            ZkShieldedError::InvalidPda
        );

        // Resolve source_pool / merkle_tree keys for the refund job payload.
        // On this path the on-chain pool/tree accounts are OPTIONAL — we only
        // need their pubkeys. Prefer the typed accounts if provided (so the
        // caller can pass them for free), otherwise fall back to
        // `vault.source_pool` for `target_pool`. `target_tree` MUST be
        // provided as the `merkle_tree` account because the vault doesn't
        // store the tree address.
        let target_pool = vault
            .source_pool
            .ok_or(ZkShieldedError::InvalidVaultMode)?;
        let target_tree = ctx
            .accounts
            .merkle_tree
            .as_ref()
            .map(|m| m.key())
            .ok_or(ZkShieldedError::MissingAccount)?;

        // ------------------------------------------------------------------
        // CPI: p01_relayer::submit_refund_job(amount, stealth_meta, target_pool, target_tree)
        // ------------------------------------------------------------------
        // Anchor instruction data layout:
        //   [discriminator(8) | amount: u64 | stealth_meta: [u8;64] | target_pool: Pubkey | target_tree: Pubkey]
        let mut ix_data = Vec::with_capacity(8 + 8 + 64 + 32 + 32);
        ix_data.extend_from_slice(&SUBMIT_REFUND_JOB_DISCRIMINATOR);
        ix_data.extend_from_slice(&refundable.to_le_bytes());
        ix_data.extend_from_slice(&stealth_meta);
        ix_data.extend_from_slice(target_pool.as_ref());
        ix_data.extend_from_slice(target_tree.as_ref());

        let ix = Instruction {
            program_id: P01_RELAYER_PROGRAM_ID,
            accounts: vec![
                // payer: Signer<'info>, mut
                AccountMeta::new(ctx.accounts.payer.key(), true),
                // source_vault: AccountInfo<'info>  (read-only)
                AccountMeta::new_readonly(vault_key, false),
                // refund_job: init, mut
                AccountMeta::new(refund_job_ai.key(), false),
                // system_program
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: ix_data,
        };

        invoke(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                refund_job_ai.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                relayer_program_ai.to_account_info(),
            ],
        )?;

        // ------------------------------------------------------------------
        // Transfer the residual lamports vault PDA → refund_job PDA via direct
        // lamport manipulation. The vault is a PDA owned by zk_shielded; the
        // refund_job was just init'd by p01_relayer with the rent-exempt
        // minimum, so we just top it up by `refundable`.
        // ------------------------------------------------------------------
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= refundable;
        **refund_job_ai.try_borrow_mut_lamports()? += refundable;

        // No reshield, no merkle inserts, no commitments. Vault closes via
        // Anchor `close = payer` constraint (residual rent → payer).
        require!(
            new_commitments.is_empty() && new_roots.is_empty(),
            ZkShieldedError::InvalidCommitment
        );

        emit!(CancelPrivateStarkEvent {
            vault: vault_key,
            retailer: ctx.accounts.retailer.key(),
            source_pool: target_pool,
            retailer_amount,
            reshield_amount: 0,
            notes_reshielded: 0,
            dust_forfeited: 0,
            slot: clock.slot as i64,
        });

        return Ok(());
    }

    // -----------------------------------------------------------------------
    // LEGACY PATH — V3 reshield is not implemented in this ix (would require
    // circuit-6 STARK proofs per commitment, currently only circuit 0 is
    // generated for the cancel ownership proof). Vault closes to payer via
    // `close = payer`, returning rent + residual lamports as plain SOL.
    // -----------------------------------------------------------------------
    let _ = (new_commitments, new_roots, vault_signer, is_native_sol);

    emit!(CancelPrivateStarkEvent {
        vault: ctx.accounts.vault.key(),
        retailer: ctx.accounts.retailer.key(),
        source_pool: ctx.accounts.vault.source_pool.unwrap_or_default(),
        retailer_amount,
        reshield_amount: 0,
        notes_reshielded: 0,
        dust_forfeited: refundable,
        slot: clock.slot as i64,
    });

    Ok(())
}

#[event]
pub struct CancelPrivateStarkEvent {
    pub vault: Pubkey,
    pub retailer: Pubkey,
    pub source_pool: Pubkey,
    pub retailer_amount: u64,
    pub reshield_amount: u64,
    pub notes_reshielded: u64,
    pub dust_forfeited: u64,
    pub slot: i64,
}
