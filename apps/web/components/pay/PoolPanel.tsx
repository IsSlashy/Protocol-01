"use client";

import { useCallback, useEffect, useState } from "react";
import type { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { Coins, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import {
  loadEncryptedNotes,
  scanPool,
  shieldToPool,
  storeEncryptedNote,
  type ShieldOutcome,
} from "@/lib/privacy/shieldClient";
import type { PoolNoteView, PoolSizeView } from "@/lib/privacy/worker/poolHandlers";
import { truncate } from "./util";

/** The live V4 SOL pools. Shielding snaps to one of these — a denominated pool
 *  cannot hold an arbitrary amount, and that is the whole point: every note in
 *  a pool looks identical. */
const SOL_DENOMINATIONS = [0.1, 1, 10, 100, 500, 1000];

export default function PoolPanel({
  meta,
  owner,
  connection,
  signOne,
}: {
  meta: string;
  owner: PublicKey;
  connection: Connection;
  signOne: ((tx: Transaction) => Promise<Transaction>) | null;
}) {
  const [denomination, setDenomination] = useState(SOL_DENOMINATIONS[0]);
  const [notes, setNotes] = useState<PoolNoteView[]>([]);
  const [poolSizes, setPoolSizes] = useState<PoolSizeView[]>([]);
  const [balance, setBalance] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [scanStep, setScanStep] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const [shielding, setShielding] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShieldOutcome | null>(null);

  const rescan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const res = await scanPool(meta, "SOL", setScanStep);
      setNotes(res.notes);
      setPoolSizes(res.poolSizes);
      setBalance(res.shieldedBalance);
    } catch (e) {
      setScanError((e as Error).message || "Pool scan failed.");
    } finally {
      setScanning(false);
      setScanStep(null);
    }
  }, [meta]);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  async function handleShield() {
    if (!signOne) {
      setError("This wallet cannot sign transactions.");
      return;
    }
    setError(null);
    setResult(null);
    setShielding(true);
    try {
      const outcome = await shieldToPool({
        meta,
        token: "SOL",
        denomination,
        owner,
        connection,
        signOne,
        onProgress: setStep,
      });
      storeEncryptedNote(owner.toBase58(), outcome.encryptedNote);
      setResult(outcome);
      void rescan();
    } catch (e) {
      setError((e as Error).message || "Shield failed.");
    } finally {
      setShielding(false);
      setStep(null);
    }
  }

  const unspent = notes.filter((n) => !n.spent);
  const selectedSize = poolSizes.find((p) => p.denomination === denomination);
  const storedNotes = loadEncryptedNotes(owner.toBase58()).length;

  return (
    <div className="space-y-5">
      {/* Balance */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-p01-cyan" />
            <p className="font-display text-sm text-p01-text">Shielded balance</p>
          </div>
          <button
            onClick={rescan}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
          >
            <RefreshCw className={scanning ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
        <p className="mt-2 font-mono text-2xl text-p01-text">{balance} SOL</p>
        <p className="mt-1 text-xs text-p01-text-muted">
          {unspent.length} unspent note{unspent.length === 1 ? "" : "s"}
          {storedNotes > 0 && <> · {storedNotes} stored locally</>}
        </p>
        {scanStep && <p className="mt-2 text-xs text-p01-text-dim">{scanStep}</p>}
        {scanError && <p className="mt-2 text-sm text-p01-red">{scanError}</p>}
      </div>

      {/* Denomination */}
      <div>
        <label className="mb-1.5 block text-xs uppercase tracking-wider text-p01-text-muted">
          Denomination
        </label>
        <div className="flex flex-wrap gap-2">
          {SOL_DENOMINATIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDenomination(d)}
              disabled={shielding}
              className={
                d === denomination
                  ? "rounded-lg border border-p01-cyan bg-p01-cyan/10 px-4 py-2 font-mono text-sm text-p01-cyan"
                  : "rounded-lg border border-p01-border bg-p01-void px-4 py-2 font-mono text-sm text-p01-text-muted hover:text-p01-text disabled:opacity-50"
              }
            >
              {d} SOL
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-p01-text-muted">
          {selectedSize
            ? `${selectedSize.totalNotes} note${selectedSize.totalNotes === 1 ? "" : "s"} in this pool — a later withdrawal is indistinguishable among them, and no more than that.`
            : "Amounts snap to a denomination; arbitrary amounts cannot be shielded."}
        </p>
        {selectedSize && selectedSize.discoverableNotes < selectedSize.totalNotes && (
          <p className="mt-1 text-xs text-p01-text-dim">
            This RPC only serves history for {selectedSize.discoverableNotes} of them, so notes are
            found from local storage rather than rediscovered by scanning.
          </p>
        )}
      </div>

      {/* What this does and does not hide — keep this honest. */}
      <div className="rounded-lg border border-p01-yellow/30 bg-p01-yellow/5 p-3 text-xs text-p01-yellow">
        <p className="font-medium">Devnet. What a shield actually hides</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-p01-yellow/90">
          <li>The deposit itself is public: this wallet funds a one-time key that deposits into the pool.</li>
          <li>Hidden is the link between that deposit and a later withdrawal — only as strong as the note count above.</li>
          <li>
            A shield needs roughly {denomination + 1.1} SOL for a moment: the denomination plus ~1 SOL of
            proof-buffer rent, which is returned to you when the proof buffer closes.
          </li>
        </ul>
      </div>

      {error && (
        <p className="flex items-start gap-1.5 text-sm text-p01-red">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}

      {result && (
        <div className="card p-4">
          <p className="font-display text-sm text-p01-text">
            Shielded {result.denomination} SOL
          </p>
          <p className="mt-1 text-xs text-p01-text-muted">
            Note at leaf #{result.leafIndex}, commitment {truncate(result.commitment, 8, 6)}.
          </p>
          <a
            href={`https://explorer.solana.com/tx/${result.txSig}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block font-mono text-xs text-p01-cyan hover:underline"
          >
            {truncate(result.txSig, 10, 8)} ↗
          </a>
        </div>
      )}

      <button
        type="button"
        onClick={handleShield}
        disabled={shielding || !signOne}
        className="btn-primary flex w-full items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {shielding ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Shielding…
          </>
        ) : (
          <>Shield {denomination} SOL</>
        )}
      </button>

      {step && (
        <p className="text-center text-xs text-p01-text-dim">
          {step}
          <br />
          <span className="text-p01-text-muted">
            Uploading a ~140 KB proof takes a few minutes. Keep this tab open.
          </span>
        </p>
      )}

      {unspent.length > 0 && (
        <div>
          <p className="mb-2 font-display text-sm text-p01-text">Your notes</p>
          <ul className="space-y-2">
            {unspent.map((n) => (
              <li
                key={`${n.pool}:${n.counter}`}
                className="card flex items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <p className="font-mono text-sm text-p01-text">{n.denomination} SOL</p>
                  <p className="truncate font-mono text-xs text-p01-text-muted">
                    leaf #{n.leafIndex} · {truncate(n.commitment, 6, 4)}
                  </p>
                </div>
                <span className="text-xs text-p01-text-dim">unshield: next step</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
