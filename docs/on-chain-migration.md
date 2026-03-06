# Protocol 01 — On-Chain Migration: Eliminating the Relayer

**Document version:** 1.0
**Date:** 2026-03-06
**Status:** Architecture design
**Goal:** Move all relayer functions on-chain to eliminate the last trusted third party

---

## 1. Current Relayer Functions

The relayer (`services/relayer/`) currently performs 5 functions:

| Function | Trust Impact | On-Chain Replacement |
|----------|-------------|---------------------|
| **Proof generation** (Rust prover) | CRITICAL — sees spending_key for zkSPL | Client-side proving (snarkjs WASM) |
| **Transaction submission** (gas abstraction) | MEDIUM — sees recipient, timing, IP | Direct user submission OR fee-payer PDA |
| **Proof verification** (pre-submit check) | LOW — convenience only | On-chain verifier already does this |
| **Commitment indexing** (WebSocket events) | LOW — public data | Client-side RPC subscription |
| **Merkle tree sync** (serve subtrees) | LOW — public data | On-chain state OR client-side indexing |

## 2. Target Architecture

```
CURRENT:
  User → [private inputs] → Relayer → [proof + tx] → Solana
  Trust: User must trust Relayer with secrets

TARGET:
  User → [client-side proof] → Solana (directly)
  Trust: Trustless — no third party sees private data
```

### 2.1 Client-Side Proving (Kill the Prover Service)

**For Denominated Pool (already client-side in extension):**
- Extension: snarkjs in Web Worker — DONE
- Mobile: snarkjs in hidden WebView — DONE but disabled (19MB circuit file)
- Fix: Use lazy loading + streaming for circuit files
- Alternative: Compile to native module via react-native-snarkjs

**For zkSPL (currently server-side):**
- Circuit is small (1,382 constraints vs 4,273 for denominated pool)
- snarkjs WASM proving: estimated ~30-60s on mobile, ~5s in extension
- This is the #1 priority — it eliminates spending_key exposure

### 2.2 Direct Transaction Submission (Kill Gas Abstraction)

**Option A: User pays gas directly**
- Simplest approach
- User needs SOL for transaction fees (~0.000005 SOL per tx)
- No privacy loss — user submits directly to Solana RPC

**Option B: On-chain fee payer program**
- New Solana program: `p01_fee_payer`
- User submits proof + public inputs
- Program verifies proof and executes the operation
- Fee is deducted from the shielded pool or paid in tokens
- No trusted intermediary needed

**Option C: Solana-native fee abstraction (SIMD-0072)**
- Solana is working on native transaction fee abstraction
- Would allow SPL token fee payment
- Status: In development, not yet available

**Recommended: Option A for devnet, Option B for mainnet**

### 2.3 Client-Side Commitment Indexing

**Current:** Relayer indexes commitments via WebSocket and serves them to clients

**Target:** Client subscribes to Solana program events directly
```typescript
// Client-side commitment indexing
connection.onProgramAccountChange(
  POOL_PROGRAM_ID,
  (accountInfo) => {
    // Parse pool state, extract new commitments
    // Update local Merkle tree
  },
  'confirmed'
);
```

### 2.4 Client-Side Merkle Tree

**Current:** Relayer maintains the Merkle tree and provides subtrees to clients

**Target:** Client builds tree from on-chain events
```typescript
// Fetch all shield events from program logs
const signatures = await connection.getSignaturesForAddress(poolPda);
for (const sig of signatures) {
  const tx = await connection.getTransaction(sig.signature);
  // Extract commitment from instruction data
  // Insert into local Merkle tree
}
```

## 3. New On-Chain Program: `p01_trustless`

A new Solana program that replaces the relayer for operations that need gas abstraction:

```rust
// programs/p01_trustless/src/lib.rs

#[program]
pub mod p01_trustless {
    /// Shield + verify in one atomic transaction
    /// User provides: commitment, proof (optional), new_root
    /// Program: inserts commitment, transfers tokens, updates root
    pub fn shield_trustless(
        ctx: Context<ShieldTrustless>,
        commitment: [u8; 32],
        new_root: [u8; 32],
        denomination: u64,
    ) -> Result<()> { ... }

    /// Unshield with client-generated proof
    /// User provides: proof, public inputs
    /// Program: verifies proof, nullifies, transfers tokens
    pub fn unshield_trustless(
        ctx: Context<UnshieldTrustless>,
        proof: Groth16Proof,
        merkle_root: [u8; 32],
        nullifier: [u8; 32],
        min_epoch: u64,
        token_mint: Pubkey,
        recipient: Pubkey,
    ) -> Result<()> { ... }

    /// zkSPL operation with client-generated proof
    /// User provides: proof, public inputs
    /// Program: verifies proof, updates confidential account
    pub fn zkspl_trustless(
        ctx: Context<ZksplTrustless>,
        proof: Groth16Proof,
        old_commitment: [u8; 32],
        new_commitment: [u8; 32],
        amount_hash: [u8; 32],
        public_credit: u64,
        public_debit: u64,
        token_mint: Pubkey,
        nonce: u64,
    ) -> Result<()> { ... }
}
```

## 4. Migration Steps

### Phase 1: Client-Side zkSPL Proving (Immediate)
1. Add snarkjs WASM prover for confidential_balance circuit to mobile and extension
2. Load circuit files lazily (don't bundle in APK)
3. Remove spending_key from relayer API calls
4. Keep relayer available as optional fallback

### Phase 2: Direct Transaction Submission (Next)
1. Users submit shield/unshield transactions directly
2. Remove relayer as transaction intermediary
3. Client-side RPC subscription for commitment indexing

### Phase 3: On-Chain Fee Abstraction (When Ready)
1. Deploy `p01_trustless` program on devnet
2. Support fee payment from shielded balance
3. Full trustless operation — no off-chain component needed

## 5. What Remains Off-Chain

Even with full on-chain migration, some things must remain client-side:
- **Proof generation** — always on user's device (trustless)
- **Merkle tree construction** — client builds from on-chain events
- **Stealth address scanning** — client scans using viewing key
- **Key management** — private keys never leave the device

Nothing needs to be on a server. The protocol becomes fully peer-to-peer:
User ↔ Solana blockchain. No intermediary.

---

*This architecture ensures that even a nation-state adversary who controls all network infrastructure between the user and Solana cannot compromise the protocol's privacy guarantees — provided the user's device is not compromised.*
