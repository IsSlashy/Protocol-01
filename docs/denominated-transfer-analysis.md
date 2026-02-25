# Denominated Pool — Transfer Analysis

> Circuit: `circuits/denominated_pool.circom` (4,273 constraints, depth 15)
> Program: `zk_shielded` (GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c)

## Conclusion

**The denominated pool circuit does NOT support intra-pool transfers.**

The circuit only proves one thing: "I know the secret of a note that is in the Merkle tree and that is sufficiently aged." It is a withdrawal circuit, not a transfer circuit.

---

## Circuit Analysis

### Public Inputs (4)

| Input | Description |
|-------|-------------|
| `merkle_root` | Root of the pool's Merkle tree at withdrawal time |
| `nullifier` | = Poseidon(nullifier_preimage, secret) — prevents double-spend |
| `min_epoch` | current_epoch - epoch_delay — proves note maturity |
| `token_mint` | Token mint (field element) — binds proof to specific token |

### Private Inputs (9 + 2*15)

| Input | Description |
|-------|-------------|
| `secret` | Random spending secret |
| `nullifier_preimage` | Random value for nullifier derivation |
| `deposit_epoch` | Epoch at time of deposit |
| `path_elements[15]` | Merkle proof siblings |
| `path_indices[15]` | Merkle proof positions (left/right) |

### What the Circuit Proves

1. **Knowledge of secret**: Prover knows `secret` and `nullifier_preimage` that produce the commitment
2. **Merkle membership**: commitment = Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint) exists in the tree at `merkle_root`
3. **Nullifier correctness**: nullifier = Poseidon(nullifier_preimage, secret) — matches the public input
4. **Time delay**: deposit_epoch <= min_epoch (note is old enough)
5. **Token binding**: token_mint matches the public input

### What the Circuit Does NOT Prove

- No `recipient` address — the circuit doesn't know who receives
- No `new_commitment` — there's no output note creation
- No `amount` — denomination is enforced at the program level, not in the circuit

---

## Transfer Scenarios

### Option A: Unshield + Re-shield (Recommended for v1)

**Flow**: Sender unshields (withdraws to a fresh address) -> Recipient shields (deposits from the fresh address)

```
Sender                          Pool                          Recipient
  |-- unshield_denominated -->   |                               |
  |     (nullifier revealed)     |                               |
  |                              |                               |
  |   SOL arrives at fresh addr  |                               |
  |                              |                               |
  |              fresh addr ---- shield_denominated ------------>|
  |                              |     (new commitment)          |
```

**Pros:**
- Works today, no circuit changes needed
- Full privacy if sender uses a fresh intermediate address
- Each step is individually private (sender's identity hidden by anonymity set, recipient deposits from a clean address)

**Cons:**
- 2 transactions (higher latency, ~6-8s total)
- Intermediate address creates a timing correlation risk if both tx happen in the same block
- Sender must communicate the intermediate address to recipient out-of-band

**Mitigation:** Add a random delay between unshield and re-shield (1-5 blocks). Use a fresh ephemeral keypair for the intermediate step.

**Effort:** Low — already implemented. UX needs a "Send" flow that automates the 2-step process.

### Option B: New Circuit with Output Commitment (Recommended for v2)

Add a second circuit (`denominated_transfer.circom`) that proves:
1. Knowledge of an input note (same as current unshield)
2. Creation of a valid output note (new commitment for recipient)
3. Nullifier revelation (prevents double-spend)

```circom
// denominated_transfer.circom (hypothetical)
signal input secret;               // sender's secret
signal input nullifier_preimage;    // sender's nullifier preimage
signal input deposit_epoch;         // sender's deposit epoch
signal input token_mint;
signal input path_elements[15];
signal input path_indices[15];
signal input recipient_secret;      // NEW: recipient's secret
signal input recipient_np;          // NEW: recipient's nullifier preimage
signal input recipient_epoch;       // NEW: current epoch for new note

signal output merkle_root;          // proves input note exists
signal output nullifier;            // prevents double-spend
signal output new_commitment;       // NEW: output note for recipient
signal output min_epoch;
signal output token_mint_out;
```

**Pros:**
- Single transaction (atomic transfer)
- No timing correlation — everything happens in one block
- Better privacy: no intermediate address, no on-chain amount movement

**Cons:**
- New circuit to build, audit, and deploy
- Larger constraint count (~6000-8000 estimated)
- Recipient must share their secret commitment parameters with sender (via encrypted channel)

**Effort:** High — new circuit + updated program instruction + SDK + UI changes.

### Option C: Use the Existing Shielded Pool (Variable Amounts)

Transfer via the existing `transfer` circuit in the shielded pool (supports arbitrary amounts).

**Pros:**
- Already implemented and tested
- Supports arbitrary amounts (not limited to denominations)

**Cons:**
- Different anonymity set — variable-amount pool has weaker privacy guarantees
- Cross-pool transfers break the denomination model
- Users would need to understand which pool they're using

**Not recommended** — defeats the purpose of fixed denominations.

---

## Recommendation

| Phase | Approach | Timeline |
|-------|----------|----------|
| **v1 (Launch)** | Option A: Unshield + Re-shield | Now — already works |
| **v2 (Post-audit)** | Option B: New transfer circuit | After mainnet launch |

### v1 Implementation Plan

1. Add a "Private Send" action to mobile and extension UI
2. The flow automates: unshield -> wait 1-5 blocks -> shield from fresh address
3. Recipient provides their pool address (or a fresh deposit address)
4. Show progress: "Withdrawing from pool..." -> "Waiting..." -> "Depositing for recipient..."

### v2 Considerations

- Circuit design should follow Railgun's model (input notes -> output notes + nullifiers)
- Consider batch transfers (multiple inputs, multiple outputs) for efficiency
- The new circuit needs a fresh trusted setup or can use the existing ptau
- Budget: circuit development (~2 weeks), audit (~$15-30k additional scope)
