use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, PROTOCOL_FEE_WALLET};
use crate::state::pool_v3::DenominatedPoolV3;
use crate::state::merkle_tree_v3::MerkleTreeStateV3;

// ---------------------------------------------------------------------------
// C6 (merkle_update) STARK proof-buffer wiring
// ---------------------------------------------------------------------------
// Mirrors the v2 `unshield_denominated_stark` parser, with the added
// `deep_ali_verified` flag check that circuit 6 requires (phase 1 + phase 2).

/// Anchor discriminator for `p01_stark_verifier::ProofBuffer`.
const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

/// p01_stark_verifier program id: DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// `ProofBuffer` layout offsets (must match `p01_stark_verifier::ProofBuffer`).
/// Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written
///       + 1 verified + 32 public_inputs_hash + 1 deep_ali_verified = 83
const PROOF_BUF_CIRCUIT_ID_OFF: usize = 40;
const PROOF_BUF_VERIFIED_OFF: usize = 49;
const PROOF_BUF_INPUTS_HASH_OFF: usize = 50;
const PROOF_BUF_DEEP_ALI_OFF: usize = 82;
const PROOF_BUF_MIN_LEN: usize = 83;

/// Circuit id for `merkle_update`.
const CIRCUIT_MERKLE_UPDATE: u8 = 6;

/// Verify the C6 proof buffer attests `(old_leaf=0, new_leaf=leaf,
/// old_root=current_root, new_root=new_root, depth=tree_depth)`.
///
/// Returns Ok(()) iff all of the following hold:
///   - `proof_buffer.owner == STARK_VERIFIER_PROGRAM_ID`
///   - discriminator matches `STARK_PROOF_BUFFER_DISCRIMINATOR`
///   - `circuit_id == 6`
///   - `verified == true` AND `deep_ali_verified == true`
///   - `public_inputs_hash == sha256(0_u64_le || leaf_u64_le ||
///        old_root_u64_le || new_root_u64_le || depth_u64_le)`
///
/// All u64s are the low 8 bytes (LE) of the corresponding [u8; 32] —
/// Goldilocks elements fit in 64 bits and the rest of the array is zero
/// padding (matches the convention used elsewhere in this program; see
/// `cancel_private_stark::handler` and `unshield_denominated_stark`).
fn verify_c6_proof_buffer(
    proof_info: &AccountInfo,
    leaf: &[u8; 32],
    old_root: &[u8; 32],
    new_root: &[u8; 32],
    depth: u8,
) -> Result<()> {
    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );
    let data = proof_info.try_borrow_data()?;
    require!(data.len() >= PROOF_BUF_MIN_LEN, ZkShieldedError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );

    let circuit_id = data[PROOF_BUF_CIRCUIT_ID_OFF];
    require!(circuit_id == CIRCUIT_MERKLE_UPDATE, ZkShieldedError::InvalidProof);

    let verified = data[PROOF_BUF_VERIFIED_OFF] == 1;
    require!(verified, ZkShieldedError::InvalidProof);

    let deep_ali_verified = data[PROOF_BUF_DEEP_ALI_OFF] == 1;
    require!(deep_ali_verified, ZkShieldedError::InvalidProof);

    let mut stored_hash = [0u8; 32];
    stored_hash.copy_from_slice(
        &data[PROOF_BUF_INPUTS_HASH_OFF..PROOF_BUF_INPUTS_HASH_OFF + 32],
    );

    // Recompute expected hash. C6 AIR public inputs are
    //   [old_leaf, new_leaf, old_root, new_root, depth]
    // (5 u64s, see `stark/src/air/merkle_update.rs::MerkleUpdatePublicInputs`).
    // The verifier hashes them via sha256(concat(le_bytes(v))) — same shape
    // as `verify_stark_proof_v2` / `verify_deep_ali_phase2`.
    let old_leaf_u64: u64 = 0; // insertion ⇒ replacing ZEROS[0]
    let new_leaf_u64 = u64::from_le_bytes(leaf[..8].try_into().unwrap());
    let old_root_u64 = u64::from_le_bytes(old_root[..8].try_into().unwrap());
    let new_root_u64 = u64::from_le_bytes(new_root[..8].try_into().unwrap());
    let depth_u64 = depth as u64;

    let mut pub_buf = [0u8; 40];
    pub_buf[0..8].copy_from_slice(&old_leaf_u64.to_le_bytes());
    pub_buf[8..16].copy_from_slice(&new_leaf_u64.to_le_bytes());
    pub_buf[16..24].copy_from_slice(&old_root_u64.to_le_bytes());
    pub_buf[24..32].copy_from_slice(&new_root_u64.to_le_bytes());
    pub_buf[32..40].copy_from_slice(&depth_u64.to_le_bytes());

    let expected = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
    require!(stored_hash == expected, ZkShieldedError::InvalidProof);

    drop(data);
    Ok(())
}

/// Shield tokens into a V3 denominated pool.
///
/// Mirrors v2's `shield_denominated` except:
///   - `pool` is a `DenominatedPoolV3` (Goldilocks Poseidon tree, on-chain
///     subtree maintenance).
///   - Requires a NEW `c6_proof_buffer` account — the pre-verified C6
///     (merkle_update) STARK proof attesting that the leaf insertion is
///     consistent with the previous root. Same UX pattern as the C1 proof
///     buffer used by `unshield_denominated_stark` (init → upload → verify
///     in prior txs, then this tx consumes it).
///   - The leaf-inserted event is emitted as the universal `LeafInserted`
///     from inside `insert_with_root_v3`. This instruction also emits a
///     `ShieldDenominatedV3Event` for backwards-compat indexers (denomination,
///     fee, deposit_epoch, etc. — the maturity bookkeeping stuff).
///
/// `new_subtrees` is the post-insertion filled-subtrees array (one entry per
/// internal level, length == tree_depth). Produced by the client alongside
/// `new_root` and bound to both via the C6 proof.
#[derive(Accounts)]
#[instruction(commitment: [u8; 32], new_root: [u8; 32], new_subtrees: Vec<[u8; 32]>)]
pub struct ShieldDenominatedV3<'info> {
    /// User depositing tokens
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Denominated pool V3
    #[account(
        mut,
        seeds = [
            DenominatedPoolV3::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump,
        constraint = denominated_pool.is_active @ ZkShieldedError::PoolNotActive
    )]
    pub denominated_pool: Account<'info, DenominatedPoolV3>,

    /// Merkle tree V3 state
    #[account(
        mut,
        seeds = [
            MerkleTreeStateV3::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeStateV3>,

    /// C6 (merkle_update) STARK proof buffer from p01_stark_verifier.
    /// Pre-verified in a prior transaction sequence:
    ///   init_proof_buffer → write_proof_chunk* → verify_stark_proof_v2
    ///   → verify_deep_ali_phase2 (or verify_merkle_update_deep_ali)
    /// CHECK: Validated manually in this handler via `verify_c6_proof_buffer`
    /// (owner, discriminator, circuit_id == 6, verified, deep_ali_verified,
    /// public_inputs_hash matches `(0, leaf, old_root, new_root, depth)`).
    pub c6_proof_buffer: AccountInfo<'info>,

    /// System program (required for native SOL transfers)
    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL token transfers)
    pub token_program: Option<Program<'info, Token>>,

    /// User's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub user_token_account: Option<Account<'info, TokenAccount>>,

    /// Pool's token vault (optional, only for SPL tokens)
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    /// Protocol fee wallet — receives shield fee (0.3%)
    /// CHECK: Validated against hardcoded PROTOCOL_FEE_WALLET constant
    #[account(
        mut,
        constraint = protocol_fee_wallet.key() == PROTOCOL_FEE_WALLET @ ZkShieldedError::InvalidFeeWallet
    )]
    pub protocol_fee_wallet: AccountInfo<'info>,
}

pub fn handler(
    ctx: Context<ShieldDenominatedV3>,
    commitment: [u8; 32],
    new_root: [u8; 32],
    new_subtrees: Vec<[u8; 32]>,
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.denominated_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    let amount = pool.denomination;

    // Calculate protocol fee (0.3% of denomination) — fees from wallet, not
    // from note (memory: feedback_fee_not_from_note).
    let (shield_fee, _) = fee::calculate_fee(amount, fee::SHIELD_FEE_BPS);

    let is_native_sol = pool.token_mint == system_program::ID;

    if is_native_sol {
        // Native SOL: transfer denomination to pool PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: pool.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        if shield_fee > 0 {
            let fee_context = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.protocol_fee_wallet.to_account_info(),
                },
            );
            system_program::transfer(fee_context, shield_fee)?;
        }
    } else {
        // SPL Token transfer
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let user_token_account = ctx.accounts.user_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;

        require!(
            user_token_account.mint == pool.token_mint,
            ZkShieldedError::InvalidTokenMint
        );
        require!(
            user_token_account.owner == ctx.accounts.depositor.key(),
            ZkShieldedError::InvalidTokenOwner
        );
        require!(
            pool_vault.mint == pool.token_mint,
            ZkShieldedError::InvalidTokenMint
        );
        require!(
            pool_vault.owner == pool.key(),
            ZkShieldedError::InvalidTokenOwner
        );

        let transfer_ctx = CpiContext::new(
            token_program.to_account_info(),
            TokenTransfer {
                from: user_token_account.to_account_info(),
                to: pool_vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;

        // SPL fee paid in SOL from depositor
        if shield_fee > 0 {
            let fee_context = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.protocol_fee_wallet.to_account_info(),
                },
            );
            system_program::transfer(fee_context, shield_fee)?;
        }
    }

    // ------------------------------------------------------------------
    // Verify the C6 (merkle_update) STARK proof buffer BEFORE mutating
    // tree state. This binds (old_root → new_root) to the proven witness.
    // See `verify_c6_proof_buffer` for the exact checks.
    // ------------------------------------------------------------------
    verify_c6_proof_buffer(
        &ctx.accounts.c6_proof_buffer,
        &commitment,
        &merkle_tree.root,
        &new_root,
        merkle_tree.depth,
    )?;

    // Insert commitment into V3 Merkle tree (emits universal LeafInserted event).
    let leaf_index = merkle_tree.insert_with_root_v3(
        commitment,
        new_root,
        &new_subtrees,
        true, // c6_verified — see verify_c6_proof_buffer above
    )?;

    // Update pool state (mirrors v2)
    pool.update_root(merkle_tree.root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.total_shielded = pool
        .total_shielded
        .checked_add(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.note_count = pool
        .note_count
        .checked_add(1)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;

    // Maturity tracking
    let current_epoch = DenominatedPoolV3::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);
    pool.record_deposit(current_epoch);

    msg!("V3 commitment added at index: {}", leaf_index);

    emit!(ShieldDenominatedV3Event {
        pool: pool.key(),
        depositor: ctx.accounts.depositor.key(),
        denomination: amount,
        protocol_fee: shield_fee,
        commitment,
        leaf_index,
        new_root: merkle_tree.root,
        deposit_epoch: current_epoch,
        mature_note_count: pool.mature_note_count,
        dynamic_delay: pool.get_dynamic_delay(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct ShieldDenominatedV3Event {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub denomination: u64,
    pub protocol_fee: u64,
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub new_root: [u8; 32],
    pub deposit_epoch: u64,
    pub mature_note_count: u64,
    pub dynamic_delay: u64,
    pub timestamp: i64,
}
