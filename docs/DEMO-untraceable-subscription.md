# Demo runbook — a subscription whose buyer is not on chain

---

## 0. THE TEST YOU ARE ABOUT TO RUN — read this first

> **If you shield a note and then subscribe with it from the same wallet, the app
> will now REFUSE, and it is right to.**

That is not a bug and it is not a regression. Spending a note republishes its
deposit's identifier in the clear, so an auditor walks
`subscription → deposit → whoever paid for the deposit` in one hop. If that is
you, then paying for the subscription through the funder buys **nothing** — you
are still one hop away through your own deposit. The app used to let you do it
and say nothing; now it stops and tells you why.

### So the test needs TWO wallets

| | role | must hold |
|---|---|---|
| **A** | deposits the notes (the "treasury") | **1.58 SOL at peak, ~1.01 SOL net, PER NOTE** — and it must NOT be the funder key |
| **B** | the buyer: imports a note, subscribes | nothing — it never pays for anything |

🚨 **CE QUE COÛTE UNE NOTE, MESURÉ — et pourquoi A peut être trop pauvre.**
Un dépôt de 1 SOL préfinance **1 573 486 080 lamports** (`shieldEphemeral.ts:270`),
dont **1 003 000 000** de valeur — dénomination + 0,3 % de frais protocole,
calculé et non retenu de mémoire (`shieldEphemeral.ts:293`) — et **570 486 080**
de rente de preuve, de budget de frais et de marge, *remboursable*. Donc, par
note : **1,5735 SOL au pic**, **1,003 SOL net**. Deux notes en série :
**1,5735 au pic**, **2,006 SOL net**.

> ⚠️ Ne pas citer « 1 003 475 300 de valeur ». Ce chiffre circulait dans un
> commentaire du dépôt et découpait le total au mauvais endroit : les 475 300
> d'écart sont de la rente de tampon, pas de la valeur. Corrigé le 21-08 à la
> source. Sur le chemin **relayé**, la valeur est exactement ce que le
> portefeuille envoie à la caisse, donc l'erreur se voyait sur la facture.

⛔ **Compter AVANT de partir.** Au 2026-08-21 l'autorité
`7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU` détient **1,4558 SOL** — sous le
pic d'**une seule** note. Le dépôt échouerait, et il échouerait **tard** : le
garde-fou de solde du harnais est à 0,5 SOL, donc rien ne se déclenche avant la
preuve C6, ~3 minutes plus tard, où la panne se lit comme un shield cassé et non
comme un manque de fonds. Vérifier le solde est la première chose à faire, pas
la dernière.

🚨 **AND IF B EVER PAYS FOR ITS NOTE ON CHAIN, IT MUST NOT PAY THE FUNDER.**
That is the walk measured on 2026-08-18, and it survives everything above: the
buyer paid the funder 1.003 SOL, the funder financed the depositing ephemeral one
second later, and P11 read it in two hops. Two transfers, neither naming both
ends, joined by an address whose own history names both.

## ⛔ Les deux règles d'exploitation que rien ne peut appliquer à ta place

Elles portent sur des clés que **l'opérateur** détient hors chaîne, délibérément : une
caisse que le déploiement pourrait dépenser serait un second flotteur, et la séparation
R≠F s'effondrerait. Aucun code ne peut donc les refuser. Les invariants sont écrits dans
`app/api/relay-to-buyer/route.ts` et épinglés par `lib/privacy/pool/topologyInvariants.test.ts`.

### 1. Un reversement caisse → flotteur doit porter PLUSIEURS achats

Le seul mouvement de valeur de R vers F est un reversement, et il **emporte toutes les
adresses que la caisse nomme**. Un auditeur marche `dépôt → éphémère → flotteur →
son historique → caisse → son historique` et arrive sur l'ensemble de ceux qui ont payé la
caisse. **Reverser un seul achat identifie exactement son acheteur.** Deux règles, les deux
portantes :

- **au moins N achats**, pour que l'ensemble ait une largeur ;
- **à un moment sans rapport avec aucun d'eux**, parce qu'un virement qui suit un dépôt de
  quelques minutes les réapparie par l'horloge même si les montants ne le font pas, et
  l'horloge est publique.

🚨 **Cette règle a déjà été violée une fois, le 2026-08-22, par moi** : un dépôt unique
reversé à la main quelques minutes plus tard, ce qui a créé `flotteur → caisse → acheteur`
pour la feuille 72. Mesuré, pas hypothétique.
✅ **Détectable** : `node verify/deposit-walk.mjs --wallet <adresse> --deposit <signature>
--till <caisse>` lit l'historique de la caisse et dit combien d'adresses un reversement
emporterait. Un ensemble de un n'est pas un ensemble.

### 2. Rien de ce que paie le puits ne doit financer ce protocole

Les 1 % voyagent **dans la transaction que l'acheteur signe**, donc
`getSignaturesForAddress` sur le puits **énumère tous les clients** du déploiement. S'il
finance un jour un éphémère ou le flotteur, la sonde P11 marche
`puits → éphémère → abonnement` et retombe sur un acheteur — et comme le puits les nomme
**tous**, un seul virement expose la liste entière d'un coup, pas un acheteur.

⚠️ **L'interdiction est plus étroite que « ne jamais dépenser », et l'élargir la rend facile
à ignorer.** Encaisser ton revenu vers un portefeuille froid qui ne touche jamais ce
protocole révèle **l'opérateur**, pas les acheteurs : c'est un fait commercial, pas une
fuite. Ce qui ne doit jamais arriver, c'est que le puits finance quelque chose qui finira
par payer un dépôt ou une dépense.

✅ **Partiellement détecté par le déploiement lui-même** : la readiness de
`/api/relay-to-buyer` intersecte les signatures du puits et du flotteur. S'ils ont jamais
partagé une transaction, elle passe `ready: false` et refuse de servir — parce qu'un
déploiement dans cet état produit des dépôts qui **paraissent** privés et ne le sont pas,
ce qu'un acheteur ne peut ni détecter ni annuler. ⚠️ Le champ `sinkFundedFloat` vaut `null`
quand la question n'a pas pu être tranchée : inconnu, pas propre.

---

So the address that COLLECTS money from buyers — **R, the till** — must never be
the address that FUNDS ephemerals — **F, the float**. Declare R in
`P01_TILL_ADDRESS` (public key only) and the deployment refuses to serve when
they are the same; leave it unset and readiness says so. R and F may settle with
each other, but in batches, on a schedule unrelated to any single purchase — one
transfer per purchase is the same leak wearing a second address, and readiness
reports that too.

✅ The demo path avoids the question entirely: the buyer pays **nothing on
chain**, they redeem a claim code for a pre-deposited note. Nothing to correlate.

⚠️ **A must not fund B.** If it does, an auditor who walks one hop further out
than probe P8 does finds the common parent. Fund them from different sources, or
be ready to say so when asked.

### The shape

```
A:  /app → Shield        deposit 2 notes into the 1 SOL pool   ← the ONLY open pool
B:  /app → Receive       copy the p01pq:… address
A:  /app → Send          seal a note to B's address   ← no transaction at all
B:  /app → Receive       paste the blob
B:  /app → Subscribe     keep "Never pay for this from my wallet" TICKED
```

Two notes, not one. A note is spent once and there is no second attempt.

### What you should see, and what must stop you

| screen says | meaning |
|---|---|
| ✅ *"Your wallet did not sign or pay for this subscription."* | the funder paid — good |
| ⛔ *"This note was deposited by your own wallet"* | you used A's wallet to subscribe, or skipped the handoff |
| ⛔ *"This note's deposit could not be found"* | the RPC pruned it. **Unknown is not safe** — retry on a fuller RPC |
| ⛔ `falling back to your wallet` | the box was unticked. Stop, fix the funder, use note #2 |
| ⛔ *"Your wallet paid for this, in public"* | same. Stop |

Then prove it (§5), with `--wallet <B>`.

---

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

### 2.0 Name the protected set out loud, first

This defends against **a passive third-party chain analyst** — someone with a
public RPC and nothing else. It does **not** defend against three parties who
each hold the link by construction, and someone in the room will derive that
list if you do not say it:

**The MERCHANT, and it is the cheapest attack of all.** The retailer is
`accountKeys[1]` of the subscribe, in cleartext, in the transaction the auditor
already has. `license_commitment` is stored verbatim on chain
(`subscribe_private_stark.rs:413`), and the shipped SDK does
`blake3(decodeLicenseKey(key))` → matched vault and **returns it**
(`packages/merchant-sdk/src/license.ts:317-335`). The buyer **must** present that
key to get the thing they bought. Cost to the merchant: one hash and one
`getProgramAccounts`. Nothing in this plan, in `PLAN-v4`, or in C7 touches it,
and **zero probes look at it.**

**The NOTE ISSUER needs no records.** §2 used to say "if they keep a record" —
that is materially too weak. Note secrets are `HKDF(treasurySeed, poolPDA,
counter)`, enumerable offline forever, and `subscriber_commitment`,
`license_commitment`, the nullifier and the vault PDA are each a pure function of
that secret. The treasury identifies every subscription it seeded by table
lookup — with byte 160 deleted, and after any redeploy. Against the issuer the
anonymity set is **one, unconditionally and permanently**.

**A NOTE SECRET MUST NEVER SERVE TWO OPERATIONS — and nothing enforces it.**
The paragraph above says the vault PDA is a pure function of the note secret,
and states that against the ISSUER. It has a second consequence, against
EVERYONE, and it is the one that will be tripped over first. The vault seed is
`[SEED_PREFIX, retailer, subscriber_id_bytes(), token_mint]`
(`subscribe_private_stark.rs:89-95`) and in private mode `subscriber_id_bytes()`
is `Poseidon(secret)`. So **two operations sharing a secret land on correlated
vault addresses, in `accountKeys`, in the clear.** Any renewal, second
subscription or recovery must derive a FRESH secret.

⚠️ **The property holds by usage, not by construction.** No on-chain check
refuses a reused secret. It is safe today only because the client mints one
secret per note and spends each note once. The obvious way to implement "renew
this subscription" — reuse the subscriber's secret so the vault is found again —
creates the linkage silently, and no test on chain goes red. The invariant is
written at `subscription_vault.rs:159` and pinned by three tests in
`tests/landed_invariants.rs`; the comment IS the control.

MEASURED 2026-08-20, and it is why the invariant is worth writing rather than
assuming: the vault address is **not** derivable from the public deposit leaves.
All 35 leaves of the 1 SOL pool were harvested from their shield instructions and
run through the real derivation — **zero** reproduced a live vault, while the
`subscriber_commitment` read back out of the account reproduced it exactly. An
observer holding the public tree therefore cannot enumerate candidate vaults. The
secret is the whole of what stands between them and the link, and reusing it is
what hands it over.

The nullifier is not an alternative seed: it is also `f(secret)`, so it buys
nothing against leaf enumeration, and it is PUBLISHED in
`SubscribePrivateStarkEvent` — seeding on it would make the vault address
computable from a public log. Strictly worse.

**The RPC PROVIDER is a stronger observer than the funder.** `PayApp.tsx:129`
hands the pool worker the same endpoint the wallet adapter uses, so one provider
account, one API key, one session sees the connected wallet's own queries **and**
all ~172 ephemeral sends inside one ~80-second window. Every document names the
funder as the off-chain observer; the funder sees one address and one amount,
once.

**It is not unlinkability.** The subscription publishes the note commitment in
cleartext at instruction byte 160, and the deposit that created the note emitted
that identical value. Anyone matches the two from public data — probe P4 does it
in one hop. So the subscription IS traceable to its deposit. What it is not
traceable to is the buyer, because the deposit names the treasury.

**The link moved off chain, it did not disappear.** Whoever handed the buyer the
note knows who got it. If they keep a record, the link is intact and merely not
public. That is the same trade Tornado Cash made with its relayers and it must
be said in those words, not implied away.

**The anonymity set is ONE note — never quote a pool count.** An earlier version
of this document said "the treasury's unspent notes" and cited "6 unspent". That
is wrong and the code contradicts it: `stark_commitment` at byte 160 names **one
specific leaf**, and P4 resolves it to its deposit in one hop — measure 1, pinned
in the committed fixture. The note count never enters the auditor's computation
at all. Say: **"one note — and it names the treasury, not the buyer."** That is
the real claim and it is a good one. Inflating it to six invites someone to check.

Worse if pressed: every deposit also names its `depositor: Signer`, so the tree
partitions by depositor in ~48 RPC calls and the treasury's notes are a publicly
labelled block. Recensement du 2026-08-20, sur les deux seuls pools non vides :
pool 1 SOL `6NUS4E5Ph…` 34 feuilles / 11 notes non dépensées ; pool 0,1 SOL
`HfSsGRgV…` 39 feuilles / 10 non dépensées, **fermé aux dépôts mais toujours
dépensable**. On ferme l'entrée, jamais la sortie.

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
| **funder (F)** — pays the subscription's rent and fees | the depositor, and never paid by a buyer |
| **till (R)** — collects money from buyers, if any is collected | the funder. Never funds anything, never deposits |
| **buyer wallet** — connects, imports a note, subscribes | any of the above |

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
   `/app`, shield **N notes** into the **1 SOL** pool — the only one still open
   to deposits (`denominatedPool.ts:214`, `:271`; refused in the engine at
   `worker/poolHandlers.ts:1421`, before the ~2-minute C6 proof).
   Prepare **at least two**: a note is spent once, and there is no second attempt
   on stage.
   - The deposit screen will say *"Your wallet paid for this, in public."* That
     is correct and it is about the **treasury's** wallet, which is exactly the
     arrangement being demonstrated.

2. **Buyer publishes their receive address.** On the buyer's browser, `/app` →
   Receive → copy the `p01pq:…` address.

3. **Treasury seals a note to it.** Still on the treasury browser: `/app` → Send
   → paste the buyer's `p01pq:` address → get a `p01enc1:…` blob. **No
   transaction is created** — nothing to observe, nothing to pair.

4. **Buyer imports.** `/app` → Receive → paste the blob.
   - 🚨 A received note exists **only in that browser's local storage**. Its
     secrets are not derivable from the buyer's seed, so clearing storage loses
     it and no rescan brings it back. Do not clear the demo browser.

5. **Buyer subscribes.** `/app` → Subscribe, using the imported note.
   - ✅ **Leave "Never pay for this from my wallet" TICKED.** It is on by default
     wherever a funder exists. With it on, a funder that cannot serve makes the
     subscription **stop before spending anything** instead of quietly charging
     the buyer's wallet in public. That converts the demo's worst outcome —
     silent, permanent, discovered by whoever opens an explorer — into a visible
     error you can fix before anyone sees it.
   - If it stops, the error carries the funder's own reason. A 429, a rotated
     ticket and a drained treasury need three different fixes; read it, fix it,
     and use the **second** note.
   - **STOP IMMEDIATELY** if you ever see the progress line
     `falling back to your wallet`, or a result paragraph saying *"Your wallet
     paid for this, in public."* Either means the box was unticked and the
     buyer's wallet is now on chain.
   - The good outcome reads *"Your wallet did not sign or pay for this
     subscription."*
   - ⚠️ The buyer's wallet does sign ONE thing: a `signMessage` to derive their
     pool seed. That is a signature over a string, **not a transaction** — it
     creates nothing on chain and no RPC method can see it. Say so if asked;
     it looks like a wallet interaction and is not one.

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
| **P1/P2/P4** | **PASS** on a circuit 7 spend | no commitment on the wire, so there is nothing to match the deposit on. ⚠️ On a v3 spend these read **FAIL** — read that out too, it is the honest half |
| **P9** | **FAIL**, pinned, on a circuit 7 spend | P9 reaches the deposit through the commitment and circuit 7 publishes none, so it cannot look. A consequence of the win, not a leak; the deposit side is what P11 covers by walking every reachable transaction |
| **P8** | **FAIL**, pinned, for the same reason | it needs the deposit P4 could not find. On a v3 spend it reads the two funder sets and expects them disjoint |

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

### 🚨 Record the fixture WITH `--wallet`, or P11 cannot pass

Naming an address makes the payer walks read the **whole** history, because an
absence is only credible from a complete read. A fixture recorded without
`--wallet` holds only the two ends of each payer's life, and replaying it
exhaustively hard-stops on the first transaction nobody recorded. The walk depth
is written into the manifest, so a shallow fixture replays shallow and P11
truthfully says INCONCLUSIVE.

```
node verify/p01-verify.mjs --spend <SIG> --wallet <BUYER> --record verify/fixtures/demo-treasury
node verify/p01-verify.mjs --self-test --replay verify/fixtures/demo-treasury
```

Do this **before** the room. The public devnet endpoint throttles, and the
exhaustive walk is ~268 extra `getTransaction` calls — paid once at record time,
free on every replay after.

### 🚨 Re-run verify after ANY Recover click

Recovery decides where a stranded ephemeral's residue goes, and one of those
ephemerals is the one that signed the subscription. A recovery that cannot
attribute the float now refuses — but a click that happens after your green run
is a change to the chain that your green run did not measure. If someone presses
Recover, the report is stale.

The recorded fixture also fills a real gap: **no committed fixture currently
exercises P10's PASS or FAIL branches**, because all three are subscribes or
synthetic v4s. Recording a real withdrawal would close that.

---

## 6. If someone asks "so is it private?"

The sentence that survives being checked, and only this one:

> The buyer's wallet address does not appear in the account keys of any
> transaction reachable from this subscription — not the spend, not the spend
> payer's history, not the deposit payer's history. Here is the tool, here is
> the fixture, run it yourself.
>
> That is a statement about this operation. It is **not** a statement that the
> buyer is unfindable. The merchant who validates their license key holds
> customer-identity ↔ vault ↔ this transaction. Whoever handed them the note can
> regenerate that link from their own seed without keeping any record. And the
> anonymity set is one note, which names the treasury rather than the buyer.

### Words that may not be said

- **"untraceable"** — still forbidden, and the reason changed on 2026-08-25.
  The commitment link is closed: circuit 7 publishes none, and on 2026-09-01 P11
  found the buyer's wallet in **none of 109 transactions across 3 surfaces**, 0
  open linkages. What forbids the word now is the **fee payer**: P6 fails
  structurally and always will, so the link is moved onto the float rather than
  removed, and five probe channels are unread. Unread is not closed.
- **"unlinkable"** — sayable ONLY with its scope attached, never bare.
  *Unlinkable on this spend, measured against this probe suite, on devnet.* Drop
  any of the three qualifiers and it becomes a claim about the world that nobody
  has tested.
- **"the anonymity set is sixty-one"**, or any number derived from a pool's note
  count, offered as a privacy claim. The number is true — 61 unspent of 101
  deposited — and it is small. State it as a fact, never as a guarantee.
- **"no one can tell which subscription is yours"** — the issuer always can, and
  the merchant does the moment you use the thing you bought.
- **"zero-knowledge"** of anything the prover produces. The prover is not ZK.
  ⚠️ The sentence that used to follow — *this repo has an executable positive
  control that recovers a private witness* — stopped being true on 2026-08-31:
  the mask landed on C1, `stark/tests/air_aware_recovery_c1.rs` now reads
  under-determined and keeps the pre-mask model beside it, still solving. Five
  channels are measured uniform on C7 and the simulator is run against the
  verifier's own equations (`compact::zk_hiding`, 15 tests, exhaustive over every
  committed value). That changes the evidence, not the verdict: an argument
  executed on two witnesses and at the shipping query count, with the hash oracle
  programmed, is
  not a theorem over all of them, so the word stays banned. See
  `docs/zk-simulation-argument.md` §5.
- **"the buyer's wallet signs nothing"** — not before confirming on a real run
  that the result says the funder paid. On a bundle built before the funder was
  configured, it signs the pre-fund.
- **"P11 passed"** if it printed INCONCLUSIVE. Read the arithmetic instead.

See `docs/PLAN-v4-commitment-channel.md` for what closing the rest requires.
