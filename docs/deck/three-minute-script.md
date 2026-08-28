# The three minute script

⚠️ GENERATED from `src/plates.py` by `src/build-script.py`. Edit the plates,
then regenerate — an edit made here is lost on the next build, and a plate
edited without regenerating leaves this file saying something the deck no
longer says. That happened: this file carried "every deployed spend
republishes its deposit's commitment" for three days after C7 made it false.

Budget is 145 words a minute. The totals at the bottom are measured, not
estimated.

Read the **spoken** block out loud. What is on the plate is the evidence you
are pointing at, not a script to read back to the room.

## 01 · title · 0:10

**On the plate (21 words):** Styx Get paid monthly. The merchant collects no name, email, or card. SOLANA DEVNET &middot; NOT AUDITED &middot; NO MAINNET DEPLOYMENT

**Spoken (23 words, budget 24):**

> Styx is checkout and subscriptions on Solana. The merchant gets paid on their own schedule, and never collects a name, email, or card.

## 02 · the problem · 0:20

**On the plate (16 words):** The problem Every payment names the payer. Card rails keep the record. Public chains publish it.

**Spoken (48 words, budget 48):**

> Two ways to take a recurring payment today, and both name the payer. Card rails create a customer record that outlives the purchase: the merchant wanted the money and inherited the file. Public chains publish the payer to everyone instead. Nobody chose either. They came with the rails.

## 03 · the demo · 1:00

**On the plate (97 words):** Demo Run it yourself. $ npm install @protocol-01/merchant-sdk @solana/web3.js $ node merchant-gate.mjs vaults on chain : 18 entitlement spread : ended=9 current=7 paused=2 CURRENT 46d6mEYBrktEFqMkhBjLsEA1rJZDmh2DLzmsafPuDjt7 the real subscriber : GRANTED a different merchant : DENIED a made-up subscriber : DENIED is_active on chain : true <- the program never sets it false ENDED 72n5rpWb2qaPSnnzUjbnoWqQ7qJkESWrA3MQbN3K1TZ the real subscriber : DENIED is_active on chain : true demo/merchant-gate.mjs, ABRIDGED &middot; NO KEY, NO SOL, NO ACCOUNT &middot; 273 ms ON 13 AUGUST THIS PROVES ENTITLEMENT, NOT PRIVACY &middot; DEVNET MOVES: READ THE ADDRESSES OFF THE SCREEN, NEVER OFF THIS PLATE

**Spoken (120 words, budget 145):**

> Here is what you can check tonight, from an empty directory, with no key and no SOL. One npm install, one script. It reads the live vaults on devnet and asks the entitlement question three times. The real subscriber is granted. A different merchant asking about the same subscriber is denied. A made-up subscriber is denied. Then an expired one: denied. Two hundred and seventy-three milliseconds, and there was no name in the vault to collect in the first place. Be clear about what that proves: entitlement, not privacy. The privacy claim is a different object, the deposit at leaf seventy-two, and there is a harness in the repo that checks it and reports our own leak as a failure.

## 04 · where the market stops · 0:25

**On the plate (24 words):** Where the market stops Processors keep the customer file. Public chains publish it. Mixers hide one payment, not a schedule. Nobody ships the recurrence.

**Spoken (56 words, budget 60):**

> Look at what exists. A payment processor hides the payment from the chain and keeps the identity: the merchant outsources the customer list and inherits it back in the breach. A public on-chain subscription removes the middleman and publishes the payer instead. And a shielded pool handles one payment beautifully. A subscription is not one payment.

## 05 · what we bring · 0:25

**On the plate (25 words):** What we bring The schedule lives inside the private layer, not beside it. A prepaid vault pays the merchant. No customer file exists to lose.

**Spoken (57 words, budget 60):**

> So we put the schedule inside the private layer instead of beside it. The vault is prepaid and addressed by a commitment to a secret, not by a wallet, so the merchant keeps getting paid and there is no customer file to lose. We wrote the prover and the verifier ourselves, and we publish our own bugs.

## 06 · what a merchant gets · 0:25

**On the plate (17 words):** Today One npm install. The merchant keeps their checkout. We take 1.3%. Live on devnet, not audited.

**Spoken (57 words, budget 60):**

> Today: one npm install, one percent plus three tenths on chain. Behind it: ten of fourteen programs live on devnet, four thousand two hundred and sixteen tests green. The caveat: four of our seven spends still republish their commitment, so the crowd is one. C7 closed the withdrawal and the subscription. Privacy is a crowd that grows.

## 07 · the ask · 0:15

**On the plate (12 words):** The ask One pilot merchant. One funded audit. Break it first: github.com/IsSlashy/Protocol-01

**Spoken (35 words, budget 36):**

> Two things. One merchant with recurring revenue who will pilot this on devnet. And the audit funded, because nothing touches real money before it lands. It is all in the public repo. Go break it.

---

## Totals, measured

| | |
|---|---|
| spoken words | 396 |
| at 145 wpm | 164 s |
| budget | 180 s |
| appendix | 10 plates, 2749 words, never presented |
