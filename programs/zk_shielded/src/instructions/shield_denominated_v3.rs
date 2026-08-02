use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, FEE_ESCROW_SEED_PREFIX};
use crate::state::pool_v3::DenominatedPoolV3;
use crate::state::merkle_tree_v3::MerkleTreeStateV3;
use crate::stark_buffer::{
    parse_stark_proof_buffer, StarkProofBufferView, STARK_VERIFIER_PROGRAM_ID,
};

// ---------------------------------------------------------------------------
// C6 (merkle_update) STARK proof-buffer wiring
// ---------------------------------------------------------------------------
// The layout table and the parser live in `crate::stark_buffer`; this file only
// adds the C6-specific bindings (circuit id, phase-2 flag, public-inputs hash).

/// Circuit id for `merkle_update`.
const CIRCUIT_MERKLE_UPDATE: u8 = 6;

/// Verify the C6 proof buffer attests `(old_leaf=0, new_leaf=leaf,
/// old_root=current_root, new_root=new_root, depth=tree_depth)`.
///
/// Returns Ok(()) iff all of the following hold:
///   - `proof_buffer.owner == STARK_VERIFIER_PROGRAM_ID`
///   - discriminator matches `STARK_PROOF_BUFFER_DISCRIMINATOR`
///   - `proof_buffer.authority == depositor` (binds the proof to this signer)
///   - `circuit_id == 6`
///   - `verified == true` AND `deep_ali_verified == true`
///   - `public_inputs_hash == sha256(0_u64_le || leaf_u64_le ||
///        old_root_u64_le || new_root_u64_le || depth_u64_le)`
///
/// All u64s are the low 8 bytes (LE) of the corresponding [u8; 32] —
/// Goldilocks elements fit in 64 bits and the rest of the array is zero
/// padding (matches the convention used elsewhere in this program; see
/// `unshield_denominated_stark_v3::handler` and `subscribe_private_stark`).
fn verify_c6_proof_buffer(
    proof_info: &AccountInfo,
    depositor: &Pubkey,
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
    let StarkProofBufferView {
        authority,
        circuit_id,
        verified,
        deep_ali_verified,
        public_inputs_hash: stored_hash,
    } = parse_stark_proof_buffer(&data)?;

    // Authority binding: the proof buffer must have been created by the
    // depositor (matches `shield_stark.rs`). Without this any verified C6
    // buffer could be replayed by an unrelated signer.
    require!(authority == *depositor, ZkShieldedError::InvalidProof);
    require!(circuit_id == CIRCUIT_MERKLE_UPDATE, ZkShieldedError::InvalidProof);
    require!(verified, ZkShieldedError::InvalidProof);
    require!(deep_ali_verified, ZkShieldedError::InvalidProof);

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
///   - Emits the canonical `LeafInsertedEvent` (Phase B — scrubbed; no
///     `depositor`, no `denomination`, no maturity stats). Off-event fields
///     (denomination, protocol fee, deposit epoch, mature note count, dynamic
///     delay) are derivable from on-chain pool state at the time of the slot
///     for indexers that genuinely need them.
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

    /// Per-pool fee escrow PDA (Phase E v1).
    /// Receives the shield fee instead of the legacy hardcoded `BRop3...` wallet.
    /// PDA seed: [b"fee_escrow", pool.key()]. Deterministic per pool, no
    /// cross-pool linkability. Drained later via `sweep_fee_escrow` (treasury
    /// authority).
    #[account(
        mut,
        seeds = [FEE_ESCROW_SEED_PREFIX, denominated_pool.key().as_ref()],
        bump,
    )]
    pub fee_escrow: SystemAccount<'info>,
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
            // Phase E v1 — fee_escrow is a SystemAccount PDA. Solana rejects
            // any tx that leaves a system account with lamports below the
            // rent-exempt minimum for its data length (0-byte → ~890_880
            // lamports). On the first shield to a fresh pool the escrow has
            // 0 lamports, so a single 300k fee credit would leave it
            // rent-defective and the runtime aborts the whole tx.
            // Top up to rent-exempt min on first use.
            let escrow_info = ctx.accounts.fee_escrow.to_account_info();
            let rent = Rent::get()?;
            let rent_min = rent.minimum_balance(0);
            let current = escrow_info.lamports();
            let projected = current.saturating_add(shield_fee);
            let amount_to_transfer = if projected < rent_min {
                rent_min.saturating_sub(current)
            } else {
                shield_fee
            };
            let fee_context = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: escrow_info,
                },
            );
            system_program::transfer(fee_context, amount_to_transfer)?;
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
            // Phase E v1 — fee_escrow is a SystemAccount PDA. Solana rejects
            // any tx that leaves a system account with lamports below the
            // rent-exempt minimum for its data length (0-byte → ~890_880
            // lamports). On the first shield to a fresh pool the escrow has
            // 0 lamports, so a single 300k fee credit would leave it
            // rent-defective and the runtime aborts the whole tx.
            // Top up to rent-exempt min on first use.
            let escrow_info = ctx.accounts.fee_escrow.to_account_info();
            let rent = Rent::get()?;
            let rent_min = rent.minimum_balance(0);
            let current = escrow_info.lamports();
            let projected = current.saturating_add(shield_fee);
            let amount_to_transfer = if projected < rent_min {
                rent_min.saturating_sub(current)
            } else {
                shield_fee
            };
            let fee_context = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: escrow_info,
                },
            );
            system_program::transfer(fee_context, amount_to_transfer)?;
        }
    }

    // ------------------------------------------------------------------
    // Verify the C6 (merkle_update) STARK proof buffer BEFORE mutating
    // tree state. This binds (old_root → new_root) to the proven witness.
    // See `verify_c6_proof_buffer` for the exact checks.
    // ------------------------------------------------------------------
    verify_c6_proof_buffer(
        &ctx.accounts.c6_proof_buffer,
        &ctx.accounts.depositor.key(),
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

    // Phase B: no flavored event. The universal `LeafInserted` event is
    // already emitted from `insert_with_root_v3` and is what the off-chain
    // tree sync uses. The previous `ShieldDenominatedV3Event` leaked
    // `depositor` and other identity fields without adding value, so it's
    // dropped entirely. The on-chain `depositor: Signer` in the tx accounts
    // is still visible (event-level scrub does NOT close the tx-level leak —
    // see Phase A.5 feeder pool).
    let _ = (current_epoch, shield_fee, leaf_index); // computed but not surfaced via event

    Ok(())
}
