# Mugen Exchange — Superteam Grant, Tranche 2 Submission

Grant: Superteam "Ideas to Prompt to Prod" (Agentic Engineering), 200 USDG total.
Status: tranche 1 (100 USDG) paid, KYC done. This packet covers tranche 2 (100 USDG),
which requires a live working MVP with Solana integration, a project URL, a GitHub
repo, and AI-coding subscription receipts totaling 200 USD.

This packet is written to be honest. Where something is built but not yet wired into
the live product, it says so plainly. Nothing here claims a privacy guarantee the
running app does not actually deliver today.

---

## 1. What shipped

A live, no-KYC, peer-to-peer fiat-to-crypto exchange on Solana. A buyer and a seller
agree on a price off-chain (cash, bank transfer, or whatever they choose), the crypto
side is locked in a real on-chain wSOL escrow, the fiat side is confirmed, and the
escrow releases to the buyer. If the trade goes wrong there is an on-chain dispute and
release path, so funds are not stuck in a one-party wallet during the trade.

The user outcome: you can do a P2P crypto trade without handing identity documents to
a centralized desk, and the crypto leg is held by an on-chain program (not by a
counterparty or by us) until both sides are satisfied.

Live URL: https://mugen-exchange.vercel.app
Demo page: https://mugen-exchange.vercel.app/demo

What is genuinely true and worth leading with:
- No-KYC P2P mode. No identity collection to post or take an order.
- Real on-chain wSOL escrow on Solana with a dispute and release flow.
- Post-quantum primitives in the stack (ML-KEM-768 for key encapsulation, a hash-based
  STARK path in the wider Protocol 01 monorepo), so the privacy layer is not purely
  reliant on classical elliptic-curve assumptions.

---

## 2. Proof it works (real devnet transactions)

A full escrow trade ran live on Solana devnet. 0.01 SOL traded, 50 bps fee, the buyer
received 9,950,000 lamports. These are real, inspectable transactions, not a mock.

Escrow trade lifecycle:

1. create_order + take_order
   https://explorer.solana.com/tx/2WJSANyYYVtVxEzFgwrq6oCN46Cm5tXPrquaZgwnpnXoeh9wXSZiwYf7kfYvBnxizozbfhvDcUbYCHk35NKnvxtj?cluster=devnet

2. confirm_payment
   https://explorer.solana.com/tx/1fQya9y1866tDtEWzEEFwjxoEV1ptxvHRQx1kfVuYtsNm2Vb6VRdATdr2btiruRZf3kRgwKY63knrQdsNYpDaqT?cluster=devnet

3. release_escrow
   https://explorer.solana.com/tx/4xH1Yhdmv7XpburTzRtdtfPtmKjYHAAjjiC1L2NeUVmWziw7CMAbA2dqNPPLmzrMqEfJasq5DWeiqWeZLspqwnNf?cluster=devnet

On-chain references:
- Escrow PDA: 725DbYYxy5EywCaL9ySo1WF2PEtMpw19ZR7PmWnPhbcb
- Program p01_mugen (escrow): EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN (devnet)
- Program p01_arcium (MPC circuits): FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT (devnet)

Anyone can open the three Explorer links above and confirm the lamport movement, the
fee, and the escrow PDA. That is the MVP-with-Solana-integration requirement satisfied
with verifiable artifacts rather than screenshots.

---

## 3. The agentic-engineering story (what the grant funds)

This is the part the grant actually subsidizes: a solo developer shipping production
Solana code by orchestrating an AI coding agent (Claude Code), doing the judgement work
while the agent handles diagnosis, cross-file refactors, and failure-mode enumeration.

In a single session, the agent did the following:

- Diagnosed why the on-chain escrow silently fell back to a non-escrow path in
  production. Root cause was a 4 KB SBF stack overflow in the deployed p01_mugen
  program (large account structs blowing the on-chain stack frame). The symptom was a
  quiet fallback, not a loud error, which is exactly the kind of thing that hides for
  weeks.
- Fixed it by boxing the heavy accounts (Box-ing the order and escrow accounts so they
  live on the heap, not the stack frame), then rebuilt and redeployed the program to
  devnet.
- Verified the full lifecycle live with the three transactions linked in section 2.
  This is what turned "escrow exists in the code" into "escrow demonstrably moved real
  lamports on devnet".
- Separately, fixed the Arcium MPC circuit build. 18 circuits now compile (arcium build
  exits 0) and the program p01_arcium is deployed on devnet at
  FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT.

Honest status of the privacy layer (disclosed in-app, not hidden):
- The MPC blind-matching circuits are built and the program is deployed, but blind
  matching is NOT yet wired into the live order flow. Order matching in the running app
  currently goes through a server-side registry that briefly holds plaintext terms
  between submit and claim-match. This is stated directly in the code
  (lib/encrypted-order-registry.ts carries an explicit honesty disclaimer) and surfaced
  in-app, so users are not told a guarantee the product does not yet deliver.
- FROST threshold signing is at MVP level (independent keypairs, default 2-of-3, run on
  localhost), not aggregated FROST-Ed25519, and the Nym transport path falls back to a
  plain fetch when the mixnet is unavailable.
- So claims like "no single node sees your data" or "MPC matching is live" would be
  overstated today, and are not made here. What is real today: no-KYC P2P trading, a
  working on-chain escrow with dispute resolution, deployed MPC circuits, and
  post-quantum key encapsulation in the stack.

The grant funds the AI-coding subscription that makes this single-operator, ship-fast
pattern possible. The escrow fix above (silent-fallback diagnosis, stack-overflow root
cause, Box fix, redeploy, live verification) is a concrete example of that pattern
producing a shippable result in one sitting.

---

## 4. Repository and access

GitHub repository: IsSlashy/Protocol-01 (public monorepo). The Mugen app lives at
apps/mugen.

The repo is public, so no access needs to be granted: the reviewer can directly
inspect apps/mugen (the live app), the p01_mugen escrow program, the p01_arcium
circuits, and the honesty disclaimer in lib/encrypted-order-registry.ts referenced
above. (If Superteam prefers a private repo, read access can be shared with
abhwshek@gmail.com on request.)

---

## 5. Checklist of remaining user actions to claim tranche 2

These are the steps only the account owner can perform. The MVP, the live URL, the
devnet proof, and this packet are already done.

- [ ] Repo access: none needed, IsSlashy/Protocol-01 is public. (Optional: if
      Superteam asks for a private repo, share read access with abhwshek@gmail.com.)
- [ ] Gather the AI-coding subscription receipt(s) totaling 200 USD (for example the
      Claude / Anthropic subscription invoices that cover the build period). Save them
      as PDF or screenshots ready to upload.
- [ ] Fill the tranche application form on the Superteam Earn listing, including:
      - Project URL: https://mugen-exchange.vercel.app (and the demo page
        https://mugen-exchange.vercel.app/demo)
      - Repo: https://github.com/IsSlashy/Protocol-01 (public, app at apps/mugen)
      - This packet (apps/mugen/TRANCHE-2-SUBMISSION.md) as the written summary
      - The 200 USD of AI-coding receipts attached.

Once those three are done, the tranche-2 requirements (live MVP with Solana
integration, project URL, repo access, and 200 USD of AI-coding receipts) are all
satisfied.
