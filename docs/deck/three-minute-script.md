# The three minute script

Generated from `src/plates.py`, so it cannot drift from the deck. Budget is 145
words a minute, a brisk pitch pace and not a comfortable one. The totals at the
bottom are measured, not estimated.

Read the **spoken** block out loud. What is on the plate is the evidence you are
pointing at, not a script to read back to the room.

## 01 · title · 0:10

**On the plate (12 words):** Styx Get paid monthly. The merchant collects no name, email, or card.

**Spoken (23 words of a 24 word budget):**

> Styx is checkout and subscriptions on Solana. The merchant gets paid on their own schedule, and never collects a name, email, or card.

## 02 · the problem · 0:20

**On the plate (16 words):** The problem Every payment names the payer. Card rails keep the record. Public chains publish it.

**Spoken (48 words of a 48 word budget):**

> Two ways to take a recurring payment today, and both name the payer. Card rails create a customer record that outlives the purchase: the merchant wanted the money and inherited the file. Public chains publish the payer to everyone instead. Nobody chose either. They came with the rails.

## 03 · the demo · 1:00

**On the plate (4 words):** Demo Run it yourself.

**Spoken (120 words of a 145 word budget):**

> Here is what you can check tonight, from an empty directory, with no key and no SOL. One npm install, one script. It reads the live vaults on devnet and asks the entitlement question three times. The real subscriber is granted. A different merchant asking about the same subscriber is denied. A made-up subscriber is denied. Then an expired one: denied. Two hundred and seventy-three milliseconds, and there was no name in the vault to collect in the first place. Be clear about what that proves: entitlement, not privacy. The privacy claim is a different object, the deposit at leaf seventy-two, and there is a harness in the repo that checks it and reports our own leak as a failure.

## 04 · where the market stops · 0:25

**On the plate (24 words):** Where the market stops Processors keep the customer file. Public chains publish it. Mixers hide one payment, not a schedule. Nobody ships the recurrence.

**Spoken (56 words of a 60 word budget):**

> Look at what exists. A payment processor hides the payment from the chain and keeps the identity: the merchant outsources the customer list and inherits it back in the breach. A public on-chain subscription removes the middleman and publishes the payer instead. And a shielded pool handles one payment beautifully. A subscription is not one payment.

## 05 · what we bring · 0:25

**On the plate (25 words):** What we bring The schedule lives inside the private layer, not beside it. A prepaid vault pays the merchant. No customer file exists to lose.

**Spoken (57 words of a 60 word budget):**

> So we put the schedule inside the private layer instead of beside it. The vault is prepaid and addressed by a commitment to a secret, not by a wallet, so the merchant keeps getting paid and there is no customer file to lose. We wrote the prover and the verifier ourselves, and we publish our own bugs.

## 06 · what a merchant gets · 0:25

**On the plate (17 words):** Today One npm install. The merchant keeps their checkout. We take 1.3%. Live on devnet, not audited.

**Spoken (59 words of a 60 word budget):**

> What a merchant does today: one npm install, and we take one percent plus three tenths on chain. Behind it: ten of our fourteen declared programs live on devnet, four thousand two hundred and sixteen tests green. And one caveat before you find it: the anonymity set today is effectively one, because every deployed spend republishes its deposit's commitment.

## 07 · the ask · 0:15

**On the plate (12 words):** The ask One pilot merchant. One funded audit. Break it first: github.com/IsSlashy/Protocol-01

**Spoken (35 words of a 36 word budget):**

> Two things. One merchant with recurring revenue who will pilot this on devnet. And the audit funded, because nothing touches real money before it lands. It is all in the public repo. Go break it.

---

**Total: 398 spoken words across 180 seconds of budget.**
At 145 words a minute that is 165 seconds, leaving 15 seconds of slack,
which is deliberate: the demo plate is the one place a live run can stall.

## What is deliberately not said

Written, measured against the repo, cut. Each one fails in the first question:

- **"a test in CI asserts the buyer is absent"** — the assertion exists, but its suite is `describe.skipIf(!LIVE)` behind `P01_LIVE_RELAY=1`, which CI never sets.
- **"77,965 bytes against 258,958"** — 258,958 is the C1+C3 pair from *before* the B4 pair-leaf change of 28 July. Measured today: C1 68,881 + C3 78,157 = **147,038**, confirmed by a live scan of a real upload (`verify/README.md:261`). The cut is 1.9x, not 3.3x. ~~Three comments in this repo still carry the stale figure.~~ All three were corrected on 26 August, along with a fourth in `docs/C7_SPEND_CIRCUIT_PLAN.md` that this note had missed.
- **"purchase to running subscription in 167.76 seconds"** — the run happened; the branch and tag named for that freeze are absent from this repo, so it is not reproducible.
- **"one proof now does the work of two"** — still cut, but the reason changed on 25 August and the new one is sharper. C7 **is** deployed and one real withdrawal landed on it (`22psv1tF…`, no commitment on the wire). What is not true is that anything *uses* it: web, extension and mobile all still call the v3 pair, pinned at `apps/web/lib/privacy/pool/spendRouting.test.ts`. And C7 covers the **withdrawal only** — there is no C7 subscription, so the flow this deck is about still republishes the commitment. Say it and the first question is "on which spend?".
- **"our fee is 1%"** — 1% operator plus 0.3% on-chain shield is 1.3% today on a 1 SOL relayed deposit.
- **"an anonymity set of 47"** — 47 is a ceiling. The effective set today is one, and plate 06 volunteers it out loud before a judge finds it.
- **"ten programs live"** without the denominator — always 10 of 14, and A3 names the four that resolve to null.
- **anything with the word cancel or renew** — neither instruction exists. A9 says so.
- **"no customer record anywhere"** — true of the merchant, false of the chain: the buyer's payment to the till one hop earlier names their wallet.
- **"nobody can re-derive an address"** — say there is no address to re-derive, and add that vaults stay enumerable.

## What the demo proves, and what it does not

`demo/merchant-gate.mjs` proves **entitlement**, not privacy: its first call is a
`getProgramAccounts`, which is the enumeration limit A8 confesses to. Say so on
the plate, because a judge who spots it unprompted has caught you overselling.
The privacy claim is a different object: the leaf 72 deposit, plus
`verify/p01-verify.mjs`, which runs offline and reports our own v3 commitment
leak as FAIL on purpose.

⚠️ The transcript on the plate is a **13 August run, abridged**. Devnet moves:
the addresses and the ended/current spread will differ. Read them off the screen,
never off the plate. Two of those eighteen vaults are legacy normal-mode and name
the subscriber's wallet in the clear.
