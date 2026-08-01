<p align="center">
  <img src="docs/assets/banner.png" alt="Protocol 01" width="100%" />
</p>

<h1 align="center">Protocol 01</h1>

<p align="center">
  <strong>The privacy layer for Solana.</strong><br/>
  Post-quantum ZK-STARKs &middot; Stealth addresses &middot; Shielded pools &middot; Private subscriptions &middot; On-chain service registry
</p>

<p align="center">
  <a href="https://protocol-01.dev">Website</a> &middot;
  <a href="https://protocol-01.dev/docs">Documentation</a> &middot;
  <a href="https://x.com/Protocol01_">Twitter/X</a> &middot;
  <a href="https://discord.gg/fShgQ5j6pE">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/IsSlashy/Protocol-01-releases/releases/latest"><img src="https://img.shields.io/github/v/release/IsSlashy/Protocol-01-releases?color=39c5bb" alt="Latest release" /></a>
  &middot;
  <a href="https://github.com/IsSlashy/Protocol-01-releases/releases/download/v1.0.1/protocol-01-v1.0.1.apk"><strong>Download Android APK (v1.0.1)</strong></a>
</p>

---

> **PROPRIETARY SOFTWARE &mdash; ALL RIGHTS RESERVED**
>
> &copy; 2025-2026 Volta Team | Developed by Slashy Fx
>
> This repository is publicly visible for **demonstration and evaluation purposes only**.
> Public visibility does **not** constitute a grant of any license.
> No permission is granted to use, copy, modify, fork, or distribute this code.
>
> **Colosseum Frontier Hackathon Evaluation Grant.**
> Solely for the duration of the Colosseum Frontier Hackathon judging period, Colosseum,
> its designated judges, reviewers, mentors, and operators are granted a limited,
> non-exclusive, non-transferable, revocable right to **clone, read, build, run, and
> evaluate** this repository for the sole purpose of reviewing and scoring the project
> in the context of the hackathon. This grant **does not** authorize redistribution,
> publication, derivative works, commercial use, or any use outside the official
> Colosseum Frontier Hackathon evaluation. All other parties are bound by the
> proprietary terms below.
>
> For licensing, investment, or partnership inquiries &mdash; [reach out](https://x.com/Protocol01_).
>
> See [LICENSE](./LICENSE) for full terms.

---

## 📱 Installation & Demo

### Mobile App (Android)

**Download the latest APK:** [GitHub Releases](https://github.com/IsSlashy/Protocol-01/releases/latest)

#### Installation Steps:
1. Download the APK on your Android device (Android 10 / API 29+)
2. Open the file → Allow "Install from unknown sources" if prompted
3. Tap "Install"
4. Open Protocol 01

#### First Launch:
1. Tap **"Create Wallet"** — a 12-word seed is generated locally (never leaves the device)
2. **Save your seed phrase** — this is your only backup
3. Set a PIN + optional biometric unlock
4. A blocking *Recovering your notes* modal auto-scans the chain on first boot — leave it run (~15s)
5. You're ready

> **Note on signing keystores:** reinstalling across different keystores (`debug` ⇄ `release`) silently wipes AsyncStorage. `adb install -r` only preserves notes when signatures match — stick to the release APK.

---

### Browser Extension (Chrome / Brave)

Manual install (developer mode):

1. Grab the latest extension ZIP from [Releases](https://github.com/IsSlashy/Protocol-01/releases/latest)
2. Extract the archive
3. Open Chrome → `chrome://extensions/`
4. Enable **"Developer mode"** (top right toggle)
5. Click **"Load unpacked"** → select the extracted `dist` folder
6. The Protocol 01 icon appears in the toolbar

---

### 🎮 Demo Path — key features in 5 minutes

#### 1. Shield a note

Privacy tab → **Shield** → choose a denomination (0.1 / 1 / 5 / 10 SOL). A ZK-STARK proof is generated on-device (~4–8 s) and the deposit lands in the pool. Wait ~30 s for maturity.

#### 2. Subscribe to a live service

Streams tab → pick one of the on-chain demo merchants (Netflix, Spotify, YouTube, Disney+ are seeded on devnet) → **Subscribe Private**.

The vault pulls from your shielded note; the retailer sees only the payment stream, nothing else.

#### 3. Cancel with auto re-denomination

Privacy → **Subscription Vaults** → select a vault → **Cancel**.

A confirmation modal shows the automated breakdown:

- What the retailer is owed (claimable periods × rate)
- `N × denomination` **notes re-shielded** into the pool
- The **residual dust** routed to a self-stealth address so no clear balance ever touches your wallet

Tap **Confirm** — the cancel tx goes through; the success screen shows the exact amounts recovered.

#### 4. Seed-based recovery

The app automatically runs `rescanPool` after a reinstall, wallet switch, or stale boot (>7 days). A blocking lazy-load modal shows per-pool progress, tallies the notes it pulled back, and can't be dismissed until the scan completes.

No cloud, no backend. Your seed is the only thing that ties you to your history.

---

### 🔧 For Developers — Test on Devnet

```bash
# Get devnet SOL
solana airdrop 2 --url devnet
```

**Smart Contracts (devnet):**

| Program | ID |
|---|---|
| Registry (stealth + services) | `QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB` |
| STARK Verifier (6 circuits) | `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs` |
| ZK Shielded Pool (V4) | `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c` |
| zkSPL (confidential balances) | `EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah` |
| Specter (stealth + streams) | `2tuztgD9RhdaBkiP79fHkrFbfWBX75v7UjSNN4ULfbSp` |
| Relayer (trustless, on-chain) | `2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW` |
| Quantum Vault (WOTS+) | `HazoS6VKk4fqzjJg2yNYSPYTSq8yEHm2EZyb23seTh7o` |
| Arcium MPC Bridge | `FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT` |
| Liquidity Pool (instant unshield) | `6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg` |
| Fee Splitter | `UdxXEvcAzmGsqUtoBgnNkbmfnky4En2kLxNnsVQU5BM` |
| Mugen P2P Escrow | `EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN` |

---

## What is Protocol 01?

Protocol 01 is a **post-quantum privacy layer for Solana**, shipped as composable SDKs and a set of on-chain programs.

The stack combines **ZK-STARKs**, **hybrid stealth addresses** (X25519 + ML-KEM-768), **Winternitz one-time signatures**, and a **custom on-chain FRI verifier** to deliver untraceable transactions that stay secure even against a future quantum adversary.

Unlike mixers, Protocol 01 provides **cryptographic privacy at the protocol level**: amounts, senders, and recipients are hidden by default through hash-based proofs and MPC threshold operations, not operational obfuscation.

```
User generates a STARK proof on-device (Winterfell, Goldilocks/Poseidon)
    -> Proof submitted to the on-chain FRI verifier (~900K CU)
        -> Shielded program applies the state transition
            -> Funds land at a stealth address (X25519 + ML-KEM-768)
                -> No on-chain link between sender and recipient
    (optional) MPC threshold decryption via Arcium Cerberus
```

> **Groth16 was fully retired in the March 2026 migration.** Six Circom circuits remain in `circuits/` for migration history only — they are not wired into any shipping client path. All runtime proofs are STARK.

---

## Architecture

```
protocol-01/
├── apps/
│   ├── extension/          # Chrome MV3 wallet + privacy UI
│   ├── mobile/             # React Native (Expo) wallet + full STARK prover (WebView WASM)
│   ├── web/                # Next.js 16 marketing site + docs
│   └── mugen/              # Gojo-themed fiat-to-crypto P2P exchange — reference integration
├── packages/
│   ├── specter-sdk/        # @protocol-01/specter-sdk — stealth wallets, transfers, service registry
│   ├── merchant-sdk/       # @protocol-01/merchant-sdk — server-side: register, payment polling, vaults, access tokens
│   ├── privacy-sdk/        # @protocol-01/privacy-sdk — shield/transfer/unshield with STARK proofs
│   ├── zkspl-sdk/          # @protocol-01/zkspl-sdk — confidential SPL balances (Poseidon commitments)
│   ├── zk-sdk/             # @protocol-01/zk-sdk — low-level note + Merkle primitives
│   ├── arcium-sdk/         # @protocol-01/arcium-sdk — MPC confidential compute (9 circuits, 6 use cases)
│   ├── auth-sdk/           # @protocol-01/auth-sdk — "Login with P-01"
│   ├── whitelist-sdk/      # @protocol-01/whitelist-sdk — developer whitelist
│   ├── p01-js/             # @protocol-01/p01-js — merchant pay button & browser SDK
│   ├── privacy-toolkit/    # Merkle trees, Goldilocks-Poseidon, commitment helpers
│   ├── react-native-zk/    # STARK prover packaged for React Native
│   ├── rpc-config/         # Shared RPC connection manager
│   └── ui/                 # Shared design tokens + components
├── circuits/                   # Legacy Circom circuits (retired 2026-03, kept for migration history)
├── programs/                   # 15 Anchor programs (12 deployed on devnet)
│   ├── zk_shielded/            # Shielded pool V4 — shield/transfer/unshield/subscribe/cancel (STARK V3)
│   ├── p01_zkspl/              # Confidential SPL balances (Poseidon commitments)
│   ├── specter/                # Stealth address registry + private streams
│   ├── p01_arcium/             # MPC bridge — 9 Arcis circuits + Phase D confidentialRelay scaffold
│   ├── p01_relayer/            # On-chain trustless relay + chunked submit + reputation decay
│   ├── p01_quantum_vault/      # WOTS+ 67-chain, hash-timelock, commit-reveal
│   ├── p01_registry/           # Stealth meta-address directory + Service Registry (retailers)
│   ├── p01_stark_verifier/     # Custom FRI verifier (7 circuits + DEEP-ALI, Goldilocks)
│   ├── p01_liquidity/          # Instant-unshield liquidity pool (prefund)
│   ├── p01_mugen/              # Mugen P2P escrow
│   ├── p01_bundler/            # (in repo, not deployed) Tx bundling helper
│   ├── subscription/           # (in repo, logic merged into zk_shielded V3)
│   ├── stream/                 # (in repo, not deployed) Time-locked payment streaming
│   ├── whitelist/              # (in repo, not deployed) Developer access control
│   └── p01-fee-splitter/       # Fee routing (0.3–0.5% protocol fee)
└── stark/                      # Winterfell STARK prover (Goldilocks field, Poseidon AIR, WASM)
```

---

## Privacy Stack

### Zero-Knowledge STARKs

Hash-based, transparent, and post-quantum. No trusted setup, no `.ptau` ceremony, no `.zkey` artifacts.

| Parameter | Value |
|-----------|-------|
| Proving system | STARK (FRI-based) |
| Field | Goldilocks (`p = 2^64 − 2^32 + 1`) |
| Hash function | Poseidon (full S-box `x^7`, 30 rounds) |
| Proof size | 47–81 KB, measured per circuit on the unmerged B1+B2 tree (the pre-B1 numbers this row used to carry were ~9–12 KB) |
| FRI parameters | blowup 16, 27 queries (22 on circuits 3, 5, 6), 22 grinding bits, terminal degree bound 1 of 16 → **4.000 bits per query, measured** |
| On-chain verification | Shared multi-circuit FRI verifier; the per-circuit CU figure is measured and pinned in `programs/p01_stark_verifier/tests/cu_budget.rs`, against a 1.4M cap |
| Circuits | 7 AIRs — subscriber ownership, pool commitment, balance proof, Merkle path, confidential balance, transfer, Merkle update |

The on-chain verifier is written from scratch (no Winterfell dependency at runtime) and fits in a 792 KB SBF binary.

### Stealth Addresses (Hybrid Post-Quantum)

Adapted from Ethereum's EIP-5564 for Solana. Each payment creates a **unique one-time address** using a hybrid of X25519 ECDH + **ML-KEM-768** (the NIST-standardized post-quantum KEM).

```
Sender: ephemeralKey = random()
Shared secret = ECDH(ephemeralKey, recipientViewingKey) ⊕ KEM(recipientKemKey)
Stealth address = recipientSpendingKey + H(sharedSecret) · G
```

The recipient scans incoming payments using a **viewTag** (2-byte fast filter) then derives the spending key. v1 addresses (X25519-only) remain supported for backward compatibility.

### Shielded Pool

On-chain Anchor program (`zk_shielded`). Stores encrypted notes in a sparse Merkle tree.

| Instruction | Description |
|-------------|-------------|
| `shield` | Deposit SOL/SPL into a denominated pool (0.1 / 1 / 5 / 10 SOL) |
| `unshield_denominated_stark` | Withdraw with STARK proof |
| `subscribe_private_stark` | Lock a note into a subscription vault |
| `pause_private_stark` / `resume_private_stark` | Control a vault's billing clock |
| `cancel_private_stark` | Cancel with auto re-denomination of the refund |

### zkSPL — Confidential SPL Balances

Account-model privacy layer. Hides balances and transfer amounts using Poseidon commitments (no elliptic-curve blinding, quantum-resistant).

```
Balance on-chain = Poseidon(balance, salt, owner_pubkey, token_mint)
                   ↑ nobody can reverse this without the salt
```

Circuits: `confidential_balance` (1,382 constraints, migrated to STARK AIR), `balance_proof` (644 constraints, STARK).

### Service Registry + Private Subscriptions

**Any wallet can register as a merchant** via the `p01_registry` program — the entry is a PDA keyed by `["service", owner, slug]` that holds the retailer pubkey, token mint, price per period, interval (slots), and a `verified` flag flipped by the protocol authority.

Clients read the registry through `fetchAllServices()` (SWR-cached, ~10 min TTL) and render a live merchant list. Users subscribe with a shielded note; the on-chain subscription vault lets the retailer pull the rate per period.

**Cancel flow:** the client computes the cancel preview locally (`refundable = total_deposited − consumed`) and sends `cancel_private_stark` with the re-shield commitments. The handler pays the retailer what's due, re-shields as many full-denomination notes as possible, and surfaces the dust. The client then routes the dust to a self-stealth address so no clear balance ever lands on the user's wallet.

### Quantum-Safe Vault

Application-layer defense if Ed25519 is ever broken by Shor's algorithm.

| Mechanism | Role |
|---|---|
| Winternitz OTS (WOTS+) | 67 hash chains, SHA-256. Key rotates after each withdrawal. |
| Hash-timelock vault | SHA-256 preimage lock for cold storage |
| Commit-then-reveal | Two-phase TX auth, prevents quantum front-running |

Ed25519 is still required for Solana transactions, but it's no longer the security boundary — the SHA-256 preimage is.

### On-Chain Trustless Relay

No backend server. The `p01_relayer` program accepts encrypted relay jobs; an ephemeral keypair posts the job; the relayer executes it. Only `Relayer PDA → stealth address` is visible on-chain. Client middleware optionally bounces the RPC through Tor + a Railway proxy.

### Multi-Party Computation (Arcium MPC)

Decentralized threshold compute via Arcium's **Cerberus protocol** — security holds as long as at least one honest node exists in the cluster.

| Parameter | Value |
|---|---|
| Network | Arcium (Cerberus) |
| Circuits | 9 Arcis circuits |
| Cluster | Devnet offset 456 |
| Fallback | Every MPC op degrades gracefully to the standard path |

Use cases: confidential relay, anonymous registry lookup, hidden nullifier, confidential balance audit, threshold stealth scan, private governance vote.

---

## Products

### Mobile App (primary client)

- STARK prover runs on-device inside a hidden WebView (WASM)
- All 4 tabs: Wallet, Privacy, Streams, Agent
- Hybrid stealth addresses + ML-KEM-768
- Auto-recovery on boot (blocking lazy-load modal)
- Subscription vault cancel with automated breakdown UI
- Biometric unlock + PIN with progressive lockout + SHA-256 hashing
- Clipboard auto-clear on sensitive copies

**Stack:** React Native 0.81, Expo 54, Expo Router, Reanimated, Hermes.

### Browser Extension

- Full Solana wallet (Manifest V3)
- STARK prover bundled (35 MB of circuit/proof assets)
- Privacy Zone + Confidential balances + Payment streams + dApp connection

**Stack:** React 19, TypeScript, Zustand, Vite, TailwindCSS v4.

### Web App

Marketing site, SDK docs, weekly update videos (Remotion).

**Stack:** Next.js 16, TypeScript, TailwindCSS v4, Framer Motion.

### Mugen (reference consumer app)

A Gojo-themed fiat-to-crypto P2P exchange built on Protocol 01 — used internally to prove the SDK in production.

---

## SDK

```typescript
// @protocol-01/specter-sdk — stealth wallets + service registry
import { P01Client, fetchAllServices } from '@protocol-01/specter-sdk';

const client = new P01Client({ cluster: 'devnet' });

// List every on-chain merchant
const services = await fetchAllServices(connection, { verifiedOnly: true });

// Send to a stealth meta-address
await client.sendPrivate({ amount: 1.5, recipient: stealthMetaAddress });
```

```typescript
// @protocol-01/merchant-sdk — server-side for retailers
import {
  registerServiceOnChain, fetchService, pollPaymentsForRetailer,
  listVaultsForRetailer, issueAccessToken, NATIVE_SOL_MINT,
} from '@protocol-01/merchant-sdk';

// Register the service (idempotent — boot-time)
await registerServiceOnChain(connection, merchantKp, {
  slug: 'my-saas-pro',
  name: 'My SaaS — Pro tier',
  iconKey: 'chatgpt',
  category: 'saas',
  metadataUri: '',
  retailer: merchantKp.publicKey,
  tokenMint: NATIVE_SOL_MINT,    // or USDC SPL mint
  priceAtomic: 50_000_000n,      // 0.05 SOL in lamports
  intervalSlots: 6_480_000n,     // ~30 days
  supportsOneshot: true,
  supportsVault: true,
  skipIfExists: true,
});

// Poll for incoming payments
const receipts = await pollPaymentsForRetailer(connection, retailerPubkey, {
  slugFilter: 'my-saas-pro',
});

// Issue a signed access token the client stores for session auth
const token = issueAccessToken({
  merchantKeypair: merchantKp,
  subscriberId: 'user-42',
  serviceSlug: 'my-saas-pro',
  ttlSeconds: 3600,
});
```

```typescript
// @protocol-01/privacy-sdk — shielded pool with STARK proofs
import { PrivacySDK } from '@protocol-01/privacy-sdk';

const sdk = new PrivacySDK({ connection, signer });
await sdk.shield({ amount: 1_000_000_000n });          // deposit 1 SOL
await sdk.transfer({ note, recipient });                // 2-in-2-out transfer
await sdk.unshield({ note, to });                       // withdraw to transparent
```

```typescript
// @protocol-01/arcium-sdk — MPC confidential compute
import { ArciumClient } from '@protocol-01/arcium-sdk';

const mpc = new ArciumClient({ connection, wallet });
await mpc.initialize();
await mpc.confidentialRelay(encryptedTx);
await mpc.privateLookup(targetHash);
```

---

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Seed phrase | AES-256-GCM, PBKDF2-SHA256 (600K iterations, OWASP 2026) |
| Note vault | CTR-HMAC-SHA256 (Encrypt-then-MAC, constant-time tag comparison) |
| Session keys | Stored in SecureStore (Keychain/Keystore), never AsyncStorage |
| Key management | Spending key never leaves the device — backend prover fallback removed |
| STARK soundness | See [STARK soundness, measured](#stark-soundness-measured) — 42–52 bits on the unmerged B1+B2 tree, and the deployed program is older than that. Never 124. |
| Double-spend | Nullifiers as on-chain PDAs inside `zk_shielded` |
| Quantum resistance | STARK (hash-based) + WOTS+ + ML-KEM-768 for stealth |
| PIN | SHA-256(`p01_pin_v1:` + pin) via expo-crypto, progressive lockout (5→30 s, 8→60 s, 10→300 s) |
| App lock | Device-level auth enforced even when `security_method='none'` |
| Clipboard | Auto-clear after 60 s on all sensitive copies |
| Screenshot | `ScreenCapture.preventScreenCaptureAsync()` on seed/viewing-key/private-note screens |
| Backup surface | `android:allowBackup="false"` to defeat `adb backup` |
| MPC threshold | Arcium Cerberus — 1-of-N honest node guarantees correctness |

### STARK soundness, measured

This table used to say **124-bit**. That number was never measured and was never
true: it came from `num_queries × log2(blowup)`, a formula that only holds when the
FRI terminal degree bound is 1 of 16, and the bound was 8 of 16 (7 of 16 on circuit
0). The real rate was 1.000 bits per query.

What the tree can defend today, per circuit, is the residual cost of a coordinated
out-of-domain forgery:

| | Circuits 0–2, 4 | Circuits 3, 5, 6 |
|---|---|---|
| Unconditional (unique decoding — a theorem) | 2^46 | 2^42 |
| Conjectured (ethSTARK Conj. 8.4, list decoding to capacity) | 2^48–2^52 | 2^47 |

Measured inputs, not assumed: the FRI rate is 1/16, from a terminal degree bound of
1 of 16 that is tight on all seven circuits, and the best in-bound adversarial
terminal polynomial agrees with the committed layer at exactly 1 of 16 points — so a
query is worth **4.000 bits**, measured on all seven circuits by
`programs/p01_stark_verifier/tests/b2_bits_measured.rs`. Both columns are capped by a
base-field Fiat-Shamir floor of 47.8–52.5 bits: every challenge in this construction
is one Goldilocks element, so adding queries or grinding cannot raise the conjectured
figure. Lifting it needs challenges drawn from an extension field, which is not built.

Three things this table must not be read as saying:

- **It is not deployed.** The devnet program predates the DEEP-binding work
  entirely, so against a coordinated OOD forgery it has no binding at all. The
  numbers above describe an unmerged tree.
- **It is not a publishable security level.** 2^42 is on the order of GPU-minutes.
- **It is not the post-quantum figure.** Forgery is a search, so Grover roughly
  halves it: ~21–26 quantum bits.

---

## Development

### Prerequisites

- Node.js 22+
- pnpm 8+
- Rust 1.94 + Anchor CLI 0.32.1 (for programs)
- Solana CLI 2.2.14 (Agave)
- JDK 17 (**not** Temurin 21.0.6 on Windows — JIT crashes)

### Quick Start

```bash
git clone https://github.com/IsSlashy/Protocol-01.git
cd Protocol-01
pnpm install

pnpm dev:mobile     # Expo dev client
pnpm dev:extension  # Extension dev server
pnpm dev:web        # Next.js dev server
```

### Build

```bash
# Release APK
cd apps/mobile/android
./gradlew assembleRelease
# output: apps/mobile/android/app/build2/outputs/apk/release/app-release.apk

# Extension + web
pnpm build:extension
pnpm build:web
```

### On-chain programs

```bash
# SBF build (Windows-safe, bypasses cargo-build-sbf)
rustup run solana cargo build --release --target sbf-solana-solana -p <program_name>
solana program deploy target/sbf-solana-solana/release/<program_name>.so \
  --program-id <declared_pubkey> --url devnet
```

---

## Testing

| Layer | Suite | Tests | Status |
|---|---|---|---|
| On-chain programs | Anchor/Rust (12 deployed) | 340+ | Localnet / Devnet |
| STARK verifier | Custom FRI + 7 circuits, DEEP-ALI on all | 103 STARK + 35 verifier | Passing |
| specter-sdk | Stealth, wallet, transfers, registry | 44 | Passing |
| privacy-sdk | Shield / transfer / unshield / denominated | 238 | Passing |
| privacy-toolkit | Merkle, Goldilocks-Poseidon, commitments | 100 | Passing |
| zk-sdk | Note + Merkle primitives | 85 | Passing |
| arcium-sdk | MPC client, Mugen P2P, encryption | 18 | Passing |
| auth-sdk | Login with P-01 | 123 | Passing |
| whitelist-sdk | Encrypted access requests + IPFS | 40 | Passing |
| p01-js | Merchant pay button + browser SDK | 99 | Passing |
| stark-prover | WASM packaging + license | 23 | Passing |
| rpc-config | RPC connection manager | 361 | Passing |
| Mobile app | Stores, services, crypto, payments | 208 (CI) | Passing |
| Extension | Shared utils + services (popup tests deferred) | 45 (CI) | Passing |
| Web app | API + lib utils (component tests deferred) | 24 (CI) | Passing |
| E2E devnet | Shield → subscribe → cancel → recover | 8/8 | Green |
| **CI total** | TS unit suite | **~1,400 tests** | Green |
| **Plus** | On-chain Anchor + STARK + e2e | **~480 more** | Local/devnet |

```bash
pnpm test                             # all unit tests
pnpm --filter specter-sdk test        # individual package
anchor test                           # on-chain programs (localnet)
```

---

## Roadmap

### Latest release — v1.0.1 (hotfix · 2026-05-29)

- Privy embedded-wallet recovery & signing fixed (`PrivyElements` mounted, deterministic note-seed persisted in SecureStore for offline recovery)
- `Transaction.serialize()` restored after the `@noble/curves` v2 migration (every on-chain op had been throwing)
- C3 `merkle_path` STARK verifier fixed — padding rows (480–511) were counted as active Poseidon rounds, rejecting valid V3 unshield proofs; verifier rebuilt + redeployed on devnet
- Transient RPC retry + ephemeral crash-sweep; pnpm 10 monorepo Android autolinking
- Verified end-to-end on device (devnet): shield, emergency unshield + sweep, private merchant subscribe, classic local-keypair flow

### Shipped

- [x] Chrome extension + Android mobile wallet
- [x] ZK shielded pool (STARK, migrated from Groth16 March 2026)
- [x] Hybrid stealth addresses (X25519 + ML-KEM-768)
- [x] Denominated privacy pools (fixed-amount Tornado model)
- [x] Private ZK subscriptions (recurring payments with STARK proofs)
- [x] STARK verifier on-chain (custom FRI, 7 circuits, Goldilocks)
- [x] Quantum vault (WOTS+ 67-chain, hash-timelock, commit-reveal)
- [x] On-chain stealth meta-address registry
- [x] **On-chain Service Registry** (retailers register as first-class merchants)
- [x] **Subscription vault cancel** with auto re-denomination + dust-to-stealth
- [x] **Boot-time auto-recovery** (blocking lazy-load rescan from seed)
- [x] Instant unshield via `p01_liquidity` prefund pool
- [x] Arcium MPC integration (9 circuits, 6 use cases, mobile wired)
- [x] On-chain trustless relayer + Tor-routed RPC middleware
- [x] Mugen — reference fiat-to-crypto P2P exchange
- [x] **V3 STARK migration end-to-end** (transfer/shield/unshield validated live, Goldilocks parity-locked)
- [x] **Tx-Opacity Phase A** — `p01_relayer` wired V3 (closes RPC IP leak L19)
- [x] **Tx-Opacity Phase B** — on-chain event scrub (closes L5-L10)
- [x] **Tx-Opacity Phase C v1** — uniform 145 KB STARK proof padding
- [x] **Tx-Opacity Phase E v1** — `fee_escrow` PDAs (closes lamport-delta denomination leak)
- [x] **Sprint 3 multi-relayer** — auto-rotation + liveness filter + chunked submit_job + lazy reputation decay
- [x] **V4 pool migration** — seed `denominated_pool_v4`, 13 fresh pools, escapes legacy un-decodable events
- [x] **Subscribe_private V3** — V2→V3 structs, ix builder placeholders, vault PDA création validated live

### In Progress

- [ ] **Subscribe_private renewal** live validation (Pay Now flow under logcat)
- [ ] **`cancel_private_stark` V3 port** — port the on-chain cancel ix to `insert_with_root_v3` (subtrees + c6_verified)
- [ ] **Phase D Arcium `confidentialRelay` deploy** — scaffold landed (`7c0841c`), pending devnet ship + mobile wiring
- [ ] On-chain atomic dust-to-stealth routing in `cancel_private_stark`
- [ ] Universal `LeafInserted` canonical event
- [ ] DeFi composability spec (balance proof verification for lending/DEX)

### Future

- [ ] **Quantum Wallet** (`p01_quantum_wallet`) — STARK-authorized smart-contract wallet, custody via Poseidon preimage proof. Design doc shipped 2026-05-09 (see `docs/quantum-wallet-ux-design.md`)
- [ ] **Cover traffic self-loop** — user-side dummy round-trips for indistinguishability
- [ ] **Phase A.5 feeder pool** — close shield depositor leak (gated on TEE attestation OR N-relayer registry)
- [ ] External security audit (OtterSec / Neodyme / Trail of Bits)
- [ ] Mainnet deployment
- [ ] iOS build
- [ ] Hardware wallet support
- [ ] Cross-chain bridges

---

## Links

| | |
|---|---|
| Website | [protocol-01.dev](https://protocol-01.dev) |
| Docs | [protocol-01.dev/docs](https://protocol-01.dev/docs) |
| Weekly updates | [protocol-01.dev/updates](https://protocol-01.dev/updates) |
| Twitter/X | [@Protocol01_](https://x.com/Protocol01_) |
| Discord | [discord.gg/fShgQ5j6pE](https://discord.gg/fShgQ5j6pE) |
| GitHub | [IsSlashy/Protocol-01](https://github.com/IsSlashy/Protocol-01) |

---

<p align="center">
  <strong>Built on Solana</strong><br/>
  <sub>&copy; 2026 Volta Team &mdash; All rights reserved</sub>
</p>
