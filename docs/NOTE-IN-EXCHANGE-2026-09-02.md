# Note-in exchange: where the money goes, and the three counters that must agree

Written 2026-09-02, with section D ("Inventory accounting") of the exchange design.
Devnet only. Nothing here is a privacy claim; the privacy of the exchange itself is
argued in the design and measured, or not, by the probes in `verify/`.

## What a note-in is

A buyer who already holds a pool note can pay for an issued (older) note by
withdrawing their own note straight to the till, on the direct circuit-7 path
(`unshield_denominated_stark_v4`), then presenting that withdrawal to
`POST /api/claim-for-payment` as a `pool-withdrawal`. The handler keeps the
protocol's 0.5 percent withdrawal fee (`fee.rs`, `UNSHIELD_FEE_BPS = 50`), so
the till receives the denomination minus that fee: 995,000,000 lamports for a
1 SOL note. A plain sale credits the till 1,003,000,000 (the denomination plus
the 0.3 percent shield fee). No treasury leaf is deposited by a note-in; one
issued leaf leaves the inventory, and the buyer's own note is spent (nullifier
published).

## The money flow, one hop at a time

```
buyer's pool note  --(v4 withdrawal, 0.995)-->  till R
till R             --(settle-till, whole till, batched, quiet-time)-->  float F
float F            --(top-up, surplus above F's floor, quiet-time)-->  restock wallet
restock wallet     --(restock, up to 3 deposits per tick, 1.003 each)-->  pool (treasury leaf)
pool leaf          --(issue-note, one leaf per claim)-->  the next buyer
```

| Hop | Who signs | When | Where the rule lives |
|-----|-----------|------|----------------------|
| note to till | the unshield ephemeral, funded by F via `/api/fund-ephemeral` | when the buyer exchanges | `apps/web/app/api/claim-for-payment/route.ts` (classifier and floor) |
| till to F | the till key, in the settler only | at least `minPurchases` purchases held AND the till quiet for `minQuietSeconds` AND a randomised hold expired | `apps/web/lib/privacy/pool/settlementPolicy.ts`, `apps/web/app/api/settle-till/route.ts`, `.github/workflows/settle-till.yml` (hourly) |
| F to restock wallet | F | F above `floatRequiredForBatch(minPurchases)` AND the restock wallet below its target AND F quiet for the same `minQuietSeconds`, plus a random start delay | `apps/web/lib/privacy/pool/restockTopUp.ts`, `apps/web/scripts/topUpRestockWallet.mts`, `.github/workflows/restock-inventory.yml` (every four hours, before the restock) |
| restock wallet to pool | the restock wallet, through a fresh ephemeral | live stock at or under `lowWater` (7), at most `maxPerRun` (3) per tick, never below `floorLamports` (1.1 SOL), random start delay | `apps/web/lib/privacy/pool/restockInventory.test.ts`, `apps/web/lib/privacy/pool/restockConfig.ts` |
| pool to buyer | nobody on chain; the issuer seals the note | one leaf per claim code, KV marker `p01:note:issued:<pool>:<leaf>` | `apps/web/app/api/issue-note/route.ts` |

Until 2026-09-02 the third hop did not exist. Takings reached F and stopped
there; the restock wallet drained to its floor, the workflow logged `FLOOR`
every tick, and `issue-note` answered 503 with the SOL one hop away. The
alternative, making the restock key F itself, was rejected: F would then be the
deposit payer of every issued note, and F's history is what probe P11 walks.
A transfer per tick adds one transaction to that history; a deposit per note
adds about a hundred.

### What each hop keeps back

- Note to till: 0.5 percent of the note stays in the fee escrow. F fronts the
  ephemeral's nullifier rent (2,000,000 lamports, permanent) and a fee budget
  (4,000,000, mostly swept back).
- Till to F: the network fee of the transfer. The settler moves the WHOLE till
  so no running counter of the next batch is left behind in the till's balance.
- F to restock wallet: the network fee, taken off the amount so F ends at or
  above its floor exactly. F's floor is the number `settle-till` reports as
  `floatRequiredForFloorLamports`: below it the settler names the deadlock
  `float-too-small-for-batch-floor`, and a top-up must never manufacture it.
- Restock wallet to pool: 0.3 percent per deposit plus proof-buffer rent, most
  of which returns when the buffers close.

Per 1 SOL note round trip: the till gains 0.995 (note-in) or 1.003 (plain sale);
the pool receives 1.003 back at restock. A note-in therefore nets the treasury
about 0.008 SOL less than a plain sale, before network fees.

## The three counters that must agree

Three independent reads describe the same loop, and each one is wrong in a
known direction. When they disagree, the direction says which one is lying.

1. **Purchases held by the till**, `purchasesHeld(tillLamports)` in
   `settlementPolicy.ts`. Since 2026-09-02 it divides by
   `MIN_PURCHASE_CREDIT_LAMPORTS` (995,000,000, the smaller of the two credits,
   derived from `UNSHIELD_FEE_BPS`), not by 1,003,000,000. Dividing by the
   larger credit read a till of note-in proceeds one purchase short per
   purchase, so three note-ins read as 2 and sat under a batch floor of 3
   forever. The floor direction is the safe one: a till reads MORE purchases
   than it holds only from about 125 plain purchases, pinned in
   `settlementPolicy.test.ts`. The same divisor drives `purchasesCarried`, the
   one-versus-many detector in `fund-ephemeral`.

2. **Notes issued**, the KV markers `p01:note:issued:<pool>:<leaf>` written by
   `issue-note`. Exact, but only the deployment can read them. Every purchase
   of either kind consumes exactly one marker.

3. **Live stock on chain**, `stock()` in `restockInventory.test.ts`: treasury
   leaves on the tree and unspent. This OVERSTATES availability, because a
   note issued to a buyer who has not spent it yet is still on the tree and
   unspent. The restock workflow hands that step only an RPC and the leaf
   list (`P01_LIVE_RPC`, `P01_TREASURY_NOTE_LEAVES`), never the issuer's store
   credentials, and `GET /api/issue-note` reports the configured size rather
   than the unissued count by its own stated choice. So the markers cannot be
   read from the workflow, by design; the low-water mark of 7 of 10 rather
   than 9 is the buffer that carries the difference. This was checked again
   on 2026-09-02 and left as documented rather than fixed: giving the harness
   the store credentials is the trade the test header refuses, and a note-in
   consumes an issued note without depositing one exactly like a plain sale,
   so it widens the gap the margin covers without changing its shape.

The reconciliation, over any window in which the loop has closed:

```
purchases settled (1)  ==  markers written (2)  ==  leaves restocked  ==  drop in (3) + leaves restocked
```

If (1) runs ahead of (2), the till was credited by something that was not a
sale (an overpayment, or a transfer to the wrong address). If (2) runs ahead
of (3)'s drop, buyers hold unspent issued notes, which is the normal lag and
the reason for the low-water margin. If (3) does not recover after (1) and (2)
have moved, the money is stuck on a hop: check F against its floor and the
restock wallet against its target in the top-up's one-line log.

## Configuration the top-up reads

Repository secrets, referenced by name in the workflow and never written down
anywhere: `P01_FUNDER_SECRET_KEY` (the float), `P01_TREASURY_KEYPAIR_JSON` (the
restock wallet, used only for its public key), `P01_FUNDER_RPC`.

Repository variables, optional: `P01_SETTLE_MIN_PURCHASES` and
`P01_SETTLE_MIN_QUIET_SECONDS`, so the top-up computes F's floor and quiet period
with the same values the deployment settles by. Unset means the policy's own
defaults (3 purchases, 6 hours), which are also the deployment's unless it
overrode them.

Environment, shared with the restock step: `P01_TREASURY_TARGET`,
`P01_TREASURY_LOW_WATER`, `P01_TREASURY_MAX_PER_RUN`, `P01_TREASURY_FLOOR`; and
the top-up's own `P01_TOPUP_MIN_LAMPORTS` (default one note, 1,003,000,000) and
`P01_TOPUP_JITTER_MS` (default 10 minutes).

Dry run, from `apps/web`, with the three secrets in the environment:

```
npx tsx scripts/topUpRestockWallet.mts --dry-run
```

The step is `continue-on-error`: a missing float key or a failed transfer shows
as a red step with an `::error::` annotation, and the restock still runs on
whatever the wallet holds.

## What is not done

- The stock count's overstatement (counter 3) is documented, not fixed. Fixing
  it needs either the issuer's KV credentials in the workflow or an unissued
  count on `GET /api/issue-note`; both are deliberate refusals elsewhere.
- The top-up keeps no stored hold between ticks (the settler keeps one in KV).
  Its jitter is a per-run random delay instead, bounded by
  `P01_TOPUP_JITTER_MS`, which does not converge on a constant the way a
  re-drawn threshold would.
- Nothing here has run against devnet yet. The plan and the transaction are
  tested against a stubbed chain (`restockTopUp.test.ts`); the first live tick
  is the measurement.
