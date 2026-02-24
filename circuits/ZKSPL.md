# zkSPL — Confidential Token Balances for Solana

## What is zkSPL?

zkSPL is a confidential token standard built on zero-knowledge proofs. It wraps any SPL token
and hides balances and transfer amounts on-chain. Nobody can see how much you hold or how much
you send — but the math guarantees everything is correct.

**Competitor:** Arcium's C-SPL (MPC-based, trusts nodes). zkSPL trusts math.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: zkSPL Accounts (account-model, DeFi-compatible)  │
│  Balance = Poseidon(balance, salt, owner, mint) on-chain    │
│  Transfers via ZK proof — amounts hidden                    │
│  Quantum-resistant commitments (hash-based, no ECC)         │
├─────────────────────────────────────────────────────────────┤
│  LAYER 1: Shielded Pool (UTXO-model, max anonymity)        │
│  Existing transfer.circom — hides sender AND recipient      │
│  For breaking transaction graphs completely                 │
└─────────────────────────────────────────────────────────────┘
```

**User chooses privacy level:**

| Level        | Mode             | Who's hidden?           | DeFi compatible? |
|-------------|------------------|-------------------------|-------------------|
| Standard     | Normal SPL       | Nobody                  | Yes               |
| Confidential | zkSPL Account    | Balances + amounts      | Yes               |
| Maximum      | Shielded Pool    | Sender + recipient + amounts | Pool only    |

---

## Cryptographic Primitives

### Poseidon Hash (quantum-resistant)
- ZK-friendly hash function operating in the BN254 scalar field
- NOT based on elliptic curves — immune to Shor's algorithm (quantum)
- Used for ALL commitments in zkSPL
- Field modulus: `21888242871839275222246405745257275088548364400416034343698204186575808495617`

### Balance Commitment
```
commitment = Poseidon(balance, salt, owner_pubkey, token_mint)
```
- `balance`: Your actual token amount (e.g., 100 USDC in base units)
- `salt`: Random 254-bit number known only to you (prevents brute-force)
- `owner_pubkey`: Derived from your spending key: `Poseidon(spending_key)`
- `token_mint`: Which token (USDC address, SOL = 0, etc.)

**Why Poseidon instead of Pedersen?**
- Pedersen: `C = v·G + r·H` — based on elliptic curves, broken by quantum computers
- Poseidon: `C = Hash(v, r, ...)` — based on algebraic hash, quantum-resistant
- Trade-off: Poseidon is NOT homomorphic (can't add commitments directly)
- But our Rust prover generates proofs in ~50ms, so one proof per operation is fine

### Amount Commitment (links sender ↔ recipient)
```
amount_hash = Poseidon(amount, amount_salt)
```
- Sender creates this when sending
- Recipient verifies this when receiving
- Both use the SAME amount + amount_salt → same hash
- On-chain stores `amount_hash` as pending credit for recipient

### Owner Key Derivation
```
owner_pubkey = Poseidon(spending_key)
```
- `spending_key` is SECRET (like a private key, derived from seed phrase)
- `owner_pubkey` is PUBLIC (stored in commitment, identifies account)
- One-way function — nobody can reverse it

---

## Circuit 1: `confidential_balance.circom`

**Purpose:** Prove a balance update is valid without revealing any amounts.

### Statistics
- **Constraints:** 1,382 (vs 79,000 for shielded pool transfer — 57x smaller)
- **Proving key:** 1.3 MB
- **WASM:** 2.5 MB
- **Proof time:** ~50ms (Rust prover), ~2s (snarkjs)

### Public Inputs (7 signals — visible on-chain)

| Signal | Description |
|--------|-------------|
| `old_commitment` | Current balance commitment (read from on-chain) |
| `new_commitment` | New balance commitment (to write on-chain) |
| `amount_hash` | Poseidon(amount, amount_salt) for private transfers |
| `public_credit` | Public deposit amount (SPL → zkSPL), 0 for private |
| `public_debit` | Public withdraw amount (zkSPL → SPL), 0 for private |
| `token_mint` | Which token |
| `nonce` | Anti-replay counter (matches on-chain account nonce) |

### Private Inputs (8 signals — never revealed)

| Signal | Description |
|--------|-------------|
| `old_balance` | Your current actual balance |
| `old_salt` | Random number in your current commitment |
| `new_balance` | Your balance after this operation |
| `new_salt` | New random number for updated commitment |
| `amount` | Private transfer amount (0 for deposit/withdraw) |
| `amount_salt` | Random number for amount commitment |
| `spending_key` | Your secret key (proves ownership) |
| `is_debit` | Direction: 1 = sending, 0 = receiving |

### Operations (all handled by the same circuit)

**DEPOSIT (SPL → zkSPL):**
```
public_credit = deposit_amount
amount = 0, is_debit = 0
→ new_balance = old_balance + deposit_amount
```

**WITHDRAW (zkSPL → SPL):**
```
public_debit = withdraw_amount
amount = 0, is_debit = 0
→ new_balance = old_balance - withdraw_amount
```

**PRIVATE SEND:**
```
amount = transfer_amount, is_debit = 1
public_credit = 0, public_debit = 0
→ new_balance = old_balance - amount
→ amount_hash stored as pending credit for recipient
```

**PRIVATE RECEIVE:**
```
amount = transfer_amount, is_debit = 0
public_credit = 0, public_debit = 0
→ new_balance = old_balance + amount
→ Must match pending amount_hash from sender
```

### Constraints (what the circuit enforces)

1. **Ownership:** `owner_pubkey == Poseidon(spending_key)`
2. **Old commitment:** `Poseidon(old_balance, old_salt, owner, mint) == old_commitment`
3. **New commitment:** `Poseidon(new_balance, new_salt, owner, mint) == new_commitment`
4. **Amount hash:** `Poseidon(amount, amount_salt) == amount_hash`
5. **Binary flag:** `is_debit ∈ {0, 1}`
6. **Conservation:** `old + credit_private + credit_public == new + debit_private + debit_public`
7. **Range proofs:** All amounts fit in 64 bits (prevents overflow/negative balances)

### The Conservation Law (most important constraint)
```
old_balance + private_credit + public_credit === new_balance + private_debit + public_debit
```
Where:
- `private_credit = (1 - is_debit) * amount` → amount if receiving, 0 if sending
- `private_debit = is_debit * amount` → amount if sending, 0 if receiving

This means money cannot be created or destroyed. Every operation is a zero-sum equation.

### Range Proofs (overflow protection)
In a finite field, "negative" numbers wrap around to huge values (p - x).
`Num2Bits(64)` decomposes a number into 64 binary digits.
If the number doesn't fit in 64 bits (≥ 2^64), the circuit FAILS.
This prevents:
- Spending more than you have (new_balance would be "negative" = p - something > 2^64)
- Creating tokens from nothing (amount would need to be artificially large)

---

## Circuit 2: `balance_proof.circom`

**Purpose:** Prove "I have at least X tokens" without revealing exact balance.

### Statistics
- **Constraints:** 644
- **Proving key:** 593 KB
- **WASM:** 2.2 MB

### Public Inputs (3 signals)

| Signal | Description |
|--------|-------------|
| `balance_commitment` | Your balance commitment (from on-chain) |
| `threshold` | Minimum amount you're proving you have |
| `token_mint` | Which token |

### Private Inputs (3 signals)

| Signal | Description |
|--------|-------------|
| `balance` | Your actual balance (secret) |
| `salt` | Your commitment salt (secret) |
| `spending_key` | Proves ownership |

### How it works
```
difference = balance - threshold

If balance ≥ threshold → difference ≥ 0 → fits in 64 bits → proof succeeds ✓
If balance < threshold → difference is "negative" → huge field number → doesn't fit → proof fails ✗
```

### Use cases
- DEX: "Does this user have enough USDC for this trade?" → `proveBalance(50_USDC)`
- Lending: "Does borrower have enough collateral?" → `proveBalance(min_collateral)`
- Any program that needs to verify sufficient funds without seeing the balance

---

## Quantum Resistance Analysis

| Component | Quantum-safe? | Notes |
|-----------|--------------|-------|
| Balance commitments (Poseidon) | **YES** | Hash-based, not ECC |
| Amount commitments (Poseidon) | **YES** | Hash-based, not ECC |
| Merkle trees (Poseidon) | **YES** | Hash-based |
| Range proofs (Num2Bits) | **YES** | Binary decomposition, no crypto |
| Proof system (Groth16) | **NO** | BN254 pairing, migrate to STARKs later |
| Signatures (Ed25519) | **NO** | Solana's problem, not ours |

**When quantum arrives:**
- Our committed data (balances, salts) stays safe (Poseidon is quantum-resistant)
- We swap Groth16 → STARKs (change proof system, keep commitment scheme)
- Arcium must rebuild their entire MPC node network with new primitives

---

## File Structure

```
circuits/
├── confidential_balance.circom   ← Main zkSPL circuit (1,382 constraints)
├── balance_proof.circom          ← Balance sufficiency proof (644 constraints)
├── transfer.circom               ← Existing shielded pool (79,000 constraints)
├── merkle.circom                 ← Merkle tree verification
├── poseidon.circom               ← Note commitment & nullifier helpers
├── package.json                  ← Build scripts for all circuits
├── keys/
│   └── pot20_final.ptau          ← Powers of Tau ceremony file
├── build/
│   ├── confidential_balance.r1cs          ← Constraint system
│   ├── confidential_balance_final.zkey    ← Proving key (1.3 MB)
│   ├── confidential_balance_vk.json       ← Verification key (4 KB)
│   ├── confidential_balance_js/
│   │   └── confidential_balance.wasm      ← Witness generator (2.5 MB)
│   ├── balance_proof.r1cs
│   ├── balance_proof_final.zkey           ← Proving key (593 KB)
│   ├── balance_proof_vk.json
│   └── balance_proof_js/
│       └── balance_proof.wasm             ← Witness generator (2.2 MB)
└── test/
    ├── confidential_balance.test.js       ← 29 tests, all passing
    ├── balance_proof.test.js              ← 11 tests, all passing
    └── transfer.test.js                   ← Existing shielded pool tests
```

## Build Commands

```bash
cd circuits/

# Install dependencies (first time)
npm install

# Build zkSPL confidential balance circuit
npm run build:zkspl

# Build balance proof circuit
npm run build:bproof

# Build all circuits (including existing transfer)
npm run build:all

# Run tests
npm run test:zkspl    # 29/29 passing
npm run test:bproof   # 11/11 passing
npm run test:all      # All circuits
```

**Note:** Compilation requires `circom` in PATH. On this machine: `C:\Users\Slashy\.cargo\bin\circom`
The `-l node_modules` flag is needed for circomlib includes.

## Test Results

### confidential_balance.test.js (29/29)
```
TEST 1: DEPOSIT          → Proof valid ✓
TEST 2: PRIVATE SEND     → Proof valid ✓
TEST 3: PRIVATE RECEIVE  → Proof valid, amount_hash matches sender ✓
TEST 4: WITHDRAW         → Proof valid ✓
TEST 5: OVERFLOW         → Correctly rejected (Num2Bits fails on negative) ✓
TEST 6: WRONG KEY        → Correctly rejected (commitment mismatch) ✓
TEST 7: CONSERVATION     → Correctly rejected (can't create money) ✓
TEST 8: MULTI-TOKEN      → Different token → different commitment ✓
TEST 9: SALT PRIVACY     → Same balance + different salt → different hash ✓
TEST 10: AMOUNT LINKAGE  → Sender/recipient amount_hash matches ✓
```

### balance_proof.test.js (11/11)
```
TEST 1: balance=100, threshold=50   → Proof valid ✓
TEST 2: balance=100, threshold=100  → Exact match valid ✓
TEST 3: balance=100, threshold=150  → Correctly rejected ✓
TEST 4: threshold=0                 → Always passes ✓
TEST 5: Wrong commitment            → Can't fake balance ✓
```

---

## Private Transfer Flow (how sender and recipient coordinate)

```
SENDER (Alice)                              RECIPIENT (Bob)
─────────────                               ──────────────
1. Pick amount + random amount_salt
2. Compute amount_hash = Poseidon(amount, amount_salt)
3. Generate ZK proof (is_debit=1):
   - old_balance → new_balance = old - amount
   - Conservation: old = new + amount
4. Submit proof + amount_hash to on-chain program

   ON-CHAIN: verify proof,
   update Alice's commitment,
   store amount_hash as pending for Bob

5. Send (amount, amount_salt) to Bob
   via encrypted off-chain channel
   (or derive from shared ECDH secret)

                                            6. Decrypt amount + amount_salt
                                            7. Verify: Poseidon(amount, amount_salt) == pending amount_hash
                                            8. Generate ZK proof (is_debit=0):
                                               - old_balance → new_balance = old + amount
                                               - Conservation: old + amount = new
                                            9. Submit proof to on-chain program

                                            ON-CHAIN: verify proof,
                                            verify amount_hash matches pending,
                                            update Bob's commitment,
                                            clear pending credit
```

---

---

## Anchor Program: `p01_zkspl`

**Status: DEPLOYED TO DEVNET**

- Program ID: `EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah`
- Binary: 370 KB (target/deploy/p01_zkspl.so)
- IDL: 42 KB (target/idl/p01_zkspl.json)
- IDL Account: `511gcYLyPyfGVMLLws5r1jL1uTkMrX34koCMotwmZqXs`
- Deploy Signature: `3R4JJDRzeJNX98rbspmzNidxfkFsds8b1WpHGvA159AjxhUAU638Bno2ACXTM1BtFodbMs7GZ5PY6ZSecK6avytV`

### Account Types

**MintConfig** (one per SPL token):
```
- authority: Pubkey
- token_mint: Pubkey
- balance_vk_hash: [u8; 32]    // Hash of confidential_balance verification key
- proof_vk_hash: [u8; 32]      // Hash of balance_proof verification key
- is_active: bool
- account_count: u64
```

**ConfidentialAccount** (one per user per token):
```
- owner: Pubkey
- mint: Pubkey
- balance_commitment: [u8; 32]  // Poseidon(balance, salt, owner_pubkey, token_mint)
- nonce: u64                     // Anti-replay (incremented each operation)
- pending_credits: Vec<PendingCredit>  // Max 16
- viewer_keys: Vec<Pubkey>       // Max 8 (opt-in compliance)
```

**PendingCredit**:
```
- amount_hash: [u8; 32]  // Poseidon(amount, amount_salt)
- sender: Pubkey
- timestamp: i64
```

### Instructions

| Instruction | Description | ZK Proof? |
|------------|-------------|-----------|
| `initialize_mint` | Register SPL token for zkSPL | No |
| `create_account` | Create confidential account (PDA per user per mint) | No |
| `deposit` | SPL → zkSPL (public amount) | Yes (confidential_balance) |
| `confidential_transfer` | Private send (hidden amount) | Yes (confidential_balance) |
| `apply_pending` | Recipient applies incoming credit | Yes (confidential_balance) |
| `withdraw` | zkSPL → SPL (public amount) | Yes (confidential_balance) |
| `prove_balance` | Prove "balance ≥ X" for DeFi | Yes (balance_proof) |
| `add_viewer` | Opt-in compliance viewing key | No |
| `remove_viewer` | Remove viewer | No |
| `init_vk_data` | Create VK storage account | No |
| `write_vk_data` | Upload VK bytes in chunks | No |

### PDA Seeds

| Account | Seeds |
|---------|-------|
| MintConfig | `["zkspl_mint", token_mint]` |
| ConfidentialAccount | `["zkspl_account", owner, token_mint]` |
| Vault | `["zkspl_vault", token_mint]` |
| VK Data | `["zkspl_vk", mint_config, vk_type]` |

### Source Structure

```
programs/p01_zkspl/src/
├── lib.rs                    ← Entry point, declare_id!, instruction routing
├── errors.rs                 ← Error codes
├── state/
│   ├── mod.rs
│   ├── mint_config.rs        ← MintConfig account
│   └── confidential_account.rs ← ConfidentialAccount + PendingCredit
├── verifier/
│   ├── mod.rs
│   └── groth16.rs            ← On-chain Groth16 verification (alt_bn128 syscall)
└── instructions/
    ├── mod.rs
    ├── initialize_mint.rs
    ├── create_account.rs
    ├── deposit.rs
    ├── confidential_transfer.rs
    ├── apply_pending.rs
    ├── withdraw.rs
    ├── prove_balance.rs
    ├── manage_viewers.rs
    └── store_vk_data.rs
```

### SDK Structure

```
packages/zkspl-sdk/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts       ← Barrel exports
    ├── types.ts       ← TypeScript types (accounts, circuits, events)
    ├── constants.ts   ← Program ID, PDA seeds, limits
    ├── crypto.ts      ← Poseidon hashing, commitments, field utils
    ├── prover.ts      ← Dual-backend prover (Rust + snarkjs)
    ├── state.ts       ← Local encrypted state management
    └── client.ts      ← ZkSplClient (high-level API)
```

---

## Implementation Status

### Phase 1: ZK Circuits — DONE
- `confidential_balance.circom` (1,382 constraints, 29/29 tests)
- `balance_proof.circom` (644 constraints, 11/11 tests)
- Keys generated via pot20_final.ptau

### Phase 2: Anchor Program — DEPLOYED TO DEVNET
- Program ID: `EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah`
- 11 instructions, on-chain Groth16 verification via alt_bn128 syscalls
- Account state: balance_commitment, pending_credits, nonce, viewer_keys

### Phase 3: SDK — DONE
- `packages/zkspl-sdk/` — TypeScript SDK
- `ZkSplClient` class: deposit, withdraw, confidentialTransfer, applyPending, proveBalance
- `ZkSplProver`: dual backend (remote Rust prover + local snarkjs fallback)
- `LocalStateManager`: encrypted local balance/salt/nonce management
- Crypto utils: Poseidon hashing (poseidon-lite), field/byte conversions

### Phase 4: Rust Prover Integration — DONE
- Added `confidential_balance` and `balance_proof` circuits to Rust prover
- Relayer proxies `/prove/zkspl` and `/prove/balance-proof` endpoints
- Dockerfile updated with new circuit files and environment variables

### Phase 5: E2E Tests — DONE
- `tests/zkspl.ts` — comprehensive Anchor test suite
- Covers: init mint, VK upload, create accounts, deposit, transfer, apply pending, withdraw, prove balance, viewer management, error cases
- Uses circomlibjs Poseidon + mock Groth16 proofs (verifier returns `true` in non-Solana mode)

### Phase 6: Mobile & Extension Integration — DONE
- **Mobile app** (`apps/mobile/`):
  - `services/zkspl/index.ts` — ZkSplService wrapper with AsyncStorage state, spending key derivation
  - `stores/confidentialStore.ts` — Zustand + persist store for confidential balances
  - `app/(main)/(wallet)/confidential.tsx` — Full Confidential Balance screen (deposit/withdraw/transfer modals, progress overlay)
  - Wallet home updated with confidential balance card and navigation
- **Chrome extension** (`apps/extension/`):
  - `shared/services/zkspl.ts` — ZkSplClient wrapper with Chrome storage, Privy + legacy wallet support
  - `shared/store/confidential.ts` — Zustand store with Chrome storage persistence
  - `popup/pages/ConfidentialWallet.tsx` — Confidential wallet page (Tailwind + Framer Motion)
  - ShieldedWallet updated with "Confidential Balances" entry card
  - App.tsx route added at `/confidential`

### Next Steps
- DeFi composability: published spec for balance proof verification
- Open-source specification and developer docs
- Mainnet deployment and security audit
