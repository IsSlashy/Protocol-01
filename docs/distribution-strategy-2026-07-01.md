# Distribution Strategy — Protocol 01 / Volta
**Date: 2026-07-01 · Horizon: 8 weeks · Goal: first real revenue**

*Produced by a 33-agent adversarial brainstorm: repo crawl → 7 GTM lenses (29 ideas) → merge (11 distinct) → 2 skeptics per idea (2 survived, 9 killed) → synthesis.*

---

## 1. The core diagnosis

Your target market feels no pain because you are selling invisibility to consumers who can't move real money through your product (devnet), don't wake up worried about chain surveillance, and can't be reached without an audience you don't have. Privacy is a vitamin for them, and even funded, audited, mainnet competitors (Elusiv, Light's pivot) failed to make it a business. The one market that bleeds *today* and is reachable through networks you are already inside is **other builders**: Solana ZK teams staring at mainnet deadlines who are freshly terrified of exactly the bug class you found in your own circuits, and grant programs whose literal job is to fund shipped work. The reframe: for the next 8 weeks, Protocol 01 is not the product — it is the proof-of-work portfolio. **You** are the product: one of very few people alive who solo-built a 124-bit on-chain STARK verifier, then caught and shipped fixes for Orchard-class under-constraints in his own production circuits. Sell that expertise for cash now; use the cash and third-party reputation to fund the external audit that unlocks the actual product later.

---

## 2. The single greatest move

**Combine the two survivors, in strict sequence: claim the owed money in 48 hours, then spend the remaining window building a paid ZK-engineering-and-review practice through Volta.** They genuinely compound: the tranche-2 filing is ~2 hours of work for near-certain cash and re-opens a warm Superteam channel; every grant reviewer, bounty sponsor, and hackathon judge you touch becomes a warm lead for the services offer; the same post-mortem content works as grant proof-pack and as sales collateral.

Why this survives every constraint: it needs zero new product code, zero marketing budget, zero audience (merit-judged channels and warm intros substitute for distribution — your exact weakness profile), it is legally invoiceable through Volta today, it puts no user funds at risk on mainnet, and one mid-size engagement (3,500–5,900 EUR) exceeds your entire grant income to date.

The skeptics' two corrections are baked in: (1) do NOT sell "audits" cold — you have no third-party track record and audit DMs pattern-match to spam. Manufacture external proof first (contest entry + free public smell tests with real disclosed findings), route paid pitches only through warm intros, and lead with *engineering-for-hire with a soundness deliverable bundled*, not a report. (2) Hard time-box the grant/bounty treadmill so it funds the customer motion instead of replacing it.

### 14-day action plan

**Day 1 — File tranche-2. Non-negotiable.**
The dossier at `apps/mugen/TRANCHE-2-SUBMISSION.md` is complete; both live URLs return 200. Grant repo read access to abhwshek@gmail.com, attach the $200 AI-coding receipts, submit via the Earn tranche form. Same day, DM the Superteam point of contact the three devnet escrow explorer tx links to start their review clock. This has sat unfiled for 16 days; it is the fastest money in the entire plan.

**Day 2 — Credibility hygiene sweep on protocol-01.dev (half day).**
Fix what a diligent buyer finds in an afternoon: README APK link v1.0.1 to v1.0.3, merchant-sdk README claiming "not yet published" when it is live on npm, unify the 13/14/15 program count, delete the unsourced 73%/$4.3B scare stats, remove the "Re-Work in progress / Soon" extension CTA. Draft the post-mortem outline in the afternoon.

**Days 3–4 — Write and publish the STARK post-mortem.**
On protocol-01.dev and as an X thread: "I built an on-chain STARK verifier, then found Orchard-class under-constraints in my own production circuits. Here is what I found, what is already fixed and device-validated in v1.0.3, what remains gated before mainnet, and the checklist I now run." The full found-it, fixed-it, validated-it arc sells far better than a scare pitch, and being honest about what is still open IS the credibility. Publish the checklist as a standalone artifact. Same days: add a `/services` page (offers below).

**Day 5 — Enter one live audit contest.**
Pick the best-fit open Cantina / Code4rena / Sherlock contest touching Solana, Rust, or ZK circuits. This is the reputation gate the skeptics identified: every solo auditor who landed private clients did it AFTER public contest results. It also doubles as a zero-sales revenue backstop. Timebox: mornings only.

**Days 6–7 — Free smell test #1.**
Pick a NAMED public Solana ZK codebase (Colosseum cohort, Arcium ecosystem). Run your checklist, write a one-page smell test, responsibly disclose anything real. One confirmed external finding in someone else's circuit is worth more than any self-audit post.

**Day 8 — Warm outreach wave 1 (5–10 messages, warm channels only).**
Diarmuid / Superteam Ireland, Dev3pack judges, Arcium DevRel, Colosseum Frontier privacy teams, the tranche-2 reviewer. The message is not "buy an audit." It is: "I published this post-mortem and checklist; happy to run a free one-page smell test on your circuits. If useful, I do fixed-price work." Attach the post-mortem and smell test #1.

**Days 9–10 — Smell test #2 + contest work.**
Second named codebase. Publish results with permission. Keep contest mornings going.

**Day 11 — Grant batch day (ONE day, then stop).**
Recycle the proof pack (live escrow trade, v1.0.3, Dev3pack #2, post-mortem) into 2–3 applications: Superteam instagrant, RTG follow-up, Solana Foundation micro-grant, pitching the on-chain STARK verifier as public-good infra. Do not let this bleed into other days.

**Day 12 — Follow-ups.**
One structured follow-up per Day-8 contact (your history shows follow-up decay by week 3 — calendar it). Outreach wave 2 to anyone who engaged with the post-mortem thread.

**Day 13 — Earn scan with the hard filter.**
Enter at most ONE bounty, only if: prize >= $1,000, deadline inside 3 weeks, winner announced inside 5 weeks, <15 current submissions, exact Rust/Anchor/ZK/wallet-UX stack match. Skip everything else.

**Day 14 — Pipeline review.**
If a discovery call is booked: close the 500 EUR half-day triage (Volta invoice, payment before delivery). If not: diagnose which artifact underperformed (post-mortem reach, smell-test targets, intro channels) and adjust the next 2-week block. Ongoing rule from here: grants/bounties capped at 1 day per week, everything else goes to the services pipeline.

### The offer ladder (all invoiced via Volta, 50% upfront on anything over 1K)
- Free: one-page circuit smell test (the outreach hook)
- 500 EUR: half-day triage call + written findings (the fast lander)
- ~1,900 EUR: 3-day Circuit Soundness Smoke
- 3,500–5,900 EUR: 1–2 week Pre-Mainnet Review
- 5–8K EUR: fixed-price ZK engineering ("your proofs verifying on-chain under the Solana CU cap in 2 weeks, soundness checklist included") — the natural upsell, and the easier first sale since it is shipping help, not a trust product

Realistic 8-week take: 100 USDG (near-certain) + 2,000–8,000 EUR services + 0–2K contest/bounty. That funds runway AND the external audit line item.

---

## 3. Ranked next moves

**1. Audit-contest track (Cantina / Code4rena / Sherlock)**
First dollar: contest payout, weeks 4–7. Effort: ~1 week spread across mornings.
Blocker: payouts lag and fields are competitive. Neutralize: it is not primarily a revenue play — it is the missing third-party credential the services practice requires, with cash as a side effect. One ranked result changes every future pitch.

**2. Grant-stack batch (instagrants, RTG, Foundation micro-grants)**
First dollar: 4–8+ weeks, low certainty. Effort: 1 day, once.
Blocker: your own history refutes the channel inside 8 weeks (Superteam France unanswered, April RTG unpaid by July, 6–12 week Foundation cycles). Neutralize: batch into one day, never revisit except to reply, and treat every reviewer contact as a warm BD lead for the services offer — the application is the excuse for the conversation.

**3. Earn bounty track (filtered)**
First dollar: 3–5 weeks post-win. Effort: capped 1 day/week.
Blocker: 20–100 competing entries and payout lag can eat the window. Neutralize: the hard filter above (>= $1K, <15 subs, announcement inside window, exact stack match); every sponsor submission includes a one-line services footer.

**4. ZK engineering-for-hire retainer conversion**
First dollar: weeks 5–8, after a first smoke or triage lands. Effort: sales only.
Blocker: trust conversion — unknown solo vendor, buyers ghost cold offers. Neutralize: never pitch cold; only pitch after a delivered free smell test or a warm intro, anchor on the shipping deliverable (proofs live under CU cap) rather than the report, and show the contest ranking + published disclosures as third-party proof.

---

## 4. Product changes that create pull

These convert the repo from vitamin to painkiller for the two audiences that matter now (buyers of your expertise, and builders who could adopt the SDK later). Roughly in order of leverage per hour:

1. **`/services` page on protocol-01.dev (BUILD, 1 day).** The site currently has zero path to pay you — no pricing, no sales contact beyond X. Three offers with EUR prices, the Volta legal line (EI Amir Chatbi / Volta, SIREN 105941512), an email, and the post-mortem as social proof. This is the storefront for the entire strategy.
2. **`/security` post-mortem page (BUILD, 1–2 days).** The full audit arc plus the public checklist plus honest per-circuit status (fixed and validated vs still gated). Converts your scariest liability ("internal audit found criticals") into your single best marketing asset and diligence-proofs the site.
3. **Resolve the license contradiction (DECIDE + 2 hours).** README says PROPRIETARY, all rights reserved; the hero says "Open source"; the SDKs are on npm. No commercial buyer can legally adopt today. Minimum fix: MIT or Apache-2.0 the npm SDKs (`packages/merchant-sdk`, `packages/privacy-sdk`), keep programs source-available if you want. Two surfaces must stop contradicting each other.
4. **Honesty pass on the hero + Arcium (EXISTS as scoped decision, <1 week).** "NOTHING THEY CAN TRACE" while your own audit lists open under-constraints is a one-afternoon diligence kill. Reframe the hero for builders and proof-of-competence; add one line: "Live on devnet. Mainnet gated on external audit — here is the plan." Remove the false "MPC active / no single node sees your data" Arcium claims (both paths already scoped in memory; either is fine, the false copy goes regardless).
5. **SDK npm hygiene (EXISTS, hours).** merchant-sdk README claims unpublished; make `npm install @protocol-01/merchant-sdk` the advertised path everywhere, sync the /sdk-demo copy. Highest GTM leverage per hour in the repo.
6. **Chrome Web Store listing for the v0.5.0 extension (artifact EXISTS, work = store assets + review).** Removes the biggest consumer distribution friction for later. Precondition: gate off the ext `zk:` transfer path first — it is a known fund-loss bug and a store reviewer or user hitting it would be a reputation event.
7. **Mainnet: publish the phased plan, do not rush the launch.** Sequence stated on `/security`: fix remaining circuit criticals, external review funded by services revenue, mainnet with per-pool caps. Turns "not audited, no date" from a dead end into a roadmap a future buyer can plan against.
8. **Cross-link Mugen `/demo` from protocol-01.dev (EXISTS both sides, minutes).** Two live properties should point at each other; it thickens the proof pack for every grant and pitch.
9. **Stream SDK gate honesty (copy fix, minutes).** "Live in days, not quarters" next to a whitelist request form is a contradiction; either open the gate or fix the copy.

Explicitly deprioritized: new privacy features, mobile work, the V3 migration, and anything consumer-acquisition shaped. Nothing in the next 8 weeks needs new protocol code.

---

## 5. Do-NOT-do list

- **Reopen the "AMD vs Nvidia" warm lead as a paid pilot.** One 3-months-cold contact whose name was never recorded, asked to evaluate for free; asking them to pay 2–3K for a devnet demo is an inverted value exchange.
- **Whop-refugee subscription wedge.** Solana shipped native, audited, free Subscriptions/Allowances on mainnet; Helio does it at 1%; the token-approve pattern reads as a drainer to exactly these users.
- **Deplatformed-merchant billing (VPNs, seedboxes).** The niche ideologically rejects recurring billing (Mullvad removed it on purpose), and you would be cold-emailing the most cold-email-hostile buyers on earth with a devnet rail.
- **Zero-PII license API for non-crypto indie devs.** Keygen is free and self-hostable, Lemon Squeezy bundles licensing, the GDPR pitch is legally false, and it is a pure cold-distribution game into a market where your Solana credibility does not transfer.
- **Paid JP Translate extension.** Chrome Web Store killed paid listings; the product wraps a ToS-gray free Google endpoint that Chrome itself already replicates for free; the seeding channels ban self-promotion.
- **Private payroll for Solana teams.** The buyer is the most compliance-sensitive persona in crypto, native Confidential Balances already exist on mainnet, and fixed-denomination notes with maturation delays cannot physically do salaries.
- **Adult/creator discreet billing.** Their existential pain is the card rail you do not touch; the sellable piece (license mint) is gated on the exact STARK path your audit flagged; SpankPay died with better positioning.
- **White-label recurring rails for processors (Sphere/Helio).** The primitive went native on Solana mainnet in June 2026 and the named targets already have subscription products; the pitch would signal you did not research them.
- **Escrow-in-a-link from Mugen.** An escrow link from an unknown in Telegram IS the scam pattern, and `resolve_dispute.rs` makes your key the centralized arbiter — a fee-taking French micro-entreprise controlling disputed no-KYC funds is MiCA exposure you cannot afford.

The pattern across all nine kills: each one required either cold distribution into a hostile market (your admitted weakness), a product that does not exist in sellable form yet, or competing against a free audited native alternative. The chosen move requires none of the three.
