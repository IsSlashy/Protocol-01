import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowDown,
  Loader2,
  AlertTriangle,
  Layers,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { cn } from '@/shared/utils';

const SOL_DENOMINATIONS = [0.1, 1, 10, 100];
const USDC_DENOMINATIONS = [1, 10, 100, 1000];

export default function DenominatedShield() {
  const navigate = useNavigate();
  const { solBalance } = useWalletStore();
  const { shieldNote, isLoading, error, progress, clearError } = useDenominatedPoolStore();

  const [token, setToken] = useState<'SOL' | 'USDC'>('SOL');
  const [selectedDenomination, setSelectedDenomination] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const denominations = token === 'SOL' ? SOL_DENOMINATIONS : USDC_DENOMINATIONS;

  const handleShield = async () => {
    if (!selectedDenomination) return;

    if (token === 'SOL' && selectedDenomination > solBalance) {
      setLocalError(`Insufficient SOL. Need ${selectedDenomination} but have ${solBalance.toFixed(4)}`);
      return;
    }

    setIsProcessing(true);
    setLocalError(null);
    clearError();

    try {
      await shieldNote(token, selectedDenomination);
      navigate('/denominated');
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

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
            <ArrowDown className="w-5 h-5 text-p01-pink" />
            <h1 className="text-white font-display font-bold tracking-wide">Shield Note</h1>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-4">
        {/* Token toggle */}
        <div className="px-4 mt-4">
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">TOKEN</p>
          <div className="flex gap-2">
            {(['SOL', 'USDC'] as const).map(t => (
              <button
                key={t}
                onClick={() => {
                  setToken(t);
                  setSelectedDenomination(null);
                }}
                aria-pressed={token === t}
                className={cn(
                  'flex-1 py-3 rounded-xl font-medium text-sm transition-colors border',
                  token === t
                    ? 'bg-p01-pink/20 text-p01-pink border-p01-pink/30'
                    : 'bg-p01-surface text-p01-chrome border-p01-border hover:text-white'
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Wallet balance */}
        <div className="px-4 mt-4">
          <div className="bg-p01-surface rounded-xl p-3 flex items-center justify-between border border-p01-border">
            <span className="text-p01-chrome text-xs">Wallet Balance</span>
            <span className="text-white text-sm font-mono">
              {token === 'SOL' ? `${solBalance.toFixed(4)} SOL` : '— USDC'}
            </span>
          </div>
        </div>

        {/* Denomination grid */}
        <div className="px-4 mt-4">
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            SELECT DENOMINATION
          </p>
          <div className="grid grid-cols-2 gap-3">
            {denominations.map(d => {
              const isSelected = selectedDenomination === d;
              const tooExpensive = token === 'SOL' && d > solBalance;

              return (
                <button
                  key={d}
                  onClick={() => !tooExpensive && setSelectedDenomination(d)}
                  disabled={tooExpensive}
                  aria-pressed={isSelected}
                  aria-label={`${d} ${token}`}
                  className={cn(
                    'py-4 rounded-xl font-display font-bold text-lg transition-all border',
                    isSelected
                      ? 'bg-p01-pink/20 text-p01-pink border-p01-pink/40 scale-[1.02]'
                      : tooExpensive
                      ? 'bg-p01-surface/50 text-p01-chrome/30 border-p01-border/50 cursor-not-allowed'
                      : 'bg-p01-surface text-white border-p01-border hover:border-p01-pink/30'
                  )}
                >
                  <div>{d}</div>
                  <div className="text-xs font-normal font-mono text-p01-chrome mt-1">{token}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Warning */}
        <div className="px-4 mt-4">
          <div className="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20 flex items-start gap-2" role="note">
            <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-yellow-200 text-xs">
              Notes require a maturity period (~2 epochs) before they can be unshielded. This prevents timing attacks.
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

        {/* Shield button */}
        <div className="px-4 mt-6">
          <button
            onClick={handleShield}
            disabled={!selectedDenomination || isProcessing || isLoading}
            className="w-full py-3.5 bg-p01-pink text-white font-medium rounded-xl hover:bg-p01-pink/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isProcessing || isLoading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Shielding...
              </>
            ) : (
              <>
                <Layers className="w-5 h-5" />
                Shield {selectedDenomination ? `${selectedDenomination} ${token}` : ''}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
