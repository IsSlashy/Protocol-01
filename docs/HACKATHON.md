# Protocol 01 — Hackathon Evaluator Guide

> Quick start for Colosseum Frontier judges (Superteam IE / Quantum Ireland track).
> Full pitch in [colosseum-frontier-submission.md](./colosseum-frontier-submission.md).

This page is built to let a judge confirm in five minutes that the project exists, runs, and ships what the submission claims.
For the narrative, market story, and deep technical write-up, jump to the submission document linked above.

---

## TL;DR (30 seconds)

- Privacy layer for Solana, post-quantum end-to-end.
- ZK-STARKs (Goldilocks / Poseidon) + ML-KEM-768 + Winternitz OTS, no trusted setup.
- 14 Anchor programs, 12 of them deployed on devnet (see table below).
- 6 STARK AIRs proven on-device, verified on-chain by a custom FRI verifier (~900K CU).
- Mobile app (Android, v0.9.9), Chrome MV3 extension, Next.js web, 8 npm SDKs, all live.
- Built solo by Slashy Fx in roughly 70 days.

---

## Ireland and Quantum Ireland fit (1 minute)

- Pitched in person at Dogpatch Labs Dublin on 2026-04-27.
- Aligns directly with Quantum Ireland's mission of post-quantum readiness, applied to a shipped Solana product rather than a research paper.
- The commercial wedge is private recurring subscriptions for any merchant, registered on-chain through `p01_registry`.
- Concrete PMF beyond the pure "privacy as a primitive" story, with a reference consumer app (Mugen P2P fiat-to-crypto) built on the same SDKs.

---

## Try it in 5 minutes

Pick one of the three options below. They are independent.

### Option A. Install the Android APK (fastest)

1. Grab the latest APK from [GitHub Releases](https://github.com/IsSlashy/Protocol-01/releases/latest).
2. Verify the artifact matches the current build:
   - Version: `0.9.9`
   - Android `versionCode`: `23`
   - APK size: `~96 MB` (`100,860,376 bytes`)
   - Bundle id: `com.protocol01.app`
   - Min Android: API 29 (Android 10).
3. Install on a physical Android device (allow "Install from unknown sources" when prompted).
4. Run the demo flow:
   - Create wallet, save the 12-word seed, set a PIN.
   - Privacy tab, Shield 0.1 SOL on devnet (proof generation runs on-device, ~4 to 8 s).
   - Streams tab, pick a seeded merchant (Netflix, Spotify, YouTube, Disney+ are pre-registered on devnet), Subscribe Private.
   - Privacy tab, Subscription Vaults, Cancel and watch the auto re-denomination breakdown.

> If the APK link 404s during the evaluation window, build it yourself with the steps in Option B.

### Option B. Inspect and build the code

Prerequisites: Node 22+, pnpm 10.34.0, Rust 1.94 + Anchor CLI 0.32.1, Solana CLI 2.2.14, JDK 17.

```bash
git clone https://github.com/IsSlashy/Protocol-01.git
cd Protocol-01
pnpm install

pnpm dev:web        # Next.js marketing site + docs at http://localhost:3000
pnpm dev:mobile     # Expo dev client (requires a connected Android device or emulator)

pnpm test           # Turbo orchestrated unit tests across all packages
pnpm test:e2e-stark # End-to-end STARK shield -> transfer -> unshield against devnet
```

Useful entry points are listed in the root [`package.json`](../package.json) under `scripts`.

### Option C. Verify devnet deployments

Source of truth for program ids: [`Anchor.toml`](../Anchor.toml) `[programs.devnet]`.
Every link below points to Solana Explorer on devnet.

| Program | Role | Devnet program id |
| --- | --- | --- |
| `p01_registry` | Stealth meta-address directory + on-chain merchant registry (the PMF surface) | [`QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB`](https://explorer.solana.com/address/QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB?cluster=devnet) |
| `p01_stark_verifier` | Custom on-chain FRI verifier, 6 circuits | [`EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z`](https://explorer.solana.com/address/EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z?cluster=devnet) |
| `zk_shielded` | Shielded pool (shield, transfer, unshield, subscribe, cancel) | [`2w4WRvujjrZYip1dUrp3X4nzoPVWeRZF9KnjtvSstGms`](https://explorer.solana.com/address/2w4WRvujjrZYip1dUrp3X4nzoPVWeRZF9KnjtvSstGms?cluster=devnet) |
| `p01_zkspl` | Confidential SPL balances (Poseidon commitments) | [`AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT`](https://explorer.solana.com/address/AY38smtdsnhmfMCzmnDEefiKCeRTkEPrFXHydAF2FuCT?cluster=devnet) |
| `specter` | Stealth address + private streams | [`8rywsvheQZPp8efQ4bsZ37J9GWMLY2ER76f3o8opPsYh`](https://explorer.solana.com/address/8rywsvheQZPp8efQ4bsZ37J9GWMLY2ER76f3o8opPsYh?cluster=devnet) |
| `p01_relayer` | On-chain trustless relayer + fee accounting | [`Ud2JYaq4frePBy3L2DmddmtPT3nXC1nqxsXEX934Hbw`](https://explorer.solana.com/address/Ud2JYaq4frePBy3L2DmddmtPT3nXC1nqxsXEX934Hbw?cluster=devnet) |
| `p01_quantum_vault` | WOTS+ vault, hash-timelock, commit-reveal | [`9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv`](https://explorer.solana.com/address/9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv?cluster=devnet) |
| `p01_arcium` | Arcium MPC bridge (9 Arcis circuits, Cerberus) | [`9kMjmVMYxBa8V9D1aoEjZtUNXTe2gjfzYdKLycn7JvgQ`](https://explorer.solana.com/address/9kMjmVMYxBa8V9D1aoEjZtUNXTe2gjfzYdKLycn7JvgQ?cluster=devnet) |
| `p01_subscription` | Recurring payment vaults with STARK ownership proofs | [`3eDvPJTK2gryh3GhjFgwz94iBsE3hsqZL9ChAFyiBThW`](https://explorer.solana.com/address/3eDvPJTK2gryh3GhjFgwz94iBsE3hsqZL9ChAFyiBThW?cluster=devnet) |
| `p01_stream` | Time-locked payment streaming | [`C92xDDAtd21ED3MitZJ9dhuyGeig5xVx8Dgg6qrxA3vx`](https://explorer.solana.com/address/C92xDDAtd21ED3MitZJ9dhuyGeig5xVx8Dgg6qrxA3vx?cluster=devnet) |
| `p01_whitelist` | Developer access control | [`5PSYrjBKke4gj8BgBgRKZNXgjmLCnojZ5yuDqUvPiG33`](https://explorer.solana.com/address/5PSYrjBKke4gj8BgBgRKZNXgjmLCnojZ5yuDqUvPiG33?cluster=devnet) |
| `p01_fee_splitter` | Protocol fee routing (0.3 to 0.5%) | [`UdxXEvcAzmGsqUtoBgnNkbmfnky4En2kLxNnsVQU5BM`](https://explorer.solana.com/address/UdxXEvcAzmGsqUtoBgnNkbmfnky4En2kLxNnsVQU5BM?cluster=devnet) |
| `p01_mugen` | Mugen P2P escrow (reference consumer integration) | [`EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN`](https://explorer.solana.com/address/EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN?cluster=devnet) |
| `p01_bundler` | Tx bundling helper | Experimental, not deployed on devnet |
| `p01_liquidity` | Instant-unshield liquidity prefund pool | Experimental, not deployed on devnet |

---

## Architecture at a glance

```
User generates a STARK proof on-device (Winterfell, Goldilocks / Poseidon)
    -> Proof submitted to the on-chain FRI verifier (~900K CU)
        -> Shielded program applies the state transition
            -> Funds land at a stealth address (X25519 + ML-KEM-768)
                -> No on-chain link between sender and recipient
    (optional) MPC threshold decryption via Arcium Cerberus
```

Groth16 was fully retired during the March 2026 migration.
Six legacy Circom circuits are kept under `circuits/` for migration history only and are not wired into any shipping client path.

---

## Code stats

- 14 Anchor programs (12 deployed on devnet, 2 experimental).
- 6 STARK AIRs (subscriber ownership, pool commitment, balance proof, Merkle path, confidential balance, transfer).
- 9 Arcis MPC circuits running on Arcium Cerberus, devnet offset 456.
- ~2,400 unit and integration tests across 70+ files (see [`README.md`](../README.md#testing) for the full breakdown).
- 8 npm SDKs published under `@protocol-01/*` (specter, merchant, privacy, zkspl, zk, arcium, auth, whitelist), plus `p01-js`, `privacy-toolkit`, `react-native-zk`, `rpc-config`.
- Mobile prover bundled as a 122 KB WASM artifact, executed inside a hidden WebView on Android.

> If a number above looks off, treat the file paths as the source of truth, not this summary.

---

## Where to focus your review

These five paths give the densest view of the work in the shortest time.

- [`programs/p01_stark_verifier/`](../programs/p01_stark_verifier/) — the only on-chain FRI verifier on Solana, six circuits, Goldilocks field, ~900K CU.
- [`stark/`](../stark/) — Winterfell-based prover, Poseidon AIR, WASM build that the mobile and extension clients consume.
- [`programs/p01_registry/`](../programs/p01_registry/) — service registry, the surface that turns the privacy layer into a private subscriptions product.
- [`programs/zk_shielded/`](../programs/zk_shielded/) — shielded pool, STARK-only since March 2026, including subscribe / pause / resume / cancel.
- [`apps/mobile/`](../apps/mobile/) — primary client, on-device proof generation, Expo 54 + React Native 0.81.

---

## Licensing for evaluation

This repository is proprietary, but the [LICENSE](../LICENSE) file (Section 4) carries an explicit Colosseum Frontier Hackathon Evaluation Grant.
Colosseum, its judges, reviewers, mentors, operators, and contractors may clone, read, build, install, and run the software in private non-production environments for the duration of the official evaluation period.
Cloning the repo, running `pnpm install`, building the APK, and installing it on a test device is therefore explicitly authorised for hackathon evaluation.

Anything beyond evaluation (redistribution, derivative works, production deployment, commercial use) still requires written authorisation from Volta Team.

---

## Contact

- Author: Slashy Fx (Volta Team)
- Twitter / X: [@Protocol01_](https://x.com/Protocol01_)
- Discord: [discord.gg/EfqnVmb2dV](https://discord.gg/EfqnVmb2dV)
- GitHub: [IsSlashy/Protocol-01](https://github.com/IsSlashy/Protocol-01)
- Website: [protocol-01.dev](https://protocol-01.dev)

For partnership, investment, or licensing questions outside of the hackathon evaluation, reach out via X DM or Discord.
