/**
 * Payment Request Bubble
 * Special message bubble for payment requests in chat
 */

import { motion } from 'framer-motion';
import { DollarSign, X, Check, Clock, AlertCircle, Loader2 } from 'lucide-react';
import { cn, truncateAddress, formatRelativeTime } from '@/shared/utils';
import { PaymentRequest, formatPaymentAmount } from '@/shared/services/paymentRequest';

interface PaymentRequestBubbleProps {
  request: PaymentRequest;
  isFromMe: boolean; // Did I create this request?
  contactName?: string;
  onPay?: () => void;
  onDecline?: () => void;
  isPaying?: boolean;
}

export default function PaymentRequestBubble({
  request,
  isFromMe,
  contactName,
  onPay,
  onDecline,
  isPaying = false,
}: PaymentRequestBubbleProps) {
  const displayName = contactName || truncateAddress(request.requesterId, 4);
  const formattedAmount = formatPaymentAmount(request.amount, request.token);

  // Check if expired
  const isExpired = request.expiresAt ? Date.now() > request.expiresAt : false;
  const effectiveStatus = isExpired && request.status === 'pending' ? 'expired' : request.status;

  // Status badge colors and text
  const statusConfig: Record<string, { bg: string; text: string; label: string; icon: React.ReactNode }> = {
    pending: {
      bg: 'bg-yellow-500/20',
      text: 'text-yellow-400',
      label: 'Pending',
      icon: <Clock className="w-3 h-3" />,
    },
    paid: {
      bg: 'bg-green-500/20',
      text: 'text-green-400',
      label: 'Paid',
      icon: <Check className="w-3 h-3" />,
    },
    declined: {
      bg: 'bg-red-500/20',
      text: 'text-red-400',
      label: 'Declined',
      icon: <X className="w-3 h-3" />,
    },
    expired: {
      bg: 'bg-p01-chrome/20',
      text: 'text-p01-chrome',
      label: 'Expired',
      icon: <AlertCircle className="w-3 h-3" />,
    },
  };

  const status = statusConfig[effectiveStatus] || statusConfig.pending;

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
          effectiveStatus === 'paid'
            ? 'bg-gradient-to-br from-green-500/10 to-emerald-500/10 border-green-500/30'
            : effectiveStatus === 'declined' || effectiveStatus === 'expired'
            ? 'bg-p01-surface/50 border-p01-border'
            : 'bg-gradient-to-br from-p01-pink/10 to-p01-cyan/10 border-p01-pink/30'
        )}
        style={{ borderRadius: 'inherit' }}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-inherit flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center',
                effectiveStatus === 'paid'
                  ? 'bg-green-500/20'
                  : effectiveStatus === 'declined' || effectiveStatus === 'expired'
                  ? 'bg-p01-chrome/20'
                  : 'bg-p01-pink/20'
              )}
            >
              <DollarSign
                className={cn(
                  'w-4 h-4',
                  effectiveStatus === 'paid'
                    ? 'text-green-400'
                    : effectiveStatus === 'declined' || effectiveStatus === 'expired'
                    ? 'text-p01-chrome'
                    : 'text-p01-pink'
                )}
              />
            </div>
            <div>
              <p className="text-white text-sm font-medium">Payment Request</p>
              <p className="text-p01-chrome text-[10px]">
                {isFromMe ? 'You requested' : `${displayName} requested`}
              </p>
            </div>
          </div>

          {/* Status Badge */}
          <div
            className={cn(
              'px-2 py-1 rounded-full flex items-center gap-1',
              status.bg,
              status.text
            )}
          >
            {status.icon}
            <span className="text-[10px] font-mono font-bold tracking-wider">
              {status.label}
            </span>
          </div>
        </div>

        {/* Amount */}
        <div className="px-4 py-4">
          <p className="text-2xl font-mono font-bold text-white">
            {formattedAmount}
          </p>
          {request.note && (
            <p className="text-p01-chrome text-sm mt-1">
              "{request.note}"
            </p>
          )}

          {/* Expiration */}
          {request.expiresAt && effectiveStatus === 'pending' && !isExpired && (
            <div className="flex items-center gap-1 mt-2 text-p01-chrome/60">
              <Clock className="w-3 h-3" />
              <span className="text-[10px] font-mono">
                Expires {formatRelativeTime(request.expiresAt).replace(' ago', '')}
              </span>
            </div>
          )}

          {/* Transaction signature for paid requests */}
          {effectiveStatus === 'paid' && request.txSignature && (
            <p className="text-green-400/60 text-[10px] font-mono mt-2 truncate">
              Tx: {truncateAddress(request.txSignature, 8)}
            </p>
          )}
        </div>

        {/* Actions for pending requests (only if I need to pay) */}
        {effectiveStatus === 'pending' && !isFromMe && (
          <div className="px-4 pb-4 flex gap-2">
            <button
              onClick={onDecline}
              disabled={isPaying}
              className="flex-1 py-2.5 bg-p01-dark border border-p01-border rounded-xl text-p01-chrome font-medium text-sm hover:text-white hover:border-red-500/50 transition-colors disabled:opacity-50"
            >
              Decline
            </button>
            <button
              onClick={onPay}
              disabled={isPaying}
              className={cn(
                'flex-1 py-2.5 rounded-xl font-medium text-sm transition-colors flex items-center justify-center gap-2',
                isPaying
                  ? 'bg-p01-border text-p01-chrome cursor-not-allowed'
                  : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90'
              )}
            >
              {isPaying ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Paying...
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  Pay {formattedAmount}
                </>
              )}
            </button>
          </div>
        )}

        {/* Waiting message for my requests */}
        {effectiveStatus === 'pending' && isFromMe && (
          <div className="px-4 pb-3">
            <p className="text-p01-chrome/60 text-xs flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Waiting for response...
            </p>
          </div>
        )}

        {/* Timestamp */}
        <div className="px-4 pb-3">
          <p className="text-p01-chrome/40 text-[10px] text-right">
            {formatRelativeTime(request.createdAt)}
          </p>
        </div>
      </div>
    </motion.div>
  );
}
