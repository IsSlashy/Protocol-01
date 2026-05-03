use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, PROTOCOL_FEE_WALLET};
use crate::state::NullifierRecord;
use crate::state::pool_v3::DenominatedPoolV3;
use crate::state::merkle_tree_v3::MerkleTreeStateV3;

/// STARK Proof Buffer account discriminator (from p01_stark_verifier).
const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

// DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// ProofBuffer layout offsets (must match p01_stark_verifier::ProofBuffer).
/// Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written + 1 verified + 32 public_inputs_hash = 82
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40; // 8 + 32
const PROOF_BUF_VERIFIED: usize = 49;   // 8 + 32 + 1 + 4 + 4
const PROOF_BUF_INPUTS_HASH: usize = 50; // 8 + 32 + 1 + 4 + 4 + 1
const PROOF_BUF_MIN_LEN: usize = 82;    // 8 + 32 + 1 + 4 + 4 + 1 + 32

/// Parse a verified STARK proof buffer.
fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32])> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, ZkShieldedError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID]).unwrap();
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_MIN_LEN]);
    Ok((authority, circuit_id, verified, public_inputs_hash))
}

/// V3 unshield from a denominated pool.
///
/// Mirrors v2's `unshield_denominated_stark` except:
///   - `pool` is a `DenominatedPoolV3` (Goldilocks Poseidon tree).
///   - Requires TWO STARK proof buffer accounts:
///       * `c1_proof_buffer` — the pool_commitment STARK proof (proves
///         knowledge of secret + nullifier_preimage hashing to nullifier and
///         commitment). Same as v2.
///       * `c3_proof_buffer` — NEW. The merkle_path STARK proof. Proves the
///         commitment from C1 is actually at the supplied merkle root. v2
///         skipped this — `is_valid_root` only checked the supplied root was
///         in the historical ring, which is a giant trust gap (a quantum
///         attacker can synthesize a valid C1 proof for any commitment they
///         can construct, regardless of whether it's in the tree).
///   - On-chain checks:
///       * `c1.public_inputs.commitment == c3.public_inputs.leaf` (tie the
///         two proofs to the same commitment).
///       * `c3.public_inputs.root` is in `pool.historical_roots` (or matches
///         the current root) — i.e. the membership proof targets a root the
///         pool has ever vouched for.
///       * Otherwise identical to v2 (nullifier PDA write, fee split,
///         payer-vs-authority auth, prefund path).
///
/// NOTE: For brevity in this scaffold the optional `prefund_record` path
/// from v2 is NOT included. The next agent should port it once the C3
/// public-inputs hash format is finalized — the prefund record stores the
/// hash of the C1 proof's public inputs, and we'd want to extend it to store
/// the C3 hash too (or store both proof_buffer pubkeys in the record).
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64
)]
pub struct UnshieldDenominatedStarkV3<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Any address can receive tokens
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

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
    pub denominated_pool: Account<'info, DenominatedPoolV3>,

    #[account(
        seeds = [
            MerkleTreeStateV3::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeStateV3>,

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

    /// C1 (pool_commitment) STARK proof buffer — proves nullifier + commitment.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=1,
    /// verified, public_inputs_hash).
    pub c1_proof_buffer: AccountInfo<'info>,

    /// C3 (merkle_path) STARK proof buffer — proves the commitment is at
    /// the merkle root. NEW in V3.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=3,
    /// verified, public_inputs_hash).
    pub c3_proof_buffer: AccountInfo<'info>,

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
}

pub fn handler(
    ctx: Context<UnshieldDenominatedStarkV3>,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.denominated_pool;
    let amount = pool.denomination;
    let is_native_sol = pool.token_mint == system_program::ID;

    require!(
        pool.total_shielded >= amount,
        ZkShieldedError::InsufficientBalance
    );

    // Maturity is a UX/SDK concern in V3 (same as v2). We update bookkeeping
    // for anonymity metrics but don't enforce.
    let current_epoch = DenominatedPoolV3::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);
    let dynamic_delay = pool.get_dynamic_delay();

    // Initialize nullifier record (double-spend protection)
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // -----------------------------------------------------------------------
    // C1 (pool_commitment) verification
    // -----------------------------------------------------------------------
    let c1_info = &ctx.accounts.c1_proof_buffer;
    require!(
        *c1_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );
    let c1_data = c1_info.try_borrow_data()?;
    let (c1_authority, c1_circuit_id, c1_verified, c1_inputs_hash) =
        parse_stark_proof_buffer(&c1_data)?;

    require!(
        c1_authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );
    require!(c1_circuit_id == 1, ZkShieldedError::InvalidProof);
    require!(c1_verified, ZkShieldedError::InvalidProof);

    // Reconstruct C1 expected hash: sha256(nullifier_u64_le || commitment_u64_le)
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
    // C3 (merkle_path) verification — NEW in V3
    // -----------------------------------------------------------------------
    let c3_info = &ctx.accounts.c3_proof_buffer;
    require!(
        *c3_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );
    let c3_data = c3_info.try_borrow_data()?;
    let (c3_authority, c3_circuit_id, c3_verified, c3_inputs_hash) =
        parse_stark_proof_buffer(&c3_data)?;

    require!(
        c3_authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );
    require!(c3_circuit_id == 3, ZkShieldedError::InvalidProof);
    require!(c3_verified, ZkShieldedError::InvalidProof);

    // Reconstruct C3 expected hash. The merkle_path PROVER
    // (`stark/src/compact.rs::generate_merkle_path_compact_proof`, line 3961)
    // stores `public_inputs: vec![leaf, root_u64]` — exactly TWO u64 felts.
    // (Note: the AIR's `MerklePathPublicInputs::to_elements` returns THREE
    // including depth, but only the first two are exposed via the prover's
    // `public_inputs` field that the mobile sends to the verifier.)
    //
    // The verifier (`p01_stark_verifier::verify_stark_proof_v2`, lines
    // 182-186) hashes them as `concat(u64.to_le_bytes() for each input)`
    // = 16 bytes. The V3 leaf format packs the Goldilocks felt into bytes
    // 0..8 of the 32-byte buffer, so we extract the low 8 bytes for the
    // root.
    {
        let mut pub_buf = [0u8; 16]; // 2 × u64 LE: leaf, root
        pub_buf[..8].copy_from_slice(&stark_commitment.to_le_bytes());
        pub_buf[8..16].copy_from_slice(&merkle_root[..8]);
        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(
            c3_inputs_hash == expected_hash,
            ZkShieldedError::InvalidProof
        );
    }
    drop(c3_data);

    // Tie c3.root ↔ pool ring is enforced by the `is_valid_root` constraint
    // on the `denominated_pool` account above (line `constraint = ...
    // is_valid_root(&merkle_root)`). Tying c3.leaf ↔ c1.commitment is
    // implicit because both reconstruct hashes from the same `stark_commitment`
    // arg — if the caller lies about either, one of the two hash checks fails.

    // -----------------------------------------------------------------------
    // Transfer funds with protocol fee (0.5%)
    // -----------------------------------------------------------------------
    let (unshield_fee, recipient_amount) = fee::calculate_fee(amount, fee::UNSHIELD_FEE_BPS);

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

        if unshield_fee > 0 {
            let pool_lamports = pool.to_account_info().lamports();
            let rent = Rent::get()?;
            let min_rent = rent.minimum_balance(pool.to_account_info().data_len());
            if pool_lamports.saturating_sub(min_rent) >= unshield_fee {
                **pool.to_account_info().try_borrow_mut_lamports()? -= unshield_fee;
                **ctx.accounts.protocol_fee_wallet.try_borrow_mut_lamports()? += unshield_fee;
            }
        }
    }

    // Update pool state
    pool.total_shielded = pool.total_shielded.checked_sub(amount)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.note_count = pool.note_count.checked_sub(1)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    pool.last_tx_at = clock.unix_timestamp;
    pool.mature_note_count = pool.mature_note_count.saturating_sub(1);

    emit!(UnshieldDenominatedStarkV3Event {
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
pub struct UnshieldDenominatedStarkV3Event {
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
