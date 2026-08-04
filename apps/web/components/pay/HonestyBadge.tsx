"use client";

import { Eye, ShieldCheck } from "lucide-react";
import type { ChainId } from "@/lib/privacy/chains/types";

/**
 * Persistent, honest disclosure of the STEALTH SEND envelope, per chain.
 *
 * SCOPE, READ THIS BEFORE EDITING THE COPY
 * ─────────────────────────────────────────
 * The Send tab has TWO modes and they hide opposite things, so this badge
 * describes exactly one of them. SendForm renders it only inside the stealth
 * branch, in the context column, folded behind a one-line summary that stays
 * visible when closed ("Hides the recipient only. Your wallet and the amount
 * stay public."); the badge text itself is unchanged and is still the full
 * disclosure. The note-handoff mode carries its own disclosure fold in its own
 * context column.
 *
 * No line numbers here on purpose: the previous version of this paragraph
 * pointed at three of them and all three rotted within a day of the rework.
 *
 * That split is correct and this badge must not
 * try to cover both — "a send does not go through the pool" was true of both
 * modes but for opposite reasons (stealth pays a wallet-funded address; the
 * handoff broadcasts nothing at all), and one sentence covering both can only
 * do it by being vague.
 *
 * SOLANA — what the code actually publishes
 * ─────────────────────────────────────────
 * The funds leg is a plain transfer out of the connected wallet:
 * `SystemProgram.transfer({ fromPubkey: sender, toPubkey: stealth.address,
 * lamports: amount })` (packages/pay-core/src/worker/workerCore.ts:352) with
 * `tx.feePayer = sender` on every transaction in the batch (workerCore.ts:363).
 * The browser signs and submits them itself — `signAll(txs)` then
 * `connection.sendRawTransaction(...)` in PayApp.tsx:120-133. There is no
 * relayer on /pay. So the sender is not merely "not yet unlinkable": nothing on
 * this path is even attempting to hide the sender, and the badge says that
 * instead of the softer "on the roadmap", which reads as a missing feature
 * rather than as a property of the mechanism.
 *
 * Only the recipient is hidden, via the one-time hybrid stealth address
 * (workerCore.ts:308-311 refuses a recipient without an ML-KEM ciphertext).
 *
 * The pointer to the other tab is deliberately not a privacy upsell. The note
 * handoff broadcasts nothing, which is real; it does NOT make the money
 * untraceable, because the recipient's eventual withdrawal republishes the
 * commitment the original deposit published — measured on devnet, leaf 16,
 * commitment 8901821612542787864, in both the deposit and the withdrawal. Both
 * halves of that have to travel together or the pointer becomes the overstate.
 *
 * Starknet: same recipient-only envelope, plus one extra caveat — the sender
 * technically retains spend authority over the stealth account until the
 * recipient claims. The STRK20 pool integration is still gated externally.
 *
 * The Starknet variant below is UNREACHABLE as of 2026-08-04: STRK, ETH and
 * Starknet USDC were retired from the selector, so `asset.chainId` — the only
 * thing SendForm passes here (SendForm.tsx:188) — can only be 'solana'. It is
 * kept verbatim rather than deleted so the copy comes back with the chain, in
 * one edit. Reason for the retirement and the steps to undo it:
 * packages/pay-core/src/assets.ts, file header.
 *
 * Do not remove or soften either variant until the corresponding work lands.
 */
export default function HonestyBadge({ chain }: { chain: ChainId }) {
  if (chain === "starknet") {
    return (
      <div className="card flex items-start gap-3 p-3 text-sm">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-p01-cyan" />
        <p className="text-p01-text-muted">
          <span className="text-p01-cyan">Recipient hidden</span> by a one-time post-quantum
          stealth address.{" "}
          <span className="inline-flex items-center gap-1 text-p01-yellow">
            <Eye className="h-3.5 w-3.5" /> Amounts public on this path.
          </span>{" "}
          STRK20 pool integration is pending. Until you claim, the sender technically retains
          spend authority over the stealth account — claim promptly.
        </p>
      </div>
    );
  }
  return (
    <div className="card flex items-start gap-3 p-3 text-sm">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-p01-cyan" />
      <p className="text-p01-text-muted">
        <span className="text-p01-cyan">Recipient hidden</span> by a one-time post-quantum
        stealth address.{" "}
        <span className="inline-flex items-center gap-1 text-p01-yellow">
          <Eye className="h-3.5 w-3.5" /> Sender and amount public on this path.
        </span>{" "}
        Your wallet signs the transfer, pays the fee and funds the one-time address, and this
        page submits it straight from your browser — there is no relayer, so nothing here hides
        the sender. Handing over a note instead (other tab) broadcasts nothing at all, but the
        recipient&apos;s later withdrawal still republishes your deposit&apos;s commitment.
      </p>
    </div>
  );
}
