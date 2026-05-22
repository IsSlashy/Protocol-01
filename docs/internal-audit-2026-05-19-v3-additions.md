# Protocol 01 — Incremental Internal Audit (V3 additions)
**Date:** 2026-05-19 | **Scope:** Work shipped between 2026-04-01 and 2026-05-19
**Previous audit:** docs/internal-audit-2026-04-01.md (covered up to 2026-04-01)

> **Status:** READ-ONLY incremental re-audit. 218 commits, ~4,000 LOC of new Rust + extensive client work. Focused on the V3 hardening surface and the new refund / chunked / heartbeat / Phase D scaffolds. Read 2,777-line `p01_arcium/lib.rs`, 7 of the new `zk_shielded` ix files, all 6 new `p01_relayer` ix files + 3 state files, and the `p01_stark_verifier` Phase C v1 additions.

---

## SCOPE

### New programs / state
- `programs/p01_relayer/src/state/relay_job.rs` — `RelayJob` (now chunked-mode aware) + `RelayChunk` PDA
- `programs/p01_relayer/src/state/refund_job.rs` — NEW `RefundJob` account (refund pipeline)
- `programs/p01_relayer/src/state/relayer_node.rs` — extended with `last_active_slot`, `reputation_score`, lazy decay (`apply_decay`)
- `programs/zk_shielded/src/state/pool_v3.rs` — NEW `DenominatedPoolV3` (Goldilocks Poseidon)
- `programs/zk_shielded/src/state/merkle_tree_v3.rs` — NEW `MerkleTreeStateV3` (C6-attested subtrees, universal `LeafInserted`)
- `programs/zk_shielded/src/state/subscription_vault.rs` — appended `client_stealth_meta: Option<[u8; 64]>`
- `programs/p01_arcium/src/state/relay_job.rs` — NEW Phase D scaffold (RelayJob status machine)

### New instructions
- `p01_relayer::submit_job_chunked`, `submit_chunk`, `heartbeat`, `expire_pending_job`, `submit_refund_job`, `process_refund_job`, `expire_refund_job`
- `zk_shielded::shield_denominated_v3`, `unshield_denominated_stark_v3`, `transfer_denominated_stark_v3`, `init_denominated_pool_v3`, `sweep_fee_escrow`
- `p01_stark_verifier::init_proof_buffer_v2`, `verify_uniform`
- `p01_arcium::submit_confidential_relay`, `expire_relay_job`

### Modified
- `zk_shielded::cancel_private_stark` — refund-via-relayer branch (CPI to p01_relayer)
- `zk_shielded::subscribe_private_stark` — V3 struct migration + `client_stealth_meta` arg
- `zk_shielded::fee.rs` — u128 widening + `fee_escrow` PDA scaffolding
- `zk_shielded::escrow_release.rs` — maturity gate added

---

## SECURITY SUMMARY

### By severity

| Severity | Count | Status |
|---|---|---|
| CRITICAL | 0 real | One acknowledged-by-design trust assumption (refund keeper) |
| HIGH | 4 | Heartbeat bypasses Sybil decay; refund keeper unconstrained; recipient unbound to STARK proof; Phase D fee never collected |
| MEDIUM | 6 | Slot/byte truncation, optional-account asymmetries, replay-window gaps |
| LOW | 5 | Doc / dead-code / event-side QA |
| FALSE POSITIVES | 4 | (see below — saved you re-investigating) |

### Breakdown by component

| Component | Verdict | Critical | High | Medium | Low |
|---|---|---|---|---|---|
| p01_relayer (chunked + refund + decay) | **STRONG with 2 gaps** | 0 | 2 | 2 | 1 |
| zk_shielded V3 (shield/unshield/transfer/cancel) | **CORRECT, partial privacy** | 0 | 1 | 2 | 1 |
| Phase D scaffold (p01_arcium) | **INCOMPLETE — not exploitable yet** | 0 | 1 | 1 | 1 |
| p01_stark_verifier Phase C v1 | **SOUND** | 0 | 0 | 1 | 1 |
| Refund pipeline (zk_shielded ↔ p01_relayer CPI) | **DOCUMENTED-RISK** | 0 | 0 | 0 | 1 |

---

## CRITICAL FALSE POSITIVES (NOT real issues)

1. **C6 proof binds only low 8 bytes of root/leaf** (`merkle_tree_v3.rs:91-104`, `transfer_denominated_stark_v3.rs:257-260`)
   Goldilocks elements fit in 64 bits and the rest of each 32-byte slot is zero-padding by construction. The on-chain Merkle tree only ever writes `[low_u64_le | 24-byte zeros]`. Confirmed in `merkle_tree_v3::ZEROS` (`merkle_tree_v3.rs:71-91`) — every entry has zero upper bytes. So binding only the low 8 bytes is sufficient. SAFE.

2. **C5 proof masquerading as C3 in `verify_uniform`** (`p01_stark_verifier/src/lib.rs:413-425`)
   C3 and C5 share IDENTICAL config bytes (tw=6, len=512, queries=22). Probe order is `[1, 6, 3, 5]`, so C5 proofs parse as C3 first. BUT `verify_generic(&proof, 3, ...)` then runs C3's AIR transitions on the proof's witness. C3 (`merkle_path`) and C5 (`transfer`) have different transition polynomials, so the soundness check rejects a C5 proof under C3 verification. Downstream `transfer_v3` / `unshield_v3` instructions also explicitly require `circuit_id == X` from the buffer. SAFE.

3. **Refund job `process_refund_job` discriminator collision** — verified `[143, 230, 188, 206, 70, 98, 31, 101]` derives from `sha256("global:submit_refund_job")[..8]` (`cancel_private_stark.rs:34`). The discriminator and account ordering match `submit_refund_job` on the relayer side. SAFE.

4. **Pause/Resume proof reuse across pause cycles** (`pause_private_stark.rs`, `resume_private_stark.rs`)
   A C0 proof bound to a vault's commitment hash could in theory be reused. BUT pause has `constraint = !vault.is_paused` and resume has `constraint = vault.is_paused`, so reuse within a cycle is impossible. Across cycles it doesn't matter — the proof just attests "I know the secret for this vault", which is the correct authorization. SAFE.

---

## REAL ISSUES TO FIX

### CRITICAL
None found.

### HIGH

**H1. Heartbeat skips `apply_decay` — anti-Sybil decay completely bypassable**
- **Files:** `programs/p01_relayer/src/instructions/heartbeat.rs:28-39`
- **Root cause:** `heartbeat` handler sets `relayer_node.last_active_slot = clock.slot` directly, WITHOUT calling `apply_decay` first.
- **Exploit:** A Sybil registers (gets 5000 initial reputation), never completes a job, and just calls `heartbeat` every < 15_000 slots (~100 min). Because `last_active_slot` is bumped each call, `apply_decay` (called by `submit_job` / `submit_job_chunked`) computes `elapsed = current_slot - last_active_slot = 0`, so `periods = 0`, no decay applied. The Sybil stays above `MIN_REPUTATION = 50` indefinitely with zero actual work.
- **Why heartbeat is supposed to defeat this:** the doc on `apply_decay` (`relayer_node.rs:106-110`) literally says "registers + builds rep on a few jobs + sits dormant → score collapses". Heartbeat is the escape hatch.
- **Timing:** `heartbeat` was shipped 2026-05-07 (commit 99b5dbf). Lazy decay was shipped one day later 2026-05-08 (commit 7d3f2a5). The decay PR did not touch `heartbeat.rs`. Pure regression.
- **Fix:** Add one line before `last_active_slot = clock.slot;`:
  ```rust
  relayer_node.apply_decay(clock.slot);
  ```
  This makes heartbeat consume the decay periods accumulated since the last reset, then resets the baseline. Spam-friendly heartbeats (every < 15K slots) still trigger no decay, but a long dormant period correctly burns the score down before refresh.

**H2. `process_refund_job` lets the keeper steal the residual — atomic shield is not enforced**
- **Files:** `programs/p01_relayer/src/instructions/process_refund_job.rs:88-138`, full `RefundJob` flow.
- **Root cause:** The handler:
  1. Sets `refund_job.status = STATUS_COMPLETED`
  2. Emits `RefundProcessedEvent` with the stealth announcement
  3. Closes the `refund_job` account with `close = keeper` → **all PDA lamports (rent + the full `amount`) flow to the keeper**
  4. Trusts the keeper to send a follow-up `shield_denominated` tx with the announced commitment.

  There is **no on-chain enforcement** that the keeper actually shields. If the keeper pockets the residual, the subscriber loses both the original deposit and the refund. The doc comment at lines 41-46 explicitly admits this trust model.
- **Severity:** HIGH (not CRITICAL because it's a documented design choice, the subscriber's loss is bounded by `vault.refundable_amount` which they chose to deposit, and the cancel path is opt-in via `client_stealth_meta`).
- **Fix path (post-MVP):**
  a) Refactor `zk_shielded::shield_denominated_v3` to accept a `Signer` OR PDA depositor (via `invoke_signed`), OR
  b) Make `process_refund_job` atomically CPI into a new `shield_denominated_via_refund` ix that consumes the `RefundJob` PDA's lamports directly.

  Until either ships, the refund-via-relayer path should be gated behind a feature flag on the mobile client and called out clearly in the UX as "trusted keeper". The recommendation in the report's RECOMMENDATIONS section formalizes this.

**H3. V3 unshield/transfer recipient is NOT bound to the STARK proof**
- **Files:** `programs/zk_shielded/src/instructions/unshield_denominated_stark_v3.rs:175-184`, commit `a66d827` ("Tornado Nova extDataHash" adaptation).
- **Root cause:** The `recipient: [u8; 32]` ix arg is verified against `remaining_accounts[0].key()`. But there's no `recipient_hash` public input on the C1/C3 STARK proofs. The ONLY cryptographic binding is `c3_authority == payer.key()` (line 252-255).
- **Why this is a HIGH:** in the relayed unshield path, the payer is an **ephemeral keypair held by the worker / mobile client**, not the end user. If a malicious worker has the ephemeral signing key (which it does — that's how it submits the tx), it can substitute the `recipient` arg + `remaining_accounts[0]` to redirect funds.
- **Mitigation today:** The end user generates the C3 proof locally (the keeper does not), and the mobile client builds the inner tx with the chosen recipient before encryption. The worker decrypts and submits as-is. So a HONEST worker preserves the recipient. The risk is a COMPROMISED worker OR a malicious relayer registry op.
- **Phase A is partial defense:** the relayer worker uses the user's submitter ephemeral key to sign. If the cleartext recipient is in the encrypted payload (it is, since the unshield ix data carries it), the relayer decrypts and learns the recipient. The relayer cannot _modify_ it without knowing the ephemeral key, BUT in chunked mode the ephemeral key may be reconstructable from the v2 hybrid envelope's KEM ciphertext if any of the relayer cluster gets compromised.
- **Fix:** add `recipient_hash` (low 8 bytes of `sha256(recipient_pubkey)`) as a 3rd public input to the C3 (merkle_path) AIR. Or, simpler, add it as a 4th input to the C1 (pool_commitment) AIR. Commit message acknowledges this is deferred.

**H4. Phase D `submit_confidential_relay` never collects the `fee`**
- **Files:** `programs/p01_arcium/src/lib.rs:1323-1372`
- **Root cause:** Handler accepts `fee: u64` arg, stores `job.fee = fee`, but **never invokes `system_program::transfer`** to move the fee from `payer` to the `relay_job` PDA. Only the PDA's rent (paid by `init`) lands in the account.
- **Impact today:** Phase D orchestration (`queue_decrypt_chunk`, MPC callbacks, threshold-EdDSA forwarder) is not yet wired (see TODOs at lines 1374-1386). So no MPC executor is ever paid, and no one expects to be paid. Not exploitable.
- **Impact at orchestration ship:** if `process_relay_job` (future) reads `relay_job.fee` and pays it out, the PDA will be **insolvent** for any `fee > 0`. The submitter pockets the fee through `expire_relay_job` (rent-only).
- **Fix:** add a `system_program::Transfer { from: payer, to: relay_job }` for `fee` lamports before `job.fee = fee;`. Mirrors `p01_relayer::submit_job` lines 87-95.

### MEDIUM

**M1. `expire_pending_job` does not advance job.status before close**
- **Files:** `programs/p01_relayer/src/instructions/expire_pending_job.rs:41-60`
- The handler closes the account via `close = submitter` without setting `job.status = Expired`. Because the account is being closed, the in-memory mutation would not be persisted anyway, so this is purely a comment / off-chain consistency issue (the emitted `JobPendingExpiredEvent` doesn't carry `status` either — fine). Compare to `expire_job.rs:77` which DOES set `job.status = Expired` even though it closes. Asymmetric for no reason.
- **Fix:** Either remove the status update from `expire_job` (close zeros the account anyway) or add it to `expire_pending_job` for consistency. Either is correct.

**M2. `submit_refund_job` doesn't verify the source vault belongs to zk_shielded**
- **Files:** `programs/p01_relayer/src/instructions/submit_refund_job.rs:23-26`
- The `source_vault` account is `AccountInfo<'info>` with no owner check. Any account can be passed as `source_vault`; the seed-based `refund_job` PDA derivation just uses its pubkey as a salt.
- **Why this is not CRITICAL:** the CPI is **only** called from `zk_shielded::cancel_private_stark`, which already validated the vault is a `SubscriptionVault` of the correct mode + private flow before invoking. The cancel handler runs after the proof check.
- **Why it's still MEDIUM:** the ix is also externally callable. An attacker can call `submit_refund_job` directly with any account as `source_vault` (paying their own rent) and create RefundJob PDAs that point at arbitrary `target_pool` + `target_tree` + `stealth_meta` — these jobs would just sit until a keeper picks them up. A keeper with no oracle for "this vault was actually cancelled" would happily process them and emit a stealth announcement event. Since `process_refund_job` doesn't write to the pool, no funds are stolen, BUT it spams the event stream and burns keeper-fee lamports on bogus refunds.
- **Fix:** add `constraint = source_vault.owner == &zk_shielded::ID` in the Accounts struct. Or, simpler, require the `source_vault` PDA derivation match the SubscriptionVault seed (would require denomination/retailer args). The cheapest fix is the owner check.

**M3. Sweep slot drift window leaks per-pool fee timing**
- **Files:** `programs/zk_shielded/src/instructions/sweep_fee_escrow.rs:92-101`
- The treasury supplies `slot` as an ix arg; handler enforces `current_slot - slot <= 25` (~10 s). The SweepRecord PDA uses `slot` as a seed for per-slot idempotency. Privacy claim: "rotation per sweep + minutes-hours after user activity" (`fee.rs:38-39`).
- **Issue:** the treasury runs all sweeps via the same hardcoded `TREASURY_AUTHORITY` (`fee.rs:23-28`). Every sweep tx is signed by the same key and emits a `SweepRecord` PDA. An off-chain observer trivially correlates `pool → sweep_record → destination_prefix`. Cross-pool revenue linkability is broken at the pool level but the treasury identity is _global_ — one key burns the privacy claim.
- **Fix:** rotate sweep authority via a multisig of disposable keys (already on the mainnet-todo list in the comment at `fee.rs:26`). Until then, document this as a known leak for devnet.

**M4. `client_stealth_meta` is stored plaintext on the vault PDA**
- **Files:** `programs/zk_shielded/src/state/subscription_vault.rs:62-68`
- `SubscriptionVault.client_stealth_meta: Option<[u8; 64]>` is readable by anyone fetching the account. Anyone who learns the stealth meta can:
  - Watch the chain for any stealth-encrypted note announcement with the matching ephemeral_pub
  - Learn the subscriber's full stealth spending + viewing pubkeys
- **Why this is not HIGH:** the stealth pubkeys do not, by themselves, leak the subscriber's wallet. They only allow tracking future incoming stealth notes for that subscriber. But this is a non-trivial linkage primitive.
- **Mitigation:** the vault is closed via `close = payer` on cancel, after which the data is gone. But during the active life of the subscription, it's on-chain.
- **Fix:** encrypt `client_stealth_meta` with a viewing key derived from the subscriber's commitment + a domain separator, decryptable only by the subscriber + the keeper-via-CPI. OR derive the stealth meta on the fly from `subscriber_commitment + retailer + epoch` so no plaintext is stored.

**M5. `MerkleTreeStateV3::insert_with_root_v3` trusts client-supplied `new_subtrees`**
- **Files:** `programs/zk_shielded/src/state/merkle_tree_v3.rs:141-199`
- The function correctly verifies the C6 STARK proof binds the (old_root → new_root) transition. BUT the `new_subtrees: &[[u8; 32]]` argument is NOT bound by the proof's public inputs (see comment at lines 171-184).
- **Why this is not exploitable:** the next insert reads `merkle_tree.root` as `old_root` for its C6 proof. If a malicious caller wrote garbage `new_subtrees`, the next insert's C6 proof would still bind to the correct root (root is bound), and the next-next insert's path computation can be done off-chain by replaying `LeafInserted` events.
- **Why it's still MEDIUM:** the on-chain `filled_subtrees` is now strictly less trustworthy than the off-chain replay. The comment at line 139-141 says "off-chain merkle rebuild should derive the canonical state from `LeafInserted` events rather than trusting these values" — so the on-chain values are now a hint, not state of record. This contradicts the "on-chain subtree maintenance" promise in `pool_v3.rs:21-34`.
- **Fix:** either (a) extend the C6 AIR to bind `new_subtrees` in public outputs (preferred, requires circuit work), or (b) delete the `filled_subtrees` storage entirely (simpler — just keep `root` on-chain and force clients to replay events).

**M6. `unshield_denominated_stark_v3` does not enforce `min_epoch`**
- **Files:** `programs/zk_shielded/src/instructions/unshield_denominated_stark_v3.rs:196-199`
- The handler comment says "Maturity is a UX/SDK concern in V3 (same as v2). We update bookkeeping for anonymity metrics but don't enforce." But `transfer_denominated_stark_v3:167-173` DOES enforce `current_epoch >= effective_min_epoch`. Asymmetric.
- **Net effect:** a fresh deposit can be unshielded immediately, defeating the anonymity-set timing protection that the pool's `epoch_delay` is supposed to provide.
- **Why this is MEDIUM not HIGH:** the policy was the same in v2 and didn't change in V3. But shipping fresh V3 pools was a chance to fix it and they didn't.
- **Fix:** add the same `effective_min_epoch` enforcement that `transfer_denominated_stark_v3` has, gated on a pool config bit so admins can disable per-pool if needed.

### LOW

**L1. `RefundJob::LEN = 234` doesn't match the spec doc**
- **Files:** `programs/p01_relayer/src/state/refund_job.rs:80-86`, `docs/sprint-refund-pipeline-contract.md:65-66`
- The doc says `LEN = 202`, the code says `234`. The added `original_payer: Pubkey` field accounts for the 32-byte delta. The doc-vs-code drift is acknowledged in the rust source comment (line 80-85) but the contract doc was not updated. Easy fix: update the doc.

**L2. `verify_uniform` doesn't gate on `circuit_id == u8::MAX`**
- **Files:** `programs/p01_stark_verifier/src/lib.rs:384-449`
- A caller could (in theory) call `init_proof_buffer` (V1, with explicit circuit_id), upload a proof, then call `verify_uniform` instead of `verify_stark_proof_v2`. `verify_uniform` would probe and overwrite `circuit_id` post-hoc.
- **Why it's safe today:** the V1 init seeds include `[circuit_id]`, so the buffer is at a different PDA than the V2 init buffers `stark_proof_v2`. AND `verify_uniform` re-runs `verify_generic`, so soundness is preserved either way. The probe result + verify result must agree on the circuit.
- **Why it's still LOW:** if someone in the future relies on "if `circuit_id != u8::MAX`, the buffer was init'd V1 and should not be uniformly-probed", that invariant doesn't hold. Defensive add: `require!(buffer.circuit_id == u8::MAX, ..)` at the top of `verify_uniform`.

**L3. `expire_pending_job` doesn't close associated `RelayChunk` PDAs**
- **Files:** `programs/p01_relayer/src/instructions/expire_pending_job.rs:11-19` (acknowledged in comment).
- For chunked jobs that timeout, the `RelayJob` PDA rent is refunded to the submitter, but the per-chunk `RelayChunk` PDAs (up to 256 × ~0.007 SOL each = ~1.8 SOL worst case) are NOT closed. They become orphaned rent.
- The comment proposes a future `expire_chunk` ix. Acceptable for now since the worst case requires 256 chunks (1.8 SOL stuck) and the median case is 1-3 chunks. But adds up at scale.

**L4. `expire_relay_job` (Phase D, `p01_arcium`) — `Decrypting` status race**
- **Files:** `programs/p01_arcium/src/lib.rs:1404-1431`
- A `Decrypting` job can be expired by anyone after deadline. If the MPC cluster is mid-callback when expire fires, the callback would later try to mutate a closed account and fail silently (or harmlessly: Anchor returns AccountNotInitialized). Not exploitable, but worth a sanity test once Phase D orchestration ships.

**L5. `cancel_private_stark` dust forfeit is silent below 100k lamports**
- **Files:** `programs/zk_shielded/src/instructions/cancel_private_stark.rs:407-417`
- If a vault has `client_stealth_meta == Some(_)` AND `refundable < REFUND_MIN_RESIDUAL` (100k lamports), the handler falls through to the legacy path, which forfeits the dust without notifying anyone. The emitted event has `dust_forfeited: refundable`, but UX-side users will not understand why they "lost" 99,999 lamports. Documented limitation, but worth a UI prompt.

---

## RECOMMENDATIONS — actionable before Sprint 4 (Quantum Wallet)

1. **Fix H1 (heartbeat decay bypass) before any mainnet talk.** One-line fix; the entire anti-Sybil design fails without it. ~5 min of work + redeploy.

2. **Gate H2 (refund pipeline keeper trust) in the mobile UX.** Add a "trusted operator" badge to the refund preview, and consider making `client_stealth_meta` opt-in until the atomic shield CPI is implemented in a follow-up sprint.

3. **Schedule H3 (recipient binding to STARK) as the first C3/C5 circuit task post-Sprint 4.** Adding `recipient_hash` to public inputs is ~3 days of circuit work + 1 day of redeploy + APK rebuild. Lower priority than Quantum Wallet but on the path.

4. **Address H4 (Phase D fee transfer) when Phase D orchestration is wired.** Right now this is a dead-code field. When the executor is built, the fee transfer needs to be added; do it before the first real call to avoid a regression that locks user fees in scaffold-state PDAs.

5. **Consider an `IDL_VERSION` constant on every `#[event]` and PDA struct** to make Phase B + B.2 future scrubs forward-compatible. Right now the universal `LeafInserted` is the only V3 event; future additions should follow the same single-event convention.

---

## Does anything BLOCK Sprint 4 (Quantum Wallet) start?

**NO.** The Quantum Wallet (`p01_quantum_wallet`) is an additive program (STARK-authorized smart-contract wallet) that does not depend on the V3 hot path or the refund pipeline. The 4 HIGH findings are localised:
- H1 / H4 are server-side fixes (~30 min total)
- H2 is a documented design tradeoff (not a regression)
- H3 is acknowledged in the original commit message as deferred circuit work

Sprint 4 can start. H1 should be fixed and redeployed first so the relayer reputation system is real, but it's not a blocker for net-new code in a different program.

---

## Appendix — files cited

### Files I read in full
- `programs/p01_relayer/src/lib.rs` (full)
- `programs/p01_relayer/src/instructions/*.rs` (all 18)
- `programs/p01_relayer/src/state/*.rs` (all 5)
- `programs/p01_relayer/src/constants.rs`, `errors.rs`
- `programs/zk_shielded/src/instructions/shield_denominated_v3.rs`
- `programs/zk_shielded/src/instructions/unshield_denominated_stark_v3.rs`
- `programs/zk_shielded/src/instructions/transfer_denominated_stark_v3.rs`
- `programs/zk_shielded/src/instructions/cancel_private_stark.rs`
- `programs/zk_shielded/src/instructions/subscribe_private_stark.rs`
- `programs/zk_shielded/src/instructions/pause_private_stark.rs`
- `programs/zk_shielded/src/instructions/resume_private_stark.rs`
- `programs/zk_shielded/src/instructions/escrow_release.rs`
- `programs/zk_shielded/src/instructions/init_denominated_pool_v3.rs`
- `programs/zk_shielded/src/instructions/sweep_fee_escrow.rs`
- `programs/zk_shielded/src/state/pool_v3.rs`
- `programs/zk_shielded/src/state/merkle_tree_v3.rs`
- `programs/zk_shielded/src/state/subscription_vault.rs`
- `programs/zk_shielded/src/fee.rs`
- `programs/zk_shielded/src/errors.rs`
- `programs/p01_arcium/src/lib.rs` (relay-related sections + accounts)
- `programs/p01_arcium/src/state/relay_job.rs`
- `programs/p01_stark_verifier/src/lib.rs` (Phase C v1 additions + existing ix)

### Spec docs reviewed
- `docs/sprint-refund-pipeline-contract.md`
- `docs/tx-opacity-plan-2026-05-06.md`
- `docs/internal-audit-2026-04-01.md`

### Git history reviewed
- `git log --since="2026-04-01" --until="2026-05-19" --no-merges --oneline` (218 commits)
- Targeted `git show` on commits: cb9f314, 22f5be9, 4bc69cb, f203dd1, a66d827, bb1df53, a0ad030, 99b5dbf, 7c0841c, 06fe228, 7d3f2a5, 6dda0c4
