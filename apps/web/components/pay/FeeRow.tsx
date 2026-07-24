"use client";

import type { ChainId, FeeQuote } from "@/lib/privacy/chains/types";
import { formatAmount } from "./util";

export default function FeeRow({
  quote,
  assetSymbol,
  chainId,
}: {
  quote: FeeQuote;
  assetSymbol: string;
  chainId: ChainId;
}) {
  // Network fee and sender rent/cushion are paid in the chain's fee currency;
  // minimum send and protocol fee are in the asset being sent.
  const feeSymbol = chainId === "starknet" ? "STRK" : "SOL";
  const rentLabel =
    chainId === "starknet"
      ? "STRK claim cushion (one-time)"
      : "Announcement rent (one-time)";
  const rows: [string, string][] = [
    ["Network fee", formatAmount(quote.networkFee, feeSymbol)],
    ...(quote.senderRent
      ? ([[rentLabel, formatAmount(quote.senderRent, feeSymbol)]] as [string, string][])
      : []),
    ...(quote.protocolFee > 0
      ? ([["Protocol fee", formatAmount(quote.protocolFee, assetSymbol)]] as [string, string][])
      : []),
    ["Minimum send", formatAmount(quote.minSend, assetSymbol)],
    ["Approvals", `${quote.approvals} signature`],
    ["Est. time", quote.estTime],
  ];
  return (
    <div className="card divide-y divide-p01-border/60 p-0 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between px-4 py-2.5">
          <span className="text-p01-text-muted">{label}</span>
          <span className="font-mono text-p01-text">{value}</span>
        </div>
      ))}
    </div>
  );
}
