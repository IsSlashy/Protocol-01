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
  <a href="https://x.com/Styx_PQ">Twitter/X</a> &middot;
  <a href="https://discord.gg/EfqnVmb2dV">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/IsSlashy/Protocol-01/releases/latest"><img src="https://img.shields.io/github/v/release/IsSlashy/Protocol-01?color=39c5bb" alt="Latest release" /></a>
  &middot;
  <a href="https://github.com/IsSlashy/Protocol-01/releases/latest"><strong>Download Android APK (latest tag v1.0.3, 2026-06-16)</strong></a>
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
> For investment or partnership inquiries &mdash; [reach out](https://x.com/Styx_PQ).

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

Privacy tab → **Shield** → choose a denomination (0.1 / 1 / 10 / 100 / 500 / 1000 SOL; only the first two have ever been used). A STARK shield proof is generated on-device (no on-device timing is published: the only on-device proving figure ever measured is circuit 3 at 1,482 ms on 2026-08-03, and the ">180 s" once quoted here was a client worker timeout rather than a proving time, see the mobile section below) and the deposit lands in the pool. Wait ~30 s for the deposit to confirm and for the wallet to re-scan. This is a confirmation wait, not a privacy delay: nothing on chain makes a note age before it can be spent. Every client pins `min_epoch = 0`, the unshield handler discards the field outright, and the subscribe gate compares against the absolute epoch counter, measured 2026-08-17, `1121 >= 2` is always true, so the gate never bites.

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
`declare_id!` constants in `programs/`, checked against the devnet cluster on
2026-09-14. The STARK verifier was redeployed on devnet 2026-09-12, slot
497,235,406, and carries 801,457 bytes of program data; every verifier figure in
this README is measured against that deployment on the real devnet cluster, and
the raw numbers are in
[`docs/BENCHMARK-2026-09-13.md`](docs/BENCHMARK-2026-09-13.md).

Four programs carry the product path today:

| Program | ID |
|---|---|
| STARK Verifier (8 circuits) | `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs` |
| ZK Shielded Pool (V4: shield, unshield, subscribe, pause, resume) | `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c` |
| Registry (merchant services + stealth meta-addresses) | `QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB` |
| Relayer (deployed, no node operating it since 2026-08-28) | `2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW` |

Two more are declared by a crate and deployed, but no shipping flow calls them:

| Program | ID |
|---|---|
| Arcium MPC Bridge (client integration removed 2026-07) | `FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT` |
| Liquidity Pool (instant unshield, SDK module + mobile service) | `6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg` |

`p01_zkspl`, `stream`, `subscription` and `whitelist` are in the repo but their
declared IDs are not deployed on devnet. Four programs were **closed on devnet
on 2026-09-13** and their crates deleted from the repo: `specter`,
`p01_quantum_vault`, `p01_quantum_wallet` and `p01_fee_splitter`
([`docs/HANDOFF-2026-09-13.md`](docs/HANDOFF-2026-09-13.md) §11 and §12).
Older deployments of some of these under superseded IDs still exist on devnet;
no crate declares them and no product path calls them.

---

## What is Styx Protocol?

Styx Protocol is a **post-quantum-oriented privacy layer for Solana**, shipped as composable SDKs and a set of on-chain programs.

The stack combines **STARKs** (hash-based, no trusted setup), **hybrid stealth addresses** (X25519 + ML-KEM-768, the NIST-standardized post-quantum KEM), **Winternitz one-time signatures**, and a **custom on-chain FRI verifier**. The *proof* system is chosen so that no proof falls to Shor: no pairing-based proofs, no trusted setup, hash commitments throughout. The *stack* is not in that position, and saying otherwise here was wrong until 2026-08-17. Solana verifies **Ed25519** and nothing else, so spend authority falls to Shor whatever this layer does. Worse for the pool specifically: the web pool seed is `HKDF(one Ed25519 signature over a fixed message)`, so an adversary who recovers the wallet key re-signs that message, reproduces the seed, and re-derives every note it ever held — retroactively. A user passphrase (derivation v2) closes that for pool notes created after it is set, and reaches neither the stealth identity nor the extension nor mobile. On what the proof bytes reveal: until 2026-08-31 a private witness could be recovered from published proof bytes by interpolation against the AIR (four C1 witnesses in 5 ms, probe `P3b` of `verify/p01-verify.mjs`, kept as the positive control). Every one of the eight circuits now carries a blinding mask, and the claim made for it is exactly this: **statistical hiding in the random-oracle model**, argued in [`docs/zk-simulation-argument.md`](docs/zk-simulation-argument.md) and measured by the X5 uniformity test on all eight circuits (2026-09-11). The words "zero-knowledge" are not used as a property of this protocol. On the mask itself one item stays open: the prover functions take it from the caller and check only its length; the shipped wasm draws it from the OS CSPRNG (`docs/LEAK-LEDGER.md`, A8). The ledger's other families (A7, A9 to A11, B to G) list what the proof bytes, the chain, the verifier and the clients still reveal.

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
- **Note contents** (owner, blinding) are never posted in clear on-chain, and
  since the 2026-08-31 masks the proof bytes no longer allow trace recovery by
  interpolation on any of the eight circuits (see the hiding paragraph above
  and `docs/LEAK-LEDGER.md` A1, A2, A5).

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
│   ├── specter-sdk/        # npm 0.4.3 (0.5.0 in repo, publish pending) — service registry, stealth meta-addresses
│   ├── merchant-sdk/       # npm 0.1.3 — server-side: register, payment polling, vaults, permissionless claims, access tokens
│   ├── privacy-sdk/        # npm 1.0.5 (2.0.0 in repo, publish pending) — shield/unshield/subscribe with STARK proofs
│   ├── zkspl-sdk/          # npm 0.1.3 — confidential SPL balances (Poseidon commitments)
│   ├── zk-sdk/             # npm 1.0.2 — low-level note + Merkle primitives
│   ├── arcium-sdk/         # npm 0.1.2 — MPC compute client (client integration removed 2026-07, see below)
│   ├── auth-sdk/           # npm 0.1.1 — "Login with P-01"
│   ├── p01-js/             # npm 0.3.2 — merchant pay button & browser SDK
│   ├── privacy-toolkit/    # npm 1.0.4 — Merkle trees, Goldilocks-Poseidon, commitment helpers
│   ├── rpc-config/         # npm 0.1.2 — shared RPC connection manager
│   ├── stark-prover/       # npm 0.1.3 (0.2.0 in repo, publish pending) — WASM STARK prover bindings, 262,363-byte blob
│   ├── whitelist-sdk/      # unpublished — developer whitelist
│   ├── react-native-zk/    # unpublished — STARK prover packaged for React Native
│   ├── pay-core/           # unpublished — /pay page core
│   ├── specter-js/         # unpublished
│   └── ui/                 # unpublished — shared design tokens + components
├── circuits/                   # One design note (ZKSPL.md). The legacy Circom circuits are gone.
├── programs/                   # 10 Anchor crates (declared IDs; deployment status in the table above)
│   ├── zk_shielded/            # Shielded pool V4 — shield/unshield/subscribe/pause/resume/claim (STARK)
│   ├── p01_stark_verifier/     # On-chain FRI verifier (8 circuit AIRs, Goldilocks)
│   ├── p01_registry/           # Stealth meta-address directory + Service Registry (retailers)
│   ├── p01_relayer/            # On-chain relay + chunked submit + reputation decay
│   ├── p01_arcium/             # MPC bridge program (deployed; clients no longer call it)
│   ├── p01_liquidity/          # Instant-unshield liquidity pool (deployed; SDK module + mobile service)
│   ├── p01_zkspl/              # (in repo, not deployed) Confidential SPL balances (Poseidon commitments)
│   ├── subscription/           # (in repo, not deployed; logic merged into zk_shielded)
│   ├── stream/                 # (in repo, not deployed) Time-locked payment streaming
│   └── whitelist/              # (in repo, not deployed) Developer access control
│   # specter, p01_quantum_vault, p01_quantum_wallet, p01_fee_splitter: closed on devnet and deleted 2026-09-13
└── stark/                      # Winterfell STARK prover (Goldilocks field, Poseidon AIR, WASM)
```

---

## Privacy Stack

### Hash-based STARKs

Hash-based, transparent, and post-quantum. No trusted setup, no `.ptau` ceremony, no `.zkey` artifacts. The hiding claim is the narrow one stated above (statistical, random-oracle model, measured on all eight circuits), which is why this heading does not say "ZK".

| Parameter | Value |
|-----------|-------|
| Proving system | STARK (FRI-based) |
| Field | Goldilocks (`p = 2^64 − 2^32 + 1`) |
| Hash function | Poseidon (full S-box `x^7`, 30 rounds) |
| Configured FRI parameters | 22 queries on `merkle_path`, `transfer`, `merkle_update` and `spend`, 27 on the other four circuits; blowup 16. Stated as configuration; no security-bit figure is derived from them |
| On-chain verification cost | Two instructions, measured on devnet 2026-09-02/03 against the verifier redeployed in slot 491,973,056: **phase 1 878,756 CU**, **phase 2 193,200 CU** (193,026 on the black-box honest run), against the 1,400,000 transaction budget |
| Circuits | 8 AIRs — C0 subscriber ownership, C1 denominated pool (pool commitment), C2 balance proof, C3 Merkle path, C4 confidential balance, C5 transfer, C6 Merkle update (shield), C7 spend (unshield v4, subscription v4). All eight proved by the shipped blob and verified on devnet 2026-09-12 (`docs/BENCHMARK-2026-09-13.md` §6, §6b) |

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
because the imprecise version would oversell it: the coset removes the
verbatim-cell line, and until 2026-08-31 trace values could still be recovered
by Lagrange interpolation (`stark/tests/air_aware_recovery_c1.rs` recovered all
four C1 private inputs). A blinding region and a lift column shipped on the
production circuits C1, C3, C6 and C7 that day, and on all eight circuits by
2026-09-11 (`docs/LEAK-LEDGER.md` A1, A2, A5, ?2 closed); the same solver now
reads under-determined, with the pre-mask model kept beside it as the positive
control. The committed channels of the proof are measured uniform in the mask
(`stark/src/compact/zk_hiding.rs`, the X5 uniformity test, on all eight
circuits), and a simulator built from the verifier's own equations and no
witness passes every one of them at the algebraic layer (2026-09-02). **That is
a statistical argument in the random-oracle model, executed on the shipping
query count, not a theorem over every witness and challenge**: the word
*zero-knowledge* is still not used here. On the mask itself one item is open,
A8: the prover functions take the mask from the caller and check only its length
(the shipped wasm draws it from the OS CSPRNG, other callers are trusted).
A7 and A9 to A11 stay open on the proof bytes, and the B to G families of
`docs/LEAK-LEDGER.md` cover what the chain, the verifier and the clients reveal.
`docs/zk-simulation-argument.md` says exactly what is and is not claimed.

The on-chain verifier is written from scratch (no Winterfell dependency at
runtime) and carries **801,457 bytes** of program data, upgraded in place on
devnet 2026-09-12, slot 497,235,406, with the uniform masks. Measured on that
deployment on 2026-09-12 (`docs/BENCHMARK-2026-09-13.md` §6, §6b, one
transaction signature per row): an honest C7 spend proof verifies at
**890,643 CU** with both phases merged in one transaction, C6 shield at
901,023 CU, C3 Merkle path at 878,411 CU; the two-transaction circuits pay
312,010 (C2), 391,977 (C1) and 438,682 (C5) CU in phase 2. Rejection is
attributed, not assumed: on the previous deployment (2026-09-02/03,
`docs/BENCHMARK-2026-09-02.md`) a forged FRI byte rejected `InvalidProof`
(6003) at 277,171 CU, a forged Merkle byte at 26,423 CU, and a tampered public
input at 18,110 CU. The interesting part is that a forged FRI byte costs the
verifier more than the cheap rejections: the forgery is caught at step 3.5,
after the work, and only the two cheap rejections short-circuit.

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

### Quantum-Safe Vault (closed 2026-09-13)

The `p01_quantum_vault` program (WOTS+ 67-chain, SHA-256 hash-timelock,
commit-then-reveal) and the `p01_quantum_wallet` design were closed on devnet
and removed from the repo on 2026-09-13 (`docs/HANDOFF-2026-09-13.md` §11).
The design notes stay under `docs/` for the record; no shipping client offers
the vault. Ed25519 remains the signing boundary for every Solana transaction.

### On-Chain Relay Program (deployed, not operated)

The `p01_relayer` program is deployed on devnet and accepts encrypted relay
jobs, but **no node operates it**. Both hosted relayer nodes were retired on
2026-08-28 (`services/relayer/README.md`): between them they picked up 10 relay
jobs in 45 days and reported `lastPollCount: 0` throughout. The funding shape
was wrong as well, because the user's own wallet pre-funded the relay-job
ephemeral, so the fee payer moved one hop instead of disappearing. Nothing in
this README depends on a relayer being up.

Two paths ship in its place, and both are submitted by the spender:

- the **direct circuit-7 spend** (`unshield_denominated_stark_v4`), which binds
  the recipient in the proof;
- the **note-in exchange**, where a buyer withdraws their own note to the till
  and collects an older issued note in return
  ([`docs/NOTE-IN-EXCHANGE-2026-09-02.md`](docs/NOTE-IN-EXCHANGE-2026-09-02.md)).

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

- STARK prover runs on-device inside a hidden WebView (WASM). No on-device
  timing is advertised here. The ">180 s" this list used to quote was never a
  proving time: it is the client worker timeout in the mobile prover provider,
  raised from 60 s after two circuits timed out on a test handset, so it bounds
  the whole flow and not the prover. The only on-device proving figure ever
  measured is circuit 3 at 1,482 ms (2026-08-03), and nothing newer exists. A
  full unshield still does not complete on the installed build, whose prover
  blob predates the deployed verifier
- Tabs: Wallet, Privacy, Streams (the Agent tab and its on-device model were removed on 2026-09-13)
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
(MIT), versions read from the registry on 2026-09-14: arcium-sdk 0.1.2,
auth-sdk 0.1.1, merchant-sdk 0.1.3, p01-js 0.3.2, privacy-sdk 1.0.5,
privacy-toolkit 1.0.4, rpc-config 0.1.2, specter-sdk 0.4.3, stark-prover
0.1.3, zk-sdk 1.0.2, zkspl-sdk 0.1.3. The repo carries newer builds not yet
published: privacy-sdk 2.0.0 and specter-sdk 0.5.0 (the modules that spoke to
the four programs closed on 2026-09-13 are gone) and stark-prover 0.2.0 (the
0ad6d7f1 blob that matches the 2026-09-12 verifier). The packed tarballs also
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
figure. For the state of the Rust verifier suites, the stark-prover package and
the web pool suite as of 2026-09-13, see
[`docs/HANDOFF-2026-09-13.md`](docs/HANDOFF-2026-09-13.md) §4c.

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

### Latest tag — v1.0.3 (2026-06-16); notes below are from v1.0.1 (hotfix · 2026-05-29)

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
- [x] STARK verifier on-chain (custom FRI, 8 circuits, Goldilocks; uniform masks on all eight since the 2026-09-12 redeploy)
- [x] ~~Quantum vault (WOTS+ 67-chain, hash-timelock, commit-reveal)~~ closed on devnet and removed 2026-09-13
- [x] On-chain stealth meta-address registry
- [x] **On-chain Service Registry** (retailers register as first-class merchants)
- [x] **Subscription vaults are one-way** — cancellation and refunds removed from the program; `claim_period` closes an exhausted vault and pays the remainder + rent to the retailer
- [x] **Boot-time auto-recovery** (blocking lazy-load rescan from seed)
- [x] Instant unshield via `p01_liquidity` prefund pool
- [x] Arcium MPC bridge program + SDK (9 circuits — client integration later removed, 2026-07)
- [x] On-chain relayer program + Tor-routed RPC middleware (both hosted nodes retired 2026-08-28; the program is deployed, nobody operates it)
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

- [ ] **Ship the masked prover blob to every client.** The chain runs the
  uniform-mask verifier since 2026-09-12 and the web app on `master` carries
  the matching `0ad6d7f1` blob (`docs/HANDOFF-2026-09-13.md` §7). The APK tagged
  v1.0.3 (2026-06-16) and `@protocol-01/stark-prover@0.1.3` on npm predate it
  and their proofs are **rejected by the chain** until a new APK is released and
  stark-prover 0.2.0 is published. This line exists so nobody reads the redeploy
  as "done" for mobile
- [ ] **Soundness hardening** of the FRI/DEEP construction (see the plain-language note in the STARK section)
- [ ] **Subscribe_private renewal** live validation (Pay Now flow under logcat)
- [ ] Universal `LeafInserted` canonical event
- [ ] DeFi composability spec (balance proof verification for lending/DEX)

### Future

- ~~**Quantum Wallet** (`p01_quantum_wallet`)~~ — retired 2026-09-13: the program was closed on devnet and its crate removed. The 2026-05-09 design note stays in `docs/quantum-wallet-ux-design.md` for the record
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
| Twitter/X | [@Styx_PQ](https://x.com/Styx_PQ) |
| Discord | [discord.gg/EfqnVmb2dV](https://discord.gg/EfqnVmb2dV) |
| GitHub | [IsSlashy/Protocol-01](https://github.com/IsSlashy/Protocol-01) |

---

<p align="center">
  <strong>Built on Solana</strong><br/>
  <sub>&copy; 2026 Volta Team &mdash; Released under the <a href="./LICENSE">MIT License</a></sub>
</p>
