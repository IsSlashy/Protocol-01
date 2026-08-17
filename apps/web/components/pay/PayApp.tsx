"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
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
  Smartphone,
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
  const { publicKey, connected, signMessage, signTransaction, signAllTransactions, disconnect } =
    useWallet();
  const { setVisible } = useWalletModal();
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

  // P01 mobile wallet (paired via QR — an in-memory Solana keypair).
  const [p01Keypair, setP01Keypair] = useState<Keypair | null>(null);
  const [showP01, setShowP01] = useState(false);

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
      const alreadyVerified = deterministicSignerVerified(solPub.toBase58());
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
    // Best-effort zeroization of the paired P01 keypair before dropping it.
    p01Keypair?.secretKey.fill(0);
    setP01Keypair(null);
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
          <Wallet className="mx-auto h-8 w-8 text-p01-cyan" />
          <div>
            <p className="font-display text-p01-text">Connect a wallet</p>
            {/* "post-quantum payments" is the exact phrase the page header of
                app/(pay)/app/page.tsx forbids, and this connect card said it:
                the signature that pays is Ed25519 and stays Ed25519. What is
                post-quantum here is the stealth address and the note
                encryption, hybrid X25519 + ML-KEM-768, so that is what the
                sentence names. Also drops the pre-rename product name. */}
            <p className="mt-1 text-sm text-p01-text-muted">
              Connect Phantom, or pair your Styx mobile wallet, to send and receive.
              Recipient addresses are hybrid post-quantum. The signature that pays
              is Ed25519 and stays Ed25519.
            </p>
          </div>
          <button
            className="glass glass-hover w-full py-3.5 font-display text-sm uppercase tracking-[0.15em] text-p01-cyan"
            onClick={() => setVisible(true)}
          >
            Connect wallet
          </button>
          <button
            className="btn-secondary flex w-full items-center justify-center gap-2"
            onClick={() => setShowP01(true)}
          >
            <Smartphone className="h-4 w-4" /> Connect P01 Wallet
          </button>
        </div>
      )}

      {/* Gate 2 — derive keys */}
      {chainConnected && !identity && (
        <div className="glass space-y-4 p-6">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-p01-cyan" />
            <p className="font-display text-p01-text">Derive your private keys</p>
          </div>
          <p className="text-sm text-p01-text-muted">
            {/* The count is now conditional, so the copy has to be too — a
                screen that promises two prompts and shows one reads as a bug,
                and one that promises one and shows two reads as a trap. */}
            {solPub && deterministicSignerVerified(solPub.toBase58())
              ? "One signature creates your stealth spending, viewing and post-quantum (ML-KEM-768) keys. No transaction is sent, no gas is paid. Your keys live only in this tab, never uploaded, never stored."
              : "Two signatures, once for this wallet: the first creates your stealth spending, viewing and post-quantum (ML-KEM-768) keys, the second only checks that your wallet signs the same way twice — a wallet that does not would leave your keys unrecoverable later. Approve both and you will not be asked again. No transaction is sent, no gas is paid. Your keys live only in this tab, never uploaded, never stored."}
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
