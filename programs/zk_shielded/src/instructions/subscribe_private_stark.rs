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
    // DEPRECATED, and no longer writable. `client_stealth_meta` used to take a
    // 64-byte subscriber-controlled stealth address — `[spending_pub(32) |
    // viewing_pub(32)]` — straight from the instruction data into this public
    // account, where it selected the refund-via-relayer path on cancel. There
    // is no cancel and no refund, so the only thing it could still do was
    // publish a subscriber's stealth address for a feature that can never fire.
    // The parameter is gone from the instruction too, so those bytes no longer
    // reach the chain at all; leaving the parameter in place would have kept
    // them in the transaction payload, which is every bit as public as the
    // account. The FIELD stays, always `None`, because `SubscriptionVault::LEN`
    // and the account layout must not move under the vaults already live on
    // devnet.
    vault.client_stealth_meta = None;
    vault.license_commitment = license_commitment;

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
        // Always false now, and kept only so the event's Borsh layout does not
        // move under decoders already built against it. See the field's doc.
        has_stealth_meta: false,
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
    /// DEPRECATED and now permanently `false`. It reported whether the vault
    /// was created with a stealth meta address, which selected the
    /// refund-via-relayer path on cancel. There is no cancel, no refund, and
    /// since the `client_stealth_meta` parameter was removed no way to supply
    /// one either. Retained, and never removed, because Borsh decodes an event
    /// sequentially and dropping a field silently shortens the buffer for every
    /// decoder built against the old layout.
    pub has_stealth_meta: bool,
}

// ---------------------------------------------------------------------------
// Structural guard on the stealth-meta removal.
//
// Nothing executes this handler either — same gap as `claim_period`, same
// reason. This guard exists because the removal it protects was MEASURED to be
// unguarded: putting `vault.client_stealth_meta = Some(..)` back left
// `cargo test -p zk_shielded` at 26 passed / 0 failed, and the client-side
// encoder tests only cover the instruction ARGUMENT, never what the program
// writes into the account.
//
// What it protects. `client_stealth_meta` was a 64-byte subscriber-controlled
// stealth address, `[spending_pub(32) | viewing_pub(32)]`, written into a PUBLIC
// account so `cancel_private_stark` could route a refund to it through
// `p01_relayer`. There is no cancel and no refund, so publishing it buys
// nothing and links a subscriber's stealth identity to a vault forever.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod stealth_meta_guard {
    const SRC: &str = include_str!("subscribe_private_stark.rs");

    /// Code only. A comment naming the field must not satisfy an assertion
    /// about the field — `claim_period`'s decoy guard was hollow for exactly
    /// that reason, and that was measured, not suspected.
    fn code() -> String {
        let end = SRC.find("mod stealth_meta_guard").expect("guard marker");
        SRC[..end]
            .lines()
            .map(|l| match l.find("//") {
                Some(at) => &l[..at],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_comment_stripper_actually_strips() {
        assert!(
            SRC.contains("DEPRECATED, and no longer writable."),
            "fixture reworded — pick another comment",
        );
        assert!(
            !code().contains("DEPRECATED, and no longer writable."),
            "code() is leaking comments; the guards below become prose matches",
        );
        assert!(code().contains("pub fn handler("));
    }

    #[test]
    fn subscribe_never_writes_a_stealth_address_into_the_public_vault() {
        let code = code();
        let writes: Vec<&str> = code
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("vault.client_stealth_meta ="))
            .collect();
        assert_eq!(
            writes,
            vec!["vault.client_stealth_meta = None;"],
            "the deprecated stealth-meta field must be written None and nothing \
             else — anything else republishes a 64-byte subscriber-controlled \
             stealth address into a public account, for a refund path that no \
             longer exists",
        );
    }

    #[test]
    fn the_handler_takes_no_stealth_meta_argument_at_all() {
        // Stopping only the WRITE would have left the 64 bytes in the
        // transaction payload, which is exactly as public as the account they
        // used to land in. The parameter is gone; this keeps it gone.
        let code = code();
        let sig_start = code.find("pub fn handler(").expect("handler signature");
        let sig_end = code[sig_start..].find(") -> Result<").expect("end of signature") + sig_start;
        assert!(
            !code[sig_start..sig_end].contains("client_stealth_meta"),
            "subscribe_private_stark takes a client_stealth_meta argument again \
             — the subscriber's stealth address is back in the public \
             transaction payload even if nothing stores it",
        );
    }

    #[test]
    fn the_event_never_reports_a_stealth_meta_and_never_carries_the_bytes() {
        let code = code();
        assert!(
            code.contains("has_stealth_meta: false,"),
            "the event's has_stealth_meta is no longer pinned false",
        );
        // An event is as public as an account, so the raw address must never be
        // emitted either.
        assert!(
            !code.lines().any(|l| l.trim() == "client_stealth_meta,"),
            "the 64 raw stealth bytes are being emitted in an event",
        );
    }
}

// ---------------------------------------------------------------------------
// Structural guard on the PDA bump derivation.
//
// This pins the SHAPE of the two note-seeded PDAs: both stay Anchor `init`
// accounts with a BARE `bump`, i.e. the runtime searches for the canonical
// bump and the handler takes no bump argument. The reasoning and the
// measurements are in the block above the `vault` field.
//
// The guard exists because the change it blocks is a five-line change that
// reads as an obvious win and is not one, and because NEITHER of its two
// failure modes is caught by anything else in the tree:
//
//   - `bump = <arg>` on an `init` account still calls find_program_address
//     (anchor-syn 0.32.1 codegen/accounts/constraints.rs:548-555, spliced at
//     :1083). It compiles, deploys, passes every test, breaks every shipped
//     client's instruction encoding, and changes the compute cost by nothing.
//     There is no failing assertion anywhere that would say so.
//   - Dropping `init` for `create_program_address` on a caller-supplied bump
//     gives ~128 valid record addresses per nullifier. That one does not
//     announce itself either; it shows up as a drained pool.
//
// Same discipline as `stealth_meta_guard`: assertions run against CODE with
// comments stripped, because a comment naming a constraint must never be what
// satisfies an assertion about the constraint.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod pda_bump_guard {
    const SRC: &str = include_str!("subscribe_private_stark.rs");

    /// Everything before the first test module, with comments removed.
    fn code() -> String {
        let end = SRC.find("mod stealth_meta_guard").expect("guard marker");
        SRC[..end]
            .lines()
            .map(|l| match l.find("//") {
                Some(at) => &l[..at],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The `#[account(...)]` attribute immediately preceding `pub <field>:`.
    fn account_attr(code: &str, field_decl: &str) -> String {
        let field_at = code
            .find(field_decl)
            .unwrap_or_else(|| panic!("field `{field_decl}` not found"));
        let attr_at = code[..field_at]
            .rfind("#[account(")
            .unwrap_or_else(|| panic!("no #[account(..)] before `{field_decl}`"));
        code[attr_at..field_at].to_string()
    }

    #[test]
    fn the_comment_stripper_actually_strips() {
        assert!(
            SRC.contains("restates public data"),
            "fixture reworded — pick another phrase from the vault block",
        );
        assert!(
            !code().contains("restates public data"),
            "code() is leaking comments; the guards below become prose matches",
        );
        assert!(code().contains("pub fn handler("));
    }

    #[test]
    fn both_note_seeded_pdas_still_search_for_the_canonical_bump() {
        let code = code();
        for field in ["pub vault:", "pub nullifier_record:"] {
            let attr = account_attr(&code, field);
            assert!(
                attr.contains("init,") && attr.contains("seeds = ["),
                "`{field}` is no longer an Anchor `init` + `seeds` account. If the \
                 derivation was hand-rolled to reach the constant-cost \
                 `create_program_address` form, the canonical-bump guarantee is \
                 gone with it — for `nullifier_record` that is ~128 record \
                 addresses per nullifier and a pool drain. Read the block above \
                 the `vault` field before changing this line.",
            );
            assert!(
                !attr.contains("bump ="),
                "`{field}` now takes a bump target. On an `init` account that does \
                 NOT replace the find_program_address search — anchor-syn 0.32.1 \
                 emits it either way (codegen/accounts/constraints.rs:548-555, \
                 spliced at :1083) and a bump target only adds an equality check \
                 (:512-527). So this buys zero compute units while breaking the \
                 instruction encoding of every shipped client. Measured, not \
                 assumed.",
            );
        }
    }

    #[test]
    fn the_handler_takes_no_bump_argument() {
        let code = code();
        let sig_start = code.find("pub fn handler(").expect("handler signature");
        let sig_end = code[sig_start..].find(") -> Result<").expect("end of signature") + sig_start;
        assert!(
            !code[sig_start..sig_end].contains("bump"),
            "subscribe_private_stark takes a bump argument. Every client \
             (apps/web, apps/extension, apps/mobile) hand-rolls this instruction's \
             Borsh payload, so this is a breaking wire change; and on an `init` \
             account the bump cannot remove the PDA search that motivated it. \
             Read the block above the `vault` field.",
        );
    }
}

// ===========================================================================
// WHY THE PDA DERIVATIONS ABOVE ARE STILL `bump` (bare), and why that is not
// the leak it looks like.
//
// This analysis lived inline on `vault` and `nullifier_record` until it was
// moved down here on 2026-08-21. It was 119 lines in the middle of an accounts
// struct, and it had shifted every line below it — 38 numbered citations across
// web, extension, mobile, the SDK and docs point INTO this file, and all of them
// broke at once. The prose was right and its placement was a cost nobody priced.
// Keep it here: appended text shifts nothing.
// ===========================================================================
//
// ─────────────────────────────────────────────────────────────────────
// CONSTANT-COST PDA DERIVATION: MEASURED, AND DELIBERATELY NOT DONE.
//
// THE ASK. Ten subscriptions at identical denomination, vault size and
// program consumed 28,918 to 40,721 CU, all ten distinct — a near-unique
// fingerprint in the public logs. Cause named correctly: this account and
// `nullifier_record` are the only two PDAs here derived at RUNTIME with a
// bare `bump`, so Anchor searches for the canonical bump and the probe
// count follows the seeds. The proposed fix was to take both bumps as
// instruction arguments and write `bump = vault_bump`, so the runtime
// VERIFIES a supplied bump at constant cost instead of SEARCHING. Five
// lines, one redeploy.
//
// It does not work, and the way it fails is invisible. Two findings read
// out of the pinned toolchain rather than assumed, then the answer to the
// question that was asked:
//
// 1. `bump = <expr>` DOES NOT REMOVE THE SEARCH ON AN `init` ACCOUNT.
//    anchor-syn 0.32.1 emits `Pubkey::find_program_address` for every
//    `init` + `seeds` account unconditionally — the `find_pda` token
//    stream is built at codegen/accounts/constraints.rs:548-555 and spliced
//    in at :1083 with no branch on whether a bump target was given. A
//    `bump = <expr>` target only ADDS `if __bump != <expr> { ConstraintSeeds }`
//    on top of the search (:512-527, whose own comment reads "If the bump
//    is provided with init *and target*, then force it to be the canonical
//    bump"). The constant-cost `Pubkey::create_program_address` form lives
//    ONLY on the non-init path, :1183-1188 — which is exactly why
//    `denominated_pool` (`bump = denominated_pool.bump`) and `merkle_tree`
//    already cost a constant and these two do not. So the change costs
//    every shipped client a coordinated redeploy, adds a byte to the
//    payload, and buys ZERO compute units. It would have shipped looking
//    like a fix.
//
// 2. DROPPING `init` TO REACH THE CONSTANT FORM IS A DOUBLE-SPEND HOLE.
//    See the block on `nullifier_record` below. It is not a hole here — a
//    non-canonical vault is only an address no client would derive — but
//    the two accounts have to move together or the fingerprint survives on
//    the half that stayed, and half a distinguisher is a distinguisher.
//
// 3. THE FOUNDER'S QUESTION — a bump passed as an argument becomes PUBLIC;
//    does it reveal anything the transaction does not already reveal?
//    It becomes public, and it reveals NOTHING NEW. A bump is the unique
//    `b` for which `create_program_address(seeds ‖ b) == address`. Both
//    addresses are already on the wire: the vault is account #2 of this
//    instruction and the nullifier record is account #5. Both seed sets are
//    already published by this same transaction — `retailer` is account #1,
//    `subscriber_commitment` and `nullifier` are both emitted in
//    `SubscribePrivateStarkEvent` at the bottom of this file, and
//    `token_mint` and the pool key are public account state. Address plus
//    seeds determines the bump, so an observer can already compute it and
//    H(bump | transaction) is zero before the argument is added. Passing it
//    moves a byte, not a fact. This is the pattern Solana's own PDA
//    documentation teaches: solana-pubkey-2.4.0/src/lib.rs:641-651 passes
//    `vault_bump_seed` in instruction data.
//
// AND THAT ANSWER APPLIES BACKWARDS, to the CU fingerprint itself. The
// search cost is a deterministic function of the seeds and the program id,
// and every seed of both PDAs is published by this same transaction (the
// list is in point 3). So the CU number restates public data: an observer
// who has the transaction can predict it, whatever the runtime's per-probe
// metering turns out to be. `find_program_address` walks bumps downward
// from 255 — the host reference implementation is
// solana-pubkey-2.4.0/src/lib.rs:828-829, and the on-chain syscall must
// agree with it because it returns the same canonical bump — so the number
// of probes is fixed once the canonical bump is, and the canonical bump is
// fixed once the address is.
//
// That does NOT make the fingerprint harmless, and it is NOT a reason to
// like it. What it does mean is that turning a candidate pool leaf into a
// predicted CU cost still needs the note secret, because it needs the
// nullifier, and the CU adds nothing that the nullifier and the vault
// address in the very same transaction do not already give up. Anyone
// arguing this instruction leaks the buyer through its compute meter has to
// show a step that does not already fall out of those two values. Nobody
// has, and the other data-dependent costs in the handler do not supply one
// either: `is_valid_root` scans `historical_roots` linearly
// (state/pool_v3.rs:191-196), but on the `merkle_root` this instruction
// takes as a cleartext argument, and the license `Option` tag tracks a
// field written into the public vault account.
//
// WHAT WOULD ACTUALLY FLATTEN IT. Only padding: let Anchor search, then
// burn the difference up to the worst case, 255 extra `create_program_address`
// probes per PDA on EVERY transaction, forever. That is a real price on
// every subscriber to erase a number an observer can already derive, and it
// is not being paid silently. Rejecting a low canonical bump instead is not
// an option: the note is already deposited, so a rejected bump is a
// stranded note.
//
// A `#[cfg(test)] mod pda_bump_guard` at the bottom of this file pins the
// shape, because measurement 1 is the kind of change nothing else catches.
// ─────────────────────────────────────────────────────────────────────
//
// ─────────────────────────────────────────────────────────────────────
// WHY THIS ONE CANNOT TAKE ITS BUMP AS AN ARGUMENT, EVER.
//
// The double-spend guard on this instruction is not a comparison; it is
// the EXISTENCE of this account at ONE address. `init` fails if the
// account is already there, and that is the whole mechanism.
//
// That mechanism holds only because the address is the CANONICAL one.
// `create_program_address(seeds ‖ b)` succeeds for roughly half of the 256
// values of `b` — every `b` whose result lands off the ed25519 curve. So a
// caller who is allowed to choose `b` gets on the order of 128 DISTINCT
// valid record PDAs for ONE nullifier, and spends the same note once per
// address. Class: pool drain, and it would pass every check in this file —
// C1, C3, the inputs-hash bindings and the `nullifier[8..] == 0`
// canonicalisation all bind the nullifier VALUE, and none of them binds the
// record's ADDRESS.
//
// Anchor's `init` is what forbids this today: with a `bump = <expr>` target
// it forces the supplied bump to equal the canonical one
// (anchor-syn 0.32.1 codegen/accounts/constraints.rs:512-527). And the only
// way to establish that a bump is canonical is to show every higher bump
// fails — i.e. to run the search. Constant cost and canonicality are the
// same question asked twice; you cannot have both.
//
// Closing the CU fingerprint here therefore means replacing the guard, not
// the derivation — a nullifier set that is not addressed by the nullifier.
// That is a state-layout change against live records, not a five-line one.
// ─────────────────────────────────────────────────────────────────────
