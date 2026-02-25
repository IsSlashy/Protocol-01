# Protocol 01 -- Security Model

**Document version:** 1.0
**Date:** 2026-02-25
**Status:** Pre-audit preparation

---

## 1. Architecture de securite

```
                            TRUST BOUNDARY A (user device)
  +---------------------------------------------------------------------------+
  |                                                                           |
  |   User Wallet (mobile / extension)                                        |
  |     - Generates secret, nullifier_preimage, salt                          |
  |     - Computes commitment = Poseidon(nullifier_preimage, secret,          |
  |                              deposit_epoch, token_mint)                    |
  |     - Generates ZK proof (Groth16) via snarkjs or relayer                 |
  |     - Holds private state: notes, salts, spending keys                    |
  |                                                                           |
  +-----------+---------------------------------------------------------------+
              |
              | (1) proof + public inputs    (3) proof request
              | OR commitment + new_root         (circuit inputs)
              v                                     v
  +-----------+-------------------------------------+-------------------------+
  |                   TRUST BOUNDARY B (relayer)                              |
  |                                                                           |
  |   Relayer Service (services/relayer)                                      |
  |     - Receives proof requests, generates proofs (Rust prover or snarkjs)  |
  |     - Verifies proofs off-chain (snarkjs) before submission               |
  |     - Submits transactions on behalf of users (gas abstraction)           |
  |     - Indexes commitments for tree synchronization (WebSocket)            |
  |     - Sees: public inputs, recipient stealth address, timing              |
  |     - Cannot see: secret, nullifier_preimage, actual balances             |
  |                                                                           |
  +-----------+---------------------------------------------------------------+
              |
              | (2) Solana transaction with proof + public inputs
              v
  +-----------+---------------------------------------------------------------+
  |                   TRUST BOUNDARY C (Solana blockchain)                    |
  |                                                                           |
  |   On-chain Programs (zk_shielded / p01_zkspl)                            |
  |     - Groth16 verification via alt_bn128 precompile syscalls              |
  |     - Merkle tree root validation (historical roots)                      |
  |     - Double-spend prevention:                                            |
  |         * Denominated pool: PDA-per-nullifier (zero false positives)      |
  |         * Legacy pool: Bloom filter (probabilistic)                       |
  |     - Token custody: PDA-controlled vaults                                |
  |     - Epoch delay enforcement (anti-timing-correlation)                   |
  |                                                                           |
  |   Visibility: proof, public inputs, recipient address,                    |
  |               commitment, new_root, nullifier, token_mint                 |
  |                                                                           |
  +---+--+----+------+------+------------------------------------------------+
      |  |    |      |      |
      |  |    |      |      +-- alt_bn128 syscalls (addition, scalar mul, pairing)
      |  |    |      +-- Merkle tree state (PDA)
      |  |    +-- Pool state (PDA with historical roots)
      |  +-- Nullifier records (PDA-per-nullifier)
      +-- Token vaults (PDA-controlled)
```

### Data Flow: Shield (Deposit)

```
User                    Relayer                 On-chain
  |                       |                       |
  |-- commitment + root ->|                       |
  |                       |-- shield_denominated->|
  |                       |   (commitment,        |
  |                       |    new_root,           |
  |                       |    denomination SOL)   |
  |                       |                       |-- insert commitment
  |                       |                       |-- transfer SOL to pool
  |                       |                       |-- update merkle root
  |                       |                       |-- record deposit epoch
```

### Data Flow: Unshield (Withdrawal)

```
User                    Relayer                 On-chain
  |                       |                       |
  |-- proof request ----->|                       |
  |   (circuit inputs)    |                       |
  |                       |-- generate proof      |
  |                       |-- verify proof        |
  |                       |                       |
  |<-- proof + signals ---|                       |
  |                       |                       |
  |-- unshield tx ------->|                       |
  |   OR via relayer      |-- unshield_denom ---->|
  |                       |   (proof, nullifier,  |
  |                       |    merkle_root,        |
  |                       |    min_epoch)          |
  |                       |                       |-- verify ZK proof (alt_bn128)
  |                       |                       |-- check nullifier not spent
  |                       |                       |-- init nullifier PDA (atomically)
  |                       |                       |-- check epoch delay
  |                       |                       |-- transfer SOL to recipient
```

---

## 2. Trust Assumptions

### 2.1 Powers of Tau Ceremony (Phase 1)

- **Source:** Hermez Phase 1 Powers of Tau (`pot20_final.ptau`)
- **Participants:** 176 participants from the Hermez community ceremony
- **Security property:** 1-of-N honest assumption -- if at least one participant
  destroyed their toxic waste, the setup is secure
- **Max constraint support:** 2^20 = 1,048,576 constraints (sufficient for all
  circuits; largest is ~5,500 for transfer depth 20)
- **Risk:** LOW -- well-known, widely used ceremony. Same ptau used by hundreds
  of production protocols (Tornado Cash, Semaphore, etc.)

### 2.2 Circuit-Specific Phase 2 Setup

- **Performed by:** Single developer (project team)
- **Method:** `snarkjs zkey contribute` + `snarkjs zkey beacon`
- **Beacon value:** Hardcoded `0102030405...1f` with 10 iterations
- **Reproducibility:** YES -- scripts in `circuits/package.json` can reproduce
  from ptau + compiled R1CS
- **Risk:** MEDIUM -- Single-contributor phase 2 means the contributor could
  forge proofs if they retained the toxic waste. For mainnet, a multi-party
  phase 2 ceremony is required.
- **Mitigation:** Beacon finalization adds randomness, but a dedicated ceremony
  with 3+ contributors is strongly recommended before mainnet.

### 2.3 Relayer Centralization

- **Architecture:** Single relayer instance (Railway deployment)
- **Knows:** Public inputs (merkle_root, nullifier, min_epoch, token_mint),
  recipient address, timing of requests, IP addresses
- **Cannot know:** Secret, nullifier_preimage, actual balances (private inputs)
- **Powers:**
  - Can censor transactions (refuse to relay)
  - Can log metadata (timing, IP, public inputs)
  - Can correlate deposit/withdrawal timing
  - Can front-run (if it learns the proof, submit its own transaction first --
    but this only steals gas payment, not funds, since proof is bound to
    specific public inputs)
- **Cannot:**
  - Forge proofs (does not know private inputs)
  - Steal funds (proof is bound to recipient via public inputs)
  - Double-spend (nullifier check is on-chain)
- **Risk:** MEDIUM -- censorship and metadata leakage
- **Mitigation:** Users can submit directly to Solana without the relayer;
  multiple relayers can be run permissionlessly.

### 2.4 Client-Side Proving

- **Model:** User's device generates the ZK proof (or delegates to relayer)
- **Trust:** User must trust their device/app is not compromised
- **Risk when delegating to relayer:** The circuit inputs (including spending_key,
  secret, nullifier_preimage) are sent to the relayer for proof generation. The
  relayer could theoretically extract and store these secrets.
- **Risk:** HIGH for relayer-delegated proving -- secrets are exposed to relayer
- **Mitigation:** Client-side proving preferred; relayer proving should only be
  used when users understand the trust tradeoff. Long-term: use MPC or trusted
  hardware for relayer proving.

### 2.5 Solana Validators (Consensus Layer)

- **Data availability:** All transaction data is public on-chain. Commitments,
  nullifiers, public inputs are visible to all validators.
- **Consensus:** Standard Solana PoS/PoH. A supermajority attack could revert
  transactions but cannot forge ZK proofs.
- **MEV:** Validators can reorder transactions. This could:
  - Front-run a withdrawal by inserting their own (but they need a valid proof)
  - Delay transactions to affect epoch timing
  - Sandwich attack is not applicable (fixed denomination, no price impact)
- **Censorship:** Validators can censor specific transactions (temporary, until
  the next leader slot)
- **Risk:** LOW -- standard Solana trust model applies

### 2.6 Cryptographic Dependencies

- **snarkjs (v0.7.4-0.7.6):** JavaScript Groth16 prover/verifier. Widely used,
  but no formal audit. Used both client-side and in relayer.
- **circomlibjs (v0.1.7):** Poseidon hash implementation for JavaScript.
  Implements the reference Poseidon specification.
- **circomlib (v2.0.5):** Circuit library (Poseidon, MiMC, comparators, etc.)
  Used in all circuits.
- **@noble/hashes (v1.3.3):** Audited cryptographic hash library by Paul Miller.
  Used for non-ZK hashing.
- **ark-circom (v0.5.0):** Rust Groth16 prover using arkworks. Critical:
  requires `CircomReduction` for circom >= 2.0.7 compatibility.
- **poseidon-lite (v0.2.0):** Lightweight Poseidon implementation for SDKs.
- **Risk:** MEDIUM -- these libraries are widely used but most lack formal audits.
  The `CircomReduction` requirement was a known footgun that caused invalid proofs
  before being identified.

### 2.7 alt_bn128 Precompile Correctness

- **Implementation:** Solana's built-in alt_bn128 syscalls (`solana-bn254` crate)
- **Operations used:** G1 addition, G1 scalar multiplication, pairing check
- **Trust:** Solana Labs maintains the implementation. It is equivalent to
  Ethereum's EIP-196/197 precompiles.
- **Risk:** LOW -- the precompile is well-tested and matches Ethereum's
  battle-tested implementation.

### 2.8 Client-Computed Merkle Roots

- **Context:** Solana does not yet have the Poseidon syscall on devnet/mainnet.
  Therefore, Merkle tree updates are computed off-chain by the client and the
  new root is accepted by the program (`insert_with_root`).
- **Trust:** The client provides the correct new_root after inserting a
  commitment. The program does NOT verify the root computation.
- **Risk:** HIGH -- a malicious client could provide an incorrect root, which
  would make subsequent Merkle proofs fail for honest users. However, this does
  NOT enable fund theft (proofs against the incorrect root would fail).
- **Impact:** Griefing attack -- a malicious depositor could submit a wrong root,
  breaking the pool's Merkle tree for all users.
- **Mitigation:** When the Poseidon syscall becomes available, on-chain root
  computation should be implemented immediately.

---

## 3. Threat Model

### 3.1 Adversary: On-Chain Observer

**Goal:** De-anonymize users by correlating deposits and withdrawals.

**Capabilities:**
- Full access to all on-chain data (commitments, nullifiers, roots, timestamps)
- Can monitor all pool events in real-time
- Can build a transaction graph

**Attack vectors:**

| Vector | Severity | Mitigation | Residual Risk |
|--------|----------|-----------|---------------|
| Timing correlation: unique deposit amount matches unique withdrawal | N/A (denominated pool) | Fixed denomination -- all deposits identical | LOW: eliminated for denominated pools |
| Timing correlation: deposit shortly before withdrawal | MEDIUM | `deposit_epoch` rounds to ~1h windows; dynamic delay (6-24h for small pools) | MEDIUM: epoch granularity leaks some timing info |
| Anonymity set analysis: small pool has few depositors | HIGH | Dynamic delay increases wait time for small pools (24h for < 10 mature notes) | HIGH: at launch, pool may have very few notes |
| Address reuse: same recipient used for multiple withdrawals | MEDIUM | Stealth addresses break recipient linking | LOW if stealth addresses are used |
| Amount pattern for zkSPL (confidential balances) | MEDIUM | Amounts are hidden in commitments; only public_credit/debit visible | LOW: only deposit/withdraw amounts are visible |
| Transaction graph: unique deposit epoch + withdrawal epoch | MEDIUM | Multiple depositors share the same epoch (7200 slot window) | MEDIUM: depends on deposit frequency |

### 3.2 Adversary: Malicious Relayer

**Goal:** Identify users, censor transactions, or extract value.

**Capabilities:**
- Sees all proof requests (public inputs and, if proof generation is delegated,
  private inputs)
- Sees IP addresses, timing, request patterns
- Controls transaction submission order and timing

**Attack vectors:**

| Vector | Severity | Mitigation | Residual Risk |
|--------|----------|-----------|---------------|
| Metadata logging: correlate IP + timing + public inputs | HIGH | None in current architecture | HIGH: relayer knows who is withdrawing and when |
| Censorship: refuse to relay certain transactions | MEDIUM | Users can submit directly to Solana; permissionless relaying | LOW if users can bypass relayer |
| Front-running: see proof, submit own transaction | LOW | Proof is bound to specific public inputs; relayer gains nothing | LOW |
| Private input extraction (delegated proving) | CRITICAL | User trusts relayer with spending_key when delegating | CRITICAL: relayer could steal all funds if it saves secrets |
| Timing manipulation: delay relay to worsen timing correlation | MEDIUM | Users can detect delays and resubmit | MEDIUM |
| Fee extraction: overcharge gas fees | LOW | Fee is transparent and configurable | LOW |

### 3.3 Adversary: Circuit Attacker

**Goal:** Forge proofs to steal funds or double-spend.

**Analysis per circuit:**

#### denominated_pool.circom (115 LOC, depth 15)

| Constraint | Purpose | Security |
|-----------|---------|----------|
| `commitHasher.out === commitment` | Commitment matches private inputs | SOUND: Poseidon collision resistance |
| `nullHasher.out === nullifier` | Nullifier matches (prevents spending others' notes) | SOUND: deterministic, checked on-chain |
| `merkleChecker.computedRoot === merkle_root` | Note exists in pool | SOUND: standard Merkle proof |
| `rangeCheck(min_epoch - deposit_epoch)` | Time delay enforced | SOUND: Num2Bits(40) fails for negative field elements |
| `pathIndices[i] * (1 - pathIndices[i]) === 0` (in merkle.circom) | Binary path indices | SOUND: standard binary constraint |
| Public inputs: `merkle_root, nullifier, min_epoch, token_mint` | All binding | SOUND: token_mint in both commitment and public input |

**Potential concerns:**
- `token_mint` is a public input AND included in the commitment hash. This
  correctly binds the note to a specific token. VERIFIED SOUND.
- `nullifier = Poseidon(nullifier_preimage, secret)` does NOT include the
  commitment. This is acceptable because the (nullifier_preimage, secret) pair
  uniquely determines both the nullifier and the commitment. Two different
  commitments with the same nullifier would require a Poseidon collision.
- `deposit_epoch` is private. The prover could claim a falsely old epoch, but
  the commitment would not match any on-chain commitment (since the real epoch
  is baked into the commitment at deposit time).

#### transfer.circom (188 LOC, depth 20)

| Issue | Severity | Status |
|-------|----------|--------|
| `output_commitment_1` and `output_commitment_2` are public inputs checked against computed values | SOUND | Verified |
| Value conservation: `in_amount_1 + in_amount_2 + public_amount === out_amount_1 + out_amount_2` | SOUND | Verified |
| Range proofs on all amounts (64-bit) | SOUND | Prevents field overflow |
| Dummy note handling: `amount=0` skips Merkle/ownership check | CONCERN | See below |
| `SpendingKeyDerivation` and `SpendingKeyHash` both hash `Poseidon(spending_key)` | REDUNDANT | Same computation, different templates |

**Known concern -- dummy notes with amount=0:**
- A dummy note with `amount=0` bypasses both Merkle proof and ownership checks.
- The conservation law still holds (`0 + 0 + public_amount === out1 + out2`).
- This is by design (allows 1-in-2-out transactions) but should be documented.
- An attacker CANNOT exploit this to create value because the range proofs and
  conservation law are still enforced.

**Known concern -- no explicit check that `nullifier_1 != nullifier_2`:**
- Both nullifiers could be the same, which would attempt to spend the same note
  twice. However, on-chain the nullifier check (Bloom filter for legacy pool)
  would catch this. For PDA-per-nullifier pools, the second `init` would fail.
- Recommendation: Add explicit `nullifier_1 !== nullifier_2` constraint in circuit.

#### confidential_balance.circom (364 LOC)

| Constraint | Purpose | Security |
|-----------|---------|----------|
| `oldCommCheck.commitment === old_commitment` | Prover knows real balance | SOUND |
| `newCommCheck.commitment === new_commitment` | New commitment correctly formed | SOUND |
| `amountCommCheck.commitment === amount_hash` | Amount commitment links sender/recipient | SOUND |
| `is_debit * (1 - is_debit) === 0` | Binary direction flag | SOUND |
| Conservation law (6 terms) | No inflation/deflation | SOUND |
| Range proofs: new_balance, old_balance, amount, public_credit, public_debit | Prevent overflow | SOUND |

**Verified sound.** The `nonce` is a public input that prevents replay attacks.
The `owner_pubkey` is derived from `spending_key` and embedded in both commitments,
proving ownership.

#### balance_proof.circom (157 LOC)

| Constraint | Purpose | Security |
|-----------|---------|----------|
| `commCheck.commitment === balance_commitment` | Prover knows real balance | SOUND |
| `rangeCheck(balance - threshold)` | balance >= threshold | SOUND |
| `rangeCheckBalance(balance)` | balance < 2^64 | SOUND |

**Verified sound.** Simple and well-constrained.

### 3.4 Adversary: Colluding Validators

**Goal:** Disrupt protocol operation or extract value.

**Capabilities:**
- Reorder transactions within a block
- Temporarily censor transactions (until next leader)
- Withhold blocks (liveness failure)
- See all transaction data before inclusion

**Attack vectors:**

| Vector | Severity | Impact |
|--------|----------|--------|
| Reorder deposit before withdrawal | LOW | No benefit -- proof verification is deterministic |
| Censor specific nullifiers | LOW | Temporary -- user can retry with different leader |
| Sandwich attack | N/A | Fixed denomination -- no price impact |
| Data withholding (for tree sync) | LOW | Temporary -- data is replicated across validators |
| Eclipse attack on relayer | MEDIUM | Relayer could see stale state; mitigated by commitment indexer |

---

## 4. Known Limitations

### 4.1 Small Anonymity Set at Launch

The anonymity set is the number of indistinguishable notes in a pool. At launch,
with few users, the anonymity set will be small (potentially < 10 notes). This
means withdrawals can be correlated with recent deposits with high probability.

**Current mitigation:** Dynamic delay forces longer waits for small pools (24
epochs / ~24 hours when < 10 mature notes). This gives time for more deposits
to accumulate.

**Recommendation:** Consider seeding pools with protocol-owned deposits to
bootstrap the anonymity set.

### 4.2 Residual Timing Correlation

Even with epoch-based timing (1-hour windows), an observer can narrow the
deposit window for a withdrawal. If only one deposit occurred in a given epoch,
the correlation is 1:1.

**Recommendation:** Encourage users to deposit well before they intend to
withdraw. Consider longer epoch sizes (e.g., 6 hours).

### 4.3 Relayer Knows Liquidity Provider Identity

When proof generation is delegated to the relayer, the relayer receives the full
circuit inputs including the spending key. This is equivalent to handing the
relayer full custody of the shielded note.

**Recommendation:** Implement client-side proving as the default. If relayer
proving is necessary, explore MPC-based proving or TEE (Trusted Execution
Environment) solutions.

### 4.4 Groth16 Not Quantum-Resistant

Groth16 proofs rely on elliptic curve pairings (BN254). Shor's algorithm on a
quantum computer could break these assumptions, allowing proof forgery.

**Note:** The Poseidon-based commitments in zkSPL are quantum-resistant (they
rely on algebraic hash security, not elliptic curves). Only the proof system
would need migration (to STARKs or lattice-based SNARKs).

**Timeline risk:** Current estimates suggest large-scale quantum computers are
10-20 years away. Groth16 is adequate for current deployment.

### 4.5 Epoch-Based Delay Granularity

`deposit_epoch = slot / 7200` (~1 hour) provides coarse timing. Within a single
epoch, all deposits share the same `deposit_epoch` value. However, the actual
slot of the deposit transaction is still visible on-chain, giving finer-grained
timing to an observer.

**Recommendation:** The circuit's epoch check is sound, but observers can still
use on-chain slot data. Consider documenting this distinction clearly for users.

### 4.6 Single Relayer as Single Point of Failure

The current architecture has one relayer. If it goes offline:
- Users cannot generate proofs server-side
- Gas abstraction is unavailable
- Commitment indexer stops updating

**Mitigation:** Users can interact directly with on-chain programs. The protocol
is permissionless -- anyone can run a relayer.

### 4.7 Client-Computed Merkle Roots (Pre-Poseidon Syscall)

Since the Poseidon syscall is not yet available on Solana, Merkle tree updates
are computed off-chain and accepted by the program without on-chain verification.
A malicious depositor could submit a wrong root, corrupting the tree for all
users of that pool.

**Impact:** Griefing only -- no fund theft, but pool becomes unusable until
remediated.

**Mitigation:** Implement on-chain root computation as soon as the Poseidon
syscall is enabled. Consider adding a verified insertion path using the
alt_bn128 precompile (though this would be expensive in compute units).

---

## 5. Vulnerabilities corrigees (Corrected Vulnerabilities)

### 5.1 CircomReduction Bug (Fixed)

**Issue:** The Rust prover (ark-circom 0.5) initially used the default
`LibsnarkReduction` for QAP computation. Circom >= 2.0.7 uses a different
R1CS-to-QAP mapping, resulting in proofs that were structurally valid (on-curve
points) but mathematically wrong (failed verification).

**Fix:** Changed to `type GrothBn = Groth16<Bn254, CircomReduction>;` in
`services/prover/src/prover.rs`. Additionally, the relayer now verifies Rust
prover proofs with snarkjs before returning them (safety net).

**Reference:** https://github.com/arkworks-rs/circom-compat/issues/35

### 5.2 Bloom Filter False Positives (Mitigated)

**Issue:** The legacy `ShieldedPool` uses a Bloom filter (`NullifierSet`) for
double-spend detection. Bloom filters have a non-zero false positive rate,
meaning a legitimate withdrawal could be incorrectly rejected.

**Fix:** The denominated pool (`DenominatedPool`) uses PDA-per-nullifier, which
has zero false positives. The Bloom filter remains only for the legacy
`ShieldedPool` (transfer.circom based flow).

**Recommendation:** Migrate all flows to PDA-per-nullifier. The Bloom filter
approach should be considered deprecated.

### 5.3 Migration from transfer.circom to denominated_pool.circom

**Status:** Both circuits are deployed. The `denominated_pool.circom` is the
recommended circuit for new deployments.

**Key improvements in denominated_pool.circom:**
- Fixed denomination (no amount in circuit) eliminates amount correlation
- Simpler circuit (fewer constraints) means faster proving
- PDA-per-nullifier instead of Bloom filter
- Epoch-based time delay for timing correlation mitigation
- Dynamic delay based on anonymity set size

**transfer.circom known issues:**
- No epoch/timing constraint (deposits and withdrawals can happen immediately)
- Variable amounts enable amount correlation
- Bloom filter for nullifiers (false positives possible)
- More complex circuit (2-in-2-out) with larger proving time
- Dummy note handling could confuse auditors (though it is sound)

### 5.4 On-Chain Merkle Root Trust (Not Yet Fixed)

**Issue:** `insert_with_root()` accepts any root provided by the client. No
on-chain verification that the new root was correctly computed from the
old subtrees + new leaf.

**Status:** OPEN -- waiting for Poseidon syscall on Solana.

**Workaround:** Honest clients compute the root correctly. A malicious client
can only grief (corrupt the tree for others), not steal funds.

### 5.5 Missing Rate Limiting on Relayer (Not Yet Fixed)

**Issue:** The relayer has a TODO for rate limiting (`express-rate-limit`) but it
is not implemented. This allows DoS attacks against the prover and relay
endpoints.

**Status:** OPEN -- code comment indicates this is planned.
