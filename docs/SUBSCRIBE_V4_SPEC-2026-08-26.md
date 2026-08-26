# subscribe_private_stark_v4 — implementation spec

> Produced 2026-08-26 by a design pass that mapped v3 against the deployed v4 withdrawal,
> then had three adversaries attack the result. **All three found an attack.** Their findings
> are folded into the constraints below — in particular the binding is a DOMAIN-TAGGED
> COMPOSITE and not the vault PDA alone, because binding the destination without the
> schedule lets whoever holds the proof buffer set rate = denomination and hand the
> retailer the whole note on the first claim.

> ⛔ This is a spec, not a record of something that shipped. Nothing here is deployed.

---

# `subscribe_private_stark_v4` — implementation spec

**File:** `programs/zk_shielded/src/instructions/subscribe_private_stark_v4.rs` (new)
**Registered alongside** `subscribe_private_stark`, never replacing it — same way `unshield_denominated_stark_v4` sits beside v3 (`programs/zk_shielded/src/lib.rs:372`, `:411`).

Everything below was read out of the tree. Where I write MEASURED I read it; where I write ASSUMED you must measure it before the redeploy.

---

## 0. The premise, verified

All three load-bearing claims in the brief hold. Two need correcting.

**C7 publishes no commitment — CONFIRMED, twice, from independent sides.** The AIR declares `SpendPublicInputs { nullifier, root, recipient_hash: [4] }` (`stark/src/air/spend.rs:443-455`) and its comment "`recipient_hash` … occupies no trace column and no constraint: the binding is Fiat-Shamir-transcript-only". Independently, on the **deployed** side, `programs/p01_stark_verifier/src/verify.rs:857` pins arity at 6 with no `depth` slot, and arm 7 (`verify.rs:1084-1113`) builds its six boundary assertions from `public_inputs[0]` and `[1]` **only** — `[2..6]` are read by nothing. So redefining what those 32 bytes mean costs **zero circuit change, zero blob change, zero verifier change**. The wasm entry takes them as a free 4-limb CSV with only an arity check (`stark/src/lib.rs:421-427`).

**The depth-12/15 gap is real — CONFIRMED.** `CANONICAL_DEPTH = 12` (`stark/src/air/spend.rs:322`) vs `DEFAULT_TREE_DEPTH = 15` (`programs/zk_shielded/src/state/pool_v3.rs:182`). The deployed verifier itself shouts it at `verify.rs:1091-1098`: "Without that leg C7 is a fund-loss circuit, in the class `unshield` C5 was in before 2026-08-18."

**`subscriber_commitment != stark_commitment` — CONFIRMED, and the gap is wider than the brief says.** The vault seed is the circuit-0 commitment `Poseidon(secret)` (`stark/src/lib.rs:135-141`, called from `apps/web/lib/privacy/worker/poolHandlers.ts:2443-2447`). The note leaf is `poseidon(nullifier, poseidon(blinding, token_mint))` where `nullifier = poseidon(np, secret)` (`stark/src/air/spend.rs:918-937`; client twin `apps/web/lib/privacy/pool/poolNotes.ts:38-40`). Different function, and the leaf additionally needs `np` and `blinding`, two HKDF branches `Poseidon(secret)` does not contain. MEASURED, not argued: all 35 leaves of the 1 SOL pool run through the vault derivation reproduced **zero** live vaults (`programs/zk_shielded/src/state/subscription_vault.rs:196-206`). So dropping `stark_commitment` costs the vault derivation nothing.

**CORRECTION 1 — v4 unshield is not a superset.** Subscribe inits **two** PDAs, writes 18 vault fields, and has three live downstream readers (`claim_period.rs:63-75`, `pause_private_stark.rs:47-60`, `resume_private_stark.rs`) that re-derive the vault PDA from stored fields with `bump = vault.bump`. v4 unshield inits one PDA and has no downstream reader at all.

**CORRECTION 2 — and this is the one that changes the design.** In v4 unshield the destination *is* the whole economic statement, so binding one pubkey binds everything. In a subscribe the destination is half: `rate` and `interval_slots` decide how fast the retailer empties the vault, and **nothing in v3 or in any v4 pattern binds them**. Verified in the vault arithmetic: `funded_periods() = total_deposited / rate` (`subscription_vault.rs:288-294`), and on `is_final` `settle` pays `unpaid_amount()` — the entire residual — after which `claim_period` closes the account and sweeps rent to the retailer (`claim_period.rs:194-203`). `claim_period` is **permissionless** (`claim_period.rs:47-60`, `retailer` is `UncheckedAccount`, not a signer). So a relayer who holds the C7 buffer and sets `rate = denomination, interval_slots = 1` hands the retailer the subscriber's entire prepaid envelope one slot after subscribe, with no recovery: cancellation and refunds were deliberately removed (`subscription_vault.rs:5-11`, `claim_period.rs:25-26`). Bind the schedule.

---

## 1. Instruction signature

```rust
pub fn subscribe_private_stark_v4(
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
) -> Result<()>
```

The first five arguments are **byte-identical in order and type** to `unshield_denominated_stark_v4` (`lib.rs:411-418`). `subscriber_commitment` occupies the slot `recipient` occupies there. That parallel is deliberate: the two files must be readable side by side.

### Dropped from v3, with reasons

**`stark_commitment: u64` (v3 arg #8, wire byte 160 — `subscribe_private_stark.rs:72`, `apps/web/lib/privacy/pool/subscribePrivateStark.ts:146`).** This is the entire point. In v3 it is the only thing tying C1's leaf to C3's root, and publishing it names the deposit that funded the spend. C7 proves both halves in one trace. Precedent: v4 unshield removed it and **pins the removal with a source scan**, `the_note_commitment_is_never_an_argument_of_this_instruction` (`unshield_denominated_stark_v4.rs:690-701`). Copy that test; it is the only thing that keeps the property.

**`min_epoch: u64` (v3 arg #3, wire byte 72 — `subscribe_private_stark.rs:67`).** v4 unshield removed the parameter outright rather than ignoring it (`lib.rs:411-418` carries none). The client-side reason is already written down: `SUBSCRIBE_MIN_EPOCH = 0n` on every shipped surface (`apps/web/lib/privacy/pool/subscribePrivateStark.ts:71`), because since commitment blinding shipped the `deposit_epoch` slot carries a **63-bit PRF secret**, so passing the real value would publish the blinding in the clear, *and* a blinded note could never satisfy `current_epoch >= blinding + delay` — it would be permanently un-subscribable with `EpochDelayNotMet` (`subscribePrivateStark.ts:50-70`, MEASURED 2026-08-12). Removing the parameter and its `checked_add` / `EpochDelayNotMet` require costs nothing real. ⛔ Removing an *ignored* parameter is not optional cosmetics: ignored bytes are still on the wire, which is the exact reasoning `lib.rs:472-478` gives for deleting `client_stealth_meta`.

### Added, all copied from v4 unshield

`subtree_root: u64`, `siblings: Vec<u64>`, `directions: Vec<u8>` — C7's public input 1 is a **depth-12 subtree root**, so the handler must walk the remaining `tree_depth - 12` levels itself (`state/spend_root.rs:88-125`).

### Kept unchanged

`nullifier`, `merkle_root`, `subscriber_commitment`, `rate`, `interval_slots`, `vk_hash_subscriber`, `license_commitment` — all as in v3 (`subscribe_private_stark.rs:65-73`).

### Wire layout, tree_depth 15 (s = 3)

| offset | field | width |
|---|---|---|
| 0 | discriminator | 8 |
| 8 | nullifier | 32 |
| 40 | merkle_root | 32 |
| 72 | subtree_root | 8 |
| 80 | siblings_len | 4 |
| 84 | siblings | 24 |
| 108 | directions_len | 4 |
| 112 | directions | 3 |
| 115 | subscriber_commitment | 32 |
| 147 | rate | 8 |
| 155 | interval_slots | 8 |
| 163 | vk_hash_subscriber | 32 |
| 195 | license tag | 1 |
| 196 | license value | 32 if `Some` |

**totalLen ∈ {196, 228}.** ⛔ These numbers are only right for `s = 3`. `tree_depth` is per-pool; a depth-16 pool shifts everything after byte 80 by 9 bytes. That is exactly the warning already written for v4 at `verify/p01-verify.mjs:283-288`. Do not hardcode 115 anywhere that does not also pin the length.

Three hand-rolled encoders must move together: `apps/web/lib/privacy/pool/subscribePrivateStark.ts` (has an exported, test-asserted `SUBSCRIBE_ARG_OFFSETS` at `:137-150`), `apps/extension/src/shared/services/subscriptionVault.ts`, and `apps/mobile`. Per the project memory, mobile is still on v3 for the spend path — register the new instruction **alongside** v3 so mobile keeps working untouched.

---

## 2. `#[derive(Accounts)]`

```rust
#[derive(Accounts)]
#[instruction(
    nullifier: [u8; 32],
    merkle_root: [u8; 32],
    subtree_root: u64,
    siblings: Vec<u64>,
    directions: Vec<u8>,
    subscriber_commitment: [u8; 32]
)]
pub struct SubscribePrivateStarkV4<'info> { … }
```

Declare **exactly six** — Anchor requires the prefix up to the last argument used in a constraint, and only `nullifier` (nullifier_record seeds) and `subscriber_commitment` (vault seeds) are used. Stopping at six drops `vk_hash_subscriber` out of the list, reducing the `[u8;32]`-swap surface from four to three. `merkle_root` stays in the list only because it is positionally before `subscriber_commitment`; it is **no longer used in any constraint** (see `denominated_pool`).

| # | account | declaration | what the constraint stops |
|---|---|---|---|
| 1 | `payer` | `#[account(mut)] Signer` | Nothing on its own. It is pinned to `c7_authority` in the handler; that is what makes the buffer non-transferable between keys. Copied from `unshield_denominated_stark_v4.rs:180-181`. |
| 2 | `retailer` | `AccountInfo`, **no validation** | Nothing — and that is correct. Any pubkey may be a retailer. Its identity is bound transitively: it is a vault seed, and the vault is in the C7 digest. Copied from `subscribe_private_stark.rs:80-82`. |
| 3 | `vault` | `init, payer = payer, space = SubscriptionVault::LEN, seeds = [SubscriptionVault::SEED_PREFIX, retailer.key().as_ref(), subscriber_commitment.as_ref(), denominated_pool.token_mint.as_ref()], bump` — **bare bump**, `Box`ed | `init` is the double-open guard: one commitment, one vault, forever. The bare `bump` forces the canonical address, which `claim_period.rs:71`, `pause_private_stark.rs:56` and `resume_private_stark.rs` all re-verify with `bump = vault.bump`. ⛔ **Never `bump = <arg>`** — on an `init` account anchor-syn 0.32.1 runs `find_program_address` either way (`codegen/accounts/constraints.rs:548-555`, spliced at `:1083`), so it buys zero CU while breaking three hand-rolled encoders; and a stored bump that is not the derived one bricks claim/pause/resume permanently, with `claim_period` the only closer (`claim_period.rs:25-26`). ⛔ **Never drop `init`** for `create_program_address` — ~128 valid addresses per seed set. Both measurements are at `subscribe_private_stark.rs:663-794`. `space = LEN` (361) is right **here and only here**: three vault sizes exist on devnet (263/328/361, `apps/web/lib/privacy/pool/subscriptionVaultAccount.ts:156`), which is why `claim_period.rs:206` reads its rent floor off `data_len()` instead. This instruction only ever creates 361-byte vaults. |
| 4 | `denominated_pool` | `mut, seeds = [DenominatedPoolV3::SEED_PREFIX, token_mint, denomination_le], bump = denominated_pool.bump, constraint = is_active` | Pins the pool to its own seeds so a foreign account cannot pose as it; `is_active` stops spends against a retired pool. Copied from `unshield_denominated_stark_v4.rs:188-201`. 🚨 **`constraint = is_valid_root(&merkle_root)` is GONE from here** (it is at `subscribe_private_stark.rs:109` in v3). It cannot live here: under C7 the root is *derived*, it does not exist until the Poseidon walk has run. It moves into the handler. Copy v4's loud comment (`unshield_denominated_stark_v4.rs:54-64`, `:197-199`) so a reader coming from v3 does not conclude it was deleted. |
| 5 | `merkle_tree` | `seeds = [MerkleTreeStateV3::SEED_PREFIX, denominated_pool.key()], bump = merkle_tree.bump` | In v3 subscribe this account is loaded and then **never read** (grep: only the seeds at `:119`). In v4 it is load-bearing: `pool.tree_depth == merkle_tree.depth` sizes the walk. Two fields written by different instructions with nothing else comparing them. Copied from `unshield_denominated_stark_v4.rs:203-210` + `:282-285`. |
| 6 | `nullifier_record` | `init, payer = payer, space = NullifierRecord::LEN, seeds = [NullifierRecord::SEED_PREFIX, denominated_pool.key(), nullifier.as_ref()], bump` — **bare bump** | Double-spend, by existence at one address. ⛔ **The seeds must stay byte-identical to v3 subscribe (`:128-132`) and to v4 unshield (`:216-221`)** — prefix `b"nullifier"`, `state/nullifier_set.rs:154`. That sameness is what stops one note being spent once through unshield and again through subscribe. "Disambiguating the two instructions' seeds" would be a pool drain dressed as tidiness. |
| 7 | `c7_proof_buffer` | raw `AccountInfo`, hand-validated | Replaces the `c1_proof_buffer` + `c3_proof_buffer` pair. Owner / discriminator / authority / circuit_id / verified / deep_ali / inputs_hash all checked in the handler. Copied from `unshield_denominated_stark_v4.rs:225-230`. |
| 8 | `system_program` | `Program<System>` | — |
| 9 | `token_program` | `Option<Program<Token>>` | — |
| 10 | `pool_vault` | `#[account(mut)] Option<Account<TokenAccount>>` | Validated in the handler: `mint == pool.token_mint`, `owner == pool.key()`. |
| 11 | `vault_token_account` | `#[account(mut)] Option<Account<TokenAccount>>` | 🚨 **Validated in the handler with BOTH `mint` and `owner`.** See §3 step 12. This is the one genuinely new require. |

**No `fee_escrow` account.** See §3 step 11.

### Attack → constraint map

| attack | what stops it |
|---|---|
| Self-built depth-12 subtree, invented leaf, 47 calls empty 6NUS4E5P | Handler steps 9–10: `resolve_pool_root` + `merkle_root[..8] == derived` + `pool.is_valid_root(&merkle_root)`. **Not inherited from v3 subscribe — v3 has no walk.** Guarded by `no_pool_value_reaches_the_vault_before_the_pool_root_is_resolved`. |
| Nullifier replay / double-spend across v3 and v4 | `nullifier_record` `init` at identical seeds + canonicalisation `nullifier[8..] == [0u8;24]` (step 7). |
| ~128 record addresses per nullifier | bare `bump` + `init` on `nullifier_record`; `pda_bump_guard`. |
| Relayer re-points the deposit to a vault of their choosing | C7 digest covers `vault.key()`; `init` + `seeds` pins that address to `[prefix, retailer, subscriber_commitment, token_mint]`, so retailer / commitment / mint are all bound transitively. |
| **Relayer sets `rate = denomination`, retailer sweeps the envelope in one slot** | C7 digest covers `rate` and `interval_slots`. **New. Nothing in v3 or v4 does this.** |
| **Relayer aims the SPL payout at their own ATA; note burned, vault unclaimable forever** | `require!(vault_token.owner == ctx.accounts.vault.key())`. **New. Absent from v3 subscribe (`:354-356`) and absent from the DEPLOYED v4 unshield (`:399-408`).** |
| Buffer minted for an unshield replayed on a subscribe | The domain tag `b"P01:C7:SUBSCRIBE:v1"` inside the digest preimage. Without it the separation is only that `sha256(pubkey)` is unlikely to equal `sha256(composite)` — separation by accident of address derivation, not by construction. |
| A vault stored with a non-canonical bump, bricked weeks later | bare `bump` + `vault.bump = ctx.bumps.vault`; `pda_bump_guard`. |
| Pool / mint / denomination substitution | `denominated_pool` self-seeded; `amount = pool.denomination`; mint bound transitively through the vault seed. ⚠️ The root ring is **not** pool-unique — every v3 pool publishes `ZEROS[15]` into `historical_roots` on its first insert (`state/merkle_tree_v3.rs:86`, `:105`; `pool_v3.rs:201-211`). Harmless (no leaf sits under it, and reaching it needs a Poseidon preimage of 0), but do not write "the rings are disjoint" in a comment. The true statement is "no root with a leaf under it is shared." |

---

## 3. Handler, in order

Steps marked **[V4]** are copied verbatim from `unshield_denominated_stark_v4::handler`. **[V3]** from `subscribe_private_stark::handler`. **[NEW]** has no precedent anywhere.

1. **[V3]** `require!(rate > 0, InvalidRate)`; `require!(interval_slots > 0, InvalidInterval)` (`subscribe_private_stark.rs:179-180`). Keep both — `funded_periods()` and `claimable_periods()` both guard `rate == 0` by returning 0, which would make the vault unclaimable but closable; `interval_slots == 0` divides by zero in `claimable_periods` (`subscription_vault.rs:262`).
2. **[V4]** `let clock = Clock::get()?; let pool_key = ctx.accounts.denominated_pool.key(); let pool = &mut …; let amount = pool.denomination; let is_native_sol = pool.token_mint == system_program::ID;` (`:268-272`). Take `pool_key` before the mutable borrow — v3 does (`subscribe_private_stark.rs:183`) and v4 does not need to.
3. **[V4]** `require!(pool.total_shielded >= amount, InsufficientBalance)` (`:273-276`).
4. **[V4]** `require!(pool.tree_depth == ctx.accounts.merkle_tree.depth, InvalidMerkleRoot)` (`:282-285`). ⛔ This **replaces** v3 subscribe's `require!(tree_depth == 15, InvalidProof)` (`subscribe_private_stark.rs:299-300`), which existed only for C3's depth felt and is meaningless under C7. Replace it — do not simply delete it. Deleting it and adding nothing leaves `resolve_pool_root` sizing the walk from a `pool.tree_depth` nobody cross-checked. (`resolve_pool_root` does reject `tree_depth <= 12`, `state/spend_root.rs:100-102`, but that is a floor, not an agreement.)
5. **[V4]** `let current_epoch = DenominatedPoolV3::current_epoch(clock.slot); pool.update_maturity(current_epoch); let dynamic_delay = pool.get_dynamic_delay();` (`:287-289`). The delay is **no longer enforced** — `min_epoch` is gone — but the maturity bookkeeping still runs, exactly as v4 does, with the results discarded at `:449` via `let _ = (…)`.
6. **[V4]** `nullifier_record.pool = pool.key(); nullifier_record.bump = ctx.bumps.nullifier_record;` (`:291-293`).
7. **[V4]** C7 buffer verification, all six requires in this order (`:298-322`): owner `== STARK_VERIFIER_PROGRAM_ID`; `parse_stark_proof_buffer` (len ≥ 83 + discriminator, `:120-134`); `c7_authority == ctx.accounts.payer.key()`; `c7_circuit_id == CIRCUIT_SPEND` (7); `c7_verified`; `c7_deep_ali_verified`; then `require!(nullifier[8..] == [0u8; 24], InvalidProof)`.
8. **[NEW]** Public-inputs-hash reconstruction, with the subscribe digest:
   ```rust
   let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
   let pub_buf = c7_subscribe_pub_bytes(
       nullifier_u64, subtree_root, &ctx.accounts.vault.key(),
       rate, interval_slots, &vk_hash_subscriber, &license_commitment,
   );
   let expected_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
   require!(c7_inputs_hash == expected_hash, ZkShieldedError::InvalidProof);
   drop(c7_data);
   ```
   The 48-byte layout and the LE round-trip identity are unchanged from `c7_pub_bytes` (`:136-162`); only the digest's preimage differs. See §4.
9. **[V4]** The walk (`:332-344`): `let derived = spend_root::resolve_pool_root(subtree_root, &siblings, &directions, pool.tree_depth).map_err(spend_root_error)?;` ⛔ **Import `spend_root_error`, do not copy it.** It is `pub fn` at `unshield_denominated_stark_v4.rs:110` and glob-reexported by `instructions/mod.rs:105`. A second copy makes the four caller-fault error codes drift silently.
10. **[V4]** Both root checks, both required (`:346-357`): `require!(merkle_root[..8] == derived.to_le_bytes(), SpendRootMismatch)` then `require!(pool.is_valid_root(&merkle_root), InvalidMerkleRoot)`. The first says "this is the root my proof reaches"; the second says "and it is one you published." `is_valid_root` compares all 32 bytes (`pool_v3.rs:190-196`), so the pair pins the full root. Neither alone is a membership check.
11. **[V3] No protocol fee. `amount` moves in full.** ⛔ **Do NOT copy v4's `fee::calculate_fee(amount, UNSHIELD_FEE_BPS)` block (`:362`, `:385-387`) or its `fee_escrow` account (`:241-247`).** Arithmetic: `vault.total_deposited` is what `funded_periods()` divides (`subscription_vault.rs:288-294`) and what `unpaid_amount()` subtracts from (`:302-308`). Copy the fee and write `total_deposited = amount` and the two disagree by 50 bps. On a 1 SOL denomination that is 5,000,000 lamports against a 361-byte vault rent of roughly 3,300,000 — so on the final claim `require!(vault_lamports >= value_payout)` (`claim_period.rs:196-199`) **fails**, the claim reverts, and since `claim_period` is the only closer (`:25-26`) the deposit and the rent are stranded forever. If the operator wants the fee later it is a **money decision**, and it comes with `vault.total_deposited = recipient_amount`, not `amount`. Note plainly in the header that this leaves subscribe as the only fee-free exit from a pool.
12. Payout.
    - **SOL [V3]:** rent-floor check `pool_lamports.saturating_sub(min_rent) >= amount` → `InsufficientPoolBalance`; `**pool…try_borrow_mut_lamports()? -= amount; **ctx.accounts.vault…try_borrow_mut_lamports()? += amount;` (`subscribe_private_stark.rs:332-342`). The destination is the `init`ed, digest-bound PDA. Safe today: both funded pools are native SOL.
    - **SPL [V3 + one NEW require]:** presence checks → `MissingTokenProgram` / `MissingPoolVault` / `MissingTokenAccount`; `pool_vault.mint == pool.token_mint`; `pool_vault.owner == pool.key()`; `vault_token.mint == pool.token_mint`; then
      ```rust
      require!(
          vault_token.owner == ctx.accounts.vault.key(),
          ZkShieldedError::InvalidTokenOwner
      );
      ```
      **This is the single most important new line in the file.** Without it the account the proof binds receives nothing on the SPL path, and "the proof binds the payout" is false for half the payout paths. Verified absent in v3 subscribe (`:354-356` checks three things, never `vault_token.owner`) and absent in the **deployed** `unshield_denominated_stark_v4.rs:399-408`. The far end already requires it: `claim_period.rs:94-98` constrains `vault_token_account.owner == vault.key()`, so a subscribe into a foreign-owned ATA mints a vault whose funds can never be claimed and whose rent is stranded. `InvalidTokenOwner` already exists (`errors.rs:63`) — no new variant, no renumbering (`errors.rs:163-213` is append-only and says why). Then `token::transfer` CPI signed by the pool PDA seeds, `amount` (not `recipient_amount` — there is no fee).
    - ⛔ **Ship the mirror repair in the same commit**: `unshield_denominated_stark_v4.rs` after `:407` needs `require!(recipient_token_account.owner == recipient_account.key(), InvalidTokenOwner)`. That hole is on devnet right now. Unfunded only because both live pools are SOL — it is not blocked, it is unfunded.
13. **[V4]** Pool state (`:435-444`): `total_shielded` `checked_sub` → `ArithmeticOverflow`; `note_count` `checked_sub`; `last_tx_at = clock.unix_timestamp`; `mature_note_count = saturating_sub(1)`.
14. **[V3]** All 18 vault fields, unchanged from `subscribe_private_stark.rs:382-413`: `subscriber_pubkey = None`, `subscriber_commitment = Some(subscriber_commitment)`, `retailer`, `token_mint`, `total_deposited = amount`, `rate`, `interval_slots`, `start_slot = clock.slot as i64`, `claimed_periods = 0`, `is_active = true`, `is_paused = false`, `pause_slot = None`, `total_paused_slots = 0`, `vk_hash_subscriber`, `source_pool = Some(pool_key)`, `bump = ctx.bumps.vault`, `client_stealth_meta = None`, `license_commitment`. ⛔ Not one field may be dropped, added, or reordered — 28 live vaults decode sequentially and the three decoders (`apps/web/…/subscriptionVaultAccount.ts:209-250`, `packages/merchant-sdk/src/vaults.ts:120-142`, `packages/p01-js/src/subscription-vault.ts:418-424`) are all length-guarded sequential reads. `client_stealth_meta = None` is pinned by `stealth_meta_guard`; carry that guard across.
15. **No event.** See §5. End with `let _ = (current_epoch, dynamic_delay);` — the same idiom v4 uses at `:449` for locals the removal orphaned.

---

## 4. What C7 binds, and why it does not leak

### The builder — a second, deliberately non-shared function

```rust
const C7_SUBSCRIBE_DOMAIN: &[u8] = b"P01:C7:SUBSCRIBE:v1";

fn c7_subscribe_pub_bytes(
    nullifier_u64: u64,
    subtree_root: u64,
    vault: &Pubkey,
    rate: u64,
    interval_slots: u64,
    vk_hash_subscriber: &[u8; 32],
    license_commitment: &Option<[u8; 32]>,
) -> [u8; C7_PUB_BYTES_LEN] {
    // Fixed-width license slot: tag byte + 32 bytes, zeroed when None.
    // A variable-length tail in a concatenated preimage is an ambiguity, and
    // this costs 33 bytes of hashing to remove it entirely.
    let mut lic = [0u8; 33];
    if let Some(v) = license_commitment { lic[0] = 1; lic[1..].copy_from_slice(v); }

    let digest = solana_sha256_hasher::hashv(&[
        C7_SUBSCRIBE_DOMAIN,
        vault.as_ref(),
        &rate.to_le_bytes(),
        &interval_slots.to_le_bytes(),
        vk_hash_subscriber,
        &lic,
    ]).to_bytes();

    let mut buf = [0u8; C7_PUB_BYTES_LEN]; // 48
    buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
    buf[8..16].copy_from_slice(&subtree_root.to_le_bytes());
    buf[16..48].copy_from_slice(&digest);
    buf
}
```

One extra sha256 syscall over v4. The preimage is a constant 132 bytes.

⛔ **Do NOT factor `c7_pub_bytes` and `c7_subscribe_pub_bytes` into one shared helper "for reuse."** The domain tag is the only structural separation between the two C7 consumers, and that refactor deletes it while reading as a cleanup.

### Why the vault, and not the retailer

Anchor's `init` + `seeds` forces `vault.key() == find_program_address([SEED_PREFIX, retailer, subscriber_commitment, token_mint])`, so binding the address **transitively binds all three seeds**: re-pointing the retailer, the commitment or the mint would require a PDA collision. Binding `retailer` alone leaves `subscriber_commitment` free, which hands the buffer holder pause/resume control over the merchant's income stream (`pause_private_stark.rs:80-118`) while the honest subscriber's note burns. Binding `subscriber_commitment` alone binds neither retailer nor mint. Both are strictly weaker.

### Why the schedule too

Because the vault address is only half the economic statement. Verified in `settle`/`funded_periods`/`claim_period` (§0, CORRECTION 2). The counter-argument that binding the terms "forces a fresh 3-minute proof on every terms tweak" is empty: `vault` is `init`, so `rate` and `interval_slots` are written exactly once, at a moment when the client necessarily already knows them — it must, to build the transaction it is proving for.

### Why `vk_hash_subscriber` and `license_commitment` are in there too

They are inert on chain (no instruction reads either), so the marginal security is small. But they are free — the ordering constraint they would impose is **already imposed by the vault PDA**, because `retailer` is a seed and the merchant is only chosen at execute time. So they cost nothing and close a residual where a hostile relayer burns the subscriber's license key. Including them is the cheap side of the trade.

### Why it does not leak

Every input is already published by the same transaction: the vault is a named account of the instruction and appears in `accountKeys`, and is re-published in every later `claim_period` (`claim_period.rs:63-75`) and every `pause` (`pause_private_stark.rs:48-56`); `rate`, `interval_slots`, `vk_hash_subscriber` and `license_commitment` are cleartext instruction arguments. So an observer holding the transaction can recompute the digest and `H(binding | transaction) = 0`. This is the argument the repo already made and accepted for the public bump: "Address plus seeds determines the bump, so an observer can already compute it… Passing it moves a byte, not a fact" (`subscribe_private_stark.rs:714-728`). The digest is preimage-hiding to anyone who does not have the transaction, and the `verify_stark_proof_v2` transaction that carries `rh0..rh3` in the clear is signed by the same ephemeral as the subscribe (`c7_authority == payer`), so the two are already linked and no new edge appears.

Contrast with what is REMOVED: `stark_commitment` and `min_epoch` are values **not otherwise on the wire**, and both name the deposit.

### One caveat, to be stated in the file and never softened

The circuit does **not** verify that the vault's `subscriber_commitment` is `Poseidon(the secret in the C7 witness)`. The recipient felts are transcript-only, so nothing constrains them against the trace. A client can bind a vault seeded on an unrelated commitment. That is not a drain — the money still lands in a vault only the named retailer can claim, and `pause`/`resume` then simply fail for everyone — but "one secret, one note, one vault" remains a **client convention**, exactly as `subscription_vault.rs:150-167` already warns. ⛔ Do not write a comment claiming the proof enforces it.

---

## 5. The event

**Emit nothing.** `SubscribePrivateStarkEvent` (`subscribe_private_stark.rs:434-455`) does not survive into v4.

The v3 event does pair `subscriber_commitment` with `nullifier` in one log line, and both are functions of the **same** note secret (`subscription_vault.rs:171-181`; `apps/web/lib/privacy/worker/poolHandlers.ts:2443-2447` confirms `subscriber_commitment` is the circuit-0 commitment over the note secret). That pairing does **not** survive, and dropping it is right — but be precise about *why*, because v4 unshield's reason does not transfer.

- v4 unshield dropped its event because it leaked `recipient` (`unshield_denominated_stark_v4.rs:446-449`). Here, every field is already in the same transaction: `nullifier` at instruction bytes 8..40, `subscriber_commitment` at 115..147, `vault` / `retailer` / `token_mint` / `source_pool` as account keys or public vault fields. So the event adds **no edge**.
- What it *does* add is a **cheap bulk index**: one `getSignaturesForAddress(program)` log scan yields `(nullifier, vault, retailer, amount, source_pool)` for every subscription with no instruction decoding at all. That turns a per-target relink job into a batch one. That is the honest reason, and it is a different reason from v4's.
- Cost of dropping it: **zero, measured.** Recovery is a discriminator-filtered `getProgramAccounts` over vault accounts, deliberately with no `dataSize` filter (`apps/web/lib/privacy/pool/subscriptionRecovery.ts:71-87`), not a log scan. A repo-wide grep for `SubscribePrivateStarkEvent` returns only `target/idl`, `target/types`, `subscribe_private_stark.rs`, `subscription_vault.rs`, `landed_invariants.rs` and two docs — **no runtime consumer**.

Consequence for the guards: `stealth_meta_guard`'s two event assertions (`subscribe_private_stark.rs:538-551`) have no event to assert about in the new file. Replace them with an assertion that the file contains **no `emit!` at all**, and keep the `vault.client_stealth_meta = None` and no-stealth-argument assertions unchanged.

---

## 6. What must be tested before any redeploy

### Guards to transplant into the new file (`mod membership_guard`), whole

From `unshield_denominated_stark_v4.rs:569-723`, including `the_comment_stripper_actually_strips` (`:587-598`) — without it every guard below becomes a prose match. Then:

- `the_public_input_layout_is_forty_eight_bytes_of_six_felts`
- `the_four_recipient_felts_reassemble_the_digest` (`:472-490`) — adapted to the subscribe builder. This pins the raw-limb shortcut, which holds only because the felts are never reduced mod p.
- `every_published_field_moves_the_hash` (`:494-507`) — extended: `nullifier`, `subtree_root`, `vault`, **`rate`**, **`interval_slots`**, `vk_hash_subscriber`, `license_commitment`. A field that does not move the hash is a field the proof does not bind.
- `the_walk_errors_stay_distinguishable` (`:530-546`)
- `no_pool_value_reaches_the_vault_before_the_pool_root_is_resolved` — **renamed** from `no_lamport_moves_before_…` (`:605-612`). Subscribe has a third lamport movement with no needle: Anchor's `init` on `vault` moves rent from the payer during `try_accounts`, before any handler code runs. The old NAME would be false while the test stayed green — the exact hollow shape already measured once at `:632-636`. **And strengthen it**: v4 uses `code.find(payout)`, which checks only the FIRST occurrence. Use `code.match_indices(payout)` and assert **every** index is past the walk.
- `no_lamport_moves_before_the_root_is_matched_against_the_pool` (`:617-626`), same `match_indices` strengthening.
- `the_proof_is_fully_checked_before_the_money_moves` (`:638-663`) — every needle is the **whole `require!` statement**, never a mention. 🚨 The first version of this guard was HOLLOW: it matched `c7_deep_ali_verified` in the destructuring tuple, so deleting the `require!` left it green. Add three needles:
  - `("terms binding", "require!(c7_inputs_hash == expected_hash,")`
  - `assert!(code().contains("&rate.to_le_bytes()") && code().contains("&interval_slots.to_le_bytes()"), "the schedule is outside the digest: whoever lands the tx chooses it")`
  - `assert!(code().contains("C7_SUBSCRIBE_DOMAIN"), "no domain tag: an unshield buffer is a subscribe buffer")`
  - and the SPL destination: `("spl destination owner", "vault_token.owner == ctx.accounts.vault.key()")`
- `the_walk_never_reaches_for_the_insertion_frontier` (`:669-675`) — `filled_subtrees` must not appear at all.
- `the_ambiguous_depth_name_is_never_used_here` (`:682-688`) — `CANONICAL_DEPTH` is 12 in one crate and 15 in four other places; spell the depth as `spend_root::SPEND_SUBTREE_DEPTH` or not at all.
- `the_note_commitment_is_never_an_argument_of_this_instruction` (`:694-701`) — **the single most important copy in the set.**
- `exactly_one_circuit_id_is_accepted` (`:706-712`), `exactly_one_proof_buffer_is_read` (`:717-722`).
- `pda_bump_guard` **whole** from `subscribe_private_stark.rs:579-661`. v4 unshield has no counterpart — it inits one PDA — so there is nothing to inherit.
- `stealth_meta_guard` from `subscribe_private_stark.rs:472-552`, with the two event assertions replaced by "no `emit!` anywhere".

### Two genuinely new guards

- **`the_instruction_list_matches_the_handler_signature`.** Parse the `#[instruction(…)]` names in order and the first six parameters of `pub fn handler(` in order; require equality. Subscribe has three `[u8;32]` args inside that prefix and the vault seeds read one of them **by name out of a positional list**. Swapping two compiles, deploys, and seeds every vault on the wrong 32 bytes. **Nothing in the tree catches this today** — v4 unshield has no PDA seeded on an instruction argument, so it never had the exposure.
- **`the_spl_destination_is_owned_by_the_account_the_proof_binds`.** Match the whole `require!` statement, not the identifier `vault_token`.

### Existing test files that must grow a case

| file | change |
|---|---|
| `programs/zk_shielded/tests/landed_invariants.rs:264-285` | `the_vault_is_still_seeded_on_the_subscriber_id` does `include_str!("../src/instructions/subscribe_private_stark.rs")` **by path**. A new file is invisible to it, so the vault-seed invariant would silently stop guarding the live path. Turn it into a loop over both paths. Same for `sharing_a_note_secret_collides_the_vault_address` (`:296-338`), which hardcodes the seed triple. |
| `programs/zk_shielded/tests/unshield_c5_membership.rs:744-884` | `every_still_registered_instruction_still_dispatches` parses `pub fn` out of lib.rs and calls each against the built `.so` — it picks the new name up automatically **and fails loudly on a stale artifact**. That one is honest. Also update the stale comment at `:777-780` claiming the C7-aware verifier "is not deployed"; per the project memory it landed 2026-08-25. |
| `packages/merchant-sdk/src/vault-abi.test.ts:65-73` | `expect(openers).toEqual(['subscribe_private_stark'])` must become the two-element list. 🚨 **But the gate is already hollow, MEASURED:** `target/idl/zk_shielded.json` (mtime Aug 8) carries **26** instructions while lib.rs registers **34**. `unshield_denominated_stark_v4` is absent; `unshield` and `transfer` — the two C5 entrypoints `unshield_c5_membership.rs` proves unroutable — are still listed. Shipping without regenerating leaves that assertion green. Add an IDL-freshness test that compares the IDL instruction set to the `pub fn` list in lib.rs, and run `anchor idl build` in the same commit. `target/types/zk_shielded.ts` shares the timestamp, so every TS consumer is typed against a program that no longer exists. |
| `verify/p01-verify.mjs` | Add to **both** tables. `SPEND_KINDS` (`:223-290`): `{ name: 'subscribe_private_stark_v4', commitmentOffset: null, totalLen: null, recipientOffset: null }` — `totalLen: null` because `Option<[u8;32]>` gives 196 **or** 228, and a single number cannot pin it; if that gap is unacceptable, make `license_commitment` a fixed `[u8;32]` instead. `SPEND_LAYOUTS` (`:2497-2543`): the full field list read off the `pub fn` signature. Then change `:3173` from `if (!layout) continue;` to a **FAIL** — the global `checked === 0` at `:3226-3229` cannot catch a single kind going unverified, and this table has already been wrong in the false-clean direction twice by its own account (`:225-231`, `:255-268`). |
| `programs/zk_shielded/src/state/subscription_vault.rs` tests | Add the attack as arithmetic: a vault with `total_deposited == rate` has `funded_periods() == 1`, so `settle(start_slot + interval)` returns `is_final: true` and `payout == total_deposited`. That is the whole of "rate = denomination empties the envelope in one slot", pinned as a pure function. |

### Measurements that must NOT be guessed

1. **CU cost of the new handler on devnet.** It adds 3 Poseidon-GL `hash2` (the walk) plus one sha256 over 132 bytes, on top of a handler that already inits a 361-byte vault. v3 subscribe MEASURED 28,918–40,721 CU across ten identical subscriptions (`subscribe_private_stark.rs:667-672`). ⛔ Do **not** derive the v4 subscribe number from the v4 unshield number: unshield does not init a vault. Simulate a real transaction. 🚨 And do **not** re-baseline the whole CU table — the memory records that a previous re-baseline had no cause, 3.1.9 and 3.1.15 give identical CU, proven by control.
2. **Instruction size.** Read 196 / 228 off a real built transaction, not off the table in §1.
3. **IDL instruction count** after `anchor idl build` — read it, do not assume it.
4. **The `.so`.** Build fresh and hash it; the stale-`dist` trap is already in the project record.
5. **Rent for a 361-byte vault** vs the fee you are choosing not to charge — read `getMinimumBalanceForRentExemption(361)` from the cluster rather than quoting ~0.0033 SOL from this document.
6. **Live vault count and pool balances**, before the redeploy. The brief says 28 vaults, 47.00 SOL in 6NUS4E5P and 5.30 in HfSsGRgV. Read them; do not carry the numbers forward.

⚠️ Never put `verify/p01-verify.mjs` in a pipe — `tail` returns 0 and fabricates a false green. This is in the project record.
⛔ Do not `cargo clean` the two warm target dirs.

---

## 7. Redeploy checklist — proving it worked

**Before**

1. `solana program dump <zk_shielded> before.so`; record its sha256. This is the rollback reference.
2. Record: both pool balances, `total_shielded` / `note_count` / `mature_note_count` for both pools, and the full list of live `SubscriptionVault` accounts (discriminator-filtered `getProgramAccounts`, **no `dataSize` filter** — three sizes exist) with their `total_deposited`, `rate`, `claimed_periods`, `bump`.
3. `anchor idl build`; commit the regenerated IDL and types in the same commit as the program change.
4. Full `cargo test -p zk_shielded` on a **freshly built** artifact.

**After — verify, do not assume**

1. **The binary is the one you built.** `solana program dump <zk_shielded> after.so`; sha256 it and compare against the locally built `.so`. This is the repo's own standard ("verified **by dump**"), and it is the only thing that proves the deploy landed what you compiled.
2. **The new instruction dispatches.** Send a deliberately-failing `subscribe_private_stark_v4` (correct discriminator, garbage proof buffer). The expected error is `InvalidProof` (6xxx), **not** `InstructionFallbackNotFound` (101). Anything else means the discriminator is not routed.
3. **v3 still dispatches.** Same probe against `subscribe_private_stark`. The old path must keep working — notes whose blinding is unknown can only be spent on the C1+C3 pair.
4. **The 28 vaults still decode.** Re-run the enumeration from step 2 above and diff field by field. A single shifted byte means the account layout moved, which it must not have.
5. **Both pools unchanged.** Diff balances and counters. A redeploy must move nothing.
6. **`unshield_denominated_stark_v4` still works** — you edited it (the `recipient_token_account.owner` require). Run one real v4 unshield on the small pool and confirm the payout lands.
7. **One real end-to-end subscribe**, smallest denomination. Then read the landed transaction and assert, from the chain rather than from the client:
   - instruction data contains **no** `stark_commitment` and no `min_epoch` — P1 reads nothing because there is nothing to read;
   - the `NullifierRecord` PDA exists at `[b"nullifier", pool, nullifier]`;
   - the vault exists at `find_program_address([SEED_PREFIX, retailer, subscriber_commitment, token_mint])` and its stored `bump` re-derives that address;
   - `total_deposited == pool.denomination`, and `rate` / `interval_slots` in the account equal the values fed into the digest;
   - recompute `sha256(DOMAIN || vault || rate || interval || vk_hash || license)` off the landed instruction data and confirm it equals the last 32 bytes of the buffer's public inputs. **That is the proof the binding is live, not merely written.**
8. **Then one `claim_period`** on that vault after one interval, and confirm the payout is `rate`, not the whole envelope.
9. **Re-run `verify/p01-verify.mjs`** against that spend, not in a pipe. Expect the offset control to print the new kind, and P1 to say "publishes NO commitment, and the signature agrees."

**Rollback:** `before.so` plus the recorded balances. Redeploying the old binary is safe as long as no v4 subscribe has landed; once one has, the vault it created is only readable by `claim_period` / `pause` / `resume`, all of which are unchanged, so a rollback strands nothing.

---

## 8. What this does NOT fix

**Three other instructions still publish the note commitment on the wire.** All at byte 80, all verified against `verify/p01-verify.mjs:223-290` and the `lib.rs` signatures:

- `transfer_denominated_stark_v3` — `commitmentOffset: 80`.
- `split_note_stark` — `commitmentOffset: 80`. ⚠️ Its table entry said `null` until 2026-08-17 and that was **FALSE**. Splitting a note before spending it does not break the link to its deposit.
- `unshield_denominated_stark_v3` — `commitmentOffset: 80`, still registered, still the only path a note with an unknown blinding has.

A v4 subscribe removes the commitment from **one** spend path. Anyone who says "Protocol 01 does not publish note commitments" after this ships is wrong on three instructions.

**The nullifier is half the commitment preimage, and this instruction publishes it.** `SPEND_BOUNDARY_SPEC` assertion 1 is `(6, ROW_COMMIT_IN, Some(0))` — "cycle-2 LEFT input == the same nullifier" (`stark/src/air/spend.rs:431`), and `compute_spend_values` asserts `poseidon(nullifier, poseidon(blinding, token_mint)) == commitment` (`:918-937`). `token_mint` is the pool's, public. So for a note whose `blinding` slot holds a real `slot/7200` epoch rather than the 63-bit PRF, the leaf is recomputable in about 12,000 Poseidon evaluations over the repo's own 6,000-epoch window (`apps/web/lib/privacy/pool/poolNotes.ts:66-72`), and the deposit falls out exactly. This instruction **cannot** check it: `blinding` is a private witness and `stark/src/air/spend.rs:908-913` forbids constraining it — a boundary assertion, range check, bit decomposition or promotion to public input all "brick that note with no recovery path", including the unspent leaf-30 note of the 0.1 SOL pool. **The gate is client-side and must be an equality**, `receipt.noteBlinding === deriveNoteBlinding(walletSeed, poolPDA, receipt.leafIndex)` — not a magnitude test, which passes any note whose epoch happened to be large and passes a hand-crafted receipt. This defect is already live in `unshield_denominated_stark_v4`; the subscribe inherits it. Write the caveat in the instruction header and pin it with a source scan so it cannot be deleted as a stale comment.

**P4 goes green vacuously on any v4 spend.** `p4Verdict` returns `{ passed: true, detail: 'no commitment published, so there is nothing to match against a deposit' }` when `target === null` (`verify/p01-verify.mjs:2331-2337`), and `target` comes from `commitmentOffset` (`:1339-1341`), which is `null` for v4. Four probes report clean having looked at nothing. That is not evidence.

**The vault is a permanent public beacon.** `SubscriptionVault` is enumerable program-wide on the discriminator alone, and each one publishes `retailer`, `token_mint`, `total_deposited`, `rate`, `interval_slots`, `start_slot` and `source_pool = Some(pool_key)`. An unshield is one event in a stream; a vault is an index entry with no expiry. Removing the event does not touch this.

**`pause` and `resume` are un-probed spends.** `pause_private_stark.rs:98-101` requires `authority == payer` on a circuit-0 buffer, so the pause is signed by the ephemeral that uploaded that proof, and an ephemeral is bracketed by a pre-fund and a sweep that both name the wallet. P6 and P8 read the **spend** transaction's fee payer and nothing else. A subscription gives the subscriber N+1 chances to name their wallet and the tool measures one.

**`subtree_root` and `directions` are cleartext tree-state fingerprints.** `subtree_root` at instruction bytes 72..80 is recomputable from public `LeafInserted` events for every leaf prefix, so it reads off the exact leaf count when the prover snapshotted the tree. `directions` (3 bytes) names which of 8 buckets the note is in: zero information today, a hard 3-bit narrowing from leaf 4,097 — `the_bucket_index_is_free_only_while_one_bucket_is_occupied` (`state/spend_root.rs:236-252`) fails that day. For an unshield that correlation window is one transaction; for a subscribe it sits next to a permanent public account that `claim_period` re-publishes every period, so the window is the life of the subscription. Not a blocker. A different number, and it should be written down.

**`subscriber_commitment = Poseidon(secret_u64)` over a single Goldilocks element** (`stark/src/lib.rs:135-141`) is a 2^64-domain preimage. That is a pause/resume authorization concern, not a relink, and it is out of scope here — but it deserves its own note.

**And the honest framing for the operator.** Shipping this instruction with the composite digest, the walk, and the SPL owner require is a strict improvement, and it also repairs a live hole in the deployed `unshield_denominated_stark_v4`. The one thing that must not happen is shipping it and calling it unlinkable: for an epoch-blinded note that claim is false by measurement, and P4's green line is not evidence — it is a probe that did not look.