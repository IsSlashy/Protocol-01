# Demo runbook — a subscription whose buyer is not on chain

**Written 2026-08-17.** For a live/investor demo on **devnet only**. Read the
"what this is not" section before saying anything on stage; the claim it
supports is narrow and it is checkable by anyone in the room.

---

## 1. The claim, in the exact words it survives

> The wallet that bought this subscription does not appear in any transaction
> on chain. Not in the subscription, not in the deposit that created the note it
> spent, not in the transactions that funded either of them. You can check that
> with three RPC calls, and here is the tool that does it.

That sentence is true under the setup below and false under any other. Every
word of it is measured by `verify/p01-verify.mjs`.

### Why it is true

There are exactly two places a buyer's wallet normally lands on chain, and this
setup removes both:

| channel | normally | here |
|---|---|---|
| the **spend** — subscription fee payer | ephemeral pre-funded by the buyer's wallet, swept back to it | pre-funded by the deployment's **funder**, swept back to it |
| the **deposit** — who put the note in the pool | the buyer's own wallet, by name, because a deposit moves real value in | the **treasury**, because the buyer never deposited: they received the note off chain |

The second row is the whole trick and it is not a trick: a deposit is a transfer
of value into the pool, so *somebody* is named. Make that somebody not be the
buyer.

---

## 2. What this is NOT — say this yourself, before you are asked

**It is not unlinkability.** The subscription publishes the note commitment in
cleartext at instruction byte 160, and the deposit that created the note emitted
that identical value. Anyone matches the two from public data — probe P4 does it
in one hop. So the subscription IS traceable to its deposit. What it is not
traceable to is the buyer, because the deposit names the treasury.

**The link moved off chain, it did not disappear.** Whoever handed the buyer the
note knows who got it. If they keep a record, the link is intact and merely not
public. That is the same trade Tornado Cash made with its relayers and it must
be said in those words, not implied away.

**The anonymity set is the treasury's unspent notes.** Measured 2026-08-16: the
0.1 SOL pool held 34 leaves / 8 unspent, the 1 SOL pool 25 / 6, the 10 SOL pool
0 / 0. Six notes is not an anonymity set. If you deposit four notes for the demo,
say "four", not "the pool".

**The funder is one address serving one deployment.** The observer's uncertainty
grows by log2 of the number of users it serves *concurrently*. On a demo
deployment that is log2(1) = **zero bits**, and `getSignaturesForAddress` on the
treasury enumerates every job it ever paid for. The honest claim is "the buyer's
wallet is not `accountKeys[0]`", never "the transaction is anonymous".

**Devnet only.** The funder route refuses any RPC whose genesis hash is not
devnet's, deliberately. Two fund-loss-class defects are open in the programs
(`unshield` C5 proves no membership; C0 is a spend authorisation) — see the
memory notes. Do not point any of this at mainnet.

---

## 3. Preconditions — check these BEFORE the room

Every failure mode below is **silent at the point of use**: the client catches
it, falls back to the buyer's wallet, and the operation succeeds with the wallet
on chain. You find out when someone opens an explorer.

### 3.1 One request answers three of them

```
curl 'https://<deployment>/api/fund-ephemeral?readiness=1&depositor=<TREASURY_PUBKEY>'
```

Requires `readiness.ready === true`. If it is false, `readiness.reasons` says
which of these it is:

- `P01_FUNDER_TICKET` unset → the POST refuses to run as an open faucet.
- **no KV** → the POST fails closed and the funder never serves. Provision
  `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or the `UPSTASH_` pair).
- RPC not devnet, or unreachable.
- funder balance below one capped grant (2 SOL).
- **the depositor you named IS the funder** → both ends of every subscription
  share one party and probe P8 reports exactly that. Use a different key.

### 3.2 The one thing readiness CANNOT check

`NEXT_PUBLIC_P01_FUNDER_TICKET` is inlined at **build** time. A deployment that
has it set in the dashboard but has not been **redeployed since** serves a bundle
where `funderConfigured()` is `false`, so the browser never calls the endpoint at
all and every job falls back to the wallet — with `readiness.ready === true` the
whole time.

**Redeploy production before the demo.** Then confirm on a real run (§5).

### 3.3 Keys

Three distinct addresses. Getting this wrong is what kills the demo:

| role | must not be |
|---|---|
| **treasury depositor** — deposits the notes | the funder, and not the buyer |
| **funder** — pays the subscription's rent and fees | the depositor |
| **buyer wallet** — connects, imports a note, subscribes | either of the above |

⚠️ If the depositor and the funder were both funded from the same parent (e.g.
both from the upgrade authority `7gWpzSZA…`), an analyst who walks **one hop
further out** than P8 does finds the common parent. P8 says so itself: it closes
one hop and no more. Either fund them from different sources, or be ready to say
this when asked.

---

## 4. The run

Deposits require the C6 prover, which lives in the browser worker, so the
treasury deposits through the UI like anyone else.

1. **Treasury deposits the notes.** Connect the *treasury depositor* wallet to
   `/pay`, shield **N notes** into one pool (0.1 SOL is the cheapest useful one).
   Prepare **at least two**: a note is spent once, and there is no second attempt
   on stage.
   - The deposit screen will say *"Your wallet paid for this, in public."* That
     is correct and it is about the **treasury's** wallet, which is exactly the
     arrangement being demonstrated.

2. **Buyer publishes their receive address.** On the buyer's browser, `/pay` →
   Receive → copy the `p01pq:…` address.

3. **Treasury seals a note to it.** Still on the treasury browser: `/pay` → Send
   → paste the buyer's `p01pq:` address → get a `p01enc1:…` blob. **No
   transaction is created** — nothing to observe, nothing to pair.

4. **Buyer imports.** `/pay` → Receive → paste the blob.
   - 🚨 A received note exists **only in that browser's local storage**. Its
     secrets are not derivable from the buyer's seed, so clearing storage loses
     it and no rescan brings it back. Do not clear the demo browser.

5. **Buyer subscribes.** `/pay` → Subscribe, using the imported note.
   - **STOP IMMEDIATELY** if the progress line says
     `falling back to your wallet`, or if the result paragraph says
     *"Your wallet paid for this, in public."* Either means the funder did not
     serve and the buyer's wallet is now on chain. The result also prints
     `funderFallbackReason` — read it, fix it, use the **second** note.
   - The good outcome reads *"Your wallet did not sign or pay for this
     subscription."*

Cost: roughly 0.3 SOL of devnet SOL per rehearsal.

---

## 5. The proof — run this in front of them

```
node verify/p01-verify.mjs --spend <SUBSCRIPTION_SIGNATURE> \
     --wallet <BUYER_WALLET_PUBKEY>
```

`--wallet` is the point. It asks the one question a structural probe cannot:
*is this specific address in there.* Read out these lines:

| probe | what it should say | what it means |
|---|---|---|
| **P11** | **PASS** — "appears in the account keys of NONE of the N transactions read, each read in full" | ⭐ **this is the audit answer.** See below. |
| **P6** | names the **funder**, and `--wallet: … is NOT among the spend payer's counterparties` | the buyer did not pay for the subscription |
| **P9** | names the **treasury**, and `--wallet: … is NOT among the deposit payer's counterparties` | the buyer did not pay for the deposit either |
| **P8** | disjoint sets, neither containing the buyer | no single wallet funded both ends |
| **P1/P2/P4** | **FAIL** | the subscription is still publicly matchable to its deposit — read this out too, it is the honest half |

### Why P11 is the one to put in front of an auditor

Every other probe reasons about **edges** — who paid whom, decoded out of System
instructions. An auditor does not decode anything. They run this:

```powershell
$r.result.transaction.message.accountKeys | ForEach-Object { $_.pubkey }
```

One line, one RPC call, every account the transaction names. An address can sit
in that list as a read-only account, a co-signer or a bare program argument,
move **not one lamport**, and be invisible to P6/P8/P9/P10 while being the first
thing that output prints.

**P11 is that method, run over every transaction reachable from the spend** —
the spend itself, its payer's whole life, the deposit payer's whole life. It is
the probe that answers the question actually being asked.

⚠️ **A P11 pass is only as good as the walk behind it.** The walks stop early
when they *find* an edge, so on a leaky payer they may have read 2 transactions
of 172 — and "not in those 2" is not "not in the 172". P11 reports INCONCLUSIVE
with the arithmetic printed whenever that happens. **If it says INCONCLUSIVE, do
not present it as a pass.**

⚠️ And read the scope aloud: P11 covers the transactions **reachable from this
spend**. It says the address is not in this operation. It never says the address
is unused, or that no other operation names it.

⚠️ The run will **exit 1** and several probes will be red. Do not hide that; it
is the tool refusing to call a partially-open system clean, and it is the reason
the green lines are worth anything. A tool that agreed with you about everything
would be evidence of nothing.

To make it replayable without a live RPC — worth doing before the room, because
the public devnet endpoint throttles:

```
node verify/p01-verify.mjs --spend <SIG> --record verify/fixtures/demo-treasury
node verify/p01-verify.mjs --self-test --replay verify/fixtures/demo-treasury
```

The recorded fixture also fills a real gap: **no committed fixture currently
exercises P10's PASS or FAIL branches**, because all three are subscribes or
synthetic v4s. Recording a real withdrawal would close that.

---

## 6. If someone asks "so is it private?"

The true answer, short:

> The buyer is not in these transactions. The subscription is still publicly
> matchable to the deposit that funded it, because the note commitment is
> published in the clear — that is a program-level fact and it needs a
> redeploy, which is frozen until 4 September for measured soundness reasons.
> What we removed is the payer channel, which was the cheapest attack: three
> RPC calls and no cryptography. What remains is the commitment channel, and we
> ship the tool that measures it.

See `docs/PLAN-v4-commitment-channel.md` for what closing the rest requires.
