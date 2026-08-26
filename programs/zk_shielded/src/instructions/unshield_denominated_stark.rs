// === Deprecated v2 (circuit-1 only, no C3 membership proof = unshield-undeposited risk). Production is v3-only. ===
// v2 unshield_denominated_stark: verifies only circuit 1 (pool_commitment),
// never proves the commitment is a member of the pool's Merkle tree on-chain.
// Superseded by unshield_denominated_stark_v3 (adds C3 membership). Commented
// out wholesale (handler + Accounts struct + event + constants/helpers).
/*
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, PROTOCOL_FEE_WALLET};
use crate::state::{DenominatedPool, MerkleTreeState, NullifierRecord};

/// STARK Proof Buffer account layout (from p01_stark_verifier).
/// We read this account to check that a STARK proof was verified.
const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

// DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

// 6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg — p01_liquidity program.
// When a `prefund_record` account is passed and owned by this program, we
// accept a non-authority payer because the PDA proves a valid prefund is in
// flight (see settle() in p01_liquidity for the full flow).
const P01_LIQUIDITY_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x50, 0x18, 0x77, 0x84, 0x39, 0xb4, 0xd7, 0x63,
    0xe6, 0xa7, 0xf7, 0x5b, 0x7a, 0x71, 0x9f, 0x9e,
    0x51, 0x8e, 0xe3, 0x24, 0x17, 0xca, 0xff, 0x96,
    0xcc, 0x35, 0xd4, 0xc7, 0x3b, 0xf4, 0x17, 0x9b,
]);

/// Anchor discriminator: sha256("account:PrefundRecord")[..8]
const PREFUND_RECORD_DISCRIMINATOR: [u8; 8] =
    [0xeb, 0x5a, 0x2e, 0xa5, 0x0e, 0xb1, 0x65, 0x15];

/// PrefundRecord offsets (mirror p01_liquidity::state::PrefundRecord).
/// Layout:
///   0   disc (8) | 8   pool (32) | 40  denominated_pool (32)
///   72  nullifier (32) | 104 merkle_root (32) | 136 public_inputs_hash (32)
///   168 stark_commitment (8) | 176 amount (8) | 184 min_epoch (8)
///   192 proof_buffer (32) | 224 ephemeral_signer (32)
///   256 settler_reward (8) | 264 opened_at_slot (8) | 272 bump (1) = 273
const PREFUND_DENOM_POOL_OFF: usize = 40;
const PREFUND_NULLIFIER_OFF: usize = 72;
const PREFUND_INPUTS_HASH_OFF: usize = 136;
const PREFUND_PROOF_BUFFER_OFF: usize = 192;
const PREFUND_EPHEMERAL_OFF: usize = 224;
const PREFUND_MIN_LEN: usize = 273;
const PREFUND_SEED_PREFIX: &[u8] = b"prefund";

/// ProofBuffer layout offsets (must match p01_stark_verifier::ProofBuffer).
/// Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written + 1 verified + 32 public_inputs_hash + 1 deep_ali_verified = 83
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40; // 8 + 32
const PROOF_BUF_VERIFIED: usize = 49;   // 8 + 32 + 1 + 4 + 4
const PROOF_BUF_INPUTS_HASH: usize = 50; // 8 + 32 + 1 + 4 + 4 + 1
const PROOF_BUF_DEEP_ALI_VERIFIED: usize = 82; // 8 + 32 + 1 + 4 + 4 + 1 + 32
const PROOF_BUF_MIN_LEN: usize = 83;    // 8 + 32 + 1 + 4 + 4 + 1 + 32 + 1

/// Parse a verified STARK proof buffer.
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

/// Unshield from denominated pool using STARK proof verification.
///
/// Instead of inline Groth16 verification, this instruction reads a pre-verified
/// STARK proof buffer from p01_stark_verifier. The proof was uploaded and verified
/// in prior transactions (init → upload → verify flow).
///
/// Required STARK proofs:
///   - Circuit 1 (pool_commitment): proves knowledge of secret + nullifier_preimage
///     that hash to the nullifier and commitment
///
/// The caller must verify the STARK proof BEFORE calling this instruction.
/// This instruction only checks that proof_buffer.verified == true.
///
/// `min_epoch` is no longer enforced on-chain — all paths (mature, emergency,
/// prefund/settle) pass `current_epoch` so the tx args and event shape are
/// identical. Maturity is a UX/SDK concern; anonymity derives from the
/// uniform on-chain footprint + the pool's merkle anonymity set.
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64
)]
pub struct UnshieldDenominatedStark<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Any address can receive tokens
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [
            DenominatedPool::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump,
        constraint = denominated_pool.is_active @ ZkShieldedError::PoolNotActive,
        constraint = denominated_pool.is_valid_root(&merkle_root) @ ZkShieldedError::InvalidMerkleRoot
    )]
    pub denominated_pool: Account<'info, DenominatedPool>,

    #[account(
        seeds = [
            MerkleTreeState::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeState>,

    #[account(
        init,
        payer = payer,
        space = NullifierRecord::LEN,
        seeds = [
            NullifierRecord::SEED_PREFIX,
            denominated_pool.key().as_ref(),
            nullifier.as_ref()
        ],
        bump
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    /// STARK proof buffer from p01_stark_verifier (circuit 1: pool_commitment).
    /// Must be verified (verified == true) and owned by the payer.
    /// Marked mut because we invalidate (set verified=false) after use.
    /// CHECK: Validated manually by reading account data and checking:
    /// - Owner is p01_stark_verifier program
    /// - Discriminator matches ProofBuffer
    /// - Authority matches payer
    /// - Circuit ID is 1 (pool_commitment)
    /// - Verified flag is true
    /// - Public inputs hash matches expected value
    /// CHECK: Read-only — proof buffer is owned by p01_stark_verifier, closed by caller.
    pub stark_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Option<Program<'info, Token>>,

    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub recipient_token_account: Option<Account<'info, TokenAccount>>,

    /// Protocol fee wallet — receives unshield fee (0.5%)
    /// CHECK: Validated against hardcoded PROTOCOL_FEE_WALLET constant
    #[account(
        mut,
        constraint = protocol_fee_wallet.key() == PROTOCOL_FEE_WALLET @ ZkShieldedError::InvalidFeeWallet
    )]
    pub protocol_fee_wallet: AccountInfo<'info>,

    /// Optional `PrefundRecord` from p01_liquidity. When present, the payer no
    /// longer needs to equal the proof buffer's authority — the PDA's
    /// existence + stored ephemeral_signer match is a sufficient proof that
    /// a valid prefund is in flight. If omitted, the classic
    /// `payer == authority` check applies.
    /// CHECK: Validated manually in the handler (owner, discriminator, PDA seeds,
    /// stored ephemeral_signer match, stored public_inputs_hash match).
    pub prefund_record: Option<AccountInfo<'info>>,
}

pub fn handler(
    ctx: Context<UnshieldDenominatedStark>,
    nullifier: [u8; 32],
    _merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    // Snapshot the denominated_pool key before taking the mutable borrow —
    // the prefund-path checks below need it and cannot re-borrow through
    // `ctx.accounts.denominated_pool` while `pool` is alive.
    let denominated_pool_key = ctx.accounts.denominated_pool.key();
    let pool = &mut ctx.accounts.denominated_pool;
    let amount = pool.denomination;
    let is_native_sol = pool.token_mint == system_program::ID;

    // Check pool balance
    require!(
        pool.total_shielded >= amount,
        ZkShieldedError::InsufficientBalance
    );

    // Dynamic delay accounting is still updated for anonymity metrics, but we no
    // longer enforce `current_epoch >= min_epoch + dynamic_delay` on-chain.
    // Rationale: the previous emergency path used `min_epoch == 0` as a
    // bypass sentinel, which made the emergency tx trivially distinguishable
    // from a mature one (arg visible in tx data). To unify the on-chain
    // footprint, clients now always pass `min_epoch = current_epoch` and
    // maturity becomes an off-chain/UX concern (the SDK warns users who try
    // to unshield an immature note). This preserves the anonymity set size
    // and keeps the event shape identical across both paths.
    let current_epoch = DenominatedPool::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);
    let dynamic_delay = pool.get_dynamic_delay();

    // Initialize nullifier record (double-spend protection)
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // -----------------------------------------------------------------------
    // STARK proof verification (replaces Groth16 inline verify)
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;

    // Must be owned by the STARK verifier program
    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let proof_data = proof_info.try_borrow_data()?;
    let (authority, circuit_id, verified, stored_inputs_hash, deep_ali_verified) =
        parse_stark_proof_buffer(&proof_data)?;

    // Two auth paths:
    //   A) Classic: payer == proof.authority — user-driven unshield.
    //   B) Prefund: payer is any wallet, but a `PrefundRecord` PDA owned by
    //      p01_liquidity proves a valid prefund is in flight. The PDA's
    //      stored ephemeral_signer must match the proof's authority, and
    //      the stored public_inputs_hash must match the proof buffer's.
    if let Some(prefund_info) = &ctx.accounts.prefund_record {
        require!(
            *prefund_info.owner == P01_LIQUIDITY_PROGRAM_ID,
            ZkShieldedError::InvalidProof
        );
        let prefund_data = prefund_info.try_borrow_data()?;
        require!(
            prefund_data.len() >= PREFUND_MIN_LEN,
            ZkShieldedError::InvalidProof
        );
        require!(
            prefund_data[..8] == PREFUND_RECORD_DISCRIMINATOR,
            ZkShieldedError::InvalidProof
        );
        // PDA seeds: [b"prefund", denominated_pool.key(), nullifier]
        let stored_denom_pool = Pubkey::try_from(
            &prefund_data[PREFUND_DENOM_POOL_OFF..PREFUND_DENOM_POOL_OFF + 32],
        ).unwrap();
        require!(
            stored_denom_pool == denominated_pool_key,
            ZkShieldedError::InvalidProof
        );
        let stored_nullifier: &[u8] =
            &prefund_data[PREFUND_NULLIFIER_OFF..PREFUND_NULLIFIER_OFF + 32];
        require!(stored_nullifier == nullifier.as_ref(), ZkShieldedError::InvalidProof);
        let stored_proof_buffer = Pubkey::try_from(
            &prefund_data[PREFUND_PROOF_BUFFER_OFF..PREFUND_PROOF_BUFFER_OFF + 32],
        ).unwrap();
        require!(
            stored_proof_buffer == proof_info.key(),
            ZkShieldedError::InvalidProof
        );
        let stored_ephemeral = Pubkey::try_from(
            &prefund_data[PREFUND_EPHEMERAL_OFF..PREFUND_EPHEMERAL_OFF + 32],
        ).unwrap();
        require!(stored_ephemeral == authority, ZkShieldedError::InvalidProof);
        let stored_inputs_hash_prefund: &[u8] =
            &prefund_data[PREFUND_INPUTS_HASH_OFF..PREFUND_INPUTS_HASH_OFF + 32];
        require!(
            stored_inputs_hash_prefund == stored_inputs_hash.as_ref(),
            ZkShieldedError::InvalidProof
        );
        let expected_pda = Pubkey::find_program_address(
            &[PREFUND_SEED_PREFIX, stored_denom_pool.as_ref(), nullifier.as_ref()],
            &P01_LIQUIDITY_PROGRAM_ID,
        ).0;
        require!(expected_pda == prefund_info.key(), ZkShieldedError::InvalidProof);
        drop(prefund_data);
    } else {
        // Classic path: payer must own the proof buffer.
        require!(
            authority == ctx.accounts.payer.key(),
            ZkShieldedError::InvalidProof
        );
    }

    // Must be pool_commitment circuit (ID 1)
    require!(circuit_id == 1, ZkShieldedError::InvalidProof);

    // Must be verified
    require!(verified, ZkShieldedError::InvalidProof);

    // Circuit 1 ships phase-2 DEEP-ALI from the client; require it.
    require!(deep_ali_verified, ZkShieldedError::InvalidProof);

    // Nullifier canonicalization: the PDA is seeded on the full 32-byte
    // `nullifier`, but the proof only binds the low 8 bytes. Reject any
    // non-canonical nullifier whose high 24 bytes are non-zero, else a single
    // proof could be spent under multiple distinct nullifier PDAs (double-spend).
    require!(nullifier[8..] == [0u8; 24], ZkShieldedError::InvalidProof);
    // 🚨 AND the low 8 bytes must be a CANONICAL Goldilocks element. The line
    // above bounds the ENCODING; this one bounds the VALUE, and without it the
    // note is spendable TWICE.
    //
    // MEASURED 2026-08-26: the deployed verifier reduces public input 0 with
    // `Felt::new(v) = Felt(v % p)` before asserting it against the trace, so n
    // and n + p satisfy the SAME boundary assertion; but `hash_public_inputs`
    // hashes the RAW u64, so the two are two distinct valid proof buffers; and
    // this PDA is seeded on the raw bytes, so they are two distinct records.
    // 2^64 - p = 2^32 - 1, so every nullifier below 2^32 - 1 has such an alias,
    // grindable at DEPOSIT time in ~2^32 hashes.
    //
    // ⛔ THIS PAIR OPERATES ON `DenominatedPool`, THE V1 TYPE, AND IS LIVE:
    // 46 such accounts hold 50.499 SOL on devnet today (measured). It is not
    // legacy code and it was NOT covered when the other six spends were fixed.
    //
    // No honest client is affected: poseidon_gl reduces its inputs and its
    // reducer returns `s - MODULUS` whenever `s >= MODULUS`, so a Poseidon-GL
    // output is canonical by construction.
    require!(
        u64::from_le_bytes(nullifier[..8].try_into().unwrap()) < crate::state::poseidon_gl::MODULUS,
        ZkShieldedError::SpendNonCanonicalFelt
    );

    // Verify the proof was generated for THIS nullifier by checking the public inputs hash.
    // The STARK verifier stores sha256(public_inputs_le_bytes) when it verifies via
    // verify_stark_proof_v2. For pool_commitment (circuit 1), public_inputs = [nullifier_u64, commitment_u64].
    //
    // The on-chain nullifier [u8; 32] stores the Goldilocks u64 nullifier in bytes 0..8.
    // We reconstruct the same sha256 hash the verifier computed (single concatenated blob).
    {
        let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
        let mut pub_buf = [0u8; 16];
        pub_buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
        pub_buf[8..].copy_from_slice(&stark_commitment.to_le_bytes());
        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(
            stored_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(proof_data);

    // NOTE: Replay prevention is handled by the nullifier PDA (init constraint).
    // The proof buffer is closed by the caller after this instruction completes.
    // We do NOT write to the proof buffer here because it's owned by p01_stark_verifier.

    // -----------------------------------------------------------------------
    // Transfer funds with protocol fee (0.5%)
    // -----------------------------------------------------------------------
    let (unshield_fee, recipient_amount) = fee::calculate_fee(amount, fee::UNSHIELD_FEE_BPS);

    let token_mint = pool.token_mint;
    let denomination_bytes = pool.denomination.to_le_bytes();
    let bump = pool.bump;
    let seeds = &[
        DenominatedPool::SEED_PREFIX,
        token_mint.as_ref(),
        denomination_bytes.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];

    if is_native_sol {
        let pool_lamports = pool.to_account_info().lamports();
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(pool.to_account_info().data_len());
        require!(
            pool_lamports.saturating_sub(min_rent) >= amount,
            ZkShieldedError::InsufficientPoolBalance
        );
        // Send net amount to recipient, fee to protocol wallet
        **pool.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += recipient_amount;
        if unshield_fee > 0 {
            **ctx.accounts.protocol_fee_wallet.try_borrow_mut_lamports()? += unshield_fee;
        }
    } else {
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;
        let recipient_token_account = ctx.accounts.recipient_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;
        require!(pool_vault.mint == pool.token_mint, ZkShieldedError::InvalidTokenMint);
        require!(pool_vault.owner == pool.key(), ZkShieldedError::InvalidTokenOwner);
        require!(recipient_token_account.mint == pool.token_mint, ZkShieldedError::InvalidTokenMint);

        // Transfer net amount to recipient
        let transfer_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            TokenTransfer {
                from: pool_vault.to_account_info(),
                to: recipient_token_account.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, recipient_amount)?;

        // SPL token fee: sent as SOL from pool PDA to fee wallet
        if unshield_fee > 0 {
            let pool_lamports = pool.to_account_info().lamports();
            let rent = Rent::get()?;
            let min_rent = rent.minimum_balance(pool.to_account_info().data_len());
            require!(
                pool_lamports.saturating_sub(min_rent) >= unshield_fee,
                ZkShieldedError::InsufficientPoolBalance
            );
            **pool.to_account_info().try_borrow_mut_lamports()? -= unshield_fee;
            **ctx.accounts.protocol_fee_wallet.try_borrow_mut_lamports()? += unshield_fee;
        }
    }

    // Update pool state
    pool.total_shielded = pool.total_shielded.checked_sub(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.note_count = pool.note_count.checked_sub(1)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;
    // saturating_sub absorbs the emergency case where an immature note is withdrawn and
    // mature_note_count is already 0 — cannot panic, and keeps the state consistent.
    pool.mature_note_count = pool.mature_note_count.saturating_sub(1);

    emit!(UnshieldDenominatedStarkEvent {
        pool: pool.key(),
        recipient: ctx.accounts.recipient.key(),
        denomination: amount,
        protocol_fee: unshield_fee,
        nullifier,
        min_epoch,
        current_epoch,
        dynamic_delay,
        mature_note_count: pool.mature_note_count,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[event]
pub struct UnshieldDenominatedStarkEvent {
    pub pool: Pubkey,
    pub recipient: Pubkey,
    pub denomination: u64,
    pub protocol_fee: u64,
    pub nullifier: [u8; 32],
    pub min_epoch: u64,
    pub current_epoch: u64,
    pub dynamic_delay: u64,
    pub mature_note_count: u64,
    pub timestamp: i64,
}
*/
// === end Deprecated v2 block (unshield_denominated_stark) ===
