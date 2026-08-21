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
} from "lucide-react";
import {
  buildPoolPayoutMessage,
  derivePoolPayoutKeypair,
  derivePoolPayoutRoot,
  exportPoolSeed,
  loadEncryptedNotes,
  loadPayouts,
  knownSpentNoteKeys,
  mergeScanWithLocal,
  NOTES_CHANGED_EVENT,
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
import type {
  PoolNoteView,
  PoolRecoverResponse,
  PoolSizeView,
} from "@/lib/privacy/worker/poolHandlers";
import {
  denominationsForRecovery,
  depositBlockFor,
  findPoolV3,
  poolsOpenForDeposit,
  shieldValueLamports,
  type DepositBlock,
  type PoolToken,
} from "@/lib/privacy/pool/denominatedPool";
import { operatorFeeAtomic } from "@/lib/privacy/pool/ephemeralFunder";
import { SHIELD_PHASES, WITHDRAW_PHASES } from "@/lib/pay/flowProgress";
import {
  requiresSweepHomeConfirmation,
  SWEEP_HOME_WARNING,
} from "@/lib/pay/sweepDestination";
import FlowProgress from "./FlowProgress";
import SuccessBurst from "./SuccessBurst";
import {
  HANDOFFS_CHANGED_EVENT,
  forgetHandoff,
  handoffKeys,
  recordHandoff,
} from "@/lib/pay/handoffs";
import StaleWorkerNotice from "./StaleWorkerNotice";
import { truncate } from "./util";

/** The live V4 SOL pools. Shielding snaps to one of these: a denominated pool
 *  cannot hold an arbitrary amount, and that is the whole point: every note in
 *  a pool looks identical. */
// Denominations are no longer a hardcoded SOL list: they come from the pool
// configs for whichever token the header selected. The list used to be SOL-only
// while the header could say USDC, so the panel shielded SOL and said USDC.
//
// 🚨 THERE ARE NOW TWO LISTS AND THEY ARE NOT INTERCHANGEABLE.
//
//   `poolsOpenForDeposit(token)`  — what the picker may OFFER. Deposit-side.
//   `denominationsForRecovery(token)` — every pool, for the float sweep and for
//                                       anything that reads existing notes.
//
// They are two named functions in `denominatedPool.ts` rather than one list and
// a filter here, because the one time this panel derived recovery's list from
// the selector, a user with ~1 SOL of proof-buffer rent stranded in the 0.1 SOL
// pool clicked Recover and was told nothing was stranded. And the picker's
// filter is a CONVENIENCE: the guarantee is `handlePoolShieldPrepare`, which
// throws `PoolClosedToDepositsError` for a blocked pool whoever asks.

/**
 * The denomination put in front. Every other pool stays one click away and
 * nothing is disabled — this is a default, not a restriction.
 *
 * Why concentrate: an anonymity set does not add up across pools, it splits.
 * Measured on devnet 2026-08-12, the SOL pools held 8, 6, 0, 0, 0 and 0 unspent
 * notes. Six denominations means six sets, four of them empty, and a deposit
 * into an empty pool is the only one there — it pairs with its withdrawal
 * trivially, whatever the protocol does.
 *
 * Founder ruling 2026-08-12. Per-token, because the USDC pools have their own
 * ladder and their own occupancy.
 */
const PRIMARY_DENOMINATION_BY_TOKEN: Record<PoolToken, number> = { SOL: 1, USDC: 100 };

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
  /** Every pool of this token, closed or not. The recovery sweep's list. */
  const denominations = denominationsForRecovery(token);
  /** Only the pools a new deposit can actually reach. The picker's list. */
  const depositable = poolsOpenForDeposit(token).map((p) => p.denomination);
  // Prefer the configured primary, then whatever is still open, and only then
  // fall back to a blocked denomination — which happens for USDC, where every
  // pool is closed. The panel must still render (and still withdraw) in that
  // state, so the fallback exists; the Shield button refuses it by name below.
  const primaryDenomination = depositable.includes(PRIMARY_DENOMINATION_BY_TOKEN[token])
    ? PRIMARY_DENOMINATION_BY_TOKEN[token]
    : (depositable[0] ?? denominations[0]!);
  const [denomination, setDenomination] = useState(primaryDenomination);
  const [notes, setNotes] = useState<PoolNoteView[]>([]);
  /** Notes this browser withdrew, keyed `pool:leafIndex`. Seeded from local
   *  storage so it survives a reload, which is the case that actually bit:
   *  session state forgot, and the list offered a spent note again. Never
   *  un-set: a spent note cannot become unspent. */
  const [spentLocally, setSpentLocally] = useState<ReadonlySet<string>>(new Set());
  /** True while the list comes from local storage, whose `spent` is a default
   *  rather than a reading. Cleared once the chain walk has answered. */
  const [notesProvisional, setNotesProvisional] = useState(false);
  /** Blob count for the balance card. State, not a render-time read: the store
   *  index is a worker-derived label now, so reading it is async. */
  const [storedNotes, setStoredNotes] = useState(0);
  /** Notes handed to someone and not yet claimed. They STAY in this list on
   *  purpose: sealing consumes nothing, both sides hold a spendable copy, and
   *  hiding them would tell the user their money is gone while it is still
   *  entirely theirs. What changes is that the row says so, and Withdraw is
   *  how they take it back. */
  const [handedOver, setHandedOver] = useState<ReadonlySet<string>>(new Set());
  const [poolSizes, setPoolSizes] = useState<PoolSizeView[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanStep, setScanStep] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  /** True from the first partial scan result until the scan settles: the list
   *  on screen came from the fast blinded pass while the legacy epoch search —
   *  the only pass that can find pre-2026-07-25 notes — is still running. The
   *  UI must say so; a partial list presented as complete reads as lost money
   *  to anyone holding an older note. */
  const [checkingOlderNotes, setCheckingOlderNotes] = useState(false);

  const [shielding, setShielding] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShieldOutcome | null>(null);
  const [busyNote, setBusyNote] = useState<string | null>(null);
  const [withdrawn, setWithdrawn] = useState<
    {
      txSig: string;
      denomination: number;
      payout: string;
      /** Who paid the rent and fees — decides which of two very different
       *  sentences the user is owed about this withdrawal. */
      fundedBy: "wallet" | "funder";
      /** Why the funder did not serve, when one was configured. Rendered, not
       *  swallowed: a 429, a 409 and an operator switching it off all put the
       *  wallet back on chain and are otherwise indistinguishable. */
      funderFallbackReason?: string;
    } | null
  >(null);
  const [recovering, setRecovering] = useState(false);
  const [recovered, setRecovered] = useState<string | null>(null);
  /**
   * What this deposit is for, asked before it happens.
   *
   * `null` = not asked yet. `'handoff'` = the note is destined for somebody
   * else, which is what a deposit is good for. `'self'` = the depositor intends
   * to spend it themselves, which works and links every spend back to them
   * through the deposit — stated here, where changing course is free, rather
   * than at the refusal after ~1 SOL of rent has been committed.
   */
  /** True once Deposit was pressed with no intent chosen: show the question. */
  /** Operator setup surface, off unless `?treasury=1` is in the URL. Read once
   *  in an effect rather than during render, so server and client agree. */
  const [treasuryMode, setTreasuryMode] = useState(false);
  useEffect(() => {
    try {
      setTreasuryMode(new URLSearchParams(window.location.search).get("treasury") === "1");
    } catch {
      // No window (SSR) or a locked-down environment: stay off, which is the
      // correct default for a control that reveals a spend key.
    }
  }, []);
  const [seedHex, setSeedHex] = useState<string | null>(null);
  const [seedLegacy, setSeedLegacy] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);

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
  /** Payout address whose sweep-to-the-wallet has been confirmed once. Held per
   *  address, not as a boolean, so arming one payout cannot arm the next. */
  const [sweepHomeArmed, setSweepHomeArmed] = useState<string | null>(null);
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
  // A version-skewed worker could not open some sealed records (see
  // StaleWorkerNotice): the spent set, handoff badges or payout history above
  // are then SHORT, not empty-because-empty. Latched with `|| next` rather
  // than assigned, because three independent async reads feed it and a fresh
  // read of one store must not clear what another detected; reset only on a
  // wallet switch, alongside the sets it describes. A reload heals it anyway.
  const [staleWorker, setStaleWorker] = useState(false);
  // Same symptom, different cure: the worker RESTARTED under this tab and
  // lost the seeds mid-session, so nothing sealed opens until the user signs
  // again — a reload alone changes nothing, so the reload line must never
  // claim this state. Latched and reset exactly like `staleWorker`.
  const [lostSession, setLostSession] = useState(false);

  const ownerKey = owner.toBase58();
  useEffect(() => {
    setPayoutRoot(null);
    setPayouts([]);
    // Spent notes are per wallet and persisted, so re-read them on a switch
    // rather than carrying one wallet's history into another's list. The store
    // is encrypted and the worker opens it, so the read is async — the stale
    // guard keeps a slow answer from painting one wallet's spends onto another.
    setSpentLocally(new Set());
    setStaleWorker(false);
    setLostSession(false);
    let stale = false;
    void knownSpentNoteKeys(meta, ownerKey)
      .then((res) => {
        if (!stale) {
          setSpentLocally(res.keys);
          setStaleWorker((prev) => prev || res.staleWorker);
          setLostSession((prev) => prev || res.lostSession);
        }
      })
      .catch(() => {});
    setHandedOver(new Set());
    void handoffKeys(meta, ownerKey)
      .then((res) => {
        if (!stale) {
          setHandedOver(res.keys);
          setStaleWorker((prev) => prev || res.staleWorker);
          setLostSession((prev) => prev || res.lostSession);
        }
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [meta, ownerKey]);

  // A handoff sealed on the Send tab must reach this list without a reload:
  // visited panels stay mounted, so reading once on mount reads once a session.
  useEffect(() => {
    let stale = false;
    const catchUp = () => {
      void handoffKeys(meta, ownerKey)
        .then((res) => {
          if (!stale) {
            setHandedOver(res.keys);
            setStaleWorker((prev) => prev || res.staleWorker);
            setLostSession((prev) => prev || res.lostSession);
          }
        })
        .catch(() => {});
    };
    window.addEventListener(HANDOFFS_CHANGED_EVENT, catchUp);
    return () => {
      stale = true;
      window.removeEventListener(HANDOFFS_CHANGED_EVENT, catchUp);
    };
  }, [meta, ownerKey]);

  // Same shape for the encrypted-backup count. It became state in the async
  // store conversion, and its only writer sat inside `rescan` — so a note
  // imported on the Receive tab (`storeEncryptedNote`, the one writer outside
  // this panel) froze the count until a rescan, a shield, a withdraw or a
  // reload. Stale-low is the wrong direction: a received note's blob is its
  // ONLY record, and no rescan re-derives it.
  useEffect(() => {
    let stale = false;
    const catchUp = () => {
      void loadEncryptedNotes(meta, ownerKey)
        .then((blobs) => {
          if (!stale) setStoredNotes(blobs.length);
        })
        .catch(() => {});
    };
    window.addEventListener(NOTES_CHANGED_EVENT, catchUp);
    return () => {
      stale = true;
      window.removeEventListener(NOTES_CHANGED_EVENT, catchUp);
    };
  }, [meta, ownerKey]);

  const rescan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    // Whether the scan's fast pass painted anything before a failure — decides
    // what the error message below must admit about the list on screen.
    let paintedFromPartialScan = false;
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
      let localNotes: PoolNoteView[] = [];
      try {
        const local = await scanPoolLocal(meta, owner.toBase58());
        if (local.notes.length > 0) {
          localNotes = local.notes;
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
      // MERGED into the previous set, never assigned over it: the read is async
      // now, and a plain set could race a `handleUnshield` write and briefly
      // resurrect the note it just recorded. One-way growth cannot.
      void resolveSpentNotes(meta, owner.toBase58())
        .then(() => knownSpentNoteKeys(meta, owner.toBase58()))
        .then((res) => {
          setSpentLocally((prev) => new Set([...prev, ...res.keys]));
          setStaleWorker((prev) => prev || res.staleWorker);
          setLostSession((prev) => prev || res.lostSession);
        })
        .catch(() => {});
      // The encrypted-backup count for the balance card. Async for the same
      // reason as the spent set: the store index is a worker-derived label.
      void loadEncryptedNotes(meta, owner.toBase58())
        .then((blobs) => setStoredNotes(blobs.length))
        .catch(() => {});
      // SECOND PAINT, chain-read: the scan streams the blinded pass's results
      // as each pool is walked — real spent readings, milliseconds of hashing —
      // while the legacy epoch search (~41 s of pure CPU per derivation, the
      // only pass that can find a pre-blinding note) still runs. Painting them
      // here is what turns the measured 41-82 s wait into seconds; the line
      // gated by `checkingOlderNotes` is what keeps the early paint honest.
      const res = await scanPool(meta, "SOL", setScanStep, (partial) => {
        paintedFromPartialScan = true;
        setCheckingOlderNotes(true);
        setNotes(mergeScanWithLocal(partial.notes, localNotes));
        setPoolSizes(partial.poolSizes);
      });
      // MERGE, not replace: the chain scan re-derives from the pool seed, so a
      // RECEIVED note (secrets from the sender's seed) is invisible to it, and
      // replacing wholesale made received money vanish exactly when the slow
      // scan finished. The chain wins every leaf it can see; see the helper.
      setNotes(mergeScanWithLocal(res.notes, localNotes));
      setNotesProvisional(false);
      setPoolSizes(res.poolSizes);
    } catch (e) {
      const msg = (e as Error).message || "Pool scan failed.";
      // If the fast pass painted and the scan then died, the list on screen is
      // real but may be missing older notes — say exactly that, not less.
      setScanError(
        paintedFromPartialScan
          ? msg +
              " The notes shown are from an unfinished scan and older notes may be missing — rescan to finish the check."
          : msg,
      );
    } finally {
      setScanning(false);
      setScanStep(null);
      setCheckingOlderNotes(false);
    }
    // `ownerKey` alongside `meta`, matching every sibling effect in this file.
    // The callback closes over `owner`, and today the two always change together
    // — PayApp passes `identity.meta` and `solPub` from the same source under the
    // same guard — so omitting it was benign rather than wrong. It was still a
    // trap set for later: the day `meta` becomes stable across wallets, a stale
    // `owner` would scan one wallet's pools and paint them as another's, with
    // nothing in this file to say why.
  }, [meta, ownerKey]);

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
      const stored = await loadPayouts(meta, ownerKey);
      // A skewed or restarted worker hides the sealed records; the
      // re-derivation from scanned notes below still finds every address a
      // live note names, so the list stays as complete as this tab can make
      // it — and the notice says why it may still be short.
      setStaleWorker((prev) => prev || stored.staleWorker);
      setLostSession((prev) => prev || stored.lostSession);
      for (const rec of stored.records) byAddress.set(rec.address, rec);
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
    [connection, notes, meta, ownerKey],
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
    // 🚨 THE CHEAPEST WAY BACK TO THIS USER RUNS THROUGH THIS BUTTON.
    //
    // The withdrawal's recipient is a plain 32-byte instruction argument, in
    // cleartext, at a fixed offset. So the walk is: read the spend, read the
    // payout address out of its bytes, ask for that address's two transactions,
    // read the second one's destination. Three RPC calls — the same price as
    // the payer walk this whole effort is about closing, on the same
    // transaction, and no probe measured it until P10.
    //
    // Everything upstream of here can be perfect and one click on this button
    // publishes the link anyway. It used to be a ONE-CLICK button that prefilled
    // the wallet, which is worse than a default: it is a recommendation.
    //
    // So the address is typed, and typing the connected wallet costs a second,
    // explicit confirmation. Not a warning next to the action — a stop in front
    // of it. Sweeping home is a legitimate thing to want and stays available;
    // it just cannot happen by momentum.
    if (
      requiresSweepHomeConfirmation({
        destination: to.toBase58(),
        ownerKey,
        payoutAddress: p.address,
        armedFor: sweepHomeArmed,
      })
    ) {
      setSweepHomeArmed(p.address);
      setSweepError(SWEEP_HOME_WARNING);
      return;
    }
    setSweepHomeArmed(null);
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
      await storeEncryptedNote(meta, owner.toBase58(), outcome.encryptedNote);
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
        encryptedNotes: await loadEncryptedNotes(meta, owner.toBase58()),
        connection,
        signOne,
        onProgress: setStep,
      });
      await recordPayout(meta, ownerKey, {
        pool: note.pool,
        leafIndex: note.leafIndex,
        address: payout.publicKey.toBase58(),
        txSig: out.txSig,
        denomination: out.denomination,
      });
      setWithdrawn({ ...out, payout: payout.publicKey.toBase58() });
      // Persist it: this is the only record that survives the reload, and the
      // chain walk that would otherwise settle it takes minutes.
      await recordSpentNote(meta, ownerKey, noteKey(note));
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
      // EVERY pool, not the selected one. Recovery is strictly pool-scoped —
      // `recoverStuckFloat` derives its candidate ephemerals from the pool PDA —
      // and it used to be keyed on the denomination pill, which defaulted to the
      // smallest. Putting 1 SOL in front moved that default, so a user with
      // ~1 SOL of proof-buffer rent stranded in the 0.1 SOL pool clicked
      // Recover and read "nothing stranded" about a pool that was never
      // searched. Withdrawals make this reachable without ever touching the
      // selector: `handleUnshield` passes the NOTE's denomination, so a failed
      // 0.1 SOL withdrawal strands float the selector no longer points at.
      //
      // Sweeping all of them costs a few reads against pools the user has never
      // touched and removes the coupling entirely.
      //
      // ⛔ `denominations` here is `denominationsForRecovery(token)` — the FULL
      // ladder — and never `depositable`, which the picker filters down to the
      // pools still open. Closing the 0.1 SOL pool to deposits made that
      // distinction load-bearing: it is exactly the pool this bug stranded
      // money in, and it is now permanently absent from the picker's list.
      //
      // The leaf indices of every note this browser knows about, per pool. A
      // spend's ephemeral is keyed to the SPENT note's leaf, and a spend
      // advances no tree, so an old note's stranded float sits nowhere near the
      // head — outside the window recovery would otherwise search.
      const leavesByDenomination = new Map<number, number[]>();
      for (const n of notes) {
        const list = leavesByDenomination.get(n.denomination) ?? [];
        list.push(n.leafIndex);
        leavesByDenomination.set(n.denomination, list);
      }
      const all = await Promise.all(
        denominations.map((d) =>
          recoverStuckFunds(meta, d, owner, setStep, leavesByDenomination.get(d) ?? []),
        ),
      );
      const r = all.reduce(
        (acc, x) => ({
          keys: acc.keys + x.keys,
          lamports: acc.lamports + x.lamports,
          repaidToFunder: acc.repaidToFunder + x.repaidToFunder,
          closedBuffers: acc.closedBuffers + x.closedBuffers,
          refused: [...acc.refused, ...x.refused],
        }),
        {
          keys: 0,
          lamports: 0,
          repaidToFunder: 0,
          closedBuffers: 0,
          refused: [] as PoolRecoverResponse["refused"],
        },
      );
      // Say all three things separately. A single "recovered X" line would
      // report the funder's repayment as money the user got back, and would
      // report a refusal as nothing having been there — which is the reading
      // that stops someone coming back for ~1 SOL that is still theirs.
      const parts: string[] = [];
      if (r.keys === 0 && r.refused.length === 0) {
        parts.push("Nothing stranded in any pool, no funds to recover.");
      } else {
        if (r.lamports > 0) {
          parts.push(`Recovered ${(r.lamports / 1e9).toFixed(4)} SOL to your wallet.`);
        }
        if (r.repaidToFunder > 0) {
          parts.push(
            `Returned ${(r.repaidToFunder / 1e9).toFixed(4)} SOL to the funder that paid for those jobs — ` +
              `that money was never yours to get back.`,
          );
        }
        if (r.closedBuffers > 0) parts.push(`Closed ${r.closedBuffers} proof buffer(s).`);
        if (r.lamports === 0 && r.repaidToFunder === 0 && r.closedBuffers === 0) {
          parts.push("Nothing was swept.");
        }
      }
      for (const ref of r.refused) {
        parts.push(
          `⚠️ ${(ref.lamports / 1e9).toFixed(4)} SOL left on the key for note #${ref.leafIndex}: ${ref.sentence}`,
        );
      }
      setRecovered(parts.join(" "));
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

  // ONE source of truth for what the user holds. The balance is the sum of the
  // very list rendered below, not a second number from a different code path.
  // The screen once said "0 SOL" next to "2 unspent notes" because the balance
  // came from the chain scan while the list came from the local first paint;
  // deriving both from `unspent` makes that contradiction unrepresentable.
  const shieldedBalance = unspent.reduce((sum, n) => sum + n.denomination, 0);

  /**
   * What a deposit actually costs the BUYER, derived rather than remembered.
   *
   * 🚨 THIS USED TO BE `denomination * 1.003 + 1.006` AND BOTH HALVES WERE
   * WRONG AFTER 2026-08-21.
   *
   * The `+ 1.006` was a hand-kept copy of the proof-buffer rent — 0.44 SOL above
   * the measured 0.570010780 (`denominatedPool.ts`, `SHIELD_RENT_LEG_LAMPORTS`)
   * — and on a RELAYED deposit the buyer never fronts that rent at all: the
   * float does, and the float is what gets it back. Quoting it here overstated
   * the price AND promised a refund that goes to somebody else.
   *
   * `shieldToPool` sets `relayThroughDeployment: true` unconditionally and the
   * path no longer falls back, so every deposit made from this panel is the
   * relayed shape or it is refused. What leaves the wallet is one signature
   * carrying two transfers: the value to the till and the operator's 1% to the
   * fee sink. Both are derived from the pool table so a denomination change
   * cannot leave this number behind.
   */
  const costPool = findPoolV3(token, denomination);
  const valueLamports = costPool ? shieldValueLamports(costPool) : 0;
  const operatorFeeLamports = costPool
    ? Number(
        operatorFeeAtomic({
          token: costPool.token,
          denominationAtomic: costPool.denominationAtomic,
          decimals: costPool.decimals,
        }),
      )
    : 0;
  const shieldCost = ((valueLamports + operatorFeeLamports) / 1e9).toFixed(3);
  const operatorFeeSol = (operatorFeeLamports / 1e9).toFixed(3);

  /**
   * Why the selected denomination cannot take a deposit, or null.
   *
   * Read from `depositBlockFor`, the same function `handlePoolShieldPrepare`
   * refuses on — NOT a rule recomputed here. If this file grew its own copy of
   * the arithmetic, the screen and the engine could disagree, which is the
   * exact defect this round exists to remove.
   */
  const selectedPool = findPoolV3(token, denomination);
  const selectedBlock = selectedPool ? depositBlockFor(selectedPool) : null;

  /**
   * The same answer for every denomination on the ladder, computed once.
   *
   * Keyed off `denominations` — the FULL list — so a blocked pool still gets a
   * chip with its unspent count next to it. Rendering only the open ones would
   * hide the 0.1 SOL pool's 10 notes from the very screen the user checks them
   * on. The chip is disabled; the pool is not.
   */
  const blockByDenomination = new Map<number, DepositBlock>();
  for (const d of denominations) {
    const pool = findPoolV3(token, d);
    const block = pool ? depositBlockFor(pool) : null;
    if (block) blockByDenomination.set(d, block);
  }
  const blockedDenominations = denominations
    .filter((d) => blockByDenomination.has(d))
    .map((d) => ({ denomination: d, block: blockByDenomination.get(d)! }));

  // Every disabled action names its reason next to itself. `scanning` is
  // deliberately absent from all of these: the pool scan enumerates the whole
  // epoch window per note per denomination and does not finish in a time a
  // human will wait, so only the Rescan button itself may lock on it.
  /**
   * 🚨 THE PANEL IS SOL-ONLY, AND THE HEADER CAN SAY OTHERWISE.
   *
   * `PayApp` passes `token={poolToken}`, which is "USDC" whenever the selected
   * asset is USDC — but every action in this file is hardcoded to SOL:
   * `scanPool(meta, "SOL", …)`, `shieldToPool({ token: "SOL" })`,
   * `unshieldFromPool({ token: "SOL" })`, and every amount rendered here
   * divides by 1e9. So with USDC selected the panel drew the USDC pools'
   * denominations — primary 100 — while the shield button called the **100 SOL**
   * pool. A wallet holding 100 SOL would have moved 100 real SOL by clicking a
   * button reached from the USDC tab.
   *
   * Refusing is the only honest state until the whole file is token-aware: the
   * labels, the cost arithmetic and the payout display all assume 9 decimals,
   * so patching the three `token:` literals would leave a panel that moves the
   * right asset and misreports every number about it.
   *
   * Withdrawal is deliberately NOT gated — existing notes are SOL notes and
   * must stay reachable from any tab. Only creating a new one is refused.
   */
  const poolIsSolOnly = token !== "SOL";

  const shieldReason = poolIsSolOnly
    ? `The pool only handles SOL today, so it cannot shield ${token}. Switch the asset to SOL to deposit. Any note you already hold stays withdrawable from here.`
    : // Before the wallet check, because it is a fact about the pool rather
      // than about this session: a different wallet would not help.
      selectedBlock
      ? selectedBlock.message
      : !signOne
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
            note={`${shieldCost} SOL leaves your wallet in one signature: the denomination, the 0.3% protocol fee and the 1% operator fee. The refundable proof rent is this deployment's, not yours.`}
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
          {/* PRIMARY denomination in front, the rest one click behind it.
              WAS "nothing is disabled" until 2026-08-20, and that is no longer
              true — the comment is updated rather than left standing, because a
              comment that describes a property the code lost is worse than none.

              What changed: a denomination whose deposit cannot land is now
              disabled and says so. Two independent reasons, both read from
              `depositBlockFor`, the same function the worker refuses on:
                • 10/100/500/1000 SOL need more pre-funding than the relay will
                  serve, so those deposits took the money and landed nothing —
                  100% of the time, measured from the route's own constants.
                • 0.1 SOL is closed by policy so deposits concentrate in one
                  anonymity set instead of splitting six ways.

              What did NOT change, and must not: every pool keeps its place in
              the note list, the scan, recovery and the Withdraw button. The
              0.1 SOL pool held 10 unspent notes (1.0 SOL) on 2026-08-20. The
              entrance is shut; the exit is untouched. */}
          <div className="flex flex-wrap gap-2">
            {denominations
              // `===` on the primary alone, NOT `|| d === denomination`: the
              // fold below keeps every non-primary, so including the selection
              // here rendered a selected non-primary TWICE, both highlighted,
              // one with an occupancy count and one without. <details> is
              // uncontrolled, so both were on screen at once.
              .filter((d) => d === primaryDenomination)
              .map((d) => (
                <button
                  key={d}
                  onClick={() => setDenomination(d)}
                  disabled={shielding || !!blockByDenomination.get(d)}
                  title={
                    blockByDenomination.get(d)?.message ??
                    (shielding ? "Locked while the shield runs." : undefined)
                  }
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
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-p01-text-dim marker:text-p01-text-dim">
              Other denominations, with how many notes each holds
              {blockedDenominations.length > 0 &&
                ` — ${blockedDenominations.length} closed to new deposits`}
            </summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {denominations
                .filter((d) => d !== primaryDenomination)
                .map((d) => {
                  const size = poolSizes.find((p) => p.denomination === d);
                  const block = blockByDenomination.get(d);
                  return (
                    <button
                      key={d}
                      onClick={() => setDenomination(d)}
                      disabled={shielding || !!block}
                      title={
                        block?.message ??
                        (shielding ? "Locked while the shield runs." : undefined)
                      }
                      className={
                        d === denomination
                          ? "rounded-lg border border-p01-cyan bg-p01-cyan/10 px-3 py-1.5 font-mono text-xs text-p01-cyan"
                          : "rounded-lg border border-p01-border bg-p01-void px-3 py-1.5 font-mono text-xs text-p01-text-muted hover:text-p01-text disabled:opacity-50"
                      }
                    >
                      {d} SOL
                      <span className="ml-1.5 text-p01-text-dim">
                        {size ? `· ${size.unspentNotes}` : "· ?"}
                      </span>
                      {block && (
                        <span className="ml-1.5 text-p01-yellow">
                          {block.reason === "over-relay-cap" ? "· over cap" : "· closed"}
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
            {/* The WHY, in the pool's own words. One line per blocked
                denomination rather than one summary sentence: the two reasons
                are different facts and collapsing them would make the closure
                sound like the arithmetic, or the arithmetic sound like a
                setting someone could turn off. */}
            {blockedDenominations.length > 0 && (
              <ul className="mt-2 space-y-1">
                {blockedDenominations.map(({ denomination: d, block }) => (
                  <li key={d} className="text-xs text-p01-text-dim">
                    {block.message}
                  </li>
                ))}
              </ul>
            )}
          </details>
          {/* THE NUMBER HERE IS THE UNSPENT COUNT, NEVER THE LEAF COUNT.
              `totalNotes` counts every note ever inserted, including every one
              already withdrawn, and a withdrawn note hides nobody. Measured on
              devnet 2026-08-12: the 0.1 SOL pool held 34 leaves and 8 unspent
              notes, the 1 SOL pool 25 and 6. The old sentence quoted the leaf
              count, overstating the set by more than 4x — which is exactly the
              class of sentence the founder ruling forbids. */}
          <p className="mt-2 text-xs text-p01-text-muted">
            {selectedSize
              ? `${selectedSize.unspentNotes} unspent note${selectedSize.unspentNotes === 1 ? "" : "s"} in this pool right now, out of ${selectedSize.totalNotes} ever deposited. Amounts snap to a denomination, so the amount you move is not distinctive. See the privacy note for what withdrawal still reveals.`
              : "Amounts snap to a denomination; arbitrary amounts cannot be shielded."}
          </p>
          {selectedSize && selectedSize.unspentNotes <= 1 && (
            <p className="mt-1 text-xs text-p01-yellow">
              A pool holding {selectedSize.unspentNotes === 0 ? "no" : "one"} unspent note gives you
              nothing to blend into: a deposit and a withdrawal here would be the only ones, so they
              pair trivially no matter what the protocol does. Nothing stops you — this is a fact
              about the pool, not a setting.
            </p>
          )}
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
            Shielding {denomination} SOL costs {shieldCost} SOL, and none of it comes back.
          </summary>
          <p className="mt-1.5 pl-4 text-p01-text-dim">
            The exact breakdown: the {denomination} SOL denomination, a 0.3% protocol fee, and a 1%
            operator fee ({operatorFeeSol} SOL). Your wallet signs ONE transaction carrying both
            transfers, so there is no second approval and no way to pay for the deposit without
            paying the fee. The ~0.57 SOL of proof-buffer rent a deposit also needs is fronted by
            this deployment rather than by you, and returns to this deployment when the buffer
            closes — which is why your figure is smaller than it used to be and why none of it is
            refundable to you. Withdrawal charges 0.5%, and moving the payout off its one-time
            address afterwards costs one more transaction fee (0.000005 SOL).
          </p>
        </details>

        {/* Operator-only, and only on explicit intent: `?treasury=1`.
            Not a permission check — anyone can add a query parameter — but it
            means this can never appear in front of an ordinary user by
            accident, which is the failure that actually happens. The value it
            reveals is the one the whole worker boundary exists to keep inside
            the worker, so it must never be one render away from a normal
            session. */}
        {treasuryMode && (
          <div className="space-y-2 rounded-lg border border-p01-red/50 p-3">
            <p className="text-xs text-p01-red">
              <strong>Treasury setup — this reveals a spend key.</strong> The pool seed derives
              every note this wallet will ever own, and whoever holds it can spend all of them,
              including notes not created yet. Put it in a server environment variable and nowhere
              else.
            </p>
            <button
              type="button"
              onClick={async () => {
                setSeedError(null);
                try {
                  const res = await exportPoolSeed(meta);
                  setSeedHex(res.seedHex);
                  setSeedLegacy(res.hasLegacySeed);
                } catch (e) {
                  setSeedError((e as Error).message || "Seed export failed.");
                }
              }}
              className="btn-secondary px-4 py-2 text-xs"
            >
              Reveal pool seed for P01_TREASURY_POOL_SEED
            </button>
            {seedHex && (
              <>
                <p className="break-all rounded-lg border border-p01-border bg-p01-void p-2 font-mono text-[11px] text-p01-text">
                  {seedHex}
                </p>
                {seedLegacy && (
                  <p className="text-xs text-p01-yellow">
                    ⚠️ This wallet also has a legacy seed: notes shielded before it adopted a
                    passphrase derive from that one and will NOT be issuable with this value. The
                    issuance route refuses them on its on-chain check, which is the right failure
                    but an opaque one — issue only notes shielded under the active derivation.
                  </p>
                )}
              </>
            )}
            {seedError && <p className="text-xs text-p01-red">{seedError}</p>}
          </div>
        )}

        {error && (
          <p className="flex items-start gap-1.5 text-sm text-p01-red">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        )}

        {/* `selectedBlock` is the belt to the picker's braces: the chips for
            blocked denominations are already disabled, so it only bites when
            the fallback selection is itself blocked (USDC, where every pool
            is). The engine refuses either way — this just stops the click. */}
        <button
          type="button"
          onClick={handleShield}
          disabled={shielding || !!busyNote || !signOne || poolIsSolOnly || !!selectedBlock}
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
              {/* Unconditional, and it mirrors SubscribePanel's funding
                  paragraph on purpose.

                  A deposit has no funder path and cannot get one: its pre-fund
                  embeds the denomination itself, so a treasury covering it
                  would be buying the note rather than lending rent. So the
                  wallet signs, the wallet pays, and the residue comes back to
                  the wallet — three separate namings of the same address.

                  The hazard this paragraph exists for is not the deposit. It is
                  what happens to the READER once another screen truthfully says
                  "your wallet did not sign this": a silent deposit screen then
                  reads as the same promise. Saying nothing here is what makes
                  the honest sentence over there misleading. */}
              <p className="mt-2 flex items-start gap-2 text-xs text-p01-text-muted">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-yellow" />
                <span>
                  <strong className="text-p01-text">Your wallet paid for this, in public.</strong>{' '}
                  Depositing moves real value in, so it comes from your address by name — and the
                  leftover rent came back to it afterwards. Anyone reading this deposit reaches
                  your wallet in three steps, and spending this note later republishes the
                  commitment printed above, which is what lets them start from the spend.
                </span>
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
              {/* Who paid. Two very different sentences, and the user is owed
                  whichever one is true — `fundedBy` is a RESULT, not a request:
                  the client asks for a funder, it may not be there, and the
                  fallback is silent on chain.

                  🚨 Neither branch may say "unlinkable". The payout address is
                  published in this withdrawal's instruction data in the clear,
                  so the funder changes who paid the FEES and nothing about who
                  can be reached from the payee — which is why the sentence
                  below points at the sweep rather than at the pre-fund. */}
              {withdrawn.fundedBy === "funder" ? (
                <p className="mt-2 flex items-start gap-2 text-xs text-p01-text-muted">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-cyan" />
                  <span>
                    <strong className="text-p01-text">Your wallet did not pay for this.</strong>{' '}
                    The funder covered the rent and fees and the leftover went back to it. That
                    removes your address from these transactions — it does not make the withdrawal
                    private: the payout address above is written into it in the clear, so whoever
                    reads this reaches whoever you sweep it to. The funder also saw the request and
                    where it came from.
                  </span>
                </p>
              ) : (
                <p className="mt-2 flex items-start gap-2 text-xs text-p01-text-muted">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-yellow" />
                  <span>
                    <strong className="text-p01-text">Your wallet paid for this, in public.</strong>{' '}
                    It signed a transfer to the signing key before, and got the leftover back
                    after. Both name your address.
                    {withdrawn.funderFallbackReason ? (
                      <>
                        {' '}The funder was asked and did not serve:{' '}
                        <span className="font-mono">{withdrawn.funderFallbackReason}</span>
                      </>
                    ) : null}
                  </span>
                </p>
              )}
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
        {/* Above everything drawn from the sealed stores (notes list, spent
            filter, handoff badges, payout history): when a skewed or restarted
            worker left them short, the column must say the right cure before
            it shows any of them — reload for skew, sign-again for a lost
            session. Skew wins when both latched: the reload lands the user on
            the signing gate anyway (the identity never persists), so its
            instruction heals both, while the reverse is not true.
            Never gates a button — standing rule, docs/PAY_UX_REWORK_PLAN.md. */}
        {(staleWorker || lostSession) && (
          <StaleWorkerNotice lostSession={lostSession && !staleWorker} />
        )}

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
          {checkingOlderNotes && (
            <p className="mt-1 text-xs text-p01-text-dim">
              Still checking for older notes — anything found will be added here.
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
            {/* This one line is the only part of the disclosure that is always
                on screen, so it is the sentence most people will ever read —
                and it said "Amounts are hidden", which the paragraph it
                summarises contradicts three lines down ("the amount is
                quantised to a denomination"). The amount is not hidden: each
                pool PDA is seeded on `denomination.to_le_bytes()`, so the
                transaction names which pool and therefore the size. What the
                pool buys is that the size is one of six fixed values instead of
                an exact figure that identifies you by itself. Say that. */}
            <span className="font-medium">
              Devnet. Your amount is one of a few fixed sizes, not hidden. Matching a withdrawal
              to its deposit is not hidden either.
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
                      {handedOver.has(noteKey(n))
                        ? "Handed over, waiting to be claimed. Still yours until one of you spends it."
                        : notesProvisional
                          ? "Still being checked against the chain; may already be spent."
                          : "In the pool, ready to withdraw."}
                    </p>
                    {!handedOver.has(noteKey(n)) && (
                      <button
                        type="button"
                        onClick={() => {
                          // Optimistic state first: the write round-trips the
                          // worker (sealed store) and the badge must not lag
                          // the click. The HANDOFFS_CHANGED_EVENT re-read
                          // reconciles after the write lands.
                          setHandedOver((prev) => new Set(prev).add(noteKey(n)));
                          void recordHandoff(meta, ownerKey, {
                            pool: n.pool,
                            leafIndex: n.leafIndex,
                            sealedAt: Date.now(),
                          });
                        }}
                        // Sealing records this by itself. The manual entry
                        // exists because a handoff leaves NO trace anywhere,
                        // by design, so nothing can be recovered after the
                        // fact: a note handed over from another device, or
                        // before this state existed, can only be declared.
                        title="Marks this note as given to someone. It keeps the note out of the handoff and subscription pickers, and does not change anything on chain."
                        className="mt-1 text-xs text-p01-text-dim underline underline-offset-2 hover:text-p01-text"
                      >
                        Mark as handed over
                      </button>
                    )}
                    {handedOver.has(noteKey(n)) && (
                      <button
                        type="button"
                        onClick={() => {
                          // Same optimistic shape as "Mark as handed over".
                          setHandedOver((prev) => {
                            const next = new Set(prev);
                            next.delete(noteKey(n));
                            return next;
                          });
                          void forgetHandoff(meta, ownerKey, n.pool, n.leafIndex);
                        }}
                        // Says what it does and, more importantly, what it does
                        // not: the recipient keeps their copy either way. The
                        // only real way to take a note back is to spend it.
                        title="Stops treating this note as handed over, so it can be handed over or subscribed with again. It does NOT take it back: the recipient still holds their copy."
                        className="mt-1 text-xs text-p01-cyan underline underline-offset-2 hover:text-p01-text"
                      >
                        Use it freely again
                      </button>
                    )}
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
              {/* There was a "My wallet" button here that prefilled the
                  connected address in one click. It is gone on purpose.

                  The withdrawal's recipient is a cleartext 32-byte instruction
                  argument, so a stranger reads this payout address straight out
                  of the spend and then reads its next transaction. Sweeping
                  home is therefore the single action that undoes the whole
                  payout-address mechanism, in three RPC calls, on the same
                  transaction the rest of this effort is trying to detach from
                  the user. Offering it as the one-click option made the worst
                  destination the easiest one — that is not a default, it is a
                  recommendation.

                  It is still allowed: typing the address works, and `handleSweep`
                  asks for one explicit confirmation first. What is removed is
                  doing it by momentum. */}
              <div className="mb-2">
                <input
                  value={sweepTo}
                  onChange={(e) => {
                    setSweepTo(e.target.value);
                    // Editing the field withdraws the confirmation. Otherwise a
                    // user could confirm sending home, change their mind, type a
                    // different address, and the next press would still be armed.
                    setSweepHomeArmed(null);
                  }}
                  placeholder="Destination address"
                  spellCheck={false}
                  className="w-full rounded-lg border border-p01-border bg-p01-void px-3 py-2 font-mono text-xs text-p01-text placeholder:text-p01-text-dim"
                />
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
