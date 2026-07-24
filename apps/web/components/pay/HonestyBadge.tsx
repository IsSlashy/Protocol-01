"use client";

import { Eye, ShieldCheck } from "lucide-react";
import type { ChainId } from "@/lib/privacy/chains/types";

/**
 * Persistent, honest disclosure of the v1 privacy envelope, per chain.
 *
 * Solana: the shield deposit publishes the sender's address on-chain; only the
 * recipient is hidden (via the one-time stealth address). Sender unlinkability
 * (relayer/feeder) is deferred.
 *
 * Starknet: same recipient-only envelope, plus two extra caveats — amounts are
 * public ERC-20 transfers until the STRK20 pool integration lands, and the
 * sender technically retains spend authority over the stealth account until
 * the recipient claims.
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
        stealth address. Your funding transfer stays public{" "}
        <span className="text-p01-yellow">(sender unlinkability is on the roadmap)</span>.
      </p>
    </div>
  );
}
