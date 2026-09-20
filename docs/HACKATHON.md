# Styx (formerly Protocol 01) — Evaluator Guide

> Quick start for Colosseum Frontier judges (Superteam IE / Quantum Ireland track) and for anyone evaluating a grant application.
> Narrative and market story: the [pitch deck](https://protocol-01.dev/pitch-deck.pdf). Technical write-up: the [design document](https://protocol-01.dev/protocol-01-design-document.pdf) and the root [`README.md`](../README.md).
> Every figure on this page names the document it was measured in; the latest numbers are in [`BENCHMARK-2026-09-13.md`](./BENCHMARK-2026-09-13.md).

This page is built to let an evaluator confirm in five minutes that the project exists, runs, and ships what the application claims.
Last checked against devnet and the npm registry on 2026-09-14.

---

## TL;DR (30 seconds)

- Private payments on Solana: a shielded pool where the proof is hash-based (STARK over Goldilocks / Poseidon, no trusted setup) and the stealth-address key exchange is hybrid X25519 + ML-KEM-768, the NIST post-quantum KEM.
- Four Anchor programs on the product path, live on devnet (verifier, shielded pool, registry, relayer); two more deployed but not called by any shipping flow (see the table below).
- Eight STARK circuits, all proven on the user's device from a 265,324-byte WASM blob and verified on-chain by an FRI verifier written for Solana (C7 spend: 890,643 CU, both phases in one transaction, `BENCHMARK-2026-09-13.md` §6).
- Measured on devnet 2026-09-12 (`BENCHMARK-2026-09-13.md` §6c): shield 1 SOL 18.6 s, private subscription 23.0 s, private withdrawal 20.8 s, end to end through the app's own code.
- Android APK (latest tag v1.0.3), Chrome MV3 extension, Next.js web app, 11 npm packages under `@protocol-01`.
- Built solo by Slashy Fx. Not audited, not on mainnet; both are stated on the site.

---

## Ireland and Quantum Ireland fit (1 minute)

- Pitched in person at Dogpatch Labs Dublin on 2026-04-27.
- Aligns directly with Quantum Ireland's mission of post-quantum readiness, applied to a shipped Solana product rather than a research paper.
- The commercial wedge is private recurring subscriptions for any merchant, registered on-chain through `p01_registry`.

---

## Try it in 5 minutes

Pick one of the three options below. They are independent.

### Option A. Use the web app (fastest)

1. Open [protocol-01.dev](https://protocol-01.dev) with a devnet wallet that holds some SOL (`solana airdrop 2 --url devnet`).
2. Shield 1 SOL. The STARK proof is generated in a worker in your browser; the flow was measured at 18.6 s end to end on devnet on 2026-09-12 (`BENCHMARK-2026-09-13.md` §6c).
3. Withdraw it to another address. The withdrawal transaction names no deposit field; the same measurement puts it at 20.8 s.

The web app on `master` carries the prover blob that matches the verifier deployed on 2026-09-12 (`HANDOFF-2026-09-13.md` §7).

### Option A'. Install the Android APK

1. Grab the latest APK from [GitHub Releases](https://github.com/IsSlashy/Protocol-01/releases/latest) (latest tag v1.0.3, 2026-06-16; the launcher still shows "Protocol 01", the build predates the rename).
2. Install on a physical Android device, Android 10 / API 29 or newer (allow "Install from unknown sources" when prompted).
3. Create a wallet, save the 12-word seed, set a PIN; the Privacy tab shields on devnet and the Streams tab subscribes to a seeded demo merchant.

> Known limit, stated in the README: the v1.0.3 APK's prover blob predates the verifier redeployed on 2026-09-12, so its proofs are rejected by the chain until a new APK is released. Use Option A for a working end-to-end flow today.

### Option B. Inspect and build the code

Prerequisites: Node 22+, pnpm 10.34.0, Rust 1.94 + Anchor CLI 0.32.1, Solana CLI 2.2.14, JDK 17.

```bash
git clone https://github.com/IsSlashy/Protocol-01.git
cd Protocol-01
pnpm install

pnpm dev:web        # Next.js marketing site + docs at http://localhost:3000
pnpm dev:mobile     # Expo dev client (requires a connected Android device or emulator)

pnpm test           # Turbo orchestrated unit tests across all packages
```

Test status per suite as of 2026-09-13 is in [`HANDOFF-2026-09-13.md`](./HANDOFF-2026-09-13.md) §4c; the live devnet flows (`liveDevnet*.test.ts` in `apps/web`) are the ones timed in the benchmark.

Useful entry points are listed in the root [`package.json`](../package.json) under `scripts`.

### Option C. Verify devnet deployments

Source of truth for program ids: the `declare_id!` in each crate under [`programs/`](../programs/), mirrored in [`Anchor.toml`](../Anchor.toml) `[programs.devnet]`. Checked against the devnet cluster on 2026-09-14.
Every link below points to Solana Explorer on devnet.

**On the product path, live:**

| Program | Role | Devnet program id |
| --- | --- | --- |
| `p01_stark_verifier` | On-chain FRI/STARK verifier written for Solana, 8 circuits; redeployed 2026-09-12, slot 497,235,406, 801,457 bytes | [`DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs`](https://explorer.solana.com/address/DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs?cluster=devnet) |
| `zk_shielded` | Shielded pool: shield, unshield v4, subscribe v4, pause, resume, permissionless claim | [`GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`](https://explorer.solana.com/address/GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c?cluster=devnet) |
| `p01_registry` | On-chain merchant registry + stealth meta-address directory | [`QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB`](https://explorer.solana.com/address/QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB?cluster=devnet) |
| `p01_relayer` | Relay program (deployed; no hosted node operates it since 2026-08-28) | [`2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW`](https://explorer.solana.com/address/2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW?cluster=devnet) |

**Deployed, not called by any shipping flow:**

| Program | Role | Devnet program id |
| --- | --- | --- |
| `p01_arcium` | Arcium MPC bridge; client integration removed 2026-07 | [`FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT`](https://explorer.solana.com/address/FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT?cluster=devnet) |
| `p01_liquidity` | Instant-unshield liquidity prefund pool (SDK module + mobile service) | [`6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg`](https://explorer.solana.com/address/6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg?cluster=devnet) |

**In the repo, declared id not deployed on devnet:** `p01_zkspl`, `stream`, `subscription`, `whitelist`.

**Closed on devnet on 2026-09-13 and deleted from the repo** ([`HANDOFF-2026-09-13.md`](./HANDOFF-2026-09-13.md) §11, §12): `specter`, `p01_quantum_vault`, `p01_quantum_wallet`, `p01_fee_splitter`. Older deployments of some of them under superseded ids still exist on devnet; no crate declares them and no product path calls them.

---

## Architecture at a glance

```
User generates a STARK proof on-device (Winterfell prover, Goldilocks / Poseidon, 265,324-byte WASM blob)
    -> Proof uploaded in 4,096-byte transaction v1 chunks (21 to 25 per proof) and verified by the on-chain FRI verifier
       (C7 spend: 890,643 CU, both phases in one transaction)
        -> zk_shielded applies the state transition
            -> Funds land at a one-time stealth address (X25519 + ML-KEM-768)
```

What the pool hides and what it does not is stated precisely in the README section "What is hidden, and what is not"; read that before relying on it.
Groth16 was fully retired during the March 2026 migration; the legacy Circom circuits have since been deleted and `circuits/` holds one design note.

---

## Code stats

- 10 Anchor crates under `programs/`: 4 live on the product path, 2 deployed off-path, 4 not deployed (table above).
- 8 STARK AIRs in `stark/src/air/`: subscriber ownership, denominated pool (pool commitment), balance proof, Merkle path, confidential balance, transfer, Merkle update (shield), spend (unshield v4, subscription v4). All eight carry a blinding mask; the hiding argument is statistical in the random-oracle model, written in [`zk-simulation-argument.md`](./zk-simulation-argument.md) and measured by the X5 uniformity test on all eight.
- 9 Arcis MPC circuits in `@protocol-01/arcium-sdk`; no shipping client calls them.
- Test counts per suite: [`README.md`](../README.md#testing) (measured 2026-08-04) and [`HANDOFF-2026-09-13.md`](./HANDOFF-2026-09-13.md) §4c (2026-09-13).
- 11 npm packages published under `@protocol-01/*` (versions read from the registry 2026-09-14): p01-js, merchant-sdk, auth-sdk, privacy-sdk, specter-sdk, privacy-toolkit, arcium-sdk, stark-prover, zk-sdk, zkspl-sdk, rpc-config. Repo holds 16.
- Prover bundled as a 265,324-byte WASM blob (`packages/stark-prover/wasm/p01_stark_bg.wasm`, digest prefix `0ad6d7f1`), run in a browser worker on the web and inside a hidden WebView on Android.

> If a number above looks off, treat the file paths as the source of truth, not this summary.

---

## Where to focus your review

These five paths give the densest view of the work in the shortest time.

- [`programs/p01_stark_verifier/`](../programs/p01_stark_verifier/) — an on-chain FRI/STARK verifier written for Solana, eight circuits, Goldilocks field; C7 spend verifies at 890,643 CU in one transaction (`BENCHMARK-2026-09-13.md` §6).
- [`stark/`](../stark/) — Winterfell-based prover, Poseidon AIRs, blinding masks, the X5 uniformity test (`stark/src/compact/zk_hiding.rs`), WASM build that the web, extension and mobile clients consume.
- [`programs/p01_registry/`](../programs/p01_registry/) — service registry, the surface that turns the privacy layer into a private subscriptions product.
- [`programs/zk_shielded/`](../programs/zk_shielded/) — shielded pool, STARK-only since March 2026, including subscribe / pause / resume; there is no cancel and no refund, by design (README, "Service Registry + Private Subscriptions").
- [`apps/web/`](../apps/web/) — the client that carries the current prover blob; the live devnet flows timed in the benchmark are its `liveDevnet*.test.ts`.

---

## Licensing for evaluation

This repository is released under the [MIT License](../LICENSE). Cloning the
repo, running `pnpm install`, building the APK, installing it on a test device,
redistributing, and building derivative works are all permitted — for judges
and for everyone else. (An earlier revision of this file described a
proprietary license with a judge-only evaluation grant; the repository moved to
MIT on 2026-08-04.)

---

## Contact

- Author: Slashy Fx (Volta Team)
- Twitter / X: [@Styx_PQ](https://x.com/Styx_PQ)
- Discord: [discord.gg/EfqnVmb2dV](https://discord.gg/EfqnVmb2dV)
- GitHub: [IsSlashy/Protocol-01](https://github.com/IsSlashy/Protocol-01)
- Website: [protocol-01.dev](https://protocol-01.dev)

For partnership, investment, or licensing questions outside of the hackathon evaluation, reach out via X DM or Discord.
