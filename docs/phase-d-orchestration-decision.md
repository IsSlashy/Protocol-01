# Phase D — Confidential Relay Orchestration Decision

**Date:** 2026-05-27
**Status:** Decision recorded — implementation pending (D.2 → D.8)
**Scope:** Pick the architecture that closes the `TODO(phase-d-orchestration)` block at `programs/p01_arcium/src/lib.rs:1374-1387`.

## Problem

`submit_confidential_relay` is scaffolded: it accepts MXE-encrypted ciphertext chunks, validates them, and stores them in a `RelayJob` PDA. What it does NOT do yet:

1. Trigger MPC decryption of the chunks
2. Reassemble the original Solana transaction once chunks are decrypted
3. Broadcast that inner transaction

Without (1)→(3), the SDK's `awaitRelayCompletion` (arcium-sdk/src/relay/index.ts:146) times out forever and Phase D is dead code.

## Goal recap

The point of `submit_confidential_relay` is to **break the link between depositor and recipient on-chain**. Depositor submits a tx that contains only encrypted chunks — recipient cannot be observed. Some other actor eventually broadcasts the recipient-bearing unshield tx, paid by a different fee-payer.

Privacy holds iff: (a) the MPC threshold prevents any single cluster node from learning the inner tx prematurely, and (b) the broadcasting actor is not the depositor or trivially correlatable to them.

## The two paths from the TODO comment

### Path A — On-chain forwarder / threshold-EdDSA verifier

The callback `confidential_relay_callback` would, once all chunks are decrypted, **invoke the inner Solana transaction on-chain via CPI**.

**Why this doesn't work on Solana today:**

1. **CPI requires the inner accounts.** To CPI a `zk_shielded::unshield` (the canonical Phase D payload), the callback must hold the unshield's accounts in its `Context` — which includes the **recipient**. The recipient would land in the callback ix tx, observable on-chain. That's exactly what Phase D is supposed to hide. **The architecture defeats its own privacy goal.**

2. **No "blind broadcast" primitive.** A Solana program cannot construct an arbitrary outer transaction whose accounts only emerge from runtime state. Programs are constrained to their declared `Accounts` struct.

3. **Threshold-EdDSA verifier ≠ trustless forwarder.** `output.verify_output(&cluster_account, &computation_account)` already cryptographically verifies the MXE cluster's threshold signature on the decryption result. That part is solved by Arcium's framework. The unsolved part is *who carries the decrypted bytes to chain in a tx that doesn't leak the recipient* — Path A has no answer.

4. A future `p01_quantum_wallet` (Sprint 4, currently delayed) would in principle let an arbitrary STARK-verified auth gadget sign the inner tx with a session key — but that's exactly the Sprint 4 work we are postponing. Path A reduces to "wait for quantum wallet".

**Verdict:** Path A is either privacy-broken (CPI-from-callback) or blocked on Sprint 4 (STARK-of-knowledge wallet auth).

### Path B — Emit `RelayJobReady` event + off-chain executor

The callback emits `RelayJobReady { chunks_decrypted, plaintext_bytes }`. A separate **executor service** (Node.js worker, hosted alongside the existing `p01_relayer`) subscribes to that event, reassembles the inner Solana tx from the bytes, and broadcasts it from its own fee-payer wallet.

**Why this works:**

1. **Recipient never appears in the depositor's tx.** Depositor's `submit_confidential_relay` carries only ciphertext chunks. Recipient is in the executor's later broadcast — separated in time and from a different signer. The privacy property is preserved.

2. **MPC threshold protects pre-decrypt.** The cluster's threshold signature on the decrypted chunks (`output.verify_output`) means no single MPC node sees plaintext alone. Privacy assumption: any K-of-N MPC nodes honest.

3. **Executor can't equivocate.** The decrypted plaintext bytes appear in the `RelayJobReady` event log on-chain. Anyone watching the chain can verify the executor's later broadcast matches the decrypted bytes. Equivocation is detectable and slashable (extends the existing relayer reputation system from Sprint 3).

4. **Censorship resistance via competing executors.** Multiple executors race to broadcast first; only the winning broadcast lands. The fee in the `RelayJob` PDA incentivizes execution. If all executors collude to censor a job, the user can read the event themselves and broadcast.

5. **Reuses existing infra.** The `services/relayer` Railway deployment already has heartbeat (`99b5dbf`), liveness filtering, expiration GC (`expire_pending_job`, `expire_relay_job`), and multi-relayer failover (Sprint 3 `e466eff`). The Phase D executor is the same shape — subscribe to a different event, broadcast a different payload.

**Trust shift vs Path A's hypothetical:**

| Concern | Path A (hypothetical) | Path B (chosen) |
|---|---|---|
| MPC threshold honest? | Required | Required |
| Recipient hidden at depositor tx? | **Broken** (CPI accounts) | Yes |
| Recipient hidden permanently? | N/A (broken upstream) | No — appears in executor broadcast (necessary for unshield to work) |
| Executor honesty? | N/A | Optional — events let anyone verify + broadcast |
| Available without Sprint 4? | No | Yes |
| Reuses existing infra? | No (new on-chain gadget) | Yes (extends relayer worker) |

The trust assumption added by Path B vs Path A (hypothetical) is: a competent ecosystem of executors exists. With multi-relayer failover already shipped in Sprint 3 and the event being publicly verifiable, this is the same trust posture we already accept for the regular relayer.

## Decision

**Path B (off-chain executor) — scoped down to "recipient-only MPC" (Alt 1, 2026-05-27 pivot).**

Initial design encrypted the full inner unshield (~800B → ~13 MPC calls per submit). On reflection that:
1. Adds a non-PQ layer (Arcium MXE uses x25519 ephemeral, classical ECC) over a system whose privacy story is post-quantum via STARK Goldilocks. Wrapping a PQ-safe payload in a non-PQ envelope is a regression of the PQ claim.
2. Yields a marginal privacy gain — the executor still learns the recipient at broadcast time. Without `p01_quantum_wallet` (Sprint 4, delayed), the fee payer Ed25519 irreducible remains.
3. Adds 35-58h of work for that marginal gain.

**Revised scope — Phase D Alt 1:** encrypt only the 32-byte recipient pubkey, not the whole inner tx. Everything else (amount, nullifier, root, STARK proof) keeps flowing through the existing `p01_relayer` (Phase A, shipped). The MPC sidecar's only job is to deliver the recipient just-in-time to the relayer worker.

**Flow:**
1. Client generates STARK proof with recipient as private (Poseidon-committed) input.
2. Client encrypts the 32-byte recipient pubkey to the MXE cluster pubkey.
3. Client submits two ixs (same tx or separate):
   - `p01_relayer::submit_job` carrying the plaintext payload (amount, nullifier, root, proof).
   - `p01_arcium::submit_confidential_relay` carrying `encrypted_recipient: [u8; 32] × 4` (one `TxChunk` worth — recipient is 4 × u64) plus a `relayer_job_id` link.
4. `submit_confidential_relay` queues **one** `queue_computation(threshold_decrypt)` on the recipient `TxChunk`.
5. Callback `confidential_relay_callback` extracts the first 4 u64 of the decrypted `TxChunk`, repacks them into 32 bytes, emits `RecipientDecrypted { relayer_job_id, recipient_bytes }`. The trailing 4 u64 of the `TxChunk` are unused (zero-padded by client).
6. The existing `services/relayer` worker subscribes to `RecipientDecrypted`, joins it against the `RelayerJob` PDA's plaintext payload it already holds, constructs the unshield tx with the now-known recipient, broadcasts.

**What this preserves:**
- Recipient hidden from the relayer service until MPC threshold-decrypts.
- Existing Phase A infra (multi-relayer registry, heartbeat, reputation decay, failover) keeps working — Phase D Alt 1 is a sidecar, not a replacement.
- STARK Goldilocks PQ story for the spent note + spend authority is untouched.

**What this gives up vs the original Phase D maximal design:**
- The rest of the unshield bytes (~800B) are still observable to the relayer node. The depositor↔recipient link via `p01_relayer` (Phase A) was already broken pre-Phase-D, so what remains is: relayer sees amount + nullifier (already public on-chain post-unshield) + the recipient now hidden until MPC decrypt.

**Trust model documented honestly:**
- Pre-MPC: recipient hidden from relayer node, MPC threshold protects against single-node compromise on the recipient.
- Post-MPC: recipient becomes visible to the executor that broadcasts (necessary for the unshield to land). If executor = relayer node (typical), the relayer node learns the recipient one step before broadcast.
- The 32-byte MXE encryption uses x25519 ephemeral → not post-quantum on the recipient field during the in-flight window. Documented as a known limitation pending Arcium PQ keys or Sprint 4 quantum wallet.

**This is no longer Path B vs Path A. It's "minimal MPC sidecar over Phase A".** Path A's on-chain CPI forwarder problem (recipient in callback accounts) doesn't even arise here because the on-chain callback only emits the recipient via event — no CPI to the unshield is attempted.

## Implementation impact on D.2 → D.8

- **D.2** — MXE circuit `threshold_decrypt_chunk`: shape is 32B encrypted → 8B plaintext per chunk. Verify whether existing `init_threshold_decrypt_comp_def` (lib.rs:152) already supports this shape; otherwise add a per-chunk encrypted ix in `programs/p01_arcium/encrypted-ixs/src/`.
- **D.3** — Wire `queue_computation(COMP_DEF_THRESHOLD_DECRYPT)` per-chunk inside `submit_confidential_relay`. Linear in `chunk_count`. (Optional optimization: batch circuit decrypting all N at once — defer.)
- **D.4** — Callback `confidential_relay_callback` accumulates `chunks_decrypted++`, transitions `Pending → Decrypting → Decrypted` when complete, and emits `RelayJobReady { job, plaintext_bytes (chunked or assembled) }`.
- **D.5** — Off-chain executor: Node.js worker in `services/relayer` subscribes to `RelayJobReady`, trims the trailing padding using `RelayJob.original_tx_len`, deserializes the inner `VersionedTransaction`, broadcasts via Solana RPC, marks `RelayJob.status = Submitted` via a `complete_relay_job` follow-up ix.
- **D.6** — SDK `awaitRelayCompletion`: poll `RelayJob.status` through `Pending → Decrypting → Decrypted → Submitted`. Surface explicit error if stuck in `Pending` past a threshold (orchestration not deployed) — wording suggested in the TODO comment at lib.rs:1384-1386.
- **D.7** — E2E test: full shield → confidential relay → unshield on devnet. Assert depositor tx doesn't contain recipient; executor tx does; the two are unlinkable from chain observation alone.
- **D.8** — Deploy `p01_arcium` redeploy + executor service to Railway alongside `p01-relayer-node`. Live smoke.

## D.2 follow-up — `threshold_decrypt` circuit already exists

Investigation confirms the encrypted instruction is already shipped at
`programs/p01_arcium/encrypted-ixs/src/lib.rs:472`:

```rust
#[instruction]
pub fn threshold_decrypt(
    encrypted_chunk: Enc<Shared, TxChunk>,
) -> TxChunk { ... }   // TxChunk = 8 × u64 = 64 plaintext bytes
```

The Solana-side `init_threshold_decrypt_comp_def` (lib.rs:152) bootstraps
the comp def. The MPC threshold-decrypts a whole `TxChunk` per call.

**Mismatch with the current scaffold:** `submit_confidential_relay`
declares `ciphertexts: Vec<[u8; 32]>` and treats each `[u8; 32]` as
"one encrypted u64 / 8 plaintext bytes". The circuit, by contrast,
batches 8 u64s per call. If we wire 1:1 from ciphertext to MPC call
we run 8× more MPC computations than necessary.

**D.3 wiring strategy:** group 8 ciphertexts into one `TxChunk` arg,
queue 1 `queue_computation(threshold_decrypt)` per group → at most
`ceil(chunk_count / 8)` MPC calls instead of `chunk_count`. For a
typical Solana unshield (~800-bytes inner tx, ~100 ciphertext chunks)
that's ~13 MPC calls instead of ~100.

`RelayJob.chunks_decrypted` advances by the group size (8 for full
groups, less for the trailing group), so the existing
`chunks_decrypted == chunk_count` terminal check still works
unchanged.

## Open questions deferred to the implementation phase

- **Batch vs per-chunk MXE decrypt:** D.2 found the existing
  `threshold_decrypt` is already a TxChunk batch (8 u64 per call). The
  unit of work is the TxChunk group, not the single ciphertext.
- **Executor anti-MEV:** does Solana's leader-rotation already break MEV on these unshield txs? Likely yes since the payload is opaque pre-broadcast and the executor's tx is just a normal `zk_shielded::unshield`. Document and move on.
- **Multiple executors race:** first-to-land wins. Loser executor wastes a tx fee. Consider a "claim" ix that locks an executor to a job for a slot window (similar to relay job claiming in existing relayer). Defer.
- **Slashing for equivocation:** the existing relayer reputation can be extended. Add only if observed in practice.

## References

- `programs/p01_arcium/src/lib.rs:1323-1389` — `submit_confidential_relay` ix (scaffold, this decision plugs the TODO)
- `programs/p01_arcium/src/lib.rs:1404-1419` — `expire_relay_job` ix (GC, already shipped)
- `programs/p01_arcium/src/lib.rs:186-275` — `balance_audit` pattern (template for queue_computation + callback)
- `programs/p01_arcium/src/state/relay_job.rs` — `RelayJob` state, status enum
- `packages/arcium-sdk/src/relay/index.ts:75-188` — client-side submit + await + relayTransaction
- `services/relayer/` — existing Railway worker (hosts heartbeat, expire_pending_job, multi-relayer failover from Sprint 3)
- `Hardening Master Plan (2026-05-07)` memory — Sprint 3 scope including this Phase D work
