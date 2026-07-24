"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Keypair, Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import nacl from "tweetnacl";
import {
  KeyRound,
  Loader2,
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
import {
  clearStarknetSessions,
  configureStarknet,
  deriveStarknetIdentity,
  isStarknetConfigured,
  setStarknetSignerRuntime,
  type ConnectedStarknet,
} from "@protocol-01/pay-core/chains/starknet";
import { buildDerivationMessage } from "@/lib/privacy/message";
import { initStealthWorker } from "@/lib/privacy/workerClient";
import ChainCoinSelector from "./ChainCoinSelector";
import SendForm from "./SendForm";
import ReceivePanel from "./ReceivePanel";
import P01ConnectModal from "./P01ConnectModal";
import Stepper from "./Stepper";
import { truncate } from "./util";

const CHAIN_TAG = "solana:devnet";
const firstLive = ALL_ASSETS.find((a) => a.status === "live") ?? ALL_ASSETS[0];

type Tab = "send" | "receive";

export default function PayApp() {
  const { publicKey, connected, signMessage, signAllTransactions, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();

  const [asset, setAsset] = useState<Asset>(firstLive);
  const [identities, setIdentities] = useState<Partial<Record<ChainId, DerivedIdentity>>>({});
  const [deriving, setDeriving] = useState(false);
  const [deriveError, setDeriveError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("send");

  // P01 mobile wallet (paired via QR — an in-memory Solana keypair).
  const [p01Keypair, setP01Keypair] = useState<Keypair | null>(null);
  const [showP01, setShowP01] = useState(false);

  // Starknet wallet (ArgentX / Braavos via get-starknet).
  const [snWallet, setSnWallet] = useState<ConnectedStarknet | null>(null);
  // Runtime-config gate: without an RPC + deployed pq_announcer, Starknet
  // assets render as coming-soon (set after configureStarknet runs).
  const [snConfigured, setSnConfigured] = useState(false);

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

  // Starknet chain config (Sepolia; announcer address comes from env once the
  // contract is deployed there — until then scan is empty and send gates).
  useEffect(() => {
    configureStarknet({
      nodeUrl:
        process.env.NEXT_PUBLIC_STARKNET_RPC_URL ||
        "https://starknet-sepolia-rpc.publicnode.com",
      announcerAddress: process.env.NEXT_PUBLIC_PQ_ANNOUNCER_ADDRESS || "",
      explorerBase: "https://sepolia.starkscan.co",
      accountClassHash: process.env.NEXT_PUBLIC_STARKNET_ACCOUNT_CLASS_HASH || undefined,
    });
    setSnConfigured(isStarknetConfigured());
  }, []);

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

  const chainConnected = chain === "solana" ? solConnected : !!snWallet;
  const step: 0 | 1 | 2 = !chainConnected ? 0 : !identity ? 1 : 2;

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
      const sig = await doSign(encoded);
      const sig2 = await doSign(encoded);
      const deterministic = sig.length === sig2.length && sig.every((b, i) => b === sig2[i]);
      sig2.fill(0);
      if (!deterministic) {
        sig.fill(0);
        throw new Error(
          "This wallet does not sign deterministically, so your keys could not be recovered later. Use Phantom or Solflare (software wallet)."
        );
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

  async function connectStarknet() {
    setDeriveError(null);
    setDeriving(true);
    try {
      // Wallet switch: a derived identity belongs to ONE wallet — wipe the
      // previous wallet's secret sessions (and its identity) before the new
      // connection replaces it. No-op on first connect.
      clearStarknetSessions();
      setIdentities((prev) => {
        if (!prev.starknet) return prev;
        const { starknet: _dropped, ...rest } = prev;
        return rest;
      });
      const { connection: sn, identity: snId } = await deriveStarknetIdentity();
      setSnWallet(sn);
      setStarknetSignerRuntime({ account: sn.account, address: sn.address });
      setIdentities((prev) => ({ ...prev, starknet: snId }));
    } catch (e) {
      setDeriveError((e as Error).message || "Starknet connection rejected.");
    } finally {
      setDeriving(false);
    }
  }

  function reset() {
    setIdentities({});
    void clearStealthSessions();
    clearStarknetSessions();
    // Best-effort zeroization of the paired P01 keypair before dropping it.
    p01Keypair?.secretKey.fill(0);
    setP01Keypair(null);
    setSnWallet(null);
    setStarknetSignerRuntime(null);
    void disconnect();
  }

  const destination =
    chain === "solana" ? (solPub ? solPub.toBase58() : "") : (snWallet?.address ?? "");

  // Starknet "Live" is honest only once the runtime config can reach the chain
  // (RPC + deployed pq_announcer). Until then its assets gate as coming-soon.
  const selectorAssets = useMemo(
    () =>
      snConfigured
        ? ALL_ASSETS
        : ALL_ASSETS.map((a) =>
            a.chainId === "starknet" ? { ...a, status: "coming-soon" as const } : a
          ),
    [snConfigured]
  );

  return (
    <div className="mx-auto w-full max-w-md">
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

      {/* Gate 1 — connect (per chain) */}
      {!chainConnected && chain === "solana" && (
        <div className="glass space-y-4 p-7 text-center">
          <Wallet className="mx-auto h-8 w-8 text-p01-cyan" />
          <div>
            <p className="font-display text-p01-text">Connect a wallet</p>
            <p className="mt-1 text-sm text-p01-text-muted">
              Connect Phantom — or pair your Protocol 01 mobile wallet — to send and receive
              private, post-quantum payments.
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

      {!chainConnected && chain === "starknet" && !snConfigured && (
        <div className="glass space-y-4 p-7 text-center">
          <Wallet className="mx-auto h-8 w-8 text-p01-cyan" />
          <p className="text-sm text-p01-text-muted">
            Starknet testnet configuration pending — coming soon.
          </p>
        </div>
      )}

      {!chainConnected && chain === "starknet" && snConfigured && (
        <div className="glass space-y-4 p-7 text-center">
          <Wallet className="mx-auto h-8 w-8 text-p01-cyan" />
          <div>
            <p className="font-display text-p01-text">Connect a Starknet wallet</p>
            <p className="mt-1 text-sm text-p01-text-muted">
              ArgentX or Braavos. One signature derives your post-quantum stealth keys — the
              same meta-address works on Solana and Starknet.
            </p>
          </div>
          {deriveError && <p className="text-sm text-p01-red">{deriveError}</p>}
          <button
            className="btn-primary flex w-full items-center justify-center gap-2 disabled:opacity-50"
            onClick={connectStarknet}
            disabled={deriving}
          >
            {deriving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Connecting…
              </>
            ) : (
              <>
                <Wallet className="h-4 w-4" /> Connect ArgentX / Braavos
              </>
            )}
          </button>
        </div>
      )}

      {/* Gate 2 — derive keys (Solana; Starknet derives during connect) */}
      {chainConnected && !identity && chain === "solana" && (
        <div className="glass space-y-4 p-6">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-p01-cyan" />
            <p className="font-display text-p01-text">Derive your private keys</p>
          </div>
          <p className="text-sm text-p01-text-muted">
            Two quick signatures create your stealth spending, viewing and post-quantum
            (ML-KEM-768) keys — the second only verifies your wallet signs deterministically.
            No transaction is sent, no gas is paid. Your keys live only in this tab, never
            uploaded, never stored.
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

      {chainConnected && !identity && chain === "starknet" && (
        <div className="glass space-y-4 p-6 text-center">
          {deriveError && <p className="text-sm text-p01-red">{deriveError}</p>}
          <button
            className="btn-primary flex w-full items-center justify-center gap-2 disabled:opacity-50"
            onClick={connectStarknet}
            disabled={deriving}
          >
            <KeyRound className="h-4 w-4" /> Sign to derive keys
          </button>
        </div>
      )}

      {/* Ready — tabs */}
      {chainConnected && identity && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="inline-flex rounded-lg border border-p01-border bg-p01-surface p-1">
              {(["send", "receive"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium capitalize transition",
                    tab === t ? "bg-p01-cyan text-p01-void" : "text-p01-text-muted hover:text-p01-text"
                  )}
                >
                  {t === "send" ? <Send className="h-3.5 w-3.5" /> : <InboxIcon className="h-3.5 w-3.5" />}
                  {t}
                </button>
              ))}
            </div>
            <button
              onClick={reset}
              className="inline-flex items-center gap-1 text-xs text-p01-text-muted hover:text-p01-red"
              title={chain === "solana" ? solLabel : truncate(snWallet?.address ?? "", 6, 4)}
            >
              <Power className="h-3.5 w-3.5" />{" "}
              {chain === "solana" ? solLabel : truncate(snWallet?.address ?? "", 6, 4)}
            </button>
          </div>

          {asset.status === "coming-soon" ? (
            <div className="card p-6 text-center text-sm text-p01-text-muted">
              {asset.name} private transactions are coming soon.
            </div>
          ) : tab === "send" ? (
            <SendForm adapter={adapter} asset={asset} />
          ) : (
            <ReceivePanel adapter={adapter} identity={identity} destination={destination} />
          )}
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
