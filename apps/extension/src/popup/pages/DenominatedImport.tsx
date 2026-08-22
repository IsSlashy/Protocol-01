/**
 * DenominatedImport — receive a note someone sent you. Route: /shield/receive-note.
 *
 * 🎯 IT IS A REAL ACTION NOW. This screen used to hang off a 9px link, which is
 * why the two halves of a handoff were not symmetrical: sending was a button
 * and receiving was a footnote. It is one of the four verbs on the Shield tab,
 * and it opens as a screen with a way back to it.
 *
 * Two things happen here, in the order a receiver needs them: their note
 * address, to hand to the sender, and the paste box for what comes back.
 *
 * Importing is purely local — no transaction, so it publishes nothing. The
 * withdrawal that follows does: it republishes this note's commitment, which the
 * sender's transfer transaction already put on-chain, so the exit is matchable
 * back to that transfer and through it to the sender's deposit. Copy on this
 * screen must not suggest that receiving a note detaches it from its history.
 *
 * The success page is gone. Importing lands the note in the list on Shield, so
 * the screen returns there rather than showing a tick and a Done button.
 */

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, Download } from 'lucide-react';
import { cn, copyToClipboard } from '@/shared/utils';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { ALL_POOLS_V3 } from '@/shared/services/denominatedPool';
import { Amount, Button, Eyebrow, Panel, Screen } from '@/popup/ui';

export default function DenominatedImport() {
  const navigate = useNavigate();
  const { importNoteAction, peekNote, getMyNoteAddress, loading } = useDenominatedPoolStore();

  const [encoded, setEncoded] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [addrCopied, setAddrCopied] = useState(false);

  // This wallet's own receive address — share it to receive private notes.
  const myAddress = useMemo(() => {
    try {
      return getMyNoteAddress();
    } catch {
      return null; // e.g. wallet locked (no local keypair available)
    }
  }, [getMyNoteAddress]);

  // Live preview of the pasted note (decrypts p01enc1 blobs with this wallet).
  const preview = useMemo(() => {
    const trimmed = encoded.trim();
    if (!trimmed) return null;
    try {
      const note = peekNote(trimmed);
      const known = ALL_POOLS_V3.some((p) => p.poolPDA.toBase58() === note.pool);
      return {
        token: note.token,
        denominationHuman: note.denominationHuman,
        pool: note.pool,
        known,
      };
    } catch {
      return { invalid: true as const };
    }
  }, [encoded, peekNote]);

  const handleCopyAddress = async () => {
    if (!myAddress) return;
    await copyToClipboard(myAddress);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  };

  const canImport = !!preview && !('invalid' in preview) && preview.known && !loading;

  const handleImport = async () => {
    setError(null);
    try {
      await importNoteAction({ encoded: encoded.trim() });
      // Back to Shield: the note is in the list there, with its own next step.
      navigate(-1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pasteInvalid = !!preview && 'invalid' in preview;
  const unknownPool = !!preview && !('invalid' in preview) && !preview.known;

  return (
    <Screen
      title="Receive a note"
      onBack={() => navigate(-1)}
      footer={
        <>
          {error && (
            <p role="alert" className="mb-2 break-words text-tiny text-p01-red">
              {error}
            </p>
          )}
          <Button
            full
            size="lg"
            icon={Download}
            loading={loading}
            disabled={!canImport}
            onClick={() => void handleImport()}
          >
            Add to my notes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* ── Half one: what the sender needs from you ── */}
        <Panel tone="quiet">
          <Eyebrow>Your note address</Eyebrow>
          {myAddress ? (
            <>
              <div className="mt-1.5 flex items-start gap-2">
                <code className="max-h-16 min-w-0 flex-1 overflow-y-auto break-all font-mono text-tiny text-p01-text-muted">
                  {myAddress}
                </code>
                <button
                  onClick={() => void handleCopyAddress()}
                  aria-label="Copy your note address"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-p01-text-muted transition-colors duration-exit hover:text-p01-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
                >
                  {addrCopied ? (
                    <Check className="h-4 w-4 text-p01-cyan" aria-hidden="true" />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
              <p className="mt-1 text-tiny text-p01-text-dim">
                Give this to the sender. It is public key material, safe to share; only your wallet
                can open a note encrypted to it.
              </p>
            </>
          ) : (
            <p role="alert" className="mt-1.5 text-tiny text-p01-red">
              Unlock the wallet to see your note address — it is derived from the local key.
            </p>
          )}
        </Panel>

        {/* ── Half two: what comes back ── */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="received-note" className="text-tiny text-p01-text-muted">
            The note they sent you
          </label>
          <textarea
            id="received-note"
            value={encoded}
            onChange={(e) => {
              setEncoded(e.target.value);
              setError(null);
            }}
            placeholder="p01enc1:…"
            rows={5}
            spellCheck={false}
            aria-invalid={pasteInvalid || undefined}
            aria-describedby={pasteInvalid ? 'received-note-err' : undefined}
            className={cn(
              'w-full resize-none break-all rounded-lg border bg-p01-dark p-3 font-mono text-tiny text-p01-text',
              'outline-none transition-colors duration-exit placeholder:text-p01-text-dim',
              'focus:border-p01-cyan focus-visible:outline-none',
              pasteInvalid ? 'border-p01-red' : 'border-p01-border',
            )}
          />
          {pasteInvalid && (
            <p id="received-note-err" role="alert" className="text-tiny text-p01-red">
              Can&apos;t read this. Either the string is cut short, or it was encrypted to a
              different wallet — only the intended recipient can open one.
            </p>
          )}
        </div>

        {/* ── What you are about to accept ── */}
        {preview && !('invalid' in preview) && (
          <Panel tone={unknownPool ? 'warn' : 'default'}>
            <div className="flex items-center justify-between gap-3">
              <Amount value={preview.denominationHuman} unit={preview.token} size="sm" />
              <span className="min-w-0 truncate font-mono text-tiny text-p01-text-dim">
                pool {preview.pool.slice(0, 12)}…
              </span>
            </div>
            {unknownPool ? (
              <p role="alert" className="mt-2 text-tiny text-p01-amber">
                This note is not from a pool this wallet recognises, so it cannot be imported.
              </p>
            ) : (
              <p className="mt-2 text-tiny text-p01-text-muted">
                Importing is local and publishes nothing. Withdrawing it later republishes this
                note&apos;s commitment, which the sender&apos;s transfer already wrote on-chain — so
                your exit is matchable back to them.
              </p>
            )}
          </Panel>
        )}
      </div>
    </Screen>
  );
}
