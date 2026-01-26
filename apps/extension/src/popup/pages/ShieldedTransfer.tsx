import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Zap,
  Shield,
  AlertTriangle,
  Loader2,
  Copy,
  Check,
  Download,
  Share2,
} from 'lucide-react';
import { useShieldedStore } from '@/shared/store/shielded';
import { cn, copyToClipboard } from '@/shared/utils';
import { encodeP01Note, type RecipientNoteData } from '@/shared/services/zk';

export default function ShieldedTransfer() {
  const navigate = useNavigate();
  const {
    isInitialized,
    shieldedBalance,
    zkAddress,
    transfer,
    initialize,
  } = useShieldedStore();

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [recipientNoteData, setRecipientNoteData] = useState<RecipientNoteData | null>(null);
  const [noteCopied, setNoteCopied] = useState(false);

  // Initialize if needed
  useEffect(() => {
    if (!isInitialized) {
      initialize().catch(err => {
        console.error('[ShieldedTransfer] Init error:', err);
        setError('Failed to initialize ZK service');
      });
    }
  }, [isInitialized, initialize]);

  // Validate ZK address format
  const isValidZkAddress = (addr: string): boolean => {
    if (!addr.startsWith('zk:')) return false;
    try {
      const combined = Uint8Array.from(atob(addr.slice(3)), c => c.charCodeAt(0));
      return combined.length === 64; // 32 bytes receiving pubkey + 32 bytes viewing key
    } catch {
      return false;
    }
  };

  const handleCopyOwnAddress = async () => {
    if (zkAddress) {
      await copyToClipboard(zkAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleTransfer = async () => {
    setError(null);
    setSuccess(null);

    if (!recipient) {
      setError('Please enter a recipient ZK address');
      return;
    }

    if (!isValidZkAddress(recipient)) {
      setError('Invalid ZK address format. Must start with "zk:" followed by base64 data');
      return;
    }

    if (recipient === zkAddress) {
      setError('Cannot transfer to yourself');
      return;
    }

    const amountNum = parseFloat(amount);
    if (!amount || amountNum <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    if (amountNum > shieldedBalance) {
      setError('Insufficient shielded balance');
      return;
    }

    setIsProcessing(true);

    try {
      const result = await transfer(recipient, amountNum);
      setSuccess(`Transfer successful!`);
      setRecipientNoteData(result.recipientNote);
      // Don't clear recipient/amount so user can see what they sent
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCopyNote = async () => {
    if (!recipientNoteData) return;

    // Use p01note format for mobile compatibility
    const p01note = encodeP01Note(recipientNoteData);
    await copyToClipboard(p01note);
    setNoteCopied(true);
    setTimeout(() => setNoteCopied(false), 2000);
  };

  const handleDownloadNote = () => {
    if (!recipientNoteData) return;

    // Use p01note format for mobile compatibility
    const p01note = encodeP01Note(recipientNoteData);
    const blob = new Blob([p01note], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `p01-note-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const percentButtons = [25, 50, 75, 100];

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-p01-border bg-p01-surface">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-p01-cyan" />
            <h1 className="text-white font-display font-bold tracking-wide">Private Transfer</h1>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Shielded Balance */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="bg-gradient-to-br from-p01-surface to-p01-dark rounded-xl p-4 border border-p01-cyan/20"
        >
          <div className="flex items-center gap-2 mb-2">
            <Shield className="w-4 h-4 text-p01-cyan" />
            <span className="text-p01-chrome text-xs">Available Shielded Balance</span>
          </div>
          <p className="text-2xl font-display font-bold text-white">
            {shieldedBalance.toFixed(4)} SOL
          </p>
        </motion.div>

        {/* Your ZK Address (for sharing) */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.05 }}
          className="bg-p01-surface rounded-xl p-4 border border-p01-border"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-p01-chrome text-xs">Your ZK Address (to receive)</span>
            <button
              onClick={handleCopyOwnAddress}
              className="flex items-center gap-1 text-p01-cyan text-xs hover:text-p01-cyan/80 transition-colors"
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-white text-xs font-mono truncate">
            {zkAddress || 'Loading...'}
          </p>
        </motion.div>

        {/* Recipient Input */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.1 }}
        >
          <label className="text-[10px] text-p01-chrome/60 mb-1.5 block font-mono tracking-wider">
            RECIPIENT ZK ADDRESS
          </label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value);
              setError(null);
              setSuccess(null);
            }}
            placeholder="zk:..."
            className={cn(
              'w-full bg-p01-surface border px-3 py-3 text-xs font-mono text-white placeholder-p01-chrome/40 focus:outline-none transition-colors rounded-lg',
              recipient && isValidZkAddress(recipient)
                ? 'border-p01-cyan focus:border-p01-cyan'
                : 'border-p01-border focus:border-p01-cyan'
            )}
          />
          {recipient && !isValidZkAddress(recipient) && recipient.length > 5 && (
            <p className="text-yellow-400 text-xs mt-1.5">
              ZK address must start with "zk:" followed by 64 bytes of base64 data
            </p>
          )}
          {recipient && isValidZkAddress(recipient) && (
            <p className="text-p01-cyan text-xs mt-1.5 flex items-center gap-1">
              <Check className="w-3 h-3" /> Valid ZK address
            </p>
          )}
        </motion.div>

        {/* Amount Input */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.15 }}
        >
          <label className="text-[10px] text-p01-chrome/60 mb-1.5 block font-mono tracking-wider">
            AMOUNT (SOL)
          </label>
          <div className="bg-p01-surface border border-p01-border p-4 rounded-lg">
            <input
              type="number"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError(null);
                setSuccess(null);
              }}
              placeholder="0.0"
              step="0.0001"
              min="0"
              max={shieldedBalance}
              className="w-full bg-transparent text-2xl font-mono font-bold text-white placeholder-p01-chrome/40 focus:outline-none"
            />
            <div className="flex gap-2 mt-3">
              {percentButtons.map((percent) => (
                <button
                  key={percent}
                  onClick={() => {
                    const maxAmount = shieldedBalance;
                    setAmount(((maxAmount * percent) / 100).toFixed(4));
                    setError(null);
                    setSuccess(null);
                  }}
                  className="flex-1 py-1.5 text-[10px] font-mono font-medium bg-p01-dark border border-p01-border text-p01-chrome hover:border-p01-cyan/50 hover:text-white transition-colors tracking-wider rounded"
                >
                  {percent}%
                </button>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Info Card */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="bg-p01-cyan/10 border border-p01-cyan/30 p-3 rounded-lg"
        >
          <div className="flex items-start gap-2">
            <Shield className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[10px] font-mono font-bold text-p01-cyan tracking-wider mb-1">
                [ FULLY PRIVATE TRANSFER ]
              </p>
              <p className="text-[10px] text-p01-chrome font-mono leading-relaxed">
                This transfer uses zero-knowledge proofs. The amount, sender, and recipient
                are completely hidden on-chain. Only you and the recipient know the details.
              </p>
            </div>
          </div>
        </motion.div>

        {/* Error */}
        {error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="p-3 bg-red-500/10 rounded-lg border border-red-500/30"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-red-400 text-xs">{error}</p>
            </div>
          </motion.div>
        )}

        {/* Success */}
        {success && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="p-3 bg-green-500/10 rounded-lg border border-green-500/30"
          >
            <div className="flex items-start gap-2">
              <Check className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
              <p className="text-green-400 text-xs">{success}</p>
            </div>
          </motion.div>
        )}

        {/* Recipient Note Data - IMPORTANT for recipient to receive funds */}
        {recipientNoteData && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-p01-cyan/10 border border-p01-cyan rounded-xl p-4"
          >
            <div className="flex items-center gap-2 mb-3">
              <Share2 className="w-5 h-5 text-p01-cyan" />
              <h3 className="text-white font-display font-bold text-sm">Share with Recipient</h3>
            </div>

            <p className="text-p01-chrome text-xs mb-3">
              The recipient MUST import this note data to access their funds. Send them this file or copy the data.
            </p>

            <div className="bg-p01-void rounded-lg p-3 mb-3">
              <p className="text-p01-chrome text-[10px] font-mono mb-1">Amount: {(Number(recipientNoteData.amount) / 1e9).toFixed(4)} SOL</p>
              <p className="text-p01-chrome text-[10px] font-mono mb-1">Leaf Index: {recipientNoteData.leafIndex}</p>
              <p className="text-white text-[10px] font-mono mt-2 break-all select-all">
                {encodeP01Note(recipientNoteData).slice(0, 60)}...
              </p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleCopyNote}
                className="flex-1 py-2 bg-p01-surface border border-p01-border rounded-lg text-white text-xs font-medium flex items-center justify-center gap-2 hover:border-p01-cyan transition-colors"
              >
                {noteCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {noteCopied ? 'Copied!' : 'Copy Note'}
              </button>
              <button
                onClick={handleDownloadNote}
                className="flex-1 py-2 bg-p01-cyan text-p01-void rounded-lg text-xs font-medium flex items-center justify-center gap-2 hover:bg-p01-cyan/90 transition-colors"
              >
                <Download className="w-4 h-4" />
                Download
              </button>
            </div>
          </motion.div>
        )}
      </div>

      {/* Transfer Button */}
      <div className="p-4 border-t border-p01-border bg-p01-surface">
        <button
          onClick={handleTransfer}
          disabled={isProcessing || !recipient || !amount || parseFloat(amount) <= 0 || !isValidZkAddress(recipient)}
          className={cn(
            'w-full py-3 font-display font-bold text-sm tracking-wider transition-colors rounded-xl flex items-center justify-center gap-2',
            isProcessing || !recipient || !amount || parseFloat(amount) <= 0 || !isValidZkAddress(recipient)
              ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
              : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90'
          )}
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Generating Proof...
            </>
          ) : (
            <>
              <Zap className="w-5 h-5" />
              TRANSFER PRIVATELY
            </>
          )}
        </button>
        <p className="text-center text-p01-chrome/60 text-[10px] mt-2">
          Proof generation may take 30-60 seconds
        </p>
      </div>
    </div>
  );
}
