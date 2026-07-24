"use client";

import { useState } from "react";
import { ChevronDown, Lock } from "lucide-react";
import clsx from "clsx";
import type { Asset } from "@/lib/privacy/chains/types";
import TokenLogo from "./TokenLogo";

export default function ChainCoinSelector({
  assets,
  selected,
  onSelect,
}: {
  assets: Asset[];
  selected: Asset;
  onSelect: (a: Asset) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="glass glass-hover flex w-full items-center justify-between gap-3 px-4 py-3"
      >
        <span className="flex items-center gap-3">
          <TokenLogo symbol={selected.symbol} size={32} />
          <span className="text-left">
            <span className="block font-mono text-sm text-p01-text">{selected.symbol}</span>
            <span className="block text-xs text-p01-text-muted">{selected.name}</span>
          </span>
        </span>
        <ChevronDown className={clsx("h-4 w-4 text-p01-text-muted transition", open && "rotate-180")} />
      </button>

      {open && (
        <div className="glass absolute z-20 mt-2 w-full overflow-hidden shadow-2xl">
          {assets.map((a) => {
            const disabled = a.status === "coming-soon";
            return (
              <button
                key={`${a.chainId}:${a.symbol}`}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onSelect(a);
                  setOpen(false);
                }}
                className={clsx(
                  "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition",
                  disabled
                    ? "cursor-not-allowed opacity-55"
                    : "hover:bg-p01-surface-2",
                  a.symbol === selected.symbol && a.chainId === selected.chainId && !disabled && "bg-p01-surface-2"
                )}
              >
                <span className="flex items-center gap-3">
                  <TokenLogo symbol={a.symbol} size={32} />
                  <span>
                    <span className="block font-mono text-sm text-p01-text">{a.symbol}</span>
                    <span className="block text-xs text-p01-text-muted">{a.name}</span>
                  </span>
                </span>
                {disabled ? (
                  <span className="badge badge-yellow inline-flex items-center gap-1">
                    <Lock className="h-3 w-3" /> Soon
                  </span>
                ) : (
                  <span className="badge badge-cyan">Live</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
