# v4-relayed — the first spend that did not name its buyer

Recorded live from devnet on 2026-08-28 from
`4KHpG7kakxBRJJqXHJbcM9XbN4JT6RbYBR7QvQ6XKEo7yfpbHJRsswddLCgmAEgjPCMW3ougu4gyzoGLRLNvgmoV`,
an `unshield_denominated_stark_v4_relayed` — the sibling instruction that pays its
submitter out of the protocol fee so a stranger can afford to send the transaction.

## What it pins, and it is one line

```
PASS  P11 [proven]  the named wallet appears in no reachable transaction
```

`Aq9mbCne…` appears in the account keys of **NONE of the 94 transactions read across
3 surfaces, each read in full**. Not a truncated walk reported as an absence — the
asymmetry the tool insists on everywhere else: a hit is cheap, an absence has to be
paid for in full.

P11 was the only `[open]` probe in the protocol. **This fixture is the record that it
closed.**

## Why BOTH halves of the run mattered

P11 reads four surfaces, and the withdrawal is only one of them. This spend's note was
deposited through the **relayed deposit** (`liveRelayedShield`, the deployed
`/api/relay-to-buyer`): the buyer pays the till, the float funds the depositing
ephemeral, and the pool transaction never names the buyer. Then the withdrawal was
relayed too. A relayed withdrawal on a wallet-funded deposit would still have failed
here, on the deposit payer's history.

## 🚨 The funding topology is part of the measurement

The treasury `7gWpzSZA…` carries more than 3,000 transactions. P11 walks a funder's
history **exhaustively** and refuses to argue absence from a truncated one, so any
account it funds DIRECTLY turns this probe INCONCLUSIVE — not green. The relayer and
the buyer were therefore each funded through their own short-history intermediary,
which is also what a real buyer looks like: nobody is funded by their relayer's funder.

Re-recording this fixture without that topology will not reproduce it.

## The float is the load-bearing account, and nothing enforces its shape

P11 walks the deposit payer's funder — the float `H8WtBx3Qap…` — and reads that
account's whole history. MEASURED 2026-08-28, all 54 of its transactions read:

```
float history          54 transactions
  naming the treasury   1
  naming the buyer      0   <- this is why P11 passes
```

The verdict rests on that last line and on nothing else. Two ways it stops being
true, neither of which any test prevents:

- **A buyer pays the float directly** instead of the till. The whole point of the
  R != F split (gate 4, 21 August) is that the account receiving buyer money is
  not the account funding ephemerals. Collapse them and P11 fails on the deposit
  surface, which is the shape of the 18 August false green.
- **The float's history outgrows the walk.** P11 refuses to argue absence from a
  truncated history, so a float with thousands of transactions turns this
  INCONCLUSIVE — not green. 54 is comfortable; it will not stay 54 forever.

## ⚠️ Two verdicts that must not be read as wins

**`P10 = PASS` is a statement about time, not privacy**, and the probe says so itself:
the payee is published in the clear at byte 115 of the instruction, permanently, so it
re-links the moment the funds move. It reads PASS here only because that address has
sent nothing onward in its one-transaction life. `v4-wired` pins the same probe FAIL
for exactly that reason — the payee there was swept home. Both fixtures together say
this better than either says alone.

**`P6 = FAIL` is structural and always will be**: every Solana transaction has a fee
payer, and a payer must hold lamports before it executes, so it always has a funding
history. What changed is WHO — and the detail line is the evidence that it changed:
`Aq9mbCne… is NOT among the spend payer's 10 counterparty edges over 91 transactions
read`. The relayer's whole life was read, and the buyer is not in it.

## The CLI trap that nearly produced a false record

`--record` requires `--spend`. A signature passed POSITIONALLY is silently ignored:
the tool searches the pool and analyses whatever spend it finds, which is a different
transaction with a different verdict. Before quoting any run, grep its output for the
signature you meant to measure.
