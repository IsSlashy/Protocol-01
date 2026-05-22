# Arcium MPC Integration in Protocol 01

A precise, no-marketing description of how Arcium fits into the protocol, what is wired today, and how transactions stay within Solana limits.

## 1. Role of Arcium in the protocol

Arcium is not the core privacy layer of Protocol 01, it is a complement.

The core privacy stack stays:
- ZK-SNARKs (Groth16, snarkjs 0.7.5, circom2 2.2.2) for shielded notes, denominated pool joins, balance proofs, transfer proofs.
- STARKs (Winterfell, Poseidon AIR over the Goldilocks 64-bit field) for the V3 hot path (shield, transfer, unshield, Merkle update) verified on-chain by `p01_stark_verifier`.
- Stealth addresses (ECDH plus ML-KEM) for receive-side privacy.

Arcium handles the class of problems that pure ZK does not solve well:
- Joint computation over inputs that originate from N different parties (one party cannot produce a single proof over inputs it does not own).
- Sealed inputs that must remain confidential even after the computation finishes (only the result is revealed, not the inputs).
- Threshold operations such as N-of-M decryption, where no single node is allowed to recover the plaintext.

Concretely, in our codebase, Arcium is exposed through:
- One Solana program, `p01_arcium`, in `programs/p01_arcium/` (2777 lines Rust plus 687 lines of encrypted instructions in `encrypted-ixs/src/lib.rs`).
- One TypeScript SDK, `@protocol-01/arcium-sdk`, in `packages/arcium-sdk/` (8 modules, RescueCipher encryption, x25519 key exchange, ephemeral key rotation every 10 operations).
- Three mobile services in `apps/mobile/services/arcium/` that wire opt-in MPC features into user-facing flows.

Devnet program ID (frozen, kept in `packages/arcium-sdk/src/client.ts`): `9kMjmVMYxBa8V9D1aoEjZtUNXTe2gjfzYdKLycn7JvgQ`. Cluster offset: 456.

## 2. Circuit catalog and wiring status

The program registers nine confidential computation definitions, each with its own `init_*_comp_def` instruction and a matching queue plus callback pair. The following table maps each circuit to its purpose and its current integration status.

| Circuit | Purpose | Status in apps |
|---|---|---|
| `threshold_decrypt` | N-of-M MPC nodes jointly decrypt and submit a Solana transaction on the user's behalf. The user wallet never appears as the fee payer or as a signer on-chain. | Wired in mobile, opt-in via `mpcEnabled` flag in `apps/mobile/stores/arciumStore.ts` (see `apps/mobile/services/arcium/confidentialRelay.ts`). Candidate to replace the current single-node Railway relayer. |
| `nullifier_commit` | SHA3 commitment over a nullifier, computed in MPC. Prevents double spend without revealing the actual nullifier value to any party. | Wired in mobile, opt-in (see `apps/mobile/services/arcium/nullifierCommit.ts`). |
| `private_lookup` | Lookup of a meta-address in the registry without revealing which key is being queried to any single party (no RPC-side correlation). | Wired in mobile, opt-in (see `apps/mobile/services/arcium/privateLookup.ts`). |
| `register_viewing_key` | Stores an encrypted viewing key under MPC so that scanning can later be done in a privacy-preserving way. | SDK only (`packages/arcium-sdk/src/stealth/`). No live app caller yet. |
| `stealth_scan_single` | Scans a viewing key against the announcement set inside MPC, so the viewing key is never reconstructed in clear by any single node. | SDK only. No live app caller yet. |
| `balance_audit`, `finalize_audit` | Confidential aggregation of multiple encrypted balances, then threshold reveal of the total. Used to produce a solvency proof without exposing individual balances. | SDK only (`packages/arcium-sdk/src/audit/`). No live app caller yet. |
| `private_vote`, `finalize_tally` | Multi-option encrypted ballot. Vote values are sealed; the tally is produced in MPC and only the totals are released. | SDK only (`packages/arcium-sdk/src/governance/`). No live app caller yet. |
| `private_vote_binary`, `finalize_tally_binary` | Same as above but specialised for yes or no votes (more efficient). | SDK only. |
| `sealed_bid_auction`, `finalize_auction` | Encrypted bid matching. Losing bids stay confidential. Winner determination happens in MPC. | SDK only (`packages/arcium-sdk/src/auction/`). No live app caller yet. |

Reality check: of the nine circuit families exposed by `p01_arcium`, three are wired into a real user-facing flow today (in the mobile app, behind an opt-in flag). The remaining circuits ship as part of the SDK so that integrators can use them, but Protocol 01 itself does not yet call them from a deployed UI. They are scaffolding, not vaporware, and the on-chain program supports them.

The web app references the SDK in its developer documentation (`apps/web/app/docs/page.tsx`), not in a runtime path.

## 3. End-to-end flow

Every MPC interaction follows the same three-phase pattern. This is by design in the Arcium model and is the key reason the Solana transaction size limit is not a blocker.

Phase 1, user-signed submission transaction:
1. The client creates an `ArciumClient`, calls `initialize()` which establishes an x25519 shared secret with the MXE account.
2. The client encrypts its inputs with RescueCipher (a hash-based CTR-mode construction). Output is a list of 32-byte ciphertext blocks, an ephemeral x25519 public key (32 bytes), and a 16-byte nonce.
3. The client picks a fresh 64-bit `computation_offset` and invokes the matching `queue_*` instruction on `p01_arcium`. The program performs a CPI into the Arcium runtime via `queue_computation(...)`.
4. The transaction lands on-chain. The encrypted payload is now queued for execution.

Phase 2, off-chain MPC execution (no Solana transactions, no user signature):
1. The Arcium ARX nodes pick up the queued computation and execute the corresponding circuit on secret shares.
2. The Cerberus protocol guarantees that as long as at least one node is honest, no single node ever sees the plaintext inputs.
3. Execution typically completes within a few seconds.

Phase 3, callback transaction (signed by the Arcium cluster):
1. The cluster posts a callback transaction that delivers a `SignedComputationOutputs<T>` payload.
2. The program's `*_callback` instruction verifies the cluster signature against the cluster account and the computation account, then either emits an event (for example `AuditTotalEvent`) or writes state into a PDA.
3. The user can decrypt revealed values locally with the same shared secret.

Concrete consequence: a "private vote" or a "balance audit" never tries to fit submission, computation, and result into one Solana transaction. The submission and the callback are two separate transactions, and the actual work happens off-chain between them.

## 4. Transaction size and account count analysis

Solana enforces two hard limits per transaction: 1232 bytes for the serialised message, and 64 unique accounts (35 writable in v0). Both limits are well respected by the Arcium queue pattern.

### 4.1 Accounts in a queue instruction

Every `queue_*` instruction in `p01_arcium` uses exactly the same 12 accounts (verified by reading lines 1823 through 2200 of `programs/p01_arcium/src/lib.rs`):

1. `payer` (signer, mut).
2. `sign_pda_account` (PDA owned by the program, derived from `SIGN_PDA_SEED`).
3. `mxe_account` (the MPC execution environment account, derived from the program ID).
4. `mempool_account` (mut, derived from MXE).
5. `executing_pool` (mut, derived from MXE).
6. `computation_account` (mut, derived from `computation_offset` and MXE).
7. `comp_def_account` (the computation definition for the circuit being called).
8. `cluster_account` (mut, derived from MXE).
9. `pool_account` (mut, fixed address `ARCIUM_FEE_POOL_ACCOUNT_ADDRESS`).
10. `clock_account` (mut, fixed address `ARCIUM_CLOCK_ACCOUNT_ADDRESS`).
11. `system_program`.
12. `arcium_program`.

Twelve accounts is far below the 64-account ceiling. Many of these are read-only or PDAs that the runtime derives, not user-supplied keys.

### 4.2 Instruction data size

The instruction payload for a typical queue is the union of:
- `computation_offset` (u64, 8 bytes).
- One or more 32-byte encrypted blocks (one per encrypted argument).
- The ephemeral x25519 public key (32 bytes).
- The 16-byte nonce.

Circuits in the catalog above use between one and five encrypted arguments, so instruction data is in the range of 64 to 200 bytes. After serialisation with the message header, accounts, signatures, and the CPI, the full transaction stays well under 600 bytes in the worst observed case. The 1232-byte limit gives a comfortable margin.

### 4.3 Where size could become a real concern (and is not)

There are three theoretical risks, all of them mitigated by the current design.

a) Large ciphertext blobs. Arcium's RescueCipher emits 32-byte blocks. Even circuits that take 8 encrypted values produce only 256 bytes of ciphertext. There is no per-argument ballooning.

b) Long remaining_accounts lists. Some instructions in `p01_arcium` (for example `finalize_audit`, `finalize_tally`) take additional remaining accounts for authority enforcement. The maximum observed is three additional accounts, bringing total to 15. Still far below 64.

c) Callback payload size. The Arcium runtime signs the output and the program verifies it. The output size is bounded by the circuit return type (struct fields, typically less than 512 bytes). Callbacks are their own transactions and do not stack with the submission.

In short, the async submission and callback split is what makes the Arcium pattern naturally fit Solana's per-transaction constraints. There is no single transaction in the entire flow that approaches the limit.

## 5. Current deployment and testing status

This section is intentionally blunt so that nothing is overclaimed.

### 5.1 What is real today

- The Rust program compiles. Encrypted instructions in `programs/p01_arcium/encrypted-ixs/src/lib.rs` build successfully against the Arcium toolchain.
- The TypeScript SDK is complete (8 modules, about 2400 lines of code), builds green, exports all 9 circuit families.
- The mobile app has three MPC services with real wiring (`confidentialRelay`, `nullifierCommit`, `privateLookup`) under an opt-in flag in `apps/mobile/stores/arciumStore.ts`.
- The previously deployed `p01_arcium` instance under program ID `9kMjmVMYxBa8V9D1aoEjZtUNXTe2gjfzYdKLycn7JvgQ` remains on devnet (the IDL and accounts are still resolvable).

### 5.2 What is not validated yet

- End-to-end devnet runs of every circuit through the real cluster, with screenshots or transaction signatures. Devnet wiring exists; a full pass per circuit has not been recorded as part of the public artifacts.
- Continuous deployment of `p01_arcium` from CI. The program is currently excluded from the `[programs.devnet]` and `[programs.localnet]` tables in `Anchor.toml` (see commits `70fbab9` and `2bc6b0f` from 2026-05-12).

### 5.3 Why `p01_arcium` is excluded from the Anchor program tables

Three reasons stack:
1. The Arcium build emits `.arcis` circuit binaries that are not checked into git, they are produced by the Arcium toolchain at build time, which CI does not yet run.
2. `anchor build` walks the `[programs.<cluster>]` map independently of the Cargo workspace exclude rules, so simply removing the crate from the workspace was not enough to unblock the whole-workspace build.
3. `arcium-client` 0.9.7 has a stack frame on the SBF target that overflows the 4 KB SBF stack limit, which blocked the SBF build of the entire workspace.

The pragmatic resolution applied for now is to keep `p01_arcium` out of the workspace and out of the Anchor program tables, and to build the program out-of-band when iterating on MPC code. The previously deployed devnet program continues to run.

This is a deliberate trade-off, not silent breakage. It is documented in the commit messages cited above.

## 6. Summary for technical reviewers

- Arcium is the MPC complement to the ZK and stealth layers, not a replacement.
- Nine circuit families are implemented on-chain and exposed by the SDK. Three are wired into the mobile app today. The other six ship as ready-to-call SDK modules.
- The submission plus off-chain MPC plus callback pattern means no single Solana transaction tries to do everything. The 1232-byte and 64-account limits are comfortably respected (12 accounts and well under 600 bytes per submission tx in the worst case observed).
- The program compiles and the SDK is complete. A full per-circuit devnet validation pass and CI redeployment are open items, gated by the Arcium toolchain integration described in section 5.3.

Reviewers who want to dig deeper:
- `programs/p01_arcium/src/lib.rs`, lines 100 to 1430 (program entrypoints, queue and callback pairs).
- `programs/p01_arcium/encrypted-ixs/src/lib.rs` (the actual circuits in Arcis).
- `packages/arcium-sdk/src/client.ts` (encryption pipeline and PDA derivation).
- `packages/arcium-sdk/README.md` (full API reference).
- `apps/mobile/services/arcium/` (live wiring).
