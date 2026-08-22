/**
 * Receive: a QR code, the address under it, one button that copies it.
 *
 * 🎯 WHAT THIS SCREEN LOST, AND WHY
 * ─────────────────────────────────
 * It had TWO copy buttons — a small icon one under the QR and a full-width one
 * inside an "address" card — wired to the same handler and the same clipboard
 * write. Two controls for one action is not redundancy, it is a question the
 * user has to answer before they can copy an address.
 *
 * It also said "devnet" three times (a badge at the top, a heading inside a
 * warning card, and the warning itself), and explained stealth mode twice: once
 * in a banner and again in an info card, with a third copy hidden behind an (i)
 * toggle. The rule from the unlock screen applies here: say it once.
 *
 * ⛔ THE STEALTH PAYMENTS BLOCK IS GONE BECAUSE ITS DESTINATION IS. Founder
 * ruling 2026-08-23 parked personal payments: `/stealth-payments` is now a
 * redirect to `/shield`. A row that reads "3 pending — 0.5 SOL" and then lands
 * the user somewhere else entirely is worse than no row at all, and the pending
 * count it displayed was the only place in the product that number appeared, so
 * it read as an action item that could not be actioned.
 *
 * ⚠️ THE ADDRESS IS SHOWN IN FULL. It was truncated under the QR and shown in
 * full in the card below, so the same address appeared twice in two different
 * shapes. Mono, selectable, wrapping — the one place monospace belongs.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, Shield, ShieldCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

import { useWalletStore } from '@/shared/store/wallet';
import { useStealthStore } from '@/shared/store/stealth';
import { copyToClipboard, cn } from '@/shared/utils';
import { Button, Hairline, Panel, Row, Screen } from '@/popup/ui';

export default function Receive() {
  const navigate = useNavigate();
  const { publicKey, network } = useWalletStore();
  const {
    metaAddress,
    stealthModeEnabled,
    toggleStealthMode,
    isInitialized: stealthInitialized,
  } = useStealthStore();

  const [copied, setCopied] = useState(false);

  // Adresse a afficher (normale ou stealth)
  const displayAddress = stealthModeEnabled && metaAddress ? metaAddress : publicKey;

  // Solana Pay URI format for better wallet compatibility
  const solanaPayUri = displayAddress
    ? stealthModeEnabled
      ? displayAddress // Meta-address as-is for stealth
      : `solana:${displayAddress}`
    : '';

  const handleCopy = async () => {
    if (displayAddress) {
      await copyToClipboard(displayAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  /**
   * The mode switch lives in the header, next to the title it changes. It was
   * a mono-caps chip reading "STEALTH" / "NORMAL"; it now says what pressing it
   * gives you, in the same voice as the rest of the product.
   */
  const modeToggle = stealthInitialized ? (
    <button
      onClick={toggleStealthMode}
      aria-pressed={stealthModeEnabled}
      className={cn(
        'flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 text-tiny transition-colors duration-exit',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
        stealthModeEnabled
          ? 'border-p01-cyan/40 bg-p01-cyan/10 text-p01-cyan'
          : 'border-p01-border text-p01-text-muted hover:border-p01-border-light',
      )}
    >
      {stealthModeEnabled ? (
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Shield className="h-4 w-4" aria-hidden="true" />
      )}
      Stealth
    </button>
  ) : undefined;

  return (
    <Screen
      title="Receive"
      onBack={() => navigate(-1)}
      action={modeToggle}
      footer={
        /* The one action on this screen, full width, at the bottom. */
        <Button
          full
          size="lg"
          icon={copied ? Check : Copy}
          disabled={!displayAddress}
          onClick={() => void handleCopy()}
        >
          {copied ? 'Copied' : stealthModeEnabled ? 'Copy meta-address' : 'Copy address'}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {/* ── The QR, and the address it encodes ── */}
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-xl bg-p01-text p-3">
            {displayAddress ? (
              <QRCodeSVG
                value={solanaPayUri}
                size={168}
                level="H"
                includeMargin={false}
                bgColor="#ffffff"
                fgColor="#070709"
                imageSettings={{
                  src: stealthModeEnabled ? '/stealth-icon.png' : '/01-logo.png',
                  x: undefined,
                  y: undefined,
                  height: 32,
                  width: 32,
                  excavate: true,
                }}
              />
            ) : (
              <div className="flex h-[168px] w-[168px] items-center justify-center bg-p01-surface">
                <span className="text-tiny text-p01-text-dim">No wallet</span>
              </div>
            )}
          </div>

          {/* Mono is for addresses. This is one. Selectable, and shown whole:
              a truncated address cannot be checked against anything. */}
          <code className="w-full select-all break-all text-center font-mono text-tiny leading-relaxed text-p01-text-muted">
            {displayAddress || '----'}
          </code>
        </div>

        {/* One sentence about what this address is. Said once. */}
        <p className="text-tiny text-p01-text-dim">
          {stealthModeEnabled
            ? 'Each payment to this meta-address lands on its own fresh address, so payments to you are not grouped under one. Claiming one moves it to your wallet, which links that address to you.'
            : `Anyone with this address can send you SOL or SPL tokens on ${network}. The address is public and everything sent to it is visible on chain.`}
        </p>

        {network === 'devnet' && (
          <Panel tone="warn">
            <p className="text-tiny text-p01-amber">
              This is a devnet address. Tokens with real value sent here are lost.
            </p>
          </Panel>
        )}

        {/* The only other decision available here, and only when it exists. */}
        {!stealthInitialized && (
          <div>
            <Hairline />
            <Row
              icon={Shield}
              label="Set up a stealth address"
              sub="A fresh address for every payment, so they are not grouped."
              onClick={() => navigate('/settings')}
              chevron
            />
          </div>
        )}
      </div>
    </Screen>
  );
}
