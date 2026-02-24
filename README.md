<p align="center">
  <img src="docs/assets/banner.png" alt="Protocol 01" width="100%" />
</p>

<h1 align="center">Protocol 01</h1>

<p align="center">
  <strong>The privacy layer for Solana.</strong><br/>
  Zero-knowledge proofs &middot; Confidential balances &middot; Stealth addresses &middot; Shielded transfers
</p>

<p align="center">
  <a href="https://protocol-01.vercel.app">Website</a> &middot;
  <a href="https://protocol-01.vercel.app/docs">Documentation</a> &middot;
  <a href="https://x.com/Protocol01_">Twitter/X</a> &middot;
  <a href="https://discord.gg/KfmhPFAHNH">Discord</a>
</p>

---

> **PROPRIETARY SOFTWARE &mdash; ALL RIGHTS RESERVED**
>
> &copy; 2026 Volta Team | Developed by Slashy Fx
> Ps:"There no team Im all alone XD"
>
> This repository is visible for **hackathon evaluation purposes only**.
> No license is granted to use, copy, modify, fork, or distribute this code.
>
> See [LICENSE](./LICENSE) for details.

---

## 📱 Installation & Demo (For Jury)

### Mobile App (Android)

**Download APK:** [Protocol-01.apk](https://expo.dev/accounts/slashy/projects/p01-mobile/builds)*

#### Installation Steps:
1. Download the APK on your Android device
2. Open the file → Allow "Install from unknown sources" if prompted
3. Tap "Install"
4. Open Protocol 01

#### First Launch:
1. Tap **"Create Wallet"** to generate a new wallet
2. **Save your seed phrase** (12 words) - this is your backup
3. Set up biometric authentication (optional)
4. You're ready to use P-01!

<p align="center">
  <img src="docs/assets/screenshots/mobile-onboarding.png" alt="Onboarding" width="200"/>
  <img src="docs/assets/screenshots/mobile-home.png" alt="Home" width="200"/>
  <img src="docs/assets/screenshots/mobile-send.png" alt="Send" width="200"/>
</p>

---

### Browser Extension (Chrome/Brave)

**Option 1 - Chrome Web Store:** *(Coming soon)*

**Option 2 - Manual Install (Developer Mode):**

1. Download the extension: [protocol-01-extension.zip](https://github.com/user-attachments/files/extension-dist.zip)
2. Extract the ZIP file
3. Open Chrome → `chrome://extensions/`
4. Enable **"Developer mode"** (top right toggle)
5. Click **"Load unpacked"**
6. Select the extracted `dist` folder
7. Protocol 01 icon appears in your toolbar!

#### First Launch:
1. Click the P-01 icon in toolbar
2. **"Create Wallet"** or **"Import Wallet"**
3. Set a password to encrypt your wallet
4. Done!

<p align="center">
  <img src="docs/assets/screenshots/extension-home.png" alt="Extension Home" width="280"/>
  <img src="docs/assets/screenshots/extension-send.png" alt="Extension Send" width="280"/>
</p>

---

### 🎮 Demo Guide - Key Features

#### 1. Private Transfer (ZK Shielded)

Send crypto without anyone knowing who sent it or who received it.

| Step | Action |
|------|--------|
| 1 | Go to **"Privacy Zone"** or **"Shield"** |
| 2 | Deposit SOL into the shielded pool |
| 3 | Tap **"Private Send"** |
| 4 | Enter recipient address + amount |
| 5 | Confirm → ZK proof is generated |
| 6 | Transaction is completely private! |

<p align="center">
  <img src="docs/assets/screenshots/demo-shield.png" alt="Shield" width="200"/>
  <img src="docs/assets/screenshots/demo-private-send.png" alt="Private Send" width="200"/>
  <img src="docs/assets/screenshots/demo-success.png" alt="Success" width="200"/>
</p>

#### 2. Confidential Balances (zkSPL)

Hide your token balance on-chain using quantum-resistant Poseidon commitments.

| Step | Action |
|------|--------|
| 1 | Go to **"Confidential"** from Privacy Zone |
| 2 | Deposit SOL into your confidential account |
| 3 | Your balance is now hidden on-chain as a Poseidon commitment |
| 4 | Send with **"Confidential Transfer"** — amount is hidden |
| 5 | Use **"Prove Balance"** to prove you have enough for DeFi |

#### 3. Payment Streams (Recurring Payments)

Set up automatic recurring payments with privacy.

| Step | Action |
|------|--------|
| 1 | Go to **"Streams"** tab |
| 2 | Tap **"Create Stream"** |
| 3 | Enter recipient, amount, frequency |
| 4 | Choose: Weekly / Bi-weekly / Monthly |
| 5 | Enable **"Private Mode"** for stealth payments |
| 6 | Confirm → Payments run automatically! |

<p align="center">
  <img src="docs/assets/screenshots/demo-streams-list.png" alt="Streams" width="200"/>
  <img src="docs/assets/screenshots/demo-create-stream.png" alt="Create Stream" width="200"/>
  <img src="docs/assets/screenshots/demo-stream-active.png" alt="Active Stream" width="200"/>
</p>

#### 4. Stealth Addresses

Receive payments to unique one-time addresses.

| Step | Action |
|------|--------|
| 1 | Go to **"Receive"** |
| 2 | Tap **"Generate Stealth Address"** |
| 3 | Share the address or QR code |
| 4 | Each address is unique and unlinkable! |

---

### 🔧 For Developers - Test on Devnet

```bash
# Get devnet SOL
solana airdrop 2 --url devnet

# Smart Contracts (Devnet)
ZK Shielded:      GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c
zkSPL:            EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah
Specter:          2tuztgD9RhdaBkiP79fHkrFbfWBX75v7UjSNN4ULfbSp
Subscription:     5kDjD9LSB1j8V6yKsZLC9NmnQ11PPvAY6Ryz4ucRC5Pt
Stream:           2yH26XmXwgPuHMvV1NbmgJin32rfP3msQt18W6168mws
Fee Splitter:     muCWm9ionWrwBavjsJudquiNSKzNEcTRm5XtKQMkWiD
Whitelist:        AjHD9r4VubPvxJapd5zztf1Yqym1QYiZaQ4SF5h3FPQE
```

---

## What is Protocol 01?

Protocol 01 is a privacy-first financial ecosystem on Solana.
It combines **Groth16 zero-knowledge proofs**, **ECDH stealth addresses**, and a **private relay network** to deliver fully untraceable transactions.

Unlike mixers or tumblers, P-01 provides **cryptographic privacy** at the protocol level.
Amounts, senders, and recipients are hidden by default through ZK circuits, not operational obfuscation.

```
User creates ZK proof (Groth16)
    -> Proof sent to relayer
        -> Relayer verifies off-chain (snarkjs)
            -> Funds sent to stealth address
                -> No on-chain link between sender and recipient
```

---

## Architecture

```
protocol-01/
├── apps/
│   ├── extension/          # Chrome/Brave extension wallet (Manifest V3)
│   ├── mobile/             # React Native (Expo) mobile wallet
│   └── web/                # Next.js marketing site & SDK demo
├── packages/
│   ├── p01-js/             # @p01/sdk — Merchant integration (Protocol01 client)
│   ├── specter-sdk/        # @p01/specter-sdk — Stealth wallets & transfers (P01Client)
│   ├── zk-sdk/             # @p01/zk-sdk — ZK proof generation (ShieldedClient)
│   ├── zkspl-sdk/          # @p01/zkspl-sdk — Confidential balances (ZkSplClient)
│   ├── auth-sdk/           # @p01/auth-sdk — "Login with P-01" authentication
│   ├── whitelist-sdk/      # @p01/whitelist-sdk — On-chain developer whitelist
│   ├── specter-js/         # @p01/js — Pay button & browser SDK
│   ├── ui/                 # @p01/ui — Shared design system & components
│   └── sdk/                # @p01/stream — Payment stream utilities
├── circuits/
│   ├── transfer.circom              # Main ZK circuit (2-in-2-out, Merkle depth 20)
│   ├── confidential_balance.circom  # zkSPL balance commitment circuit (1,382 constraints)
│   ├── balance_proof.circom         # zkSPL balance sufficiency proof (644 constraints)
│   ├── merkle.circom                # Merkle tree membership proof
│   └── poseidon.circom              # ZK-friendly hash function
├── programs/
│   ├── zk_shielded/        # Shielded pool — shield/transfer/unshield with Groth16
│   ├── p01_zkspl/          # zkSPL — confidential balances with Poseidon commitments
│   ├── specter/            # Stealth address registry + private streams
│   ├── subscription/       # Recurring payments with delegated authority
│   ├── stream/             # Time-locked payment streaming (escrow)
│   ├── whitelist/          # Developer access control
│   └── p01-fee-splitter/   # Fee routing (0.5% protocol fee)
└── services/
    ├── prover/             # Rust native Groth16 prover (ark-circom, ~50ms proofs)
    └── relayer/            # Express.js — ZK verification, proof gen, subscription crank
```

---

## Privacy Stack

### Zero-Knowledge Proofs (Groth16)

Circuits written in **Circom**, proven with **snarkjs**.
Verified on-chain via Solana's native `alt_bn128` syscalls.

| Parameter | Value |
|-----------|-------|
| Proving system | Groth16 (BN254) |
| Hash function | Poseidon (ZK-native, ~300x fewer constraints than Keccak) |
| Merkle tree depth | 20 (~1M notes capacity) |
| Transfer model | 2-in-2-out (UTXO-style) |
| On-chain verification | ~200K compute units |

The circuit proves:
1. **Ownership** &mdash; Prover holds the spending key for input notes
2. **Membership** &mdash; Notes exist in the on-chain Merkle tree
3. **Nullifiers** &mdash; Prevents double-spending without revealing which note was spent
4. **Conservation** &mdash; Input amounts = output amounts + public amount

### Stealth Addresses (ECDH)

Adapted from Ethereum's EIP-5564 for Solana.
Each payment creates a **unique one-time address** using Elliptic Curve Diffie-Hellman key exchange.

```
Sender: ephemeralKey = random()
Shared secret = ECDH(ephemeralKey, recipientViewingKey)
Stealth address = recipientSpendingKey + H(sharedSecret) * G
```

The recipient scans incoming payments using a **viewTag** (2-byte fast filter).
Then derives the private key to spend.

### Shielded Pool

On-chain Anchor program.
Stores encrypted notes in a sparse Merkle tree.

| Instruction | Description |
|-------------|-------------|
| `shield` | Deposit transparent SOL/SPL into the pool |
| `transfer` | Private 2-in-2-out transfer within the pool |
| `transfer_via_relayer` | Gasless private transfer via relay |
| `unshield` | Withdraw from pool back to transparent balance |

### zkSPL — Confidential Token Balances (Quantum-Resistant)

Account-model privacy layer. Hides balances and transfer amounts on-chain using **Poseidon hash commitments** — a quantum-resistant alternative to ECC-based schemes like Pedersen.

```
Balance on-chain = Poseidon(balance, salt, owner_pubkey, token_mint)
                   ↑ nobody can reverse this without the salt
```

| Parameter | Value |
|-----------|-------|
| Commitment scheme | Poseidon hash (quantum-resistant, no ECC) |
| Circuit: balance update | `confidential_balance.circom` (1,382 constraints) |
| Circuit: sufficiency proof | `balance_proof.circom` (644 constraints) |
| Conservation law | `old_balance + credit === new_balance + debit` |
| DeFi composable | Yes — `proveBalance(threshold)` without revealing balance |

**Operations:**
- **Deposit** — SPL tokens into confidential account (amount public, balance hidden)
- **Withdraw** — From confidential back to transparent (amount public, remaining hidden)
- **Confidential Transfer** — Private send to another user (amount hidden as `Poseidon(amount, salt)`)
- **Balance Proof** — Prove `balance >= threshold` for DeFi without revealing actual balance

**Why quantum-resistant?**
Pedersen commitments (`C = v·G + r·H`) rely on elliptic curves — broken by Shor's algorithm.
Poseidon commitments (`C = Hash(v, r, ...)`) rely on algebraic hashes — immune to quantum attacks.
The Groth16 proof system is ephemeral and can be migrated to STARKs later.

### Private Relay

The relayer breaks the on-chain link between sender and recipient:

1. User generates a ZK proof client-side
2. User funds the relayer (amount + 0.5% fee + gas)
3. Relayer verifies the proof off-chain (snarkjs)
4. Relayer sends funds from its own wallet to the stealth address
5. On-chain: only `Relayer -> Stealth Address` is visible

The relayer network supports **health checks**, **load balancing**, and **random selection**.
Maximum privacy through relay diversity.

---

## Products

### Browser Extension

Full Solana wallet as a Chrome/Brave extension.
Built on Manifest V3.

- Wallet creation & import (BIP39)
- SOL & SPL token management with real-time prices
- Privacy Zone: stealth addresses + shielded transfers
- Confidential balances (zkSPL) — quantum-resistant hidden balances
- Payment streams dashboard
- dApp connection (Wallet Standard)
- AES-256-GCM seed encryption (PBKDF2, 100K iterations)

**Stack:** React 18, TypeScript, Zustand, Vite, TailwindCSS, @solana/web3.js

### Mobile App

Native wallet for iOS and Android.
Privacy on the go.

- Biometric authentication (Face ID / Fingerprint)
- QR code payments
- Confidential balances (zkSPL) — quantum-resistant hidden balances
- Push notifications
- AI-powered assistant
- Payment streams management
- Cloud backup (Privy integration)

**Stack:** React Native, Expo, Expo Router, NativeWind, Reanimated 3

### Web Application

Marketing site, SDK demo, and documentation portal.
Built with Next.js 16 and Framer Motion.

**Stack:** Next.js 16, TypeScript, TailwindCSS v4, Framer Motion

### SDK

```typescript
// @p01/specter-sdk — Stealth wallets & private transfers
import { P01Client, createWallet, sendPrivate } from '@p01/specter-sdk';

const client = new P01Client({ cluster: 'devnet' });
const wallet = await createWallet();
await client.connect(wallet);

// Send to stealth address (recipient unlinkable on-chain)
await sendPrivate({ amount: 1.5, recipient: stealthMetaAddress });

// Create payment stream (time-locked escrow)
await client.createStream({ recipient, amount: 10, duration: 30 * 86400 });
```

```typescript
// @p01/zk-sdk — Shielded pool with Groth16 ZK proofs
import { ShieldedClient } from '@p01/zk-sdk';

const zkClient = new ShieldedClient({ rpcUrl, programId });

await zkClient.shield(1_000_000_000n, notes);      // Deposit 1 SOL to private pool
await zkClient.transfer(proofInputs);               // Private transfer (amount hidden)
await zkClient.unshield(outputNotes, 500_000_000n); // Withdraw to public address
```

```typescript
// @p01/zkspl-sdk — Confidential balances with quantum-resistant commitments
import { ZkSplClient } from '@p01/zkspl-sdk';

const client = new ZkSplClient({ connection, wallet, spendingKey });

await client.createAccount(tokenMint);                         // Create confidential account
await client.deposit(tokenMint, 1_000_000_000n);               // Deposit 1 SOL (balance hidden)
await client.confidentialTransfer(tokenMint, recipient, amount); // Private transfer
await client.proveBalance(tokenMint, 500_000_000n);            // Prove balance >= 0.5 SOL (DeFi)
```

```typescript
// @p01/sdk — Merchant integration & subscriptions
import { Protocol01 } from '@p01/sdk';

const p01 = new Protocol01({ merchantId: 'my-saas', merchantName: 'My App' });
await p01.requestPayment({ amount: 29.99, description: 'Pro Plan' });
await p01.createSubscription({ amount: 9.99, interval: 'monthly' });
```

---

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Seed phrase | AES-256-GCM, PBKDF2 (100K iterations) |
| Note storage | XChaCha20-Poly1305 |
| Key management | Keys never leave the device |
| ZK soundness | Invalid proofs cannot be generated |
| ZK completeness | Valid spends always produce valid proofs |
| Zero-knowledge | Proofs reveal nothing beyond validity |
| Double-spend | Nullifiers are unique per note, stored on-chain |
| Quantum resistance | Poseidon commitments immune to Shor's algorithm |
| Balance hiding | Commitments reveal nothing about the underlying balance |

**Threat model:**
Blockchain observers cannot link senders to recipients.
Amounts are hidden within the shielded pool.
Spending patterns cannot be analyzed.

---

## Development

### Prerequisites

- Node.js 18+
- pnpm 8+
- Rust + Anchor CLI (for on-chain programs)
- Circom 2.x (for circuit compilation)

### Quick Start

```bash
git clone https://github.com/IsSlashy/Protocol-01.git
cd Protocol-01

pnpm install

pnpm dev           # All apps
pnpm dev:web       # Web only
pnpm dev:extension # Extension only
pnpm dev:mobile    # Mobile only (requires Expo Go)
```

### Build

```bash
pnpm build:extension    # -> apps/extension/dist
pnpm build:web          # -> apps/web/.next
pnpm build:mobile       # Expo EAS build
```

### Circuit Compilation

```bash
cd circuits

# Shielded pool circuit (UTXO transfers)
circom transfer.circom --r1cs --wasm --sym -o build

# zkSPL confidential balance circuits
circom confidential_balance.circom --r1cs --wasm --sym -l node_modules -o build
circom balance_proof.circom --r1cs --wasm --sym -l node_modules -o build

# Key generation (same pattern for all circuits)
snarkjs groth16 setup build/transfer.r1cs pot_final.ptau transfer.zkey
snarkjs zkey export verificationkey transfer.zkey vk.json
```

---

## Testing & Quality Assurance

Protocol 01 maintains comprehensive test coverage across all layers of the stack.

### Test Coverage Summary

| Layer | Suite | Tests | Status |
|---|---|---|---|
| **Smart Contracts** | Anchor/Rust (7 programs) | 340+ | Localnet |
| **Extension** | React components (14 files) | 195 | Passing |
| **Web App** | Next.js components + API (18 files) | 369 | Passing |
| **Mobile App** | Stores, services, crypto (17 files) | 426 | Passing |
| **auth-sdk** | Client + Server + Protocol | 123 | Passing |
| **p01-js** | SDK core + Registry + Protocol01 | 267 | Passing |
| **specter-sdk** | Stealth, wallet, transfers, client | 129 | Passing |
| **zk-sdk** | Notes, Merkle, keys, client | 131 | Passing |
| **zkspl-sdk** | Confidential balances, Poseidon, proofs | 40+ | Passing |
| **ZK Circuits** | confidential_balance + balance_proof | 40 | Passing |
| **whitelist-sdk** | On-chain whitelist operations | 40 | Passing |
| **ui** | Design tokens + theme | 85 | Passing |
| **relayer** | Private send + stealth + ZK verify | 20 | Passing |
| **E2E Integration** | Full protocol flows (4 scenarios) | 81 | Devnet |
| **TOTAL** | **62+ test files** | **~2255+** | |

### What's Tested

- **On-chain programs**: PDA derivation, instruction handlers, state machines, error codes, account sizes, vesting math, Bloom filter nullifiers, Groth16 proof verification
- **Privacy flows**: Stealth address generation/scanning/claiming, ZK shield/transfer/unshield, payment splitting, relayer routing
- **zkSPL**: Confidential balance circuits (Poseidon commitments, conservation law, range proofs), deposit/withdraw/transfer/apply-pending, balance sufficiency proofs
- **Auth protocol**: Session lifecycle, QR generation, Ed25519 signature verification, subscription proofs, replay prevention
- **Frontend**: All major components, user interactions, wallet connection, payment flows, settings
- **SDK**: Full API coverage with mocked Solana RPC, error handling, edge cases

### Running Tests

```bash
# All unit tests (SDK + apps)
pnpm test

# Smart contract tests (requires local validator)
anchor test

# E2E integration tests
pnpm test:e2e

# Individual packages
pnpm --filter auth-sdk test
pnpm --filter p01-js test
pnpm --filter specter-sdk test
```

### CI/CD

Automated via GitHub Actions on every push/PR:
1. **Lint** -- ESLint + Prettier
2. **Build** -- TypeScript compilation across all packages
3. **Test** -- Full test suite execution

### Security Practices

- **No hardcoded secrets** -- All API keys and private keys use environment variables
- **`.env` files gitignored** -- `.env.example` files document required variables without exposing values
- **TypeScript strict mode** -- Enabled across the entire monorepo
- **Input validation** -- All API endpoints and SDK methods validate inputs
- **ZK proof verification** -- Server-side Groth16 proof verification with nullifier tracking to prevent double-spends
- **Stealth address privacy** -- ECDH key exchange ensures only the recipient can detect and claim payments
- **Proprietary license** -- Code visible for hackathon evaluation only

---

## Roadmap

### Shipped

- [x] Chrome/Brave extension wallet
- [x] Mobile app (iOS/Android)
- [x] ZK shielded pool (Groth16, Circom)
- [x] Stealth addresses (ECDH)
- [x] Private relay (off-chain ZK verification)
- [x] Payment streams (SPL)
- [x] Jupiter swap integration
- [x] Fiat on-ramp (MoonPay, Ramp)
- [x] SDK v1 (@p01/sdk, @p01/zk-sdk)
- [x] zkSPL confidential balances (quantum-resistant Poseidon commitments)
- [x] Rust native Groth16 prover (~50ms proofs vs ~3min in JS)
- [x] zkSPL SDK (@p01/zkspl-sdk)

### In Progress

- [ ] DeFi composability spec (balance proof verification for lending/DEX)
- [ ] On-chain relayer (Anchor program)
- [ ] Decentralized relayer network

### Future

- [ ] Mainnet deployment + security audit
- [ ] Cross-chain bridges
- [ ] Desktop app (Windows/macOS)
- [ ] CLI tool
- [ ] DAO governance
- [ ] Hardware wallet support

---

## Links

| | |
|---|---|
| Website | [protocol-01.vercel.app](https://protocol-01.vercel.app) |
| Documentation | [protocol-01.vercel.app/docs](https://protocol-01.vercel.app/docs) |
| Roadmap | [protocol-01.vercel.app/roadmap](https://protocol-01.vercel.app/roadmap) |
| Twitter/X | [@Protocol01_](https://x.com/Protocol01_) |
| Discord | [discord.gg/KfmhPFAHNH](https://discord.gg/KfmhPFAHNH) |
| GitHub | [IsSlashy/Protocol-01](https://github.com/IsSlashy/Protocol-01) |

---

<p align="center">
  <strong>Built on Solana</strong><br/>
  <sub>&copy; 2026 Volta Team &mdash; All rights reserved</sub>
</p>
