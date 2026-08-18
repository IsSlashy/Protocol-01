"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import nacl from "tweetnacl";
import {
  Coins,
  CreditCard,
  KeyRound,
  Loader2,
  Repeat,
  Send,
  Inbox as InboxIcon,
  Wallet,
  ShieldQuestion,
  Power,
} from "lucide-react";
import clsx from "clsx";
import {
  ALL_ASSETS,
  getAdapter,
  setSolanaSignerRuntime,
  clearStealthSessions,
} from "@/lib/privacy/chains";
import type { Asset, ChainId, DerivedIdentity } from "@/lib/privacy/chains/types";
import type { PoolToken } from "@/lib/privacy/pool/denominatedPool";
import { buildDerivationMessage } from "@/lib/privacy/message";
import { initStealthWorker } from "@/lib/privacy/workerClient";
import ChainCoinSelector from "./ChainCoinSelector";
import SendForm from "./SendForm";
import ReceivePanel from "./ReceivePanel";
import PoolPanel from "./PoolPanel";
import SubscribePanel from "@/components/pay/SubscribePanel";
import SubscriptionsPanel from "@/components/pay/SubscriptionsPanel";
import P01ConnectModal from "./P01ConnectModal";
import Stepper from "./Stepper";
import { truncate } from "./util";

/**
 * Solana-only as of 2026-08-04.
 *
 * The Starknet wiring that used to live in this file — `configureStarknet`, the
 * `isStarknetConfigured` gate, `deriveStarknetIdentity`, the ArgentX/Braavos
 * connect card and the per-chain `snWallet` state — was removed because
 * `ALL_ASSETS` no longer contains a Starknet asset, so none of it was reachable:
 * `asset.chainId` can only be `'solana'`. It is NOT a deletion of the Starknet
 * work. `starknetAdapter`, the asset constants and the e2e tests all still exist
 * in @protocol-01/pay-core; the reason for the retirement and the exact steps to
 * undo it are recorded at the top of packages/pay-core/src/assets.ts. Restore
 * this wiring in the same commit that moves those assets back into ALL_ASSETS.
 */
const CHAIN_TAG = "solana:devnet";
const firstLive = ALL_ASSETS.find((a) => a.status === "live") ?? ALL_ASSETS[0];

// "subs" is the read side of "subscribe": the vaults this browser already
// opened, their standing and their detail. It is its own tab because reviewing
// what you pay for and buying something new are different activities (mobile
// separates them the same way), and the Subscribe tab is already dense.
type Tab = "send" | "receive" | "pool" | "subscribe" | "subs";

export default function PayApp() {
  const {
    publicKey,
    connected,
    signMessage,
    signTransaction,
    signAllTransactions,
    disconnect,
    wallets,
    select,
  } = useWallet();

  /**
   * The P01 extension, if it announced itself to this page.
   *
   * It registers through the Wallet Standard exactly as Phantom does, so the
   * adapter finds it with no configuration. Surfacing it as its OWN button
   * matters: routing the product's wallet through the generic "Connect wallet"
   * modal costs a fold, a modal and a pick — three actions to reach the wallet
   * this app is built around, and one to reach a competitor's.
   *
   * `undefined` when the extension is absent, which is the common case: the
   * button simply does not render, rather than offering something that cannot
   * work.
   */
  const p01Extension = useMemo(
    () =>
      wallets.find(
        (w) =>
          /protocol\s*01/i.test(w.adapter.name) &&
          (w.readyState === "Installed" || w.readyState === "Loadable"),
      ),
    [wallets],
  );
  const { connection } = useConnection();

  const [asset, setAsset] = useState<Asset>(firstLive);
  const [identities, setIdentities] = useState<Partial<Record<ChainId, DerivedIdentity>>>({});
  const [deriving, setDeriving] = useState(false);
  const [deriveError, setDeriveError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("send");

  // Tabs the user has opened this session. A visited panel is never unmounted
  // again, only hidden (see the keep-alive render below): switching tabs
  // mid-shield used to unmount the panel WITH its progress bar, so on screen a
  // multi-minute operation with ~1 SOL in proof buffers simply vanished, and a
  // user who believed it dead would start a second one, the exact mechanism
  // behind this project's orphaned buffers. Hidden-not-unmounted keeps the
  // operation, its progress and its busy reporting alive off-screen.
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(["send"]));
  useEffect(() => {
    setVisited((prev) => (prev.has(tab) ? prev : new Set([...prev, tab])));
  }, [tab]);

  // P01 mobile wallet (paired via QR), or a buyer key created on this device.
  const [p01Keypair, setP01Keypair] = useState<Keypair | null>(null);
  const [showP01, setShowP01] = useState(false);

  // ── The device buyer key ────────────────────────────────────────────────
  //
  // 🚨 THIS USED TO LIVE FOR EXACTLY AS LONG AS THE TAB, and the app sealed
  // paid notes to it anyway. MEASURED 2026-08-17/18: three reloads, three
  // orphaned identities, three spent single-use claim codes. The issuance
  // route's own re-seal branch — same leaf, same recipient — could never fire,
  // because the recipient address never survived long enough to ask twice.
  //
  // `keyIsDevice` distinguishes a key this browser created and stored from a
  // phone paired over QR: only the first is ours to persist, back up or forget.
  const [keyIsDevice, setKeyIsDevice] = useState(false);
  const [keyBackedUp, setKeyBackedUp] = useState(false);

  // The device-key rehydrate that used to run here is gone with the paths that
  // created one. Keeping it would silently re-adopt a stored key on mount, so
  // the extension button — the only way in now — would never be reached.
  // `lib/pay/buyerKey.ts` is untouched and still tested: a stored key remains
  // readable, which is what a migration will need.

  // Which tabs have an operation in flight, fed by the panels' onBusyChange.
  // The tab bar stays CLICKABLE during an operation on purpose: locking a user
  // out of navigation for several minutes is aggressive, and the worker keeps
  // running either way. What must not happen is the operation looking vanished
  // after a tab switch: during those minutes roughly 1 SOL sits in proof
  // buffers, and a user who believes it died starts a second one and locks a
  // second float (the exact mechanism behind this project's orphaned buffers).
  // So the busy tab keeps a pulsing dot, making the way back unmissable.
  const [busyTabs, setBusyTabs] = useState<Partial<Record<Tab, boolean>>>({});
  const setTabBusy = useCallback((t: Tab, busy: boolean) => {
    setBusyTabs((prev) => (!!prev[t] === busy ? prev : { ...prev, [t]: busy }));
  }, []);
  // Stable identities: the panels run their onBusyChange inside an effect, so
  // a new function every render would churn that effect on every keystroke.
  const onPoolBusy = useCallback((b: boolean) => setTabBusy("pool", b), [setTabBusy]);
  const onSubscribeBusy = useCallback((b: boolean) => setTabBusy("subscribe", b), [setTabBusy]);
  const onSendBusy = useCallback((b: boolean) => setTabBusy("send", b), [setTabBusy]);
  const onReceiveBusy = useCallback((b: boolean) => setTabBusy("receive", b), [setTabBusy]);

  // Always "solana" today — ALL_ASSETS is Solana-only (see the note above).
  // Kept as a variable, not inlined, so restoring a second chain is mechanical.
  const chain: ChainId = asset.chainId;
  const identity = identities[chain] ?? null;
  const adapter = useMemo(() => getAdapter(chain), [chain]);

  // ── Unified Solana wallet (Phantom/adapter OR paired P01 keypair) ─────────
  const solPub = p01Keypair ? p01Keypair.publicKey : publicKey;
  const solConnected = !!p01Keypair || connected;
  const solLabel = p01Keypair
    ? `P01 ${truncate(p01Keypair.publicKey.toBase58(), 4, 4)}`
    : publicKey
      ? truncate(publicKey.toBase58(), 4, 4)
      : "";

  // Boot the stealth Web Worker (secret holder) and point it at our RPC.
  useEffect(() => {
    initStealthWorker({ rpcUrl: connection.rpcEndpoint, cluster: "devnet" });
  }, [connection.rpcEndpoint]);

  // Expose the active Solana wallet to the (secret-free) adapter so it can
  // sign + submit the unsigned transactions the worker builds. deriveMeta now
  // REQUIRES a bound signer runtime (sessions are wallet-bound at birth), so
  // the runtime is set whenever a wallet pubkey exists — even for wallets that
  // cannot sign transactions. Those can still derive/scan/claim; only
  // signAndSubmit (sends/registration) fails, honestly, at call time.
  useEffect(() => {
    if (!solPub) {
      setSolanaSignerRuntime(null);
      return;
    }
    const signAll = p01Keypair
      ? async (txs: Transaction[]) => {
          txs.forEach((tx) => tx.partialSign(p01Keypair));
          return txs;
        }
      : signAllTransactions;
    setSolanaSignerRuntime({
      senderPubkey: solPub.toBase58(),
      async signAndSubmit(transactionsB64, ctx) {
        if (!signAll) {
          throw new Error("This wallet cannot sign transactions.");
        }
        const txs = transactionsB64.map((b64) => Transaction.from(Buffer.from(b64, "base64")));
        const signed = await signAll(txs);
        // Submit in order: announcement init, KEM chunks, and LAST the funds
        // transfer. Any failure before the last tx aborts the whole send with
        // no funds moved (worst case: announcement rent).
        let signature = "";
        for (const tx of signed) {
          signature = await connection.sendRawTransaction(tx.serialize());
          const conf = await connection.confirmTransaction(
            { signature, blockhash: ctx.blockhash, lastValidBlockHeight: ctx.lastValidBlockHeight },
            "confirmed"
          );
          if (conf.value.err) {
            throw new Error(`Transaction failed on-chain: ${JSON.stringify(conf.value.err)}`);
          }
        }
        return signature;
      },
    });
    return () => setSolanaSignerRuntime(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p01Keypair, publicKey, signAllTransactions, connection]);

  // A derived identity belongs to ONE wallet — drop it (and the worker's
  // secret sessions) whenever that chain's wallet disconnects or switches.
  const solWalletKey = solPub ? solPub.toBase58() : null;
  useEffect(() => {
    setIdentities((prev) => {
      if (!prev.solana) return prev;
      void clearStealthSessions();
      const { solana: _dropped, ...rest } = prev;
      return rest;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solWalletKey]);

  // Single-transaction signer for the pool shield's pre-fund — the ONLY thing
  // the user's wallet signs in a shield. The paired P01 keypair signs locally;
  // a watch-only wallet has no signer and the panel says so instead of failing
  // halfway through.
  const signSolanaTx = useMemo(() => {
    if (p01Keypair) {
      return async (tx: Transaction) => {
        tx.partialSign(p01Keypair);
        return tx;
      };
    }
    return signTransaction ?? null;
  }, [p01Keypair, signTransaction]);

  const chainConnected = solConnected;
  const step: 0 | 1 | 2 = !chainConnected ? 0 : !identity ? 1 : 2;

  /**
   * Wallets whose signer has been shown to be deterministic, by pubkey.
   *
   * PUBLIC DATA ONLY — a list of addresses that passed a check. No signature,
   * no seed, nothing derived from one. Losing or clearing it costs one extra
   * prompt, never a key.
   *
   * Only PASSES are recorded. A wallet that failed is refused every time it
   * tries, because the cost of that mistake is notes that cannot be found next
   * session and the cost of re-asking is one popup.
   */
  const SIGNER_VERIFIED_KEY = "p01_deterministic_signer_v1";

  function deterministicSignerVerified(pubkey: string): boolean {
    try {
      const raw = window.localStorage.getItem(SIGNER_VERIFIED_KEY);
      return raw ? (JSON.parse(raw) as string[]).includes(pubkey) : false;
    } catch {
      // Unreadable or private mode: re-ask. The cache is an optimisation, and
      // the safe direction when it is unavailable is to perform the check.
      return false;
    }
  }

  function rememberDeterministicSigner(pubkey: string): void {
    try {
      const raw = window.localStorage.getItem(SIGNER_VERIFIED_KEY);
      const list = raw ? (JSON.parse(raw) as string[]) : [];
      if (!list.includes(pubkey)) list.push(pubkey);
      window.localStorage.setItem(SIGNER_VERIFIED_KEY, JSON.stringify(list));
    } catch {
      // Quota or private mode. The check simply runs again next time.
    }
  }

  async function deriveSolana() {
    const doSign = p01Keypair
      ? async (m: Uint8Array) => nacl.sign.detached(m, p01Keypair.secretKey)
      : signMessage;
    if (!solPub || !doSign) {
      setDeriveError("This wallet cannot sign messages, so it cannot derive private keys.");
      return;
    }
    setDeriveError(null);
    setDeriving(true);
    try {
      const message = buildDerivationMessage({
        walletPubkey: solPub.toBase58(),
        origin: typeof window !== "undefined" ? window.location.origin : "",
        chainTag: CHAIN_TAG,
      });
      const encoded = new TextEncoder().encode(message);
      // Sign twice and compare: Ed25519 signMessage must be deterministic, or
      // the derived keys would be unrecoverable next session (Ledger may add
      // entropy). The P01 path signs locally and is always deterministic.
      //
      // ⚠️ TWO PROMPTS, AND THE SECOND ONE HAS TO WAIT FOR THE FIRST TO SETTLE.
      // Chaining the calls with nothing between them asks the wallet extension
      // to open a second popup in the same tick the first one is tearing down,
      // and a wallet that serialises its requests can leave that second popup
      // rendered but inert — "loading forever, cannot press confirm", with a
      // request stuck in its queue that survives a page reload.
      //
      // A yield to the macrotask queue is the whole fix. It changes NOTHING
      // about the check: still two independent signatures, still compared byte
      // for byte, still refused if they differ. It only stops the second
      // request racing the first one's teardown.
      // ⚠️ AND IT IS ASKED ONCE PER WALLET, NOT ONCE PER SESSION.
      //
      // Determinism is a property of the WALLET, not of the session: a signer
      // that returned the same bytes twice will do so again, and one that did
      // not is refused and never gets a cached verdict. So re-prompting on
      // every visit repays a check that can only produce the answer it already
      // produced, and it is the prompt people get stuck on — a second popup
      // opening while the first tears down is what leaves an extension showing
      // "loading" with confirm inert.
      //
      // Only a PASS is remembered, keyed by pubkey. A failure caches nothing,
      // so a non-deterministic wallet is refused every single time.
      //
      // What this does not do is make a wallet swap safe: if the same pubkey is
      // later driven by a signer that produces different bytes, the derived
      // seed differs and the notes are simply not found. That is already the
      // failure on every session after the first, cache or no cache — this
      // moves nothing about it.
      // ⚠️ OUR OWN SIGNERS SKIP THE SECOND PROMPT, and only ours.
      //
      // The check exists because a third-party wallet may sign the same bytes
      // two different ways, and a seed derived from a randomised signature is
      // notes nobody can find next session. It is not a question about ed25519
      // — it is a question about whose implementation is on the other end.
      //
      // For the in-page keypair we ARE the implementation: `doSign` is
      // `nacl.sign.detached` a few lines up. For the P01 extension it is our
      // extension, signing detached ed25519, deterministic by RFC 8032.
      //
      // Asking anyway costs more than a popup here. MEASURED 2026-08-18: the
      // extension's background keeps a single `currentApproval` in
      // chrome.storage.session, so the second request killed the first's
      // message channel and derivation failed with "A listener indicated an
      // asynchronous response by returning true, but the message channel
      // closed before a response was received" — a wallet that works, refused
      // by a check about wallets that do not.
      //
      // ⛔ Third-party wallets are unchanged. They are still asked twice.
      const ownSigner =
        !!p01Keypair || (!!p01Extension && wallets.some((w) => w.adapter.connected && /protocol\s*01/i.test(w.adapter.name)));
      const alreadyVerified = ownSigner || deterministicSignerVerified(solPub.toBase58());
      const sig = await doSign(encoded);
      if (!alreadyVerified) {
        await new Promise((r) => setTimeout(r, 250));
        let sig2: Uint8Array;
        try {
          sig2 = await doSign(encoded);
        } catch (e) {
          // Wipe the first signature before surfacing: it is the root secret,
          // and an early return here used to leave it in memory.
          sig.fill(0);
          throw new Error(
            'The second signature prompt was not completed, so determinism could not be checked ' +
              'and no keys were derived. Nothing was spent. This wallet is asked twice ON PURPOSE, ' +
              'once only — approve both and it will not be asked again. ' +
              `(${(e as Error).message || 'rejected'})`,
          );
        }
        const deterministic = sig.length === sig2.length && sig.every((b, i) => b === sig2[i]);
        sig2.fill(0);
        if (!deterministic) {
          sig.fill(0);
          throw new Error(
            "This wallet does not sign deterministically, so your keys could not be recovered later. Use Phantom or Solflare (software wallet)."
          );
        }
        rememberDeterministicSigner(solPub.toBase58());
      }
      const derived = await adapter.deriveMeta(sig);
      // The signature IS the root secret — wipe the main-thread copy once the
      // worker holds the derived keys.
      sig.fill(0);
      setIdentities((prev) => ({ ...prev, solana: derived }));
    } catch (e) {
      setDeriveError((e as Error).message || "Signature rejected.");
    } finally {
      setDeriving(false);
    }
  }

  function reset() {
    setIdentities({});
    void clearStealthSessions();
    // ⚠️ A DEVICE KEY IS NOT DROPPED HERE, and that is deliberate.
    //
    // `reset()` is reached from the identity chip and from the stale-worker
    // notice, whose whole cure is "reconnect and derive again". Forgetting a
    // stored buyer key on that path would destroy every subscription bought
    // under it — the license key is recomputed from the note's secret, so
    // there is nothing to look up afterwards. A paired phone keypair is a
    // different thing: it lives elsewhere, so zeroing our copy loses nothing.
    if (!keyIsDevice) {
      p01Keypair?.secretKey.fill(0);
      setP01Keypair(null);
    } else {
      // ⚠️ LEAVE THE SESSION, KEEP THE KEY. Two different things, and the
      // first version of this conflated them by doing neither: a device key
      // survived `reset()` on purpose, so `chainConnected` stayed true and the
      // screen sat on "Sign to derive keys" with no way out at all. Measured
      // by a user, immediately.
      //
      // Storage is untouched, so the identity is resumable from the connect
      // screen and nothing bought under it is lost.
      setP01Keypair(null);
      setKeyIsDevice(false);
      setKeyBackedUp(false);
    }
    void disconnect();
  }

  const destination = solPub ? solPub.toBase58() : "";

  // The catalog is already the product surface: retirements are declared in
  // packages/pay-core/src/assets.ts, not filtered here. There is no longer a
  // runtime gate to apply on top of it.
  const selectorAssets = ALL_ASSETS;

  // The pool and subscribe tabs both drive a denominated pool, so they take the
  // same token as the header selector. USDC_POOLS_V3 has real devnet pools.
  const poolToken: PoolToken = asset.symbol === "USDC" ? "USDC" : "SOL";

  // Widens past `md` on large screens. While this was max-w-md, every panel's
  // two-column grid was decorative: the columns opened inside 448px, so each got
  // about 200px and the content truncated to "Bitward...", "communicatio...".
  // Measured from the running app. The page wrapper carries the matching width;
  // neither change works alone.
  return (
    <div className="mx-auto w-full max-w-md lg:max-w-5xl">
      <div className="mb-6">
        <Stepper current={step} />
      </div>

      {/* Coin selector — always visible so users see multi-chain support */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs uppercase tracking-wider text-p01-text-muted">
          Asset
        </label>
        <ChainCoinSelector assets={selectorAssets} selected={asset} onSelect={setAsset} />
      </div>

      {/* Gate 1 — connect */}
      {!chainConnected && (
        <div className="glass space-y-4 p-7 text-center">
          <KeyRound className="mx-auto h-8 w-8 text-p01-cyan" />
          <div>
            {/* ⚠️ THIS SCREEN USED TO OPEN ON SOMEBODY ELSE'S WALLET.
                It was titled "Connect a wallet", led with Phantom, and buried
                the P01 key under two folds — so the product's own wallet was
                the third option on a screen about wallets. An external wallet
                is also the WORST option here: it is the account that holds the
                user's real financial life, and a deposit it pays for names
                them. It belongs behind a fold, not in front of one. */}
            <p className="font-display text-p01-text">Your P01 wallet</p>
            {/* "post-quantum payments" is the exact phrase the page header of
                app/(pay)/app/page.tsx forbids, and this connect card said it:
                the signature that pays is Ed25519 and stays Ed25519. What is
                post-quantum here is the stealth address and the note
                encryption, hybrid X25519 + ML-KEM-768, so that is what the
                sentence names. Also drops the pre-rename product name. */}
            <p className="mt-1 text-sm text-p01-text-muted">
              Everything here runs on a P01 key: subscriptions belong to it, notes are sealed to
              it, and the deployment pays the fees. Recipient addresses are hybrid post-quantum.
              The signature that pays is Ed25519 and stays Ed25519.
            </p>
          </div>
          {/* ⚠️ ORDER IS THE ARGUMENT HERE.
              A wallet was only ever needed to make a seed recoverable and to
              sign the pre-fund; the funder does the second job now and the
              stored key does the first. And a buyer who connects a wallet is a
              buyer whose deposit can name them — the one thing this product
              exists to avoid. So the device key leads and the wallet folds. */}
          {/* ⚠️ THE PRODUCT'S OWN WALLET, AT THE TOP, WITH ONE CLICK.
              It renders only when the extension actually announced itself
              through the Wallet Standard, so the button never promises
              something that cannot happen. `select()` is enough — the adapter
              connects on selection, which is why there is no second step and
              no modal. */}
          {p01Extension && (
            <button
              className="btn-primary flex w-full items-center justify-center gap-2"
              onClick={() => select(p01Extension.adapter.name)}
            >
              <Wallet className="h-4 w-4" /> Connect the P01 extension
            </button>
          )}

          {/* ⛔ THE P01 EXTENSION IS THE ONLY WAY IN.
              A key pasted into a text field, a key generated in the page, an
              external wallet — all of it worked, and all of it existed because
              the extension could not announce itself. It can now, so the doors
              that were built around its absence are gone rather than folded:
              a fold is still a decision, and every one of those paths put the
              signing key somewhere weaker than the extension holds it.
              ⚠️ When the extension is missing the screen says so and stops.
              There is deliberately no fallback — a fallback here is how a
              buyer ends up with a key in localStorage they never chose. */}
          {!p01Extension && (
            <div className="rounded-lg border border-p01-yellow/30 bg-p01-yellow/5 p-4 text-left">
              <p className="text-sm text-p01-yellow">The P01 extension is not installed.</p>
              <p className="mt-2 text-xs text-p01-text-muted">
                It is what holds your keys and signs for you. Install it, then reload this page —
                it announces itself to the app and the button above appears.
              </p>
            </div>
          )}
          {/* A buyer that is not a wallet at all.
              Everything downstream already supports this: `p01Keypair` replaces
              the adapter for `solPub`, for `doSign` — nacl, locally, so there is
              no extension, no popup and no request queue to get stuck — and for
              transaction signing. The plumbing existed for the paired-phone
              path; nothing generated a key here.
              It is the honest shape for a subscription buyer. The wallet was
              only ever needed to make a seed recoverable and to sign the
              pre-fund, and the funder does the second job now.
              ⚠️ Held in memory only. Whoever closes this tab loses the identity
              and the license key of anything bought under it, which is why the
              address is shown with an export rather than quietly created. */}
        </div>
      )}

      {/* The device-key backup gate lived here. It guarded a secret this
          page created; the extension holds its own keys and backs them up
          itself, so there is nothing here left to save. */}

      {/* Gate 2 — derive keys */}
      {/* `keyBackedUp` gates this so the backup step is not competing with a
          signature prompt. A device key that is not saved yet has nothing to
          derive TO that the user could keep. */}
      {chainConnected && !identity && (!keyIsDevice || keyBackedUp) && (
        <div className="glass space-y-4 p-6">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-p01-cyan" />
            <p className="font-display text-p01-text">Derive your private keys</p>
          </div>
          <p className="text-sm text-p01-text-muted">
            {/* The count is now conditional, so the copy has to be too — a
                screen that promises two prompts and shows one reads as a bug,
                and one that promises one and shows two reads as a trap. */}
            {/* ⚠️ "never stored" IS SCOPED TO THE WALLET PATH, and has to be.
                On the device path the signing key is in this browser's storage
                by design — that is the whole point of it — so a page that
                exists to correct overstatement must not ship the sentence that
                would now be false. */}
            {solPub && deterministicSignerVerified(solPub.toBase58())
              ? `One signature creates your stealth spending, viewing and post-quantum (ML-KEM-768) keys. No transaction is sent, no gas is paid.${keyIsDevice ? " They are derived from the buyer key stored in this browser." : " Your keys live only in this tab, never uploaded, never stored."}`
              : `Two signatures, once for this wallet: the first creates your stealth spending, viewing and post-quantum (ML-KEM-768) keys, the second only checks that your wallet signs the same way twice — a wallet that does not would leave your keys unrecoverable later. Approve both and you will not be asked again. No transaction is sent, no gas is paid.${keyIsDevice ? " They are derived from the buyer key stored in this browser." : " Your keys live only in this tab, never uploaded, never stored."}`}
          </p>
          <div className="flex items-start gap-2 rounded-lg border border-p01-yellow/30 bg-p01-yellow/5 p-3 text-xs text-p01-yellow">
            <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0" />
            Only sign this on the official site. Any site that gets this signature can derive your
            keys.
          </div>
          {deriveError && <p className="text-sm text-p01-red">{deriveError}</p>}
          <button
            className="btn-primary flex w-full items-center justify-center gap-2 disabled:opacity-50"
            onClick={deriveSolana}
            disabled={deriving}
          >
            {deriving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Waiting for signature…
              </>
            ) : (
              <>
                <KeyRound className="h-4 w-4" /> Sign to derive keys
              </>
            )}
          </button>
          <button className="text-center text-xs text-p01-text-muted hover:text-p01-cyan" onClick={reset}>
            Disconnect
          </button>
        </div>
      )}

      {/* Ready — tabs */}
      {chainConnected && identity && (
        <div className="space-y-4">
          {/* ⚠️ THE QUESTION THE TABS CANNOT ANSWER.
              The bar names five protocol primitives. A person arrives wanting
              one of three OUTCOMES, and the mapping between the two is exactly
              the knowledge they do not have. Asked "my identity is ready, do I
              shield now?", the honest answer is usually NO — and nothing on
              this screen said so.
              That is not hypothetical: it is how the wrong kind of note gets
              made. A buyer deposits, spends what they deposited, and the
              subscription walks back to them in one hop. Measured
              2026-08-17/18, then measured again by the probes: P9 and P11 red
              on a run where everything else was right. */}
          <div className="rounded-lg border border-p01-border bg-p01-surface p-4">
            <p className="font-display text-sm text-p01-text">What do you want to do?</p>
            <div className="mt-3 space-y-2">
              <button
                onClick={() => setTab("subscribe")}
                className="w-full rounded-md border border-p01-border bg-p01-void p-3 text-left transition hover:border-p01-cyan"
              >
                <span className="text-sm text-p01-cyan">Subscribe to a vendor</span>
                <span className="mt-1 block text-xs text-p01-text-muted">
                  You do not need to put money in. A note is issued to you against a claim code,
                  and nothing is deposited in your name.
                </span>
              </button>
              <button
                onClick={() => setTab("send")}
                className="w-full rounded-md border border-p01-border bg-p01-void p-3 text-left transition hover:border-p01-cyan"
              >
                <span className="text-sm text-p01-text">Hand a note to someone</span>
                <span className="mt-1 block text-xs text-p01-text-muted">
                  You hand over a whole note, not an amount. Needs one you already hold.
                </span>
              </button>
              <button
                onClick={() => setTab("pool")}
                className="w-full rounded-md border border-p01-border bg-p01-void p-3 text-left transition hover:border-p01-yellow"
              >
                <span className="text-sm text-p01-text">Put money in (deposit)</span>
                <span className="mt-1 block text-xs text-p01-yellow">
                  Only to hold value or to hand a note over. A note you deposit yourself is the
                  one kind that points back at you — do not deposit just to subscribe.
                </span>
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            {/* flex-wrap: five tabs no longer fit one row inside max-w-md. */}
            <div className="inline-flex flex-wrap rounded-lg border border-p01-border bg-p01-surface p-1">
              {/* Pool, subscribe and subs are Solana-only: all three drive the
                  denominated pool, which exists on Solana alone. */}
              {((chain === "solana"
                ? ["send", "receive", "pool", "subscribe", "subs"]
                : ["send", "receive"]) as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  title={busyTabs[t] ? "An operation is still running in this tab" : undefined}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition",
                    tab === t ? "bg-p01-cyan text-p01-void" : "text-p01-text-muted hover:text-p01-text"
                  )}
                >
                  {t === "send" ? (
                    <Send className="h-3.5 w-3.5" />
                  ) : t === "receive" ? (
                    <InboxIcon className="h-3.5 w-3.5" />
                  ) : t === "pool" ? (
                    <Coins className="h-3.5 w-3.5" />
                  ) : t === "subscribe" ? (
                    <Repeat className="h-3.5 w-3.5" />
                  ) : (
                    <CreditCard className="h-3.5 w-3.5" />
                  )}
                  {t}
                  {busyTabs[t] && (
                    <span className="relative flex h-2 w-2" aria-label="operation in progress">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-p01-yellow opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-p01-yellow" />
                    </span>
                  )}
                </button>
              ))}
            </div>
            <button
              onClick={reset}
              className="inline-flex items-center gap-1 text-xs text-p01-text-muted hover:text-p01-red"
              title={solLabel}
            >
              <Power className="h-3.5 w-3.5" /> {solLabel}
            </button>
          </div>

          {asset.status === "coming-soon" && (
            <div className="card p-6 text-center text-sm text-p01-text-muted">
              {asset.name} private transactions are coming soon.
            </div>
          )}

          {/* Keep-alive panels: each mounts on first visit and is then only
              HIDDEN on tab switch, never unmounted. The panels report their
              in-flight state through onBusyChange from an effect whose cleanup
              clears the flag on unmount, which is correct precisely because,
              with this structure, unmount only happens on disconnect. A shield
              left mid-flight keeps its progress bar, keeps its badge, and is
              exactly where the user left it when they come back. It also means
              a tab's scan runs once per session, not once per visit. */}
          {(() => {
            const comingSoon = asset.status === "coming-soon";
            const show = (t: Tab) => (tab === t && !comingSoon ? undefined : "hidden");
            return (
              <>
                {visited.has("send") && (
                  // The note handoff needs the pool session key and the wallet
                  // that owns the local note blobs. Solana-only, like the pools.
                  <div className={show("send")}>
                    <SendForm
                      adapter={adapter}
                      asset={asset}
                      meta={chain === "solana" ? identity.meta : null}
                      owner={chain === "solana" ? solPub : null}
                      onBusyChange={onSendBusy}
                    />
                  </div>
                )}
                {visited.has("receive") && (
                  // Receiving means importing a sealed note, which needs the
                  // pool session key and the wallet that owns the local note
                  // store. Same nullable contract as SendForm; the panel
                  // explains a missing session itself.
                  <div className={show("receive")}>
                    <ReceivePanel
                      adapter={adapter}
                      identity={identity}
                      destination={destination}
                      meta={chain === "solana" ? identity.meta : null}
                      owner={chain === "solana" ? solPub : null}
                      onBusyChange={onReceiveBusy}
                    />
                  </div>
                )}
                {visited.has("pool") && chain === "solana" && solPub && (
                  <div className={show("pool")}>
                    <PoolPanel
                      meta={identity.meta}
                      owner={solPub}
                      connection={connection}
                      signOne={signSolanaTx}
                      token={poolToken}
                      onBusyChange={onPoolBusy}
                    />
                  </div>
                )}
                {visited.has("subscribe") && chain === "solana" && solPub && (
                  // Same shape as the pool tab: subscribing pre-funds an
                  // ephemeral with ONE wallet-signed transfer, then the
                  // ephemeral does the rest. `signSolanaTx` is passed through
                  // nullable on purpose: the panel reports a watch-only wallet
                  // itself, with a reason, instead of being hidden behind a
                  // generic card here.
                  <div className={show("subscribe")}>
                    <SubscribePanel
                      meta={identity.meta}
                      owner={solPub}
                      connection={connection}
                      signOne={signSolanaTx}
                      token={poolToken}
                      onBusyChange={onSubscribeBusy}
                    />
                  </div>
                )}
                {visited.has("subs") && chain === "solana" && solPub && (
                  // Read-only: the subscriptions this browser opened, their
                  // standing and their license key, re-derived in the Worker on
                  // demand. No signer on purpose; this tab never sends a
                  // transaction. `meta` identifies the Worker session that
                  // holds the note secrets.
                  <div className={show("subs")}>
                    <SubscriptionsPanel
                      meta={identity.meta}
                      owner={solPub}
                      connection={connection}
                    />
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {showP01 && (
        <P01ConnectModal
          onClose={() => setShowP01(false)}
          onConnected={(kp) => {
            setP01Keypair(kp);
            setShowP01(false);
          }}
        />
      )}
    </div>
  );
}
