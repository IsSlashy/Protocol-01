use anchor_lang::prelude::*;

use crate::errors::LiquidityError;
use crate::state::{LiquidityPool, PrefundRecord};

// ---------------------------------------------------------------------------
// STARK proof buffer layout (mirrors p01_stark_verifier::ProofBuffer).
// ---------------------------------------------------------------------------

const STARK_PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

/// p01_stark_verifier program ID: DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
const STARK_VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x47, 0x0c, 0x5e, 0xb3, 0x56, 0x43, 0x7f,
    0xef, 0xf9, 0x2e, 0xd1, 0x86, 0x9b, 0x02, 0x2b,
    0xc4, 0x60, 0x2e, 0x12, 0xb1, 0x13, 0x07, 0x44,
    0xb3, 0x7a, 0x18, 0x7d, 0xe6, 0x39, 0xce, 0xd8,
]);

/// Layout: 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written
///       + 1 verified + 32 public_inputs_hash + 1 deep_ali_verified = 83
///
/// `PROOF_BUF_MIN_LEN` used to be 82, which put `deep_ali_verified` outside the
/// slice this parser would even look at. Every buffer the verifier can create
/// is `ProofBuffer::PROOF_DATA_OFFSET = 83` bytes or longer
/// (`p01_stark_verifier/src/lib.rs:556`), so requiring 83 rejects nothing an
/// honest caller can produce.
const PROOF_BUF_AUTHORITY: usize = 8;
const PROOF_BUF_CIRCUIT_ID: usize = 40;
const PROOF_BUF_VERIFIED: usize = 49;
const PROOF_BUF_INPUTS_HASH: usize = 50;
const PROOF_BUF_DEEP_ALI_VERIFIED: usize = 82;
const PROOF_BUF_MIN_LEN: usize = 83;

const CIRCUIT_POOL_COMMITMENT: u8 = 1;

// ---------------------------------------------------------------------------
// zk_shielded denominated pool (mirrors zk_shielded::state::DenominatedPool and
// ::DenominatedPoolV3).
// ---------------------------------------------------------------------------

/// zk_shielded program ID: GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c.
/// Same 32 bytes as `settle.rs:14-19`, which CPIs into it.
const ZK_SHIELDED_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xe7, 0xb5, 0x1a, 0x49, 0x09, 0x04, 0x45, 0xa8,
    0x85, 0x8a, 0x6a, 0x51, 0x39, 0xea, 0x69, 0xab,
    0x2f, 0xf2, 0x32, 0x9d, 0x8c, 0xb4, 0xaf, 0x3d,
    0xcc, 0xb1, 0x47, 0x1f, 0xb6, 0x0d, 0x77, 0x73,
]);

/// Anchor discriminator: `sha256("account:DenominatedPool")[..8]`.
const DENOMINATED_POOL_DISCRIMINATOR: [u8; 8] = [16, 21, 198, 35, 177, 92, 68, 140];

/// Anchor discriminator: `sha256("account:DenominatedPoolV3")[..8]`.
/// Accepted as well because both structs open with the same three fields and
/// the client's pool-version choice is not this program's business.
const DENOMINATED_POOL_V3_DISCRIMINATOR: [u8; 8] = [15, 219, 145, 69, 148, 52, 170, 42];

/// Both structs start `authority: Pubkey, token_mint: Pubkey, denomination: u64`
/// (`zk_shielded/src/state/pool.rs:172-180`, `pool_v3.rs:53-61`), so:
///   0..8 disc | 8..40 authority | 40..72 token_mint | 72..80 denomination
const DENOM_POOL_AUTHORITY: usize = 8;
const DENOM_POOL_TOKEN_MINT: usize = 40;
const DENOM_POOL_DENOMINATION: usize = 72;
const DENOM_POOL_MIN_LEN: usize = 80;

/// What `prefund` needs out of a zk_shielded denominated pool.
struct DenominatedPoolView {
    /// `DenominatedPool::authority` — the wallet that signed
    /// `init_denominated_pool`. zk_shielded writes it from a `Signer`
    /// (`init_denominated_pool.rs:70`, `init_denominated_pool_v3.rs`), and the
    /// account is owned by zk_shielded, so nobody can set it to a key they do
    /// not control and nobody but zk_shielded can rewrite it later. That is
    /// what makes it usable as an allowlist key — see `handler`.
    authority: Pubkey,
    /// `DenominatedPool::denomination` — the fixed note value.
    denomination: u64,
}

/// Read the fields `prefund` binds against, having first established that this
/// account really is a zk_shielded denominated pool.
///
/// Before this existed, `denominated_pool` was a bare `AccountInfo` used only
/// as a PDA seed, and the payout came from a free `amount` instruction
/// argument. Two consequences, both live:
///
///   1. The payout was unbound. The proof binds only
///      `sha256(nullifier_u64 || stark_commitment)`; `amount` appeared nowhere
///      in it, so one honest circuit-1 proof authorised any payout up to
///      `pool.reserve_lamports`.
///   2. Replay was unbound. `PrefundRecord`'s `init` is the only anti-replay
///      constraint and its seeds include `denominated_pool.key()`. With that
///      key unvalidated, every fresh dummy key yielded a fresh uninitialised
///      PDA, so the same buffer + same nullifier could be prefunded forever.
///
/// The three checks here (owner, length, discriminator) establish only that the
/// bytes are a real zk_shielded pool image. They do NOT establish that it is a
/// pool this program should pay against — `zk_shielded::init_denominated_pool`
/// is permissionless, so an attacker can mint a genuine, correctly-discriminated
/// `DenominatedPool` carrying any `denomination` they like. The `authority`
/// binding in `handler` is what turns "a real pool" into "a pool we support".
fn parse_denominated_pool(owner: &Pubkey, data: &[u8]) -> Result<DenominatedPoolView> {
    require!(
        *owner == ZK_SHIELDED_PROGRAM_ID,
        LiquidityError::InvalidDenominatedPool
    );
    require!(
        data.len() >= DENOM_POOL_MIN_LEN,
        LiquidityError::InvalidDenominatedPool
    );
    require!(
        data[..8] == DENOMINATED_POOL_DISCRIMINATOR || data[..8] == DENOMINATED_POOL_V3_DISCRIMINATOR,
        LiquidityError::InvalidDenominatedPool
    );
    let authority = Pubkey::try_from(&data[DENOM_POOL_AUTHORITY..DENOM_POOL_TOKEN_MINT])
        .map_err(|_| error!(LiquidityError::InvalidDenominatedPool))?;
    let denomination = u64::from_le_bytes(
        data[DENOM_POOL_DENOMINATION..DENOM_POOL_MIN_LEN]
            .try_into()
            .map_err(|_| error!(LiquidityError::InvalidDenominatedPool))?,
    );
    require!(denomination > 0, LiquidityError::InvalidDenominatedPool);
    Ok(DenominatedPoolView {
        authority,
        denomination,
    })
}

fn parse_proof_buffer(data: &[u8]) -> Result<(Pubkey, u8, bool, [u8; 32], bool)> {
    require!(data.len() >= PROOF_BUF_MIN_LEN, LiquidityError::InvalidProofBuffer);
    require!(
        data[..8] == STARK_PROOF_BUFFER_DISCRIMINATOR,
        LiquidityError::InvalidProofBuffer
    );
    let authority = Pubkey::try_from(&data[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID])
        .map_err(|_| error!(LiquidityError::InvalidProofBuffer))?;
    let circuit_id = data[PROOF_BUF_CIRCUIT_ID];
    let verified = data[PROOF_BUF_VERIFIED] == 1;
    let mut inputs_hash = [0u8; 32];
    inputs_hash.copy_from_slice(&data[PROOF_BUF_INPUTS_HASH..PROOF_BUF_DEEP_ALI_VERIFIED]);
    let deep_ali_verified = data[PROOF_BUF_DEEP_ALI_VERIFIED] == 1;
    Ok((authority, circuit_id, verified, inputs_hash, deep_ali_verified))
}

// ---------------------------------------------------------------------------
// Prefund instruction
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
    amount: u64
)]
pub struct Prefund<'info> {
    /// Ephemeral signer — the user's disposable keypair used to upload + verify
    /// the proof. Signing here authorizes the prefund (we check it matches the
    /// proof buffer's authority below).
    #[account(mut)]
    pub ephemeral_signer: Signer<'info>,

    /// CHECK: any address may receive the prefunded lamports.
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// `is_active` is the prefund kill-switch, and it is the reason a freshly
    /// created pool cannot prefund at all: `init_pool` now sets it to `false`
    /// and only `update_params` (admin-signed) can turn it on. See the header
    /// comment on `handler` for why it must stay off until `settle` works.
    #[account(
        mut,
        seeds = [LiquidityPool::SEED_PREFIX],
        bump = pool.bump,
        constraint = pool.is_active @ LiquidityError::PoolInactive
    )]
    pub pool: Account<'info, LiquidityPool>,

    /// STARK proof buffer (owned by p01_stark_verifier, circuit 1).
    /// CHECK: validated in handler — owner, disc, circuit, authority, verified, hash.
    pub stark_proof_buffer: AccountInfo<'info>,

    /// Denominated pool the note belongs to. Its `denomination` is what this
    /// instruction pays out, and its key is a `PrefundRecord` PDA seed, so it
    /// is NOT an opaque identifier — see `parse_denominated_pool`.
    /// CHECK: validated in handler — owner is zk_shielded, discriminator is
    /// DenominatedPool or DenominatedPoolV3, denomination is non-zero, and
    /// `authority` equals this program's admin.
    pub denominated_pool: AccountInfo<'info>,

    /// Anti-replay. `init` failing on a second use is the ONLY thing that stops
    /// one proof buffer opening many prefunds, so the seeds must cover exactly
    /// the bytes the proof commits to and nothing else.
    ///
    /// The seed is `nullifier[..8]`, not the whole 32 bytes. The circuit-1
    /// public-inputs hash is `sha256(u64::from_le_bytes(nullifier[..8]) ||
    /// stark_commitment)` — see `handler` — so bytes 8..32 are constrained by
    /// nothing at all. Keying on all 32 gave a single verified buffer 2^192
    /// distinct anti-replay PDAs: same proof, same proven prefix, bump one
    /// unproven tail byte, get paid again. Measured under litesvm before this
    /// changed: four accepted prefunds against one real pool from one buffer
    /// (`tests/deep_ali_gate.rs`,
    /// `prefund_cannot_be_replayed_by_varying_the_unproven_nullifier_tail`).
    ///
    /// 64 bits of proven nullifier is itself thin — that is a circuit-1 public
    /// input question, not something this program can widen. What it can do is
    /// not pretend to more binding than the proof supplies.
    ///
    /// `settle` derives the same seeds from `prefund_record.nullifier[..8]`.
    #[account(
        init,
        payer = ephemeral_signer,
        space = PrefundRecord::LEN,
        seeds = [
            PrefundRecord::SEED_PREFIX,
            denominated_pool.key().as_ref(),
            &nullifier[..8]
        ],
        bump
    )]
    pub prefund_record: Account<'info, PrefundRecord>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Prefund>,
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    min_epoch: u64,
    stark_commitment: u64,
    amount: u64,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    // -----------------------------------------------------------------------
    // Bind the payout: which pool, and how much.
    //
    // `amount` is caller-supplied and the circuit-1 proof does not cover it —
    // the only thing the proof binds is sha256(nullifier_u64 ||
    // stark_commitment). Left free, one honest proof authorises any payout the
    // reserve can cover.
    //
    // `amount == denominated_pool.denomination` on its own is NOT a bound.
    // `zk_shielded::init_denominated_pool` (`zk_shielded/src/lib.rs:131`) and
    // `init_denominated_pool_v3` (`:186`) are permissionless: `authority` is a
    // bare `Signer` with no admin check, `token_mint` is an unvalidated
    // `Pubkey` INSTRUCTION ARGUMENT, and `denomination` is a free `u64` gated
    // only by `require!(denomination > 0)`. The PDA seeds are
    // `[b"denominated_pool", token_mint, denomination.to_le_bytes()]`, so any
    // (arbitrary 32 bytes, arbitrary denomination) pair is a fresh
    // uninitialised PDA anyone can create for rent. The result is owned by
    // zk_shielded and carries the genuine discriminator, so it satisfies every
    // check in `parse_denominated_pool` — and its `denomination` is a number
    // the ATTACKER chose. Measured under litesvm against the previous revision
    // of this handler: one prefund against a self-minted 10-SOL pool moved
    // 9,890,000,000 lamports out of a 10-SOL reserve.
    //
    // What the attacker cannot forge is `DenominatedPool::authority`.
    // zk_shielded assigns it from a `Signer` at init and the account is
    // zk_shielded-owned thereafter, so it names a keypair the creator actually
    // controls. Requiring it to equal this pool's `admin` is therefore an
    // allowlist with no extra state: the supported set is exactly the pools our
    // own admin created. A pool minted by anyone else is refused before any
    // lamport moves, whatever `denomination` it declares.
    //
    // With the pool pinned, `amount == denomination` becomes meaningful: the
    // payout is the note's value as fixed by our admin at pool creation, which
    // is the only value the settle side was ever written to return (the CPI
    // target takes `let amount = pool.denomination;`).
    //
    // SEPARATE, LARGER PROBLEM, stated here because it decides whether a
    // prefund is recoverable at all: that CPI target no longer exists.
    // `zk_shielded::unshield_denominated_stark` is commented out wholesale —
    // handler, Accounts struct and its `#[program]` registration
    // (`zk_shielded/src/lib.rs:152-172`) — in favour of
    // `unshield_denominated_stark_v3`. `settle.rs:117` still builds
    // `sha256("global:unshield_denominated_stark")[..8]`, which zk_shielded
    // will not dispatch. So every prefund this instruction opens is currently
    // unsettleable and the payout is a permanent loss to the reserve, valid
    // proof or not.
    //
    // That is why `init_pool` now creates the pool with `is_active = false` and
    // the `Prefund` accounts struct requires `is_active`. Prefund is off unless
    // an admin explicitly signs `update_params(is_active = Some(true))`. It
    // must stay off until a v3 settle path exists. This is a control, not a
    // comment: `prefund_is_unreachable_on_a_pool_as_init_pool_creates_it` in
    // `tests/deep_ali_gate.rs` runs `init_pool` and then a full prefund against
    // real SBF bytecode and requires the reject.
    //
    // The `amount` argument is kept rather than dropped so the instruction data
    // layout is unchanged. Honest clients already pass the denomination:
    //   apps/mobile/services/liquidity/index.ts (`PrefundArgs.amount`)
    //     `/** Denomination lamports of the note being prefunded. */`
    // `LiquidityError::AmountMismatch` ("Prefund amount does not match pool
    // denomination") was defined at errors.rs:34 and never wired up; this is
    // the check it was written for.
    //
    // RESIDUAL, stated precisely because the previous revision of this comment
    // got it wrong: one buffer opens at most one prefund per
    // (denominated_pool, nullifier[..8]) pair, because that is the
    // `PrefundRecord` PDA and `init` fails the second time. The proof binds no
    // pool identity, so an attacker holding one valid proof can still open one
    // prefund per ADMIN-SUPPORTED pool — bounded by the number of pools our
    // admin created, each paying that pool's own denomination. Closing that
    // needs the denominated_pool key inside circuit 1's public inputs, which is
    // a circuit change and out of scope here.
    // -----------------------------------------------------------------------
    let denominated_pool_view = {
        let dp = &ctx.accounts.denominated_pool;
        let dp_data = dp.try_borrow_data()?;
        parse_denominated_pool(dp.owner, &dp_data)?
    };
    require!(
        denominated_pool_view.authority == pool.admin,
        LiquidityError::UnsupportedDenominatedPool
    );
    require!(
        amount == denominated_pool_view.denomination,
        LiquidityError::AmountMismatch
    );

    // -----------------------------------------------------------------------
    // Validate the STARK proof buffer.
    // -----------------------------------------------------------------------
    let proof_info = &ctx.accounts.stark_proof_buffer;
    require!(
        *proof_info.owner == STARK_VERIFIER_PROGRAM_ID,
        LiquidityError::InvalidProofOwner
    );
    let data = proof_info.try_borrow_data()?;
    let (authority, circuit_id, verified, stored_hash, deep_ali_verified) =
        parse_proof_buffer(&data)?;
    require!(verified, LiquidityError::ProofNotVerified);
    // Phase 2 (`verify_deep_ali_phase2`) is mandatory for circuits 1-6.
    //
    // Phase 1 is not an AIR check: `verify_quotient_at_query` enforces nothing
    // since 2026-07-27, and boundary constraints — the only place public inputs
    // meet the trace in phase 1 — fire only on a query that is both
    // trace-aligned and on an assertion row. A `verified`-only buffer therefore
    // does not bind the declared (nullifier, commitment) to anything, and this
    // handler pays real lamports out of the reserve. Same require! as the
    // canonical consumer, `zk_shielded/src/instructions/unshield_stark.rs:196`.
    //
    // This closes the "phase 1 was never an AIR check" hole. It does NOT make
    // the proof sound — DEEP-ALI is still bound to prover-chosen OOD values
    // (B1). The gate is necessary, not sufficient.
    require!(deep_ali_verified, LiquidityError::ProofNotVerified);
    require!(circuit_id == CIRCUIT_POOL_COMMITMENT, LiquidityError::WrongCircuit);
    require!(
        authority == ctx.accounts.ephemeral_signer.key(),
        LiquidityError::AuthorityMismatch
    );

    // Reconstruct the sha256(nullifier_u64 || commitment_u64) the verifier stored
    // when verify_stark_proof_v2 ran. Same pattern as
    // zk_shielded::unshield_denominated_stark, so this record is admissible at settle time.
    {
        let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
        let mut pub_buf = [0u8; 16];
        pub_buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
        pub_buf[8..].copy_from_slice(&stark_commitment.to_le_bytes());
        let expected = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
        require!(stored_hash == expected, LiquidityError::InputsHashMismatch);
    }
    drop(data);

    // -----------------------------------------------------------------------
    // Fee math (all in bps of `amount`).
    // -----------------------------------------------------------------------
    let prefund_fee = (amount as u128)
        .checked_mul(pool.prefund_fee_bps as u128)
        .ok_or(LiquidityError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(LiquidityError::ArithmeticOverflow)? as u64;

    let settler_reward = (amount as u128)
        .checked_mul(pool.settler_reward_bps as u128)
        .ok_or(LiquidityError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(LiquidityError::ArithmeticOverflow)? as u64;

    let recipient_amount = amount
        .checked_sub(prefund_fee)
        .and_then(|v| v.checked_sub(settler_reward))
        .ok_or(LiquidityError::ArithmeticOverflow)?;

    require!(
        pool.reserve_lamports >= recipient_amount,
        LiquidityError::InsufficientLiquidity
    );

    // -----------------------------------------------------------------------
    // Pay the recipient directly from the pool PDA's lamports.
    // -----------------------------------------------------------------------
    **pool.to_account_info().try_borrow_mut_lamports()? = pool
        .to_account_info()
        .lamports()
        .checked_sub(recipient_amount)
        .ok_or(LiquidityError::InsufficientLiquidity)?;
    **ctx.accounts.recipient.to_account_info().try_borrow_mut_lamports()? = ctx
        .accounts
        .recipient
        .to_account_info()
        .lamports()
        .checked_add(recipient_amount)
        .ok_or(LiquidityError::ArithmeticOverflow)?;

    pool.reserve_lamports = pool
        .reserve_lamports
        .checked_sub(recipient_amount)
        .ok_or(LiquidityError::ArithmeticOverflow)?;

    // -----------------------------------------------------------------------
    // Record the prefund so settle() can reconcile later.
    // -----------------------------------------------------------------------
    let record = &mut ctx.accounts.prefund_record;
    record.pool = pool.key();
    record.denominated_pool = ctx.accounts.denominated_pool.key();
    record.nullifier = nullifier;
    record.merkle_root = merkle_root;
    record.public_inputs_hash = stored_hash;
    record.stark_commitment = stark_commitment;
    record.amount = amount;
    record.min_epoch = min_epoch;
    record.proof_buffer = proof_info.key();
    record.ephemeral_signer = authority;
    record.settler_reward = settler_reward;
    record.opened_at_slot = Clock::get()?.slot;
    record.bump = ctx.bumps.prefund_record;

    emit!(PrefundOpenedEvent {
        pool: pool.key(),
        denominated_pool: record.denominated_pool,
        nullifier,
        amount,
        prefund_fee,
        settler_reward,
        recipient: ctx.accounts.recipient.key(),
        recipient_amount,
        opened_at_slot: record.opened_at_slot,
    });

    Ok(())
}

#[event]
pub struct PrefundOpenedEvent {
    pub pool: Pubkey,
    pub denominated_pool: Pubkey,
    pub nullifier: [u8; 32],
    pub amount: u64,
    pub prefund_fee: u64,
    pub settler_reward: u64,
    pub recipient: Pubkey,
    pub recipient_amount: u64,
    pub opened_at_slot: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These pin the BYTE LAYOUT the gate reads. They do NOT prove the
    /// `require!(deep_ali_verified, ..)` in `handler` is still there — that
    /// needs a real instruction against real bytecode and lives in
    /// `tests/deep_ali_gate.rs` (litesvm). Both exist because this one runs in
    /// plain `cargo test` with no Solana toolchain, and that one is the actual
    /// accept/reject gate.
    fn buffer(verified: bool, deep_ali_verified: bool) -> Vec<u8> {
        let mut d = vec![0u8; PROOF_BUF_MIN_LEN];
        d[..8].copy_from_slice(&STARK_PROOF_BUFFER_DISCRIMINATOR);
        d[PROOF_BUF_AUTHORITY..PROOF_BUF_CIRCUIT_ID].copy_from_slice(&[7u8; 32]);
        d[PROOF_BUF_CIRCUIT_ID] = CIRCUIT_POOL_COMMITMENT;
        d[PROOF_BUF_VERIFIED] = u8::from(verified);
        d[PROOF_BUF_INPUTS_HASH..PROOF_BUF_DEEP_ALI_VERIFIED].copy_from_slice(&[0xABu8; 32]);
        d[PROOF_BUF_DEEP_ALI_VERIFIED] = u8::from(deep_ali_verified);
        d
    }

    #[test]
    fn min_len_covers_the_deep_ali_flag() {
        // 82 would put the flag outside the slice the parser reads at all.
        assert_eq!(PROOF_BUF_MIN_LEN, PROOF_BUF_DEEP_ALI_VERIFIED + 1);
        assert!(parse_proof_buffer(&buffer(true, true)[..82]).is_err());
    }

    #[test]
    fn parses_the_deep_ali_flag_from_byte_82() {
        let (_, _, verified, _, deep_ali) = parse_proof_buffer(&buffer(true, false)).unwrap();
        assert!(verified, "phase-1 flag");
        assert!(!deep_ali, "phase-2 flag must read byte 82, not be assumed");

        let (_, _, _, _, deep_ali) = parse_proof_buffer(&buffer(true, true)).unwrap();
        assert!(deep_ali);
    }

    #[test]
    fn inputs_hash_stops_before_the_flag() {
        // If the hash slice ran to 83 it would swallow the flag byte and the
        // hash comparison would start depending on phase-2 state.
        let (_, _, _, h0, _) = parse_proof_buffer(&buffer(true, false)).unwrap();
        let (_, _, _, h1, _) = parse_proof_buffer(&buffer(true, true)).unwrap();
        assert_eq!(h0, h1);
        assert_eq!(h0, [0xABu8; 32]);
    }

    // -----------------------------------------------------------------------
    // denominated_pool parsing — layout pins for the amount binding
    // -----------------------------------------------------------------------

    fn anchor_account_disc(name: &str) -> [u8; 8] {
        let h = solana_sha256_hasher::hashv(&[format!("account:{}", name).as_bytes()]).to_bytes();
        let mut out = [0u8; 8];
        out.copy_from_slice(&h[..8]);
        out
    }

    fn pool_account_with_authority(
        disc: [u8; 8],
        authority: Pubkey,
        denomination: u64,
    ) -> Vec<u8> {
        let mut d = vec![0u8; DENOM_POOL_MIN_LEN];
        d[..8].copy_from_slice(&disc);
        d[DENOM_POOL_AUTHORITY..DENOM_POOL_TOKEN_MINT].copy_from_slice(authority.as_ref());
        // 40..72 token_mint — not read here.
        d[DENOM_POOL_DENOMINATION..DENOM_POOL_MIN_LEN]
            .copy_from_slice(&denomination.to_le_bytes());
        d
    }

    fn pool_account(disc: [u8; 8], denomination: u64) -> Vec<u8> {
        pool_account_with_authority(disc, Pubkey::new_from_array([5u8; 32]), denomination)
    }

    /// The two discriminators are hardcoded so this program does not have to
    /// depend on the zk_shielded crate. Recompute them from the same strings
    /// Anchor uses, so a typo cannot survive.
    #[test]
    fn denominated_pool_discriminators_are_the_anchor_ones() {
        assert_eq!(
            DENOMINATED_POOL_DISCRIMINATOR,
            anchor_account_disc("DenominatedPool")
        );
        assert_eq!(
            DENOMINATED_POOL_V3_DISCRIMINATOR,
            anchor_account_disc("DenominatedPoolV3")
        );
    }

    /// `authority` is the first field and `denomination` sits after
    /// `authority: Pubkey` and `token_mint: Pubkey` in both structs. If either
    /// grows a field before them, this fires.
    #[test]
    fn field_offsets_are_after_the_discriminator_and_two_pubkeys() {
        assert_eq!(DENOM_POOL_AUTHORITY, 8);
        assert_eq!(DENOM_POOL_TOKEN_MINT, 8 + 32);
        assert_eq!(DENOM_POOL_DENOMINATION, 8 + 32 + 32);
        assert_eq!(DENOM_POOL_MIN_LEN, DENOM_POOL_DENOMINATION + 8);
    }

    #[test]
    fn reads_authority_and_denomination_from_either_pool_version() {
        let owner = ZK_SHIELDED_PROGRAM_ID;
        let admin = Pubkey::new_from_array([42u8; 32]);
        for disc in [DENOMINATED_POOL_DISCRIMINATOR, DENOMINATED_POOL_V3_DISCRIMINATOR] {
            let v = parse_denominated_pool(
                &owner,
                &pool_account_with_authority(disc, admin, 1_000_000_000),
            )
            .unwrap();
            assert_eq!(v.denomination, 1_000_000_000);
            assert_eq!(v.authority, admin, "authority must come from bytes 8..40");
        }
    }

    /// The whole point of reading `authority`: an attacker-minted pool is a
    /// *valid* zk_shielded pool. `parse_denominated_pool` accepts it — it has
    /// the right owner, length and discriminator — and the caller must be the
    /// one to refuse it on `authority`. This test states that division of
    /// labour so nobody later "simplifies" the handler check away on the
    /// grounds that the parser already validated the account.
    #[test]
    fn an_attacker_minted_pool_parses_but_carries_the_attackers_authority() {
        let owner = ZK_SHIELDED_PROGRAM_ID;
        let admin = Pubkey::new_from_array([42u8; 32]);
        let attacker = Pubkey::new_from_array([0xEEu8; 32]);
        let v = parse_denominated_pool(
            &owner,
            &pool_account_with_authority(
                DENOMINATED_POOL_DISCRIMINATOR,
                attacker,
                9_999_000_000_000,
            ),
        )
        .expect("a permissionlessly-minted pool is structurally valid");
        assert_eq!(v.denomination, 9_999_000_000_000);
        assert_ne!(v.authority, admin);
    }

    #[test]
    fn rejects_pools_that_are_not_zk_shielded_pools() {
        let owner = ZK_SHIELDED_PROGRAM_ID;
        let good = pool_account(DENOMINATED_POOL_DISCRIMINATOR, 1_000_000_000);

        // Wrong owner — an account fabricated by a program the attacker
        // controls, carrying a well-formed pool image.
        assert!(parse_denominated_pool(&Pubkey::new_from_array([3u8; 32]), &good).is_err());
        // Right owner, wrong account type.
        assert!(parse_denominated_pool(&owner, &pool_account([9u8; 8], 1)).is_err());
        // Too short to carry a denomination.
        assert!(parse_denominated_pool(&owner, &good[..DENOM_POOL_MIN_LEN - 1]).is_err());
        // Zero denomination would make a payout of 0 pass `amount == denom`
        // for a caller who also passes 0 — harmless, but it is not a real pool.
        assert!(parse_denominated_pool(&owner, &pool_account(DENOMINATED_POOL_DISCRIMINATOR, 0)).is_err());
    }
}
