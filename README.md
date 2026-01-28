<p align="center">
  <img src="docs/assets/banner.png" alt="Protocol 01" width="100%" />
</p>

<h1 align="center">Protocol 01</h1>

<p align="center">
  <strong>The privacy layer for Solana.</strong><br/>
  Zero-knowledge proofs &middot; Stealth addresses &middot; Shielded transfers
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
>
> This repository is visible for **hackathon evaluation purposes only**.
> No license is granted to use, copy, modify, fork, or distribute this code.
> See [LICENSE](./LICENSE) for details.

---

## What is Protocol 01?

Protocol 01 is a privacy-first financial ecosystem on Solana. It combines **Groth16 zero-knowledge proofs**, **ECDH stealth addresses**, and a **private relay network** to deliver fully untraceable transactions.

Unlike mixers or tumblers, P-01 provides **cryptographic privacy** at the protocol level &mdash; amounts, senders, and recipients are hidden by default through ZK circuits, not operational obfuscation.

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
│   ├── extension/          # Chrome/Brave extension wallet
│   ├── mobile/             # React Native (Expo) mobile wallet
│   └── web/                # Next.js marketing site & SDK demo
├── packages/
│   ├── sdk/                # @p01/sdk — dApp integration
│   ├── zk-sdk/             # @p01/zk-sdk — ZK proof generation (WASM)
│   ├── specter-sdk/        # Stealth address operations
│   └── specter-js/         # React hooks for dApp devs
├── circuits/
│   ├── transfer.circom     # Main ZK circuit (2-in-2-out, Merkle depth 20)
│   ├── merkle.circom       # Merkle tree membership proof
│   └── poseidon.circom     # ZK-friendly hash function
├── programs/
│   ├── zk_shielded/        # Anchor program — shielded pool (shield/transfer/unshield)
│   ├── specter/            # Anchor program — stealth address registry
│   └── stream/             # Anchor program — payment streams
└── services/
    └── relayer/            # Express.js — ZK verification + private transfers
```

---

## Privacy Stack

### Zero-Knowledge Proofs (Groth16)

Circuits written in **Circom**, proven with **snarkjs**, verified on-chain via Solana's native `alt_bn128` syscalls.

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

Adapted from Ethereum's EIP-5564 for Solana. Each payment creates a **unique one-time address** using Elliptic Curve Diffie-Hellman key exchange.

```
Sender: ephemeralKey = random()
Shared secret = ECDH(ephemeralKey, recipientViewingKey)
Stealth address = recipientSpendingKey + H(sharedSecret) * G
```

The recipient scans incoming payments using a **viewTag** (2-byte fast filter), then derives the private key to spend.

### Shielded Pool

On-chain Anchor program storing encrypted notes in a sparse Merkle tree.

| Instruction | Description |
|-------------|-------------|
| `shield` | Deposit transparent SOL/SPL into the pool |
| `transfer` | Private 2-in-2-out transfer within the pool |
| `transfer_via_relayer` | Gasless private transfer via relay |
| `unshield` | Withdraw from pool back to transparent balance |

### Private Relay

The relayer breaks the on-chain link between sender and recipient:

1. User generates a ZK proof client-side
2. User funds the relayer (amount + 0.5% fee + gas)
3. Relayer verifies the proof off-chain (snarkjs)
4. Relayer sends funds from its own wallet to the stealth address
5. On-chain: only `Relayer -> Stealth Address` is visible

The relayer network supports **health checks**, **load balancing**, and **random selection** for maximum privacy.

---

## Products

### Browser Extension

Full Solana wallet as a Chrome/Brave extension (Manifest V3).

- Wallet creation & import (BIP39)
- SOL & SPL token management with real-time prices
- Privacy Zone: stealth addresses + shielded transfers
- Payment streams dashboard
- dApp connection (Wallet Standard)
- AES-256-GCM seed encryption (PBKDF2, 100K iterations)

**Stack:** React 18, TypeScript, Zustand, Vite, TailwindCSS, @solana/web3.js

### Mobile App

Native wallet for iOS and Android.

- Biometric authentication (Face ID / Fingerprint)
- QR code payments
- Push notifications
- AI-powered assistant
- Payment streams management
- Cloud backup (Privy integration)

**Stack:** React Native, Expo, Expo Router, NativeWind, Reanimated 3

### Web Application

Marketing site, SDK demo, and documentation portal.

**Stack:** Next.js 16, TypeScript, TailwindCSS v4, Framer Motion

### SDK

```typescript
import { P01Client } from '@p01/sdk';

const client = new P01Client({ cluster: 'devnet' });
const wallet = await P01Client.createWallet();
await client.connect(wallet);

// Stealth transfer
await client.sendPrivate(recipientStealthAddress, 1.5);

// Payment stream
await client.createStream(recipient, 10, 30); // 10 SOL over 30 days
```

```typescript
import { ShieldedClient } from '@p01/zk-sdk';

const zk = new ShieldedClient({ connection, wallet });
await zk.initialize(seedPhrase);

await zk.shield(1_000_000_000n);               // Deposit 1 SOL
await zk.transfer(zkAddress, 500_000_000n);     // Private transfer
await zk.unshield(publicKey, 500_000_000n);     // Withdraw
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

**Threat model:** Blockchain observers cannot link senders to recipients, track amounts, or analyze spending patterns within the shielded pool.

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
circom transfer.circom --r1cs --wasm --sym -o build
snarkjs groth16 setup build/transfer.r1cs pot_final.ptau transfer.zkey
snarkjs zkey export verificationkey transfer.zkey vk.json
```

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

### In Progress

- [ ] On-chain relayer (Anchor program)
- [ ] Decentralized relayer network
- [ ] Advanced privacy (decoy transactions)

### Future

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
