"use client";

import { Eye, ShieldCheck } from "lucide-react";
import type { ChainId } from "@/lib/privacy/chains/types";

/**
 * Persistent, honest disclosure of the v1 privacy envelope, per chain.
 *
 * This renders on the SEND tab. A send does NOT route through the denominated
 * pool — it is the plain stealth-address path, so the transfer amount is public
 * on both chains (docs/PAY_HANDOFF_OPUS5.md §10: "The send flow still does not
 * route through the pool. A /pay send is the same stealth-address path as
 * before, amounts public"). The Pool tab is a separate, manual shield/withdraw
 * flow; do not let this badge imply the two are connected.
 *
 * Solana: the funding transfer publishes the sender's address and the amount
 * on-chain; only the recipient is hidden (via the one-time stealth address).
 * Sender unlinkability (relayer/feeder) is deferred.
 *
 * Starknet: same recipient-only envelope, plus one extra caveat — the sender
 * technically retains spend authority over the stealth account until the
 * recipient claims. The STRK20 pool integration is still gated externally.
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
        A send does not go through the pool; sender unlinkability is on the roadmap.
      </p>
    </div>
  );
}
