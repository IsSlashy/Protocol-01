import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Loader2,
  AlertTriangle,
  Lock,
  Clock,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { useDenominatedPoolStore, type StoredNote } from '@/shared/store/denominatedPool';
import { cn, truncateAddress } from '@/shared/utils';

export default function DenominatedUnshield() {
  const navigate = useNavigate();
  const location = useLocation();
  const { publicKey } = useWalletStore();
  const {
    getMatureNotes,
    unshieldNote,
    isProving,
    error,
    progress,
    clearError,
  } = useDenominatedPoolStore();

  const [selectedNote, setSelectedNote] = useState<string | null>(null);
  const [recipient, setRecipient] = useState(publicKey || '');
  const [isProcessing, setIsProcessing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const matureNotes = getMatureNotes();

  // Pre-select note if navigated with state
  useEffect(() => {
    const state = location.state as { noteId?: string } | null;
    if (state?.noteId) {
      setSelectedNote(state.noteId);
    }
  }, [location.state]);

  // Default recipient to own wallet
  useEffect(() => {
    if (publicKey && !recipient) {
      setRecipient(publicKey);
    }
  }, [publicKey]);

  const handleUnshield = async () => {
    if (!selectedNote) return;

    setIsProcessing(true);
    setLocalError(null);
    clearError();

    try {
      const sig = await unshieldNote(selectedNote, recipient);
      setSuccess(true);
      setTimeout(() => navigate('/denominated'), 2000);
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const formatDenomination = (note: StoredNote) => {
    return `${note.denomination} ${note.token}`;
  };

  if (success) {
    return (
      <div className="flex flex-col h-full bg-p01-void items-center justify-center">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-center"
        >
          <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
            <Check className="w-8 h-8 text-green-400" />
          </div>
          <p className="text-white font-display font-bold text-lg">Unshielded!</p>
          <p className="text-p01-chrome text-sm mt-2">Returning to pool view...</p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-p01-border bg-p01-surface">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/denominated')}
            className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <ArrowUp className="w-5 h-5 text-p01-pink" />
            <h1 className="text-white font-display font-bold tracking-wide">Unshield Note</h1>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-4">
        {/* Select note */}
        <div className="px-4 mt-4">
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            SELECT MATURE NOTE ({matureNotes.length})
          </p>

          {matureNotes.length === 0 ? (
            <div className="bg-p01-surface rounded-xl p-6 text-center border border-p01-dark">
              <Clock className="w-10 h-10 text-p01-chrome/30 mx-auto mb-2" />
              <p className="text-p01-chrome text-sm">No mature notes available</p>
              <p className="text-p01-chrome/60 text-xs mt-1">
                Notes need ~2 epochs after deposit to mature
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {matureNotes.map(note => (
                <button
                  key={note.id}
                  onClick={() => setSelectedNote(note.id)}
                  aria-pressed={selectedNote === note.id}
                  aria-label={`Select note ${formatDenomination(note)}`}
                  className={cn(
                    'w-full p-4 rounded-xl border transition-all flex items-center justify-between',
                    selectedNote === note.id
                      ? 'bg-p01-pink/10 border-p01-pink/40'
                      : 'bg-p01-surface border-p01-border hover:border-p01-pink/20'
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'w-10 h-10 rounded-full flex items-center justify-center',
                      selectedNote === note.id ? 'bg-p01-pink/20' : 'bg-green-500/20'
                    )}>
                      {selectedNote === note.id ? (
                        <Check className="w-5 h-5 text-p01-pink" />
                      ) : (
                        <Lock className="w-5 h-5 text-green-400" />
                      )}
                    </div>
                    <div className="text-left">
                      <p className="text-white font-medium text-sm">{formatDenomination(note)}</p>
                      <p className="text-p01-chrome text-xs font-mono">
                        {note.id.slice(0, 8)}...
                      </p>
                    </div>
                  </div>
                  <span className="text-green-400 text-xs">Mature</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Recipient */}
        <div className="px-4 mt-4">
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            RECIPIENT
          </p>
          <div className="bg-p01-surface rounded-xl p-3 border border-p01-border">
            <div className="flex items-center justify-between mb-1">
              <span className="text-p01-chrome text-xs">Withdraw to</span>
              {publicKey && recipient !== publicKey && (
                <button
                  onClick={() => setRecipient(publicKey)}
                  className="text-p01-pink text-xs hover:underline"
                >
                  Use my wallet
                </button>
              )}
            </div>
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Solana address..."
              aria-label="Recipient address"
              className="w-full bg-transparent text-white text-sm font-mono outline-none"
            />
          </div>
        </div>

        {/* Warning */}
        <div className="px-4 mt-4">
          <div className="p-3 bg-p01-pink/10 rounded-lg border border-p01-pink/20 flex items-start gap-2" role="note">
            <AlertTriangle className="w-4 h-4 text-p01-pink flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-p01-chrome text-xs">
              Unshielding generates a ZK proof that may take a few seconds. The withdrawal amount is visible but the deposit source remains hidden.
            </p>
          </div>
        </div>

        {/* Error */}
        {(localError || error) && (
          <div className="px-4 mt-3">
            <div className="p-3 bg-red-500/10 rounded-lg border border-red-500/30" role="alert" aria-live="polite">
              <p className="text-red-400 text-sm">{localError || error}</p>
            </div>
          </div>
        )}

        {/* Progress */}
        {progress && (
          <div className="px-4 mt-3">
            <div className="p-3 bg-p01-cyan/10 rounded-lg border border-p01-cyan/20 flex items-center gap-2" role="status" aria-live="polite">
              <Loader2 className="w-4 h-4 text-p01-cyan animate-spin" aria-hidden="true" />
              <p className="text-p01-cyan text-sm">{progress}</p>
            </div>
          </div>
        )}

        {/* Unshield button */}
        <div className="px-4 mt-6">
          <button
            onClick={handleUnshield}
            disabled={!selectedNote || !recipient || isProcessing || isProving}
            className="w-full py-3.5 bg-p01-pink text-white font-medium rounded-xl hover:bg-p01-pink/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isProcessing || isProving ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                {progress || 'Processing...'}
              </>
            ) : (
              <>
                <ArrowUp className="w-5 h-5" />
                Unshield
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
