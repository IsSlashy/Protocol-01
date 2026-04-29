# Protocol 01 — Colosseum Frontier Submission

## One-liner

**The privacy layer for Solana — ZK proofs, stealth addresses, and post-quantum STARKs in one mobile app.**

---

## Short Description (for project card)

Protocol 01 brings full financial privacy to Solana. Shield SOL, send it privately, receive to untraceable stealth addresses — all proven with zero-knowledge proofs generated on your phone. No backend. No trusted third party. Just math.

Built by one developer in 70 days.
14 Solana programs deployed on devnet (plus 2 experimental).
6 STARK AIRs covering the full hot path.
130K+ lines of code.
One ~97MB Android app that does it all.

---

## Full Description

### The Problem

Solana is fast, cheap, and completely transparent. Every transaction, every balance, every interaction is permanently visible on-chain. This makes Solana unusable for:

- **Payroll** — employees see each other's salaries
- **Subscriptions** — services know your full wallet history
- **Donations** — political contributions are permanently public
- **Business payments** — competitors see your treasury flows
- **Personal finance** — anyone with your address sees everything

Existing "privacy" on Solana is fragmented: pool-based mixers (Cloak, Hush) break one link but can't hide recipients. Arcium MPC wrappers (Umbra, Light 2.0) encrypt computation but depend on a single off-chain primitive. Token-2022 Confidential Balances hide amounts but not addresses. No one has combined these approaches into a complete, trustless, on-chain privacy layer with stealth addressing, on-device proving, and quantum resistance.

### The Solution

Protocol 01 is a **protocol-level privacy layer** for Solana.
It uses post-quantum STARK proofs over the Goldilocks field, stealth addresses (ECDH + ML-KEM-768), multi-party computation (Arcium), and on-chain verification to make transactions untraceable, without leaving Solana.
Groth16 is retained only for two narrow surfaces (compliance attestations, sealed-bid auction escrow), both off the hot path.

**How it works:**

```
User deposits SOL into shielded pool
  → Receives a private "note" (Poseidon commitment on-chain)
    → To spend: generates a ZK proof on-device (no server)
      → Proof verified on-chain by trustless relayer
        → Funds sent to a one-time stealth address
          → No on-chain link between sender and recipient
```

Everything happens on Solana.
No bridge.
No relayer server.
The hot path is STARK-only, so no trusted setup is required for shield, transfer, unshield, subscribe, cancel, or merkle update.

### What Makes This Different

**1. Fully trustless, spending key never leaves your device**

The STARK proof is generated locally on mobile, inside the app process.
There is no remote prover fallback.
If your phone can't prove it, it doesn't get proved.
This is a hard security guarantee, not a configuration option.

**2. Post-quantum by default, Groth16 removed from the hot path**

Groth16 (BN254) is vulnerable to Shor's algorithm.
The April 2026 STARK migration is complete: shield, transfer, unshield, subscribe, cancel, and merkle-update on `zk_shielded` and `p01_zkspl` now run STARK-only, end-to-end.
Proofs are generated on-device against six AIRs over the Goldilocks field (2^64 - 2^32 + 1) with a Poseidon hash chain.
The on-chain FRI verifier is custom-built (no Winterfell dependency at runtime) and already deployed on devnet.
Two narrow Groth16 surfaces remain by design and both sit off the hot path: an optional compliance overlay inside `privacy-sdk` (for selective audit attestations), and the sealed-bid auction escrow used by the OTC primitive.

**3. Stealth addresses with post-quantum key exchange**

Recipients register a stealth meta-address (spending + viewing public keys). Senders derive one-time addresses using ECDH. For quantum resistance, we also support ML-KEM-768 (Kyber) key encapsulation — the NIST post-quantum standard. The recipient scans the chain to detect payments using only their viewing key.

**4. Multi-party computation via Arcium**

Some privacy operations can't be solved with ZK alone — they require distributed computation where no single party sees the plaintext. We integrated 9 MPC circuits on Arcium's decentralized compute network:

- Confidential relay (hidden transaction routing)
- Anonymous registry (private address lookup)
- Hidden nullifier generation (distributed double-spend prevention)
- Balance audit (prove solvency without revealing amounts)
- Stealth scan (distributed payment detection)
- Private voting (encrypted governance)

**5. Real mobile app, not a demo**

Protocol 01 ships as a ~97MB Android APK (release v0.9.9, 100,860,376 bytes) with:
- Full wallet (create, import, send, receive, airdrop)
- Privacy zone (shield, unshield, private send, stealth receive)
- Confidential balances (Poseidon commitments, balance proofs)
- Fixed-denomination privacy pools (0.1, 0.5, 1, 5, 10 SOL)
- Payment streams with optional privacy (amount noise, timing noise, stealth addresses)
- Subscription management with STARK-proof payments
- On-device STARK proof generation (Goldilocks AIRs, Poseidon hashing)
- Quantum-safe vault (Winternitz OTS, hash-timelock, commit-reveal)

---

## Technical Architecture

### Solana Programs (14 deployed on devnet, 2 experimental)

Devnet program IDs are sourced from `Anchor.toml [programs.devnet]`.

| Program | Description | Devnet address |
|---------|-------------|----------------|
| zk_shielded | Shielded pool, STARK-only hot path (shield/unshield/transfer) | `2w4WRvujjrZYip1dUrp3X4nzoPVWeRZF9KnjtvSstGms` |
| p01_zkspl | Confidential balances with Poseidon commitments, STARK-only | `AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT` |
| specter | Stealth address registry + private payment streams | `8rywsvheQZPp8efQ4bsZ37J9GWMLY2ER76f3o8opPsYh` |
| p01_relayer | On-chain relay instruction handlers + fee accounting | `Ud2JYaq4frePBy3L2DmddmtPT3nXC1nqxsXEX934Hbw` |
| p01_stark_verifier | Custom FRI verifier, 6 AIRs, Goldilocks field | `EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z` |
| p01_quantum_vault | 3-layer quantum-safe vault (WOTS+, hash-timelock, commit-reveal) | `9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv` |
| p01_registry | Stealth meta-address directory (EIP-5564 adapted for Solana) | `QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB` |
| p01_arcium | 9 MPC circuits on Arcium decentralized compute | `9kMjmVMYxBa8V9D1aoEjZtUNXTe2gjfzYdKLycn7JvgQ` |
| p01_fee_splitter | Protocol fee routing (0.25%) | `UdxXEvcAzmGsqUtoBgnNkbmfnky4En2kLxNnsVQU5BM` |
| p01_subscription | Recurring payments with delegated authority | `3eDvPJTK2gryh3GhjFgwz94iBsE3hsqZL9ChAFyiBThW` |
| p01_stream | Time-locked payment streaming (escrow-based) | `C92xDDAtd21ED3MitZJ9dhuyGeig5xVx8Dgg6qrxA3vx` |
| p01_whitelist | Developer access control | `5PSYrjBKke4gj8BgBgRKZNXgjmLCnojZ5yuDqUvPiG33` |
| p01_mugen | Mugen merchant integration program | `EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN` |
| p01_liquidity | Instant-unshield liquidity pool (LP shares + settler) | devnet (`6PfFkvj…`) |

Two further programs (`p01_bundler`, additional liquidity primitives) sit in the repo as experimental and are not currently part of the deployed surface.

### Zero-Knowledge Circuits

**STARK AIRs (Goldilocks field, Poseidon hashing), 6 circuits, hot path:**

| AIR | Trace Width | Trace Length | Purpose |
|-----|-------------|-------------|---------|
| subscriber_ownership | 3 | 32 | Subscription proof (post-quantum) |
| pool_commitment | 3 | 32 | Pool membership |
| balance_proof | 3 | 32 | Balance sufficiency |
| merkle_path | 4 | 64 | Merkle inclusion |
| confidential_balance | 4 | 256 | Balance commitment (cascaded hashing) |
| transfer | 6 | 512 | Private transfer (14 active hash cycles) |

These six AIRs cover every hot-path operation: shield, transfer, unshield, subscribe, cancel-subscription, and merkle-update.
Proofs verify on-chain through the custom FRI verifier (`p01_stark_verifier`) within the 1.4M CU budget.

**Groth16 (Circom), legacy March 2026, off-hot-path only:**

The original Circom sources are kept in-tree for migration history.
Two surfaces still rely on Groth16 by design:

- *Compliance overlay* (`privacy-sdk/compliance.ts`) — optional, opt-in audit attestations for merchants who need selective disclosure. Sits outside the shielded pool flow.
- *Sealed-bid auction escrow* (`escrow_bid` circuit) — used by the OTC primitive for hidden-bid resolution, also outside the hot path.

Everything else previously proven in Groth16 (transfer, note_split, denominated_pool, denominated_transfer, confidential_balance, balance_proof, subscriber_ownership, merkle) is now STARK.

### Codebase Stats

| Metric | Count |
|--------|-------|
| Rust (programs + STARK prover) | 50,153 lines |
| TypeScript (mobile + SDKs) | 45,995 lines |
| Circom (legacy, kept for migration history) | 33,248 lines |
| Total | **~130,000 lines** |
| Solana programs deployed (devnet) | 14 |
| Experimental / unreleased programs | 2 |
| STARK AIRs (hot path) | 6 |
| Groth16 circuits retained off hot path | 2 (compliance, escrow_bid) |
| MPC circuits (Arcium) | 9 |
| SDKs published / migration-complete | 8 |
| Test files | 28+ |
| Development time | ~70 days solo |

---

## Competitive Landscape

Privacy on Solana is heating up. Across 5 Colosseum hackathons (Hyperdrive through Cypherpunk), 25+ privacy/ZK projects have been submitted. Most solve **one piece** of the puzzle. Protocol 01 solves **all of them**.

### What the judges have already seen

- **Pool-based mixers** — Cloak (3rd Stablecoins, Cypherpunk Sep 2025, now Accelerator C4), Hush (Breakout), Solana Mixer (Breakout, SP1 zkVM), Radr (Cypherpunk, Groth16), Zask (Breakout, yield-bearing), Voidify (Cypherpunk). All do deposit→pool→withdraw mixing. None have stealth addresses, STARKs, or on-device provers.
- **Private DEX / DeFi** — Blackpool → DARKLAKE (2nd DeFi, Radar Sep 2024, Accelerator C2), Encifher (3rd DeFi, Breakout Apr 2025). Both focus on hiding trading strategies, not general financial privacy.
- **Arcium MPC wrappers** — Umbra (HM Stablecoins, Breakout, now running SDK cohort), Light 2.0 (Cypherpunk), Incognito Protocol (Cypherpunk), Degen Cash (Accelerator C1). All rely on Arcium as their sole privacy primitive — no ZK circuits, no stealth addresses, no quantum resistance.
- **Token-2022 Confidential Balances** — ConfiX (Breakout), Zera (Cypherpunk), Rupiah Digital (Breakout). Use Solana's native confidential transfers. Limited to amount hiding; sender/receiver addresses remain public.
- **Post-quantum (research only)** — dirac-crypto (Breakout), Terra Dourada (Cypherpunk). No deployed programs, no production-ready stack.

### What NO ONE has built — and we already have

| Gap | Status on Solana | Protocol 01 |
|-----|-----------------|-------------|
| **Stealth addresses** (EIP-5564) | NinjaPay/Privment mention it — no actual on-chain registry | Full stealth meta-address protocol: p01_registry program + ECDH + ML-KEM-768 key exchange |
| **On-chain STARK/FRI verifier** | Zero competitors | Custom FRI verifier, 6 circuit types, Goldilocks field, deployed on devnet (447KB) |
| **Post-quantum privacy stack** | dirac-crypto = research paper | ML-KEM-768 stealth addresses + WOTS+ vault + Poseidon STARKs, post-quantum end-to-end on the hot path |
| **On-device proof generation** | Most use server-side provers | STARK proofs generated locally on mobile, zero backend, hard security guarantee |
| **Full-stack privacy protocol** | Everyone does one thing | 14 programs: shielded pools + stealth + confidential balances + streams + subscriptions + MPC + quantum vault + relayer + liquidity |
| **Shipped mobile app** | Most are web demos or CLIs | ~97MB Android APK (v0.9.9), 4 tabs, full wallet + privacy + streams + AI agent |
| **STARK + MPC combination** | Umbra = MPC only; Radr = ZK only | 6 STARKs (hot path) + 9 Arcium MPC circuits working together, with two narrow Groth16 surfaces retained for compliance and OTC escrow |

### Key accelerator/winner projects to differentiate from

- **DARKLAKE** (Blackpool, C2 accelerator): Private DEX only — no general payments, no stealth, no mobile app
- **Cloak** (C4 accelerator): Pool mixer only — no ZK proofs (uses randomized outputs), no stealth, no quantum resistance
- **Umbra** (SDK cohort): Arcium MPC only — powerful but single-primitive, no on-device proving, no STARKs

**Protocol 01's moat: depth of stack + breadth of features + solo-dev credibility.**

---

## Why Frontier IE / Quantum Ireland

The Superteam Ireland regional track is judged by the Quantum Ireland panel on three criteria: Ecosystem Impact on Solana, Product-Market Fit on Solana, and User Growth Potential.
Protocol 01 is the only project in the cohort whose technical stack genuinely earns the "quantum" framing of the partnership.

- **First FRI/STARK verifier on Solana.** `p01_stark_verifier` is a custom on-chain FRI verifier over Goldilocks, deployed on devnet, fitting the 1.4M CU budget. No other project in the hackathon ships an on-chain STARK verifier.
- **Post-quantum primitives, not slideware.** ML-KEM-768 (NIST FIPS 203) for key encapsulation in stealth addresses, WOTS+ hash-based signatures inside `p01_quantum_vault`, Poseidon-over-Goldilocks STARK proofs for every shielded operation. These are wired into the deployed programs, not described in a paper.
- **Hot path is post-quantum end-to-end.** Shield, transfer, unshield, subscribe, cancel, and merkle-update on `zk_shielded` and `p01_zkspl` use STARK proofs only. Groth16 remains for two narrow off-path surfaces (compliance attestations, OTC sealed-bid escrow) where the trade-off is intentional.
- **Quantum framing the panel can verify.** All claims map to on-chain program IDs, npm-published SDKs, and a release APK. A reviewer can install the app or fetch the verifier binary the same afternoon.

## Ecosystem Impact on Solana

Protocol 01 ships infrastructure other Solana teams can reuse today.

- 14 Anchor programs deployed on devnet, addresses listed above and in `Anchor.toml`.
- 8 npm-published SDKs covering shield, stealth, confidential balances, streams, subscriptions, vault, relay, and the unified `@protocol-01/privacy-sdk` umbrella.
- Custom FRI verifier and Goldilocks field arithmetic exposed as a Rust crate, reusable by any Anchor program that wants STARK verification.
- Stealth address registry (`p01_registry`, EIP-5564 adapted for Solana) usable by any wallet that wants to issue meta-addresses.
- Mugen integration program (`p01_mugen`) demonstrates the merchant integration pattern end-to-end.

This is the Bonsol / Confidential Balances category of contribution: foundational primitives that other builders can pick up rather than a single end-user app.

## Product-Market Fit on Solana

The commercial wrapper for Protocol 01 is **private recurring subscriptions, P2P and P2B**.

- `p01_subscription` handles recurring payments with delegated authority.
- `p01_registry` lets merchants publish a stealth meta-address; subscribers send to one-time addresses derived via ECDH + ML-KEM-768.
- `p01_relayer` settles payments on-chain with no backend.
- The shielded pool gives subscribers cover traffic so individual payments are not linkable to a wallet history.
- `privacy-sdk/subscriptions` and `privacy-sdk/streams` give merchants a Stripe-shaped TypeScript surface, drop-in for React and React Native via `@protocol-01/privacy-sdk/react`.

The reference integration is **Mugen**, a Solana-native merchant whose mobile app already imports the SDK and consumes the registry program (`p01_mugen`).
The pitch is concrete: any Solana merchant can take payments on a recurring schedule without exposing their treasury or their customers' wallet history, using the same code path Mugen uses.

## User Growth Potential

The acquisition funnel is built into the SDK itself: a merchant who integrates Protocol 01 to take subscription payments simultaneously exposes their users to the privacy zone, the shield primitive, and the stealth wallet.
Every B2B integration multiplies the consumer surface.

- **Android APK live.** Release v0.9.9 (~97MB), full wallet + privacy + streams + agent tabs, downloadable from the GitHub releases page.
- **Chrome extension installable.** The browser extension ships the same shielded pool and stealth flows for desktop users.
- **8 SDKs published to npm.** `@protocol-01/privacy-sdk` plus 7 specialised packages, each with a deprecation/canonical mapping documented in `docs/MIGRATION.md`.
- **4 demo screens.** Wallet, Privacy, Streams, and Agent, each runnable against devnet without any centralised backend.
- **Solo-dev velocity, ~70 days.** All 14 programs, 6 STARK AIRs, mobile app, extension, and SDKs were built and migrated to STARK by one engineer, evidence the stack is small enough for new contributors to onboard fast.

---

## Demo

- **Live APK**: [Download v0.9.9](https://github.com/IsSlashy/Protocol-01-releases/releases/tag/v0.9.9) (~97 MB, Android, 100,860,376 bytes)
- **Website**: https://protocol-01.dev
- **Video demo**: [link]
- **14 programs deployed on Solana devnet**, addresses verifiable against `Anchor.toml`

---

## Team

**Slashy Fx** — Solo developer, Volta Team

Full-stack blockchain engineer.
Built all 14 deployed Solana programs, 6 STARK AIRs, the legacy Circom circuits, the mobile app, the browser extension, the web frontend, and all 8 SDKs.
From circuit design to pixel-perfect UI, one person, ~70 days.

- Twitter/X: [@Protocol01_](https://x.com/Protocol01_)
- GitHub: [IsSlashy](https://github.com/IsSlashy)

---

## What's Next

- **Mainnet deployment** — programs are devnet-ready, audit needed
- **iOS app** — same codebase (Expo/React Native), needs Apple Developer account
- **SDK documentation** — developer onboarding for integrators
- **Token launch** — protocol governance + fee distribution
- **Security audit** — formal verification of ZK circuits and Solana programs

---

## Why This Matters

Privacy is not a feature — it's a right. Solana has the speed and cost structure to be the global payments network, but it can't get there without privacy. Protocol 01 makes every SOL transaction optionally private, using math instead of trust, running entirely on-chain, with no server to shut down and no key to seize.

This is what financial sovereignty looks like on Solana.
