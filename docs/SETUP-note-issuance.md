# Setting up note issuance — so a buyer needs one wallet and one click

**Written 2026-08-17. Devnet only.** Everything below refuses on any RPC whose
genesis hash is not devnet's.

This is the configuration behind "the buyer does not deposit the note they
spend". Without it the Subscribe tab cannot issue a note and the buyer is back
to depositing their own — which links every subscription to them in one hop.

---

## What you are building

```
treasury wallet A  ──shield──▶  notes sit in the pool, deposited by A
                                        │
buyer wallet B  ──Subscribe──▶  claim redeemed → a note is sealed to B
                                        │
                                B subscribes; the funder pays the fees
```

B never deposits, never signs a transfer, and is in no transaction's account
keys. An observer who walks `subscription → commitment → deposit` lands on **A**.

⚠️ **A must not be the funder key**, or both ends of every subscription share one
party and probe P8 reports exactly that. Check with
`GET /api/fund-ephemeral?readiness=1&depositor=<A>`.

---

## 1. Deposit the notes (once, by hand)

Connect **wallet A** to `/app` and shield into the **1 SOL** pool. Deposit as
many as you want issuable; each one is real money you are giving away.

> ⛔ **This step used to say 0.1 SOL, and following it was impossible.** That pool
> has carried `deposits: 'closed'` since the founder decision of 21 August
> (`denominatedPool.ts`), so a restock attempt is refused before it starts —
> and the instruction survived a week because nobody restocked in that week.
> One denomination is open, and it is the one the demo spends from. Splitting the
> crowd across two denominations is the thing that decision exists to prevent:
> 53 notes and 45 notes are two crowds, never one of 98.
>
> ⚠️ It also makes each issuable note cost **1 SOL instead of 0.1**. That is the
> real price of this path, and it is why the inventory is small.

When the deposit screen asks *"What is this deposit for?"*, answer **"To hand to
someone else"**. That is what these notes are.

**Write down each note's leaf index.** It is on the result screen
(`leaf #23 · commitment …`) and in the note list.

## 2. Get A's pool seed

The seed is derived in the browser from A's wallet signature and lives in the
worker. Nothing on a server can derive it, so it has to be exported once.

Still connected as **A**, open:

```
https://<deployment>/app?treasury=1
```

⚠️ The route is **`/app`**, not `/pay`. The panels live under the `(pay)` route
GROUP (`app/(pay)/app/page.tsx`), and a parenthesised segment does not appear in
the URL — so `/pay` is a 404 and every doc that says otherwise sends the operator
to a blank page.

Three things must all be true before the box exists, because `PoolPanel` is
mounted only when they are (`PayApp.tsx:460`):

1. wallet **A** connected, chain **Solana**;
2. the **derivation message signed** — a `signMessage`, not a transaction: it
   creates nothing on chain and no RPC method can see it. Reject it and the
   worker holds no keys, so the export answers *"No pool keys for this
   identity"*;
3. the **Deposit** tab opened at least once.

A Phantom disconnect unmounts the panel and drops the derived keys, so the box
vanishing mid-setup usually means the wallet locked or switched account, not
that anything broke.

The Deposit panel gains a red **"Reveal pool seed"** box. Press it and copy the
64 hex characters.

The `?treasury=1` flag is not a permission check — anyone can type a query
parameter — it exists so this control can never appear in front of an ordinary
user by accident, which is the failure that actually happens.

> ⛔ **This is the most dangerous value in the app.** Whoever holds it derives
> every secret, every nullifier and every commitment of every note this identity
> will ever own, and can spend all of them — including notes not yet created.
> Put it in a server environment variable and nowhere else. Never in a browser
> bundle, never in a repo, never in a chat.

If the response says `hasLegacySeed: true`, this wallet adopted a passphrase and
its older notes derive from a different seed. Issue only notes shielded under
the active one, or the on-chain check in step 5 will refuse them.

## 3. Environment variables

| variable | what it is |
|---|---|
| `P01_TREASURY_POOL_SEED` | 64 hex characters from step 2 |
| `P01_TREASURY_NOTE_LEAVES` | the leaf indices from step 1, e.g. `23,24,25` |
| `P01_CLAIM_MINT_SECRET` | ≥16 characters, server-only. **Not** the funder ticket — that ships in the browser bundle |
| `P01_FUNDER_TICKET` | already set for the funder; also authorises the issue request |
| `P01_FUNDER_SECRET_KEY` | already set; pays the subscription's fees |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | **required.** No durable store, no issuance and no funder — both fail closed |

Then **redeploy**. `NEXT_PUBLIC_P01_FUNDER_TICKET` is inlined at build time, so a
deployment that sets it without rebuilding serves a bundle that never calls the
funder at all and silently charges the buyer's wallet.

## 4. Check before you need it

```
curl 'https://<deployment>/api/issue-note'
curl 'https://<deployment>/api/fund-ephemeral?readiness=1&depositor=<A>'
```

Both list what is missing by name. Every failure they cover is otherwise silent
at the point of use: the client catches it, falls back, and the operation
succeeds with the buyer on chain.

## 5. Mint a claim

A note is the denomination itself, so one is issued per **claim**, and a claim
is created when a payment settles. Until a payment webhook exists, mint by hand:

```
curl -X POST 'https://<deployment>/api/mint-claim' \
  -H 'x-p01-claim-mint: <P01_CLAIM_MINT_SECRET>' \
  -H 'content-type: application/json' \
  -d '{"reference":"manual test"}'
```

Returns a `claimCode`, good for **one** note, expiring in 24 hours.

🚨 **It is consumed on first redemption whether or not a note is delivered.** If
issuance fails after that, mint a new claim — do not retry. That rule is what
stops a guessed code being retried until it works, and it is why a failure needs
`Recover` rather than a second redemption.

## 6. Test it

Connect **wallet B** — a different browser profile is enough, it does not need
SOL — go to Subscribe, pick a vendor, paste the claim code, and press Subscribe.

| you should see | meaning |
|---|---|
| *"You hold no note, so one will be issued to you"* | the issuance path is live |
| *"Your wallet did not sign or pay for this subscription"* | the funder paid |
| **no** *"This note was deposited by your own wallet"* | B is not the depositor |

Then prove it:

```
node verify/p01-verify.mjs --spend <SIG> --wallet <B> --record verify/fixtures/demo-treasury
```

Record **with `--wallet`**: naming an address makes the payer walks exhaustive,
and a fixture recorded without it cannot serve that walk on replay.

---

## What this does not do — the part to say first

**It does not hide the buyer from us.** The note's secrets are
`HKDF(treasurySeed, pool, counter)`, enumerable offline forever from the seed in
step 2. So `subscriber_commitment`, the nullifier and the vault PDA of every
subscription bought with an issued note are each a pure function of a value this
server can regenerate — **with no records kept and no log written**. Against the
issuer the anonymity set is one, permanently, and it stays one after any
redeploy.

**It is custody between payment and spend.** Holding the seed means the
deployment can spend an issued note itself until the recipient does.

**The merchant still holds the link.** `license_commitment` is stored verbatim
on chain and the shipped SDK maps a presented key to its vault. The buyer must
present that key to get what they bought.

The honest claim is in `docs/DEMO-untraceable-subscription.md` §6, with the list
of words that may not be said.
