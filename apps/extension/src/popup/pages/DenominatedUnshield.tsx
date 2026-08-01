/**
 * DenominatedUnshield — withdraw a shielded denominated note to a recipient.
 *
 * Picks a note from the denominated pool store, lets the user enter a
 * recipient address (defaults to own wallet), offers a regular / emergency
 * toggle, then orchestrates C1 + C3 STARK proofs + the on-chain
 * unshield_denominated_stark_v3 instruction.
 *
 * Proof generation (C1 + C3) takes roughly 60-120s in the browser WASM.
 * Keep the popup open throughout.
 *
 * Regular vs. emergency:
 *   Both paths now produce a BYTE-IDENTICAL instruction. `min_epoch` is always
 *   0 (see UNSHIELD_MIN_EPOCH in shared/services/denominatedPool.ts) and the
 *   V3 handler ignores the argument anyway
 *   (unshield_denominated_stark_v3.rs:387). The toggle is UX only: it decides
 *   whether the maturity warning blocks the button, not what goes on-chain.
 *   Previously "regular" published the note's deposit epoch in the clear,
 *   which narrowed the anonymity set to the deposits made in that epoch.
 */

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowUp,
  AlertTriangle,
  CheckCircle,
  Loader2,
  Lock,
  Zap,
  Info,
} from 'lucide-react';
import { PublicKey } from '@solana/web3.js';
import { cn } from '@/shared/utils';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { useWalletStore } from '@/shared/store/wallet';

type Mode = 'regular' | 'emergency';

export default function DenominatedUnshield() {
  const navigate = useNavigate();
  const { publicKey } = useWalletStore();

  const { getNotes, unshieldNote, loading } = useDenominatedPoolStore();
  const notes = useMemo(() => getNotes(), [getNotes]);

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(
    notes.length === 1 ? notes[0].commitment.toString() : null,
  );
  const [recipientInput, setRecipientInput] = useState('');
  const [mode, setMode] = useState<Mode>('regular');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [showModeInfo, setShowModeInfo] = useState(false);

  const selectedNote = notes.find((n) => n.commitment.toString() === selectedNoteId);

  // Validate recipient — empty = own wallet (shown as hint).
  const recipientValid = useMemo(() => {
    if (!recipientInput.trim()) return true; // default = own wallet
    try {
      new PublicKey(recipientInput.trim());
      return true;
    } catch {
      return false;
    }
  }, [recipientInput]);

  const canSubmit =
    selectedNoteId !== null &&
    recipientValid &&
    !loading &&
    !progress;

  const handleUnshield = async () => {
    if (!selectedNoteId || !selectedNote) return;
    setError(null);
    setProgress('Starting...');
    try {
      const result = await unshieldNote({
        noteId: selectedNoteId,
        recipient: recipientInput.trim() || undefined, // undefined = own wallet
        emergency: mode === 'emergency',
        onProgress: (step) => setProgress(step),
      });
      setTxSig(result.txSig);
      setDone(true);
      setProgress(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    }
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
            <h1 className="text-white font-display font-bold tracking-wide text-sm">UNSHIELD</h1>
            <p className="text-p01-cyan text-[9px] font-mono tracking-wider">
              PRIVATE DENOMINATED POOL
            </p>
          </div>
          <div className="w-9" />
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-4 pt-8"
          >
            <CheckCircle className="w-16 h-16 text-p01-cyan" />
            <p className="text-white font-display font-bold text-lg tracking-wide">
              Withdrawn!
            </p>
            <p className="text-p01-chrome text-xs text-center">
              {selectedNote?.denominationHuman} {selectedNote?.token} unshielded.
              Funds sent to{' '}
              {recipientInput.trim()
                ? `${recipientInput.slice(0, 8)}…${recipientInput.slice(-6)}`
                : 'your wallet'}.
            </p>
            {txSig && (
              <p className="text-p01-chrome/50 text-[9px] font-mono break-all text-center">
                tx: {txSig}
              </p>
            )}
            <button
              onClick={() => navigate(-1)}
              className="mt-4 px-6 py-2 rounded-xl bg-p01-cyan text-p01-void font-bold font-display text-sm tracking-wider"
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
          <h1 className="text-white font-display font-bold tracking-wide text-sm">UNSHIELD</h1>
          <p className="text-p01-cyan text-[9px] font-mono tracking-wider">
            PRIVATE DENOMINATED POOL
          </p>
        </div>
        <div className="w-9" />
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Note picker */}
        <div>
          <p className="text-p01-chrome text-[10px] font-mono mb-2">SELECT NOTE</p>
          {notes.length === 0 ? (
            <div className="p-4 rounded-xl bg-p01-surface border border-p01-border text-center">
              <Lock className="w-8 h-8 text-p01-chrome/30 mx-auto mb-2" />
              <p className="text-p01-chrome text-sm">No shielded notes found</p>
              <p className="text-p01-chrome/60 text-xs mt-1">
                Shield some SOL first to create a private note.
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

        {/* Recipient input */}
        <div>
          <p className="text-p01-chrome text-[10px] font-mono mb-2">RECIPIENT ADDRESS</p>
          <div className={cn(
            'rounded-xl border p-3 transition-colors',
            !recipientValid && recipientInput
              ? 'border-p01-red/60 bg-p01-red/5'
              : 'border-p01-border bg-p01-surface focus-within:border-p01-cyan/40',
          )}>
            <input
              type="text"
              value={recipientInput}
              onChange={(e) => setRecipientInput(e.target.value)}
              placeholder={publicKey ? `${publicKey.slice(0, 8)}… (your wallet)` : 'Enter Solana address'}
              aria-label="Recipient Solana address"
              className="w-full bg-transparent text-white text-xs font-mono outline-none placeholder:text-p01-chrome/30"
            />
          </div>
          {!recipientValid && recipientInput && (
            <p className="text-p01-red text-[9px] font-mono mt-1">Invalid Solana address</p>
          )}
          {!recipientInput && (
            <p className="text-p01-chrome/50 text-[9px] mt-1">
              Leave blank to withdraw to your own wallet.
            </p>
          )}
        </div>

        {/* Regular / Emergency toggle */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <p className="text-p01-chrome text-[10px] font-mono">WITHDRAWAL MODE</p>
            <button
              onClick={() => setShowModeInfo(!showModeInfo)}
              className="text-p01-chrome/40 hover:text-p01-chrome transition-colors"
              aria-label="Toggle mode info"
            >
              <Info className="w-3 h-3" />
            </button>
          </div>

          {showModeInfo && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-3 p-3 rounded-xl bg-p01-gradient-card border border-p01-cyan/15 space-y-2"
            >
              <div className="flex items-start gap-2">
                <Lock className="w-3 h-3 text-p01-cyan shrink-0 mt-0.5" />
                <div>
                  <p className="text-white text-[10px] font-medium">Regular</p>
                  <p className="text-p01-chrome/70 text-[9px]">
                    Standard withdrawal. Your deposit epoch is never published — min_epoch is
                    always 0, so the transaction reveals nothing about when the note was created.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Zap className="w-3 h-3 text-yellow-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-yellow-300 text-[10px] font-medium">Emergency</p>
                  <p className="text-p01-chrome/70 text-[9px]">
                    Label only — it produces a byte-identical transaction, so nothing on-chain
                    signals urgency. Neither mode is blocked by note age. Withdrawing a fresh note
                    still shrinks your anonymity set by timing alone.
                  </p>
                </div>
              </div>
            </motion.div>
          )}

          <div className="flex gap-2">
            {(['regular', 'emergency'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  'flex-1 py-2 rounded-xl border text-sm font-display font-bold tracking-wide transition-all flex items-center justify-center gap-2',
                  mode === m
                    ? m === 'emergency'
                      ? 'bg-yellow-500/15 border-yellow-500 text-yellow-300'
                      : 'bg-p01-cyan/15 border-p01-cyan text-p01-cyan'
                    : 'bg-p01-surface border-p01-border text-p01-chrome hover:border-p01-cyan/40',
                )}
              >
                {m === 'emergency' ? <Zap className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>

          {mode === 'emergency' && (
            <div className="mt-2 flex items-start gap-2 p-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
              <AlertTriangle className="w-3 h-3 text-yellow-400 shrink-0 mt-0.5" />
              <p className="text-yellow-300 text-[9px]">
                Emergency mode is a label, not a different transaction. Withdrawing a note soon
                after depositing it links the two by timing regardless of the mode you pick.
              </p>
            </div>
          )}
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

        {/* Summary card */}
        {selectedNote && (
          <div className="p-3 rounded-xl bg-p01-gradient-card border border-p01-cyan/15">
            <div className="flex items-start gap-2">
              <ArrowUp className="w-4 h-4 text-p01-pink shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-white text-xs font-medium">
                  Unshield {selectedNote.denominationHuman} {selectedNote.token}
                </p>
                <p className="text-p01-chrome text-[10px]">
                  Generates C1 + C3 STARK proofs (~60-120s). Keep the popup open.
                  Proof rent (~2 SOL) is recovered after the transaction confirms.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Action button */}
        <button
          onClick={handleUnshield}
          disabled={!canSubmit || notes.length === 0}
          className={cn(
            'w-full py-3 rounded-xl font-bold font-display text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
            !canSubmit || notes.length === 0
              ? 'bg-p01-surface border border-p01-border text-p01-chrome/50 cursor-not-allowed'
              : mode === 'emergency'
                ? 'bg-yellow-500 text-p01-void hover:bg-yellow-400'
                : 'bg-p01-pink text-white hover:bg-p01-pink/90',
          )}
        >
          {loading || !!progress ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Proving & Withdrawing...
            </>
          ) : (
            <>
              {mode === 'emergency' ? <Zap className="w-4 h-4" /> : <ArrowUp className="w-4 h-4" />}
              {mode === 'emergency' ? 'Emergency Withdraw' : 'Withdraw (Unshield)'}
            </>
          )}
        </button>

        <p className="text-p01-chrome/40 text-[9px] font-mono text-center">
          C1 + C3 proofs + on-chain unshield takes ~2-3 min. Do not close the popup.
        </p>
      </div>
    </div>
  );
}
