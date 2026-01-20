import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Check, Loader2, ExternalLink, AlertCircle } from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { truncateAddress, cn } from '@/shared/utils';

export default function SendConfirm() {
  const navigate = useNavigate();
  const location = useLocation();
  const { recipient, amount } = location.state || {};

  const { sendTransaction, isLoading, error, network, publicKey } = useWalletStore();

  const [localError, setLocalError] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);
  const [txSignature, setTxSignature] = useState<string | null>(null);

  const handleConfirm = async () => {
    setLocalError('');

    try {
      const signature = await sendTransaction(recipient, amount);
      setTxSignature(signature);
      setIsSuccess(true);
    } catch (err) {
      setLocalError((err as Error).message);
    }
  };

  const getExplorerUrl = (signature: string) => {
    return `https://solscan.io/tx/${signature}?cluster=${network}`;
  };

  if (isSuccess && txSignature) {
    return (
      <div className="flex flex-col h-full bg-p01-void">
        <div className="flex-1 flex flex-col items-center justify-center p-6">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="w-16 h-16 bg-p01-cyan/20 border border-p01-cyan flex items-center justify-center mb-6"
          >
            <Check className="w-8 h-8 text-p01-cyan" />
          </motion.div>

          <h2 className="text-lg font-display font-bold text-white mb-2 tracking-wider">
            TRANSACTION SENT
          </h2>
          <p className="text-[11px] text-p01-chrome/60 text-center font-mono mb-6">
            Your transaction has been submitted to the {network} network.
          </p>

          {/* Transaction details */}
          <div className="w-full bg-p01-surface border border-p01-border p-4 space-y-3 mb-6">
            <div className="flex justify-between">
              <span className="text-[10px] text-[#555560] font-mono">AMOUNT</span>
              <span className="text-xs text-white font-mono">{amount} SOL</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[10px] text-[#555560] font-mono">TO</span>
              <span className="text-xs text-white font-mono">
                {truncateAddress(recipient, 6)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[10px] text-[#555560] font-mono">SIGNATURE</span>
              <span className="text-xs text-p01-cyan font-mono">
                {truncateAddress(txSignature, 6)}
              </span>
            </div>
          </div>

          {/* View on explorer */}
          <a
            href={getExplorerUrl(txSignature)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-p01-cyan text-xs font-mono hover:underline mb-6"
          >
            VIEW ON SOLSCAN
            <ExternalLink className="w-3 h-3" />
          </a>

          <button
            onClick={() => navigate('/')}
            className="w-full py-3 bg-p01-cyan text-p01-void font-display font-bold text-sm tracking-wider hover:bg-p01-cyan-dim transition-colors"
          >
            DONE
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 border-b border-p01-border bg-p01-surface">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 hover:bg-p01-border transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-p01-chrome" />
        </button>
        <h1 className="text-sm font-mono font-bold text-white tracking-wider">CONFIRM SEND</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* Network Badge */}
        {network === 'devnet' && (
          <div className="flex justify-center mb-4">
            <span className="px-2 py-0.5 text-[9px] font-mono font-bold bg-yellow-500/10 text-yellow-500 border border-yellow-500/30 tracking-wider">
              [ DEVNET ]
            </span>
          </div>
        )}

        {/* Amount Display */}
        <div className="text-center py-6 bg-p01-surface border border-p01-border mb-4">
          <p className="text-[10px] text-[#555560] font-mono tracking-wider mb-2">SENDING</p>
          <p className="text-3xl font-mono font-bold text-white">
            {amount} SOL
          </p>
        </div>

        {/* Details */}
        <div className="bg-p01-surface border border-p01-border p-4 space-y-3">
          <div className="flex justify-between">
            <span className="text-[10px] text-[#555560] font-mono tracking-wider">FROM</span>
            <span className="text-xs font-mono text-white">
              {truncateAddress(publicKey || '', 6)}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-[10px] text-[#555560] font-mono tracking-wider">TO</span>
            <span className="text-xs font-mono text-white">
              {truncateAddress(recipient || '', 6)}
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-[10px] text-[#555560] font-mono tracking-wider">NETWORK</span>
            <span className="text-xs text-white font-mono uppercase">
              SOLANA {network}
            </span>
          </div>

          <div className="border-t border-p01-border pt-3">
            <div className="flex justify-between">
              <span className="text-[10px] text-[#555560] font-mono tracking-wider">
                NETWORK FEE
              </span>
              <span className="text-xs text-white font-mono">~0.000005 SOL</span>
            </div>
          </div>

          <div className="border-t border-p01-border pt-3">
            <div className="flex justify-between">
              <span className="text-[10px] text-[#555560] font-mono tracking-wider">
                TOTAL
              </span>
              <span className="text-xs text-p01-cyan font-mono font-bold">
                ~{(amount + 0.000005).toFixed(6)} SOL
              </span>
            </div>
          </div>
        </div>

        {/* Error */}
        {(localError || error) && (
          <div className="mt-4 flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 text-red-400">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span className="text-xs font-mono">{localError || error}</span>
          </div>
        )}
      </div>

      {/* Confirm Button */}
      <div className="p-3 border-t border-p01-border bg-p01-surface">
        <button
          onClick={handleConfirm}
          disabled={isLoading}
          className={cn(
            'w-full py-3 font-display font-bold text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
            isLoading
              ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
              : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
          )}
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              SENDING...
            </>
          ) : (
            'CONFIRM & SEND'
          )}
        </button>
      </div>
    </div>
  );
}
