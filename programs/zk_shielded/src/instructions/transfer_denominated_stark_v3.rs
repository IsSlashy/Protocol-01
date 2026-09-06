use anchor_lang::prelude::*;

use crate::errors::ZkShieldedError;
use crate::state::spend_root;
use crate::state::insert_root;
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
/// Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written
///       + 1 verified + 32 public_inputs_hash + 1 deep_ali_verified = 83
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_DEEP_ALI: usize = 82;
const PROOF_BUF_MIN_LEN: usize = 83;

/// Parse a verified STARK proof buffer.
/// Returns (authority, circuit_id, verified, deep_ali_verified, public_inputs_hash).
fn parse_stark_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, bool, [u8; 32])> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, ZkShieldedError::InvalidProof);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        ZkShieldedError::InvalidProof
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID])
        .map_err(|_| ZkShieldedError::InvalidProof)?;
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let deep_ali_verified = data[PROOF_BUF_DEEP_ALI] == 1;
    let mut public_inputs_hash = [0u8; 32];
    public_inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_INPUTS_HASH + 32]);
    Ok((authority, circuit_id, verified, deep_ali_verified, public_inputs_hash))
}

/// V3 transfer of a note within a denominated pool.
///
/// Mirrors v2's `transfer_denominated_stark` with three STARK proof buffers
/// instead of one — the same pattern the V3 design uses to close the v2 trust
/// gap (membership was never proven on-chain).
///
///   * `c1_proof_buffer` — pool_commitment. Proves the caller knows the
///     `(secret, nullifier_preimage)` for the OLD note's `(nullifier,
///     commitment)`. Same as v2.
///   * `c3_proof_buffer` — merkle_path. Proves the OLD commitment is at
///     `merkle_root` (which must be in `pool.historical_roots`). NEW in V3 —
///     v2 only checked `is_valid_root` on the supplied root, never that the
///     commitment was actually at it.
///   * `c6_proof_buffer` — merkle_update. Proves `(current_root, new_root,
///     new_commitment, new_subtrees)` is a valid insertion. Same as `shield_v3`.
///
/// On-chain checks tie all three proofs together:
///   - `c1.public_inputs.commitment == c3.public_inputs.leaf` (same `stark_commitment`).
///   - `c3.public_inputs.root` is in `pool.historical_roots` (via `is_valid_root`).
///   - `c6.public_inputs.{old_root, new_leaf, new_root}` matches the on-chain
///     `(merkle_tree.root, new_commitment, new_root)`.
///
/// Funds do not move (same pool, same denomination). Only the merkle tree
/// state and pool bookkeeping change. Universal `LeafInserted` is emitted by
/// `insert_with_root_v3`.
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
    new_commitment: [u8; 32],
    c6_old_subtree_root: u64,
    c6_new_subtree_root: u64,
    new_subtrees: Vec<[u8; 32]>,
    subtree_root: u64,
    siblings: Vec<u64>,
    directions: Vec<u8>
)]
pub struct TransferDenominatedStarkV3<'info> {
    /// Transaction submitter — must be the note owner (signs to bind new_commitment).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Denominated pool V3
    #[account(
        mut,
        // [ERAS 2026-09-06] The PDA is no longer pinned here. Era 0 has three
        // seeds and era n >= 1 has four, and one `seeds = [...]` cannot say
        // both, so the handler re-derives the address from the pool's own
        // fields and the tree's `era` (`require_pool_pda`) before touching
        // any state. Owner and discriminator are still checked by `Account`.
        constraint = denominated_pool.is_active @ ZkShieldedError::PoolNotActive,
        // ⛔ NO `is_valid_root` CONSTRAINT HERE ANY MORE, AND ITS ABSENCE IS
        // DELIBERATE. Since the C3 depth cut, `merkle_root` is the OUTPUT of the
        // handler's Poseidon walk, not a value the caller names and the pool
        // confirms. Checking it here would run BEFORE the walk, confirming a
        // root the proof does not actually reach. The ring membership is still
        // enforced, once, in the handler, right after the walk.
    )]
    pub denominated_pool: Account<'info, DenominatedPoolV3>,

    /// Merkle tree V3 state (mutable — new commitment is inserted)
    #[account(
        mut,
        seeds = [
            MerkleTreeStateV3::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Account<'info, MerkleTreeStateV3>,

    /// Nullifier record PDA — created (init) on first use.
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

    /// C1 (pool_commitment) STARK proof buffer.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=1,
    /// verified, public_inputs_hash matches `(nullifier, stark_commitment)`).
    pub c1_proof_buffer: AccountInfo<'info>,

    /// C3 (merkle_path) STARK proof buffer — proves OLD commitment is at
    /// `merkle_root`. NEW in V3.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=3,
    /// verified, public_inputs_hash matches `(stark_commitment, merkle_root)`).
    pub c3_proof_buffer: AccountInfo<'info>,

    /// C6 (merkle_update) STARK proof buffer — proves NEW commitment insertion.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=6,
    /// verified, deep_ali_verified, public_inputs_hash matches
    /// `(0, new_commitment, current_root, new_root, depth)`).
    pub c6_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<TransferDenominatedStarkV3>,
    nullifier: [u8; 32],
    _merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
    new_commitment: [u8; 32],
    // [C6-D12] The two SUBTREE roots, replacing the caller-supplied `new_root`.
    // The program now COMPUTES the pool root by folding the top levels against
    // the pool account's own `filled_subtrees`; a caller-supplied pool root is
    // exactly what that fold exists to refuse.
    c6_old_subtree_root: u64,
    c6_new_subtree_root: u64,
    new_subtrees: Vec<[u8; 32]>,
    // [C3-D12] Not optional. The C3 proof attests membership in a depth-12
    // SUBTREE, so the handler must walk the remaining levels to reach a pool
    // root. None of the three is trusted: the walk's result must equal the
    // named `merkle_root`, and that root must already be in the pool's ring.
    subtree_root: u64,
    siblings: Vec<u64>,
    directions: Vec<u8>,
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
    let payer_key = ctx.accounts.payer.key();

    // Dynamic delay: update maturity tracking
    let current_epoch = DenominatedPoolV3::current_epoch(clock.slot);
    pool.update_maturity(current_epoch);

    // Enforce epoch delay for transfers (always)
    let dynamic_delay = pool.get_dynamic_delay();
    let effective_min_epoch = min_epoch
        .checked_add(dynamic_delay)
        .ok_or(ZkShieldedError::ArithmeticOverflow)?;
    require!(
        current_epoch >= effective_min_epoch,
        ZkShieldedError::EpochDelayNotMet
    );

    // Initialize the nullifier record (marks the OLD note as spent)
    let nullifier_record = &mut ctx.accounts.nullifier_record;
    nullifier_record.pool = pool.key();
    nullifier_record.bump = ctx.bumps.nullifier_record;

    // Nullifier canonicalization: the PDA is seeded on the full 32-byte
    // `nullifier`, but the proof only binds the low 8 bytes. Reject any
    // non-canonical nullifier whose high 24 bytes are non-zero, else a single
    // proof could be spent under multiple distinct nullifier PDAs (double-spend).
    require!(nullifier[8..] == [0u8; 24], ZkShieldedError::InvalidProof);
    // 🚨 AND the low 8 bytes must be a CANONICAL Goldilocks element. The line
    // above bounds the ENCODING; this one bounds the VALUE.
    //
    // MEASURED 2026-08-26: the deployed verifier pins `Felt::new(pub[0])` with
    // `Felt::new(v) = Felt(v % p)`, but hashes the u64 RAW and range-checks no
    // public input. 2^64 - p = 2^32 - 1, so every nullifier below 2^32 - 1 has a
    // second in-range encoding `n + p`: one field element, TWO record PDAs, two
    // honest proofs off one witness, and the note pays out TWICE. The full
    // measurement is written out at the same require in
    // `unshield_denominated_stark_v4.rs`. No honest client is affected -- a
    // Poseidon-GL output is reduced by construction.
    require!(
        u64::from_le_bytes(nullifier[..8].try_into().unwrap()) < crate::state::poseidon_gl::MODULUS,
        ZkShieldedError::SpendNonCanonicalFelt
    );

    // -----------------------------------------------------------------------
    // C1 (pool_commitment) verification — proves ownership of OLD note.
    // public_inputs = [nullifier_u64, commitment_u64], hashed as
    // sha256(nullifier_le || commitment_le) = 16 bytes (matches verifier).
    // -----------------------------------------------------------------------
    {
        let c1_info = &ctx.accounts.c1_proof_buffer;
        require!(
            *c1_info.owner == STARK_VERIFIER_PROGRAM_ID,
            ZkShieldedError::InvalidProof
        );
        let c1_data = c1_info.try_borrow_data()?;
        let (c1_authority, c1_circuit_id, c1_verified, c1_deep, c1_inputs_hash) =
            parse_stark_proof_buffer(&c1_data)?;

        require!(c1_authority == payer_key, ZkShieldedError::InvalidProof);
        require!(c1_circuit_id == 1, ZkShieldedError::InvalidProof);
        require!(c1_verified, ZkShieldedError::InvalidProof);
        // Circuit 1 ships phase-2 DEEP-ALI from the client; require it.
        require!(c1_deep, ZkShieldedError::InvalidProof);

        let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
        let mut pub_buf = [0u8; 16];
        pub_buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
        pub_buf[8..].copy_from_slice(&stark_commitment.to_le_bytes());
        let expected = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(c1_inputs_hash == expected, ZkShieldedError::InvalidProof);
    }

    // -----------------------------------------------------------------------
    // C3 (merkle_path) verification — proves OLD commitment is at merkle_root.
    // public_inputs = [leaf_u64, root_u64, depth], hashed as 24 bytes.
    // [C3 depth binding] depth is the 3rd public input, folded into the prover
    // transcript; bound here so an attacker cannot supply a mismatched depth
    // (C3 periodic columns are baked for depth=15 → any other depth desyncs
    // the constraint system). MUST match the prover's `pub_bytes` byte-for-byte.
    // The `is_valid_root(&merkle_root)` constraint above already ties
    // merkle_root to the pool ring; this check ties it to the C3 proof.
    // -----------------------------------------------------------------------
    {
        let c3_info = &ctx.accounts.c3_proof_buffer;
        require!(
            *c3_info.owner == STARK_VERIFIER_PROGRAM_ID,
            ZkShieldedError::InvalidProof
        );
        let c3_data = c3_info.try_borrow_data()?;
        let (c3_authority, c3_circuit_id, c3_verified, c3_deep, c3_inputs_hash) =
            parse_stark_proof_buffer(&c3_data)?;

        require!(c3_authority == payer_key, ZkShieldedError::InvalidProof);
        require!(c3_circuit_id == 3, ZkShieldedError::InvalidProof);
        require!(c3_verified, ZkShieldedError::InvalidProof);
        // Circuit 3 ships phase-2 DEEP-ALI from the client; require it.
        require!(c3_deep, ZkShieldedError::InvalidProof);

        // 🚨 THE TWO VALUES IN THIS HASH BOTH CHANGED ON 2026-08-29.
        //
        // C3 was cut from depth 15 to depth 12 so rows 384..511 could become a
        // blinding region. Two consequences land right here:
        //
        //   depth  is the CONSTANT 12, not the pool's tree depth. The pool tree is
        //          still 15 deep; the CIRCUIT covers 12 of its levels. Feeding the
        //          pool depth builds a hash no honest proof can match.
        //   root   is `subtree_root`, the root of the depth-12 subtree the leaf sits
        //          in — C3's public input 1 is what `compute_merkle_root` returns
        //          over the twelve path elements it was given.
        //
        // ⛔ NEITHER IS TRUSTED by this block. The walk below is what ties
        // `subtree_root` to this pool, and it must not be separated from it.
        let circuit_depth = spend_root::SPEND_SUBTREE_DEPTH as u64;
        {
            let mut pub_buf = [0u8; 24]; // 3 x u64 LE: leaf, subtree_root, depth
            pub_buf[..8].copy_from_slice(&stark_commitment.to_le_bytes());
            pub_buf[8..16].copy_from_slice(&subtree_root.to_le_bytes());
            pub_buf[16..24].copy_from_slice(&circuit_depth.to_le_bytes());
            let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
            require!(c3_inputs_hash == expected_hash, ZkShieldedError::InvalidProof);
        }
    }

    // -----------------------------------------------------------------------
    // [C3-D12] Walk the top levels, then tie the result to the pool's ring.
    //
    // The proof above says "this leaf is in a 12-level tree rooted at
    // `subtree_root`". It says nothing about whose tree that is — anyone can
    // build a 12-level tree containing any leaf they like. These three steps are
    // what turn it into a statement about THIS pool:
    //
    //   1. the walk derives a pool root from the subtree root and the siblings;
    //   2. that derived root must equal the `merkle_root` the caller named;
    //   3. that named root must be one the pool actually published.
    //
    // ✅ CALLER-SUPPLIED SIBLINGS ARE SAFE HERE. C3 READS: a forged sibling
    // produces a root that is in no history, so step 3 refuses it. ⛔ C6 WRITES,
    // where the root is new by definition and there is no history to check
    // against — which is why the deposit path uses
    // `insert_root::fold_insertion` against the pool's own `filled_subtrees`.
    // The two are not interchangeable.
    // -----------------------------------------------------------------------
    // `merkle_tree` is already mutably borrowed above for the C6 insertion, so
    // the depth is read through that binding rather than a second borrow.
    require!(
        pool.tree_depth == merkle_tree.depth,
        ZkShieldedError::InvalidMerkleRoot
    );
    let derived_root = spend_root::resolve_pool_root(
        subtree_root,
        &siblings,
        &directions,
        pool.tree_depth,
    )
    .map_err(crate::instructions::unshield_denominated_stark_v4::spend_root_error)?;
    require!(
        _merkle_root[..8] == derived_root.to_le_bytes(),
        ZkShieldedError::SpendRootMismatch
    );
    require!(
        pool.is_valid_root(&_merkle_root),
        ZkShieldedError::InvalidMerkleRoot
    );

    // -----------------------------------------------------------------------
    // C6 (merkle_update) verification — proves new_commitment + new_root +
    // new_subtrees is a valid insertion from the CURRENT pool root.
    // public_inputs = [old_leaf=0, new_leaf, old_root, new_root, depth] — 5 u64s,
    // hashed as 40 bytes (matches `shield_denominated_v3::verify_c6_proof_buffer`).
    // Both phase 1 (FRI) AND phase 2 (DEEP-ALI) must be verified for C6.
    // -----------------------------------------------------------------------
    {
        let c6_info = &ctx.accounts.c6_proof_buffer;
        require!(
            *c6_info.owner == STARK_VERIFIER_PROGRAM_ID,
            ZkShieldedError::InvalidProof
        );
        let c6_data = c6_info.try_borrow_data()?;
        let (c6_authority, c6_circuit_id, c6_verified, c6_deep_ali, c6_inputs_hash) =
            parse_stark_proof_buffer(&c6_data)?;

        require!(c6_authority == payer_key, ZkShieldedError::InvalidProof);
        require!(c6_circuit_id == 6, ZkShieldedError::InvalidProof);
        require!(c6_verified, ZkShieldedError::InvalidProof);
        require!(c6_deep_ali, ZkShieldedError::InvalidProof);

        // 🚨 SUBTREE ROOTS AND THE CONSTANT 12, NOT `merkle_tree.root` AND
        // `merkle_tree.depth`. C6 was cut to depth 12 on 2026-08-29, so what it
        // attests is a SUBTREE transition. Feeding the pool root or the pool
        // depth here builds a hash no honest proof can match.
        //
        // ⛔ AND NEITHER ROOT IS TRUSTED BY THIS BLOCK. The fold below is what
        // ties them to this pool. This is the same shape as
        // `shield_denominated_v3`, and for the same reason.
        let old_leaf_u64: u64 = 0; // insertion ⇒ replacing ZEROS[0]
        let new_leaf_u64 = u64::from_le_bytes(new_commitment[..8].try_into().unwrap());
        let depth_u64 = insert_root::INSERT_SUBTREE_DEPTH as u64;

        let mut pub_buf = [0u8; 40];
        pub_buf[0..8].copy_from_slice(&old_leaf_u64.to_le_bytes());
        pub_buf[8..16].copy_from_slice(&new_leaf_u64.to_le_bytes());
        pub_buf[16..24].copy_from_slice(&c6_old_subtree_root.to_le_bytes());
        pub_buf[24..32].copy_from_slice(&c6_new_subtree_root.to_le_bytes());
        pub_buf[32..40].copy_from_slice(&depth_u64.to_le_bytes());
        let expected = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(c6_inputs_hash == expected, ZkShieldedError::InvalidProof);
    }

    // -----------------------------------------------------------------------
    // [C6-D12] Fold the top levels, and let the OLD fold prove the subtree
    // belongs to this pool.
    //
    // ⛔ THIS IS THE WRITE SIDE, so `insert_root::fold_insertion` and NOT
    // `spend_root::resolve_pool_root` -- the siblings come from the pool
    // account's own `filled_subtrees`, never from `new_subtrees`, which the
    // caller supplies and the C6 hash does not cover. The C3 walk twenty lines
    // above is the read side and correctly takes caller-supplied siblings,
    // because its result is checked against a root the pool already published.
    // A new root has no such history, which is the whole distinction.
    // -----------------------------------------------------------------------
    let insert_at = merkle_tree.leaf_count;
    let filled: Vec<u64> = merkle_tree
        .filled_subtrees
        .iter()
        .map(|b| {
            require!(b[8..].iter().all(|x| *x == 0), ZkShieldedError::InvalidMerkleRoot);
            let v = u64::from_le_bytes(b[..8].try_into().unwrap());
            require!(v < crate::state::poseidon_gl::MODULUS, ZkShieldedError::InvalidMerkleRoot);
            Ok(v)
        })
        .collect::<Result<Vec<u64>>>()?;

    let folded = insert_root::fold_insertion(
        c6_old_subtree_root,
        c6_new_subtree_root,
        insert_at,
        &filled,
        merkle_tree.depth,
    )
    .map_err(|_| error!(ZkShieldedError::InvalidMerkleRoot))?;

    // 🚨 THIS EQUALITY IS THE WHOLE BINDING. Drop it and every other check in
    // this handler still passes while a caller writes an arbitrary pool root.
    let current_root_felt = {
        let b = merkle_tree.root;
        require!(b[8..].iter().all(|x| *x == 0), ZkShieldedError::InvalidMerkleRoot);
        let v = u64::from_le_bytes(b[..8].try_into().unwrap());
        require!(v < crate::state::poseidon_gl::MODULUS, ZkShieldedError::InvalidMerkleRoot);
        v
    };
    require!(
        folded.old_pool_root == current_root_felt,
        ZkShieldedError::InvalidMerkleRoot
    );

    let new_root = {
        let mut out = [0u8; 32];
        out[..8].copy_from_slice(&folded.new_pool_root.to_le_bytes());
        out
    };

    // -----------------------------------------------------------------------
    // Insert new commitment into the V3 Merkle tree (emits LeafInserted)
    // -----------------------------------------------------------------------
    let leaf_index = merkle_tree.insert_with_root_v3(
        new_commitment,
        new_root,
        &new_subtrees,
        true, // c6_verified — see C6 block above
    )?;

    // The top-level subtree entries are DERIVED from the fold that just
    // reproduced the pool root, so they overwrite whatever `new_subtrees` said
    // there. Levels below 12 remain the client's hint, unchanged and unbound.
    for (level, value) in folded.updated_subtrees() {
        let l = *level as usize;
        if l < merkle_tree.filled_subtrees.len() {
            let mut out = [0u8; 32];
            out[..8].copy_from_slice(&value.to_le_bytes());
            merkle_tree.filled_subtrees[l] = out;
        }
    }

    // Update pool root and leaf index (pushes old root onto historical ring)
    pool.update_root(new_root);
    pool.next_leaf_index = merkle_tree.leaf_count;
    pool.last_tx_at = clock.unix_timestamp;

    // Note count stays the same: one consumed, one created.
    // total_shielded stays the same: no funds move.
    // Decrement mature (old note was mature) and record new deposit.
    pool.mature_note_count = pool.mature_note_count.saturating_sub(1);
    pool.record_deposit(current_epoch);

    // Phase B: no flavored event. The universal `LeafInserted` (from
    // `insert_with_root_v3`) covers the new leaf; the on-chain
    // `NullifierRecord` PDA covers the spent nullifier. Re-emitting them as
    // an additional `TransferDenominatedStarkV3Event` only added latency-
    // window analytics that any sophisticated attacker can derive from
    // `getTransaction` anyway. Dropped to remove an unnecessary parser
    // surface — Phase B is event-level scrub only; tx-account-level leaks
    // remain (Phase A.5 / B.2).
    let _ = (min_epoch, current_epoch, dynamic_delay, nullifier, leaf_index, new_commitment, new_root);

    Ok(())
}
