# Refund Pipeline Sprint — Shared Interface Contract

> **SUPERSEDED — 2026-08-01. This document describes a feature that no longer exists.**
>
> The founder removed cancellation and refunds from the subscription entirely. A vault is a
> one-way prepaid envelope: money that enters can only leave toward the retailer.
> `zk_shielded::cancel_normal` and `zk_shielded::cancel_private_stark` are DELETED, and
> `subscribe_private_stark` no longer takes or writes `client_stealth_meta`, so the field this
> whole pipeline branched on is permanently `None`. `claim_period` is now the only instruction
> that can close a `SubscriptionVault`, and it pays the residual and the rent to the retailer.
>
> Nothing below is implementable and nothing below should be quoted as shipped or planned.
> Sections A, D and E in particular describe on-chain code that has been removed.
> `p01_relayer::submit_refund_job` still exists but is ORPHANED: it had exactly one caller and
> that caller is gone. It and the `RefundJob` account are kept only so `process_refund_job` /
> `expire_refund_job` can still drain any RefundJob PDA already live on devnet.
>
> Kept as the historical record of what was built and why it was undone.

**Date:** 2026-05-11
**Goal:** Cancel a private subscription → residual routed to p01_relayer RefundJob → keeper shields into pool with stealth-encrypted commitment → subscriber sees note via existing stealth scanner.

**Backward compat:** Old V4 vaults without `client_stealth_meta` use the legacy reshield path. New vaults route via RefundJob.

---

## A. SubscriptionVault state addition (zk_shielded)

**File:** `programs/zk_shielded/src/state/subscription_vault.rs`

Append at the **end** of the struct, after `bump`:

```rust
/// Stealth meta address (v1) for refund delivery. `[spending_pub(32) | viewing_pub(32)]`.
/// None for legacy vaults (reshield via cancel_private_stark legacy path).
pub client_stealth_meta: Option<[u8; 64]>,
```

LEN: `+ 65` (1 tag + 64 value) → 308 + 65 = 373

Backward compat: old vaults have trailing zero padding → decodes as `None`.

---

## B. subscribe_private_stark — new arg

**File:** `programs/zk_shielded/src/instructions/subscribe_private_stark.rs`

Append handler arg:
```rust
client_stealth_meta: Option<[u8; 64]>,
```

Persist: `vault.client_stealth_meta = client_stealth_meta;`

Emit in `SubscribePrivateStarkEvent`: `has_stealth_meta: bool` (don't leak the bytes).

---

## C. RefundJob state (p01_relayer)

**File:** `programs/p01_relayer/src/state/refund_job.rs` (new)

```rust
use anchor_lang::prelude::*;

#[account]
pub struct RefundJob {
    pub source_vault: Pubkey,           // vault that was cancelled; also the PDA seed
    pub stealth_meta: [u8; 64],         // spending_pub(32) | viewing_pub(32)
    pub target_pool: Pubkey,
    pub target_tree: Pubkey,
    pub amount: u64,                    // residual transferred in (full, before keeper fee deduction)
    pub keeper_fee_lamports: u64,       // pays the relayer that processes the job
    pub created_at_slot: u64,
    pub deadline_slot: u64,
    pub status: u8,                     // 0=Pending 1=Completed 2=Expired
    pub bump: u8,
}

impl RefundJob {
    pub const SEED_PREFIX: &'static [u8] = b"refund_job";
    pub const LEN: usize = 8 + 32 + 64 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1; // 202
    pub const STATUS_PENDING: u8 = 0;
    pub const STATUS_COMPLETED: u8 = 1;
    pub const STATUS_EXPIRED: u8 = 2;
}
```

**PDA seed:** `[b"refund_job", source_vault.as_ref()]` — exactly one RefundJob per cancelled vault.

**Constants** (in `p01_relayer/src/constants.rs` or similar):
```rust
pub const REFUND_KEEPER_FEE: u64 = 50_000;        // 0.00005 SOL keeper incentive
pub const REFUND_MIN_RESIDUAL: u64 = 100_000;     // below this, no refund (covers fees only)
pub const REFUND_DEADLINE_SLOTS: u64 = 432_000;   // ~1 day at 200ms/slot
```

---

## D. p01_relayer instructions

### D.1 `submit_refund_job`

CPI'd by zk_shielded `cancel_private_stark`. Signer: the cancel payer.

**Args:**
```rust
amount: u64,           // total residual transferred (already at PDA)
stealth_meta: [u8; 64],
target_pool: Pubkey,
target_tree: Pubkey,
```

**Accounts:**
```rust
#[derive(Accounts)]
pub struct SubmitRefundJob<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,           // cancel payer (subscriber)

    /// CHECK: validated by zk_shielded handler caller
    pub source_vault: AccountInfo<'info>,

    #[account(
        init,
        payer = payer,
        space = RefundJob::LEN,
        seeds = [RefundJob::SEED_PREFIX, source_vault.key().as_ref()],
        bump
    )]
    pub refund_job: Account<'info, RefundJob>,

    pub system_program: Program<'info, System>,
}
```

Handler initializes RefundJob with status=Pending, deadline=clock.slot + REFUND_DEADLINE_SLOTS. Caller is responsible for transferring the `amount` to refund_job PDA separately (via cancel ix moving lamports from vault → refund_job).

### D.2 `process_refund_job`

Called by keeper (any signer holding a registered RelayerNode w/ sufficient reputation, OR — for MVP — any signer).

**Args:**
```rust
commitment: [u8; 32],
new_root: [u8; 32],
ephemeral_pub: [u8; 32],   // for client scan
view_tag: u8,
ciphertext: Vec<u8>,       // up to 256B for v1 stealth (encrypted note payload)
```

**Accounts:** refund_job (mut), denominated_pool (mut), merkle_tree (mut), keeper (signer + mut for fee receipt), zk_shielded program (CPI), system program.

Handler:
1. Require status==Pending, slot <= deadline_slot
2. CPI to `zk_shielded::shield_denominated` with provided commitment + new_root, source = refund_job PDA
3. Transfer `keeper_fee_lamports` from refund_job → keeper
4. Mark status=Completed, emit `RefundProcessed` event with announcement payload

### D.3 `expire_refund_job`

Anyone can call after deadline. Marks status=Expired, returns lamports to a treasury (or burns).

For MVP: lamports go to refund_job's rent recipient = original payer.

---

## E. cancel_private_stark refactor (zk_shielded)

**File:** `programs/zk_shielded/src/instructions/cancel_private_stark.rs`

```rust
let residual = vault.refundable_amount(slot);

match vault.client_stealth_meta {
    Some(stealth_meta) if residual >= REFUND_MIN_RESIDUAL => {
        // NEW PATH: route to RefundJob
        // 1. CPI to p01_relayer::submit_refund_job (init the PDA)
        // 2. Transfer `residual` lamports vault PDA → refund_job PDA
        // 3. Don't reshield, don't touch merkle tree
    }
    Some(_) | None => {
        // LEGACY PATH (kept for V4 vaults OR small dust):
        //   if Some but residual < threshold → forfeit dust, close vault
        //   if None → existing reshield-into-pool logic with new_commitments/new_roots
    }
}
// Close vault as today.
```

The `new_commitments` and `new_root` args become **optional** — only required for legacy path. Pass empty arrays for new path.

The `denominated_pool` and `merkle_tree` accounts become optional in the new path. Use `Option<Account<...>>` or make them no-op in handler when stealth_meta path is taken.

**Easier impl:** two distinct ix variants (`cancel_private_stark_v1_legacy` and `cancel_private_stark_v2_refund`) — caller picks based on `vault.client_stealth_meta`. Cleaner but bigger client refactor.

Recommendation: keep ONE ix, make legacy accounts optional, branch in handler.

---

## F. Mobile contract

- `subscribe.tsx` reads stealth meta from walletStore/specter (v1: spending+viewing pubkeys), passes 64 bytes to `subscribePrivateStark` builder.
- `subscriptionVault/index.ts::subscribePrivateStark` adds `clientStealthMeta?: Uint8Array` (length 64) to args, encodes into ix data.
- `fetchVault` decodes new `client_stealth_meta` field at end of struct (after bump). Returns `Buffer | null`. Use variable-length Borsh.
- `[id].tsx` cancel preview:
  - If `vault.client_stealth_meta != null` AND `residual >= REFUND_MIN_RESIDUAL`: show "X SOL refunded privately as note in pool Y, ~Z slots delay"
  - If `vault.client_stealth_meta != null` AND `residual < REFUND_MIN_RESIDUAL`: show "Residual too low (covers fees only), no refund"
  - If `vault.client_stealth_meta == null` (legacy): keep current preview logic
- `cancelPrivateStark` builder: detect new vs legacy path, build appropriate ix. New path requires `refund_job` PDA derivation: `findProgramAddress([b"refund_job", vaultPDA.toBuffer()], P01_RELAYER_PROGRAM_ID)`.

---

## G. Keeper (Railway, services/relayer)

For each new RefundJob PDA in status=Pending:
1. Parse: stealth_meta (split into spending_pub + viewing_pub), target_pool, target_tree, amount
2. Generate ephemeral keypair (X25519)
3. Derive one-time stealth address: `H(ECDH(ephemeral_priv, viewing_pub)) * G + spending_pub`
4. Compute view_tag (first byte of shared secret hash)
5. Compute commitment for the note. **Critical detail TBD:** what's the commitment formula for our denominated_pool shield? Most likely Poseidon(stealth_address_x_coord, denom, nullifier_secret) or similar. Read packages/specter-sdk for existing commitment derivation. If our pool's shield commitment formula requires a ZK proof, we have a problem — the keeper can't generate proofs cheaply.
6. Replay current Merkle tree state to compute new_root after inserting commitment (use existing replayMerkleProofFromEvents logic in apps/mobile/services/sync — adapt for keeper).
7. Encrypt note payload for recipient: ciphertext = encrypt with shared_secret, payload = {amount, commitment_secret, leaf_index_placeholder}
8. Build process_refund_job tx with (commitment, new_root, ephemeral_pub, view_tag, ciphertext)
9. Submit & confirm

If commitment requires a proof: defer to a follow-up sprint and have keeper just collect RefundJobs without processing (MVP).

---

## Critical questions to resolve BEFORE coding

1. **What's the commitment formula for shield_denominated?** Read `programs/zk_shielded/src/instructions/shield_denominated.rs` — does it just take the commitment as opaque [u8;32] without verifying its derivation? If yes, keeper can compute it freely. If on-chain verifies a proof, keeper needs a prover.
2. **Does `merkle_tree.insert_with_root` require the caller to compute the root correctly?** Yes — the new_root is provided by caller; on-chain only inserts and verifies the chain. So keeper must replay tree state to compute new_root. Use the existing `replayMerkleProofFromEvents` pattern from mobile.

## Order of execution

1. Agent A (zk_shielded) — state + subscribe + cancel
2. Agent B (p01_relayer) — RefundJob + 3 ix
3. Agent C (Mobile) — subscribe wiring + cancel preview + decoder
4. Agent D (Keeper) — Railway worker
5. Coordinator (me) — deploy programs, regenerate IDLs, rebuild APK, E2E

A and B can run in parallel. C depends on A+B IDL. D depends on B IDL.
