//! [C7] Unshield from a V3 pool on ONE proof instead of two.
//!
//! # What changes against v3
//!
//! v3 spends on a pair: C1 (`pool_commitment`) publishes the note commitment
//! and proves the nullifier is derived from it; C3 (`merkle_path`) proves that
//! same commitment is a leaf under a root the pool published. The two are tied
//! through the `stark_commitment` argument, which both public-input hashes are
//! rebuilt from.
//!
//! That shared value is exactly the problem. **The commitment is published on
//! chain**, so a spend names the very leaf it is spending, and anyone reading
//! the tree can point at the deposit that funded it. Circuit 7 proves both
//! halves in one trace and publishes `[nullifier, root, rh0, rh1, rh2, rh3]` —
//! no commitment anywhere. See `stark/src/air/spend.rs`.
//!
//! Three consequences for this file:
//!
//!   * ONE proof buffer instead of two. `stark_commitment` is gone as an
//!     argument, because on-chain code is not supposed to know it.
//!   * The recipient is bound BY THE PROOF, not merely by the payer signature.
//!     `sha256(recipient_pubkey)` is four of the six public inputs, so a
//!     relayer that re-points the payout invalidates the proof it is relaying.
//!     v3 had no such binding — only `c3_authority == payer`.
//!   * The root the circuit proves is a **depth-12 subtree** root, and this
//!     instruction has to finish the job. See below; it is the whole reason
//!     `state/spend_root.rs` and `state/poseidon_gl.rs` exist.
//!
//! # ⛔ The half of C7 that lives here, not in the circuit
//!
//! `CANONICAL_DEPTH` in `air/spend.rs` is **12**. The pool tree is **15**. A
//! verified C7 proof therefore asserts:
//!
//!     "I know a leaf and a twelve-level path from it to the root I published."
//!
//! and NOT "that leaf is in this pool". Anyone who builds their own twelve
//! levels over an invented leaf gets a proof the deployed verifier accepts.
//! Routing a payout on that alone is `unshield` C5 before 2026-08-18 — a
//! fund-loss defect, not a gap.
//!
//! So the handler walks the remaining `tree_depth - 12` levels itself, hashing
//! the subtree root against siblings the CALLER supplies, and then requires the
//! result to name a root the pool has vouched for.
//!
//! ⛔ NOT `filled_subtrees`. That array is an insertion frontier — the left
//! siblings along the path of the *next* leaf. It cannot supply the siblings of
//! an arbitrary existing leaf, and no proof binds it. Reaching for it here
//! would look plausible and would open a second hole.
//!
//! Caller-supplied siblings are safe because they are not trusted: they only
//! *name* a candidate root, and `is_valid_root` accepts nothing the pool did
//! not itself publish. Wrong siblings give a root that was never in the ring.
//!
//! # 🚨 Why `is_valid_root` is NOT an account constraint here
//!
//! In v3 it sits on the `denominated_pool` account, as
//! `constraint = denominated_pool.is_valid_root(&merkle_root)`. A reader coming
//! from that file will look for it in the same place and not find it.
//!
//! It cannot live there. In v3 the root is an argument, known before the
//! handler runs. In v4 the root is **derived** — it does not exist until the
//! Poseidon walk has run — so the check is necessarily in the handler, after
//! `resolve_pool_root`. Moving it back to the accounts struct would check a
//! root nobody proved anything about.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
use crate::fee::{self, FEE_ESCROW_SEED_PREFIX};
use crate::state::NullifierRecord;
use crate::state::merkle_tree_v3::MerkleTreeStateV3;
use crate::state::pool_v3::DenominatedPoolV3;
use crate::state::spend_root::{self, SpendRootError};

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
/// Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written
///       + 1 verified + 32 public_inputs_hash + 1 deep_ali_verified = 83
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_DEEP_ALI_VERIFIED: usize = 82;
const PROOF_BUF_MIN_LEN: usize = 83;

/// The circuit id this instruction — and only this instruction — spends on.
const CIRCUIT_SPEND: u8 = 7;

/// `pub_bytes` for circuit 7: six Goldilocks felts, 8 LE bytes each.
///
/// The ORDER is frozen and load-bearing three times over: it feeds the
/// Fiat-Shamir transcript in `stark/src/compact.rs`, it is what
/// `boundary_assertions_for_circuit(7, ..)` indexes, and it is what this file
/// rebuilds. Any disagreement is a rejected proof, not a silent hole — but it
/// is a rejection discovered at the END of a ~150-transaction upload.
const C7_PUB_BYTES_LEN: usize = 48;

pub fn spend_root_error(e: SpendRootError) -> ZkShieldedError {
    match e {
        SpendRootError::PoolShallowerThanCircuit => ZkShieldedError::SpendPoolShallowerThanCircuit,
        SpendRootError::WrongSiblingCount => ZkShieldedError::SpendWrongSiblingCount,
        SpendRootError::NonBinaryDirection => ZkShieldedError::SpendNonBinaryDirection,
        SpendRootError::NonCanonicalFelt => ZkShieldedError::SpendNonCanonicalFelt,
    }
}

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

/// Rebuild the 48 bytes circuit 7 hashed into `public_inputs_hash`.
///
/// # 🚨 The last 32 bytes ARE the sha256 digest, and that is not a coincidence
/// # to be simplified away
///
/// The prover takes `recipient_hash: [u64; 4]` and writes `rh.to_le_bytes()`
/// for each. The client fills those four from `sha256(recipient_pubkey)` as
/// `u64::from_le_bytes(digest[8i..8i+8])`. Little-endian round-trips, so the
/// concatenation of the four is the digest byte-for-byte — which is why this
/// function can copy the digest in one move instead of splitting and
/// re-joining.
///
/// ⛔ That identity holds only because the felts are carried RAW. They occupy
/// no trace column and no constraint (`air/spend.rs`: the binding is
/// transcript-only, exactly as C3's `depth` is), so nothing ever reduces them
/// mod p. If a future change makes the prover publish reduced felts instead,
/// a digest limb ≥ the Goldilocks modulus would stop round-tripping and this
/// shortcut becomes wrong. `the_four_recipient_felts_reassemble_the_digest`
/// below is the guard on that.
fn c7_pub_bytes(nullifier_u64: u64, subtree_root: u64, recipient: &Pubkey) -> [u8; C7_PUB_BYTES_LEN] {
    let digest = solana_sha256_hasher::hashv(&[recipient.as_ref()]).to_bytes();
    let mut buf = [0u8; C7_PUB_BYTES_LEN];
    buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
    buf[8..16].copy_from_slice(&subtree_root.to_le_bytes());
    buf[16..48].copy_from_slice(&digest);
    buf
}

/// V4 unshield from a denominated pool, on a single circuit-7 proof.
///
/// `merkle_root` is the pool root the caller NAMES; `subtree_root`, `siblings`
/// and `directions` are what the handler uses to DERIVE it. Both are required:
/// the derivation says "this is the root my proof reaches", the named root says
/// "and it is one you published". Neither alone is a membership check.
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    subtree_root: u64,
    siblings: Vec<u64>,
    directions: Vec<u8>,
    recipient: [u8; 32]
)]
pub struct UnshieldDenominatedStarkV4<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    // `recipient` is in `remaining_accounts[0]`, not a named account — the
    // indexability adaptation carried over from v3, so a naive Solscan-style
    // indexer cannot resolve "recipient: ABC" from the IDL. Unlike v3 the
    // cryptographic binding no longer rests on the payer signature alone: the
    // recipient's sha256 is inside the proof transcript.
    #[account(
        mut,
        seeds = [
            DenominatedPoolV3::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump,
        constraint = denominated_pool.is_active @ ZkShieldedError::PoolNotActive,
        // 🚨 NO `is_valid_root` constraint here, unlike v3. The root does not
        // exist yet at this point — it is the OUTPUT of the Poseidon walk. See
        // the module header.
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

    /// C7 (spend) STARK proof buffer — the ONLY proof this instruction reads.
    /// It proves, in one trace, that the nullifier derives from a well-formed
    /// commitment AND that the commitment is a leaf under `subtree_root`.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=7,
    /// verified, deep_ali_verified, public_inputs_hash).
    pub c7_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Option<Program<'info, Token>>,

    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub recipient_token_account: Option<Account<'info, TokenAccount>>,

    /// Per-pool fee escrow PDA. Seeds: [b"fee_escrow", pool.key()].
    #[account(
        mut,
        seeds = [FEE_ESCROW_SEED_PREFIX, denominated_pool.key().as_ref()],
        bump,
    )]
    pub fee_escrow: SystemAccount<'info>,
}

pub fn handler(
    ctx: Context<UnshieldDenominatedStarkV4>,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    subtree_root: u64,
    siblings: Vec<u64>,
    directions: Vec<u8>,
    recipient: [u8; 32],
) -> Result<()> {
    let recipient_account = ctx
        .remaining_accounts
        .first()
        .ok_or(ZkShieldedError::MissingRecipient)?;
    require!(
        recipient_account.key() == Pubkey::new_from_array(recipient),
        ZkShieldedError::MismatchedRecipient
    );

    let clock = Clock::get()?;
    let pool = &mut ctx.accounts.denominated_pool;
    let amount = pool.denomination;
    let is_native_sol = pool.token_mint == system_program::ID;

    require!(
        pool.total_shielded >= amount,
        ZkShieldedError::InsufficientBalance
    );

    // The two depth fields must agree before either is used to size the walk.
    // They are written by different instructions and nothing else compares them;
    // a pool whose tree state disagrees about its own depth would silently make
    // the sibling count mean something different from what the caller proved.
    require!(
        pool.tree_depth == ctx.accounts.merkle_tree.depth,
        ZkShieldedError::InvalidMerkleRoot
    );

    let current_epoch = DenominatedPoolV3::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);
    let dynamic_delay = pool.get_dynamic_delay();

    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // -----------------------------------------------------------------------
    // C7 (spend) verification
    // -----------------------------------------------------------------------
    let c7_info = &ctx.accounts.c7_proof_buffer;
    require!(
        *c7_info.owner == STARK_VERIFIER_PROGRAM_ID,
        ZkShieldedError::InvalidProof
    );
    let c7_data = c7_info.try_borrow_data()?;
    let (c7_authority, c7_circuit_id, c7_verified, c7_inputs_hash, c7_deep_ali_verified) =
        parse_stark_proof_buffer(&c7_data)?;

    require!(
        c7_authority == ctx.accounts.payer.key(),
        ZkShieldedError::InvalidProof
    );
    require!(c7_circuit_id == CIRCUIT_SPEND, ZkShieldedError::InvalidProof);
    require!(c7_verified, ZkShieldedError::InvalidProof);
    // Circuit 7 ships phase-2 DEEP-ALI from the client; require it. Without
    // this flag the buffer records only that the FRI layer checked out, which
    // is not a statement about the trace.
    require!(c7_deep_ali_verified, ZkShieldedError::InvalidProof);

    // Nullifier canonicalization: the PDA is seeded on the full 32 bytes, but
    // the proof binds only the low 8. Reject any non-canonical nullifier whose
    // high 24 bytes are non-zero, else one proof could be spent under several
    // distinct nullifier PDAs — a double-spend with no forgery in it.
    require!(nullifier[8..] == [0u8; 24], ZkShieldedError::InvalidProof);

    {
        let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
        let pub_buf = c7_pub_bytes(nullifier_u64, subtree_root, recipient_account.key);
        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(c7_inputs_hash == expected_hash, ZkShieldedError::InvalidProof);
    }
    drop(c7_data);

    // -----------------------------------------------------------------------
    // The other half of the membership statement — see the module header.
    //
    // Everything above proves a leaf sits under `subtree_root`. Nothing above
    // says `subtree_root` has anything to do with this pool.
    // -----------------------------------------------------------------------
    let derived = spend_root::resolve_pool_root(
        subtree_root,
        &siblings,
        &directions,
        pool.tree_depth,
    )
    .map_err(spend_root_error)?;

    // The named root must be the one the walk reaches. Only the low 8 bytes
    // carry the felt — the V3 root format packs the Goldilocks element into
    // bytes 0..8 — and the high 24 are compared too, so a caller cannot name
    // one published root while proving a path to another with the same limb.
    require!(
        merkle_root[..8] == derived.to_le_bytes(),
        ZkShieldedError::SpendRootMismatch
    );
    require!(
        pool.is_valid_root(&merkle_root),
        ZkShieldedError::InvalidMerkleRoot
    );

    // -----------------------------------------------------------------------
    // Transfer funds with protocol fee (0.5%) — identical to v3.
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
        **recipient_account.try_borrow_mut_lamports()? += recipient_amount;
        if unshield_fee > 0 {
            **ctx.accounts.fee_escrow.to_account_info().try_borrow_mut_lamports()? += unshield_fee;
        }
    } else {
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenProgram)?;
        let pool_vault = ctx
            .accounts
            .pool_vault
            .as_ref()
            .ok_or(ZkShieldedError::MissingPoolVault)?;
        let recipient_token_account = ctx
            .accounts
            .recipient_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;
        require!(pool_vault.mint == pool.token_mint, ZkShieldedError::InvalidTokenMint);
        require!(pool_vault.owner == pool.key(), ZkShieldedError::InvalidTokenOwner);
        require!(
            recipient_token_account.mint == pool.token_mint,
            ZkShieldedError::InvalidTokenMint
        );
        // 🚨 THE PROOF BINDS A WALLET; THE SPL LEG PAYS A TOKEN ACCOUNT. Without
        // this line those are two different things, and the whole "trustlessly
        // relayable" property of circuit 7 is false on this branch.
        //
        // The header of this file says a relayer "that re-points the payout
        // invalidates the proof it is relaying". MEASURED 2026-08-26: true on the
        // SOL leg, where `recipient_account.key() == recipient` is checked before
        // any lamport moves, and FALSE here — the mint was checked and the OWNER
        // was not, so whoever submits the transaction could pass any token
        // account of the right mint, including their own, and the money would
        // follow the account rather than the proof.
        //
        // Not reachable at the time it was found: both live pools carry
        // `token_mint = 11111111111111111111111111111111`, native SOL, read off
        // chain at offset 40. So this was a latent defect and not a live drain —
        // it becomes live the day an SPL pool opens, which is exactly when
        // nobody would be looking for it.
        //
        // ⛔ `unshield_denominated_stark_v3.rs` has the SAME gap, at its own
        // `recipient_token_account.mint` check. It is NOT fixed here: v3 binds no
        // recipient in its proof at all, so there is no bound identity to compare
        // against — closing it there means deciding what v3's payee even is, and
        // that is a different change.
        require!(
            recipient_token_account.owner == Pubkey::new_from_array(recipient),
            ZkShieldedError::InvalidTokenOwner
        );

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
            require!(
                pool_lamports.saturating_sub(min_rent) >= unshield_fee,
                ZkShieldedError::InsufficientPoolBalance
            );
            **pool.to_account_info().try_borrow_mut_lamports()? -= unshield_fee;
            **ctx.accounts.fee_escrow.to_account_info().try_borrow_mut_lamports()? += unshield_fee;
        }
    }

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

    // Phase B: no flavored event — the `NullifierRecord` PDA already is the
    // public "this nullifier was spent" marker, and re-emitting it as an event
    // leaked `recipient`.
    let _ = (amount, unshield_fee, current_epoch, dynamic_delay, nullifier);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The prover's frozen order, restated where the reconstruction lives so a
    /// change to either side has to pass through a failing test.
    #[test]
    fn the_public_input_layout_is_forty_eight_bytes_of_six_felts() {
        assert_eq!(C7_PUB_BYTES_LEN, 6 * 8);
    }

    /// 🚨 The guard on the shortcut in `c7_pub_bytes`.
    ///
    /// The four recipient felts are written raw, so their concatenation IS the
    /// sha256 digest. This test splits the digest the way the CLIENT does and
    /// re-joins it the way the PROVER does, and requires the round trip to be
    /// the identity — including for a limb that exceeds the Goldilocks modulus,
    /// which is the case that would break if anyone ever reduces them.
    #[test]
    fn the_four_recipient_felts_reassemble_the_digest() {
        let recipient = Pubkey::new_from_array([0x5A; 32]);
        let digest = solana_sha256_hasher::hashv(&[recipient.as_ref()]).to_bytes();

        // Client side: four LE u64s.
        let felts: [u64; 4] = core::array::from_fn(|i| {
            u64::from_le_bytes(digest[8 * i..8 * i + 8].try_into().unwrap())
        });
        // Prover side: `rh.to_le_bytes()` for each, concatenated.
        let mut rejoined = [0u8; 32];
        for (i, f) in felts.iter().enumerate() {
            rejoined[8 * i..8 * i + 8].copy_from_slice(&f.to_le_bytes());
        }
        assert_eq!(rejoined, digest, "the LE round trip is not the identity");

        let buf = c7_pub_bytes(1, 2, &recipient);
        assert_eq!(&buf[16..48], &digest, "c7_pub_bytes wrote a different digest");
    }

    /// Every field of `pub_bytes` moves the hash. A field that does not is a
    /// field the proof does not bind, and for `subtree_root` that would be the
    /// whole membership statement.
    #[test]
    fn every_published_field_moves_the_hash() {
        let r0 = Pubkey::new_from_array([1u8; 32]);
        let r1 = Pubkey::new_from_array([2u8; 32]);
        let base = c7_pub_bytes(7, 9, &r0);
        for (name, other) in [
            ("nullifier", c7_pub_bytes(8, 9, &r0)),
            ("subtree_root", c7_pub_bytes(7, 10, &r0)),
            ("recipient", c7_pub_bytes(7, 9, &r1)),
        ] {
            assert_ne!(base, other, "{name} did not change pub_bytes");
        }
    }

    /// 🚨 The recipient is bound BY THE PROOF here, which v3 could not do.
    ///
    /// In v3 a relayer holding a valid (C1, C3) pair could point the payout at
    /// any account, because nothing in either public-input hash mentioned the
    /// recipient; only `authority == payer` stood in the way. Substituting the
    /// recipient in v4 changes `public_inputs_hash`, so the buffer stops
    /// matching and the spend is refused.
    #[test]
    fn substituting_the_recipient_invalidates_the_reconstruction() {
        let honest = Pubkey::new_from_array([0xAA; 32]);
        let attacker = Pubkey::new_from_array([0xBB; 32]);
        let h = solana_sha256_hasher::hashv(&[&c7_pub_bytes(42, 99, &honest)]).to_bytes();
        let a = solana_sha256_hasher::hashv(&[&c7_pub_bytes(42, 99, &attacker)]).to_bytes();
        assert_ne!(h, a);
    }

    /// Each caller-side failure of the walk keeps its own error code. Collapsing
    /// them into `InvalidProof` would tell a caller with three siblings on a
    /// depth-15 pool that their PROOF is bad, and they would go rebuild it.
    #[test]
    fn the_walk_errors_stay_distinguishable() {
        let mapped = [
            (SpendRootError::PoolShallowerThanCircuit, ZkShieldedError::SpendPoolShallowerThanCircuit),
            (SpendRootError::WrongSiblingCount, ZkShieldedError::SpendWrongSiblingCount),
            (SpendRootError::NonBinaryDirection, ZkShieldedError::SpendNonBinaryDirection),
            (SpendRootError::NonCanonicalFelt, ZkShieldedError::SpendNonCanonicalFelt),
        ];
        let mut codes: Vec<u32> = Vec::new();
        for (from, expect) in mapped {
            let got = spend_root_error(from);
            assert_eq!(got as u32, expect as u32);
            codes.push(got as u32);
        }
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), 4, "two walk errors share a code");
    }

    /// The circuit id is not a free parameter. Reading a C1 or a C3 buffer here
    /// would accept a proof that publishes the commitment and proves a
    /// different statement.
    #[test]
    fn this_instruction_spends_on_circuit_seven_only() {
        assert_eq!(CIRCUIT_SPEND, 7);
    }
}

// ---------------------------------------------------------------------------
// [C7] The implication this instruction has to hold, checked on the SOURCE.
//
// "Routable only if it proves membership" is a property of the code, not of any
// one execution: no fixture can show that NO ordering of accounts reaches the
// payout early. `tests/unshield_c5_membership.rs` holds the same shape for the
// C5 instructions, and for the same reason.
//
// Everything below reads the file with comments stripped. A comment naming a
// check must never be what satisfies an assertion about the check — the module
// header above says `filled_subtrees` and `CANONICAL_DEPTH` in prose, and both
// are things the code must NOT contain.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod membership_guard {
    const SRC: &str = include_str!("unshield_denominated_stark_v4.rs");

    /// Instruction code only: everything above the first test module, comments
    /// removed.
    fn code() -> String {
        let end = SRC.find("#[cfg(test)]").expect("test marker");
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
            SRC.contains("NOT `filled_subtrees`"),
            "fixture reworded — pick another comment",
        );
        assert!(
            !code().contains("NOT `filled_subtrees`"),
            "code() is leaking comments; every guard below becomes a prose match",
        );
        assert!(code().contains("pub fn handler("));
    }

    /// 🚨 THE FUND-LOSS GUARD. C7 proves membership in a depth-12 subtree and
    /// says nothing about which subtree. If a lamport can move before
    /// `resolve_pool_root` has run, an attacker's self-built twelve levels pay
    /// out — the `unshield` C5 defect, rebuilt.
    #[test]
    fn no_lamport_moves_before_the_pool_root_is_resolved() {
        let code = code();
        let walk = code.find("resolve_pool_root").expect("the walk is gone");
        for payout in ["try_borrow_mut_lamports", "token::transfer("] {
            let at = code.find(payout).unwrap_or_else(|| panic!("{payout} not found"));
            assert!(at > walk, "{payout} can run before resolve_pool_root");
        }
    }

    /// The walk alone is not a membership check either: it turns a subtree root
    /// into SOME root. Only `is_valid_root` says the pool ever published it.
    #[test]
    fn no_lamport_moves_before_the_root_is_matched_against_the_pool() {
        let code = code();
        let ring = code.find("is_valid_root").expect("is_valid_root is gone");
        let mismatch = code.find("SpendRootMismatch").expect("named-root check is gone");
        for payout in ["try_borrow_mut_lamports", "token::transfer("] {
            let at = code.find(payout).unwrap();
            assert!(at > ring, "{payout} can run before is_valid_root");
            assert!(at > mismatch, "{payout} can run before the derived/named root check");
        }
    }

    /// 🚨 THE SPL LEG MUST PAY THE ACCOUNT THE PROOF BINDS, NOT MERELY THE RIGHT
    /// MINT. The SOL leg compares `recipient_account.key()` against the bound
    /// `recipient`; the SPL leg pays a token ACCOUNT, so it has to compare that
    /// account's OWNER against the same value or the binding buys nothing here.
    ///
    /// Matched as the REQUIRE it has to be, for the reason the guard below this
    /// one records: `recipient_token_account.owner` also appears in ordinary
    /// reads, so searching for the name alone would stay green with the check
    /// deleted — which is precisely how the deep-ALI guard was hollow.
    #[test]
    fn the_spl_payout_goes_to_the_account_the_proof_binds() {
        let code = code();
        let needle = "require!(
            recipient_token_account.owner == Pubkey::new_from_array(recipient),";
        assert!(
            code.contains(needle),
            "the SPL destination is no longer bound to the recipient the proof names;              a relayer can re-point an SPL payout to any token account of the right mint",
        );
        let bind = code.find("recipient_token_account.owner").expect("owner binding is gone");
        let at = code.find("token::transfer(").expect("token::transfer is gone");
        assert!(at > bind, "token::transfer can run before the destination owner is bound");
    }

    /// The proof itself must be checked before the money moves, phase 2
    /// included. `deep_ali_verified` is what separates "FRI checked out" from
    /// "the trace satisfies the AIR".
    ///
    /// 🚨 THE FIRST VERSION OF THIS GUARD WAS HOLLOW, AND IT WAS MEASURED.
    /// It searched for `c7_deep_ali_verified`, which also appears in the tuple
    /// the buffer is destructured into — so deleting the `require!` outright
    /// left this test GREEN. Every name below is therefore matched as the
    /// REQUIRE it has to be, never as a mention.
    #[test]
    fn the_proof_is_fully_checked_before_the_money_moves() {
        let code = code();
        let payouts: Vec<usize> = ["try_borrow_mut_lamports", "token::transfer("]
            .iter()
            .map(|p| code.find(p).unwrap_or_else(|| panic!("{p} not found")))
            .collect();

        // Each of these is the whole statement, not a substring that a binding
        // or a comment could satisfy.
        let requires = [
            ("phase 2", "require!(c7_deep_ali_verified,"),
            ("phase 1", "require!(c7_verified,"),
            ("circuit id", "require!(c7_circuit_id == CIRCUIT_SPEND,"),
            ("buffer authority", "c7_authority == ctx.accounts.payer.key()"),
            ("public-inputs hash", "require!(c7_inputs_hash == expected_hash,"),
            ("nullifier canonicalisation", "require!(nullifier[8..] == [0u8; 24],"),
        ];
        for (what, needle) in requires {
            let at = code
                .find(needle)
                .unwrap_or_else(|| panic!("the {what} check is gone: `{needle}` not in the code"));
            for (p, payout) in payouts.iter().zip(["try_borrow_mut_lamports", "token::transfer("]) {
                assert!(*p > at, "{payout} can run before the {what} check");
            }
        }
    }

    /// ⛔ `filled_subtrees` is an INSERTION FRONTIER — the left siblings of the
    /// NEXT leaf. It cannot supply the siblings of an arbitrary existing leaf
    /// and no proof binds it. Using it here would look like a saving and would
    /// be a second hole, so it must not appear at all.
    #[test]
    fn the_walk_never_reaches_for_the_insertion_frontier() {
        assert!(
            !code().contains("filled_subtrees"),
            "the siblings must come from the caller, not from the insertion frontier",
        );
    }

    /// 🚨 `CANONICAL_DEPTH` means 12 in `air/spend.rs` and 15 in four other
    /// places in this tree. Reaching for the familiar name is how the C7 CU
    /// probe ended up hashing at row 478 instead of 382 — inside the blinding
    /// region, where nothing is constrained. This file must spell the depth out
    /// through `spend_root::SPEND_SUBTREE_DEPTH` or not at all.
    #[test]
    fn the_ambiguous_depth_name_is_never_used_here() {
        assert!(
            !code().contains("CANONICAL_DEPTH"),
            "CANONICAL_DEPTH is 12 in one crate and 15 in another; name the depth another way",
        );
    }

    /// The privacy property the circuit exists for, asserted against the code
    /// that consumes it. v3 has to publish the note commitment to tie C1 to C3,
    /// which names the deposit that funded the spend. If `stark_commitment`
    /// reappears here, the single proof has bought nothing.
    #[test]
    fn the_note_commitment_is_never_an_argument_of_this_instruction() {
        let code = code();
        assert!(
            !code.contains("stark_commitment"),
            "v4 must not take the commitment — publishing it is the linkage C7 removes",
        );
    }

    /// A C1 or a C3 buffer proves a different statement and publishes the
    /// commitment. Exactly one circuit id may be accepted here.
    #[test]
    fn exactly_one_circuit_id_is_accepted() {
        let code = code();
        assert!(code.contains("c7_circuit_id == CIRCUIT_SPEND"));
        for other in ["circuit_id == 1", "circuit_id == 3", "circuit_id == 5"] {
            assert!(!code.contains(other), "{other} is reachable from this handler");
        }
    }

    /// One buffer, not two. A second `parse_stark_proof_buffer` call site would
    /// mean v4 had quietly grown back into the v3 pairing.
    #[test]
    fn exactly_one_proof_buffer_is_read() {
        let code = code();
        let calls = code.matches("parse_stark_proof_buffer(").count();
        // One definition, one call site.
        assert_eq!(calls, 2, "expected the definition and a single call site");
    }
}
