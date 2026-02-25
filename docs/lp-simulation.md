# Protocol 01 -- LP Economic Simulation

All calculations assume the relayer fee is 0.5% (50 bps), matching `CONFIG.feeBps` in `services/relayer/src/index.ts`. LP reward share is 80% of collected fees. SOL price assumed at $150 for gas cost calculations.

---

## 1. Simulation Parameters

### 1 USDC Pool

| Parameter | Pessimistic | Base | Optimistic |
|---|---|---|---|
| LP Notes in pool | 5,000 | 5,000 | 5,000 |
| Number of LPs | 10 | 10 | 10 |
| Notes per LP | 500 | 500 | 500 |
| Capital per LP | 500 USDC | 500 USDC | 500 USDC |
| Transactions/day | 10 | 100 | 1,000 |
| Fee per transaction | 0.5% | 0.5% | 0.5% |
| LP reward share | 80% | 80% | 80% |

---

## 2. 1 USDC Pool Analysis

### 2.1 Revenue calculations

**Daily total pool revenue** = transactions/day * denomination * fee%

| Scenario | Daily total revenue | Daily LP pool (80%) | Daily per LP (10 LPs) |
|---|---|---|---|
| Pessimistic (10 tx/day) | 10 * 1 * 0.005 = **0.05 USDC** | 0.04 USDC | 0.004 USDC |
| Base (100 tx/day) | 100 * 1 * 0.005 = **0.50 USDC** | 0.40 USDC | 0.04 USDC |
| Optimistic (1,000 tx/day) | 1,000 * 1 * 0.005 = **5.00 USDC** | 4.00 USDC | 0.40 USDC |

**Monthly and annual per LP**:

| Scenario | Monthly per LP | Annual per LP | Gross APY |
|---|---|---|---|
| Pessimistic | 0.12 USDC | 1.46 USDC | **0.29%** |
| Base | 1.20 USDC | 14.60 USDC | **2.92%** |
| Optimistic | 12.00 USDC | 146.00 USDC | **29.20%** |

### 2.2 Shuffle costs

**Full shuffle** (all 500 notes, 4x/month):
- Per shuffle: 500 * 0.011 SOL = 5.5 SOL
- Monthly: 5.5 * 4 = 22 SOL = **$3,300**
- Annual: $39,600

**Partial shuffle** (20% of notes = 100 notes, 4x/month):
- Per shuffle: 100 * 0.011 SOL = 1.1 SOL
- Monthly: 1.1 * 4 = 4.4 SOL = **$660**
- Annual: $7,920

**Minimal shuffle** (5% of notes = 25 notes, 4x/month):
- Per shuffle: 25 * 0.011 SOL = 0.275 SOL
- Monthly: 0.275 * 4 = 1.1 SOL = **$165**
- Annual: $1,980

### 2.3 Net APY after shuffle costs (partial shuffle -- 20%)

| Scenario | Gross annual | Shuffle cost | Net annual | Net APY |
|---|---|---|---|---|
| Pessimistic | $1.46 | $7,920 | **-$7,918.54** | **-1,583.7%** |
| Base | $14.60 | $7,920 | **-$7,905.40** | **-1,581.1%** |
| Optimistic | $146.00 | $7,920 | **-$7,774.00** | **-1,554.8%** |

### 2.4 Net APY with minimal shuffle (5%)

| Scenario | Gross annual | Shuffle cost | Net annual | Net APY |
|---|---|---|---|---|
| Pessimistic | $1.46 | $1,980 | **-$1,978.54** | **-395.7%** |
| Base | $14.60 | $1,980 | **-$1,965.40** | **-393.1%** |
| Optimistic | $146.00 | $1,980 | **-$1,834.00** | **-366.8%** |

### 2.5 Comparison vs lending yield

Solend/Kamino USDC lending: ~5% APY = $25/year on 500 USDC.

The 1 USDC pool **cannot compete with lending** at any realistic transaction volume when shuffle costs are denominated in SOL. The fundamental problem: each note is worth only $1, but shuffling each note costs ~$1.65 in gas. The gas cost exceeds the note value.

### 2.6 Breakeven analysis (1 USDC pool)

**Without shuffle costs**: To match 5% lending yield on 500 USDC ($25/year), each LP needs $25/year in rewards.

```
$25 = (annual_tx * 1 * 0.005 * 0.80) / 10
$25 = annual_tx * 0.0004
annual_tx = 62,500
daily_tx = 171
```

Breakeven vs lending (no shuffle): **171 transactions/day**.

**With minimal shuffle ($1,980/year)**: Each LP needs $25 + $1,980 = $2,005/year.

```
$2,005 = annual_tx * 0.0004
annual_tx = 5,012,500
daily_tx = 13,733
```

Breakeven vs lending (with shuffle): **13,733 transactions/day**.

This is unrealistic for a 1 USDC pool.

---

## 3. 10 USDC Pool Analysis

| Parameter | Pessimistic | Base | Optimistic |
|---|---|---|---|
| LP Notes in pool | 5,000 | 5,000 | 5,000 |
| Number of LPs | 10 | 10 | 10 |
| Notes per LP | 500 | 500 | 500 |
| Capital per LP | 5,000 USDC | 5,000 USDC | 5,000 USDC |
| Transactions/day | 10 | 100 | 1,000 |

### Revenue

| Scenario | Daily total | Daily LP pool | Daily per LP | Monthly per LP | Annual per LP | Gross APY |
|---|---|---|---|---|---|---|
| Pessimistic | 0.50 USDC | 0.40 USDC | 0.04 USDC | 1.20 USDC | 14.60 USDC | **0.29%** |
| Base | 5.00 USDC | 4.00 USDC | 0.40 USDC | 12.00 USDC | 146.00 USDC | **2.92%** |
| Optimistic | 50.00 USDC | 40.00 USDC | 4.00 USDC | 120.00 USDC | 1,460.00 USDC | **29.20%** |

### Net APY (minimal shuffle -- 5%, same $1,980/year gas cost)

| Scenario | Gross annual | Shuffle cost | Net annual | Net APY |
|---|---|---|---|---|
| Pessimistic | $14.60 | $1,980 | **-$1,965.40** | **-39.3%** |
| Base | $146.00 | $1,980 | **-$1,834.00** | **-36.7%** |
| Optimistic | $1,460.00 | $1,980 | **-$520.00** | **-10.4%** |

### Breakeven (10 USDC pool, minimal shuffle)

To earn $1,980 + $250 (5% on $5,000) = $2,230/year:

```
$2,230 = (annual_tx * 10 * 0.005 * 0.80) / 10
$2,230 = annual_tx * 0.004
annual_tx = 557,500
daily_tx = 1,527
```

Breakeven vs lending (with shuffle): **1,527 transactions/day**.

**Without shuffle costs**: Breakeven at **17 tx/day** to match 5% lending.

---

## 4. 100 USDC Pool Analysis

| Parameter | Pessimistic | Base | Optimistic |
|---|---|---|---|
| LP Notes in pool | 5,000 | 5,000 | 5,000 |
| Number of LPs | 10 | 10 | 10 |
| Notes per LP | 500 | 500 | 500 |
| Capital per LP | 50,000 USDC | 50,000 USDC | 50,000 USDC |
| Transactions/day | 5 | 50 | 500 |

Note: Larger denominations typically have fewer transactions.

### Revenue

| Scenario | Daily total | Daily LP pool | Daily per LP | Monthly per LP | Annual per LP | Gross APY |
|---|---|---|---|---|---|---|
| Pessimistic | 2.50 USDC | 2.00 USDC | 0.20 USDC | 6.00 USDC | 73.00 USDC | **0.15%** |
| Base | 25.00 USDC | 20.00 USDC | 2.00 USDC | 60.00 USDC | 730.00 USDC | **1.46%** |
| Optimistic | 250.00 USDC | 200.00 USDC | 20.00 USDC | 600.00 USDC | 7,300.00 USDC | **14.60%** |

### Net APY (minimal shuffle -- 5%, $1,980/year)

| Scenario | Gross annual | Shuffle cost | Net annual | Net APY |
|---|---|---|---|---|
| Pessimistic | $73.00 | $1,980 | **-$1,907.00** | **-3.8%** |
| Base | $730.00 | $1,980 | **-$1,250.00** | **-2.5%** |
| Optimistic | $7,300.00 | $1,980 | **+$5,320.00** | **+10.6%** |

### Breakeven (100 USDC pool, minimal shuffle)

To earn $1,980 + $2,500 (5% on $50,000) = $4,480/year:

```
$4,480 = (annual_tx * 100 * 0.005 * 0.80) / 10
$4,480 = annual_tx * 0.04
annual_tx = 112,000
daily_tx = 307
```

Breakeven vs lending (with shuffle): **307 transactions/day**.

**Without shuffle costs**: Breakeven at **17 tx/day** to match 5% lending.

---

## 5. 1,000 USDC Pool Analysis

| Parameter | Pessimistic | Base | Optimistic |
|---|---|---|---|
| LP Notes in pool | 5,000 | 5,000 | 5,000 |
| Number of LPs | 10 | 10 | 10 |
| Notes per LP | 500 | 500 | 500 |
| Capital per LP | 500,000 USDC | 500,000 USDC | 500,000 USDC |
| Transactions/day | 2 | 20 | 200 |

Note: Very large denominations have the fewest transactions but highest per-tx fees.

### Revenue

| Scenario | Daily total | Daily LP pool | Daily per LP | Monthly per LP | Annual per LP | Gross APY |
|---|---|---|---|---|---|---|
| Pessimistic | 10.00 USDC | 8.00 USDC | 0.80 USDC | 24.00 USDC | 292.00 USDC | **0.06%** |
| Base | 100.00 USDC | 80.00 USDC | 8.00 USDC | 240.00 USDC | 2,920.00 USDC | **0.58%** |
| Optimistic | 1,000.00 USDC | 800.00 USDC | 80.00 USDC | 2,400.00 USDC | 29,200.00 USDC | **5.84%** |

### Net APY (minimal shuffle -- 5%, $1,980/year)

| Scenario | Gross annual | Shuffle cost | Net annual | Net APY |
|---|---|---|---|---|
| Pessimistic | $292.00 | $1,980 | **-$1,688.00** | **-0.3%** |
| Base | $2,920.00 | $1,980 | **+$940.00** | **+0.2%** |
| Optimistic | $29,200.00 | $1,980 | **+$27,220.00** | **+5.4%** |

### Breakeven (1,000 USDC pool, minimal shuffle)

To earn $1,980 + $25,000 (5% on $500,000) = $26,980/year:

```
$26,980 = (annual_tx * 1000 * 0.005 * 0.80) / 10
$26,980 = annual_tx * 0.4
annual_tx = 67,450
daily_tx = 185
```

Breakeven vs lending (with shuffle): **185 transactions/day**.

**Without shuffle costs**: Breakeven at **172 tx/day** to match 5% lending.

---

## 6. Summary -- Cross-Pool Comparison

### Gross APY (no shuffle costs)

| Pool | Pessimistic | Base | Optimistic |
|---|---|---|---|
| 1 USDC | 0.29% | 2.92% | 29.20% |
| 10 USDC | 0.29% | 2.92% | 29.20% |
| 100 USDC | 0.15% | 1.46% | 14.60% |
| 1,000 USDC | 0.06% | 0.58% | 5.84% |

Note: Gross APY percentage is inversely proportional to capital locked. The 1 USDC and 10 USDC pools have the same gross APY because the fee rate and tx/day assumptions are identical -- the difference is the absolute dollar amounts and the shuffle cost ratio.

### Net APY (minimal shuffle -- 5% of notes, 4x/month, $1,980/year)

| Pool | Capital/LP | Pessimistic | Base | Optimistic |
|---|---|---|---|---|
| 1 USDC | $500 | -395.7% | -393.1% | -366.8% |
| 10 USDC | $5,000 | -39.3% | -36.7% | -10.4% |
| 100 USDC | $50,000 | -3.8% | -2.5% | **+10.6%** |
| 1,000 USDC | $500,000 | -0.3% | **+0.2%** | **+5.4%** |

### Minimum daily transactions for breakeven (vs. 5% lending + shuffle costs)

| Pool | Breakeven tx/day |
|---|---|
| 1 USDC | 13,733 |
| 10 USDC | 1,527 |
| 100 USDC | 307 |
| 1,000 USDC | 185 |

---

## 7. Sensitivity Analysis

### Impact of SOL price on shuffle costs

| SOL Price | Minimal shuffle annual cost | 100 USDC pool breakeven tx/day |
|---|---|---|
| $50 | $660 | 119 |
| $100 | $1,320 | 213 |
| $150 | $1,980 | 307 |
| $200 | $2,640 | 401 |
| $300 | $3,960 | 589 |

### Impact of fee rate

| Fee rate | 100 USDC daily revenue (50 tx) | Annual per LP | Gross APY |
|---|---|---|---|
| 0.25% (25 bps) | 12.50 USDC | 365 USDC | 0.73% |
| 0.50% (50 bps) | 25.00 USDC | 730 USDC | 1.46% |
| 1.00% (100 bps) | 50.00 USDC | 1,460 USDC | 2.92% |

Doubling the fee to 1% (100 bps, the maximum in `ShieldedPool::MAX_RELAYER_FEE_BPS`) doubles the LP reward. However, higher fees reduce transaction volume.

### Impact of number of LPs

Fewer LPs means more reward per LP, but a smaller anonymity set:

| LPs | Notes/LP | Total notes | Capital/LP (100 USDC) | Annual reward (50 tx/day) | Gross APY |
|---|---|---|---|---|---|
| 5 | 1,000 | 5,000 | $100,000 | $1,460 | 1.46% |
| 10 | 500 | 5,000 | $50,000 | $730 | 1.46% |
| 20 | 250 | 5,000 | $25,000 | $365 | 1.46% |
| 50 | 100 | 5,000 | $10,000 | $146 | 1.46% |

Note: Gross APY is constant because total fee revenue is fixed regardless of LP distribution. The key difference is absolute capital required per LP.

---

## 8. Alternative LP Models

### 8.1 No-shuffle model (accept timing analysis risk)

If LPs accept the risk that dormant notes can be statistically identified:

| Pool | Capital/LP | Pessimistic | Base | Optimistic |
|---|---|---|---|---|
| 1 USDC | $500 | 0.29% | 2.92% | 29.20% |
| 10 USDC | $5,000 | 0.29% | 2.92% | 29.20% |
| 100 USDC | $50,000 | 0.15% | 1.46% | 14.60% |
| 1,000 USDC | $500,000 | 0.06% | 0.58% | 5.84% |

Without shuffle, the 100 USDC pool at optimistic volume (500 tx/day) yields 14.60% APY, significantly beating lending. But the privacy guarantee is degraded because LP notes are identifiable as "likely LPs."

### 8.2 Protocol-subsidized shuffles

The protocol treasury pays for LP shuffles:

- Annual shuffle budget for 10 LPs: $19,800 (minimal shuffle).
- This is effectively a protocol expense for privacy guarantees.
- Viable if the protocol has other revenue sources or VC funding during bootstrapping.

### 8.3 Reduced LP count with higher capital

Instead of 10 LPs with 500 notes each, use 3 LPs with 1,667 notes each:

- Same 5,000 note anonymity set.
- Fewer entities to coordinate.
- Higher reward per LP: $730 * (10/3) = $2,433/year on the 100 USDC base case.
- Higher capital requirement: $166,700 per LP.
- Risk: more concentrated, single LP withdrawal is more impactful.

---

## 9. Conclusion

### Is the LP model viable?

**CONDITIONALLY YES**, under specific conditions:

1. **100 USDC and 1,000 USDC pools are viable at moderate-to-high volume** (optimistic scenarios). The 100 USDC pool becomes profitable at ~307 tx/day including shuffle costs.

2. **1 USDC and 10 USDC pools are NOT viable as standalone LP investments.** The shuffle costs exceed revenue at any realistic transaction volume. These pools require either:
   - Protocol subsidization of shuffle costs, or
   - Acceptance of degraded privacy (no shuffles), or
   - Dramatically higher fee rates (impractical).

3. **Without shuffle costs, all pools are viable at base-case volume (100 tx/day)** with 2.92% gross APY on the 1/10 USDC pools. This is competitive with but below lending yields. The LP incentive becomes "earn yield + support the protocol" rather than pure profit maximization.

4. **The model is highly sensitive to SOL price and transaction volume.** At SOL = $300, shuffle costs double and breakeven volumes increase proportionally.

### Minimum volume for breakeven (vs. 5% lending + minimal shuffle)

| Pool | Min tx/day |
|---|---|
| 1 USDC | 13,733 (unrealistic) |
| 10 USDC | 1,527 (aggressive) |
| 100 USDC | 307 (achievable at scale) |
| 1,000 USDC | 185 (achievable at scale) |

### Key risks

1. **Gas cost dominance**: On Solana, even ~$0.0015/tx adds up when shuffling thousands of notes. SOL price appreciation makes this worse.
2. **Low transaction volume at launch**: The chicken-and-egg problem. LPs provide anonymity, but revenue depends on organic users who need anonymity.
3. **Relayer trust**: LPs must trust the relayer with their identities. A compromised relayer degrades the entire privacy model.
4. **Capital lock-up opportunity cost**: 500,000 USDC locked in a 1,000 USDC pool earns 0.58% base-case APY. The same capital in lending earns 5% with no operational overhead.
5. **Regulatory risk**: LPs who knowingly provide anonymity for financial transactions may face regulatory scrutiny depending on jurisdiction.
6. **Anonymity set degradation**: If organic users learn that most notes are LPs, they may lose confidence in the privacy guarantees, creating a negative feedback loop.

### Recommendation

For launch:
- **Focus on 100 USDC and 1,000 USDC pools** where LP economics are most favorable.
- **Subsidize shuffles from protocol treasury** during the bootstrapping phase (first 6--12 months).
- **Target 3--5 LPs** rather than 10 to concentrate rewards and reduce coordination complexity.
- **Set aggressive LP reward share** (90--100% of fees to LPs) during bootstrapping, reducing to 60--80% as organic volume grows.
- **Consider the no-shuffle model initially**, accepting weaker privacy guarantees in exchange for viable LP economics, with a roadmap to add shuffle subsidies as revenue grows.
- **Build the ZK proof-of-deposit-age circuit** as a medium-term priority to remove relayer trust from the LP model.
