<p align="center">
  <img src="docs/assets/banner.png" alt="Styx Protocol" width="100%" />
</p>

<h1 align="center">Styx Protocol</h1>

<p align="center">
  <strong>The privacy layer for Solana.</strong><br/>
  Hash-based post-quantum STARKs &middot; Stealth addresses &middot; Shielded pools &middot; Subscription vaults &middot; On-chain service registry
</p>

<p align="center">
  <a href="https://protocol-01.dev">Website</a> &middot;
  <a href="https://protocol-01.dev/docs">Documentation</a> &middot;
  <a href="https://x.com/Protocol01_">Twitter/X</a> &middot;
  <a href="https://discord.gg/EfqnVmb2dV">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/IsSlashy/Protocol-01-releases/releases/latest"><img src="https://img.shields.io/github/v/release/IsSlashy/Protocol-01-releases?color=39c5bb" alt="Latest release" /></a>
  &middot;
  <a href="https://github.com/IsSlashy/Protocol-01-releases/releases/download/v1.0.1/protocol-01-v1.0.1.apk"><strong>Download Android APK (v1.0.1)</strong></a>
</p>

---

> **MIT LICENSE &mdash; OPEN SOURCE**
>
> &copy; 2025-2026 Volta Team | Developed by Slashy Fx
>
> This repository is released under the [MIT License](./LICENSE): use it, fork it,
> build on it, audit it. A privacy protocol earns trust by being verifiable, and
> the `@protocol-01` SDK packages on npm have shipped under MIT from the start —
> the repository now says the same thing everywhere.
>
> For investment or partnership inquiries &mdash; [reach out](https://x.com/Protocol01_).

---

## 📱 Installation & Demo

### Mobile App (Android)

**Download the latest APK:** [GitHub Releases](https://github.com/IsSlashy/Protocol-01/releases/latest)

#### Installation Steps:
1. Download the APK on your Android device (Android 10 / API 29+)
2. Open the file → Allow "Install from unknown sources" if prompted
3. Tap "Install"
4. Open **Protocol 01** — the shipped build predates the rename, so that is the
   name the launcher shows, not Styx

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
6. The **Protocol 01** icon appears in the toolbar — the archive's manifest still
   reads that name, so Chrome prints it rather than Styx

---

### 🎮 Demo Path — key features in 5 minutes

#### 1. Shield a note

Privacy tab → **Shield** → choose a denomination (0.1 / 1 / 10 / 100 / 500 / 1000 SOL; only the first two have ever been used). A STARK shield proof is generated on-device (~4–8 s; the heavier unshield circuits are the ones measured past 180 s, see the mobile section below) and the deposit lands in the pool. Wait ~30 s for the deposit to confirm and for the wallet to re-scan. This is a confirmation wait, not a privacy delay: nothing on chain makes a note age before it can be spent. Every client pins `min_epoch = 0`, the unshield handler discards the field outright, and the subscribe gate compares against the absolute epoch counter — measured 2026-08-17, `1121 >= 2` is always true, so the gate never bites.

#### 2. Subscribe to a live service

Streams tab → pick one of the demo merchants (the catalogue lists privacy
vendors — Mullvad, Proton VPN, IVPN, AdGuard, and others) → **Subscribe
Private**.

The demo services on devnet are seeded by us; no third-party merchant is
registered yet. The vault pulls from your shielded note, and the retailer's
claim is permissionless — anyone can trigger the payout, and it can only ever
land on the retailer's registered address.

#### 3. Pause and resume — there is no cancellation

Privacy → **Subscription Vaults** → select a vault → **Pause** / **Resume**.

A subscription is a one-way prepaid envelope. **Money that enters a vault can
only ever leave it toward the retailer.** There is no cancel instruction, no
refund and no path by which a lamport returns to the subscriber; the subscriber
is told this on the paying screen, before the deposit.

- **Pause** freezes the clock and cuts access. Prepaid periods are not lost —
  `total_paused_slots` is credited on resume, so pause moves *when* the retailer
  is paid, never *how much*.
- **Resume** restarts accrual from where it stopped.
- `claim_period` closes the vault once its funded periods are spent, paying the
  sub-period remainder and the rent to the retailer. It is the only instruction
  that can close a `SubscriptionVault`.

#### 4. Seed-based recovery

The app automatically runs `rescanPool` after a reinstall, wallet switch, or stale boot (>7 days). A blocking lazy-load modal shows per-pool progress, tallies the notes it pulled back, and can't be dismissed until the scan completes.

No cloud, no backend. A rescan re-derives **your own deposits** from your seed, which is what restores them on a new device. It does not reach a note somebody **handed** you: those secrets came from the sender's seed, so no derivation finds them and the local store is their only witness. Back up the device store, not just the seed.

---

### 🔧 For Developers — Test on Devnet

```bash
# Get devnet SOL
solana airdrop 2 --url devnet
```

**Smart contracts — declared program IDs (devnet).** These are the
`declare_id!` constants in `programs/`; the shielded pool and the STARK
verifier (coset LDE) were both redeployed 2026-08-04, and every verifier figure
in this README is measured against that deployment on the real devnet cluster.

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

---

## What is Styx Protocol?

Styx Protocol is a **post-quantum-oriented privacy layer for Solana**, shipped as composable SDKs and a set of on-chain programs.

The stack combines **STARKs** (hash-based, no trusted setup), **hybrid stealth addresses** (X25519 + ML-KEM-768, the NIST-standardized post-quantum KEM), **Winternitz one-time signatures**, and a **custom on-chain FRI verifier**. The *proof* system is chosen so that no proof falls to Shor: no pairing-based proofs, no trusted setup, hash commitments throughout. The *stack* is not in that position, and saying otherwise here was wrong until 2026-08-17. Solana verifies **Ed25519** and nothing else, so spend authority falls to Shor whatever this layer does. Worse for the pool specifically: the web pool seed is `HKDF(one Ed25519 signature over a fixed message)`, so an adversary who recovers the wallet key re-signs that message, reproduces the seed, and re-derives every note it ever held — retroactively. A user passphrase (derivation v2) closes that for pool notes created after it is set, and reaches neither the stealth identity nor the extension nor mobile. One measured caveat outranks that design goal today: the STARK prover is **not zero-knowledge** — a private witness has been recovered from published proof bytes by Lagrange interpolation (`stark/tests/zk_feasibility.rs`), so proof bytes must be treated as revealing note secrets until the additive masking lands. No quantum computer is needed for that recovery; a laptop does it.

### What is hidden, and what is not

A privacy protocol owes its users a precise answer here, so this section states
what the code does rather than what a mixer brochure would say:

**Hidden:**
- **The pool transaction is signed by a one-time key rather than by your wallet
  — always on the withdrawal, but only on SOL for the deposit.** A **USDC**
  deposit has no ephemeral path: `useEphemeralDepositor = pool.token === 'SOL'`
  (`apps/mobile/stores/denominatedPoolStore.ts:1176`), so your wallet signs the
  shield instruction itself and appears on chain as the depositor. The code logs
  exactly that, and the mobile app tells the depositor so on the shield screen —
  this README claimed the opposite until 2026-08-17. On the web client USDC is
  refused outright rather than half-wired. Wherever a one-time key *is* used,
  your wallet funds it in the clear one hop earlier and the residue is swept
  back, so the wallet stays reachable from either leg in three RPC calls.
  Dropping the wallet as the signer is real and worth saying. It is not absence.
- **Stealth payments create a unique one-time address per payment** — an
  observer cannot connect two payments to the same recipient from the addresses
  alone.
- **zkSPL balances and transfer amounts** sit behind Poseidon commitments; the
  chain stores the commitment, not the number. The `p01_zkspl` program is not
  deployed on devnet, so this layer is SDK and program source today.
- **Note contents** (owner, blinding) are never posted in clear on-chain — but
  see the prover caveat above: proof bytes currently allow trace recovery by
  interpolation.

**NOT hidden — read this before relying on the pool:**
- **A withdrawal is linkable to its deposit.** The withdrawal proof publishes
  the note's commitment, which the deposit already published: matching the two
  is trivial for any observer, and this is a property of the circuit's public
  inputs — no client-side change can remove it.
- **Your wallet is reachable from any spend in three RPC calls, and it is the
  cheapest attack here.** Nothing cryptographic is involved: the ephemeral key
  cannot pay a fee from nothing, so an ordinary `SystemProgram::transfer` funds
  it and another sweeps the residue back, and both name the wallet. Measured on
  a real devnet subscription — `verify/p01-verify.mjs` probe P6 does exactly
  this walk and prints its own call count.
- **The anonymity set is small, and here are the numbers.** Measured
  2026-08-17: seven unspent notes in the 1 SOL pool out of twenty-six ever
  deposited, eight in the 0.1 SOL pool, and zero in every other denomination.
  Because each note is individually linkable by the point above, the effective
  set is one.
- **Amounts in the denominated pool are public by denomination** (0.1 / 1 / 10
  / 100 / 500 / 1000 SOL, of which only the first two have ever been used).
- **A merchant's retailer address and subscription vault fields are public** —
  anyone can enumerate a merchant's subscriber vaults.

So the honest claim is narrower than it used to read here. This paragraph said
"the pool hides *who you are* (your wallet), not *which deposit you are*" until
2026-08-17, and that sentence contradicted the caveat three bullets above it: the
wallet funds the ephemeral in the clear, one hop earlier, and three RPC calls
close that hop. **The pool hides neither today.** What it does hide is the
amount's distinctiveness, by denomination.

Handing the note to someone else does not fix this, and both forms were measured
rather than assumed: an off-chain hand-off emits no transaction at all, so the
chain is unchanged and the spend still republishes the deposit's commitment; an
on-chain `transfer_denominated_stark_v3` publishes the OLD commitment in the
clear at byte 80 of its own instruction, so it adds a public hop instead of
breaking the chain — verified against both real transfers on devnet, two for
two. Anything stronger will be claimed here when it ships, not before.

```
User generates a STARK proof (Winterfell prover, Goldilocks/Poseidon)
    -> Proof submitted to the on-chain FRI verifier
        -> Shielded program applies the state transition
            -> Funds land at a one-time stealth address (X25519 + ML-KEM-768)
                -> Neither transaction is SIGNED by the user's wallet
                   — except a USDC deposit, which the wallet signs itself.
                   Elsewhere the wallet funded the ephemeral one hop
                   earlier, in the clear, and is swept back to afterwards.
```

> **Groth16 was fully retired in the March 2026 migration.** The Circom
> circuits themselves have since been deleted too — `circuits/` now holds only
> a design note. All runtime proofs are STARK.

---

## Architecture

```
protocol-01/
├── apps/
│   ├── extension/          # Chrome MV3 wallet + privacy UI
│   ├── mobile/             # React Native (Expo) wallet + full STARK prover (WebView WASM)
│   └── web/                # Next.js 16 marketing site + docs
├── packages/                   # 16 packages, 11 published to npm under @protocol-01
│   ├── specter-sdk/        # npm 0.4.1 — stealth wallets, transfers, service registry
│   ├── merchant-sdk/       # npm 0.1.2 — server-side: register, payment polling, vaults, permissionless claims, access tokens
│   ├── privacy-sdk/        # npm 1.0.2 — shield/transfer/unshield with STARK proofs
│   ├── zkspl-sdk/          # npm 0.1.2 — confidential SPL balances (Poseidon commitments)
│   ├── zk-sdk/             # npm 1.0.1 — low-level note + Merkle primitives
│   ├── arcium-sdk/         # npm 0.1.1 — MPC compute client (client integration removed 2026-07, see below)
│   ├── auth-sdk/           # npm 0.1.0 — "Login with P-01"
│   ├── p01-js/             # npm 0.3.1 — merchant pay button & browser SDK
│   ├── privacy-toolkit/    # npm 1.0.2 — Merkle trees, Goldilocks-Poseidon, commitment helpers
│   ├── rpc-config/         # npm 0.1.1 — shared RPC connection manager
│   ├── stark-prover/       # npm 0.1.1 — WASM STARK prover bindings
│   ├── whitelist-sdk/      # unpublished — developer whitelist
│   ├── react-native-zk/    # unpublished — STARK prover packaged for React Native
│   ├── pay-core/           # unpublished — /pay page core
│   ├── specter-js/         # unpublished
│   └── ui/                 # unpublished — shared design tokens + components
├── circuits/                   # One design note (ZKSPL.md). The legacy Circom circuits are gone.
├── programs/                   # 14 Anchor programs (declared IDs; deployment status varies — see table above)
│   ├── zk_shielded/            # Shielded pool V4 — shield/unshield/subscribe/pause/resume/claim (STARK)
│   ├── p01_zkspl/              # Confidential SPL balances (Poseidon commitments)
│   ├── specter/                # Stealth address registry + private streams
│   ├── p01_arcium/             # MPC bridge program (clients no longer call it)
│   ├── p01_relayer/            # On-chain relay + chunked submit + reputation decay
│   ├── p01_quantum_vault/      # WOTS+ 67-chain, hash-timelock, commit-reveal
│   ├── p01_quantum_wallet/     # STARK-authorized wallet (design stage)
│   ├── p01_registry/           # Stealth meta-address directory + Service Registry (retailers)
│   ├── p01_stark_verifier/     # Custom FRI verifier (6 circuit AIRs, Goldilocks)
│   ├── p01_liquidity/          # Instant-unshield liquidity pool (prefund)
│   ├── subscription/           # (in repo, logic merged into zk_shielded)
│   ├── stream/                 # (in repo, not deployed) Time-locked payment streaming
│   ├── whitelist/              # (in repo, not deployed) Developer access control
│   └── p01-fee-splitter/       # Fee routing
└── stark/                      # Winterfell STARK prover (Goldilocks field, Poseidon AIR, WASM)
```

---

## Privacy Stack

### Hash-based STARKs

Hash-based, transparent, and post-quantum. No trusted setup, no `.ptau` ceremony, no `.zkey` artifacts. Not zero-knowledge today: see the witness-recovery caveat above, which is why this heading no longer says "ZK".

| Parameter | Value |
|-----------|-------|
| Proving system | STARK (FRI-based) |
| Field | Goldilocks (`p = 2^64 − 2^32 + 1`) |
| Hash function | Poseidon (full S-box `x^7`, 30 rounds) |
| Configured FRI parameters | 27 queries, blowup 16 (Blake3 Merkle) — stated as configuration; no security-bit figure is derived from them |
| On-chain verification cost | **809,812 CU** measured on devnet 2026-08-04 for an accepted honest proof (C1 `pool_commitment` via `verify_uniform`, tx budget 1,400,000 — sig `2sLVyzPW…jZiBR`) |
| Circuits | 6 AIRs — subscriber ownership, pool commitment, balance proof, Merkle path, confidential balance, transfer |

**On soundness, plainly:** an earlier revision of this README advertised
"124-bit" security. That figure was wrong — it was never implemented, and the
naive formula it came from (`queries × log2(blowup)`) does not survive
measurement: the effective FRI rate was measured at 1/2, not the nominal 1/16,
which collapses that arithmetic. The soundness of the current construction is
under active hardening (DEEP binding of the out-of-domain sample landed
2026-07-30; the coset low-degree extension deployed 2026-08-04), **no audited
soundness figure is claimed**, and the protocol is not audited. Treat devnet as
devnet.

Since the 2026-08-04 coset-LDE deployment, **no raw trace cells are
transmitted** in the proofs the devnet verifier accepts. Said precisely,
because the imprecise version would oversell it: what the coset removes is the
verbatim-cell line — recovering trace values by Lagrange interpolation remains
possible, so this is *not* "the witness is hidden". The prover that produces
coset proofs currently lives on the unmerged `b7-drop-aligned-checks` branch;
**the deployed web app, the installed APK, and `@protocol-01/stark-prover@0.1.2`
still carry the pre-coset blob and are rejected by the chain** until they are
rebuilt from that branch.

The on-chain verifier is written from scratch (no Winterfell dependency at
runtime) and fits in a **667,000-byte** SBF binary (sha `90c75a0e…`), upgraded
in place on devnet 2026-08-04. Its post-deploy verification gate passes exit 0,
and rejection is attributed, not assumed — measured on devnet, all three
outcomes: an honest proof accepted at 809,812 CU; a proof forged by one byte
rejected `InvalidProof` (6003) at 542,150 CU, deep in the DEEP/FRI work; a
tampered public input rejected at **19,777 CU** on an `OOD z mismatch` right
after step 1. The 27× gap between the two rejections is the interesting part:
a forgery consistent with its own transcript costs the full DEEP/FRI pass to
catch, while a tampered input breaks Fiat-Shamir and dies immediately. Two
defect classes, two mechanisms, both closed.

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
| `claim_period` | Retailer claims accrued periods; closes the vault and sweeps the sub-period remainder + rent to the retailer once its funding is spent |

### zkSPL — Confidential SPL Balances

Account-model privacy layer. Hides balances and transfer amounts using Poseidon commitments (no elliptic-curve blinding, quantum-resistant). The `p01_zkspl` program is not deployed on devnet: what ships today is the SDK and the program source.

```
Balance on-chain = Poseidon(balance, salt, owner_pubkey, token_mint)
                   ↑ nobody can reverse this without the salt
```

Circuits: `confidential_balance` and `balance_proof`, both STARK AIRs (the constraint counts previously quoted here were from the retired Circom versions).

### Service Registry + Private Subscriptions

**Any wallet can register as a merchant** via the `p01_registry` program — the entry is a PDA keyed by `["service", owner, slug]` that holds the retailer pubkey, token mint, price per period, interval (slots), and a `verified` flag flipped by the protocol authority.

Clients read the registry through `fetchAllServices()` (SWR-cached, ~10 min TTL) and render a live merchant list. Users subscribe with a shielded note; the on-chain subscription vault lets the retailer pull the rate per period — and since 2026-08-04 the claim is **permissionless**: anyone can trigger it, the program pins the payout to the registered retailer address, so a merchant who loses their key keeps getting paid.

Full disclosure on the current registry state: every entry live on devnet today
is a demo service seeded and attested by us. No third-party merchant has
registered yet — if you integrate, you are early, and the
[merchant-sdk README](./packages/merchant-sdk/README.md) is written for you.

**Exit flow:** there is none for the subscriber. A subscription is a one-way prepaid envelope — `cancel_normal` and `cancel_private_stark` were removed from the program, and no instruction can move a lamport from a `SubscriptionVault` to anyone but the retailer. The vault ends when `claim_period` finds its funded periods spent: that call pays the last periods, sweeps the sub-period remainder `total_deposited % rate` (which never bought a period and used to be quoted as the "refund"), closes the account and sends its rent to the retailer. The subscriber's controls are pause and resume, and the rule is stated on the paying screen before the deposit.

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

### Multi-Party Computation (Arcium MPC) — program and SDK only

The `p01_arcium` bridge program and `@protocol-01/arcium-sdk` (9 Arcis
circuits) exist and are published, but **the client integration was removed
from the shipping apps in July 2026** — no mobile or extension flow calls MPC
today. The circuits cover confidential relay, anonymous registry lookup, hidden
nullifier, confidential balance audit, threshold stealth scan, and private
governance vote; they are available to developers who want to build on them,
and nothing in the current privacy claims of this README depends on MPC.

---

## Products

### Mobile App (primary client)

- STARK prover runs on-device inside a hidden WebView (WASM). Shield proofs
  complete in seconds; the heavier unshield circuits currently exceed practical
  on-device time limits (measured >180 s on real hardware, 2026-08-03) and are
  being optimized — the honest state, not the aspirational one
- All 4 tabs: Wallet, Privacy, Streams, Agent
- Hybrid stealth addresses + ML-KEM-768
- Auto-recovery on boot (blocking lazy-load modal)
- Subscription vaults: pause / resume, with the one-way no-refund rule stated before payment
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

## SDK

11 of the 16 packages are published to npm under the `@protocol-01` scope
(MIT): arcium-sdk 0.1.1, auth-sdk 0.1.0, merchant-sdk 0.1.2, p01-js 0.3.1,
privacy-sdk 1.0.2, privacy-toolkit 1.0.2, rpc-config 0.1.1, specter-sdk 0.4.1,
stark-prover 0.1.1, zk-sdk 1.0.1, zkspl-sdk 0.1.2. The packed tarballs also
install and typecheck standalone, outside any workspace (verified 2026-08-04).

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
  hasActiveVaultAccessForVault, issueAccessToken, NATIVE_SOL_MINT,
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
| Seed / vault encryption | AES-256-GCM with PBKDF2-derived keys, 100,000 iterations (extension); authenticated encryption with HMAC on the mobile note vault |
| Session keys | Stored in SecureStore (Keychain/Keystore), never AsyncStorage |
| Key management | Spending key never leaves the device — backend prover fallback removed |
| STARK soundness | Under active hardening; **no audited figure is claimed** — see the plain-language note in the STARK section above |
| Double-spend | Nullifiers as on-chain PDAs inside `zk_shielded` |
| Quantum resistance | STARK (hash-based) + WOTS+ + ML-KEM-768 for stealth — a design choice, not an "immunity" claim |
| PIN | SHA-256(`p01_pin_v1:` + pin) via expo-crypto, progressive lockout (5→30 s, 8→60 s, 10→300 s) |
| Clipboard | Auto-clear on sensitive copies |
| Screenshot | `ScreenCapture.preventScreenCaptureAsync()` on seed/viewing-key/private-note screens |
| Backup surface | `android:allowBackup="false"` to defeat `adb backup` |

**Not audited.** No external security audit has been performed yet; it is on
the roadmap, and until it happens the protocol should be treated as
experimental software on devnet.

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

Every number below was **measured on 2026-08-04** by running the suite, not
carried forward. Suites not re-run that day say so instead of quoting a stale
figure.

| Layer | Suite | Tests | Status |
|---|---|---|---|
| specter-sdk | Stealth, wallet, transfers, registry | 240 | Passing |
| merchant-sdk | Registry, vaults, entitlement, permissionless claims, licenses | 273 | Passing |
| privacy-sdk | Shield / transfer / unshield / denominated | 112 | Passing |
| privacy-toolkit | Merkle, Goldilocks-Poseidon, commitments | 44 | Passing |
| zk-sdk | Note + Merkle primitives | 99 | Passing |
| arcium-sdk | MPC client, encryption | 0 | **No test suite** — its only suite tested the P2P exchange and went with it on 2026-08-19 |
| auth-sdk | Login with P-01 | 123 | Passing |
| whitelist-sdk | Encrypted access requests + IPFS | 40 | Passing |
| p01-js | Merchant pay button + browser SDK | 393 | Passing |
| stark-prover | WASM packaging + license keys | 23 | Passing |
| pay-core | /pay page core | 3 (+4 skipped) | Passing |
| ui | Shared components | 85 | Passing |
| Web app | API + lib utils | 399 (+29 skipped) | Passing |
| rpc-config / zkspl-sdk / specter-js | — | 0 | **No test suite** — an earlier revision claimed 361 for rpc-config; that suite does not exist |
| Mobile app / Extension | Jest / vitest CI suites | not re-measured 2026-08-04 | — |
| STARK prover/verifier (Rust) | verifier lib 81, CU-pin suite 21, DEEP-binding 26 | 128 | Passing — measured 2026-08-04 on the coset branch (`b7-drop-aligned-checks`, unmerged) |
| E2E devnet | Shield → subscribe → recover | — | **Stale — its `cancel` step no longer exists in the program** |

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
- [x] Subscription vaults with STARK subscribe proofs (the vault is keyed by a note commitment, not the subscriber wallet; a merchant's vaults are enumerable)
- [x] STARK verifier on-chain (custom FRI, 6 circuits, Goldilocks)
- [x] Quantum vault (WOTS+ 67-chain, hash-timelock, commit-reveal)
- [x] On-chain stealth meta-address registry
- [x] **On-chain Service Registry** (retailers register as first-class merchants)
- [x] **Subscription vaults are one-way** — cancellation and refunds removed from the program; `claim_period` closes an exhausted vault and pays the remainder + rent to the retailer
- [x] **Boot-time auto-recovery** (blocking lazy-load rescan from seed)
- [x] Instant unshield via `p01_liquidity` prefund pool
- [x] Arcium MPC bridge program + SDK (9 circuits — client integration later removed, 2026-07)
- [x] On-chain trustless relayer + Tor-routed RPC middleware
- [x] **Permissionless `claim_period` + close-on-exhaustion** (2026-08-04, proven on devnet by a third-party signer: the program pins where the money goes, not who sends the claim)
- [x] **MIT license everywhere** (2026-08-04 — root LICENSE, site, and docs now agree with what npm shipped)
- [x] **Coset-LDE STARK verifier redeployed on devnet** (2026-08-04 — honest proof accepted at 809,812 CU, deployed-verifier gate exit 0, rejection attributed per cause)
- [x] **V3 STARK migration end-to-end** (transfer/shield/unshield validated live, Goldilocks parity-locked)
- [x] **Tx-Opacity Phase A** — `p01_relayer` wired V3 (closes RPC IP leak L19)
- [x] **Tx-Opacity Phase B** — on-chain event scrub (closes L5-L10)
- [x] **Tx-Opacity Phase C v1** — uniform 145 KB STARK proof padding
- [x] **Tx-Opacity Phase E v1** — `fee_escrow` PDAs (closes lamport-delta denomination leak)
- [x] **Sprint 3 multi-relayer** — auto-rotation + liveness filter + chunked submit_job + lazy reputation decay
- [x] **V4 pool migration** — seed `denominated_pool_v4`, 13 fresh pools, escapes legacy un-decodable events
- [x] **Subscribe_private V3** — V2→V3 structs, ix builder placeholders, vault PDA création validated live

### In Progress

- [ ] **Ship the coset prover to the clients.** The chain now runs the coset
  verifier, but the deployed web app, the installed APK, and
  `@protocol-01/stark-prover@0.1.2` still carry the pre-coset proof blob and
  are **rejected by the chain** until rebuilt from the (unmerged)
  `b7-drop-aligned-checks` branch. The desynchronization did not disappear —
  it changed sides, and this line exists so nobody reads the redeploy as "done"
- [ ] **Soundness hardening** of the FRI/DEEP construction (see the plain-language note in the STARK section)
- [ ] **Subscribe_private renewal** live validation (Pay Now flow under logcat)
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
| Discord | [discord.gg/EfqnVmb2dV](https://discord.gg/EfqnVmb2dV) |
| GitHub | [IsSlashy/Protocol-01](https://github.com/IsSlashy/Protocol-01) |

---

<p align="center">
  <strong>Built on Solana</strong><br/>
  <sub>&copy; 2026 Volta Team &mdash; Released under the <a href="./LICENSE">MIT License</a></sub>
</p>
