"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import type { Connection, Transaction } from "@solana/web3.js";
import {
  ChevronDown,
  Coins,
  Download,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import {
  buildPoolPayoutMessage,
  derivePoolPayoutKeypair,
  derivePoolPayoutRoot,
  loadEncryptedNotes,
  loadPayouts,
  knownSpentNoteKeys,
  resolveSpentNotes,
  recordPayout,
  recordSpentNote,
  scanPool,
  shieldToPool,
  recoverStuckFunds,
  storeEncryptedNote,
  sweepPayout,
  unshieldFromPool,
  scanPoolLocal,
  type PayoutRecord,
  type ShieldOutcome,
} from "@/lib/privacy/shieldClient";
import type { PoolNoteView, PoolSizeView } from "@/lib/privacy/worker/poolHandlers";
import { getPoolsForTokenV3, type PoolToken } from "@/lib/privacy/pool/denominatedPool";
import { SHIELD_PHASES, WITHDRAW_PHASES } from "@/lib/pay/flowProgress";
import FlowProgress from "./FlowProgress";
import SuccessBurst from "./SuccessBurst";
import { truncate } from "./util";

/** The live V4 SOL pools. Shielding snaps to one of these: a denominated pool
 *  cannot hold an arbitrary amount, and that is the whole point: every note in
 *  a pool looks identical. */
// Denominations are no longer a hardcoded SOL list: they come from the pool
// configs for whichever token the header selected. The list used to be SOL-only
// while the header could say USDC, so the panel shielded SOL and said USDC.
function denominationsFor(token: PoolToken): number[] {
  return getPoolsForTokenV3(token).map((p) => p.denomination).sort((a, b) => a - b);
}

/** A payout address the user can still move funds out of. */
interface PayoutView extends PayoutRecord {
  lamports: number;
}

/** Identifies a note across rescans. Same shape as `SendForm` and `SubscribePanel`. */
function noteKey(n: PoolNoteView): string {
  return `${n.pool}:${n.leafIndex}`;
}

/** Set once the disclosure has been shown expanded; after that it starts
 *  collapsed with its one-line summary still visible. The content itself never
 *  goes away, only the delivery changes. */
const DISCLOSURE_SEEN_KEY = "p01:pay:pool-disclosure-seen";

export default function PoolPanel({
  meta,
  owner,
  connection,
  signOne,
  signMessage: signMessageProp,
  token,
  onBusyChange,
}: {
  token: PoolToken;
  meta: string;
  owner: PublicKey;
  connection: Connection;
  signOne: ((tx: Transaction) => Promise<Transaction>) | null;
  /**
   * Message signer for the payout-address root. Optional: the connected browser
   * wallet is picked up from the adapter when this is absent. It exists so the
   * QR-paired P01 keypair path, which has no wallet-adapter session and whose
   * local nacl signer lives in `PayApp`, can supply one instead of losing the
   * ability to withdraw. Until it does, withdrawal is disabled on that path
   * rather than silently falling back to naming the wallet.
   */
  signMessage?: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  /**
   * Raised while this panel is running something that locks funds or must not
   * be perceived as vanished. PayApp badges the tab with it, so a user who
   * navigates away mid-operation can find their way back instead of assuming it
   * died and starting a second one, which would lock a second proof buffer.
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const denominations = denominationsFor(token);
  const [denomination, setDenomination] = useState(denominations[0]!);
  const [notes, setNotes] = useState<PoolNoteView[]>([]);
  /** Notes this browser withdrew, keyed `pool:leafIndex`. Seeded from local
   *  storage so it survives a reload, which is the case that actually bit:
   *  session state forgot, and the list offered a spent note again. Never
   *  un-set: a spent note cannot become unspent. */
  const [spentLocally, setSpentLocally] = useState<ReadonlySet<string>>(new Set());
  /** True while the list comes from local storage, whose `spent` is a default
   *  rather than a reading. Cleared once the chain walk has answered. */
  const [notesProvisional, setNotesProvisional] = useState(false);
  const [poolSizes, setPoolSizes] = useState<PoolSizeView[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanStep, setScanStep] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const [shielding, setShielding] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShieldOutcome | null>(null);
  const [busyNote, setBusyNote] = useState<string | null>(null);
  const [withdrawn, setWithdrawn] = useState<
    { txSig: string; denomination: number; payout: string } | null
  >(null);
  const [recovering, setRecovering] = useState(false);
  const [recovered, setRecovered] = useState<string | null>(null);

  // Open on the first visit, collapsed afterwards. The one-line summary stays
  // on screen either way, so nothing true ever leaves the page.
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  useEffect(() => {
    try {
      if (!window.localStorage.getItem(DISCLOSURE_SEEN_KEY)) {
        setDisclosureOpen(true);
        window.localStorage.setItem(DISCLOSURE_SEEN_KEY, "1");
      }
    } catch {
      // Storage unavailable: default to collapsed, the summary still shows.
    }
  }, []);

  // ── Payout addresses ─────────────────────────────────────────────────────
  // The root is held in component state and nowhere else: never localStorage,
  // never the worker. It is re-derivable from the wallet at any time, so losing
  // it on reload costs one signature, not funds.
  const { publicKey: adapterPubkey, signMessage: adapterSignMessage } = useWallet();
  const signMessage =
    signMessageProp ??
    (adapterPubkey && adapterPubkey.equals(owner) ? adapterSignMessage ?? null : null);
  const [payoutRoot, setPayoutRoot] = useState<Uint8Array | null>(null);
  const [payouts, setPayouts] = useState<PayoutView[]>([]);
  const [sweeping, setSweeping] = useState<string | null>(null);
  const [sweepTo, setSweepTo] = useState("");
  const [sweepError, setSweepError] = useState<string | null>(null);

  // One boolean for the whole panel, derived rather than raised by hand in every
  // try/finally: a single missed exit path would leave the tab badged forever.
  // The cleanup also clears it when the panel unmounts, which is exactly the
  // case that motivated the badge, a user switching tabs mid-operation.
  const panelBusy = shielding || !!busyNote || !!sweeping || recovering;
  useEffect(() => {
    onBusyChange?.(panelBusy);
    return () => onBusyChange?.(false);
  }, [panelBusy, onBusyChange]);

  const [swept, setSwept] = useState<string | null>(null);

  // Drop the root whenever the wallet changes: a payout key belongs to exactly
  // one wallet, and keeping a stale root across a switch would show one wallet
  // the other's addresses.
  const ownerKey = owner.toBase58();
  useEffect(() => {
    setPayoutRoot(null);
    setPayouts([]);
    // Spent notes are per wallet and persisted, so re-read them on a switch
    // rather than carrying one wallet's history into another's list.
    setSpentLocally(knownSpentNoteKeys(ownerKey));
  }, [ownerKey]);

  const rescan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      // FIRST PAINT, no network. Notes shielded from this browser are already in
      // local storage, encrypted under the pool seed, and carry pool, leaf index,
      // denomination and commitment. Drawing them costs milliseconds; the chain
      // walk below costs tens of seconds on the public devnet RPC and the user
      // was watching "Scanning the 0.1 SOL pool..." the whole time.
      //
      // Nothing here has seen a nullifier PDA, so `spent` on these is a default
      // and not a reading: a note withdrawn on another device, or in an earlier
      // session, paints as spendable. `notesProvisional` says so, and the
      // Withdraw button stays disabled until the chain walk below answers.
      try {
        const local = await scanPoolLocal(meta, owner.toBase58());
        if (local.notes.length > 0) {
          setNotes(local.notes);
          setNotesProvisional(true);
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
      void resolveSpentNotes(meta, owner.toBase58())
        .then(() => setSpentLocally(knownSpentNoteKeys(owner.toBase58())))
        .catch(() => {});
      const res = await scanPool(meta, "SOL", setScanStep);
      setNotes(res.notes);
      setNotesProvisional(false);
      setPoolSizes(res.poolSizes);
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

  /**
   * Unlock this wallet's payout addresses: one message signature, cached for the
   * session. Throws (rather than falling back to the wallet as recipient) when
   * no message signer is available, see the `signMessage` prop.
   */
  const requirePayoutRoot = useCallback(async (): Promise<Uint8Array> => {
    if (payoutRoot) return payoutRoot;
    if (!signMessage) {
      throw new Error(
        "This wallet cannot sign messages here, so a recoverable payout address cannot be " +
          "derived. Connect the browser wallet that owns these notes and try again.",
      );
    }
    const message = buildPoolPayoutMessage({
      walletPubkey: ownerKey,
      origin: typeof window !== "undefined" ? window.location.origin : "",
    });
    // Signed once per session. This wallet's Ed25519 determinism was already
    // proven before this panel could render: PayApp signs the identity message
    // twice and refuses the whole session if the two differ (PayApp.tsx:186-196).
    // Determinism is a property of the signer, not of the message, so it carries.
    const sig = await signMessage(new TextEncoder().encode(message));
    const root = derivePoolPayoutRoot(sig);
    sig.fill(0);
    setPayoutRoot(root);
    return root;
  }, [payoutRoot, signMessage, ownerKey]);

  /**
   * List every payout address that still holds something.
   *
   * Two independent sources, unioned on purpose. The local records survive an
   * RPC that has pruned the pool's history; re-deriving from the scanned notes
   * survives a cleared browser. Either one alone would hide funds in the case
   * the other covers.
   */
  const refreshPayouts = useCallback(
    async (root: Uint8Array) => {
      const byAddress = new Map<string, PayoutRecord>();
      for (const rec of loadPayouts(ownerKey)) byAddress.set(rec.address, rec);
      for (const n of notes) {
        const address = derivePoolPayoutKeypair(root, n.pool, n.leafIndex).publicKey.toBase58();
        if (!byAddress.has(address)) {
          byAddress.set(address, {
            pool: n.pool,
            leafIndex: n.leafIndex,
            address,
            txSig: "",
            denomination: n.denomination,
          });
        }
      }
      const recs = [...byAddress.values()];
      if (recs.length === 0) {
        setPayouts([]);
        return;
      }
      const infos = await connection.getMultipleAccountsInfo(
        recs.map((r) => new PublicKey(r.address)),
      );
      setPayouts(
        recs
          .map((r, i) => ({ ...r, lamports: infos[i]?.lamports ?? 0 }))
          .filter((r) => r.lamports > 0),
      );
    },
    [connection, notes, ownerKey],
  );

  async function handleShowPayouts() {
    setSweepError(null);
    try {
      await refreshPayouts(await requirePayoutRoot());
    } catch (e) {
      setSweepError((e as Error).message || "Could not read your payout addresses.");
    }
  }

  async function handleSweep(p: PayoutView) {
    setSweepError(null);
    setSwept(null);
    const destination = sweepTo.trim();
    if (!destination) {
      setSweepError("Enter the address that should receive these funds.");
      return;
    }
    let to: PublicKey;
    try {
      to = new PublicKey(destination);
    } catch {
      setSweepError("That is not a valid Solana address.");
      return;
    }
    setSweeping(p.address);
    try {
      const root = await requirePayoutRoot();
      const payout = derivePoolPayoutKeypair(root, p.pool, p.leafIndex);
      // Belt and braces: a mismatch here would mean the derivation drifted and
      // the transaction would be signed by a key that owns nothing.
      if (payout.publicKey.toBase58() !== p.address) {
        throw new Error("Payout key mismatch. Rescan before sweeping.");
      }
      const { txSig, lamports } = await sweepPayout({ connection, payout, destination: to });
      setSwept(`Swept ${(lamports / 1e9).toFixed(4)} SOL · ${truncate(txSig, 8, 6)}`);
      await refreshPayouts(root);
    } catch (e) {
      setSweepError((e as Error).message || "Sweep failed.");
    } finally {
      setSweeping(null);
    }
  }

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
      // The payout address, NOT `owner`. Passing the connected wallet here is
      // what put it in the withdrawal transaction by name until 2026-08-04;
      // `executeUnshield` now refuses that outright, so this is the only shape
      // that works. The address is derived from a wallet signature, so it is
      // recoverable on any device, see `shieldClient.derivePoolPayoutKeypair`.
      const root = await requirePayoutRoot();
      const payout = derivePoolPayoutKeypair(root, note.pool, note.leafIndex);

      // The worker picks the blob whose commitment matches and uses its Merkle
      // path; anything that does not decrypt or match is ignored there.
      const out = await unshieldFromPool({
        meta,
        token: "SOL",
        denomination: note.denomination,
        leafIndex: note.leafIndex,
        recipient: payout.publicKey,
        owner,
        encryptedNotes: loadEncryptedNotes(owner.toBase58()),
        connection,
        signOne,
        onProgress: setStep,
      });
      recordPayout(ownerKey, {
        pool: note.pool,
        leafIndex: note.leafIndex,
        address: payout.publicKey.toBase58(),
        txSig: out.txSig,
        denomination: out.denomination,
      });
      setWithdrawn({ ...out, payout: payout.publicKey.toBase58() });
      // Persist it: this is the only record that survives the reload, and the
      // chain walk that would otherwise settle it takes minutes.
      recordSpentNote(ownerKey, noteKey(note));
      setSpentLocally((prev) => new Set(prev).add(noteKey(note)));
      void refreshPayouts(root);
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
          ? "Nothing stranded, no funds to recover."
          : `Recovered ${(r.lamports / 1e9).toFixed(4)} SOL from ${r.keys} key(s), closed ${r.closedBuffers} proof buffer(s).`,
      );
    } catch (e) {
      setError((e as Error).message || "Recovery failed.");
    } finally {
      setRecovering(false);
      setStep(null);
    }
  }

  // A note we just withdrew is spent, whatever the next scan says. `spent` is
  // resolved by looking up the nullifier PDA, and the rescan fired right after a
  // withdrawal usually beats that PDA into existence, so the note comes back
  // "unspent" and keeps a Withdraw button that can only fail, after locking ~1
  // SOL of buffer rent and minutes of upload. Trust what we did over what we
  // read; the chain scan agrees on the following pass.
  const unspent = notes.filter((n) => !n.spent && !spentLocally.has(noteKey(n)));
  const selectedSize = poolSizes.find((p) => p.denomination === denomination);
  const storedNotes = loadEncryptedNotes(owner.toBase58()).length;

  // ONE source of truth for what the user holds. The balance is the sum of the
  // very list rendered below, not a second number from a different code path.
  // The screen once said "0 SOL" next to "2 unspent notes" because the balance
  // came from the chain scan while the list came from the local first paint;
  // deriving both from `unspent` makes that contradiction unrepresentable.
  const shieldedBalance = unspent.reduce((sum, n) => sum + n.denomination, 0);

  const shieldCost = (denomination * 1.003 + 1.006).toFixed(3);

  // Every disabled action names its reason next to itself. `scanning` is
  // deliberately absent from all of these: the pool scan enumerates the whole
  // epoch window per note per denomination and does not finish in a time a
  // human will wait, so only the Rescan button itself may lock on it.
  const shieldReason = !signOne
    ? "This wallet cannot sign transactions, so it cannot shield."
    : busyNote
      ? "Paused while the withdrawal runs."
      : null;
  const withdrawReason = !signOne
    ? "This wallet cannot sign transactions, so it cannot withdraw."
    : shielding
      ? "Paused while the shield runs."
      : null;
  const sweepReason = shielding
    ? "Paused while the shield runs."
    : busyNote
      ? "Paused while the withdrawal runs."
      : null;

  return (
    // Two columns from lg so the action never sinks below the fold on a 1080p
    // screen: the doing on the left, in the wider track, and the context on
    // the right. Below lg everything stacks in one column, action first. The
    // minmax(0,...) tracks keep long mono strings from ever forcing a
    // horizontal scroll; overflow inside a row truncates instead.
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:items-start">
      {/* Progress spans BOTH columns while an operation runs. During those
          minutes the user does nothing else, so the screen is honestly in one
          state and the one thing that moves gets the full width: room for the
          step list, and visible whichever column the click came from. Both
          flows report through the same worker `step` string; only one runs at
          a time, so each bar keys off its own running flag. The wrappers are
          conditional so an idle bar leaves no empty grid cell behind. */}
      {shielding && (
        <div className="min-w-0 lg:col-span-2">
          <FlowProgress
            phases={SHIELD_PHASES}
            step={step}
            running={shielding}
            note={`About ${shieldCost} SOL is committed while this runs. Most of it is a refundable deposit, returned at the end.`}
          />
        </div>
      )}
      {busyNote && (
        <div className="min-w-0 lg:col-span-2">
          <FlowProgress
            phases={WITHDRAW_PHASES}
            step={step}
            running={!!busyNote}
            note="About 1 SOL sits in a refundable deposit while this runs and comes back when it finishes."
          />
        </div>
      )}

      {/* ── Action column: what you came here to do ───────────────────────── */}
      <div className="min-w-0 space-y-5">
        {/* Denomination */}
        <div>
          <label className="mb-1.5 block text-xs uppercase tracking-wider text-p01-text-muted">
            Denomination
          </label>
          <div className="flex flex-wrap gap-2">
            {denominations.map((d) => (
              <button
                key={d}
                onClick={() => setDenomination(d)}
                disabled={shielding}
                title={shielding ? "Locked while the shield runs." : undefined}
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
              ? `${selectedSize.totalNotes} note${selectedSize.totalNotes === 1 ? "" : "s"} in this pool. Amounts snap to a denomination, so the amount you move is not distinctive. See the privacy note for what withdrawal still reveals.`
              : "Amounts snap to a denomination; arbitrary amounts cannot be shielded."}
          </p>
          {selectedSize && selectedSize.discoverableNotes < selectedSize.totalNotes && (
            <p className="mt-1 text-xs text-p01-text-dim">
              This RPC serves history for only {selectedSize.discoverableNotes} of them.
              Withdrawal rebuilds the Merkle proof from that history, so a note whose history is
              gone cannot be withdrawn from this endpoint.
            </p>
          )}
        </div>

        {/* Cost, not privacy. Kept out of the disclosure box so nothing reads
            as a fifth thing the pool hides. Plain sentence in front, the
            precise breakdown (rent, per-step fees) one click behind it. */}
        <details className="text-xs text-p01-text-muted">
          <summary className="cursor-pointer marker:text-p01-text-dim">
            Shielding {denomination} SOL needs about {shieldCost} SOL free for a few minutes. Most
            of it is a refundable deposit that comes back at the end.
          </summary>
          <p className="mt-1.5 pl-4 text-p01-text-dim">
            The exact breakdown: the {denomination} SOL denomination, a 0.3% protocol fee, and ~1
            SOL of proof-buffer rent that is returned when the buffer closes. Withdrawal charges
            0.5%, and moving the payout off its one-time address afterwards costs one more
            transaction fee (0.000005 SOL).
          </p>
        </details>

        {error && (
          <p className="flex items-start gap-1.5 text-sm text-p01-red">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
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
        {shieldReason && !shielding && (
          <p className="text-center text-xs text-p01-text-dim">{shieldReason}</p>
        )}

        {result && !shielding && (
          <div className="space-y-2">
            <SuccessBurst label={`${result.denomination} SOL note shielded`} />
            <div className="card p-4">
              <p className="font-display text-sm text-p01-text">
                Your {result.denomination} SOL note is in the pool
              </p>
              <p className="mt-1 text-xs text-p01-text-muted">
                It counts toward the balance and can be withdrawn from this device.
              </p>
              <p className="mt-1 truncate font-mono text-xs text-p01-text-dim">
                leaf #{result.leafIndex} · commitment {truncate(result.commitment, 8, 6)}
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
          </div>
        )}

        {withdrawn && !busyNote && (
          <div className="space-y-2">
            <SuccessBurst label={`${withdrawn.denomination} SOL withdrawn`} />
            <div className="card p-4">
              <p className="font-display text-sm text-p01-text">
                Withdrew {withdrawn.denomination} SOL
              </p>
              <p className="mt-1 text-xs text-p01-text-muted">
                Paid to {truncate(withdrawn.payout, 6, 6)}, an address derived for this note
                alone. Only your wallet&apos;s signature reaches it. Sweep it from the payout
                list, whenever and wherever you want. This withdrawal is still publicly matchable
                to the deposit it spends (the commitment appears in both), so treat it as a
                transparent transfer.
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
          </div>
        )}

        <div className="flex items-center justify-between gap-3 text-xs">
          <button
            onClick={handleRecover}
            disabled={recovering || shielding || !!busyNote}
            className="text-p01-text-muted underline-offset-2 hover:text-p01-cyan hover:underline disabled:opacity-50"
          >
            {recovering ? "Checking for stranded funds…" : "Recover funds from a failed attempt"}
          </button>
          {recovered ? (
            <span className="text-p01-cyan">{recovered}</span>
          ) : shielding || busyNote ? (
            <span className="text-p01-text-dim">Paused while a move is running.</span>
          ) : null}
        </div>
        {recovering && step && (
          <p className="text-center text-xs text-p01-text-dim">{step}</p>
        )}
      </div>

      {/* ── Context column: what you hold and what it reveals ─────────────── */}
      <div className="min-w-0 space-y-5">
        {/* Balance. The one place that says what you hold. */}
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
          <p className="mt-2 font-mono text-2xl text-p01-text">
            {Number(shieldedBalance.toFixed(4))} SOL
          </p>
          <p className="mt-1 text-xs text-p01-text-muted">
            {unspent.length} note{unspent.length === 1 ? "" : "s"} ready to move
            {storedNotes > 0 && <> · {storedNotes} encrypted backup{storedNotes === 1 ? "" : "s"} on this device</>}
          </p>
          {notesProvisional && (
            <p className="mt-1 text-xs text-p01-text-dim">
              Shown from this device&apos;s records while the chain check runs. A note withdrawn
              elsewhere may still appear until the check finishes; it settles on its own.
            </p>
          )}
          {scanStep && <p className="mt-2 text-xs text-p01-text-dim">{scanStep}</p>}
          {scanError && <p className="mt-2 text-sm text-p01-red">{scanError}</p>}
        </div>

        {/* What this does and does not hide. This product's first rule is that
            copy never claims more than the shipped path provides. The one-line
            summary never leaves the screen; the detail opens expanded on the
            first visit and collapses afterwards, but every sentence survives.

            Text replaced 2026-08-04 with the wording produced by the
            measurement pass, which traced a full shield/unshield pair on
            devnet rather than reasoning from the source. Three clauses
            changed:

            1. The old text said only "the deposit is public too: this wallet
               funds a one-time key". That understated one half and omitted the
               other. The deposit instruction's depositor and fee payer is the
               ephemeral E, not the wallet (shieldEphemeral.ts:278-297 builds
               eSigner; denominatedPool.ts:828 passes signer.publicKey as
               depositor), so the wallet genuinely is NOT named in the deposit.
               But the WITHDRAWAL pays out to the connected wallet by name
               (PoolPanel.tsx:125 passes `owner` as recipient), which the old
               text never said at all. Both halves are now stated.

            2. NEW clause: /pay has no relayer. signSendV3 in
               denominatedPool.ts:691-705 calls signSendConfirmTx directly,
               comment at :697, "Step 1 (web /pay): no relayer yet, submit
               directly." So the submitting IP reaches the RPC. The mobile
               parenthetical is measured too: a relayed mobile shield still
               carries the user's wallet as depositor on chain (devnet
               RcsL4pYy… , relayed via 3pF5wSmF…), because the inner tx is
               signed before encryption (v3RelayerWrapper.ts:122-129).

            3. The anonymity-set-of-one clause is unchanged in substance but is
               now backed by a fresh pair rather than the 2026-07-25 tx: leaf
               16, commitment 8901821612542787864, published in the clear by
               BOTH the deposit RcsL4pYy… (LeafInserted) and the withdrawal
               4Uwqht… (stark_commitment at instruction bytes 80..88).

            2026-08-04, second pass: the payout clause changed because the code
            changed. `handleUnshield` above now passes a derived payout
            address, not `owner`, and `unshieldEphemeral.executeUnshield`
            refuses the pre-funder outright. What did NOT change, and is stated
            as plainly as the old leak was: `shieldClient.unshieldFromPool`
            still builds `owner -> E` and has the wallet sign it, so the wallet
            is still on chain next to this withdrawal. A fresh payee is not
            unlinkability.

            The relayer clause also got sharper rather than being deleted.
            Routing only the final unshield transaction through the relayer
            would not close the IP channel. A withdrawal first uploads C1 and
            C3 in 1000-byte chunks (`stark.ts:43`, `stark.ts:517-529`), one
            direct `sendRawTransaction` each, all signed by the same ephemeral
            E (`denominatedPool.ts:1689,1701` pass the same `signer`), into
            buffers whose PDA is seeded on E's own pubkey (`stark.ts:92-100`),
            and the final transaction names those buffers. So the RPC has
            already seen this browser create everything the relayed transaction
            would refer to. The sentence below therefore says "every
            transaction", which is what is true; do not soften it to "some". */}
        <div className="rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
          <button
            type="button"
            onClick={() => setDisclosureOpen((v) => !v)}
            aria-expanded={disclosureOpen}
            className="flex w-full items-center justify-between gap-2 text-left"
          >
            <span className="font-medium">
              Devnet. Amounts are hidden. Matching a withdrawal to its deposit is not.
            </span>
            <ChevronDown
              className={
                disclosureOpen
                  ? "h-3.5 w-3.5 shrink-0 rotate-180 transition-transform"
                  : "h-3.5 w-3.5 shrink-0 transition-transform"
              }
            />
          </button>
          {disclosureOpen && (
            <div className="mt-2 space-y-2 text-p01-red/90">
              <p>
                Neither the deposit nor the withdrawal names your wallet: the deposit is signed
                by a one-time key, and the withdrawal now pays a fresh address derived for that
                one note. But your wallet publicly funds the one-time key in both cases, in a
                transaction it signs itself, so your wallet is still on chain, one hop away, at
                the same moment.
              </p>
              <p>
                The withdrawal publishes the note commitment in the clear, and the deposit
                published that same value, so anyone can match a withdrawal to its exact deposit.
                The anonymity set is one, not the note count above.
              </p>
              <p>
                /pay submits every transaction directly, including the hundreds of proof-chunk
                uploads a withdrawal needs, so your IP reaches the RPC throughout. There is no
                relayer here, and relaying only the last transaction would not change that.
              </p>
              <p>
                What you get today: the amount is quantised to a denomination, the note itself is
                post-quantum encrypted, and the money does not land in your wallet unless you
                move it there. That is the whole list.
              </p>
            </div>
          )}
        </div>

        {unspent.length > 0 && (
          <div>
            <p className="mb-2 font-display text-sm text-p01-text">Your notes</p>
            {withdrawReason && (
              <p className="mb-2 text-xs text-p01-text-dim">{withdrawReason}</p>
            )}
            <ul className="space-y-2">
              {unspent.map((n) => (
                <li
                  // NOT `counter`: notes painted from local storage all carry 0,
                  // so two of them collide and React may duplicate or omit rows,
                  // which is how a withdrawn note kept its place in this list.
                  // `leafIndex` is unique within a pool by construction.
                  key={noteKey(n)}
                  className="card flex items-center justify-between gap-3 p-3"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-p01-text">{n.denomination} SOL note</p>
                    <p className="text-xs text-p01-text-muted">
                      {notesProvisional
                        ? "Still being checked against the chain; may already be spent."
                        : "In the pool, ready to withdraw."}
                    </p>
                    <p className="truncate font-mono text-xs text-p01-text-dim">
                      leaf #{n.leafIndex} · {truncate(n.commitment, 6, 4)}
                    </p>
                  </div>
                  <button
                    onClick={() => handleUnshield(n)}
                    disabled={!!busyNote || shielding || !signOne || !signMessage}
                    // Not disabled while provisional: the chain walk enumerates
                    // candidate epochs per note per pool and can run for minutes,
                    // and locking withdrawal behind it makes the app unusable.
                    // The row says the status in plain words instead.
                    title={
                      busyNote && busyNote !== `${n.pool}:${n.leafIndex}`
                        ? "Another withdrawal is running."
                        : notesProvisional
                          ? "Not yet confirmed against the chain: this note may already be spent."
                          : undefined
                    }
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
            {!signMessage && (
              <p className="mt-2 text-xs text-p01-red">
                Withdrawal is disabled: this session has no message signer, so the one-time
                payout address a withdrawal pays into could not be re-derived later. Connect the
                browser wallet that owns these notes. Paying your wallet directly instead is not
                offered; that is the leak this replaced.
              </p>
            )}
          </div>
        )}

        {/* Payout addresses.
            Deliberately its own section rather than a line on the withdrawal
            receipt: the funds sit here until the user moves them, and a balance
            the user cannot see is a balance they have lost. Two independent
            ways to find these addresses are unioned in `refreshPayouts`, the
            local record and re-derivation from the note list, so neither a
            cleared browser nor a pruning RPC hides one. */}
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="font-display text-sm text-p01-text">Withdrawn, waiting to be moved</p>
            <button
              onClick={handleShowPayouts}
              disabled={!!sweeping || !!busyNote}
              title={
                sweeping
                  ? "Paused while the sweep runs."
                  : busyNote
                    ? "Paused while the withdrawal runs."
                    : undefined
              }
              className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Check
            </button>
          </div>
          <p className="mb-2 text-xs text-p01-text-muted">
            Each withdrawal pays a fresh address derived from your wallet signature, not your
            wallet. Nothing moves it automatically. Sending it to the wallet that funded the
            withdrawal is the one destination that links the two together again on chain.
          </p>

          {payouts.length === 0 ? (
            <p className="text-xs text-p01-text-dim">
              Nothing waiting. Press Check after a withdrawal, or on a new device, to re-derive
              your payout addresses and read their balances.
            </p>
          ) : (
            <>
              {sweepReason && <p className="mb-2 text-xs text-p01-text-dim">{sweepReason}</p>}
              <div className="mb-2 flex gap-2">
                <input
                  value={sweepTo}
                  onChange={(e) => setSweepTo(e.target.value)}
                  placeholder="Destination address"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg border border-p01-border bg-p01-void px-3 py-2 font-mono text-xs text-p01-text placeholder:text-p01-text-dim"
                />
                <button
                  onClick={() => setSweepTo(ownerKey)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-p01-border px-3 py-2 text-xs text-p01-text-muted hover:text-p01-text"
                  title="Links this payout back to your wallet on chain"
                >
                  <Wallet className="h-3.5 w-3.5" /> My wallet
                </button>
              </div>
              <ul className="space-y-2">
                {payouts.map((p) => (
                  <li
                    key={p.address}
                    className="card flex items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-sm text-p01-text">
                        {Number((p.lamports / 1e9).toFixed(6))} SOL
                      </p>
                      <p className="text-xs text-p01-text-muted">Waiting to be moved.</p>
                      <p className="truncate font-mono text-xs text-p01-text-dim">
                        leaf #{p.leafIndex} · {truncate(p.address, 6, 6)}
                      </p>
                    </div>
                    <button
                      onClick={() => handleSweep(p)}
                      disabled={!!sweeping || !!busyNote || shielding}
                      title={sweepReason ?? undefined}
                      className="btn-secondary inline-flex items-center gap-2 px-4 py-2 text-xs disabled:opacity-50"
                    >
                      {sweeping === p.address ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      Sweep
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {swept && <p className="mt-2 text-xs text-p01-cyan">{swept}</p>}
          {sweepError && <p className="mt-2 text-xs text-p01-red">{sweepError}</p>}
        </div>
      </div>
    </div>
  );
}
