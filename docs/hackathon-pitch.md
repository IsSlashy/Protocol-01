# Protocol 01 — Privacy & Payments Layer for Solana

> **Plug-and-play SDKs. One rail, two modes: classic and private.**
> Confidential transfers, stealth addresses, shielded subscriptions, private vaults — in a few lines of code.

---

## The pitch in one paragraph

Protocol 01 is the privacy and payments layer Solana doesn't have yet. We ship a complete stack — **post-quantum ZK-STARKs**, **stealth addresses**, **on-chain stealth relayer**, **service registry**, **confidential SPL** — behind SDKs any app can drop in. Every flow exists in two parallel modes on the same rail: **classic** (transparent, fast, cheap) and **private** (STARK-shielded, unlinkable). Live on devnet today across mobile, extension, and web.

---

## Core tech

- **Post-quantum ZK-STARKs (Goldilocks end-to-end)** — Winterfell prover with Poseidon hashing. Six AIRs cover shield, unshield, transfer, confidential balance, pool commitment, and Merkle update. Hash-based, no trusted setup, no elliptic curves — quantum-resistant by design.
- **Native on-chain FRI verifier** — single multi-circuit Solana program verifies STARK proofs in **<1.4M CU** (most circuits <900K). DEEP-ALI on all 6 circuits, 124-bit soundness, sha256-syscall hashing. Zero Winterfell dependency at runtime.
- **Hybrid stealth addresses** — X25519 + ML-KEM-768 (NIST PQC standard) generate unlinkable one-time addresses, breaking the sender↔receiver link even against a quantum adversary.
- **Quantum-safe vault** — Winternitz one-time signatures (WOTS+ 67 chains, SHA-256) provide application-layer defense if Ed25519 is ever broken by Shor's algorithm.
- **On-chain stealth relayer with N-relayer failover** — `p01_relayer` lets a network of relayers submit unshields on behalf of users, breaking the depositor↔recipient tx-graph link. Auto-rotation across registered relayers with a liveness gate (`last_active_slot`) and chunked submission (`submit_job_chunked`) for proofs that exceed Solana's 1232-byte tx limit. Worker live on Railway.
- **Tx-opacity hardening (V3)** — uniform proof padding, scrubbed events, fee-escrow PDA, and a universal `LeafInserted` event (V4 pools) for deterministic Merkle recoverability across clients.
- **Arcium MPC bridge** — `p01_arcium` ships 9 MPC circuits and a `submit_confidential_relay` ix for off-chain MPC settlement, expanding the privacy surface beyond what STARKs alone can express.

---

## Payments — one rail, two modes

Every payment flow exists **classic** (transparent on-chain) and **private** (STARK-shielded). Same SDK, same UX, same fee model — apps choose per transaction.

- **Recurring (P2B subscriptions)** — merchants self-publish offers as on-chain PDAs through the **service registry**. Users subscribe in one tap; protocol auto-charges on schedule.
  - *Classic*: delegated allowance, low CU, public trail.
  - *Private*: each charge consumes a shielded note, settles via STARK, merchant receives funds with zero link to subscriber. Cancellation re-denominates the refund into private notes + stealth sweep for the dust — no clear balance ever touches the user's wallet.

- **P2P (ZK-STARK classic)** — send SOL or any SPL with a single STARK proof, note → note, one tx, no relayer, no merchant context. The simplest possible private payment. Optional add-ons on the same rail: stealth addressing, stealth relayer, note splitting/merging on a denominated pool.

- **P2B (checkout & invoicing)** — `merchant-sdk` generates an invoice with amount + memo commitment; buyer settles with a shielded note; merchant vault receives the funds without exposing the buyer. Compatible with stablecoin SPLs via `p01_zkspl`.

- **B2B (settlement & treasury)** — combines confidential SPL (Poseidon-encrypted balances), liquidity pool (instant unshield prefund), Arcium MPC (multi-leg netting, atomic swaps, compliance attestations), and fee splitter for revenue share — all on-chain, all verifiable.

Every payment — recurring, P2P, P2B, B2B, classic or private — pays the same automatic on-chain fee (**0.3–0.5%**) through `p01-fee-splitter`. **One protocol, one fee rail, every payment shape covered.**

---

## What's shipped

| Surface | Status |
|---|---|
| **12 Solana programs** | STARK verifier, shielded pool (V4), subscription vault, service registry, P2P escrow, stealth relayer (chunked), quantum-safe vault, confidential SPL, liquidity pool, fee splitter, privacy router, Arcium MPC bridge |
| **6 STARK AIRs** | Native on-chain multi-circuit verifier |
| **8+ TypeScript SDKs** | specter-sdk, merchant-sdk, privacy-sdk, zkspl-sdk, p01-js, whitelist-sdk, arcium-sdk, react-native-zk |
| **3 clients** | Android app, Chrome MV3 extension, Next.js web app |
| **Live demo** | Service registry populated with 4 attested merchants on devnet — any wallet can shield, unshield, transfer, subscribe, and cancel privately today |

---

## Why it matters

Solana's lack of a native privacy layer is the single biggest blocker for institutional payments, payroll, B2B settlement, and consumer subscriptions. Existing privacy projects on Solana are siloed (Elusiv shut down, Light is L2-only, Arcium is MPC-only). **Protocol 01 is the only stack that ships transfers, subscriptions, stealth addresses, confidential SPL, MPC, and a relayer network behind one SDK** — and the only one that's already post-quantum.

Built solo, end-to-end, in ~100 days. Live on devnet. Mainnet-ready after one external audit.
