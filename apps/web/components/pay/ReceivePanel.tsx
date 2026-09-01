"use client";

/**
 * ReceivePanel - receiving means being handed a shielded note.
 *
 * Two things live here, and only two:
 *
 * 1. YOUR NOTE ADDRESS. A "p01pq:" string (public X25519 + ML-KEM-768 keys,
 *    derived in the worker from the pool seed). Whoever wants to hand you a
 *    note seals it to this address, so publishing it is the receiving half of
 *    the product: without it nobody can pay you a note at all.
 * 2. THE IMPORT. Paste the sealed "p01enc1:" string you were given; the worker
 *    opens it, recomputes the note's commitment from its secrets and refuses a
 *    mismatch, refuses a duplicate or provably spent note, then files it in
 *    this device's encrypted note store. No secret ever reaches this file.
 *
 * WHAT IS CLAIMED AND WHAT IS NOT
 * ───────────────────────────────
 * Claimed: receiving a note broadcasts nothing. There is no transaction, so
 * there is no sender, recipient, amount or timing for anyone to correlate.
 * NOT claimed: that the note is untraceable. What the withdrawal publishes went
 * CONDITIONAL when C7 shipped, and the copy below must STAY conditional rather
 * than collapse into either half: on circuit 7 (this client and the extension)
 * the withdrawal carries no commitment, so the exit is NOT matchable to the
 * deposit; from the phone, or on any note C7 cannot prove, it republishes the
 * ORIGINAL deposit's commitment and the exit IS matchable (measured on devnet).
 * And the sender keeps a spendable copy until someone spends the note.
 *
 * LAYOUT RULE (same contract as SendForm)
 * ───────────────────────────────────────
 * Two columns from `lg`, one below, action first. A sealed note is ~1,800
 * characters and the address is ~1,600: both break inside their own boxes
 * (`break-all`, internal vertical scroll) and both columns carry `min-w-0`,
 * so nothing can ever force the page to scroll horizontally. A result landing
 * below the fold on a stacked screen scrolls itself into view.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "react-qr-code";
import type { PublicKey } from "@solana/web3.js";
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type {
  ChainStealthAdapter,
  DerivedIdentity,
  StealthPayment,
} from "@/lib/privacy/chains/types";
import {
  fetchNoteReceiveAddress,
  importReceivedNote,
  type ImportNoteOutcome,
} from "@/lib/privacy/shieldClient";
import { RECEIVE_NOTE_PHASES } from "@/lib/pay/flowProgress";
import FlowProgress from "./FlowProgress";
import SuccessBurst from "./SuccessBurst";
import { formatAmount, timeAgo, truncate } from "./util";

/**
 * The stealth-payment inbox is PARKED, not deleted. Founder call, 2026-08-05.
 *
 * WHY. The stealth SEND was parked the same day (`SendForm.tsx`, commit
 * 1904d9a4): it hid the recipient and nothing else, under a name that promised
 * more, and it was somebody else's product (a plain send is Phantom's, stealth
 * addressing is Umbra's). With no way to emit a stealth payment from this
 * protocol, the inbox below had nothing left to receive: keeping a scanner for
 * payments nobody can send would be a dead end presented as a feature. What
 * remains ours is the shielded note, so this tab now receives exactly that.
 *
 * NOTHING IS DELETED. The whole inbox below still compiles: the meta-address
 * card, `adapter.scan`, `adapter.claim` and their states are intact, the same
 * treatment Starknet got in this app.
 *
 * TO BRING IT BACK: set this to false. That restores the meta-address card and
 * the incoming-payments inbox underneath the note receiver, and nothing else
 * needs to change.
 */
const STEALTH_RECEIVE_PARKED = true;

/**
 * First-visit switch for the disclosure fold, same delivery contract as
 * SendForm: the full text is owed once in full view, then folds to its
 * one-line summary and stays one click away. Content never changes.
 */
const DISCLOSURE_SEEN_KEY = "p01.pay.receive.disclosureSeen";

export default function ReceivePanel({
  adapter,
  identity,
  destination,
  meta,
  owner,
  onBusyChange,
}: {
  adapter: ChainStealthAdapter;
  identity: DerivedIdentity;
  destination: string;
  /**
   * Pool session key from `deriveMeta`, and the connected wallet. Optional
   * ONLY so this component keeps compiling for a caller that has not been
   * wired yet; receiving a note needs both (the session key selects the
   * worker's pool seed, the wallet selects the local note store) and the
   * panel says so on screen rather than silently hiding.
   */
  meta?: string | null;
  owner?: PublicKey | null;
  /** Raised while an import runs, so PayApp can badge the tab. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const poolReady = !!meta && !!owner;

  // ── Your note address ────────────────────────────────────────────────────
  const [address, setAddress] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadAddress = useCallback(async () => {
    if (!meta) return;
    setAddressError(null);
    try {
      setAddress(await fetchNoteReceiveAddress(meta));
    } catch (e) {
      setAddressError((e as Error).message || "Could not derive your note address.");
    }
  }, [meta]);

  useEffect(() => {
    if (poolReady) void loadAddress();
  }, [poolReady, loadAddress]);

  function copyAddress() {
    if (!address) return;
    void navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // ── The import ───────────────────────────────────────────────────────────
  const [blob, setBlob] = useState("");
  const [importing, setImporting] = useState(false);
  const [importStep, setImportStep] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [received, setReceived] = useState<ImportNoteOutcome | null>(null);

  useEffect(() => {
    onBusyChange?.(importing);
    return () => onBusyChange?.(false);
  }, [importing, onBusyChange]);

  // On a stacked (sub-lg) screen the result lands in the context column below
  // the form. A success the user has to find is not a confirmation, so it
  // scrolls itself into view; at lg, `block: "nearest"` makes this a no-op.
  const resultRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (received) {
      resultRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
  }, [received]);

  const trimmed = blob.trim();
  const looksSealed = trimmed.startsWith("p01enc1:");
  const canImport = looksSealed && !importing;
  // A disabled button owes its reason, next to it, every time. Nothing here is
  // gated on a scan: this tab does not scan anything.
  const importReason =
    trimmed.length === 0
      ? "Paste the sealed note you were given."
      : !looksSealed
        ? 'That is not a sealed note. A sealed note starts with "p01enc1:".'
        : null;

  async function handleImport() {
    if (!meta || !owner || !looksSealed) return;
    setImportError(null);
    setImporting(true);
    try {
      const outcome = await importReceivedNote({
        meta,
        walletPubkey: owner.toBase58(),
        sealedNote: trimmed,
        onProgress: setImportStep,
      });
      setReceived(outcome);
      setBlob("");
    } catch (e) {
      setImportError((e as Error).message || "Could not import this note.");
    } finally {
      setImporting(false);
      setImportStep(null);
    }
  }

  // ── Disclosure fold ──────────────────────────────────────────────────────
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  useEffect(() => {
    try {
      if (!window.localStorage.getItem(DISCLOSURE_SEEN_KEY)) {
        setDisclosureOpen(true);
        window.localStorage.setItem(DISCLOSURE_SEEN_KEY, "1");
      }
    } catch {
      // No storage, no memory of a first visit: open every time, which errs on
      // the side of showing the disclosure.
      setDisclosureOpen(true);
    }
  }, []);

  // ── Context-column blocks ────────────────────────────────────────────────

  function renderReceived(r: ImportNoteOutcome) {
    return (
      <div ref={resultRef} className="space-y-4">
        <SuccessBurst label={`Received a ${r.note.denomination} ${r.note.token} note`} />

        <div className="card p-4">
          {/* Both halves of the truth, on the screen the user remembers:
              receiving broadcast nothing, AND the eventual withdrawal still
              republishes the deposit's commitment. Never ship one without the
              other. */}
          <p className="text-sm text-p01-text-muted">
            The note is yours now. It is saved on this device, encrypted, and shows up in
            your note lists without any pool scan. Receiving it sent nothing to the chain;
            when it is eventually withdrawn, that withdrawal will publish the same
            commitment the original deposit published, so the exit can be matched to that
            deposit.
          </p>
          {r.note.spentKnown ? (
            <p className="mt-2 text-xs text-p01-text-muted">
              Checked against the chain just now: it has not been withdrawn.
            </p>
          ) : (
            <p className="mt-2 text-xs text-p01-yellow">
              The chain could not be reached to confirm it is still unspent. The note was
              saved anyway; the check runs again whenever your notes refresh.
            </p>
          )}
          {/* Second-plane reference: the protocol's name for this note. */}
          <p className="mt-2 font-mono text-xs text-p01-text-dim">
            leaf #{r.note.leafIndex} · {truncate(r.note.commitment, 6, 4)}
          </p>
        </div>

        {/* Everything a user could get wrong from here. All of it is a property
            of the mechanism, not a warning about a bug. */}
        <div className="rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
          <p className="font-medium">Before you count this as money:</p>
          <div className="mt-1.5 space-y-2 text-p01-red/90">
            <p>
              The sender still holds a spendable copy. Handing a note over does not erase
              its secrets on their side, and whoever withdraws first gets the funds. Until
              you have spent it, treat it as a promise from the sender, not as cash in hand.
            </p>
            <p>
              This device holds your only copy. A received note cannot be rebuilt from your
              wallet or from the chain, so clearing this browser&apos;s storage loses it.
            </p>
            <p>
              {r.merklePath === "stored"
                ? "Its withdrawal path travelled with it, so spending it will not need to rebuild the pool's history."
                : "No withdrawal path travelled with it, so spending it will first rebuild this pool's history, which takes time."}
            </p>
          </div>
        </div>

        <p className="text-xs text-p01-text-dim">
          To spend it, open the Pool tab: the note sits under Your notes with the same
          Withdraw button as a note you shielded yourself. It can also pay for a
          subscription, or be handed on from the Send tab.
        </p>

        <button className="btn-secondary w-full" onClick={() => setReceived(null)}>
          Receive another note
        </button>
      </div>
    );
  }

  function renderAddressCard() {
    return (
      <div className="card p-4">
        <p className="font-display text-sm text-p01-text">Your note address</p>
        <p className="mt-1 text-xs text-p01-text-muted">
          Whoever wants to hand you a note needs this address (or the QR). It contains only
          public keys, so it is safe to share anywhere.
        </p>

        {addressError ? (
          <div className="mt-3">
            <p className="text-sm text-p01-red">{addressError}</p>
            <button
              onClick={() => void loadAddress()}
              className="btn-secondary mt-2 inline-flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </button>
          </div>
        ) : !address ? (
          <p className="mt-3 flex items-center gap-2 text-xs text-p01-text-dim">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Deriving your address…
          </p>
        ) : (
          <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            <div className="rounded-lg bg-white p-2">
              <QRCode value={address} size={148} />
            </div>
            <div className="min-w-0 flex-1">
              <code className="block break-all rounded-lg border border-p01-border bg-p01-void p-3 font-mono text-xs text-p01-cyan">
                {truncate(address, 16, 12)}
              </code>
              <button
                onClick={copyAddress}
                className="btn-secondary mt-2 inline-flex items-center gap-2 px-3 py-1.5 text-xs"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy note address"}
              </button>
              {/* Second plane: what the address actually is. */}
              <p className="mt-2 text-xs text-p01-text-dim">
                An X25519 and an ML-KEM-768 public key, a post-quantum pair. Notes sealed to
                it can only be opened by this wallet&apos;s derived keys.
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── The retired stealth-payment inbox, kept compiling. ───────────────────

  const [payments, setPayments] = useState<StealthPayment[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [metaCopied, setMetaCopied] = useState(false);

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
    // Parked: nobody can emit a stealth payment from this protocol anymore, so
    // scanning for one would only burn RPC quota looking busy.
    if (STEALTH_RECEIVE_PARKED) return;
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
    setMetaCopied(true);
    setTimeout(() => setMetaCopied(false), 1500);
  }

  const pending = payments.filter((p) => !p.claimed);

  function renderStealthInbox() {
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
                {metaCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {metaCopied ? "Copied" : "Copy meta-address"}
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
              Unshielding sends the funds to your connected wallet, that final hop is public
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

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {!poolReady ? (
        <div className="card p-4 text-sm text-p01-text-muted">
          Receiving a note needs your derived pool keys and a connected wallet. Reconnect and
          sign to derive, then come back.
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Main column: the action. */}
          <div className="min-w-0 space-y-4">
            <div>
              <label
                htmlFor="p01-sealed-note"
                className="mb-1.5 block text-xs uppercase tracking-wider text-p01-text-muted"
              >
                Sealed note you were given
              </label>
              <textarea
                id="p01-sealed-note"
                value={blob}
                onChange={(e) => setBlob(e.target.value)}
                placeholder="p01enc1:…"
                rows={5}
                spellCheck={false}
                className="card w-full resize-y break-all bg-p01-void px-4 py-3 font-mono text-xs text-p01-text outline-none placeholder:text-p01-text-dim focus:border-p01-cyan"
              />
              {trimmed.length > 0 &&
                (looksSealed ? (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-p01-cyan">
                    <Check className="h-3.5 w-3.5" /> Looks like a sealed note
                  </p>
                ) : (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-p01-yellow">
                    <TriangleAlert className="h-3.5 w-3.5" /> Not a sealed note. It starts with
                    &quot;p01enc1:&quot;.
                  </p>
                ))}
              <p className="mt-1.5 text-xs text-p01-text-muted">
                The sender makes this string on their Send tab by sealing a note to your
                address on the right.
              </p>
            </div>

            {importError && (
              <p className="flex items-start gap-1.5 text-sm text-p01-red">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {importError}
              </p>
            )}

            <button
              type="button"
              onClick={handleImport}
              disabled={!canImport}
              className="btn-primary flex w-full items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Importing…
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" /> Add it to my notes
                </>
              )}
            </button>
            {!importing && importReason && (
              <p className="text-center text-xs text-p01-text-dim">{importReason}</p>
            )}

            <FlowProgress phases={RECEIVE_NOTE_PHASES} step={importStep} running={importing} />
          </div>

          {/* Secondary column: the address to publish, then the context,
              replaced by the result when one lands. */}
          <div className="min-w-0 space-y-4">
            {renderAddressCard()}

            {received ? (
              renderReceived(received)
            ) : (
              /* What receiving does and does not hide. Full text delivered as a
                 one-line summary plus a fold, open on the first visit. */
              <details
                className="group rounded-lg border border-p01-cyan/30 bg-p01-cyan/5"
                open={disclosureOpen}
                onToggle={(e) => setDisclosureOpen(e.currentTarget.open)}
              >
                <summary className="flex cursor-pointer select-none items-start gap-2 p-3 text-xs text-p01-cyan [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
                  <span>
                    Receiving a note broadcasts nothing. Its later exit from the pool can
                    still be matched to the original deposit.
                  </span>
                </summary>
                <div className="space-y-2 px-3 pb-3 text-xs text-p01-cyan/90">
                  <p className="font-medium text-p01-cyan">
                    Nothing goes on chain when a note changes hands.
                  </p>
                  <p>
                    You are handed the note&apos;s secrets, sealed to your address. There is
                    no transaction, so there is no sender, no recipient, no amount and no
                    timing for anyone to correlate, and no fee.
                  </p>
                  <p className="text-p01-yellow">
                    What it does not hide depends on where it is withdrawn. From here or the
                    extension, on circuit 7, the withdrawal carries no commitment and that exit
                    is NOT matchable to the deposit. From the phone, or on any note circuit 7
                    cannot prove, it republishes the deposit&apos;s commitment and that exit IS
                    publicly matchable to it. Measured on devnet.
                  </p>
                  <p className="text-p01-yellow">
                    Until someone withdraws it, the sender keeps a spendable copy of the
                    note. Whoever spends first wins.
                  </p>
                  <p className="text-p01-cyan/70">
                    For the curious: your address carries an X25519 and an ML-KEM-768 public
                    key (a post-quantum pair), and this device recomputes the note&apos;s
                    commitment from its secrets before accepting it.
                  </p>
                </div>
              </details>
            )}
          </div>
        </div>
      )}

      {!STEALTH_RECEIVE_PARKED && renderStealthInbox()}
    </div>
  );
}
