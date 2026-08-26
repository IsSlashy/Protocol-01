//! [C7] Open a private subscription vault on ONE proof instead of two.
//!
//! Read this file side by side with `unshield_denominated_stark_v4.rs`. The
//! first five arguments are byte-identical in order and type, and
//! `subscriber_commitment` occupies the slot `recipient` occupies there. That
//! parallel is deliberate.
//!
//! # What changes against v3
//!
//! v3 (`subscribe_private_stark.rs`) spends on a PAIR: C1 (`pool_commitment`)
//! proves the nullifier derives from a well-formed note, C3 (`merkle_path`)
//! proves that note is a leaf under a published root. The only thing tying the
//! two together is the `stark_commitment` argument, which both public-input
//! hashes are rebuilt from — so v3 has to PUBLISH the note commitment, and a
//! subscription names the very deposit that funded it.
//!
//! Circuit 7 proves both halves in one trace and publishes
//! `[nullifier, root, rh0, rh1, rh2, rh3]` — no commitment anywhere.
//!
//! Consequences for this file:
//!
//!   * ONE proof buffer instead of two. `stark_commitment` is gone as an
//!     argument, because on-chain code is not supposed to know it. Pinned by
//!     `the_note_commitment_is_never_an_argument_of_this_instruction`.
//!   * `min_epoch` is gone too — removed, not ignored. Every shipped surface
//!     already sends `SUBSCRIBE_MIN_EPOCH = 0n`, because since commitment
//!     blinding shipped the `deposit_epoch` slot carries a 63-bit PRF secret:
//!     passing the real value would publish the blinding in the clear, AND a
//!     blinded note could never satisfy `current_epoch >= blinding + delay`, so
//!     it would be permanently un-subscribable with `EpochDelayNotMet`
//!     (MEASURED 2026-08-12). An IGNORED parameter is still bytes on the wire,
//!     which is the same reasoning that deleted `client_stealth_meta`.
//!   * The destination and the SCHEDULE are bound BY THE PROOF. See below.
//!   * The root the circuit proves is a depth-12 SUBTREE root, and this
//!     instruction has to finish the job.
//!
//! # ⛔ The half of C7 that lives here, not in the circuit
//!
//! The depth circuit 7 proves is 12 (`spend_root::SPEND_SUBTREE_DEPTH`). The
//! pool tree is 15. A verified C7 proof therefore asserts:
//!
//! ```text
//! "I know a leaf and a twelve-level path from it to the root I published."
//! ```
//!
//! and NOT "that leaf is in this pool". Anyone who builds their own twelve
//! levels over an invented leaf gets a proof the deployed verifier accepts.
//! Routing pool value on that alone is `unshield` C5 before 2026-08-18 — a
//! fund-loss defect, not a gap. v3 subscribe has NO walk at all; it did not
//! need one, because C3 proved the path to the full-depth root.
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
//! handler runs. Here the root is **derived** — it does not exist until the
//! Poseidon walk has run — so the check is necessarily in the handler, after
//! `resolve_pool_root`. Moving it back to the accounts struct would check a
//! root nobody proved anything about.
//!
//! # 🚨 THE BINDING IS A DOMAIN-TAGGED COMPOSITE, NOT THE VAULT PDA ALONE
//!
//! Do not simplify this back to `sha256(vault_pubkey)`, the shape v4 unshield
//! uses. In an unshield the destination IS the whole economic statement, so
//! binding one pubkey binds everything. In a subscribe the destination is only
//! HALF: `rate` and `interval_slots` decide how fast the retailer empties the
//! vault, and NOTHING in v3, and nothing in any v4 pattern, binds them.
//!
//! Read out of the vault arithmetic: `funded_periods() = total_deposited / rate`
//! (`state/subscription_vault.rs`), and on the final settle `claim_period` pays
//! `unpaid_amount()` — the entire residual — then closes the account and sweeps
//! the rent to the retailer. `claim_period` is PERMISSIONLESS: its `retailer` is
//! an `UncheckedAccount`, not a signer. So a relayer who holds the C7 buffer and
//! sets `rate = denomination, interval_slots = 1` hands the retailer the
//! subscriber's entire prepaid envelope one slot after subscribe, with no
//! recovery: cancellation and refunds were deliberately removed. The proof would
//! still verify, because the proof said nothing about the terms.
//!
//! Hence the preimage is
//! `DOMAIN || vault || rate || interval_slots || vk_hash_subscriber || license`.
//!
//! The DOMAIN tag is the second half of that. Without it the only separation
//! between a buffer minted for an unshield and one spent here is that
//! `sha256(pubkey)` is unlikely to collide with `sha256(composite)` —
//! separation by accident of address derivation, not by construction.
//!
//! Why the VAULT and not the retailer: Anchor's `init` + `seeds` forces
//! `vault.key() == find_program_address([SEED_PREFIX, retailer,
//! subscriber_commitment, token_mint])`, so binding the address transitively
//! binds all three seeds. Binding `retailer` alone would leave
//! `subscriber_commitment` free, which hands the buffer holder pause/resume
//! control over the merchant's income stream while the honest subscriber's note
//! burns. Binding `subscriber_commitment` alone binds neither retailer nor mint.
//! Both are strictly weaker.
//!
//! Why it does not leak: every input is already published by the same
//! transaction. The vault is a named account and appears in `accountKeys`, and
//! is re-published by every later `claim_period` and every `pause`; `rate`,
//! `interval_slots`, `vk_hash_subscriber` and `license_commitment` are cleartext
//! instruction arguments. An observer holding the transaction can recompute the
//! digest, so `H(binding | transaction) = 0`. This is the same argument the repo
//! already made and accepted for the public bump. What is REMOVED —
//! `stark_commitment` and `min_epoch` — are values not otherwise on the wire,
//! and both name the deposit.
//!
//! # ⛔ NO PROTOCOL FEE. `amount` moves in full.
//!
//! Do not copy v4 unshield's `fee::calculate_fee` block or its `fee_escrow`
//! account. `vault.total_deposited` is what `funded_periods()` divides and what
//! `unpaid_amount()` subtracts from. Charge the fee and write
//! `total_deposited = amount` and the two disagree by 50 bps: on a 1 SOL
//! denomination that is 5,000,000 lamports against a 361-byte vault rent of
//! roughly 3,300,000 (ASSUMED — read
//! `getMinimumBalanceForRentExemption(361)` off the cluster before quoting it),
//! so on the final claim `require!(vault_lamports >= value_payout)` FAILS, the
//! claim reverts, and since `claim_period` is the only closer the deposit and
//! the rent are stranded forever. If the operator wants the fee later it is a
//! MONEY DECISION, and it arrives with `vault.total_deposited = recipient_amount`
//! and not with `amount`.
//!
//! Stated plainly: this leaves subscribe as the only fee-free exit from a pool.
//!
//! # ⛔ One caveat that must never be softened
//!
//! The circuit does NOT verify that the vault's `subscriber_commitment` is
//! `Poseidon(the secret in the C7 witness)`. The recipient felts are
//! transcript-only — they occupy no trace column and no constraint — so nothing
//! ties them to the trace. A client can bind a vault seeded on an unrelated
//! commitment. That is not a drain: the money still lands in a vault only the
//! named retailer can claim, and `pause`/`resume` then simply fail for everyone.
//! But "one secret, one note, one vault" remains a CLIENT CONVENTION, exactly as
//! `state/subscription_vault.rs` already warns. Do not write a comment claiming
//! the proof enforces it.
//!
//! # ⚠️ WHAT THIS DOES NOT FIX — the epoch-blinded note
//!
//! This instruction publishes the nullifier, and the nullifier is half the
//! commitment preimage: the AIR asserts
//! `poseidon(nullifier, poseidon(blinding, token_mint)) == commitment`, and
//! `token_mint` is the pool's and public. So for a note whose `blinding` slot
//! holds a real `slot/7200` epoch rather than the 63-bit PRF, the leaf is
//! recomputable in roughly 12,000 Poseidon evaluations over the repo's own
//! 6,000-epoch window, and the deposit falls out exactly.
//!
//! This instruction CANNOT check it. `blinding` is a private witness, and
//! constraining it — a boundary assertion, a range check, a bit decomposition,
//! or promotion to a public input — bricks every note already deposited under
//! the other convention, with no recovery path. The gate is CLIENT-SIDE and must
//! be an EQUALITY, `receipt.noteBlinding === deriveNoteBlinding(walletSeed,
//! poolPDA, receipt.leafIndex)`, never a magnitude test: a magnitude test passes
//! any note whose epoch happened to be large, and passes a hand-crafted receipt.
//! The defect is already live in `unshield_denominated_stark_v4`; this file
//! inherits it. `the_blinding_caveat_is_still_written_down` keeps this paragraph
//! from being deleted as a stale comment.
//!
//! Nothing here is deployed. Every number marked ASSUMED must be measured before
//! the redeploy.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Transfer as TokenTransfer};

use crate::errors::ZkShieldedError;
// ⛔ IMPORTED, not copied. `spend_root_error` is the single mapping from the
// four caller-fault walk errors onto four distinct on-chain codes. A second
// copy would let the two C7 consumers drift silently, and a caller with three
// siblings on a depth-15 pool would be told their PROOF is bad.
use crate::instructions::unshield_denominated_stark_v4::spend_root_error;
use crate::state::spend_root;
use crate::state::{DenominatedPoolV3, MerkleTreeStateV3, NullifierRecord, SubscriptionVault};

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

/// The domain separator that makes an unshield buffer unusable here.
///
/// ⛔ This is the ONLY structural separation between the two C7 consumers.
/// Deleting it leaves separation-by-luck: `sha256(pubkey)` merely being
/// unlikely to equal `sha256(composite)`.
const C7_SUBSCRIBE_DOMAIN: &[u8] = b"P01:C7:SUBSCRIBE:v1";

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

/// Rebuild the 48 bytes circuit 7 hashed into `public_inputs_hash`, for a
/// SUBSCRIBE.
///
/// ⛔ DO NOT factor this and `unshield_denominated_stark_v4::c7_pub_bytes` into
/// one shared helper "for reuse". The domain tag is the only structural
/// separation between the two C7 consumers, and that refactor deletes it while
/// reading as a cleanup.
///
/// # 🚨 The last 32 bytes ARE the sha256 digest, and that is not a coincidence
/// # to be simplified away
///
/// The prover takes `recipient_hash: [u64; 4]` and writes `rh.to_le_bytes()`
/// for each. The client fills those four from the digest below as
/// `u64::from_le_bytes(digest[8i..8i+8])`. Little-endian round-trips, so the
/// concatenation of the four is the digest byte-for-byte — which is why this
/// function can copy the digest in one move instead of splitting and
/// re-joining.
///
/// ⛔ That identity holds only because the felts are carried RAW. They occupy no
/// trace column and no constraint, so nothing ever reduces them mod p. If a
/// future change makes the prover publish reduced felts, a digest limb ≥ the
/// Goldilocks modulus would stop round-tripping and this shortcut becomes wrong.
/// `the_four_binding_felts_reassemble_the_digest` below is the guard on that.
///
/// One extra sha256 syscall over the v4 unshield builder. The preimage is a
/// constant 132 bytes: 19 domain + 32 vault + 8 rate + 8 interval + 32 vk + 33
/// license.
fn c7_subscribe_pub_bytes(
    nullifier_u64: u64,
    subtree_root: u64,
    vault: &Pubkey,
    rate: u64,
    interval_slots: u64,
    vk_hash_subscriber: &[u8; 32],
    license_commitment: &Option<[u8; 32]>,
) -> [u8; C7_PUB_BYTES_LEN] {
    // Fixed-width license slot: tag byte + 32 bytes, zeroed when None. A
    // variable-length tail in a concatenated preimage is an ambiguity, and this
    // costs 33 bytes of hashing to remove it entirely.
    let mut lic = [0u8; 33];
    if let Some(v) = license_commitment {
        lic[0] = 1;
        lic[1..].copy_from_slice(v);
    }

    let digest = solana_sha256_hasher::hashv(&[
        C7_SUBSCRIBE_DOMAIN,
        vault.as_ref(),
        &rate.to_le_bytes(),
        &interval_slots.to_le_bytes(),
        vk_hash_subscriber,
        &lic,
    ])
    .to_bytes();

    let mut buf = [0u8; C7_PUB_BYTES_LEN];
    buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
    buf[8..16].copy_from_slice(&subtree_root.to_le_bytes());
    buf[16..48].copy_from_slice(&digest);
    buf
}

/// Open a private subscription vault from a denominated pool, on a single
/// circuit-7 proof.
///
/// `merkle_root` is the pool root the caller NAMES; `subtree_root`, `siblings`
/// and `directions` are what the handler uses to DERIVE it. Both are required:
/// the derivation says "this is the root my proof reaches", the named root says
/// "and it is one you published". Neither alone is a membership check.
///
/// ⛔ EXACTLY SIX arguments are declared below. Anchor needs the prefix up to
/// the last argument used in a constraint, and only `nullifier` (nullifier
/// record seeds) and `subscriber_commitment` (vault seeds) are used. Stopping
/// at six drops `vk_hash_subscriber` out of the list, cutting the
/// `[u8; 32]`-swap surface from four to three. `merkle_root` stays only because
/// it is positionally before `subscriber_commitment`; no constraint reads it.
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    subtree_root: u64,
    siblings: Vec<u64>,
    directions: Vec<u8>,
    subscriber_commitment: [u8; 32]
)]
pub struct SubscribePrivateStarkV4<'info> {
    /// Transaction payer. Nothing on its own — it is pinned to `c7_authority`
    /// in the handler, and THAT is what makes the buffer non-transferable
    /// between keys.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Retailer who will receive periodic payments.
    ///
    /// Deliberately unvalidated: any pubkey may be a retailer. Its identity is
    /// bound TRANSITIVELY — it is a vault seed, and the vault is in the C7
    /// digest, so re-pointing it would need a PDA collision.
    /// CHECK: Any pubkey can be a retailer.
    pub retailer: AccountInfo<'info>,

    /// Subscription vault PDA, keyed by commitment instead of pubkey.
    ///
    /// `init` is the double-open guard: one commitment, one vault, forever.
    ///
    /// ⛔ BARE `bump`, never `bump = <arg>`. On an `init` account anchor-syn
    /// 0.32.1 runs `find_program_address` either way, so a bump target buys
    /// ZERO compute units while breaking three hand-rolled encoders; and a
    /// stored bump that is not the derived one bricks `claim_period`, `pause`
    /// and `resume` permanently — all three re-derive this address with
    /// `bump = vault.bump`, and `claim_period` is the only closer. ⛔ Never drop
    /// `init` for `create_program_address`: roughly 128 addresses are valid per
    /// seed set. Both measurements live at the end of
    /// `subscribe_private_stark.rs`; `pda_bump_guard` below pins the shape.
    ///
    /// `space = LEN` (361) is right HERE AND ONLY HERE. Three vault sizes exist
    /// on devnet (263 / 328 / 361), which is why `claim_period` reads its rent
    /// floor off `data_len()` instead. This instruction only ever creates
    /// 361-byte vaults.
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

    /// Source denominated pool, pinned to its own seeds so a foreign account
    /// cannot pose as it.
    #[account(
        mut,
        seeds = [
            DenominatedPoolV3::SEED_PREFIX,
            denominated_pool.token_mint.as_ref(),
            &denominated_pool.denomination.to_le_bytes()
        ],
        bump = denominated_pool.bump,
        constraint = denominated_pool.is_active @ ZkShieldedError::PoolNotActive,
        // 🚨 NO `is_valid_root` constraint here, unlike v3 subscribe. The root
        // does not exist yet at this point — it is the OUTPUT of the Poseidon
        // walk. See the module header. It moved into the handler; it was not
        // deleted.
    )]
    pub denominated_pool: Box<Account<'info, DenominatedPoolV3>>,

    /// Merkle tree state. In v3 subscribe this account is loaded and then never
    /// read. Here it is load-bearing: `pool.tree_depth == merkle_tree.depth`
    /// sizes the walk, and the two fields are written by different instructions
    /// with nothing else comparing them.
    #[account(
        seeds = [
            MerkleTreeStateV3::SEED_PREFIX,
            denominated_pool.key().as_ref()
        ],
        bump = merkle_tree.bump
    )]
    pub merkle_tree: Box<Account<'info, MerkleTreeStateV3>>,

    /// Nullifier record PDA — double-spend prevention by EXISTENCE at ONE
    /// address.
    ///
    /// ⛔ These seeds are byte-identical to v3 subscribe's and to v4 unshield's,
    /// prefix `b"nullifier"`. That sameness is what stops one note being spent
    /// once through unshield and again through subscribe. "Disambiguating the
    /// two instructions' seeds" would be a pool drain dressed as tidiness.
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

    /// C7 (spend) STARK proof buffer — the ONLY proof this instruction reads.
    /// It replaces the `c1_proof_buffer` + `c3_proof_buffer` pair, and proves,
    /// in one trace, that the nullifier derives from a well-formed commitment
    /// AND that the commitment is a leaf under `subtree_root`.
    /// CHECK: Validated manually (owner, discriminator, authority, circuit_id=7,
    /// verified, deep_ali_verified, public_inputs_hash).
    pub c7_proof_buffer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    /// Token program (optional, for SPL tokens).
    pub token_program: Option<Program<'info, Token>>,

    /// Pool's token vault (optional, only for SPL tokens). Validated in the
    /// handler: `mint == pool.token_mint`, `owner == pool.key()`.
    #[account(mut)]
    pub pool_vault: Option<Account<'info, TokenAccount>>,

    /// Vault's token account (optional, only for SPL tokens).
    ///
    /// 🚨 Validated in the handler with BOTH `mint` and `owner`. The owner check
    /// is the one genuinely new require in this file — see the block at its call
    /// site.
    ///
    /// NOTE: there is deliberately NO `fee_escrow` account. See the module
    /// header: charging a fee here strands the deposit AND the rent.
    #[account(mut)]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handler(
    ctx: Context<SubscribePrivateStarkV4>,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    subtree_root: u64,
    siblings: Vec<u64>,
    directions: Vec<u8>,
    subscriber_commitment: [u8; 32],
    rate: u64,
    interval_slots: u64,
    vk_hash_subscriber: [u8; 32],
    license_commitment: Option<[u8; 32]>,
) -> Result<()> {
    // Both are load-bearing, and neither is cosmetic. `funded_periods()` and
    // `claimable_periods()` return 0 on `rate == 0`, which makes a vault
    // unclaimable but still closable; `interval_slots == 0` divides by zero
    // inside `claimable_periods`.
    require!(rate > 0, ZkShieldedError::InvalidRate);
    require!(interval_slots > 0, ZkShieldedError::InvalidInterval);

    let clock = Clock::get()?;
    // Taken BEFORE the mutable borrow — it is written into `vault.source_pool`
    // at the end, while `pool` is still borrowed.
    let pool_key = ctx.accounts.denominated_pool.key();
    let pool = &mut ctx.accounts.denominated_pool;
    let amount = pool.denomination;
    let is_native_sol = pool.token_mint == system_program::ID;

    require!(
        pool.total_shielded >= amount,
        ZkShieldedError::InsufficientBalance
    );

    // The two depth fields must agree before either is used to size the walk.
    // They are written by different instructions and nothing else compares them.
    //
    // ⛔ This REPLACES v3 subscribe's `require!(tree_depth == 15)`, which existed
    // only for C3's depth felt and is meaningless under C7. Deleting that line
    // and adding nothing would leave `resolve_pool_root` sizing the walk from a
    // `pool.tree_depth` nobody cross-checked. `resolve_pool_root` does reject
    // `tree_depth <= 12`, but that is a floor, not an agreement.
    require!(
        pool.tree_depth == ctx.accounts.merkle_tree.depth,
        ZkShieldedError::InvalidMerkleRoot
    );

    // The maturity bookkeeping still runs even though the delay is no longer
    // ENFORCED — `min_epoch` is gone. Same shape as v4 unshield: the results are
    // discarded at the end of the handler.
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
    // Circuit 7 ships phase-2 DEEP-ALI from the client; require it. Without this
    // flag the buffer records only that the FRI layer checked out, which is not a
    // statement about the trace.
    require!(c7_deep_ali_verified, ZkShieldedError::InvalidProof);

    // Nullifier canonicalization: the PDA is seeded on the full 32 bytes, but
    // the proof binds only the low 8. Reject any non-canonical nullifier whose
    // high 24 bytes are non-zero, else one proof could be spent under several
    // distinct nullifier PDAs — a double-spend with no forgery in it.
    require!(nullifier[8..] == [0u8; 24], ZkShieldedError::InvalidProof);
    // 🚨 AND the low 8 bytes must be a CANONICAL Goldilocks element. The line
    // above bounds the ENCODING; this one bounds the VALUE, and those stopped
    // being the same thing the moment a raw u64 became the wire format.
    //
    // MEASURED 2026-08-26 against the DEPLOYED verifier. Its boundary assertion
    // is `Felt::new(public_inputs[0])` (p01_stark_verifier/src/verify.rs, arm 7)
    // and `Felt::new(v) = Felt(v % p)` (goldilocks.rs) -- but
    // `public_inputs_to_bytes` and `hash_public_inputs` hash the u64 RAW, and a
    // grep over verify.rs finds no range check on any public input. Since
    // 2^64 - p = 2^32 - 1 EXACTLY, every nullifier below 2^32 - 1 has a SECOND
    // in-range encoding `n + p`: ONE field element, TWO 8-byte strings, TWO
    // distinct `NullifierRecord` PDAs, both `init`-able, and both passing the
    // check above. The attacker re-runs the prover on the SAME witness with
    // public input 0 set to `n + p` -- the trace is byte-identical, only the
    // Fiat-Shamir seed moves -- and gets a second fully HONEST proof. No
    // forgery, no soundness break: the note simply pays out twice. Grinding a
    // note secret until `n < 2^32 - 1` is ~2^32 Poseidon-GL evaluations, GPU
    // hours, not a hardness assumption.
    //
    // This is the argument `spend_root::resolve_pool_root` already makes for
    // `subtree_root` and for every sibling -- "a non-canonical u64 is a distinct
    // value mod p, so accepting one would let two different byte strings name
    // the same root". The nullifier, which is the actual double-spend key rather
    // than a root, had nothing.
    //
    // Costs no honest client anything: a Poseidon-GL output is reduced by
    // construction (`state/poseidon_gl.rs`), so an honest prover has only ever
    // emitted the canonical value. `SpendNonCanonicalFelt` already exists, so
    // the append-only error enum does not renumber.
    //
    // ⚠️ Belt and braces belongs one layer DOWN and is deliberately not shipped
    // here: rejecting `public_inputs[i] >= GOLDILOCKS_PRIME` inside
    // `p01_stark_verifier::verify_generic` would close this for every circuit at
    // once instead of once per spend instruction. That is a verifier redeploy,
    // and this crate is not it -- the consumer-side line is what ships first.
    require!(
        u64::from_le_bytes(nullifier[..8].try_into().unwrap()) < crate::state::poseidon_gl::MODULUS,
        ZkShieldedError::SpendNonCanonicalFelt
    );

    {
        // The vault address transitively carries retailer + subscriber
        // commitment + mint; `rate` and `interval_slots` are the other half of
        // the economic statement and are bound explicitly. See the module
        // header for why binding the destination alone is not enough here.
        let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
        let vault_key = ctx.accounts.vault.key();
        let pub_buf = c7_subscribe_pub_bytes(
            nullifier_u64,
            subtree_root,
            &vault_key,
            rate,
            interval_slots,
            &vk_hash_subscriber,
            &license_commitment,
        );
        let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(c7_inputs_hash == expected_hash, ZkShieldedError::InvalidProof);
    }
    drop(c7_data);

    // -----------------------------------------------------------------------
    // The other half of the membership statement — see the module header.
    //
    // Everything above proves a leaf sits under `subtree_root`. Nothing above
    // says `subtree_root` has anything to do with this pool. v3 subscribe had no
    // equivalent of this block because C3 proved the full-depth path.
    // -----------------------------------------------------------------------
    let derived = spend_root::resolve_pool_root(subtree_root, &siblings, &directions, pool.tree_depth)
        .map_err(spend_root_error)?;

    // The named root must be the one the walk reaches. Only the low 8 bytes
    // carry the felt — the V3 root format packs the Goldilocks element into
    // bytes 0..8 — and the high 24 are compared too, so a caller cannot name one
    // published root while proving a path to another with the same limb.
    require!(
        merkle_root[..8] == derived.to_le_bytes(),
        ZkShieldedError::SpendRootMismatch
    );
    require!(
        pool.is_valid_root(&merkle_root),
        ZkShieldedError::InvalidMerkleRoot
    );

    // -----------------------------------------------------------------------
    // Transfer the FULL denomination from the pool into the vault.
    //
    // ⛔ No `fee::calculate_fee`, no `fee_escrow`. The module header has the
    // arithmetic: a fee here makes the final `claim_period` revert, and
    // `claim_period` is the only instruction that can close a vault.
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

        // The destination is the `init`ed, digest-bound PDA. Safe today for the
        // additional reason that both funded pools are native SOL.
        **pool.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? += amount;
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
        let vault_token = ctx
            .accounts
            .vault_token_account
            .as_ref()
            .ok_or(ZkShieldedError::MissingTokenAccount)?;

        require!(pool_vault.mint == pool.token_mint, ZkShieldedError::InvalidTokenMint);
        require!(pool_vault.owner == pool.key(), ZkShieldedError::InvalidTokenOwner);
        require!(vault_token.mint == pool.token_mint, ZkShieldedError::InvalidTokenMint);

        // 🚨 THE SINGLE MOST IMPORTANT NEW LINE IN THIS FILE.
        //
        // The proof binds a vault PDA; the SPL leg pays a TOKEN ACCOUNT. Without
        // this require those are two different things, and "the proof binds the
        // payout" is false for half the payout paths: whoever lands the
        // transaction could pass any token account of the right mint, including
        // their own, and the money would follow the ACCOUNT rather than the
        // PROOF.
        //
        // Verified absent in v3 subscribe, which checks three things and never
        // this one. It landed in `unshield_denominated_stark_v4` on 2026-08-26
        // (commit ce4b75eb) as the mirror of this repair — the spec for this
        // file called for shipping that fix alongside; READ THE CODE, it is
        // already in the tree, so nothing was changed there.
        //
        // The far end already requires it: `claim_period` constrains
        // `vault_token_account.owner == vault.key()`, so a subscribe into a
        // foreign-owned ATA mints a vault whose funds can NEVER be claimed and
        // whose rent is stranded. `InvalidTokenOwner` already exists — no new
        // variant, no renumbering of an append-only error enum.
        //
        // Written on ONE line so the guard below can match the whole `require!`
        // statement rather than the identifier: `vault_token.owner` would also be
        // satisfied by an ordinary read, which is exactly how the deep-ALI guard
        // was hollow.
        require!(vault_token.owner == ctx.accounts.vault.key(), ZkShieldedError::InvalidTokenOwner);

        let transfer_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            TokenTransfer {
                from: pool_vault.to_account_info(),
                to: vault_token.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer_seeds,
        );
        // `amount`, not a net-of-fee figure. There is no fee.
        token::transfer(transfer_ctx, amount)?;
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

    // -----------------------------------------------------------------------
    // Vault state — ALL EIGHTEEN FIELDS, in v3's order.
    //
    // ⛔ Not one field may be dropped, added or reordered. Live vaults decode
    // sequentially and all three decoders (apps/web, packages/merchant-sdk,
    // packages/p01-js) are length-guarded sequential reads.
    // -----------------------------------------------------------------------
    let vault = &mut ctx.accounts.vault;
    vault.subscriber_pubkey = None;
    vault.subscriber_commitment = Some(subscriber_commitment);
    vault.retailer = ctx.accounts.retailer.key();
    vault.token_mint = pool.token_mint;
    // The FULL denomination. This is what `funded_periods()` divides and what
    // `unpaid_amount()` subtracts from; see the header on why it must not be
    // net of a fee.
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
    // account, where it selected the refund-via-relayer path on cancel. There is
    // no cancel and no refund. The parameter never existed on this instruction;
    // the FIELD stays, always `None`, because `SubscriptionVault::LEN` and the
    // account layout must not move under the vaults already live on devnet.
    vault.client_stealth_meta = None;
    vault.license_commitment = license_commitment;

    // -----------------------------------------------------------------------
    // NO EVENT. `SubscribePrivateStarkEvent` does not survive into v4.
    //
    // Be precise about WHY, because v4 unshield's reason does not transfer. That
    // one dropped its event because the event leaked `recipient`. Here every
    // field is already in the same transaction: `nullifier` and
    // `subscriber_commitment` are instruction bytes, and vault / retailer /
    // token_mint / source_pool are account keys or public vault fields. So the
    // event adds NO EDGE.
    //
    // What it DOES add is a cheap bulk index: one `getSignaturesForAddress`
    // log scan yields (nullifier, vault, retailer, amount, source_pool) for every
    // subscription with no instruction decoding at all — a per-target relink job
    // turned into a batch one. That is the honest reason.
    //
    // Cost of dropping it: zero, measured. Recovery is a discriminator-filtered
    // `getProgramAccounts` over vault accounts, deliberately with no `dataSize`
    // filter, not a log scan. A repo-wide grep for `SubscribePrivateStarkEvent`
    // finds no runtime consumer.
    // -----------------------------------------------------------------------

    // The same idiom v4 unshield uses for locals the `min_epoch` removal
    // orphaned: the maturity bookkeeping above still has to RUN, its outputs are
    // no longer read.
    let _ = (current_epoch, dynamic_delay);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::spend_root::SpendRootError;

    /// The prover's frozen order, restated where the reconstruction lives so a
    /// change to either side has to pass through a failing test.
    #[test]
    fn the_public_input_layout_is_forty_eight_bytes_of_six_felts() {
        assert_eq!(C7_PUB_BYTES_LEN, 6 * 8);
    }

    /// 🚨 The guard on the shortcut in `c7_subscribe_pub_bytes`.
    ///
    /// The four binding felts are written raw, so their concatenation IS the
    /// sha256 digest. This test splits the digest the way the CLIENT does and
    /// re-joins it the way the PROVER does, and requires the round trip to be
    /// the identity — including for a limb that exceeds the Goldilocks modulus,
    /// which is the case that would break if anyone ever reduces them.
    #[test]
    fn the_four_binding_felts_reassemble_the_digest() {
        let vault = Pubkey::new_from_array([0x5A; 32]);
        let vk = [0x11u8; 32];
        let lic = Some([0x22u8; 32]);

        let mut lic_slot = [0u8; 33];
        lic_slot[0] = 1;
        lic_slot[1..].copy_from_slice(&[0x22u8; 32]);
        let digest = solana_sha256_hasher::hashv(&[
            C7_SUBSCRIBE_DOMAIN,
            vault.as_ref(),
            &7u64.to_le_bytes(),
            &9u64.to_le_bytes(),
            &vk,
            &lic_slot,
        ])
        .to_bytes();

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

        let buf = c7_subscribe_pub_bytes(1, 2, &vault, 7, 9, &vk, &lic);
        assert_eq!(
            &buf[16..48],
            &digest,
            "c7_subscribe_pub_bytes wrote a different digest",
        );
    }

    /// Every field of `pub_bytes` moves the hash. A field that does not is a
    /// field the proof does not bind — and for `rate` / `interval_slots` that is
    /// the whole prepaid envelope, emptied one slot after subscribe.
    #[test]
    fn every_published_field_moves_the_hash() {
        let v0 = Pubkey::new_from_array([1u8; 32]);
        let v1 = Pubkey::new_from_array([2u8; 32]);
        let vk0 = [0xA0u8; 32];
        let vk1 = [0xA1u8; 32];
        let lic0 = Some([0xB0u8; 32]);
        let lic1 = Some([0xB1u8; 32]);
        let base = c7_subscribe_pub_bytes(7, 9, &v0, 100, 200, &vk0, &lic0);
        for (name, other) in [
            ("nullifier", c7_subscribe_pub_bytes(8, 9, &v0, 100, 200, &vk0, &lic0)),
            ("subtree_root", c7_subscribe_pub_bytes(7, 10, &v0, 100, 200, &vk0, &lic0)),
            ("vault", c7_subscribe_pub_bytes(7, 9, &v1, 100, 200, &vk0, &lic0)),
            ("rate", c7_subscribe_pub_bytes(7, 9, &v0, 101, 200, &vk0, &lic0)),
            ("interval_slots", c7_subscribe_pub_bytes(7, 9, &v0, 100, 201, &vk0, &lic0)),
            ("vk_hash_subscriber", c7_subscribe_pub_bytes(7, 9, &v0, 100, 200, &vk1, &lic0)),
            ("license_commitment", c7_subscribe_pub_bytes(7, 9, &v0, 100, 200, &vk0, &lic1)),
            ("license None", c7_subscribe_pub_bytes(7, 9, &v0, 100, 200, &vk0, &None)),
        ] {
            assert_ne!(base, other, "{name} did not change pub_bytes");
        }
    }

    /// 🚨 THE ATTACK CORRECTION 2 OF THE SPEC IS ABOUT, as arithmetic.
    ///
    /// A relayer holding the buffer who could choose the terms would set
    /// `rate = denomination` and `interval_slots = 1`, and `claim_period` —
    /// permissionless — would hand the retailer the whole envelope one slot
    /// later. Binding the destination alone does not stop that, because the
    /// destination is unchanged. Only the schedule being INSIDE the digest does.
    #[test]
    fn rewriting_the_schedule_invalidates_the_reconstruction() {
        let vault = Pubkey::new_from_array([0xAA; 32]);
        let vk = [0u8; 32];
        let honest = c7_subscribe_pub_bytes(42, 99, &vault, 1_000_000, 216_000, &vk, &None);
        let looted = c7_subscribe_pub_bytes(42, 99, &vault, 1_000_000_000, 1, &vk, &None);
        let h = solana_sha256_hasher::hashv(&[&honest]).to_bytes();
        let a = solana_sha256_hasher::hashv(&[&looted]).to_bytes();
        assert_ne!(
            h, a,
            "the schedule is outside the digest: whoever lands the tx chooses it",
        );
    }

    /// 🚨 A buffer minted for an unshield must not be spendable here.
    ///
    /// ⛔ THE OBVIOUS VERSION OF THIS TEST IS HOLLOW, AND IT WAS MEASURED HERE
    /// ON 2026-08-26. It compared the builder's digest against
    /// `sha256(vault_pubkey)` and asserted they differ — which stays TRUE with
    /// the domain tag deleted from the preimage, because the two preimages
    /// differ anyway by the rate, the interval and the vk hash. Deleting
    /// `C7_SUBSCRIBE_DOMAIN` from the `hashv` call left that assertion GREEN.
    /// It asserted separation-by-luck, which the module header says explicitly
    /// is NOT the mechanism.
    ///
    /// So the statement is made the only way that binds: build the digest the
    /// UNTAGGED code would produce, over the same six values, and require the
    /// builder not to produce it. That is false the instant the tag leaves the
    /// preimage, and it cannot be satisfied by the constant merely existing.
    #[test]
    fn the_domain_tag_is_inside_the_preimage_and_not_merely_defined() {
        let vault = Pubkey::new_from_array([0xCC; 32]);
        let vk = [0x33u8; 32];
        let untagged = solana_sha256_hasher::hashv(&[
            vault.as_ref(),
            &5u64.to_le_bytes(),
            &6u64.to_le_bytes(),
            &vk,
            &[0u8; 33],
        ])
        .to_bytes();
        let subscribe = c7_subscribe_pub_bytes(1, 2, &vault, 5, 6, &vk, &None);
        assert_ne!(
            &subscribe[16..48],
            &untagged,
            "the domain tag is not in the digest preimage: an unshield buffer and a              subscribe buffer are separated only by the accident that their other              fields differ",
        );

        // And the tag itself is frozen. Changing its bytes silently invalidates
        // every proof already built for this instruction.
        assert_eq!(C7_SUBSCRIBE_DOMAIN, b"P01:C7:SUBSCRIBE:v1");
    }

    /// Each caller-side failure of the walk keeps its own error code. Collapsing
    /// them into `InvalidProof` would tell a caller with three siblings on a
    /// depth-15 pool that their PROOF is bad, and they would go rebuild it.
    ///
    /// The mapping is IMPORTED from `unshield_denominated_stark_v4`; this test
    /// pins that the import still resolves to four distinct codes.
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
    /// would accept a proof that publishes the commitment and proves a different
    /// statement.
    #[test]
    fn this_instruction_spends_on_circuit_seven_only() {
        assert_eq!(CIRCUIT_SPEND, 7);
    }
}

// ---------------------------------------------------------------------------
// [C7] The implications this instruction has to hold, checked on the SOURCE.
//
// "Routable only if it proves membership" is a property of the code, not of any
// one execution: no fixture can show that NO ordering of accounts reaches the
// payout early.
//
// Everything below reads the file with comments stripped. A comment naming a
// check must never be what satisfies an assertion about the check — the module
// header says `filled_subtrees` in prose, and that is a thing the code must NOT
// contain.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod membership_guard {
    const SRC: &str = include_str!("subscribe_private_stark_v4.rs");

    /// The two ways pool value reaches the vault. Both must sit behind every
    /// check below.
    ///
    /// ⛔ Anchor's `init` on `vault` moves RENT from the payer during
    /// `try_accounts`, before a line of handler code runs. That movement has no
    /// needle here and cannot have one, which is why these guards are named for
    /// POOL VALUE and not for lamports in general. The v4 unshield name
    /// (`no_lamport_moves_before_…`) would be false in this file while the test
    /// stayed green — the hollow shape, again.
    const POOL_VALUE_MOVES: [&str; 2] = ["try_borrow_mut_lamports", "token::transfer("];

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

    /// EVERY occurrence, not the first. v4 unshield used `code.find(payout)`,
    /// which checks only the earliest one and would miss a second payout added
    /// below it.
    fn every_index_of(code: &str, needle: &str) -> Vec<usize> {
        let v: Vec<usize> = code.match_indices(needle).map(|(i, _)| i).collect();
        assert!(!v.is_empty(), "`{needle}` not found");
        v
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
    /// says nothing about which subtree. If pool value can move before
    /// `resolve_pool_root` has run, an attacker's self-built twelve levels pay
    /// out — the `unshield` C5 defect, rebuilt. v3 subscribe has no walk to
    /// inherit this from.
    #[test]
    fn no_pool_value_reaches_the_vault_before_the_pool_root_is_resolved() {
        let code = code();
        let walk = code
            .find("let derived = spend_root::resolve_pool_root(")
            .expect("the walk is gone: a self-built twelve-level subtree now pays out");
        for payout in POOL_VALUE_MOVES {
            for at in every_index_of(&code, payout) {
                assert!(at > walk, "{payout} can run before resolve_pool_root");
            }
        }
    }

    /// The walk alone is not a membership check either: it turns a subtree root
    /// into SOME root. Only `is_valid_root` says the pool ever published it, and
    /// only `SpendRootMismatch` says the named root is the one the walk reached.
    ///
    /// 🚨 THESE NEEDLES WERE NAMES, AND A NAME IS SATISFIED BY A DISCARDED
    /// READ. MEASURED 2026-08-26 on this tree: replacing
    ///
    ///     require!(pool.is_valid_root(&merkle_root), ..)
    ///
    /// with `let _root_is_published = pool.is_valid_root(&merkle_root);` left this
    /// test GREEN, along with all 86 lib tests, all 10 landed_invariants and
    /// `clippy -D warnings` at exit 0. That binary is a FULL POOL DRAIN: with the
    /// ring gone the surviving `SpendRootMismatch` check is a TAUTOLOGY, because
    /// the caller supplies `merkle_root` themselves and `derived` comes from their
    /// own siblings. Any self-built twelve-level subtree over an invented leaf then
    /// pays a denomination, and a fresh nullifier every round means the `init` on
    /// the record never collides.
    ///
    /// It is the exact hollow shape this file diagnoses two functions down for the
    /// PROOF checks. The lesson had been applied there, to the SPL owner check and
    /// to the domain tag -- and not to the three needles this file exists for.
    /// Every one is now matched as the `require!` (or the whole statement) it is.
    #[test]
    fn no_pool_value_moves_before_the_root_is_matched_against_the_pool() {
        let code = code();
        let ring = code
            .find("require!(\n        pool.is_valid_root(&merkle_root),")
            .expect(
                "the ring check is no longer a require over `&merkle_root`: any \
                 self-built subtree reaches a root of the caller's own choosing and \
                 pays out",
            );
        let mismatch = code
            .find("require!(\n        merkle_root[..8] == derived.to_le_bytes(),")
            .expect("the derived/named root check is no longer a require");
        for payout in POOL_VALUE_MOVES {
            for at in every_index_of(&code, payout) {
                assert!(at > ring, "{payout} can run before is_valid_root");
                assert!(at > mismatch, "{payout} can run before the derived/named root check");
            }
        }

        // ⛔ And the two checks must constrain the SAME 32 bytes.
        // `SpendRootMismatch` on its own is a tautology when `merkle_root` is
        // caller-supplied and `derived` comes from caller-supplied siblings; it
        // only means something because `is_valid_root` is applied to that same
        // value and to no other. One occurrence, inside the require above, is
        // what keeps that true -- the two needles pin it textually and this
        // count stops a second, unconstrained value being handed to the ring.
        assert_eq!(
            code.matches("is_valid_root").count(),
            1,
            "`is_valid_root` is consulted more than once here: the ring is being asked \
             about some value other than the `merkle_root` the mismatch check pinned",
        );
    }

    /// The proof itself must be checked before the money moves, phase 2
    /// included, and the TERMS must be inside what the proof commits to.
    ///
    /// 🚨 THE FIRST VERSION OF THE V4 UNSHIELD GUARD WAS HOLLOW, AND IT WAS
    /// MEASURED. It searched for `c7_deep_ali_verified`, which also appears in
    /// the tuple the buffer is destructured into — so deleting the `require!`
    /// outright left the test GREEN. Every needle below is therefore matched as
    /// the REQUIRE (or the whole statement) it has to be, never as a mention.
    #[test]
    fn the_proof_is_fully_checked_before_the_money_moves() {
        let code = code();
        let payouts: Vec<(usize, &str)> = POOL_VALUE_MOVES
            .iter()
            .flat_map(|p| every_index_of(&code, p).into_iter().map(move |i| (i, *p)))
            .collect();

        let requires = [
            ("phase 2", "require!(c7_deep_ali_verified,"),
            ("phase 1", "require!(c7_verified,"),
            ("circuit id", "require!(c7_circuit_id == CIRCUIT_SPEND,"),
            ("buffer authority", "c7_authority == ctx.accounts.payer.key()"),
            ("public-inputs hash", "require!(c7_inputs_hash == expected_hash,"),
            ("nullifier encoding canonicalisation", "require!(nullifier[8..] == [0u8; 24],"),
            // 🚨 The VALUE, not merely the encoding, and matched as the whole
            // statement. MEASURED 2026-08-26: with this require replaced by a
            // discarded `let`, the alias encoding `n + p` spends the same note a
            // SECOND time for 130,225 CU. The executed proof is
            // `one_field_element_cannot_be_spent_under_two_nullifier_encodings`
            // in tests/subscribe_v4_adversarial.rs, which goes red on exactly that.
            (
                "nullifier value canonicalisation",
                "require!(\n        u64::from_le_bytes(nullifier[..8].try_into().unwrap()) \
                 < crate::state::poseidon_gl::MODULUS,",
            ),
            // The terms binding, as the whole statement that feeds `rate` and
            // `interval_slots` into the hash the require above compares. The
            // spec listed the `c7_inputs_hash` require twice for this; that
            // needle cannot tell a composite digest from a bare pubkey, so this
            // is the one that actually pins the terms.
            ("terms binding", "let pub_buf = c7_subscribe_pub_bytes("),
        ];
        for (what, needle) in requires {
            let at = code
                .find(needle)
                .unwrap_or_else(|| panic!("the {what} check is gone: `{needle}` not in the code"));
            for (p, payout) in &payouts {
                assert!(*p > at, "{payout} can run before the {what} check");
            }
        }

        // Not ordering assertions — presence. Both live inside
        // `c7_subscribe_pub_bytes`, above the handler, so an ordering check
        // would be vacuously true.
        assert!(
            code.contains("&rate.to_le_bytes()") && code.contains("&interval_slots.to_le_bytes()"),
            "the schedule is outside the digest: whoever lands the tx chooses it, sets \
             rate = denomination and interval_slots = 1, and claim_period hands the \
             retailer the whole envelope one slot later",
        );
        // ⛔ NOT `code.contains("C7_SUBSCRIBE_DOMAIN")`. MEASURED 2026-08-26:
        // that needle is satisfied by the constant's own DEFINITION, so
        // deleting the tag from the `hashv` preimage left it green — the
        // destructuring-tuple shape that made the v4 deep-ALI guard hollow,
        // rebuilt here by hand. Match the tag where it has to appear: first
        // element of the digest preimage.
        assert!(
            code.contains("hashv(&[
        C7_SUBSCRIBE_DOMAIN,"),
            "no domain tag in the digest preimage: an unshield buffer is a subscribe              buffer. Defining the constant is not using it",
        );
    }

    /// 🚨 THE SPL LEG MUST PAY THE ACCOUNT THE PROOF BINDS, NOT MERELY THE RIGHT
    /// MINT.
    ///
    /// ⛔ This is DELIBERATELY not folded into the ordering set above. The SOL
    /// branch is written first, so `try_borrow_mut_lamports` appears in the file
    /// BEFORE this require; asserting "every payout is after this check" would
    /// be false for a correct file. The spec asked for it in that list; the code
    /// says it cannot go there. What is true, and what is asserted, is that the
    /// SPL payout itself is behind it.
    ///
    /// Matched as the whole `require!`: `vault_token.owner` also appears in
    /// ordinary reads, so searching for the name alone would stay green with the
    /// check deleted.
    #[test]
    fn the_spl_destination_is_owned_by_the_account_the_proof_binds() {
        let code = code();
        let needle = "require!(vault_token.owner == ctx.accounts.vault.key(),";
        let bind = code.find(needle).unwrap_or_else(|| {
            panic!(
                "the SPL destination is no longer bound to the vault the proof names; a \
                 relayer can aim the payout at their own ATA, the note burns and the vault \
                 is unclaimable forever because claim_period requires \
                 vault_token_account.owner == vault.key()"
            )
        });
        for at in every_index_of(&code, "token::transfer(") {
            assert!(at > bind, "token::transfer can run before the destination owner is bound");
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

    /// THE SINGLE MOST IMPORTANT GUARD IN THE SET. The privacy property the
    /// circuit exists for, asserted against the code that consumes it. v3 has to
    /// publish the note commitment to tie C1 to C3, which names the deposit that
    /// funded the subscription. If `stark_commitment` reappears here, the single
    /// proof has bought nothing.
    #[test]
    fn the_note_commitment_is_never_an_argument_of_this_instruction() {
        assert!(
            !code().contains("stark_commitment"),
            "v4 must not take the commitment — publishing it is the linkage C7 removes",
        );
    }

    /// `min_epoch` is REMOVED, not ignored. An ignored parameter still puts its
    /// bytes on the wire, and those bytes would carry a 63-bit PRF blinding
    /// secret in the clear — plus the note could never satisfy the delay and
    /// would be permanently un-subscribable.
    #[test]
    fn the_epoch_delay_parameter_is_gone_rather_than_ignored() {
        let code = code();
        assert!(!code.contains("min_epoch"), "min_epoch is back on the wire");
        assert!(
            !code.contains("EpochDelayNotMet"),
            "a blinded note can never satisfy the delay; this require would brick it",
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
    /// mean v4 had quietly grown back into the v3 C1+C3 pairing.
    #[test]
    fn exactly_one_proof_buffer_is_read() {
        let calls = code().matches("parse_stark_proof_buffer(").count();
        // One definition, one call site.
        assert_eq!(calls, 2, "expected the definition and a single call site");
    }

    /// ⛔ NO PROTOCOL FEE, and this is not an oversight to be tidied up.
    ///
    /// `vault.total_deposited` is what `funded_periods()` divides. Charge 50 bps
    /// and write `total_deposited = amount` and the final `claim_period` reverts
    /// on `vault_lamports >= value_payout` — and `claim_period` is the only
    /// instruction that can close a vault, so the deposit and the rent are
    /// stranded forever.
    #[test]
    fn no_fee_is_taken_out_of_the_subscribers_envelope() {
        let code = code();
        for needle in ["calculate_fee", "fee_escrow", "FEE_ESCROW_SEED_PREFIX", "FEE_BPS"] {
            assert!(
                !code.contains(needle),
                "`{needle}` is back: a fee here makes total_deposited disagree with the \
                 lamports in the vault, and the final claim_period reverts forever",
            );
        }
        assert!(
            code.contains("vault.total_deposited = amount;"),
            "the vault must record the FULL denomination it received",
        );
    }

    /// 🚨 GENUINELY NEW — nothing in the tree caught this before.
    ///
    /// This instruction has THREE `[u8; 32]` arguments and the vault seeds read
    /// one of them BY NAME out of a positional list. Swapping `nullifier` and
    /// `subscriber_commitment` in either list compiles, deploys, and seeds every
    /// vault on the wrong 32 bytes — and seeds every nullifier record on the
    /// other wrong 32 bytes, which silently unlinks the double-spend guard from
    /// the value the proof binds. v4 unshield has no PDA seeded on an
    /// instruction argument, so it never had this exposure and has no guard to
    /// inherit.
    #[test]
    fn the_instruction_list_matches_the_handler_signature() {
        let code = code();

        fn names(list: &str) -> Vec<String> {
            list.split(',')
                .map(|p| p.split(':').next().unwrap_or("").trim().to_string())
                .filter(|p| !p.is_empty())
                .collect()
        }

        let at = code.find("#[instruction(").expect("the #[instruction(..)] list is gone");
        let body_at = at + "#[instruction(".len();
        let end = code[body_at..].find(")]").expect("unterminated #[instruction(..)]") + body_at;
        let declared = names(&code[body_at..end]);

        let sig_at = code.find("pub fn handler(").expect("handler signature");
        let sig_body = sig_at + "pub fn handler(".len();
        let sig_end = code[sig_body..].find(") -> Result<").expect("end of signature") + sig_body;
        let params = names(&code[sig_body..sig_end]);

        assert_eq!(
            params.first().map(String::as_str),
            Some("ctx"),
            "the handler no longer takes its Context first; the offsets below are meaningless",
        );
        assert!(
            !declared.is_empty() && params.len() > declared.len(),
            "the two lists cannot be compared: {} declared, {} parameters",
            declared.len(),
            params.len(),
        );
        assert_eq!(
            declared,
            params[1..=declared.len()].to_vec(),
            "the #[instruction(..)] list and the handler parameters have diverged. Anchor \
             matches these POSITIONALLY and the vault seeds read `subscriber_commitment` and \
             the record seeds read `nullifier` BY NAME, so a swap of two [u8; 32] arguments \
             compiles, deploys, and seeds every vault and every nullifier record on the \
             wrong bytes",
        );
    }

    /// 🚨 ALL EIGHTEEN VAULT FIELDS, AS WHOLE STATEMENTS AND IN ORDER.
    ///
    /// ⛔ MEASURED 2026-08-26. Deleting the single line
    /// `vault.bump = ctx.bumps.vault;` left EVERYTHING green -- 86 lib tests, 10
    /// landed_invariants, 10 unshield_c5_membership (SBF dispatch included, against
    /// a freshly rebuilt artifact), 7 subscription_lifecycle, and
    /// `clippy -D warnings` at exit 0 -- while minting a vault whose stored bump is
    /// 0. `claim_period` re-derives this address with `bump = vault.bump` and
    /// refuses it with ConstraintSeeds (2006). Deleting `vault.is_active = true;`
    /// is the same story through VaultNotActive (6025). `claim_period` is the ONLY
    /// instruction that can close a vault, and cancel and refund were deliberately
    /// removed, so either one-line mutation strands the subscriber's whole prepaid
    /// envelope plus the rent, permanently, with nothing red.
    ///
    /// ORDER as well as presence: live vaults decode sequentially and all three
    /// decoders (apps/web, packages/merchant-sdk, packages/p01-js) are
    /// length-guarded sequential reads. The count is the anti-vacuity half, so a
    /// NINETEENTH field cannot arrive unnamed.
    ///
    /// This is the WEAKER of the two guards on the property, because a source scan
    /// cannot see what a field is set TO. The executed one is
    /// `a_correct_v4_subscribe_lands_and_the_vault_it_mints_is_readable` plus
    /// `claim_period_drives_a_v4_minted_vault_one_period_at_a_time` in
    /// tests/subscribe_v4_adversarial.rs: they read the fields back off a vault the
    /// real `.so` minted, re-derive the address from the STORED bump, and then drive
    /// `claim_period` against it. Keep both -- the scan pins the order the decoders
    /// need, the probe pins that the vault is spendable.
    #[test]
    fn every_vault_field_the_decoders_read_is_still_written_in_order() {
        let code = code();
        const WRITES: [&str; 18] = [
            "vault.subscriber_pubkey = None;",
            "vault.subscriber_commitment = Some(subscriber_commitment);",
            "vault.retailer = ctx.accounts.retailer.key();",
            "vault.token_mint = pool.token_mint;",
            "vault.total_deposited = amount;",
            "vault.rate = rate;",
            "vault.interval_slots = interval_slots;",
            "vault.start_slot = clock.slot as i64;",
            "vault.claimed_periods = 0;",
            "vault.is_active = true;",
            "vault.is_paused = false;",
            "vault.pause_slot = None;",
            "vault.total_paused_slots = 0;",
            "vault.vk_hash_subscriber = vk_hash_subscriber;",
            "vault.source_pool = Some(pool_key);",
            "vault.bump = ctx.bumps.vault;",
            "vault.client_stealth_meta = None;",
            "vault.license_commitment = license_commitment;",
        ];
        let mut prev = 0usize;
        for w in WRITES {
            let at = code.find(w).unwrap_or_else(|| {
                panic!(
                    "`{w}` is gone. The three decoders are length-guarded SEQUENTIAL \
                     reads over live vaults, and claim_period / pause / resume re-derive \
                     this account from its own stored fields -- a dropped field is a \
                     vault only claim_period could close and that claim_period cannot find"
                )
            });
            assert!(
                at > prev,
                "`{w}` moved: the eighteen writes are out of v3 order and the sequential \
                 decoders will read the wrong bytes",
            );
            prev = at;
        }

        let assigned: Vec<&str> = code
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("vault.") && l.contains(" = ") && l.ends_with(';'))
            .collect();
        assert_eq!(
            assigned.len(),
            WRITES.len(),
            "this handler writes {} vault fields, not {}. One arrived or left without \
             passing through the list above: {assigned:?}",
            assigned.len(),
            WRITES.len(),
        );
    }

    /// 🚨 THE DIGEST MUST BE BUILT OVER THE VAULT THIS INSTRUCTION INITS.
    ///
    /// The call SITE is the thing no other guard in this file can see.
    /// `every_published_field_moves_the_hash` exercises the pure builder, and
    /// `the_proof_is_fully_checked_before_the_money_moves` matches only
    /// `let pub_buf = c7_subscribe_pub_bytes(` -- neither can tell WHICH `Pubkey`
    /// is passed. Re-pointing that argument at `ctx.accounts.retailer.key()`
    /// compiles, keeps every one of those tests green, and is strictly weaker: the
    /// retailer alone leaves `subscriber_commitment` free, which hands the buffer
    /// holder pause/resume control over the merchant's income stream while the
    /// honest subscriber's note burns. No needle matching a NAME can catch it,
    /// because the call site accepts any `Pubkey` in scope -- so match the binding
    /// and the head of the argument list, whole.
    #[test]
    fn the_digest_is_built_over_the_vault_this_instruction_inits() {
        let code = code();
        assert!(
            code.contains("let vault_key = ctx.accounts.vault.key();"),
            "the digest no longer reads the vault account's own address",
        );
        const CALL: &str = concat!(
            "let pub_buf = c7_subscribe_pub_bytes(\n",
            "            nullifier_u64,\n",
            "            subtree_root,\n",
            "            &vault_key,",
        );
        assert!(
            code.contains(CALL),
            "the third argument of the digest builder is no longer `&vault_key`. Only \
             the vault address transitively binds retailer + subscriber_commitment + \
             mint; anything else is strictly weaker, and nothing else here can see it",
        );
    }

    /// ⚠️ The caveat about epoch-blinded notes is prose, and prose gets deleted
    /// as stale. It is the only place the client-side gate is specified, and the
    /// gate must be an EQUALITY — a magnitude test passes any note whose epoch
    /// happened to be large, and passes a hand-crafted receipt.
    ///
    /// Asserted against SRC, not `code()`: the whole point is that the COMMENT
    /// survives.
    #[test]
    fn the_blinding_caveat_is_still_written_down() {
        for needle in [
            "The gate is CLIENT-SIDE and must be an EQUALITY",
            "one secret, one note, one vault",
        ] {
            assert!(
                SRC.contains(needle),
                "`{needle}` was deleted. It is not a stale comment: it is the only \
                 statement of a defect this instruction inherits and cannot fix on chain",
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Structural guard on the stealth-meta removal.
//
// Carried across from `subscribe_private_stark.rs`, with its two EVENT
// assertions replaced by "no `emit!` anywhere" — there is no event in this file
// to assert about, and an assertion about a missing event would be vacuous
// rather than absent, which is worse.
//
// What it protects. `client_stealth_meta` was a 64-byte subscriber-controlled
// stealth address, `[spending_pub(32) | viewing_pub(32)]`, written into a PUBLIC
// account so `cancel_private_stark` could route a refund to it. There is no
// cancel and no refund, so publishing it buys nothing and links a subscriber's
// stealth identity to a vault forever.
//
// The removal it protects was MEASURED to be unguarded on v3: putting
// `vault.client_stealth_meta = Some(..)` back left the suite green, because the
// client-side encoder tests only cover the instruction ARGUMENT, never what the
// program writes into the account.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod stealth_meta_guard {
    const SRC: &str = include_str!("subscribe_private_stark_v4.rs");

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
        // used to land in.
        let code = code();
        let sig_start = code.find("pub fn handler(").expect("handler signature");
        let sig_end = code[sig_start..].find(") -> Result<").expect("end of signature") + sig_start;
        assert!(
            !code[sig_start..sig_end].contains("client_stealth_meta"),
            "this instruction takes a client_stealth_meta argument — the subscriber's \
             stealth address is back in the public transaction payload even if nothing \
             stores it",
        );
    }

    /// The v3 event paired `subscriber_commitment` with `nullifier` in one log
    /// line, both functions of the same note secret. It does not survive into
    /// v4 — not because it leaks an edge the transaction does not already carry,
    /// but because it is a CHEAP BULK INDEX: one log scan yields
    /// (nullifier, vault, retailer, amount, source_pool) for every subscription
    /// with no instruction decoding at all, turning a per-target relink job into
    /// a batch one.
    ///
    /// Cost of dropping it: zero, measured. Client recovery is a
    /// discriminator-filtered `getProgramAccounts` over vault accounts, not a
    /// log scan.
    #[test]
    fn this_instruction_emits_no_event_at_all() {
        let code = code();
        assert!(
            !code.contains("emit!"),
            "an event is back. Anything emitted here is a bulk index over every \
             subscription, readable with one getSignaturesForAddress call and no \
             instruction decoding",
        );
        assert!(
            !code.contains("#[event]"),
            "an event struct is back in this file",
        );
    }
}

// ---------------------------------------------------------------------------
// Structural guard on the PDA bump derivation. Carried whole from
// `subscribe_private_stark.rs`; v4 unshield has no counterpart because it inits
// exactly one PDA.
//
// This pins the SHAPE of the two note-seeded PDAs: both stay Anchor `init`
// accounts with a BARE `bump`, i.e. the runtime searches for the canonical bump
// and the handler takes no bump argument.
//
// The guard exists because the change it blocks is a five-line change that reads
// as an obvious win and is not one, and because NEITHER of its two failure modes
// is caught by anything else in the tree:
//
//   - `bump = <arg>` on an `init` account still calls find_program_address
//     (anchor-syn 0.32.1 codegen/accounts/constraints.rs:548-555, spliced at
//     :1083). It compiles, deploys, passes every test, breaks every shipped
//     client's instruction encoding, and changes the compute cost by nothing.
//   - Dropping `init` for `create_program_address` on a caller-supplied bump
//     gives ~128 valid record addresses per nullifier. That one shows up as a
//     drained pool.
//
// And here there is a third, specific to the vault: `claim_period`, `pause` and
// `resume` all re-derive this address with `bump = vault.bump`. A stored bump
// that is not the derived one bricks all three, and `claim_period` is the only
// instruction that can close the account.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod pda_bump_guard {
    const SRC: &str = include_str!("subscribe_private_stark_v4.rs");

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
            SRC.contains("BARE `bump`, never `bump = <arg>`"),
            "fixture reworded — pick another phrase from the vault block",
        );
        assert!(
            !code().contains("BARE `bump`, never `bump = <arg>`"),
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
                 `create_program_address` form, the canonical-bump guarantee is gone \
                 with it — for `nullifier_record` that is ~128 record addresses per \
                 nullifier and a pool drain, and for `vault` it is a stored bump that \
                 claim_period, pause and resume can never re-derive.",
            );
            assert!(
                !attr.contains("bump ="),
                "`{field}` now takes a bump target. On an `init` account that does NOT \
                 replace the find_program_address search — anchor-syn 0.32.1 emits it \
                 either way (codegen/accounts/constraints.rs:548-555, spliced at :1083) \
                 and a bump target only adds an equality check (:512-527). So this buys \
                 zero compute units while breaking the instruction encoding of every \
                 shipped client. Measured, not assumed.",
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
            "this instruction takes a bump argument. Every client hand-rolls this \
             instruction's Borsh payload, so this is a breaking wire change; and on an \
             `init` account the bump cannot remove the PDA search that motivated it.",
        );
    }
}
