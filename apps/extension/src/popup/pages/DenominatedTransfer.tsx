/**
 * DenominatedTransfer — note-to-note transfer of a denominated note.
 *
 * Spends a MATURE denominated note (C1 + C3 ownership/membership) and mints a
 * brand-new note for the recipient (C6 insertion), then hands the recipient an
 * encoded "shareable note" string out-of-band. Funds never leave the pool.
 *
 * WHAT IS AND IS NOT HIDDEN — the copy on this screen must respect it:
 *   - No recipient IDENTITY is written on-chain. The transaction names an
 *     ephemeral payer and two commitments; the recipient is never an account
 *     in it, and the handoff blob travels off-chain. That part is real.
 *   - The transaction is NOT unlinkable from the sender. It republishes the
 *     spent note's commitment as `stark_commitment` (ix data byte 80,
 *     transfer_denominated_stark_v3.rs:205-211 binds it into C1), which is the
 *     same value the sender's deposit published. And it publishes the new
 *     commitment (bytes 88-120), which the recipient's eventual withdrawal will
 *     republish in turn. So deposit -> transfer -> withdrawal is a chain any
 *     observer can follow. Only the C7 spend circuit breaks it
 *     (docs/C7_SPEND_CIRCUIT_PLAN.md); it is not built.
 *   - The ephemeral payer is funded by the user's wallet in a plain SystemProgram
 *     transfer immediately beforehand (shared/services/denominatedPool.ts
 *     transferDenominatedStarkV3), so the payer is one public hop from the
 *     wallet. Not signing is real; it is not anonymity.
 *
 * The recipient's note secrets are RANDOM (not seed-derived): if the encoded
 * string is lost, the funds are permanently unrecoverable — surfaced loudly on
 * the success screen.
 *
 * Proof generation (C1 + C3 + C6) takes roughly 90-180s in the browser WASM.
 * Keep the popup open throughout. The note must be matured: the on-chain
 * handler checks `current_epoch >= min_epoch + dynamic_delay`
 * (transfer_denominated_stark_v3.rs:165-173), but this client pins min_epoch to
 * 0 (TRANSFER_MIN_EPOCH) and refuses immature notes in the store pre-flight
 * instead, so the deposit epoch is never published here.
 */

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Zap,
  CheckCircle,
  Loader2,
  Lock,
  Copy,
  Check,
  AlertTriangle,
} from 'lucide-react';
import { cn, copyToClipboard } from '@/shared/utils';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { isNoteEncryptionAddress } from '@/shared/services/noteCrypto';

export default function DenominatedTransfer() {
  const navigate = useNavigate();

  const { getNotes, transferNote, loading } = useDenominatedPoolStore();
  const notes = useMemo(() => getNotes(), [getNotes]);

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(
    notes.length === 1 ? notes[0].commitment.toString() : null,
  );
  const [recipientAddr, setRecipientAddr] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [encodedNote, setEncodedNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const selectedNote = notes.find((n) => n.commitment.toString() === selectedNoteId);
  const recipientValid = useMemo(
    () => isNoteEncryptionAddress(recipientAddr.trim()),
    [recipientAddr],
  );
  const canSubmit = selectedNoteId !== null && recipientValid && !loading && !progress;

  const handleTransfer = async () => {
    if (!selectedNoteId || !selectedNote || !recipientValid) return;
    setError(null);
    setProgress('Starting...');
    try {
      const result = await transferNote({
        noteId: selectedNoteId,
        recipientAddress: recipientAddr.trim(),
        onProgress: (step) => setProgress(step),
      });
      setTxSig(result.txSig);
      setEncodedNote(result.encryptedNote);
      setDone(true);
      setProgress(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    }
  };

  const handleCopy = async () => {
    if (!encodedNote) return;
    await copyToClipboard(encodedNote);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (done) {
    return (
      <div className="flex flex-col h-full bg-p01-void">
        <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
          <button
            onClick={() => navigate(-1)}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1 text-center">
            <h1 className="text-white font-display font-bold tracking-wide text-sm">TRANSFER</h1>
            <p className="text-p01-cyan text-[9px] font-mono tracking-wider">
              SHIELDED DENOMINATED POOL
            </p>
          </div>
          <div className="w-9" />
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-4 pt-4"
          >
            <CheckCircle className="w-14 h-14 text-p01-cyan" />
            <p className="text-white font-display font-bold text-lg tracking-wide">
              Note Transferred!
            </p>
            <p className="text-p01-chrome text-xs text-center">
              {selectedNote?.denominationHuman} {selectedNote?.token} moved to a new note.
              Send the encrypted blob below to the recipient — it is the only way they can
              claim it.
            </p>

            {/* Encryption + irrecoverable note */}
            <div className="w-full flex items-start gap-2 p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/40">
              <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
              <p className="text-yellow-300 text-[10px] leading-relaxed">
                <span className="font-bold">Encrypted to the recipient</span> (post-quantum) — only
                their wallet can open it, so it is safe to share over any channel. But if neither of
                you keeps this blob, the {selectedNote?.denominationHuman} {selectedNote?.token} is
                lost forever.
              </p>
            </div>

            {/* Encrypted note blob */}
            {encodedNote && (
              <div className="w-full">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-p01-chrome text-[10px] font-mono tracking-wider">
                    ENCRYPTED NOTE (give to recipient)
                  </span>
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1 text-p01-cyan text-[10px] hover:text-p01-cyan/80 transition-colors"
                    aria-label={copied ? 'Note copied' : 'Copy encoded note'}
                  >
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="p-3 rounded-xl bg-p01-surface border border-p01-border max-h-32 overflow-y-auto">
                  <p className="text-p01-chrome text-[9px] font-mono break-all leading-relaxed">
                    {encodedNote}
                  </p>
                </div>
              </div>
            )}

            {txSig && (
              <p className="text-p01-chrome/50 text-[9px] font-mono break-all text-center">
                tx: {txSig}
              </p>
            )}
            <button
              onClick={() => navigate(-1)}
              className="mt-2 px-6 py-2 rounded-xl bg-p01-cyan text-p01-void font-bold font-display text-sm tracking-wider"
            >
              Done
            </button>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
        <button
          onClick={() => navigate(-1)}
          className="p-2 text-p01-chrome hover:text-white transition-colors"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 text-center">
          <h1 className="text-white font-display font-bold tracking-wide text-sm">TRANSFER</h1>
          <p className="text-p01-cyan text-[9px] font-mono tracking-wider">
            SHIELDED DENOMINATED POOL
          </p>
        </div>
        <div className="w-9" />
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Note picker */}
        <div>
          <p className="text-p01-chrome text-[10px] font-mono mb-2">SELECT NOTE TO TRANSFER</p>
          {notes.length === 0 ? (
            <div className="p-4 rounded-xl bg-p01-surface border border-p01-border text-center">
              <Lock className="w-8 h-8 text-p01-chrome/30 mx-auto mb-2" />
              <p className="text-p01-chrome text-sm">No shielded notes found</p>
              <p className="text-p01-chrome/60 text-xs mt-1">
                Shield some SOL first to create a shielded note.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {notes.map((note) => {
                const id = note.commitment.toString();
                const selected = id === selectedNoteId;
                return (
                  <button
                    key={id}
                    onClick={() => setSelectedNoteId(id)}
                    className={cn(
                      'w-full p-3 rounded-xl border text-left transition-all',
                      selected
                        ? 'bg-p01-cyan/15 border-p01-cyan'
                        : 'bg-p01-surface border-p01-border hover:border-p01-cyan/40',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Lock className={cn('w-4 h-4', selected ? 'text-p01-cyan' : 'text-p01-chrome/60')} />
                        <span className={cn('text-sm font-mono font-bold', selected ? 'text-p01-cyan' : 'text-white')}>
                          {note.denominationHuman} {note.token}
                        </span>
                        {note.source === 'received' && (
                          <span className="text-[8px] font-mono text-p01-cyan/70 border border-p01-cyan/30 rounded px-1 py-0.5">
                            RECEIVED
                          </span>
                        )}
                      </div>
                      <span className="text-p01-chrome/50 text-[10px] font-mono">
                        leaf #{note.leafIndex}
                      </span>
                    </div>
                    <p className="text-p01-chrome/40 text-[9px] font-mono mt-1 truncate">
                      {id.slice(0, 20)}…
                    </p>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Recipient address */}
        <div>
          <p className="text-p01-chrome text-[10px] font-mono mb-2">RECIPIENT ADDRESS (p01pq:…)</p>
          <textarea
            value={recipientAddr}
            onChange={(e) => {
              setRecipientAddr(e.target.value);
              setError(null);
            }}
            placeholder="Paste the recipient's p01pq:… note address"
            rows={3}
            aria-label="Recipient note address"
            className={cn(
              'w-full rounded-xl p-3 text-[10px] font-mono text-white outline-none resize-none break-all bg-p01-surface border transition-colors placeholder:text-p01-chrome/30',
              recipientAddr.trim() && !recipientValid
                ? 'border-p01-red/60'
                : 'border-p01-border focus:border-p01-cyan/40',
            )}
          />
          {recipientAddr.trim() && !recipientValid && (
            <p className="text-p01-red text-[9px] font-mono mt-1">
              Invalid address — expected a p01pq:… post-quantum note address.
            </p>
          )}
          {recipientValid && (
            <p className="text-p01-cyan text-[9px] font-mono mt-1">✓ Valid recipient address</p>
          )}
        </div>

        {/* Info card */}
        <div className="p-3 rounded-xl bg-p01-cyan/10 border border-p01-cyan/30">
          <div className="flex items-start gap-2">
            <Zap className="w-4 h-4 text-p01-cyan shrink-0 mt-0.5" />
            <div>
              <p className="text-[10px] font-mono font-bold text-p01-cyan tracking-wider mb-1">
                [ NOTE-TO-NOTE TRANSFER ]
              </p>
              <p className="text-p01-chrome text-[10px] leading-relaxed">
                Generates C1 + C3 + C6 STARK proofs (~90-180s). The note must be matured. The
                output note is encrypted to the recipient (post-quantum X25519 + ML-KEM-768), so
                the blob is safe to share. Proof rent is recovered after the tx confirms.
              </p>
              <p className="text-p01-chrome/70 text-[9px] leading-relaxed mt-2">
                The recipient is never named on-chain: the transaction carries an ephemeral
                payer and two commitments, and the blob is handed over off-chain. But the
                commitment of the note you are spending goes on-chain here — the same value
                your deposit published — so this transfer is still matchable to your deposit,
                and the recipient&apos;s later withdrawal is matchable back to this transfer.
                The ephemeral payer is funded by your wallet moments earlier, in the clear.
              </p>
            </div>
          </div>
        </div>

        {/* Progress / error */}
        {progress && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-p01-surface border border-p01-border" aria-live="polite">
            <Loader2 className="w-4 h-4 text-p01-cyan animate-spin shrink-0" aria-hidden="true" />
            <p className="text-p01-chrome text-[10px] font-mono">{progress}</p>
          </div>
        )}

        {error && (
          <div
            className="p-3 rounded-lg bg-p01-red/10 border border-p01-red/30"
            role="alert"
            aria-live="assertive"
          >
            <p className="text-p01-red text-[10px] font-mono break-all">{error}</p>
          </div>
        )}

        {/* Action button */}
        <button
          onClick={handleTransfer}
          disabled={!canSubmit || notes.length === 0}
          className={cn(
            'w-full py-3 rounded-xl font-bold font-display text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
            !canSubmit || notes.length === 0
              ? 'bg-p01-surface border border-p01-border text-p01-chrome/50 cursor-not-allowed'
              : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90',
          )}
        >
          {loading || !!progress ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Proving & Transferring...
            </>
          ) : (
            <>
              <Zap className="w-4 h-4" />
              Transfer Note
            </>
          )}
        </button>

        <p className="text-p01-chrome/40 text-[9px] font-mono text-center">
          C1 + C3 + C6 proofs + on-chain transfer takes ~2-3 min. Do not close the popup.
        </p>
      </div>
    </div>
  );
}
