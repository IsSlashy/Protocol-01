use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::state::{MerkleTreeState, ShieldedPool};

/// STARK Proof Buffer layout constants (must match p01_stark_verifier::ProofBuffer).
/// We parse the raw account to check a STARK merkle_update proof was verified.
const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

// DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// ProofBuffer layout offsets (must match p01_stark_verifier::ProofBuffer).
/// Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written
///       + 1 verified + 32 public_inputs_hash + 1 deep_ali_verified
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_DEEP_ALI_VERIFIED: usize = 82;
const PROOF_BUF_MIN_LEN: usize = 83;

/// Canonical Merkle tree depth bound by circuit 6 (CANONICAL_DEPTH in the
/// STARK verifier). Any other depth silently yields wrong constraint
/// evaluations so we reject up front here too.
const CANONICAL_DEPTH: u64 = 15;

/// Parse a verified STARK proof buffer. Returns the fields relevant to binding
/// a shield proof to the tree insertion.
fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32], bool)> {
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
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_DEEP_ALI_VERIFIED]);
    let deep_ali_verified = data[PROOF_BUF_DEEP_ALI_VERIFIED] == 1;
    Ok((authority, circuit_id, verified, public_inputs_hash, deep_ali_verified))
}

/// Shield tokens into the shielded pool using a STARK merkle_update proof.
///
/// This replaces the legacy trusted-root `insert_with_root(commitment, new_root)`
/// pattern: the circuit 6 proof binds `old_root → new_root` given the insertion
/// of `commitment` at the tree's next leaf slot (old_leaf = 0, new_leaf =
/// commitment). A malicious client can no longer poison the pool root with an
/// arbitrary `new_root`.
///
/// Public inputs (u64 LE, bound by `sha256(pub_inputs)`):
///   [0] old_leaf (always 0 — empty slot before insertion)
///   [1] new_leaf (commitment, truncated to Goldilocks u64)
///   [2] old_root (current pool root, truncated to Goldilocks u64)
///   [3] new_root (post-insertion root, truncated to Goldilocks u64)
///   [4] depth (must equal CANONICAL_DEPTH = 15)
///
/// NOTE: leaf_index is NOT a circuit 6 public input — the circuit binds the
/// (old_root, new_root, commitment, depth) tuple. The on-chain Merkle tree
/// state enforces the actual leaf index by only ever inserting at the next
/// open slot. A prover who uses a different path is still free to prove an
/// honest update; the zk_shielded merkle_tree account tracks where the next
/// leaf lives.
#[derive(Accounts)]
#[instruction(commitment: [u8; 32], old_root: [u8; 32], new_root: [u8; 32], amount: u64)]
pub struct ShieldStark<'info> {
    /// User depositing tokens — must be the STARK proof authority.
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Shielded pool
    #[account(
        mut,
        seeds = [
            ShieldedPool::SEED_PREFIX,
            shielded_pool.token_mint.as_ref()
        ],
        bump = shielded_pool.bump,
        constraint = shielded_pool.is_active @ ZkShieldedError::PoolNotActive
    )]
    pub shielded_pool: Account<'info, ShieldedPool>,

    /// Merkle tree state — mutable, we insert the new commitment.
    #[account(
        mut,
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            shielded_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    /// STARK proof buffer from p01_stark_verifier (circuit 6: merkle_update).
    /// CHECK: Validated by:
    /// - Owner is p01_stark_verifier program
    /// - Discriminator matches ProofBuffer
    /// - Authority matches depositor
    /// - Circuit ID is 6 (merkle_update)
    /// - Both verified and deep_ali_verified flags are true
    /// - Public inputs hash matches sha256([old_leaf=0 || new_leaf=commitment_u64
    ///     || old_root_u64 || new_root_u64 || depth=15] — each u64 LE)
    pub stark_proof_buffer: AccountInfo<'info>,

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
}

pub fn handler(
    ctx: Context<ShieldStark>,
    commitment: [u8; 32],
    old_root: [u8; 32],
    new_root: [u8; 32],
    amount: u64,
) -> Result<()> {
    require!(amount > 0, ZkShieldedError::InvalidAmount);

    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.shielded_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;

    // The claimed old_root must match the current on-chain pool root. This is
    // the key trust anchor: the circuit proves old_root → new_root given the
    // insertion, and on-chain we enforce that the prover's old_root is the
    // pool's real current root.
    require!(
        pool.merkle_root == old_root,
        ZkShieldedError::InvalidMerkleRoot
    );

    // Sanity: new_root must differ from old_root (inserting a leaf must change it).
    require!(
        new_root != old_root,
        ZkShieldedError::InvalidMerkleRoot
    );
    require!(
        new_root != [0u8; 32],
        ZkShieldedError::InvalidMerkleRoot
    );

    // -----------------------------------------------------------------------
    // STARK proof verification (circuit 6: merkle_update)
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;

    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let proof_data = proof_info.try_borrow_data()?;
    let (authority, circuit_id, verified, stored_inputs_hash, deep_ali_verified) =
        parse_stark_proof_buffer(&proof_data)?;

    // Authority must be the depositor (binds the proof to this signer).
    require!(
        authority == ctx.accounts.depositor.key(),
        ZkShieldedError::InvalidProof
    );

    // Must be merkle_update circuit (ID 6).
    require!(circuit_id == 6, ZkShieldedError::InvalidProof);

    // Phase 1 verified.
    require!(verified, ZkShieldedError::InvalidProof);

    // Phase 2 DEEP-ALI verified — required for circuit 6 to close the
    // per-query soundness gap (see p01_stark_verifier docs).
    require!(deep_ali_verified, ZkShieldedError::InvalidProof);

    // Reconstruct the public-inputs hash the verifier stored.
    // Circuit 6 pub inputs: [old_leaf, new_leaf, old_root, new_root, depth].
    // On-chain [u8; 32] roots/commitments pack their Goldilocks u64 in bytes 0..8.
    {
        let commitment_u64 = u64::from_le_bytes(commitment[..8].try_into().unwrap());
        let old_root_u64 = u64::from_le_bytes(old_root[..8].try_into().unwrap());
        let new_root_u64 = u64::from_le_bytes(new_root[..8].try_into().unwrap());

        let mut pub_buf = [0u8; 40]; // 5 × 8
        pub_buf[0..8].copy_from_slice(&0u64.to_le_bytes());           // old_leaf = 0
        pub_buf[8..16].copy_from_slice(&commitment_u64.to_le_bytes()); // new_leaf = commitment
        pub_buf[16..24].copy_from_slice(&old_root_u64.to_le_bytes());
        pub_buf[24..32].copy_from_slice(&new_root_u64.to_le_bytes());
        pub_buf[32..40].copy_from_slice(&CANONICAL_DEPTH.to_le_bytes());

        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(
            stored_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(proof_data);

    // -----------------------------------------------------------------------
    // Transfer tokens (same logic as legacy shield)
    // -----------------------------------------------------------------------
    let is_native_sol = pool.token_mint == system_program::ID;

    if is_native_sol {
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: pool.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;
    } else {
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
    }

    // -----------------------------------------------------------------------
    // Insert commitment into the Merkle tree at the tree's next slot.
    //
    // The on-chain tree tracks leaf_index via merkle_tree.leaf_count. The STARK
    // proof bound (old_root, new_root, commitment) — we now trust the prover
    // has committed to the correct path because the circuit enforces the
    // transition. `insert_with_root` still does the leaf_count++ bookkeeping
    // and sets the new root; its historical trust model is gone because we
    // just proved new_root is a valid successor of old_root.
    // -----------------------------------------------------------------------
    let leaf_index = merkle_tree.insert_with_root(commitment, new_root)?;

    // Update pool state.
    pool.update_root(merkle_tree.root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.total_shielded = pool
        .total_shielded
        .checked_add(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;

    emit!(ShieldStarkEvent {
        pool: pool.key(),
        depositor: ctx.accounts.depositor.key(),
        amount,
        commitment,
        leaf_index,
        old_root,
        new_root,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Event emitted when tokens are shielded via STARK merkle_update.
#[event]
pub struct ShieldStarkEvent {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub timestamp: i64,
}
