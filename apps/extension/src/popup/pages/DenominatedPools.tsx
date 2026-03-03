import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Shield,
  Lock,
  Clock,
  Check,
  Loader2,
  RefreshCw,
  Eye,
  EyeOff,
  Layers,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { useDenominatedPoolStore, type StoredNote } from '@/shared/store/denominatedPool';
import { cn } from '@/shared/utils';

export default function DenominatedPools() {
  const navigate = useNavigate();
  const { publicKey } = useWalletStore();
  const {
    notes,
    isLoading,
    error,
    refreshNotes,
    getActiveNotes,
    getMatureNotes,
    getPendingNotes,
    clearError,
  } = useDenominatedPoolStore();

  const [showBalance, setShowBalance] = useState(true);
  const [filter, setFilter] = useState<'ALL' | 'SOL' | 'USDC'>('ALL');

  useEffect(() => {
    if (publicKey) {
      refreshNotes();
    }
  }, [publicKey]);

  const activeNotes = getActiveNotes();
  const matureNotes = getMatureNotes();
  const pendingNotes = getPendingNotes();
  const spentNotes = notes.filter(n => n.status === 'spent');

  const filteredActive = filter === 'ALL' ? activeNotes : activeNotes.filter(n => n.token === filter);
  const filteredMature = filter === 'ALL' ? matureNotes : matureNotes.filter(n => n.token === filter);
  const filteredPending = filter === 'ALL' ? pendingNotes : pendingNotes.filter(n => n.token === filter);

  const formatDenomination = (note: StoredNote) => {
    if (!showBalance) return '****';
    return `${note.denomination} ${note.token}`;
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-p01-border bg-p01-surface">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/shielded')}
            className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-p01-pink" />
            <h1 className="text-white font-display font-bold tracking-wide">Denominated Pools</h1>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => refreshNotes()}
            disabled={isLoading}
            className="p-2 text-p01-chrome hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn('w-5 h-5', isLoading && 'animate-spin')} />
          </button>
          <button
            onClick={() => setShowBalance(!showBalance)}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
          >
            {showBalance ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-4">
        {/* Error */}
        {error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mx-4 mt-3 p-3 bg-red-500/10 rounded-lg border border-red-500/30"
          >
            <p className="text-red-400 text-xs">{error}</p>
            <button onClick={clearError} className="text-p01-chrome text-xs hover:underline mt-1">
              Dismiss
            </button>
          </motion.div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 px-4 mt-4">
          <button
            onClick={() => navigate('/denominated/shield')}
            className="flex-1 py-3 bg-p01-pink text-white rounded-xl font-medium text-sm hover:bg-p01-pink/90 transition-colors flex items-center justify-center gap-2"
          >
            <ArrowDown className="w-4 h-4" />
            Shield
          </button>
          <button
            onClick={() => navigate('/denominated/unshield')}
            disabled={matureNotes.length === 0}
            className="flex-1 py-3 bg-p01-surface text-white rounded-xl font-medium text-sm hover:bg-p01-dark transition-colors flex items-center justify-center gap-2 border border-p01-border disabled:opacity-50"
          >
            <ArrowUp className="w-4 h-4" />
            Unshield
          </button>
        </div>

        {/* Token filter */}
        <div className="flex gap-2 px-4 mt-4">
          {(['ALL', 'SOL', 'USDC'] as const).map(t => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-mono transition-colors',
                filter === t
                  ? 'bg-p01-pink/20 text-p01-pink border border-p01-pink/30'
                  : 'bg-p01-surface text-p01-chrome hover:text-white border border-p01-border'
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Summary card */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="mx-4 mt-4 bg-gradient-to-br from-p01-pink/10 to-p01-surface rounded-xl p-4 border border-p01-pink/20"
        >
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-2xl font-bold font-display text-p01-pink">{filteredActive.length}</p>
              <p className="text-p01-chrome text-[10px] mt-1">ACTIVE</p>
            </div>
            <div>
              <p className="text-2xl font-bold font-display text-green-400">{filteredMature.length}</p>
              <p className="text-p01-chrome text-[10px] mt-1">MATURE</p>
            </div>
            <div>
              <p className="text-2xl font-bold font-display text-yellow-400">{filteredPending.length}</p>
              <p className="text-p01-chrome text-[10px] mt-1">PENDING</p>
            </div>
          </div>
        </motion.div>

        {/* Mature notes (ready to unshield) */}
        {filteredMature.length > 0 && (
          <div className="px-4 mt-4">
            <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
              MATURE ({filteredMature.length})
            </p>
            <div className="bg-p01-surface rounded-xl overflow-hidden divide-y divide-p01-border/50">
              {filteredMature.map(note => (
                <div
                  key={note.id}
                  className="p-4 flex items-center justify-between cursor-pointer hover:bg-p01-void/50 transition-colors"
                  onClick={() => navigate('/denominated/unshield', { state: { noteId: note.id } })}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                      <Check className="w-5 h-5 text-green-400" />
                    </div>
                    <div>
                      <p className="text-white font-medium text-sm">{formatDenomination(note)}</p>
                      <p className="text-green-400 text-xs">Ready to unshield</p>
                    </div>
                  </div>
                  <ArrowUp className="w-4 h-4 text-p01-chrome" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pending notes */}
        {filteredPending.length > 0 && (
          <div className="px-4 mt-4">
            <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
              PENDING ({filteredPending.length})
            </p>
            <div className="bg-p01-surface rounded-xl overflow-hidden divide-y divide-p01-border/50">
              {filteredPending.map(note => (
                <div key={note.id} className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-yellow-500/20 flex items-center justify-center">
                      <Clock className="w-5 h-5 text-yellow-400" />
                    </div>
                    <div>
                      <p className="text-white font-medium text-sm">{formatDenomination(note)}</p>
                      <p className="text-yellow-400 text-xs">Waiting for maturity</p>
                    </div>
                  </div>
                  <Lock className="w-4 h-4 text-p01-chrome/40" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {activeNotes.length === 0 && (
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="mx-4 mt-6"
          >
            <div className="bg-p01-surface rounded-xl p-6 text-center border border-p01-dark">
              <Layers className="w-12 h-12 text-p01-chrome/30 mx-auto mb-3" />
              <p className="text-white font-medium mb-1">No denominated notes</p>
              <p className="text-p01-chrome text-xs mb-4">
                Shield fixed-denomination notes for maximum privacy
              </p>
              <button
                onClick={() => navigate('/denominated/shield')}
                className="px-4 py-2 bg-p01-pink text-white rounded-lg font-medium text-sm hover:bg-p01-pink/90 transition-colors"
              >
                Shield First Note
              </button>
            </div>
          </motion.div>
        )}

        {/* Info card */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="mx-4 mt-4 mb-4"
        >
          <div className="bg-gradient-to-r from-p01-pink/10 to-p01-surface rounded-xl p-4 border border-p01-pink/20">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-p01-pink/20 flex items-center justify-center flex-shrink-0">
                <Shield className="w-5 h-5 text-p01-pink" />
              </div>
              <div>
                <p className="text-white font-medium text-sm">Fixed-Denomination Privacy</p>
                <p className="text-p01-chrome text-xs mt-1">
                  All notes in a pool have the same value. This breaks the link between deposits and withdrawals, providing maximum anonymity.
                </p>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
