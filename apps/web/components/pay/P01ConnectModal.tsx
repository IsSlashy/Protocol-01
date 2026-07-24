"use client";

/**
 * Connect the Protocol 01 mobile wallet to the web /pay page.
 *
 * Same channel protocol as the extension's ConnectPhone (p01conn1 QR → phone
 * scans in "Settings → Connect to extension" → seals its seed to the one-time
 * code shown here → uploads ciphertext to /api/pair/:id on THIS origin → we
 * poll, decrypt with the code, derive the Solana keypair). The relay only ever
 * sees ciphertext; the code never leaves this screen except by the user typing
 * it on their phone.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AlertCircle, Loader2, RefreshCw, Smartphone, X } from "lucide-react";
import type { Keypair } from "@solana/web3.js";
import {
  generatePairingCode,
  formatCodeForDisplay,
  decryptPairing,
  DEFAULT_TTL_SEC,
} from "@/lib/pair/pairCrypto";
import { makeConnectToken } from "@/lib/pair/connectPair";
import { keypairFromMnemonic } from "@/lib/pair/deriveWallet";

const POLL_MS = 2500;

export default function P01ConnectModal({
  onConnected,
  onClose,
}: {
  onConnected: (keypair: Keypair) => void;
  onClose: () => void;
}) {
  const [channel, setChannel] = useState(() => generatePairingCode());
  const codeRef = useRef(generatePairingCode());
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_TTL_SEC);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const stoppedRef = useRef(false);

  const token =
    typeof window !== "undefined" ? makeConnectToken(window.location.origin, channel) : "";

  const regenerate = useCallback(() => {
    stoppedRef.current = false;
    codeRef.current = generatePairingCode();
    setChannel(generatePairingCode());
    setError("");
    setSecondsLeft(DEFAULT_TTL_SEC);
  }, []);

  // Countdown — expire client-side too.
  useEffect(() => {
    const iv = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          stoppedRef.current = true;
          setError("This pairing code expired. Start over to generate a fresh one.");
          clearInterval(iv);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [channel]);

  // Poll the relay for the phone's encrypted blob.
  useEffect(() => {
    stoppedRef.current = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (stoppedRef.current) return;
      try {
        const res = await fetch(`/api/pair/${channel}`, { cache: "no-store" });
        if (res.ok) {
          const { blob } = (await res.json()) as { blob: string | null };
          if (blob) {
            stoppedRef.current = true;
            try {
              setImporting(true);
              const mnemonic = await decryptPairing(blob, codeRef.current);
              const keypair = await keypairFromMnemonic(mnemonic);
              onConnected(keypair);
              return;
            } catch {
              setImporting(false);
              setError(
                "The code entered on your phone didn’t match. Start over and re-enter the code shown here."
              );
              return;
            }
          }
        }
      } catch {
        // network blip — keep polling
      }
      timer = setTimeout(poll, POLL_MS);
    };

    timer = setTimeout(poll, POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal>
      <div className="glass w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-p01-cyan" />
            <p className="font-display text-p01-text">Connect P01 Wallet</p>
          </div>
          <button onClick={onClose} className="text-p01-text-muted hover:text-p01-text" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-xs text-p01-text-muted">
          In the P01 app: <span className="text-p01-cyan">Settings → Connect to extension</span>,
          scan this QR, then type the code below on your phone.
        </p>

        <div className="flex justify-center">
          <div className="rounded-lg bg-white p-3">
            {token && <QRCodeSVG value={token} size={192} level="M" />}
          </div>
        </div>

        <div className="card p-3 text-center">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-p01-text-dim">
            Pairing code (type on phone)
          </p>
          <p className="font-mono text-lg font-bold tracking-[2px] text-p01-cyan">
            {formatCodeForDisplay(codeRef.current)}
          </p>
        </div>

        <div className="flex items-center justify-center gap-2 text-xs text-p01-text-muted">
          {importing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing wallet…
            </>
          ) : error ? null : secondsLeft > 0 ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for phone… expires in {secondsLeft}s
            </>
          ) : (
            "Expired"
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-p01-red/30 bg-p01-red/10 p-3 text-xs text-p01-red" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        {(error || secondsLeft === 0) && (
          <button onClick={regenerate} className="btn-secondary flex w-full items-center justify-center gap-2">
            <RefreshCw className="h-4 w-4" /> Start over
          </button>
        )}

        <p className="text-[10px] leading-relaxed text-p01-text-dim">
          Your seed is encrypted on your phone to this one-time code before it leaves the device.
          The relay only ever sees ciphertext. The imported wallet lives in this tab&apos;s memory
          only and is forgotten when you close it.
        </p>
      </div>
    </div>
  );
}
