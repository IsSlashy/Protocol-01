"use client";

/**
 * SendForm — two ways to send, which are not variants of each other.
 *
 * 1. HAND OVER A SHIELDED NOTE (default). Pick one of your existing notes, seal
 *    it to the recipient's post-quantum note address, give them the string.
 *    There is no transaction: the recipient ends up holding the note's secrets
 *    and withdraws it later as their own. Nothing is broadcast, so there is no
 *    send for anyone to pair with a receive.
 *
 * 2. STEALTH SEND. The original path: fund a fresh one-time address straight
 *    from the connected wallet. It hides the recipient and nothing else — the
 *    sender's wallet and the amount both land on chain.
 *
 * WHY THE AMOUNT BOX IS GONE FROM (1)
 * ───────────────────────────────────
 * A note is one of six fixed sizes. You cannot hand over 0.2 SOL privately; you
 * shield 0.1 or 1, and what you hand over is that note. A free-form number is
 * not a smaller version of this feature, it is the other feature — so it lives
 * under its own tab with its own disclosure, rather than as an option inside a
 * flow that would then be lying about what it hides.
 *
 * WHAT IS CLAIMED HERE AND WHAT IS NOT
 * ────────────────────────────────────
 * Claimed: the handoff itself creates no on-chain record. That is a property of
 * there being no transaction, not of a proof, so it needs no circuit and cannot
 * regress.
 * NOT claimed: that the note becomes untraceable. When the recipient withdraws,
 * that withdrawal republishes the commitment the ORIGINAL deposit published, so
 * the exit is publicly matchable to the sender's deposit — measured on devnet
 * (leaf 16, commitment 8901821612542787864, present in both the deposit and the
 * withdrawal). The disclosure box below says exactly that. Do not soften it
 * before `docs/C7_SPEND_CIRCUIT_PLAN.md` ships.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "react-qr-code";
import type { PublicKey } from "@solana/web3.js";
import {
  ArrowRight,
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import type {
  Asset,
  ChainStealthAdapter,
  ResolvedRecipient,
  TxRef,
} from "@/lib/privacy/chains/types";
import type { PoolNoteView } from "@/lib/privacy/worker/poolHandlers";
import { loadEncryptedNotes, scanPool, scanPoolLocal } from "@/lib/privacy/shieldClient";
import {
  isP01NoteAddress,
  sealNoteFor,
  type SealedNoteHandoff,
} from "@/lib/privacy/noteTransfer";
import FeeRow from "./FeeRow";
import HonestyBadge from "./HonestyBadge";
import { formatAmount, truncate } from "./util";

type Mode = "note" | "stealth";

function noteKey(n: PoolNoteView): string {
  return `${n.pool}:${n.leafIndex}`;
}

/**
 * Largest byte payload a QR code can carry: version 40, error correction L
 * (ISO/IEC 18004). A sealed note is ML-KEM-768 ciphertext plus the note JSON,
 * so it runs ~1,900 characters and normally fits — but a note carrying a full
 * 15-element Merkle path can pass this, and react-qr-code throws rather than
 * degrading. Checking first turns a crashed panel into one honest sentence.
 */
const QR_BYTE_CAPACITY = 2_900;

export default function SendForm({
  adapter,
  asset,
  meta,
  owner,
}: {
  adapter: ChainStealthAdapter;
  asset: Asset;
  /**
   * Pool session key from `deriveMeta`, and the connected wallet.
   *
   * Optional ONLY so this component keeps compiling for a caller that has not
   * been wired yet; the note handoff needs both (the session key selects the
   * worker's pool seed, the wallet selects the locally stored note blobs) and
   * says so on screen rather than silently hiding the tab.
   */
  meta?: string | null;
  owner?: PublicKey | null;
}) {
  const poolReady = !!meta && !!owner;
  const [mode, setMode] = useState<Mode>(poolReady ? "note" : "stealth");

  // ── Stealth send (path 2) ────────────────────────────────────────────────
  const [recipientInput, setRecipientInput] = useState("");
  const recipientRef = useRef("");
  const [resolved, setResolved] = useState<ResolvedRecipient | null>(null);
  const [resolving, setResolving] = useState(false);
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TxRef | null>(null);

  // ── Note handoff (path 1) ────────────────────────────────────────────────
  const [notes, setNotes] = useState<PoolNoteView[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanStep, setScanStep] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [noteAddress, setNoteAddress] = useState("");
  const [sealing, setSealing] = useState(false);
  const [sealStep, setSealStep] = useState<string | null>(null);
  const [sealError, setSealError] = useState<string | null>(null);
  const [sealed, setSealed] = useState<SealedNoteHandoff | null>(null);
  const [copied, setCopied] = useState(false);

  const amountNum = Number(amount) || 0;
  const quote = useMemo(() => adapter.quoteFees(asset, amountNum), [adapter, asset, amountNum]);
  const belowMin = amountNum > 0 && amountNum < quote.minSend;
  const canSend = !!resolved && amountNum >= quote.minSend && !sending;

  const rescan = useCallback(async () => {
    if (!meta) return;
    setScanning(true);
    setScanError(null);
    try {
      // FIRST PAINT, no network. Notes shielded from this browser are already in
      // local storage, encrypted under the pool seed, and carry pool, leaf index,
      // denomination and commitment. Drawing them costs milliseconds; the chain
      // walk below costs tens of seconds on the public devnet RPC and the user
      // was watching "Scanning the 0.1 SOL pool..." the whole time.
      //
      // These arrive with `spentKnown: false` — nothing here has seen a nullifier
      // PDA — so they are provisional until the scan below replaces them.
      try {
        const local = await scanPoolLocal(meta, owner!.toBase58());
        if (local.notes.length > 0) setNotes(local.notes);
      } catch {
        // A missing or unreadable blob store is not an error worth showing:
        // the authoritative scan runs next regardless.
      }
      const res = await scanPool(meta, "SOL", setScanStep);
      setNotes(res.notes);
    } catch (e) {
      setScanError((e as Error).message || "Pool scan failed.");
    } finally {
      setScanning(false);
      setScanStep(null);
    }
  }, [meta]);

  useEffect(() => {
    if (mode === "note" && poolReady) void rescan();
  }, [mode, poolReady, rescan]);

  const unspent = notes.filter((n) => !n.spent);
  const chosen = unspent.find((n) => noteKey(n) === selected) ?? null;
  const addressLooksRight = isP01NoteAddress(noteAddress);
  const canSeal = !!chosen && addressLooksRight && !sealing;

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

  async function handleSeal() {
    if (!meta || !owner || !chosen) return;
    // Checked here as well as inside `sealNoteFor` and again in the worker. The
    // point of the check at THIS layer is that it costs nothing: without it a
    // mistyped address is only reported after a full pool scan, which on devnet
    // is minutes of history-walking.
    if (!isP01NoteAddress(noteAddress)) {
      setSealError(
        'That is not a Protocol 01 note address. It starts with "p01pq:" — ask the recipient for theirs.',
      );
      return;
    }
    setSealError(null);
    setSealing(true);
    try {
      setSealed(
        await sealNoteFor({
          meta,
          token: chosen.token,
          denomination: chosen.denomination,
          leafIndex: chosen.leafIndex,
          recipientAddress: noteAddress,
          encryptedNotes: loadEncryptedNotes(owner.toBase58()),
          onProgress: setSealStep,
        }),
      );
    } catch (e) {
      setSealError((e as Error).message || "Could not seal this note.");
    } finally {
      setSealing(false);
      setSealStep(null);
    }
  }

  function copySealed() {
    if (!sealed) return;
    void navigator.clipboard.writeText(sealed.sealedNote);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // ── Result screens ───────────────────────────────────────────────────────

  if (sealed) {
    const qrFits = sealed.sealedNote.length <= QR_BYTE_CAPACITY;
    return (
      <div className="space-y-4">
        <div className="card p-4">
          <div className="flex items-start gap-3">
            <Check className="mt-0.5 h-5 w-5 shrink-0 text-p01-cyan" />
            <div className="min-w-0">
              <p className="font-display text-p01-text">
                Sealed {sealed.denomination} {chosen?.token ?? "SOL"} note
              </p>
              <p className="mt-1 text-sm text-p01-text-muted">
                Nothing was sent. Give the recipient the string below, by any channel — it is
                encrypted to their address, so it is useless to anyone else in transit.
              </p>
            </div>
          </div>

          <code
            data-testid="sealed-note"
            className="mt-4 block max-h-40 overflow-y-auto break-all rounded-lg border border-p01-border bg-p01-void p-3 font-mono text-xs text-p01-cyan"
          >
            {sealed.sealedNote}
          </code>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={copySealed}
              className="btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy sealed note"}
            </button>
            <span className="font-mono text-xs text-p01-text-dim">
              leaf #{sealed.leafIndex} · {truncate(sealed.commitment, 6, 4)}
            </span>
          </div>

          {qrFits ? (
            <div className="mt-4 flex flex-col items-center gap-2">
              <div className="rounded-lg bg-white p-2">
                <QRCode value={sealed.sealedNote} size={180} />
              </div>
              <p className="text-center text-xs text-p01-text-dim">
                {sealed.sealedNote.length.toLocaleString()} characters — a dense code. If a camera
                struggles with it, copy the text instead.
              </p>
            </div>
          ) : (
            <p className="mt-4 text-xs text-p01-text-muted">
              Too long for a QR code ({sealed.sealedNote.length.toLocaleString()} characters, the
              format tops out around {QR_BYTE_CAPACITY.toLocaleString()}). Copy the text.
            </p>
          )}
        </div>

        {/* Everything a user could get wrong from here. All three are
            properties of the mechanism, not warnings about bugs. */}
        <div className="rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
          <p className="font-medium">This string is now the money.</p>
          <div className="mt-1.5 space-y-2 text-p01-red/90">
            <p>
              Once the recipient opens it, whoever holds the contents can withdraw the note. It is
              a bearer instrument, like cash — there is no account it belongs to and no way to
              cancel it.
            </p>
            <p>
              You can still withdraw this note yourself. Handing it over does not consume it: the
              secrets come from your own pool seed, so both of you hold a spendable copy until one
              of you spends it. Whoever goes first wins and the other copy stops working.
            </p>
            <p>
              {sealed.merklePath === "none"
                ? "No Merkle path travelled with this note, so the recipient's wallet has to rebuild it from this pool's history before withdrawing."
                : "The note carries its Merkle path, so the recipient can withdraw without rebuilding the pool's history."}
            </p>
          </div>
        </div>

        <button
          className="btn-secondary w-full"
          onClick={() => {
            setSealed(null);
            setSelected(null);
            setNoteAddress("");
            void rescan();
          }}
        >
          Hand over another note
        </button>
      </div>
    );
  }

  if (result) {
    return (
      <div className="space-y-4">
        <div className="card flex items-start gap-3 p-4">
          <Check className="mt-0.5 h-5 w-5 shrink-0 text-p01-cyan" />
          <div className="min-w-0">
            {/*
              This used to read "Private send submitted … hidden behind a one-time
              stealth address", which contradicted the HonestyBadge sitting a few
              lines above it on the same screen. The badge is the accurate one:
              this path does not touch the pool, so the sender's wallet and the
              amount are both public and only the recipient is hidden. The success
              toast is what a user remembers, so it is the last place that should
              overstate.
            */}
            <p className="font-display text-p01-text">Sent to a one-time address</p>
            <p className="mt-1 text-sm text-p01-text-muted">
              {formatAmount(amountNum, asset.symbol)} to {resolved?.label}. The recipient is
              hidden; your wallet and the amount are on-chain in the clear.
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

  // ── Form ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* The two paths are not settings of one send — they hide different
          things — so they get a switch and separate disclosures. */}
      <div className="inline-flex w-full rounded-lg border border-p01-border bg-p01-surface p-1">
        <button
          type="button"
          onClick={() => setMode("note")}
          className={
            mode === "note"
              ? "flex-1 rounded-md bg-p01-cyan px-3 py-1.5 text-sm font-medium text-p01-void"
              : "flex-1 rounded-md px-3 py-1.5 text-sm font-medium text-p01-text-muted hover:text-p01-text"
          }
        >
          Hand over a note
        </button>
        <button
          type="button"
          onClick={() => setMode("stealth")}
          className={
            mode === "stealth"
              ? "flex-1 rounded-md bg-p01-cyan px-3 py-1.5 text-sm font-medium text-p01-void"
              : "flex-1 rounded-md px-3 py-1.5 text-sm font-medium text-p01-text-muted hover:text-p01-text"
          }
        >
          Stealth send
        </button>
      </div>

      {mode === "note" ? (
        !poolReady ? (
          <div className="card p-4 text-sm text-p01-text-muted">
            Handing over a note needs your derived pool keys and a connected wallet. Reconnect and
            sign to derive, then come back.
          </div>
        ) : (
          <>
            {/* Recipient's note address */}
            <div>
              <label
                htmlFor="p01-note-address"
                className="mb-1.5 block text-xs uppercase tracking-wider text-p01-text-muted"
              >
                Recipient&apos;s note address
              </label>
              <input
                id="p01-note-address"
                value={noteAddress}
                onChange={(e) => setNoteAddress(e.target.value)}
                placeholder="p01pq:…"
                className="card w-full bg-p01-void px-4 py-3 font-mono text-sm text-p01-text outline-none placeholder:text-p01-text-dim focus:border-p01-cyan"
              />
              {noteAddress.trim().length > 0 &&
                (addressLooksRight ? (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-p01-cyan">
                    <Check className="h-3.5 w-3.5" /> Valid note address · X25519 + ML-KEM-768
                  </p>
                ) : (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-p01-yellow">
                    <TriangleAlert className="h-3.5 w-3.5" /> Not a note address. It starts with
                    &quot;p01pq:&quot;.
                  </p>
                ))}
              <p className="mt-1.5 text-xs text-p01-text-muted">
                This is not a wallet address and not a st: meta-address. The recipient finds theirs
                on the Import note screen of the Protocol 01 extension.
              </p>
            </div>

            {/* Note picker — this is the amount field. */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="block text-xs uppercase tracking-wider text-p01-text-muted">
                  Note to hand over
                </span>
                <button
                  type="button"
                  onClick={rescan}
                  disabled={scanning || sealing}
                  className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
                >
                  <RefreshCw className={scanning ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
                  {scanning ? "Scanning…" : "Rescan"}
                </button>
              </div>

              {scanStep && <p className="mb-2 text-xs text-p01-text-dim">{scanStep}</p>}
              {scanError && <p className="mb-2 text-sm text-p01-red">{scanError}</p>}

              {!scanning && unspent.length === 0 && !scanError && (
                <p className="text-xs text-p01-text-muted">
                  No unspent notes. Shield one in the Pool tab first — you cannot hand over 0.2 SOL,
                  you hand over a note, and a note is one of the fixed pool sizes.
                </p>
              )}

              {unspent.length > 0 && (
                <ul className="space-y-2">
                  {unspent.map((n) => {
                    const k = noteKey(n);
                    const active = k === selected;
                    return (
                      <li key={`${n.pool}:${n.counter}`}>
                        <button
                          type="button"
                          onClick={() => setSelected(k)}
                          disabled={sealing}
                          aria-pressed={active}
                          className={
                            active
                              ? "flex w-full items-center justify-between gap-3 rounded-lg border border-p01-cyan bg-p01-cyan/10 p-3 text-left"
                              : "flex w-full items-center justify-between gap-3 rounded-lg border border-p01-border bg-p01-void p-3 text-left hover:border-p01-border-hover disabled:opacity-50"
                          }
                        >
                          <div className="min-w-0">
                            <p
                              className={
                                active
                                  ? "font-mono text-sm text-p01-cyan"
                                  : "font-mono text-sm text-p01-text"
                              }
                            >
                              {n.denomination} {n.token}
                            </p>
                            <p className="truncate font-mono text-xs text-p01-text-muted">
                              leaf #{n.leafIndex} · {truncate(n.commitment, 6, 4)}
                            </p>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* What this path does and does not hide. */}
            <div className="rounded-lg border border-p01-cyan/30 bg-p01-cyan/5 p-3 text-xs text-p01-cyan">
              <p className="font-medium">No transaction is sent. That is what makes it private.</p>
              <div className="mt-1.5 space-y-2 text-p01-cyan/90">
                <p>
                  Handing over a note moves nothing on chain: the recipient simply ends up holding
                  its secrets. There is no transfer to observe, so there is no sender, no
                  recipient, no amount and no timing for anyone to correlate — and no fee.
                </p>
                <p className="text-p01-yellow">
                  What it does not hide: when they withdraw, the withdrawal publishes the same note
                  commitment your deposit published, so that exit is publicly matchable to your
                  deposit. Measured on devnet. The handoff is invisible; the note leaving the pool
                  is not.
                </p>
                <p className="text-p01-yellow">
                  You keep a spendable copy. The note is not consumed or locked by handing it over —
                  whoever withdraws first wins.
                </p>
              </div>
            </div>

            {sealError && (
              <p className="flex items-start gap-1.5 text-sm text-p01-red">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {sealError}
              </p>
            )}

            <button
              type="button"
              onClick={handleSeal}
              disabled={!canSeal}
              className="btn-primary flex w-full items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sealing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Sealing…
                </>
              ) : (
                <>
                  Seal this note to them <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>

            {sealStep && <p className="text-center text-xs text-p01-text-dim">{sealStep}</p>}
          </>
        )
      ) : (
        <>
          {/* Recipient */}
          <div>
            <label
              htmlFor="p01-stealth-recipient"
              className="mb-1.5 block text-xs uppercase tracking-wider text-p01-text-muted"
            >
              Recipient
            </label>
            <div className="flex gap-2">
              <input
                id="p01-stealth-recipient"
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
                {resolving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
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
            <label
              htmlFor="p01-stealth-amount"
              className="mb-1.5 block text-xs uppercase tracking-wider text-p01-text-muted"
            >
              Amount
            </label>
            <div className="card flex items-center gap-3 bg-p01-void px-4 py-3">
              <input
                id="p01-stealth-amount"
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
            {/*
              A free-form amount box on a privacy product reads as "type a number and
              it is private". It is not: this path funds a one-time address straight
              from the connected wallet, so the number typed here lands on chain
              beside the sender. Saying so AT THE INPUT, not only in the badge below,
              is the difference between a disclosure and a warning someone reads.

              The other tab is the path that hides the amount, and it does it by
              removing the choice — a note is one of six fixed sizes, which is what
              makes two notes of the same size indistinguishable.
            */}
            {asset.chainId === "solana" && amountNum > 0 && (
              <p className="mt-1.5 text-xs text-p01-text-muted">
                <span className="text-p01-yellow">
                  This amount and your wallet will be public.
                </span>{" "}
                To hide them, shield into the pool and hand over a note instead — notes are fixed
                at 0.1, 1, 10, 100, 500 or 1000 SOL, and a free-form amount cannot be hidden
                because it identifies itself.
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
        </>
      )}
    </div>
  );
}
