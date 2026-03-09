# Protocol 01 × Arcium — Integration Plan

## Objectif
Intégrer Arcium MPC dans Protocol 01 pour 6 use cases concrets, déployables et vérifiables sur devnet.

## Architecture

```
packages/arcium-sdk/           ← TypeScript client SDK
programs/p01_arcium/           ← Anchor program (bridge P01 ↔ Arcium)
programs/p01_arcium/
  encrypted-ixs/               ← Arcis MPC circuits (6 circuits)
  src/lib.rs                   ← Anchor program with #[arcium_program]
tests/p01-arcium.test.ts       ← Devnet integration tests
```

## 6 Use Cases

### UC1: Confidential Relay (threshold_decrypt)
**Problem**: Single relayer decrypts TX → sees plaintext
**MPC Solution**: N nodes jointly decrypt relay job, no single node sees TX
**Circuit**: Accepts encrypted TX + relay key shares → threshold XOR decrypt → return to submitter
**Verifiable**: Submit relay job → MPC decrypts → execute on-chain → TX succeeds

### UC2: Anonymous Registry Lookup (private_lookup)
**Problem**: RPC node sees which wallet you're querying
**MPC Solution**: User submits encrypted wallet address → MPC checks registry → returns encrypted meta-address
**Circuit**: Compare encrypted address against registry entries → return matching meta-address
**Verifiable**: Query registry without wallet address appearing in RPC logs

### UC3: Hidden Nullifier Commitment (nullifier_commit)
**Problem**: On-chain nullifiers are linkable (observer sees which notes are spent)
**MPC Solution**: User submits encrypted nullifier → MPC computes SHA3 commitment → stores mapping privately
**Circuit**: SHA3(encrypted_nullifier) → public commitment, encrypted nullifier stored in MXE state
**Verifiable**: Nullifier commitment on-chain, original nullifier never visible

### UC4: Confidential Balance Audit (balance_audit)
**Problem**: Compliance requires proving solvency without revealing individual balances
**MPC Solution**: Users submit encrypted balances → MPC sums them → returns total without revealing individuals
**Circuit**: Sum N encrypted balances → return encrypted total + threshold proof
**Verifiable**: Auditor sees total, never individual amounts

### UC5: Threshold Stealth Scanning (stealth_scan)
**Problem**: Viewing key on single device = single point of failure
**MPC Solution**: Viewing key sharded across MPC nodes → distributed view-tag computation
**Circuit**: Compute X25519 shared secret from key shares → derive view tag → match announcements
**Verifiable**: Stealth payments discovered without reconstructing viewing key on any single node

### UC6: Private Governance Vote (private_vote)
**Problem**: Protocol governance votes are public (voter coercion, front-running)
**MPC Solution**: Encrypted votes → MPC tallies → reveal result only
**Circuit**: Accumulate encrypted votes in MXE state → threshold reveal when voting ends
**Verifiable**: Vote tally correct, individual votes never revealed

## Implementation Order

### Phase 1: Foundation (packages/arcium-sdk + programs/p01_arcium)
1. Create `packages/arcium-sdk/` — TS client (encryption, PDA helpers, computation management)
2. Create `programs/p01_arcium/` — Anchor program skeleton with Arcium macros
3. Create `encrypted-ixs/` — Arcis circuit definitions
4. Setup: Arcium.toml, Cargo.toml workspace, devnet cluster config

### Phase 2: Circuits (encrypted-ixs/)
5. UC4: balance_audit (simplest — pure arithmetic on encrypted values)
6. UC6: private_vote (stateful — Enc<Mxe, T> persistent encrypted state)
7. UC3: nullifier_commit (SHA3 hashing + state storage)
8. UC2: private_lookup (comparison + conditional return)
9. UC5: stealth_scan (X25519 + view-tag derivation)
10. UC1: threshold_decrypt (most complex — full relay integration)

### Phase 3: SDK Client
11. ArciumClient class (connection, encryption, key management)
12. Per-use-case helpers (submitBalanceAudit, castPrivateVote, etc.)
13. Event listeners for computation finalization

### Phase 4: Tests
14. Unit tests for each circuit
15. Devnet integration tests (cluster offset 456)
16. Cross-protocol tests (P01 shield → Arcium audit → P01 unshield)

## Dependencies

### npm (packages/arcium-sdk)
```json
{
  "@arcium-hq/client": "0.8.5",
  "@arcium-hq/reader": "0.8.5",
  "@coral-xyz/anchor": "^0.32.1",
  "@solana/web3.js": "^1.98.4"
}
```

### Cargo (programs/p01_arcium)
```toml
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
arcium-client = { version = "0.8.5", default-features = false }
arcium-macros = "0.8.5"
arcium-anchor = "0.8.5"
```

### Cargo (encrypted-ixs)
```toml
arcis = "0.8.5"
blake3 = "=1.8.2"
```

## Devnet Config
- Arcium cluster offset: 456
- RPC: Helius devnet (existing)
- Deploy wallet: 7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU
