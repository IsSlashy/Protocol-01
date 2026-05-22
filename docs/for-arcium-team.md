# Protocol 01, with Arcium inside

A short technical note for the Arcium team, written in the same plain style we use for the rest of Protocol 01.

## Why we picked Arcium

Protocol 01 is the privacy layer Solana doesn't have yet. The core of the protocol is built around post-quantum ZK-STARKs (Winterfell, Poseidon over Goldilocks), stealth addresses (X25519 plus ML-KEM-768), and on-chain verification. That stack covers shield, unshield, transfer, confidential balances, and Merkle updates. It does not cover the class of problems where the secret inputs come from more than one party, or where the secrecy needs to survive past the result.

That is exactly the gap Arcium fills. We did not want to fake MPC with a trusted off-chain service, and we did not want to skip those use cases entirely. The Arcium model, secret shares over a real network, threshold reveal, signed callbacks on Solana, gave us a path to ship those flows without compromising the trust model we built everywhere else.

## What we built on top of Arcium

One Solana program, `p01_arcium`, ships with nine confidential computation definitions written in Arcis. Each one has its own queue and callback pair, registered cleanly through `comp_def_offset` and `init_computation_definition_accounts`. The whole program lives in `programs/p01_arcium/` and weighs about 3.5k lines including the encrypted instructions.

On top of that program, we wrote `@protocol-01/arcium-sdk`, a TypeScript SDK organised by use case rather than by raw circuit. Eight modules, each one a thin wrapper that handles `ArciumClient` setup, RescueCipher encryption, ephemeral key rotation every 10 operations, computation offset generation, PDA derivation, and result decryption. About 2400 lines, dependency-light, builds standalone.

Mapping the modules to the circuits we registered on-chain (Mugen module excluded from this note):

- Relay, circuit `threshold_decrypt`. N-of-M MPC nodes jointly decrypt and submit a Solana transaction. The user wallet never appears as the fee payer or as a signer on-chain. This is our path to remove the last centralised relayer in the stack.
- Nullifier, circuit `nullifier_commit`. SHA3 commitment over a nullifier computed entirely in MPC. Prevents double-spend without revealing the actual nullifier value to any single party.
- Registry, circuit `private_lookup`. Lookup of a meta-address without revealing which key is being queried, so no RPC node can correlate a lookup with a sender.
- Audit, circuits `balance_audit` and `finalize_audit`. Confidential aggregation across many encrypted balances, then a threshold reveal of just the total. Solvency proofs without disclosing individual balances.
- Governance, circuits `private_vote` plus `finalize_tally`, with `private_vote_binary` plus `finalize_tally_binary` for the yes-no case. Encrypted ballots, results computed in MPC, only the totals released.
- Auction, circuits `sealed_bid_auction` and `finalize_auction`. Encrypted bid matching, with losing bids staying confidential after settlement.
- Stealth, circuits `register_viewing_key` and `stealth_scan_single`. Viewing keys stored under MPC, scanning done so that no single node ever reconstructs the viewing key in clear.

Each of these modules takes an `ArciumClient` and an Anchor `Program`, returns a typed result, and surfaces clean error messages when the cluster is unreachable or the inputs are invalid.

## Where it sits in the protocol

Inside Protocol 01, Arcium is one of three privacy primitives, not the only one. We treat them as complementary.

- ZK-STARKs handle the hot path (a single user proves a single statement about their own state).
- Stealth addressing handles the receive side (recipient identity privacy).
- Arcium handles everything that needs joint computation across parties, or sealed inputs that must remain sealed after the result is revealed.

Concretely, the protocol's user flow stays ZK-STARK first. Arcium activates for opt-in features (today) and as the eventual default for the threshold relayer (next milestone). We did not bolt Arcium on top of an unrelated stack, we extended the privacy surface where ZK alone could not go.

## How it actually flows on-chain

We adopted the same three-phase pattern across every circuit, which is also what makes Solana's per-transaction limits a non-issue in practice.

1. The user transaction encrypts the inputs with RescueCipher and calls our queue instruction, which CPIs into the Arcium runtime. The whole queue instruction uses 12 accounts (payer, sign PDA, MXE, mempool, executing pool, computation account, comp def, cluster, fee pool, clock, system, arcium program) and the data payload is in the 64-to-200 byte range depending on how many encrypted arguments the circuit takes. Comfortably under the 1232-byte limit, comfortably under the 64-account ceiling.
2. The ARX nodes run the circuit on secret shares. Nothing on-chain.
3. The Arcium-signed callback transaction lands on the program. Our `*_callback` handler verifies the cluster signature against `cluster_account` and `computation_account`, then either emits a typed event (for example `AuditTotalEvent`) or updates a PDA. The user decrypts the revealed value locally with the same shared secret.

We never try to fit submission, MPC, and result into a single tx. The async split is the design.

## What is live today

- The Rust program compiles, the encrypted instructions build through the Arcium toolchain.
- The TypeScript SDK is complete, builds green, exports all nine circuit families.
- The mobile app wires three of them into user-facing flows behind an opt-in flag (`apps/mobile/services/arcium/` plus `apps/mobile/stores/arciumStore.ts`): the confidential relay (`threshold_decrypt`), the private nullifier commit, and the private registry lookup.
- The previously deployed program ID on devnet, `9kMjmVMYxBa8V9D1aoEjZtUNXTe2gjfzYdKLycn7JvgQ`, remains live and resolvable.

## What we are still working on

We try to stay honest about this part rather than overclaim.

- A full per-circuit devnet validation pass, with transaction signatures and screenshots for each callback, is still pending. The wiring exists, the recorded artifacts do not yet.
- `p01_arcium` is temporarily excluded from the `[programs.devnet]` and `[programs.localnet]` tables in `Anchor.toml` (commits `70fbab9` and `2bc6b0f` on 2026-05-12). Three reasons stack: the `.arcis` circuit binaries are generated by the Arcium toolchain at build time and are not checked into git, `anchor build` walks the program tables independently of the Cargo workspace exclude rules, and `arcium-client 0.9.7` overflows the 4 KB SBF stack which blocked the whole-workspace build. We currently build `p01_arcium` out-of-band and keep the devnet deployment frozen. This is documented in the commit messages, not silent breakage.
- The next milestone is to integrate the Arcium toolchain into CI so the program redeploys cleanly alongside the rest of the workspace, then run the full per-circuit validation pass.

## Closing note

We are solo built (Volta Team, end of January 2026 to today) and we picked Arcium deliberately, not as a checkbox. Six of the nine circuits are SDK-ready scaffolding for now, but we wrote them because they belong in the protocol's roadmap, not to inflate a feature count. The three that are wired today are the ones that meaningfully change the trust model of the mobile app.

If anything in this note reads wrong from the inside, we would rather hear it now than ship it. Feedback, integration hints, or a pointer toward the right Arcis idioms for the circuits we have not yet pushed to devnet are all very welcome.

Repository: github.com/IsSlashy/Protocol-01
Direct path to the integration: `programs/p01_arcium/`, `packages/arcium-sdk/`, `apps/mobile/services/arcium/`
