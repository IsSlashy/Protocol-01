"use client";

import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { Check, Copy, Download, Loader2, RefreshCw } from "lucide-react";
import type {
  ChainStealthAdapter,
  DerivedIdentity,
  StealthPayment,
} from "@/lib/privacy/chains/types";
import { formatAmount, timeAgo, truncate } from "./util";

export default function ReceivePanel({
  adapter,
  identity,
  destination,
}: {
  adapter: ChainStealthAdapter;
  identity: DerivedIdentity;
  destination: string;
}) {
  const [payments, setPayments] = useState<StealthPayment[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function scan() {
    setScanning(true);
    setScanError(null);
    try {
      setPayments(await adapter.scan(identity));
    } catch (e) {
      setScanError((e as Error).message || "Scan failed. Check your connection and rescan.");
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.meta]);

  async function claim(p: StealthPayment) {
    setClaimingId(p.id);
    setClaimError(null);
    try {
      await adapter.claim(p, identity, destination);
      setPayments((prev) => prev.map((x) => (x.id === p.id ? { ...x, claimed: true } : x)));
    } catch (e) {
      setClaimError((e as Error).message || "Claim failed. Rescan and try again.");
    } finally {
      setClaimingId(null);
    }
  }

  function copyMeta() {
    void navigator.clipboard.writeText(identity.meta);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const pending = payments.filter((p) => !p.claimed);

  return (
    <div className="space-y-5">
      {/* Publish / meta card */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <p className="font-display text-sm text-p01-text">Your private address</p>
        </div>
        <p className="mt-1 text-xs text-p01-text-muted">
          Share this meta-address (or the QR) with anyone who wants to pay you privately.
        </p>

        <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div className="rounded-lg bg-white p-2">
            <QRCode value={identity.meta} size={112} />
          </div>
          <div className="min-w-0 flex-1">
            <code className="block break-all rounded-lg border border-p01-border bg-p01-void p-3 font-mono text-xs text-p01-cyan">
              {truncate(identity.meta, 16, 12)}
            </code>
            <button
              onClick={copyMeta}
              className="btn-secondary mt-2 inline-flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy meta-address"}
            </button>
          </div>
        </div>
      </div>

      {/* Inbox */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="font-display text-sm text-p01-text">
            Incoming ({pending.length})
          </p>
          <button
            onClick={scan}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
          >
            <RefreshCw className={scanning ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>

        {scanError && (
          <p className="mb-2 text-sm text-p01-red">{scanError}</p>
        )}
        {claimError && (
          <p className="mb-2 text-sm text-p01-red">{claimError}</p>
        )}

        {pending.length === 0 && !scanning && !scanError && (
          <div className="card p-6 text-center text-sm text-p01-text-muted">
            No incoming private payments yet.
          </div>
        )}

        {pending.length > 0 && (
          <p className="mb-2 text-xs text-p01-text-dim">
            Unshielding sends the funds to your connected wallet — that final hop is public
            on-chain.
          </p>
        )}
        <ul className="space-y-2">
          {pending.map((p) => (
            <li key={p.id} className="card flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="font-mono text-sm text-p01-text">
                  {formatAmount(p.amount, p.assetSymbol)}
                </p>
                <p className="truncate font-mono text-xs text-p01-text-muted">
                  {truncate(p.stealthAddress, 8, 6)}
                  {/* Starknet scan reports receivedAt = 0 when the timestamp is unknown. */}
                  {p.receivedAt > 0 && <> · {timeAgo(p.receivedAt)}</>}
                </p>
              </div>
              <button
                onClick={() => claim(p)}
                disabled={claimingId === p.id}
                className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-xs disabled:opacity-50"
              >
                {claimingId === p.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                Unshield
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
