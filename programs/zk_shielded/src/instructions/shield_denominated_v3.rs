use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, FEE_ESCROW_SEED_PREFIX};
use crate::state::pool_v3::DenominatedPoolV3;
use crate::state::merkle_tree_v3::MerkleTreeStateV3;
use crate::state::insert_root::{self, INSERT_SUBTREE_DEPTH};

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
const PROOF_BUF_AUTHORITY_OFF: usize = 8;
const PROOF_BUF_CIRCUIT_ID_OFF: usize = 40;
const PROOF_BUF_VERIFIED_OFF: usize = 49;
const PROOF_BUF_INPUTS_HASH_OFF: usize = 50;
const PROOF_BUF_DEEP_ALI_OFF: usize = 82;
const PROOF_BUF_MIN_LEN: usize = 83;

/// Circuit id for `merkle_update`.
const CIRCUIT_MERKLE_UPDATE: u8 = 6;

/// Read a Goldilocks element from its 32-byte encoding, rejecting non-canonical
/// values and non-zero padding.
///
/// The upper 24 bytes MUST be zero. The old code did `u64::from_le_bytes(x[..8])`
/// and ignored the rest, which let two different 32-byte arrays name the same
/// root -- the same aliasing shape as the nullifier defect closed 2026-08-26.
fn felt_from_bytes(bytes: &[u8; 32]) -> Result<u64> {
    require!(
        bytes[8..].iter().all(|b| *b == 0),
        ZkShieldedError::InvalidMerkleRoot
    );
    let v = u64::from_le_bytes(bytes[..8].try_into().unwrap());
    require!(
        v < crate::state::poseidon_gl::MODULUS,
        ZkShieldedError::InvalidMerkleRoot
    );
    Ok(v)
}

/// The canonical 32-byte encoding of a Goldilocks element: low 8 bytes LE, then
/// 24 zero bytes. The inverse of `felt_from_bytes`.
fn felt_to_bytes(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&v.to_le_bytes());
    out
}

/// Verify the C6 proof buffer attests `(old_leaf=0, new_leaf=leaf,
/// old_root=old_subtree_root, new_root=new_subtree_root, depth=12)`.
///
/// 🚨 THESE ARE SUBTREE ROOTS SINCE 2026-08-29, NOT POOL ROOTS, and the
/// depth is the constant 12 rather than `merkle_tree.depth`. C6 was cut to depth
/// 12 to free 128 trace rows for a blinding region. Passing the pool root or the
/// pool depth here produces a hash no honest proof can match, so that mistake is
/// loud -- but the reverse is not: this function alone does NOT establish that
/// the subtree belongs to the pool. `fold_insertion` plus the old-root equality
/// in the handler is what does that, and without them a depositor proves an
/// insertion into a subtree they invented.
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
    old_subtree_root: &[u8; 32],
    new_subtree_root: &[u8; 32],
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

    // Authority binding: the proof buffer must have been created by the
    // depositor (matches `shield_stark.rs`). Without this any verified C6
    // buffer could be replayed by an unrelated signer.
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY_OFF..PROOF_BUF_CIRCUIT_ID_OFF])
        .map_err(|_| ZkShieldedError::InvalidProof)?;
    require!(authority == *depositor, ZkShieldedError::InvalidProof);

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
    let old_root_u64 = u64::from_le_bytes(old_subtree_root[..8].try_into().unwrap());
    let new_root_u64 = u64::from_le_bytes(new_subtree_root[..8].try_into().unwrap());
    // ⛔ THE CONSTANT, NOT `merkle_tree.depth`. The verifier rejects any other
    // value for C6 in phase 2, and the pool is 15 deep.
    let depth_u64 = INSERT_SUBTREE_DEPTH as u64;

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
/// ⛔ `new_root` IS GONE FROM THIS INSTRUCTION, AND IT MUST NOT COME BACK.
/// The program now COMPUTES the pool root by folding the top levels itself; a
/// caller-supplied one is exactly the value the fold exists to stop the caller
/// from choosing.
///
/// `old_subtree_root` and `new_subtree_root` are C6's depth-12 roots. Neither is
/// trusted: the old one must reproduce the pool's current root through the fold,
/// and the new one is covered by the proof's public-input hash.
///
/// `new_subtrees` remains the client's post-insertion filled-subtrees array for
/// the levels BELOW 12. ⚠️ It is still bound by nothing -- the same hole
/// `insert_with_root_v3` documents -- and the top-level entries are now derived
/// on chain and overwrite whatever it claims there.
#[derive(Accounts)]
#[instruction(commitment: [u8; 32], old_subtree_root: [u8; 32], new_subtree_root: [u8; 32], new_subtrees: Vec<[u8; 32]>)]
pub struct ShieldDenominatedV3<'info> {
    /// User depositing tokens
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Denominated pool V3
    #[account(
        mut,
        // [ERAS 2026-09-06] The PDA is no longer pinned here. Era 0 has three
        // seeds and era n >= 1 has four, and one `seeds = [...]` cannot say
        // both, so the handler re-derives the address from the pool's own
        // fields and the tree's `era` (`require_pool_pda`) before touching
        // any state. Owner and discriminator are still checked by `Account`.
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
    old_subtree_root: [u8; 32],
    new_subtree_root: [u8; 32],
    new_subtrees: Vec<[u8; 32]>,
) -> Result<()> {
    // [ERAS 2026-09-06] Replaces the `seeds = [...]` constraint on the pool.
    let pool_era = ctx.accounts.merkle_tree.era;
    ctx.accounts.denominated_pool.require_pool_pda(
        &ctx.accounts.denominated_pool.key(),
        pool_era,
        ctx.program_id,
    )?;
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.denominated_pool;
    let merkle_tree = &mut ctx.accounts.merkle_tree;
    let amount = pool.denomination;

    // [ERAS 2026-09-06] Refuse a full tree BEFORE any lamport moves, and say
    // where the next deposit goes: the directory for this denomination names
    // the active era, and `open_next_era` opens one if it has not happened yet.
    if merkle_tree.is_full() {
        let (directory, _) = crate::state::pool_directory::PoolDirectory::pda(
            &pool.token_mint,
            pool.denomination,
            ctx.program_id,
        );
        msg!(
            "tree full ({} leaves at depth {}): read PoolDirectory {} for the active era, or call open_next_era",
            merkle_tree.leaf_count,
            merkle_tree.depth,
            directory
        );
        return err!(ZkShieldedError::MerkleTreeFull);
    }

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
        &old_subtree_root,
        &new_subtree_root,
    )?;

    // ------------------------------------------------------------------
    // [C6-D12] Fold the top levels, and let the OLD fold prove the subtree
    // belongs to this pool.
    //
    // The proof above says "inserting this leaf into a 12-level tree rooted at
    // `old_subtree_root` yields `new_subtree_root`". It says nothing about
    // whose tree that is. The fold answers that: both roots go up through the
    // pool account's OWN `filled_subtrees`, and the old one is required to come
    // out equal to the pool's current root.
    //
    // ⛔ `new_subtrees` -- the depositor's array, in scope right here -- is NOT
    // what the fold reads. See `state::insert_root` for why that substitution is
    // the whole vulnerability.
    // ------------------------------------------------------------------
    let insert_at = merkle_tree.leaf_count;
    let old_sub = felt_from_bytes(&old_subtree_root)?;
    let new_sub = felt_from_bytes(&new_subtree_root)?;
    let filled: Vec<u64> = merkle_tree
        .filled_subtrees
        .iter()
        .map(felt_from_bytes)
        .collect::<Result<Vec<u64>>>()?;

    let folded = insert_root::fold_insertion(
        old_sub,
        new_sub,
        insert_at,
        &filled,
        merkle_tree.depth,
    )
    .map_err(|_| error!(ZkShieldedError::InvalidMerkleRoot))?;

    // 🚨 THIS EQUALITY IS THE WHOLE BINDING. Drop it and every other check
    // in this handler still passes while a depositor writes an arbitrary pool
    // root.
    require!(
        folded.old_pool_root == felt_from_bytes(&merkle_tree.root)?,
        ZkShieldedError::InvalidMerkleRoot
    );

    let new_root = felt_to_bytes(folded.new_pool_root);

    // Insert commitment into V3 Merkle tree (emits universal LeafInserted event).
    let leaf_index = merkle_tree.insert_with_root_v3(
        commitment,
        new_root,
        &new_subtrees,
        true, // c6_verified — see verify_c6_proof_buffer above
    )?;

    // The top-level subtree entries are DERIVED from the fold that just
    // reproduced the pool root. [DENIAL 2026-09-06] `insert_with_root_v3` no
    // longer writes the caller's `new_subtrees` at these levels at all, so a
    // right-turning level keeps its completed left sibling and the next
    // deposit on that branch folds through the truth. Levels below
    // `INSERT_SUBTREE_DEPTH` remain the client's hint: the program neither
    // derives nor reads them.
    for (level, value) in folded.updated_subtrees() {
        let l = *level as usize;
        if l < merkle_tree.filled_subtrees.len() {
            merkle_tree.filled_subtrees[l] = felt_to_bytes(*value);
        }
    }

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
