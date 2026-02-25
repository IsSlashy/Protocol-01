# Protocol 01 -- Liquidity Provider (LP) Design

## 1. Vue d'ensemble

### Pourquoi les LPs existent

Protocol 01 uses denominated pools (Tornado Cash model) where privacy is a function of the anonymity set size. A user withdrawing 1 USDC from a pool containing 5,000 notes is indistinguishable from 4,999 other possible depositors. A user withdrawing from a pool containing 3 notes has essentially no privacy.

At launch, pools are empty. Zero notes means zero anonymity. The dynamic delay mechanism in `DenominatedPool` reflects this directly:

| Mature notes | Additional withdrawal delay |
|---|---|
| >= 1,000 | 0 (instant) |
| 100 -- 999 | 1 epoch (~1 hour) |
| 10 -- 99 | 6 epochs (~6 hours) |
| < 10 | 24 epochs (~24 hours) |

LPs solve the cold-start problem by depositing notes into pools before organic users arrive. They are paid from relayer fees for the service of making the protocol usable.

### How LPs benefit Protocol 01

1. **Bootstrap anonymity**: Pools reach >= 1,000 mature notes, unlocking instant withdrawals and strong privacy guarantees.
2. **Attract organic users**: Users will not shield into an empty pool. LPs create the initial "network effect" that makes the protocol credible.
3. **Fee revenue alignment**: LPs earn when the protocol earns. More transactions = more fees = higher LP rewards = more LP capital = better anonymity set = more transactions. Flywheel.
4. **Capital efficiency signal**: A pool with 5,000 USDC of LP-backed notes at 1 USDC denomination signals that the privacy guarantee is real, not theoretical.

---

## 2. Flow LP complet

### 2.1 Registration

LP registration is off-chain and relayer-mediated:

1. LP contacts the relayer operator via an authenticated API (API key issuance).
2. LP declares:
   - Target pool(s) (denomination + token mint)
   - Number of notes to deposit
   - Expected deposit schedule
3. Relayer records LP identity (wallet pubkey, API key) in its database.
4. Relayer issues a signed `lp_registration_id` (opaque token) that the LP uses for reward claims.

There is no on-chain LP registry. From the blockchain's perspective, LP deposits are identical to user deposits.

### 2.2 Deposit

LP deposits use the exact same `shield_denominated` instruction as any other user:

```
shield_denominated(commitment: [u8; 32], new_root: [u8; 32])
```

- The LP generates a commitment = `Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)`.
- The LP calls `shield_denominated` with exactly `pool.denomination` tokens.
- The commitment is inserted into the Merkle tree at `next_leaf_index`.
- Pool state updates: `note_count += 1`, `total_shielded += denomination`.
- The `record_deposit(current_epoch)` call tracks the deposit epoch for maturity.

**On-chain, this transaction is byte-for-byte identical to a regular user deposit.** There is no LP flag, no special account, no distinguishing field.

The LP stores the note locally (nullifier_preimage, secret, leaf_index, merkle proof) exactly as a regular user would.

### 2.3 Rewards

Rewards are computed off-chain by the relayer using a time-weighted proportional formula:

```
reward_lp = (time_in_pool_lp / sum(time_in_pool_all_lps)) * total_fees_collected_this_epoch
```

Where:
- `time_in_pool_lp` = number of hours LP's notes have been in the pool during the distribution epoch (24h).
- `sum(time_in_pool_all_lps)` = total note-hours across all LPs in this epoch.
- `total_fees_collected_this_epoch` = sum of relayer fees (0.5% of each unshield transaction) during the epoch.

**Distribution epoch**: Every 24 hours (configurable). The relayer snapshots note-hours at epoch boundaries.

**Fee source**: The relayer collects fees on every unshield it processes. These fees are held in the relayer's wallet. A configurable fraction (initially 100%) of collected fees is allocated to the LP reward pool. In the future, the `p01_fee_splitter` program (50 bps default, configurable up to 500 bps) can be used to split fees between protocol treasury, relayer operations, and LP rewards on-chain.

**Worked example** (1 USDC pool, 24h epoch):

- 10 LPs, each with 500 notes (5,000 total LP notes).
- All notes present for the full 24h epoch => each LP has 500 * 24 = 12,000 note-hours.
- Total note-hours = 10 * 12,000 = 120,000.
- 100 unshield transactions in the epoch, each 1 USDC at 0.5% fee => 100 * 0.005 = 0.50 USDC total fees.
- Per-LP reward = (12,000 / 120,000) * 0.50 = 0.05 USDC/day = 1.50 USDC/month.

### 2.4 Claim

Reward claims are separate transactions, deliberately unlinkable to pool activity:

1. LP calls the relayer's `/lp/claim` endpoint with their `lp_registration_id`.
2. Relayer verifies the LP's accumulated reward balance.
3. Relayer sends reward via a standard SOL/SPL transfer from the relayer's fee wallet to the LP's specified claim address.
4. This transfer is a regular Solana transfer -- it does not touch the shielded pool, does not reference any commitment, and does not reveal any pool-related information.

The claim address can (and should) be different from the LP's deposit wallet for operational security.

### 2.5 Withdrawal

An LP can withdraw their notes at any time using the standard `unshield_denominated` instruction:

1. LP generates a ZK proof for their note (merkle_root, nullifier, min_epoch, token_mint).
2. LP submits the proof via the relayer (or directly if they want to pay gas).
3. Pool state updates: `note_count -= 1`, `total_shielded -= denomination`, `mature_note_count -= 1`.

**Reward forfeiture**: When an LP withdraws a note mid-epoch, the relayer stops accruing note-hours for that note. The LP forfeits the partial-epoch reward for withdrawn notes. This is a soft penalty -- there is no slashing or lock-up.

**Dynamic delay applies**: LP withdrawals are subject to the same dynamic delay as user withdrawals. If the LP's withdrawal would reduce `mature_note_count` below a threshold, remaining notes face longer delays. This self-regulates against LP bank runs.

---

## 3. Indistinguabilite on-chain

### 3.1 Why an analyst cannot identify LPs

From the blockchain's perspective, every `shield_denominated` transaction has the same structure:

- **Accounts**: depositor (signer), denominated_pool (PDA), merkle_tree (PDA), system_program.
- **Data**: commitment (32 bytes), new_root (32 bytes).
- **Transfer**: exactly `pool.denomination` lamports/tokens.

There is no metadata, no LP flag, no special signer role. An LP depositing 500 notes looks exactly like 500 individual users each depositing 1 note, or 50 users each depositing 10 notes, or any other combination.

Similarly, `unshield_denominated` transactions are indistinguishable: every withdrawal returns exactly `pool.denomination` tokens, with a nullifier and ZK proof.

### 3.2 Risk: dormant note patterns

**Attack vector**: An analyst observes that certain notes are deposited and never withdrawn, even after months. Organic users typically shield, wait, and unshield within days or weeks. A cluster of long-lived notes may signal LP activity.

**Statistical pattern**: If 5,000 notes are deposited in week 1 and 4,800 of them are still in the pool 6 months later, while organic churn shows 90% withdrawal within 30 days, the dormant 4,800 are statistically likely to be LP notes.

**Mitigation: periodic shuffle**

LPs periodically withdraw and re-deposit their notes to reset the age profile:

1. LP unshields note (generates nullifier, proves membership).
2. LP waits a randomized delay (1--12 hours).
3. LP re-deposits with a fresh commitment.

This makes LP notes indistinguishable from organic "re-shield" behavior (users who withdraw and immediately re-deposit to a different denomination or to refresh their commitment).

### 3.3 Shuffle cost and impact on net profitability

Each shuffle consists of one unshield + one shield:

- **Unshield cost**: ~0.005 SOL (transaction fee) + ~0.00089 SOL (nullifier PDA rent) = ~0.006 SOL.
- **Shield cost**: ~0.005 SOL (transaction fee).
- **Total per shuffle**: ~0.011 SOL.

Recommended shuffle frequency: 4 times per month (once per week).

For an LP with 500 notes shuffled 4 times per month:
- Monthly shuffle cost = 500 notes * 4 shuffles * 0.011 SOL = 22 SOL.
- At SOL = $150: 22 * $150 = **$3,300/month** in shuffle costs.

This is a significant cost that dominates LP economics for low-volume pools. See the simulation document for breakeven analysis.

**Optimization**: LPs do not need to shuffle all notes every cycle. A randomized subset (e.g., 10--20% per week) provides statistical cover while reducing costs by 80--90%.

Partial shuffle (20% per week, 500 notes):
- Monthly cost = 500 * 0.20 * 4 * 0.011 SOL = 4.4 SOL = **$660/month**.

---

## 4. Trust assumptions

### 4.1 Relayer knows LP identities

The relayer is the LP coordinator. It knows:
- Which wallet addresses belong to LPs.
- Which commitments are LP deposits (from registration).
- How many notes each LP has in each pool.
- When LPs shuffle (it processes the unshield/shield transactions).

**Implications if the relayer is compromised**:

1. **Privacy degradation**: An attacker who compromises the relayer database can exclude LP notes from the anonymity set. If the pool has 5,000 notes and 4,500 are LPs, the effective anonymity set for a real user is only 500, not 5,000.

2. **LP deanonymization**: The attacker can link LP deposit addresses to their claim addresses, potentially revealing LP identities.

3. **Selective censorship**: The relayer could refuse to process certain LPs' withdrawals, effectively locking their capital.

### 4.2 Announced vs. real anonymity set

The on-chain `note_count` reflects all notes, including LP notes. A user seeing `note_count = 5,000` believes they are hiding among 5,000 depositors.

In reality, if the relayer knows 4,500 of those are LP notes, the "true" anonymity set from the relayer's perspective is only 500. Users are not informed of this distinction.

**This is the fundamental trust assumption of the LP model**: users trust the relayer not to use its knowledge of LP notes to deanonymize them.

**Mitigations**:
- **Multiple relayers**: If Protocol 01 supports multiple independent relayers in the future, each relayer only knows its own LPs. No single relayer can identify all LP notes.
- **Transparency reports**: The relayer publishes the LP-to-organic note ratio without revealing which notes are LPs. Users can make informed decisions about which pools to use.
- **Minimum organic ratio**: The protocol could enforce that pools with <20% organic notes display a warning in the UI.

### 4.3 Future: trustless LP rewards via ZK proofs

The relayer's knowledge of LP identities is a design compromise for simplicity. A more privacy-preserving design is possible:

**ZK proof of deposit age**: An LP could prove "I have a note that has been in the pool for >= T epochs" without revealing which note it is.

Circuit design:
```
inputs: [commitment, nullifier_preimage, secret, deposit_epoch, current_epoch, min_duration]
public: [merkle_root, current_epoch, min_duration, reward_claim_hash]
private: [commitment, nullifier_preimage, secret, deposit_epoch, merkle_path]

constraints:
  commitment == Poseidon(nullifier_preimage, secret, deposit_epoch, token_mint)
  merkle_verify(commitment, merkle_path, merkle_root) == true
  current_epoch - deposit_epoch >= min_duration
  reward_claim_hash == Poseidon(commitment, current_epoch)
```

This would allow LPs to claim rewards from a smart contract without the relayer knowing which notes are theirs. The `reward_claim_hash` prevents double-claiming within an epoch.

**Complexity**: This requires a new circuit, a new on-chain program for reward distribution, and a mechanism to fund the reward pool without relayer mediation. This is a post-mainnet optimization.

---

## 5. Reward formula

### 5.1 Formula

```
reward_lp = (time_in_pool_lp / sum(time_in_pool_all_lps)) * total_fees_collected_this_epoch
```

Where:
- `time_in_pool_lp` = sum of (note_count_lp * hours_present) for all of LP's notes during the epoch.
- `sum(time_in_pool_all_lps)` = aggregate note-hours across all LPs.
- `total_fees_collected_this_epoch` = relayer fees collected in the 24h distribution window.

### 5.2 Distribution epoch

- **Duration**: 24 hours (midnight UTC to midnight UTC).
- **Snapshot**: The relayer records note-hours at epoch boundaries.
- **Payment**: Within 1 hour of epoch close, rewards are computed and made available for claim.

### 5.3 Fee source

The relayer charges `CONFIG.feeBps` (default: 50 bps = 0.5%) on every unshield transaction it processes. This fee is deducted from the user's withdrawal amount before forwarding to the recipient.

The fee is held in the relayer's wallet. The `p01_fee_splitter` program can optionally be used to split fees on-chain:
- LP reward pool: configurable % (initially 80%)
- Protocol treasury: configurable % (initially 10%)
- Relayer operations: configurable % (initially 10%)

### 5.4 Worked example

**Setup**: 1 USDC denomination pool, 10 LPs, each with 500 notes (5,000 total LP notes), 100 transactions/day, 0.5% fee.

**Step 1**: Calculate daily fee revenue.
```
daily_revenue = 100 tx * 1 USDC * 0.005 = 0.50 USDC
```

**Step 2**: Calculate LP reward pool (assuming 80% to LPs).
```
lp_pool = 0.50 * 0.80 = 0.40 USDC
```

**Step 3**: Calculate per-LP reward (all 10 LPs have equal note-hours).
```
reward_per_lp = 0.40 / 10 = 0.04 USDC/day
```

**Step 4**: Annualize.
```
annual_reward = 0.04 * 365 = 14.60 USDC/year
capital_locked = 500 USDC
apy = 14.60 / 500 = 2.92%
```

**Conclusion for this scenario**: 2.92% APY before shuffle costs. After shuffle costs (~$660/month for partial shuffles = $7,920/year, shared across 500 notes = $15.84/note/year), the LP is deeply unprofitable at 100 tx/day on the 1 USDC pool. See `lp-simulation.md` for the full analysis across scenarios.
