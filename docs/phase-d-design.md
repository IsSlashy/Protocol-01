# Phase D — Confidential Relay Design (2026-05-07)

## Context

Phase A (Tx-Opacity Master Plan) routed V3 unshield txs through p01_relayer to obscure depositor. Phase D integrates Arcium MPC for decryption: mobile encrypts unshield note data with Arcium's threshold public key, MPC nodes cooperatively decrypt, and a relayer submits the decrypted tx on-chain. This keeps the note plaintext (amount, token, recipient) hidden from any single observer (including the relayer).

SDK entry point `arcium-sdk:75-138` calls `submit_confidential_relay` on-chain. Instruction skeleton landed in commit `7c0841c` (RelayJob PDA, ConfidentialRelayJobSubmitted event, 3 error variants). Full orchestration—how to queue decryption, reassemble the result, and submit—remains open.

## What's shipped (scaffold)

- **RelayJob PDA struct**: holds encrypted note data, MPC requestor pubkey, relayer pubkey, flags
- **submit_confidential_relay ix**: validates caller, initializes RelayJob, emits event
- **3 error variants**: InvalidRelayer, JobAlreadyExists, InsufficientFunds
- **Event ConfidentialRelayJobSubmitted**: notifies MPC nodes to begin decryption

## What's open

### Decision 1: per-chunk vs batch decryption

**Per-chunk approach**: Queue N independent threshold_decrypt computations, one per 32-byte ciphertext chunk. Each MPC round decrypts 8 bytes plaintext. Cost scales linearly with note size (~10-20 chunks for typical notes). Simpler integration: no new circuit, reuse circuit_5 (threshold_decrypt from STARK verifier).

**Batch approach**: Define new MXE circuit `threshold_decrypt_batch(Vec<Ciphertext>) -> Vec<Plaintext>`. Single MPC round decrypts all chunks at once. Requires new circuit design, formal proof, trusted setup. Faster but higher upfront cost.

**Recommendation**: Per-chunk for v1 (v0.9.11+). Migrate to batch in v2 if profiling shows MPC latency dominates (unlikely; Arcium RTG ~3s per round). Batch becomes relevant at N > 50 notes in a single relay submission (out of scope for now).

### Decision 2: submission path — on-chain vs off-chain

**On-chain threshold-EdDSA gadget**: implement EdDSA signature verification on-chain accepting a threshold-aggregated signature from MPC nodes. Solana has no native primitive for this. Custom verification requires: (a) curve arithmetic in SBF (Ed25519 point doubling), (b) Lagrange coefficient arithmetic, (c) signature aggregation logic. Estimated effort: 2-4 weeks, high audit risk.

**Off-chain Arcium executor**: MPC emits decrypted tx bytes and signature via `RelayJobReady` event. A trusted (or N-of-M trusted) off-chain executor service watches events, verifies the signature, signs the relay tx with its own keypair, submits on-chain. Trust model: executor is honest (or 1-of-N Arcium MPC nodes is honest). Executor can run as a Railway service or as part of Arcium's infrastructure.

**Recommendation**: Off-chain for v1. Faster ship (no new circuit, no on-chain gadget). Documents trust model transparently. v2 can migrate to on-chain threshold-EdDSA if Solana gains a threshold signature primitive or if formal audit justifies the complexity.

### Decision 3: Mobile encryption SDK

Currently mobile encrypts unshield notes with the *single* relayer's X25519/ML-KEM-768 key (Phase A). For Phase D, mobile must encrypt with **the MXE (Arcium's threshold public key)** instead. This requires:

1. Query Arcium's public key setup (likely via `arcium-sdk` export or hardcoded in v1)
2. Replace relayer's key with MXE threshold pubkey in EncryptedNote struct
3. Arcium SDK handles key distribution (participants store their key shares offline)

**Implementation**: Add Arcium threshold pubkey to mobile config alongside relayer addresses. Use `arcium-sdk` encryption helpers (TBD) in place of current X25519 encryption in `denominatedPool/index.ts:~1950`.

## Threat model

- **T1 (passive RPC observer)**: ✓ Improved. RPC sees RelayJob PDA (encrypted data only) + RelayJobReady event (decrypted tx but signed by executor, not by submitter's wallet). Depositor wallet still exposed at tx level (Phase B.2 future work).
- **T2 (active RPC MITM)**: ✓ Same as Phase A. Executor signature verification + on-chain program validation close substitution attacks.
- **T3 (relayer/executor compromised)**: ✓ **NEW DEFENSE**. Single executor compromise does not expose plaintext if 1-of-N MPC nodes remain honest. On-chain threshold-EdDSA (v2) closes this fully; off-chain executor (v1) shifts trust to Arcium's MPC setup (3-of-5 quorum assumed honest).
- **T4 (quantum)**: ✗ No change. X25519 encryption still PQ-vulnerable. Mitigated only by hybrid + WOTS+ at higher layers (Phase E / Sprint 4).

## Implementation phases

1. **Phase D.1: expire_confidential_relay ix** — Garbage-collect stale RelayJob PDAs (older than 24h, unused). Same pattern as expire_pending_job. ~100 LOC, can ship in same session as scaffold.
2. **Phase D.2: Per-chunk threshold_decrypt orchestration** — MPC processes RelayJobSubmitted event, queues N threshold_decrypt calls, monitors completion. ~2 weeks Rust work on Arcium side (our code: call their queue API).
3. **Phase D.3: Reassembly callback** — On completion of all chunks, MPC emits RelayJobReady event with decrypted plaintext + signature. Our job: listen, validate, pass to executor.
4. **Phase D.4: Off-chain executor reference impl** — Railway service that watches RelayJobReady, validates MPC signature (Arcium's EdDSA over decrypted tx), signs relay tx, submits. ~1 week.
5. **Phase D.5: Mobile encryption integration** — Replace relayer key with MXE threshold pubkey in shield/unshield paths. Use arcium-sdk encryption. ~3 days.
6. **Phase D.6: End-to-end devnet test** — Full flow: mobile shield → encrypt with MXE key → submit_confidential_relay → MPC queue → RelayJobReady → executor submits. ~2 days.

## Estimated effort

- **Off-chain path (v1)**: 1-2 weeks focused solo work (assuming Arcium handles MPC orchestration on their end).
- **On-chain threshold-EdDSA (v2)**: add 2-4 weeks for curve arithmetic + signature verification + formal testing.
- **Quick wins**: Decision 1 (per-chunk) removes 2-3 weeks of circuit work. Decision 2 (off-chain) removes 2-4 weeks of on-chain gadget work.

## Open questions for next session

1. Does Arcium provide a queue API, or do we poll an RPC event stream?
2. What is the MXE threshold public key format (X25519? Curve25519? Raw bytes)?
3. Should the executor be a separate Railway service, or integrate into p01_relayer?
4. Do we sign RelayJob with mobile's keypair, or is it unsigned (MPC attestation only)?
5. What is the acceptable latency for Phase D relays (MPC RTG baseline ~3s, so <10s total acceptable)?

## References

- [Tx-Opacity Master Plan 2026-05-06](tx-opacity-master-plan-2026-05-06.md) — full 6-phase roadmap
- [Phase A relayer wired + E2E live 2026-05-06](phase-a-relayer-wired-2026-05-06.md) — Phase A design + implementation notes
- [arcium-sdk](../../packages/arcium-sdk/) — MPC API (incomplete, to be filled in during Phase D.2)
- Arcium RTG documentation — https://docs.arcium.ai/ (check for threshold decryption API, signature aggregation)
