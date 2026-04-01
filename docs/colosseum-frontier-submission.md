# Protocol 01 — Colosseum Frontier Submission

## One-liner

**The privacy layer for Solana — ZK proofs, stealth addresses, and post-quantum STARKs in one mobile app.**

---

## Short Description (for project card)

Protocol 01 brings full financial privacy to Solana. Shield SOL, send it privately, receive to untraceable stealth addresses — all proven with zero-knowledge proofs generated on your phone. No backend. No trusted third party. Just math.

Built by one developer in 70 days. 15 Solana programs on devnet. 9 ZK circuits. 6 STARK AIRs. 130K+ lines of code. One 191MB Android app that does it all.

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

Protocol 01 is a **protocol-level privacy layer** for Solana. It uses zero-knowledge proofs (Groth16 + STARKs), stealth addresses (ECDH + ML-KEM), multi-party computation (Arcium), and on-chain verification to make transactions untraceable — without leaving Solana.

**How it works:**

```
User deposits SOL into shielded pool
  → Receives a private "note" (Poseidon commitment on-chain)
    → To spend: generates a ZK proof on-device (no server)
      → Proof verified on-chain by trustless relayer
        → Funds sent to a one-time stealth address
          → No on-chain link between sender and recipient
```

Everything happens on Solana. No bridge. No relayer server. No trusted setup beyond the initial Groth16 ceremony.

### What Makes This Different

**1. Fully trustless — spending key never leaves your device**

The ZK proof is generated locally using a WebView-based prover on mobile. There is no remote prover fallback. If your phone can't prove it, it doesn't get proved. This is a hard security guarantee, not a configuration option.

**2. Post-quantum ready — STARK migration is complete**

Groth16 (BN254) is vulnerable to Shor's algorithm. We built a complete parallel proof system using STARKs over Goldilocks field (2^64 - 2^32 + 1) with Poseidon AIR. The on-chain FRI verifier is custom-built (no Winterfell dependency), supports 6 circuit types, and is already deployed on devnet. Both proof systems work — users can choose Groth16 (smaller proofs, ~200 bytes) or STARKs (quantum-resistant, ~9KB proofs).

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

**5. Real mobile app — not a demo**

Protocol 01 ships as a 191MB Android APK with:
- Full wallet (create, import, send, receive, airdrop)
- Privacy zone (shield, unshield, private send, stealth receive)
- Confidential balances (Poseidon commitments, balance proofs)
- Fixed-denomination privacy pools (0.1, 0.5, 1, 5, 10 SOL)
- Payment streams with optional privacy (amount noise, timing noise, stealth addresses)
- Subscription management with ZK-proof payments
- On-device ZK proof generation (Groth16 via WebView, STARKs via WASM)
- Quantum-safe vault (Winternitz OTS, hash-timelock, commit-reveal)

---

## Technical Architecture

### Solana Programs (15 deployed on devnet)

| Program | Description | Address |
|---------|-------------|---------|
| zk_shielded | Shielded pool — shield/unshield/transfer with Groth16 + STARK | `GbVM5yve...j27c` |
| p01_zkspl | Confidential balances with Poseidon commitments | `EqppogLB...Ppah` |
| specter | Stealth address registry + private payment streams | `2tuztgD9...fbSp` |
| p01_trustless | On-chain trustless nullifier registry (no backend) | `FnTmMxsN...i43Q` |
| p01_relayer | On-chain relay instruction handlers + fee accounting | `2okhzLVr...5WpW` |
| p01_stark_verifier | Custom FRI verifier — 6 circuits, Goldilocks field | `DGY37k3J...QvSs` |
| p01_quantum_vault | 3-layer quantum-safe vault (WOTS+, hash-timelock, commit-reveal) | `HazoS6VK...Th7o` |
| p01_registry | Stealth meta-address directory (EIP-5564 adapted for Solana) | `QaQwpvBi...hQB` |
| p01_arcium | 9 MPC circuits on Arcium decentralized compute | `FH1JiQRU...TLPT` |
| p01-fee-splitter | Protocol fee routing (0.25%) | `UdxXEvcA...5BM` |
| subscription | Recurring payments with delegated authority | devnet |
| stream | Time-locked payment streaming (escrow-based) | devnet |
| whitelist | Developer access control | devnet |
| p01_bundler | Transaction bundler for multi-step privacy operations | devnet |

### Zero-Knowledge Circuits

**Groth16 (Circom) — 9 circuits, 33K+ lines:**

| Circuit | Constraints | Purpose |
|---------|-------------|---------|
| transfer | 12,222 | 2-in-2-out private transfer (UTXO model) |
| note_split | ~10,000 | Split shielded notes |
| denominated_pool | 4,273 | Fixed-denomination privacy pool |
| denominated_transfer | ~4,500 | Transfer between denomination pools |
| confidential_balance | 1,382 | Poseidon balance commitment |
| balance_proof | 644 | Balance sufficiency proof (range proof) |
| subscriber_ownership | ~800 | Prove subscription ownership without revealing identity |
| merkle | ~500 | Merkle inclusion proof |
| poseidon | — | Shared hash component |

**STARKs (Winterfell AIR) — 6 circuits, all with compact proof format (~9KB):**

| AIR | Trace Width | Trace Length | Purpose |
|-----|-------------|-------------|---------|
| subscriber_ownership | 3 | 32 | Subscription proof (quantum-resistant) |
| pool_commitment | 3 | 32 | Pool membership |
| balance_proof | 3 | 32 | Balance sufficiency |
| merkle_path | 4 | 64 | Merkle inclusion |
| confidential_balance | 4 | 256 | Balance commitment (cascaded hashing) |
| transfer | 6 | 512 | Private transfer (14 active hash cycles) |

### Codebase Stats

| Metric | Count |
|--------|-------|
| Rust (programs + STARK prover) | 50,153 lines |
| TypeScript (mobile + SDKs) | 45,995 lines |
| Circom (ZK circuits) | 33,248 lines |
| Total | **~130,000 lines** |
| Solana programs | 15 |
| ZK circuits (Groth16) | 9 |
| STARK AIRs | 6 |
| MPC circuits (Arcium) | 9 |
| SDKs published | 8 |
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
| **Post-quantum privacy stack** | dirac-crypto = research paper | ML-KEM stealth addresses + WOTS+ vault + Poseidon STARKs + dual proof system |
| **On-device ZK proof generation** | Most use server-side provers | WebView Groth16 + WASM STARKs, zero backend, hard security guarantee |
| **Full-stack privacy protocol** | Everyone does one thing | 15 programs: shielded pools + stealth + confidential balances + streams + subscriptions + MPC + quantum vault + nullifiers + relayer |
| **Shipped mobile app** | Most are web demos or CLIs | 191MB Android APK, 4 tabs, full wallet + privacy + streams + AI agent |
| **ZK + MPC combination** | Umbra = MPC only; Radr = ZK only | 9 Groth16 circuits + 6 STARKs + 9 Arcium MPC circuits working together |

### Key accelerator/winner projects to differentiate from

- **DARKLAKE** (Blackpool, C2 accelerator): Private DEX only — no general payments, no stealth, no mobile app
- **Cloak** (C4 accelerator): Pool mixer only — no ZK proofs (uses randomized outputs), no stealth, no quantum resistance
- **Umbra** (SDK cohort): Arcium MPC only — powerful but single-primitive, no on-device proving, no STARKs

**Protocol 01's moat: depth of stack + breadth of features + solo-dev credibility.**

---

## Track Recommendation: Infrastructure

**Why Infrastructure over DeFi:**

1. **Judges already awarded DeFi prizes** to DARKLAKE (2nd, Radar) and Encifher (3rd, Breakout) for privacy. Competing in DeFi means being compared to established accelerator companies.
2. **The unique value is infra-level**: custom FRI verifier, stealth address protocol, post-quantum primitives, 8 composable SDKs. These are developer tools, not just a consumer product.
3. **Colosseum Codex** (blog, Apr 2025) highlighted Confidential Balances and Bonsol as key infrastructure. Protocol 01 builds on and extends this same category.
4. **Infrastructure winners tend to be novel primitives**: Torque (2nd Infra, Renaissance), Solana Async Runtime (HM Infra, Breakout). Protocol 01's STARK verifier and stealth protocol fit this pattern.
5. **The mobile app is the demo, not the product**. The product is the protocol — programs, circuits, SDKs that any wallet or dApp can integrate.

**Backup: DeFi track** if Frontier combines or renames tracks. The private payments + streams + subscriptions story is strong for DeFi judges.

### Track Fit: Infrastructure

Protocol 01 provides foundational privacy infrastructure for Solana:
- On-chain ZK verifier (Groth16 via alt_bn128 syscalls)
- On-chain STARK/FRI verifier (custom, no external dependencies) — **first on Solana**
- Stealth address protocol (adapted EIP-5564 for Solana) — **first on Solana**
- Post-quantum cryptographic primitives (ML-KEM, WOTS+, Poseidon STARKs) — **first on Solana**
- On-chain trustless relayer (no backend server)
- 8 composable SDKs for developers to integrate privacy
- Revenue model: 0.25% protocol fee via p01-fee-splitter

---

## Demo

- **Live APK**: [Download v0.9.4](https://github.com/IsSlashy/Protocol-01-releases/releases/tag/v0.9.4) (191 MB, Android)
- **Website**: https://protocol-01.vercel.app
- **Video demo**: [link]
- **All 15 programs deployed on Solana devnet** — fully verifiable on-chain

---

## Team

**Slashy Fx** — Solo developer, Volta Team

Full-stack blockchain engineer. Built all 15 Solana programs, 9 ZK circuits, 6 STARK AIRs, the mobile app, the browser extension, the web frontend, and all 8 SDKs. From circuit design to pixel-perfect UI, one person, 70 days.

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
