"use client";

/**
 * SendForm - two ways to send, which are not variants of each other.
 *
 * 1. HAND OVER A SHIELDED NOTE (default). Pick one of your existing notes, seal
 *    it to the recipient's note address, give them the string. There is no
 *    transaction: the recipient ends up holding the note's secrets and
 *    withdraws it later as their own. Nothing is broadcast, so there is no
 *    send for anyone to pair with a receive.
 *
 * 2. STEALTH SEND. The original path: fund a fresh one-time address straight
 *    from the connected wallet. It hides the recipient and nothing else; the
 *    sender's wallet and the amount both land on chain.
 *
 * LAYOUT RULE (2026-08-05 rework)
 * ───────────────────────────────
 * Two columns from `lg`, one below. The main column is the action: the note
 * picker (the note IS the amount), the recipient, the button, the progress.
 * The secondary column is the context: the folded disclosure, replaced by the
 * result when one lands. On mobile everything stacks, action first; a result
 * that lands below the fold there scrolls itself into view. Nothing important
 * may sit below the fold on a 1080p screen, and nothing may ever force
 * horizontal scrolling: the sealed string breaks inside its own box, the QR
 * is fixed-size, and both columns carry `min-w-0` so a long mono string can
 * never widen the page. Each mode keeps its full disclosure text verbatim,
 * delivered as a one-line summary that is always visible plus a fold holding
 * the detail, open on the first visit and closed after. Protocol vocabulary
 * (leaf, commitment, ML-KEM) stays available but moves to the second plane.
 * Both modes drive a FlowProgress bar while they run and a SuccessBurst when
 * they land, per the founder's ruling that every flow gets progress and every
 * success gets a confirmation beat.
 *
 * WHY THE AMOUNT BOX IS GONE FROM (1)
 * ───────────────────────────────────
 * A note is one of six fixed sizes. You cannot hand over 0.2 SOL privately; you
 * shield 0.1 or 1, and what you hand over is that note. A free-form number is
 * not a smaller version of this feature, it is the other feature, so it lives
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
 * the exit is publicly matchable to the sender's deposit; measured on devnet
 * (leaf 16, commitment 8901821612542787864, present in both the deposit and the
 * withdrawal). The disclosure fold below says exactly that. Do not soften it
 * before `docs/C7_SPEND_CIRCUIT_PLAN.md` ships.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import QRCode from "react-qr-code";
import type { PublicKey } from "@solana/web3.js";
import {
  ArrowRight,
  Check,
  ChevronRight,
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
import {
  loadEncryptedNotes,
  knownSpentNoteKeys,
  mergeScanWithLocal,
  resolveSpentNotes,
  scanPool,
  scanPoolLocal,
} from "@/lib/privacy/shieldClient";
import {
  isP01NoteAddress,
  sealNoteFor,
  type SealedNoteHandoff,
} from "@/lib/privacy/noteTransfer";
import { SEAL_PHASES, STEALTH_SEND_PHASES } from "@/lib/pay/flowProgress";
import { handoffKeys, recordHandoff } from "@/lib/pay/handoffs";
import FeeRow from "./FeeRow";
import FlowProgress from "./FlowProgress";
import HonestyBadge from "./HonestyBadge";
import StaleWorkerNotice from "./StaleWorkerNotice";
import SuccessBurst from "./SuccessBurst";
import { formatAmount, truncate } from "./util";

type Mode = "note" | "stealth";

/**
 * The stealth send is PARKED, not deleted. Founder call, 2026-08-05.
 *
 * WHY. It hides the recipient and nothing else: the wallet signs, pays, funds
 * the one-time address and the amount is public, which the disclosure had to
 * spell out under a tab named "Stealth send". A name that promises more than
 * the mechanism gives is the exact defect this project audited out of its own
 * README. And the capability is not what anyone comes here for: a plain send is
 * Phantom's, stealth addressing is Umbra's, both are one click away elsewhere.
 * What is ours is the shielded note: post-quantum encryption, ZK proofs,
 * unlinkability from the funding wallet, and a subscription to a vetted privacy
 * merchant. Offering a weaker version of someone else's product beside it
 * dilutes the proposition instead of widening it.
 *
 * NOTHING IS DELETED. The whole stealth branch below still compiles, its tests
 * still run, `adapter.send` and the pay-core stealth path are untouched. This
 * mirrors how Starknet was retired from this app: out of the UI, reason and
 * undo recorded in the source, code intact.
 *
 * TO BRING IT BACK: set this to false. That restores the mode switch and the
 * initial-mode fallback, and nothing else needs to change. If it comes back,
 * rename it for what it hides ("Pay a private address"), because the old name
 * is what made it misread.
 */
const STEALTH_SEND_PARKED = true;

function noteKey(n: PoolNoteView): string {
  return `${n.pool}:${n.leafIndex}`;
}

/**
 * Largest byte payload a QR code can carry: version 40, error correction L
 * (ISO/IEC 18004). A sealed note is ML-KEM-768 ciphertext plus the note JSON,
 * so it runs ~1,900 characters and normally fits, but a note carrying a full
 * 15-element Merkle path can pass this, and react-qr-code throws rather than
 * degrading. Checking first turns a crashed panel into one honest sentence.
 */
const QR_BYTE_CAPACITY = 2_900;

/**
 * First-visit switch for the disclosure folds. The full text is owed to the
 * user once in full view; from the second visit on it folds to its one-line
 * summary and stays one click away. Delivery changes, content does not.
 */
const DISCLOSURE_SEEN_KEY = "p01.pay.send.disclosureSeen";

export default function SendForm({
  adapter,
  asset,
  meta,
  owner,
  onBusyChange,
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
  /**
   * Raised while this panel is running something that locks funds or must not
   * be perceived as vanished. PayApp badges the tab with it, so a user who
   * navigates away mid-operation can find their way back instead of assuming it
   * died and starting a second one, which would lock a second proof buffer.
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const poolReady = !!meta && !!owner;
  const [mode, setMode] = useState<Mode>(poolReady || STEALTH_SEND_PARKED ? "note" : "stealth");

  // ── Disclosure fold (both modes) ─────────────────────────────────────────
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  useEffect(() => {
    try {
      if (!window.localStorage.getItem(DISCLOSURE_SEEN_KEY)) {
        setDisclosureOpen(true);
        window.localStorage.setItem(DISCLOSURE_SEEN_KEY, "1");
      }
    } catch {
      // No storage, no memory of a first visit: open every time, which errs
      // on the side of showing the disclosure.
      setDisclosureOpen(true);
    }
  }, []);
  function onDisclosureToggle(e: SyntheticEvent<HTMLDetailsElement>) {
    setDisclosureOpen(e.currentTarget.open);
  }

  // ── Stealth send (path 2) ────────────────────────────────────────────────
  const [recipientInput, setRecipientInput] = useState("");
  const recipientRef = useRef("");
  const [resolved, setResolved] = useState<ResolvedRecipient | null>(null);
  const [resolving, setResolving] = useState(false);
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [sendStep, setSendStep] = useState<string | null>(null);
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

  // One boolean for the whole panel, derived rather than raised by hand in every
  // try/finally: a single missed exit path would leave the tab badged forever.
  // The cleanup also clears it when the panel unmounts, which is exactly the
  // case that motivated the badge, a user switching tabs mid-operation.
  const panelBusy = sending || sealing;
  useEffect(() => {
    onBusyChange?.(panelBusy);
    return () => onBusyChange?.(false);
  }, [panelBusy, onBusyChange]);

  const [sealStep, setSealStep] = useState<string | null>(null);
  const [sealError, setSealError] = useState<string | null>(null);
  const [sealed, setSealed] = useState<SealedNoteHandoff | null>(null);
  const [copied, setCopied] = useState(false);

  // On a stacked (sub-lg) screen the result lands in the context block below
  // the form, i.e. possibly below the fold. A success the user has to find is
  // not a confirmation, so it scrolls itself into view. At lg the columns sit
  // side by side and `block: "nearest"` makes this a no-op.
  const resultRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (sealed || result) {
      resultRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
  }, [sealed, result]);

  const amountNum = Number(amount) || 0;
  const quote = useMemo(() => adapter.quoteFees(asset, amountNum), [adapter, asset, amountNum]);
  const belowMin = amountNum > 0 && amountNum < quote.minSend;
  const canSend = !!resolved && amountNum >= quote.minSend && !sending;

  const rescan = useCallback(async () => {
    if (!meta || !owner) return;
    setScanning(true);
    setScanError(null);
    try {
      // FIRST PAINT, no network. Notes shielded from this browser are already in
      // local storage, encrypted under the pool seed, and carry pool, leaf index,
      // denomination and commitment. Drawing them costs milliseconds; the chain
      // walk below costs tens of seconds on the public devnet RPC and the user
      // was watching "Scanning the 0.1 SOL pool..." the whole time.
      //
      // These arrive with `spentKnown: false`; nothing here has seen a nullifier
      // PDA, so they are provisional until the scan below reconciles them.
      let localNotes: PoolNoteView[] = [];
      try {
        const local = await scanPoolLocal(meta, owner.toBase58());
        if (local.notes.length > 0) {
          localNotes = local.notes;
          setNotes(local.notes);
        }
      } catch {
        // A missing or unreadable blob store is not an error worth showing:
        // the authoritative scan runs next regardless.
      }

      // Ask the chain which of these are already spent. The full pool walk would
      // answer eventually and does not finish in any time a user waits, while
      // this is one getAccountInfo per locally known note, so a note spent in an
      // earlier session or on another device drops out within seconds. It only
      // ever confirms spent, never un-spends, so a failed read leaves the note
      // exactly where it was. Fire and forget: the filter below does the rest.
      if (owner) {
        const ownerKey = owner.toBase58();
        // MERGED, not assigned: the read is async now (encrypted store, worker
        // opens it), and a plain set could race the seal handler's write.
        void resolveSpentNotes(meta, ownerKey)
          .then(() => knownSpentNoteKeys(meta, ownerKey))
          .then((res) => {
            setSpentHere((prev) => new Set([...prev, ...res.keys]));
            setStaleWorker((prev) => prev || res.staleWorker);
          })
          .catch(() => {});
      }
      const res = await scanPool(meta, "SOL", setScanStep);
      // MERGE, not replace: a RECEIVED note's secrets came from the sender's
      // seed, so the seed-deriving chain scan can never return it; replacing
      // wholesale dropped it from this picker the moment the slow scan landed.
      setNotes(mergeScanWithLocal(res.notes, localNotes));
    } catch (e) {
      setScanError((e as Error).message || "Pool scan failed.");
    } finally {
      setScanning(false);
      setScanStep(null);
    }
  }, [meta, owner]);

  useEffect(() => {
    if (mode === "note" && poolReady) void rescan();
  }, [mode, poolReady, rescan]);

  // `spent` on a locally-painted note is a default, not a reading, so also drop
  // what this browser has already withdrawn. Handing over a spent note would
  // give the recipient something they can never claim.
  // State, not a memo: the chain resolution below adds to it, and a memo keyed
  // on `owner` would not recompute after that write.
  const [spentHere, setSpentHere] = useState<ReadonlySet<string>>(new Set());
  /** Notes already handed to someone and not yet claimed. Not spendable-safe to
   *  hand over a second time: that would promise one coin to two people. */
  const [handedOver, setHandedOver] = useState<ReadonlySet<string>>(new Set());
  // A version-skewed worker left `spentHere` or `handedOver` SHORT (see
  // StaleWorkerNotice): this picker may then re-offer a note already spent or
  // already promised to someone. Latched with `|| next` since two async reads
  // feed it; reset on a wallet switch with the sets it describes.
  const [staleWorker, setStaleWorker] = useState(false);
  useEffect(() => {
    // Async read (encrypted store), with a stale guard so a slow answer never
    // paints one wallet's spends onto another after a switch.
    setSpentHere(new Set());
    setStaleWorker(false);
    let stale = false;
    if (owner) {
      void knownSpentNoteKeys(meta ?? null, owner.toBase58())
        .then((res) => {
          if (!stale) {
            setSpentHere(res.keys);
            setStaleWorker((prev) => prev || res.staleWorker);
          }
        })
        .catch(() => {});
    }
    setHandedOver(new Set());
    if (owner) {
      void handoffKeys(meta ?? null, owner.toBase58())
        .then((res) => {
          if (!stale) {
            setHandedOver(res.keys);
            setStaleWorker((prev) => prev || res.staleWorker);
          }
        })
        .catch(() => {});
    }
    return () => {
      stale = true;
    };
  }, [meta, owner]);
  // A note already handed to someone is withheld from this picker: handing the
  // same coin to a second person promises both of them money only one can take.
  // It stays withdrawable in the Pool tab, which is how a sender takes it back.
  const unspent = notes.filter(
    (n) => !n.spent && !spentHere.has(noteKey(n)) && !handedOver.has(noteKey(n)),
  );
  const chosen = unspent.find((n) => noteKey(n) === selected) ?? null;
  const addressLooksRight = isP01NoteAddress(noteAddress);
  const canSeal = !!chosen && addressLooksRight && !sealing;

  // A disabled button owes its reason, next to it, every time. `scanning` is
  // deliberately absent from both: the pool scan is combinatorial and must
  // never gate an action button.
  const sealReason = !chosen
    ? unspent.length === 0
      ? "Shield a note in the Pool tab first."
      : "Pick a note above to hand over."
    : noteAddress.trim().length === 0
      ? "Paste the recipient's note address."
      : !addressLooksRight
        ? "Fix the recipient address above first."
        : null;
  const sendReason = !resolved
    ? "Enter a recipient first."
    : amountNum <= 0
      ? "Enter an amount."
      : belowMin
        ? `The minimum send is ${formatAmount(quote.minSend, asset.symbol)}.`
        : null;

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
    // The only step this page can truthfully report: `adapter.send` builds the
    // transfer, opens the wallet and submits as one opaque call, so the bar
    // gets one synthesized step rather than invented sub-steps.
    setSendStep("Sending to a fresh one-time address. Approve the transfer in your wallet...");
    try {
      setResult(await adapter.send({ recipient: resolved, asset, amount: amountNum }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      setSendStep(null);
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
        'That is not a Protocol 01 note address. It starts with "p01pq:". Ask the recipient for theirs.',
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
          encryptedNotes: await loadEncryptedNotes(meta, owner.toBase58()),
          onProgress: setSealStep,
        }),
      );
      // The note is NOT spent by sealing, so it stays in the lists. What
      // changed is that somebody else can now spend it at any moment, and this
      // record is what lets the UI say so, and keep the note out of the pickers
      // that would hand it over twice or lock it into a subscription.
      await recordHandoff(meta, owner.toBase58(), {
        pool: chosen.pool,
        leafIndex: chosen.leafIndex,
        sealedAt: Date.now(),
      });
      setHandedOver((prev) => new Set(prev).add(noteKey(chosen)));
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

  // ── Context-column blocks ────────────────────────────────────────────────

  function renderSealedResult(s: SealedNoteHandoff) {
    const qrFits = s.sealedNote.length <= QR_BYTE_CAPACITY;
    return (
      <div ref={resultRef} className="space-y-4">
        <SuccessBurst label={`Sealed a ${s.denomination} ${chosen?.token ?? "SOL"} note`} />

        <div className="card p-4">
          <p className="text-sm text-p01-text-muted">
            Nothing was sent. Give the recipient the string below, by any channel: it is
            encrypted to their address, so it is useless to anyone else in transit.
          </p>

          <code
            data-testid="sealed-note"
            className="mt-4 block max-h-40 overflow-y-auto break-all rounded-lg border border-p01-border bg-p01-void p-3 font-mono text-xs text-p01-cyan"
          >
            {s.sealedNote}
          </code>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={copySealed}
              className="btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy sealed note"}
            </button>
            {/* Second-plane reference: lets the sender tell two handoffs apart. */}
            <span className="font-mono text-xs text-p01-text-dim">
              leaf #{s.leafIndex} · {truncate(s.commitment, 6, 4)}
            </span>
          </div>

          {qrFits ? (
            <div className="mt-4 flex flex-col items-center gap-2">
              <div className="rounded-lg bg-white p-2">
                <QRCode value={s.sealedNote} size={180} />
              </div>
              <p className="text-center text-xs text-p01-text-dim">
                {s.sealedNote.length.toLocaleString()} characters, a dense code. If a camera
                struggles with it, copy the text instead.
              </p>
            </div>
          ) : (
            <p className="mt-4 text-xs text-p01-text-muted">
              Too long for a QR code ({s.sealedNote.length.toLocaleString()} characters, the
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
              a bearer instrument, like cash: there is no account it belongs to and no way to
              cancel it.
            </p>
            <p>
              You can still withdraw this note yourself. Handing it over does not consume it: the
              secrets come from your own pool seed, so both of you hold a spendable copy until one
              of you spends it. Whoever goes first wins and the other copy stops working.
            </p>
            <p>
              {s.merklePath === "none"
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

  function renderSendResult(r: TxRef) {
    return (
      <div ref={resultRef} className="space-y-4">
        {/*
          This block used to read "Private send submitted … hidden behind a
          one-time stealth address", which contradicted the HonestyBadge it sat
          next to. The badge is the accurate one: this path does not touch the
          pool, so the sender's wallet and the amount are both public and only
          the recipient is hidden. The success block is what a user remembers,
          so it is the last place that should overstate.
        */}
        <SuccessBurst label="Sent to a one-time address" />
        <div className="card p-4">
          <p className="text-sm text-p01-text-muted">
            {formatAmount(amountNum, asset.symbol)} to {resolved?.label}. The recipient is
            hidden; your wallet and the amount are on-chain in the clear.
          </p>
          <a
            href={r.explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block font-mono text-xs text-p01-cyan hover:underline"
          >
            {truncate(r.signature, 10, 8)} ↗
          </a>
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
      {/* The two paths are not settings of one send: they hide different
          things, so they get a switch and separate disclosures. Hidden while
          the stealth path is parked, since a switch with one option is just a
          label that moves. */}
      {!STEALTH_SEND_PARKED && (
      <div className="inline-flex w-full rounded-lg border border-p01-border bg-p01-surface p-1 lg:max-w-md">
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
      )}

      {mode === "note" ? (
        !poolReady ? (
          <div className="card p-4 text-sm text-p01-text-muted">
            Handing over a note needs your derived pool keys and a connected wallet. Reconnect and
            sign to derive, then come back.
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            {/* Main column: the action. */}
            <div className="min-w-0 space-y-4">
              {/* Note picker first: the note IS the amount, so picking it is
                  the action the rest of the form serves. */}
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

                {/* Skew here does not empty this list (notes come from the
                    scan) — it blunts the spent/handed-over FILTERS above, so
                    a note listed below may already be gone or promised away.
                    The picker must say so before offering anything. */}
                {staleWorker && (
                  <div className="mb-2">
                    <StaleWorkerNotice />
                  </div>
                )}

                {!scanning && unspent.length === 0 && !scanError && (
                  <p className="text-xs text-p01-text-muted">
                    No unspent notes. Shield one in the Pool tab first: you cannot hand over 0.2
                    SOL, you hand over a note, and a note is one of the fixed pool sizes.
                  </p>
                )}

                {unspent.length > 0 && (
                  <ul className="space-y-2">
                    {unspent.map((n) => {
                      // Key on `k`, NOT on `n.counter`: local-storage notes all
                      // carry 0, so those keys collide and React may omit or
                      // duplicate rows.
                      const k = noteKey(n);
                      const active = k === selected;
                      return (
                        <li key={k}>
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
                              {/* Second plane: the protocol's name for this note. */}
                              <p className="truncate font-mono text-xs text-p01-text-dim">
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
                      <Check className="h-3.5 w-3.5" /> Valid note address
                    </p>
                  ) : (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-p01-yellow">
                      <TriangleAlert className="h-3.5 w-3.5" /> Not a note address. It starts with
                      &quot;p01pq:&quot;.
                    </p>
                  ))}
                <p className="mt-1.5 text-xs text-p01-text-muted">
                  Not a wallet address. The recipient finds theirs on the Import note screen of
                  the Protocol 01 extension.
                </p>
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
              {!sealing && sealReason && (
                <p className="text-center text-xs text-p01-text-dim">{sealReason}</p>
              )}

              <FlowProgress phases={SEAL_PHASES} step={sealStep} running={sealing} />
            </div>

            {/* Secondary column: the context, replaced by the result when it
                lands. */}
            <div className="min-w-0 space-y-4">
              {sealed ? (
                renderSealedResult(sealed)
              ) : (
                /* What this path does and does not hide. Full text unchanged;
                   folded behind its one-line summary after the first visit. */
                <details
                  className="group rounded-lg border border-p01-cyan/30 bg-p01-cyan/5"
                  open={disclosureOpen}
                  onToggle={onDisclosureToggle}
                >
                  <summary className="flex cursor-pointer select-none items-start gap-2 p-3 text-xs text-p01-cyan [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
                    <span>
                      Nothing goes on chain now. The note&apos;s later exit from the pool can
                      still be linked to your deposit.
                    </span>
                  </summary>
                  <div className="space-y-2 px-3 pb-3 text-xs text-p01-cyan/90">
                    <p className="font-medium text-p01-cyan">
                      No transaction is sent. That is what makes it private.
                    </p>
                    <p>
                      Handing over a note moves nothing on chain: the recipient simply ends up
                      holding its secrets. There is no transfer to observe, so there is no
                      sender, no recipient, no amount and no timing for anyone to correlate, and
                      no fee.
                    </p>
                    <p className="text-p01-yellow">
                      What it does not hide: when they withdraw, the withdrawal publishes the
                      same note commitment your deposit published, so that exit is publicly
                      matchable to your deposit. Measured on devnet. The handoff is invisible;
                      the note leaving the pool is not.
                    </p>
                    <p className="text-p01-yellow">
                      You keep a spendable copy. The note is not consumed or locked by handing it
                      over; whoever withdraws first wins.
                    </p>
                    <p className="text-p01-cyan/70">
                      For the curious: a note is identified by its leaf number and public
                      commitment, and the sealed string is encrypted to the recipient&apos;s
                      p01pq: address with X25519 plus ML-KEM-768, a post-quantum scheme.
                    </p>
                  </div>
                </details>
              )}
            </div>
          </div>
        )
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Main column: the action. */}
          <div className="min-w-0 space-y-4">
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
                beside the sender. Saying so AT THE INPUT, not only in the badge in the
                context column, is the difference between a disclosure and a warning
                someone reads.

                The other tab is the path that hides the amount, and it does it by
                removing the choice: a note is one of six fixed sizes, which is what
                makes two notes of the same size indistinguishable.
              */}
              {asset.chainId === "solana" && amountNum > 0 && (
                <p className="mt-1.5 text-xs text-p01-text-muted">
                  <span className="text-p01-yellow">
                    This amount and your wallet will be public.
                  </span>{" "}
                  To hide them, shield into the pool and hand over a note instead: notes are
                  fixed at 0.1, 1, 10, 100, 500 or 1000 SOL, and a free-form amount cannot be
                  hidden because it identifies itself.
                </p>
              )}
            </div>

            <FeeRow quote={quote} assetSymbol={asset.symbol} chainId={asset.chainId} />

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
              {/*
                The label used to read "Shield & send" / "Shielding…". This path
                does not shield: `workerCore.ts:352` builds a plain
                SystemProgram.transfer from the connected wallet to a fresh stealth
                address, fee payer the wallet. The button is the last thing read
                before committing, and it contradicted the disclosure directly
                above it, which is the exact failure this file's own header warns
                about. Shielding is the Pool tab; handing over a note is the other
                mode of this one.
              */}
              {sending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Sending…
                </>
              ) : (
                <>
                  Send to a one-time address <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
            {!sending && sendReason && (
              <p className="text-center text-xs text-p01-text-dim">{sendReason}</p>
            )}

            <FlowProgress phases={STEALTH_SEND_PHASES} step={sendStep} running={sending} />
          </div>

          {/* Secondary column: the context, replaced by the result when it
              lands. */}
          <div className="min-w-0 space-y-4">
            {result ? (
              renderSendResult(result)
            ) : (
              /* The full stealth disclosure is HonestyBadge, unchanged; folded
                 behind its one-line summary after the first visit. */
              <details
                className="group rounded-lg border border-p01-border bg-p01-surface"
                open={disclosureOpen}
                onToggle={onDisclosureToggle}
              >
                <summary className="flex cursor-pointer select-none items-start gap-2 p-3 text-xs text-p01-text-muted [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
                  <span>Hides the recipient only. Your wallet and the amount stay public.</span>
                </summary>
                <div className="px-3 pb-3">
                  <HonestyBadge chain={asset.chainId} />
                </div>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
