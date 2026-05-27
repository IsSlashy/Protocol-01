# Phase D Alt 1 — Integration Gap (zk_shielded recipient-decoupling)

**Date:** 2026-05-27
**Status:** Decision recorded — D.5/D.7/D.8 deferred pending zk_shielded redesign
**Scope:** Document why the on-chain Phase D Alt 1 pieces (D.3+D.4) and SDK (D.6) shipped today cannot be end-to-end-wired without a separate restructure of `zk_shielded::unshield`.

## Recap of what shipped today

Three slices landed:

- **D.3** (`eacc55c`) — RelayJob state + ix shape: Alt 1 fixed layout, `relayer_job_id` link, no Vec chunks.
- **D.4** (`a7e645e`, `6319eb3`) — `decrypt_recipient` Arcis circuit + `init_decrypt_recipient_comp_def` + `queue_computation` wiring + `decrypt_recipient_callback` + `RecipientDecrypted` event.
- **D.6** (`d370383`) — SDK rewrite for Alt 1: encrypt recipient as 4 u64s, dual-ix submit, poll RelayJob PDA, surface plaintext recipient post-MPC.

These are correct, self-contained, and form a complete on-chain + client-side MPC sidecar pipeline for recipient confidentiality.

## What's missing — the integration gap

D.5 (`services/relayer` event subscriber that joins the decrypted recipient with the Phase A payload and broadcasts the unshield) cannot be built without addressing a deeper issue:

**The user pre-signs the inner unshield transaction with their own keypair before encrypting it for the relayer.** Per the worker code at `services/relayer/index.mjs:152-153,289-297`:

> "the inner-tx signer key (user keypair for shield/unshield/transfer) was never included in the relay payload."

And:

> "The worker CANNOT re-sign because the encrypted payload contains only the serialized transaction bytes."

Solana transactions sign over the full message, including all `AccountMeta` entries. The recipient appears as an `AccountMeta` (it must — the SystemProgram::transfer or token transfer needs the recipient as a writable account). Therefore the recipient is **inside the signed message hash**.

Post-signing substitution invalidates the signature. There is no clean way to use Phase D Alt 1's decrypted recipient to amend a pre-signed tx.

## The two unblockers

### Unblocker A — Decouple recipient from user signature in `zk_shielded::unshield`

Redesign the unshield ix so that:

1. The user pre-signs a "spend authorization" that **does NOT include the recipient** — only the nullifier, root, amount, and STARK proof (whose public inputs include the recipient).
2. The unshield ix takes recipient as a **separate runtime parameter** supplied by the broadcaster.
3. The on-chain STARK verifier checks that the proof's recipient public input matches the runtime parameter.

This is the cleanest cryptographic story (STARK already commits to recipient in the proof) but requires:
- Modifying `zk_shielded::unshield_stark` ix signature
- Modifying STARK public input layout (recipient already public, just needs to be wired separately from the signed accounts)
- Modifying mobile/extension tx construction to pre-sign without recipient + send recipient as a separate field
- Modifying the relayer worker to construct the unshield tx fresh using the user's signed authorization + the MPC-revealed recipient

Estimated effort: **40-60h** across `zk_shielded`, mobile, extension, worker, integration tests.

### Unblocker B — Sprint 4 quantum wallet (`p01_quantum_wallet`)

The quantum wallet design (Sprint 4 in the Hardening Master Plan, currently delayed) makes the fee payer a disposable STARK-authenticated session key. The user's true spending key never appears as an inner-tx signer; instead, a session key signs the actual broadcast tx, and the worker can be that session key with a STARK-of-knowledge proof. Recipient can be a free runtime parameter because there is no fixed pre-signed tx to invalidate.

This is the architecturally clean answer the original master plan envisioned. It solves the integration gap as a side-effect.

Estimated effort: **~290h** per master plan (Sprint 4 full scope).

## Recommendation

**Defer D.5, D.7, D.8 indefinitely; ship D.3+D.4+D.6 as forward-looking infrastructure.**

Rationale:
- The shipped pieces are deployed as future-ready infrastructure. When unblocker A or B is built, the MPC sidecar is already in place.
- Attempting D.5 today with the current `zk_shielded` shape requires either a hack (e.g., the relayer broadcasts a partially-signed tx that gets recipient injected via durable nonce gymnastics) or a significant restructure that exceeds the Phase D budget.
- Unblocker A is a coherent piece of work that should be planned and scoped on its own — not bundled into Phase D's "implementation polish".
- Unblocker B aligns with the long-term post-quantum narrative; Phase D Alt 1's privacy gain is incremental and bounded by the x25519 PQ regression noted in `phase-d-orchestration-decision.md`.

**Operational state after this decision:**
- `p01_arcium::submit_confidential_relay` ix is live in the codebase but not invoked by any client until D.5 unblocks.
- `decrypt_recipient` MXE comp_def needs an `init_decrypt_recipient_comp_def` call to be reachable on a target cluster — defer until first integration.
- The arcium-sdk `submitConfidentialRelayJob` / `awaitRecipientDecryption` / `relayRecipient` are exported and documented but not consumed by any app yet. Tagged as Phase D building blocks.
- Mobile `confidentialRelay.ts`'s `mpcRelay()` throws an explicit migration error; the standard Phase A path remains the active broadcast route.

## Path forward (post-defer)

1. **Decide between unblocker A and B** as a separate strategic question (likely after Sprint 3 finish, alongside the master plan's review of Sprint 4 timing).
2. **If unblocker A**: write a `zk_shielded` unshield ix RFC, scope the cross-component changes, ship as its own sprint.
3. **If unblocker B**: resume Sprint 4 quantum wallet implementation; Phase D Alt 1 sidecar plugs in naturally.
4. **Either way**: D.5 → D.7 → D.8 become straightforward once the inner-tx signing model accommodates recipient-decoupling.

## References

- `programs/p01_arcium/src/lib.rs:1310-1389` — submit_confidential_relay (Alt 1)
- `programs/p01_arcium/src/lib.rs:1419-1485` — decrypt_recipient_callback (Alt 1)
- `programs/p01_arcium/encrypted-ixs/src/lib.rs:494-510` — decrypt_recipient circuit
- `programs/p01_arcium/src/state/relay_job.rs` — RelayJob (Alt 1 fixed layout)
- `packages/arcium-sdk/src/relay/index.ts` — SDK (Alt 1 API surface)
- `services/relayer/index.mjs:152-297` — the worker comments that identify the signing constraint
- `docs/phase-d-orchestration-decision.md` — original Path B → Alt 1 pivot
- `hardening-master-plan-2026-05-07` memory — Sprint 4 (quantum wallet) scope
