# Protocol 01 — Quantum Resistance Assessment & Migration Plan

**Document version:** 1.1
**Date:** 2026-04-17 (v1.0: 2026-03-06)
**Status:** Research, planning, and partial implementation (stealth + claim layers shipped; proof system migration complete)
**Classification:** Internal — engineering reference

---

## What's New in v1.1 (2026-04-17)

Since v1.0 this document has tracked planning; this revision tracks **what has actually shipped**. Summary of the post-quantum work landed since March:

| Workstream | Status as of 2026-04-17 | Reference |
|-----------|------------------------|-----------|
| STARK proof-system migration (Groth16 → Winterfell) | **Shipped** — all 6 circuits, all 7 shielded-pool instructions switched to STARKs; deprecated Groth16 instructions and VK data removed | P3.1–P3.7 in roadmap |
| Hybrid X25519 + ML-KEM-768 stealth addresses | **Shipped + mandatory** — v2 is the only accepted format; v1 announcements are rejected at the SDK and on-chain layers | P4.1 |
| HKDF info-binding enrichment (mix-and-match defense) | **Shipped** — hybrid-KEM shared secret now binds `ephemeralPubKey \|\| kemCiphertext` into the HKDF info field | P4.2 |
| Stealth claim post-quantum wrapper (WOTS+) | **Shipped (SDK)** — `deriveStealthWotsKeypair`, `buildClaimProofPQ`, `verifyClaimProofPQ`; on-chain "both-sigs-valid" verifier deferred to P4.6 roadmap | P4.3 |
| SPHINCS+ (SLH-DSA) evaluation for commit-reveal | **Evaluated — DEFER** (see §2.10) | P4.4 |
| SHA-512 long-term commitment primitive | **Shipped (SDK)** — opt-in `computeLongTermCommitment` with domain separation; no on-chain changes (see §2.11) | P4.5 |

The sections below retain the full March-6 analysis. Where an item has moved from "planned" to "shipped," an inline **Status:** line has been added rather than rewriting the original text — the historical threat analysis is still the correct justification for the work that followed.

---

## Executive Summary

Protocol 01 is a privacy layer for Solana using ZK-STARKs (Winterfell, migrated from Groth16 in P3), stealth addresses (hybrid X25519 + ML-KEM-768, v2 mandatory as of P4.1), and confidential balances (Poseidon commitments). This document inventories every cryptographic primitive in the protocol, assesses its quantum resistance, and defines a migration path to ensure user privacy remains strong for decades — even against nation-state adversaries with quantum computers.

**Key findings (updated 2026-04-17):**
- **The proof system is now fully quantum-resistant** — STARKs with hash-only assumptions replaced Groth16/BN254 across all 7 shielded-pool instructions (P3.1–P3.7). The Groth16 verifier has been removed.
- **Stealth address key exchange is now hybrid post-quantum** — every new stealth payment uses X25519 + ML-KEM-768 with transcript-bound HKDF. V1 is rejected end-to-end; an HNDL attacker who harvests today's announcements cannot decrypt them without breaking both ECDH *and* ML-KEM.
- **Stealth claims can now be authenticated with a hash-based signature** alongside the Ed25519 signature. The on-chain verifier that enforces "both must be valid" is the next post-quantum step (the SDK is ready).
- **Wallet signatures remain Ed25519** — this is a Solana-level dependency; see §2.1. Solana's Dilithium testnet (Project Eleven) and SIMD-0296 are the ecosystem path forward.
- **HNDL defense posture for stealth addresses is now "as good as any L1 payment network has"** — short of waiting for Solana's native Dilithium/Kyber support, the hybrid stealth + WOTS+ claim construction is the maximum client-side defense available today.
- **Solana ecosystem is actively preparing** — Dilithium testnet (Dec 2025), Winternitz Vault (mainnet), SIMD-0296 (4KB transactions, in review), STARK on-chain verification proven feasible (1.1M CU).

### Quantum Resistance Scorecard

(Updated 2026-04-17 — rows marked ✓ shipped have moved from "planned" to "implemented and deployed".)

| Component | Primitive | Status | Threat | Timeline |
|-----------|----------|--------|--------|----------|
| Commitments (zkSPL) | Poseidon | SAFE | Grover (halved, still sufficient) | N/A |
| Commitments (shielded pool) | Poseidon | SAFE | Grover (halved, still sufficient) | N/A |
| Merkle trees | Poseidon | SAFE | ~85-bit quantum collision resistance | N/A |
| Symmetric encryption | XSalsa20-Poly1305 | SAFE | Grover (256→128 bit, sufficient) | N/A |
| Metadata encryption | AES-256-CBC | SAFE | Grover (256→128 bit, sufficient) | N/A |
| Hash functions | SHA-256, Keccak256, SHA-512 | SAFE | Grover (128-bit post-quantum) | N/A |
| Key derivation | HKDF-SHA256 (w/ transcript binding) | SAFE | Grover (halved, sufficient) | N/A |
| Random generation | nacl.randomBytes | SAFE | Not affected by quantum | N/A |
| **ZK proof verification** | **STARK (Winterfell + SHA-256)** ✓ shipped | **SAFE** | **Hash assumptions only** | **N/A** |
| **Stealth addresses (key exchange)** | **Hybrid X25519 + ML-KEM-768** ✓ shipped | **SAFE (hybrid)** | **Safe unless BOTH ECDH and ML-KEM fall** | **N/A** |
| **Stealth claim signature (SDK)** | **Ed25519 + WOTS+ (hash-based)** ✓ shipped | **SAFE (hybrid)** | **Safe unless BOTH Ed25519 and SHA-256 fall** | **Verifier: pending (P4.6 roadmap)** |
| **Long-term commitment primitive** | **SHA-512 domain-separated** ✓ shipped (SDK) | **SAFE** | **2^256 PQ preimage margin** | **N/A** |
| **Wallet signatures** | **Ed25519** | **BROKEN (Solana-level)** | **Shor — O(n³)** | **2035-2045** |
| **VK on-chain storage (legacy)** | **BN254 curve points** | **REMOVED** | n/a — Groth16 deprecated in P3.7 | — |
| **Pedersen commitments (p01-js)** | **Ed25519 (C=vG+rH)** | **BROKEN — unused in production circuits** | **Shor — unhides values** | **2035-2045** |

---

## 1. Quantum Threat Model

### 1.1 Shor's Algorithm — Breaks Public-Key Cryptography

**Complexity:** Polynomial time O(n³) on a quantum computer
**What it breaks in Protocol 01:**

| Primitive | Where Used | Impact |
|-----------|-----------|--------|
| Ed25519 | Solana wallet keypairs, transaction signing | Attacker can derive private key from public key, steal all funds |
| X25519 (Curve25519) | Stealth address ECDH key exchange | Attacker can derive shared secrets, de-anonymize all stealth payments |
| BN254 pairing | Groth16 proof verification (alt_bn128 syscalls) | Attacker can forge proofs, mint tokens, double-spend |

**Estimated timeline for Cryptographically Relevant Quantum Computer (CRQC):**
- Optimistic: 2030-2035
- Consensus: 2035-2040
- Conservative: 2040-2050
- Required logical qubits for 255-bit ECC: ~4,000 (current largest: ~1,500 noisy)

**NIST recommendation:** Begin migration NOW. NSA CNSA 2.0 mandates PQC for new classified systems by 2027.

### 1.2 Grover's Algorithm — Weakens Symmetric Crypto

**Complexity:** O(√N) — halves effective security bits
**Impact on Protocol 01:**

| Primitive | Current Security | Post-Quantum Security | Status |
|-----------|-----------------|----------------------|--------|
| XSalsa20-Poly1305 (256-bit key) | 256 bits | 128 bits | SAFE |
| AES-256-CBC | 256 bits | 128 bits | SAFE |
| SHA-256 | 128-bit collision | 85-bit collision (BHT) | SAFE |
| Poseidon (BN254 field, 254-bit) | ~127-bit collision | ~85-bit collision | SAFE |
| Keccak256 | 128-bit collision | ~85-bit collision | SAFE |
| HKDF-SHA256 | 256-bit PRF | 128-bit PRF | SAFE |

**Mitigation:** All symmetric primitives already use 256-bit keys. No changes needed.

### 1.3 Harvest Now, Decrypt Later (HNDL)

**The most urgent quantum threat.** The HNDL attack model means adversaries (nation-states, intelligence agencies, corporations) record encrypted/obfuscated data today and decrypt it when quantum computers become available.

**Why this matters for Protocol 01:**

1. **Blockchain immutability**: Every transaction, commitment, nullifier, ephemeral public key, and stealth address is permanently recorded on Solana's ledger
2. **Retroactive de-anonymization**: An adversary who records today's stealth address ephemeral public keys can, in the future:
   - Derive all ECDH shared secrets using Shor's algorithm
   - Reconstruct every stealth address mapping (sender → recipient)
   - De-anonymize the entire history of private transfers
3. **Proof forgery**: Historical proofs cannot be retroactively forged (they're already verified), but the *ability* to forge new proofs means the proof system must be migrated before CRQC arrives
4. **The Federal Reserve (2025)** warns: "HNDL is a present and ongoing privacy risk for distributed ledger networks, not a future one"

**Critical implication for Protocol 01:**
- **Stealth address ephemeral public keys on-chain are the #1 HNDL target**
- Every `ephemeralPublicKey` stored or emitted on Solana creates a permanent record that can be decrypted by a future quantum computer
- This cannot be fixed retroactively — only new transactions can use quantum-resistant key exchange
- Users should be warned: **current stealth transactions provide privacy against classical computers but NOT against future quantum computers**

---

## 2. Complete Cryptographic Primitive Inventory

### 2.1 Layer 1: Wallet Signatures — Ed25519

**Status: BROKEN by Shor's algorithm**

| File | Usage | Library |
|------|-------|---------|
| `packages/specter-sdk/src/utils/crypto.ts:291` | `nacl.sign.detached()` — Ed25519 signing | tweetnacl |
| `packages/specter-sdk/src/utils/crypto.ts:306` | `nacl.sign.detached.verify()` — Ed25519 verification | tweetnacl |
| `packages/specter-sdk/src/utils/crypto.ts:27` | `nacl.sign.keyPair()` — keypair generation | tweetnacl |
| `apps/extension/src/shared/services/wallet.ts:70` | `nacl.sign.keyPair.fromSeed()` — wallet creation | tweetnacl |
| `apps/extension/src/shared/store/authAdapter.ts:172` | `tweetnacl.sign` — auth signatures | tweetnacl |
| All Solana transactions | `Keypair`, `Transaction.sign()` | @solana/web3.js |

**Quantum attack:** Shor's algorithm derives Ed25519 private key from public key in polynomial time. All wallets whose public key has ever been revealed (i.e., any wallet that has ever sent a transaction) are vulnerable.

**Dependency:** This is a **Solana-level** issue. Protocol 01 cannot fix this independently — it requires Solana protocol support for post-quantum signatures.

**Solana ecosystem status (as of March 2026):**
- **Winternitz Vault (mainnet):** Hash-based one-time signatures using Keccak256. Available today but limited: each key can only sign once, requires new vault per transaction. Not suitable as default wallet mechanism.
- **Project Eleven testnet (Dec 2025):** Full replacement of Ed25519 with CRYSTALS-Dilithium (ML-DSA, FIPS 204). Demonstrated ~3,000 TPS with no degradation. Proves feasibility.
- **SIMD-0296 (in review):** Transaction size limit increase from 1,232→4,096 bytes. Required for Dilithium signatures (2,560 bytes vs Ed25519's 64 bytes).
- **No mainnet timeline:** Solana has no official PQC mainnet roadmap yet.

**Protocol 01 action items:**
1. **Monitor** Solana's PQC rollout closely (SIMD-0296, Dilithium precompile)
2. **Prepare** for hybrid signatures (Ed25519 + Dilithium) when Solana supports them
3. **Consider** Winternitz Vault for high-value cold storage (available now)
4. **Document** the risk to users: wallets that have transacted have exposed their public key

### 2.2 Layer 2: Key Exchange — X25519 ECDH (Stealth Addresses)

**Status (2026-04-17): MITIGATED via mandatory hybrid X25519 + ML-KEM-768 with transcript-bound HKDF.**

As of P4.1, the SDK and on-chain layers refuse to produce or accept v1 (classical-only) stealth announcements. Every new stealth payment uses `deriveHybridSharedSecret(classic_ecdh, ml_kem_shared, { ephemeralPubKey, kemCiphertext })` — so an HNDL adversary who records today's on-chain data cannot recover the shared secret even with a future Shor oracle, unless ML-KEM is simultaneously broken. P4.2 bound the ephemeral pubkey and KEM ciphertext into the HKDF info field to prevent mix-and-match attacks that would otherwise let an adversary reuse one half of a transcript under a different context.

The original analysis below describes the pre-mitigation state and the design decisions that drove P4.1–P4.3. It is retained because the "BROKEN by Shor" analysis still applies to *old* (pre-P4.1) stealth announcements that remain on-chain — those cannot be retroactively fixed.

**Historical status (v1.0): BROKEN by Shor's algorithm — HIGHEST PRIORITY for Protocol 01.**

This is the component Protocol 01 has the most control over and where HNDL is most dangerous.

**Current implementation (3 separate implementations!):**

#### Implementation A: Extension (`apps/extension/src/shared/store/shielded.ts`)
```
Flow: nacl.box.keyPair() → nacl.box.before() → SHA-256 → stealth seed → Keypair.fromSeed()
- Ephemeral X25519 keypair: nacl.box.keyPair() (line 167)
- Viewing key derivation: nacl.hash(viewingSeed).slice(0, 32) (line 125)
- Shared secret: nacl.box.before(theirPub, mySecret) (line 52)
- View tag: SHA-256(hex(sharedSecret) + 'view_tag').slice(0,2) (line 80-88)
- Stealth seed: SHA-256(hex(spendingPub || SHA-256(hex(sharedSecret)))) (line 195)
- Final address: Keypair.fromSeed(stealthSeed) (line 198)
```

#### Implementation B: Specter SDK (`packages/specter-sdk/src/stealth/derive.ts`)
```
Flow: nacl.box.keyPair() → nacl.scalarMult() → SHA-256 → XOR+hash(!) → Keypair.fromSeed()
- Ephemeral keypair: nacl.box.keyPair() (crypto.ts:20)
- Shared secret: nacl.scalarMult(privateKey, publicKey) (crypto.ts:39)
- View tag: SHA-256(sharedSecret)[0] (crypto.ts:82)
- Stealth pubkey: addPublicKeys(spendingPub, sha256(sharedSecret)) (derive.ts:50-53)
  WARNING: addPublicKeys uses XOR + hash, NOT proper EC point addition (derive.ts:211-221)
- Private key derivation: byte-by-byte mod 256 addition (derive.ts:226-237)
  WARNING: This is NOT correct scalar modular arithmetic
```

#### Implementation C: Relayer (`services/relayer/src/private-send.ts`)
```
Flow: crypto.randomBytes() → SHA-256(ephemeral || viewingPub) → SHA-256(spendingPub || secret)
- Ephemeral key: crypto.randomBytes(32) (line 71)
- Shared secret: SHA-256(ephemeralPrivate || recipientViewingPubkey) (lines 75-79)
  WARNING: NOT actual ECDH — just concatenation + hash
- Stealth seed: SHA-256(spendingPubkey || sharedSecret) (lines 82-87)
- View tag: SHA-256(sharedSecret + 'view_tag').slice(0,2) (lines 90-94)
```

**Quantum vulnerabilities in stealth addresses:**

| Component | Algorithm | Quantum Status | HNDL Risk |
|-----------|----------|---------------|-----------|
| Ephemeral keypair | X25519 | BROKEN (Shor) | HIGH — ephemeral public key stored on-chain |
| Shared secret derivation | X25519 ECDH / nacl.scalarMult | BROKEN (Shor) | CRITICAL — derivable from on-chain ephemeral key |
| View tag | SHA-256 | SAFE | N/A |
| Stealth seed derivation | SHA-256 | SAFE | N/A (but input is compromised by above) |
| Final stealth address | Ed25519 (Keypair.fromSeed) | BROKEN (Shor) | Dependent on Solana PQC |

**The chain of vulnerability:**
1. Ephemeral X25519 public key `R` is published on-chain (permanent record)
2. Quantum attacker uses Shor to derive ephemeral private key `r` from `R`
3. Attacker retrieves recipient's viewing public key `V` from stealth meta-address
4. Attacker computes `sharedSecret = ECDH(r, V)` — the same value the sender computed
5. Attacker derives the stealth address and links sender → recipient
6. **All historical stealth payments are de-anonymized**

**Migration: Hybrid X25519 + ML-KEM (Kyber)**

The migration must use a **hybrid** key exchange: classical X25519 (for backward compatibility during transition) combined with ML-KEM (for quantum resistance). The combined shared secret ensures security even if one scheme is broken.

**Target protocol (Phase 1 — Hybrid):**
```
SENDER:
  1. Generate ephemeral X25519 keypair: (r, R = r*G)
  2. Generate ML-KEM ciphertext: (ct, pq_secret) = ML-KEM.Encaps(recipient_kem_pubkey)
  3. Compute classical shared secret: classical_secret = X25519(r, V)
  4. Combine: shared_secret = SHA-256(classical_secret || pq_secret || "protocol01-hybrid-v1")
  5. Derive stealth address from shared_secret (same as current)
  6. Publish on-chain: R (32 bytes) + ct (1,088 bytes for Kyber768) + view_tag (2 bytes)

RECIPIENT (scanning):
  1. For each announcement: try X25519 + ML-KEM.Decaps
  2. Quick reject via view tag
  3. If match: derive stealth private key (same as current)
```

**Target protocol (Phase 2 — Pure PQC):**
```
SENDER:
  1. (ct, shared_secret) = ML-KEM.Encaps(recipient_kem_pubkey)
  2. Derive stealth address from shared_secret
  3. Publish on-chain: ct (1,088 bytes) + view_tag (2 bytes)

RECIPIENT (scanning):
  1. shared_secret = ML-KEM.Decaps(recipient_kem_privkey, ct)
  2. Module-LWE SAP scans 66.8% faster than ECDH-based scanning
```

**Available libraries:**
- `@noble/post-quantum` — Audited ML-KEM (Kyber) implementation for JS/TS (by Paul Miller, same author as @noble/hashes already used)
- `mlkem` — FIPS 203 compliant TypeScript implementation, 1.4-1.8x faster
- `pqcrypto` (Rust) — For the prover service

**Key size impact on Solana:**

| Scheme | Ephemeral Public Key | Ciphertext | Total On-Chain per Payment |
|--------|---------------------|------------|---------------------------|
| Current (X25519) | 32 bytes | N/A | 32 + 2 (view tag) = 34 bytes |
| Hybrid (X25519 + Kyber768) | 32 bytes | 1,088 bytes | 1,122 bytes |
| Pure ML-KEM-768 | N/A | 1,088 bytes | 1,090 bytes |
| Pure ML-KEM-1024 | N/A | 1,568 bytes | 1,570 bytes |

**Solana account storage:** These fit comfortably in a Solana account (max 10 MB). The stealth payment PDA currently stores 105 bytes; ML-KEM would increase this to ~1,200 bytes — well within limits.

### 2.3 Layer 3: Symmetric Encryption

**Status: SAFE — no changes required**

| File | Algorithm | Key Size | Post-Quantum Security |
|------|----------|----------|----------------------|
| `packages/specter-sdk/src/utils/crypto.ts:95-105` | XSalsa20-Poly1305 (nacl.secretbox) | 256-bit | 128-bit (SAFE) |
| `packages/specter-sdk/src/utils/crypto.ts:125-139` | X25519+XSalsa20-Poly1305 (nacl.box) | 256-bit | 128-bit key, but X25519 BROKEN |
| `services/relayer/src/private-send.ts:115` | AES-256-CBC | 256-bit | 128-bit (SAFE) |
| `apps/mobile/.../share-note.tsx:278` | XSalsa20-Poly1305 (BLE), PIN-derived (NFC) | 256-bit | 128-bit (SAFE) |

**Note:** The `nacl.box()` (authenticated public-key encryption) uses X25519 for key exchange — the encryption itself is safe but the key agreement is vulnerable. When migrating stealth addresses to ML-KEM, the encryption key derivation must also use the hybrid shared secret.

**WARNING — XOR "Encryption" in Mobile:**
`apps/mobile/utils/crypto/encryption.ts:88-105` contains a custom XOR cipher. This is NOT cryptographically secure even against classical computers. It should be replaced with AES-GCM or XSalsa20-Poly1305 regardless of quantum considerations.

### 2.4 Layer 4: Hash Functions

**Status: SAFE — no changes required**

| Hash Function | Usage | Post-Quantum Security |
|---------------|-------|----------------------|
| Poseidon (BN254 field) | Note commitments, nullifier derivation, owner key derivation, Merkle tree | ~85-bit collision, ~127-bit preimage |
| SHA-256 | View tag generation, stealth seed derivation, key derivation, metadata hashing | ~85-bit collision, ~128-bit preimage |
| SHA-512 | Ed25519→X25519 private key conversion (internal) | ~170-bit collision, ~256-bit preimage |
| BLAKE2b | Fast hashing, keyed MAC (in p01-js SDK) | ~85-bit collision, ~128-bit preimage |
| Keccak256 | Verification key hashing (on-chain), Winternitz Vault | ~85-bit collision, ~128-bit preimage |

All hash functions provide at least 85-bit collision resistance post-quantum, which is computationally infeasible even for quantum computers (2^85 operations ≈ 3.8 × 10^25).

### 2.5 Layer 5: Commitments

**Status: SAFE — already quantum-resistant**

| Commitment Scheme | Construction | Files | Quantum Status |
|-------------------|-------------|-------|---------------|
| zkSPL balance commitment | `Poseidon(balance, salt, owner_pubkey, token_mint)` | `circuits/confidential_balance.circom` | SAFE |
| Shielded pool note commitment | `Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)` | `circuits/denominated_pool.circom` | SAFE |
| Nullifier | `Poseidon(nullifier_preimage, secret)` | `circuits/denominated_pool.circom` | SAFE |
| Owner key derivation | `Poseidon(spending_key)` | `circuits/poseidon.circom` | SAFE |
| Amount hash | `Poseidon(amount, amount_salt, sender_pubkey, recipient_pubkey)` | `circuits/confidential_balance.circom` | SAFE |
| **Pedersen commitment** | **C = v*G + r*H** | **`packages/p01-js/src/security/crypto.ts:594-730`** | **BROKEN (Shor)** |

**WARNING — Pedersen Commitments:**
The `p01-js` package contains a full Pedersen commitment implementation (lines 594-730) using Ed25519 curve points. Pedersen commitments rely on the discrete logarithm problem: given C = v*G + r*H, an attacker with Shor's algorithm can compute v and r, breaking the hiding property. This includes:
- `createPedersenCommitment()` — commit to amount with blinding factor
- `verifyPedersenCommitment()` — open and verify
- `addPedersenCommitments()` / `subtractPedersenCommitments()` — homomorphic operations
- `createZeroCommitment()` — commitment to zero

These Pedersen commitments are NOT used in the current ZK circuits (which use Poseidon), but they exist in the SDK and could be used by downstream code. **They must NOT be used for quantum-sensitive operations.**

**Why Poseidon commitments are quantum-safe:**
- Poseidon is an algebraic hash function over a prime field (BN254 Fr)
- It has no dependency on elliptic curve discrete logarithm problems
- Shor's algorithm does not apply to hash functions
- Grover's algorithm provides only a quadratic speedup (√N), resulting in ~85-bit collision resistance — still computationally infeasible

**Important distinction:** The Poseidon hash itself runs over the BN254 scalar field, but this is just the arithmetic field for computation — it does NOT depend on the BN254 curve's discrete log hardness. If Protocol 01 migrates from Groth16/BN254 to STARKs, Poseidon can be computed over any sufficiently large prime field.

### 2.6 Layer 6: Zero-Knowledge Proof System — STARK (migrated from Groth16/BN254)

**Status (2026-04-17): MIGRATED. All 7 shielded-pool instructions now verify STARK proofs on-chain; Groth16 verifier and VK data removed in P3.7.**

The post-quantum proof-system migration is complete. STARKs rely only on hash function assumptions (SHA-256 via Solana's `hashv` syscall + Blake3 for Merkle), making the proof system resistant to Shor's algorithm. Mapping of current instructions:

| Operation | Previous | Current |
|-----------|---------|---------|
| `subscribe_private` / `pause` / `resume` | Groth16 (subscriber_ownership, circuit 0) | STARK circuit 0 |
| `shield_denominated` (note commitment) | Groth16 (pool_commitment, circuit 1) | STARK circuit 1 |
| `prove_balance` | Groth16 (balance_proof, circuit 2) | STARK circuit 2 |
| `unshield_denominated_stark` | Groth16 → **removed** | STARK circuits 0-3 |
| `transfer_denominated_stark` | Groth16 → **removed** | STARK (multi-circuit) |
| `cancel_private_stark` | Groth16 → **removed** | STARK circuit 0 |
| `emergency_unshield_denominated_stark` | Groth16 → **removed** | STARK (multi-circuit) |
| `split_note_stark` | Groth16 → **removed** | STARK circuit 6 (merkle_update — WIP P2.2 on-chain) |

The original Groth16 analysis below is retained because it motivates the STARK migration, but the "BROKEN" status no longer applies to production code paths — only to historical on-chain proofs that have already been verified and cannot be forged retroactively.

**Historical status (v1.0): BROKEN by Shor's algorithm.**

**Current stack:**

| Component | Implementation | File |
|-----------|---------------|------|
| Circuit language | Circom 2.x | `circuits/*.circom` |
| Client-side prover | snarkjs 0.7.4/0.7.6 (WASM) | `packages/zk-sdk/src/prover/` |
| Server-side prover | ark-circom 0.5 (Rust) | `services/prover/src/prover.rs` |
| On-chain verifier | Custom Groth16 verifier (Rust) | `programs/zk_shielded/src/verifier/groth16.rs` |
| Pairing operations | Solana alt_bn128 syscalls | `solana-bn254` crate |
| Trusted setup | Hermez PoT (Phase 1) + single contributor (Phase 2) | `circuits/package.json` scripts |

**What Shor breaks:**
1. **BN254 elliptic curve pairings** — the alt_bn128 precompile computes `e(G1, G2)` bilinear pairings. Shor's algorithm makes the discrete log on BN254 tractable, allowing an attacker to:
   - Forge proof elements (π_A, π_B, π_C)
   - Compute valid proofs without knowing the private inputs
   - Break the soundness of the proof system entirely
2. **Verification key points** — the VK contains G1/G2 points (α, β, γ, δ, IC[]). With Shor, an attacker could extract the discrete logarithm relationships between these points.

**What Shor does NOT break:**
- The Circom circuit logic itself — the R1CS constraint system is mathematical, not cryptographic
- The Poseidon hash computations within circuits
- The commitment scheme (Poseidon-based, not EC-based)
- The Merkle tree structure

**Migration options:**

#### Option A: STARKs (Recommended Long-Term)

| Property | Current (Groth16/BN254) | Target (STARK) |
|----------|------------------------|----------------|
| Assumption | Elliptic curve pairings | Hash functions only |
| Quantum safe | NO | YES |
| Proof size | ~256 bytes | ~4,000-50,000 bytes |
| Verify cost | ~200K CU | ~1.1M CU (proven on Solana) |
| Setup | Trusted (ceremony needed) | Transparent (no ceremony!) |
| Prover | snarkjs / ark-circom | Winterfell / Stone / Cairo |

**Feasibility on Solana (confirmed by research):**
A 2025 measurement study (ePrint 2025/1741) demonstrated full STARK verification on Solana L1:
- Mean verification cost: **1.10 × 10⁶ CU** (fits within Solana's 1.4M CU budget)
- Proof size: ~4,437 bytes at 128-bit security
- Used Winterfell 0.12 with SHA-256 hashv syscall optimization
- Combined STARK + SLH-DSA (SPHINCS+) signature verification: total ~1.6M CU
- Scaling: approximately linear with proof bytes (~249 CU per proof byte)

**Circuit rewrite required:** Circom circuits would need to be rewritten for a STARK-compatible framework (Cairo, AIR/Winterfell, or Miden Assembly). The constraint logic is portable but the circuit language is not.

#### Option B: Hybrid STARK-inside-Groth16 (Recommended Transition)

```
Phase 1 (now → CRQC):
  Inner proof: STARK (quantum-safe, proves the actual statement)
  Outer proof: Groth16 wrapper (small on-chain footprint, cheap verification)

  On-chain: verify Groth16 wrapper (~200K CU)
  Off-chain: verify STARK (optional, for users who want quantum safety now)

Phase 2 (when CRQC approaches):
  Drop the Groth16 wrapper
  Verify STARKs directly on-chain (~1.1M CU)
```

This approach preserves the current on-chain verifier and transaction costs while providing a quantum-safe proof path for the future.

#### Option C: Lattice-Based SNARKs (Emerging Research)

Lattice-based SNARKs (based on LWE/SIS assumptions) could provide SNARK-like succinctness with quantum resistance. However, these are still in early research stages (Lattigo, OpenFHE). Not recommended for production planning until 2028+.

### 2.7 Layer 7: Merkle Trees

**Status: SAFE — Poseidon-based**

| Implementation | File | Depth | Hash |
|---------------|------|-------|------|
| Client-side incremental tree | `packages/privacy-toolkit/src/merkle/incrementalTree.ts` | 15/20 | Poseidon |
| Proof from subtrees | `packages/privacy-toolkit/src/merkle/proofFromSubtrees.ts` | 15 | Poseidon |
| On-chain Merkle state | `programs/zk_shielded/src/state/merkle_tree.rs` | 15 | Root stored (not computed on-chain) |
| In-circuit verification | `circuits/merkle.circom` | 15/20 | Poseidon |

**Post-quantum security:** ~85-bit collision resistance (Poseidon over BN254 field). This is sufficient — no practical attack is feasible at this security level.

**Future consideration:** If migrating to STARKs, consider using SHA-256 for Merkle trees (native Solana syscall support, higher post-quantum collision resistance at ~128 bits). However, this would change the in-circuit hash function and affect proof generation performance.

### 2.8 Layer 8: Key Derivation

**Status: SAFE with one caveat**

| Implementation | File | Algorithm | Post-Quantum |
|---------------|------|-----------|--------------|
| HKDF-SHA256 | `packages/specter-sdk/src/utils/crypto.ts:48-54` | HKDF(sha256) | SAFE (128-bit) |
| Password-based KDF | `packages/specter-sdk/src/utils/crypto.ts:167-179` | Iterative SHA-256 | WEAK — use Argon2id |
| Viewing key derivation | `apps/extension/.../shielded.ts:125` | `nacl.hash().slice(0,32)` | SAFE (512→32 bytes) |
| Stealth seed derivation | `apps/extension/.../shielded.ts:63-73` | SHA-256(SHA-256(hex)) | SAFE |

**Caveat:** The password-based KDF (`deriveKeyFromPassword` in crypto.ts:167-179) uses simple iterative SHA-256 hashing, not a proper memory-hard KDF. This is weak against both classical and quantum brute-force. Should use Argon2id regardless of quantum considerations.

### 2.9 Layer 9: Random Number Generation

**Status: SAFE**

| Implementation | Source | Post-Quantum |
|---------------|--------|--------------|
| `nacl.randomBytes()` | System CSPRNG (Web Crypto API / Node.js crypto) | SAFE |
| `crypto.randomBytes()` | Node.js OpenSSL CSPRNG | SAFE |
| `crypto.getRandomValues()` | Web Crypto API | SAFE |

Quantum computers do not provide speedups against properly seeded CSPRNGs.

### 2.10 Layer 10: Post-Quantum Authorization — SPHINCS+ Evaluation (P4.4)

**Status: EVALUATED — DEFER (see recommendation at end of section)**

The P4.3 WOTS+ wrapper (see `packages/specter-sdk/src/stealth/quantum.ts`) gives every stealth payment a hash-based signature binding the claim to `(stealthAddress, ephemeralPubKey, spendingPubKey, destinationPubKey)`. WOTS+ is *one-time* by construction: each stealth seed produces a fresh keypair that signs exactly one claim. This is a perfect fit for stealth claims but a poor fit for anywhere a key must sign repeatedly — e.g., a commit-reveal vault that a user wants to refill or a long-lived authorization key.

SPHINCS+ (standardized as SLH-DSA in NIST FIPS 205) is the stateless hash-based alternative: one keypair can sign a practically unlimited number of messages without tracking state, at the cost of much larger signatures. This section assesses whether SPHINCS+ should replace or augment the current commit-reveal primitive in `p01_quantum_vault`.

#### 2.10.1 Parameter Variants

NIST FIPS 205 defines 12 parameter sets (small `s` = smaller sig, slower sign; fast `f` = larger sig, faster sign):

| Parameter set | Security level | Public key | Signature | Sign time (ref) | Verify time (ref) |
|---------------|---------------|-----------|-----------|----------------|-------------------|
| SLH-DSA-SHA2-128s | NIST L1 (≈ AES-128) | 32 B | **7,856 B** | ~2,500 ms | ~2.5 ms |
| SLH-DSA-SHA2-128f | NIST L1 (≈ AES-128) | 32 B | **17,088 B** | ~115 ms | ~7 ms |
| SLH-DSA-SHA2-192s | NIST L3 (≈ AES-192) | 48 B | **16,224 B** | ~4,500 ms | ~4 ms |
| SLH-DSA-SHA2-192f | NIST L3 (≈ AES-192) | 48 B | **35,664 B** | ~180 ms | ~11 ms |
| SLH-DSA-SHA2-256s | NIST L5 (≈ AES-256) | 64 B | **29,792 B** | ~4,300 ms | ~7 ms |
| SLH-DSA-SHA2-256f | NIST L5 (≈ AES-256) | 64 B | **49,856 B** | ~320 ms | ~19 ms |

(SHAKE variants exist but offer no Solana advantage — there is no SHAKE syscall; only SHA-256 is hardware-accelerated.)

**Immediate observation:** even the smallest variant (SLH-DSA-SHA2-128s, 7.8 KB) is **more than 6× the 1,232-byte Solana transaction limit** and still 2× the proposed SIMD-0296 4,096-byte limit. Any on-chain use requires the same chunked-upload pattern already built for STARK proofs (`resize_proof_buffer` in `p01_stark_verifier`).

#### 2.10.2 Solana Feasibility Analysis

**Transaction size path (using the proof-buffer pattern):**

| Variant | Proof-buffer chunks needed | Approximate setup cost |
|---------|---------------------------|-----------------------|
| 128s (7.8 KB) | 8 chunks × ~1 KB | ~0.06 SOL rent for buffer account |
| 128f (17 KB) | 17 chunks × ~1 KB | ~0.13 SOL rent |
| 192s (16 KB) | 16 chunks × ~1 KB | ~0.12 SOL rent |
| 256s (30 KB) | 30 chunks × ~1 KB | ~0.22 SOL rent |

Every claim would need: (a) create buffer PDA, (b) 8-30 upload txs, (c) one verify tx, (d) close buffer PDA — **10-32 total transactions per claim**. By comparison, the P4.3 WOTS+ flow is **one** transaction with 2,144 bytes of signature + 2,144 bytes of public key, uploaded once.

**Compute unit path:**

SLH-DSA verification performs many thousand SHA-256 compressions. The ePrint 2025/1741 Solana STARK+SLH-DSA study measured:

- Combined STARK + SLH-DSA-SHA2-128f verification: **~1.6M CU** (exceeds 1.4M budget — must split across two txs)
- SLH-DSA-SHA2-128f alone: estimated **~500K CU** (35% of budget)
- SLH-DSA-SHA2-128s alone: estimated **~200-300K CU** (smaller sig, fewer hashes)

This is feasible but expensive: roughly 2-3× the CU cost of Groth16 verification for a primitive that only authorizes a single operation.

**Client-side (mobile) path:**

The @noble/post-quantum reference implementation has not been benchmarked on React Native, but parameter-set Fortuna:

- 128s signing: ~2.5 seconds on desktop → likely 8-15 seconds on mobile JS
- 128f signing: ~115 ms on desktop → likely 500-1500 ms on mobile JS
- Verification is fast everywhere (2-19 ms desktop, tens of ms on mobile)

The `s` variants have signing times that are prohibitive for interactive UX; only `f` variants are viable for client-side signing, which pushes signature sizes to the 17-50 KB range.

#### 2.10.3 Comparison: SPHINCS+ vs WOTS+ vs Current Commit-Reveal

| Property | Commit-Reveal (current) | WOTS+ (P4.3) | SPHINCS+ (SLH-DSA-128f) |
|----------|------------------------|--------------|------------------------|
| Quantum security | Hash preimage (~128-bit PQ) | Hash preimage + one-time (~128-bit PQ) | EUF-CMA under hash assumptions (~128-bit PQ) |
| Key reuse | N/A (hash lock, no signing) | **NO** (single use per keypair) | YES (stateless, unlimited) |
| Semantics | Prove knowledge of a preimage | Sign one arbitrary message | Sign unlimited arbitrary messages |
| Signature size | 32 B (preimage) + 32 B (commitment) | 2,144 B (sig) + 2,144 B (pubkey) | 17,088 B (sig) + 32 B (pubkey) |
| On-chain verify cost | <5K CU (one SHA-256) | ~100-150K CU (67-chain WOTS) | ~500K CU (thousands of SHA-256) |
| Fits in one Solana tx | YES | YES (single tx, signature in instruction data or buffer) | **NO** (requires 8-17 chunk uploads) |
| Client sign time | Instant | ~10-50 ms (67 hash chains) | 500-1500 ms (mobile `f`) |
| Expressiveness | Limited — only binary "I know X" | Arbitrary messages, context-bound | Arbitrary messages, reusable key |
| State burden | Stateless | **Stateful** (must track which keys have signed) | Stateless |

**Where each wins:**

- **Commit-reveal** wins when the authorization is binary and the commitment is known at commit time (cold-storage vault unlock, timelocked claim). The current `p01_quantum_vault` hash-lock is already optimal for this use case — it's smaller, faster, and simpler than either hash-based signature scheme.
- **WOTS+** wins for *per-payment one-time claims* where the keypair is naturally throwaway. P4.3 exploits this: each stealth address derives a fresh WOTS+ keypair from its seed, so the "key must be fresh" rule is satisfied by construction.
- **SPHINCS+** wins when a *stable, long-lived* quantum-safe signing key is needed — e.g., a user's recovery key, a treasury authorizer, a cross-program authority. None of Protocol 01's current primitives need this.

#### 2.10.4 Use-Case Mapping for Protocol 01

| Primitive | Current use case | Needs SPHINCS+? |
|-----------|-----------------|-----------------|
| Wallet transaction signing | Ed25519 (Solana-level) | No — this is Solana's decision; Dilithium is the ecosystem path |
| Stealth claim authorization | Ed25519 today, WOTS+ added in P4.3 | No — one-time signing is a perfect WOTS+ fit |
| Commit-reveal vault (`p01_quantum_vault` hash-lock) | SHA-256 preimage | **No** — hash-lock is simpler and smaller; SPHINCS+ would strictly bloat this |
| Winternitz Vault fallback | WOTS+ already | No |
| Long-lived auth key (hypothetical) | Does not exist in Protocol 01 today | Would be the right fit if introduced |
| Relayer operator keys | Ed25519 | Deferred — operator rotation is a governance issue, not a crypto one |

Every current authorization path in Protocol 01 is either (a) Solana-level and therefore outside our control, (b) inherently one-time (stealth claims), or (c) already optimal as a hash-lock (vaults). **There is no current Protocol 01 primitive where SPHINCS+ would be the best tool.**

#### 2.10.5 Recommendation: DEFER

**Decision:** Do **not** adopt SPHINCS+ in Protocol 01 at this time.

**Rationale:**

1. **No fit for current primitives.** WOTS+ (P4.3) covers one-time claim signing with a 10× smaller on-chain footprint. The hash-lock in `p01_quantum_vault` covers preimage-based authorization with a 200× smaller footprint. Adding SPHINCS+ would duplicate capability the stack already has, at a significantly higher cost.
2. **Prohibitive on-chain cost.** Even SLH-DSA-128s (the smallest variant) requires 8 chunk uploads + a verify call (~9 transactions per claim) versus 1 transaction for WOTS+. SLH-DSA-128f (the only mobile-viable variant for signing) needs 17 uploads.
3. **Mobile signing latency.** The `s` variants take ~seconds to sign on mobile JS, which breaks UX. The `f` variants sign in ~1 second but produce 17-50 KB signatures.
4. **NIST maturity is not the bottleneck.** SLH-DSA is FIPS-205 standardized and @noble/post-quantum has an audited implementation. The blocker is not algorithmic maturity — it's that nothing in Protocol 01 demands a stateless hash-based signature.

**Conditions that would flip this decision:**

- A new Protocol 01 feature introduces a *long-lived, reusable* quantum-safe signing key (e.g., governance multisig, delegation authority, cross-chain relay key). WOTS+ cannot serve this role because each key signs at most once.
- Solana deploys a native SLH-DSA precompile (not currently on any SIMD roadmap), dropping on-chain verify cost below the WOTS+ threshold.
- NIST identifies a structural weakness in WOTS+/XMSS stateful hash-based signatures that does not apply to SPHINCS+, making stateful one-time signatures untrustworthy.

**Tracking:** Quarterly review. If any condition above becomes true, re-evaluate with a new ADR. The reference @noble/post-quantum library exists and can be integrated quickly if the use case materializes.

**References specific to this section:**
- NIST FIPS 205 (SLH-DSA), 2024 — canonical SPHINCS+ spec
- ePrint 2025/1741 — Solana STARK+SLH-DSA measurement (CU costs, tx split strategy)
- @noble/post-quantum `slh_dsa_sha2_128s` / `slh_dsa_sha2_128f` — reference TypeScript impl

### 2.11 Layer 11: Long-Term Commitment Hashes — SHA-512 (P4.5)

**Status: EVALUATED — SDK primitive added, on-chain state unchanged**

The existing `HashVault.commitment` (`programs/p01_quantum_vault/src/state/hash_vault.rs`) and `CommitRecord.commitment` (`programs/p01_quantum_vault/src/state/commit_reveal.rs`) both store 32-byte SHA-256 digests. Under Grover's algorithm, SHA-256 preimage resistance drops from 2^256 to 2^128. P4.5 asks whether we should migrate long-lived commitments to SHA-512 for additional margin.

#### 2.11.1 What Grover Actually Buys an Attacker

The relevant attack against a hash-timelock vault is **preimage**: given `commitment = H(secret)`, find `secret`.

| Hash | Classical preimage | Quantum (Grover) preimage | Classical collision | Quantum (BHT) collision |
|------|-------------------|---------------------------|---------------------|-------------------------|
| SHA-256 (32 B) | 2^256 | 2^128 | 2^128 | ~2^85 |
| SHA-512 (64 B) | 2^512 | 2^256 | 2^256 | ~2^170 |
| SHA-384 (48 B) | 2^384 | 2^192 | 2^192 | ~2^128 |

**2^128 operations is already computationally unreachable.** At 10 billion GPUs × 10^10 hashes/sec, 2^128 SHA-256 evaluations would take ≈ 10^19 years — roughly a billion times the age of the universe. Doubling that exponent changes nothing operationally.

The only realistic threat model where SHA-512 gives meaningful benefit:
- **A structural improvement to Grover** that shaves a constant factor off the √N speedup (currently no known improvement; Grover is already proven optimal for unstructured search).
- **A future quantum algorithm** that outperforms Grover on hash preimages. None is currently known, and cryptanalysis history suggests if one is discovered it would likely break both SHA-256 *and* SHA-512 simultaneously rather than just shaving bits.

**Conclusion:** SHA-512 is *not* a practical security upgrade for any Protocol 01 commitment at present. It is a "deep paranoia" primitive for commitments intended to survive 30+ years in adversarial conditions.

#### 2.11.2 Cost of Migrating On-Chain State to SHA-512

| Cost dimension | SHA-256 (current) | SHA-512 (hypothetical) | Ratio |
|----------------|-------------------|------------------------|-------|
| On-chain verify CU | ~1,000 CU (SHA-256 syscall) | ~30,000–50,000 CU (software impl, no syscall) | **30–50×** |
| Stored digest size | 32 B | 64 B | 2× |
| Instruction data for reveal | 32 B preimage | 32 B preimage (same) | 1× |
| Backward compatibility | — | Requires v2 instruction variant + account migration | N/A |

Solana's `hashv` syscall accelerates SHA-256 to near-native speed. SHA-512 has no syscall — `sha2` crate software implementation costs roughly 30-50× more CU per hash (measured in similar on-chain programs). For a primitive that protects against a non-existent attack, this trade is unambiguously bad.

#### 2.11.3 Where SHA-512 Actually Does Help

Off-chain, in the SDK layer, SHA-512 is essentially free (client CPU time in the microsecond range). Contexts where it's a reasonable choice:

1. **Multi-decade commitment archives** — e.g., a treasury key's recovery commitment stored in multiple physical backups intended to outlast Protocol 01 itself. If the commitment will be retained for 30+ years and the preimage holds value throughout, the extra margin is cheap insurance.
2. **Hash-based signature pubkey hashes** *when the PK-hash is the cryptographic bottleneck*. Currently it is not — WOTS+ chain security (67 × SHA-256 chains, each providing ~2^128 PQ preimage) dominates the public-key-hash security (one SHA-256 of the concatenated chain tops, also ~2^128 PQ). Moving just the PK hash to SHA-512 would leave the chains as the weaker link.
3. **Client-side seed or wallet commitments** where the user wants the same margin the BIP39 standard already provides via HMAC-SHA512 — and where the commitment never goes on-chain.

#### 2.11.4 Deliverable: SDK Primitive, No On-Chain Change

P4.5 ships a **client-side SHA-512 commitment primitive** in `packages/specter-sdk/src/quantum/longTermCommit.ts`:

```typescript
import {
  generateLongTermSecret,
  computeLongTermCommitment,
  verifyLongTermCommitment,
  LONG_TERM_COMMIT_SIZE, // 64
  LONG_TERM_COMMIT_DOMAIN, // 'p01:long-term-commit-v1'
} from '@protocol01/specter-sdk';

const secret = generateLongTermSecret(); // 32-byte random preimage
const commitment = computeLongTermCommitment(secret, optionalSalt);
// commitment.length === 64, domain-separated SHA-512

const ok = verifyLongTermCommitment(commitment, secret, optionalSalt);
// constant-time check, rejects non-64-byte input
```

Key design choices:
- **Domain separation**: every input is prefixed with `'p01:long-term-commit-v1'` so that no SHA-512 computed elsewhere in the codebase (e.g., for Ed25519→X25519 conversion) can ever collide with or be mistaken for a long-term commitment.
- **Optional salt**: callers can derive many independent commitments from one master secret by varying the salt, without risking correlation attacks.
- **Constant-time verify**: `verifyLongTermCommitment` uses `constantTimeEqual` to avoid leaking bit-position information through timing.
- **Length validation**: `verifyLongTermCommitment` rejects commitments that are not exactly 64 bytes, so a 32-byte SHA-256 commitment can never be silently accepted as valid.

**No changes to `p01_quantum_vault`.** The existing 32-byte SHA-256 commitments continue to work exactly as before. A future v2 vault instruction could opt into 64-byte commitments if a specific product need emerges (e.g., a premium "century vault" tier); this is a deliberate non-goal for now.

**References specific to this section:**
- BIP39 (Bitcoin Improvement Proposal 39) — existing standard that already uses HMAC-SHA512 for multi-decade seed commitments
- NIST FIPS 180-4 — SHA-256 and SHA-512 specifications
- @noble/hashes `sha512` — audited reference implementation

---

## 3. Solana Ecosystem Quantum Readiness

### 3.1 Available Now (Mainnet)

| Feature | Description | Limitation |
|---------|------------|-----------|
| **Winternitz Vault** | Hash-based one-time signatures (Keccak256). PDA-based vault that signs once then must be closed/reopened. | One-time use per vault. Not a general-purpose signature scheme. |
| **alt_bn128 syscalls** | BN254 pairing operations. | Quantum-vulnerable (Shor), but needed until STARK syscalls exist. |
| **SHA-256 hashv syscall** | Hardware-accelerated SHA-256. | Already quantum-safe. Critical for future STARK verification. |

### 3.2 In Development

| Feature | Status | ETA | Impact on Protocol 01 |
|---------|--------|-----|----------------------|
| **SIMD-0296** (4KB transactions) | In review (Dec 2025) | 2026 H2 (est.) | Enables Dilithium signatures (2.5 KB) and larger stealth address announcements with ML-KEM ciphertexts (1 KB) |
| **Dilithium testnet** (Project Eleven) | Operational | Testnet now | Proves quantum-resistant signatures work at ~3,000 TPS |
| **STARK verification syscall** | Research prototype | 2027+ (est.) | Would enable native STARK verification at lower CU cost |
| **Poseidon syscall** | Planned | Unknown | Would enable on-chain Merkle root verification (fixes current trust issue) |

### 3.3 Not Yet Planned

| Feature | Need | Workaround |
|---------|------|-----------|
| ML-KEM (Kyber) precompile | Efficient on-chain KEM operations | Do key exchange off-chain, only store ciphertext on-chain |
| Lattice-based signature precompile | Native PQC signatures | Use Solana's eventual Dilithium support |
| STARK verifier precompile | Cheaper STARK verification | Use Winterfell with SHA-256 hashv syscall (~1.1M CU) |

---

## 4. HNDL Defense Strategy

### 4.1 What's Already Harvested (Cannot Be Fixed Retroactively)

| Data Type | On-Chain Location | HNDL Vulnerability |
|-----------|------------------|-------------------|
| Stealth ephemeral public keys (X25519) | Stealth payment PDAs, transaction logs | CRITICAL — future Shor attack reveals shared secrets |
| Wallet public keys (Ed25519) | Every transaction, account ownership | HIGH — future Shor attack reveals private keys |
| Groth16 proofs (BN254 points) | Transaction data | MEDIUM — proofs already verified, but forgery becomes possible |
| Poseidon commitments | Pool state PDAs | SAFE — hash-based, no ECDLP dependency |
| Nullifiers | Nullifier PDAs | SAFE — hash-based |
| Merkle roots | Pool state PDAs | SAFE — hash-based |

### 4.2 Defending New Data (Starting Now)

**Priority 1: Stealth Addresses (Protocol 01 can act independently)**
- Implement hybrid X25519 + ML-KEM key exchange
- New stealth payments will be quantum-resistant
- Old payments remain vulnerable (cannot be retroactively fixed)
- Users must be warned about this distinction

**Priority 2: Forward Secrecy Enhancement**
- Add per-transaction key rotation for viewing keys
- Ensure compromise of one viewing key doesn't expose all past payments
- Use HKDF with transaction-specific context for key derivation

**Priority 3: User Communication**
- Document that current stealth payments are not quantum-safe
- Provide a "quantum-safe migration" flow for high-value users
- Allow users to "re-shield" through a new quantum-safe stealth address

---

## 5. Implementation Roadmap

### Phase 0: Documentation & Preparation (NOW — Q2 2026)

**Effort:** Low | **Dependencies:** None | **UX Impact:** None

- [x] Complete cryptographic primitive inventory (this document)
- [x] Assess quantum resistance of each component
- [ ] Add quantum resistance warnings to user-facing documentation
- [ ] Add `QUANTUM_SAFE: boolean` flag to SDK types for each operation
- [ ] Create internal tracking for Solana PQC SIMDs and upgrades
- [ ] Benchmark @noble/post-quantum ML-KEM performance on mobile (React Native)
- [ ] Benchmark @noble/post-quantum ML-KEM performance in browser extension
- [ ] Research Winterfell/STARK circuit equivalents for current Circom circuits

### Phase 1: Stealth Address Hybrid Migration (Q3-Q4 2026)

**Status: ✓ SHIPPED (2026-04 — P4.1, P4.2, P4.3)**
**Effort:** Medium | **Dependencies:** @noble/post-quantum library | **UX Impact:** Minimal

Summary of what landed:
- `@noble/post-quantum` (ML-KEM-768) integrated into `packages/specter-sdk` and downstream apps
- Meta-address v2 format is the only accepted version (v1 rejected at SDK + on-chain layers)
- Hybrid shared secret = `HKDF(classic_ecdh || ml_kem_shared, info = "p01:stealth-hybrid-v1" || ephemeralPubKey || kemCiphertext)`; the transcript binding (P4.2) blocks mix-and-match attacks
- WOTS+ claim wrapper (P4.3) derives a per-payment hash-based signing keypair from the same stealth seed as the Ed25519 keypair, giving every new claim a post-quantum authentication path (the on-chain "both-sigs-valid" verifier is the next step — P4.6 roadmap)
- Stealth payment PDA fields expanded for `kem_ciphertext`; module-LWE-aware scanning path landed

The detail below describes the original design plan.

This is the highest-priority migration because:
1. Protocol 01 controls this fully (no Solana protocol dependency)
2. HNDL threat is already active for stealth addresses
3. ML-KEM libraries are mature and audited
4. Backward compatibility is achievable through hybrid approach

**Implementation plan:**

1. **Add ML-KEM dependency**
   - Install `@noble/post-quantum` (audited, by same author as @noble/hashes)
   - Add to `packages/specter-sdk/package.json` and `apps/*/package.json`

2. **Extend stealth meta-address format**
   ```
   Current meta-address: spending_pubkey (32B) || viewing_pubkey (32B) = 64 bytes

   New meta-address v2:
     version (1B) || spending_pubkey (32B) || viewing_pubkey_x25519 (32B) ||
     kem_pubkey_mlkem768 (1,184B) = 1,249 bytes
   ```
   - Version byte: 0x01 = classical only, 0x02 = hybrid
   - Backward compatible: v1 clients ignore the KEM pubkey

3. **Implement hybrid key exchange**
   ```typescript
   // packages/specter-sdk/src/stealth/derive.ts
   import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

   function deriveHybridSharedSecret(
     ephemeralX25519Secret: Uint8Array,
     recipientViewingPubX25519: Uint8Array,
     recipientKemPubKey: Uint8Array
   ): { sharedSecret: Uint8Array; kemCiphertext: Uint8Array } {
     // Classical ECDH
     const classicalSecret = nacl.scalarMult(ephemeralX25519Secret, recipientViewingPubX25519);

     // Post-quantum KEM
     const { cipherText, sharedSecret: pqSecret } = ml_kem768.encapsulate(recipientKemPubKey);

     // Combine with domain separation
     const combined = sha256(
       new Uint8Array([...classicalSecret, ...pqSecret,
         ...new TextEncoder().encode('protocol01-hybrid-v1')])
     );

     return { sharedSecret: combined, kemCiphertext: cipherText };
   }
   ```

4. **Update on-chain stealth payment PDA**
   ```rust
   // programs/specter/src/state/stealth.rs
   pub struct StealthPayment {
       pub recipient_key: Pubkey,          // 32 bytes
       pub encrypted_amount: [u8; 32],     // 32 bytes
       pub token_mint: Pubkey,             // 32 bytes
       pub ephemeral_pub_key: [u8; 32],    // 32 bytes (X25519, kept for backward compat)
       pub kem_ciphertext: Vec<u8>,        // ~1,088 bytes (ML-KEM-768)
       pub view_tag: u8,                   // 1 byte
       pub version: u8,                    // 1 byte (0x01=classical, 0x02=hybrid)
       pub slot: u64,                      // 8 bytes
   }
   // Total: ~1,268 bytes (was ~105 bytes)
   ```

5. **Update scanning (recipient side)**
   - For v2 announcements: use hybrid decapsulation
   - For v1 announcements: use classical X25519 only (backward compatible)
   - Module-LWE scanning is 66.8% faster than ECDH scanning (per academic benchmarks)

6. **Unify the three stealth implementations**
   - Currently: extension, specter-sdk, and relayer each have different implementations
   - Target: single implementation in `packages/specter-sdk/src/stealth/` used by all
   - Fix the incorrect EC math in specter-sdk (XOR instead of point addition)

**Estimated data size impact:**
- Stealth payment PDA: 105 → ~1,268 bytes (+1,163 bytes, ~$0.009 rent at current SOL prices)
- Transaction size: fits within current 1,232-byte limit if ML-KEM ciphertext is stored in a separate instruction

### Phase 2: ZK Proof System Preparation (Q1-Q2 2027)

**Status: ✓ SHIPPED EARLY (2026-03/04 — P2, P3 workstreams).** Original Q1-Q2 2027 target beaten by ~9 months.
**Effort:** High | **Dependencies:** STARK library maturity | **UX Impact:** None (backend change)

1. **Research STARK circuit equivalents**
   - Map each Circom circuit to Winterfell AIR (Algebraic Intermediate Representation)
   - `denominated_pool.circom` (4,273 constraints) → STARK AIR
   - `confidential_balance.circom` (1,382 constraints) → STARK AIR
   - `balance_proof.circom` (644 constraints) → STARK AIR

2. **Implement hybrid proof generation**
   - Generate both Groth16 (for on-chain verification) and STARK (for quantum safety)
   - Store STARK proof off-chain (IPFS or Arweave) as backup
   - When Solana supports STARK verification: switch to on-chain STARKs

3. **Benchmark Winterfell on Solana**
   - Adapt the ePrint 2025/1741 research prototype
   - Measure real CU costs for Protocol 01's specific circuits
   - Ensure it fits within 1.4M CU budget (research shows 1.1M CU is achievable)

### Phase 3: Proof System Migration (Q3 2027 — Q2 2028)

**Status: ✓ SHIPPED EARLY (2026-03/04 — P3.1-P3.7).** Original Q3 2027-Q2 2028 target beaten by ~16-22 months. On-chain STARK verification is now the default and only path for all 7 shielded-pool instructions. Groth16 verifier and VK storage removed in P3.7.
**Effort:** Very High | **Dependencies:** Solana STARK support | **UX Impact:** Proof generation time may increase

1. **Deploy STARK verifier on Solana**
   - Use Winterfell verifier compiled for BPF/SBF
   - SHA-256 hashv syscall for performance
   - Custom bump allocator for memory management

2. **Migration path:**
   ```
   Week 1-4: Deploy STARK verifier alongside Groth16 verifier
   Week 5-8: Generate both proof types, verify both on-chain
   Week 9-12: Switch default to STARK verification
   Week 13+: Deprecate Groth16 verifier (keep for legacy proofs)
   ```

3. **Handle the trusted setup legacy:**
   - STARKs require NO trusted setup (transparent!)
   - This eliminates the Phase 2 ceremony concern entirely
   - All future pool deployments use STARKs — no ceremony needed

### Phase 4: Full Quantum-Safe Stack (2028+)

**Status (2026-04-17): IN PROGRESS — sub-items 4.1–4.5 shipped; 4.6 is the next on-chain delivery.** Sub-items below renumbered to match the task tracker.

**Effort:** Medium | **Dependencies:** Solana Dilithium mainnet | **UX Impact:** Wallet migration needed

**Sub-item tracker:**

| Sub | Title | Status | Notes |
|-----|-------|--------|-------|
| 4.1 | Force v2 hybrid stealth everywhere (refuse v1) | ✓ Shipped (2026-04) | SDK + on-chain refuse v1 announcements |
| 4.2 | HKDF info binding enrichment | ✓ Shipped (2026-04) | `ephemeralPubKey \|\| kemCiphertext` mixed into info |
| 4.3 | Stealth spending key WOTS+ wrapping | ✓ Shipped (2026-04) | SDK primitive; on-chain verifier = 4.6 |
| 4.4 | SPHINCS+ (SLH-DSA) evaluation | ✓ Evaluated → **DEFER** (2026-04) | See §2.10 for rationale |
| 4.5 | SHA-512 for long-term commit hashes | ✓ Shipped as SDK primitive (2026-04) | See §2.11; no on-chain change |
| 4.6 | On-chain verifier enforcing Ed25519 + WOTS+ claim proofs | **Pending** | Next post-quantum on-chain delivery |
| 4.7 | Wallet signature migration (Solana Dilithium) | Blocked on Solana | Monitor Project Eleven mainnet roadmap |
| 4.8 | Drop classical-only support once 80% ecosystem adoption | Pending | Coupled to 4.7 |
| 4.9 | Post-migration security audit | Pending | After 4.6 + 4.7 |

**Legacy plan (retained for reference):**

1. **Wallet signature migration**
   - When Solana deploys Dilithium (ML-DSA) on mainnet:
     - Support hybrid Ed25519 + Dilithium keypairs
     - Users generate new quantum-safe wallet
     - Migrate funds from old wallet to new wallet
   - SIMD-0296 (4KB transactions) required for Dilithium signatures

2. **Drop classical-only support**
   - When sufficient ecosystem adoption (~80%): deprecate v1 stealth addresses
   - Convert all stealth announcements to pure ML-KEM (drop X25519)
   - Drop Groth16 verifier (STARK only) — **done in P3.7 (2026-04)**

3. **Post-migration security audit**
   - Full review of quantum-safe stack
   - Verify no residual classical dependencies
   - Penetration testing with simulated quantum oracle

### 5.5 Implementation Status Snapshot (2026-04-17)

**What an attacker with a Cryptographically Relevant Quantum Computer can do today against Protocol 01:**

| Attack surface | Feasible with CRQC alone? | What else they'd need |
|----------------|---------------------------|------------------------|
| Derive any user's Ed25519 private key from on-chain public key | **Yes** | — (Solana-level issue) |
| Read the contents of a post-P4.1 stealth announcement | **No** | Also break ML-KEM-768 (Module-LWE), OR break SHA-256 HKDF info binding |
| Read the contents of a pre-P4.1 (legacy) stealth announcement | **Yes** | Data is on-chain; HNDL-harvestable — cannot be retroactively fixed |
| Forge a STARK proof to steal shielded-pool funds | **No** | Also break SHA-256 collision resistance (hash-only assumptions) |
| Forge a Groth16 proof (historical) | No production path exists | Groth16 verifier removed in P3.7 |
| Forge a stealth claim signature (post-P4.6) | **No** | Also break either SHA-256 preimage (WOTS+ half) OR Ed25519 (classical half) — but only when on-chain "both-sigs-valid" verifier ships |
| Forge a stealth claim signature (today, before P4.6) | **Yes via Ed25519** | SDK emits WOTS+ proofs but on-chain enforcement is pending P4.6 |
| Open a Pedersen commitment (in `p01-js`) | **Yes** | — but these commitments are NOT used in production circuits (kept for SDK compatibility) |

**What the client SDK exposes to app developers as of 2026-04-17:**

```typescript
// Post-quantum stealth addresses (v2 mandatory)
import {
  generateStealthMetaAddress, // v2 with ML-KEM pubkey
  generateStealthAddress,      // emits kemCiphertext + ephemeralPubKey
  createStealthAnnouncement,   // on-chain encoding
  verifyStealthOwnership,      // hybrid decapsulation path
  createScanner,               // scans with KEM secret key
} from '@protocol01/specter-sdk';

// Post-quantum claim proofs (P4.3)
import {
  deriveStealthWotsFromRecipient, // per-payment WOTS+ keypair
  buildClaimProofPQ,              // sign (stealth, ephemeral, spending, destination)
  verifyClaimProofPQ,             // offline sanity check
} from '@protocol01/specter-sdk';

// Post-quantum authorization primitives
import {
  generateWotsKeypair, wotsSign, wotsVerify, // general-purpose WOTS+
  computeHashVaultCommitment,                 // SHA-256 vault (default)
  computeLongTermCommitment,                  // SHA-512 vault (P4.5, opt-in)
} from '@protocol01/specter-sdk';

// Hybrid-KEM utilities
import {
  kemGenerateKeypair, kemEncapsulate, kemDecapsulate,
  deriveHybridSharedSecret, // P4.2 transcript-bound HKDF
} from '@protocol01/specter-sdk';
```

**Dependency on Solana L1 PQC roadmap:**
- Ed25519 wallet signatures remain the only residual classical-ECDLP dependency Protocol 01 exposes to users. Everything else is either hash-based (SAFE), lattice-based (SAFE under Module-LWE), or hybrid (SAFE unless BOTH halves fall).
- The realistic unlock is Solana's Dilithium (ML-DSA) mainnet deployment. Project Eleven demonstrated feasibility in Dec 2025; SIMD-0296 (4KB transactions) is the blocker. No mainnet timeline yet.
- **Until Solana ships Dilithium**, users should treat Protocol 01's quantum resistance as: "all *new* stealth payments and all proof-system operations are post-quantum safe, *but* the wallet key that authorizes these operations is Ed25519 and will remain classical-vulnerable until the base layer upgrades."

---

## 6. Implementation Considerations for Solana

### 6.1 Transaction Size Constraints

| Operation | Current Size | With Hybrid PQC | With SIMD-0296 (4KB) |
|-----------|-------------|-----------------|---------------------|
| Stealth payment (shield) | ~400 bytes | ~1,500 bytes | Fits (4,096 bytes) |
| Stealth payment (announcement) | ~34 bytes | ~1,122 bytes | Fits |
| Groth16 proof verification | ~450 bytes | Same | Same |
| STARK proof verification | N/A | ~4,437+ bytes | Fits (4,096 bytes) |
| Dilithium signature | N/A | ~2,560 bytes | Fits |

**Before SIMD-0296:** Split large operations into multiple transactions or use account-based storage (PDAs) for large data like KEM ciphertexts and STARK proofs.

**After SIMD-0296:** Most operations fit in a single transaction.

### 6.2 Compute Unit Budget

| Operation | CU Cost | Budget (1.4M) |
|-----------|---------|---------------|
| Groth16 verification (current) | ~200K | 14% |
| STARK verification (Winterfell) | ~1.1M | 79% |
| SLH-DSA signature verification | ~500K | 36% |
| ML-KEM encapsulation | ~50K (est.) | 4% |
| ML-KEM decapsulation | ~50K (est.) | 4% |

**Note:** STARK + SLH-DSA combined (~1.6M CU) exceeds the 1.4M budget. Options:
1. Use two transactions (STARK verify + signature verify)
2. Wait for Solana CU budget increase
3. Use recursive STARK compression to reduce proof size

### 6.3 Account Storage Costs

| Account | Current Size | With PQC | Rent Cost (SOL) |
|---------|-------------|----------|-----------------|
| Stealth payment PDA | ~105 bytes | ~1,268 bytes | ~0.009 SOL |
| Stealth meta-address | ~64 bytes | ~1,249 bytes | ~0.009 SOL |
| STARK proof storage (if needed) | 0 | ~4,437 bytes | ~0.033 SOL |
| Verification key (STARK) | 0 | ~10,000 bytes | ~0.075 SOL |

Total additional cost per stealth payment: ~0.009 SOL (~$1.35 at $150/SOL). This is acceptable for privacy-preserving payments.

---

## 7. Risk Assessment

### 7.1 Risk of NOT Migrating

| Risk | Probability (10yr) | Impact | Mitigation |
|------|-------------------|--------|-----------|
| HNDL de-anonymization of stealth payments | HIGH (recording likely happening now) | CRITICAL — full history exposed | Hybrid stealth addresses (Phase 1) |
| Groth16 proof forgery | LOW-MEDIUM (CRQC 10-20 years) | CRITICAL — fund theft, inflation | STARK migration (Phase 2-3) |
| Ed25519 key theft | LOW-MEDIUM (CRQC 10-20 years) | CRITICAL — all wallet funds stolen | Depends on Solana (Phase 4) |

### 7.2 Risk of Migrating Too Aggressively

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| PQC algorithm broken classically | LOW (NIST-standardized) | HIGH | Hybrid approach (classical + PQ) |
| Performance degradation (larger proofs) | MEDIUM | MEDIUM | Benchmark before deployment |
| User confusion (new key types) | MEDIUM | LOW | Clear UX, automatic migration |
| Increased transaction costs | HIGH | LOW | ~$0.01/tx increase is acceptable |

### 7.3 What We Can Control vs. What We Can't

| We Control | We Don't Control |
|-----------|-----------------|
| Stealth address key exchange protocol | Solana wallet signature scheme |
| Proof system choice (Groth16 vs STARK) | Solana alt_bn128 syscall availability |
| On-chain data formats (PDA structures) | Solana transaction size limits |
| Client-side encryption algorithms | Solana CU budget |
| SDK and circuit implementation | When CRQC arrives |

---

## 8. References

### Standards
- NIST FIPS 203: ML-KEM (Kyber) — Module-Lattice-Based Key-Encapsulation Mechanism (Aug 2024)
- NIST FIPS 204: ML-DSA (Dilithium) — Module-Lattice-Based Digital Signature Algorithm (Aug 2024)
- NIST FIPS 205: SLH-DSA (SPHINCS+) — Stateless Hash-Based Digital Signature Algorithm (Aug 2024)
- NSA CNSA 2.0: Commercial National Security Algorithm Suite 2.0 (2022, updated 2024)

### Solana-Specific
- Helius: "What Would Solana Need to Change to Become Quantum Ready?" (2025)
- SIMD-0296: Larger Transaction Size (in review, Dec 2025)
- Project Eleven: Solana Dilithium Testnet (Dec 2025)
- Dean Little: Solana Winternitz Vault (Jan 2025)
- ePrint 2025/1741: "Full L1 On-Chain ZK-STARK+PQC Verification on Solana: A Measurement Study" (2025)

### Post-Quantum Stealth Addresses
- ePrint 2025/112: "Post-Quantum Stealth Address Protocols" — LWE, Ring-LWE, Module-LWE SAPs
- Module-LWE SAP scanning: 66.8% faster than ECDH-based protocols (ECPDKSAP)

### Libraries
- @noble/post-quantum: Audited ML-KEM/ML-DSA implementation (Paul Miller)
- Winterfell: STARK prover/verifier in Rust (Meta/Facebook)
- mlkem: FIPS 203 compliant TypeScript ML-KEM

### Threat Intelligence
- Federal Reserve FEDS 2025-093: "Harvest Now Decrypt Later: Examining Post-Quantum Cryptography and the Data Privacy Risks for Distributed Ledger Networks" (Oct 2025)
- EU PQC Roadmap: Coordinated Implementation Roadmap for Post-Quantum Cryptography Transition (2025)

---

*This document should be updated quarterly as the quantum computing landscape, Solana ecosystem, and PQC standards evolve. The next scheduled review is 2026-07 (Q3). Trigger an earlier review if: (a) Solana publishes a Dilithium mainnet roadmap or SIMD-0296 is accepted, (b) NIST publishes new PQC standards or deprecates an existing one, (c) Protocol 01 ships a new on-chain primitive that exposes fresh cryptographic assumptions (e.g., the P4.6 on-chain WOTS+ claim verifier).*
