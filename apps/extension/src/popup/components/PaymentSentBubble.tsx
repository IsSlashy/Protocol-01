/**
 * Payment Sent Bubble
 * Special message bubble for sent/received payments in chat
 */

import { motion } from 'framer-motion';
import { Check, ExternalLink, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { cn, truncateAddress, formatRelativeTime } from '@/shared/utils';
import { PaymentSent, formatPaymentAmount, getPaymentSolscanUrl } from '@/shared/services/paymentRequest';
import { NetworkType } from '@/shared/services/wallet';

interface PaymentSentBubbleProps {
  payment: PaymentSent;
  isFromMe: boolean; // Did I send this payment?
  contactName?: string;
  network: NetworkType;
}

export default function PaymentSentBubble({
  payment,
  isFromMe,
  contactName,
  network,
}: PaymentSentBubbleProps) {
  const displayName = contactName || truncateAddress(
    isFromMe ? payment.recipientId : payment.senderId,
    4
  );
  const formattedAmount = formatPaymentAmount(payment.amount, payment.token);
  const solscanUrl = getPaymentSolscanUrl(payment.txSignature, network);

  const handleViewOnSolscan = () => {
    window.open(solscanUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'max-w-[85%] rounded-2xl overflow-hidden',
        isFromMe ? 'ml-auto' : 'mr-auto'
      )}
    >
      <div
        className={cn(
          'border',
          isFromMe
            ? 'bg-gradient-to-br from-green-500/20 to-emerald-500/20 border-green-500/30'
            : 'bg-gradient-to-br from-p01-cyan/20 to-blue-500/20 border-p01-cyan/30'
        )}
        style={{ borderRadius: 'inherit' }}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-inherit flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center',
                isFromMe ? 'bg-green-500/20' : 'bg-p01-cyan/20'
              )}
            >
              {isFromMe ? (
                <ArrowUpRight className="w-4 h-4 text-green-400" />
              ) : (
                <ArrowDownLeft className="w-4 h-4 text-p01-cyan" />
              )}
            </div>
            <div>
              <p className="text-white text-sm font-medium">
                {isFromMe ? 'Payment Sent' : 'Payment Received'}
              </p>
              <p className="text-p01-chrome text-[10px]">
                {isFromMe ? `To @${displayName}` : `From @${displayName}`}
              </p>
            </div>
          </div>

          {/* Success Badge */}
          <div className="px-2 py-1 rounded-full flex items-center gap-1 bg-green-500/20 text-green-400">
            <Check className="w-3 h-3" />
            <span className="text-[10px] font-mono font-bold tracking-wider">
              Confirmed
            </span>
          </div>
        </div>

        {/* Amount */}
        <div className="px-4 py-4">
          <div className="flex items-baseline gap-1">
            <span
              className={cn(
                'text-xl',
                isFromMe ? 'text-green-400' : 'text-p01-cyan'
              )}
            >
              {isFromMe ? '-' : '+'}
            </span>
            <p className="text-2xl font-mono font-bold text-white">
              {formattedAmount}
            </p>
          </div>

          {payment.note && (
            <p className="text-p01-chrome text-sm mt-1">
              "{payment.note}"
            </p>
          )}

          {/* Transaction signature */}
          <p className="text-p01-chrome/40 text-[10px] font-mono mt-2 truncate">
            Tx: {truncateAddress(payment.txSignature, 8)}
          </p>
        </div>

        {/* View on Solscan */}
        <div className="px-4 pb-4">
          <button
            onClick={handleViewOnSolscan}
            className={cn(
              'w-full py-2.5 rounded-xl font-medium text-sm transition-colors flex items-center justify-center gap-2',
              'bg-p01-dark border border-p01-border text-p01-chrome hover:text-white hover:border-p01-cyan/50'
            )}
          >
            View on Solscan
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Timestamp */}
        <div className="px-4 pb-3">
          <p className="text-p01-chrome/40 text-[10px] text-right">
            {formatRelativeTime(payment.timestamp)}
          </p>
        </div>
      </div>
    </motion.div>
  );
}
