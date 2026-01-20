/**
 * MessageBubble Component
 * Renders individual chat messages with different styles for sent/received
 */

import { motion } from 'framer-motion';
import { Check, CheckCheck, Clock, AlertCircle, Lock, DollarSign, ArrowUpRight } from 'lucide-react';
import { cn, truncateAddress } from '@/shared/utils';
import { Message } from '@/shared/store/messages';

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  showTimestamp?: boolean;
  onPaymentAction?: (action: 'pay' | 'decline', message: Message) => void;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function MessageStatus({ status }: { status: Message['status'] }) {
  switch (status) {
    case 'sending':
      return <Clock className="w-3 h-3 text-p01-chrome/60" />;
    case 'sent':
      return <Check className="w-3 h-3 text-p01-chrome/60" />;
    case 'delivered':
      return <CheckCheck className="w-3 h-3 text-p01-cyan" />;
    case 'failed':
      return <AlertCircle className="w-3 h-3 text-red-400" />;
    default:
      return null;
  }
}

export default function MessageBubble({
  message,
  isOwn,
  showTimestamp = true,
  onPaymentAction,
}: MessageBubbleProps) {
  // Render payment request bubble
  if (message.type === 'payment_request' && message.paymentData) {
    const pd = message.paymentData;
    const isPending = pd.status === 'pending';
    return (
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', duration: 0.3 }}
        className={cn('flex', isOwn ? 'justify-end' : 'justify-start')}
      >
        <div className={cn(
          'max-w-[85%] rounded-2xl overflow-hidden border',
          pd.status === 'completed' ? 'bg-green-500/10 border-green-500/30' :
          pd.status === 'declined' ? 'bg-p01-surface/50 border-p01-border' :
          'bg-p01-pink/10 border-p01-pink/30'
        )}>
          <div className="px-4 py-3 flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-p01-pink/20 flex items-center justify-center">
              <DollarSign className="w-4 h-4 text-p01-pink" />
            </div>
            <div>
              <p className="text-white text-sm font-medium">Payment Request</p>
              <p className="text-p01-chrome text-[10px]">{isOwn ? 'You requested' : 'Requested from you'}</p>
            </div>
          </div>
          <div className="px-4 py-3">
            <p className="text-2xl font-mono font-bold text-white">{pd.amount} {pd.tokenSymbol}</p>
            {message.decryptedContent && <p className="text-p01-chrome text-sm mt-1">"{message.decryptedContent}"</p>}
          </div>
          {isPending && !isOwn && onPaymentAction && (
            <div className="px-4 pb-4 flex gap-2">
              <button onClick={() => onPaymentAction('decline', message)} className="flex-1 py-2 bg-p01-dark border border-p01-border rounded-xl text-p01-chrome text-sm">Decline</button>
              <button onClick={() => onPaymentAction('pay', message)} className="flex-1 py-2 bg-p01-cyan text-p01-void rounded-xl text-sm font-medium">Pay</button>
            </div>
          )}
        </div>
      </motion.div>
    );
  }

  // Render payment sent bubble
  if (message.type === 'payment_sent' && message.paymentData) {
    const pd = message.paymentData;
    return (
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', duration: 0.3 }}
        className={cn('flex', isOwn ? 'justify-end' : 'justify-start')}
      >
        <div className={cn(
          'max-w-[85%] rounded-2xl overflow-hidden border',
          isOwn ? 'bg-green-500/10 border-green-500/30' : 'bg-p01-cyan/10 border-p01-cyan/30'
        )}>
          <div className="px-4 py-3 flex items-center gap-2">
            <div className={cn('w-8 h-8 rounded-full flex items-center justify-center', isOwn ? 'bg-green-500/20' : 'bg-p01-cyan/20')}>
              <ArrowUpRight className={cn('w-4 h-4', isOwn ? 'text-green-400' : 'text-p01-cyan')} />
            </div>
            <p className="text-white text-sm font-medium">{isOwn ? 'Payment Sent' : 'Payment Received'}</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-2xl font-mono font-bold text-white">{isOwn ? '-' : '+'}{pd.amount} {pd.tokenSymbol}</p>
          </div>
          {pd.txSignature && (
            <div className="px-4 pb-3">
              <p className="text-p01-chrome/40 text-[10px] font-mono">Tx: {truncateAddress(pd.txSignature, 8)}</p>
            </div>
          )}
        </div>
      </motion.div>
    );
  }

  // Render text message bubble
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', duration: 0.3 }}
      className={cn('flex', isOwn ? 'justify-end' : 'justify-start')}
    >
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-2.5 relative group',
          isOwn
            ? 'bg-p01-cyan text-p01-void rounded-br-sm'
            : 'bg-p01-surface text-white rounded-bl-sm'
        )}
      >
        {/* Message content */}
        <p className="text-sm whitespace-pre-wrap break-words">
          {message.decryptedContent || '[Encrypted]'}
        </p>

        {/* Timestamp and status */}
        {showTimestamp && (
          <div
            className={cn(
              'flex items-center gap-1 mt-1',
              isOwn ? 'justify-end' : 'justify-start'
            )}
          >
            <span
              className={cn(
                'text-[10px]',
                isOwn ? 'text-p01-void/60' : 'text-p01-chrome/60'
              )}
            >
              {formatTime(message.timestamp)}
            </span>

            {isOwn && <MessageStatus status={message.status} />}

            {/* Encryption indicator (shown on hover) */}
            <Lock
              className={cn(
                'w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity',
                isOwn ? 'text-p01-void/40' : 'text-p01-chrome/40'
              )}
            />
          </div>
        )}
      </div>
    </motion.div>
  );
}
