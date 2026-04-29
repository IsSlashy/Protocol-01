# Protocol 01 -- Audit Scope

**Document version:** 1.0
**Date:** 2026-02-25
**Status:** Pre-audit preparation

> **Status update 2026-04-28:** The hot-path Groth16 verifiers listed below (`programs/zk_shielded/src/verifier/groth16.rs`, `programs/p01_zkspl/src/verifier/groth16.rs`) have been replaced by the STARK FRI verifier on every spend path in P10. Groth16 verifier code is retained only for compliance attestations and the sealed-bid auction escrow surface (legacy, scheduled for STARK migration). Auditors should treat the Groth16 entries below as scoped to those retained surfaces; the production hot path verifies STARK proofs over the Goldilocks field.

---

## Priority Table

Auditors should proceed top-to-bottom. P0 items are critical for fund safety.

| Priority | File | LOC | Category | Reason |
|----------|------|-----|----------|--------|
| **P0** | `circuits/denominated_pool.circom` | 115 | Circuit | Core privacy circuit -- any constraint flaw = fund loss or broken anonymity |
| **P0** | `circuits/merkle.circom` | 98 | Circuit | Shared Merkle proof library used by all circuits -- bug affects all flows |
| **P0** | `programs/zk_shielded/src/instructions/unshield_denominated.rs` | 264 | On-chain | Fund exit point + ZK proof verification + nullifier check + epoch delay |
| **P0** | `programs/zk_shielded/src/verifier/groth16.rs` | 479 | On-chain | Custom Groth16 verifier using alt_bn128 syscalls -- correctness is critical |
| **P0** | `programs/zk_shielded/src/instructions/shield_denominated.rs` | 170 | On-chain | Fund entry point -- Merkle tree insertion with client-computed root |
| **P0** | `programs/zk_shielded/src/state/pool.rs` | 405 | On-chain | Pool state management, dynamic delay logic, epoch maturity tracking |
| **P0** | `programs/zk_shielded/src/state/merkle_tree.rs` | 286 | On-chain | Merkle tree state, `insert_with_root` (unverified client root), zero values |
| **P1** | `circuits/confidential_balance.circom` | 364 | Circuit | zkSPL circuit -- conservation law, range proofs, commitment scheme |
| **P1** | `circuits/balance_proof.circom` | 157 | Circuit | Balance sufficiency proof -- range proof correctness |
| **P1** | `circuits/transfer.circom` | 188 | Circuit | Legacy circuit -- document known issues; still deployed |
| **P1** | `circuits/poseidon.circom` | 63 | Circuit | Note commitment + nullifier computation templates for legacy flow |
| **P1** | `programs/zk_shielded/src/instructions/unshield.rs` | 283 | On-chain | Legacy fund exit -- Bloom filter nullifier check |
| **P1** | `programs/zk_shielded/src/state/nullifier_set.rs` | 156 | On-chain | Bloom filter implementation -- false positive analysis needed |
| **P1** | `programs/p01_zkspl/src/verifier/groth16.rs` | 290 | On-chain | zkSPL Groth16 verifier (similar to zk_shielded verifier) |
| **P1** | `programs/p01_zkspl/src/instructions/deposit.rs` | 181 | On-chain | zkSPL fund entry |
| **P1** | `programs/p01_zkspl/src/instructions/withdraw.rs` | 188 | On-chain | zkSPL fund exit |
| **P1** | `programs/p01_zkspl/src/instructions/confidential_transfer.rs` | 134 | On-chain | zkSPL private transfer |
| **P1** | `programs/p01_zkspl/src/instructions/apply_pending.rs` | 113 | On-chain | zkSPL apply pending credits |
| **P1** | `programs/p01_zkspl/src/instructions/prove_balance.rs` | 94 | On-chain | zkSPL balance proof verification |
| **P1** | `programs/p01_zkspl/src/state/confidential_account.rs` | 90 | On-chain | Confidential account structure |
| **P2** | `programs/zk_shielded/src/instructions/shield.rs` | 166 | On-chain | Legacy shield flow -- variable amounts |
| **P2** | `programs/zk_shielded/src/instructions/transfer.rs` | 173 | On-chain | Legacy private transfer |
| **P2** | `programs/zk_shielded/src/instructions/transfer_via_relayer.rs` | 172 | On-chain | Relayer-based transfer |
| **P2** | `programs/zk_shielded/src/instructions/init_denominated_pool.rs` | 111 | On-chain | Pool initialization -- authority checks |
| **P2** | `programs/zk_shielded/src/instructions/store_vk_data.rs` | 163 | On-chain | VK data upload (admin function) |
| **P2** | `programs/zk_shielded/src/instructions/update_vk.rs` | 59 | On-chain | VK hash update (admin function) |
| **P2** | `programs/zk_shielded/src/errors.rs` | 79 | On-chain | Error definitions |
| **P2** | `programs/zk_shielded/src/lib.rs` | 187 | On-chain | Program entry points |
| **P2** | `programs/p01_zkspl/src/lib.rs` | 133 | On-chain | zkSPL program entry points |
| **P2** | `programs/p01_zkspl/src/errors.rs` | 67 | On-chain | zkSPL error definitions |
| **P2** | `programs/p01_zkspl/src/state/mint_config.rs` | 46 | On-chain | zkSPL mint configuration |
| **P2** | `programs/p01_zkspl/src/instructions/initialize_mint.rs` | 51 | On-chain | zkSPL mint initialization |
| **P2** | `programs/p01_zkspl/src/instructions/create_account.rs` | 80 | On-chain | zkSPL account creation |
| **P2** | `programs/p01_zkspl/src/instructions/manage_viewers.rs` | 94 | On-chain | zkSPL viewer management |
| **P2** | `programs/p01_zkspl/src/instructions/store_vk_data.rs` | 92 | On-chain | zkSPL VK data upload |
| **P3** | `services/relayer/src/index.ts` | 2,004 | Off-chain | Relayer service -- DoS, metadata leakage, proof generation |
| **P3** | `services/prover/src/main.rs` | 504 | Off-chain | Rust prover service -- proof correctness, self-verification |
| **P3** | `services/prover/src/prover.rs` | 185 | Off-chain | Rust Groth16 prover -- CircomReduction, input parsing |
| **Out of scope** | `programs/specter/` | -- | On-chain | Stealth address registry -- no direct fund custody |
| **Out of scope** | `programs/stream/` | -- | On-chain | Payment streaming -- separate fund flow |
| **Out of scope** | `programs/subscription/` | -- | On-chain | Recurring payments -- separate fund flow |
| **Out of scope** | `programs/whitelist/` | -- | On-chain | Whitelist management -- no funds |
| **Out of scope** | `programs/p01-fee-splitter/` | -- | On-chain | Fee splitting -- no direct user funds at risk |

---

## LOC Summary

| Category | LOC | Files |
|----------|-----|-------|
| **P0 -- Critical (circuits + core on-chain)** | 1,817 | 7 |
| **P1 -- High (zkSPL + legacy circuits + on-chain)** | 2,302 | 11 |
| **P2 -- Medium (secondary on-chain)** | 1,574 | 12 |
| **P3 -- Low (off-chain services)** | 2,693 | 3 |
| **Total in scope** | 8,386 | 33 |

**Estimated critical audit scope (P0 + P1):** ~4,119 LOC

---

## Specific Focus Areas for Auditors

### Circuits (P0/P1)

1. **Constraint completeness in denominated_pool.circom:**
   - Verify that all private inputs are properly bound to public inputs
   - Confirm `token_mint` binding prevents cross-pool proof reuse
   - Verify epoch range check (40-bit Num2Bits) is sufficient
   - Check that no underconstrained signals exist

2. **Merkle tree verification in merkle.circom:**
   - Verify `pathIndices` binary constraints
   - Verify `computedRoot` is correctly propagated
   - Check MerkleTreeChecker vs MerklePathComputer consistency

3. **Conservation law in confidential_balance.circom:**
   - Verify all 5 range proofs (64-bit) are sufficient
   - Verify `is_debit` binary constraint
   - Check that `private_debit` and `private_credit` cannot be manipulated
   - Verify `amount_hash` binding between sender and recipient
   - Check `nonce` (anti-replay) is properly constrained (it is a public input
     but not directly used in constraints other than being public -- auditor
     should verify the on-chain program increments it)

4. **transfer.circom legacy concerns:**
   - Document the dummy note pattern (amount=0 bypasses checks)
   - Verify `nullifier_1 != nullifier_2` is NOT checked in circuit (on-chain check?)
   - Verify value conservation with `public_amount` (can be negative)

### On-Chain Programs (P0/P1)

1. **Groth16 verifier (groth16.rs):**
   - Verify G1 negation (field modulus subtraction) is correct
   - Verify endianness conversion (LE to BE) is correct for all public inputs
   - Verify pairing equation: `e(-A, B) * e(alpha, beta) * e(IC_sum, gamma) * e(C, delta) = 1`
   - Check IC linear combination: `IC[0] + sum(pub_i * IC[i+1])`
   - Verify VK hash comparison (Keccak256 of raw VK bytes)
   - Check for stack overflow with large public input counts

2. **insert_with_root (merkle_tree.rs):**
   - Confirm that the program trusts the client-computed root without verification
   - Document the griefing risk
   - Verify `filled_subtrees[0]` is updated correctly
   - Verify `leaf_count` overflow check

3. **Nullifier double-spend prevention:**
   - Denominated pool: Verify PDA `init` constraint atomically prevents double-spend
   - Legacy pool: Analyze Bloom filter false positive rate
   - Check: What happens if the same nullifier is used in different pools?

4. **Dynamic delay logic (pool.rs):**
   - Verify `update_maturity` circular buffer logic
   - Check for off-by-one errors in epoch scanning
   - Verify `get_dynamic_delay` thresholds are appropriate
   - Check `record_deposit` buffer overflow handling

5. **Token handling:**
   - Verify SOL vs SPL token branching is correct
   - Check PDA signer seeds match for token transfers
   - Verify rent-exempt balance check before SOL withdrawal
   - Check for reentrancy (CPI to token program)

---

## Open Questions for Auditors

1. **Is the 40-bit range check on `epoch_diff` in denominated_pool.circom
   sufficient?** 40 bits supports ~1 trillion epochs. Given Solana's slot rate
   and the epoch calculation (`slot / 7200`), is there any scenario where this
   could overflow?

2. **Can a malicious client submit a correct commitment but wrong root in
   `shield_denominated`?** The commitment is correctly inserted at
   `filled_subtrees[0]`, but the root is accepted blindly. Could this be
   exploited beyond griefing?

3. **Is the Bloom filter in NullifierSet safe for the legacy pool?** With
   `BLOOM_SIZE_BITS = 16,384` and 3 hash functions, what is the false positive
   rate at 10,000 nullifiers? At 100,000?

4. **Does the `nonce` in confidential_balance.circom provide sufficient replay
   protection?** The nonce is a public input but is only constrained by being
   public. The on-chain program must enforce monotonic incrementing. Is this
   verified?

5. **Are the precomputed ZEROS in merkle_tree.rs correct?** These 21 values
   must exactly match the Poseidon hash chain starting from ZERO_VALUE. A
   mismatch would cause all Merkle proofs to fail.

6. **Is the BN254 Fq modulus in `g1_negate` correct?** The hardcoded 32-byte
   array must be the exact field modulus. A wrong byte would cause all proof
   verifications to produce incorrect results.

7. **What is the impact of `historical_roots` having a fixed size of 100?** If
   more than 100 deposits happen between a user's deposit and their withdrawal
   attempt, the root they proved against may be pruned.

---

## Recommended Audit Approach

### Phase 1: Circuit Review (1-2 weeks)
- Formal verification of constraint systems using circom-checker or similar
- Exhaustive input/output analysis for each circuit
- Cross-reference public inputs between circuits and on-chain verification

### Phase 2: On-Chain Program Review (2-3 weeks)
- Anchor account validation review
- Custom Groth16 verifier correctness
- State management and arithmetic safety
- Token handling and PDA security

### Phase 3: Integration Review (1 week)
- End-to-end flow testing
- Relayer trust model validation
- Dependency supply chain review

### Phase 4: Report (1 week)
- Findings classification
- Remediation recommendations
- Re-audit of fixes
