"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Loader2, Search, TriangleAlert } from "lucide-react";
import type {
  Asset,
  ChainStealthAdapter,
  ResolvedRecipient,
  TxRef,
} from "@/lib/privacy/chains/types";
import FeeRow from "./FeeRow";
import HonestyBadge from "./HonestyBadge";
import { formatAmount, truncate } from "./util";

export default function SendForm({
  adapter,
  asset,
}: {
  adapter: ChainStealthAdapter;
  asset: Asset;
}) {
  const [recipientInput, setRecipientInput] = useState("");
  const recipientRef = useRef("");
  const [resolved, setResolved] = useState<ResolvedRecipient | null>(null);
  const [resolving, setResolving] = useState(false);
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TxRef | null>(null);

  const amountNum = Number(amount) || 0;
  const quote = useMemo(() => adapter.quoteFees(asset, amountNum), [adapter, asset, amountNum]);
  const belowMin = amountNum > 0 && amountNum < quote.minSend;
  const canSend = !!resolved && amountNum >= quote.minSend && !sending;

  async function handleResolve() {
    setError(null);
    setResolved(null);
    const input = recipientInput.trim();
    if (!input) return;
    setResolving(true);
    try {
      const recipient = await adapter.resolveRecipient(input);
      // Ignore a stale response if the user already changed the input.
      if (recipientRef.current.trim() === input) setResolved(recipient);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResolving(false);
    }
  }

  async function handleSend() {
    if (!resolved) return;
    setError(null);
    setSending(true);
    try {
      setResult(await adapter.send({ recipient: resolved, asset, amount: amountNum }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  if (result) {
    return (
      <div className="space-y-4">
        <div className="card flex items-start gap-3 p-4">
          <Check className="mt-0.5 h-5 w-5 shrink-0 text-p01-cyan" />
          <div className="min-w-0">
            <p className="font-display text-p01-text">Private send submitted</p>
            <p className="mt-1 text-sm text-p01-text-muted">
              {formatAmount(amountNum, asset.symbol)} to {resolved?.label}, hidden behind a
              one-time stealth address.
            </p>
            <a
              href={result.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block font-mono text-xs text-p01-cyan hover:underline"
            >
              {truncate(result.signature, 10, 8)} ↗
            </a>
          </div>
        </div>
        <button
          className="btn-secondary w-full"
          onClick={() => {
            setResult(null);
            setAmount("");
            setRecipientInput("");
            setResolved(null);
          }}
        >
          Send another
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Recipient */}
      <div>
        <label className="mb-1.5 block text-xs uppercase tracking-wider text-p01-text-muted">
          Recipient
        </label>
        <div className="flex gap-2">
          <input
            value={recipientInput}
            onChange={(e) => {
              setRecipientInput(e.target.value);
              recipientRef.current = e.target.value;
              setResolved(null);
            }}
            onBlur={handleResolve}
            placeholder="Wallet address or st… meta-address"
            className="card w-full bg-p01-void px-4 py-3 font-mono text-sm text-p01-text outline-none placeholder:text-p01-text-dim focus:border-p01-cyan"
          />
          <button
            type="button"
            onClick={handleResolve}
            disabled={resolving || !recipientInput.trim()}
            className="btn-ghost flex items-center gap-2 px-4 disabled:opacity-50"
          >
            {resolving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </button>
        </div>
        {resolved && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-p01-cyan">
            <Check className="h-3.5 w-3.5" /> Resolved {resolved.label} · v2 hybrid
          </p>
        )}
      </div>

      {/* Amount */}
      <div>
        <label className="mb-1.5 block text-xs uppercase tracking-wider text-p01-text-muted">
          Amount
        </label>
        <div className="card flex items-center gap-3 bg-p01-void px-4 py-3">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            placeholder="0.0"
            className="w-full bg-transparent font-mono text-lg text-p01-text outline-none placeholder:text-p01-text-dim"
          />
          <span className="font-mono text-sm text-p01-text-muted">{asset.symbol}</span>
        </div>
        {belowMin && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-p01-yellow">
            <TriangleAlert className="h-3.5 w-3.5" /> Minimum send is{" "}
            {formatAmount(quote.minSend, asset.symbol)}
          </p>
        )}
      </div>

      <FeeRow quote={quote} assetSymbol={asset.symbol} chainId={asset.chainId} />
      <HonestyBadge chain={asset.chainId} />

      {error && (
        <p className="flex items-center gap-1.5 text-sm text-p01-red">
          <TriangleAlert className="h-4 w-4" /> {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleSend}
        disabled={!canSend}
        className="btn-primary flex w-full items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {sending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Shielding…
          </>
        ) : (
          <>
            Shield &amp; send <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
    </div>
  );
}
