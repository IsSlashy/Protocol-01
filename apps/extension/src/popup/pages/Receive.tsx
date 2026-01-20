import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Copy,
  Check,
  ExternalLink,
  Shield,
  ShieldCheck,
  Eye,
  EyeOff,
  Info,
  ChevronRight,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useWalletStore } from '@/shared/store/wallet';
import { useStealthStore } from '@/shared/store/stealth';
import { copyToClipboard, truncateAddress, cn } from '@/shared/utils';

export default function Receive() {
  const navigate = useNavigate();
  const { publicKey, network } = useWalletStore();
  const {
    metaAddress,
    stealthModeEnabled,
    toggleStealthMode,
    isInitialized: stealthInitialized,
    payments,
    stealthBalance,
  } = useStealthStore();

  const [copied, setCopied] = useState(false);
  const [showStealthInfo, setShowStealthInfo] = useState(false);

  // Adresse a afficher (normale ou stealth)
  const displayAddress = stealthModeEnabled && metaAddress ? metaAddress : publicKey;

  // Nombre de paiements stealth en attente
  const pendingPayments = payments.filter((p) => !p.claimed).length;

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

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header - Industrial */}
      <div className="flex items-center gap-3 p-3 border-b border-p01-border bg-p01-surface">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 hover:bg-p01-border transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-p01-chrome" />
        </button>
        <h1 className="text-sm font-mono font-bold text-white tracking-wider">RECEIVE SOL</h1>

        {/* Stealth Mode Toggle */}
        {stealthInitialized && (
          <button
            onClick={toggleStealthMode}
            className={cn(
              'ml-auto flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono font-bold tracking-wider border transition-all rounded',
              stealthModeEnabled
                ? 'bg-p01-cyan/20 border-p01-cyan text-p01-cyan'
                : 'bg-transparent border-p01-border text-p01-chrome hover:border-p01-cyan/50'
            )}
          >
            {stealthModeEnabled ? (
              <>
                <ShieldCheck className="w-3 h-3" />
                STEALTH
              </>
            ) : (
              <>
                <Shield className="w-3 h-3" />
                NORMAL
              </>
            )}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Network Badge */}
        {network === 'devnet' && (
          <div className="flex justify-center">
            <span className="px-2 py-0.5 text-[9px] font-mono font-bold bg-yellow-500/10 text-yellow-500 border border-yellow-500/30 tracking-wider">
              [ DEVNET ]
            </span>
          </div>
        )}

        {/* Stealth Mode Banner */}
        <AnimatePresence>
          {stealthModeEnabled && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="bg-p01-cyan/10 border border-p01-cyan/30 p-3 rounded-xl"
            >
              <div className="flex items-start gap-2">
                <ShieldCheck className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-mono font-bold text-p01-cyan tracking-wider">
                      [ STEALTH MODE ACTIVE ]
                    </p>
                    <button
                      onClick={() => setShowStealthInfo(!showStealthInfo)}
                      className="text-p01-cyan/70 hover:text-p01-cyan"
                    >
                      <Info className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="text-[10px] text-p01-chrome font-mono tracking-wider mt-1">
                    Each payment will go to a unique address only you can access.
                  </p>

                  {/* Expandable Info */}
                  <AnimatePresence>
                    {showStealthInfo && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mt-2 pt-2 border-t border-p01-cyan/20"
                      >
                        <p className="text-[9px] text-p01-chrome/70 font-mono leading-relaxed">
                          The stealth address (meta-address) allows senders to generate unique
                          one-time addresses for each payment. Only you can detect and spend
                          these funds using your viewing and spending keys. This provides
                          maximum privacy as your main address is never revealed.
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* QR Code - Real QR with styling */}
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="flex flex-col items-center"
        >
          <div
            className={cn(
              'bg-white p-4 rounded-xl border-4 shadow-lg',
              stealthModeEnabled
                ? 'border-p01-cyan shadow-p01-cyan/20'
                : 'border-p01-pink shadow-p01-pink/20'
            )}
          >
            {displayAddress ? (
              <div className="relative">
                <QRCodeSVG
                  value={solanaPayUri}
                  size={160}
                  level="H"
                  includeMargin={false}
                  bgColor="#ffffff"
                  fgColor="#0a0a0f"
                  imageSettings={{
                    src: stealthModeEnabled ? '/stealth-icon.png' : '/01-logo.png',
                    x: undefined,
                    y: undefined,
                    height: 32,
                    width: 32,
                    excavate: true,
                  }}
                />
                {stealthModeEnabled && (
                  <div className="absolute -top-2 -right-2 w-6 h-6 bg-p01-cyan rounded-full flex items-center justify-center shadow-lg">
                    <ShieldCheck className="w-4 h-4 text-p01-void" />
                  </div>
                )}
              </div>
            ) : (
              <div className="w-40 h-40 bg-p01-surface flex items-center justify-center rounded">
                <span className="text-p01-chrome text-xs font-mono">NO WALLET</span>
              </div>
            )}
          </div>

          {/* Truncated address under QR */}
          <div className="mt-3 flex items-center gap-2">
            <span className="text-p01-chrome text-sm font-mono">
              {displayAddress
                ? stealthModeEnabled
                  ? `st:01...${displayAddress.slice(-8)}`
                  : truncateAddress(displayAddress, 8)
                : '---'}
            </span>
            <button
              onClick={handleCopy}
              className="p-1 hover:bg-p01-surface rounded transition-colors"
            >
              {copied ? (
                <Check className="w-4 h-4 text-p01-cyan" />
              ) : (
                <Copy className="w-4 h-4 text-p01-chrome hover:text-white" />
              )}
            </button>
          </div>
        </motion.div>

        {/* Address Display - Industrial */}
        <div className="bg-p01-surface border border-p01-border p-3 rounded-xl">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-[#555560] font-mono tracking-wider">
              {stealthModeEnabled ? 'YOUR STEALTH META-ADDRESS' : 'YOUR SOLANA ADDRESS'}
            </span>
            {!stealthModeEnabled && publicKey && (
              <a
                href={`https://solscan.io/account/${publicKey}?cluster=${network}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[10px] text-p01-cyan font-mono tracking-wider hover:text-p01-cyan-dim transition-colors"
              >
                VIEW
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>

          <p className="font-mono text-[10px] text-white break-all mb-3 tracking-wider leading-relaxed select-all">
            {displayAddress || '----'}
          </p>

          <button
            onClick={handleCopy}
            className={cn(
              'w-full flex items-center justify-center gap-2 py-2.5 bg-p01-dark border rounded-lg transition-colors',
              stealthModeEnabled
                ? 'border-p01-cyan/30 hover:border-p01-cyan'
                : 'border-p01-border hover:border-p01-cyan'
            )}
          >
            {copied ? (
              <>
                <Check className="w-4 h-4 text-p01-cyan" />
                <span className="text-xs font-mono font-medium text-p01-cyan tracking-wider">
                  COPIED TO CLIPBOARD
                </span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 text-p01-chrome" />
                <span className="text-xs font-mono font-medium text-white tracking-wider">
                  COPY {stealthModeEnabled ? 'META-ADDRESS' : 'ADDRESS'}
                </span>
              </>
            )}
          </button>
        </div>

        {/* Stealth Payments Link */}
        {stealthInitialized && (
          <button
            onClick={() => navigate('/stealth-payments')}
            className="w-full bg-p01-surface border border-p01-border p-3 rounded-xl flex items-center justify-between hover:border-p01-cyan/50 transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'w-8 h-8 flex items-center justify-center border rounded-lg',
                  pendingPayments > 0
                    ? 'bg-p01-cyan/20 border-p01-cyan'
                    : 'bg-p01-dark border-p01-border'
                )}
              >
                {pendingPayments > 0 ? (
                  <EyeOff className="w-4 h-4 text-p01-cyan" />
                ) : (
                  <Eye className="w-4 h-4 text-p01-chrome" />
                )}
              </div>
              <div className="text-left">
                <p className="text-[11px] font-mono font-bold text-white tracking-wider">
                  STEALTH PAYMENTS
                </p>
                <p className="text-[10px] text-p01-chrome font-mono">
                  {pendingPayments > 0
                    ? `${pendingPayments} pending - ${(stealthBalance / 1e9).toFixed(4)} SOL`
                    : 'No pending payments'}
                </p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-p01-chrome group-hover:text-p01-cyan transition-colors" />
          </button>
        )}

        {/* Info Card - Terminal style */}
        <div
          className={cn(
            'border p-3 rounded-xl',
            stealthModeEnabled
              ? 'bg-p01-cyan/5 border-p01-cyan/30'
              : 'bg-p01-pink/5 border-p01-pink/30'
          )}
        >
          <div className="flex items-start gap-2">
            <div
              className={cn(
                'w-4 h-4 border flex items-center justify-center flex-shrink-0 mt-0.5 rounded',
                stealthModeEnabled
                  ? 'bg-p01-cyan/20 border-p01-cyan'
                  : 'bg-p01-pink/20 border-p01-pink'
              )}
            >
              <span
                className={cn(
                  'text-[8px] font-mono font-bold',
                  stealthModeEnabled ? 'text-p01-cyan' : 'text-p01-pink'
                )}
              >
                i
              </span>
            </div>
            <div>
              <p
                className={cn(
                  'text-[10px] font-mono font-bold tracking-wider mb-1',
                  stealthModeEnabled ? 'text-p01-cyan' : 'text-p01-pink'
                )}
              >
                [ {stealthModeEnabled ? 'PRIVATE RECEIVING' : 'RECEIVING'} ]
              </p>
              <p className="text-[10px] text-[#555560] font-mono tracking-wider leading-relaxed">
                {stealthModeEnabled
                  ? 'SHARE THIS META-ADDRESS FOR PRIVATE PAYMENTS. EACH PAYMENT WILL BE SENT TO A UNIQUE STEALTH ADDRESS.'
                  : `SCAN THIS QR CODE OR SHARE YOUR ADDRESS TO RECEIVE SOL OR SPL TOKENS ON THE ${network.toUpperCase()} NETWORK.`}
              </p>
            </div>
          </div>
        </div>

        {/* Network warning for devnet */}
        {network === 'devnet' && (
          <div className="bg-yellow-500/5 border border-yellow-500/30 p-3 rounded-xl">
            <div className="flex items-start gap-2">
              <div className="w-4 h-4 bg-yellow-500/20 border border-yellow-500 flex items-center justify-center flex-shrink-0 mt-0.5 rounded">
                <span className="text-[8px] font-mono font-bold text-yellow-500">!</span>
              </div>
              <div>
                <p className="text-[10px] font-mono font-bold text-yellow-500 tracking-wider mb-1">
                  [ DEVNET ]
                </p>
                <p className="text-[10px] text-[#555560] font-mono tracking-wider leading-relaxed">
                  THIS IS A DEVNET ADDRESS. ONLY SEND DEVNET TOKENS TO THIS ADDRESS. REAL TOKENS
                  WILL BE LOST.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Setup Stealth if not initialized */}
        {!stealthInitialized && (
          <div className="bg-p01-surface border border-p01-border p-3 rounded-xl">
            <div className="flex items-start gap-2">
              <Shield className="w-4 h-4 text-p01-chrome flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-[10px] font-mono font-bold text-white tracking-wider mb-1">
                  ENABLE STEALTH ADDRESSES
                </p>
                <p className="text-[10px] text-p01-chrome font-mono tracking-wider mb-2">
                  Stealth addresses provide maximum privacy by generating unique addresses for
                  each payment.
                </p>
                <button
                  onClick={() => navigate('/settings')}
                  className="text-[10px] font-mono font-bold text-p01-cyan tracking-wider hover:underline"
                >
                  SETUP IN SETTINGS &rarr;
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
