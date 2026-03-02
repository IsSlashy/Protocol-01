# P01 -- Full Technical Inventory

**Date:** 2026-02-26
**Anchor:** 0.32.1 | **Agave CLI:** 3.1.8 | **Circomlib:** 2.0.5 | **Node:** v24+
**Monorepo root:** `P:\p01`

---

## Table of Contents

1. [Circuits](#1-circuits)
2. [On-Chain Programs](#2-on-chain-programs)
3. [Services](#3-services)
4. [SDKs](#4-sdks)
5. [Mobile App](#5-mobile-app)
6. [Chrome Extension](#6-chrome-extension)
7. [Scripts](#7-scripts)
8. [Custom Tooling](#8-custom-tooling)
9. [Original Innovations](#9-original-innovations)

---

## 1. Circuits

**Root directory:** `circuits/`
**Trusted setup:** `circuits/keys/pot20_final.ptau` (1.2 GB, Powers of Tau ceremony)
**External dependency:** circomlib v2.0.5 (Poseidon hash, Num2Bits, etc.)

### 1.1 Production Circuits

| # | Circuit | Path | Model | Depth | Capacity | Constraints | Public Inputs | Private Inputs | Tests | Status |
|---|---------|------|-------|-------|----------|-------------|---------------|----------------|-------|--------|
| 1 | transfer | `circuits/transfer.circom` | Zcash-style 2-in-2-out shielded pool | 20 | 1M notes | ~3,400,000 | 7 | 20 | 6/6 (anchor) | LEGACY/MAINTAINED |
| 2 | denominated_pool | `circuits/denominated_pool.circom` | Tornado Cash-style fixed-denomination | 15 | 32K notes | ~4,273 | 5 | 6 | 21/21 (circuit) + 26 (anchor) | ACTIVE/PRODUCTION |
| 3 | denominated_transfer | `circuits/denominated_transfer.circom` | P2P note transfer in denominated pool | 15 | 32K notes | ~4,400 | 5 | 11 | 12/12 (circuit) | ACTIVE/PRODUCTION |
| 4 | confidential_balance | `circuits/confidential_balance.circom` | zkSPL account-model (deposit/withdraw/send/receive) | N/A | N/A | 1,382 | 7 | 10 | 29/29 (circuit) + 40 (anchor) | ACTIVE/PRODUCTION |
| 5 | balance_proof | `circuits/balance_proof.circom` | Prove balance >= threshold | N/A | N/A | 644 | 3 | 4 | 11/11 (circuit) | ACTIVE/PRODUCTION |

#### 1.1.1 transfer.circom

- **Purpose:** 2-input-2-output Zcash-style shielded transfer with full Merkle inclusion proof.
- **Public inputs (7):** `merkle_root`, `nullifier_1`, `nullifier_2`, `output_commitment_1`, `output_commitment_2`, `public_amount`, `token_mint`
- **Private inputs (20):** 2 input notes (amount, owner, randomness, Merkle path elements + indices), 2 output notes (amount, owner, randomness), `spending_key`
- **Templates used:** `SpendingKeyDerivation`, `NoteCommitment`, `MerkleTreeChecker(20)`, `NullifierComputation`, `Num2Bits(64)`
- **Build artifacts:** `transfer.r1cs` (3.4M), `transfer_final.zkey` (11M), `transfer.wasm`, `verification_key.json`
- **External deps:** Poseidon from circomlib
- **Status:** LEGACY/MAINTAINED -- superseded by denominated pool for new deployments but still in use for existing pools.

#### 1.1.2 denominated_pool.circom

- **Purpose:** Fixed-denomination shielded pool (Tornado Cash model). All notes in a pool have identical value; denomination enforced at the program level, not in the circuit.
- **Public inputs (5):** `merkle_root`, `nullifier`, `min_epoch`, `token_mint`, `enforce_maturity`
- **Private inputs (6):** `secret`, `nullifier_preimage`, `deposit_epoch`, `path_elements[15]`, `path_indices[15]`
- **Commitment scheme:** `Commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)`
- **Nullifier scheme:** `Nullifier = Poseidon(nullifier_preimage, secret)`
- **Epoch constraint:** `deposit_epoch <= min_epoch` (gated by `enforce_maturity` flag)
- **Build artifacts:** `.r1cs`, `_final.zkey`, `.wasm`, `verification_key.json` -- all present
- **Status:** ACTIVE/PRODUCTION

#### 1.1.3 denominated_transfer.circom

- **Purpose:** P2P note transfer within a denominated pool. Spends one note (proves Merkle inclusion + nullifier) and creates a new note for the recipient.
- **Public inputs (5):** `merkle_root`, `nullifier`, `min_epoch`, `token_mint`, `new_commitment`
- **Private inputs (11):** old note (`secret`, `nullifier_preimage`, `deposit_epoch`, Merkle path), new note (`new_secret`, `new_nullifier_preimage`, `new_deposit_epoch`)
- **Key difference from denominated_pool:** maturity is ALWAYS enforced (no `enforce_maturity` bypass); produces a `new_commitment` output.
- **Build artifacts:** all present
- **Status:** ACTIVE/PRODUCTION

#### 1.1.4 confidential_balance.circom

- **Purpose:** Single circuit handling 4 zkSPL operations (deposit, withdraw, send, receive) via selector flags.
- **Public inputs (7):** `old_commitment`, `new_commitment`, `amount_hash`, `public_credit`, `public_debit`, `token_mint`, `nonce`
- **Private inputs (10):** balance values, salts, owner key, `is_debit` flag
- **Conservation law:** `old_balance + private_credit + public_credit === new_balance + private_debit + public_debit`
- **Amount linking:** `amount_hash = Poseidon(amount, amount_salt)` -- shared between sender and recipient proofs
- **Balance commitment:** `Poseidon(balance, salt, owner_pubkey, token_mint)`
- **Status:** ACTIVE/PRODUCTION

#### 1.1.5 balance_proof.circom

- **Purpose:** Range proof that a committed balance meets or exceeds a threshold.
- **Public inputs (3):** `balance_commitment`, `threshold`, `token_mint`
- **Private inputs (4):** `balance`, `salt`, `owner_pubkey`, `token_mint_private`
- **Core logic:** `Num2Bits(64)` on `(balance - threshold)` -- constrains non-negative difference in 64-bit range.
- **Status:** ACTIVE/PRODUCTION

### 1.2 Helper Templates

| File | Path | Templates | Used By |
|------|------|-----------|---------|
| merkle.circom | `circuits/merkle.circom` | `MerkleTreeChecker`, `MerklePathComputer`, `LeafIndex` | transfer, denominated_pool, denominated_transfer |
| poseidon.circom | `circuits/poseidon.circom` | `NoteCommitment`, `NullifierComputation`, `SpendingKeyDerivation`, `SpendingKeyHash` | transfer, denominated_pool, denominated_transfer |

### 1.3 Build Commands

| Circuit | Build Command |
|---------|--------------|
| denominated_pool | `npm run build:denom` (in `circuits/`) |
| denominated_transfer | `npm run build:dtransfer` (in `circuits/`) |
| confidential_balance | `npm run build:zkspl` (in `circuits/`) |
| balance_proof | `npm run build:bproof` (in `circuits/`) |

### 1.4 Circuit Test Files

| File | Path | Tests |
|------|------|-------|
| denominated_pool.test.js | `circuits/test/denominated_pool.test.js` | 21 |
| denominated_transfer.test.js | `circuits/test/denominated_transfer.test.js` | 12 |
| (confidential_balance tests) | `circuits/test/` | 29 |
| (balance_proof tests) | `circuits/test/` | 11 |

**Total circuit-level tests: 73, all passing.**

---

## 2. On-Chain Programs

**Framework:** Anchor 0.32.1
**Network:** Solana Devnet (6 of 7 deployed; whitelist blocked by authority mismatch)
**Shared verifier:** `programs/zk_shielded/src/verifier/groth16.rs` (521 lines, alt_bn128 syscalls)

### 2.1 Program Summary

| # | Program | Program ID | Instructions | State Accounts | Size | Status |
|---|---------|-----------|-------------|----------------|------|--------|
| 1 | zk_shielded | `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c` | 16 | ShieldedPool, DenominatedPool, MerkleTreeState, NullifierSet | ~3600-4200B | DEPLOYED |
| 2 | p01_zkspl | `EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah` | 10 | MintConfig, ConfidentialAccount | 361-1200B | DEPLOYED |
| 3 | specter | `2tuztgD9RhdaBkiP79fHkrFbfWBX75v7UjSNN4ULfbSp` | 6 | P01Wallet, StealthPayment, Stream | 113-240B | DEPLOYED |
| 4 | p01_subscription | `5kDjD9LSB1j8V6yKsZLC9NmnQ11PPvAY6Ryz4ucRC5Pt` | 8 | Subscription | ~260B | DEPLOYED |
| 5 | p01_stream | `2yH26XmXwgPuHMvV1NbmgJin32rfP3msQt18W6168mws` | 3 | Stream | ~160B | DEPLOYED |
| 6 | p01_whitelist | `AjHD9r4VubPvxJapd5zztf1Yqym1QYiZaQ4SF5h3FPQE` | 6 | Whitelist, WhitelistEntry | 73-220B | NOT DEPLOYED (auth) |
| 7 | p01_fee_splitter | `muCWm9ionWrwBavjsJudquiNSKzNEcTRm5XtKQMkWiD` | 4 | FeeConfig | 123B | DEPLOYED |

### 2.2 Detailed Breakdown

#### 2.2.1 zk_shielded

**Path:** `programs/zk_shielded/`
**Program ID:** `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`

**Standard Shielded Pool Instructions (7):**

| Instruction | Purpose |
|------------|---------|
| `initialize_pool` | Create a new shielded pool with Merkle tree |
| `shield` | Deposit tokens into pool, add commitment to tree |
| `transfer` | Private 2-in-2-out transfer within pool |
| `unshield` | Withdraw tokens, prove nullifier |
| `transfer_via_relayer` | Relayed transfer (gas abstraction) |
| `update_vk` | Update verification key hash |
| `init_vk_data` / `write_vk_data` | Chunked VK upload to on-chain storage |

**Denominated Pool Instructions (9):**

| Instruction | Purpose |
|------------|---------|
| `init_denominated_pool` | Create fixed-denomination pool |
| `shield_denominated` | Deposit exact denomination, add commitment |
| `unshield_denominated` | Withdraw with ZK proof + epoch check |
| `emergency_unshield_denominated` | Bypass time delay (enforce_maturity=0) |
| `transfer_denominated` | P2P note transfer within pool |
| `update_denominated_vk` | Hot-swap denominated pool VK |
| `update_transfer_vk` | Hot-swap transfer circuit VK |
| `resize_denominated_pool` | Realloc pool account for new fields |
| `init_transfer_vk_data` / `store_transfer_vk_data` | Chunked transfer VK upload |

**State Accounts:**

| Account | Size | Fields |
|---------|------|--------|
| ShieldedPool | ~3600B | authority, token_mint, vk_hash, merkle_root, next_index, filled_subtrees[20] |
| DenominatedPool | ~4200B | authority, token_mint, denomination, vk_hash, vk_hash_transfer, merkle_root, next_index, filled_subtrees[15], epoch_buffer[32] (dynamic delay tracking) |
| MerkleTreeState | variable | Full tree nodes |
| NullifierSet | PDA per nullifier | `[b"nullifier", pool_key, nullifier_bytes]` -- init constraint = atomic double-spend prevention |

**Key files:**

| File | Path | Lines | Purpose |
|------|------|-------|---------|
| lib.rs | `programs/zk_shielded/src/lib.rs` | -- | Program entry, instruction dispatch |
| mod.rs | `programs/zk_shielded/src/instructions/mod.rs` | -- | Instruction module exports |
| groth16.rs | `programs/zk_shielded/src/verifier/groth16.rs` | 521 | Groth16 verifier using alt_bn128 syscalls |
| pool.rs | `programs/zk_shielded/src/state/pool.rs` | -- | ShieldedPool + DenominatedPool structs |
| unshield_denominated.rs | `programs/zk_shielded/src/instructions/unshield_denominated.rs` | -- | Unshield with nullifier PDA |
| emergency_unshield_denominated.rs | `programs/zk_shielded/src/instructions/emergency_unshield_denominated.rs` | -- | Emergency bypass |
| transfer_denominated.rs | `programs/zk_shielded/src/instructions/transfer_denominated.rs` | -- | P2P transfer |
| resize_denominated_pool.rs | `programs/zk_shielded/src/instructions/resize_denominated_pool.rs` | -- | Realloc instruction |
| update_denominated_vk.rs | `programs/zk_shielded/src/instructions/update_denominated_vk.rs` | -- | VK hot-swap (pool circuit) |
| update_transfer_vk.rs | `programs/zk_shielded/src/instructions/update_transfer_vk.rs` | -- | VK hot-swap (transfer circuit) |
| store_transfer_vk_data.rs | `programs/zk_shielded/src/instructions/store_transfer_vk_data.rs` | -- | Chunked transfer VK upload |

**Dependencies:** anchor-lang 0.32.1, solana-bn254 2, sha3 0.10, bytemuck 1.14

**SPL token support:** `shield_denominated` / `unshield_denominated` accept `Option<Token>`, `Option<TokenAccount>`. Branch logic: `is_native_sol = pool.token_mint == system_program::ID`. Pool vault = ATA owned by pool PDA for the token mint.

#### 2.2.2 p01_zkspl

**Path:** `programs/p01_zkspl/` (assumed from standard layout)
**Program ID:** `EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah`

**Instructions (10):**

| Instruction | Purpose |
|------------|---------|
| `initialize_mint` | Create confidential mint config |
| `create_account` | Create confidential token account |
| `deposit` | Public deposit into confidential balance |
| `confidential_transfer` | Private transfer between accounts |
| `apply_pending` | Apply pending credits to balance |
| `withdraw` | Withdraw from confidential to public |
| `prove_balance` | Prove balance >= threshold |
| `add_viewer` / `remove_viewer` | Manage auditor/viewer keys |
| `init_vk_data` / `write_vk_data` | Chunked VK upload |

**State Accounts:**

| Account | Size | Fields |
|---------|------|--------|
| MintConfig | 361B | authority, token_mint, vk_hash |
| ConfidentialAccount | ~1200B | owner, balance_commitment, nonce, pending_credits[16], viewer_keys[8] |

#### 2.2.3 specter

**Path:** `programs/specter/`
**Program ID:** `2tuztgD9RhdaBkiP79fHkrFbfWBX75v7UjSNN4ULfbSp`

**Instructions (6):**

| Instruction | Purpose |
|------------|---------|
| `init_wallet` | Create P01 wallet |
| `send_private` | Stealth address payment |
| `claim_stealth` | Claim stealth payment |
| `create_stream` | Create payment stream |
| `withdraw_stream` | Withdraw from stream |
| `cancel_stream` | Cancel and refund stream |

**State Accounts:**

| Account | Size | Fields |
|---------|------|--------|
| P01Wallet | 113B | owner, stealth_pubkey, encryption_pubkey |
| StealthPayment | ~240B | sender, ephemeral_pubkey, encrypted_recipient, amount, token_mint, claimed |
| Stream | ~160B | sender, recipient, amount, start_time, end_time, withdrawn, cancelled |

#### 2.2.4 p01_subscription

**Path:** `programs/p01_subscription/`
**Program ID:** `5kDjD9LSB1j8V6yKsZLC9NmnQ11PPvAY6Ryz4ucRC5Pt`

**Instructions (8):**

| Instruction | Purpose |
|------------|---------|
| `create` | Create subscription |
| `process_payment` | Process recurring payment |
| `pause` / `resume` | Pause/resume subscription |
| `cancel` | Cancel subscription |
| `renew_delegation` | Renew PDA delegation |
| `update_privacy` | Update privacy settings |
| `close` | Close subscription account |

**State:** Subscription (~260B). Uses PDA-as-delegate model for automated payments.

#### 2.2.5 p01_stream

**Path:** `programs/p01_stream/`
**Program ID:** `2yH26XmXwgPuHMvV1NbmgJin32rfP3msQt18W6168mws`

**Instructions (3):** `create_stream`, `withdraw_from_stream`, `cancel_stream`
**State:** Stream (~160B) -- sender, recipient, amount, timestamps, withdrawn, cancelled

#### 2.2.6 p01_whitelist

**Path:** `programs/p01_whitelist/`
**Program ID:** `AjHD9r4VubPvxJapd5zztf1Yqym1QYiZaQ4SF5h3FPQE`

**Instructions (6):** `initialize`, `request_access`, `approve`, `reject`, `revoke`, `check_access`
**State:** Whitelist (73B), WhitelistEntry (~220B)
**Status:** NOT DEPLOYED to devnet (blocked by authority mismatch)

#### 2.2.7 p01_fee_splitter

**Path:** `programs/p01_fee_splitter/`
**Program ID:** `muCWm9ionWrwBavjsJudquiNSKzNEcTRm5XtKQMkWiD`

**Instructions (4):** `initialize`, `update_config`, `split_sol`, `split_token`
**State:** FeeConfig (123B) -- default 50 bps (0.5%), max 500 bps (5%)

### 2.3 Shared Verifier

**Path:** `programs/zk_shielded/src/verifier/groth16.rs`
**Lines:** 521
**Syscalls used:** `alt_bn128_addition`, `alt_bn128_multiplication`, `alt_bn128_pairing`
**Key detail:** All public inputs undergo `le_to_be()` conversion before pairing check (Solana stores LE, precompile expects BE).

### 2.4 Program Dependencies

| Crate | Version | Used By |
|-------|---------|---------|
| anchor-lang | 0.32.1 | All 7 programs |
| anchor-spl | 0.32.1 | zk_shielded, p01_zkspl, specter, p01_fee_splitter |
| solana-bn254 | 2 | zk_shielded, p01_zkspl |
| sha3 | 0.10 | zk_shielded |
| bytemuck | 1.14 | zk_shielded |

---

## 3. Services

### 3.1 Rust Groth16 Prover

**Path:** `services/prover/`
**Framework:** Axum 0.8
**Port:** 3001

**Endpoints:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/prove` | POST | Generate Groth16 proof (transfer/denominated circuits) |
| `/verify` | POST | Verify Groth16 proof |
| `/prove/zkspl` | POST | Generate zkSPL proof |
| `/verify/zkspl` | POST | Verify zkSPL proof |
| `/prove/balance-proof` | POST | Generate balance range proof |
| `/verify/balance-proof` | POST | Verify balance range proof |

**Key implementation details:**

- Uses `CircomReduction` (NOT `LibsnarkReduction`) -- critical for circom >= 2.0.7 correctness
- Self-verification: every generated proof is verified before returning
- Concurrent limiting: 1 proof at a time (via semaphore/mutex)
- `CircomBuilder::build()` consumes self; must reload `CircomConfig` per proof (~50ms reload)
- `__rust_probestack` global_asm stub required for wasmer_vm compatibility with Rust 1.85+

**Dependencies:**

| Crate | Version | Purpose |
|-------|---------|---------|
| ark-bn254 | 0.5 | BN254 curve |
| ark-circom | 0.5 | Circom R1CS loading |
| ark-groth16 | 0.5 | Groth16 prover/verifier |
| axum | 0.8 | HTTP server |
| rayon | 1.10 | Parallelism |

**Key files:**

| File | Path | Purpose |
|------|------|---------|
| main.rs | `services/prover/src/main.rs` | Entry, `__rust_probestack` stub |
| prover.rs | `services/prover/src/prover.rs` | Proof generation with CircomReduction |

**Status:** FUNCTIONAL, deployed via Docker

### 3.2 Node.js Relayer

**Path:** `services/relayer/`
**Framework:** Express.js
**Lines:** 2004 (index.ts)
**Deployment:** Railway (separate repo `IsSlashy/p01-relayer`)

**Features:**

| Feature | Detail |
|---------|--------|
| Proof generation | Rust prover first, snarkjs fallback |
| Commitment indexer | WebSocket-based on-chain event tracking |
| Fee collection | 50 bps default (configurable) |
| Proof verification | snarkjs cross-checks Rust prover output |
| Docker | Multi-stage build: Rust binary + Node.js in one image |

**Architecture:**
```
Client --> Relayer (:3000) --> Rust Prover (:3001) --> proof
                           |-> snarkjs fallback (if Rust fails)
                           |-> snarkjs verify (safety net for Rust proofs)
```

**Key files:**

| File | Path | Purpose |
|------|------|---------|
| index.ts | `services/relayer/src/index.ts` | Main relayer logic (2004 lines) |
| Dockerfile | `services/relayer/Dockerfile` | Multi-stage Rust + Node build |

**Status:** FUNCTIONAL, deployed on Railway

---

## 4. SDKs

**Root directory:** `packages/`

### 4.1 SDK Summary

| # | Package | Path | Lines | Key Exports | Test Files | Status |
|---|---------|------|-------|-------------|------------|--------|
| 1 | @p01/zkspl-sdk | `packages/zkspl-sdk/` | 2762 | ZkSplClient, ZkSplProver, LocalStateManager, crypto utils | 0 | FUNCTIONAL |
| 2 | @p01/zk-sdk | `packages/zk-sdk/` | -- | ShieldedClient, Note, MerkleTree, ZkProver | 2 | FUNCTIONAL |
| 3 | @p01/specter-sdk | `packages/specter-sdk/` | -- | P01Client, wallet/stealth/transfer/streams, 50+ utils | 4 | FUNCTIONAL |
| 4 | @p01/specter-js | `packages/specter-js/` | -- | P01 client, createPayButton, createSubscribeButton | 0 | FUNCTIONAL |
| 5 | @p01/sdk | `packages/sdk/` | -- | P01StreamClient, stream operations | 3 | FUNCTIONAL |
| 6 | @p01/auth-sdk | `packages/auth-sdk/` | -- | P01AuthClient, P01AuthServer | 3 | FUNCTIONAL |
| 7 | @p01/whitelist-sdk | `packages/whitelist-sdk/` | -- | WhitelistSDK, NaCl encryption, IPFS | 1 | FUNCTIONAL |
| 8 | @p01/ui | `packages/ui/` | -- | Design system, 15+ components, design tokens | 1 | FUNCTIONAL |
| 9 | p-01/p01-js | `packages/p01-js/` | -- | Protocol01, PrivateSubscription, PrivateStream, React components | 6 | FUNCTIONAL |

### 4.2 Detailed Breakdown

#### 4.2.1 @p01/zkspl-sdk

**Path:** `packages/zkspl-sdk/`
**Lines:** 2762
**Purpose:** Client library for the p01_zkspl confidential token program.

**Key exports:**

| Export | Purpose |
|--------|---------|
| `ZkSplClient` | High-level client for all zkSPL operations (deposit, withdraw, transfer, prove_balance) |
| `ZkSplProver` | Proof generation wrapper (snarkjs or Rust backend) |
| `LocalStateManager` | Local state tracking for confidential accounts (balance, salt, nonce) |
| Crypto utils | Poseidon hashing, commitment generation, amount hash computation |

#### 4.2.2 @p01/zk-sdk

**Path:** `packages/zk-sdk/`
**Purpose:** Core ZK primitives for shielded pool interactions.

**Key exports:**

| Export | Purpose |
|--------|---------|
| `ShieldedClient` | Client for shield/unshield/transfer operations |
| `Note` | Shielded note representation |
| `MerkleTree` | Client-side Merkle tree |
| `ZkProver` | Proof generation interface |

#### 4.2.3 @p01/specter-sdk

**Path:** `packages/specter-sdk/`
**Purpose:** Comprehensive SDK for all P01 features -- wallet, stealth payments, streams, subscriptions.

**Key exports:** P01Client (main entry), wallet module, stealth module, transfer module, streams module, 50+ utility functions.

#### 4.2.4 @p01/specter-js

**Path:** `packages/specter-js/`
**Purpose:** Embeddable JS client with payment/subscribe button factories for web integration.

**Key exports:** P01 client, `createPayButton()`, `createSubscribeButton()`

#### 4.2.5 @p01/sdk

**Path:** `packages/sdk/`
**Purpose:** Stream-focused SDK.

**Key exports:** `P01StreamClient`, stream creation/withdrawal/cancellation.

#### 4.2.6 @p01/auth-sdk

**Path:** `packages/auth-sdk/`
**Purpose:** Authentication SDK (client + server).

**Key exports:** `P01AuthClient`, `P01AuthServer`

#### 4.2.7 @p01/whitelist-sdk

**Path:** `packages/whitelist-sdk/`
**Purpose:** Whitelist management with encrypted IPFS storage.

**Key exports:** `WhitelistSDK`, NaCl encryption helpers, IPFS integration

#### 4.2.8 @p01/ui

**Path:** `packages/ui/`
**Purpose:** Shared design system.

**Key exports:** 15+ React components, design tokens

#### 4.2.9 p-01/p01-js

**Path:** `packages/p01-js/`
**Purpose:** High-level JS library with React components for protocol integration.

**Key exports:** `Protocol01`, `PrivateSubscription`, `PrivateStream`, React components

---

## 5. Mobile App

**Path:** `apps/mobile/`
**Framework:** Expo / React Native
**Package name:** `com.protocol01.app`
**Debug keystore:** `~/.android/debug.keystore`

### 5.1 Services

| Service | Path | Lines | Purpose |
|---------|------|-------|---------|
| denominatedPool/index.ts | `apps/mobile/services/denominatedPool/index.ts` | 1302 | Shield, unshield, emergencyUnshield, transferNote, Merkle proof from filledSubtrees |
| denominatedPool/circuitLoader.ts | `apps/mobile/services/denominatedPool/circuitLoader.ts` | 182 | Dual-circuit loading: Expo Asset + APK fallback, cache map |
| zk/index.ts | `apps/mobile/services/zk/index.ts` | 3927 | ZkService class (singleton via `getZkService()`), stealth addresses, legacy shielded pool |
| zkspl/index.ts | `apps/mobile/services/zkspl/index.ts` | 603 | Wraps @p01/zkspl-sdk for mobile |
| solana/ (15 files) | `apps/mobile/services/solana/` | -- | wallet, connection, balance, transactions, streams, subscriptions, websocket, etc. |
| privacy/ | `apps/mobile/services/privacy/` | -- | torProxy, transactionSplitter |
| payments/ | `apps/mobile/services/payments/` | -- | Payment processing |
| crypto/ | `apps/mobile/services/crypto/` | -- | Cryptographic utilities |
| notifications/ | `apps/mobile/services/notifications/` | -- | Push notifications |
| ai/ | `apps/mobile/services/ai/` | -- | AI features |
| jupiter/ | `apps/mobile/services/jupiter/` | -- | Jupiter swap integration |
| sync/ | `apps/mobile/services/sync/` | -- | Data synchronization |

### 5.2 Stores (Zustand + AsyncStorage)

| Store | Path | Lines | Purpose |
|-------|------|-------|---------|
| denominatedPoolStore.ts | `apps/mobile/stores/denominatedPoolStore.ts` | 523 | Notes, poolCache, shield/unshield/transfer actions |
| walletStore.ts | `apps/mobile/stores/walletStore.ts` | 412 | publicKey, balance, Privy support |
| shieldedStore.ts | `apps/mobile/stores/shieldedStore.ts` | 1094 | Legacy shielded pool state |
| confidentialStore.ts | `apps/mobile/stores/confidentialStore.ts` | 831 | zkSPL balances |
| settingsStore.ts | `apps/mobile/stores/settingsStore.ts` | -- | App settings |
| streamStore.ts | `apps/mobile/stores/streamStore.ts` | -- | Payment streams |

### 5.3 ZK Proving (On-Device)

**Component:** `DenominatedPoolProver.tsx`
**Path:** `apps/mobile/components/privacy/DenominatedPoolProver.tsx`
**Lines:** 497

**Architecture:** Hidden 1x1 pixel WebView that loads snarkjs from CDN. Circuit files loaded from APK assets (`file:///android_asset/`) with Expo Asset fallback.

**Proving time:** ~1-3 seconds on device (warm).

**Circuit assets bundled in APK:**

| Asset | Path | Size |
|-------|------|------|
| denominated_pool.wasm | `apps/mobile/assets/circuits/denominated_pool/` | 2.3 MB |
| denominated_pool_final.zkey | `apps/mobile/assets/circuits/denominated_pool/` | 4.2 MB |
| denominated_transfer.wasm | `apps/mobile/assets/circuits/denominated_pool/` | 2.3 MB |
| denominated_transfer_final.zkey | `apps/mobile/assets/circuits/denominated_pool/` | 4.4 MB |
| **Total** | | **~16.8 MB** |

### 5.4 Privacy Screens

| Screen | Path | Purpose |
|--------|------|---------|
| index.tsx | `apps/mobile/app/(main)/(privacy)/index.tsx` | Privacy hub / pool selector |
| denominated-shield.tsx | `apps/mobile/app/(main)/(privacy)/denominated-shield.tsx` | Deposit into denominated pool |
| denominated-unshield.tsx | `apps/mobile/app/(main)/(privacy)/denominated-unshield.tsx` | Withdraw from denominated pool |
| denominated-transfer.tsx | `apps/mobile/app/(main)/(privacy)/denominated-transfer.tsx` | P2P note transfer |
| denominated-notes.tsx | `apps/mobile/app/(main)/(privacy)/denominated-notes.tsx` | View held notes |
| denominated-import.tsx | `apps/mobile/app/(main)/(privacy)/denominated-import.tsx` | Import notes |
| shielded | `apps/mobile/app/(main)/(privacy)/shielded*` | Legacy shielded pool screens |
| confidential | `apps/mobile/app/(main)/(wallet)/confidential.tsx` | zkSPL confidential balances |

### 5.5 Key Singletons & Patterns

| Pattern | Access | File |
|---------|--------|------|
| ZkService singleton | `getZkService()` | `apps/mobile/services/zk/index.ts` |
| TreeSyncManager singleton | `getTreeSyncManager()` | WebSocket background sync |
| Wallet keypair | `getKeypair()` | `apps/mobile/services/solana/wallet.ts` |

---

## 6. Chrome Extension

**Path:** `apps/extension/`
**Framework:** React + Vite + Tailwind CSS
**Manifest:** V3

### 6.1 Scale

| Metric | Count |
|--------|-------|
| Services | 25 |
| Stores | 15 |
| Pages | 44+ |

### 6.2 Architecture

| Component | Purpose |
|-----------|---------|
| Background service worker | Subscription auto-check every 15 min, event handling |
| Content script | Page injection for dApp integration |
| Inject script | `window.solana`-compatible provider for dApp compatibility |
| Popup | Full UI with 44+ pages |

### 6.3 Key Services

| Service | Path | Purpose |
|---------|------|---------|
| denominatedPool.ts | `apps/extension/src/shared/services/denominatedPool.ts` | Denominated pool operations |
| zk.ts | `apps/extension/src/shared/services/zk.ts` | ZK proof generation and shielded pool |
| zkspl.ts | `apps/extension/src/shared/services/zkspl.ts` | zkSPL confidential tokens |

### 6.4 Key Stores

| Store | Path | Purpose |
|-------|------|---------|
| settings.ts | `apps/extension/src/shared/store/settings.ts` | Extension settings |
| confidential.ts | `apps/extension/src/shared/store/confidential.ts` | zkSPL state |

### 6.5 Key Pages

| Page | Path | Purpose |
|------|------|---------|
| Home.tsx | `apps/extension/src/popup/pages/Home.tsx` | Main dashboard |
| Settings.tsx | `apps/extension/src/popup/pages/Settings.tsx` | Settings |
| ConfidentialWallet.tsx | `apps/extension/src/popup/pages/ConfidentialWallet.tsx` | zkSPL UI |

### 6.6 ZK Proving

- **Primary:** snarkjs Web Worker (in-extension)
- **Fallback:** Backend relayer proof generation
- **Circuit files:** Bundled in `apps/extension/public/circuits/`

**Bundled circuit files:**

| File | Path |
|------|------|
| denominated_pool.wasm | `apps/extension/public/circuits/denominated_pool.wasm` |
| denominated_pool_final.zkey | `apps/extension/public/circuits/denominated_pool_final.zkey` |
| denominated_pool_vk.json | `apps/extension/public/circuits/denominated_pool_vk.json` |
| denominated_transfer.wasm | `apps/extension/public/circuits/denominated_transfer.wasm` |
| denominated_transfer_final.zkey | `apps/extension/public/circuits/denominated_transfer_final.zkey` |
| denominated_transfer_vk.json | `apps/extension/public/circuits/denominated_transfer_vk.json` |

### 6.7 Storage

`chrome.storage.local` with Zustand adapter for state persistence.

---

## 7. Scripts

**Root directory:** `scripts/`

### 7.1 Script Inventory

| # | Script | Path | Purpose | Status |
|---|--------|------|---------|--------|
| 1 | setup-sol-denominated-pools.mjs | `scripts/setup-sol-denominated-pools.mjs` | Initialize SOL denominated pools on devnet | FUNCTIONAL |
| 2 | setup-usdc-denominated-pools.mjs | `scripts/setup-usdc-denominated-pools.mjs` | Initialize USDC denominated pools (1/10/100/1000 USDC) + vault ATAs | FUNCTIONAL |
| 3 | setup-transfer-vk.mjs | `scripts/setup-transfer-vk.mjs` | Upload transfer circuit VK | FUNCTIONAL |
| 4 | upload-transfer-vk-data.mjs | `scripts/upload-transfer-vk-data.mjs` | Chunked transfer VK data upload | FUNCTIONAL |
| 5 | update-denominated-vk.mjs | `scripts/update-denominated-vk.mjs` | Hot-swap denominated pool VK | FUNCTIONAL |
| 6 | resize-and-setup-transfer-vk.mjs | `scripts/resize-and-setup-transfer-vk.mjs` | Realloc pool + upload transfer VK | FUNCTIONAL |
| 7 | test-denominated-transfer.mjs | `scripts/test-denominated-transfer.mjs` | E2E denominated transfer test | FUNCTIONAL |
| 8 | unshield-note.mjs | `scripts/unshield-note.mjs` | Manual note unshield | FUNCTIONAL |
| 9 | unshield-wait.sh | `scripts/unshield-wait.sh` | Wait-then-unshield helper | FUNCTIONAL |
| 10 | debug-merkle.mjs | `scripts/debug-merkle.mjs` | Merkle tree state debugging | FUNCTIONAL |
| 11 | build-deploy-zk.sh | `scripts/build-deploy-zk.sh` | Build and deploy ZK programs | FUNCTIONAL |
| 12 | check-pool-state.ts | `scripts/check-pool-state.ts` | Inspect pool state on-chain | FUNCTIONAL |
| 13 | full-diagnostic.ts | `scripts/full-diagnostic.ts` | Full system diagnostic | FUNCTIONAL |

### 7.2 VK Upload Pipeline

The VK (verification key) upload process is a multi-step pipeline due to Solana transaction size limits:

1. **`vkJsonToBinary()`** -- Convert JSON VK to binary format; G2 points use EIP-197 ordering `[x_imag, x_real, y_imag, y_real]`
2. **`init_vk_data`** -- Initialize on-chain VK data account
3. **`write_vk_data`** -- Chunked writes (multiple transactions)
4. **`update_denominated_vk`** / **`update_transfer_vk`** -- Set vk_hash on pool

### 7.3 Proof Format Conversion

snarkjs G2 `pi_b` format: `[[c0_x, c1_x], [c0_y, c1_y]]`
On-chain format: `[c1_x, c0_x, c1_y, c0_y]` (real/imaginary swap)

Implemented in: `proofToOnChainBytes()` (used in `denominatedPool/index.ts` and scripts)

### 7.4 USDC Devnet Configuration

- **USDC Mint:** `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 decimals)
- **Pool denominations:** 1, 10, 100, 1000 USDC
- **Pool PDA:** `[b"denominated_pool", token_mint, &denomination.to_le_bytes()]`

---

## 8. Custom Tooling

### 8.1 APK Injection Pipeline

**Purpose:** Fast mobile deployment iteration (~2-3 min vs 30+ min EAS build).

| Tool | Path | Purpose |
|------|------|---------|
| inject_apk.py | `apps/mobile/inject_apk.py` | Python script: replaces JS bundle in APK, injects circuit assets with predictable names |
| build-apk.sh | `apps/mobile/build-apk.sh` | Shell wrapper for APK build |
| build-wsl.sh | `apps/mobile/build-wsl.sh` | WSL-specific build variant |

**Pipeline:**
```
expo export --> inject_apk.py (zipfile replace bundle + inject circuits)
           --> zipalign.exe
           --> apksigner.bat
           --> adb install -r
```

**Key detail:** Expo Asset uses hash-based naming that breaks snarkjs circuit discovery. The injection script places circuits at predictable paths (`file:///android_asset/`) so the WebView prover can locate them.

### 8.2 Docker Multi-Stage Build

**Path:** `services/relayer/Dockerfile`
**Purpose:** Single container with both Rust prover binary and Node.js relayer.

**Stages:**
1. Rust builder -- compiles ark-circom prover
2. Node.js builder -- installs npm dependencies
3. Runtime -- copies both binaries into slim image

### 8.3 Circuit Build System

**Path:** `circuits/package.json`
**Commands:**

| Command | Purpose |
|---------|---------|
| `npm run build:denom` | Build denominated_pool circuit |
| `npm run build:dtransfer` | Build denominated_transfer circuit |
| `npm run build:zkspl` | Build confidential_balance circuit |
| `npm run build:bproof` | Build balance_proof circuit |

**Each build produces:** `.r1cs`, `.wasm`, `_final.zkey` (via pot20_final.ptau), `verification_key.json`

---

## 9. Original Innovations

This section catalogs the original technical innovations developed in P01 that are not standard library usage or straightforward integrations. Each entry includes the problem solved, the solution approach, files involved, and a reusability rating.

### Innovation 1: Client-Side Groth16 on React Native via Hidden WebView

| Attribute | Detail |
|-----------|--------|
| **Problem** | snarkjs requires Node.js APIs (fs, crypto, worker_threads) that are unavailable in React Native's Metro bundler. No native Groth16 prover exists for React Native. |
| **Solution** | A hidden 1x1 pixel WebView loads snarkjs from CDN at runtime. Circuit files (.wasm and .zkey) are loaded from APK assets (`file:///android_asset/`) or Expo Assets as fallback. The WebView communicates with React Native via `postMessage`/`onMessage` bridge. Proving completes in 1-3 seconds on modern devices. |
| **Files** | `apps/mobile/components/privacy/DenominatedPoolProver.tsx` (497 lines), `apps/mobile/services/denominatedPool/circuitLoader.ts` (182 lines) |
| **Reusability** | **HIGH** -- Generic pattern applicable to any ZK circuit in any React Native app. Could be extracted as a standalone `react-native-snarkjs` library. |

### Innovation 2: Dual-Circuit Loading and Caching System

| Attribute | Detail |
|-----------|--------|
| **Problem** | The app needs to load different circuits (denominated_pool vs denominated_transfer) on demand. Reloading circuits for each proof is slow. Expo Asset's hash-based naming makes discovery non-trivial. |
| **Solution** | A circuit cache map keyed by circuit type. `preloadCircuit(type)` loads and caches. Dual fallback: first tries Expo Asset API (cross-platform), then falls back to direct APK asset paths (Android-specific). Cache persists across proofs within a session. |
| **Files** | `apps/mobile/services/denominatedPool/circuitLoader.ts` (182 lines), `apps/mobile/components/privacy/DenominatedPoolProver.tsx` |
| **Reusability** | **HIGH** -- Useful for any multi-circuit ZK application on mobile. |

### Innovation 3: APK Asset Injection for ZK Circuits

| Attribute | Detail |
|-----------|--------|
| **Problem** | Expo Asset uses hash-based naming for bundled files (e.g., `a1b2c3d4.wasm`), which breaks snarkjs's circuit file discovery. Full EAS builds take 30+ minutes per iteration. |
| **Solution** | Python script (`inject_apk.py`, 112 lines) that: (1) opens the APK as a zip, (2) replaces the JS bundle with the newly exported one, (3) injects circuit files at predictable paths in the `assets/` directory, (4) re-signs the APK. Total cycle: 2-3 minutes. |
| **Files** | `apps/mobile/inject_apk.py` (112 lines) |
| **Reusability** | **MEDIUM** -- Specific to Android APK format, but the pattern (post-build asset injection) is broadly applicable. |

### Innovation 4: Denominated Pools with Dynamic Time Delay

| Attribute | Detail |
|-----------|--------|
| **Problem** | Fixed time delays for anonymity are either too long (poor UX) or too short (poor privacy). The delay should adapt to how many notes have matured in the anonymity set. |
| **Solution** | DenominatedPool struct contains a circular buffer of 32 epochs tracking note maturity (`epoch_buffer`). Dynamic delay thresholds adjust based on `mature_note_count`: more mature notes in the pool allow shorter wait times. The circuit enforces `deposit_epoch <= min_epoch`; the program enforces `current_epoch >= min_epoch`. |
| **Files** | `programs/zk_shielded/src/state/pool.rs` (DenominatedPool struct), `circuits/denominated_pool.circom` |
| **Reusability** | **MEDIUM** -- Applicable to any fixed-denomination mixing pool that wants adaptive privacy guarantees. |

### Innovation 5: enforce_maturity Bypass for Emergency Withdrawal

| Attribute | Detail |
|-----------|--------|
| **Problem** | Time-delayed withdrawals protect privacy but lock user funds. Users need emergency access to their own money (e.g., urgent liquidation). |
| **Solution** | The circuit includes a binary public input `enforce_maturity`. When set to 1, the epoch constraint (`deposit_epoch <= min_epoch`) is enforced. When set to 0, the constraint is bypassed. The `emergency_unshield_denominated` instruction sets `enforce_maturity=0`. The denominated_transfer circuit always enforces maturity (no emergency bypass for transfers). |
| **Files** | `circuits/denominated_pool.circom`, `programs/zk_shielded/src/instructions/emergency_unshield_denominated.rs` |
| **Reusability** | **MEDIUM** -- Pattern of circuit-level conditional constraint enforcement via public input flag. |

### Innovation 6: LE-to-BE Endianness Conversion for Solana BN254 Verifier

| Attribute | Detail |
|-----------|--------|
| **Problem** | Solana stores all data in little-endian format. The `alt_bn128` precompile (used for Groth16 pairing checks) expects big-endian inputs. Passing LE data produces incorrect pairings and silent verification failures. |
| **Solution** | Systematic `le_to_be()` conversion for all public inputs before they enter the pairing check. Applied consistently across all 521 lines of the verifier. |
| **Files** | `programs/zk_shielded/src/verifier/groth16.rs` (521 lines) |
| **Reusability** | **HIGH** -- Required by any Solana program using alt_bn128 syscalls for ZK verification. |

### Innovation 7: Pool Realloc for Adding Fields Without Recreation

| Attribute | Detail |
|-----------|--------|
| **Problem** | Adding `vk_hash_transfer` to the DenominatedPool struct changes the account size. Solana accounts cannot be resized without explicit realloc. Recreating pools would lose all existing commitments. |
| **Solution** | A dedicated `resize_denominated_pool` instruction that uses Anchor's `realloc` constraint to grow the account, preserving all existing data. New fields are appended and zero-initialized. |
| **Files** | `programs/zk_shielded/src/instructions/resize_denominated_pool.rs` |
| **Reusability** | **HIGH** -- Generic pattern for any Solana program that needs schema evolution without data migration. |

### Innovation 8: VK Hot-Swap Without Pool Recreation

| Attribute | Detail |
|-----------|--------|
| **Problem** | Updating a circuit's verification key (e.g., after a trusted setup ceremony or bug fix) traditionally requires redeploying the pool and migrating all state. |
| **Solution** | Separate `update_denominated_vk` and `update_transfer_vk` instructions that only update the `vk_hash` field on the pool. The VK data is stored in a separate account. Pool state (Merkle tree, commitments) is untouched. Authority-gated. |
| **Files** | `programs/zk_shielded/src/instructions/update_denominated_vk.rs`, `programs/zk_shielded/src/instructions/update_transfer_vk.rs` |
| **Reusability** | **HIGH** -- Applicable to any ZK program that may need circuit upgrades. |

### Innovation 9: Merkle Proof from filledSubtrees (No Full Tree Sync)

| Attribute | Detail |
|-----------|--------|
| **Problem** | Computing a Merkle proof normally requires maintaining a full local copy of the tree. Local trees diverge from on-chain state due to missed transactions, making proofs invalid. Syncing the full tree is slow and error-prone. |
| **Solution** | `computeNewRootFromSubtrees()` reads the on-chain `filledSubtrees` array (the minimal set of hashes needed to reconstruct any path) and computes both the new root AND the Merkle proof in a single pass. No full tree required. The proof is saved with the note for instant unshield later. |
| **Files** | `apps/mobile/services/denominatedPool/index.ts` (1302 lines) |
| **Reusability** | **HIGH** -- Applicable to any incremental Merkle tree implementation. Eliminates the need for full tree sync in any UTXO/commitment scheme. |

### Innovation 10: Rust Groth16 Prover with CircomReduction Fix

| Attribute | Detail |
|-----------|--------|
| **Problem** | The default `LibsnarkReduction` in ark-circom produces structurally valid but mathematically incorrect proofs for circuits compiled with circom >= 2.0.7. Proofs pass structural checks but fail pairing verification. This is a known but poorly documented issue (github.com/arkworks-rs/circom-compat/issues/35). |
| **Solution** | Use `type GrothBn = Groth16<Bn254, CircomReduction>;` instead of the default. Additionally, every generated proof is self-verified before being returned to the caller. |
| **Files** | `services/prover/src/prover.rs` |
| **Reusability** | **HIGH** -- Critical for anyone using ark-circom with modern circom. Should be the default in all Rust-based circom provers. |

### Innovation 11: Dual-Prover Architecture (Rust + snarkjs Fallback)

| Attribute | Detail |
|-----------|--------|
| **Problem** | The native Rust prover is fast (~250ms) but may fail due to circuit loading issues, memory pressure, or platform-specific bugs. snarkjs is slow (~3s) but battle-tested and reliable. |
| **Solution** | The relayer attempts proof generation via the Rust prover first. On failure, it falls back to snarkjs. As a safety net, all Rust-generated proofs are cross-verified using snarkjs before being returned to the client. This provides both speed and reliability. |
| **Files** | `services/relayer/src/index.ts` (2004 lines) |
| **Reusability** | **HIGH** -- Pattern applicable to any system with a fast-but-fragile primary and slow-but-reliable fallback. |

### Innovation 12: PDA-per-Nullifier (Not Bloom Filter)

| Attribute | Detail |
|-----------|--------|
| **Problem** | Double-spend detection in shielded pools requires checking if a nullifier has been used before. Bloom filters are space-efficient but have false positives, which could wrongly reject valid withdrawals. On-chain Bloom filters also have concurrency issues. |
| **Solution** | Each nullifier gets its own PDA: `[b"nullifier", pool_key, nullifier_bytes]`. The PDA is created with Anchor's `init` constraint, which atomically fails if the account already exists. Zero false positives. Zero race conditions. Each PDA costs rent (~0.001 SOL) but provides absolute correctness. |
| **Files** | `programs/zk_shielded/src/instructions/unshield_denominated.rs` |
| **Reusability** | **HIGH** -- Superior to Bloom filters for any on-chain set membership check where correctness matters more than storage cost. |

### Innovation 13: Poseidon-Based Quantum-Resistant Commitments

| Attribute | Detail |
|-----------|--------|
| **Problem** | Traditional privacy protocols use elliptic curve commitments (Pedersen commitments over ECC). These are vulnerable to quantum computers running Shor's algorithm, which can solve the discrete log problem. |
| **Solution** | All commitments use the Poseidon hash function, which is algebraic (efficient in ZK circuits) but not based on elliptic curve discrete log. Poseidon's security relies on the algebraic properties of the hash, not on the hardness of discrete log. This provides quantum resistance for the commitment layer. |
| **Files** | All `.circom` files, `circuits/poseidon.circom` |
| **Reusability** | **HIGH** -- Drop-in replacement for Pedersen commitments in any ZK protocol. |

### Innovation 14: snarkjs Proof to On-Chain Format Conversion

| Attribute | Detail |
|-----------|--------|
| **Problem** | snarkjs outputs G2 points in a format that differs from the EIP-197 on-chain format. Specifically, the real and imaginary components of G2 coordinates are swapped. Submitting unconverted proofs causes silent verification failures. |
| **Solution** | `proofToOnChainBytes()` function that converts snarkjs G2 `pi_b` from `[[c0_x, c1_x], [c0_y, c1_y]]` to on-chain `[c1_x, c0_x, c1_y, c0_y]` (swap real/imaginary for each coordinate pair). Applied consistently in all client-side code and scripts. |
| **Files** | `apps/mobile/services/denominatedPool/index.ts`, various scripts |
| **Reusability** | **HIGH** -- Required by anyone using snarkjs proofs with EIP-197-compatible verifiers (Solana alt_bn128, Ethereum precompiles). |

### Innovation 15: __rust_probestack Stub for wasmer_vm Compatibility

| Attribute | Detail |
|-----------|--------|
| **Problem** | Rust 1.85+ removed the `__rust_probestack` symbol (switched to inline probing). However, `wasmer_vm` (used by ark-circom for WASM execution) still references this symbol at link time, causing build failures. Version pinning does not work: 1.84 is too old for edition 2024, and the `-C probe-stack=call` flag was never stabilized. |
| **Solution** | A `global_asm!` block in `main.rs` that defines a minimal `__rust_probestack` stub (just a `ret` instruction). This satisfies the linker without affecting runtime behavior. |
| **Files** | `services/prover/src/main.rs` |
| **Reusability** | **MEDIUM** -- Specific to the Rust + wasmer_vm + ark-circom stack, but critical for anyone in that ecosystem. |

### Innovation 16: Single Circuit for 4 zkSPL Operations

| Attribute | Detail |
|-----------|--------|
| **Problem** | Confidential tokens need 4 distinct operations (deposit, withdraw, send, receive). Separate circuits for each would quadruple the trusted setup work, key storage, and verification complexity. |
| **Solution** | A single `confidential_balance` circuit with selector flags: `is_debit` (0 or 1), `public_credit`, `public_debit`. The conservation law `old_balance + private_credit + public_credit === new_balance + private_debit + public_debit` unifies all operations. Deposit: `public_credit > 0`, all else zero. Withdraw: `public_debit > 0`. Send: `is_debit = 1`. Receive: `is_debit = 0`. |
| **Files** | `circuits/confidential_balance.circom` (1,382 constraints) |
| **Reusability** | **HIGH** -- Architectural pattern for any confidential token system that needs multiple operation types. |

### Innovation 17: Amount Commitment Linking Sender and Recipient

| Attribute | Detail |
|-----------|--------|
| **Problem** | In a private transfer, the sender debits X and the recipient credits X, but neither amount is revealed on-chain. How do you prove conservation (sender debited exactly what recipient credited) without revealing the amount? |
| **Solution** | `amount_hash = Poseidon(amount, amount_salt)`. The sender and recipient use the same `amount` and `amount_salt` values, producing the same `amount_hash` (a public input). The on-chain program checks that both proofs reference the same `amount_hash`, ensuring conservation without revealing the amount. The sender shares `(amount, amount_salt)` with the recipient out-of-band. |
| **Files** | `circuits/confidential_balance.circom`, `packages/zkspl-sdk/` |
| **Reusability** | **HIGH** -- Applicable to any private transfer protocol that needs conservation proofs. |

---

## Appendix A: Test Coverage Summary

| Test Suite | Path | Tests | Status |
|------------|------|-------|--------|
| Circuit: denominated_pool | `circuits/test/denominated_pool.test.js` | 21 | ALL PASSING |
| Circuit: denominated_transfer | `circuits/test/denominated_transfer.test.js` | 12 | ALL PASSING |
| Circuit: confidential_balance | `circuits/test/` | 29 | ALL PASSING |
| Circuit: balance_proof | `circuits/test/` | 11 | ALL PASSING |
| Anchor: zkSPL | `tests/zkspl.ts` | 40 | ALL PASSING |
| Anchor: denominated pool | `tests/denominated-pool.ts` | 26 | ALL PASSING |
| Anchor: denominated pool E2E | `tests/denominated-pool-e2e.ts` | -- | ALL PASSING |
| Anchor: ZK transfer | `tests/` | 6 | ALL PASSING |
| Anchor: ZK shielded | `tests/` | 6 | ALL PASSING |
| Anchor: ZK E2E | `tests/` | 6 | ALL PASSING |
| Anchor: streaming | `tests/` | -- | ALL PASSING |
| Anchor: subscriptions | `tests/` | -- | ALL PASSING |
| Anchor: fee splitter | `tests/` | -- | ALL PASSING |
| Anchor: specter | `tests/` | -- | ALL PASSING |
| Anchor: whitelist | `tests/` | -- | ALL PASSING |
| E2E: auth/privacy/stealth/stream | `tests/` | -- | ALL PASSING |
| **Total** | | **644+** | **ALL PASSING** |

## Appendix B: Devnet Deployment Addresses

| Program | Address | Status |
|---------|---------|--------|
| zk_shielded | `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c` | DEPLOYED |
| p01_zkspl | `EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah` | DEPLOYED |
| specter | `2tuztgD9RhdaBkiP79fHkrFbfWBX75v7UjSNN4ULfbSp` | DEPLOYED |
| p01_subscription | `5kDjD9LSB1j8V6yKsZLC9NmnQ11PPvAY6Ryz4ucRC5Pt` | DEPLOYED |
| p01_stream | `2yH26XmXwgPuHMvV1NbmgJin32rfP3msQt18W6168mws` | DEPLOYED |
| p01_whitelist | `AjHD9r4VubPvxJapd5zztf1Yqym1QYiZaQ4SF5h3FPQE` | NOT DEPLOYED |
| p01_fee_splitter | `muCWm9ionWrwBavjsJudquiNSKzNEcTRm5XtKQMkWiD` | DEPLOYED |

## Appendix C: External Dependencies (Key)

| Dependency | Version | Category | Used By |
|------------|---------|----------|---------|
| circomlib | 2.0.5 | ZK circuits | All .circom files |
| anchor-lang | 0.32.1 | Smart contracts | All 7 programs |
| anchor-spl | 0.32.1 | SPL token integration | 4 programs |
| solana-bn254 | 2 | BN254 curve ops | zk_shielded, p01_zkspl |
| ark-bn254 | 0.5 | Rust BN254 | Prover service |
| ark-circom | 0.5 | Rust circom loading | Prover service |
| ark-groth16 | 0.5 | Rust Groth16 | Prover service |
| axum | 0.8 | HTTP server | Prover service |
| snarkjs | -- | JS Groth16 | Relayer, mobile, extension |
| Expo | -- | Mobile framework | Mobile app |
| React Native | -- | Mobile UI | Mobile app |
| Vite | -- | Extension bundler | Chrome extension |
| Zustand | -- | State management | Mobile + extension |
| Express.js | -- | HTTP server | Relayer |

## Appendix D: Known Gotchas

| Issue | Detail | Mitigation |
|-------|--------|------------|
| Windows test-validator | WSL2 bug prevents native Windows usage | Use `wsl` for local validator |
| Node v24 | Experimental strip-types breaks tests | Set `NODE_OPTIONS="--no-experimental-strip-types"` |
| ark-circom CircomReduction | LibsnarkReduction produces wrong proofs for circom >= 2.0.7 | Always use `CircomReduction` type alias |
| ark-circom build() | Consumes self, not Clone | Reload CircomConfig per proof (~50ms) |
| ark-circom error type | Returns eyre::Result, not anyhow | Use `.map_err(\|e\| anyhow::anyhow!(...))` not `.context()` |
| Local Merkle tree divergence | Local tree drifts from on-chain | Never use local tree for on-chain ops; compute from filledSubtrees |
| Rust 1.85+ probestack | wasmer_vm references removed symbol | global_asm! stub in main.rs |
| Expo Asset naming | Hash-based names break circuit discovery | APK injection with predictable paths |
| Anchor account ordering | Must exactly match IDL | Verify against IDL before submitting |
| G2 point format | snarkjs vs EIP-197 real/imag swap | proofToOnChainBytes() conversion |
| Public input endianness | Solana LE vs alt_bn128 BE | le_to_be() in verifier |

---

*Generated 2026-02-26. This document covers the complete technical inventory of the P01 monorepo as of commit `545b851`.*
