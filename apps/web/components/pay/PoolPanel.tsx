"use client";

import { useCallback, useEffect, useState } from "react";
import type { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { Coins, Download, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import {
  loadEncryptedNotes,
  scanPool,
  shieldToPool,
  recoverStuckFunds,
  storeEncryptedNote,
  unshieldFromPool,
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
  const [busyNote, setBusyNote] = useState<string | null>(null);
  const [withdrawn, setWithdrawn] = useState<{ txSig: string; denomination: number } | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recovered, setRecovered] = useState<string | null>(null);

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

  async function handleUnshield(note: PoolNoteView) {
    if (!signOne) {
      setError("This wallet cannot sign transactions.");
      return;
    }
    setError(null);
    setResult(null);
    setBusyNote(`${note.pool}:${note.leafIndex}`);
    try {
      // The worker picks the blob whose commitment matches and uses its Merkle
      // path; anything that does not decrypt or match is ignored there.
      const out = await unshieldFromPool({
        meta,
        token: "SOL",
        denomination: note.denomination,
        leafIndex: note.leafIndex,
        recipient: owner,
        owner,
        encryptedNotes: loadEncryptedNotes(owner.toBase58()),
        connection,
        signOne,
        onProgress: setStep,
      });
      setWithdrawn(out);
      void rescan();
    } catch (e) {
      setError((e as Error).message || "Withdrawal failed.");
    } finally {
      setBusyNote(null);
      setStep(null);
    }
  }

  async function handleRecover() {
    setError(null);
    setRecovered(null);
    setRecovering(true);
    try {
      const r = await recoverStuckFunds(meta, denomination, owner, setStep);
      setRecovered(
        r.keys === 0
          ? "Nothing stranded — no funds to recover."
          : `Recovered ${(r.lamports / 1e9).toFixed(4)} SOL from ${r.keys} key(s), closed ${r.closedBuffers} proof buffer(s).`,
      );
    } catch (e) {
      setError((e as Error).message || "Recovery failed.");
    } finally {
      setRecovering(false);
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
        <p className="mt-2 font-mono text-2xl text-p01-text">{Number(balance.toFixed(4))} SOL</p>
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
            ? `${selectedSize.totalNotes} note${selectedSize.totalNotes === 1 ? "" : "s"} in this pool. Amounts snap to a denomination, so the amount you move is not distinctive — but see below for what withdrawal still reveals.`
            : "Amounts snap to a denomination; arbitrary amounts cannot be shielded."}
        </p>
        {selectedSize && selectedSize.discoverableNotes < selectedSize.totalNotes && (
          <p className="mt-1 text-xs text-p01-text-dim">
            This RPC serves history for only {selectedSize.discoverableNotes} of them. Withdrawal
            rebuilds the Merkle proof from that history, so a note whose history is gone cannot be
            withdrawn from this endpoint.
          </p>
        )}
      </div>

      {/* What this does and does not hide. This product's first rule is that
          copy never claims more than the shipped path provides — and the V3
          withdrawal instruction publishes the note commitment in cleartext, so
          it must NOT be described as unlinkable. Verified on devnet
          2026-07-25: tx 2FhzBLHc… carries stark_commitment
          1126946528953530644 at instruction bytes 80..88, the exact value the
          deposit emitted for leaf 28. */}
      <div className="rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
        <p className="font-medium">Devnet. This does NOT yet make you anonymous</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-p01-red/90">
          <li>
            <strong>Withdrawal reveals which deposit it spends.</strong> The withdrawal transaction
            includes the note commitment in the clear, and the deposit published that same value —
            so anyone can match the two. The anonymity set is effectively one, not the note count
            above.
          </li>
          <li>The deposit is public too: this wallet funds a one-time key that deposits into the pool.</li>
          <li>
            What you do get today: the amount is quantised to a denomination, and the note itself is
            post-quantum encrypted. That is all.
          </li>
          <li>
            A shield needs about {(denomination * 1.003 + 1.006).toFixed(3)} SOL for a few minutes —
            the denomination, a 0.3% protocol fee, and ~1 SOL of proof-buffer rent that is returned
            when the buffer closes. Withdrawal charges 0.5%.
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

      {withdrawn && (
        <div className="card p-4">
          <p className="font-display text-sm text-p01-text">
            Withdrew {withdrawn.denomination} SOL
          </p>
          <p className="mt-1 text-xs text-p01-text-muted">
            Sent to your connected wallet. This withdrawal is publicly matchable to the deposit it
            spends (the commitment appears in both), so treat it as a transparent transfer.
          </p>
          <a
            href={`https://explorer.solana.com/tx/${withdrawn.txSig}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block font-mono text-xs text-p01-cyan hover:underline"
          >
            {truncate(withdrawn.txSig, 10, 8)} ↗
          </a>
        </div>
      )}

      <button
        type="button"
        onClick={handleShield}
        disabled={shielding || !!busyNote || !signOne}
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

      <div className="flex items-center justify-between gap-3 text-xs">
        <button
          onClick={handleRecover}
          disabled={recovering || shielding || !!busyNote}
          className="text-p01-text-muted underline-offset-2 hover:text-p01-cyan hover:underline disabled:opacity-50"
        >
          {recovering ? "Checking for stranded funds…" : "Recover funds from a failed attempt"}
        </button>
        {recovered && <span className="text-p01-cyan">{recovered}</span>}
      </div>

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
                <button
                  onClick={() => handleUnshield(n)}
                  disabled={!!busyNote || shielding || !signOne}
                  className="btn-secondary inline-flex items-center gap-2 px-4 py-2 text-xs disabled:opacity-50"
                >
                  {busyNote === `${n.pool}:${n.leafIndex}` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
