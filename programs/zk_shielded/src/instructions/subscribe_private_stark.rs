use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
// V4 seed bump (2026-05-07) replaced V2 pools with V3 (struct DenominatedPoolV3,
// seed `denominated_pool_v4`). subscribe_private_stark was missed in that pass —
// it was still deserializing V4 pool accounts as the V2 `DenominatedPool` struct,
// producing AccountDiscriminatorMismatch (Anchor error 3002 / 0xbba) for every
// vault subscription on V3+ pools. Switch to V3 structs.
use crate::state::{DenominatedPoolV3, MerkleTreeStateV3, NullifierRecord, SubscriptionVault};

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

/// ProofBuffer layout offsets (must match p01_stark_verifier::ProofBuffer).
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_DEEP_ALI_VERIFIED: usize = 82;
const PROOF_BUF_MIN_LEN: usize = 83;

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

/// Create a private (ZK-based) subscription vault by unshielding a denomination
/// pool note using STARK proof verification (quantum-resistant).
///
/// Instead of inline Groth16 verification, this instruction reads a pre-verified
/// STARK proof buffer from p01_stark_verifier. The proof was uploaded and verified
/// in prior transactions (init -> upload -> verify flow).
///
/// Required STARK proofs:
///   - Circuit 1 (pool_commitment): proves knowledge of secret + nullifier_preimage
///     that hash to the nullifier and commitment
///
/// The caller must verify the STARK proof BEFORE calling this instruction.
/// This instruction only checks that proof_buffer.verified == true.
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    subscriber_commitment: [u8; 32],
    rate: u64,
    interval_slots: u64,
    vk_hash_subscriber: [u8; 32],
    stark_commitment: u64,
    client_stealth_meta: Option<[u8; 64]>,
    license_commitment: Option<[u8; 32]>
)]
pub struct SubscribePrivateStark<'info> {
    /// Transaction payer
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Retailer who will receive periodic payments
    /// CHECK: Any pubkey can be a retailer
    pub retailer: AccountInfo<'info>,

    /// Subscription vault PDA (keyed by commitment instead of pubkey)
    #[account(
        init,
        payer = payer,
        space = SubscriptionVault::LEN,
        seeds = [
            SubscriptionVault::SEED_PREFIX,
            retailer.key().as_ref(),
            subscriber_commitment.as_ref(),
            denominated_pool.token_mint.as_ref()
        ],
        bump
    )]
    pub vault: Box<Account<'info, SubscriptionVault>>,

    /// Source denominated pool
    #[account(
        mut,
        seeds = [
            DenominatedPoolV3::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump,
        constraint = denominated_pool.is_active @ ZkShieldedError::PoolNotActive,
        constraint = denominated_pool.is_valid_root(&merkle_root) @ ZkShieldedError::InvalidMerkleRoot
    )]
    pub denominated_pool: Box<Account<'info, DenominatedPoolV3>>,

    /// Merkle tree state (read-only for unshield)
    #[account(
        seeds = [
            MerkleTreeStateV3::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Box<Account<'info, MerkleTreeStateV3>>,

    /// Nullifier record PDA — init for double-spend prevention
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
    pub nullifier_record: Box<Account<'info, NullifierRecord>>,

    /// C1 (pool_commitment) STARK proof buffer — proves knowledge of secret +
    /// nullifier_preimage hashing to the nullifier and commitment.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=1,
    /// verified, deep_ali_verified, public_inputs_hash).
    pub c1_proof_buffer: AccountInfo<'info>,

    /// C3 (merkle_path) STARK proof buffer — proves the commitment from C1 is a
    /// leaf at the supplied merkle root. Without this, subscribe verifies only
    /// C1 (knowledge of a well-formed note) and never that the note was ever
    /// deposited — a quantum/forging attacker could synthesize a valid C1 proof
    /// for any commitment and drain `denomination` per call. Mirrors the C3
    /// gate added to unshield_denominated_stark_v3.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=3,
    /// verified, deep_ali_verified, public_inputs_hash).
    pub c3_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL tokens)
    pub token_program: Option<Program<'info, Token>>,

    /// Pool's token vault (optional, only for SPL tokens)
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    /// Vault's token account (optional, only for SPL tokens)
    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<SubscribePrivateStark>,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    subscriber_commitment: [u8; 32],
    rate: u64,
    interval_slots: u64,
    vk_hash_subscriber: [u8; 32],
    stark_commitment: u64,
    client_stealth_meta: Option<[u8; 64]>,
    license_commitment: Option<[u8; 32]>,
) -> Result<()> {
    require!(rate > 0, ZkShieldedError::InvalidRate);
    require!(interval_slots > 0, ZkShieldedError::InvalidInterval);

    let clock = Clock::get()?;
    let pool_key = ctx.accounts.denominated_pool.key();
    let pool = &mut ctx.accounts.denominated_pool;
    let amount = pool.denomination;
    let is_native_sol = pool.token_mint == system_program::ID;

    // Check pool has sufficient balance
    require!(
        pool.total_shielded >= amount,
        ZkShieldedError::InsufficientBalance
    );

    // Dynamic delay check
    let current_epoch = DenominatedPoolV3::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);
    let dynamic_delay = pool.get_dynamic_delay();
    let effective_min_epoch = min_epoch
        .checked_add(dynamic_delay)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    require!(
        current_epoch >= effective_min_epoch,
        ZkShieldedError::EpochDelayNotMet
    );

    // Initialize nullifier record (double-spend check via init constraint)
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // -----------------------------------------------------------------------
    // C1 (pool_commitment) verification
    // -----------------------------------------------------------------------
    let c1_info = &ctx.accounts.c1_proof_buffer;

    // Must be owned by the STARK verifier program
    require!(
        *c1_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );

    let c1_data = c1_info.try_borrow_data()?;
    let (c1_authority, c1_circuit_id, c1_verified, c1_inputs_hash, c1_deep_ali_verified) =
        parse_stark_proof_buffer(&c1_data)?;

    // Authority must be the payer (prevents using someone else's proof)
    require!(
        c1_authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );

    // Must be pool_commitment circuit (ID 1)
    require!(c1_circuit_id == 1, ZkShieldedError::InvalidProof);

    // Must be verified
    require!(c1_verified, ZkShieldedError::InvalidProof);

    // Circuit 1 ships phase-2 DEEP-ALI from the client; require it.
    require!(c1_deep_ali_verified, ZkShieldedError::InvalidProof);

    // Nullifier canonicalization: the PDA is seeded on the full 32-byte
    // `nullifier`, but the proof only binds the low 8 bytes. Reject any
    // non-canonical nullifier whose high 24 bytes are non-zero, else a single
    // proof could be spent under multiple distinct nullifier PDAs (double-spend).
    require!(nullifier[8..] == [0u8; 24], ZkShieldedError::InvalidProof);

    // Verify the proof was generated for THIS nullifier + commitment by checking
    // the public inputs hash. The STARK verifier v2 stores
    //   sha256(nullifier_u64_le || commitment_u64_le)
    // as a single concatenated blob (one syscall), so reconstruct the same way.
    // The on-chain nullifier [u8; 32] stores the Goldilocks u64 in bytes 0..8.
    {
        let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
        let mut pub_buf = [0u8; 16];
        pub_buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
        pub_buf[8..].copy_from_slice(&stark_commitment.to_le_bytes());
        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(
            c1_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }

    drop(c1_data);

    // -----------------------------------------------------------------------
    // C3 (merkle_path) verification — proves the C1 commitment is a leaf in the
    // pool's tree at `merkle_root`. Without this, an attacker can synthesize a
    // valid C1 proof for a never-deposited commitment and drain `denomination`.
    // Mirrors unshield_denominated_stark_v3.
    // -----------------------------------------------------------------------
    let c3_info = &ctx.accounts.c3_proof_buffer;
    require!(
        *c3_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );
    let c3_data = c3_info.try_borrow_data()?;
    let (c3_authority, c3_circuit_id, c3_verified, c3_inputs_hash, c3_deep_ali_verified) =
        parse_stark_proof_buffer(&c3_data)?;

    require!(
        c3_authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );
    require!(c3_circuit_id == 3, ZkShieldedError::InvalidProof);
    require!(c3_verified, ZkShieldedError::InvalidProof);
    // Circuit 3 ships phase-2 DEEP-ALI from the client; require it.
    require!(c3_deep_ali_verified, ZkShieldedError::InvalidProof);

    // Reconstruct C3 expected hash. The merkle_path prover stores
    //   public_inputs: vec![leaf, root_u64, depth]  (three u64 felts)
    // hashed as concat(u64.to_le_bytes()) = 24 bytes. The V3 leaf format packs
    // the Goldilocks felt into bytes 0..8, so we extract the low 8 bytes for the
    // root. depth must be 15 (the depth the C3 periodic columns are baked for).
    // c3.leaf ↔ c1.commitment is tied implicitly: both reconstruct from the same
    // `stark_commitment` arg, so lying about either fails one of the two hashes.
    // c3.root ↔ pool ring is tied by the `is_valid_root(&merkle_root)` account
    // constraint on `denominated_pool` above.
    let tree_depth = pool.tree_depth as u64;
    require!(tree_depth == 15, ZkShieldedError::InvalidProof);
    {
        let mut pub_buf = [0u8; 24]; // 3 × u64 LE: leaf, root, depth
        pub_buf[..8].copy_from_slice(&stark_commitment.to_le_bytes());
        pub_buf[8..16].copy_from_slice(&merkle_root[..8]);
        pub_buf[16..24].copy_from_slice(&tree_depth.to_le_bytes());
        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(
            c3_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }
    drop(c3_data);

    // NOTE: Replay prevention handled by the nullifier PDA + subscription state.
    // Proof buffers owned by p01_stark_verifier — cannot write to them from
    // zk_shielded. Caller closes them.

    // -----------------------------------------------------------------------
    // Transfer funds from pool to vault (identical to Groth16 version)
    // -----------------------------------------------------------------------
    let token_mint = pool.token_mint;
    let denomination_bytes = pool.denomination.to_le_bytes();
    let bump = pool.bump;
    let seeds = &[
        DenominatedPoolV3::SEED_PREFIX,
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

        **pool.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? += amount;
    } else {
        let token_program = ctx.accounts.token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let pool_vault = ctx.accounts.pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;
        let vault_token = ctx.accounts.vault_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;

        require!(pool_vault.mint == pool.token_mint, ZkShieldedError::InvalidTokenMint);
        require!(pool_vault.owner == pool.key(), ZkShieldedError::InvalidTokenOwner);
        require!(vault_token.mint == pool.token_mint, ZkShieldedError::InvalidTokenMint);

        let transfer_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            TokenTransfer {
                from: pool_vault.to_account_info(),
                to: vault_token.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;
    }

    // Update pool state
    pool.total_shielded = pool
        .total_shielded
        .checked_sub(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.note_count = pool
        .note_count
        .checked_sub(1)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;
    pool.mature_note_count = pool.mature_note_count.saturating_sub(1);

    // Initialize vault state
    let vault = &mut ctx.accounts.vault;
    vault.subscriber_pubkey = None;
    vault.subscriber_commitment = Some(subscriber_commitment);
    vault.retailer = ctx.accounts.retailer.key();
    vault.token_mint = pool.token_mint;
    vault.total_deposited = amount;
    vault.rate = rate;
    vault.interval_slots = interval_slots;
    vault.start_slot = clock.slot as i64;
    vault.claimed_periods = 0;
    vault.is_active = true;
    vault.is_paused = false;
    vault.pause_slot = None;
    vault.total_paused_slots = 0;
    vault.vk_hash_subscriber = vk_hash_subscriber;
    vault.source_pool = Some(pool_key);
    vault.bump = ctx.bumps.vault;
    vault.client_stealth_meta = client_stealth_meta;
    vault.license_commitment = license_commitment;

    let has_stealth_meta = client_stealth_meta.is_some();

    emit!(SubscribePrivateStarkEvent {
        vault: vault.key(),
        subscriber_commitment,
        retailer: ctx.accounts.retailer.key(),
        token_mint: pool.token_mint,
        amount,
        rate,
        interval_slots,
        source_pool: pool_key,
        nullifier,
        start_slot: clock.slot as i64,
        has_stealth_meta,
    });

    Ok(())
}

#[event]
pub struct SubscribePrivateStarkEvent {
    pub vault: Pubkey,
    pub subscriber_commitment: [u8; 32],
    pub retailer: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub rate: u64,
    pub interval_slots: u64,
    pub source_pool: Pubkey,
    pub nullifier: [u8; 32],
    pub start_slot: i64,
    /// DEPRECATED. True if the vault was created with a stealth meta address.
    /// It selected the refund-via-relayer path on cancel; there is no cancel
    /// and no refund, so this now reports a field nothing acts on. The 64 raw
    /// bytes are NOT emitted, to avoid leaking the address itself.
    pub has_stealth_meta: bool,
}
